'use strict';
const http  = require('http');
const https = require('https');

process.on('uncaughtException',  e => { console.error('[UNCAUGHT]', e.message, e.stack); process.exit(1); });
process.on('unhandledRejection', e => console.error('[UNHANDLED]', String(e)));

const FOOTBALL_KEY  = process.env.FOOTBALL_KEY  || '';
const TENNIS_KEY    = process.env.TENNIS_KEY    || '';
const THEODDS_KEY   = process.env.THEODDS_KEY   || '';
const TG_TOKEN      = process.env.TG_TOKEN      || '8171273424:AAGMvAxhDnt-HSZSZi8DJeV0j6YEwhfHC5E';
const TG_CHAT       = process.env.TG_CHAT       || '6307700447';
const PORT          = parseInt(process.env.PORT  || '3000', 10);
const ODD_MIN       = parseFloat(process.env.ODD_MIN || '1.20');
const ODD_MAX       = parseFloat(process.env.ODD_MAX || '1.60');

const alerted       = new Map();
const ALERTED_TTL   = 24*60*60*1000;
function alertedHas(k){ const t=alerted.get(k); return t!=null&&(Date.now()-t)<ALERTED_TTL; }
function alertedAdd(k){ alerted.set(k, Date.now()); }
function cleanupAlerted(){ const c=Date.now()-ALERTED_TTL; for(const[k,t] of alerted) if(t<c) alerted.delete(k); }

let lastFootball=[], allFootballForSim=[], lastTennis=[], lastUpdate=null;
const stats         = { pollCount:0, alertsSent:0, errors:0, oddsUpdates:0 };
const simAlerts     = [];
const htSnapshot    = new Map();
const kickoffSnapshot = new Map();
const breakRecoveries = new Map();
const surfaceCache  = new Map();
const oddsCache     = new Map();
const ODDS_TTL      = 45*1000;

const FB_URL = 'https://roturas25-default-rtdb.europe-west1.firebasedatabase.app';
let fbSaveTimer = null;

async function fbGet(path){
  try{ return await fetchJson(FB_URL+path+'.json'); }
  catch(e){ console.warn('[FB GET]',e.message); return null; }
}
async function fbPut(path,data){
  return new Promise((res,rej)=>{
    const body=JSON.stringify(data);
    const url=new URL(FB_URL+path+'.json');
    const r=https.request({hostname:url.hostname,path:url.pathname+url.search,
      method:'PUT',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},
      r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res());});
    r.on('error',rej); r.write(body); r.end();
  });
}
async function fbDelete(path){
  return new Promise((res,rej)=>{
    const url=new URL(FB_URL+path+'.json');
    const r=https.request({hostname:url.hostname,path:url.pathname+url.search,method:'DELETE'},
      r=>{r.resume();r.on('end',res);});
    r.on('error',rej); r.end();
  });
}
function scheduleFbSave(){
  if(fbSaveTimer) return;
  fbSaveTimer=setTimeout(async()=>{
    fbSaveTimer=null;
    try{
      await fbPut('/state/alerted', Object.fromEntries(alerted));
      await fbPut('/state/sims',    simAlerts.slice(0,500));
      console.log('[FB] Estado guardado. alerted:',alerted.size,'sims:',simAlerts.length);
    }catch(e){console.warn('[FB SAVE]',e.message);}
  },3000);
}
async function loadStateFromFB(){
  console.log('[FB] Cargando estado previo...');
  try{
    const savedAlerted=await fbGet('/state/alerted');
    if(savedAlerted&&typeof savedAlerted==='object'){
      const entries=Array.isArray(savedAlerted)
        ?savedAlerted.map(k=>[k,Date.now()])
        :Object.entries(savedAlerted);
      entries.forEach(([k,t])=>alerted.set(k,typeof t==='number'?t:Date.now()));
      cleanupAlerted();
      console.log('[FB] alerted restaurado:',alerted.size,'claves');
    }
    const savedSims=await fbGet('/state/sims');
    if(Array.isArray(savedSims)&&savedSims.length){
      simAlerts.push(...savedSims);
      console.log('[FB] simAlerts restaurado:',simAlerts.length);
    }
  }catch(e){console.warn('[FB LOAD]',e.message);}
}

function todayStr(){ return new Date().toISOString().split('T')[0]; }
function tomorrowStr(){ return new Date(Date.now()+86400000).toISOString().split('T')[0]; }
function nowISO(){ return new Date().toISOString(); }

function fetchJson(url,headers={}){
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers},res=>{
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(new Error('JSON:'+d.slice(0,80)));}});
    });
    req.on('error',reject);
    req.setTimeout(12000,()=>{req.destroy();reject(new Error('Timeout'));});
  });
}
async function sendTG(msg){
  if(!TG_TOKEN||!TG_CHAT) return;
  try{
    const body=JSON.stringify({chat_id:TG_CHAT,text:msg});
    await new Promise((res,rej)=>{
      const r=https.request({hostname:'api.telegram.org',path:`/bot${TG_TOKEN}/sendMessage`,method:'POST',
        headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},
        r=>{r.resume();r.on('end',res);});
      r.on('error',rej); r.write(body); r.end();
    });
    stats.alertsSent++;
  }catch(e){console.error('[TG]',e.message);}
}
function hasLiveMatches(){
  return lastFootball.some(m=>m.status==='IN_PLAY'||m.status==='PAUSED')
      || lastTennis.some(m=>!m.isUp);
}
function isDoubles(e){
  const p1=(e.event_first_player||'').trim(),p2=(e.event_second_player||'').trim(),lg=(e.league_name||'').toLowerCase();
  return p1.includes('/')||p2.includes('/')||lg.includes('double')||lg.includes('doble');
}

// ═══════════════════════════════════════════════════════════
// ODDS ENGINE
// ═══════════════════════════════════════════════════════════
function parseBookiesFromAllSports(obj){
  if(!obj||typeof obj!=='object') return {odds:null,bookies:[],source:null,count:0};
  const entries=Object.entries(obj).map(([bk,v])=>({bk,odds:parseFloat(v)})).filter(x=>!isNaN(x.odds)&&x.odds>1);
  if(!entries.length) return {odds:null,bookies:[],source:null,count:0};
  entries.sort((a,b)=>a.odds-b.odds);
  const mid=entries[Math.floor(entries.length/2)];
  const KNOWN=['Bet365','Betway','1xBet','Unibet','William Hill','Pinnacle','Bwin','Betfair','Ladbrokes','Coral','10Bet','Marathonbet'];
  const sorted=[...entries].sort((a,b)=>{const ai=KNOWN.indexOf(a.bk),bi=KNOWN.indexOf(b.bk);return(ai===-1?99:ai)-(bi===-1?99:bi);});
  return{odds:Math.round(mid.odds*100)/100,bookies:sorted.map(e=>e.bk).slice(0,8),source:sorted[0]?.bk||mid.bk,count:entries.length};
}

