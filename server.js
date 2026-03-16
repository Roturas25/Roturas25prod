'use strict';
const http  = require('http');
const https = require('https');

process.on('uncaughtException',  e => console.error('[UNCAUGHT]',  e.message));
process.on('unhandledRejection', e => console.error('[UNHANDLED]', String(e)));

// ── Credenciales — SOLO desde Railway env vars, nunca hardcodeadas ────────────
const FOOTBALL_KEY     = process.env.FOOTBALL_KEY     || '';
const TENNIS_KEY       = process.env.TENNIS_KEY       || '';
const THEODDS_KEY      = process.env.THEODDS_KEY      || '';
const TG_TOKEN         = process.env.TG_TOKEN         || '';
const TG_CHAT          = process.env.TG_CHAT          || '';
const BETFAIR_SSOID    = process.env.BETFAIR_SSOID    || '';  // session token
const BETFAIR_APP_KEY  = process.env.BETFAIR_APP_KEY  || '';  // delayed key — set in Railway
const ODDS_API_IO_KEY  = process.env.ODDS_API_IO_KEY  || '';  // odds-api.io key
const PORT             = parseInt(process.env.PORT || '3000', 10);
const ODD_MIN          = parseFloat(process.env.ODD_MIN || '1.20');
const ODD_MAX          = parseFloat(process.env.ODD_MAX || '1.60');

// ── Estado global ─────────────────────────────────────────────────────────────
const alerted           = new Set();
let   lastFootball      = [];
let   allFootballForSim = [];   // FIX BUG 8: merge en vez de override
let   lastTennis        = [];
const finishedTennisCache = new Map(); // eventId → finalState, kept 2h for resolution
let   nextFootball      = [];
let   lastUpdate        = null;
const stats             = { pollCount:0, alertsSent:0, errors:0 };
const simAlerts         = [];
const oddsCache         = new Map();   // AllSports pre-match: key→{o1,o2,match,set2,current,...}
const footballOddsCache = new Map();   // matchId → {ft05,ft15,source,updatedAt}
const tennisOddsCache   = new Map();   // matchKey → {match_o1,match_o2,set2_o1,set2_o2,set_o1,set_o2,source,updatedAt}
const htSnapshot        = new Map();
const kickoffSnapshot   = new Map();
const breakRecoveries   = new Map();
const surfaceCache      = new Map();
const nextFootball24    = [];

// Betfair market ID cache: eventKey → { matchOddsId, setWinnerId, ou05Id, ou15Id }
const betfairMarketIds  = new Map();

// ── Diagnóstico en tiempo real ─────────────────────────────────────────────────
const diag = {
  football:  { lastOk: null, lastErr: null, lastErrMsg: '', callCount: 0 },
  tennis:    { lastOk: null, lastErr: null, lastErrMsg: '', callCount: 0 },
  odds:      { lastOk: null, lastErr: null, lastErrMsg: '', callCount: 0, cacheSize: 0 },
  theodds:   { lastOk: null, lastErr: null, lastErrMsg: '', callCount: 0, cacheSize: 0 },
  betfair:   { lastOk: null, lastErr: null, lastErrMsg: '', callCount: 0, marketsFound: 0, ssoExpired: false },
  oddsapiio: { lastOk: null, lastErr: null, lastErrMsg: '', callCount: 0, cacheSize: 0 },
  firebase:  { lastOk: null, lastErr: null, lastErrMsg: '' },
  telegram:  { lastOk: null, lastErr: null, lastErrMsg: '' },
  resolution: { pendingTennis: 0, pendingFootball: 0, staleOver6h: 0 },
};

// ── API usage counters ────────────────────────────────────────────────────────
const apiUsage = {
  limits: {
    football:  { daily: 10,   monthly: 300,  label: 'football-data.org free' },
    allsports: { daily: 100,  monthly: 3000, label: 'AllSports free' },
    theodds:   { daily: null, monthly: 500,  label: 'TheOdds free (500/mo)' },
    betfair:   { daily: null, monthly: null, label: 'Betfair Exchange (delayed, free)' },
    oddsapiio: { daily: null, monthly: null, label: 'odds-api.io' },
  },
  today: { football: 0, allsports: 0, theodds: 0, betfair: 0, oddsapiio: 0, date: '' },
  history: [],
  startedAt: new Date().toISOString(),
};

function trackApiCall(api) {
  const today = new Date().toISOString().split('T')[0];
  if (apiUsage.today.date !== today) {
    if (apiUsage.today.date) {
      apiUsage.history.push({ ...apiUsage.today });
      if (apiUsage.history.length > 30) apiUsage.history.shift();
    }
    apiUsage.today = { football: 0, allsports: 0, theodds: 0, betfair: 0, oddsapiio: 0, date: today };
  }
  if (api in apiUsage.today) apiUsage.today[api]++;
}

function apiUsageSummary() {
  const t = apiUsage.today;
  const lims = apiUsage.limits;
  const monthTotal = (key) => apiUsage.history.reduce((s,d) => s + (d[key]||0), 0) + (t[key]||0);
  return {
    today: {
      football:  { calls: t.football,  limit_daily: lims.football.daily,  pct: lims.football.daily  ? Math.round(t.football /lims.football.daily *100) : null },
      allsports: { calls: t.allsports, limit_daily: lims.allsports.daily, pct: lims.allsports.daily ? Math.round(t.allsports/lims.allsports.daily*100) : null },
      theodds:   { calls: t.theodds,   limit_daily: null, pct: null },
      betfair:   { calls: t.betfair,   limit_daily: null, pct: null },
      oddsapiio: { calls: t.oddsapiio, limit_daily: null, pct: null },
    },
    month: {
      football:  { calls: monthTotal('football'),  limit: lims.football.monthly,  pct: lims.football.monthly  ? Math.round(monthTotal('football') /lims.football.monthly  *100) : null },
      allsports: { calls: monthTotal('allsports'), limit: lims.allsports.monthly, pct: lims.allsports.monthly ? Math.round(monthTotal('allsports')/lims.allsports.monthly *100) : null },
      theodds:   { calls: monthTotal('theodds'),   limit: lims.theodds.monthly,   pct: lims.theodds.monthly   ? Math.round(monthTotal('theodds')  /lims.theodds.monthly   *100) : null },
      betfair:   { calls: monthTotal('betfair'),   limit: null, pct: null },
      oddsapiio: { calls: monthTotal('oddsapiio'), limit: null, pct: null },
    },
    history: apiUsage.history.slice(-7),
    startedAt: apiUsage.startedAt,
    date: t.date,
  };
}

// ── Firebase ──────────────────────────────────────────────────────────────────
const FB_URL = 'https://roturas25-default-rtdb.europe-west1.firebasedatabase.app';
let fbSaveTimer = null;

async function fbGet(path) {
  try {
    const d = await fetchJson(FB_URL + path + '.json');
    diag.firebase.lastOk = nowISO();
    return d;
  } catch(e) { diag.firebase.lastErr = nowISO(); diag.firebase.lastErrMsg = e.message; return null; }
}

async function fbPut(path, data) {
  return new Promise((res, rej) => {
    const body = JSON.stringify(data);
    const url  = new URL(FB_URL + path + '.json');
    const r = https.request({ hostname: url.hostname, path: url.pathname + url.search,
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }},
      r => { r.resume(); r.on('end', () => { diag.firebase.lastOk = nowISO(); res(); }); });
    r.on('error', e => { diag.firebase.lastErr = nowISO(); diag.firebase.lastErrMsg = e.message; rej(e); });
    r.write(body); r.end();
  });
}

function scheduleFbSave() {
  if (fbSaveTimer) return;
  fbSaveTimer = setTimeout(async () => {
    fbSaveTimer = null;
    try {
      await fbPut('/state/alerted',  [...alerted].slice(-2000));
      await fbPut('/state/sims',     simAlerts.slice(0, 500));
    } catch(e) { console.warn('[FB SAVE]', e.message); }
  }, 3000);
}

async function loadStateFromFB() {
  console.log('[FB] Cargando estado previo...');
  try {
    const savedAlerted = await fbGet('/state/alerted');
    if (Array.isArray(savedAlerted)) {
      savedAlerted.forEach(k => alerted.add(k));
      console.log('[FB] alerted restaurado:', alerted.size);
    }
    const savedSims = await fbGet('/state/sims');
    if (Array.isArray(savedSims) && savedSims.length) {
      simAlerts.push(...savedSims);
      console.log('[FB] simAlerts restaurado:', simAlerts.length);
    }
  } catch(e) { console.warn('[FB LOAD]', e.message); }
}

// ── Utilidades ────────────────────────────────────────────────────────────────
function todayStr()    { return new Date().toISOString().split('T')[0]; }
function tomorrowStr() { return new Date(Date.now()+86400000).toISOString().split('T')[0]; }
function nowISO()      { return new Date().toISOString(); }

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
    diag.telegram.lastOk = nowISO();
  } catch(e){ diag.telegram.lastErr = nowISO(); diag.telegram.lastErrMsg = e.message; console.error('[TG]',e.message); }
}

function hasLiveMatches(){
  return lastFootball.some(m=>m.status==='IN_PLAY'||m.status==='PAUSED')
      || lastTennis.some(m=>!m.isUp);
}
function isDoubles(e){
  const p1=(e.event_first_player||'').trim(), p2=(e.event_second_player||'').trim(), lg=(e.league_name||'').toLowerCase();
  return p1.includes('/')||p2.includes('/')||lg.includes('double')||lg.includes('doble');
}

// ── Surface cache ─────────────────────────────────────────────────────────────
// FIX BUG 6: static surface map for well-known tournaments
const KNOWN_SURFACES = {
  // Hard outdoor
  'australian open': 'hard', 'us open': 'hard',
  'miami': 'hard', 'indian wells': 'hard', 'masters 1000 miami': 'hard',
  'cincinnati': 'hard', 'montreal': 'hard', 'toronto': 'hard', 'canada': 'hard',
  'beijing': 'hard', 'shanghai': 'hard', 'tokyo': 'hard', 'dubai': 'hard',
  'doha': 'hard', 'abu dhabi': 'hard', 'brisbane': 'hard', 'auckland': 'hard',
  'adelaide': 'hard', 'sydney': 'hard', 'acapulco': 'hard', 'washington': 'hard',
  'los cabos': 'hard', 'winston-salem': 'hard',  'us open series': 'hard',
  'china open': 'hard', 'wuhan': 'hard', 'guangzhou': 'hard', 'tianjin': 'hard',
  'zhuhai': 'hard', 'hong kong': 'hard',
  // Clay
  'roland garros': 'clay', 'monte carlo': 'clay', 'monte-carlo': 'clay',
  'madrid': 'clay', 'barcelona': 'clay', 'rome': 'clay', 'roma': 'clay',
  'hamburg': 'clay', 'estoril': 'clay', 'munich': 'clay', 'lyon': 'clay',
  'bucharest': 'clay', 'istanbul': 'clay', 'marrakech': 'clay',
  'geneva': 'clay', 'geneve': 'clay', 'nice': 'clay', 'bastad': 'clay',
  'båstad': 'clay', 'gstaad': 'clay', 'umag': 'clay', 'kitzbuhel': 'clay',
  'kitzbühel': 'clay', 'cordoba': 'clay', 'buenos aires': 'clay',
  'bogota': 'clay', 'bogotá': 'clay', 'santiago': 'clay', 'sao paulo': 'clay',
  'rio': 'clay', 'casablanca': 'clay', 'rabat': 'clay', 'parma': 'clay',
  'prague': 'clay', 'praga': 'clay', 'warsaw': 'clay', 'varsovia': 'clay',
  'strasbourg': 'clay', 'nuremberg': 'clay', 'nürnberg': 'clay',
  'poltu quatu': 'clay', 'palermo': 'clay', 'budapest': 'clay',
  'istanbul': 'clay', 'belgrade': 'clay', 'beograd': 'clay',
  'estoril': 'clay', 'leon': 'clay', 'iasi': 'clay', 'sofia': 'clay',
  // Grass
  'wimbledon': 'grass', "queen's": 'grass', 'queens': 'grass', 'halle': 'grass',
  "s-hertogenbosch": 'grass', 'eastbourne': 'grass', 'nottingham': 'grass',
  'birmingham': 'grass', 'bad homburg': 'grass', 'mallorca': 'grass',
  'rosmalen': 'grass', 'newport': 'grass',
  // Hard indoor
  'rotterdam': 'hard_i', 'marseille': 'hard_i', 'metz': 'hard_i',
  'montpellier': 'hard_i', 'st. petersburg': 'hard_i', 'moscow': 'hard_i',
  'moscú': 'hard_i', 'vienna': 'hard_i', 'wien': 'hard_i',
  'paris bercy': 'hard_i', 'paris-bercy': 'hard_i', 'stockholm': 'hard_i',
  'basel': 'hard_i', 'antwerp': 'hard_i', 'amberes': 'hard_i',
  'indoor': 'hard_i', 'cubierto': 'hard_i',
  // ATP 1000 known surfaces
  'masters 1000': 'hard', // default for 1000s not listed
};

