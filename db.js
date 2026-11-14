'use strict';
/* ============================================================================
   SPEEDRUN - PostgreSQL layer (permanent storage for accounts + Global Leaderboard)
   - Needs the DATABASE_URL environment variable (postgres://user:pass@host:5432/dbname).
   - Without DATABASE_URL the game + multiplayer still work, only the leaderboard/account
     endpoints answer "503 no_db" (nothing crashes).
   - The schema is created automatically (idempotent) the first time the server starts.
   ============================================================================ */
const crypto = require('crypto');

let Pool = null;
try { Pool = require('pg').Pool; } catch (e) { Pool = null; }

const dbcfg = require('./dbconfig');

/* Connection string: DATABASE_URL (or a common alternative name, see dbconfig.js). Cleaned + parsed once at startup. */
const found = dbcfg.findRaw(process.env);
const parsed = found ? dbcfg.parse(found.raw) : null;
const DATABASE_URL = found ? found.raw : '';                    // non-empty = the admin DID set something
const CONFIG_ERROR = !found
  ? { error: 'DATABASE_URL is not set.', hint: 'Add the environment variable DATABASE_URL on your hosting (value = connection string of your PostgreSQL database) and redeploy/restart. See README.' }
  : (parsed.ok ? null : { error: parsed.error, hint: parsed.hint });
const PG = parsed && parsed.ok ? parsed.cfg : null;
const SOURCE = found ? found.source : '';
const sslChoice = PG ? dbcfg.decideSsl(PG, process.env.DATABASE_SSL) : { ssl: false, auto: false, why: '' };
const POOL_MAX = Math.max(1, Math.min(50, parseInt(process.env.DATABASE_POOL_MAX, 10) || 10));

/* Anti-farming limits (rolling window, per account). Real tournaments take minutes, so normal players never hit them. */
const MAX_AWARDS_PER_HOUR = Math.max(1, parseInt(process.env.MAX_TOURNAMENTS_PER_HOUR, 10) || 12);
const MAX_AWARDS_PER_DAY = Math.max(1, parseInt(process.env.MAX_TOURNAMENTS_PER_DAY, 10) || 100);

let pool = null;
let ready = false;
let lastError = '';
let lastHint = '';
let info = null;                    // result of the last successful startup check (server version, tables, counts)
let sslNow = sslChoice.ssl;
let sslFlipped = false;
let initPromise = null;
let retryTimer = null;

function log() { console.log('[' + new Date().toISOString() + ']', ...arguments); }

const SCHEMA = [
  /* accounts. username_lower is the unique key (case-insensitive) so "Ali" and "ali" can never both exist. */
  `CREATE TABLE IF NOT EXISTS users (
     id            BIGSERIAL PRIMARY KEY,
     username      TEXT        NOT NULL,
     username_lower TEXT       NOT NULL UNIQUE,
     pass_hash     TEXT        NOT NULL,
     total_pts     INTEGER     NOT NULL DEFAULT 0 CHECK (total_pts >= 0),
     tournaments   INTEGER     NOT NULL DEFAULT 0,
     reached_at    TIMESTAMPTZ NOT NULL DEFAULT now(),   -- when total_pts last changed (tie-breaker: earlier = better rank)
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_login_at TIMESTAMPTZ
   )`,
  /* one row per (finished tournament, player). The UNIQUE key is what makes awarding idempotent. */
  `CREATE TABLE IF NOT EXISTS tournament_results (
     id            BIGSERIAL PRIMARY KEY,
     tournament_id TEXT        NOT NULL,
     user_id       BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     pts           INTEGER     NOT NULL CHECK (pts >= 0),
     rounds        SMALLINT    NOT NULL,
     placings      SMALLINT[]  NOT NULL,
     humans        SMALLINT    NOT NULL,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (tournament_id, user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS tournament_results_user_time_idx ON tournament_results (user_id, created_at DESC)`,
  /* the ranking index: ORDER BY total_pts DESC, reached_at ASC, id ASC (only players that have PTS) */
  `CREATE INDEX IF NOT EXISTS users_rank_idx ON users (total_pts DESC, reached_at ASC, id ASC) WHERE total_pts > 0`,
  /* small key/value table (used for the auto-generated token signing secret) */
  `CREATE TABLE IF NOT EXISTS app_secrets (
     k TEXT PRIMARY KEY,
     v TEXT NOT NULL
   )`
];

