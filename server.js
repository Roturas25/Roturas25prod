'use strict';
const http  = require('http');
const https = require('https');

process.on('uncaughtException',  e => console.error('[UNCAUGHT]',  e.message));
process.on('unhandledRejection', e => console.error('[UNHANDLED]', String(e)));

const FOOTBALL_KEY = process.env.FOOTBALL_KEY || '';
const TENNIS_KEY   = process.env.TENNIS_KEY   || '';
const TG_TOKEN     = process.env.TG_TOKEN     || '8171273424:AAGMvAxhDnt-HSZSZi8DJeV0j6YEwhfHC5E';
const TG_CHAT      = process.env.TG_CHAT      || '6307700447';
const PORT         = parseInt(process.env.PORT || '3000', 10);
const ODD_MIN      = parseFloat(process.env.ODD_MIN || '1.20');
const ODD_MAX      = parseFloat(process.env.ODD_MAX || '1.60');

const alerted           = new Set();
let   lastFootball      = [];
let   allFootballForSim = [];
let   lastTennis        = [];
let   lastUpdate        = null;
const stats             = { pollCount:0, alertsSent:0, errors:0 };
const simAlerts         = [];
const oddsCache         = new Map();
const htSnapshot        = new Map();
const kickoffSnapshot   = new Map();
const breakRecoveries   = new Map();

function todayStr()   { return new Date().toISOString().split('T')[0]; }
function tomorrowStr(){ return new Date(Date.now()+86400000).toISOString().split('T')[0]; }
function nowISO()     { return new Date().toISOString(); }

function fetchJson(url, headers={}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {headers}, res => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){reject(new Error('JSON:'+d.slice(0,100)));} });
    });
    req.on('error',reject);
    req.setTimeout(15000,()=>{req.destroy();reject(new Error('Timeout'));});
  });
}

async function sendTG(msg) {
  if (!TG_TOKEN||!TG_CHAT) return;
  try {
    const body=JSON.stringify({chat_id:TG_CHAT,text:msg});
    await new Promise((res,rej)=>{
      const r=https.request({hostname:'api.telegram.org',path:`/bot${TG_TOKEN}/sendMessage`,method:'POST',
        headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},
        r=>{r.resume();r.on('end',res);});
      r.on('error',rej); r.write(body); r.end();
    });
    stats.alertsSent++;
  } catch(e){console.error('[TG]',e.message);}
}

function hasLiveMatches(){
  return lastFootball.some(m=>m.status==='IN_PLAY'||m.status==='PAUSED')
      || lastTennis.some(m=>!m.isUp);
}
function isDoubles(e){
  const p1=(e.event_first_player||'').trim(), p2=(e.event_second_player||'').trim(), lg=(e.league_name||'').toLowerCase();
  return p1.includes('/')||p2.includes('/')||lg.includes('double')||lg.includes('doble');
}

// ── Cuotas ──────────────────────────────────────────────────────────────────
function buildOddsCache(result){
  if(!result||typeof result!=='object') return;
  Object.entries(result).forEach(([id,data])=>{
    if(oddsCache.has(id)) return;
    const hw=data['Home/Away']||data['1X2']||data['Match Winner']||data['Winner']||null;
    if(!hw) return;
    function median(obj){
      if(!obj||typeof obj!=='object') return null;
      const v=Object.values(obj).map(x=>parseFloat(x)).filter(x=>!isNaN(x)&&x>1);
      if(!v.length) return null; v.sort((a,b)=>a-b);
      return Math.round(v[Math.floor(v.length/2)]*100)/100;
    }
    const o1=median(hw['Home']||hw['Player 1']||hw['First Player']);
    const o2=median(hw['Away']||hw['Player 2']||hw['Second Player']);
    if(o1||o2) oddsCache.set(id,{o1:o1||null,o2:o2||null});
  });
}
async function fetchAllOdds(){
  if(!TENNIS_KEY) return;
  const [t,tm]=[todayStr(),tomorrowStr()];
  for(const url of[
    `https://apiv2.allsportsapi.com/tennis/?met=Odds&APIkey=${TENNIS_KEY}&from=${t}&to=${tm}`,
    `https://apiv2.allsportsapi.com/tennis/?met=Odds&APIkey=${TENNIS_KEY}`,
  ]){
    try{const r=await fetchJson(url);if(r.success&&r.result)buildOddsCache(r.result);}
    catch(e){console.warn('[ODDS]',e.message);}
  }
}
function getMatchOdds(e){ return oddsCache.get(String(e.event_key))||{o1:null,o2:null}; }