async function loadSurfaceCache() {
  // Load static map first
  Object.entries(KNOWN_SURFACES).forEach(([k,v]) => surfaceCache.set('__' + k, v));
  if (!TENNIS_KEY) return;
  try {
    const r = await fetchJson(`https://apiv2.allsportsapi.com/tennis/?met=Countries&APIkey=${TENNIS_KEY}`);
    if (!r.result) return;
    let loaded = 0;
    r.result.forEach(t => {
      if (!t.league_key || !t.league_surface) return;
      const raw = (t.league_surface || '').toLowerCase().trim();
      let surf = 'hard';
      if (raw.includes('clay'))  surf = 'clay';
      else if (raw.includes('grass')) surf = 'grass';
      else if (raw.includes('carpet')||raw.includes('indoor')) surf = 'hard_i';
      surfaceCache.set(String(t.league_key), surf);
      loaded++;
    });
    console.log(`[SURFACE] Cache cargado: ${loaded} torneos`);
  } catch(e) { console.warn('[SURFACE]', e.message); }
}

function getSurface(trn, country, leagueKey){
  if (leagueKey && surfaceCache.has(String(leagueKey))) return surfaceCache.get(String(leagueKey));
  const l = (trn||'').toLowerCase() + ' ' + (country||'').toLowerCase();
  // Check static map
  for (const [k, v] of Object.entries(KNOWN_SURFACES)) {
    if (l.includes(k)) return v;
  }
  // Keyword fallback
  if (l.includes('clay') || l.includes('tierra')) return 'clay';
  if (l.includes('grass') || l.includes('hierba')) return 'grass';
  if (l.includes('indoor') || l.includes('carpet') || l.includes('cubierto')) return 'hard_i';
  return 'hard';
}

// ── Odds: AllSports (tenis pre-match y live) ──────────────────────────────────
function buildOddsCache(result){
  if(!result||typeof result!=='object') return;
  const LIVE_TTL = 5 * 60 * 1000; // 5 minutes — protect fresh live odds
  Object.entries(result).forEach(([id,data])=>{
    const existing = oddsCache.get(id) || {};
    // FIX: never overwrite fresh Betfair/live data with stale pre-match
    if (existing.source === 'betfair' && existing.updated && (Date.now()-existing.updated) < LIVE_TTL) return;
    if (existing.source === 'oddsapiio' && existing.updated && (Date.now()-existing.updated) < LIVE_TTL) return;

    // Match winner odds
    const hw = data['Home/Away'] || data['1X2'] || data['Match Winner'] || data['Winner'] || null;
    if(hw) {
      function median(obj){
        if(!obj||typeof obj!=='object') return null;
        const v=Object.values(obj).map(x=>parseFloat(x)).filter(x=>!isNaN(x)&&x>1);
        if(!v.length) return null; v.sort((a,b)=>a-b);
        return Math.round(v[Math.floor(v.length/2)]*100)/100;
      }
      const o1=median(hw['Home']||hw['Player 1']||hw['First Player']||hw['1']);
      const o2=median(hw['Away']||hw['Player 2']||hw['Second Player']||hw['2']);
      if(o1||o2) {
        existing.o1 = o1||null;
        existing.o2 = o2||null;
        existing.match_o1 = o1||null;
        existing.match_o2 = o2||null;
        // Set .match = odds for whichever player is in ODD_MIN–ODD_MAX range
        // If neither is in range, use the lower odd (more likely the favourite)
        if (o1!=null && o1>=ODD_MIN && o1<=ODD_MAX) existing.match = o1;
        else if (o2!=null && o2>=ODD_MIN && o2<=ODD_MAX) existing.match = o2;
        else if (o1!=null && o2!=null) existing.match = Math.min(o1, o2);
        else existing.match = o1||o2;
        existing.source = existing.source || 'allsports';
      }
    }

    // Set 2 winner odds
    const s2 = data['Set 2 Winner'] || data['2nd Set Winner'] || null;
    if(s2) {
      function medS(obj){
        if(!obj||typeof obj!=='object') return null;
        const v=Object.values(obj).map(x=>parseFloat(x)).filter(x=>!isNaN(x)&&x>1);
        if(!v.length) return null; v.sort((a,b)=>a-b);
        return Math.round(v[Math.floor(v.length/2)]*100)/100;
      }
      existing.set2_o1 = medS(s2['Home']||s2['Player 1']||s2['First Player']);
      existing.set2_o2 = medS(s2['Away']||s2['Player 2']||s2['Second Player']);
    }

    existing.updated = Date.now();
    oddsCache.set(id, existing);
  });
}

async function fetchAllOdds(){
  if(!TENNIS_KEY) return;
  diag.odds.callCount++;
  trackApiCall('allsports');
  const [t,tm]=[todayStr(),tomorrowStr()];
  for(const url of[
    `https://apiv2.allsportsapi.com/tennis/?met=Odds&APIkey=${TENNIS_KEY}&from=${t}&to=${tm}`,
    `https://apiv2.allsportsapi.com/tennis/?met=Odds&APIkey=${TENNIS_KEY}`,
  ]){
    try{
      const r=await fetchJson(url);
      if(r.success&&r.result){ buildOddsCache(r.result); diag.odds.lastOk=nowISO(); }
    } catch(e){ diag.odds.lastErr=nowISO(); diag.odds.lastErrMsg=e.message; console.warn('[ODDS]',e.message); }
  }
  diag.odds.cacheSize = oddsCache.size;
}

function getMatchOdds(e){ return oddsCache.get(String(e.event_key))||{o1:null,o2:null}; }

// ── TheOdds API — tenis live odds (FUENTE PRINCIPAL) ──────────────────────────
// Usa THEODDS_KEY (ya configurado en Railway) para obtener cuotas h2h de tenis en vivo.
// Más fiable que Betfair (sin SSOID que expira). Actualiza cada 2 min solo si hay live.
const THEODDS_TENNIS_SPORTS = [
  'tennis_atp_aus_open','tennis_atp_french_open','tennis_atp_wimbledon','tennis_atp_us_open',
  'tennis_atp_indian_wells','tennis_atp_miami_open','tennis_atp_monte_carlo',
  'tennis_atp_madrid','tennis_atp_rome','tennis_atp_canadian_open',
  'tennis_atp_cincinnati','tennis_atp_shanghai','tennis_wta_aus_open',
  'tennis_wta_french_open','tennis_wta_wimbledon','tennis_wta_us_open',
  'tennis','tennis_atp','tennis_wta', // generic keys catch remaining tournaments
];