function buildTennisOddsCache(result){
  if(!result||typeof result!=='object') return;
  let updated=0;
  Object.entries(result).forEach(([id,data])=>{
    const ex=oddsCache.get(id);
    if(ex&&(Date.now()-ex.ts)<ODDS_TTL) return;
    const hw=data['Home/Away']||data['1X2']||data['Match Winner']||data['Winner']||null;
    if(!hw) return;
    const r1=parseBookiesFromAllSports(hw['Home']||hw['Player 1']||hw['First Player']);
    const r2=parseBookiesFromAllSports(hw['Away']||hw['Player 2']||hw['Second Player']);
    if(!r1.odds&&!r2.odds) return;
    const allBookies=[...new Set([...r1.bookies,...r2.bookies])];
    const existing=oddsCache.get(id)||{};
    oddsCache.set(id,{
      ...existing,
      o1:r1.odds||null, o2:r2.odds||null,
      preMatch:existing.preMatch||{o1:r1.odds||null,o2:r2.odds||null},
      bookies:allBookies.slice(0,8), bookieCount:Math.max(r1.count,r2.count),
      source:r1.source||r2.source||'AllSports', ts:Date.now(),
    });
    updated++;
  });
  if(updated>0){stats.oddsUpdates+=updated;console.log(`[ODDS-T] ${updated} partidos actualizados`);}
}

async function fetchTennisOdds(){
  if(!TENNIS_KEY) return;
  try{
    const r=await fetchJson(`https://apiv2.allsportsapi.com/tennis/?met=Odds&APIkey=${TENNIS_KEY}&from=${todayStr()}&to=${tomorrowStr()}`);
    if(r.success&&r.result) buildTennisOddsCache(r.result);
  }catch(e){console.warn('[ODDS-T]',e.message);}
}

// TheOddsAPI — live odds fútbol (Over/Under + H2H)
// Registrarse: https://the-odds-api.com/ → Get API Key (500 req gratis/mes)
// Plan Starter: $12.99/mes → 50.000 req/mes (suficiente para 30s polling)
// Configurar en Railway: THEODDS_KEY=tu_api_key
const THEODDS_SPORTS=['soccer_spain_la_liga','soccer_england_premier_league'];
async function fetchFootballLiveOdds(){
  if(!THEODDS_KEY) return;
  for(const sport of THEODDS_SPORTS){
    try{
      const url=`https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${THEODDS_KEY}&regions=eu&markets=h2h,totals&oddsFormat=decimal`;
      const r=await fetchJson(url);
      if(!Array.isArray(r)) continue;
      r.forEach(event=>{
        const hName=(event.home_team||'').toLowerCase();
        const aName=(event.away_team||'').toLowerCase();
        const ftMatch=lastFootball.find(m=>(m.h||'').toLowerCase().includes(hName.split(' ')[0])||
          (m.a||'').toLowerCase().includes(aName.split(' ')[0]));
        const cacheKey=ftMatch?ftMatch.id:`ft_${event.id}`;
        let h2hO1=null,h2hO2=null,over05=null,over15=null;
        const bookieList=[];
        (event.bookmakers||[]).forEach(bm=>{
          bookieList.push(bm.key);
          (bm.markets||[]).forEach(mkt=>{
            if(mkt.key==='h2h') mkt.outcomes.forEach(o=>{
              if(o.name===event.home_team) h2hO1=h2hO1?(h2hO1+o.price)/2:o.price;
              if(o.name===event.away_team) h2hO2=h2hO2?(h2hO2+o.price)/2:o.price;
            });
            if(mkt.key==='totals') mkt.outcomes.forEach(o=>{
              if(o.name==='Over'&&o.point===0.5) over05=over05?(over05+o.price)/2:o.price;
              if(o.name==='Over'&&o.point===1.5) over15=over15?(over15+o.price)/2:o.price;
            });
          });
        });
        const r2=v=>v?Math.round(v*100)/100:null;
        const existing=oddsCache.get(cacheKey)||{};
        oddsCache.set(cacheKey,{...existing,o1:r2(h2hO1),o2:r2(h2hO2),
          over05:r2(over05),over15:r2(over15),
          preMatch:existing.preMatch||{o1:r2(h2hO1),o2:r2(h2hO2)},
          bookies:[...new Set(bookieList)].slice(0,6),source:'TheOddsAPI',bookieCount:bookieList.length,ts:Date.now()});
      });
      console.log(`[ODDS-F] ${sport}: ${r.length} partidos`);
    }catch(e){console.warn('[ODDS-F]',e.message);}
  }
}
function getMatchOdds(e){ return oddsCache.get(String(e.event_key))||oddsCache.get('fd_'+e.event_key)||{o1:null,o2:null,over05:null,over15:null,preMatch:null,bookies:[],source:null,bookieCount:0}; }
function getFootballOdds(matchId){ return oddsCache.get(matchId)||{o1:null,o2:null,over05:null,over15:null,preMatch:null,bookies:[],source:null,bookieCount:0}; }

