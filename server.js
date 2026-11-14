'use strict';
/* ============================================================================
   SPEEDRUN: ESCAPE FROM TSUNAMI - Multiplayer backend (server.js LITE)
   - WebSocket relay + room manager (HOST AUTHORITY: the host runs the game
     simulation, this server only manages rooms and forwards messages).
   - Also serves index.html so ONE deployment (one URL) hosts game + backend.
   - Rooms are in memory (a restart closes live rooms), but accounts + the GLOBAL LEADERBOARD live in PostgreSQL
     (DATABASE_URL, see db.js / README). No secrets are stored in the source code.
   Run:  npm install && npm start
   ========================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const db = require('./db');
const auth = require('./auth');
const tour = require('./tournament');

/* ---------------- configuration (all via environment variables) ---------------- */
function envInt(name, def, min, max) {
  const v = parseInt(process.env[name], 10);
  if (!Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, v));
}
const PORT = envInt('PORT', 3000, 1, 65535);
const HOST = '0.0.0.0';                                    // required by most hosting platforms
const MAX_PLAYERS_CAP = envInt('MAX_PLAYERS', 8, 2, 8);     // the game supports max 8 runners
const MAX_ROOMS = envInt('MAX_ROOMS', 300, 1, 100000);
const MAX_CONN_PER_IP = envInt('MAX_CONN_PER_IP', 40, 1, 10000);   // generous: mobile carriers share IPs (CGNAT)
const GRACE_MS = envInt('RECONNECT_GRACE_MS', 15000, 0, 120000);   // slot is kept this long after a connection drop
const MAX_MSG_BYTES = envInt('MAX_MSG_BYTES', 64 * 1024, 1024, 1024 * 1024);
const HEARTBEAT_MS = envInt('HEARTBEAT_MS', 15000, 2000, 120000);
const MSG_RATE = envInt('MSG_RATE_PER_SEC', 120, 10, 2000); // sustained messages / second / connection
const MSG_BURST = MSG_RATE * 2;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean); // empty = allow all
const TRUST_PROXY = process.env.TRUST_PROXY !== '0';        // read client IP from X-Forwarded-For (hosting reverse proxy)
const ROOT = __dirname;

/* ---------------- constants ---------------- */
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';     // no 0/O/1/I
const ID_LEN = 6;
const STATUSES = new Set(['waiting', 'starting', 'playing']);
/* Message types the game is allowed to relay (everything else is dropped). */
const GUEST_TYPES = new Set(['hello', 'p', 'chat', 'cc', 'gc', 'mc', 'ham', 'ping', 'bye']);
const HOST_TYPES = new Set(['lobby', 'welcome', 'full', 'chat', 'scm', 'left', 'start', 'late', 'wait', 's',
  'co', 'go', 'mo', 'gr', 'mr', 'bonk', 'stun', 'end', 'final', 'toLobby', 'pong']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.css': 'text/css; charset=utf-8'
};

/* ---------------- state (in-memory) ---------------- */
const rooms = new Map();       // id -> room
const ipCount = new Map();     // ip -> open connections
const startedAt = Date.now();

/* room = { id, name, pub, max, status, mode, map, hostName,
            host: { cid, ws, timer, userId }, members: Map(cid -> { cid, ws, timer, userId }), created,
            pidMap: Map(game player id -> cid), tour: tournament tracker (see tournament.js) } */

/* ---------------- helpers ---------------- */
function now() { return Date.now(); }
function log() { console.log('[' + new Date().toISOString() + ']', ...arguments); }

function cleanText(s, max, fallback) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  return s || fallback || '';
}
function validCid(c) { return typeof c === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(c); }
function normId(v) { return String(v == null ? '' : v).trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }

function genId() {
  for (let tries = 0; tries < 50; tries++) {
    let s = '';
    for (let i = 0; i < ID_LEN; i++) s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
    if (!rooms.has(s)) return s;
  }
  return null;
}

