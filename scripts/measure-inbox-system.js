#!/usr/bin/env node
/**
 * Stage E / C6 - the WHOLE system under load, one scenario per process, one build per run (base SHA or working tree).
 *   real gateway process  (dist/index.js)  <-HTTP->  real client processes (dist/index.js, PostgreSQL schema each)
 *   fake Meta Graph API (fetch preload), a driver posting real webhook payloads to the gateway. Nothing leaves the machine.
 *
 *   node scripts/measure-inbox-system.js --side base|new --dist <dir>/dist --label NAME [options]
 *     --scenario burst|sustained   --participants N   --duration SECONDS (sustained)   --abandon 0.35   --clients 6
 *     --history H       gateway inbox history that is NEVER pruned (failed/held). Same on both sides (axis A).
 *     --completed C     ADDITIONAL completed history, new side only (axis B: the base prunes completed to 300)
 *     --seed-conversations M   expired conversations resident in every client (accumulated state)
 *     --fault none | kill-client@S | term-client@S | kill-gateway@S | db-outage@S:DURATION | client-down@S:DURATION   (S = seconds after start)
 *     --timeout SECONDS (max wait for responses, default 600)
 *
 * Reports: trigger -> first response (p50/p95/p99/max, missing), receipt -> handler start, gateway/client event-loop lag,
 * per-client campaign results vs expected (no loss, no duplicate), stale drops / skipped / failed / retries, ACTUAL inbox counts
 * by status (never the seeded numbers), and, on faults, how many interrupted (ambiguous) items a restart produced.
 * Local *test* PostgreSQL only (dedicated database). Output goes to docs/results-data/.
 */
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const { inboxTestUrl, assertInboxTestDb, ensureInboxTestDb } = require('./inbox-test-db');
const { preflight, resultsPath } = require('./measure-preflight');

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const side = arg('side'); const dist = path.resolve(arg('dist', '')); const label = arg('label', `${side}-run`);
if (!['base', 'new'].includes(side) || !fs.existsSync(path.join(dist, 'index.js'))) { console.error('usage: --side base|new --dist <dir>/dist --label NAME ...'); process.exit(2); }
const scenario = arg('scenario', 'burst'); const N = Number(arg('participants', '100')); const durationS = Number(arg('duration', '60'));
const abandon = Number(arg('abandon', '0.35')); const CLIENTS = Number(arg('clients', '6')); const H = Number(arg('history', '300'));
const C = Number(arg('completed', '0')); const M = Number(arg('seed-conversations', '0')); const fault = arg('fault', 'none'); const timeoutS = Number(arg('timeout', '600'));
const RUN = `ld${Date.now().toString(36)}`;
const PN = 'shared-phone-id';
const pre = preflight();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))].toFixed(1); };
const preload = path.join(__dirname, 'lib', 'load-preload.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${RUN}-`));

const baseUrl = new URL(inboxTestUrl());
const gwDbName = fault.startsWith('db-outage') ? 'flowsbiz_inbox_test_gw' : baseUrl.pathname.slice(1);
const gwInboxUrl = (() => { const u = new URL(baseUrl); u.pathname = '/' + gwDbName; return u.toString(); })();
const schemaUrl = (schema) => { const u = new URL(baseUrl); u.searchParams.set('options', `-c search_path=${schema}`); return u.toString(); };

const events = { cs: {}, gwLines: [], firstSend: new Map(), sendCount: new Map(), handlerStart: new Map(), lag: { gateway: [], client: [] }, logs: { stale: 0, skipped: 0, inboxFailed: 0, storeFailed: 0, retry: 0, ambiguous: 0, groupFailed: 0, unhandled: 0, persistFailed: 0 } };
const procs = [];
function onLine(name, line, isGateway) {
  if (line.startsWith('@@SEND ')) { const j = JSON.parse(line.slice(7)); if (!events.firstSend.has(j.to)) events.firstSend.set(j.to, j.t); events.sendCount.set(j.to, (events.sendCount.get(j.to) || 0) + 1); return; }
  if (line.startsWith('@@LAG ')) { const j = JSON.parse(line.slice(6)); events.lag[isGateway ? 'gateway' : 'client'].push({ t: j.t, p99: j.p99, max: j.max, rssMB: j.rssMB, name }); return; }
  if (line.startsWith('@@CS ')) { const j = JSON.parse(line.slice(5)); (events.cs[name] = events.cs[name] || []).push(j); return; }
  if (!isGateway && /@@STAGE|SIGTERM|SIGINT|draining|Shutdown|grace|INBOX_SHUTDOWN|INBOX_AMBIGUOUS|INBOX_STORE|INBOX_LEASE|META_INBOUND\] shutdown/i.test(line) && events.gwLines.length < 400) events.gwLines.push(new Date().toISOString().slice(11, 23) + ' [client] ' + line.slice(0, 300));
  if (isGateway && /INBOX|ERROR|error|FAILED|Unhandled|Uncaught/.test(line) && events.gwLines.length < 400) events.gwLines.push(new Date().toISOString().slice(11, 23) + ' ' + line.slice(0, 300));
  let m;
  if (!isGateway && (m = /\[META_INBOUND\] (\S+) /.exec(line))) { if (!events.handlerStart.has(m[1])) events.handlerStart.set(m[1], Date.now()); return; }
  if (/stale trigger ignored/.test(line)) events.logs.stale += 1;
  if (/META_GATEWAY_CLIENT_SKIPPED/.test(line)) events.logs.skipped += 1;
  if (/META_GATEWAY_INBOX_FAILED|META_CLIENT_INBOX_FAILED/.test(line)) events.logs.inboxFailed += 1;
  if (/INBOX_STORE_FAILED/.test(line)) events.logs.storeFailed += 1;
  if (/META_GATEWAY_INBOX_RETRY|META_CLIENT_INBOX_RETRY/.test(line)) events.logs.retry += 1;
  if (/INBOX_AMBIGUOUS_REVIEW/.test(line)) events.logs.ambiguous += 1;
  if (/INBOX_GROUP_FAILED/.test(line)) events.logs.groupFailed += 1;
  if (/PERSIST_FAILED/.test(line)) events.logs.persistFailed += 1;
  if (/UnhandledPromiseRejection|Uncaught/.test(line)) events.logs.unhandled += 1;
}
function launch(name, env, isGateway, cwd) {
  fs.mkdirSync(cwd, { recursive: true });
  const child = spawn(process.execPath, ['--require', preload, path.join(dist, 'index.js')], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const entry = { name, child, isGateway, env, cwd, ready: null, exited: false };
  let buf = { out: '', err: '' };
  const feed = (kind) => (d) => { buf[kind] += d; let i; while ((i = buf[kind].indexOf('\n')) >= 0) { const line = buf[kind].slice(0, i); buf[kind] = buf[kind].slice(i + 1); onLine(name, line, isGateway); if (/Admin dashboard/.test(line) && entry.resolveReady) entry.resolveReady(); } };
  child.stdout.on('data', feed('out')); child.stderr.on('data', feed('err'));
  child.on('exit', (code, sig) => { entry.exited = true; if (!isGateway && events.gwLines.length < 400) events.gwLines.push(new Date().toISOString().slice(11, 23) + ` [client] EXIT code=${code} signal=${sig}`); });
  entry.readyPromise = new Promise((resolve) => { entry.resolveReady = resolve; });
  procs.push(entry);
  return entry;
}
const freePort = () => new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function stopProc(entry, signal = 'SIGTERM', waitMs = 15000) {
  if (entry.exited) return;
  if (signal === 'SIGTERM' && !entry.isGateway && events.gwLines.length < 400) events.gwLines.push(new Date().toISOString().slice(11, 23) + ' [harness] SIGTERM sent');
  // Windows has no POSIX signals: child.kill('SIGTERM') is TerminateProcess (no handler runs). A graceful stop is delivered over IPC
  // and re-emitted as process 'SIGTERM' by the preload, which runs the app's REAL shutdown handler.
  if (signal === 'SIGTERM' && entry.child.connected) entry.child.send('SIGTERM'); else entry.child.kill(signal);
  const t0 = Date.now(); while (!entry.exited && Date.now() - t0 < waitMs) await sleep(50);
  if (!entry.exited) { entry.child.kill('SIGKILL'); await sleep(200); }
}

function makeCampaign(i, phrase) {
  return { id: `camp-${i}`, name: `campaign ${i}`, triggerType: 1, triggerPhrase: phrase, suffix: ' - Bot', active: true, runtimeStatus: 'active',
    conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], sendContactCard: false, decisionTimeoutMinutes: 30, decisionTimeoutMode: 'message', decisionTimeoutText: '',
      invalidReplyText: 'לא הצלחתי לזהות את התשובה.', flowRecoveryText: 'נראה שהשיחה נקטעה.', humanHandoffEnabled: false,
      decisionFlow: [{ id: 'welcome', kind: 'message', text: `ברוכים הבאים ${i}`, nextStepId: 'question' }, { id: 'question', kind: 'question', presentation: 'buttons', text: 'רוצה להמשיך?', options: [{ id: 'continue', text: 'כן' }], timeoutMode: 'stop' }] } };
}
const payloadOf = (id, from, kind, body) => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PN, display_phone_number: '15550001111' }, contacts: [{ profile: { name: 'P' }, wa_id: from }],
  messages: [kind === 'text' ? { from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } } : { from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'continue', title: 'כן' } } }] } }] }] });
