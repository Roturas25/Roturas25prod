const http  = require('http');
const https = require('https');

// ═══════════════════════════════════════════════════════════
// ROTURAS25 — SERVIDOR AUTÓNOMO v4
// ═══════════════════════════════════════════════════════════

const FOOTBALL_KEY = process.env.FOOTBALL_KEY || '';
const TENNIS_KEY   = process.env.TENNIS_KEY   || '';
const TG_TOKEN     = process.env.TG_TOKEN     || '8171273424:AAGMvAxhDnt-HSZSZi8DJeV0j6YEwhfHC5E';
const TG_CHAT      = process.env.TG_CHAT      || '6307700447';
const PORT         = process.env.PORT         || 3000;

const ODD_MIN = parseFloat(process.env.ODD_MIN || '1.20');
const ODD_MAX = parseFloat(process.env.ODD_MAX || '1.60');

// ── Estado en memoria ──
const alerted         = new Set();
let   lastFootball    = [];
let   allFootballForSim = [];
let   lastTennis      = [];
let   lastUpdate      = null;
let   stats           = { pollCount: 0, alertsSent: 0, errors: 0 };
const simAlerts       = [];          // máx 500

// Caché de cuotas: eventKey → { o1, o2 }
// Se rellena con met=Odds y persiste mientras el servidor vive
const oddsCache       = new Map();

// ═══════════════════════════════════════════════════════════
// UTILIDADES
// ═══════════════════════════════════════════════════════════

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function sendTG(msg) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    const body = JSON.stringify({ chat_id: TG_CHAT, text: msg });
    await new Promise((res, rej) => {
      const req = https.request({
        hostname: 'api.telegram.org',
        path:     `/bot${TG_TOKEN}/sendMessage`,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, r => { r.resume(); r.on('end', res); });
      req.on('error', rej);
      req.write(body); req.end();
    });
    stats.alertsSent++;
  } catch(e) {
    console.error('[TG ERROR]', e.message);
  }
}

function todayStr()    { return new Date().toISOString().split('T')[0]; }
function tomorrowStr() { return new Date(Date.now() + 86400000).toISOString().split('T')[0]; }
function nowISO()      { return new Date().toISOString(); }

function hasLiveMatches() {
  return lastFootball.some(m => m.status === 'IN_PLAY' || m.status === 'PAUSED')
      || lastTennis.some(m => !m.isUp);
}

