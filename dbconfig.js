'use strict';
/* ============================================================================
   SPEEDRUN - database configuration helpers (no dependencies, unit-tested in test/config.js)
   - finds the connection string in the environment (DATABASE_URL first, then common alternative names)
   - cleans up what people paste (quotes, "DATABASE_URL=" prefix, Neon's  psql '...'  command, spaces)
   - parses it itself, so passwords with special characters (@ # / ? %) never break the connection
   - decides SSL automatically (ON for online databases, OFF for local ones) unless DATABASE_SSL says otherwise
   - turns raw driver errors into a plain-language hint (what to fix)
   ============================================================================ */

/* DATABASE_URL is the official name. The others are accepted because many hosting/database dashboards use them. */
const ENV_NAMES = ['DATABASE_URL', 'DATABASE_PRIVATE_URL', 'DATABASE_PUBLIC_URL', 'POSTGRES_URL', 'POSTGRESQL_URL',
  'POSTGRES_URI', 'POSTGRES_CONNECTION_STRING', 'POSTGRES_PRISMA_URL', 'NEON_DATABASE_URL', 'SUPABASE_DB_URL', 'DB_URL', 'PG_URL'];

const URL_RE = /postgres(?:ql)?:\/\/[^\s'"`]+/i;

/* Returns the usable connection string found in env, or null. { value, source } */
function findRaw(env) {
  env = env || process.env;
  for (const name of ENV_NAMES) {
    const v = env[name];
    if (typeof v === 'string' && v.trim()) return { raw: v, source: name };
  }
  /* standard libpq variables (PGHOST, PGUSER, PGPASSWORD, PGDATABASE, PGPORT) */
  if (env.PGHOST && env.PGDATABASE) {
    const enc = encodeURIComponent;
    const raw = 'postgres://' + enc(env.PGUSER || 'postgres') + (env.PGPASSWORD ? ':' + enc(env.PGPASSWORD) : '') + '@' +
      env.PGHOST + ':' + (env.PGPORT || 5432) + '/' + enc(env.PGDATABASE);
    return { raw, source: 'PGHOST/PGUSER/PGPASSWORD/PGDATABASE' };
  }
  return null;
}

/* "  DATABASE_URL = 'postgresql://...'  ",  "psql 'postgresql://...'",  "postgres://...\n"  ->  "postgresql://..." */
function clean(raw) {
  let s = String(raw == null ? '' : raw).replace(/^﻿/, '').trim();
  const m = URL_RE.exec(s);
  if (m) return m[0].replace(/[;,]+$/, '');
  return s.replace(/^[A-Z_]+\s*=\s*/, '').replace(/^['"`]+|['"`]+$/g, '').trim();
}

function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

/* Returns { ok:true, cfg:{host,port,user,password,database,options,sslmode}, } or { ok:false, error, hint } */
function parse(raw) {
  const s = clean(raw);
  if (!s) return { ok: false, error: 'DATABASE_URL is empty.', hint: 'Fill DATABASE_URL with the connection string from your PostgreSQL provider.' };
  if (/\[YOUR-PASSWORD\]|\[PASSWORD\]|<password>|\[YOUR_PASSWORD\]/i.test(s)) {
    return { ok: false, error: 'DATABASE_URL still contains the placeholder for the password.', hint: 'Replace [YOUR-PASSWORD] (including the brackets) with your real database password.' };
  }
  const m = /^postgres(?:ql)?:\/\/(?:([^:@\/?#]*)(?::(.*))?@)?([^@\/?#]*)(?:\/([^?#]*))?(?:\?(.*))?$/i.exec(s);
  if (!m) {
    return { ok: false, error: 'DATABASE_URL is not a valid PostgreSQL connection string.',
      hint: 'It must look like  postgresql://USER:PASSWORD@HOST/DBNAME  and start with postgres:// or postgresql://.' };
  }
  const hp = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(m[3] || '');
  if (!hp) return { ok: false, error: 'DATABASE_URL has no valid host.', hint: 'Copy the full connection string again from your database provider.' };
  const cfg = {
    user: safeDecode(m[1] || ''), password: safeDecode(m[2] || ''),
    host: hp[1].replace(/^\[|\]$/g, ''), port: hp[2] ? parseInt(hp[2], 10) : 5432,
    database: safeDecode(m[4] || ''), options: '', sslmode: ''
  };
  if (m[5]) for (const pair of m[5].split('&')) {
    const i = pair.indexOf('=');
    const k = (i < 0 ? pair : pair.slice(0, i)).toLowerCase(), v = i < 0 ? '' : safeDecode(pair.slice(i + 1));
    if (k === 'sslmode') cfg.sslmode = v.toLowerCase();
    else if (k === 'options') cfg.options = v;
  }
  if (/^(HOST|USER|PASSWORD|DBNAME|USERNAME)$/.test(cfg.host) || cfg.user === 'USER' || cfg.password === 'PASSWORD' || cfg.host === 'HOST') {
    return { ok: false, error: 'DATABASE_URL still contains the example values (USER / PASSWORD / HOST).', hint: 'Paste the real connection string from your database provider.' };
  }
  if (!cfg.host) return { ok: false, error: 'DATABASE_URL has no host.', hint: 'Copy the full connection string again from your database provider.' };
  if (!cfg.database) return { ok: false, error: 'DATABASE_URL has no database name at the end.', hint: 'The string must end with /DBNAME, for example .../neondb?sslmode=require' };
  if (!cfg.user) return { ok: false, error: 'DATABASE_URL has no username.', hint: 'The string must start with postgresql://USER:PASSWORD@...' };
  return { ok: true, cfg };
}

function isLocalHost(h) {
  h = String(h || '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || !h.includes('.')   // "db", "postgres" (docker / private network)
    || /\.(internal|local|svc|svc\.cluster\.local)$/.test(h);
}

/* Returns { ssl: false | {rejectUnauthorized:false}, auto: bool, why: string }
   Order: DATABASE_SSL env (true/false) -> ?sslmode= in the URL -> automatic (online host = SSL on, local host = off). */
function decideSsl(cfg, envValue) {
  const e = String(envValue || '').trim().toLowerCase();
  if (['true', '1', 'require', 'yes', 'on'].includes(e)) return { ssl: { rejectUnauthorized: false }, auto: false, why: 'DATABASE_SSL=true' };
  if (['false', '0', 'disable', 'no', 'off'].includes(e)) return { ssl: false, auto: false, why: 'DATABASE_SSL=false' };
  const sm = cfg.sslmode;
  if (sm === 'disable') return { ssl: false, auto: false, why: 'sslmode=disable' };
  if (['require', 'verify-ca', 'verify-full', 'prefer', 'allow'].includes(sm)) {
    return { ssl: { rejectUnauthorized: false }, auto: sm === 'prefer' || sm === 'allow', why: 'sslmode=' + sm };
  }
  const local = isLocalHost(cfg.host);
  return { ssl: local ? false : { rejectUnauthorized: false }, auto: true, why: local ? 'auto (local host: SSL off)' : 'auto (online host: SSL on)' };
}

/* Plain-language reason + what to do, from a driver error. Never includes the password. */
function diagnose(err, cfg) {
  const msg = String((err && err.message) || err || '');
  const code = String((err && err.code) || '');
  const host = cfg && cfg.host || '';
  if (code === '28P01' || /password authentication failed/i.test(msg)) return 'Wrong password (or username) in DATABASE_URL. Copy the connection string again from the database dashboard; if you reset the password, update DATABASE_URL too.';
  if (code === '28000' || /role ".*" does not exist/i.test(msg)) return 'The database username in DATABASE_URL does not exist. Copy the connection string again from the database dashboard.';
  if (code === '3D000' || /database ".*" does not exist/i.test(msg)) return 'The database name at the end of DATABASE_URL does not exist. Check the name in the database dashboard.';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo/i.test(msg)) {
    return 'The database host "' + host + '" cannot be found. Check for typos in DATABASE_URL.' + (/supabase\.co$/i.test(host) && /^db\./i.test(host) ? ' Supabase "direct connection" hosts are IPv6-only: use the "Session pooler" connection string instead, or use Neon.' : '');
  }
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return 'The database host is not reachable from this server (often an IPv6-only address). Use the IPv4 / pooler connection string from your database provider.';
  if (code === 'ECONNREFUSED') return isLocalHost(host) ? 'DATABASE_URL points to "' + host + '" (a local database) but none is running there. On hosting you must use the ONLINE connection string from Neon/Supabase/etc., not localhost.' : 'The database refused the connection. Check host and port in DATABASE_URL and that the database is running.';
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || /timeout|timed out|terminated unexpectedly/i.test(msg)) return 'The database did not answer in time. Free databases may be asleep (retrying wakes them) or the host/port is wrong. If it keeps failing, check host and port in DATABASE_URL.';
  if (/no pg_hba\.conf entry|SSL\/TLS required|SSL (?:is )?required|connection is insecure/i.test(msg)) return 'The database requires SSL. Set the environment variable DATABASE_SSL=true.';
  if (/does not support SSL|SSL off|wrong version number|ssl3_get_record/i.test(msg)) return 'The database does not accept SSL. Set the environment variable DATABASE_SSL=false.';
  if (/self.signed|certificate|SSL/i.test(msg)) return 'SSL problem while connecting. Set DATABASE_SSL=true (or false for a local database).';
  if (code === '53300' || /too many (?:connections|clients)|remaining connection slots/i.test(msg)) return 'The database has too many open connections. Set DATABASE_POOL_MAX=3 (free plans allow very few).';
  if (code === '42501' || /permission denied/i.test(msg)) return 'The database user is not allowed to create tables. Use the main/owner connection string of the database.';
  if (code === '57P03' || /starting up|shutting down/i.test(msg)) return 'The database is starting up. It will be retried automatically.';
  if (/pg" package is not installed|Cannot find module/i.test(msg)) return 'Dependencies are not installed. Run "npm install" (hosting does this automatically when the build command is "npm install").';
  return 'Unexpected database error. See the server log line above for details.';
}

module.exports = { ENV_NAMES, findRaw, clean, parse, decideSsl, diagnose, isLocalHost };