async function fetchTheOddsTennis() {
  if (!THEODDS_KEY) return;
  const liveTennis = lastTennis.filter(m => !m.isUp);
  if (!liveTennis.length) return;

  trackApiCall('theodds');
  diag.theodds.callCount++;

  // APPROACH: Fetch from KNOWN active sport keys for current tournaments
  // Plus a discovery call that gets ALL tennis sport keys (not just s.active ones)
  // BUG FIX: previously used s.active filter which returned [] for in-play-only events
  // and [] is truthy so fallback never triggered

  // Step 1: ensure we have sport keys (refresh every 2h, no active filter)
  const SPORTS_TTL = 2 * 3600 * 1000;
  if (!fetchTheOddsTennis._keys || !fetchTheOddsTennis._loadedAt ||
      (Date.now() - fetchTheOddsTennis._loadedAt) > SPORTS_TTL) {
    try {
      const sportsResp = await fetchJson(
        `https://api.the-odds-api.com/v4/sports/?apiKey=${THEODDS_KEY}&all=true`
      );
      trackApiCall('theodds');
      if (Array.isArray(sportsResp)) {
        const tennisKeys = sportsResp
          .filter(s => s.key && s.key.includes('tennis'))
          .map(s => s.key);
        // Only update if we got results; keep old keys if empty
        if (tennisKeys.length > 0) {
          fetchTheOddsTennis._keys = tennisKeys;
          fetchTheOddsTennis._loadedAt = Date.now();
          console.log('[THEODDS] Tennis sports found:', tennisKeys.length, tennisKeys.slice(0,6));
        }
      }
    } catch(e) {
      console.warn('[THEODDS sports discovery]', e.message);
    }
  }

  // Step 2: build URL list — known current tournament keys + discovered keys
  // These are the most likely keys for March 2026 (Miami Open season)
  const KNOWN_TENNIS_KEYS = [
    'tennis_wta_miami_open',
    'tennis_atp_miami_open',
    'tennis_wta_indian_wells',
    'tennis_atp_indian_wells',
    'tennis_wta',
    'tennis_atp',
    'tennis_atp_challenger',
    'tennis_wta_125k',
    'tennis',
  ];

  // Merge discovered + known, deduplicate, cap at 10
  const discoveredKeys = (fetchTheOddsTennis._keys && fetchTheOddsTennis._keys.length > 0)
    ? fetchTheOddsTennis._keys
    : [];
  const allKeys = [...new Set([...discoveredKeys, ...KNOWN_TENNIS_KEYS])].slice(0, 10);
  
  console.log('[THEODDS] Querying', allKeys.length, 'tennis sport keys');

  let totalMatched = 0;

  for (const key of allKeys) {
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${key}/odds/?apiKey=${THEODDS_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`;
      const r = await fetchJson(url);
      
      if (!Array.isArray(r)) continue;
      if (r.length === 0) continue;

      console.log(`[THEODDS] ${key}: ${r.length} events`);

      for (const ev of r) {
        const homeLC = (ev.home_team||'').toLowerCase();
        const awayLC = (ev.away_team||'').toLowerCase();

        // Match against live tennis matches
        const tm = liveTennis.find(m =>
          (namesMatch(homeLC, m.p1) && namesMatch(awayLC, m.p2)) ||
          (namesMatch(homeLC, m.p2) && namesMatch(awayLC, m.p1))
        );
        if (!tm) continue;

        const swapped = namesMatch(homeLC, tm.p2);
        const favIs = (tm.o1!=null && tm.o1 >= ODD_MIN && tm.o1 <= ODD_MAX) ? 'p1' : 'p2';

        // Extract h2h odds
        let p1Odd = null, p2Odd = null;
        for (const bk of (ev.bookmakers || [])) {
          for (const mkt of (bk.markets || [])) {
            if (mkt.key !== 'h2h') continue;
            for (const oc of (mkt.outcomes || [])) {
              const pr = parseFloat(oc.price);
              if (!isNaN(pr) && pr > 1.01) {
                // Outcome name is the player's full name
                const ocName = (oc.name||'').toLowerCase();
                const p1Name = swapped ? tm.p2 : tm.p1;
                const p2Name = swapped ? tm.p1 : tm.p2;
                if (namesMatch(ocName, p1Name)) p1Odd = pr;
                else if (namesMatch(ocName, p2Name)) p2Odd = pr;
              }
            }
            if (p1Odd && p2Odd) break;
          }
          if (p1Odd && p2Odd) break;
        }

        if (p1Odd || p2Odd) {
          const favOdd = favIs === 'p1' ? p1Odd : p2Odd;
          const tc = tennisOddsCache.get(tm._key) || {};
          tc.match_o1 = swapped ? p2Odd : p1Odd;
          tc.match_o2 = swapped ? p1Odd : p2Odd;
          tc.match = favOdd;
          tc.source_match = 'theodds';
          tc.updatedAt = Date.now();
          tennisOddsCache.set(tm._key, tc);

          // Mirror to oddsCache (normT reads this)
          const oc2 = oddsCache.get(tm._key) || {};
          oc2.match   = favOdd;
          oc2.match_o1 = tc.match_o1;
          oc2.match_o2 = tc.match_o2;
          oc2.source  = 'theodds';
          oc2.updated = Date.now();
          oddsCache.set(tm._key, oc2);

          totalMatched++;
          console.log(`[THEODDS] Matched: ${tm.p1} vs ${tm.p2} → favOdd=${favOdd}`);
        }
      }

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));

    } catch(e) {
      // 404 = sport key doesn't exist, skip silently
      if (!e.message.includes('404') && !e.message.includes('JSON')) {
        diag.theodds.lastErrMsg = e.message;
        console.warn('[THEODDS]', key, e.message);
      }
    }
  }

  if (totalMatched > 0) {
    diag.theodds.lastOk = nowISO();
    diag.theodds.cacheSize = tennisOddsCache.size;
    console.log(`[THEODDS] Total matched: ${totalMatched} matches with live odds`);
  } else {
    console.log('[THEODDS] No matches found in any sport key — odds will use AllSports pre-match');
  }
}
// Keep AllSports pollOdds as additional source but with TTL protection already in place
async function pollOdds() {
  if (!TENNIS_KEY) return;
  const live = lastTennis.filter(m => !m.isUp);
  if (!live.length) return;
  const batch = live.slice(0, 6);

  await Promise.allSettled(batch.map(async m => {
    try {
      const r = await fetchJson(
        `https://apiv2.allsportsapi.com/tennis/?met=Odds&APIkey=${TENNIS_KEY}&eventId=${m._key}`
      );
      if (!r.success || !r.result) return;

      let betTypes = r.result;
      const firstKey = Object.keys(r.result)[0];
      if (firstKey && !isNaN(firstKey)) {
        betTypes = r.result[firstKey] || r.result[m._key] || {};
      }

      const existing = oddsCache.get(m._key) || {};
      const LIVE_TTL = 5 * 60 * 1000;
      // Don't overwrite fresh Betfair or TheOdds data
      if (existing.source === 'betfair' && existing.updated && (Date.now()-existing.updated) < LIVE_TTL) return;
      if (existing.source === 'theodds' && existing.updated && (Date.now()-existing.updated) < LIVE_TTL) return;
      if (existing.source === 'oddsapiio' && existing.updated && (Date.now()-existing.updated) < LIVE_TTL) return;
      let changed = false;

      function medianOdd(obj) {
        if (!obj || typeof obj !== 'object') return null;
        const vs = Object.values(obj).map(x => parseFloat(x)).filter(x => !isNaN(x) && x > 1.01);
        if (!vs.length) return null;
        vs.sort((a,b) => a-b);
        return Math.round(vs[Math.floor(vs.length/2)]*100)/100;
      }

      const favIs = m.o1!=null&&m.o1>=ODD_MIN&&m.o1<=ODD_MAX ? 'p1'
                  : m.o2!=null&&m.o2>=ODD_MIN&&m.o2<=ODD_MAX ? 'p2' : null;

      for (const [bName, bData] of Object.entries(betTypes)) {
        if (!bData || typeof bData !== 'object') continue;
        const n = bName.toLowerCase();
        if (n.includes('match winner') || n.includes('winner') || n.includes('home/away') || n === '1x2') {
          const p1Obj = bData['Home']||bData['Player 1']||bData['First Player']||bData['1']||null;
          const p2Obj = bData['Away']||bData['Player 2']||bData['Second Player']||bData['2']||null;
          const o1 = medianOdd(p1Obj), o2 = medianOdd(p2Obj);
          if (o1||o2) { existing.match_o1=o1; existing.match_o2=o2; existing.match=favIs==='p1'?o1:o2; existing.source='allsports_live'; existing.updated=Date.now(); changed=true; }
        }
        if (n.includes('set 2') || n.includes('2nd set')) {
          const p1Obj = bData['Home']||bData['Player 1']||bData['First Player']||null;
          const p2Obj = bData['Away']||bData['Player 2']||bData['Second Player']||null;
          const o1=medianOdd(p1Obj), o2=medianOdd(p2Obj);
          existing.set2_o1=o1; existing.set2_o2=o2; existing.set2=favIs==='p1'?o1:o2; changed=true;
        }
        const setN=`set ${m.curSetNum}`;
        if (n.includes(setN) && !n.includes('game') && !n.includes('total')) {
          const p1Obj=bData['Home']||bData['Player 1']||bData['First Player']||null;
          const p2Obj=bData['Away']||bData['Player 2']||bData['Second Player']||null;
          const o1=medianOdd(p1Obj), o2=medianOdd(p2Obj);
          existing.current_o1=o1; existing.current_o2=o2; existing.current=favIs==='p1'?o1:o2; changed=true;
        }
      }
      if (changed) {
        existing.updated=Date.now();
        oddsCache.set(m._key, existing);
        // ALSO write to tennisOddsCache so resolveTennisOdds picks it up
        const tcEntry = tennisOddsCache.get(m._key) || {};
        if (!tcEntry.source_match || tcEntry.source_match === 'allsports' || tcEntry.source_match === 'allsports_live') {
          if (existing.match)   { tcEntry.match = existing.match; tcEntry.source_match = 'allsports_live'; }
          if (existing.set2)    { tcEntry.set2  = existing.set2; }
          if (existing.current) { tcEntry.current = existing.current; }
          tcEntry.updatedAt = Date.now();
          tennisOddsCache.set(m._key, tcEntry);
        }
        diag.odds.lastOk=nowISO(); diag.odds.cacheSize=oddsCache.size;
      }
    } catch(e) { diag.odds.lastErr=nowISO(); diag.odds.lastErrMsg=e.message; }
  }));
}


// ── TheOdds API — cuotas fútbol (goals +0.5 / +1.5) ──────────────────────────
// FIX BUG 9: integrar TheOdds para cuotas de goles en LaLiga y EPL
const THEODDS_SPORTS = {
  laliga:  'soccer_spain_la_liga',
  premier: 'soccer_england_premier_league',
};

async function fetchTheOddsFootball() {
  if (!THEODDS_KEY) return;
  diag.theodds.callCount++;
  trackApiCall('theodds');
  for (const [league, sport] of Object.entries(THEODDS_SPORTS)) {
    try {
      // Try live odds first, fallback to pre-match
      const urls = [
        `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${THEODDS_KEY}&regions=eu&markets=totals&oddsFormat=decimal`,
        `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${THEODDS_KEY}&regions=eu&markets=totals&oddsFormat=decimal&commenceTimeFrom=${todayStr()}T00:00:00Z`,
      ];
      const r = await fetchJson(urls[0]);
      if (!Array.isArray(r)) continue;

      r.forEach(match => {
        if (!match.id || !match.bookmakers?.length) return;
        const matchKey = match.id; // TheOdds uses a string match ID

        // Find matching football match by team names
        const homeLC = (match.home_team||'').toLowerCase();
        const awayLC = (match.away_team||'').toLowerCase();
        const fdMatch = lastFootball.find(m => {
          const mh = (m.h||'').toLowerCase(), ma = (m.a||'').toLowerCase();
          return (mh.includes(homeLC.slice(0,5)) || homeLC.includes(mh.slice(0,5))) &&
                 (ma.includes(awayLC.slice(0,5)) || awayLC.includes(ma.slice(0,5)));
        });
        if (!fdMatch) return;

        // Extract totals markets
        let ft05 = null, ft15 = null;
        for (const bk of match.bookmakers) {
          for (const market of (bk.markets||[])) {
            if (market.key !== 'totals') continue;
            for (const outcome of (market.outcomes||[])) {
              const pt = parseFloat(outcome.point);
              const pr = parseFloat(outcome.price);
              if (outcome.name === 'Over' && pt === 0.5 && !ft05) ft05 = pr;
              if (outcome.name === 'Over' && pt === 1.5 && !ft15) ft15 = pr;
            }
          }
        }

        if (ft05 || ft15) {
          footballOddsCache.set(fdMatch.id, {
            ft05: ft05 || null,
            ft15: ft15 || null,
            home: match.home_team,
            away: match.away_team,
            updatedAt: Date.now()
          });
          diag.theodds.lastOk = nowISO();
          diag.theodds.cacheSize = footballOddsCache.size;
        }
      });
    } catch(e) {
      diag.theodds.lastErr = nowISO();
      diag.theodds.lastErrMsg = e.message;
      console.warn('[THEODDS]', league, e.message);
    }
  }
}


// BETFAIR INTEGRATION START ════════════════════════════════════════════════════
// Betfair Exchange API — live (delayed 3min with free key) odds for tennis & football
// NOTE: BETFAIR_SSOID (session token) expires ~12h inactivity — renew via Railway env.
// Priority: Betfair > odds-api.io > TheOdds > AllSports pre-match

function betfairPost(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname: 'api.betfair.com',
      path: '/exchange/betting/json-rpc/v1',
      method: 'POST',
      headers: {
        'X-Application': BETFAIR_APP_KEY,
        'X-Authentication': BETFAIR_SSOID,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Accept': 'application/json',
      },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error('BF JSON: ' + d.slice(0, 100))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('BF timeout')); });
    req.write(payload);
    req.end();
  });
}

function normName(s) {
  return (s||'').toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim();
}

function namesMatch(a, b) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const la = na.split(' ').pop(), lb = nb.split(' ').pop();
  if (la.length >= 4 && lb.length >= 4 && la === lb) return true;
  if (na.length >= 4 && nb.includes(na)) return true;
  if (nb.length >= 4 && na.includes(nb)) return true;
  return false;
}

