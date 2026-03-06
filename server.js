const http = require('http');
const https = require('https');

// ═══════════════════════════════════════
// CONFIGURACIÓN — Keys integradas
// ═══════════════════════════════════════
const FOOTBALL_KEY = process.env.FOOTBALL_KEY || '';
const TENNIS_KEY   = process.env.TENNIS_KEY   || '';
const PORT         = process.env.PORT || 3000;

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error: ' + data.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // ── FOOTBALL: partidos hoy + mañana ──
    if (path === '/football') {
      const today    = new Date().toISOString().split('T')[0];
      const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
      const [pd, pl] = await Promise.all([
        fetchJson(`https://api.football-data.org/v4/competitions/PD/matches?dateFrom=${today}&dateTo=${tomorrow}`, { 'X-Auth-Token': FOOTBALL_KEY }),
        fetchJson(`https://api.football-data.org/v4/competitions/PL/matches?dateFrom=${today}&dateTo=${tomorrow}`, { 'X-Auth-Token': FOOTBALL_KEY }),
      ]);
      res.writeHead(200);
      res.end(JSON.stringify({ pd: pd.matches || [], pl: pl.matches || [] }));
      return;
    }

    // ── TENNIS: live ──
    if (path === '/tennis/live') {
      const data = await fetchJson(`https://apiv2.allsportsapi.com/tennis/?met=Livescore&APIkey=${TENNIS_KEY}`);
      res.writeHead(200);
      res.end(JSON.stringify(data));
      return;
    }

    // ── TENNIS: upcoming 24h ──
    if (path === '/tennis/upcoming') {
      const today    = new Date().toISOString().split('T')[0];
      const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
      const data = await fetchJson(`https://apiv2.allsportsapi.com/tennis/?met=Fixtures&APIkey=${TENNIS_KEY}&from=${today}&to=${tomorrow}`);
      res.writeHead(200);
      res.end(JSON.stringify(data));
      return;
    }

    // ── HEALTH CHECK ──
    if (path === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, football: !!FOOTBALL_KEY, tennis: !!TENNIS_KEY }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));

  } catch(e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  console.log(`Roturas25 proxy server running on port ${PORT}`);
  console.log(`Football key: ${FOOTBALL_KEY ? '✓ configured' : '✗ missing'}`);
  console.log(`Tennis key:   ${TENNIS_KEY   ? '✓ configured' : '✗ missing'}`);
});