// ═══════════════════════════════════════════════════════════
// FOOTBALL
// ═══════════════════════════════════════════════════════════
function normF(m,code){
  const shF=m.score?.fullTime?.home??m.score?.home??0;
  const saF=m.score?.fullTime?.away??m.score?.away??0;
  const shH=m.score?.halfTime?.home??null;
  const saH=m.score?.halfTime?.away??null;
  let min=0;
  if(m.status==='PAUSED'){min=45;}
  else if(m.status==='IN_PLAY'){
    if(m.minute!=null&&m.minute>0){min=m.minute+(m.injuryTime||0);}
    else{const startTs=m.utcDate?new Date(m.utcDate).getTime():0;if(startTs>0){const el=Math.floor((Date.now()-startTs)/60000);min=el<=47?el:el<=62?45:Math.min(45+(el-62),90);}}
  }
  const g2=shH!=null?Math.max(0,(shF-shH)+(saF-saH)):0;
  const fid='fd_'+m.id;
  const od=getFootballOdds(fid);
  return{id:fid,league:code==='PD'?'LaLiga EA Sports':'Premier League',k:code==='PD'?'laliga':'premier',
    status:m.status,min,h:m.homeTeam?.shortName||m.homeTeam?.name||'?',a:m.awayTeam?.shortName||m.awayTeam?.name||'?',
    hc:m.homeTeam?.crest||null,ac:m.awayTeam?.crest||null,
    lh:shF,la:saF,lhLive:shF,laLive:saF,lhH:shH,laH:saH,g2,utcDate:m.utcDate,
    o1:od.o1,o2:od.o2,over05:od.over05,over15:od.over15,
    preMatchO1:od.preMatch?.o1,preMatchO2:od.preMatch?.o2,
    bookies:od.bookies||[],source:od.source||null,
    a25:alertedHas('25_fd_'+m.id),a67:alertedHas('67_fd_'+m.id)};
}
async function fetchFootball(){
  if(!FOOTBALL_KEY) return;
  const[t,tm]=[todayStr(),tomorrowStr()];
  const[pd,pl]=await Promise.all([
    fetchJson(`https://api.football-data.org/v4/competitions/PD/matches?dateFrom=${t}&dateTo=${tm}`,{'X-Auth-Token':FOOTBALL_KEY}),
    fetchJson(`https://api.football-data.org/v4/competitions/PL/matches?dateFrom=${t}&dateTo=${tm}`,{'X-Auth-Token':FOOTBALL_KEY}),
  ]);
  const all=[...(pd.matches||[]).map(m=>normF(m,'PD')),...(pl.matches||[]).map(m=>normF(m,'PL'))];
  allFootballForSim=all; lastFootball=all.filter(m=>m.status!=='FINISHED');
}
function checkFootballAlerts(){
  lastFootball.forEach(m=>{
    if(m.status!=='IN_PLAY') return;
    if(m.min>=1&&m.min<=8&&!kickoffSnapshot.has(m.id)) kickoffSnapshot.set(m.id,{h:m.lhLive||0,a:m.laLive||0});
    const liveGoals1h=(m.lhLive||0)+(m.laLive||0);
    const snap0=kickoffSnapshot.get(m.id);
    const knownGoals1h=Math.max(liveGoals1h,snap0?liveGoals1h-snap0.h-snap0.a:0);
    const k25='25_'+m.id;
    if(m.min>=22&&m.min<=38&&!alertedHas(k25)&&knownGoals1h===0){
      alertedAdd(k25);
      const od=getFootballOdds(m.id);
      simAlerts.unshift({id:k25+'_05',type:'football_ht_05',match:`${m.h} vs ${m.a}`,detail:`${m.league} · ~Min.${m.min} · 1ªP +0.5`,alertedAt:nowISO(),resolved:false,outcome:null,_matchId:m.id.replace('fd_',''),_resolveOn:'ht_goal',_market:'+0.5',_nominalStake:50,_league:m.league,_half:1,_liveO1:m.o1,_liveO2:m.o2,_liveOver05:od.over05,_liveOver15:od.over15,_preMatchO1:m.preMatchO1,_preMatchO2:m.preMatchO2,_bookies:od.bookies,_source:od.source});
      simAlerts.unshift({id:k25+'_15',type:'football_ht_15',match:`${m.h} vs ${m.a}`,detail:`${m.league} · ~Min.${m.min} · 1ªP +1.5`,alertedAt:nowISO(),resolved:false,outcome:null,_matchId:m.id.replace('fd_',''),_resolveOn:'ht_goal_15',_market:'+1.5',_nominalStake:25,_league:m.league,_half:1,_liveO1:m.o1,_liveO2:m.o2,_liveOver05:od.over05,_liveOver15:od.over15,_preMatchO1:m.preMatchO1,_preMatchO2:m.preMatchO2,_bookies:od.bookies,_source:od.source});
      if(simAlerts.length>500) simAlerts.length=500;
      const odStr=od.over05?` · +0.5@${od.over05}x +1.5@${od.over15||'?'}x`:'';
      sendTG(`${m.h} vs ${m.a} · ${m.league}\nMin.${m.min} · 0-0 1ªP${odStr}`);
    }
    if(m.min>=46&&m.min<=50&&m.lhH!=null&&!htSnapshot.has(m.id)) htSnapshot.set(m.id,{h:m.lhH,a:m.laH});
    const snap=htSnapshot.get(m.id);
    const goals2h=snap!=null?Math.max(0,((m.lhLive||0)-snap.h)+((m.laLive||0)-snap.a)):0;
    const k67='67_'+m.id;
    if(m.min>=63&&m.min<=78&&!alertedHas(k67)&&goals2h===0){
      alertedAdd(k67);
      const od=getFootballOdds(m.id);
      simAlerts.unshift({id:k67+'_05',type:'football_2h_05',match:`${m.h} vs ${m.a}`,detail:`${m.league} · ~Min.${m.min} · 2ªP +0.5`,alertedAt:nowISO(),resolved:false,outcome:null,_matchId:m.id.replace('fd_',''),_resolveOn:'sh_goal',_market:'+0.5',_nominalStake:50,_league:m.league,_half:2,_liveO1:m.o1,_liveO2:m.o2,_liveOver05:od.over05,_liveOver15:od.over15,_preMatchO1:m.preMatchO1,_preMatchO2:m.preMatchO2,_bookies:od.bookies,_source:od.source});
      simAlerts.unshift({id:k67+'_15',type:'football_2h_15',match:`${m.h} vs ${m.a}`,detail:`${m.league} · ~Min.${m.min} · 2ªP +1.5`,alertedAt:nowISO(),resolved:false,outcome:null,_matchId:m.id.replace('fd_',''),_resolveOn:'sh_goal_15',_market:'+1.5',_nominalStake:25,_league:m.league,_half:2,_liveO1:m.o1,_liveO2:m.o2,_liveOver05:od.over05,_liveOver15:od.over15,_preMatchO1:m.preMatchO1,_preMatchO2:m.preMatchO2,_bookies:od.bookies,_source:od.source});
      if(simAlerts.length>500) simAlerts.length=500;
      const odStr=od.over05?` · +0.5@${od.over05}x +1.5@${od.over15||'?'}x`:'';
      sendTG(`${m.h} vs ${m.a} · ${m.league}\nMin.${m.min} · 0-0 2ªP${odStr}`);
    }
  });
}
function resolveFootballSims(){
  simAlerts.forEach(s=>{
    if(s.resolved||!s._matchId) return;
    const m=allFootballForSim.find(x=>x.id==='fd_'+s._matchId); if(!m) return;
    const pastHT=m.status==='PAUSED'||m.status==='FINISHED'||(m.status==='IN_PLAY'&&m.min>45);
    const goalsHT=(m.lhH||0)+(m.laH||0);
    if(s._resolveOn==='ht_goal'&&pastHT){s.outcome=goalsHT>=1?'WIN':'LOSS';s.resolved=true;s.resolvedAt=nowISO();}
    if(s._resolveOn==='ht_goal_15'&&pastHT){s.outcome=goalsHT>=2?'WIN':'LOSS';s.resolved=true;s.resolvedAt=nowISO();}
    if(s._resolveOn==='sh_goal'&&m.status==='FINISHED'){s.outcome=m.g2>=1?'WIN':'LOSS';s.resolved=true;s.resolvedAt=nowISO();}
    if(s._resolveOn==='sh_goal_15'&&m.status==='FINISHED'){s.outcome=m.g2>=2?'WIN':'LOSS';s.resolved=true;s.resolvedAt=nowISO();}
  });
}

