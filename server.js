const http  = require('http');
const https = require('https');

// ═══════════════════════════════════════════════════════════
// ROTURAS25 — SERVIDOR AUTÓNOMO v3
// ═══════════════════════════════════════════════════════════

const FOOTBALL_KEY = process.env.FOOTBALL_KEY || '';
const TENNIS_KEY   = process.env.TENNIS_KEY   || '';
const TG_TOKEN     = process.env.TG_TOKEN     || '8171273424:AAGMvAxhDnt-HSZSZi8DJeV0j6YEwhfHC5E';
const TG_CHAT      = process.env.TG_CHAT      || '6307700447';
const PORT         = process.env.PORT         || 3000;

const ODD_MIN = parseFloat(process.env.ODD_MIN || '1.20');
const ODD_MAX = parseFloat(process.env.ODD_MAX || '1.60');

// ── Estado en memoria ──
const alerted    = new Set();   // claves de alertas ya enviadas
let lastFootball = [];
let lastTennis   = [];
let allFootballForSim = [];  // incluye finalizados para resolver simulaciones
let lastUpdate   = null;
let stats        = { pollCount: 0, alertsSent: 0, errors: 0 };

// ── Simulador: registro de TODAS las alertas con resultado ──
// Estructura: { id, type, match, detail, alertedAt, resolved, outcome }
// outcome: null | 'WIN' | 'LOSS'
// Para tenis: monitoriza si fav ganó el set
// Para fútbol: monitoriza si hubo gol tras la alerta
const simAlerts = [];   // array, máx 500 entradas