function send(ws, obj) {
  if (!ws || ws.readyState !== 1) return false;
  if (ws.bufferedAmount > 4 * 1024 * 1024) { try { ws.terminate(); } catch (e) { /* ignore */ } return false; } // hopelessly slow client
  try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
}
function sendErr(ws, code, msg) { send(ws, { k: 'err', code, msg }); }

function playerCount(room) { return 1 + room.members.size; }
function roomStatus(room) { return playerCount(room) >= room.max ? 'full' : room.status; }
function roomInfo(room) {
  return { id: room.id, name: room.name, host: room.hostName, players: playerCount(room), max: room.max,
    status: roomStatus(room), mode: room.mode, map: room.map };
}
function publicList() {
  const out = [];
  for (const room of rooms.values()) {
    if (!room.pub || !room.host.ws) continue;            // private or host offline -> never listed
    out.push(roomInfo(room));
  }
  out.sort((a, b) => (a.status === 'full') - (b.status === 'full') || b.players - a.players || a.name.localeCompare(b.name));
  return out.slice(0, 60);
}

function removeMember(room, cid, notifyHost, reason) {
  const m = room.members.get(cid);
  if (!m) return;
  clearTimeout(m.timer);
  room.members.delete(cid);
  if (m.ws && m.ws.ctx) { m.ws.ctx.room = null; m.ws.ctx.role = null; }
  if (reason && m.ws) send(m.ws, { k: reason });
  if (notifyHost) send(room.host.ws, { k: 'gone', c: cid });
}

function closeRoom(room, reason) {
  if (rooms.get(room.id) !== room) return;
  rooms.delete(room.id);
  clearTimeout(room.host.timer);
  for (const m of room.members.values()) {
    clearTimeout(m.timer);
    if (m.ws && m.ws.ctx) { m.ws.ctx.room = null; m.ws.ctx.role = null; }
    send(m.ws, { k: 'hostleft', why: reason || 'closed' });
  }
  room.members.clear();
  if (room.host.ws && room.host.ws.ctx) { room.host.ws.ctx.room = null; room.host.ws.ctx.role = null; }
  log('room closed', room.id, reason || '');
}

/* A connection leaves whatever room it is in (explicit leave, or switching rooms). */
function leaveRoom(ws, explicit) {
  const ctx = ws.ctx;
  const room = ctx && ctx.room;
  if (!room) return;
  if (ctx.role === 'host') {
    if (room.host.ws === ws) closeRoom(room, 'host_left');
  } else if (ctx.role === 'guest') {
    const m = room.members.get(ctx.cid);
    if (m && m.ws === ws) removeMember(room, ctx.cid, true);
  }
  ctx.room = null; ctx.role = null;
}

/* Unexpected socket close: keep the slot for GRACE_MS so the player can reconnect seamlessly. */
function onSocketClosed(ws) {
  const ctx = ws.ctx;
  if (!ctx) return;
  const room = ctx.room;
  if (!room) return;
  if (ctx.role === 'host') {
    if (room.host.ws !== ws) return;                      // already replaced by a newer connection
    room.host.ws = null;
    for (const m of room.members.values()) send(m.ws, { k: 'hostdown' });
    clearTimeout(room.host.timer);
    room.host.timer = setTimeout(() => closeRoom(room, 'host_timeout'), GRACE_MS);
  } else if (ctx.role === 'guest') {
    const m = room.members.get(ctx.cid);
    if (!m || m.ws !== ws) return;
    m.ws = null;
    clearTimeout(m.timer);
    m.timer = setTimeout(() => removeMember(room, m.cid, true), GRACE_MS);
  }
}

/* ---------------- message handlers ---------------- */
function takeToken(bucket, cost) {
  const t = now();
  bucket.tokens = Math.min(bucket.cap, bucket.tokens + (t - bucket.t) / 1000 * bucket.rate);
  bucket.t = t;
  if (bucket.tokens < cost) return false;
  bucket.tokens -= cost;
  return true;
}

