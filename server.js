const http  = require('http');
const https = require('https');

// ═══════════════════════════════════════════════════════════
// ROTURAS25 — SERVIDOR AUTÓNOMO v5
// ═══════════════════════════════════════════════════════════

// Evitar crash loop: capturar errores no manejados
process.on('uncaughtException',  e => console.error('[UNCAUGHT]', e.message, e.stack));
process.on('unhandledRejection', e => console.error('[UNHANDLED]', e));
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
  const shF = m.score?.fullTime?.home  ?? m.score?.home ?? 0;
  const saF = m.score?.fullTime?.away  ?? m.score?.away ?? 0;
  const shH = m.score?.halfTime?.home  ?? null;
  const saH = m.score?.halfTime?.away  ?? null;

  // Minuto actual — football-data.org plan gratuito no siempre da minute en tiempo real.
  // Estrategia: usar m.minute si viene, sino calcular desde utcDate (hora de inicio).
  let min = 0;
  if (m.status === 'PAUSED') {
    min = 45;
  } else if (m.status === 'IN_PLAY') {
    if (m.minute != null && m.minute > 0) {
      min = m.minute + (m.injuryTime || 0);
    } else {
      // Fallback: tiempo transcurrido desde el inicio del partido
      const startTs = m.utcDate ? new Date(m.utcDate).getTime() : 0;
      if (startTs > 0) {
        const elapsed = Math.floor((Date.now() - startTs) / 60000);
        // El partido tiene ~45min de 1ª parte + ~15min de descanso + 45min de 2ª parte
        // Si elapsed < 50 → 1ª parte (min real ≈ elapsed)
        // Si elapsed >= 50 y < 65 → descanso o inicio 2ª parte (min ≈ 45)
        // Si elapsed >= 65 → 2ª parte (min real ≈ 45 + (elapsed - 65) + margen)
        // Partido real: 45min 1ªP + ~15min descanso + 45min 2ªP
        // elapsed desde utcDate incluye el descanso
        if (elapsed <= 47) {
          min = elapsed;                            // 1ª parte
        } else if (elapsed <= 62) {
          min = 45;                                 // descanso / primeros segundos 2ªP
        } else {
          min = Math.min(45 + (elapsed - 62), 90); // 2ª parte
        }
      }
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
    lhLive: shF,  laLive: saF,  // marcador más actualizado disponible
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
    if (m.status !== 'IN_PLAY') return;
    // Una sola alerta por mitad. Genera 2 simAlerts:
    //   _05 → +0.5 goles (stake nominal 50€) WIN si ≥1 gol
    //   _15 → +1.5 goles (stake nominal 25€) WIN si ≥2 goles

    // ─── 1ª parte: min.22–38 ────────────────────────────────
    // Guardar snapshot al inicio del partido (min 1-8) para detectar cambios
    if (m.min >= 1 && m.min <= 8 && !kickoffSnapshot.has(m.id)) {
      kickoffSnapshot.set(m.id, { h: m.lhLive || 0, a: m.laLive || 0 });
    }

    // Detectar goles en 1ªP:
    // Método 1: la API devuelve score > 0 directamente (shF/saF)
    // Método 2: el marcador ha aumentado vs el snapshot inicial
    const liveGoals1h = (m.lhLive || 0) + (m.laLive || 0);
    const snap0 = kickoffSnapshot.get(m.id);
    const goalsVsKickoff = snap0 ? (liveGoals1h - snap0.h - snap0.a) : 0;
    const knownGoals1h = Math.max(liveGoals1h, goalsVsKickoff);
    const skip25 = knownGoals1h > 0;

    const k25 = '25_' + m.id;
    if (m.min >= 22 && m.min <= 38 && !alerted.has(k25) && !skip25) {
      alerted.add(k25);
      simAlerts.unshift({ id: k25+'_05', type:'football_ht_05', match:`${m.h} vs ${m.a}`,
        detail:`${m.league} · ~Min.${m.min} · 1ªP +0.5 goles (50€)`,
        alertedAt:nowISO(), resolved:false, outcome:null,
        _matchId:m.id.replace('fd_',''), _resolveOn:'ht_goal', _market:'+0.5', _nominalStake:50, _league:m.league, _half:1 });
      simAlerts.unshift({ id: k25+'_15', type:'football_ht_15', match:`${m.h} vs ${m.a}`,
        detail:`${m.league} · ~Min.${m.min} · 1ªP +1.5 goles (25€)`,
        alertedAt:nowISO(), resolved:false, outcome:null,
        _matchId:m.id.replace('fd_',''), _resolveOn:'ht_goal_15', _market:'+1.5', _nominalStake:25, _league:m.league, _half:1 });
      if (simAlerts.length > 500) simAlerts.length = 500;
      sendTG(
        `⚽ ROTURAS25 — FÚTBOL 1ª PARTE
` +
        `━━━━━━━━━━━━━━━━━━━━
` +
        `${m.league}
` +
        `${m.h} vs ${m.a}
` +
        `━━━━━━━━━━━━━━━━━━━━
` +
        `⏱ ~Min.${m.min}
` +
        `→ APUESTA 1: +0.5 goles 1ªP · 50€
` +
        `→ APUESTA 2: +1.5 goles 1ªP · 25€`
      );
    }

    // ─── 2ª parte: min.63–78 ────────────────────────────────
    // Guardar snapshot del marcador al inicio de 2ªP (cuando el partido
    // vuelve a IN_PLAY tras el descanso) para detectar si ya hubo gol.
    if (m.min >= 46 && m.min <= 50 && m.lhH != null && !htSnapshot.has(m.id)) {
      htSnapshot.set(m.id, { h: m.lhH, a: m.laH });
      console.log(`[HT SNAP] ${m.h} vs ${m.a} → HT: ${m.lhH}-${m.laH}`);
    }

    const k67 = '67_' + m.id;
    // Verificar goles en 2ªP: comparar marcador actual con snapshot HT
    // Si no hay snapshot (API no lo dio), asumimos sin gol (preferible a no alertar)
    const snap = htSnapshot.get(m.id);
    const goals2h = snap != null
      ? Math.max(0, ((m.lhLive||0) - snap.h) + ((m.laLive||0) - snap.a))  // goles desde el descanso
      : 0;  // sin info → asumir 0 para no perder la alerta
    if (m.min >= 63 && m.min <= 78 && !alerted.has(k67) && goals2h === 0) {
      alerted.add(k67);
      simAlerts.unshift({ id: k67+'_05', type:'football_2h_05', match:`${m.h} vs ${m.a}`,
        detail:`${m.league} · ~Min.${m.min} · 2ªP +0.5 goles (50€)`,
        alertedAt:nowISO(), resolved:false, outcome:null,
        _matchId:m.id.replace('fd_',''), _resolveOn:'sh_goal', _market:'+0.5', _nominalStake:50, _league:m.league, _half:2 });
      simAlerts.unshift({ id: k67+'_15', type:'football_2h_15', match:`${m.h} vs ${m.a}`,
        detail:`${m.league} · ~Min.${m.min} · 2ªP +1.5 goles (25€)`,
        alertedAt:nowISO(), resolved:false, outcome:null,
        _matchId:m.id.replace('fd_',''), _resolveOn:'sh_goal_15', _market:'+1.5', _nominalStake:25, _league:m.league, _half:2 });
      if (simAlerts.length > 500) simAlerts.length = 500;
      sendTG(
        `⚽ ROTURAS25 — FÚTBOL 2ª PARTE
` +
        `━━━━━━━━━━━━━━━━━━━━
` +
        `${m.league}
` +
        `${m.h} vs ${m.a}
` +
        `━━━━━━━━━━━━━━━━━━━━
` +
        `⏱ ~Min.${m.min}
` +
        `→ APUESTA 1: +0.5 goles 2ªP · 50€
` +
        `→ APUESTA 2: +1.5 goles 2ªP · 25€`
      );
    }
  });
}

