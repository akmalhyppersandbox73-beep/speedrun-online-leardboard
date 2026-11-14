'use strict';
/* ============================================================================
   SPEEDRUN - accounts: username/password validation, scrypt hashing, signed login tokens
   (Node built-in crypto only, no extra dependency)
   ============================================================================ */
const crypto = require('crypto');

const TOKEN_TTL_MS = 90 * 24 * 3600 * 1000;      // a login stays valid for 90 days
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const PASS_MIN = 6, PASS_MAX = 72;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

let secret = null;                                 // set by setSecret() once the DB is ready
function setSecret(s) { secret = Buffer.from(String(s), 'utf8'); }
function hasSecret() { return !!secret; }

function checkUsername(u) {
  u = String(u == null ? '' : u).trim();
  if (!USERNAME_RE.test(u)) return { ok: false, msg: 'Username must be 3-16 characters: letters, numbers or underscore.' };
  return { ok: true, value: u };
}
function checkPassword(p) {
  p = String(p == null ? '' : p);
  if (p.length < PASS_MIN) return { ok: false, msg: 'Password must be at least ' + PASS_MIN + ' characters.' };
  if (p.length > PASS_MAX) return { ok: false, msg: 'Password is too long (max ' + PASS_MAX + ').' };
  return { ok: true, value: p };
}

function scryptAsync(password, salt, keylen, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, opts, (err, key) => err ? reject(err) : resolve(key));
  });
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}
async function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = parseInt(parts[1], 10), r = parseInt(parts[2], 10), p = parseInt(parts[3], 10);
    const salt = Buffer.from(parts[4], 'base64'), want = Buffer.from(parts[5], 'base64');
    const got = await scryptAsync(password, salt, want.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch (e) { return false; }
}
/* a fixed hash used to burn the same time when the username does not exist (no user enumeration by timing) */
let dummyHash = null;
async function burnTime(password) {
  if (!dummyHash) dummyHash = await hashPassword('dummy-password-for-timing');
  await verifyPassword(password, dummyHash);
}

function b64u(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function sign(data) { return b64u(crypto.createHmac('sha256', secret).update(data).digest()); }

/* token = base64url(JSON{u: userId, e: expiry}) + "." + HMAC. Stateless: verifying it never touches the database. */
function makeToken(userId) {
  if (!secret) return null;
  const body = b64u(JSON.stringify({ u: String(userId), e: Date.now() + TOKEN_TTL_MS }));
  return body + '.' + sign(body);
}
/* returns the user id (string of digits) or null */
function verifyToken(tok) {
  if (!secret || typeof tok !== 'string' || tok.length > 300) return null;
  const i = tok.indexOf('.');
  if (i < 1) return null;
  const body = tok.slice(0, i), mac = tok.slice(i + 1);
  const want = sign(body);
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  let o;
  try { o = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch (e) { return null; }
  if (!o || typeof o.u !== 'string' || !/^\d{1,18}$/.test(o.u) || typeof o.e !== 'number' || o.e < Date.now()) return null;
  return o.u;
}

/* ---------------- tiny in-memory rate limiter (login / register / API protection) ---------------- */
const buckets = new Map();
function rateHit(key, limit, windowMs) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || t - b.t0 > windowMs) { b = { t0: t, n: 0 }; buckets.set(key, b); }
  b.n++;
  return b.n <= limit;
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (t - b.t0 > 3600 * 1000) buckets.delete(k); }, 5 * 60 * 1000).unref();

module.exports = { setSecret, hasSecret, checkUsername, checkPassword, hashPassword, verifyPassword, burnTime, makeToken, verifyToken, rateHit };