function hCreate(ws, m) {
  const ctx = ws.ctx;
  if (!validCid(m.cid)) return sendErr(ws, 'bad_request', 'Invalid client identity.');
  if (now() - ctx.lastCreate < 2000) return sendErr(ws, 'rate', 'Please wait a moment before creating another server.');
  if (rooms.size >= MAX_ROOMS) return sendErr(ws, 'busy', 'The server is busy right now. Please try again later.');
  leaveRoom(ws, true);
  ctx.cid = m.cid;
  const id = genId();
  if (!id) return sendErr(ws, 'busy', 'Could not allocate a server ID. Try again.');
  ctx.lastCreate = now();
  const hostName = cleanText(m.hostName, 16, 'Host');
  const max = Math.min(MAX_PLAYERS_CAP, Math.max(2, parseInt(m.max, 10) || 4));
  const room = {
    id, name: cleanText(m.name, 24, hostName + "'s Server"), pub: m.pub !== false && m.pub !== 0 && m.pub !== 'private',
    max, status: 'waiting', mode: cleanText(m.mode, 24, 'Single Round'), map: cleanText(m.map, 24, ''), hostName,
    host: { cid: m.cid, ws, timer: null, userId: ctx.userId || null }, members: new Map(), created: now(), pidMap: new Map(), tour: null
  };
  rooms.set(id, room);
  ctx.room = room; ctx.role = 'host';
  log('room created', id, room.pub ? 'public' : 'private', 'max=' + max);
  send(ws, { k: 'created', id, name: room.name, pub: room.pub, max: room.max });
}

function hJoin(ws, m) {
  const ctx = ws.ctx;
  if (!validCid(m.cid)) return sendErr(ws, 'bad_request', 'Invalid client identity.');
  const id = normId(m.id);
  if (id.length < 4) return sendErr(ws, 'bad_id', 'Please enter a valid Server ID.');
  const room = rooms.get(id);
  if (!room) return sendErr(ws, 'not_found', 'Server not found. Check the ID or ask the host for a new one.');
  if (ctx.room === room && ctx.role === 'guest') return;           // duplicate join from the same socket
  /* The host can never also join as a guest in his own room (same identity twice). */
  if (room.host.cid === m.cid) return sendErr(ws, 'dup', 'You are already the host of this server.');
  const existing = room.members.get(m.cid);
  if (existing) {
    /* Same identity already in this room: this is a reconnect (or a second tab). The newest connection wins. */
    if (ctx.room && ctx.room !== room) leaveRoom(ws, true);
    clearTimeout(existing.timer);
    const old = existing.ws;
    existing.ws = ws;
    existing.userId = ctx.userId || null;
    if (old && old !== ws) {
      if (old.ctx) { old.ctx.room = null; old.ctx.role = null; }
      send(old, { k: 'kicked', why: 'dup' });
    }
    ctx.cid = m.cid; ctx.room = room; ctx.role = 'guest';
    return send(ws, { k: 'joined', id: room.id, name: room.name, pub: room.pub, max: room.max, host: room.hostName, resumed: true });
  }
  if (!room.host.ws) return sendErr(ws, 'host_down', 'The host is reconnecting. Please try again in a few seconds.');
  if (playerCount(room) >= room.max) return sendErr(ws, 'full', 'This server is full.');
  leaveRoom(ws, true);
  ctx.cid = m.cid;
  room.members.set(m.cid, { cid: m.cid, ws, timer: null, userId: ctx.userId || null });
  ctx.room = room; ctx.role = 'guest';
  send(ws, { k: 'joined', id: room.id, name: room.name, pub: room.pub, max: room.max, host: room.hostName, resumed: false });
  send(room.host.ws, { k: 'peer', c: m.cid });
}