// ═══════════════════════════════════════════════════════════
// TENNIS
// ═══════════════════════════════════════════════════════════
function getCat(s){
  const l=(s||'').toLowerCase();
  if(l.includes('itf')){const isW=l.includes('women')||l.includes(' w ')||/\bitf w\d/i.test(s)||/\bw\d{1,3}\b/.test(s)||l.includes('wta')||l.includes('female')||l.includes('ladies');return isW?'itf_f':'itf_m';}
  if(l.includes('125')||l.includes('w125')||l.includes('wta 125')) return 'wta125';
  if(l.includes('wta')) return 'wta';
  const isFemale=l.includes('women')||l.includes('female')||l.includes('ladies')||l.includes(' w ')||/\bw\d{1,3}\b/.test(s);
  if(isFemale&&l.includes('challenger')) return 'wta125';
  if(isFemale) return 'wta';
  if(l.includes('challenger')) return 'challenger';
  return 'atp';
}
function getTier(s){
  const l=(s||'').toLowerCase();
  if(l.includes('grand slam')||l.includes('australian open')||l.includes('roland garros')||l.includes('wimbledon')||l.includes('us open')) return 'slam';
  if(l.includes('masters 1000')||l.includes('atp 1000')||l.includes('atp1000')) return 'atp1000';
  if(l.includes('atp 500')||l.includes('atp500')) return 'atp500';
  if(l.includes('atp 250')||l.includes('atp250')) return 'atp250';
  if(l.includes('wta 1000')||l.includes('wta1000')) return 'wta1000';
  if(l.includes('wta 500')||l.includes('wta500')) return 'wta500';
  if(l.includes('wta 250')||l.includes('wta250')) return 'wta250';
  if(l.includes('125')||l.includes('w125')||l.includes('wta 125')) return 'wta125';
  const isFemale=l.includes('wta')||l.includes('women')||l.includes('female')||l.includes('ladies')||/\bw\d{1,3}\b/.test(s);
  if(isFemale&&l.includes('challenger')) return 'wta125';
  if(l.includes('challenger')&&!isFemale) return 'challenger';
  if(l.includes('itf')) return 'itf';
  if(isFemale) return 'wta_other';
  return 'atp_other';
}
function normalizeRound(raw){
  if(!raw||!raw.trim()) return null;
  const r=raw.toLowerCase().trim().replace(/-.*$/,'').trim();
  if(r.includes('final')&&(r.includes('quarter')||r.includes('1/4'))) return 'qf';
  if(r.includes('final')&&(r.includes('semi')||r.includes('1/2'))) return 'sf';
  if(r==='final'||r==='the final') return 'f';
  if(r.includes('1/8')||r.includes('round of 16')||r.includes('r16')) return 'r16';
  if(r.includes('1/16')||r.includes('round of 32')||r.includes('r32')) return 'r32';
  if(r.includes('1/32')||r.includes('round of 64')||r.includes('r64')) return 'r64';
  if(r.includes('1/64')||r.includes('round of 128')||r.includes('r128')) return 'r128';
  if(r.includes('qualif')||r.includes('qual.')) return 'q';
  if(r.includes('round robin')||r.includes('group')) return 'rr';
  if(r.match(/round (\d+)/)) return 'r'+r.match(/round (\d+)/)[1];
  return raw.trim().slice(0,20);
}
function getSurface(trn,country,leagueKey){
  if(leagueKey&&surfaceCache.has(String(leagueKey))) return surfaceCache.get(String(leagueKey));
  const l=(trn||'').toLowerCase()+' '+(country||'').toLowerCase();
  if(l.match(/roland garros|monte.carlo|madrid|barcelona|rome|roma|hamburg|estoril|munich|lyon|bucharest|istanbul|marrakech|geneva|nice|bastad|gstaad|umag|kitzbuhel|clay|tierra|cordoba|buenos aires|bogota|santiago|sao paulo|rio|casablanca|rabat|parma|prague|warsaw|strasbourg|nuremberg/)) return 'clay';
  if(l.match(/wimbledon|queens|halle|s-hertogenbosch|eastbourne|nottingham|grass|hierba|birmingham|bad homburg|mallorca|rosmalen/)) return 'grass';
  if(l.match(/rotterdam|marseille|metz|sofia|montpellier|indoor|cubierto|st. petersburg|moscow|vienna|wien|paris bercy|stockholm|basilea|basel|antwerp/)) return 'hard_i';
  return 'hard';
}
function normT(e){
  const _trnFull=(e.country_name||'')+' '+(e.league_name||'');
  const cat=getCat(_trnFull),tier=getTier(e.league_name||''),surface=getSurface(e.league_name||'',e.country_name||'',e.league_key),round=normalizeRound(e.league_round||'');
  const od=getMatchOdds(e);
  const{o1,o2}=od;
  const scores=e.scores||[];
  const cs=scores.filter(s=>{const a=parseInt(s.score_first)||0,b=parseInt(s.score_second)||0;return(a>=6||b>=6)&&(Math.abs(a-b)>=2||a>=7||b>=7);});
  const sets1=cs.map(s=>parseInt(s.score_first)||0),sets2=cs.map(s=>parseInt(s.score_second)||0);
  const curSetNum=cs.length+1;
  const cr1=parseInt(e.event_first_player_score_current_set),cr2=parseInt(e.event_second_player_score_current_set);
  let g1=String(!isNaN(cr1)?cr1:0),g2=String(!isNaN(cr2)?cr2:0);
  const pbp=e.pointbypoint||[];
  const curGames=pbp.filter(g=>g.set_number==='Set '+curSetNum);
  if(g1==='0'&&g2==='0'){const ir=scores.find((s,i)=>i===cs.length);if(ir){const a=parseInt(ir.score_first),b=parseInt(ir.score_second);if(!isNaN(a)&&!isNaN(b)){g1=String(a);g2=String(b);}}}
  if(g1==='0'&&g2==='0'&&curGames.length>0){const lp=curGames[curGames.length-1];if(lp?.score){const sp=(lp.score||'').split(' - ');if(sp.length===2){g1=sp[0].trim();g2=sp[1].trim();}}}
  const rawPt=(e.event_game_result||'').trim();
  let pt1='',pt2='';
  if(rawPt&&rawPt!=='0 - 0'&&rawPt!=='-'){const spt=rawPt.split(' - ');if(spt.length===2){pt1=spt[0].trim();pt2=spt[1].trim();}}
  let lastBreak=null;
  for(let i=curGames.length-1;i>=0;i--){const g=curGames[i];if(g?.serve_lost!=null&&g.serve_lost!==''){const sp=(g.score||'').split(' - ');lastBreak={setLabel:g.set_number,gameNum:String(g.number_game??i),broken:g.serve_lost,gP1:parseInt(sp[0])||0,gP2:parseInt(sp[1])||0};break;}}
  const mon=(o1!=null&&o1>=ODD_MIN&&o1<=ODD_MAX)||(o2!=null&&o2>=ODD_MIN&&o2<=ODD_MAX);
  return{id:'td_'+e.event_key,_key:String(e.event_key),cat,tier,surface,round,trn:e.league_name||'Torneo',
    p1:e.event_first_player||'?',p2:e.event_second_player||'?',
    o1,o2,sets1,sets2,g1,g2,pt1,pt2,srv:e.event_serve==='First Player'?1:2,
    curSetNum,lastBreak,pbpLen:pbp.length,mon,isUp:false,hasOdds:o1!=null||o2!=null,liveO1:o1,liveO2:o2,
    preMatchO1:od.preMatch?.o1||null,preMatchO2:od.preMatch?.o2||null,
    bookies:od.bookies||[],source:od.source||null,bookieCount:od.bookieCount||0};
}
function normTUp(e){
  const cat=getCat((e.country_name||'')+' '+(e.league_name||'')),tier=getTier(e.league_name||''),surface=getSurface(e.league_name||'',e.country_name||'',e.league_key),round=normalizeRound(e.league_round||'');
  let dt;try{dt=new Date(`${e.event_date}T${e.event_time||'00:00'}:00`);}catch{dt=new Date();}
  if(isNaN(dt.getTime())) dt=new Date();
  const od=getMatchOdds(e);const{o1,o2}=od;
  const mon=(o1!=null&&o1>=ODD_MIN&&o1<=ODD_MAX)||(o2!=null&&o2>=ODD_MIN&&o2<=ODD_MAX);
  return{id:'tdu_'+e.event_key,_key:String(e.event_key),cat,tier,surface,round,trn:e.league_name||'Torneo',
    p1:e.event_first_player||'?',p2:e.event_second_player||'?',o1,o2,mon,hasOdds:o1!=null||o2!=null,
    localT:dt.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Madrid'}),
    localD:dt.toLocaleDateString('es-ES',{weekday:'short',day:'2-digit',month:'2-digit'}),
    _ts:dt.getTime(),isUp:true};
}
async function loadSurfaceCache(){
  if(!TENNIS_KEY) return;
  try{
    const r=await fetchJson(`https://apiv2.allsportsapi.com/tennis/?met=Countries&APIkey=${TENNIS_KEY}`);
    if(!r.result) return;
    let loaded=0;
    r.result.forEach(t=>{if(!t.league_key||!t.league_surface)return;const raw=(t.league_surface||'').toLowerCase().trim();let surf='hard';if(raw.includes('clay'))surf='clay';else if(raw.includes('grass'))surf='grass';else if(raw.includes('carpet')||raw.includes('indoor'))surf='hard_i';surfaceCache.set(String(t.league_key),surf);loaded++;});
    console.log(`[SURFACE] Cache: ${loaded} torneos`);
  }catch(e){console.warn('[SURFACE]',e.message);}
}
async function fetchTennis(){
  if(!TENNIS_KEY) return [];
  await fetchTennisOdds();
  const[lR,uR]=await Promise.allSettled([
    fetchJson(`https://apiv2.allsportsapi.com/tennis/?met=Livescore&APIkey=${TENNIS_KEY}`),
    fetchJson(`https://apiv2.allsportsapi.com/tennis/?met=Fixtures&APIkey=${TENNIS_KEY}&from=${todayStr()}&to=${tomorrowStr()}`),
  ]);
  const liveRaw=(lR.status==='fulfilled'&&lR.value.result)?lR.value.result:[];
  const upRaw=(uR.status==='fulfilled'&&uR.value.result)?uR.value.result:[];
  const liveSingles=liveRaw.filter(e=>!isDoubles(e)&&e.event_status!=='Finished');
  const upSingles=upRaw.filter(e=>e.event_live==='0'&&!isDoubles(e));
  const live=liveSingles.map(normT),up=upSingles.map(normTUp);
  const liveFiltered=live.filter(m=>m.mon);
  lastTennis=[...liveFiltered,...up];
  console.log(`[TENNIS] Live:${live.length} mon:${liveFiltered.length} Up:${up.length} Odds:${oddsCache.size}`);
  return liveFiltered;
}
function isBreakAlert(m){
  if(!m.lastBreak||m.isUp) return false;
  const favIs=m.o1!=null&&m.o1>=ODD_MIN&&m.o1<=ODD_MAX?'First Player':m.o2!=null&&m.o2>=ODD_MIN&&m.o2<=ODD_MAX?'Second Player':null;
  if(!favIs||m.lastBreak.broken!==favIs) return false;
  const favG=favIs==='First Player'?parseInt(m.g1):parseInt(m.g2);
  const rivG=favIs==='First Player'?parseInt(m.g2):parseInt(m.g1);
  if(rivG<=favG) return false;
  const brkRivG=favIs==='First Player'?m.lastBreak.gP2:m.lastBreak.gP1;
  return rivG===brkRivG;
}
function checkTennisAlerts(live){
  live.forEach(m=>{
    if(!isBreakAlert(m)) return;
    const kb=`brk_set_${m.id}_s${m.curSetNum}`;
    if(alertedHas(kb)) return; alertedAdd(kb);
    const favIs=(m.o1!=null&&m.o1>=ODD_MIN&&m.o1<=ODD_MAX)?'First Player':'Second Player';
    const favName=favIs==='First Player'?m.p1:m.p2,favO=favIs==='First Player'?m.o1:m.o2;
    const oddsband=favO==null?'n/d':favO<1.30?'1.20-1.30':favO<1.40?'1.30-1.40':favO<1.50?'1.40-1.50':'1.50-1.60';
    simAlerts.unshift({id:kb,type:'tennis_break',match:`${m.p1} vs ${m.p2}`,
      detail:`${m.trn} [${m.cat.toUpperCase()}] · Set ${m.curSetNum}: ${m.lastBreak.gP1}–${m.lastBreak.gP2} · Fav ROTO: ${favName}`,
      alertedAt:nowISO(),resolved:false,outcome:null,
      _eventId:m.id,_setNum:m.curSetNum,_favIs:favIs,
      _setsP1atAlert:[...m.sets1],_setsP2atAlert:[...m.sets2],
      _favO:favO,_oddsband:oddsband,_cat:m.cat,_tier:m.tier,_surface:m.surface,_round:m.round,
      _liveO1:m.o1,_liveO2:m.o2,_preMatchO1:m.preMatchO1,_preMatchO2:m.preMatchO2,
      _bookie:m.source||'AllSports',_bookies:m.bookies||[],_bookieCount:m.bookieCount||0});
    if(simAlerts.length>500) simAlerts.length=500;
    sendTG(`${m.p1} vs ${m.p2} · ${m.trn}\nBreak ${m.curSetNum}º set: ${m.g1}-${m.g2} · ${favName} roto\npre:${m.preMatchO1||'?'}x live:${favO!=null?favO+'x':'n/d'}`);
  });
  scheduleFbSave();
}
function checkSet1Loss(live){
  live.forEach(m=>{
    const favIs=m.o1!=null&&m.o1>=ODD_MIN&&m.o1<=ODD_MAX?'First Player':m.o2!=null&&m.o2>=ODD_MIN&&m.o2<=ODD_MAX?'Second Player':null;
    if(!favIs||m.sets1.length!==1) return;
    const fav1=favIs==='First Player'?m.sets1[0]:m.sets2[0],riv1=favIs==='First Player'?m.sets2[0]:m.sets1[0];
    if(fav1>=riv1) return;
    const favName=favIs==='First Player'?m.p1:m.p2,favO=favIs==='First Player'?m.o1:m.o2;
    const oddsband=favO==null?'n/d':favO<1.30?'1.20-1.30':favO<1.40?'1.30-1.40':favO<1.50?'1.40-1.50':'1.50-1.60';
    const ks2=`set1loss_s2_${m.id}`,ksM=`set1loss_match_${m.id}`;
    if(!alertedHas(ksM)){
      if(!alertedHas(ks2)){
        alertedAdd(ks2);
        simAlerts.unshift({id:ks2,type:'tennis_set1_set2',match:`${m.p1} vs ${m.p2}`,
          detail:`${m.trn} [${m.cat.toUpperCase()}] · Set1: ${m.sets1[0]}-${m.sets2[0]} · Fav pierde S1 → Gana S2?`,
          alertedAt:nowISO(),resolved:false,outcome:null,_eventId:m.id,_setNum:2,_favIs:favIs,
          _setsP1atAlert:[...m.sets1],_setsP2atAlert:[...m.sets2],_favO:favO,_oddsband:oddsband,
          _cat:m.cat,_tier:m.tier,_surface:m.surface,_round:m.round,
          _liveO1:m.o1,_liveO2:m.o2,_preMatchO1:m.preMatchO1,_preMatchO2:m.preMatchO2,
          _bookie:m.source||'AllSports',_bookies:m.bookies||[],_bookieCount:m.bookieCount||0});
        if(simAlerts.length>500) simAlerts.length=500;
      }
      alertedAdd(ksM);
      simAlerts.unshift({id:ksM,type:'tennis_set1_match',match:`${m.p1} vs ${m.p2}`,
        detail:`${m.trn} [${m.cat.toUpperCase()}] · Set1: ${m.sets1[0]}-${m.sets2[0]} · Fav pierde S1 → Gana partido?`,
        alertedAt:nowISO(),resolved:false,outcome:null,_eventId:m.id,_favIs:favIs,
        _setsP1atAlert:[...m.sets1],_setsP2atAlert:[...m.sets2],_favO:favO,_oddsband:oddsband,
        _cat:m.cat,_tier:m.tier,_surface:m.surface,_round:m.round,
        _liveO1:m.o1,_liveO2:m.o2,_preMatchO1:m.preMatchO1,_preMatchO2:m.preMatchO2,
        _bookie:m.source||'AllSports',_bookies:m.bookies||[],_bookieCount:m.bookieCount||0});
      if(simAlerts.length>500) simAlerts.length=500;
      sendTG(`${m.p1} vs ${m.p2} · ${m.trn}\nSet 1: ${m.sets1[0]}-${m.sets2[0]} · ${favName} pierde S1\npre:${m.preMatchO1||'?'}x live:${favO!=null?favO+'x':'n/d'}\nApostar: gana S2 / gana partido`);
    }
  });
  scheduleFbSave();
}
function checkBreakRecovery(live){
  live.forEach(m=>{
    const favIs=m.o1!=null&&m.o1>=ODD_MIN&&m.o1<=ODD_MAX?'First Player':m.o2!=null&&m.o2>=ODD_MIN&&m.o2<=ODD_MAX?'Second Player':null;
    if(!favIs) return;
    const favG=parseInt(favIs==='First Player'?m.g1:m.g2)||0,rivG=parseInt(favIs==='First Player'?m.g2:m.g1)||0;
    const favName=favIs==='First Player'?m.p1:m.p2,favO=favIs==='First Player'?m.o1:m.o2;
    const breakSim=simAlerts.find(s=>s.type==='tennis_break'&&!s.resolved&&s._eventId===m.id&&s._setNum===m.curSetNum);
    if(!breakSim) return;
    const rkKey=`${m.id}_s${m.curSetNum}`;
    if(!breakRecoveries.has(rkKey)) breakRecoveries.set(rkKey,{recovered:false,alertedRecovery:false});
    const rec=breakRecoveries.get(rkKey);
    if(favG>0&&favG===rivG&&!rec.alertedRecovery){
      rec.alertedRecovery=true;rec.recovered=true;
      const krec=`rec_${m.id}_s${m.curSetNum}_${favG}`;
      if(!alertedHas(krec)){alertedAdd(krec);
        simAlerts.unshift({id:krec,type:'tennis_recovery',match:`${m.p1} vs ${m.p2}`,detail:`${m.trn} [${m.cat.toUpperCase()}] · Set ${m.curSetNum}: empate ${favG}-${rivG}`,alertedAt:nowISO(),resolved:true,outcome:'RECOVERY',_eventId:m.id,_setNum:m.curSetNum,_favIs:favIs,_favO:favO,_oddsband:breakSim._oddsband});
        if(simAlerts.length>500) simAlerts.length=500;
        sendTG(`${m.p1} vs ${m.p2} · ${m.trn}\nBreak recuperado set ${m.curSetNum}: ${m.g1}-${m.g2} · ${favName} igualó`);
      }
    }
    if(favG>rivG&&rec.alertedRecovery) rec.alertedRecovery=false;
  });
}
function checkFootballStart(){lastFootball.forEach(m=>{if(m.status!=='IN_PLAY')return;const ks=`fstart_${m.id}`;if(alertedHas(ks))return;alertedAdd(ks);sendTG(`${m.h} vs ${m.a} · ${m.league}\nPartido iniciado`);});}
function checkMonitoredMatchStart(){lastTennis.filter(m=>!m.isUp&&m.mon&&m.pbpLen>0).forEach(m=>{const ks=`start_${m.id}`;if(alertedHas(ks))return;alertedAdd(ks);const favIs=(m.o1!=null&&m.o1>=ODD_MIN&&m.o1<=ODD_MAX)?'First Player':'Second Player';const favName=favIs==='First Player'?m.p1:m.p2,favO=favIs==='First Player'?m.o1:m.o2;sendTG(`${m.p1} vs ${m.p2} · ${m.trn}\nInicio monitorizado · fav ${favName} @${favO!=null?favO+'x':'n/d'}`);});}
function resolveTennisSims(){
  simAlerts.forEach(s=>{
    if(s.resolved)return;
    const m=lastTennis.find(x=>x.id===s._eventId);if(!m||m.isUp)return;
    const favName=s._favIs==='First Player'?s.match.split(' vs ')[0]:(s.match.split(' vs ')[1]||'').trim();
    if(s.type==='tennis_break'&&m.sets1.length>s._setsP1atAlert.length){
      const idx=s._setNum-1,favWon=s._favIs==='First Player'?m.sets1[idx]>m.sets2[idx]:m.sets2[idx]>m.sets1[idx];
      const sc1=m.sets1[idx],sc2=m.sets2[idx];
      s._tiebreak=(sc1===7&&sc2===6)||(sc1===6&&sc2===7);s._setScore=sc1+'-'+sc2;
      s.outcome=favWon?'WIN':'LOSS';s.resolved=true;s.resolvedAt=nowISO();
      sendTG(`${s.match}\nSet ${s._setNum}: ${sc1}-${sc2}${s._tiebreak?' (tiebreak)':''} · ${favName} ${favWon?'gana':'pierde'} el set`);
    }
    if(s.type==='tennis_set1_set2'&&m.sets1.length>=2){
      const favWon=s._favIs==='First Player'?m.sets1[1]>m.sets2[1]:m.sets2[1]>m.sets1[1];
      s.outcome=favWon?'WIN':'LOSS';s.resolved=true;s.resolvedAt=nowISO();
      sendTG(`${s.match}\nSet 2: ${m.sets1[1]}-${m.sets2[1]} · ${favName} ${favWon?'gana':'pierde'} S2`);
    }
    if(s.type==='tennis_set1_match'){
      const done=m.sets1.length>=2&&(m.sets1.filter((v,i)=>v>m.sets2[i]).length===2||m.sets2.filter((v,i)=>v>m.sets1[i]).length===2);
      if(done){const p1w=m.sets1.filter((v,i)=>v>m.sets2[i]).length,p2w=m.sets2.filter((v,i)=>v>m.sets1[i]).length;const favWon=s._favIs==='First Player'?p1w>p2w:p2w>p1w;s.outcome=favWon?'WIN':'LOSS';s.resolved=true;s.resolvedAt=nowISO();sendTG(`${s.match}\n${m.sets1.map((v,i)=>`${v}-${m.sets2[i]}`).join(' ')} · ${favName} ${favWon?'gana':'pierde'} el partido`);}
    }
  });
  scheduleFbSave();
}