// ── Football ─────────────────────────────────────────────────────────────────
function normF(m,code){
  const shF=m.score?.fullTime?.home??m.score?.home??0;
  const saF=m.score?.fullTime?.away??m.score?.away??0;
  const shH=m.score?.halfTime?.home??null;
  const saH=m.score?.halfTime?.away??null;
  let min=0;
  if(m.status==='PAUSED'){min=45;}
  else if(m.status==='IN_PLAY'){
    if(m.minute!=null&&m.minute>0){min=m.minute+(m.injuryTime||0);}
    else{
      const startTs=m.utcDate?new Date(m.utcDate).getTime():0;
      if(startTs>0){
        const el=Math.floor((Date.now()-startTs)/60000);
        min=el<=47?el:el<=62?45:Math.min(45+(el-62),90);
      }
    }
  }
  const g2=shH!=null?Math.max(0,(shF-shH)+(saF-saH)):0;
  return{id:'fd_'+m.id,league:code==='PD'?'LaLiga EA Sports':'Premier League',k:code==='PD'?'laliga':'premier',
    status:m.status,min,h:m.homeTeam?.shortName||m.homeTeam?.name||'?',a:m.awayTeam?.shortName||m.awayTeam?.name||'?',
    hc:m.homeTeam?.crest||null,ac:m.awayTeam?.crest||null,
    lh:shF,la:saF,lhLive:shF,laLive:saF,lhH:shH,laH:saH,g2,utcDate:m.utcDate,
    a25:alerted.has('25_fd_'+m.id),a67:alerted.has('67_fd_'+m.id)};
}
async function fetchFootball(){
  if(!FOOTBALL_KEY) return;
  const [t,tm]=[todayStr(),tomorrowStr()];
  const [pd,pl]=await Promise.all([
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
    if(m.min>=22&&m.min<=38&&!alerted.has(k25)&&knownGoals1h===0){
      alerted.add(k25);
      simAlerts.unshift({id:k25+'_05',type:'football_ht_05',match:`${m.h} vs ${m.a}`,detail:`${m.league} · ~Min.${m.min} · 1ªP +0.5`,alertedAt:nowISO(),resolved:false,outcome:null,_matchId:m.id.replace('fd_',''),_resolveOn:'ht_goal',_market:'+0.5',_nominalStake:50,_league:m.league,_half:1});
      simAlerts.unshift({id:k25+'_15',type:'football_ht_15',match:`${m.h} vs ${m.a}`,detail:`${m.league} · ~Min.${m.min} · 1ªP +1.5`,alertedAt:nowISO(),resolved:false,outcome:null,_matchId:m.id.replace('fd_',''),_resolveOn:'ht_goal_15',_market:'+1.5',_nominalStake:25,_league:m.league,_half:1});
      if(simAlerts.length>500) simAlerts.length=500;
      sendTG(`⚽ ROTURAS25 — FÚTBOL 1ª PARTE\n━━━━━━━━━━━━━━━━━━━━\n${m.league}\n${m.h} vs ${m.a}\n━━━━━━━━━━━━━━━━━━━━\n⏱ ~Min.${m.min}\n→ APUESTA 1: +0.5 goles 1ªP · 50€\n→ APUESTA 2: +1.5 goles 1ªP · 25€`);
    }
    if(m.min>=46&&m.min<=50&&m.lhH!=null&&!htSnapshot.has(m.id)) htSnapshot.set(m.id,{h:m.lhH,a:m.laH});
    const snap=htSnapshot.get(m.id);
    const goals2h=snap!=null?Math.max(0,((m.lhLive||0)-snap.h)+((m.laLive||0)-snap.a)):0;
    const k67='67_'+m.id;
    if(m.min>=63&&m.min<=78&&!alerted.has(k67)&&goals2h===0){
      alerted.add(k67);
      simAlerts.unshift({id:k67+'_05',type:'football_2h_05',match:`${m.h} vs ${m.a}`,detail:`${m.league} · ~Min.${m.min} · 2ªP +0.5`,alertedAt:nowISO(),resolved:false,outcome:null,_matchId:m.id.replace('fd_',''),_resolveOn:'sh_goal',_market:'+0.5',_nominalStake:50,_league:m.league,_half:2});
      simAlerts.unshift({id:k67+'_15',type:'football_2h_15',match:`${m.h} vs ${m.a}`,detail:`${m.league} · ~Min.${m.min} · 2ªP +1.5`,alertedAt:nowISO(),resolved:false,outcome:null,_matchId:m.id.replace('fd_',''),_resolveOn:'sh_goal_15',_market:'+1.5',_nominalStake:25,_league:m.league,_half:2});
      if(simAlerts.length>500) simAlerts.length=500;
      sendTG(`⚽ ROTURAS25 — FÚTBOL 2ª PARTE\n━━━━━━━━━━━━━━━━━━━━\n${m.league}\n${m.h} vs ${m.a}\n━━━━━━━━━━━━━━━━━━━━\n⏱ ~Min.${m.min}\n→ APUESTA 1: +0.5 goles 2ªP · 50€\n→ APUESTA 2: +1.5 goles 2ªP · 25€`);
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

// ── Tennis ───────────────────────────────────────────────────────────────────
function getCat(s){
  const l=(s||'').toLowerCase();
  if(l.includes('itf')){
    const isW=l.includes('women')||l.includes(' w ')||/\bitf w\d/i.test(s)||/\bw\d{1,3}\b/.test(s)||l.includes('wta')||l.includes('female')||l.includes('ladies');
    return isW?'itf_f':'itf_m';
  }
  if(l.includes('125')||l.includes('w125')) return 'wta125';
  if(l.includes('wta')) return 'wta';
  if(l.includes('challenger')) return 'challenger';
  return 'atp';
}
function normT(e){
  const cat=getCat((e.country_name||'')+' '+(e.league_name||''));
  const{o1,o2}=getMatchOdds(e);
  const scores=e.scores||[];
  const cs=scores.filter(s=>{const a=parseInt(s.score_first)||0,b=parseInt(s.score_second)||0;return(a>=6||b>=6)&&(Math.abs(a-b)>=2||a>=7||b>=7);});
  const sets1=cs.map(s=>parseInt(s.score_first)||0), sets2=cs.map(s=>parseInt(s.score_second)||0);
  const curSetNum=cs.length+1;
  // Juegos del set actual — 3 fuentes por orden de prioridad
  const cr1=parseInt(e.event_first_player_score_current_set), cr2=parseInt(e.event_second_player_score_current_set);
  let g1=String(!isNaN(cr1)?cr1:0), g2=String(!isNaN(cr2)?cr2:0);
  const pbp=e.pointbypoint||[];
  const curGames=pbp.filter(g=>g.set_number==='Set '+curSetNum);
  // Fallback 1: última fila de scores[] que NO pasó el filtro de set completado
  // (AllSportsAPI mete el set en curso en scores[] cuando current_set viene vacío)
  if(g1==='0'&&g2==='0'){
    const incompleteRow=scores.find((s,i)=>i===cs.length); // la fila justo después de los completados
    if(incompleteRow){
      const a=parseInt(incompleteRow.score_first),b=parseInt(incompleteRow.score_second);
      if(!isNaN(a)&&!isNaN(b)){g1=String(a);g2=String(b);}
    }
  }
  // Fallback 2: score del último juego registrado en el pbp del set actual
  if(g1==='0'&&g2==='0'&&curGames.length>0){
    const lastPbp=curGames[curGames.length-1];
    if(lastPbp&&lastPbp.score){const sp=(lastPbp.score||'').split(' - ');if(sp.length===2){g1=(sp[0]||'0').trim();g2=(sp[1]||'0').trim();}}
  }
  // Puntos del juego en curso: event_game_result = "40 - 15" / "AD - 40" / "0 - 0"
  const rawPt=(e.event_game_result||'').trim();
  let pt1='',pt2='';
  if(rawPt&&rawPt!=='0 - 0'&&rawPt!=='-'){
    const spt=rawPt.split(' - ');
    if(spt.length===2){pt1=spt[0].trim();pt2=spt[1].trim();}
  }
  let lastBreak=null;
  for(let i=curGames.length-1;i>=0;i--){
    const g=curGames[i];
    if(g&&g.serve_lost!=null&&g.serve_lost!==''){
      const sp=(g.score||'').split(' - ');
      lastBreak={setLabel:g.set_number,gameNum:String(g.number_game??i),broken:g.serve_lost,gP1:parseInt(sp[0])||0,gP2:parseInt(sp[1])||0};
      break;
    }
  }
  const mon=(o1!=null&&o1>=ODD_MIN&&o1<=ODD_MAX)||(o2!=null&&o2>=ODD_MIN&&o2<=ODD_MAX);
  return{id:'td_'+e.event_key,_key:String(e.event_key),cat,trn:e.league_name||'Torneo',
    p1:e.event_first_player||'?',p2:e.event_second_player||'?',
    o1,o2,sets1,sets2,g1,g2,pt1,pt2,srv:e.event_serve==='First Player'?1:2,
    curSetNum,lastBreak,pbpLen:pbp.length,mon,isUp:false,hasOdds:o1!=null||o2!=null,liveO1:o1,liveO2:o2};
}
function normTUp(e){
  const cat=getCat((e.country_name||'')+' '+(e.league_name||''));
  let dt; try{dt=new Date(`${e.event_date}T${e.event_time||'00:00'}:00`);}catch{dt=new Date();}
  if(isNaN(dt.getTime())) dt=new Date();
  const{o1,o2}=getMatchOdds(e);
  const mon=(o1!=null&&o1>=ODD_MIN&&o1<=ODD_MAX)||(o2!=null&&o2>=ODD_MIN&&o2<=ODD_MAX);
  return{id:'tdu_'+e.event_key,_key:String(e.event_key),cat,trn:e.league_name||'Torneo',
    p1:e.event_first_player||'?',p2:e.event_second_player||'?',o1,o2,mon,hasOdds:o1!=null||o2!=null,
    localT:dt.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Madrid'}),
    localD:dt.toLocaleDateString('es-ES',{weekday:'short',day:'2-digit',month:'2-digit'}),
    _ts:dt.getTime(),isUp:true};
}
async function fetchTennis(){
  if(!TENNIS_KEY) return [];
  await fetchAllOdds();
  const[lR,uR]=await Promise.allSettled([
    fetchJson(`https://apiv2.allsportsapi.com/tennis/?met=Livescore&APIkey=${TENNIS_KEY}`),
    fetchJson(`https://apiv2.allsportsapi.com/tennis/?met=Fixtures&APIkey=${TENNIS_KEY}&from=${todayStr()}&to=${tomorrowStr()}`),
  ]);
  const liveRaw=(lR.status==='fulfilled'&&lR.value.result)?lR.value.result:[];
  const upRaw=(uR.status==='fulfilled'&&uR.value.result)?uR.value.result:[];
  const liveSingles=liveRaw.filter(e=>!isDoubles(e)&&e.event_status!=='Finished');
  const upSingles=upRaw.filter(e=>e.event_live==='0'&&!isDoubles(e));
  const live=liveSingles.map(normT), up=upSingles.map(normTUp);
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
  return rivG>favG;
}
function checkBreakRecovery(live){
  live.forEach(m=>{
    const favIs=m.o1!=null&&m.o1>=ODD_MIN&&m.o1<=ODD_MAX?'First Player':m.o2!=null&&m.o2>=ODD_MIN&&m.o2<=ODD_MAX?'Second Player':null;
    if(!favIs) return;
    const favG=parseInt(favIs==='First Player'?m.g1:m.g2)||0;
    const rivG=parseInt(favIs==='First Player'?m.g2:m.g1)||0;
    const favName=favIs==='First Player'?m.p1:m.p2, favO=favIs==='First Player'?m.o1:m.o2;
    const breakSim=simAlerts.find(s=>s.type==='tennis_break'&&!s.resolved&&s._eventId===m.id&&s._setNum===m.curSetNum);
    if(!breakSim) return;
    const rkKey=`${m.id}_s${m.curSetNum}`;
    if(!breakRecoveries.has(rkKey)) breakRecoveries.set(rkKey,{recovered:false,alertedRecovery:false});
    const rec=breakRecoveries.get(rkKey);
    if(favG>0&&favG===rivG&&!rec.alertedRecovery){
      rec.alertedRecovery=true; rec.recovered=true;
      const krec=`rec_${m.id}_s${m.curSetNum}_${favG}`;
      if(!alerted.has(krec)){
        alerted.add(krec);
        simAlerts.unshift({id:krec,type:'tennis_recovery',match:`${m.p1} vs ${m.p2}`,
          detail:`${m.trn} [${m.cat.toUpperCase()}] · Set ${m.curSetNum}: empate ${favG}-${rivG}`,
          alertedAt:nowISO(),resolved:true,outcome:'RECOVERY',
          _eventId:m.id,_setNum:m.curSetNum,_favIs:favIs,_favO:favO,_oddsband:breakSim._oddsband});
        if(simAlerts.length>500) simAlerts.length=500;
        sendTG(`🎾 ROTURAS25 — BREAK RECUPERADO\n━━━━━━━━━━━━━━━━━━━━\n${m.p1} vs ${m.p2}\n📍 ${m.trn} [${m.cat.toUpperCase()}]\n✅ ${favName} ha RECUPERADO el break\n   Set ${m.curSetNum}: ${m.p1} ${m.g1}–${m.g2} ${m.p2}\n⭐ Fav @ ${favO!=null?favO+'x':'n/d'}`);
      }
    }
    if(favG>rivG&&rec.alertedRecovery) rec.alertedRecovery=false;
  });
}
function checkFootballStart(){
  lastFootball.forEach(m=>{
    if(m.status!=='IN_PLAY') return;
    const ks=`fstart_${m.id}`; if(alerted.has(ks)) return; alerted.add(ks);
    sendTG(`⚽ PARTIDO INICIADO — ${m.league}\n━━━━━━━━━━━━━━━━━━━━\n${m.h} vs ${m.a}\n→ Monitorizado para alertas de gol`);
  });
}
function checkMonitoredMatchStart(){
  lastTennis.filter(m=>!m.isUp&&m.mon&&m.pbpLen>0).forEach(m=>{
    const ks=`start_${m.id}`; if(alerted.has(ks)) return; alerted.add(ks);
    const favIs=(m.o1!=null&&m.o1>=ODD_MIN&&m.o1<=ODD_MAX)?'First Player':'Second Player';
    const favName=favIs==='First Player'?m.p1:m.p2, favO=favIs==='First Player'?m.o1:m.o2;
    sendTG(`🎾 PARTIDO INICIADO — MONITORIZADO\n━━━━━━━━━━━━━━━━━━━━\n${m.p1} vs ${m.p2}\n📍 ${m.trn} [${m.cat.toUpperCase()}]\n⭐ FAV: ${favName} @ ${favO!=null?favO+'x':'n/d'}\n→ Monitorizando roturas de saque`);
  });
}
function checkTennisAlerts(live){
  live.forEach(m=>{
    if(!isBreakAlert(m)) return;
    const kb=`brk_${m.id}_${m.lastBreak.setLabel}_${m.lastBreak.gameNum}`;
    if(alerted.has(kb)) return; alerted.add(kb);
    const favIs=(m.o1!=null&&m.o1>=ODD_MIN&&m.o1<=ODD_MAX)?'First Player':'Second Player';
    const favName=favIs==='First Player'?m.p1:m.p2, favO=favIs==='First Player'?m.o1:m.o2;
    const oddsband=favO==null?'n/d':favO<1.30?'1.20-1.30':favO<1.40?'1.30-1.40':favO<1.50?'1.40-1.50':'1.50-1.60';
    simAlerts.unshift({id:kb,type:'tennis_break',match:`${m.p1} vs ${m.p2}`,
      detail:`${m.trn} [${m.cat.toUpperCase()}] · Set ${m.curSetNum}: ${m.lastBreak.gP1}–${m.lastBreak.gP2} · Fav ROTO: ${favName}`,
      alertedAt:nowISO(),resolved:false,outcome:null,
      _eventId:m.id,_setNum:m.curSetNum,_favIs:favIs,
      _setsP1atAlert:[...m.sets1],_setsP2atAlert:[...m.sets2],
      _favO:favO,_oddsband:oddsband,_cat:m.cat,_liveO1:m.o1,_liveO2:m.o2});
    if(simAlerts.length>500) simAlerts.length=500;
    const setsStr=m.sets1.map((s,i)=>`${s}-${m.sets2[i]}`).join(' · ');
    sendTG(`🎾 ROTURAS25 — SAQUE ROTO\n━━━━━━━━━━━━━━━━━━━━\n${m.p1} vs ${m.p2}\n📍 ${m.trn} [${m.cat.toUpperCase()}]\n━━━━━━━━━━━━━━━━━━━━\n📊 ${setsStr?'Sets: '+setsStr+' | Set actual: '+m.g1+'-'+m.g2:'Marcador: '+m.g1+'-'+m.g2}\n⚡ ${favName} ha sido ROTO en Set ${m.curSetNum}\n   ${favName} va PERDIENDO el set\n━━━━━━━━━━━━━━━━━━━━\n⭐ FAVORITO: ${favName}\n   Cuota: ${favO!=null?favO+'x':'n/d'}\n→ APOSTAR que ${favName} gana el Set ${m.curSetNum}`);
  });
}
function checkSet1Loss(live){
  live.forEach(m=>{
    const favIs=m.o1!=null&&m.o1>=ODD_MIN&&m.o1<=ODD_MAX?'First Player':m.o2!=null&&m.o2>=ODD_MIN&&m.o2<=ODD_MAX?'Second Player':null;
    if(!favIs||m.sets1.length!==1) return;
    const fav1=favIs==='First Player'?m.sets1[0]:m.sets2[0], riv1=favIs==='First Player'?m.sets2[0]:m.sets1[0];
    if(fav1>=riv1) return;
    const favName=favIs==='First Player'?m.p1:m.p2, favO=favIs==='First Player'?m.o1:m.o2;
    const oddsband=favO==null?'n/d':favO<1.30?'1.20-1.30':favO<1.40?'1.30-1.40':favO<1.50?'1.40-1.50':'1.50-1.60';
    const ks2=`set1loss_s2_${m.id}`, ksM=`set1loss_match_${m.id}`;
    if(!alerted.has(ksM)){
      if(!alerted.has(ks2)){
        alerted.add(ks2);
        simAlerts.unshift({id:ks2,type:'tennis_set1_set2',match:`${m.p1} vs ${m.p2}`,
          detail:`${m.trn} [${m.cat.toUpperCase()}] · Set1: ${m.sets1[0]}-${m.sets2[0]} · Fav pierde S1 → Gana S2?`,
          alertedAt:nowISO(),resolved:false,outcome:null,_eventId:m.id,_setNum:2,_favIs:favIs,
          _setsP1atAlert:[...m.sets1],_setsP2atAlert:[...m.sets2],_favO:favO,_oddsband:oddsband,_cat:m.cat});
        if(simAlerts.length>500) simAlerts.length=500;
      }
      alerted.add(ksM);
      simAlerts.unshift({id:ksM,type:'tennis_set1_match',match:`${m.p1} vs ${m.p2}`,
        detail:`${m.trn} [${m.cat.toUpperCase()}] · Set1: ${m.sets1[0]}-${m.sets2[0]} · Fav pierde S1 → Gana partido?`,
        alertedAt:nowISO(),resolved:false,outcome:null,_eventId:m.id,_favIs:favIs,
        _setsP1atAlert:[...m.sets1],_setsP2atAlert:[...m.sets2],_favO:favO,_oddsband:oddsband,_cat:m.cat});
      if(simAlerts.length>500) simAlerts.length=500;
      sendTG(`🎾 ROTURAS25 — FAVORITO PIERDE SET 1\n━━━━━━━━━━━━━━━━━━━━\n${m.p1} vs ${m.p2}\n📍 ${m.trn} [${m.cat.toUpperCase()}]\n━━━━━━━━━━━━━━━━━━━━\n📊 Set 1: ${m.sets1[0]}-${m.sets2[0]} — ${favName} PERDIÓ\n⭐ Fav: ${favName} @ ${favO!=null?favO+'x':'n/d'}\n━━━━━━━━━━━━━━━━━━━━\n→ APOSTAR 1: ${favName} gana el Set 2\n→ APOSTAR 2: ${favName} gana el partido`);
    }
  });
}
function resolveTennisSims(){
  simAlerts.forEach(s=>{
    if(s.resolved) return;
    const m=lastTennis.find(x=>x.id===s._eventId); if(!m||m.isUp) return;
    const favName=s._favIs==='First Player'?s.match.split(' vs ')[0]:(s.match.split(' vs ')[1]||'').trim();
    if(s.type==='tennis_break'&&m.sets1.length>s._setsP1atAlert.length){
      const idx=s._setNum-1, favWon=s._favIs==='First Player'?m.sets1[idx]>m.sets2[idx]:m.sets2[idx]>m.sets1[idx];
      s.outcome=favWon?'WIN':'LOSS'; s.resolved=true; s.resolvedAt=nowISO();
      sendTG(`📊 RESULTADO · ${s.match}\nSet ${s._setNum}: ${m.sets1[idx]}-${m.sets2[idx]}\n${favName}: ${favWon?'✅ GANÓ':'❌ PERDIÓ'} el set`);
    }
    if(s.type==='tennis_set1_set2'&&m.sets1.length>=2){
      const favWon=s._favIs==='First Player'?m.sets1[1]>m.sets2[1]:m.sets2[1]>m.sets1[1];
      s.outcome=favWon?'WIN':'LOSS'; s.resolved=true; s.resolvedAt=nowISO();
      sendTG(`📊 RESULTADO · ${s.match}\nSet 2: ${m.sets1[1]}-${m.sets2[1]}\n${favName}: ${favWon?'✅ GANÓ':'❌ PERDIÓ'} el Set 2`);
    }
    if(s.type==='tennis_set1_match'){
      const done=m.sets1.length>=2&&(m.sets1.filter((v,i)=>v>m.sets2[i]).length===2||m.sets2.filter((v,i)=>v>m.sets1[i]).length===2);
      if(done){
        const p1w=m.sets1.filter((v,i)=>v>m.sets2[i]).length, p2w=m.sets2.filter((v,i)=>v>m.sets1[i]).length;
        const favWon=s._favIs==='First Player'?p1w>p2w:p2w>p1w;
        s.outcome=favWon?'WIN':'LOSS'; s.resolved=true; s.resolvedAt=nowISO();
        sendTG(`📊 RESULTADO · ${s.match}\nPartido: ${m.sets1.map((v,i)=>`${v}-${m.sets2[i]}`).join(' ')}\n${favName}: ${favWon?'✅ GANÓ':'❌ PERDIÓ'} el partido`);
      }
    }
  });
}

// ── Poll ─────────────────────────────────────────────────────────────────────
async function poll(){
  try{
    stats.pollCount++;
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
    if(stats.pollCount%20===0) console.log(`[POLL #${stats.pollCount}] Tennis:${lastTennis.filter(m=>!m.isUp).length} Football:${lastFootball.filter(m=>m.status==='IN_PLAY').length} Odds:${oddsCache.size}`);
  }catch(e){stats.errors++;console.error('[POLL ERROR]',e.message);}
  setTimeout(poll, hasLiveMatches()?45000:180000);
}

// ── GitHub helper ────────────────────────────────────────────────────────────
async function ghUpsertFile(repoPath,contentStr,commitMsg){
  const GH_TOKEN=process.env.GH_TOKEN||'', GH_REPO=process.env.GH_REPO||'Roturas25/Roturas25prod';
  if(!GH_TOKEN) throw new Error('GH_TOKEN not set');
  const b64=Buffer.from(contentStr).toString('base64');
  let sha; try{const ex=await fetchJson(`https://api.github.com/repos/${GH_REPO}/contents/${repoPath}`,{Authorization:`token ${GH_TOKEN}`,Accept:'application/vnd.github.v3+json','User-Agent':'Roturas25'});sha=ex?.sha;}catch(_){}
  const body=JSON.stringify({message:commitMsg,content:b64,...(sha?{sha}:{})});
  await new Promise((res,rej)=>{
    const buf=Buffer.from(body);
    const r=https.request({hostname:'api.github.com',path:`/repos/${GH_REPO}/contents/${repoPath}`,method:'PUT',
      headers:{Authorization:`token ${GH_TOKEN}`,Accept:'application/vnd.github.v3+json','Content-Type':'application/json','Content-Length':buf.length,'User-Agent':'Roturas25-Server'}},
      r=>{r.resume();r.on('end',res);});
    r.on('error',rej); r.write(buf); r.end();
  });
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const CORS_HEADERS={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers':'Content-Type,Authorization',
};

const server=http.createServer((req,res)=>{
  Object.entries(CORS_HEADERS).forEach(([k,v])=>res.setHeader(k,v));
  res.setHeader('Content-Type','application/json');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  const path=new URL(req.url,'http://localhost').pathname;

  if(path==='/health'&&req.method==='GET'){
    res.writeHead(200);
    res.end(JSON.stringify({ok:true,version:'v6',football:!!FOOTBALL_KEY,tennis:!!TENNIS_KEY,telegram:!!TG_TOKEN,oddMin:ODD_MIN,oddMax:ODD_MAX,updated:lastUpdate,stats,liveFootball:lastFootball.filter(m=>m.status==='IN_PLAY'||m.status==='PAUSED').length,liveTennis:lastTennis.filter(m=>!m.isUp).length,oddsCache:oddsCache.size,simCount:simAlerts.length}));
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
    res.end(JSON.stringify({football:lastFootball,tennis:lastTennis,updated:lastUpdate,alerted:[...alerted],simAlerts:simAlerts.slice(0,200),oddStats,catStats,ftStats}));
    return;
  }

  if(path==='/admin/push'&&req.method==='POST'){
    let body='';
    req.on('data',d=>{body+=d;if(body.length>5*1024*1024)req.destroy();});
    req.on('end',async()=>{
      try{
        const{secret,file,content:fileContent}=JSON.parse(body);
        const DEPLOY_SECRET=process.env.DEPLOY_SECRET||'roturas25deploy';
        if(secret!==DEPLOY_SECRET){res.writeHead(403);res.end(JSON.stringify({error:'Forbidden'}));return;}
        if(!file||!fileContent){res.writeHead(400);res.end(JSON.stringify({error:'file and content required'}));return;}
        if(!['server.js','docs/index.html','package.json'].includes(file)){res.writeHead(400);res.end(JSON.stringify({error:'file not allowed'}));return;}
        await ghUpsertFile(file,fileContent,`🚀 Auto-deploy ${file} ${new Date().toISOString()}`);
        res.writeHead(200);res.end(JSON.stringify({ok:true,file,pushed:true}));
        console.log('[DEPLOY] pushed',file);
      }catch(e){console.error('[DEPLOY ERROR]',e.message);res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    });
    return;
  }

  res.writeHead(404);res.end(JSON.stringify({error:'Not found'}));
});

server.listen(PORT,()=>{
  console.log(`\n🎾 ROTURAS25 v6 — puerto ${PORT}`);
  console.log(`   Football:${FOOTBALL_KEY?'✓':'✗ falta FOOTBALL_KEY'}  Tennis:${TENNIS_KEY?'✓':'✗ falta TENNIS_KEY'}  TG:${TG_TOKEN?'✓':'✗'}`);
  console.log(`   ODD_MIN:${ODD_MIN}  ODD_MAX:${ODD_MAX}\n`);
  poll();
});
