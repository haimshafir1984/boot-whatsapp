/**
 * Automatic JSON -> PostgreSQL move of a CLIENT inbox at startup (src/inbox/handoff.ts), against REAL PostgreSQL
 * (flowsbiz_inbox_test on 5433). Exit 3 = BLOCKED, never a skip.
 *
 * Production deploys run the old (JSON) and new (PostgreSQL) process side by side for a few seconds (Swarm start-first) on the
 * same data volume. The OLD process here is a real, separate Node process running the real compiled JsonInboxStore - receiving
 * and completing messages the whole time - while this process starts the real PostgreSQL store over the same file.
 */
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { inboxTestUrl, assertInboxTestDb, ensureInboxTestDb } = require('./inbox-test-db');
const { createInboxPool } = require('../dist/inbox/schema');
const { MetaGatewayInbox } = require('../dist/metaGatewayInbox');
const { createInboxStore, JsonInboxStore } = require('../dist/inbox/store');
const { readInboxConfig } = require('../dist/inbox/config');
const handoff = require('../dist/inbox/handoff');
const mig = require('../dist/inbox/migration');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-handoff-'));
const RUN = `ho${process.pid}`;
const PN = '1207335449126872';
const results = [];
async function scenario(name, fn) { try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 5).join(' | ')]); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const payload = (id, from) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: PN, display_phone_number: '15550001111' }, messages: [{ from, id, timestamp: '1700000000', type: 'text', text: { body: 'hi' } }] } }] }] });
let n = 0;
const fresh = (name) => { const dir = path.join(root, `${name}-${++n}`); fs.mkdirSync(dir, { recursive: true }); return { dir, file: path.join(dir, 'meta-client-inbox.json'), ns: `${RUN}-${name}-${n}` }; };
const pgCfg = (ns, extra = {}) => readInboxConfig('client', { INBOX_BACKEND: 'postgres', INBOX_DATABASE_URL: inboxTestUrl(), INBOX_NAMESPACE: ns, ...extra });

/** A realistic production-like client file: finished work plus one failed item, built with the real legacy class. */
function buildLegacy(file) {
  const inbox = new MetaGatewayInbox(file);
  inbox.enqueue('done1', payload('done1', '972501000001')); inbox.markCompleted('done1');
  inbox.enqueue('done2', payload('done2', '972501000002')); inbox.markCompleted('done2');
  inbox.enqueue('bad1', payload('bad1', '972501000003')); inbox.markFailed('bad1', new Error('exhausted'));
}

/**
 * The OLD process: a real JsonInboxStore that keeps receiving a message every 100ms and completing whatever it claims
 * (optionally slowly), exactly like the live client drainer, until it has handed over. Prints what it accepted.
 */
function startOldProcess(file, { completeDelayMs = 0 } = {}) {
  const storePath = require.resolve('../dist/inbox/store');
  const code = `
    const { JsonInboxStore } = require(${JSON.stringify(storePath)});
    const PN = ${JSON.stringify(PN)};
    const pl = (id) => (${payload.toString()})(id, '9725010000' + String(id.length).padStart(2, '0'));
    (async () => {
      const store = new JsonInboxStore(${JSON.stringify(file)}, 'client');
      await store.init();
      const accepted = [], refused = [], completed = []; let i = 0;
      const receive = setInterval(async () => {
        const id = 'live' + (++i);
        try { await store.enqueueMany([{ id, payload: pl(id) }]); accepted.push(id); } catch { refused.push(id); }
      }, 100);
      const work = setInterval(async () => {
        try {
          const { claimed } = await store.claim(5);
          for (const item of claimed) {
            if (${completeDelayMs}) await new Promise((r) => setTimeout(r, ${completeDelayMs}));
            await store.complete(item); completed.push(item.id);
          }
        } catch {}
      }, 50);
      // Stop once handed over (ack written) and prove no write happens after that.
      const done = setInterval(async () => {
        if (!require('fs').existsSync(${JSON.stringify(handoff.ackFile(file))})) return;
        clearInterval(done); clearInterval(receive); clearInterval(work);
        let writeAfterSeal = 'none';
        try { await store.enqueueMany([{ id: 'after-seal', payload: pl('after-seal') }]); writeAfterSeal = 'accepted'; } catch (e) { writeAfterSeal = 'refused'; }
        process.stdout.write('\\n__RESULT__' + JSON.stringify({ accepted, refused, completed, writeAfterSeal }) + '\\n');
        process.exit(0);
      }, 50);
    })().catch((e) => { console.error(e); process.exit(1); });
  `;
  const child = spawn(process.execPath, ['-e', code], { env: { ...process.env, NODE_ENV: 'test' } });
  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const finished = new Promise((resolve, reject) => child.on('exit', (code) => {
    if (code !== 0) return reject(new Error(`old process exited ${code}: ${err}`));
    const line = out.split('\n').find((l) => l.startsWith('__RESULT__'));
    return line ? resolve(JSON.parse(line.slice('__RESULT__'.length))) : reject(new Error('old process printed no result: ' + out + err));
  }));
  return { child, finished };
}

