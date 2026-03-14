'use strict';
// ============================================================
// Roturas25 — server.js v10
// Railway · Node.js
// ============================================================

const https = require('https');
const http  = require('http');

// ── Config ──────────────────────────────────────────────────
const PORT        = process.env.PORT || 3000;
const API_KEY     = 'a8e248094b7d294e0a4eb421cd9945f291eb070e0c7cdc81dc03182e2b693063';
const FB_URL      = 'https://roturas25-default-rtdb.europe-west1.firebasedatabase.app';
const TG_TOKEN    = '8171273424:AAGMvAxhDnt-HSZSZi8DJeV0j6YEwhfHC5E';
const TG_CHAT     = '6307700447';
const ODD_MIN     = 1.20;
const ODD_MAX     = 1.60;

// ── State ────────────────────────────────────────────────────
let lastTennis          = [];
let lastFootball        = [];
let nextFootball        = [];       // NEW: next 24h fixtures
let simAlerts           = [];       // max 500
const oddsCache         = new Map(); // NEW: live odds per match_id
const breakRecoveries   = new Map();
const htSnapshot        = new Map();
const kickoffSnapshot   = new Map();
const alerted           = new Set();
const allFootballForSim = [];
const surfaceCache      = new Map(); // NEW: tournament → surface

// ── BT fixed odds ────────────────────────────────────────────
const BT_ODDS = { ft05: 1.80, ft15: 3.00, brk: 2.10, s2: 1.65, sm: 2.20 };

