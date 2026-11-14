'use strict';
/* Offline unit test of the DATABASE_URL handling (no database, no npm packages needed):  npm run test:config */
const c = require('../dbconfig');
let pass = 0, fail = 0;
function ok(cond, name, extra) { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } }

/* finding the variable */
ok(c.findRaw({}) === null, 'no variable -> null');
ok(c.findRaw({ DATABASE_URL: '   ' }) === null, 'blank variable -> null');
ok(c.findRaw({ POSTGRES_URL: 'postgres://a:b@h/d' }).source === 'POSTGRES_URL', 'alternative name POSTGRES_URL is found');
ok(c.findRaw({ DATABASE_URL: 'x', POSTGRES_URL: 'y' }).source === 'DATABASE_URL', 'DATABASE_URL has priority');
const pg = c.findRaw({ PGHOST: 'h.example.com', PGUSER: 'u', PGPASSWORD: 'p@ss', PGDATABASE: 'd' });
ok(pg && c.parse(pg.raw).ok && c.parse(pg.raw).cfg.password === 'p@ss', 'PGHOST/PGUSER/... variables work, special chars survive');

/* cleaning what people paste on a phone */
const good = 'postgresql://neondb_owner:Abc123@ep-cool-123.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
for (const [name, raw] of [['plain', good], ['spaces/newline', '  ' + good + '\n'], ['double quotes', '"' + good + '"'], ['single quotes', "'" + good + "'"],
  ['psql command (Neon)', "psql '" + good + "'"], ['KEY=value line', 'DATABASE_URL=' + good], ['KEY="value" line', 'DATABASE_URL="' + good + '"']]) {
  const r = c.parse(raw);
  ok(r.ok && r.cfg.host === 'ep-cool-123.ap-southeast-1.aws.neon.tech' && r.cfg.user === 'neondb_owner' && r.cfg.password === 'Abc123' && r.cfg.database === 'neondb' && r.cfg.port === 5432 && r.cfg.sslmode === 'require', 'parse: ' + name, r);
}

/* special characters in the password */
let r = c.parse('postgres://admin:p@ss/w0rd#1?x@db.example.com:6543/mydb');
ok(r.ok && r.cfg.password === 'p@ss/w0rd#1?x' && r.cfg.host === 'db.example.com' && r.cfg.port === 6543 && r.cfg.database === 'mydb', 'unencoded @ / # ? in password', r);
r = c.parse('postgres://admin:p%40ss%2Fw0rd@db.example.com/mydb');
ok(r.ok && r.cfg.password === 'p@ss/w0rd', 'percent-encoded password is decoded', r);
r = c.parse('postgres://admin@db.example.com/mydb');
ok(r.ok && r.cfg.password === '', 'no password is allowed');
r = c.parse('postgresql://u:p@[::1]:5433/db');
ok(r.ok && r.cfg.host === '::1' && r.cfg.port === 5433, 'IPv6 host', r);

/* bad input gives a clear message */
for (const [name, raw, re] of [
  ['empty', '', /empty/i], ['not a url', 'hello world', /valid PostgreSQL/i], ['mysql url', 'mysql://u:p@h/d', /valid PostgreSQL/i],
  ['placeholder password', 'postgresql://u:[YOUR-PASSWORD]@h.example.com/d', /placeholder/i], ['.env.example values', 'postgresql://USER:PASSWORD@HOST/DBNAME', /example values/i],
  ['no database name', 'postgresql://u:p@h.example.com', /database name/i], ['no host', 'postgresql://u:p@/db', /host/i]]) {
  const x = c.parse(raw);
  ok(!x.ok && re.test(x.error) && x.hint, 'bad input: ' + name, x);
}

/* SSL decision */
const cfgOnline = c.parse(good).cfg, cfgLocal = c.parse('postgres://u:p@localhost:5432/d').cfg, cfgPlain = c.parse('postgres://u:p@db.example.com/d').cfg;
ok(c.decideSsl(cfgOnline, '').ssl && !c.decideSsl(cfgOnline, '').auto, 'sslmode=require -> SSL on');
ok(c.decideSsl(cfgPlain, '').ssl && c.decideSsl(cfgPlain, '').auto, 'online host, nothing set -> SSL on (automatic)');
ok(c.decideSsl(cfgLocal, '').ssl === false, 'localhost -> SSL off');
ok(c.decideSsl(c.parse('postgres://u:p@db:5432/d').cfg, '').ssl === false, 'docker host "db" -> SSL off');
ok(c.decideSsl(cfgLocal, 'true').ssl && !c.decideSsl(cfgLocal, 'true').auto, 'DATABASE_SSL=true overrides');
ok(c.decideSsl(cfgOnline, 'false').ssl === false, 'DATABASE_SSL=false overrides');

/* plain-language hints */
const d = (code, msg, host) => c.diagnose({ code, message: msg }, { host: host || 'x.example.com' });
ok(/password/i.test(d('28P01', 'password authentication failed for user "u"')), 'hint: wrong password');
ok(/does not exist/i.test(d('3D000', 'database "x" does not exist')), 'hint: wrong db name');
ok(/cannot be found/i.test(d('ENOTFOUND', 'getaddrinfo ENOTFOUND x')), 'hint: unknown host');
ok(/IPv6|pooler/i.test(d('ENOTFOUND', 'getaddrinfo ENOTFOUND', 'db.abcd.supabase.co')), 'hint: supabase direct host');
ok(/localhost|local database/i.test(d('ECONNREFUSED', 'connect ECONNREFUSED', 'localhost')), 'hint: localhost on hosting');
ok(/DATABASE_SSL=true/.test(d('', 'no pg_hba.conf entry for host "1.2.3.4", user "u", database "d", no encryption')), 'hint: SSL required');
ok(/DATABASE_SSL=false/.test(d('', 'The server does not support SSL connections')), 'hint: SSL unsupported');
ok(/POOL_MAX/.test(d('53300', 'too many connections')), 'hint: too many connections');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