async function sqlItems(pool, ns) {
  return (await pool.query('select message_id, status from inbox_items where namespace = $1 and role = $2 order by message_id', [ns, 'client'])).rows;
}

(async () => {
  await ensureInboxTestDb();
  const pool = createInboxPool(inboxTestUrl(), { max: 4 });
  const identity = await assertInboxTestDb(pool);

  await scenario('OVERLAP: the old JSON process keeps receiving during the deploy; it hands over, never writes again, and every message it accepted is in PostgreSQL', async () => {
    const t = fresh('overlap'); buildLegacy(t.file);
    const old = startOldProcess(t.file);
    await sleep(800);                                                                     // old process is live and taking traffic
    assert.ok(fs.existsSync(handoff.aliveFile(t.file)), 'the old process publishes a heartbeat');
    const store = createInboxStore(pgCfg(t.ns), t.file);                                  // the new process starts on PostgreSQL
    await store.init();
    const r = await old.finished;
    assert.ok(r.accepted.length > 0, 'the old process really was receiving traffic');
    assert.equal(r.writeAfterSeal, 'refused', 'after handing over the old process refuses to write');
    const rows = await sqlItems(pool, t.ns);
    const ids = new Set(rows.map((x) => x.message_id));
    for (const id of ['done1', 'done2', 'bad1', ...r.accepted]) assert.ok(ids.has(id), `${id} accepted by the old process must be in PostgreSQL`);
    assert.equal(rows.find((x) => x.message_id === 'bad1').status, 'failed', 'a failed item stays failed (visible for review)');
    assert.ok(fs.existsSync(mig.markerPath(t.file)), 'marker written');
    assert.equal(fs.existsSync(t.file), false, 'the JSON file was renamed away (never deleted)');
    assert.ok(fs.readdirSync(t.dir).some((f) => f.startsWith('meta-client-inbox.json.migrated-')), 'original kept as .migrated-*');
    await sleep(600);
    assert.equal(fs.existsSync(t.file), false, 'the old process did not recreate the JSON file afterwards');
    for (const f of [handoff.requestFile(t.file), handoff.ackFile(t.file), handoff.aliveFile(t.file)]) assert.equal(fs.existsSync(f), false, `${path.basename(f)} cleaned up`);
    await store.enqueueMany([{ id: 'new1', payload: payload('new1', '972501000009') }]);
    assert.ok((await sqlItems(pool, t.ns)).some((x) => x.message_id === 'new1'), 'the new process receives into PostgreSQL');
    await store.close();
  });

  await scenario('IN-FLIGHT: an item the old process is still working on is finished and recorded as completed BEFORE the import - not imported as interrupted', async () => {
    const t = fresh('inflight'); buildLegacy(t.file);
    const old = startOldProcess(t.file, { completeDelayMs: 1500 });
    await sleep(500);
    const store = createInboxStore(pgCfg(t.ns), t.file);
    await store.init();
    const r = await old.finished;
    const rows = await sqlItems(pool, t.ns);
    for (const id of r.completed) assert.equal(rows.find((x) => x.message_id === id)?.status, 'completed', `${id} completed by the old process is completed in PostgreSQL`);
    assert.equal(rows.filter((x) => x.status === 'review' || x.status === 'processing').length, 0, 'nothing was cut off mid-work');
    await store.close();
  });

  await scenario('NO OLD PROCESS (plain restart): nobody is alive to answer, the import proceeds on its own', async () => {
    const t = fresh('alone'); buildLegacy(t.file);
    const store = createInboxStore(pgCfg(t.ns), t.file);
    const started = Date.now(); await store.init();
    assert.ok(Date.now() - started < 15_000, 'did not wait for an answer from nobody');
    assert.deepEqual((await sqlItems(pool, t.ns)).map((x) => x.message_id), ['bad1', 'done1', 'done2']);
    await store.close();
  });

  await scenario('STALE HEARTBEAT: a heartbeat left by a process that died is not waited on', async () => {
    const t = fresh('stale'); buildLegacy(t.file);
    fs.writeFileSync(handoff.aliveFile(t.file), JSON.stringify({ instance: 'dead', at: Date.now() - 60_000 }));
    const store = createInboxStore(pgCfg(t.ns), t.file);
    const started = Date.now(); await store.init();
    assert.ok(Date.now() - started < 15_000);
    assert.equal((await sqlItems(pool, t.ns)).length, 3);
    await store.close();
  });

  await scenario('A process that STARTS on JSON clears a leftover takeover request and keeps working (staying on JSON is a decision)', async () => {
    const t = fresh('stay'); buildLegacy(t.file);
    fs.writeFileSync(handoff.requestFile(t.file), '{}');
    const store = new JsonInboxStore(t.file, 'client'); await store.init();
    assert.equal(fs.existsSync(handoff.requestFile(t.file)), false);
    await sleep(700);
    await store.enqueueMany([{ id: 'still-json', payload: payload('still-json', '972501000010') }]);
    assert.equal((await store.counts()).queued, 1, 'not frozen');
    await store.close();
  });

  await scenario('A FAILED import leaves everything as it was: nothing activated, the file untouched, init rejects (and is retried by the caller)', async () => {
    const t = fresh('fail'); buildLegacy(t.file);
    const data = JSON.parse(fs.readFileSync(t.file, 'utf-8'));
    data.items.push({ ...data.items[0] });                                                  // duplicate identity: a blocking issue
    fs.writeFileSync(t.file, JSON.stringify(data));
    const before = fs.readFileSync(t.file);
    const store = createInboxStore(pgCfg(t.ns), t.file);
    await assert.rejects(() => store.init(), /blocking/);
    assert.deepEqual(fs.readFileSync(t.file), before, 'source untouched');
    assert.equal(fs.existsSync(mig.markerPath(t.file)), false, 'not activated');
    assert.equal((await sqlItems(pool, t.ns)).length, 0, 'nothing imported');
  });

  await scenario('DEFAULT BACKEND: a client with a database defaults to PostgreSQL; explicit json is honoured; no database = json; the gateway stays opt-in', async () => {
    assert.equal(readInboxConfig('client', { DATABASE_URL: 'postgres://x' }).backend, 'postgres');
    assert.equal(readInboxConfig('client', { INBOX_DATABASE_URL: 'postgres://x' }).backend, 'postgres');
    assert.equal(readInboxConfig('client', { DATABASE_URL: 'postgres://x', INBOX_BACKEND: 'json' }).backend, 'json');
    assert.equal(readInboxConfig('client', {}).backend, 'json');
    assert.equal(readInboxConfig('gateway', { DATABASE_URL: 'postgres://x' }).backend, 'json');
    assert.equal(readInboxConfig('gateway', { INBOX_DATABASE_URL: 'postgres://x' }).backend, 'json');
  });

  await scenario('STRICT MODE (INBOX_AUTO_MIGRATE=false) and the gateway role keep the old refuse-to-start guard', async () => {
    const t = fresh('strict'); buildLegacy(t.file);
    assert.throws(() => createInboxStore(pgCfg(t.ns, { INBOX_AUTO_MIGRATE: 'false' }), t.file), /has not been migrated/);
    const gw = readInboxConfig('gateway', { INBOX_BACKEND: 'postgres', INBOX_DATABASE_URL: inboxTestUrl(), INBOX_NAMESPACE: t.ns });
    assert.equal(gw.autoMigrate, false);
    assert.throws(() => createInboxStore(gw, t.file), /has not been migrated/);
  });

  await pool.query('delete from inbox_admin_audit where item_id in (select id from inbox_items where namespace like $1)', [`${RUN}%`]);
  await pool.query('delete from inbox_items where namespace like $1', [`${RUN}%`]);
  await pool.query('delete from inbox_senders where namespace like $1', [`${RUN}%`]);
  await pool.query('delete from inbox_meta where namespace like $1', [`${RUN}%`]);
  await pool.query('delete from inbox_import_ledger where source_id like $1', [`client:${RUN}%`]);
  await pool.end();
  let failed = 0;
  for (const r of results) { if (r[1] === 'FAIL') failed++; console.log(r[1] + '  ' + r[0]); if (r[2]) console.log('      ' + r[2]); }
  console.log(`inbox-auto-migrate-handoff: ${results.length - failed} passed, ${failed} failed (${identity.db}:${identity.port}, PostgreSQL ${identity.version})`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
