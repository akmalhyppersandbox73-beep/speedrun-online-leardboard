'use strict';
/* ============================================================================
   SPEEDRUN - server-side Tournament tracking (decides who gets Global PTS)
   ----------------------------------------------------------------------------
   Clients NEVER send a PTS number. The server only watches the messages that the room HOST already relays to the
   guests (start / end) and derives everything itself:
     - a tournament counts only when ALL rounds were started in order and the LAST round has ended
     - every round must have lasted a plausible time (MIN_ROUND_SECONDS)
     - round results must be a clean ranking (ranks 1..N, ids that were really in the round roster)
     - only humans that played EVERY round, on the SAME logged-in account, are awarded
     - at least MIN_HUMANS humans must have finished it (offline / solo-vs-bots never counts)
     - PTS per round = TPTS[rank-1] (same table as the game: [10,8,6,5,4,3,2,1], rank > 8 -> 1)
   Single Round, unfinished tournaments and solo play never reach this code path or never complete.
   ============================================================================ */
const crypto = require('crypto');

const TPTS = [10, 8, 6, 5, 4, 3, 2, 1];                 // keep identical to `var TPTS` in index.html
const ROUNDS_ALLOWED = new Set([3, 5, 7, 9]);           // the rounds offered in the lobby
const MIN_ROUND_MS = Math.max(0, parseInt(process.env.MIN_ROUND_SECONDS, 10) >= 0 ? parseInt(process.env.MIN_ROUND_SECONDS, 10) : 30) * 1000;
const MIN_HUMANS = Math.max(2, parseInt(process.env.TOURNAMENT_MIN_HUMANS, 10) || 2);
const MAX_ROSTER = 16;
const PID_RE = /^[A-Za-z0-9_]{1,12}$/;

function ptsForRank(rank) { return TPTS[rank - 1] || 1; }
function isBotId(id) { return /^B\d+$/.test(id); }

/* The host announces every guest identity with a 'welcome' message ({t:'welcome', id:'G1'}) sent to that guest's cid.
   We remember pid -> cid so a roster entry can be tied to a real connection / account. */
function noteWelcome(room, cid, d) {
  if (!d || typeof d.id !== 'string' || !PID_RE.test(d.id)) return;
  if (!room.pidMap) room.pidMap = new Map();
  room.pidMap.set(d.id, String(cid));
}

function memberFor(room, pid) {
  if (pid === 'H') return room.host;                      // the host always plays as 'H'
  const cid = room.pidMap && room.pidMap.get(pid);
  if (!cid) return null;
  if (cid === room.host.cid) return null;                 // a guest id can never point to the host's connection
  return room.members.get(cid) || null;
}

function bad(room, why) {
  if (room.tour && !room.tour.bad) { room.tour.bad = why; }
  return null;
}

/* host sent {t:'start', info:{roster, cfg, tour:{cur}}} */
function onStart(room, info, now) {
  const tourInfo = info && typeof info === 'object' ? info.tour : null;
  if (!tourInfo || typeof tourInfo !== 'object') { room.tour = null; return; }        // Single Round: nothing is tracked
  const cur = tourInfo.cur;
  const rounds = info.cfg && info.cfg.rounds;
  if (!Number.isInteger(cur) || cur < 1 || !Number.isInteger(rounds) || !ROUNDS_ALLOWED.has(rounds)) { room.tour = null; return; }
  if (cur === 1) {                                         // a (new) tournament begins
    room.tour = { id: crypto.randomUUID(), rounds, cur: 0, startAt: {}, rosters: {}, rows: {}, ended: {}, players: {}, bad: '', settled: false };
  } else if (!room.tour || room.tour.bad || room.tour.settled || cur !== room.tour.cur + 1 || rounds !== room.tour.rounds) {
    return bad(room, 'sequence');
  }
  const tour = room.tour;
  if (cur > tour.rounds) return bad(room, 'too_many_rounds');
  const roster = Array.isArray(info.roster) ? info.roster.slice(0, MAX_ROSTER + 1) : null;
  if (!roster || roster.length < 2 || roster.length > MAX_ROSTER) return bad(room, 'roster');
  const ids = new Set(), humans = [];
  for (const r of roster) {
    if (!r || typeof r.id !== 'string' || !PID_RE.test(r.id) || ids.has(r.id)) return bad(room, 'roster');
    ids.add(r.id);
    if (!r.bot && !isBotId(r.id)) humans.push(r.id);
  }
  tour.cur = cur;
  tour.startAt[cur] = now;
  tour.rosters[cur] = ids;
  /* bind every human of this round to a connection + account (identity must not change between rounds) */
  for (const pid of humans) {
    const mem = memberFor(room, pid);
    const cid = mem ? mem.cid : null;
    const uid = mem && mem.userId ? String(mem.userId) : '';
    let p = tour.players[pid];
    if (!p) p = tour.players[pid] = { cid, uid, rounds: 0, bad: !mem };
    if (!mem || p.cid !== cid || p.uid !== uid) p.bad = true;
    p.rounds++;
  }
}