function hResume(ws, m) {            // host reconnects to his own room
  const ctx = ws.ctx;
  if (!validCid(m.cid)) return sendErr(ws, 'bad_request', 'Invalid client identity.');
  const room = rooms.get(normId(m.id));
  if (!room || room.host.cid !== m.cid) return sendErr(ws, 'not_found', 'Your server no longer exists.');
  clearTimeout(room.host.timer);
  const old = room.host.ws;
  room.host.ws = ws;
  room.host.userId = ctx.userId || null;
  if (old && old !== ws) { if (old.ctx) { old.ctx.room = null; old.ctx.role = null; } send(old, { k: 'kicked', why: 'dup' }); }
  ctx.cid = m.cid; ctx.room = room; ctx.role = 'host';
  send(ws, { k: 'resumed', id: room.id, members: Array.from(room.members.keys()) });
  for (const mem of room.members.values()) send(mem.ws, { k: 'hostup' });
}

function hUpdate(ws, m) {
  const room = ws.ctx.room;
  if (!room || ws.ctx.role !== 'host' || room.host.ws !== ws) return;
  if (m.max != null) room.max = Math.min(MAX_PLAYERS_CAP, Math.max(2, parseInt(m.max, 10) || room.max));
  if (typeof m.status === 'string' && STATUSES.has(m.status)) room.status = m.status;
  if (m.mode != null) room.mode = cleanText(m.mode, 24, room.mode);
  if (m.map != null) room.map = cleanText(m.map, 24, '');
  if (m.hostName != null) room.hostName = cleanText(m.hostName, 16, room.hostName);
}

function validGame(d, allowed) {
  return d && typeof d === 'object' && !Array.isArray(d) && typeof d.t === 'string' && d.t.length <= 12 && allowed.has(d.t);
}

function hData(ws, m) {              // guest -> host
  const ctx = ws.ctx, room = ctx.room;
  if (!room || ctx.role !== 'guest') return;
  if (!validGame(m.d, GUEST_TYPES)) return;
  if (m.d.t === 'chat' && !takeToken(ctx.chat, 1)) return sendErr(ws, 'chat_rate', 'You are sending messages too fast.');
  send(room.host.ws, { k: 'data', c: ctx.cid, d: m.d });
}

function hostOnly(ws) {
  const room = ws.ctx.room;
  return (room && ws.ctx.role === 'host' && room.host.ws === ws) ? room : null;
}
function hTo(ws, m) {                // host -> one guest
  const room = hostOnly(ws); if (!room) return;
  if (!validGame(m.d, HOST_TYPES)) return;
  if (m.d.t === 'welcome') { try { tour.noteWelcome(room, String(m.c), m.d); } catch (e) { /* never break the relay */ } }
  const mem = room.members.get(String(m.c));
  if (mem) send(mem.ws, { k: 'data', d: m.d });
}
function hAll(ws, m) {               // host -> every guest (serialize once)
  const room = hostOnly(ws); if (!room) return;
  if (!validGame(m.d, HOST_TYPES)) return;
  try { watchTournament(room, m.d); } catch (e) { log('tournament watch error', e && e.message); }   // never breaks the relay
  const payload = JSON.stringify({ k: 'data', d: m.d });
  for (const mem of room.members.values()) {
    const w = mem.ws;
    if (w && w.readyState === 1 && w.bufferedAmount < 4 * 1024 * 1024) { try { w.send(payload); } catch (e) { /* ignore */ } }
  }
}
function hKick(ws, m) {
  const room = hostOnly(ws); if (!room) return;
  removeMember(room, String(m.c), false, 'kicked');
}
function hLeave(ws) { leaveRoom(ws, true); }
function hPing(ws, m) { send(ws, { k: 'pong', ts: typeof m.ts === 'number' ? m.ts : 0 }); }
function hList(ws) { send(ws, { k: 'list', rooms: publicList() }); }

