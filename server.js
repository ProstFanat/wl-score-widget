// Node server for the score overlays. PostgreSQL is used when DATABASE_URL is configured.
// Run: npm start   (Node 16+)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_STATE_FILE = process.env.DEFAULT_STATE_FILE || process.env.CHAMPIONS_STATE_FILE || path.join(__dirname, 'champions-state.json');
const PASSWORD = process.env.CONTROL_PASSWORD || ''; // empty = no password (local use)
const MAX_GAMES = 15; // FUT Champions weekend run length; change if the mode differs in FC27
const pool = process.env.DATABASE_URL
  ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ...(process.env.NODE_ENV === 'production' ? { ssl: { rejectUnauthorized: false } } : {}),
  })
  : null;

function createScoreboard(stateFile) {
  let state = { wins: 0, losses: 0, history: [] };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch {}

  const clients = new Set();
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
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

  return {
    payload,
    clients,
    broadcast,
    act: (name, params) => {
      const action = name === 'check' ? () => {} : actions[name];
      if (!action) return false;
      action(params);
      save();
      broadcast();
      return true;
    },
  };
}

const scoreboards = {
  default: createScoreboard(DEFAULT_STATE_FILE),
};
const pages = {
  '/': 'index.html',
  '/halloween': 'overlays/halloween.html',
  '/chupapi-v1': 'overlays/chupapi-v1.html',
  '/mancity': 'overlays/mancity.html',
  '/donetsk1y': 'overlays/donetsk1y.html',
  '/preview/donetsk1y': 'overlays/donetsk1y.html',
  '/hetra-zidana': 'overlays/hetra-zidana.html',
  '/brofist': 'overlays/brofist.html',
  '/brofist-smash': 'overlays/brofist-smash.html',
  '/black98': 'overlays/black98.html',
  '/adrian-v1': 'overlays/adrian-v1.html',
  '/adrian-v2': 'overlays/adrian-v2.html',
  '/preview/adrian-v2': 'overlays/adrian-v2.html',
  '/preview/adrian-v1': 'overlays/adrian-v1.html',
  '/preview/black98': 'overlays/black98.html',
  '/preview/brofist': 'overlays/brofist.html',
  '/preview/hetra-zidana': 'overlays/hetra-zidana.html',
  '/chupapi-v2': 'overlays/chupapi-v2.html',
  '/preview/chupapi-v2': 'overlays/chupapi-v2.html',
  '/preview/mancity': 'overlays/mancity.html',
  '/preview/chupapi-v1': 'overlays/chupapi-v1.html',
  '/default-left': 'overlays/default-left.html',
  '/halloween-left': 'overlays/halloween-left.html',
  '/preview/default-left': 'overlays/default-left.html',
  '/preview/halloween-left': 'overlays/halloween-left.html',
  '/halloween/control': 'controls/default.html',
  '/phoenix-overlay': 'overlays/phoenix-overlay.html',
  '/phoenix-upg': 'overlays/phoenix-upg.html',
  '/default': 'overlays/default.html',
  '/default/control': 'controls/default.html',
  '/champions': 'overlays/default.html',
  '/champions/control': 'controls/default.html',
  '/new': 'rooms/create.html',
  '/find-room': 'rooms/find.html',
  '/guide': 'guide.html',
  '/camera-frames': 'camera-frames/index.html',
  '/camera-frames/halloween': 'camera-frames/halloween.html',
  '/preview/default': 'overlays/default.html',
  '/preview/halloween': 'overlays/halloween.html',
  '/preview/champions': 'overlays/default.html',
  '/preview/default/results': 'overlays/results.html',
  '/preview/halloween/results': 'overlays/results.html',
  '/example/results': 'rooms/results-example.html',
};

// every local overlay theme shares the one default scoreboard, like personal rooms do
const legacyBoardIds = {
  default: 'champions',
};
const roomClients = new Map();
const ROOM_THEMES = ['default', 'halloween'];
const ROOM_OVERLAY_THEMES = [...ROOM_THEMES, 'default-left', 'halloween-left', 'mancity', 'donetsk1y'];

function roomOverlayLinks(viewId, suffix = '', themes = ROOM_THEMES) {
  return Object.fromEntries(themes.map(theme => [theme, `/room/${viewId}/${theme}${suffix}`]));
}