function resolveFootballSims() {
  simAlerts.forEach(s => {
    if (s.resolved || !s._matchId) return;
    const m = allFootballForSim.find(x => x.id === 'fd_' + s._matchId);
    if (!m) return;

    // 1ª parte +0.5: WIN si ≥1 gol al descanso
    if (s._resolveOn === 'ht_goal' && (m.status === 'PAUSED' || m.status === 'FINISHED' || (m.status === 'IN_PLAY' && m.min > 45))) {
      const goalsAtHT = (m.lhH || 0) + (m.laH || 0);
      s.outcome = goalsAtHT >= 1 ? 'WIN' : 'LOSS';
      s.resolved = true; s.resolvedAt = nowISO();
    }
    // 1ª parte +1.5: WIN si ≥2 goles al descanso
    if (s._resolveOn === 'ht_goal_15' && (m.status === 'PAUSED' || m.status === 'FINISHED' || (m.status === 'IN_PLAY' && m.min > 45))) {
      const goalsAtHT = (m.lhH || 0) + (m.laH || 0);
      s.outcome = goalsAtHT >= 2 ? 'WIN' : 'LOSS';
      s.resolved = true; s.resolvedAt = nowISO();
    }
    // 2ª parte +0.5: WIN si ≥1 gol en 2ªP
    if (s._resolveOn === 'sh_goal' && m.status === 'FINISHED') {
      s.outcome = m.g2 >= 1 ? 'WIN' : 'LOSS';
      s.resolved = true; s.resolvedAt = nowISO();
    }
    // 2ª parte +1.5: WIN si ≥2 goles en 2ªP
    if (s._resolveOn === 'sh_goal_15' && m.status === 'FINISHED') {
      s.outcome = m.g2 >= 2 ? 'WIN' : 'LOSS';
      s.resolved = true; s.resolvedAt = nowISO();
    }
  });
}