/* ---------------- accounts over the WebSocket + Global Leaderboard PTS ---------------- */
/* The client sends its login token once per connection. The user id is taken from the signed token, never from the client. */
function hAuth(ws, m) {
  const ctx = ws.ctx;
  const uid = typeof m.tok === 'string' ? auth.verifyToken(m.tok) : null;
  ctx.userId = uid || null;
  const room = ctx.room;
  if (room && ctx.cid) {                                   // logged in / out while inside a room
    if (ctx.role === 'host' && room.host.ws === ws) room.host.userId = ctx.userId;
    else if (ctx.role === 'guest') { const mem = room.members.get(ctx.cid); if (mem && mem.ws === ws) mem.userId = ctx.userId; }
  }
  send(ws, { k: 'authed', ok: !!uid });
}

/* Called for every host -> guests broadcast. Only start / end / toLobby matter for the leaderboard. */
function watchTournament(room, d) {
  if (d.t === 'start') tour.onStart(room, d.info, now());
  else if (d.t === 'toLobby') room.tour = null;
  else if (d.t === 'end') {
    const st = tour.onEnd(room, d.tr, now());
    if (st) settleTournament(room, st);
  }
}
function wsOfCid(room, cid) {
  if (cid === room.host.cid) return room.host.ws;
  const mem = room.members.get(cid);
  return mem ? mem.ws : null;
}
/* A finished online tournament: add PTS to the accounts (database, idempotent) and tell each player. */
function settleTournament(room, st) {
  log('tournament finished', st.tournamentId, 'rounds=' + st.rounds, 'humans=' + st.humans, st.ok ? ('awards=' + st.awards.length) : 'not counted (too few humans)');
  if (!st.ok) return;
  const targets = st.awards.map(a => ({ a, ws: wsOfCid(room, a.cid) }));
  const guests = st.guests.map(g => wsOfCid(room, g.cid));
  for (const w of guests) send(w, { k: 'tnote', code: 'login' });
  if (!db.isReady()) { for (const t of targets) send(t.ws, { k: 'tnote', code: 'nodb' }); return; }
  (async () => {
    for (const t of targets) {
      try {
        const r = await db.awardTournament({ tournamentId: st.tournamentId, userId: t.a.userId, pts: t.a.pts,
          rounds: st.rounds, placings: t.a.placings, humans: st.humans });
        if (r.awarded) {
          lbCache.at = 0;                                  // leaderboard changed: next read is fresh
          send(t.ws, { k: 'tpts', gained: t.a.pts, total: r.total, rounds: st.rounds });
        } else if (r.reason === 'rate_limited') send(t.ws, { k: 'tnote', code: 'limit' });
      } catch (e) {
        log('award failed', t.a.userId, e && e.message);
        send(t.ws, { k: 'tnote', code: 'error' });
      }
    }
  })();
}

const HANDLERS = { create: hCreate, join: hJoin, resume: hResume, upd: hUpdate, data: hData, to: hTo, all: hAll,
  kick: hKick, leave: hLeave, ping: hPing, list: hList, auth: hAuth };

function onMessage(ws, raw, isBinary) {
  const ctx = ws.ctx;
  ws.alive = true;
  if (isBinary) return;
  if (!takeToken(ctx.rate, 1)) {                                   // flood protection
    ctx.strikes++;
    if (ctx.strikes === 1) sendErr(ws, 'rate', 'Too many messages. Slow down.');
    if (ctx.strikes > 300) { try { ws.close(1008, 'rate limit'); } catch (e) { /* ignore */ } }
    return;
  }
  if (ctx.strikes > 0 && ctx.rate.tokens > MSG_RATE) ctx.strikes = 0;
  let m;
  try { m = JSON.parse(raw.toString('utf8')); } catch (e) { return; }
  if (!m || typeof m !== 'object' || typeof m.k !== 'string') return;
  const h = HANDLERS[m.k];
  if (!h) return;
  try { h(ws, m); } catch (e) { log('handler error', m.k, e && e.message); }
}

