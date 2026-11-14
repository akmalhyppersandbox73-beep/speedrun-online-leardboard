'use strict';
/* End-to-end test for the Global Leaderboard.
   Needs a PostgreSQL database that can be wiped:  TEST_DATABASE_URL=postgres://user:pass@localhost:5432/speedrun_test npm test
   It starts server.js on a free port, creates accounts over HTTP, plays fake tournaments over a real WebSocket room
   and checks what ends up in the database / leaderboard. */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const { Pool } = require('pg');

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!DB) { console.error('Set TEST_DATABASE_URL to a throw-away PostgreSQL database.'); process.exit(2); }
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(cond, name, extra) { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } }

let srv = null;
function startServer(env) {
  return new Promise((resolve, reject) => {
    srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: Object.assign({}, process.env, { PORT: String(PORT), DATABASE_URL: DB, MIN_ROUND_SECONDS: '1', MAX_TOURNAMENTS_PER_HOUR: '1000' }, env || {}), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    srv.stdout.on('data', d => { out += d; if (/database ready/.test(out)) resolve(); });
    srv.stderr.on('data', d => { out += d; });
    srv.on('exit', c => reject(new Error('server exited ' + c + '\n' + out)));
    setTimeout(() => reject(new Error('server start timeout\n' + out)), 20000);
  });
}
function stopServer() { return new Promise(r => { if (!srv) return r(); srv.removeAllListeners('exit'); srv.on('exit', () => r()); srv.kill('SIGTERM'); }); }

async function api(method, p, body, tok) {
  const r = await fetch(BASE + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, tok ? { Authorization: 'Bearer ' + tok } : {}), body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch (e) { /* none */ }
  return { st: r.status, d };
}

class Peer {
  constructor(cid) { this.cid = cid; this.msgs = []; this.waiters = []; }
  async open() {
    this.ws = new WebSocket('ws://127.0.0.1:' + PORT);
    this.ws.on('message', raw => { const m = JSON.parse(raw); this.msgs.push(m); this.waiters = this.waiters.filter(w => !w(m)); });
    await new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
    await this.wait(m => m.k === 'hi');
    return this;
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  wait(pred, ms) {
    const hit = this.msgs.find(pred); if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout waiting for message')), ms || 4000);
      this.waiters.push(m => { if (pred(m)) { clearTimeout(t); res(m); return true; } return false; });
    });
  }
  has(pred) { return !!this.msgs.find(pred); }
  clear() { this.msgs = []; }
  async auth(tok) { this.send({ k: 'auth', tok }); return (await this.wait(m => m.k === 'authed')).ok; }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

/* host H + guest G1 (+ one bot); returns {host, guest, roomId} */
async function makeRoom(hostTok, guestTok) {
  const host = await new Peer('H' + Math.random().toString(36).slice(2).padEnd(20, 'x')).open();
  const guest = await new Peer('G' + Math.random().toString(36).slice(2).padEnd(20, 'y')).open();
  if (hostTok !== undefined) await host.auth(hostTok);
  if (guestTok !== undefined) await guest.auth(guestTok);
  host.send({ k: 'create', cid: host.cid, name: 'T', hostName: 'Host', max: 4, pub: true, mode: 'Tournament 3R', map: '' });
  const created = await host.wait(m => m.k === 'created');
  guest.send({ k: 'join', cid: guest.cid, id: created.id, name: 'Guest' });
  await guest.wait(m => m.k === 'joined');
  await host.wait(m => m.k === 'peer');
  host.send({ k: 'to', c: guest.cid, d: { t: 'welcome', id: 'G1' } });
  await guest.wait(m => m.k === 'data' && m.d.t === 'welcome');
  return { host, guest, roomId: created.id };
}
const roster = (extra) => [{ id: 'H', name: 'A', bot: false }, { id: 'G1', name: 'B', bot: false }, { id: 'B1', name: 'Bot', bot: true }].concat(extra || []);
function startMsg(cur, rounds, rost) { return { k: 'all', d: { t: 'start', info: { roster: rost || roster(), cfg: { rounds, tour: true }, seed: 1, tour: { cur, maps: ['city', 'beach', 'alpine'] } } } }; }
function endMsg(cur, hist) { return { k: 'all', d: { t: 'end', tr: { pts: {}, hist, cur, rounds: 3 } } }; }
const row = (id, rank, extra) => Object.assign({ id, name: id, rank, pts: 1, st: 2, ft: 50, dist: 600 }, extra || {});
/* plays a full tournament; hostRanks = [rankOfH, rankOfG1] per round */
async function playTournament(room, rounds, ranks, opts) {
  opts = opts || {};
  const hist = [];
  for (let r = 1; r <= rounds; r++) {
    room.host.send(startMsg(r, rounds, opts.roster));
    await sleep(opts.fast ? 20 : 1100);
    const [rh, rg] = ranks[r - 1];
    hist.push({ round: r, map: 'city', rows: [row('H', rh, opts.fakePts ? { pts: 9999 } : {}), row('G1', rg), row('B1', 6 - rh - rg)] });
    room.host.send(endMsg(r, hist.slice()));
    await sleep(60);
  }
}

