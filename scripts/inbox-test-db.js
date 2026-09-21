/**
 * Stage E: the dedicated inbox test database. Shared by every inbox test/measurement so none of them can point at the
 * wrong server. Only ever the LOCAL PostgreSQL 18 on port 5433, database `flowsbiz_inbox_test` (NOT flowsbiz_test_18, which
 * other tests use, and NEVER 5432 which holds real data).
 *   node scripts/inbox-test-db.js           -> creates the database if missing, prints its identity
 * Exports: inboxTestUrl(), assertInboxTestDb(pool), ensureInboxTestDb(), NAME
 */
const { Pool } = require('pg');

const NAME = 'flowsbiz_inbox_test';

function adminUrl() {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) { console.error('BLOCKED: TEST_DATABASE_URL is not set (needs the local PostgreSQL 18 test server).'); process.exit(3); }
  const u = new URL(base);
  if (!['localhost', '127.0.0.1'].includes(u.hostname) || u.port !== '5433') { console.error(`Refusing: TEST_DATABASE_URL must be localhost:5433 (got ${u.hostname}:${u.port}).`); process.exit(1); }
  return u;
}
function inboxTestUrl() { const u = adminUrl(); u.pathname = '/' + NAME; return u.toString(); }

async function assertInboxTestDb(pool) {
  const r = await pool.query('select current_database() as db, inet_server_port() as port, current_setting(\'server_version\') as version');
  const { db, port, version } = r.rows[0];
  if (db !== NAME || Number(port) !== 5433 || !String(version).startsWith('18')) throw new Error(`Refusing to run: connected to ${db} on ${port} (PostgreSQL ${version}), expected ${NAME} on 5433 (PostgreSQL 18).`);
  return { db, port: Number(port), version };
}

async function ensureInboxTestDb() {
  const u = adminUrl();
  const admin = new Pool({ connectionString: u.toString(), max: 1 });
  try {
    const exists = await admin.query('select 1 from pg_database where datname = $1', [NAME]);
    if (!exists.rowCount) await admin.query(`create database ${NAME}`);
  } finally { await admin.end(); }
  const pool = new Pool({ connectionString: inboxTestUrl(), max: 1 });
  try { return await assertInboxTestDb(pool); } finally { await pool.end(); }
}

module.exports = { NAME, inboxTestUrl, assertInboxTestDb, ensureInboxTestDb };

if (require.main === module) {
  ensureInboxTestDb().then((id) => { console.log(JSON.stringify(id)); }).catch((e) => { console.error(e.message); process.exit(1); });
}