// ── Para monitorizar resultados post-alerta ──
// clave → { setNum, favIs, scorePending }
const pendingResolution = new Map();

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
        catch(e) { reject(new Error('JSON parse: ' + data.slice(0, 120))); }
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
        path: `/bot${TG_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
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

// Detectar si un nombre de partido/torneo es de dobles
// AllSportsAPI incluye "Doubles" o "/" en los nombres de los jugadores (p.ej. "Smith/Jones")
function isDoubles(e) {
  const p1 = (e.event_first_player  || '').trim();
  const p2 = (e.event_second_player || '').trim();
  const lg = (e.league_name || '').toLowerCase();
  // Doubles si el nombre del jugador contiene "/" (dos apellidos)
  if (p1.includes('/') || p2.includes('/')) return true;
  // O si el torneo lo dice explícitamente
  if (lg.includes('double') || lg.includes('doble')) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════
// FOOTBALL
// ═══════════════════════════════════════════════════════════

function normF(m, code) {
  const shF = m.score?.fullTime?.home  ?? 0;
  const saF = m.score?.fullTime?.away  ?? 0;
  const shH = m.score?.halfTime?.home  ?? 0;
  const saH = m.score?.halfTime?.away  ?? 0;

  // football-data.org: m.minute es el minuto actual, m.injuryTime es tiempo añadido
  // En segunda parte a veces minute viene null — calculamos desde currentPeriodStartedAt
  let min = 0;
  if (m.status === 'PAUSED') {
    min = 45;
  } else if (m.status === 'IN_PLAY') {
    if (m.minute && m.minute > 0) {
      min = m.minute;
    } else if (m.currentPeriodStartedAt) {
      const elapsed = Math.floor((Date.now() - new Date(m.currentPeriodStartedAt).getTime()) / 60000);
      // Si hay medio tiempo, estamos en 2ª parte
      const hasHT = shH != null;
      min = hasHT ? Math.min(45 + elapsed, 90) : Math.min(elapsed, 45);
    }
  }

  return {
    id: 'fd_' + m.id,
    league: code === 'PD' ? 'LaLiga EA Sports' : 'Premier League',
    k:      code === 'PD' ? 'laliga' : 'premier',
    status: m.status,
    min,
    h:  m.homeTeam?.shortName || m.homeTeam?.name || '?',
    a:  m.awayTeam?.shortName || m.awayTeam?.name || '?',
    lh: shF, la: saF,
    g2: (shF - shH) + (saF - saH),
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
  // Guardamos todos para resolver alertas, pero solo mostramos los no finalizados
  const allMatches = [
    ...(pd.matches || []).map(m => normF(m, 'PD')),
    ...(pl.matches || []).map(m => normF(m, 'PL')),
  ];
  lastFootball = allMatches.filter(m => m.status !== 'FINISHED');
  // Para resolución del simulador también necesitamos los finalizados
  allFootballForSim = allMatches;
}

function checkFootballAlerts() {
  lastFootball.forEach(m => {
    if (m.status !== 'IN_PLAY' || !m.min) return;

    const k25 = '25_' + m.id;
    if (m.min >= 24 && m.min <= 31 && m.lh === 0 && m.la === 0 && !alerted.has(k25)) {
      alerted.add(k25);
      const sim = {
        id: k25, type: 'football_ht', match: `${m.h} vs ${m.a}`,
        detail: `${m.league} · Min.${m.min} · 0-0 → Gol 1ª parte`,
        alertedAt: nowISO(), resolved: false, outcome: null,
        // para resolución: necesitamos que al final del HT haya gol
        _matchId: m.id, _resolveOn: 'ht_goal',
        _scoreAtAlert: { lh: m.lh, la: m.la },
      };
      simAlerts.unshift(sim);
      if (simAlerts.length > 500) simAlerts.length = 500;
      sendTG(`⚽ ROTURAS25 — ALERTA GOLEADORA\n━━━━━━━━━━━━━━━━━━━━\n${m.h} vs ${m.a}\n📍 ${m.league}\n━━━━━━━━━━━━━━━━━━━━\n📊 Marcador: ${m.lh}-${m.la} · Min. ${m.min}\n⚡ 0-0 a punto de acabar la 1ª parte\n→ APOSTAR: Gol antes del descanso`);
    }

    const k67 = '67_' + m.id;
    if (m.min >= 66 && m.min <= 73 && m.g2 === 0 && !alerted.has(k67)) {
      alerted.add(k67);
      const sim = {
        id: k67, type: 'football_2h', match: `${m.h} vs ${m.a}`,
        detail: `${m.league} · Min.${m.min} · Sin gol 2ªP → Gol 2ª parte`,
        alertedAt: nowISO(), resolved: false, outcome: null,
        _matchId: m.id, _resolveOn: 'sh_goal',
        _scoreAtAlert: { lh: m.lh, la: m.la, g2: m.g2 },
      };
      simAlerts.unshift(sim);
      if (simAlerts.length > 500) simAlerts.length = 500;
      sendTG(`⚽ ROTURAS25 — ALERTA GOLEADORA\n━━━━━━━━━━━━━━━━━━━━\n${m.h} vs ${m.a}\n📍 ${m.league}\n━━━━━━━━━━━━━━━━━━━━\n📊 Marcador: ${m.lh}-${m.la} · Min. ${m.min}\n⚡ Sin gol en 2ª parte — se acaba el tiempo\n→ APOSTAR: Habrá gol en 2ª parte`);
    }
  });
}

// Resolver alertas de fútbol pendientes
function resolveFootballSims() {
  simAlerts.forEach(s => {
    if (s.resolved || !s._matchId) return;
    const m = allFootballForSim.find(x => x.id === 'fd_' + s._matchId);
    if (!m) return;

    if (s._resolveOn === 'ht_goal' && (m.status === 'PAUSED' || m.status === 'IN_PLAY' && m.min > 45 || m.status === 'FINISHED')) {
      const goalsAtHT = m.lh + m.la;  // tras el descanso o fin
      s.outcome  = goalsAtHT > 0 ? 'WIN' : 'LOSS';
      s.resolved = true;
      s.resolvedAt = nowISO();
      console.log(`[SIM] ${s.id} → ${s.outcome} (goles HT: ${goalsAtHT})`);
    }

    if (s._resolveOn === 'sh_goal' && m.status === 'FINISHED') {
      s.outcome  = m.g2 > 0 ? 'WIN' : 'LOSS';
      s.resolved = true;
      s.resolvedAt = nowISO();
      console.log(`[SIM] ${s.id} → ${s.outcome} (goles 2ªP: ${m.g2})`);
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
  const cat  = getCat((e.country_name || '') + ' ' + (e.league_name || ''));

  // ── Cuotas pre-match ──
  // live_odds solo existe cuando la API tiene mercado disponible para ese partido.
  // Si el partido empezó antes de que el servidor arrancara, puede que no haya cuotas.
  // Intentamos varias rutas del objeto según la versión de la API.
  const odds = e.live_odds || e.odds || [];
  let o1 = null, o2 = null;
  if (Array.isArray(odds) && odds.length > 0) {
    odds.forEach(o => {
      const t = (o.type || o.odd_type || '').toLowerCase();
      const v = parseFloat(o.value || o.odd_value || o.odd);
      if (isNaN(v) || v <= 1) return;
      if (['1','1/win','home','player 1','first player'].includes(t) && !o1) o1 = v;
      if (['2','2/win','away','player 2','second player'].includes(t) && !o2) o2 = v;
    });
    // Fallback: si el tipo no coincide, coge el primero y segundo con odds > 1
    if (!o1 && !o2) {
      const valid = odds.filter(o => parseFloat(o.value || o.odd_value || o.odd) > 1);
      if (valid[0]) o1 = parseFloat(valid[0].value || valid[0].odd_value || valid[0].odd);
      if (valid[1]) o2 = parseFloat(valid[1].value || valid[1].odd_value || valid[1].odd);
    }
  }

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

  // Point-by-point break detection
  const pbp       = e.pointbypoint || [];
  const curGames  = pbp.filter(g => g.set_number === 'Set ' + curSetNum);
  let lastBreak   = null;
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
    id: 'td_' + e.event_key, cat,
    trn: e.league_name || 'Torneo',
    p1:  e.event_first_player  || '?',
    p2:  e.event_second_player || '?',
    o1, o2, sets1, sets2, g1, g2,
    srv: e.event_serve === 'First Player' ? 1 : 2,
    curSetNum, lastBreak, pbpLen: pbp.length, mon,
    isUp: false,
    hasOdds: o1 != null || o2 != null,
  };
}

function normTUp(e) {
  const cat = getCat((e.country_name || '') + ' ' + (e.league_name || ''));

  // football-data Fixtures usa event_date + event_time pero a veces en UTC
  // Construimos la fecha de forma segura
  let dt;
  try {
    dt = new Date(`${e.event_date}T${(e.event_time || '00:00').replace(':','').length === 4 ? e.event_time : e.event_time || '00:00'}:00`);
    if (isNaN(dt.getTime())) dt = new Date();
  } catch { dt = new Date(); }

  // AllSportsAPI Fixtures: cuotas pueden venir en varios campos según la versión
  // Probamos todos los posibles
  const oddsArr = e.odds || e.live_odds || e['1x2_odds'] || [];
  let o1 = null, o2 = null;
  if (Array.isArray(oddsArr) && oddsArr.length > 0) {
    oddsArr.forEach(o => {
      const t = (o.type || o.odd_type || o.name || '').toLowerCase();
      const v = parseFloat(o.value || o.odd_value || o.odd || o.odd1 || 0);
      if (isNaN(v) || v <= 1) return;
      if (['1','1/win','home','player 1','first player','p1'].includes(t) && !o1) o1 = v;
      if (['2','2/win','away','player 2','second player','p2'].includes(t) && !o2) o2 = v;
    });
    // Fallback: primeros dos valores válidos
    if (!o1 && !o2) {
      const valid = oddsArr.filter(o => parseFloat(o.value || o.odd_value || o.odd || 0) > 1);
      if (valid[0]) o1 = parseFloat(valid[0].value || valid[0].odd_value || valid[0].odd);
      if (valid[1]) o2 = parseFloat(valid[1].value || valid[1].odd_value || valid[1].odd);
    }
  }

  const mon = (o1 != null && o1 >= ODD_MIN && o1 <= ODD_MAX) ||
              (o2 != null && o2 >= ODD_MIN && o2 <= ODD_MAX);

  // Jugadores: AllSportsAPI usa event_first_player / event_second_player en Fixtures
  const p1 = e.event_first_player  || e.home_team_name || e.player1 || '?';
  const p2 = e.event_second_player || e.away_team_name || e.player2 || '?';

  return {
    id: 'tdu_' + e.event_key, cat,
    trn: e.league_name || e.tournament_name || 'Torneo',
    p1, p2,
    o1, o2, mon, hasOdds: o1 != null || o2 != null,
    localT: dt.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' }),
    localD: dt.toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: '2-digit' }),
    isUp: true,
  };
}

async function fetchTennis() {
  if (!TENNIS_KEY) return [];
  const [lR, uR] = await Promise.allSettled([
    fetchJson(`https://apiv2.allsportsapi.com/tennis/?met=Livescore&APIkey=${TENNIS_KEY}`),
    fetchJson(`https://apiv2.allsportsapi.com/tennis/?met=Fixtures&APIkey=${TENNIS_KEY}&from=${todayStr()}&to=${tomorrowStr()}`),
  ]);

  // FILTRO INDIVIDUALES: excluir dobles
  const liveRaw = (lR.status === 'fulfilled' && lR.value.result) ? lR.value.result : [];
  const upRaw   = (uR.status === 'fulfilled' && uR.value.result) ? uR.value.result : [];

  // DEBUG: log estructura de cuotas en el primer partido upcoming
  const sample = upRaw.find(e => e.event_live === '0' && !isDoubles(e));
  if (sample) {
    console.log('[ODDS DEBUG] Keys del partido upcoming:', Object.keys(sample).filter(k => k.includes('odd') || k.includes('bet') || k.includes('market') || k.includes('1x2')));
    console.log('[ODDS DEBUG] odds:', JSON.stringify(sample.odds || sample.live_odds || sample.event_odds || 'ninguno').slice(0, 300));
    console.log('[ODDS DEBUG] Jugadores:', sample.event_first_player, 'vs', sample.event_second_player);
  }

  const live = liveRaw.filter(e => !isDoubles(e) && e.event_status !== 'Finished').map(normT);
  const up   = upRaw.filter(e => e.event_live === '0' && !isDoubles(e)).map(normTUp);

  lastTennis = [...live, ...up];
  return live;
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
    const rivName = favIs === 'First Player' ? m.p2 : m.p1;
    const favO    = favIs === 'First Player' ? m.o1 : m.o2;
    const rivO    = favIs === 'First Player' ? m.o2 : m.o1;
    const gFav    = favIs === 'First Player' ? m.lastBreak.gP1 : m.lastBreak.gP2;
    const gRiv    = favIs === 'First Player' ? m.lastBreak.gP2 : m.lastBreak.gP1;
    const setsP1  = m.sets1.filter((s,i) => s > (m.sets2[i]||0)).length;
    const setsP2  = m.sets2.filter((s,i) => s > (m.sets1[i]||0)).length;

    // Registrar en simulador
    const sim = {
      id: kb, type: 'tennis_break',
      match: `${m.p1} vs ${m.p2}`,
      detail: `${m.trn} [${m.cat.toUpperCase()}] · Set ${m.curSetNum}: ${m.lastBreak.gP1}–${m.lastBreak.gP2} · Fav: ${favName}`,
      alertedAt: nowISO(), resolved: false, outcome: null,
      _eventId: m.id,
      _setNum: m.curSetNum,
      _favIs: favIs,
      _setsP1atAlert: [...m.sets1],
      _setsP2atAlert: [...m.sets2],
    };
    simAlerts.unshift(sim);
    if (simAlerts.length > 500) simAlerts.length = 500;

    // Mensaje Telegram
    sendTG(
      `🎾 ROTURAS25 — ROTURA DE SAQUE\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `${m.trn} [${m.cat.toUpperCase()}]\n` +
      `\n` +
      `${m.p1} vs ${m.p2}\n` +
      `Sets: ${m.p1} ${setsP1}–${setsP2} ${m.p2}\n` +
      `Set ${m.curSetNum} actual: ${m.p1} ${m.lastBreak.gP1}–${m.lastBreak.gP2} ${m.p2}\n` +
      `\n` +
      `⚠️ Rotado: ${favName} (FAVORITO)\n` +
      `Va PERDIENDO el set ${m.curSetNum} por ${gFav}–${gRiv}\n` +
      `\n` +
      `💰 Cuotas pre-partido:\n` +
      `  ${favName}: ${favO != null ? favO + 'x ← FAVORITO' : 'n/d (partido ya en curso)'}\n` +
      `  ${rivName}: ${rivO != null ? rivO + 'x' : 'n/d'}\n` +
      `\n` +
      `→ APUESTA: ${favName} gana el set ${m.curSetNum}`
    );
  });
}

// Resolver alertas de tenis pendientes
// Sabemos el resultado del set cuando sets1/sets2 tienen una entrada más que en el momento de la alerta
function resolveTennisSims() {
  simAlerts.forEach(s => {
    if (s.resolved || s.type !== 'tennis_break') return;
    const m = lastTennis.find(x => x.id === s._eventId);
    if (!m || m.isUp) return;

    // El set se ha cerrado cuando sets1 tiene más entradas que en el momento de la alerta
    const setsNow = m.sets1.length;
    const setsAtAlert = s._setsP1atAlert.length;

    if (setsNow > setsAtAlert) {
      // El set alertado ya terminó: miramos el resultado en el índice correcto
      const setIdx = s._setNum - 1;
      const p1Won = m.sets1[setIdx] > m.sets2[setIdx];
      const favWon = s._favIs === 'First Player' ? p1Won : !p1Won;
      s.outcome    = favWon ? 'WIN' : 'LOSS';
      s.resolved   = true;
      s.resolvedAt = nowISO();
      console.log(`[SIM] ${s.id} → ${s.outcome} (set ${s._setNum}: P1=${m.sets1[setIdx]} P2=${m.sets2[setIdx]})`);

      // Notificar resultado por Telegram
      sendTG(
        `📊 RESULTADO SIMULADOR\n${s.match}\nSet ${s._setNum}: ${m.sets1[setIdx]}–${m.sets2[setIdx]}\nFavorito (${s._favIs === 'First Player' ? s.match.split(' vs ')[0] : s.match.split(' vs ')[1]?.trim()}): ${favWon ? '✅ GANÓ' : '❌ PERDIÓ'} el set`
      );
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
      football: lastFootball,
      tennis:   lastTennis,
      updated:  lastUpdate,
      alerted:  [...alerted],
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
      simCount: simAlerts.length,
    }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`\n🎾 Roturas25 SERVER v3 — puerto ${PORT}`);
  console.log(`   Football: ${FOOTBALL_KEY ? '✓' : '✗'} · Tennis: ${TENNIS_KEY ? '✓' : '✗'} · TG: ${TG_TOKEN ? '✓' : '✗'}`);
  console.log(`   Cuota fav: ${ODD_MIN}x – ${ODD_MAX}x · Filtro dobles: ON\n`);
  poll();
  setTimeout(() => sendTG('✅ Roturas25 v3 activo. Individuales únicamente. Simulador de alertas activado.'), 3000);
});