// ═══════════════════════════════════════════════════════════
// TENNIS
// ═══════════════════════════════════════════════════════════

function getCat(s) {
  const l = (s || '').toLowerCase();
  if (l.includes('itf')) {
    // Distinguir ITF masculino (M) de femenino (F)
    // AllSportsAPI suele indicar "ITF Women", "ITF W", "W15", "W25", "W60", "W100"
    // o incluir "women" en country_name/league_name
    const isWomen = l.includes('women') || l.includes(' w ') || l.includes('/w/')
      || /\bitf w\d/i.test(s) || /\bw\d{1,3}\b/.test(s)
      || l.includes('wta') || l.includes('female') || l.includes('ladies');
    return isWomen ? 'itf_f' : 'itf_m';
  }
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
  // FIX: filtrar solo sets terminados — AllSportsAPI puede incluir el set en curso
  // en scores[] con marcador parcial, lo que haría curSetNum incorrecto.
  const completedScores = scores.filter(s => {
    const a = parseInt(s.score_first)  || 0;
    const b = parseInt(s.score_second) || 0;
    return (a >= 6 || b >= 6) && (Math.abs(a - b) >= 2 || a >= 7 || b >= 7);
  });
  completedScores.forEach(s => {
    sets1.push(parseInt(s.score_first)  || 0);
    sets2.push(parseInt(s.score_second) || 0);
  });
  const curSetNum = completedScores.length + 1;
  // Juegos del set actual: primero intentar event_first/second_player_score_current_set
  // (campos propios de AllSportsAPI), si no, derivar del último juego completo del pbp.
  // event_game_result = puntos del juego en curso ("40 - 15"), NO sirve para juegos del set.
  let cg1 = 0, cg2 = 0;
  const csRaw1 = parseInt(e.event_first_player_score_current_set);
  const csRaw2 = parseInt(e.event_second_player_score_current_set);
  if (!isNaN(csRaw1) && !isNaN(csRaw2)) {
    cg1 = csRaw1; cg2 = csRaw2;
  }
  // g1/g2 = juegos del set actual (para mostrar y para lógica de break)
  const g1 = String(cg1);
  const g2 = String(cg2);

  const pbp      = e.pointbypoint || [];
  const curGames = pbp.filter(g => g.set_number === 'Set ' + curSetNum);
  let lastBreak  = null;
  // FIX: escanear TODOS los juegos del set actual hacia atrás para encontrar
  // el último break. Si solo miramos el último juego y fue un hold, perdemos
  // la rotura que ocurrió en el juego anterior. Buscamos el último juego con
  // serve_lost distinto de null/vacío.
  for (let i = curGames.length - 1; i >= 0; i--) {
    const g = curGames[i];
    if (g && g.serve_lost != null && g.serve_lost !== '') {
      const sp = (g.score || '').split(' - ');
      lastBreak = {
        setLabel: g.set_number,
        gameNum:  String(g.number_game ?? i),
        broken:   g.serve_lost,
        gP1:      parseInt(sp[0]) || 0,
        gP2:      parseInt(sp[1]) || 0,
      };
      break;
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
    // cuota live en tiempo real del favorito para el modal de registro
    liveO1: o1, liveO2: o2,
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
  // CRÍTICO: solo alertar si el favorito está efectivamente PERDIENDO en juegos del set.
  // g1/g2 ahora son los juegos del set actual (extraídos de event_*_score_current_set).
  // Esto evita alertas cuando el rival solo ha igualado tras ir el fav por delante.
  const favG = favIs === 'First Player' ? parseInt(m.g1) : parseInt(m.g2);
  const rivG = favIs === 'First Player' ? parseInt(m.g2) : parseInt(m.g1);
  // rivG > favG: el rival lleva más juegos → el fav va perdiendo el set
  return rivG > favG;
}

// ─── Snapshot de marcador al descanso (para detectar goles en 2ªP) ──────────────
// htSnapshot: matchId → { h, a } guardado cuando vuelve de PAUSED (inicio 2ªP)
const htSnapshot = new Map();
// kickoffSnapshot: matchId → { h, a } guardado en los primeros minutos
// Si la API devuelve goles después, sabemos que ha habido gol en 1ªP
const kickoffSnapshot = new Map();

// ─── Rastreo de recuperaciones de break por partido+set ───────────────────────
// Estructura: breakRecoveries[matchId_setNum] = { alerted, favIs, broken_gameNum }
const breakRecoveries = new Map();

function checkBreakRecovery(live) {
  // Para cada partido en live que tiene una alerta de break previa en simAlerts:
  // detectar si el favorito ha recuperado el empate en el marcador del set.
  live.forEach(m => {
    const favIs = m.o1 != null && m.o1 >= ODD_MIN && m.o1 <= ODD_MAX
      ? 'First Player'
      : m.o2 != null && m.o2 >= ODD_MIN && m.o2 <= ODD_MAX
        ? 'Second Player'
        : null;
    if (!favIs) return;

    const favG = parseInt(favIs === 'First Player' ? m.g1 : m.g2) || 0;
    const rivG = parseInt(favIs === 'First Player' ? m.g2 : m.g1) || 0;
    const favName = favIs === 'First Player' ? m.p1 : m.p2;
    const favO    = favIs === 'First Player' ? m.o1 : m.o2;

    // Buscar si hay un simAlert de break activo para este partido+set
    const breakSim = simAlerts.find(s =>
      s.type === 'tennis_break' && !s.resolved
      && s._eventId === m.id && s._setNum === m.curSetNum
    );
    if (!breakSim) return;

    const rkKey = `${m.id}_s${m.curSetNum}`;

    // Registrar todas las roturas para el contador global (una sola vez por rkKey)
    if (!breakRecoveries.has(rkKey)) {
      breakRecoveries.set(rkKey, { recovered: false, alertedRecovery: false });
    }
    const rec = breakRecoveries.get(rkKey);

    // Si el fav ya ha igualado (favG === rivG, ambos > 0) y no hemos alertado recuperación
    if (favG > 0 && favG === rivG && !rec.alertedRecovery) {
      rec.alertedRecovery = true;
      rec.recovered = true;
      // Guardar en simAlerts como registro de recuperación
      const krec = `rec_${m.id}_s${m.curSetNum}_${favG}`;
      if (!alerted.has(krec)) {
        alerted.add(krec);
        const simRec = {
          id: krec, type: 'tennis_recovery', match: `${m.p1} vs ${m.p2}`,
          detail: `${m.trn} [${m.cat.toUpperCase()}] · Set ${m.curSetNum}: ${favG}-${rivG} empate · Fav: ${favName}`,
          alertedAt: nowISO(), resolved: true, outcome: 'RECOVERY',
          _eventId: m.id, _setNum: m.curSetNum, _favIs: favIs,
          _favO: favO, _oddsband: breakSim._oddsband,
        };
        simAlerts.unshift(simRec);
        if (simAlerts.length > 500) simAlerts.length = 500;

        const favO_ = favO != null ? favO + 'x' : 'n/d';
        sendTG(
          `🎾 ROTURAS25 — BREAK RECUPERADO\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `${m.p1} vs ${m.p2}\n` +
          `📍 ${m.trn} [${m.cat.toUpperCase()}]\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `✅ ${favName} ha RECUPERADO el break\n` +
          `   Marcador en Set ${m.curSetNum}: ${m.p1} ${m.g1}–${m.g2} ${m.p2}\n` +
          `⭐ Fav @ ${favO_}\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `→ El partido se ha igualado en el set`
        );
      }
    }

    // Si el marcador actual favorece al fav (favG > rivG) pero ya había igualado: reset para no volver a alertar
    // (si le vuelven a romper, se creará nuevo simAlert de break con nuevo gameNum)
    if (favG > rivG && rec.alertedRecovery) {
      rec.alertedRecovery = false; // reset por si hay otra rotura posterior
    }
  });
}

// ─── Alerta inicio de partido de fútbol ───────────────────────────────────────
function checkFootballStart() {
  lastFootball.forEach(m => {
    if (m.status !== 'IN_PLAY') return;
    const ks = `fstart_${m.id}`;
    if (alerted.has(ks)) return;
    alerted.add(ks);
    sendTG(
      `⚽ PARTIDO INICIADO — ${m.league}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `${m.h} vs ${m.a}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `→ Sigue el partido y prepara alertas de gol`
    );
  });
}

function checkMonitoredMatchStart() {
  // Alerta cuando un partido monitorizado pasa de upcoming a REALMENTE live
  // Condición extra: pbpLen>0 (primer punto jugado) para evitar falsos positivos
  // cuando AllSportsAPI mete el partido en livescore antes de que empiece de verdad.
  lastTennis.filter(m => !m.isUp && m.mon && m.pbpLen > 0).forEach(m => {
    const ks = `start_${m.id}`;
    if (alerted.has(ks)) return;
    alerted.add(ks);
    const favIs   = (m.o1 != null && m.o1 >= ODD_MIN && m.o1 <= ODD_MAX) ? 'First Player' : 'Second Player';
    const favName = favIs === 'First Player' ? m.p1 : m.p2;
    const favO    = favIs === 'First Player' ? m.o1  : m.o2;
    sendTG(
      `🎾 PARTIDO INICIADO — MONITORIZADO\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `${m.p1} vs ${m.p2}\n` +
      `📍 ${m.trn} [${m.cat.toUpperCase()}]\n` +
      `⭐ FAV: ${favName} @ ${favO != null ? favO + 'x' : 'n/d'}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `→ Monitorizando roturas de saque`
    );
  });
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

    const oddsband = favO == null ? 'n/d'
      : favO < 1.30 ? '1.20-1.30'
      : favO < 1.40 ? '1.30-1.40'
      : favO < 1.50 ? '1.40-1.50'
      : '1.50-1.60';

    const sim = {
      id: kb, type: 'tennis_break', match: `${m.p1} vs ${m.p2}`,
      detail: `${m.trn} [${m.cat.toUpperCase()}] · Set ${m.curSetNum}: ${m.lastBreak.gP1}–${m.lastBreak.gP2} · Fav ROTO: ${favName}`,
      alertedAt: nowISO(), resolved: false, outcome: null,
      _eventId: m.id, _setNum: m.curSetNum, _favIs: favIs,
      _setsP1atAlert: [...m.sets1], _setsP2atAlert: [...m.sets2],
      _favO: favO, _oddsband: oddsband, _cat: m.cat,
      _liveO1: m.o1, _liveO2: m.o2,  // cuotas en tiempo real al momento de la alerta
    };
    simAlerts.unshift(sim);
    if (simAlerts.length > 500) simAlerts.length = 500;

    const setsStr  = m.sets1.map((s,i) => `${s}-${m.sets2[i]}`).join(' · ');
    const totalStr = setsStr ? `Sets: ${setsStr}  |  Set actual: ${m.g1}-${m.g2}` : `Marcador: ${m.g1}-${m.g2}`;

    sendTG(
      `🎾 ROTURAS25 — SAQUE ROTO\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `${m.p1} vs ${m.p2}\n` +
      `📍 ${m.trn} [${m.cat.toUpperCase()}]\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 ${totalStr}\n` +
      `⚡ ${favName} ha sido ROTO en Set ${m.curSetNum}\n` +
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

// ─── Alerta: favorito pierde el Set 1 ─────────────────────────────────────────
// Condición: sets1.length === 1 y el favorito perdió ese primer set
// Genera DOS alertas separadas: ganar Set 2 + ganar partido
function checkSet1Loss(live) {
  live.forEach(m => {
    const favIs = m.o1 != null && m.o1 >= ODD_MIN && m.o1 <= ODD_MAX
      ? 'First Player'
      : m.o2 != null && m.o2 >= ODD_MIN && m.o2 <= ODD_MAX
        ? 'Second Player'
        : null;
    if (!favIs) return;
    // Solo actuar cuando acaba de terminar el Set 1 (sets1.length === 1)
    if (m.sets1.length !== 1) return;

    const fav1 = favIs === 'First Player' ? m.sets1[0] : m.sets2[0];
    const riv1 = favIs === 'First Player' ? m.sets2[0] : m.sets1[0];
    if (fav1 >= riv1) return; // el fav ganó o empató el set 1

    const favName = favIs === 'First Player' ? m.p1 : m.p2;
    const favO    = favIs === 'First Player' ? m.o1 : m.o2;
    const oddsband = favO == null ? 'n/d'
      : favO < 1.30 ? '1.20-1.30'
      : favO < 1.40 ? '1.30-1.40'
      : favO < 1.50 ? '1.40-1.50'
      : '1.50-1.60';

    // Una sola alerta TG, pero DOS registros en simAlerts (estadísticas separadas)
    const ks2 = `set1loss_s2_${m.id}`;
    const ksM = `set1loss_match_${m.id}`;
    if (!alerted.has(ksM)) {
      // Registrar "gana Set 2"
      if (!alerted.has(ks2)) {
        alerted.add(ks2);
        simAlerts.unshift({
          id: ks2, type: 'tennis_set1_set2', match: `${m.p1} vs ${m.p2}`,
          detail: `${m.trn} [${m.cat.toUpperCase()}] · Set1: ${m.sets1[0]}-${m.sets2[0]} · Fav pierde S1 → Gana S2?`,
          alertedAt: nowISO(), resolved: false, outcome: null,
          _eventId: m.id, _setNum: 2, _favIs: favIs,
          _setsP1atAlert: [...m.sets1], _setsP2atAlert: [...m.sets2],
          _favO: favO, _oddsband: oddsband, _cat: m.cat,
        });
        if (simAlerts.length > 500) simAlerts.length = 500;
      }
      // Registrar "gana partido"
      alerted.add(ksM);
      const simM = {
        id: ksM, type: 'tennis_set1_match', match: `${m.p1} vs ${m.p2}`,
        detail: `${m.trn} [${m.cat.toUpperCase()}] · Set1: ${m.sets1[0]}-${m.sets2[0]} · Fav pierde S1 → Gana partido?`,
        alertedAt: nowISO(), resolved: false, outcome: null,
        _eventId: m.id, _favIs: favIs,
        _setsP1atAlert: [...m.sets1], _setsP2atAlert: [...m.sets2],
        _favO: favO, _oddsband: oddsband, _cat: m.cat,
      };
      simAlerts.unshift(simM);
      if (simAlerts.length > 500) simAlerts.length = 500;

      // Un solo Telegram con las dos apuestas
      const s1Str = `${m.sets1[0]}-${m.sets2[0]}`;
      sendTG(
        `🎾 ROTURAS25 — FAVORITO PIERDE SET 1
` +
        `━━━━━━━━━━━━━━━━━━━━
` +
        `${m.p1} vs ${m.p2}
` +
        `📍 ${m.trn} [${m.cat.toUpperCase()}]
` +
        `━━━━━━━━━━━━━━━━━━━━
` +
        `📊 Set 1: ${s1Str} — ${favName} PERDIÓ
` +
        `⭐ Fav: ${favName} @ ${favO != null ? favO + 'x' : 'n/d'}
` +
        `━━━━━━━━━━━━━━━━━━━━
` +
        `→ APOSTAR 1: ${favName} gana el Set 2
` +
        `→ APOSTAR 2: ${favName} gana el partido`
      );
    }
  });
}

function resolveTennisSims() {
  simAlerts.forEach(s => {
    if (s.resolved) return;
    const m = lastTennis.find(x => x.id === s._eventId);
    if (!m || m.isUp) return;
    const favName = s._favIs === 'First Player' ? s.match.split(' vs ')[0] : s.match.split(' vs ')[1]?.trim();

    // ── Rotura de saque: el favorito gana/pierde el set donde fue roto ──
    if (s.type === 'tennis_break' && m.sets1.length > s._setsP1atAlert.length) {
      const setIdx = s._setNum - 1;
      const p1Won  = m.sets1[setIdx] > m.sets2[setIdx];
      const favWon = s._favIs === 'First Player' ? p1Won : !p1Won;
      s.outcome = favWon ? 'WIN' : 'LOSS';
      s.resolved = true; s.resolvedAt = nowISO();
      sendTG(`📊 RESULTADO · ${s.match}\nSet ${s._setNum}: ${m.sets1[setIdx]}-${m.sets2[setIdx]}\n${favName}: ${favWon ? '✅ GANÓ' : '❌ PERDIÓ'} el set`);
    }

    // ── Pérdida Set 1: ¿ganó el Set 2? ──
    if (s.type === 'tennis_set1_set2' && m.sets1.length >= 2) {
      const p1Won = m.sets1[1] > m.sets2[1];
      const favWon = s._favIs === 'First Player' ? p1Won : !p1Won;
      s.outcome = favWon ? 'WIN' : 'LOSS';
      s.resolved = true; s.resolvedAt = nowISO();
      sendTG(`📊 RESULTADO · ${s.match}\nSet 2: ${m.sets1[1]}-${m.sets2[1]}\n${favName}: ${favWon ? '✅ GANÓ' : '❌ PERDIÓ'} el Set 2`);
    }

    // ── Pérdida Set 1: ¿ganó el partido? ──
    // Partido terminado = el favorito tiene sets ganados > sets perdidos O viceversa (mejor de 3)
    if (s.type === 'tennis_set1_match') {
      const finished = m.sets1.length >= 2 && (
        (m.sets1.filter((v,i) => v > m.sets2[i]).length === 2) ||
        (m.sets2.filter((v,i) => v > m.sets1[i]).length === 2)
      );
      if (finished) {
        const p1Sets = m.sets1.filter((v,i) => v > m.sets2[i]).length;
        const p2Sets = m.sets2.filter((v,i) => v > m.sets1[i]).length;
        const p1Won  = p1Sets > p2Sets;
        const favWon = s._favIs === 'First Player' ? p1Won : !p1Won;
        s.outcome = favWon ? 'WIN' : 'LOSS';
        s.resolved = true; s.resolvedAt = nowISO();
        const score = m.sets1.map((v,i) => `${v}-${m.sets2[i]}`).join(' ');
        sendTG(`📊 RESULTADO · ${s.match}\nPartido: ${score}\n${favName}: ${favWon ? '✅ GANÓ' : '❌ PERDIÓ'} el partido`);
      }
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
    checkSet1Loss(live || []);
    checkBreakRecovery(live || []);
    checkMonitoredMatchStart();
    checkFootballAlerts();
    checkFootballStart();
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
    // Calcular stats por banda de cuota (solo registros resueltos tennis_break)
    // Stats de fútbol separadas por mercado
    const ftStats = { ht_05:{alerts:0,wins:0,losses:0}, ht_15:{alerts:0,wins:0,losses:0}, '2h_05':{alerts:0,wins:0,losses:0}, '2h_15':{alerts:0,wins:0,losses:0} };
    simAlerts.forEach(s => {
      if (s.resolved) {
        const k = s.type==='football_ht_05'?'ht_05':s.type==='football_ht_15'?'ht_15':s.type==='football_2h_05'?'2h_05':s.type==='football_2h_15'?'2h_15':null;
        if (k) { ftStats[k].alerts++; if(s.outcome==='WIN')ftStats[k].wins++; if(s.outcome==='LOSS')ftStats[k].losses++; }
      }
    });
    const bands = ['1.20-1.30','1.30-1.40','1.40-1.50','1.50-1.60'];
    const oddStats = {};
    bands.forEach(b => { oddStats[b] = { alerts:0, wins:0, losses:0, recoveries:0 }; });
    // Stats por categoría (itf_m, itf_f, atp, wta, etc.)
    const catStats = {};
    simAlerts.forEach(s => {
      // Break stats por cuota
      if (['tennis_break','tennis_set1_set2','tennis_set1_match'].includes(s.type) && s.resolved && s._oddsband) {
        const b = s._oddsband;
        if (!oddStats[b]) oddStats[b] = { alerts:0, wins:0, losses:0, recoveries:0 };
        oddStats[b].alerts++;
        if (s.outcome === 'WIN')  oddStats[b].wins++;
        if (s.outcome === 'LOSS') oddStats[b].losses++;
      }
      // Recovery stats — enlazar recuperaciones con la alerta de break correspondiente
      if (s.type === 'tennis_recovery' && s._oddsband) {
        const b = s._oddsband;
        if (!oddStats[b]) oddStats[b] = { alerts:0, wins:0, losses:0, recoveries:0 };
        oddStats[b].recoveries++;
      }
      // Cat stats (itf_m, itf_f separados)
      const cat = s._cat;
      if (cat && ['tennis_break','tennis_set1_set2','tennis_set1_match'].includes(s.type) && s.resolved) {
        if (!catStats[cat]) catStats[cat] = { alerts:0, wins:0, losses:0, recoveries:0 };
        catStats[cat].alerts++;
        if (s.outcome === 'WIN')  catStats[cat].wins++;
        if (s.outcome === 'LOSS') catStats[cat].losses++;
      }
      if (cat && s.type === 'tennis_recovery') {
        if (!catStats[cat]) catStats[cat] = { alerts:0, wins:0, losses:0, recoveries:0 };
        catStats[cat].recoveries++;
      }
    });
    res.writeHead(200);
    res.end(JSON.stringify({
      football:  lastFootball,
      tennis:    lastTennis,
      updated:   lastUpdate,
      alerted:   [...alerted],
      simAlerts: simAlerts.slice(0, 200),
      oddStats, catStats, ftStats,
    }));
    return;
  }

  // ── /admin/push — recibe server.js o docs/index.html y hace push a GitHub ──
  if (path === '/admin/push' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 5 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      try {
        const { secret, file, content: fileContent } = JSON.parse(body);
        const DEPLOY_SECRET = process.env.DEPLOY_SECRET || 'roturas25deploy';
        if (secret !== DEPLOY_SECRET) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
        if (!file || !fileContent) { res.writeHead(400); res.end(JSON.stringify({ error: 'file and content required' })); return; }
        // Allowed files only
        const allowed = ['server.js', 'docs/index.html', 'package.json'];
        if (!allowed.includes(file)) { res.writeHead(400); res.end(JSON.stringify({ error: 'file not allowed' })); return; }
        await ghUpsertFile(file, fileContent, `🚀 Auto-deploy ${file} — ${new Date().toISOString()}`);
        res.writeHead(200); res.end(JSON.stringify({ ok: true, file, pushed: true }));
        console.log('[DEPLOY] Pushed', file, 'to GitHub');
      } catch(e) {
        console.error('[DEPLOY ERROR]', e.message);
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
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

// ═══════════════════════════════════════════════════════════
// GITHUB PUSH HELPER — usado por /admin/push y pushStatusToGH
// ═══════════════════════════════════════════════════════════
async function ghUpsertFile(repoPath, contentStr, commitMsg) {
  const GH_TOKEN = process.env.GH_TOKEN || '';
  const GH_REPO  = process.env.GH_REPO  || 'Roturas25/Roturas25prod';
  if (!GH_TOKEN) throw new Error('GH_TOKEN no configurado en Railway');

  const base64Content = Buffer.from(contentStr).toString('base64');

  // Obtener SHA actual del archivo (si existe)
  let sha;
  try {
    const existing = await fetchJson(
      `https://api.github.com/repos/${GH_REPO}/contents/${repoPath}`,
      { 'Authorization': `token ${GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'Roturas25' }
    );
    sha = existing?.sha;
  } catch(e) { /* archivo nuevo */ }

  const body = JSON.stringify({ message: commitMsg, content: base64Content, ...(sha ? { sha } : {}) });
  await new Promise((res, rej) => {
    const buf = Buffer.from(body);
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${GH_REPO}/contents/${repoPath}`,
      method: 'PUT',
      headers: {
        'Authorization': `token ${GH_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'Content-Length': buf.length,
        'User-Agent': 'Roturas25-Server'
      }
    }, r => { r.resume(); r.on('end', res); });
    req.on('error', rej);
    req.write(buf); req.end();
  });
}

// ═══════════════════════════════════════════════════════════
// AUTO-PUSH A GITHUB (se ejecuta al arrancar Railway)
// Cuando Railway redeploya desde GitHub, server.js ya está actualizado.
// Este bloque solo sirve para confirmar el deploy con un commit de estado.
// ═══════════════════════════════════════════════════════════
async function pushStatusToGH() {
  try {
    const ts = new Date().toISOString();
    await ghUpsertFile('status.json', JSON.stringify({ lastDeploy: ts, version: 'v5' }), `🤖 Deploy ${ts}`);
    console.log('[GH] Status push OK →', ts);
  } catch(e) {
    console.warn('[GH] Status push failed:', e.message);
  }
}

server.listen(PORT, () => {
  console.log(`\n🎾 Roturas25 SERVER v4 — puerto ${PORT}`);
  console.log(`   Football: ${FOOTBALL_KEY ? '✓' : '✗'} · Tennis: ${TENNIS_KEY ? '✓' : '✗'} · TG: ${TG_TOKEN ? '✓' : '✗'}`);
  console.log(`   Cuota fav: ${ODD_MIN}x – ${ODD_MAX}x · Filtro dobles: ON · Odds: met=Odds endpoint\n`);
  poll();
  setTimeout(pushStatusToGH, 8000);
  // Mensaje de inicio — solo 1 por deploy real (no en crash loops)
  // Throttle: no enviar si hay otro mensaje en los últimos 5 min
  setTimeout(async () => {
    try {
      const startMsg = `✅ Roturas25 v5 activo\n⏱ ${new Date().toLocaleString('es-ES', {timeZone:'Europe/Madrid'})}`;
      await sendTG(startMsg);
    } catch(e) { console.warn('[STARTUP TG]', e.message); }
  }, 4000);
});
