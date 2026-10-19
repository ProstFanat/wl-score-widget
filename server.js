// Zero-dependency server for the FUT Champions widget.
// Run: node server.js   (Node 16+)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');
const PASSWORD = process.env.CONTROL_PASSWORD || ''; // empty = no password (local use)
const MAX_GAMES = 15; // FUT Champions weekend run length; change if the mode differs in FC27

let state = { wins: 0, losses: 0, history: [] };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch {}

const clients = new Set();
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state));
const payload = () => JSON.stringify({ ...state, max: MAX_GAMES });
const broadcast = () => clients.forEach(res => res.write(`data: ${payload()}\n\n`));

const actions = {
  win: () => { state.wins++; state.history.push('W'); },
  loss: () => { state.losses++; state.history.push('L'); },
  undo: () => {
    const last = state.history.pop();
    if (last === 'W') state.wins = Math.max(0, state.wins - 1);
    if (last === 'L') state.losses = Math.max(0, state.losses - 1);
  },
  reset: () => { state = { wins: 0, losses: 0, history: [] }; },
  // set exact values, e.g. POST /api/set?wins=5&losses=2 (a missing value is left unchanged)
  set: params => {
    const num = (key, fallback) => {
      const v = parseInt(params.get(key), 10);
      return Number.isFinite(v) ? Math.min(Math.max(v, 0), 999) : fallback;
    };
    state.wins = num('wins', state.wins);
    state.losses = num('losses', state.losses);
    // history only drives "undo", so rebuild it to match the new totals
    state.history = ['W'.repeat(state.wins), 'L'.repeat(state.losses)].join('').split('');
  },
};

const pages = { '/': 'overlay.html', '/control': 'control.html' };

http.createServer((req, res) => {
  const [url, query = ''] = req.url.split('?');
  res.setHeader('Access-Control-Allow-Origin', '*'); // lets pages opened from disk (file://) talk to the server
  res.setHeader('Access-Control-Allow-Headers', 'x-password');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${payload()}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'POST' && url.startsWith('/api/')) {
    if (PASSWORD && req.headers['x-password'] !== PASSWORD) { res.writeHead(401); return res.end(); }
    const act = url === '/api/check' ? () => {} : actions[url.slice(5)];
    if (!act) { res.writeHead(404); return res.end(); }
    act(new URLSearchParams(query)); save(); broadcast();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(payload());
  }

  if (pages[url]) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, pages[url])));
  }
  if (url === '/bird.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(fs.readFileSync(path.join(__dirname, 'bird.png')));
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => {
  console.log(`Overlay (OBS Browser Source): http://localhost:${PORT}/`);
  console.log(`Control panel (OBS Dock/browser): http://localhost:${PORT}/control`);
});