function isDoubles(e) {
  const p1 = (e.event_first_player  || '').trim();
  const p2 = (e.event_second_player || '').trim();
  const lg = (e.league_name || '').toLowerCase();
  if (p1.includes('/') || p2.includes('/')) return true;
  if (lg.includes('double') || lg.includes('doble')) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════
// CUOTAS — met=Odds de AllSportsAPI (estrategia bulk)
//
// Estructura de la respuesta (documentación oficial):
//   result[matchId]["Home/Away"]["Home"] = { bookmaker: "cuota", ... }
//   result[matchId]["Home/Away"]["Away"] = { bookmaker: "cuota", ... }
//
// Estrategia: 2 llamadas bulk por ciclo en vez de N individuales:
//   1. met=Odds&from=HOY&to=MAÑANA  → cuotas de partidos futuros y de hoy
//   2. met=Odds (sin fecha)          → cuotas de partidos en curso ahora
// Esto cubre TODO: upcoming, recién empezados y en curso.
// Cada llamada cuesta 1 request de la cuota de API.
// ═══════════════════════════════════════════════════════════

function buildOddsCache(oddsResult) {
  if (!oddsResult || typeof oddsResult !== 'object') return;
  Object.entries(oddsResult).forEach(([matchId, data]) => {
    if (oddsCache.has(matchId)) return; // no sobreescribir
    const hw = data['Home/Away'] || data['1X2'] || data['Match Winner'] || data['Winner'] || null;
    if (!hw) return;
    function median(obj) {
      if (!obj || typeof obj !== 'object') return null;
      const vals = Object.values(obj).map(v => parseFloat(v)).filter(v => !isNaN(v) && v > 1);
      if (!vals.length) return null;
      vals.sort((a, b) => a - b);
      return Math.round(vals[Math.floor(vals.length / 2)] * 100) / 100;
    }
    const o1 = median(hw['Home'] || hw['Player 1'] || hw['First Player']);
    const o2 = median(hw['Away'] || hw['Player 2'] || hw['Second Player']);
    if (o1 || o2) {
      oddsCache.set(matchId, { o1: o1 || null, o2: o2 || null });
    }
  });
}

async function fetchAllOdds() {
  if (!TENNIS_KEY) return;
  const t = todayStr(), tm = tomorrowStr();
  try {
    // Llamada 1: partidos de hoy y mañana (upcoming + que empiezan hoy)
    const r1 = await fetchJson(
      `https://apiv2.allsportsapi.com/tennis/?met=Odds&APIkey=${TENNIS_KEY}&from=${t}&to=${tm}`
    );
    if (r1.success && r1.result) {
      const before = oddsCache.size;
      buildOddsCache(r1.result);
      console.log(`[ODDS bulk hoy/mañana] ${oddsCache.size - before} nuevos partidos con cuotas (total caché: ${oddsCache.size})`);
    } else {
      console.log(`[ODDS bulk hoy/mañana] sin resultado:`, JSON.stringify(r1).slice(0, 100));
    }
  } catch(e) { console.warn('[ODDS bulk hoy/mañana] Error:', e.message); }

  try {
    // Llamada 2: partidos en curso ahora mismo (met=Odds sin fecha = live odds)
    const r2 = await fetchJson(
      `https://apiv2.allsportsapi.com/tennis/?met=Odds&APIkey=${TENNIS_KEY}`
    );
    if (r2.success && r2.result) {
      const before = oddsCache.size;
      buildOddsCache(r2.result);
      console.log(`[ODDS bulk live] ${oddsCache.size - before} nuevos partidos con cuotas (total caché: ${oddsCache.size})`);
    } else {
      console.log(`[ODDS bulk live] sin resultado:`, JSON.stringify(r2).slice(0, 100));
    }
  } catch(e) { console.warn('[ODDS bulk live] Error:', e.message); }
}

function getMatchOdds(e) {
  // Primero caché (resultado de met=Odds)
  const cached = oddsCache.get(String(e.event_key));
  if (cached) return cached;
  // Sin cuotas disponibles
  return { o1: null, o2: null };
}

// ═══════════════════════════════════════════════════════════
// FOOTBALL
// ═══════════════════════════════════════════════════════════

function normF(m, code) {
  const shF = m.score?.fullTime?.home  ?? 0;
  const saF = m.score?.fullTime?.away  ?? 0;
  const shH = m.score?.halfTime?.home  ?? null;
  const saH = m.score?.halfTime?.away  ?? null;

  // Minuto actual — football-data.org a veces devuelve null en 2ª parte
  let min = 0;
  if (m.status === 'PAUSED') {
    min = 45;
  } else if (m.status === 'IN_PLAY') {
    if (m.minute != null && m.minute > 0) {
      min = m.minute + (m.injuryTime || 0);
    } else if (m.currentPeriodStartedAt) {
      const elapsed = Math.floor((Date.now() - new Date(m.currentPeriodStartedAt).getTime()) / 60000);
      // Si ya hay datos de medio tiempo, estamos en 2ª parte
      const inSecondHalf = shH != null && shH >= 0;
      min = inSecondHalf ? Math.min(45 + elapsed, 90) : Math.min(elapsed, 45);
    }
  }

  // Goles en 2ª parte: fullTime - halfTime
  const g2 = shH != null
    ? Math.max(0, (shF - shH) + (saF - saH))
    : 0;

  return {
    id:     'fd_' + m.id,
    league: code === 'PD' ? 'LaLiga EA Sports' : 'Premier League',
    k:      code === 'PD' ? 'laliga' : 'premier',
    status: m.status,
    min,
    h:  m.homeTeam?.shortName || m.homeTeam?.name || '?',
    a:  m.awayTeam?.shortName || m.awayTeam?.name || '?',
    hc: m.homeTeam?.crest || null,
    ac: m.awayTeam?.crest || null,
    lh: shF, la: saF,
    lhH: shH, laH: saH,   // marcador al descanso
    g2,
    utcDate: m.utcDate,
    a25: alerted.has('25_fd_' + m.id),
    a67: alerted.has('67_fd_' + m.id),
  };
}

async function fetchFootball() {
  if (!FOOTBALL_KEY) return;
  const t = todayStr(), tm = tomorrowStr();
  const [pd, pl] = await Promise.all([
    fetchJson(`https://api.football-data.org/v4/competitions/PD/matches?dateFrom=${t}&dateTo=${tm}`, { 'X-Auth-Token': FOOTBALL_KEY }),
    fetchJson(`https://api.football-data.org/v4/competitions/PL/matches?dateFrom=${t}&dateTo=${tm}`, { 'X-Auth-Token': FOOTBALL_KEY }),
  ]);
  const all = [
    ...(pd.matches || []).map(m => normF(m, 'PD')),
    ...(pl.matches || []).map(m => normF(m, 'PL')),
  ];
  allFootballForSim = all;
  // Para mostrar: excluimos los finalizados
  lastFootball = all.filter(m => m.status !== 'FINISHED');
}

function checkFootballAlerts() {
  lastFootball.forEach(m => {
    if (m.status !== 'IN_PLAY' || !m.min) return;

    // Alerta min.24-31: partido 0-0 en primera parte
    const k25 = '25_' + m.id;
    if (m.min >= 24 && m.min <= 31 && m.lh === 0 && m.la === 0 && !alerted.has(k25)) {
      alerted.add(k25);
      const sim = {
        id: k25, type: 'football_ht', match: `${m.h} vs ${m.a}`,
        detail: `${m.league} · Min.${m.min} · 0-0 → Gol 1ª parte`,
        alertedAt: nowISO(), resolved: false, outcome: null,
        _matchId: m.id, _resolveOn: 'ht_goal',
      };
      simAlerts.unshift(sim);
      if (simAlerts.length > 500) simAlerts.length = 500;
      sendTG(`⚽ ROTURAS25 — FÚTBOL ALERTA\n${m.league}\n${m.h} vs ${m.a}\n⏱ Min.${m.min} · Marcador: 0-0\n→ APOSTAR: Habrá gol en 1ª parte`);
    }

    // Alerta min.66-73: 2ª parte sin goles (lhH/laH son los goles del descanso)
    const k67 = '67_' + m.id;
    if (m.min >= 66 && m.min <= 73 && m.g2 === 0 && !alerted.has(k67)) {
      alerted.add(k67);
      const sim = {
        id: k67, type: 'football_2h', match: `${m.h} vs ${m.a}`,
        detail: `${m.league} · Min.${m.min} · Sin gol en 2ª parte → Gol 2ª parte`,
        alertedAt: nowISO(), resolved: false, outcome: null,
        _matchId: m.id, _resolveOn: 'sh_goal',
      };
      simAlerts.unshift(sim);
      if (simAlerts.length > 500) simAlerts.length = 500;
      sendTG(`⚽ ROTURAS25 — FÚTBOL ALERTA\n${m.league}\n${m.h} vs ${m.a}\n⏱ Min.${m.min} · Sin gol en 2ª parte (total: ${m.lh}-${m.la})\n→ APOSTAR: Habrá gol en 2ª parte`);
    }
  });
}

function resolveFootballSims() {
  simAlerts.forEach(s => {
    if (s.resolved || !s._matchId) return;
    const m = allFootballForSim.find(x => x.id === 'fd_' + s._matchId);
    if (!m) return;

    if (s._resolveOn === 'ht_goal' && (m.status === 'PAUSED' || m.status === 'FINISHED' || (m.status === 'IN_PLAY' && m.min > 45))) {
      const goalsAtHT = (m.lhH || 0) + (m.laH || 0);
      s.outcome = goalsAtHT > 0 ? 'WIN' : 'LOSS';
      s.resolved = true; s.resolvedAt = nowISO();
    }

    if (s._resolveOn === 'sh_goal' && m.status === 'FINISHED') {
      s.outcome = m.g2 > 0 ? 'WIN' : 'LOSS';
      s.resolved = true; s.resolvedAt = nowISO();
    }
  });
}

// ═══════════════════════════════════════════════════════════
// TENNIS
// ═══════════════════════════════════════════════════════════

function getCat(s) {
  const l = (s || '').toLowerCase();
  if (l.includes('itf'))                        return 'itf';
  if (l.includes('125') || l.includes('w125')) return 'wta125';
  if (l.includes('wta'))                        return 'wta';
  if (l.includes('challenger'))                 return 'challenger';
  return 'atp';
}

function normT(e) {
  const cat = getCat((e.country_name || '') + ' ' + (e.league_name || ''));

  // Cuotas: primero caché (set por met=Odds), luego intento live_odds
  const { o1, o2 } = getMatchOdds(e);

  const scores = e.scores || [];
  const sets1 = [], sets2 = [];
  scores.forEach(s => {
    sets1.push(parseInt(s.score_first)  || 0);
    sets2.push(parseInt(s.score_second) || 0);
  });
  const gr  = (e.event_game_result || '0 - 0').split(' - ');
  const g1  = (gr[0] || '0').trim();
  const g2  = (gr[1] || '0').trim();
  const curSetNum = scores.length + 1;

  const pbp      = e.pointbypoint || [];
  const curGames = pbp.filter(g => g.set_number === 'Set ' + curSetNum);
  let lastBreak  = null;
  if (curGames.length > 0) {
    const last = curGames[curGames.length - 1];
    if (last && last.serve_lost != null && last.serve_lost !== '') {
      const sp = (last.score || '').split(' - ');
      lastBreak = {
        setLabel: last.set_number,
        gameNum:  last.number_game,
        broken:   last.serve_lost,
        gP1:      parseInt(sp[0]) || 0,
        gP2:      parseInt(sp[1]) || 0,
      };
    }
  }

  const mon = (o1 != null && o1 >= ODD_MIN && o1 <= ODD_MAX) ||
              (o2 != null && o2 >= ODD_MIN && o2 <= ODD_MAX);

  return {
    id: 'td_' + e.event_key,
    _key: String(e.event_key),
    cat,
    trn:  e.league_name || 'Torneo',
    p1:   e.event_first_player  || '?',
    p2:   e.event_second_player || '?',
    o1, o2, sets1, sets2, g1, g2,
    srv: e.event_serve === 'First Player' ? 1 : 2,
    curSetNum, lastBreak, pbpLen: pbp.length, mon,
    isUp: false,
    hasOdds: o1 != null || o2 != null,
  };
}

function normTUp(e) {
  const cat = getCat((e.country_name || '') + ' ' + (e.league_name || ''));
  let dt;
  try { dt = new Date(`${e.event_date}T${e.event_time || '00:00'}:00`); }
  catch { dt = new Date(); }
  if (isNaN(dt.getTime())) dt = new Date();

  const { o1, o2 } = getMatchOdds(e);
  const mon = (o1 != null && o1 >= ODD_MIN && o1 <= ODD_MAX) ||
              (o2 != null && o2 >= ODD_MIN && o2 <= ODD_MAX);

  return {
    id: 'tdu_' + e.event_key,
    _key: String(e.event_key),
    cat,
    trn: e.league_name || 'Torneo',
    p1:  e.event_first_player  || '?',
    p2:  e.event_second_player || '?',
    o1, o2, mon, hasOdds: o1 != null || o2 != null,
    localT: dt.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' }),
    localD: dt.toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: '2-digit' }),
    _ts: dt.getTime(),
    isUp: true,
  };
}