/* host sent {t:'end', tr:{cur, hist}} when a round is over. Returns a settlement object when the LAST round just ended. */
function onEnd(room, tr, now) {
  const tour = room.tour;
  if (!tour || tour.bad || tour.settled) return null;
  if (!tr || typeof tr !== 'object' || tr.cur !== tour.cur) return bad(room, 'end_cur');
  const cur = tour.cur;
  if (tour.ended[cur]) return null;                        // the same 'end' arriving twice
  if (now - tour.startAt[cur] < MIN_ROUND_MS) return bad(room, 'too_fast');
  const hist = tr.hist;
  const last = Array.isArray(hist) && hist.length ? hist[hist.length - 1] : null;
  if (!last || last.round !== cur || !Array.isArray(last.rows) || last.rows.length < 2 || last.rows.length > MAX_ROSTER) return bad(room, 'hist');
  const rows = new Map(), roster = tour.rosters[cur];
  for (const r of last.rows) {
    if (!r || typeof r.id !== 'string' || !roster.has(r.id) || rows.has(r.id) || !Number.isInteger(r.rank)) return bad(room, 'rows');
    rows.set(r.id, r.rank);
  }
  const ranks = Array.from(rows.values()).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return bad(room, 'ranks');   // must be exactly 1..N
  tour.rows[cur] = rows;
  tour.ended[cur] = true;
  if (cur < tour.rounds) return null;
  return settle(room, tour);
}

function settle(room, tour) {
  tour.settled = true;
  const finishers = [];                                    // humans that played every round on one stable identity
  for (const pid of Object.keys(tour.players)) {
    const p = tour.players[pid];
    if (p.bad || p.rounds !== tour.rounds) continue;
    const placings = [];
    for (let r = 1; r <= tour.rounds; r++) {
      const rank = tour.rows[r] && tour.rows[r].get(pid);
      if (!rank) break;
      placings.push(rank);
    }
    if (placings.length !== tour.rounds) continue;
    finishers.push({ pid, cid: p.cid, uid: p.uid, placings, pts: placings.reduce((s, k) => s + ptsForRank(k), 0) });
  }
  const out = { tournamentId: tour.id, rounds: tour.rounds, humans: finishers.length, awards: [], guests: [], ok: finishers.length >= MIN_HUMANS };
  if (!out.ok) return out;
  /* one account may appear only once (two connections of the same account in one room = no points for either) */
  const seen = new Map();
  for (const f of finishers) if (f.uid) seen.set(f.uid, (seen.get(f.uid) || 0) + 1);
  for (const f of finishers) {
    if (!f.uid) out.guests.push({ cid: f.cid });                                 // not logged in: told how to join the leaderboard
    else if (seen.get(f.uid) === 1) out.awards.push({ userId: f.uid, cid: f.cid, pts: f.pts, placings: f.placings });
  }
  return out;
}

module.exports = { TPTS, ptsForRank, noteWelcome, onStart, onEnd, MIN_ROUND_MS, MIN_HUMANS };