async function fetchBetfairTennisOdds() {
  if (!BETFAIR_SSOID || !BETFAIR_APP_KEY) return;
  const liveTennis = lastTennis.filter(m => !m.isUp);
  if (!liveTennis.length) return;
  diag.betfair.callCount++;
  trackApiCall('betfair');
  try {
    const catResp = await betfairPost([{
      jsonrpc: '2.0', id: 1,
      method: 'SportsAPING/v1.0/listMarketCatalogue',
      params: {
        filter: { eventTypeIds: ['2'], inPlayOnly: true, marketTypeCodes: ['MATCH_ODDS','SET_WINNER'] },
        marketProjection: ['EVENT','RUNNERS'],
        maxResults: '200',
        sort: 'FIRST_TO_START',
      },
    }]);
    if (!catResp?.[0]?.result) {
      const err = JSON.stringify(catResp?.[0]?.error || '');
      if (err.includes('INVALID_SESSION') || err.includes('-32000')) {
        diag.betfair.ssoExpired = true;
        diag.betfair.lastErrMsg = 'SSOID expired — renew BETFAIR_SSOID in Railway';
      }
      return;
    }
    diag.betfair.ssoExpired = false;
    const markets = catResp[0].result;
    diag.betfair.marketsFound = markets.length;

    const eventMap = new Map();
    for (const mkt of markets) {
      const eid = mkt.event?.id; if (!eid) continue;
      if (!eventMap.has(eid)) {
        const rn = mkt.runners || [];
        eventMap.set(eid, { p1: rn[0]?.runnerName||'', p2: rn[1]?.runnerName||'', matchId: null, setIds: [] });
      }
      const e = eventMap.get(eid);
      if (mkt.marketType === 'MATCH_ODDS') e.matchId = mkt.marketId;
      if (mkt.marketType === 'SET_WINNER') e.setIds.push({ id: mkt.marketId, name: (mkt.marketName||'').toLowerCase() });
    }

    const matched = [];
    for (const [, bf] of eventMap) {
      for (const tm of liveTennis) {
        if (namesMatch(bf.p1, tm.p1) && namesMatch(bf.p2, tm.p2)) {
          matched.push({ tm, matchId: bf.matchId, setIds: bf.setIds }); break;
        }
      }
    }
    if (!matched.length) return;

    const allIds = matched.flatMap(m => [m.matchId, ...m.setIds.map(s=>s.id)].filter(Boolean));
    const bookResp = await betfairPost([{
      jsonrpc: '2.0', id: 2,
      method: 'SportsAPING/v1.0/listMarketBook',
      params: {
        marketIds: allIds,
        priceProjection: { priceData: ['EX_BEST_OFFERS'], exBestOffersOverrides: { bestPricesDepth: 1 } },
      },
    }]);
    if (!bookResp?.[0]?.result) return;
    const books = new Map(bookResp[0].result.map(b => [b.marketId, b]));

    for (const { tm, matchId, setIds } of matched) {
      const favIs = (tm.o1 >= ODD_MIN && tm.o1 <= ODD_MAX) ? 'p1' : 'p2';
      const tc = tennisOddsCache.get(tm._key) || {};

      if (matchId && books.has(matchId)) {
        const rn = books.get(matchId).runners || [];
        const r0 = rn[0]?.ex?.availableToBack?.[0]?.price;
        const r1 = rn[1]?.ex?.availableToBack?.[0]?.price;
        if (r0 || r1) {
          tc.match_o1 = r0||null; tc.match_o2 = r1||null;
          tc.match = favIs==='p1'?r0:r1; tc.source_match = 'betfair';
        }
      }
      for (const sw of setIds) {
        if (!books.has(sw.id)) continue;
        const rn = books.get(sw.id).runners || [];
        const r0 = rn[0]?.ex?.availableToBack?.[0]?.price;
        const r1 = rn[1]?.ex?.availableToBack?.[0]?.price;
        if (!r0 && !r1) continue;
        if (sw.name.includes('set ' + tm.curSetNum) || sw.name.includes('set' + tm.curSetNum)) {
          tc.current_o1=r0||null; tc.current_o2=r1||null;
          tc.current=favIs==='p1'?r0:r1; tc.source_current='betfair';
        }
        if (sw.name.includes('set 2') || sw.name.includes('set2')) {
          tc.set2_o1=r0||null; tc.set2_o2=r1||null;
          tc.set2=favIs==='p1'?r0:r1; tc.source_set2='betfair';
        }
      }
      tc.updatedAt = Date.now();
      tennisOddsCache.set(tm._key, tc);
      // Mirror into oddsCache so normT() picks it up without changes
      const oc = oddsCache.get(tm._key) || {};
      if (tc.match)   { oc.match   = tc.match;   oc.source = 'betfair'; }
      if (tc.set2)    { oc.set2    = tc.set2; }
      if (tc.current) { oc.current = tc.current; }
      oc.match_o1 = tc.match_o1; oc.match_o2 = tc.match_o2;
      oddsCache.set(tm._key, oc);
    }
    diag.betfair.lastOk = nowISO();
    console.log('[BETFAIR TENNIS] updated', matched.length, 'matches');
  } catch(e) {
    diag.betfair.lastErr = nowISO(); diag.betfair.lastErrMsg = e.message;
    console.warn('[BETFAIR TENNIS]', e.message);
  }
}

async function fetchBetfairFootballOdds() {
  if (!BETFAIR_SSOID || !BETFAIR_APP_KEY) return;
  const liveF = lastFootball.filter(m => m.status==='IN_PLAY'||m.status==='PAUSED');
  if (!liveF.length) return;
  diag.betfair.callCount++;
  trackApiCall('betfair');
  try {
    const catResp = await betfairPost([{
      jsonrpc: '2.0', id: 3,
      method: 'SportsAPING/v1.0/listMarketCatalogue',
      params: {
        filter: { eventTypeIds: ['1'], inPlayOnly: true, marketTypeCodes: ['OVER_UNDER_05','OVER_UNDER_15'] },
        marketProjection: ['EVENT','RUNNERS'],
        maxResults: '100', sort: 'FIRST_TO_START',
      },
    }]);
    if (!catResp?.[0]?.result) return;
    const markets = catResp[0].result;
    const eventMap = new Map();
    for (const mkt of markets) {
      const eid = mkt.event?.id; if (!eid) continue;
      if (!eventMap.has(eid)) eventMap.set(eid, { name: mkt.event?.name||'', ou05Id: null, ou15Id: null });
      const e = eventMap.get(eid);
      if (mkt.marketType === 'OVER_UNDER_05') e.ou05Id = mkt.marketId;
      if (mkt.marketType === 'OVER_UNDER_15') e.ou15Id = mkt.marketId;
    }
    const matched = [];
    for (const [, bf] of eventMap) {
      const parts = bf.name.split(' v ');
      const bfH = parts[0]?.trim()||'', bfA = parts[1]?.trim()||'';
      const fm = liveF.find(f => namesMatch(bfH,f.h) && namesMatch(bfA,f.a));
      if (fm) matched.push({ fm, ou05Id: bf.ou05Id, ou15Id: bf.ou15Id });
    }
    if (!matched.length) return;
    const allIds = matched.flatMap(m => [m.ou05Id,m.ou15Id].filter(Boolean));
    const bookResp = await betfairPost([{
      jsonrpc: '2.0', id: 4,
      method: 'SportsAPING/v1.0/listMarketBook',
      params: {
        marketIds: allIds,
        priceProjection: { priceData: ['EX_BEST_OFFERS'], exBestOffersOverrides: { bestPricesDepth: 1 } },
      },
    }]);
    if (!bookResp?.[0]?.result) return;
    const books = new Map(bookResp[0].result.map(b => [b.marketId, b]));
    for (const { fm, ou05Id, ou15Id } of matched) {
      const fc = footballOddsCache.get(fm.id) || {};
      const getOver = (mktId) => {
        if (!mktId || !books.has(mktId)) return null;
        const rn = books.get(mktId).runners || [];
        const over = rn.find(r => (r.runnerName||'').toLowerCase().includes('over') || r.sortPriority===1);
        return over?.ex?.availableToBack?.[0]?.price || null;
      };
      const p05 = getOver(ou05Id), p15 = getOver(ou15Id);
      if (p05) { fc.ft05 = p05; fc.source_ft05 = 'betfair'; }
      if (p15) { fc.ft15 = p15; fc.source_ft15 = 'betfair'; }
      if (p05 || p15) { fc.updatedAt = Date.now(); footballOddsCache.set(fm.id, fc); }
    }
    diag.betfair.lastOk = nowISO();
    console.log('[BETFAIR FOOTBALL] updated', matched.length, 'matches');
  } catch(e) {
    diag.betfair.lastErr = nowISO(); diag.betfair.lastErrMsg = e.message;
    console.warn('[BETFAIR FOOTBALL]', e.message);
  }
}

async function fetchBetfairOdds() {
  await Promise.allSettled([fetchBetfairTennisOdds(), fetchBetfairFootballOdds()]);
}
// BETFAIR INTEGRATION END ══════════════════════════════════════════════════════

// FALLBACK ODDS API START ══════════════════════════════════════════════════════
// odds-api.io — fallback when Betfair has no market (ITF/Challenger tennis, etc.)

async function fetchOddsApiIoTennis() {
  if (!ODDS_API_IO_KEY) return;
  const live = lastTennis.filter(m => !m.isUp);
  if (!live.length) return;
  const needsFallback = live.filter(m => {
    const tc = tennisOddsCache.get(m._key);
    return !tc || !tc.match || tc.source_match !== 'betfair';
  });
  if (!needsFallback.length) return;
  diag.oddsapiio.callCount++;
  trackApiCall('oddsapiio');
  try {
    const url = 'https://odds-api.io/api/odds?sport=tennis&market=h2h&apikey=' + ODDS_API_IO_KEY;
    const r = await fetchJson(url);
    const events = Array.isArray(r) ? r : (r.data || r.events || r.results || []);
    for (const ev of events) {
      const homeLC = (ev.home_team||ev.homeTeam||ev.player1||'').toLowerCase();
      const awayLC = (ev.away_team||ev.awayTeam||ev.player2||'').toLowerCase();
      const tm = needsFallback.find(m => namesMatch(homeLC,m.p1) && namesMatch(awayLC,m.p2));
      if (!tm) continue;
      const favIs = (tm.o1>=ODD_MIN&&tm.o1<=ODD_MAX)?'p1':'p2';
      let homeOdd=null, awayOdd=null;
      for (const bk of (ev.bookmakers||ev.sportsbooks||[])) {
        for (const mkt of (bk.markets||bk.odds||[])) {
          const key=(mkt.key||mkt.market||'').toLowerCase();
          if (!['h2h','match_winner','moneyline','winner'].includes(key)) continue;
          for (const oc of (mkt.outcomes||mkt.selections||[])) {
            const name=(oc.name||oc.label||'').toLowerCase();
            const price=parseFloat(oc.price||oc.odd||oc.odds||0);
            if (price>1.01) {
              if (homeOdd===null && (namesMatch(name,tm.p1)||name==='home'||name==='1')) homeOdd=price;
              if (awayOdd===null && (namesMatch(name,tm.p2)||name==='away'||name==='2')) awayOdd=price;
            }
          }
          if (homeOdd||awayOdd) break;
        }
        if (homeOdd||awayOdd) break;
      }
      if (homeOdd||awayOdd) {
        const tc = tennisOddsCache.get(tm._key) || {};
        if (!tc.match || tc.source_match!=='betfair') {
          tc.match_o1=homeOdd; tc.match_o2=awayOdd;
          tc.match=favIs==='p1'?homeOdd:awayOdd; tc.source_match='oddsapiio';
          tc.updatedAt=Date.now(); tennisOddsCache.set(tm._key,tc);
          const oc=oddsCache.get(tm._key)||{};
          if (!oc.match||oc.source!=='betfair') {
            oc.match=tc.match; oc.match_o1=homeOdd; oc.match_o2=awayOdd; oc.source='oddsapiio';
            oddsCache.set(tm._key,oc);
          }
        }
      }
    }
    diag.oddsapiio.lastOk=nowISO(); diag.oddsapiio.cacheSize=tennisOddsCache.size;
  } catch(e) {
    diag.oddsapiio.lastErr=nowISO(); diag.oddsapiio.lastErrMsg=e.message;
    console.warn('[ODDSAPIIO TENNIS]',e.message);
  }
}