/* ---------------- HTTP (static game files + health + account / leaderboard API) ---------------- */
function corsHeaders(req) {
  const origin = req.headers.origin;
  const h = { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '600', 'Vary': 'Origin' };
  if (ALLOWED_ORIGINS.length) { if (origin && ALLOWED_ORIGINS.includes(origin)) h['Access-Control-Allow-Origin'] = origin; }
  else h['Access-Control-Allow-Origin'] = '*';                       // tokens travel in a header (no cookies), so '*' is safe
  return h;
}
function sendJson(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' }, extra || {}));
  res.end(body);
}
function apiErr(req, res, code, errCode, msg) { sendJson(res, code, { ok: false, code: errCode, msg }, corsHeaders(req)); }
function readJson(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > max) { reject(new Error('too_big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new Error('bad_json')); } });
    req.on('error', reject);
  });
}
function bearerUser(req) {
  const h = String(req.headers.authorization || '');
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? auth.verifyToken(m[1]) : null;                           // user id string or null
}
function dbGate(req, res) {
  if (db.isReady() && auth.hasSecret()) return true;
  const st = db.status();
  if (!st.configured) {
    /* DATABASE_URL missing or malformed: tell the admin exactly what to do (players see the same plain sentence) */
    apiErr(req, res, 503, 'no_db', 'The Global Leaderboard is not set up on this server (no database configured). Admin: ' + (st.hint || 'set the DATABASE_URL environment variable and restart.'));
  } else {
    apiErr(req, res, 503, 'db_down', 'The leaderboard database is not reachable right now. Please try again in a moment.' + (st.hint ? ' (Admin: ' + st.hint + ')' : ''));
  }
  return false;
}

/* Top-100 cache: 3 s lifetime, concurrent requests share ONE query, and it is cleared whenever PTS change. */
const lbCache = { at: 0, data: null, pending: null };
const LB_TTL_MS = 3000;
async function leaderboardTop() {
  const t = now();
  if (lbCache.data && t - lbCache.at < LB_TTL_MS) return lbCache.data;
  if (lbCache.pending) return lbCache.pending;
  lbCache.pending = (async () => {
    try {
      const [top, total] = await Promise.all([db.topPlayers(100), db.rankedCount()]);
      lbCache.data = { top, total, updatedAt: new Date().toISOString() };
      lbCache.at = now();
      return lbCache.data;
    } finally { lbCache.pending = null; }
  })();
  return lbCache.pending;
}