(async () => {
  const pool = new Pool({ connectionString: DB });
  await startServer();
  await pool.query('TRUNCATE tournament_results, users RESTART IDENTITY CASCADE');

  console.log('\n[accounts]');
  let r = await api('GET', '/health'); ok(r.st === 200 && r.d.leaderboard.ready === true, 'health reports leaderboard ready', r.d);
  r = await api('GET', '/api/leaderboard'); ok(r.st === 200 && r.d.top.length === 0 && r.d.total === 0, 'empty leaderboard is really empty (no sample data)', r.d);
  r = await api('POST', '/api/auth/register', { username: 'ab', password: 'secret1' }); ok(r.st === 400 && r.d.code === 'bad_username', 'short username rejected');
  r = await api('POST', '/api/auth/register', { username: 'Alice_01', password: '123' }); ok(r.st === 400 && r.d.code === 'bad_password', 'short password rejected');
  r = await api('POST', '/api/auth/register', { username: 'Alice_01', password: 'secret1' }); ok(r.st === 201 && r.d.token, 'register Alice'); const tokA = r.d.token;
  r = await api('POST', '/api/auth/register', { username: 'alice_01', password: 'other11' }); ok(r.st === 409 && r.d.code === 'taken', 'duplicate username (case-insensitive) rejected');
  r = await api('POST', '/api/auth/register', { username: 'Bob', password: 'secret2' }); ok(r.st === 201, 'register Bob'); const tokB = r.d.token;
  r = await api('POST', '/api/auth/register', { username: 'Carol', password: 'secret3' }); ok(r.st === 201, 'register Carol'); const tokC = r.d.token;
  r = await api('POST', '/api/auth/login', { username: 'ALICE_01', password: 'wrongpass' }); ok(r.st === 401, 'wrong password rejected');
  r = await api('POST', '/api/auth/login', { username: 'nobody', password: 'wrongpass' }); ok(r.st === 401 && r.d.code === 'bad_credentials', 'unknown user gives the same error');
  r = await api('POST', '/api/auth/login', { username: 'alice_01', password: 'secret1' }); ok(r.st === 200 && r.d.user.username === 'Alice_01', 'login works (case-insensitive name, original spelling kept)');
  r = await api('GET', '/api/leaderboard/me'); ok(r.st === 401, 'my rank needs a login');
  r = await api('GET', '/api/leaderboard/me', null, tokA + 'x'); ok(r.st === 401, 'tampered token rejected');
  r = await api('GET', '/api/leaderboard/me', null, tokA); ok(r.st === 200 && r.d.rank === null && r.d.pts === 0, 'new player is unranked with 0 PTS', r.d);
  r = await api('POST', '/api/leaderboard', {}); ok(r.st === 404, 'no endpoint to POST scores exists');
  r = await api('POST', '/api/leaderboard/submit', { pts: 99999 }, tokA); ok(r.st === 404, 'no endpoint accepts a PTS value from a client');

  console.log('\n[online tournament -> PTS]');
  let room = await makeRoom(tokA, tokB);
  await playTournament(room, 3, [[1, 2], [1, 2], [1, 2]]);
  const gainA = await room.host.wait(m => m.k === 'tpts'), gainB = await room.guest.wait(m => m.k === 'tpts');
  ok(gainA.gained === 30 && gainA.total === 30, 'Alice (1st x3) got 30 PTS', gainA);
  ok(gainB.gained === 24 && gainB.total === 24, 'Bob (2nd x3) got 24 PTS', gainB);
  ok(room.guest.has(m => m.k === 'data' && m.d.t === 'start') && room.guest.has(m => m.k === 'data' && m.d.t === 'end'), 'game messages are still relayed to guests');
  r = await api('GET', '/api/leaderboard'); ok(r.d.top.length === 2 && r.d.top[0].username === 'Alice_01' && r.d.top[0].pts === 30 && r.d.top[1].username === 'Bob' && r.d.top[1].rank === 2, 'leaderboard order', r.d.top);
  r = await api('GET', '/api/leaderboard/me', null, tokB); ok(r.d.rank === 2 && r.d.pts === 24, 'Bob: My Rank #2 / My PTS 24', r.d);
  /* replaying the same final "end" must not add PTS twice */
  room.host.send(endMsg(3, [{ round: 3, map: 'x', rows: [row('H', 1), row('G1', 2), row('B1', 3)] }])); await sleep(200);
  r = await api('GET', '/api/leaderboard/me', null, tokA); ok(r.d.pts === 30, 'repeated message does not add PTS twice', r.d);
  /* a second, real tournament in the same room adds again; the client-supplied "pts" field is ignored */
  room.host.clear(); room.guest.clear();
  await playTournament(room, 3, [[2, 1], [2, 1], [2, 1]], { fakePts: true });
  await room.host.wait(m => m.k === 'tpts'); await sleep(100);
  r = await api('GET', '/api/leaderboard/me', null, tokA); ok(r.d.pts === 54, 'second tournament: +24 (rank-based, fake pts ignored)', r.d);
  const rkA = (await api('GET', '/api/leaderboard/me', null, tokA)).d, rkB = (await api('GET', '/api/leaderboard/me', null, tokB)).d;
  ok(rkB.pts === 54 && rkA.rank === 1 && rkB.rank === 2, 'equal PTS (54 = 54): the account that reached it first ranks higher', [rkA, rkB]);
  const t1 = await pool.query("SELECT count(*)::int AS n FROM tournament_results"); ok(t1.rows[0].n === 4, 'tournament_results has exactly 4 rows', t1.rows[0]);
  room.host.close(); room.guest.close();

  console.log('\n[things that must NOT give PTS]');
  const before = async tok => (await api('GET', '/api/leaderboard/me', null, tok)).d.pts;
  const a0 = await before(tokA);
  /* too fast rounds (server MIN_ROUND_SECONDS=1) */
  room = await makeRoom(tokA, tokB);
  await playTournament(room, 3, [[1, 2], [1, 2], [1, 2]], { fast: true }); await sleep(300);
  ok(await before(tokA) === a0, 'rounds that ended implausibly fast give nothing');
  room.host.close(); room.guest.close();
  /* unfinished tournament (only 2 of 3 rounds) */
  room = await makeRoom(tokA, tokB);
  await playTournament(room, 2, [[1, 2], [1, 2]]); await sleep(300);
  ok(await before(tokA) === a0, 'unfinished tournament (2 of 3 rounds) gives nothing');
  room.host.close(); room.guest.close();
  /* single round (no tour info) */
  room = await makeRoom(tokA, tokB);
  room.host.send({ k: 'all', d: { t: 'start', info: { roster: roster(), cfg: { rounds: 3, tour: false }, seed: 1 } } }); await sleep(1100);
  room.host.send({ k: 'all', d: { t: 'end' } }); await sleep(200);
  ok(await before(tokA) === a0, 'Single Round gives nothing');
  /* a guest cannot fake host messages */
  room.guest.send({ k: 'all', d: { t: 'start', info: { roster: roster(), cfg: { rounds: 3 }, tour: { cur: 1 } } } });
  room.guest.send({ k: 'data', d: { t: 'end', tr: { cur: 1 } } }); await sleep(200);
  ok(!room.host.has(m => m.k === 'data' && m.d && m.d.t === 'start'), 'guest cannot broadcast host-only messages');
  room.host.close(); room.guest.close();
  /* solo (only one human + bots) */
  room = await makeRoom(tokA, tokB);
  await playTournament(room, 3, [[1, 2], [1, 2], [1, 2]], { roster: [{ id: 'H', name: 'A', bot: false }, { id: 'B1', name: 'Bot', bot: true }, { id: 'B2', name: 'Bot2', bot: true }] }); await sleep(300);
  ok(await before(tokA) === a0, 'a single human against bots gives nothing');
  room.host.close(); room.guest.close();
  /* guest not logged in: host is awarded, guest only gets a hint */
  room = await makeRoom(tokA, '');
  const bA = await before(tokA);
  await playTournament(room, 3, [[1, 2], [1, 2], [1, 2]]);
  await room.guest.wait(m => m.k === 'tnote' && m.code === 'login'); await room.host.wait(m => m.k === 'tpts'); await sleep(100);
  ok(await before(tokA) === bA + 30, 'logged-in player is awarded, anonymous guest only gets a login hint');
  room.host.close(); room.guest.close();
  /* the same account on both connections of one room */
  room = await makeRoom(tokC, tokC);
  const bC = await before(tokC);
  await playTournament(room, 3, [[1, 2], [1, 2], [1, 2]]); await sleep(300);
  ok(await before(tokC) === bC, 'one account on two connections in the same room gives nothing');
  room.host.close(); room.guest.close();
  /* bad token over WS */
  const pz = await new Peer('Z' + 'z'.repeat(20)).open(); ok(await pz.auth('garbage') === false, 'garbage WS token is not authenticated'); pz.close();

  console.log('\n[Top 100 + my own rank]');
  await pool.query("INSERT INTO users (username, username_lower, pass_hash, total_pts, reached_at) SELECT 'p'||g, 'p'||g, 'x', 1000 + g, now() - (g || ' minutes')::interval FROM generate_series(1,150) g");
  /* two players with identical PTS: the one who got there first ranks higher */
  await pool.query("INSERT INTO users (username, username_lower, pass_hash, total_pts, reached_at) VALUES ('tieEarly','tieearly','x',777, now() - interval '2 days'),('tieLate','tielate','x',777, now() - interval '1 day')");
  r = await api('GET', '/api/leaderboard'); await sleep(0);
  ok(r.d.top.length <= 100, 'main list holds at most 100 players', r.d.top.length);
  r = await (async () => { await sleep(3200); return api('GET', '/api/leaderboard'); })();
  ok(r.d.top.length === 100 && r.d.top[0].rank === 1 && r.d.top[99].rank === 100, 'exactly 100 rows ranked 1..100');
  ok(r.d.top.every((x, i, a) => i === 0 || a[i - 1].pts >= x.pts), 'sorted by PTS (highest first)');
  ok(!r.d.top.some(x => x.username === 'Bob' || x.username === 'tieLate'), 'players below #100 are not listed');
  const me = await api('GET', '/api/leaderboard/me', null, tokB);
  ok(me.st === 200 && me.d.rank > 100 && me.d.pts === 54, 'player below #100 still gets own rank + PTS: #' + me.d.rank, me.d);
  /* the tie players have fake password hashes, so compare with the exact ordering the API uses */
  const ord = (await pool.query("SELECT username FROM users WHERE total_pts = 777 ORDER BY total_pts DESC, reached_at ASC, id ASC")).rows.map(x => x.username);
  ok(ord[0] === 'tieEarly' && ord[1] === 'tieLate', 'tie-breaker: same PTS -> earlier to reach it ranks higher', ord);

  console.log('\n[persistence]');
  const snap = JSON.stringify((await api('GET', '/api/leaderboard')).d.top);
  await stopServer(); await startServer(); await sleep(200);
  ok(JSON.stringify((await api('GET', '/api/leaderboard')).d.top) === snap, 'leaderboard identical after a server restart');
  r = await api('POST', '/api/auth/login', { username: 'Alice_01', password: 'secret1' }); ok(r.st === 200, 'accounts survive a restart');
  r = await api('GET', '/api/leaderboard/me', null, tokA); ok(r.st === 200, 'old login token still valid after restart (secret stored in DB)');

  await pool.end(); await stopServer();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(async e => { console.error('TEST CRASH', e); await stopServer().catch(() => {}); process.exit(1); });