// ═══════════════════════════════════════════════════════════
// POLL — 30s con live, 120s sin
// ═══════════════════════════════════════════════════════════
async function poll(){
  try{
    stats.pollCount++;
    await fetchFootballLiveOdds().catch(e=>console.warn('[ODDS-F poll]',e.message));
    const live=await fetchTennis().catch(e=>{console.error('[TENNIS]',e.message);return[];});
    await fetchFootball().catch(e=>console.error('[FOOTBALL]',e.message));
    checkTennisAlerts(live||[]);
    checkSet1Loss(live||[]);
    checkBreakRecovery(live||[]);
    checkMonitoredMatchStart();
    checkFootballAlerts();
    checkFootballStart();
    resolveTennisSims();
    resolveFootballSims();
    lastUpdate=nowISO();
    if(stats.pollCount%20===0){cleanupAlerted();console.log(`[POLL #${stats.pollCount}] Tennis:${lastTennis.filter(m=>!m.isUp).length} Football:${lastFootball.filter(m=>m.status==='IN_PLAY').length} Odds:${oddsCache.size} Alerted:${alerted.size} OddsUpd:${stats.oddsUpdates}`);}
  }catch(e){stats.errors++;console.error('[POLL ERROR]',e.message);}
  setTimeout(poll, hasLiveMatches()?30000:120000);
}

