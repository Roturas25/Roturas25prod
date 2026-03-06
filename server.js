const http  = require('http');
const https = require('https');

// ═══════════════════════════════════════════════════════════
// ROTURAS25 — SERVIDOR AUTÓNOMO
// El servidor hace el polling y envía alertas a Telegram.
// La app HTML solo sirve para consultar y registrar apuestas.
// ═══════════════════════════════════════════════════════════

const FOOTBALL_KEY = process.env.FOOTBALL_KEY || '';
const TENNIS_KEY   = process.env.TENNIS_KEY   || '';
const TG_TOKEN     = process.env.TG_TOKEN     || '8171273424:AAGMvAxhDnt-HSZSZi8DJeV0j6YEwhfHC5E';
const TG_CHAT      = process.env.TG_CHAT      || '6307700447';
const PORT         = process.env.PORT         || 3000;

// Cuota fav mín/máx (ajustable via variables de entorno)
const ODD_MIN = parseFloat(process.env.ODD_MIN || '1.20');
const ODD_MAX = parseFloat(process.env.ODD_MAX || '1.60');

// ── Alertas ya enviadas (evita duplicados en memoria) ──
const alerted = new Set();

// ── Estado en memoria para que la app pueda consultar ──
let lastFootball = [];
let lastTennis   = [];
let lastUpdate   = null;
let stats = { pollCount: 0, alertsSent: 0, errors: 0 };

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
    console.log('[TG]', msg.slice(0, 80));
  } catch(e) {
    console.error('[TG ERROR]', e.message);
  }
}

function todayStr() { return new Date().toISOString().split('T')[0]; }
function tomorrowStr() { return new Date(Date.now() + 86400000).toISOString().split('T')[0]; }

// ¿Hay partidos en juego ahora mismo?
function hasLiveMatches() {
  const liveF = lastFootball.some(m => m.status === 'IN_PLAY' || m.status === 'PAUSED');
  const liveT = lastTennis.some(m => !m.isUp);
  return liveF || liveT;
}

// ═══════════════════════════════════════════════════════════
// FOOTBALL
// ═══════════════════════════════════════════════════════════

function normF(m, code) {
  const shF = m.score?.fullTime?.home  ?? 0;
  const saF = m.score?.fullTime?.away  ?? 0;
  const shH = m.score?.halfTime?.home  ?? 0;
  const saH = m.score?.halfTime?.away  ?? 0;
  return {
    id: 'fd_' + m.id,
    league: code === 'PD' ? 'LaLiga EA Sports' : 'Premier League',
    k: code === 'PD' ? 'laliga' : 'premier',
    status: m.status,
    min: m.minute || (m.status === 'PAUSED' ? 45 : 0),
    h: m.homeTeam?.shortName || m.homeTeam?.name || '?',
    a: m.awayTeam?.shortName || m.awayTeam?.name || '?',
    lh: shF, la: saF,
    g2: (shF - shH) + (saF - saH),
    utcDate: m.utcDate,
  };
}

async function fetchFootball() {
  if (!FOOTBALL_KEY) return;
  const t = todayStr(), tm = tomorrowStr();
  const [pd, pl] = await Promise.all([
    fetchJson(`https://api.football-data.org/v4/competitions/PD/matches?dateFrom=${t}&dateTo=${tm}`, { 'X-Auth-Token': FOOTBALL_KEY }),
    fetchJson(`https://api.football-data.org/v4/competitions/PL/matches?dateFrom=${t}&dateTo=${tm}`, { 'X-Auth-Token': FOOTBALL_KEY }),
  ]);
  lastFootball = [
    ...(pd.matches || []).map(m => normF(m, 'PD')),
    ...(pl.matches || []).map(m => normF(m, 'PL')),
  ];
}