function normalizeBoard(row) {
  return {
    wins: Number(row.wins),
    losses: Number(row.losses),
    history: row.history || [],
    championsResults: Array.isArray(row.champions_results) ? row.champions_results : [],
    max: MAX_GAMES,
    ...(row.name ? { name: row.name } : {}),
  };
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, expectedHash) {
  if (typeof password !== 'string' || !salt || !expectedHash) return false;
  const supplied = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

async function initializeDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scoreboards (
      id TEXT PRIMARY KEY,
      view_id TEXT UNIQUE,
      control_hash TEXT UNIQUE,
      password_salt TEXT,
      password_hash TEXT,
      name TEXT NOT NULL,
      wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
      losses INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
      history TEXT[] NOT NULL DEFAULT '{}',
      champions_results JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('ALTER TABLE scoreboards ADD COLUMN IF NOT EXISTS password_salt TEXT');
  await pool.query('ALTER TABLE scoreboards ADD COLUMN IF NOT EXISTS password_hash TEXT');
  await pool.query("ALTER TABLE scoreboards ADD COLUMN IF NOT EXISTS champions_results JSONB NOT NULL DEFAULT '[]'::jsonb");

  for (const [slug, fileBoard] of Object.entries(scoreboards)) {
    const boardId = legacyBoardIds[slug];
    const saved = JSON.parse(fileBoard.payload());
    await pool.query(
      `INSERT INTO scoreboards (id, name, wins, losses, history)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [boardId, slug ? `${slug} scoreboard` : 'Main scoreboard', saved.wins, saved.losses, saved.history || []],
    );
  }
}

async function getBoard(boardId) {
  if (!pool) {
    const localBoard = Object.entries(legacyBoardIds).find(([, id]) => id === boardId);
    return localBoard ? JSON.parse(scoreboards[localBoard[0]].payload()) : null;
  }
  const { rows } = await pool.query(
    'SELECT wins, losses, history, champions_results, name FROM scoreboards WHERE id = $1',
    [boardId],
  );
  return rows[0] ? normalizeBoard(rows[0]) : null;
}

function buildUpdatedState(state, action, params) {
  const updated = { ...state, history: [...state.history] };
  if (action === 'win') {
    updated.wins++;
    updated.history.push('W');
  } else if (action === 'loss') {
    updated.losses++;
    updated.history.push('L');
  } else if (action === 'undo') {
    const last = updated.history.pop();
    if (last === 'W') updated.wins = Math.max(0, updated.wins - 1);
    if (last === 'L') updated.losses = Math.max(0, updated.losses - 1);
  } else if (action === 'reset') {
    updated.wins = 0;
    updated.losses = 0;
    updated.history = [];
  } else if (action === 'set') {
    const num = (key, fallback) => {
      const value = parseInt(params.get(key), 10);
      return Number.isFinite(value) ? Math.min(Math.max(value, 0), 999) : fallback;
    };
    updated.wins = num('wins', updated.wins);
    updated.losses = num('losses', updated.losses);
    updated.history = [...'W'.repeat(updated.wins), ...'L'.repeat(updated.losses)];
  } else if (action !== 'check') {
    return null;
  }
  return updated;
}

async function applyDatabaseAction(boardId, action, params) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'SELECT wins, losses, history, champions_results, name FROM scoreboards WHERE id = $1 FOR UPDATE',
      [boardId],
    );
    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const current = normalizeBoard(result.rows[0]);
    const updated = buildUpdatedState(current, action, params);
    if (!updated) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      'UPDATE scoreboards SET wins = $2, losses = $3, history = $4 WHERE id = $1',
      [boardId, updated.wins, updated.losses, updated.history],
    );
    await client.query('COMMIT');
    return updated;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function addChampionsResult(boardId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'SELECT wins, losses, history, champions_results, name FROM scoreboards WHERE id = $1 FOR UPDATE',
      [boardId],
    );
    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const current = normalizeBoard(result.rows[0]);
    if (current.wins + current.losses === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    current.championsResults.push({
      wins: current.wins,
      losses: current.losses,
      history: [...current.history],
    });
    current.championsResults = current.championsResults.slice(-15);
    const updated = { ...current, wins:0, losses:0, history:[] };
    await client.query(
      `UPDATE scoreboards
       SET wins = 0, losses = 0, history = '{}', champions_results = $2
       WHERE id = $1`,
      [boardId, JSON.stringify(updated.championsResults)],
    );
    await client.query('COMMIT');
    return updated;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function clearChampionsResults(boardId) {
  const { rows } = await pool.query(
    `UPDATE scoreboards
     SET champions_results = '[]'::jsonb
     WHERE id = $1
     RETURNING wins, losses, history, champions_results, name`,
    [boardId],
  );
  return rows[0] ? normalizeBoard(rows[0]) : null;
}

async function applyAction(boardId, action, params) {
  if (pool) return applyDatabaseAction(boardId, action, params);
  const localBoard = Object.entries(legacyBoardIds).find(([, id]) => id === boardId);
  if (!localBoard) return null;
  if (!scoreboards[localBoard[0]].act(action, params)) return false;
  return getBoard(boardId);
}

function sendBoardUpdate(boardId, state) {
  const subscription = roomClients.get(boardId);
  if (!subscription) return;
  const message = JSON.stringify(state);
  subscription.lastMessage = message;
  for (const client of subscription.clients) client.write(`data: ${message}\n\n`);
}

function subscribeToBoard(req, res, boardId, state) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const message = JSON.stringify(state);
  res.write(`data: ${message}\n\n`);

  let subscription = roomClients.get(boardId);
  if (!subscription) {
    subscription = { clients: new Set(), lastMessage: message, poll: null, heartbeat: null };
    roomClients.set(boardId, subscription);
    if (pool) {
      subscription.poll = setInterval(async () => {
        try {
          const current = await getBoard(boardId);
          if (current && JSON.stringify(current) !== subscription.lastMessage) {
            sendBoardUpdate(boardId, current);
          }
        } catch (error) {
          console.error(`Failed to refresh scoreboard ${boardId}:`, error);
        }
      }, 2000);
      subscription.poll.unref();
    }
    subscription.heartbeat = setInterval(() => {
      for (const client of subscription.clients) client.write(': keepalive\n\n');
    }, 15000);
    subscription.heartbeat.unref();
  }
  subscription.clients.add(res);
  res.on('close', () => {
    subscription.clients.delete(res);
    if (subscription.clients.size === 0) {
      clearInterval(subscription.poll);
      clearInterval(subscription.heartbeat);
      roomClients.delete(boardId);
    }
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function publicError(res, status, message) {
  sendJson(res, status, { error: message });
}

function readJsonBody(req, maxBytes = 2048) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON request body'));
      }
    });
    req.on('error', reject);
  });
}

async function handleRequest(req, res) {
  const [url, query = ''] = req.url.split('?');
  res.setHeader('Access-Control-Allow-Origin', '*'); // lets pages opened from disk (file://) talk to the server
  res.setHeader('Access-Control-Allow-Headers', 'x-password, x-scoreboard-password');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'GET' && url === '/events') {
    const state = await getBoard('champions');
    return state ? subscribeToBoard(req, res, 'champions', state) : publicError(res, 503, 'Scoreboard storage is unavailable');
  }
  if (req.method === 'GET' && url === '/halloween/events') {
    const state = await getBoard('champions');
    return state ? subscribeToBoard(req, res, 'champions', state) : publicError(res, 503, 'Scoreboard storage is unavailable');
  }
  if (req.method === 'GET' && (url === '/default/events' || url === '/champions/events')) {
    const state = await getBoard('champions');
    return state ? subscribeToBoard(req, res, 'champions', state) : publicError(res, 503, 'Scoreboard storage is unavailable');
  }

  const roomEvents = url.match(/^\/room\/([a-f0-9]{32})\/events$/);
  if (req.method === 'GET' && roomEvents) {
    if (!pool) return publicError(res, 503, 'Personal scoreboards require a configured PostgreSQL database');
    const boardId = `room:${roomEvents[1]}`;
    const state = await getBoard(boardId);
    return state ? subscribeToBoard(req, res, boardId, state) : publicError(res, 404, 'Scoreboard not found');
  }

  const roomDetails = url.match(/^\/api\/rooms\/([a-f0-9]{64})$/);
  if (req.method === 'GET' && roomDetails) {
    if (!pool) return publicError(res, 503, 'Personal scoreboards require a configured PostgreSQL database');
    const hash = crypto.createHash('sha256').update(roomDetails[1]).digest('hex');
    const { rows } = await pool.query(
      'SELECT id, view_id, name, wins, losses, history, champions_results, password_salt, password_hash FROM scoreboards WHERE control_hash = $1',
      [hash],
    );
    if (!rows[0]) return publicError(res, 401, 'Invalid control link');
    if (rows[0].password_hash && !verifyPassword(req.headers['x-scoreboard-password'], rows[0].password_salt, rows[0].password_hash)) {
      return publicError(res, 401, 'Incorrect scoreboard password');
    }
    if (!rows[0].password_hash) return publicError(res, 428, 'This older scoreboard has no password. Create a new personal scoreboard to set one.');
    return sendJson(res, 200, {
      ...normalizeBoard(rows[0]),
      viewId: rows[0].view_id,
      overlays: roomOverlayLinks(rows[0].view_id, '', ROOM_OVERLAY_THEMES),
      resultOverlays: roomOverlayLinks(rows[0].view_id, '/results'),
    });
  }

  if (req.method === 'POST' && url === '/api/rooms/search') {
    if (!pool) return publicError(res, 503, 'Personal scoreboards require a configured PostgreSQL database');
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return publicError(res, 400, error.message);
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 40) return publicError(res, 400, 'Enter a room name of 1 to 40 characters');
    const { rows } = await pool.query(
      'SELECT view_id, name FROM scoreboards WHERE view_id IS NOT NULL AND LOWER(name) = LOWER($1)',
      [name],
    );
    if (!rows.length) return publicError(res, 404, 'No scoreboard found with that exact name');
    if (rows.length > 1) return publicError(res, 409, 'More than one existing scoreboard has that name. Use its saved private control link.');
    return sendJson(res, 200, {
      name: rows[0].name,
      controlUrl: `/manage-room/${rows[0].view_id}`,
    });
  }

  if (req.method === 'POST' && url === '/api/rooms') {
    if (!pool) return publicError(res, 503, 'Add a PostgreSQL database in Render and set DATABASE_URL to enable personal scoreboards');
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return publicError(res, 400, error.message);
    }
    const name = typeof body.name === 'string'
      ? body.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40)
      : '';
    if (!name) return publicError(res, 400, 'Scoreboard name is required');
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 8 || password.length > 128) {
      return publicError(res, 400, 'Password must be between 8 and 128 characters');
    }
    const viewId = crypto.randomBytes(16).toString('hex');
    const controlToken = crypto.randomBytes(32).toString('hex');
    const passwordSalt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, passwordSalt);
    const boardId = `room:${viewId}`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended(LOWER($1), 0))', [name]);
      const { rows } = await client.query(
        'SELECT 1 FROM scoreboards WHERE view_id IS NOT NULL AND LOWER(name) = LOWER($1) LIMIT 1',
        [name],
      );
      if (rows.length) {
        await client.query('ROLLBACK');
        return publicError(res, 409, 'A scoreboard with that name already exists. Choose a unique name.');
      }
      await client.query(
        `INSERT INTO scoreboards (id, view_id, control_hash, password_salt, password_hash, name, wins, losses, history)
         VALUES ($1, $2, $3, $4, $5, $6, 0, 0, '{}')`,
        [boardId, viewId, crypto.createHash('sha256').update(controlToken).digest('hex'), passwordSalt, passwordHash, name],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return sendJson(res, 201, {
      name,
      controlUrl: `/manage/${controlToken}`,
      overlays: roomOverlayLinks(viewId, '', ROOM_OVERLAY_THEMES),
    });
  }

  const roomPasswordSetup = url.match(/^\/api\/rooms\/([a-f0-9]{64})\/password$/);
  if (req.method === 'POST' && roomPasswordSetup) {
    if (!pool) return publicError(res, 503, 'Personal scoreboards require a configured PostgreSQL database');
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return publicError(res, 400, error.message);
    }
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 8 || password.length > 128) {
      return publicError(res, 400, 'Password must be between 8 and 128 characters');
    }
    const controlHash = crypto.createHash('sha256').update(roomPasswordSetup[1]).digest('hex');
    const passwordSalt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, passwordSalt);
    const result = await pool.query(
      'UPDATE scoreboards SET password_salt = $2, password_hash = $3 WHERE control_hash = $1 AND password_hash IS NULL RETURNING id',
      [controlHash, passwordSalt, passwordHash],
    );
    if (result.rows[0]) return sendJson(res, 200, { success: true });
    const existing = await pool.query('SELECT password_hash FROM scoreboards WHERE control_hash = $1', [controlHash]);
    if (!existing.rows[0]) return publicError(res, 404, 'Control link not found');
    return publicError(res, 409, 'A password has already been set for this scoreboard');
  }

  const manageRoute = url.match(/^\/manage\/([a-f0-9]{64})$/);
  if (req.method === 'GET' && manageRoute) {
    if (!pool) return publicError(res, 503, 'Personal scoreboards require a configured PostgreSQL database');
    const hash = crypto.createHash('sha256').update(manageRoute[1]).digest('hex');
    const { rows } = await pool.query('SELECT id FROM scoreboards WHERE control_hash = $1', [hash]);
    if (!rows[0]) return publicError(res, 404, 'Control link not found');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'rooms/control.html')));
  }

  const roomManageRoute = url.match(/^\/manage-room\/([a-f0-9]{32})$/);
  if (req.method === 'GET' && roomManageRoute) {
    if (!pool) return publicError(res, 503, 'Personal scoreboards require a configured PostgreSQL database');
    const { rows } = await pool.query('SELECT id FROM scoreboards WHERE view_id = $1', [roomManageRoute[1]]);
    if (!rows[0]) return publicError(res, 404, 'Scoreboard not found');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'rooms/control.html')));
  }

  const phoenixRoomRoute = url.match(/^\/room\/([a-f0-9]{32})\/phoenix$/);
  if (req.method === 'GET' && phoenixRoomRoute) {
    if (!pool) return publicError(res, 503, 'Personal scoreboards require a configured PostgreSQL database');
    const state = await getBoard(`room:${phoenixRoomRoute[1]}`);
    if (!state) return publicError(res, 404, 'Scoreboard not found');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'overlays/phoenix-overlay.html')));
  }

  const phoenixUpgRoomRoute = url.match(/^\/room\/([a-f0-9]{32})\/phoenix-upg$/);
  if (req.method === 'GET' && phoenixUpgRoomRoute) {
    if (!pool) return publicError(res, 503, 'Personal scoreboards require a configured PostgreSQL database');
    const state = await getBoard(`room:${phoenixUpgRoomRoute[1]}`);
    if (!state) return publicError(res, 404, 'Scoreboard not found');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'overlays/phoenix-upg.html')));
  }

  const roomRoute = url.match(/^\/room\/([a-f0-9]{32})\/(default|halloween|champions|default-left|halloween-left|chupapi-v1|chupapi-v2|mancity|hetra-zidana|brofist|black98|adrian-v1|adrian-v2|donetsk1y)(\/results)?$/);
  if (req.method === 'GET' && roomRoute) {
    if (!pool) return publicError(res, 503, 'Personal scoreboards require a configured PostgreSQL database');
    const state = await getBoard(`room:${roomRoute[1]}`);
    if (!state) return publicError(res, 404, 'Scoreboard not found');
    const overlay = roomRoute[3] ? 'results' : ['default-left', 'halloween-left', 'chupapi-v1', 'chupapi-v2', 'mancity', 'hetra-zidana', 'brofist', 'black98', 'adrian-v1', 'adrian-v2', 'donetsk1y'].includes(roomRoute[2]) ? roomRoute[2] : roomRoute[2] === 'halloween' ? 'halloween' : 'default';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, `overlays/${overlay}.html`)));
  }

  const roomAction = url.match(/^\/api\/rooms\/([a-f0-9]{64})\/(win|loss|undo|reset|set)$/);
  if (req.method === 'POST' && roomAction) {
    if (!pool) return publicError(res, 503, 'Personal scoreboards require a configured PostgreSQL database');
    const hash = crypto.createHash('sha256').update(roomAction[1]).digest('hex');
    const { rows } = await pool.query('SELECT id, password_salt, password_hash FROM scoreboards WHERE control_hash = $1', [hash]);
    if (!rows[0] || !rows[0].password_hash) return publicError(res, 401, 'Invalid control link');
    if (!verifyPassword(req.headers['x-scoreboard-password'], rows[0].password_salt, rows[0].password_hash)) {
      return publicError(res, 401, 'Incorrect scoreboard password');
    }
    const state = await applyAction(rows[0].id, roomAction[2], new URLSearchParams(query));
    if (!state) return publicError(res, 404, 'Scoreboard not found');
    sendBoardUpdate(rows[0].id, state);
    return sendJson(res, 200, state);
  }

  const roomChampionsResult = url.match(/^\/api\/rooms\/([a-f0-9]{64})\/champions-result$/);
  if (req.method === 'POST' && roomChampionsResult) {
    if (!pool) return publicError(res, 503, 'Personal scoreboards require a configured PostgreSQL database');
    const hash = crypto.createHash('sha256').update(roomChampionsResult[1]).digest('hex');
    const { rows } = await pool.query('SELECT id, password_salt, password_hash FROM scoreboards WHERE control_hash = $1', [hash]);
    if (!rows[0] || !rows[0].password_hash) return publicError(res, 401, 'Invalid control link');
    if (!verifyPassword(req.headers['x-scoreboard-password'], rows[0].password_salt, rows[0].password_hash)) {
      return publicError(res, 401, 'Incorrect scoreboard password');
    }
    const state = await addChampionsResult(rows[0].id);
    if (state === false) return publicError(res, 400, 'Record at least one win or loss before adding a Champions result');
    if (!state) return publicError(res, 404, 'Scoreboard not found');
    sendBoardUpdate(rows[0].id, state);
    return sendJson(res, 200, state);
  }

  const roomClearChampionsResults = url.match(/^\/api\/rooms\/([a-f0-9]{64})\/champions-results\/clear$/);
  if (req.method === 'POST' && roomClearChampionsResults) {
    if (!pool) return publicError(res, 503, 'Personal scoreboards require a configured PostgreSQL database');
    const hash = crypto.createHash('sha256').update(roomClearChampionsResults[1]).digest('hex');
    const { rows } = await pool.query('SELECT id, password_salt, password_hash FROM scoreboards WHERE control_hash = $1', [hash]);
    if (!rows[0] || !rows[0].password_hash) return publicError(res, 401, 'Invalid control link');
    if (!verifyPassword(req.headers['x-scoreboard-password'], rows[0].password_salt, rows[0].password_hash)) {
      return publicError(res, 401, 'Incorrect scoreboard password');
    }
    const state = await clearChampionsResults(rows[0].id);
    if (!state) return publicError(res, 404, 'Scoreboard not found');
    sendBoardUpdate(rows[0].id, state);
    return sendJson(res, 200, state);
  }

  const roomViewDetails = url.match(/^\/api\/rooms\/by-view\/([a-f0-9]{32})$/);
  if (req.method === 'GET' && roomViewDetails) {
    if (!pool) return publicError(res, 503, 'Personal scoreboards require a configured PostgreSQL database');
    const { rows } = await pool.query(
      'SELECT id, view_id, name, wins, losses, history, champions_results, password_salt, password_hash FROM scoreboards WHERE view_id = $1',
      [roomViewDetails[1]],
    );
    if (!rows[0]) return publicError(res, 404, 'Scoreboard not found');
    if (!rows[0].password_hash) return publicError(res, 428, 'This older scoreboard has no password. Open its saved private control link to set one.');
    if (!verifyPassword(req.headers['x-scoreboard-password'], rows[0].password_salt, rows[0].password_hash)) {
      return publicError(res, 401, 'Incorrect scoreboard password');
    }
    return sendJson(res, 200, {
      ...normalizeBoard(rows[0]),
      viewId: rows[0].view_id,
      overlays: roomOverlayLinks(rows[0].view_id, '', ROOM_OVERLAY_THEMES),
      resultOverlays: roomOverlayLinks(rows[0].view_id, '/results'),
    });
  }

  const roomViewAction = url.match(/^\/api\/rooms\/by-view\/([a-f0-9]{32})\/(win|loss|undo|reset|set)$/);
  if (req.method === 'POST' && roomViewAction) {
    if (!pool) return publicError(res, 503, 'Personal scoreboards require a configured PostgreSQL database');
    const { rows } = await pool.query(
      'SELECT id, password_salt, password_hash FROM scoreboards WHERE view_id = $1',
      [roomViewAction[1]],
    );
    if (!rows[0]) return publicError(res, 404, 'Scoreboard not found');
    if (!rows[0].password_hash) return publicError(res, 428, 'This older scoreboard has no password. Open its saved private control link to set one.');
    if (!verifyPassword(req.headers['x-scoreboard-password'], rows[0].password_salt, rows[0].password_hash)) {
      return publicError(res, 401, 'Incorrect scoreboard password');
    }
    const state = await applyAction(rows[0].id, roomViewAction[2], new URLSearchParams(query));
    if (!state) return publicError(res, 404, 'Scoreboard not found');
    sendBoardUpdate(rows[0].id, state);
    return sendJson(res, 200, state);
  }

  const roomViewChampionsResult = url.match(/^\/api\/rooms\/by-view\/([a-f0-9]{32})\/champions-result$/);
  if (req.method === 'POST' && roomViewChampionsResult) {
    if (!pool) return publicError(res, 503, 'Personal scoreboards require a configured PostgreSQL database');
    const { rows } = await pool.query(
      'SELECT id, password_salt, password_hash FROM scoreboards WHERE view_id = $1',
      [roomViewChampionsResult[1]],
    );
    if (!rows[0]) return publicError(res, 404, 'Scoreboard not found');
    if (!rows[0].password_hash) return publicError(res, 428, 'This older scoreboard has no password. Open its saved private control link to set one.');
    if (!verifyPassword(req.headers['x-scoreboard-password'], rows[0].password_salt, rows[0].password_hash)) {
      return publicError(res, 401, 'Incorrect scoreboard password');
    }
    const state = await addChampionsResult(rows[0].id);
    if (state === false) return publicError(res, 400, 'Record at least one win or loss before adding a Champions result');
    if (!state) return publicError(res, 404, 'Scoreboard not found');
    sendBoardUpdate(rows[0].id, state);
    return sendJson(res, 200, state);
  }

  const roomViewClearChampionsResults = url.match(/^\/api\/rooms\/by-view\/([a-f0-9]{32})\/champions-results\/clear$/);
  if (req.method === 'POST' && roomViewClearChampionsResults) {
    if (!pool) return publicError(res, 503, 'Personal scoreboards require a configured PostgreSQL database');
    const { rows } = await pool.query(
      'SELECT id, password_salt, password_hash FROM scoreboards WHERE view_id = $1',
      [roomViewClearChampionsResults[1]],
    );
    if (!rows[0]) return publicError(res, 404, 'Scoreboard not found');
    if (!rows[0].password_hash) return publicError(res, 428, 'This older scoreboard has no password. Open its saved private control link to set one.');
    if (!verifyPassword(req.headers['x-scoreboard-password'], rows[0].password_salt, rows[0].password_hash)) {
      return publicError(res, 401, 'Incorrect scoreboard password');
    }
    const state = await clearChampionsResults(rows[0].id);
    if (!state) return publicError(res, 404, 'Scoreboard not found');
    sendBoardUpdate(rows[0].id, state);
    return sendJson(res, 200, state);
  }

  const legacyApi = url.match(/^\/api\/(?:(halloween|default|champions)\/)?(win|loss|undo|reset|set|check)$/);
  if (req.method === 'POST' && legacyApi) {
    if (PASSWORD && req.headers['x-password'] !== PASSWORD) { res.writeHead(401); return res.end(); }
    const slug = 'default';
    const boardId = legacyBoardIds[slug];
    const state = await applyAction(boardId, legacyApi[2], new URLSearchParams(query));
    if (!state) return publicError(res, 404, 'Scoreboard not found');
    sendBoardUpdate(boardId, state);
    return sendJson(res, 200, state);
  }

  if (req.method === 'GET' && pages[url]) {
    if (url.startsWith('/preview/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(PUBLIC_DIR, pages[url])));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, pages[url])));
  }

  if (req.method === 'GET' && url === '/examples/champions-results.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'examples/champions-results.json')));
  }

  if (req.method === 'GET' && (url === '/bird.png' || url === '/assets/bird.png')) {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'assets/bird.png')));
  }

  if (req.method === 'GET' && url === '/assets/phoenix.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'assets/phoenix.png')));
  }

  const chupapiV2Asset = url.match(/^\/assets\/chupapi-v2\/(chupapi-base|chupapi-base-with-logo|chupapi-logo-v2|chupapi-progress-line)\.png$/);
  if (req.method === 'GET' && chupapiV2Asset) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, `assets/chupapi-v2/${chupapiV2Asset[1]}.png`)));
  }

  if (req.method === 'GET' && url === '/assets/hetra/zidane-cut.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'assets/hetra/zidane-cut.png')));
  }

  const hetraAsset = url.match(/^\/assets\/hetra\/(sock-white|sock-gold|sock-blue)\.png$/);
  if (req.method === 'GET' && hetraAsset) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, `assets/hetra/${hetraAsset[1]}.png`)));
  }

  const brofistAsset = url.match(/^\/assets\/brofist\/(man|fist|ball)\.png$/);
  if (req.method === 'GET' && brofistAsset) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, `assets/brofist/${brofistAsset[1]}.png`)));
  }

  if (req.method === 'GET' && url === '/assets/black98/logo.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'assets/black98/logo.png')));
  }

  const adrianV2Asset = url.match(/^\/assets\/adrian-v2\/(logo|shark-big|shark-small)\.png$/);
  if (req.method === 'GET' && adrianV2Asset) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, `assets/adrian-v2/${adrianV2Asset[1]}.png`)));
  }

  if (req.method === 'GET' && url === '/assets/adrian-v1/parrot.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'assets/adrian-v1/parrot.png')));
  }

  const donetskAsset = url.match(/^\/assets\/donetskiy\/(bg-shahtar\.png|shahtar_logo\.svg\.webp)$/);
  if (req.method === 'GET' && donetskAsset) {
    res.writeHead(200, { 'Content-Type': donetskAsset[1].endsWith('.webp') ? 'image/webp' : 'image/png', 'Cache-Control': 'no-cache' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, `assets/donetskiy/${donetskAsset[1]}`)));
  }

  if (req.method === 'GET' && url === '/assets/mancity_logo.webp') {
    res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'no-cache' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'assets/mancity_logo.webp')));
  }

  if (req.method === 'GET' && url === '/assets/mancity_ship.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'assets/mancity_ship.png')));
  }

  if (req.method === 'GET' && url === '/assets/chupapi_logo.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'assets/chupapi_logo.png')));
  }
  if (req.method === 'GET' && url === '/assets/halloween-pumpkin.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'assets/Halloween pumpkin.png')));
  }

  if (req.method === 'GET' && url === '/assets/FUT_Champions_CUP.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'assets/FUT_Champions_CUP.png')));
  }

  if (req.method === 'GET' && url === '/assets/FONTS/CruyffSans-Bold.ecd5078c.otf') {
    res.writeHead(200, { 'Content-Type': 'font/otf', 'Cache-Control': 'public, max-age=86400' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'assets/FONTS/CruyffSans-Bold.ecd5078c.otf')));
  }

  const phoenixWing = url.match(/^\/assets\/phoenix-wings\/(wing\d+\.png)$/);
  if (req.method === 'GET' && phoenixWing) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'assets/phoenix-wings', phoenixWing[1])));
  }

  if (req.method === 'GET' && url === '/assets/phoenix_logo.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'assets/phoenix_logo.png')));
  }

  if (req.method === 'GET' && url === '/assets/phoenix_upg.gif') {
    res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'public, max-age=86400' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'assets/phoenix_upg.gif')));
  }

  if (req.method === 'GET' && url === '/assets/ComfyUI_00002_.mp4') {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'public, max-age=86400' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'assets/ComfyUI_00002_.mp4')));
  }

  if (req.method === 'GET' && url === '/assets/Happy%20Holidays.gif') {
    res.writeHead(200, { 'Content-Type': 'image/gif' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'assets/Happy Holidays.gif')));
  }

  res.writeHead(404); res.end();
}

async function start() {
  if (pool) {
    pool.on('error', error => console.error('Unexpected PostgreSQL pool error:', error));
    await initializeDatabase();
  } else {
    console.warn('DATABASE_URL is not set; using local JSON files. Render deployments need PostgreSQL for durable scores.');
  }
  http.createServer((req, res) => {
    handleRequest(req, res).catch(error => {
      console.error(`Request failed for ${req.method} ${req.url}:`, error);
      if (!res.headersSent) publicError(res, 500, 'The request could not be completed');
      else res.destroy(error);
    });
  }).listen(PORT, () => {
    console.log(`Widget selector: http://localhost:${PORT}/`);
    console.log(`Halloween overlay: http://localhost:${PORT}/halloween`);
    console.log(`Default overlay: http://localhost:${PORT}/default`);
    console.log(`Control panel (all overlays): http://localhost:${PORT}/default/control`);
    console.log(`Create a personal scoreboard: http://localhost:${PORT}/new`);
  });
}

start().catch(error => {
  console.error('Unable to start the server:', error);
  process.exitCode = 1;
});