const agent = new http.Agent({ keepAlive: true, maxSockets: 200 });
const post = (port, pathname, body, headers = {}) => new Promise((resolve) => {
  const data = JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', () => resolve(0)); req.setTimeout(30000, () => { req.destroy(); resolve(0); }); req.end(data);
});

(async () => {
  await ensureInboxTestDb();
  const admin = new Pool({ connectionString: inboxTestUrl(), max: 4 });
  const ident = await assertInboxTestDb(admin);
  if (gwDbName !== baseUrl.pathname.slice(1)) {
    const exists = await admin.query('select 1 from pg_database where datname = $1', [gwDbName]);
    if (!exists.rowCount) await admin.query(`create database ${gwDbName}`);
    await admin.query(`alter database ${gwDbName} with allow_connections true`);   // a crashed earlier outage run may have left it disabled
  }
  const { migrateDatabase, createPostgresBackend } = require(path.join(dist, 'database'));
  const { Storage, emptyStorageData } = require(path.join(dist, 'storage'));
  console.log(`[${label}] side=${side} scenario=${scenario} N=${N} clients=${CLIENTS} history=${H} completed=${C} seedConv=${M} fault=${fault} db=${ident.db}`);

  // ---- clients: schema each, campaign, accumulated conversation state
  const clients = [];
  const phrases = [];
  for (let i = 0; i < CLIENTS; i++) {
    const schema = `${RUN}_c${i}`;
    await admin.query(`create schema ${schema}`);
    const url = schemaUrl(schema);
    await migrateDatabase(url);
    const backend = await createPostgresBackend(url); const snap = await backend.loadSnapshot();
    const st = new Storage(path.join(tmp, `c${i}-setup.json`), { initialData: snap ?? emptyStorageData(), backend });
    const phrase = `join campaign ${i}`; phrases.push(phrase);
    st.addCampaign(makeCampaign(i, phrase)); await st.flush(); await st.close();
    if (M > 0) {
      await admin.query(`insert into ${schema}.conversation_state(jid, kind, sender_phone, campaign_id, campaign_result_id, scheduled_at, data, updated_at)
        select 'whatsapp:9725' || lpad(g::text, 8, '0'), 'expired-decision', '9725' || lpad(g::text, 8, '0'), 'camp-${i}', 'old' || g, now() + interval '20 hours',
               jsonb_build_object('kind','expired-decision','senderJid','whatsapp:9725' || lpad(g::text, 8, '0'),'senderPhone','9725' || lpad(g::text, 8, '0'),'campaignId','camp-${i}','campaignResultId','old' || g,'stepId','question','timestamp',(extract(epoch from now())*1000)::bigint), now()
          from generate_series(1, $1) g`, [M]);
    }
    clients.push({ i, schema, url, port: await freePort(), token: `${RUN}-c${i}-owner`, dir: path.join(tmp, `client${i}`) });
  }
  const clientEnv = (c) => ({
    NODE_ENV: 'production', WHATSAPP_PROVIDER: 'META_CLOUD_API', PORT: String(c.port), OWNER_ACCESS_TOKEN: c.token, CLIENT_ACCESS_TOKEN: `${c.token}-client`,
    META_ACCESS_TOKEN: 'load-token', META_PHONE_NUMBER_ID: PN, META_DISPLAY_PHONE_NUMBER: '15550001111', META_APP_SECRET: '', BOT_REPLY_DELAY_MS: '0', CLIENT_NAME: `client-${c.i}`,
    STORAGE_PATH: path.join(c.dir, 'data', 'contacts.json'), CONVERSATION_STATE_PATH: path.join(c.dir, 'data', 'conversation-state.json'), UPLOADS_PATH: path.join(c.dir, 'uploads'), SESSION_PATH: path.join(c.dir, 'session'),
    DATABASE_URL: c.url, ...(side === 'new' ? { INBOX_BACKEND: 'postgres', INBOX_NAMESPACE: `${RUN}-c${c.i}` } : {}),
  });
  for (const c of clients) { c.entry = launch(`client${c.i}`, clientEnv(c), false, c.dir); }
  await Promise.all(clients.map((c) => Promise.race([c.entry.readyPromise, sleep(90000).then(() => { throw new Error(`client ${c.i} did not start`); })])));

  // ---- gateway
  const gwDir = path.join(tmp, 'gateway');
  fs.mkdirSync(path.join(gwDir, 'owner'), { recursive: true });
  fs.writeFileSync(path.join(gwDir, 'owner', 'clients.json'), JSON.stringify(clients.map((c) => ({ id: `client-${c.i}`, name: `client-${c.i}`, accessCode: `code-${c.i}`, ownerAccessToken: c.token, plan: 'self_service', readonlyDashboard: false, maxCampaigns: 7,
    whatsappProvider: 'META_CLOUD_API', metaPhoneNumberId: PN, metaDisplayPhoneNumber: '15550001111', managementUrl: `http://127.0.0.1:${c.port}`, provisioningStatus: 'ready', createdAt: new Date().toISOString() })), null, 1));
  const gwPort = await freePort();
  const gwEnv = { NODE_ENV: 'production', WHATSAPP_PROVIDER: 'META_CLOUD_API', PORT: String(gwPort), OWNER_ACCESS_TOKEN: `${RUN}-gw`, CLIENT_ACCESS_TOKEN: `${RUN}-gw-client`, META_ACCESS_TOKEN: 'load-token', META_PHONE_NUMBER_ID: PN, META_DISPLAY_PHONE_NUMBER: '15550001111', META_APP_SECRET: '',
    STORAGE_PATH: path.join(gwDir, 'data', 'contacts.json'), OWNER_STORAGE_PATH: path.join(gwDir, 'owner', 'clients.json'), CONVERSATION_STATE_PATH: path.join(gwDir, 'data', 'conversation-state.json'), UPLOADS_PATH: path.join(gwDir, 'uploads'), SESSION_PATH: path.join(gwDir, 'session'), DATABASE_URL: '',
    ...(side === 'new' ? { INBOX_BACKEND: 'postgres', INBOX_DATABASE_URL: gwInboxUrl, INBOX_NAMESPACE: RUN } : {}) };
  // gateway inbox history that is never pruned (failed/held), identical on both sides; completed history only where it is retained (new)
  const payload = (id, from) => payloadOf(id, from, 'text', 'old message');
  if (side === 'base') {
    const items = []; const now = Date.now();
    for (let i = 0; i < H; i++) { const id = `hist${i}`; items.push({ id, payload: payload(id, '9725' + String(10000000 + (i % 2000))), status: i % 2 ? 'held' : 'failed', attempts: 60, createdAt: new Date(now - 3600000 + i).toISOString(), updatedAt: new Date(now - 3000000 + i).toISOString(), lastError: 'seeded history' }); }
    fs.writeFileSync(path.join(gwDir, 'owner', 'meta-gateway-inbox.json'), JSON.stringify({ version: 1, items }));
  } else {
    const { createInboxPool, migrateInboxSchema } = require(path.join(dist, 'inbox', 'schema'));
    const gp = createInboxPool(gwInboxUrl, { max: 2 });
    if (gwDbName !== baseUrl.pathname.slice(1)) { /* dedicated DB exists */ }
    await migrateInboxSchema(gp);
    await gp.query(`insert into inbox_senders(namespace, role, sender_key, sender_phone, next_seq) select $1, 'gateway', $2 || ':972509' || lpad(g::text, 6, '0'), '972509' || lpad(g::text, 6, '0'), 1000000 from generate_series(0, 1999) g`, [RUN, PN]);
    if (H + C > 0) await gp.query(`insert into inbox_items(namespace, role, phone_number_id, message_id, sender_key, sender_phone, sender_seq, status, payload, received_at, updated_at, resolution, attempts)
      select $1, 'gateway', $2, 'hist' || n, $2 || ':972509' || lpad((n % 2000)::text, 6, '0'), '972509' || lpad((n % 2000)::text, 6, '0'), n,
             case when n <= $3 then case when n % 2 = 0 then 'held' else 'failed' end else 'completed' end, $4::jsonb, clock_timestamp() - interval '1 day', clock_timestamp() - interval '1 hour',
             case when n <= $3 then 'exhausted' else 'processed' end, 60 from generate_series(1, $5) n`, [RUN, PN, H, JSON.stringify(payload('x', '972509000000')), H + C]);
    await gp.query('analyze inbox_items'); await gp.end();
  }
  const gw = launch('gateway', gwEnv, true, gwDir);
  await Promise.race([gw.readyPromise, sleep(90000).then(() => { throw new Error('gateway did not start'); })]);
  await sleep(1500);

  // ---- drive
  const participants = [];
  for (let k = 0; k < N; k++) {
    const idx = k % 10 < 7 ? 0 : 1 + (k % (CLIENTS - 1));           // ~70% on the launch client, the rest spread (shared number)
    participants.push({ k, phone: '97253' + String(1000000 + k), client: idx % CLIENTS, abandon: (k * 7919 % 100) / 100 < abandon, tid: `t-${RUN}-${k}`, aid: `a-${RUN}-${k}`, t0: 0, answered: false });
  }
  const t0 = new Map();
  const postedStatus = { ok: 0, fail: 0 };
  const acked = new Set(); const postAttempts = { retried: 0, gaveUp: 0 };
  // Meta re-delivers a webhook that was not answered 2xx. The driver does the same (1s..8s backoff, up to 3 minutes), so a message is
  // "acknowledged" only after a real 200 - and only acknowledged messages can be held against the system as lost.
  const deliver = async (id, payload) => {
    const first = Date.now(); let wait = 1000;
    for (let attempt = 0; ; attempt++) {
      const st = await post(gwPort, '/webhooks/meta/whatsapp', payload);
      if (st === 200) { acked.add(id); if (attempt > 0) postAttempts.retried += 1; return true; }
      if (Date.now() - first > 180000) { postAttempts.gaveUp += 1; return false; }
      await sleep(wait); wait = Math.min(8000, wait * 2);
    }
  };
  const sendTrigger = async (p) => { p.t0 = Date.now(); t0.set(p.tid, p.t0); const ok = await deliver(p.tid, payloadOf(p.tid, p.phone, 'text', phrases[p.client])); if (ok) postedStatus.ok += 1; else postedStatus.fail += 1; };
  const sendAnswer = async (p) => { p.answered = true; t0.set(p.aid, Date.now()); await deliver(p.aid, payloadOf(p.aid, p.phone, 'interactive')); };
  const startedAt = Date.now();
  const faultLog = [];
  const faultDone = { promise: Promise.resolve(), resolve: () => {} };
  const scheduleFault = () => {
    const m = /^([a-z-]+)@([\d.]+)(?::(\d+))?$/.exec(fault); if (!m) return;
    const [, kind, at, dur] = m; const atMs = Number(at) * 1000;
    faultDone.promise = new Promise((resolve) => { faultDone.resolve = resolve; });
    setTimeout(async () => {
      const c0 = clients[0];
      faultLog.push({ kind, atS: Number(at), realT: Date.now() - startedAt });
      try {
      if (kind === 'kill-client') { await stopProc(c0.entry, 'SIGKILL'); await sleep(4000); c0.entry = launch('client0b', clientEnv(c0), false, c0.dir); await c0.entry.readyPromise; }
      else if (kind === 'term-client') { await stopProc(c0.entry, 'SIGTERM', 20000); await sleep(1000); c0.entry = launch('client0b', clientEnv(c0), false, c0.dir); await c0.entry.readyPromise; }
      else if (kind === 'client-down') { await stopProc(c0.entry, 'SIGKILL'); await sleep(Number(dur) * 1000); c0.entry = launch('client0b', clientEnv(c0), false, c0.dir); await c0.entry.readyPromise; }
      else if (kind === 'kill-gateway') { await stopProc(gw, 'SIGKILL'); await sleep(3000); const g2 = launch('gateway2', { ...gwEnv, PORT: String(gwPort) }, true, gwDir); await g2.readyPromise; gw.entry2 = g2; }
      else if (kind === 'db-outage') {
        await admin.query(`alter database ${gwDbName} with allow_connections false`);
        await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()', [gwDbName]);
        await sleep(Number(dur) * 1000);
      }
      } catch (err) { faultLog[faultLog.length - 1].error = String(err && err.message || err); }
      finally { if (kind === 'db-outage') await admin.query(`alter database ${gwDbName} with allow_connections true`).catch(() => {}); }
      faultLog[faultLog.length - 1].doneS = +((Date.now() - startedAt) / 1000).toFixed(1);
      faultDone.resolve();
    }, atMs);
  };
  scheduleFault();
  // ---- soak instrumentation (sustained only): participants answer WHILE the drive runs (not after it), and a 60s timeline is appended
  // to a .jsonl as it goes (a crash mid-run keeps everything so far).
  let answerer = null; let timelineTimer = null; const timeline = [];
  if (scenario === 'sustained') {
    answerer = setInterval(() => { for (const p of participants) if (p.t0 && !p.abandon && !p.answered && events.firstSend.has(p.phone) && Date.now() - events.firstSend.get(p.phone) > 1500) void sendAnswer(p); }, 500);
    const tlFile = resultsPath(`c6-${label}-timeline-${new Date().toISOString().slice(0, 10)}.jsonl`); fs.writeFileSync(tlFile, '');
    const tp = new Pool({ connectionString: gwInboxUrl, max: 1 }); let lastAt = Date.now();
    timelineTimer = setInterval(async () => {
      const now = Date.now(); const from = lastAt; lastAt = now;
      const win = (arr) => arr.filter((x) => x.t > from && x.t <= now);
      const gl = win(events.lag.gateway); const cl0 = win(events.lag.client.filter((x) => x.name === 'client0' || x.name === 'client0b'));
      const posted = participants.filter((p) => p.t0 && p.t0 > from && p.t0 <= now);
      const fr = posted.filter((p) => events.firstSend.has(p.phone)).map((p) => events.firstSend.get(p.phone) - p.t0);
      const rh = []; for (const p of posted) { const h = events.handlerStart.get(p.tid); if (h !== undefined) rh.push(h - p.t0); }
      const cs = {}; for (const [k, arr] of Object.entries(events.cs)) { const w = arr.filter((x) => x.t > from && x.t <= now); if (w.length) { const last = w[w.length - 1]; cs[k] = { ops: last.ops, p50: last.p50, p99: last.p99, max: last.max, conversations: last.size }; } }
      let gwCounts = null, oldest = null, convRows = null;
      try {
        gwCounts = Object.fromEntries((await tp.query("select status, count(*)::int n from inbox_items where namespace = $1 and role = 'gateway' and status in ('queued','retry','processing','review','held','failed') group by status", [RUN])).rows.map((r) => [r.status, r.n]));
        oldest = (await tp.query("select coalesce(extract(epoch from (clock_timestamp() - min(due_at))) * 1000, 0)::int as ms from inbox_senders where namespace = $1 and role = 'gateway' and head_id is not null and due_at <= statement_timestamp()", [RUN])).rows[0].ms;
        convRows = 0; for (const c of clients) convRows += (await admin.query(`select count(*)::int n from ${c.schema}.conversation_state`)).rows[0].n;
      } catch { /* keep sampling */ }
      const row = { tMin: +((now - startedAt) / 60000).toFixed(1), posted: posted.length, firstResponseMs: { n: fr.length, p50: pct(fr, 50), p99: pct(fr, 99), max: fr.length ? Math.max(...fr) : null }, receiptToHandlerMs: { n: rh.length, p50: pct(rh, 50), p99: pct(rh, 99) },
        gatewayLagMs: { p99Worst: gl.length ? Math.max(...gl.map((x) => x.p99)) : null, max: gl.length ? Math.max(...gl.map((x) => x.max)) : null, samples: gl.length }, clientLagMs: { p99Worst: cl0.length ? Math.max(...cl0.map((x) => x.p99)) : null, max: cl0.length ? Math.max(...cl0.map((x) => x.max)) : null },
        rssMB: { gateway: gl.length ? gl[gl.length - 1].rssMB : null, client0: cl0.length ? cl0[cl0.length - 1].rssMB : null }, conversationStateOpMs: cs, conversationRowsAllClients: convRows, gatewayInbox: gwCounts, gatewayOldestDueMs: oldest, sentTotal: [...events.sendCount.values()].reduce((a, b) => a + b, 0) };
      timeline.push(row); fs.appendFileSync(tlFile, JSON.stringify(row) + '\n');
    }, 60000);
  }
  if (scenario === 'burst') {
    await Promise.all(participants.map((p) => sendTrigger(p)));
  } else {
    const gap = (durationS * 1000) / N;
    for (const p of participants) { void sendTrigger(p); await sleep(gap); }
  }
  const postedAt = Date.now();
  // answer to a participant once its first response arrived (unless it abandons); then wait for everything to settle
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    let waiting = 0;
    for (const p of participants) {
      if (!events.firstSend.has(p.phone)) { waiting += 1; continue; }
      if (!p.abandon && !p.answered && Date.now() - events.firstSend.get(p.phone) > 1500) void sendAnswer(p);
    }
    if (!waiting && participants.every((p) => p.abandon || p.answered)) break;
    await sleep(500);
  }
  await faultDone.promise;                       // never collect while the fault is still in progress
  if (Number(arg('observe', '0')) > 0) await sleep(Number(arg('observe', '0')) * 1000);   // recovery observation with no traffic (lets expired leases re-run)
  const settleDeadline = Date.now() + 240000;    // let acknowledged work drain after the fault (bounded)
  while (Date.now() < settleDeadline) {
    let pending = 0;
    for (const [id] of t0) if (acked.has(id) && !events.handlerStart.has(id)) pending += 1;
    for (const p of participants) if (!p.abandon && !p.answered && events.firstSend.has(p.phone)) { void sendAnswer(p); pending += 1; }
    if (!pending) break;
    await sleep(1000);
  }
  await sleep(scenario === 'sustained' ? 15000 : 8000);
  const endedAt = Date.now();
  if (answerer) clearInterval(answerer); if (timelineTimer) clearInterval(timelineTimer);

  // ---- collect
  const lat = []; let missing = 0;
  for (const p of participants) { const f = events.firstSend.get(p.phone); if (f === undefined) missing += 1; else lat.push(f - p.t0); }
  const recv = []; let noHandler = 0;
  let ackedNoHandler = 0;
  for (const [id, t] of t0) { const h = events.handlerStart.get(id); if (h === undefined) { noHandler += 1; if (acked.has(id)) ackedNoHandler += 1; } else recv.push(h - t); }
  const results = [];
  for (const c of clients) {
    const r = await admin.query(`select count(*)::int n, count(distinct phone)::int d from ${c.schema}.campaign_results where campaign_id = $1`, [`camp-${c.i}`]);
    const expected = participants.filter((p) => p.client === c.i).length;
    results.push({ client: c.i, expected, results: r.rows[0].n, distinctPhones: r.rows[0].d });
  }
  let traceProbe = null;
  const inboxCounts = { gateway: null, clientsReview: 0, clientsByStatus: {} };
  if (side === 'new') {
    const gp = new Pool({ connectionString: gwInboxUrl, max: 2 });
    inboxCounts.gateway = Object.fromEntries((await gp.query('select status, count(*)::int n from inbox_items where namespace = $1 and role = $2 group by status', [RUN, 'gateway'])).rows.map((r) => [r.status, r.n]));
    await gp.end();
    for (const c of clients) {
      const rows = (await admin.query(`select status, count(*)::int n from ${c.schema}.inbox_items group by status`)).rows;
      for (const r of rows) inboxCounts.clientsByStatus[r.status] = (inboxCounts.clientsByStatus[r.status] || 0) + r.n;
    }
    inboxCounts.clientsReview = inboxCounts.clientsByStatus.review || 0;
    // D1 trace probe: for every interrupted (ambiguous) item, which DURABLE traces of a run exist for that participant. Every effect type
    // a run can produce is listed (inventory of src/messageFlow.ts): campaign result (+stage/email/score/referral code live on it), campaign events,
    // outbox rows (every send goes through the outbox), contact-save queue, saved contacts, conversation state (other than the ambiguity hold
    // itself), scheduled jobs. Ground truth outside the database: the fake Meta saw a send to that phone. Unknown effect type = NOT clean.
    traceProbe = { ambiguous: 0, clean: 0, withTrace: 0, byType: {}, providerSendSeenButNoDbTrace: 0, items: [] };
    for (const c of clients) {
      const items = (await admin.query(`select id, sender_phone from ${c.schema}.inbox_items where status = 'review' and resolution = 'ambiguous_processing'`)).rows;
      for (const it of items) {
        const ph = String(it.sender_phone || '').replace(/\D/g, ''); const like = '%' + ph + '%';
        const q = async (sql) => (await admin.query(sql, [ph, like])).rows[0].n;
        const t = {
          campaign_result: await q(`select count(*)::int n from ${c.schema}.campaign_results where phone = $1`),
          campaign_events: await q(`select count(*)::int n from ${c.schema}.campaign_events where phone = $1`),
          outbox: await q(`select count(*)::int n from ${c.schema}.outbox_messages where recipient like $2`),
          contact_queue: await q(`select count(*)::int n from ${c.schema}.contact_queue where phone = $1`),
          saved_contact: await q(`select count(*)::int n from ${c.schema}.saved_contacts where phone = $1`),
          conversation_state: await q(`select count(*)::int n from ${c.schema}.conversation_state where (sender_phone = $1 or jid like $2) and coalesce(data->>'source','') <> 'inbox'`),
          scheduled_job: await q(`select count(*)::int n from ${c.schema}.scheduled_jobs where target_id like $2 or data::text like $2`),
        };
        const found = Object.entries(t).filter(([, n]) => n > 0).map(([k]) => k);
        const providerSends = events.sendCount.get(ph) || events.sendCount.get('+' + ph) || 0;
        traceProbe.ambiguous += 1; if (found.length) traceProbe.withTrace += 1; else traceProbe.clean += 1;
        for (const k of found) traceProbe.byType[k] = (traceProbe.byType[k] || 0) + 1;
        if (!found.length && providerSends > 0) traceProbe.providerSendSeenButNoDbTrace += 1;
        traceProbe.items.push({ client: c.i, phoneTail: ph.slice(-4), traces: found, providerSends });
      }
    }
  } else {
    const gj = path.join(gwDir, 'owner', 'meta-gateway-inbox.json');
    const parsed = fs.existsSync(gj) ? JSON.parse(fs.readFileSync(gj, 'utf8')) : { items: [] };
    inboxCounts.gateway = parsed.items.reduce((a, i) => { a[i.status] = (a[i.status] || 0) + 1; return a; }, {});
  }
  const lagOf = (arr, from, to) => { const s = arr.filter((x) => x.t >= from && x.t <= to); return { p99: pct(s.map((x) => x.p99), 50), worstP99: s.length ? Math.max(...s.map((x) => x.p99)) : null, max: s.length ? Math.max(...s.map((x) => x.max)) : null, samples: s.length }; };
  const summary = {
    label, side, scenario, participants: N, clients: CLIENTS, historyNeverPruned: H, completedHistoryNewOnly: C, seededConversationsPerClient: M, fault, faultLog, preflight: pre,
    posted: postedStatus, durationS: +((endedAt - startedAt) / 1000).toFixed(1), driveS: +((postedAt - startedAt) / 1000).toFixed(1),
    firstResponseMs: { n: lat.length, missing, p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: lat.length ? Math.max(...lat) : null },
    receiptToHandlerMs: { n: recv.length, neverStarted: noHandler, acknowledgedButNeverStarted: ackedNoHandler, notAcknowledgedByDriverGiveUp: postAttempts.gaveUp, redeliveredWebhooks: postAttempts.retried, p50: pct(recv, 50), p95: pct(recv, 95), p99: pct(recv, 99), max: recv.length ? Math.max(...recv) : null },
    gatewayEventLoopMs: lagOf(events.lag.gateway, startedAt, endedAt), clientEventLoopMs: lagOf(events.lag.client, startedAt, endedAt),
    perClientResults: results, lostResults: results.reduce((a, r) => a + Math.max(0, r.expected - r.distinctPhones), 0), duplicateResults: results.reduce((a, r) => a + Math.max(0, r.results - r.distinctPhones), 0),
    logs: events.logs, inboxActualCounts: inboxCounts, traceProbe, timeline, host: { cpu: os.cpus()[0].model, threads: os.cpus().length, ramGB: Math.round(os.totalmem() / 1e9), node: process.version },
  };
  console.log(JSON.stringify(summary));
  if (events.gwLines.length) fs.writeFileSync(resultsPath(`c6-${label}-gateway-lines-${new Date().toISOString().slice(0, 10)}.log`), events.gwLines.join(String.fromCharCode(10)));
  fs.writeFileSync(arg('out', resultsPath(`c6-${label}-${new Date().toISOString().slice(0, 10)}.json`)), JSON.stringify(summary, null, 1));

  // ---- teardown
  for (const p of [...procs].reverse()) await stopProc(p, 'SIGTERM', 12000);
  if (side === 'new') { const gp = new Pool({ connectionString: gwInboxUrl, max: 1 }); await gp.query('delete from inbox_items where namespace = $1', [RUN]); await gp.query('delete from inbox_senders where namespace = $1', [RUN]); await gp.end(); }
  for (const c of clients) await admin.query(`drop schema if exists ${c.schema} cascade`);
  await admin.end(); agent.destroy();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch(async (e) => { console.error('HARNESS FAILED:', e); for (const p of procs) { try { p.child.kill('SIGKILL'); } catch { /* gone */ } } process.exit(1); });