async function fetchTennis() {
  if (!TENNIS_KEY) return [];

  // Paso 1: cuotas bulk PRIMERO — 2 llamadas cubren todos los partidos del día
  // Cuotas disponibles en caché ANTES de normalizar, incluso para partidos ya en curso
  await fetchAllOdds();

  // Paso 2: livescore + fixtures en paralelo
  const [lR, uR] = await Promise.allSettled([
    fetchJson(`https://apiv2.allsportsapi.com/tennis/?met=Livescore&APIkey=${TENNIS_KEY}`),
    fetchJson(`https://apiv2.allsportsapi.com/tennis/?met=Fixtures&APIkey=${TENNIS_KEY}&from=${todayStr()}&to=${tomorrowStr()}`),
  ]);

  const liveRaw = (lR.status === 'fulfilled' && lR.value.result) ? lR.value.result : [];
  const upRaw   = (uR.status === 'fulfilled' && uR.value.result) ? uR.value.result : [];

  const liveSingles = liveRaw.filter(e => !isDoubles(e) && e.event_status !== 'Finished');
  const upSingles   = upRaw.filter(e => e.event_live === '0' && !isDoubles(e));

  // Normalizar — cuotas ya en caché
  const live = liveSingles.map(normT);
  const up   = upSingles.map(normTUp);

  // Live: solo monitorizados (fav en rango) | Upcoming: todos
  const liveFiltered = live.filter(m => m.mon);
  lastTennis = [...liveFiltered, ...up];

  console.log('[TENNIS] Live: ' + live.length + ' singles, ' + liveFiltered.length + ' mon | Upcoming: ' + up.length + ' | Odds cache: ' + oddsCache.size);
  return liveFiltered;
}