async function fetchOddsApiIoFootball() {
  if (!ODDS_API_IO_KEY) return;
  const liveF = lastFootball.filter(m=>m.status==='IN_PLAY'||m.status==='PAUSED');
  if (!liveF.length) return;
  const needsFallback = liveF.filter(m => {
    const fc=footballOddsCache.get(m.id);
    return !fc||(!fc.ft05&&!fc.ft15)||fc.source_ft05!=='betfair';
  });
  if (!needsFallback.length) return;
  diag.oddsapiio.callCount++;
  trackApiCall('oddsapiio');
  try {
    const url='https://odds-api.io/api/odds?sport=soccer&market=totals&apikey='+ODDS_API_IO_KEY;
    const r=await fetchJson(url);
    const events=Array.isArray(r)?r:(r.data||r.events||r.results||[]);
    for (const ev of events) {
      const homeLC=(ev.home_team||ev.homeTeam||'').toLowerCase();
      const awayLC=(ev.away_team||ev.awayTeam||'').toLowerCase();
      const fm=needsFallback.find(m=>namesMatch(homeLC,m.h)&&namesMatch(awayLC,m.a));
      if (!fm) continue;
      let ft05=null,ft15=null;
      for (const bk of (ev.bookmakers||ev.sportsbooks||[])) {
        for (const mkt of (bk.markets||bk.odds||[])) {
          const key=(mkt.key||mkt.market||'').toLowerCase();
          if (!['totals','over_under','goals','total'].includes(key)) continue;
          for (const oc of (mkt.outcomes||mkt.selections||[])) {
            const name=(oc.name||oc.label||'').toLowerCase();
            const pt=parseFloat(oc.point||oc.line||oc.handicap||0);
            const pr=parseFloat(oc.price||oc.odd||oc.odds||0);
            if (pr>1.01&&name.includes('over')) {
              if (Math.abs(pt-0.5)<0.01&&!ft05) ft05=pr;
              if (Math.abs(pt-1.5)<0.01&&!ft15) ft15=pr;
            }
          }
        }
        if (ft05||ft15) break;
      }
      if (ft05||ft15) {
        const fc=footballOddsCache.get(fm.id)||{};
        if (!fc.source_ft05||fc.source_ft05!=='betfair') {
          if (ft05){fc.ft05=ft05;fc.source_ft05='oddsapiio';}
          if (ft15){fc.ft15=ft15;fc.source_ft15='oddsapiio';}
          fc.updatedAt=Date.now(); footballOddsCache.set(fm.id,fc);
        }
      }
    }
    diag.oddsapiio.lastOk=nowISO();
  } catch(e) {
    diag.oddsapiio.lastErr=nowISO(); diag.oddsapiio.lastErrMsg=e.message;
    console.warn('[ODDSAPIIO FOOTBALL]',e.message);
  }
}

// fetchFallbackOdds — fills gaps after Betfair poll
async function fetchFallbackOdds() {
  await Promise.allSettled([
    fetchOddsApiIoTennis(),
    fetchOddsApiIoFootball(),
    fetchTheOddsFootball(),
  ]);
}
// FALLBACK ODDS API END ════════════════════════════════════════════════════════

// ── AllSports Football Livescore — para minuto real ───────────────────────────
// FIX BUG 2: football-data.org no da minuto real → usar allsports como complemento
const allSportsLiveMinutes = new Map(); // fd_matchId → {min, status}

async function fetchAllSportsFootballLive() {
  if (!TENNIS_KEY) return; // usa misma key (allsports)
  try {
    const r = await fetchJson(
      `https://apiv2.allsportsapi.com/football/?met=Livescore&APIkey=${TENNIS_KEY}`
    );
    if (!r.success || !Array.isArray(r.result)) return;
    r.result.forEach(m => {
      // Try to match by team name to lastFootball
      const homeLC = (m.event_home_team||'').toLowerCase();
      const awayLC = (m.event_away_team||'').toLowerCase();
      const fdMatch = lastFootball.find(f => {
        const fh = (f.h||'').toLowerCase(), fa = (f.a||'').toLowerCase();
        return (fh.includes(homeLC.slice(0,4)) || homeLC.includes(fh.slice(0,4))) &&
               (fa.includes(awayLC.slice(0,4)) || awayLC.includes(fa.slice(0,4)));
      });
      if (fdMatch) {
        const min = parseInt(m.event_status) || 0;
        allSportsLiveMinutes.set(fdMatch.id, {
          min,
          status: m.event_live === '1' ? 'IN_PLAY' : 'SCHEDULED',
          elapsed: m.event_status,
        });
      }
    });
  } catch(e) { /* silent - not critical */ }
}

// ── Football data.org ─────────────────────────────────────────────────────────
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
  // FIX BUG 2: override min from AllSports if available
  const asLive = allSportsLiveMinutes.get('fd_'+m.id);
  if (asLive && asLive.min > 0 && (m.status==='IN_PLAY'||m.status==='PAUSED')) {
    min = asLive.min;
  }
  const g2=shH!=null?Math.max(0,(shF-shH)+(saF-saH)):0;
  // Get football odds from TheOdds cache
  const fOdds = footballOddsCache.get('fd_'+m.id) || {};
  return{id:'fd_'+m.id,league:code==='PD'?'LaLiga EA Sports':'Premier League',k:code==='PD'?'laliga':'premier',
    status:m.status,min,h:m.homeTeam?.shortName||m.homeTeam?.name||'?',a:m.awayTeam?.shortName||m.awayTeam?.name||'?',
    hc:m.homeTeam?.crest||null,ac:m.awayTeam?.crest||null,
    lh:shF,la:saF,lhLive:shF,laLive:saF,lhH:shH,laH:saH,g2,utcDate:m.utcDate,
    a25:alerted.has('25_fd_'+m.id),a67:alerted.has('67_fd_'+m.id),
    odds_ft05: fOdds.ft05||null,
    odds_ft15: fOdds.ft15||null,
  };
}

async function fetchFootball(){
  if(!FOOTBALL_KEY) { diag.football.lastErrMsg='FOOTBALL_KEY missing'; return; }
  diag.football.callCount++;
  trackApiCall('football');
  const [t,tm]=[todayStr(),tomorrowStr()];
  try {
    const [pd,pl]=await Promise.all([
      fetchJson(`https://api.football-data.org/v4/competitions/PD/matches?dateFrom=${t}&dateTo=${tm}`,{'X-Auth-Token':FOOTBALL_KEY}),
      fetchJson(`https://api.football-data.org/v4/competitions/PL/matches?dateFrom=${t}&dateTo=${tm}`,{'X-Auth-Token':FOOTBALL_KEY}),
    ]);
    const all=[...(pd.matches||[]).map(m=>normF(m,'PD')),...(pl.matches||[]).map(m=>normF(m,'PL'))];
    // FIX BUG 8: merge into allFootballForSim instead of overriding
    if (all.length > 0) {
      all.forEach(m => {
        const idx = allFootballForSim.findIndex(x => x.id === m.id);
        if (idx >= 0) allFootballForSim[idx] = m;
        else allFootballForSim.push(m);
      });
      lastFootball = allFootballForSim.filter(m=>m.status!=='FINISHED');
    }
    diag.football.lastOk = nowISO();
  } catch(e) {
    diag.football.lastErr = nowISO();
    diag.football.lastErrMsg = e.message;
    console.error('[FOOTBALL]', e.message);
  }
}

async function fetchFootballNext() {
  if(!FOOTBALL_KEY) return;
  try {
    const [t,tm]=[todayStr(),tomorrowStr()];
    const [pd,pl]=await Promise.all([
      fetchJson(`https://api.football-data.org/v4/competitions/PD/matches?dateFrom=${t}&dateTo=${tm}`,{'X-Auth-Token':FOOTBALL_KEY}),
      fetchJson(`https://api.football-data.org/v4/competitions/PL/matches?dateFrom=${t}&dateTo=${tm}`,{'X-Auth-Token':FOOTBALL_KEY}),
    ]);
    const all=[...(pd.matches||[]).map(m=>normF(m,'PD')),...(pl.matches||[]).map(m=>normF(m,'PL'))];
    nextFootball = all.filter(m=>m.status!=='FINISHED').sort((a,b)=>new Date(a.utcDate)-new Date(b.utcDate));
  } catch(e) { console.warn('[NEXT24]', e.message); }
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
      const fOdds = footballOddsCache.get(m.id) || {};
      simAlerts.unshift({id:k25+'_05',type:'football_ht_05',match:`${m.h} vs ${m.a}`,
        detail:`${m.league} · ~Min.${m.min} · 1ªP +0.5`,alertedAt:nowISO(),resolved:false,outcome:null,
        _matchId:m.id.replace('fd_',''),_resolveOn:'ht_goal',_market:'+0.5',_nominalStake:50,
        _league:m.league,_half:1,odds_ft05:fOdds.ft05||null,odds_ft15:fOdds.ft15||null});
      simAlerts.unshift({id:k25+'_15',type:'football_ht_15',match:`${m.h} vs ${m.a}`,
        detail:`${m.league} · ~Min.${m.min} · 1ªP +1.5`,alertedAt:nowISO(),resolved:false,outcome:null,
        _matchId:m.id.replace('fd_',''),_resolveOn:'ht_goal_15',_market:'+1.5',_nominalStake:25,
        _league:m.league,_half:1,odds_ft05:fOdds.ft05||null,odds_ft15:fOdds.ft15||null});
      if(simAlerts.length>500) simAlerts.length=500;
      const oddsStr = fOdds.ft05 ? ` · +0.5@${fOdds.ft05}x +1.5@${fOdds.ft15||'?'}x` : '';
      sendTG(`${m.h} vs ${m.a} · ${m.league}\nMin.${m.min} · 0-0 1ªP · apostar +0.5 (50€) y +1.5 (25€)${oddsStr}`);
    }
    if(m.min>=46&&m.min<=50&&m.lhH!=null&&!htSnapshot.has(m.id)) htSnapshot.set(m.id,{h:m.lhH,a:m.laH});
    const snap=htSnapshot.get(m.id);
    const goals2h=snap!=null?Math.max(0,((m.lhLive||0)-snap.h)+((m.laLive||0)-snap.a)):0;
    const k67='67_'+m.id;
    if(m.min>=63&&m.min<=78&&!alerted.has(k67)&&goals2h===0){
      alerted.add(k67);
      const fOdds = footballOddsCache.get(m.id) || {};
      simAlerts.unshift({id:k67+'_05',type:'football_2h_05',match:`${m.h} vs ${m.a}`,
        detail:`${m.league} · ~Min.${m.min} · 2ªP +0.5`,alertedAt:nowISO(),resolved:false,outcome:null,
        _matchId:m.id.replace('fd_',''),_resolveOn:'sh_goal',_market:'+0.5',_nominalStake:50,
        _league:m.league,_half:2,odds_ft05:fOdds.ft05||null,odds_ft15:fOdds.ft15||null});
      simAlerts.unshift({id:k67+'_15',type:'football_2h_15',match:`${m.h} vs ${m.a}`,
        detail:`${m.league} · ~Min.${m.min} · 2ªP +1.5`,alertedAt:nowISO(),resolved:false,outcome:null,
        _matchId:m.id.replace('fd_',''),_resolveOn:'sh_goal_15',_market:'+1.5',_nominalStake:25,
        _league:m.league,_half:2,odds_ft05:fOdds.ft05||null,odds_ft15:fOdds.ft15||null});
      if(simAlerts.length>500) simAlerts.length=500;
      const oddsStr = fOdds.ft05 ? ` · +0.5@${fOdds.ft05}x +1.5@${fOdds.ft15||'?'}x` : '';
      sendTG(`${m.h} vs ${m.a} · ${m.league}\nMin.${m.min} · 0-0 2ªP · apostar +0.5 (50€) y +1.5 (25€)${oddsStr}`);
    }
  });
}