function checkFootballAlerts() {
  lastFootball.forEach(m => {
    if (m.status !== 'IN_PLAY' || !m.min) return;

    const k25 = '25_' + m.id;
    if (m.min >= 24 && m.min <= 31 && m.lh === 0 && m.la === 0 && !alerted.has(k25)) {
      alerted.add(k25);
      sendTG(`⚽ ROTURAS25 — FÚTBOL ALERTA\n${m.league}\n${m.h} vs ${m.a}\n⏱ Min.${m.min} · Marcador: 0-0\n→ APOSTAR: Habrá gol en 1ª parte`);
    }

    const k67 = '67_' + m.id;
    if (m.min >= 66 && m.min <= 73 && m.g2 === 0 && !alerted.has(k67)) {
      alerted.add(k67);
      sendTG(`⚽ ROTURAS25 — FÚTBOL ALERTA\n${m.league}\n${m.h} vs ${m.a}\n⏱ Min.${m.min} · Sin gol en 2ª parte\n→ APOSTAR: Habrá gol en 2ª parte`);
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
  const odds = e.live_odds || [];
  let o1 = null, o2 = null;
  odds.forEach(o => {
    const t = (o.type || '').toLowerCase(), v = parseFloat(o.value);
    if (isNaN(v) || v <= 1) return;
    if (['1','1/win','home'].includes(t) && !o1) o1 = v;
    if (['2','2/win','away'].includes(t) && !o2) o2 = v;
  });
  // fallback
  if (!o1 && !o2) {
    const wm = odds.find(o => (o.odd_name || '').toLowerCase().includes('winner'));
    if (wm) {
      const a = odds.filter(o => (o.type || '').includes('1'));
      const b = odds.filter(o => (o.type || '').includes('2'));
      if (a[0]) o1 = parseFloat(a[0].value) || null;
      if (b[0]) o2 = parseFloat(b[0].value) || null;
    }
  }

  const scores = e.scores || [];
  const sets1 = [], sets2 = [];
  scores.forEach(s => { sets1.push(parseInt(s.score_first)||0); sets2.push(parseInt(s.score_second)||0); });
  const gr = (e.event_game_result || '0 - 0').split(' - ');
  const g1 = (gr[0] || '0').trim(), g2 = (gr[1] || '0').trim();
  const curSetNum = scores.length + 1;

  // Point-by-point break detection
  const pbp = e.pointbypoint || [];
  const curGames = pbp.filter(g => g.set_number === 'Set ' + curSetNum);
  let lastBreak = null;
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
    p1: e.event_first_player  || '?',
    p2: e.event_second_player || '?',
    o1, o2, sets1, sets2, g1, g2,
    srv: e.event_serve === 'First Player' ? 1 : 2,
    curSetNum, lastBreak, pbpLen: pbp.length, mon,
    isUp: false,
  };
}

function normTUp(e) {
  const cat = getCat((e.country_name || '') + ' ' + (e.league_name || ''));
  const dt  = new Date(`${e.event_date}T${e.event_time || '00:00'}:00`);
  return {
    id: 'tdu_' + e.event_key, cat,
    trn: e.league_name || 'Torneo',
    p1: e.event_first_player  || '?',
    p2: e.event_second_player || '?',
    o1: null, o2: null, mon: false,
    localT: dt.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' }),
    localD: dt.toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: '2-digit' }),
    isUp: true,
  };
}

async function fetchTennis() {
  if (!TENNIS_KEY) return;
  const [lR, uR] = await Promise.allSettled([
    fetchJson(`https://apiv2.allsportsapi.com/tennis/?met=Livescore&APIkey=${TENNIS_KEY}`),
    fetchJson(`https://apiv2.allsportsapi.com/tennis/?met=Fixtures&APIkey=${TENNIS_KEY}&from=${todayStr()}&to=${tomorrowStr()}`),
  ]);
  const live = (lR.status === 'fulfilled' && lR.value.result) ? lR.value.result.map(normT) : [];
  const up   = (uR.status === 'fulfilled' && uR.value.result) ? uR.value.result.filter(e => e.event_live === '0').map(normTUp) : [];
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
  return rivG > favG; // rival strictly more games after break
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

    sendTG(
      `🎾 ROTURAS25 — ROTURA\n` +
      `${m.p1} vs ${m.p2}\n` +
      `${m.trn} [${m.cat.toUpperCase()}]\n` +
      `⚠ ${favName} ROTADO · cuota pre-match: ${favO}x\n` +
      `Set ${m.curSetNum}: ${m.p1} ${m.lastBreak.gP1}–${m.lastBreak.gP2} ${m.p2}\n` +
      `${favName} va PERDIENDO el set\n` +
      `→ APOSTAR que ${favName} gana el set\n` +
      `Cuotas: P1=${m.o1 ?? 'n/d'}x  P2=${m.o2 ?? 'n/d'}x`
    );
  });
}