function isBreakAlert(m) {
  if (!m.lastBreak || m.isUp) return false;
  let favIs = null;
  if (m.o1 != null && m.o1 >= ODD_MIN && m.o1 <= ODD_MAX)      favIs = 'First Player';
  else if (m.o2 != null && m.o2 >= ODD_MIN && m.o2 <= ODD_MAX) favIs = 'Second Player';
  else return false;
  if (m.lastBreak.broken !== favIs) return false;
  const favG = favIs === 'First Player' ? m.lastBreak.gP1 : m.lastBreak.gP2;
  const rivG = favIs === 'First Player' ? m.lastBreak.gP2 : m.lastBreak.gP1;
  return rivG > favG;
}

function checkTennisAlerts(live) {
  live.forEach(m => {
    if (!isBreakAlert(m)) return;
    const kb = `brk_${m.id}_${m.lastBreak.setLabel}_${m.lastBreak.gameNum}`;
    if (alerted.has(kb)) return;
    alerted.add(kb);

    const favIs   = (m.o1 != null && m.o1 >= ODD_MIN && m.o1 <= ODD_MAX) ? 'First Player' : 'Second Player';
    const favName = favIs === 'First Player' ? m.p1 : m.p2;
    const favO    = favIs === 'First Player' ? m.o1  : m.o2;

    const sim = {
      id: kb, type: 'tennis_break', match: `${m.p1} vs ${m.p2}`,
      detail: `${m.trn} [${m.cat.toUpperCase()}] · Set ${m.curSetNum}: ${m.lastBreak.gP1}–${m.lastBreak.gP2} · Fav: ${favName}`,
      alertedAt: nowISO(), resolved: false, outcome: null,
      _eventId: m.id, _setNum: m.curSetNum, _favIs: favIs,
      _setsP1atAlert: [...m.sets1], _setsP2atAlert: [...m.sets2],
    };
    simAlerts.unshift(sim);
    if (simAlerts.length > 500) simAlerts.length = 500;

    const setsStr  = m.sets1.map((s,i) => `${s}-${m.sets2[i]}`).join(' · ');
    const totalStr = setsStr ? `Sets: ${setsStr}  |  Set actual: ${m.g1}-${m.g2}` : `Marcador: ${m.g1}-${m.g2}`;

    sendTG(
      `🎾 ROTURAS25 — ROTURA DE SAQUE\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `${m.p1} vs ${m.p2}\n` +
      `📍 ${m.trn} [${m.cat.toUpperCase()}]\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 ${totalStr}\n` +
      `⚡ ${favName} ha sido ROTADO en Set ${m.curSetNum}\n` +
      `   Juegos en el set: ${m.p1} ${m.lastBreak.gP1} – ${m.lastBreak.gP2} ${m.p2}\n` +
      `   ${favName} va PERDIENDO el set\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `⭐ FAVORITO: ${favName}\n` +
      `   Cuota apertura: ${favO != null ? favO + 'x' : 'n/d'}\n` +
      `   Cuotas: ${m.p1} ${m.o1 != null ? m.o1 + 'x' : 'n/d'} | ${m.p2} ${m.o2 != null ? m.o2 + 'x' : 'n/d'}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `→ APOSTAR que ${favName} gana el Set ${m.curSetNum}`
    );
  });
}

function resolveTennisSims() {
  simAlerts.forEach(s => {
    if (s.resolved || s.type !== 'tennis_break') return;
    const m = lastTennis.find(x => x.id === s._eventId);
    if (!m || m.isUp) return;
    if (m.sets1.length > s._setsP1atAlert.length) {
      const setIdx = s._setNum - 1;
      const p1Won  = m.sets1[setIdx] > m.sets2[setIdx];
      const favWon = s._favIs === 'First Player' ? p1Won : !p1Won;
      s.outcome = favWon ? 'WIN' : 'LOSS';
      s.resolved = true; s.resolvedAt = nowISO();
      const favName = s._favIs === 'First Player' ? s.match.split(' vs ')[0] : s.match.split(' vs ')[1]?.trim();
      sendTG(`📊 RESULTADO SIM · ${s.match}\nSet ${s._setNum}: ${m.sets1[setIdx]}-${m.sets2[setIdx]}\n${favName}: ${favWon ? '✅ GANÓ' : '❌ PERDIÓ'} el set`);
    }
  });
}

// ═══════════════════════════════════════════════════════════
// POLLING
// ═══════════════════════════════════════════════════════════

let pollTimeout = null;

async function poll() {
  try {
    stats.pollCount++;
    const live = await fetchTennis().catch(e => { console.error('[TENNIS]', e.message); return []; });
    await fetchFootball().catch(e => console.error('[FOOTBALL]', e.message));

    checkTennisAlerts(live || []);
    checkFootballAlerts();
    resolveTennisSims();
    resolveFootballSims();
    lastUpdate = new Date().toISOString();
    if (stats.pollCount % 20 === 0) {
      console.log(`[POLL #${stats.pollCount}] Tennis live: ${lastTennis.filter(m=>!m.isUp).length} · Football live: ${lastFootball.filter(m=>m.status==='IN_PLAY'||m.status==='PAUSED').length} · Odds cache: ${oddsCache.size}`);
    }
  } catch(e) {
    stats.errors++;
    console.error('[POLL ERROR]', e.message);
  }

  const delay = hasLiveMatches() ? 45 * 1000 : 3 * 60 * 1000;
  pollTimeout = setTimeout(poll, delay);
}

// ═══════════════════════════════════════════════════════════
// HTTP SERVER
// ═══════════════════════════════════════════════════════════

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const path = new URL(req.url, 'http://localhost').pathname;

  if (path === '/data') {
    res.writeHead(200);
    res.end(JSON.stringify({
      football:  lastFootball,
      tennis:    lastTennis,
      updated:   lastUpdate,
      alerted:   [...alerted],
      simAlerts: simAlerts.slice(0, 200),
    }));
    return;
  }

  if (path === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({
      ok: true,
      football: !!FOOTBALL_KEY, tennis: !!TENNIS_KEY, telegram: !!TG_TOKEN,
      oddMin: ODD_MIN, oddMax: ODD_MAX,
      updated: lastUpdate, stats,
      liveFootball: lastFootball.filter(m => m.status === 'IN_PLAY' || m.status === 'PAUSED').length,
      liveTennis:   lastTennis.filter(m => !m.isUp).length,
      oddsCache:    oddsCache.size,
      simCount:     simAlerts.length,
    }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`\n🎾 Roturas25 SERVER v4 — puerto ${PORT}`);
  console.log(`   Football: ${FOOTBALL_KEY ? '✓' : '✗'} · Tennis: ${TENNIS_KEY ? '✓' : '✗'} · TG: ${TG_TOKEN ? '✓' : '✗'}`);
  console.log(`   Cuota fav: ${ODD_MIN}x – ${ODD_MAX}x · Filtro dobles: ON · Odds: met=Odds endpoint\n`);
  poll();
  setTimeout(() => sendTG('✅ Roturas25 v4 activo. Cuotas via met=Odds (pre-partido real). Solo partidos monitorizados.'), 3000);
});