function enabled() { return !!DATABASE_URL; }
function isReady() { return ready; }
function configError() { return CONFIG_ERROR; }
function status() {
  return { configured: !!DATABASE_URL && !CONFIG_ERROR, envSet: !!DATABASE_URL, source: SOURCE, driver: !!Pool, ready,
    error: ready ? '' : (CONFIG_ERROR ? CONFIG_ERROR.error : lastError), hint: ready ? '' : (CONFIG_ERROR ? CONFIG_ERROR.hint : lastHint),
    ssl: !!sslNow, info };
}

function makePool() {
  const cfg = { host: PG.host, port: PG.port, user: PG.user, password: PG.password, database: PG.database,
    max: POOL_MAX, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000, keepAlive: true };
  if (PG.options) cfg.options = PG.options;
  cfg.ssl = sslNow;                                       // explicit object: never overridden by ?sslmode= in the URL
  const p = new Pool(cfg);
  p.on('error', e => { lastError = e && e.message || String(e); log('db pool error:', lastError); });
  return p;
}

async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(7351924601)');       // several instances may start at once; released at COMMIT
    for (const sql of SCHEMA) await client.query(sql);
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (e2) { /* ignore */ }
    throw e;
  } finally { client.release(); }
}

/* Returns the secret used to sign login tokens: AUTH_SECRET env var, otherwise a random one stored in the DB. */
async function getTokenSecret() {
  if (process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 16) return process.env.AUTH_SECRET;
  const fresh = crypto.randomBytes(32).toString('hex');
  await pool.query('INSERT INTO app_secrets (k, v) VALUES ($1, $2) ON CONFLICT (k) DO NOTHING', ['token_secret', fresh]);
  const r = await pool.query('SELECT v FROM app_secrets WHERE k = $1', ['token_secret']);
  return r.rows[0].v;
}

/* Opens a connection, proves the database answers, creates/updates the tables and reads them back.
   Returns facts for the startup log. Throws the driver error if anything fails. */