// ═══════════════════════════════════════════════════════════
// SMART POLLING — gestión automática de cuota de API
// ═══════════════════════════════════════════════════════════
// Horario de partidos en Europa: ~12:00–23:00 hora España
// Fuera de ese horario → poll cada 10 min (solo para no perder nada)
// Durante partidos → poll cada 45s
// Sin partidos live en horario activo → poll cada 2 min
//
// Consumo estimado (AllSportsAPI, 2 llamadas por ciclo de tenis):
//   Hora pico (45s): 2 × 80 ciclos/hora = 160 req/hora  ← dentro del límite 260
//   Hora normal (2min): 2 × 30 ciclos = 60 req/hora
//   Noche (10min): 2 × 6 ciclos = 12 req/hora
//
// Football-data.org: 1 llamada/ciclo, límite 10/min → no hay problema

let pollTimeout = null;

async function poll() {
  try {
    stats.pollCount++;
    const [, live] = await Promise.all([
      fetchFootball().catch(e => console.error('[FOOTBALL]', e.message)),
      fetchTennis().catch(e => { console.error('[TENNIS]', e.message); return []; }),
    ]);
    if (live) checkTennisAlerts(live);
    checkFootballAlerts();
    lastUpdate = new Date().toISOString();
  } catch(e) {
    stats.errors++;
    console.error('[POLL ERROR]', e.message);
  }

  // Decide next interval
  // Lógica: hay tenis 24h en todo el mundo, así que solo
  // bajamos la frecuencia cuando NO hay ningún partido en directo.
  let delay;
  if (hasLiveMatches()) {
    // Hay partidos en juego (fútbol o tenis): cada 45 segundos
    delay = 45 * 1000;
  } else {
    // Sin ningún partido live: cada 3 minutos (ahorra cuota)
    delay = 3 * 60 * 1000;
  }

  pollTimeout = setTimeout(poll, delay);
}

// ═══════════════════════════════════════════════════════════
// HTTP SERVER — la app consulta datos y registra apuestas
// ═══════════════════════════════════════════════════════════

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const path = new URL(req.url, `http://localhost`).pathname;

  if (path === '/data') {
    // Todo en una sola llamada: la app solo necesita esto
    res.writeHead(200);
    res.end(JSON.stringify({
      football: lastFootball,
      tennis:   lastTennis,
      updated:  lastUpdate,
      alerted:  [...alerted],
    }));
    return;
  }

  if (path === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({
      ok: true,
      football: !!FOOTBALL_KEY,
      tennis:   !!TENNIS_KEY,
      telegram: !!TG_TOKEN,
      updated:  lastUpdate,
      stats,
      liveFootball: lastFootball.filter(m => m.status === 'IN_PLAY' || m.status === 'PAUSED').length,
      liveTennis:   lastTennis.filter(m => !m.isUp).length,
      nextPollIn:   pollTimeout ? '~calculando' : 'detenido',
    }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`\n🎾 Roturas25 SERVER arrancado en puerto ${PORT}`);
  console.log(`   Football key: ${FOOTBALL_KEY ? '✓' : '✗ FALTA FOOTBALL_KEY'}`);
  console.log(`   Tennis key:   ${TENNIS_KEY   ? '✓' : '✗ FALTA TENNIS_KEY'}`);
  console.log(`   Telegram:     ${TG_TOKEN ? '✓' : '✗ FALTA TG_TOKEN'}`);
  console.log(`   Cuota fav:    ${ODD_MIN}x – ${ODD_MAX}x`);
  console.log(`   Iniciando primer poll...\n`);
  // Primer poll inmediato
  poll();
  // Enviar mensaje de inicio a Telegram
  setTimeout(() => sendTG('✅ Roturas25 servidor activo. Monitorizando LaLiga, Premier, ATP, WTA, ITF y Challenger. Las alertas llegarán aquí automáticamente.'), 3000);
});
