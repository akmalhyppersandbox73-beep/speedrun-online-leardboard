'use strict';
/* Run:  npm run db:check
   Checks DATABASE_URL, connects, creates the tables and prints a plain-language result.
   Works on your computer, or in the hosting's console/shell, with the same environment variables as the server. */
const db = require('../db');

(async () => {
  console.log('SpeedRun - database check\n');
  const r = await db.check();
  if (r.ok) {
    console.log('  RESULT      : OK - the database works');
    console.log('  Env var     : ' + r.source);
    console.log('  Host        : ' + r.host + '   (SSL ' + (r.ssl ? 'on' : 'off') + ', ' + r.ssl_rule + ')');
    console.log('  Database    : ' + r.database + ' (user ' + r.user + ')');
    console.log('  Server      : ' + r.version);
    console.log('  Tables      : ' + r.tables.join(', '));
    console.log('  Players     : ' + r.players + ' accounts, ' + r.ranked + ' ranked (PTS > 0)');
    console.log('\nThe Global Leaderboard will work when the server starts with this same DATABASE_URL.');
    process.exit(0);
  }
  console.log('  RESULT      : FAILED');
  console.log('  Problem     : ' + r.error);
  console.log('  What to do  : ' + r.hint);
  if (r.source) console.log('  Env var used: ' + r.source);
  process.exit(1);
})().catch(e => { console.error('Unexpected error:', e && e.stack || e); process.exit(2); });