// ═══════════════════════════════════════════════════════════
// HTTP SERVER
// ═══════════════════════════════════════════════════════════
const CORS_HEADERS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'};

async function ghUpsertFile(repoPath,contentStr,commitMsg){
  const GH_TOKEN=process.env.GH_TOKEN||'',GH_REPO=process.env.GH_REPO||'Roturas25/Roturas25prod';
  if(!GH_TOKEN) throw new Error('GH_TOKEN not set');
  const b64=Buffer.from(contentStr).toString('base64');
  let sha;try{const ex=await fetchJson(`https://api.github.com/repos/${GH_REPO}/contents/${repoPath}`,{Authorization:`token ${GH_TOKEN}`,Accept:'application/vnd.github.v3+json','User-Agent':'Roturas25'});sha=ex?.sha;}catch(_){}
  const body=JSON.stringify({message:commitMsg,content:b64,...(sha?{sha}:{})});
  await new Promise((res,rej)=>{const buf=Buffer.from(body);const r=https.request({hostname:'api.github.com',path:`/repos/${GH_REPO}/contents/${repoPath}`,method:'PUT',headers:{Authorization:`token ${GH_TOKEN}`,Accept:'application/vnd.github.v3+json','Content-Type':'application/json','Content-Length':buf.length,'User-Agent':'Roturas25-Server'}},r=>{r.resume();r.on('end',res);});r.on('error',rej);r.write(buf);r.end();});
}

