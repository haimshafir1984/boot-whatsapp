#!/usr/bin/env node
/**
 * Stage E / C4 - cost of ONE conversation change in PostgreSQL mode, by number of resident conversations, on a chosen build.
 * The same script runs against the frozen base (`--dist <base>/dist`) and the working tree, so both sides pay for exactly the
 * same scenario: N conversations resident (restored from the database), then 60 single-conversation changes, each followed by
 * flush() (the durability boundary the message handlers use). One N per process; run sequentially.
 *
 *   TEST_DATABASE_URL=... node scripts/measure-convstate-hotpath.js --dist <dir>/dist --n 20000 --label base [--out file.json]
 *
 * Reports: synchronous set() time (median/p95/max), event-loop delay over the whole loop (includes the database drain's own
 * synchronous work: snapshot clone / diff), wall time per change including flush.
 * Local *test* database only (TRUNCATES application tables).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { preflight, resultsPath } = require('./measure-preflight');

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const dist = path.resolve(arg('dist', path.join(__dirname, '..', 'dist')));
const N = Number(arg('n', '1200'));
const label = arg('label', 'tree');
const REPS = Number(arg('reps', '60'));
const pre = preflight();
const { createPostgresBackend, migrateDatabase } = require(path.join(dist, 'database'));
const { Storage, emptyStorageData } = require(path.join(dist, 'storage'));
const { conversationState } = require(path.join(dist, 'conversationState'));
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;
if (!url) { console.error('BLOCKED: TEST_DATABASE_URL is not set.'); process.exit(3); }
const u = new URL(url);
if (!['localhost', '127.0.0.1'].includes(u.hostname) || !u.pathname.toLowerCase().includes('test')) { console.error('Refusing: local *test* database only'); process.exit(1); }
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const FLOW = Array.from({ length: 8 }, (_, i) => ({ id: 'step' + i, kind: 'message', text: 'x'.repeat(200) }));

(async () => {
  await migrateDatabase(url);
  const pool = new Pool({ connectionString: url });
  await pool.query('truncate table scheduled_jobs, conversation_state, outbox_messages, twilio_templates, uploaded_files, saved_contacts, contact_queue, campaign_events, campaign_results, campaigns, client_profile, admin_settings, app_state restart identity');
  await pool.query(`insert into conversation_state(jid, kind, sender_phone, campaign_id, campaign_result_id, scheduled_at, data, updated_at)
    select 'whatsapp:9725' || lpad(g::text, 8, '0'), 'expired-decision', '9725' || lpad(g::text, 8, '0'), 'c1', 'r' || g, now() + interval '1 day',
           jsonb_build_object('kind','expired-decision','senderJid','whatsapp:9725' || lpad(g::text, 8, '0'),'senderPhone','9725' || lpad(g::text, 8, '0'),'campaignId','c1','campaignResultId','r' || g,'stepId','step1','timestamp',1), now()
      from generate_series(1, $1) g`, [N]);
  const backend = await createPostgresBackend(url);
  const snapshot = await backend.loadSnapshot();
  const storage = new Storage('unused.json', { initialData: snapshot ?? emptyStorageData(), backend });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-hot-'));
  conversationState.configurePersistence(path.join(dir, 'conversation-state.json'), storage);
  const restored = conversationState.restore(() => setTimeout(() => {}, 1e9).unref(), () => FLOW);
  await storage.flush();
  const shadowFile = path.join(dir, 'conversation-state.json');
  const shadowBytesAfterRestore = fs.existsSync(shadowFile) ? fs.statSync(shadowFile).size : 0;

  const sync = []; const wall = [];
  const h = monitorEventLoopDelay({ resolution: 1 }); h.enable();
  for (let r = 0; r < REPS; r++) {
    const i = 1 + (r % N); const jid = `whatsapp:9725${String(i).padStart(8, '0')}`;
    const state = { kind: 'decision', senderJid: jid, senderPhone: jid.slice(9), campaignId: 'c1', campaignResultId: 'r' + i, flow: FLOW, stepId: 'step1', timestamp: Date.now() + r };
    const t0 = process.hrtime.bigint();
    conversationState.set(jid, state);
    const t1 = process.hrtime.bigint();
    await storage.flush();
    const t2 = process.hrtime.bigint();
    sync.push(Number(t1 - t0) / 1e6); wall.push(Number(t2 - t0) / 1e6);
    await new Promise((res) => setImmediate(res));
  }
  h.disable();
  const shadowBytesEnd = fs.existsSync(shadowFile) ? fs.statSync(shadowFile).size : 0;
  const rowsInDb = (await pool.query('select count(*)::int n from conversation_state')).rows[0].n;
  const row = {
    label, dist, N, restored, rowsInDb, host: { cpu: os.cpus()[0].model, node: process.version }, preflight: pre,
    setMs: { median: +pct(sync, 50).toFixed(3), p95: +pct(sync, 95).toFixed(3), max: +Math.max(...sync).toFixed(3) },
    wallPerChangeMs: { median: +pct(wall, 50).toFixed(3), p95: +pct(wall, 95).toFixed(3) },
    eventLoopDelayMs: { p99: +(h.percentile(99) / 1e6).toFixed(2), max: +(h.max / 1e6).toFixed(2) },
    shadowFileBytes: shadowBytesEnd, shadowFileWritten: shadowBytesAfterRestore > 0 || shadowBytesEnd > 0,
  };
  console.log(JSON.stringify(row));
  fs.writeFileSync(arg('out', resultsPath(`c4-convstate-${label}-N${N}-${new Date().toISOString().slice(0, 10)}.json`)), JSON.stringify(row, null, 1));
  await storage.close(); await pool.end(); fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