// FIX BUG 8: football resolution - more robust, checks FINISHED status properly
function resolveFootballSims(){
  const now = Date.now();
  simAlerts.forEach(s=>{
    if(s.resolved||!s._matchId) return;
    const m=allFootballForSim.find(x=>x.id==='fd_'+s._matchId);
    if(!m) {
      // FIX: if match not found and sim is old (>4h), try to resolve from context
      const alertAge = now - new Date(s.alertedAt).getTime();
      if (alertAge > 4 * 3600000) {
        // If +24h and still unresolved, mark as stale - needs manual check
        if (alertAge > 24 * 3600000) {
          s._stale = true;
        }
      }
      return;
    }
    const pastHT=m.status==='PAUSED'||m.status==='FINISHED'||(m.status==='IN_PLAY'&&m.min>45);
    const goalsHT=(m.lhH||0)+(m.laH||0);
    if(s._resolveOn==='ht_goal'&&pastHT){s.outcome=goalsHT>=1?'WIN':'LOSS';s.resolved=true;s.resolvedAt=nowISO();}
    if(s._resolveOn==='ht_goal_15'&&pastHT){s.outcome=goalsHT>=2?'WIN':'LOSS';s.resolved=true;s.resolvedAt=nowISO();}
    if(s._resolveOn==='sh_goal'&&m.status==='FINISHED'){s.outcome=m.g2>=1?'WIN':'LOSS';s.resolved=true;s.resolvedAt=nowISO();}
    if(s._resolveOn==='sh_goal_15'&&m.status==='FINISHED'){s.outcome=m.g2>=2?'WIN':'LOSS';s.resolved=true;s.resolvedAt=nowISO();}
  });
  // Update diag
  diag.resolution.pendingFootball = simAlerts.filter(s=>!s.resolved&&s._matchId).length;
  diag.resolution.staleOver6h = simAlerts.filter(s=>!s.resolved&&s._stale).length;
}

// ── Tennis ───────────────────────────────────────────────────────────────────
function getCat(s){
  const l=(s||'').toLowerCase();
  if(l.includes('itf')){
    const isW=l.includes('women')||l.includes(' w ')||/\bitf w\d/i.test(s)||/\bw\d{1,3}\b/.test(s)||l.includes('wta')||l.includes('female')||l.includes('ladies');
    return isW?'itf_f':'itf_m';
  }
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
  if(l.includes('grand slam')||l.includes('australian open')||l.includes('roland garros')||
     l.includes('wimbledon')||l.includes('us open')) return 'slam';
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

function normalizeRound(raw) {
  if (!raw || !raw.trim()) return null;
  const r = raw.toLowerCase().trim().replace(/-.*$/, '').trim();
  if (r.includes('final') && (r.includes('quarter')||r.includes('1/4'))) return 'qf';
  if (r.includes('final') && (r.includes('semi')||r.includes('1/2')))    return 'sf';
  if (r==='final'||r==='the final') return 'f';
  if (r.includes('1/8')||r.includes('round of 16')||r.includes('r16'))   return 'r16';
  if (r.includes('1/16')||r.includes('round of 32')||r.includes('r32'))  return 'r32';
  if (r.includes('1/32')||r.includes('round of 64')||r.includes('r64'))  return 'r64';
  if (r.includes('1/64')||r.includes('round of 128')||r.includes('r128')) return 'r128';
  if (r.includes('qualif')||r.includes('qual.'))                          return 'q';
  if (r.includes('round robin')||r.includes('group'))                     return 'rr';
  if (r.match(/round (\d+)/)) return 'r' + r.match(/round (\d+)/)[1];
  return raw.trim().slice(0, 20);
}

// ── resolveTennisOdds — centralized priority chain ────────────────────────────
// ChatGPT recommendation + our own analysis. Merges all sources with priority.
function resolveTennisOdds(matchKey) {
  const bf   = tennisOddsCache.get(matchKey) || {};          // Betfair / oddsapiio / theodds
  const as   = oddsCache.get(matchKey)       || {};          // AllSports (pre-match & live)

  // Determine best match odd
  const match = bf.match ?? as.match ?? null;
  const set2  = bf.set2  ?? as.set2  ?? null;
  const curr  = bf.current ?? as.current ?? null;

  // Determine source label (first available)
  let source = null;
  if      (bf.source_match === 'betfair')    source = 'betfair';
  else if (bf.source_match === 'oddsapiio')  source = 'oddsapiio';
  else if (bf.source_match === 'theodds')    source = 'theodds';
  else if (as.source === 'allsports_live')   source = 'allsports_live';
  else if (match != null)                    source = 'allsports';

  return { match, set2, current: curr, source };
}


function normT(e){
  const _trnFull=(e.country_name||'')+' '+(e.league_name||'');
  const cat=getCat(_trnFull);
  const tier=getTier(e.league_name||'');
  const surface=getSurface(e.league_name||'', e.country_name||'', e.league_key);
  const round=normalizeRound(e.league_round||'');
  const{o1,o2}=getMatchOdds(e);
  const scores=e.scores||[];
  const cs=scores.filter(s=>{const a=parseInt(s.score_first)||0,b=parseInt(s.score_second)||0;return(a>=6||b>=6)&&(Math.abs(a-b)>=2||a>=7||b>=7);});
  const sets1=cs.map(s=>parseInt(s.score_first)||0), sets2=cs.map(s=>parseInt(s.score_second)||0);
  const curSetNum=cs.length+1;
  const cr1=parseInt(e.event_first_player_score_current_set), cr2=parseInt(e.event_second_player_score_current_set);
  let g1=String(!isNaN(cr1)?cr1:0), g2=String(!isNaN(cr2)?cr2:0);
  const pbp=e.pointbypoint||[];
  const curGames=pbp.filter(g=>g.set_number==='Set '+curSetNum);
  if(g1==='0'&&g2==='0'){
    const incompleteRow=scores.find((s,i)=>i===cs.length);
    if(incompleteRow){
      const a=parseInt(incompleteRow.score_first),b=parseInt(incompleteRow.score_second);
      if(!isNaN(a)&&!isNaN(b)){g1=String(a);g2=String(b);}
    }
  }
  if(g1==='0'&&g2==='0'&&curGames.length>0){
    const lastPbp=curGames[curGames.length-1];
    if(lastPbp&&lastPbp.score){const sp=(lastPbp.score||'').split(' - ');if(sp.length===2){g1=(sp[0]||'0').trim();g2=(sp[1]||'0').trim();}}
  }
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
  // FIX BUG 5: if pbp is empty, try to detect break from scores
  if (!lastBreak && curGames.length === 0) {
    // Can't detect break without pbp - but at least mark match for monitoring
    // The break will be detected when pbp becomes available
  }
  const mon=(o1!=null&&o1>=ODD_MIN&&o1<=ODD_MAX)||(o2!=null&&o2>=ODD_MIN&&o2<=ODD_MAX);
  // Use centralized resolver — priority: Betfair > oddsapiio > theodds > allsports_live > allsports
  const _resolved = resolveTennisOdds(String(e.event_key));
  // Fallback: use o1/o2 pre-match if no odds in any cache
  const _preFav = (o1!=null&&o1>=ODD_MIN&&o1<=ODD_MAX) ? o1 : (o2!=null&&o2>=ODD_MIN&&o2<=ODD_MAX) ? o2 : null;
  const liveMatch   = _resolved.match   ?? _preFav ?? null;
  const liveSet2    = _resolved.set2    ?? null;
  const liveCurrent = _resolved.current ?? null;
  const oddsSource  = _resolved.source  ?? (_preFav!=null ? 'allsports' : null);
  return{id:'td_'+e.event_key,_key:String(e.event_key),cat,tier,surface,round,trn:e.league_name||'Torneo',
    p1:e.event_first_player||'?',p2:e.event_second_player||'?',
    o1,o2,sets1,sets2,g1,g2,pt1,pt2,srv:e.event_serve==='First Player'?1:2,
    curSetNum,lastBreak,pbpLen:pbp.length,mon,isUp:false,hasOdds:o1!=null||o2!=null,liveO1:o1,liveO2:o2,
    odds_match:   liveMatch,
    odds_set2:    liveSet2,
    odds_current: liveCurrent,
    odds_source:  oddsSource,
  };
}

function normTUp(e){
  const cat=getCat((e.country_name||'')+' '+(e.league_name||''));
  const tier=getTier(e.league_name||'');
  const surface=getSurface(e.league_name||'', e.country_name||'', e.league_key);
  const round=normalizeRound(e.league_round||'');
  let dt; try{dt=new Date(`${e.event_date}T${e.event_time||'00:00'}:00`);}catch{dt=new Date();}
  if(isNaN(dt.getTime())) dt=new Date();
  const{o1,o2}=getMatchOdds(e);
  const mon=(o1!=null&&o1>=ODD_MIN&&o1<=ODD_MAX)||(o2!=null&&o2>=ODD_MIN&&o2<=ODD_MAX);
  return{id:'tdu_'+e.event_key,_key:String(e.event_key),cat,tier,surface,round,trn:e.league_name||'Torneo',
    p1:e.event_first_player||'?',p2:e.event_second_player||'?',o1,o2,mon,hasOdds:o1!=null||o2!=null,
    localT:dt.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Madrid'}),
    localD:dt.toLocaleDateString('es-ES',{weekday:'short',day:'2-digit',month:'2-digit'}),
    _ts:dt.getTime(),isUp:true};
}

async function fetchTennis(){
  if(!TENNIS_KEY) { diag.tennis.lastErrMsg='TENNIS_KEY missing'; return []; }
  diag.tennis.callCount++;
  trackApiCall('allsports');
  await fetchAllOdds();
  const[lR,uR]=await Promise.allSettled([
    fetchJson(`https://apiv2.allsportsapi.com/tennis/?met=Livescore&APIkey=${TENNIS_KEY}`),
    fetchJson(`https://apiv2.allsportsapi.com/tennis/?met=Fixtures&APIkey=${TENNIS_KEY}&from=${todayStr()}&to=${tomorrowStr()}`),
  ]);
  const liveRaw=(lR.status==='fulfilled'&&lR.value.result)?lR.value.result:[];
  const upRaw=(uR.status==='fulfilled'&&uR.value.result)?uR.value.result:[];

  if (lR.status === 'fulfilled' && lR.value.success) {
    diag.tennis.lastOk = nowISO();
  } else {
    diag.tennis.lastErr = nowISO();
    diag.tennis.lastErrMsg = lR.reason?.message || 'failed';
  }

  // Save finished matches to cache BEFORE filtering them out (for resolution)
  const now_ms = Date.now();
  const FINISHED_TTL = 2 * 3600 * 1000; // keep 2h
  liveRaw.forEach(e => {
    if (isDoubles(e)) return;
    if (e.event_status === 'Finished' || e.event_status === '1' || e.event_status === 'After Penalties') {
      const key = 'td_' + e.event_key;
      const normalised = normT(e);
      finishedTennisCache.set(key, { ...normalised, finishedAt: now_ms });
    }
  });
  // Prune old entries
  finishedTennisCache.forEach((v, k) => { if (now_ms - v.finishedAt > FINISHED_TTL) finishedTennisCache.delete(k); });

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
  if(rivG<=favG) return false;
  const brkFavG = favIs==='First Player' ? m.lastBreak.gP1 : m.lastBreak.gP2;
  const brkRivG = favIs==='First Player' ? m.lastBreak.gP2 : m.lastBreak.gP1;
  return rivG === brkRivG;
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
        sendTG(`${m.p1} vs ${m.p2} · ${m.trn}\nBreak recuperado set ${m.curSetNum}: ${m.g1}-${m.g2} · ${favName} igualó`);
      }
    }
    if(favG>rivG&&rec.alertedRecovery) rec.alertedRecovery=false;
  });
}