async function handleApi(req, res, pathname, ip) {
  const cors = corsHeaders(req);
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (ALLOWED_ORIGINS.length && req.headers.origin && !ALLOWED_ORIGINS.includes(req.headers.origin)) return apiErr(req, res, 403, 'origin', 'Origin not allowed.');
  if (!auth.rateHit('api:' + ip, 240, 60000)) return apiErr(req, res, 429, 'rate', 'Too many requests. Please slow down.');
  try {
    /* ---- public: Top 100 (never contains players outside the Top 100) ---- */
    if (pathname === '/api/leaderboard' && req.method === 'GET') {
      if (!dbGate(req, res)) return;
      const d = await leaderboardTop();
      return sendJson(res, 200, { ok: true, top: d.top, total: d.total, updatedAt: d.updatedAt }, cors);
    }
    /* ---- my own rank + PTS (separate small request, needs login) ---- */
    if (pathname === '/api/leaderboard/me' && req.method === 'GET') {
      if (!dbGate(req, res)) return;
      const uid = bearerUser(req);
      if (!uid) return apiErr(req, res, 401, 'auth', 'Please log in again.');
      const [me, total] = await Promise.all([db.playerRank(uid), leaderboardTop().then(d => d.total)]);
      if (!me) return apiErr(req, res, 401, 'auth', 'Account not found. Please log in again.');
      return sendJson(res, 200, { ok: true, username: me.username, pts: me.pts, rank: me.rank, total }, cors);
    }
    if (pathname === '/api/auth/me' && req.method === 'GET') {
      if (!dbGate(req, res)) return;
      const uid = bearerUser(req);
      const u = uid ? await db.getUserById(uid) : null;
      if (!u) return apiErr(req, res, 401, 'auth', 'Please log in again.');
      return sendJson(res, 200, { ok: true, user: { id: String(u.id), username: u.username } }, cors);
    }
    if ((pathname === '/api/auth/register' || pathname === '/api/auth/login') && req.method === 'POST') {
      if (!dbGate(req, res)) return;
      let body;
      try { body = await readJson(req, 2048); } catch (e) { return apiErr(req, res, 400, 'bad_request', 'Invalid request.'); }
      const uc = auth.checkUsername(body.username);
      const pc = auth.checkPassword(body.password);
      if (pathname === '/api/auth/register') {
        if (!auth.rateHit('reg:' + ip, 10, 3600 * 1000)) return apiErr(req, res, 429, 'rate', 'Too many new accounts from this network. Try again later.');
        if (!uc.ok) return apiErr(req, res, 400, 'bad_username', uc.msg);
        if (!pc.ok) return apiErr(req, res, 400, 'bad_password', pc.msg);
        const hash = await auth.hashPassword(pc.value);
        try {
          const u = await db.createUser(uc.value, hash);
          return sendJson(res, 201, { ok: true, token: auth.makeToken(u.id), user: { id: String(u.id), username: u.username } }, cors);
        } catch (e) {
          if (e && e.code === 'TAKEN') return apiErr(req, res, 409, 'taken', 'That username is already taken.');
          throw e;
        }
      }
      /* login */
      if (!auth.rateHit('login:' + ip, 40, 15 * 60 * 1000)) return apiErr(req, res, 429, 'rate', 'Too many login attempts. Try again in a few minutes.');
      if (!uc.ok || !pc.ok) return apiErr(req, res, 401, 'bad_credentials', 'Wrong username or password.');
      if (!auth.rateHit('loginu:' + uc.value.toLowerCase(), 10, 15 * 60 * 1000)) return apiErr(req, res, 429, 'rate', 'Too many attempts for this account. Try again in a few minutes.');
      const u = await db.getUserByName(uc.value);
      let ok = false;
      if (u) ok = await auth.verifyPassword(pc.value, u.pass_hash); else await auth.burnTime(pc.value);
      if (!ok) return apiErr(req, res, 401, 'bad_credentials', 'Wrong username or password.');
      db.touchLogin(u.id);
      return sendJson(res, 200, { ok: true, token: auth.makeToken(u.id), user: { id: String(u.id), username: u.username } }, cors);
    }
    return apiErr(req, res, 404, 'not_found', 'Unknown API endpoint.');
  } catch (e) {
    if (e && e.code === 'NO_DB') return apiErr(req, res, 503, 'db_down', 'The leaderboard database is not reachable right now. Please try again in a moment.');
    log('api error', pathname, e && e.message);
    return apiErr(req, res, 500, 'server', 'Server error. Please try again.');
  }
}

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (pathname.startsWith('/api/') && pathname !== '/api/servers') {
    return handleApi(req, res, pathname, clientIp(req)).catch(e => { log('api crash', e && e.message); try { res.writeHead(500); res.end(); } catch (e2) { /* ignore */ } });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
  if (pathname === '/health') {
    const d = db.status();
    return sendJson(res, 200, { ok: true, uptime: Math.round((now() - startedAt) / 1000), rooms: rooms.size, clients: wss.clients.size,
      leaderboard: { configured: d.configured, ready: d.ready, source: d.source || null, ssl: d.ssl,
        players: d.info ? d.info.players : null, ranked: d.info ? d.info.ranked : null,
        problem: d.ready ? null : (d.configured ? 'cannot connect' : d.error || null), hint: d.ready ? null : (d.hint || null) } });   // raw driver text stays in the server log only
  }
  if (pathname === '/api/servers') return sendJson(res, 200, { servers: publicList() });
  if (pathname === '/') pathname = '/index.html';
  const name = pathname.slice(1);
  /* only flat files in the project root with a whitelisted extension (server.js, package.json, README.md etc. are never served) */
  const ext = path.extname(name).toLowerCase();
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name) || !MIME[ext]) { res.writeHead(404); return res.end('Not found'); }
  const file = path.join(ROOT, name);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[ext], 'Content-Length': st.size, 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
});