const server=http.createServer((req,res)=>{
  Object.entries(CORS_HEADERS).forEach(([k,v])=>res.setHeader(k,v));
  res.setHeader('Content-Type','application/json');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  const path=new URL(req.url,'http://localhost').pathname;

  if(path==='/health'&&req.method==='GET'){
    res.writeHead(200);
    res.end(JSON.stringify({ok:true,version:'v7',football:!!FOOTBALL_KEY,tennis:!!TENNIS_KEY,liveOdds:!!THEODDS_KEY,telegram:!!TG_TOKEN,oddMin:ODD_MIN,oddMax:ODD_MAX,updated:lastUpdate,stats,liveFootball:lastFootball.filter(m=>m.status==='IN_PLAY'||m.status==='PAUSED').length,liveTennis:lastTennis.filter(m=>!m.isUp).length,oddsCache:oddsCache.size,simCount:simAlerts.length,pollInterval:hasLiveMatches()?'30s':'120s'}));
    return;
  }

  if(path==='/data'&&req.method==='GET'){
    const ftStats={ht_05:{alerts:0,wins:0,losses:0},ht_15:{alerts:0,wins:0,losses:0},'2h_05':{alerts:0,wins:0,losses:0},'2h_15':{alerts:0,wins:0,losses:0}};
    const oddStats={},catStats={};
    ['1.20-1.30','1.30-1.40','1.40-1.50','1.50-1.60'].forEach(b=>{oddStats[b]={alerts:0,wins:0,losses:0,recoveries:0};});
    simAlerts.forEach(s=>{
      if(s.resolved){const k=s.type==='football_ht_05'?'ht_05':s.type==='football_ht_15'?'ht_15':s.type==='football_2h_05'?'2h_05':s.type==='football_2h_15'?'2h_15':null;if(k){ftStats[k].alerts++;if(s.outcome==='WIN')ftStats[k].wins++;if(s.outcome==='LOSS')ftStats[k].losses++;}}
      if(['tennis_break','tennis_set1_set2','tennis_set1_match'].includes(s.type)&&s.resolved&&s._oddsband){const b=s._oddsband;if(!oddStats[b])oddStats[b]={alerts:0,wins:0,losses:0,recoveries:0};oddStats[b].alerts++;if(s.outcome==='WIN')oddStats[b].wins++;if(s.outcome==='LOSS')oddStats[b].losses++;}
      if(s.type==='tennis_recovery'&&s._oddsband){if(!oddStats[s._oddsband])oddStats[s._oddsband]={alerts:0,wins:0,losses:0,recoveries:0};oddStats[s._oddsband].recoveries++;}
      const cat=s._cat;
      if(cat&&['tennis_break','tennis_set1_set2','tennis_set1_match'].includes(s.type)&&s.resolved){if(!catStats[cat])catStats[cat]={alerts:0,wins:0,losses:0,recoveries:0};catStats[cat].alerts++;if(s.outcome==='WIN')catStats[cat].wins++;if(s.outcome==='LOSS')catStats[cat].losses++;}
      if(cat&&s.type==='tennis_recovery'){if(!catStats[cat])catStats[cat]={alerts:0,wins:0,losses:0,recoveries:0};catStats[cat].recoveries++;}
    });
    res.writeHead(200);
    res.end(JSON.stringify({football:lastFootball,tennis:lastTennis,updated:lastUpdate,alerted:[...alerted.keys()],simAlerts:simAlerts.slice(0,200),oddStats,catStats,ftStats,liveOddsActive:!!THEODDS_KEY}));
    return;
  }

  if(path==='/reset'&&req.method==='POST'){
    let body='';
    req.on('data',d=>{body+=d;if(body.length>1024)req.destroy();});
    req.on('end',async()=>{
      try{
        const{secret}=JSON.parse(body||'{}');
        if(secret!==(process.env.DEPLOY_SECRET||'roturas25deploy')){res.writeHead(403);res.end(JSON.stringify({error:'Forbidden'}));return;}
        await Promise.all([fbDelete('/btdata'),fbDelete('/btcleared'),fbDelete('/bets'),fbDelete('/state/sims')]);
        simAlerts.length=0;
        console.log('[RESET] Firebase limpiado');
        res.writeHead(200);res.end(JSON.stringify({ok:true,cleared:['btdata','bets','state/sims','btcleared'],ts:nowISO()}));
      }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    });
    return;
  }

  if(path==='/admin/push'&&req.method==='POST'){
    let body='';
    req.on('data',d=>{body+=d;if(body.length>5*1024*1024)req.destroy();});
    req.on('end',async()=>{
      try{
        const{secret,file,content:fileContent}=JSON.parse(body);
        if(secret!==(process.env.DEPLOY_SECRET||'roturas25deploy')){res.writeHead(403);res.end(JSON.stringify({error:'Forbidden'}));return;}
        if(!file||!fileContent){res.writeHead(400);res.end(JSON.stringify({error:'file and content required'}));return;}
        if(!['server.js','docs/index.html','package.json'].includes(file)){res.writeHead(400);res.end(JSON.stringify({error:'file not allowed'}));return;}
        await ghUpsertFile(file,fileContent,`Deploy ${file} ${nowISO()}`);
        res.writeHead(200);res.end(JSON.stringify({ok:true,file,pushed:true}));
        console.log('[DEPLOY] pushed',file);
      }catch(e){console.error('[DEPLOY ERROR]',e.message);res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    });
    return;
  }

  res.writeHead(404);res.end(JSON.stringify({error:'Not found'}));
});

server.listen(PORT,async()=>{
  console.log(`\n🎾 ROTURAS25 v7 — puerto ${PORT}`);
  console.log(`   Football:${FOOTBALL_KEY?'✓':'✗'}  Tennis:${TENNIS_KEY?'✓':'✗'}  TG:${TG_TOKEN?'✓':'✗'}`);
  console.log(`   LiveOdds(TheOddsAPI):${THEODDS_KEY?'✓ ACTIVO':'✗ no configurado — solo pre-match AllSports'}`);
  console.log(`   ODD_MIN:${ODD_MIN}  ODD_MAX:${ODD_MAX}  Poll: 30s live / 120s idle\n`);
  await loadSurfaceCache();
  await loadStateFromFB();
  poll();
});