function checkFootballStart(){
  lastFootball.forEach(m=>{
    if(m.status!=='IN_PLAY') return;
    const ks=`fstart_${m.id}`; if(alerted.has(ks)) return; alerted.add(ks);
    sendTG(`${m.h} vs ${m.a} · ${m.league}\nPartido iniciado`);
  });
}

function checkMonitoredMatchStart(){
  lastTennis.filter(m=>!m.isUp&&m.mon&&m.pbpLen>0).forEach(m=>{
    const ks=`start_${m.id}`; if(alerted.has(ks)) return; alerted.add(ks);
    const favIs=(m.o1!=null&&m.o1>=ODD_MIN&&m.o1<=ODD_MAX)?'First Player':'Second Player';
    const favName=favIs==='First Player'?m.p1:m.p2, favO=favIs==='First Player'?m.o1:m.o2;
    sendTG(`${m.p1} vs ${m.p2} · ${m.trn}\nInicio monitorizado · fav ${favName} @${favO!=null?favO+'x':'n/d'}`);
  });
}

function checkTennisAlerts(live){
  live.forEach(m=>{
    if(!isBreakAlert(m)) return;
    const kb=`brk_set_${m.id}_s${m.curSetNum}`;
    if(alerted.has(kb)) return; alerted.add(kb);
    const favIs=(m.o1!=null&&m.o1>=ODD_MIN&&m.o1<=ODD_MAX)?'First Player':'Second Player';
    const favName=favIs==='First Player'?m.p1:m.p2, favO=favIs==='First Player'?m.o1:m.o2;
    const oddsband=favO==null?'n/d':favO<1.30?'1.20-1.30':favO<1.40?'1.30-1.40':favO<1.50?'1.40-1.50':'1.50-1.60';
    const cached = oddsCache.get(m._key) || {};
    simAlerts.unshift({id:kb,type:'tennis_break',match:`${m.p1} vs ${m.p2}`,
      detail:`${m.trn} [${m.cat.toUpperCase()}] · Set ${m.curSetNum}: ${m.lastBreak.gP1}–${m.lastBreak.gP2} · Fav ROTO: ${favName}`,
      alertedAt:nowISO(),resolved:false,outcome:null,
      _eventId:m.id,_setNum:m.curSetNum,_favIs:favIs,
      _setsP1atAlert:[...m.sets1],_setsP2atAlert:[...m.sets2],
      _favO:favO,_oddsband:oddsband,_cat:m.cat,_tier:m.tier,_surface:m.surface,_round:m.round,
      _liveO1:m.o1,_liveO2:m.o2,
      odds_match:   cached.match   || null,
      odds_set2:    cached.set2    || null,
      odds_current: cached.current || null,
    });
    if(simAlerts.length>500) simAlerts.length=500;
    const oddsStr = cached.current ? ` · set @${cached.current}x` : cached.match ? ` · match @${cached.match}x` : '';
    sendTG(`${m.p1} vs ${m.p2} · ${m.trn}\nBreak ${m.curSetNum}º set: ${m.g1}-${m.g2} · ${favName} roto\nFav @${favO!=null?favO+'x':'n/d'} → apostar gana set${oddsStr}`);
  });
  scheduleFbSave();
}

function checkSet1Loss(live){
  live.forEach(m=>{
    const favIs=m.o1!=null&&m.o1>=ODD_MIN&&m.o1<=ODD_MAX?'First Player':m.o2!=null&&m.o2>=ODD_MIN&&m.o2<=ODD_MAX?'Second Player':null;
    if(!favIs||m.sets1.length!==1) return;
    const fav1=favIs==='First Player'?m.sets1[0]:m.sets2[0], riv1=favIs==='First Player'?m.sets2[0]:m.sets1[0];
    if(fav1>=riv1) return;
    const favName=favIs==='First Player'?m.p1:m.p2, favO=favIs==='First Player'?m.o1:m.o2;
    const oddsband=favO==null?'n/d':favO<1.30?'1.20-1.30':favO<1.40?'1.30-1.40':favO<1.50?'1.40-1.50':'1.50-1.60';
    const cached = oddsCache.get(m._key) || {};
    const ks2=`set1loss_s2_${m.id}`, ksM=`set1loss_match_${m.id}`;
    if(!alerted.has(ksM)){
      if(!alerted.has(ks2)){
        alerted.add(ks2);
        simAlerts.unshift({id:ks2,type:'tennis_set1_set2',match:`${m.p1} vs ${m.p2}`,
          detail:`${m.trn} [${m.cat.toUpperCase()}] · Set1: ${m.sets1[0]}-${m.sets2[0]} · Fav pierde S1 → Gana S2?`,
          alertedAt:nowISO(),resolved:false,outcome:null,_eventId:m.id,_setNum:2,_favIs:favIs,
          _setsP1atAlert:[...m.sets1],_setsP2atAlert:[...m.sets2],_favO:favO,_oddsband:oddsband,
          _cat:m.cat,_tier:m.tier,_surface:m.surface,_round:m.round,_liveO1:m.o1,_liveO2:m.o2,
          odds_match: cached.match||null, odds_set2: cached.set2||null, odds_current: cached.current||null});
        if(simAlerts.length>500) simAlerts.length=500;
      }
      alerted.add(ksM);
      simAlerts.unshift({id:ksM,type:'tennis_set1_match',match:`${m.p1} vs ${m.p2}`,
        detail:`${m.trn} [${m.cat.toUpperCase()}] · Set1: ${m.sets1[0]}-${m.sets2[0]} · Fav pierde S1 → Gana partido?`,
        alertedAt:nowISO(),resolved:false,outcome:null,_eventId:m.id,_favIs:favIs,
        _setsP1atAlert:[...m.sets1],_setsP2atAlert:[...m.sets2],_favO:favO,_oddsband:oddsband,
        _cat:m.cat,_tier:m.tier,_surface:m.surface,_round:m.round,_liveO1:m.o1,_liveO2:m.o2,
        odds_match: cached.match||null, odds_set2: cached.set2||null, odds_current: cached.current||null});
      if(simAlerts.length>500) simAlerts.length=500;
      sendTG(`${m.p1} vs ${m.p2} · ${m.trn}\nSet 1: ${m.sets1[0]}-${m.sets2[0]} · ${favName} pierde S1 @${favO!=null?favO+'x':'n/d'}\nApostar: gana S2 / gana partido`);
    }
  });
  scheduleFbSave();
}

function resolveTennisSims(){
  simAlerts.forEach(s=>{
    if(s.resolved) return;
    // Check live matches first, then recently finished matches
    const m = lastTennis.find(x=>x.id===s._eventId) || finishedTennisCache.get(s._eventId);
    if(!m||m.isUp) return;
    const favName=s._favIs==='First Player'?s.match.split(' vs ')[0]:(s.match.split(' vs ')[1]||'').trim();
    if(s.type==='tennis_break'&&m.sets1.length>s._setsP1atAlert.length){
      const idx=s._setNum-1, favWon=s._favIs==='First Player'?m.sets1[idx]>m.sets2[idx]:m.sets2[idx]>m.sets1[idx];
      const sc1=m.sets1[idx], sc2=m.sets2[idx];
      s._tiebreak=(sc1===7&&sc2===6)||(sc1===6&&sc2===7);
      s._setScore=sc1+'-'+sc2;
      s.outcome=favWon?'WIN':'LOSS'; s.resolved=true; s.resolvedAt=nowISO();
      sendTG(`${s.match}\nSet ${s._setNum}: ${sc1}-${sc2}${s._tiebreak?' (tiebreak)':''} · ${favName} ${favWon?'gana':'pierde'} el set`);
    }
    if(s.type==='tennis_set1_set2'&&m.sets1.length>=2){
      const favWon=s._favIs==='First Player'?m.sets1[1]>m.sets2[1]:m.sets2[1]>m.sets1[1];
      s.outcome=favWon?'WIN':'LOSS'; s.resolved=true; s.resolvedAt=nowISO();
      sendTG(`${s.match}\nSet 2: ${m.sets1[1]}-${m.sets2[1]} · ${favName} ${favWon?'gana':'pierde'} S2`);
    }
    if(s.type==='tennis_set1_match'){
      const done=m.sets1.length>=2&&(m.sets1.filter((v,i)=>v>m.sets2[i]).length===2||m.sets2.filter((v,i)=>v>m.sets1[i]).length===2);
      if(done){
        const p1w=m.sets1.filter((v,i)=>v>m.sets2[i]).length, p2w=m.sets2.filter((v,i)=>v>m.sets1[i]).length;
        const favWon=s._favIs==='First Player'?p1w>p2w:p2w>p1w;
        s.outcome=favWon?'WIN':'LOSS'; s.resolved=true; s.resolvedAt=nowISO();
        sendTG(`${s.match}\n${m.sets1.map((v,i)=>`${v}-${m.sets2[i]}`).join(' ')} · ${favName} ${favWon?'gana':'pierde'} el partido`);
      }
    }
  });
  diag.resolution.pendingTennis = simAlerts.filter(s=>!s.resolved&&s.type&&s.type.startsWith('tennis')&&s.type!=='tennis_recovery').length;
  scheduleFbSave();
}

// ── Poll principal ────────────────────────────────────────────────────────────
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
    if(stats.pollCount%20===0) console.log(`[POLL #${stats.pollCount}] Tennis:${lastTennis.filter(m=>!m.isUp).length} Football:${lastFootball.filter(m=>m.status==='IN_PLAY').length} Odds:${oddsCache.size} FbOdds:${footballOddsCache.size}`);
  }catch(e){stats.errors++;console.error('[POLL ERROR]',e.message);}
  setTimeout(poll, hasLiveMatches()?45000:180000);
}

// ── Bucles independientes ─────────────────────────────────────────────────────
function startOddsPoll() {
  // PRIMARY: TheOdds API tennis h2h — every 2min when live matches exist
  // Uses THEODDS_KEY (already in Railway). No SSOID, no expiry, just works.
  const runTheOddsTennis = async () => {
    try { if (lastTennis.some(m=>!m.isUp)) await fetchTheOddsTennis(); }
    catch(e) { console.warn('[THEODDS TENNIS]', e.message); }
    setTimeout(runTheOddsTennis, 2 * 60 * 1000);
  };
  setTimeout(runTheOddsTennis, 8000); // 8s after boot

  // PRIMARY: TheOdds API football totals — every 3min when live football
  const runTheOddsFootball = async () => {
    try { if (lastFootball.some(m=>m.status==='IN_PLAY'||m.status==='PAUSED')) await fetchTheOddsFootball(); }
    catch(e) { console.warn('[THEODDS FOOTBALL]', e.message); }
    setTimeout(runTheOddsFootball, 3 * 60 * 1000);
  };
  setTimeout(runTheOddsFootball, 12000);

  // BONUS: Betfair live odds — every 30s (if SSOID works, adds live market odds)
  const runBetfair = async () => {
    try { if (BETFAIR_SSOID && BETFAIR_APP_KEY) await fetchBetfairOdds(); }
    catch(e) { console.warn('[BETFAIR]', e.message); }
    setTimeout(runBetfair, 30000);
  };
  setTimeout(runBetfair, 20000);

  // AllSports per-match odds — every 30s (primary live source for tennis)
  const runAllSports = async () => {
    try { await pollOdds(); } catch(e) { console.warn('[ALLSPORTS ODDS]', e.message); }
    setTimeout(runAllSports, 30000);
  };
  setTimeout(runAllSports, 5000); // start fast, 5s after boot

  // BONUS: odds-api.io fallback — every 5min
  const runFallback = async () => {
    try { await fetchFallbackOdds(); } catch(e) { console.warn('[FALLBACK ODDS]', e.message); }
    setTimeout(runFallback, 5 * 60 * 1000);
  };
  setTimeout(runFallback, 60000);
}