async function connectAndVerify() {
  const r = await pool.query('SELECT version() AS v, current_database() AS d, current_user AS u');
  await runMigrations();
  const t = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ANY($1)`, [['users', 'tournament_results', 'app_secrets']]);
  if (t.rows.length < 3) throw new Error('tables were not created (found ' + t.rows.map(x => x.table_name).join(',') + ')');
  const c = await pool.query('SELECT count(*)::int AS players, count(*) FILTER (WHERE total_pts > 0)::int AS ranked FROM users');
  await pool.query('SELECT username, total_pts FROM users WHERE total_pts > 0 ORDER BY total_pts DESC, reached_at ASC, id ASC LIMIT 100');   // the exact Top-100 query
  return { version: String(r.rows[0].v).split(',')[0], database: r.rows[0].d, user: r.rows[0].u, tables: t.rows.map(x => x.table_name).sort(),
    players: c.rows[0].players, ranked: c.rows[0].ranked };
}

/* Errors that mean "wrong SSL setting": in automatic mode we flip SSL once and try again immediately. */
function sslMismatch(msg) {
  return /does not support SSL|SSL off|wrong version number|ssl3_get_record|no pg_hba\.conf entry.*(?:SSL off|no encryption)|SSL\/TLS required|SSL (?:is )?required|self.signed|unable to verify/i.test(msg);
}

function logConfigProblem() {
  const line = '='.repeat(78);
  log('\n' + line + '\n  GLOBAL LEADERBOARD DISABLED: ' + CONFIG_ERROR.error + '\n  FIX: ' + CONFIG_ERROR.hint +
    '\n  (the game and multiplayer still work; only accounts + leaderboard are off)\n  Check after the fix: open  https://YOUR-URL/health  -> leaderboard.ready must be true\n' + line);
}

/* init(onReady): connects, verifies, migrates, then calls onReady(secret). Keeps retrying (5 s, growing to 30 s) if the DB is not reachable yet. */
function init(onReady) {
  if (CONFIG_ERROR) { logConfigProblem(); return Promise.resolve(false); }
  if (!Pool) { lastError = 'The "pg" package is not installed (run npm install).'; lastHint = dbcfg.diagnose(new Error(lastError), PG); log(lastError); return Promise.resolve(false); }
  if (initPromise) return initPromise;
  log('database: connecting to ' + PG.host + ':' + PG.port + '/' + PG.database + ' as ' + PG.user + ' (from ' + SOURCE + ', SSL ' + (sslNow ? 'on' : 'off') + ' - ' + sslChoice.why + ')');
  let tries = 0;
  initPromise = (async function attempt() {
    try {
      tries++;
      if (!pool) pool = makePool();
      info = await connectAndVerify();
      const secret = await getTokenSecret();
      ready = true; lastError = ''; lastHint = '';
      log('database READY: ' + info.version + ' | db=' + info.database + ' | tables=' + info.tables.join(',') + ' | players=' + info.players + ' ranked=' + info.ranked + ' | Global Leaderboard is ENABLED');
      if (onReady) onReady(secret);
      return true;
    } catch (e) {
      ready = false; lastError = (e && e.message) || String(e);
      if (!sslFlipped && sslChoice.auto && sslMismatch(lastError)) {      // wrong guess about SSL: flip it once and retry right away
        sslFlipped = true; sslNow = sslNow ? false : { rejectUnauthorized: false };
        log('database: SSL setting did not match (' + lastError + '); retrying with SSL ' + (sslNow ? 'on' : 'off'));
        try { await pool.end(); } catch (e2) { /* ignore */ }
        pool = null;
        return attempt();
      }
      lastHint = dbcfg.diagnose(e, PG);
      log('database NOT READY (attempt ' + tries + '): ' + lastError + '\n  -> ' + lastHint);
      await new Promise(r => { retryTimer = setTimeout(r, Math.min(30000, 5000 * tries)); });
      return attempt();
    }
  })();
  return initPromise;
}

/* One-shot check for "npm run db:check": never retries, never keeps the process alive. Returns { ok, ... }. */
async function check() {
  if (CONFIG_ERROR) return { ok: false, error: CONFIG_ERROR.error, hint: CONFIG_ERROR.hint };
  if (!Pool) return { ok: false, error: 'The "pg" package is not installed.', hint: dbcfg.diagnose(new Error('Cannot find module pg'), PG) };
  for (let pass = 0; pass < 2; pass++) {
    try {
      if (!pool) pool = makePool();
      const facts = await connectAndVerify();
      await getTokenSecret();
      await close();
      return Object.assign({ ok: true, ssl: !!sslNow, ssl_rule: sslChoice.why, host: PG.host, source: SOURCE }, facts);
    } catch (e) {
      const m = (e && e.message) || String(e);
      try { await pool.end(); } catch (e2) { /* ignore */ }
      pool = null;
      if (pass === 0 && !sslFlipped && sslChoice.auto && sslMismatch(m)) { sslFlipped = true; sslNow = sslNow ? false : { rejectUnauthorized: false }; continue; }
      return { ok: false, error: m, hint: dbcfg.diagnose(e, PG), host: PG.host, source: SOURCE };
    }
  }
}

function requireReady() {
  if (!ready) { const e = new Error('database unavailable'); e.code = 'NO_DB'; throw e; }
}

/* ---------------- accounts ---------------- */
async function createUser(username, passHash) {
  requireReady();
  try {
    const r = await pool.query(
      'INSERT INTO users (username, username_lower, pass_hash) VALUES ($1, $2, $3) RETURNING id, username',
      [username, username.toLowerCase(), passHash]);
    return r.rows[0];
  } catch (e) {
    if (e && e.code === '23505') { const err = new Error('username taken'); err.code = 'TAKEN'; throw err; }
    throw e;
  }
}
async function getUserByName(username) {
  requireReady();
  const r = await pool.query('SELECT id, username, pass_hash FROM users WHERE username_lower = $1', [String(username).toLowerCase()]);
  return r.rows[0] || null;
}
async function getUserById(id) {
  requireReady();
  const r = await pool.query('SELECT id, username FROM users WHERE id = $1', [id]);
  return r.rows[0] || null;
}
async function touchLogin(id) {
  if (!ready) return;
  try { await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]); } catch (e) { /* not important */ }
}
async function updatePassHash(id, hash) {
  if (!ready) return;
  try { await pool.query('UPDATE users SET pass_hash = $2 WHERE id = $1', [id, hash]); } catch (e) { /* not important */ }
}

/* ---------------- leaderboard reads ---------------- */
/* Top N (max 100). Order: total PTS (high first) -> who reached that total first -> account id. Always the same order. */
async function topPlayers(limit) {
  requireReady();
  const n = Math.max(1, Math.min(100, limit | 0 || 100));
  const r = await pool.query(
    'SELECT username, total_pts FROM users WHERE total_pts > 0 ORDER BY total_pts DESC, reached_at ASC, id ASC LIMIT $1', [n]);
  return r.rows.map((row, i) => ({ rank: i + 1, username: row.username, pts: row.total_pts }));
}
async function rankedCount() {
  requireReady();
  const r = await pool.query('SELECT count(*)::int AS n FROM users WHERE total_pts > 0');
  return r.rows[0].n;
}
/* Rank + PTS of ONE player (one small query, computed entirely inside the database so no timestamp precision is lost).
   rank is null when the player has 0 PTS (not ranked yet). */
async function playerRank(userId) {
  requireReady();
  const r = await pool.query(
    `WITH me AS (SELECT id, username, total_pts, reached_at FROM users WHERE id = $1)
     SELECT me.username, me.total_pts AS pts,
            CASE WHEN me.total_pts > 0 THEN
                 (SELECT count(*) FROM users u WHERE u.total_pts > me.total_pts)
               + (SELECT count(*) FROM users u WHERE u.total_pts = me.total_pts AND (u.reached_at, u.id) < (me.reached_at, me.id))
               + 1
            END AS rank
       FROM me`, [userId]);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return { username: row.username, pts: row.pts, rank: row.rank == null ? null : Number(row.rank) };
}

/* ---------------- awarding PTS (called ONLY by the server after a finished online Tournament) ---------------- */
/* Idempotent: the same (tournamentId, userId) can never be added twice (row lock + UNIQUE constraint, one transaction). */
async function awardTournament(o) {
  requireReady();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [o.userId]);
    if (!lock.rows.length) { await client.query('ROLLBACK'); return { awarded: false, reason: 'no_user' }; }
    const dup = await client.query('SELECT 1 FROM tournament_results WHERE tournament_id = $1 AND user_id = $2', [o.tournamentId, o.userId]);
    if (dup.rows.length) { await client.query('ROLLBACK'); return { awarded: false, reason: 'duplicate' }; }
    const lim = await client.query(
      `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS h,
              count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS d
         FROM tournament_results WHERE user_id = $1 AND created_at > now() - interval '24 hours'`, [o.userId]);
    if (lim.rows[0].h >= MAX_AWARDS_PER_HOUR || lim.rows[0].d >= MAX_AWARDS_PER_DAY) { await client.query('ROLLBACK'); return { awarded: false, reason: 'rate_limited' }; }
    await client.query(
      'INSERT INTO tournament_results (tournament_id, user_id, pts, rounds, placings, humans) VALUES ($1, $2, $3, $4, $5, $6)',
      [o.tournamentId, o.userId, o.pts, o.rounds, o.placings, o.humans]);
    const up = await client.query(
      'UPDATE users SET total_pts = total_pts + $2, tournaments = tournaments + 1, reached_at = now() WHERE id = $1 RETURNING total_pts',
      [o.userId, o.pts]);
    await client.query('COMMIT');
    return { awarded: true, total: up.rows[0].total_pts };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (e2) { /* ignore */ }
    if (e && e.code === '23505') return { awarded: false, reason: 'duplicate' };   // unique violation = already counted
    throw e;
  } finally { client.release(); }
}

async function close() {
  clearTimeout(retryTimer);
  if (pool) { const p = pool; pool = null; ready = false; try { await p.end(); } catch (e) { /* ignore */ } }
}

module.exports = {
  enabled, isReady, status, configError, init, check, close,
  createUser, getUserByName, getUserById, touchLogin, updatePassHash,
  topPlayers, rankedCount, playerRank, awardTournament
};