/* ---------------- WebSocket ---------------- */
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES, perMessageDeflate: false });

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim().slice(0, 64);
  }
  return req.socket.remoteAddress || '?';
}

server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return socket.destroy();
  }
  const ip = clientIp(req);
  if ((ipCount.get(ip) || 0) >= MAX_CONN_PER_IP) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, ws => { ws.ip = ip; wss.emit('connection', ws, req); });
});

wss.on('connection', ws => {
  const ip = ws.ip;
  ipCount.set(ip, (ipCount.get(ip) || 0) + 1);
  ws.alive = true;
  ws.ctx = {
    cid: null, room: null, role: null, strikes: 0, lastCreate: 0, userId: null,
    rate: { tokens: MSG_BURST, cap: MSG_BURST, rate: MSG_RATE, t: now() },
    chat: { tokens: 4, cap: 4, rate: 0.7, t: now() }              // chat: burst 4, then ~1 message / 1.4 s
  };
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (raw, isBinary) => onMessage(ws, raw, isBinary));
  ws.on('error', () => { /* handled by close */ });
  ws.on('close', () => {
    const c = (ipCount.get(ip) || 1) - 1;
    if (c <= 0) ipCount.delete(ip); else ipCount.set(ip, c);
    onSocketClosed(ws);
  });
  send(ws, { k: 'hi', v: 1, max: MAX_PLAYERS_CAP, grace: GRACE_MS });
});

/* heartbeat: ping every connection, drop the ones that did not answer since the last round */
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { try { ws.terminate(); } catch (e) { /* ignore */ } continue; }
    ws.alive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  }
}, HEARTBEAT_MS);

/* cleanup: safety net for rooms whose host is gone for longer than the grace time */
const sweeper = setInterval(() => {
  const t = now();
  for (const room of rooms.values()) {
    if (!room.host.ws && !room.host.timer) closeRoom(room, 'orphan');
    if (room.host.ws && room.host.ws.readyState > 1) closeRoom(room, 'dead_host');
    for (const m of room.members.values()) {
      if (!m.ws && !m.timer) removeMember(room, m.cid, true);
    }
    if (t - room.created > 24 * 3600 * 1000 && playerCount(room) <= 1) closeRoom(room, 'expired');
  }
}, 30000);

/* database (accounts + leaderboard). Never blocks the game server: it connects in the background and retries. */
db.init(secret => auth.setSecret(secret)).catch(e => log('db init error', e && e.message));
/* REQUIRE_DATABASE=true: refuse to start without a valid DATABASE_URL (hosting then shows the failure in its logs/status). Default: game still runs. */
if (String(process.env.REQUIRE_DATABASE || '').toLowerCase() === 'true' && db.configError()) {
  log('REQUIRE_DATABASE=true and ' + db.configError().error + ' Exiting.');
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  log('Speedrun multiplayer server listening on ' + HOST + ':' + PORT + ' (max ' + MAX_PLAYERS_CAP + ' players/room)');
});

function shutdown() {
  log('shutting down');
  clearInterval(heartbeat); clearInterval(sweeper);
  for (const ws of wss.clients) { try { ws.close(1001, 'server restart'); } catch (e) { /* ignore */ } }
  server.close(() => { db.close().finally(() => process.exit(0)); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', e => log('uncaughtException', e && e.stack || e));
process.on('unhandledRejection', e => log('unhandledRejection', e && e.stack || e));