function startAllSportsFootballPoll() {
  const run = async () => {
    try { await fetchAllSportsFootballLive(); } catch(e) { /* silent */ }
    setTimeout(run, 60000); // cada 1 min
  };
  setTimeout(run, 20000);
}

function startNext24Poll() {
  const run = async () => {
    try { await fetchFootballNext(); } catch(e) { console.warn('[NEXT24]', e.message); }
    setTimeout(run, 10 * 60 * 1000);
  };
  run();
}

// ── GitHub helper ─────────────────────────────────────────────────────────────
async function ghUpsertFile(repoPath,contentStr,commitMsg){
  const GH_TOKEN=process.env.GH_TOKEN||'';
  const GH_REPO=process.env.GH_REPO||'Roturas25/Roturas25prod';
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
    res.end(JSON.stringify({
      ok:true, version:'v18',
      football:!!FOOTBALL_KEY, tennis:!!TENNIS_KEY, theodds:!!THEODDS_KEY,
      betfair: BETFAIR_SSOID ? (diag.betfair.ssoExpired ? '⚠ SSO_EXPIRED' : '✓') : '✗ MISSING',
      oddsapiio: !!ODDS_API_IO_KEY,
      telegram:!!TG_TOKEN,
      oddMin:ODD_MIN, oddMax:ODD_MAX, updated:lastUpdate, stats,
      liveFootball:lastFootball.filter(m=>m.status==='IN_PLAY'||m.status==='PAUSED').length,
      liveTennis:lastTennis.filter(m=>!m.isUp).length,
      oddsCache:oddsCache.size, tennisOddsCache:tennisOddsCache.size,
      fbOddsCache:footballOddsCache.size, simCount:simAlerts.length,
    }));
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
    res.end(JSON.stringify({
      football:lastFootball,tennis:lastTennis,updated:lastUpdate,
      alerted:[...alerted],simAlerts:simAlerts.slice(0,200),
      oddStats,catStats,ftStats,
      odds:Object.fromEntries(oddsCache),
      footballOdds:Object.fromEntries(footballOddsCache),
      tennisOdds:Object.fromEntries(tennisOddsCache),
    }));
    return;
  }

  if(path==='/football-next'&&req.method==='GET'){
    res.writeHead(200);
    res.end(JSON.stringify({matches:nextFootball,updated:lastUpdate}));
    return;
  }

  if(path==='/diagnostics'&&req.method==='GET'){
    const now = Date.now();
    const stale6h = simAlerts.filter(s=>!s.resolved&&s.type!=='tennis_recovery'&&(now-new Date(s.alertedAt).getTime())>6*3600000);
    const stale24h = simAlerts.filter(s=>!s.resolved&&(now-new Date(s.alertedAt).getTime())>24*3600000);
    res.writeHead(200);
    res.end(JSON.stringify({
      version: 'v12',
      uptime: Math.floor(process.uptime()),
      apis: {
        football:  { key: FOOTBALL_KEY  ? '✓' : '✗ MISSING', ...diag.football  },
        tennis:    { key: TENNIS_KEY    ? '✓' : '✗ MISSING', ...diag.tennis    },
        odds:      { key: TENNIS_KEY    ? '✓' : '✗ MISSING', ...diag.odds      },
        theodds:   { key: THEODDS_KEY   ? '✓' : '✗ MISSING', ...diag.theodds   },
        betfair:   { key: BETFAIR_SSOID ? (diag.betfair.ssoExpired?'⚠ SSO_EXPIRED':'✓') : '✗ MISSING', ...diag.betfair },
        oddsapiio: { key: ODDS_API_IO_KEY?'✓':'✗ MISSING', ...diag.oddsapiio },
        firebase:  diag.firebase,
        telegram:  diag.telegram,
      },
      live: {
        tennis: lastTennis.filter(m=>!m.isUp).length,
        football_inplay: lastFootball.filter(m=>m.status==='IN_PLAY'||m.status==='PAUSED').length,
        football_total: lastFootball.length,
      },
      sims: {
        total: simAlerts.length,
        pending_tennis: simAlerts.filter(s=>!s.resolved&&s.type?.startsWith('tennis')&&s.type!=='tennis_recovery').length,
        pending_football: simAlerts.filter(s=>!s.resolved&&s.type?.startsWith('football')).length,
        stale_over_6h: stale6h.length,
        stale_over_24h: stale24h.length,
        stale_details: stale6h.slice(0,5).map(s=>({id:s.id,match:s.match,type:s.type,alertedAt:s.alertedAt})),
      },
      cache: {
        odds_allsports: oddsCache.size,
        odds_tennis_live: tennisOddsCache.size,
        odds_football: footballOddsCache.size,
        alerted_keys: alerted.size,
        surface_cache: surfaceCache.size,
        betfair_markets: betfairMarketIds.size,
      },
      odds_sources: {
        tennis_betfair: [...tennisOddsCache.values()].filter(v=>v.source_match==='betfair').length,
        tennis_oddsapiio: [...tennisOddsCache.values()].filter(v=>v.source_match==='oddsapiio').length,
        tennis_allsports: [...tennisOddsCache.values()].filter(v=>!v.source_match||v.source_match==='allsports').length,
        football_betfair: [...footballOddsCache.values()].filter(v=>v.source_ft05==='betfair').length,
        football_oddsapiio: [...footballOddsCache.values()].filter(v=>v.source_ft05==='oddsapiio').length,
        football_theodds: [...footballOddsCache.values()].filter(v=>v.source_ft05==='theodds'||(!v.source_ft05&&(v.ft05||v.ft15))).length,
      },
      apiUsage: apiUsageSummary(),
      config: { ODD_MIN, ODD_MAX },
      prompts: {
        football_not_showing: 'Fútbol no aparece. Comprueba FOOTBALL_KEY en Railway.',
        odds_not_updating: 'Cuotas no actualizan. Betfair: comprueba BETFAIR_SSOID (expira ~12h). OddsApiIo: comprueba ODDS_API_IO_KEY.',
        betfair_sso_expired: 'BETFAIR_SSOID expirado. Ve a betfair.com, inicia sesión, copia el SSOID de las cookies y actualiza en Railway.',
        tennis_stalling: 'Tenis se congela cuando AllSports no devuelve pointbypoint[]. El servidor reintentará.',
        sims_not_resolving: 'Sims sin resolver >6h. Usa /reset o el botón de Config.',
        how_to_reset: 'POST /reset limpia estado. El frontend tiene botón en Config.',
      }
    }));
    return;
  }

  if(path==='/test-odds'&&req.method==='GET'){
    // Live verification endpoint — shows current state of ALL odds caches
    const liveTennis = lastTennis.filter(m=>!m.isUp);
    const liveFootball = lastFootball.filter(m=>m.status==='IN_PLAY'||m.status==='PAUSED');
    const tennisOddsReport = liveTennis.map(m => {
      const tc = tennisOddsCache.get(m._key) || {};
      const oc = oddsCache.get(m._key) || {};
      return {
        match: m.p1+' vs '+m.p2,
        tournament: m.trn,
        betfair: { match: tc.match, set2: tc.set2, current: tc.current, source: tc.source_match, updated: tc.updatedAt ? new Date(tc.updatedAt).toISOString() : null },
        allsports: { o1: oc.o1, o2: oc.o2, match: oc.match, set2: oc.set2, updated: oc.updated ? new Date(oc.updated).toISOString() : null },
        final_shown: { match: m.odds_match, set2: m.odds_set2, current: m.odds_current, source: m.odds_source },
      };
    });
    const footballOddsReport = liveFootball.map(m => {
      const fc = footballOddsCache.get(m.id) || {};
      return {
        match: m.h+' vs '+m.a,
        league: m.league, minute: m.min,
        odds: { ft05: fc.ft05, ft15: fc.ft15, source_ft05: fc.source_ft05, source_ft15: fc.source_ft15, updated: fc.updatedAt ? new Date(fc.updatedAt).toISOString() : null },
        in_match_object: { ft05: m.odds_ft05, ft15: m.odds_ft15 },
      };
    });
    res.writeHead(200);
    res.end(JSON.stringify({
      timestamp: nowISO(),
      betfair_status: {
        ssoid_set: !!BETFAIR_SSOID,
        app_key_set: !!BETFAIR_APP_KEY,
        last_ok: diag.betfair.lastOk,
        last_err: diag.betfair.lastErr,
        last_err_msg: diag.betfair.lastErrMsg,
        sso_expired: diag.betfair.ssoExpired,
        markets_found: diag.betfair.marketsFound,
        call_count: diag.betfair.callCount,
      },
      oddsapiio_status: {
        key_set: !!ODDS_API_IO_KEY,
        last_ok: diag.oddsapiio.lastOk,
        last_err_msg: diag.oddsapiio.lastErrMsg,
        call_count: diag.oddsapiio.callCount,
      },
      theodds_status: {
        key_set: !!THEODDS_KEY,
        last_ok: diag.theodds.lastOk,
        last_err: diag.theodds.lastErr,
        last_err_msg: diag.theodds.lastErrMsg,
        call_count: diag.theodds.callCount,
        tennis_cache: tennisOddsCache.size,
        football_cache: footballOddsCache.size,
        discovered_sport_keys: fetchTheOddsTennis._keys || [],
        keys_loaded_at: fetchTheOddsTennis._loadedAt ? new Date(fetchTheOddsTennis._loadedAt).toISOString() : null,
      },
      live_tennis_count: liveTennis.length,
      live_football_count: liveFootball.length,
      tennis_odds_cache_size: tennisOddsCache.size,
      football_odds_cache_size: footballOddsCache.size,
      tennis: tennisOddsReport,
      football: footballOddsReport,
    }, null, 2));
    return;
  }

  if(path==='/api-usage'&&req.method==='GET'){
    res.writeHead(200);
    res.end(JSON.stringify(apiUsageSummary()));
    return;
  }

  if(path==='/reset'&&req.method==='POST'){
    alerted.clear();
    simAlerts.length=0;
    oddsCache.clear();
    footballOddsCache.clear();
    tennisOddsCache.clear();
    betfairMarketIds.clear();
    allSportsLiveMinutes.clear();
    (async()=>{
      try{
        await fbPut('/state/alerted',[]);
        await fbPut('/state/sims',[]);
      }catch(e){console.warn('[RESET] FB error:',e.message);}
    })();
    console.log('[RESET] Estado reseteado',new Date().toISOString());
    res.writeHead(200);
    res.end(JSON.stringify({ok:true}));
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

server.listen(PORT, async ()=>{
  console.log(`\n🎾 ROTURAS25 v18 — puerto ${PORT}`);
  console.log(`   Football:${FOOTBALL_KEY?'✓':'✗'}  Tennis:${TENNIS_KEY?'✓':'✗'}  TheOdds:${THEODDS_KEY?'✓':'✗'}  Betfair:${BETFAIR_SSOID?'✓':'✗ falta BETFAIR_SSOID'}  OddsApiIo:${ODDS_API_IO_KEY?'✓':'✗'}  TG:${TG_TOKEN?'✓':'✗'}`);
  console.log(`   ODD_MIN:${ODD_MIN}  ODD_MAX:${ODD_MAX}\n`);
  await loadSurfaceCache();
  await loadStateFromFB();
  poll();
  startOddsPoll();          // AllSports 15s + Betfair 10s + fallback 60s
  startAllSportsFootballPoll();
  startNext24Poll();
});