// ── Utility: HTTP GET → JSON ─────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 10000 }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch(e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Firebase ─────────────────────────────────────────────────
function fbPut(path, data) {
  return new Promise((resolve, reject) => {
    const body   = Buffer.from(JSON.stringify(data));
    const opts   = {
      hostname : 'roturas25-default-rtdb.europe-west1.firebasedatabase.app',
      path     : path + '.json',
      method   : 'PUT',
      headers  : { 'Content-Type': 'application/json', 'Content-Length': body.length }
    };
    const req = https.request(opts, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve(buf));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
function fbGet(path) {
  return fetchJSON(`${FB_URL}${path}.json`);
}

// ── Telegram ─────────────────────────────────────────────────
function tg(text) {
  if (!text) return;
  const body   = Buffer.from(JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }));
  const opts   = {
    hostname : 'api.telegram.org',
    path     : `/bot${TG_TOKEN}/sendMessage`,
    method   : 'POST',
    headers  : { 'Content-Type': 'application/json', 'Content-Length': body.length }
  };
  const req = https.request(opts, () => {});
  req.on('error', () => {});
  req.write(body);
  req.end();
}

// ── normT() ─ tennis score normaliser ────────────────────────
function normT(m) {
  const sc = m.scores || [];
  const sets1 = [], sets2 = [];
  let cs = 0;
  for (const s of sc) {
    const a = +s.score_first || 0, b = +s.score_second || 0;
    const done = (a >= 6 || b >= 6) && (Math.abs(a-b) >= 2 || a >= 7 || b >= 7);
    if (done) { sets1.push(a); sets2.push(b); cs = sets1.length; }
  }
  let g1 = 0, g2 = 0;
  const p1 = m.event_first_player_score_current_set;
  const p2 = m.event_second_player_score_current_set;
  if (p1 != null && p2 != null) { g1 = +p1; g2 = +p2; }
  else if (sc[cs]) { g1 = +sc[cs].score_first || 0; g2 = +sc[cs].score_second || 0; }

  let pt1 = '', pt2 = '';
  const gr = m.event_game_result || '';
  if (gr) { const pts = gr.split(' - '); pt1 = pts[0]||''; pt2 = pts[1]||''; }

  const fav = (m.event_home_team_odds != null && m.event_away_team_odds != null)
    ? (m.event_home_team_odds <= m.event_away_team_odds ? 'home' : 'away')
    : 'home';

  return { sets1, sets2, g1, g2, pt1, pt2, fav, setNum: cs + 1 };
}

// ── surfaceForTournament ─────────────────────────────────────
function surfaceForTournament(tournamentName) {
  if (!tournamentName) return 'hard';
  const t = tournamentName.toLowerCase();
  if (t.includes('clay') || t.includes('tierra') || t.includes('roland') ||
      t.includes('monte') || t.includes('madrid') || t.includes('barcelona') ||
      t.includes('rome') || t.includes('roma') || t.includes('hamburg') ||
      t.includes('stuttgart') || t.includes('munich') || t.includes('estoril') ||
      t.includes('bucharest') || t.includes('budapest') || t.includes('lyon') ||
      t.includes('geneva') || t.includes('prague') || t.includes('marrakech') ||
      t.includes('bogota') || t.includes('santiago') || t.includes('buenos')) {
    return 'clay';
  }
  if (t.includes('grass') || t.includes('wimbledon') || t.includes('halle') ||
      t.includes('eastbourne') || t.includes('s-hertogenbosch') || t.includes('nottingham') ||
      t.includes('queens') || t.includes("queen's")) {
    return 'grass';
  }
  return 'hard';
}

// ── btGlobalStats ────────────────────────────────────────────
function btGlobalStats() {
  const bts = simAlerts.filter(s => s._bt && s._resolved);
  const wins = bts.filter(s => s._win).length;
  const losses = bts.filter(s => !s._win).length;
  const profit = bts.reduce((acc, s) => {
    if (!s._resolved) return acc;
    const stake = s._stake || 50;
    return acc + (s._win ? (s._odds || 1) * stake - stake : -stake);
  }, 0);
  const invested = bts.reduce((acc, s) => acc + (s._resolved ? (s._stake || 50) : 0), 0);
  const roi = invested > 0 ? (profit / invested * 100).toFixed(1) : '0.0';
  return { wins, losses, total: wins + losses, profit: +profit.toFixed(2), roi: +roi, invested: +invested.toFixed(2) };
}

// ── sendBtResolutionTG ───────────────────────────────────────
function sendBtResolutionTG(sim) {
  const stats = btGlobalStats();
  const result = sim._win ? '✅ WIN' : '❌ LOSS';
  const pnl    = sim._win
    ? `+${((sim._odds || 1) * (sim._stake || 50) - (sim._stake || 50)).toFixed(2)}€`
    : `-${(sim._stake || 50).toFixed(2)}€`;
  const lines = [
    `${sim.match || sim._match || '?'}`,
    `${result} · ${sim._type || sim.type || '?'} @${sim._odds || '?'}x · ${pnl}`,
    `📊 Global: ${stats.wins}W ${stats.losses}L · ${stats.profit >= 0 ? '+' : ''}${stats.profit}€ · ROI ${stats.roi}%`
  ];
  tg(lines.join('\n'));
}

// ════════════════════════════════════════════════════════════
// FETCH TENNIS
// ════════════════════════════════════════════════════════════
async function fetchTennis() {
  try {
    const d = await fetchJSON(
      `https://apiv2.allsportsapi.com/tennis/?met=Livescore&APIkey=${API_KEY}`
    );
    if (d && d.success && Array.isArray(d.result)) {
      lastTennis = d.result;
      // Update surface cache from tournament names
      for (const m of lastTennis) {
        const tn = m.tournament_name || m.league_name || '';
        const lk = m.league_key || m.tournament_key || '';
        if (lk && !surfaceCache.has(lk)) {
          surfaceCache.set(lk, surfaceForTournament(tn));
        }
      }
    }
  } catch(e) { console.error('[fetchTennis]', e.message); }
}

// ════════════════════════════════════════════════════════════
// FETCH FOOTBALL
// ════════════════════════════════════════════════════════════
async function fetchFootball() {
  try {
    const d = await fetchJSON(
      `https://apiv2.allsportsapi.com/football/?met=Livescore&APIkey=${API_KEY}`
    );
    if (d && d.success && Array.isArray(d.result)) {
      lastFootball = d.result;
      // Keep allFootballForSim in sync
      for (const m of lastFootball) {
        if (!allFootballForSim.find(x => x.match_id === m.match_id)) {
          allFootballForSim.push(m);
        } else {
          const idx = allFootballForSim.findIndex(x => x.match_id === m.match_id);
          allFootballForSim[idx] = m;
        }
      }
    }
  } catch(e) { console.error('[fetchFootball]', e.message); }
}

// ════════════════════════════════════════════════════════════
// FETCH FOOTBALL NEXT 24H — NEW
// ════════════════════════════════════════════════════════════
async function fetchFootballNext() {
  try {
    const now    = new Date();
    const plus24 = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const fmt    = d => d.toISOString().split('T')[0];
    const from   = fmt(now);
    const to     = fmt(plus24);
    const d = await fetchJSON(
      `https://apiv2.allsportsapi.com/football/?met=Fixtures&APIkey=${API_KEY}&from=${from}&to=${to}`
    );
    if (d && d.success && Array.isArray(d.result)) {
      // Filter only LaLiga + Premier (league keys: 149=EPL, 302=LaLiga or similar)
      // We keep all and let frontend filter by league
      nextFootball = d.result.map(m => ({
        match_id        : m.match_id,
        match_hometeam_name  : m.match_hometeam_name,
        match_awayteam_name  : m.match_awayteam_name,
        league_name     : m.league_name,
        league_id       : m.league_id,
        match_date      : m.match_date,
        match_time      : m.match_time,
        match_status    : m.match_status
      }));
    }
  } catch(e) { console.error('[fetchFootballNext]', e.message); }
}

// ════════════════════════════════════════════════════════════
// POLL ODDS — NEW
// Fetches live odds for active tennis matches from AllSports API
// Uses per-match eventId, rate-limited with 30s TTL per match
// ════════════════════════════════════════════════════════════
async function pollOdds() {
  if (!lastTennis.length) return;
  const now    = Date.now();
  const TTL    = 30 * 1000; // only re-fetch if older than 30s
  const MAX_CONCURRENT = 5;

  // Collect matches that need an odds refresh
  const toFetch = lastTennis
    .filter(m => {
      const cached = oddsCache.get(String(m.event_key));
      return !cached || (now - cached.updated) > TTL;
    })
    .slice(0, MAX_CONCURRENT);

  if (!toFetch.length) return;

  const results = await Promise.allSettled(
    toFetch.map(m => fetchOddsForMatch(m))
  );

  results.forEach((res, i) => {
    if (res.status === 'rejected') {
      console.warn('[pollOdds] match', toFetch[i].event_key, res.reason?.message);
    }
  });
}

async function fetchOddsForMatch(m) {
  const matchId = String(m.event_key);
  try {
    const d = await fetchJSON(
      `https://apiv2.allsportsapi.com/tennis/?met=Odds&APIkey=${API_KEY}&eventId=${matchId}`
    );
    if (!d || !d.success || !Array.isArray(d.result) || !d.result.length) return;

    // Parse odds from AllSports response
    // Result is array of bet types: { bet_name, odd_home, odd_away, odd_1, odd_x, odd_2 }
    const bets = d.result;
    let oddMatch   = null; // match winner
    let oddSet2    = null; // set 2 winner
    let oddCurrent = null; // current set winner

    // AllSports tennis odds bet_name examples:
    // "Match Winner", "Set 1 Winner", "Set 2 Winner", "Set 3 Winner"
    const nt  = normT(m);
    const cs  = nt.setNum; // current set number (1-based)

    for (const b of bets) {
      const name = (b.bet_name || '').toLowerCase();
      if (name.includes('match winner') && !oddMatch) {
        // odd_home = home player, odd_away = away player
        const oh = parseFloat(b.odd_home || b.odd_1 || 0);
        const oa = parseFloat(b.odd_away || b.odd_2 || 0);
        if (oh > 0 && oa > 0) {
          oddMatch = nt.fav === 'home' ? oh : oa;
        }
      }
      if (name.includes(`set ${cs} winner`) && !oddCurrent) {
        const oh = parseFloat(b.odd_home || b.odd_1 || 0);
        const oa = parseFloat(b.odd_away || b.odd_2 || 0);
        if (oh > 0 && oa > 0) {
          oddCurrent = nt.fav === 'home' ? oh : oa;
        }
      }
      if (name.includes('set 2 winner') && !oddSet2) {
        const oh = parseFloat(b.odd_home || b.odd_1 || 0);
        const oa = parseFloat(b.odd_away || b.odd_2 || 0);
        if (oh > 0 && oa > 0) {
          oddSet2 = nt.fav === 'home' ? oh : oa;
        }
      }
    }

    // Determine favourite from match winner odds
    const allWinner = bets.find(b => (b.bet_name||'').toLowerCase().includes('match winner'));
    let favName = null;
    if (allWinner) {
      const oh = parseFloat(allWinner.odd_home || allWinner.odd_1 || 0);
      const oa = parseFloat(allWinner.odd_away || allWinner.odd_2 || 0);
      if (oh > 0 && oa > 0) {
        favName = oh <= oa ? m.event_home_team : m.event_away_team;
      }
    }

    const entry = {
      match   : oddMatch,
      set2    : oddSet2,
      current : oddCurrent,
      fav     : favName || m.event_home_team,
      updated : Date.now()
    };
    oddsCache.set(matchId, entry);

  } catch(e) {
    // Keep stale entry if exists, just update timestamp to avoid hammering
    const stale = oddsCache.get(matchId);
    if (stale) oddsCache.set(matchId, { ...stale, updated: Date.now() });
    throw e;
  }
}

// ════════════════════════════════════════════════════════════
// ALERT HELPERS — attach live odds to new sim alerts
// ════════════════════════════════════════════════════════════
function getOddsForMatch(matchId) {
  const o = oddsCache.get(String(matchId));
  if (!o) return {};
  return {
    odds_match   : o.match,
    odds_set2    : o.set2,
    odds_current : o.current
  };
}

// ════════════════════════════════════════════════════════════
// CHECK TENNIS ALERTS
// ════════════════════════════════════════════════════════════
function checkTennisAlerts() {
  for (const m of lastTennis) {
    const id  = `td_${m.event_key}`;
    const nt  = normT(m);
    const { sets1, sets2, g1, g2, fav, setNum } = nt;

    if (fav === 'home') {
      var favG = g1, rivG = g2;
      var favSets = sets1, rivSets = sets2;
      var favName = m.event_home_team, rivName = m.event_away_team;
    } else {
      var favG = g2, rivG = g1;
      var favSets = sets2, rivSets = sets1;
      var favName = m.event_away_team, rivName = m.event_home_team;
    }

    const tour = m.tournament_name || m.league_name || 'ATP';
    const lk   = m.league_key || m.tournament_key || '';
    const surf = surfaceCache.get(lk) || surfaceForTournament(tour);

    // ── Break alert ─────────────────────────────────────────
    // Favourite is broken: rival leads by exactly 1 break (rivG > favG)
    // and rival's lead came from a break (not from their own serves)
    const setLabel  = `s${setNum}`;
    const brkKey    = `${id}_brk_${setLabel}`;
    const brkState  = breakRecoveries.get(brkKey) || { broken: false, brkRivG: null, brkFavG: null };

    if (!brkState.broken && rivG > favG) {
      // Potential break — mark it
      const simId = `brk_${id}_${setLabel}_${favG}`;
      if (!alerted.has(simId)) {
        alerted.add(simId);
        // Odds from livescore odds fields
        const mOdds = fav === 'home'
          ? +m.event_home_team_odds || null
          : +m.event_away_team_odds || null;
        const useOdd = (mOdds && mOdds >= ODD_MIN && mOdds <= ODD_MAX) ? mOdds : BT_ODDS.brk;

        const odds = getOddsForMatch(m.event_key);

        const sim = {
          _id        : simId,
          _type      : 'tennis_break',
          _bt        : true,
          _odds      : BT_ODDS.brk,
          _stake     : 50,
          _resolved  : false,
          _win       : null,
          _simId     : simId,
          // Live odds (from pollOdds)
          odds_match   : odds.odds_match   || null,
          odds_set2    : odds.odds_set2    || null,
          odds_current : odds.odds_current || null,
          // Metadata for BT categories — NEW
          date       : m.event_date || new Date().toISOString().split('T')[0],
          tournament : tour,
          round      : m.event_round || '',
          surface    : surf,
          _cat       : `${surf}_${m.event_round || 'unknown'}`,
          // Match data
          match      : `${favName} vs ${rivName}`,
          matchId    : id,
          setLabel,
          favName,
          rivName,
          favG, rivG,
          ts         : Date.now()
        };
        simAlerts.unshift(sim);
        if (simAlerts.length > 500) simAlerts.length = 500;

        // Telegram
        tg(`${favName} vs ${rivName} · ${tour}\nBreak ${setLabel.replace('s','set ')}: ${favG}-${rivG} · ${favName} roto @${BT_ODDS.brk}x → apostar gana set`);

        // Mark break state
        breakRecoveries.set(brkKey, { broken: true, brkRivG: rivG, brkFavG: favG });
      }
    }

    // ── Break recovery (informative only, no popup/bt) ──────
    if (brkState.broken && favG === rivG) {
      const recKey = `rec_${id}_${setLabel}_${favG}`;
      if (!alerted.has(recKey)) {
        alerted.add(recKey);
        breakRecoveries.set(brkKey, { broken: false, brkRivG: null, brkFavG: null });
        tg(`${favName} vs ${rivName} · ${tour}\nBreak recuperado ${setLabel.replace('s','set ')}: ${favG}-${rivG} · ${favName} igualó`);

        // Add informative simAlert (not BT)
        const sim = {
          _id      : recKey,
          _type    : 'tennis_recovery',
          _bt      : false,
          _resolved: false,
          match    : `${favName} vs ${rivName}`,
          ts       : Date.now()
        };
        simAlerts.unshift(sim);
        if (simAlerts.length > 500) simAlerts.length = 500;
      }
    }
  }
}

// ════════════════════════════════════════════════════════════
// CHECK SET 1 LOSS
// ════════════════════════════════════════════════════════════
function checkSet1Loss() {
  for (const m of lastTennis) {
    const id  = `td_${m.event_key}`;
    const nt  = normT(m);
    const { sets1, sets2, fav, setNum } = nt;
    if (sets1.length < 1) continue;

    const favSets = fav === 'home' ? sets1 : sets2;
    const rivSets = fav === 'home' ? sets2 : sets1;
    const favName = fav === 'home' ? m.event_home_team : m.event_away_team;
    const rivName = fav === 'home' ? m.event_away_team : m.event_home_team;
    const tour    = m.tournament_name || m.league_name || 'ATP';
    const lk      = m.league_key || m.tournament_key || '';
    const surf    = surfaceCache.get(lk) || surfaceForTournament(tour);

    // Fav lost set 1?
    if (favSets[0] < rivSets[0]) {
      const odds = getOddsForMatch(m.event_key);

      // tennis_set1_set2
      const s2key = `set1loss_s2_${id}`;
      if (!alerted.has(s2key)) {
        alerted.add(s2key);
        const mOdds = fav === 'home' ? +m.event_home_team_odds : +m.event_away_team_odds;
        const sim = {
          _id        : s2key,
          _type      : 'tennis_set1_set2',
          _bt        : true,
          _odds      : BT_ODDS.s2,
          _stake     : 50,
          _resolved  : false,
          _win       : null,
          _simId     : s2key,
          odds_match   : odds.odds_match   || null,
          odds_set2    : odds.odds_set2    || null,
          odds_current : odds.odds_current || null,
          date       : m.event_date || new Date().toISOString().split('T')[0],
          tournament : tour,
          round      : m.event_round || '',
          surface    : surf,
          _cat       : `${surf}_${m.event_round || 'unknown'}`,
          match      : `${favName} vs ${rivName}`,
          matchId    : id,
          favName, rivName,
          s1fav: favSets[0], s1riv: rivSets[0],
          ts    : Date.now()
        };
        simAlerts.unshift(sim);
        if (simAlerts.length > 500) simAlerts.length = 500;
        tg(`${favName} vs ${rivName} · ${tour}\nSet 1: ${favSets[0]}-${rivSets[0]} · Fav pierde S1 @${BT_ODDS.s2}x\nApostar: gana S2 / gana partido`);
      }

      // tennis_set1_match
      const smkey = `set1loss_match_${id}`;
      if (!alerted.has(smkey)) {
        alerted.add(smkey);
        const sim = {
          _id        : smkey,
          _type      : 'tennis_set1_match',
          _bt        : true,
          _odds      : BT_ODDS.sm,
          _stake     : 50,
          _resolved  : false,
          _win       : null,
          _simId     : smkey,
          odds_match   : odds.odds_match   || null,
          odds_set2    : odds.odds_set2    || null,
          odds_current : odds.odds_current || null,
          date       : m.event_date || new Date().toISOString().split('T')[0],
          tournament : tour,
          round      : m.event_round || '',
          surface    : surf,
          _cat       : `${surf}_${m.event_round || 'unknown'}`,
          match      : `${favName} vs ${rivName}`,
          matchId    : id,
          favName, rivName,
          s1fav: favSets[0], s1riv: rivSets[0],
          ts    : Date.now()
        };
        simAlerts.unshift(sim);
        if (simAlerts.length > 500) simAlerts.length = 500;
      }
    }
  }
}

// ════════════════════════════════════════════════════════════
// CHECK BREAK RECOVERY (alias for the map cleanup)
// ════════════════════════════════════════════════════════════
function checkBreakRecovery() {
  // Resolution logic is already in checkTennisAlerts()
  // This function cleans up stale break states for matches no longer live
  const liveIds = new Set(lastTennis.map(m => `td_${m.event_key}`));
  for (const [key] of breakRecoveries) {
    // key format: td_EVENTKEY_brk_sN
    const matchId = key.split('_brk_')[0];
    if (!liveIds.has(matchId)) {
      breakRecoveries.delete(key);
    }
  }
}

// ════════════════════════════════════════════════════════════
// CHECK MONITORED MATCH START (tennis upcoming → live)
// ════════════════════════════════════════════════════════════
function checkMonitoredMatchStart() {
  // Placeholder — matches that were upcoming and are now live get alerts
  // This runs to ensure alerted set is consistent
}

// ════════════════════════════════════════════════════════════
// CHECK FOOTBALL START
// ════════════════════════════════════════════════════════════
function checkFootballStart() {
  for (const m of lastFootball) {
    const startKey = `start_${m.match_id}`;
    if (!alerted.has(startKey) && m.match_status === 'First Half') {
      alerted.add(startKey);
      // Record kickoff snapshot
      kickoffSnapshot.set(m.match_id, {
        home: +m.match_hometeam_score || 0,
        away: +m.match_awayteam_score || 0
      });
    }
  }
}

// ════════════════════════════════════════════════════════════
// CHECK FOOTBALL ALERTS
// ════════════════════════════════════════════════════════════
function checkFootballAlerts() {
  for (const m of lastFootball) {
    const mid  = m.match_id;
    const min  = parseInt(m.match_elapsed || m.match_status_detail || 0) || 0;
    const h    = +m.match_hometeam_score || 0;
    const a    = +m.match_awayteam_score || 0;
    const stat = m.match_status || '';

    // 1st half window: min 22-38, 0-0 global
    if (stat === 'First Half' && min >= 22 && min <= 38 && h === 0 && a === 0) {
      const k25 = `k25_${mid}`;
      if (!alerted.has(k25)) {
        alerted.add(k25);
        const tour = m.league_name || 'Liga';
        const match = `${m.match_hometeam_name} vs ${m.match_awayteam_name}`;

        // Football sim 0.5
        const sim05 = {
          _id       : `${k25}_05`,
          _type     : 'football_ht_05',
          _bt       : true,
          _odds     : BT_ODDS.ft05,
          _stake    : 50,
          _resolved : false,
          _win      : null,
          _simId    : `${k25}_05`,
          match, matchId: String(mid),
          league: tour, min,
          date  : m.match_date || new Date().toISOString().split('T')[0],
          ts    : Date.now()
        };
        const sim15 = {
          _id       : `${k25}_15`,
          _type     : 'football_ht_15',
          _bt       : true,
          _odds     : BT_ODDS.ft15,
          _stake    : 25,
          _resolved : false,
          _win      : null,
          _simId    : `${k25}_15`,
          match, matchId: String(mid),
          league: tour, min,
          date  : m.match_date || new Date().toISOString().split('T')[0],
          ts    : Date.now()
        };
        simAlerts.unshift(sim05, sim15);
        if (simAlerts.length > 500) simAlerts.length = 500;

        // Save HT snapshot for 2H resolution
        htSnapshot.set(mid, { home: h, away: a });

        tg(`${match} · ${tour}\nMin.${min} · 0-0 1ªP · apostar +0.5 (50€) y +1.5 (25€)`);
      }
    }

    // 2nd half window: min 63-78, 0 goals in 2nd half
    if (stat === 'Second Half' && min >= 63 && min <= 78) {
      const ht = htSnapshot.get(mid) || { home: 0, away: 0 };
      const goals2h = (h - ht.home) + (a - ht.away);
      if (goals2h === 0) {
        const k67 = `k67_${mid}`;
        if (!alerted.has(k67)) {
          alerted.add(k67);
          const tour  = m.league_name || 'Liga';
          const match = `${m.match_hometeam_name} vs ${m.match_awayteam_name}`;

          const sim05 = {
            _id       : `${k67}_05`,
            _type     : 'football_2h_05',
            _bt       : true,
            _odds     : BT_ODDS.ft05,
            _stake    : 50,
            _resolved : false,
            _win      : null,
            _simId    : `${k67}_05`,
            match, matchId: String(mid),
            league: tour, min,
            date  : m.match_date || new Date().toISOString().split('T')[0],
            ts    : Date.now()
          };
          const sim15 = {
            _id       : `${k67}_15`,
            _type     : 'football_2h_15',
            _bt       : true,
            _odds     : BT_ODDS.ft15,
            _stake    : 25,
            _resolved : false,
            _win      : null,
            _simId    : `${k67}_15`,
            match, matchId: String(mid),
            league: tour, min,
            date  : m.match_date || new Date().toISOString().split('T')[0],
            ts    : Date.now()
          };
          simAlerts.unshift(sim05, sim15);
          if (simAlerts.length > 500) simAlerts.length = 500;

          tg(`${match} · ${tour}\nMin.${min} · 0 goles 2ªP · apostar +0.5 (50€) y +1.5 (25€)`);
        }
      }
    }
  }
}

// ════════════════════════════════════════════════════════════
// RESOLVE TENNIS SIMS
// ════════════════════════════════════════════════════════════
function resolveTennisSims() {
  const liveMap = new Map(lastTennis.map(m => [`td_${m.event_key}`, m]));

  for (const sim of simAlerts) {
    if (!sim._bt || sim._resolved) continue;
    const m = liveMap.get(sim.matchId);

    if (sim._type === 'tennis_break') {
      if (!m) {
        // Match ended — if it's gone from live, we can't resolve automatically without final score
        // Leave unresolved until manual resolution or future enhancement
        continue;
      }
      const nt  = normT(m);
      const { sets1, sets2, fav } = nt;
      const setIdx = parseInt((sim.setLabel || 's1').replace('s','')) - 1;
      const favSets = fav === 'home' ? sets1 : sets2;
      const rivSets = fav === 'home' ? sets2 : sets1;

      if (favSets.length > setIdx && rivSets.length > setIdx) {
        // Set is complete
        const fWon = favSets[setIdx] > rivSets[setIdx];
        sim._resolved = true;
        sim._win      = fWon;
        sim._resolvedAt = Date.now();

        // Check tiebreak
        if (favSets[setIdx] === 7 && rivSets[setIdx] === 6) sim._tiebreak = true;
        if (favSets[setIdx] === 6 && rivSets[setIdx] === 7) sim._tiebreak = true;

        sendBtResolutionTG(sim);
        fbPut(`/state/sims/${sim._id.replace(/[^a-z0-9_]/gi,'_')}`, sim).catch(()=>{});
      }
    }

    if (sim._type === 'tennis_set1_set2') {
      if (!m) continue;
      const nt  = normT(m);
      const { sets1, sets2, fav } = nt;
      const favSets = fav === 'home' ? sets1 : sets2;
      const rivSets = fav === 'home' ? sets2 : sets1;
      if (favSets.length >= 2 && rivSets.length >= 2) {
        sim._resolved   = true;
        sim._win        = favSets[1] > rivSets[1];
        sim._resolvedAt = Date.now();
        sendBtResolutionTG(sim);
        fbPut(`/state/sims/${sim._id.replace(/[^a-z0-9_]/gi,'_')}`, sim).catch(()=>{});
      }
    }

    if (sim._type === 'tennis_set1_match') {
      if (!m) {
        // Match gone from live — check if we can determine winner
        continue;
      }
      // Resolve when match is over: one player has 2 sets
      const nt  = normT(m);
      const { sets1, sets2, fav } = nt;
      const favSets = fav === 'home' ? sets1 : sets2;
      const rivSets = fav === 'home' ? sets2 : sets1;
      const favSetWins = favSets.reduce((acc, v, i) => acc + (v > (rivSets[i]||0) ? 1 : 0), 0);
      const rivSetWins = rivSets.reduce((acc, v, i) => acc + (v > (favSets[i]||0) ? 1 : 0), 0);
      if (favSetWins === 2 || rivSetWins === 2) {
        sim._resolved   = true;
        sim._win        = favSetWins === 2;
        sim._resolvedAt = Date.now();
        sendBtResolutionTG(sim);
        fbPut(`/state/sims/${sim._id.replace(/[^a-z0-9_]/gi,'_')}`, sim).catch(()=>{});
      }
    }
  }
}

// ════════════════════════════════════════════════════════════
// RESOLVE FOOTBALL SIMS
// ════════════════════════════════════════════════════════════
function resolveFootballSims() {
  const liveMap = new Map(lastFootball.map(m => [String(m.match_id), m]));

  for (const sim of simAlerts) {
    if (!sim._bt || sim._resolved) continue;
    if (!sim._type.startsWith('football_')) continue;

    const m = liveMap.get(sim.matchId);

    // HT sims resolve at PAUSED (half time)
    if (sim._type === 'football_ht_05' || sim._type === 'football_ht_15') {
      if (!m) continue;
      const stat = m.match_status || '';
      if (stat === 'Half Time' || stat === 'HT' || stat === 'PAUSED') {
        const h = +m.match_hometeam_score || 0;
        const a = +m.match_awayteam_score || 0;
        const goals = h + a;
        sim._resolved   = true;
        sim._win        = sim._type.includes('05') ? goals > 0 : goals > 1;
        sim._resolvedAt = Date.now();
        sendBtResolutionTG(sim);
        fbPut(`/state/sims/${sim._id.replace(/[^a-z0-9_]/gi,'_')}`, sim).catch(()=>{});
      }
    }

    // 2H sims resolve at FINISHED
    if (sim._type === 'football_2h_05' || sim._type === 'football_2h_15') {
      if (!m) continue;
      const stat = m.match_status || '';
      if (stat === 'Finished' || stat === 'FT' || stat === 'FINISHED') {
        const h  = +m.match_hometeam_score || 0;
        const a  = +m.match_awayteam_score || 0;
        const ht = htSnapshot.get(m.match_id) || { home: 0, away: 0 };
        const goals2h = (h - ht.home) + (a - ht.away);
        sim._resolved   = true;
        sim._win        = sim._type.includes('05') ? goals2h > 0 : goals2h > 1;
        sim._resolvedAt = Date.now();
        sendBtResolutionTG(sim);
        fbPut(`/state/sims/${sim._id.replace(/[^a-z0-9_]/gi,'_')}`, sim).catch(()=>{});
      }
    }
  }
}

// ════════════════════════════════════════════════════════════
// MAIN POLL LOOP
// Order: fetchTennis → fetchFootball → checkTennisAlerts →
//        checkSet1Loss → checkBreakRecovery →
//        checkMonitoredMatchStart → checkFootballStart →
//        checkFootballAlerts → resolveTennisSims → resolveFootballSims
// ════════════════════════════════════════════════════════════
let pollTimer = null;

async function poll() {
  try {
    await fetchTennis();
    await fetchFootball();
    checkTennisAlerts();
    checkSet1Loss();
    checkBreakRecovery();
    checkMonitoredMatchStart();
    checkFootballStart();
    checkFootballAlerts();
    resolveTennisSims();
    resolveFootballSims();
  } catch(e) {
    console.error('[poll]', e.message);
  }

  const hasLive = lastTennis.length > 0 || lastFootball.length > 0;
  const delay   = hasLive ? 45000 : 180000;
  pollTimer = setTimeout(poll, delay);
}

// Odds poll — independent 15s cycle
function startOddsPoll() {
  const oddsPollFn = async () => {
    try { await pollOdds(); } catch(e) { console.error('[oddsPoll]', e.message); }
    setTimeout(oddsPollFn, 15000);
  };
  setTimeout(oddsPollFn, 5000); // start 5s after boot
}

// Football next 24h — refresh every 10 minutes
function startFootballNextPoll() {
  const fn = async () => {
    try { await fetchFootballNext(); } catch(e) { console.error('[footballNext]', e.message); }
    setTimeout(fn, 10 * 60 * 1000);
  };
  fn(); // immediate
}

// ════════════════════════════════════════════════════════════
// 8-HOUR CHECK
// ════════════════════════════════════════════════════════════
function eightHourCheck() {
  const since = Date.now() - 8 * 60 * 60 * 1000;
  const recent = simAlerts.filter(s => s._bt && s._resolved && s._resolvedAt > since);
  if (!recent.length) return;
  const stats = btGlobalStats();
  const lines = ['📋 Resumen 8h:', ...recent.map(s =>
    `${s._win?'✅':'❌'} ${s.match} · ${s._type}`
  ), `Total: ${stats.wins}W ${stats.losses}L · ${stats.profit}€`];
  tg(lines.join('\n'));
}

// ════════════════════════════════════════════════════════════
// DAILY ALERT
// ════════════════════════════════════════════════════════════
function sendDailyBtSummary() {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const stats  = btGlobalStats();
  const recent = simAlerts.filter(s => s._bt && s._resolved && s._resolvedAt > since);
  const lines  = [
    `📅 Resumen diario`,
    `${recent.length} resoluciones · ${stats.wins}W ${stats.losses}L`,
    `Profit: ${stats.profit >= 0 ? '+' : ''}${stats.profit}€ · ROI ${stats.roi}%`
  ];
  tg(lines.join('\n'));
}

function scheduleDailyAlert() {
  const now    = new Date();
  const target = new Date(now);
  target.setHours(15, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  setTimeout(() => {
    sendDailyBtSummary();
    setInterval(sendDailyBtSummary, 24 * 60 * 60 * 1000);
  }, target - now);
}

// ════════════════════════════════════════════════════════════
// HTTP SERVER
// ════════════════════════════════════════════════════════════
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, data, status = 200) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise(resolve => {
    let buf = '';
    req.on('data', d => buf += d);
    req.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  // ── GET /health ──────────────────────────────────────────
  if (req.method === 'GET' && url === '/health') {
    return json(res, {
      ok      : true,
      uptime  : process.uptime(),
      tennis  : lastTennis.length,
      football: lastFootball.length,
      sims    : simAlerts.length,
      alerted : alerted.size,
      odds    : oddsCache.size,
      ts      : Date.now()
    });
  }

  // ── GET /data ────────────────────────────────────────────
  if (req.method === 'GET' && url === '/data') {
    return json(res, {
      tennis       : lastTennis,
      football     : lastFootball,
      simAlerts    : simAlerts.slice(0, 200), // send last 200
      btStats      : btGlobalStats(),
      odds         : Object.fromEntries(oddsCache),  // NEW
      ts           : Date.now()
    });
  }

  // ── GET /football-next ───────────────────────────────────
  if (req.method === 'GET' && url === '/football-next') {
    return json(res, { ok: true, matches: nextFootball, ts: Date.now() });
  }

  // ── POST /admin/push ─────────────────────────────────────
  if (req.method === 'POST' && url === '/admin/push') {
    const body = await readBody(req);
    if (body && body.message) tg(body.message);
    return json(res, { ok: true });
  }

  // ── POST /reset ──────────────────────────────────────────
  // NEW: clears all state
  if (req.method === 'POST' && url === '/reset') {
    alerted.clear();
    simAlerts.length = 0;
    oddsCache.clear();
    breakRecoveries.clear();
    htSnapshot.clear();
    kickoffSnapshot.clear();
    try {
      await fbPut('/state/alerted', []);
      await fbPut('/state/sims', []);
    } catch(e) { console.warn('[reset] FB error:', e.message); }
    console.log('[reset] Database reset at', new Date().toISOString());
    return json(res, { ok: true, ts: Date.now() });
  }

  // ── 404 ──────────────────────────────────────────────────
  return json(res, { error: 'not found' }, 404);
});

// ════════════════════════════════════════════════════════════
// STARTUP
// ════════════════════════════════════════════════════════════
server.listen(PORT, () => {
  console.log(`[Roturas25 v10] listening on :${PORT}`);

  // Boot notification (8s delay)
  setTimeout(() => {
    const stats = btGlobalStats();
    tg(`🟢 Roturas25 v10 iniciado\nSims: ${simAlerts.length} · ${stats.wins}W ${stats.losses}L · ${stats.profit}€`);
  }, 8000);

  // Start polling loops
  poll();
  startOddsPoll();
  startFootballNextPoll();

  // Periodic checks
  setInterval(eightHourCheck, 8 * 60 * 60 * 1000);
  scheduleDailyAlert();
});
