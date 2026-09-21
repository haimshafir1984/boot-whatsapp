/**
 * Stage E / C4 - conversation state in PostgreSQL mode is persisted ROW BY ROW (no full snapshot, no full deep clone, no shadow
 * file) and restored from the database only. Real PostgreSQL (TEST_DATABASE_URL, local database whose name contains "test").
 * Exit 3 = BLOCKED, never a skip. WARNING: like the other PG tests this TRUNCATES the application tables of the test database.
 *
 * The six proofs required before the shadow file may be dropped in PostgreSQL mode:
 *   T1 flush -> restart from the database ALONE (no shadow file exists) -> same conversations, timers, needs_review, recovery, held messages
 *   T2 a failing database write is never reported as durable; it is retried and lands once the database is back
 *   T3 the cost of one change does not grow with the number of resident conversations
 *   T4 an empty database never resurrects conversations from a stale leftover file
 *   T5 JSON mode is unchanged (file is the source of truth, atomic write, a write failure reaches the caller)
 *   T6 export / snapshot load still contain the conversations (they come from the database rows)
 */
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { Pool } = require('pg');
const { createPostgresBackend, migrateDatabase, loadStorageSnapshot } = require('../dist/database');
const { emptyStorageData, Storage } = require('../dist/storage');
const { conversationState } = require('../dist/conversationState');

const url = process.env.TEST_DATABASE_URL;
if (!url) { console.error('BLOCKED: TEST_DATABASE_URL is not set (needs a local PostgreSQL test database).'); process.exit(3); }
const parsed = new URL(url);
if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || !parsed.pathname.toLowerCase().includes('test')) { console.error('Refusing to run: TEST_DATABASE_URL must be a local database whose name contains "test".'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pool = new Pool({ connectionString: url });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'convrows-'));
async function clear() {
  const sb = await pool.query("select to_regclass('public.service_bot_state') as name");
  if (sb.rows[0]?.name) await pool.query('truncate table service_bot_state restart identity');
  await pool.query('truncate table scheduled_jobs, conversation_state, outbox_messages, twilio_templates, uploaded_files, saved_contacts, contact_queue, campaign_events, campaign_results, campaigns, client_profile, admin_settings, app_state restart identity');
}
const results = [];
async function scenario(name, fn) { try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 4).join(' | ')]); } }
async function boot() {
  const backend = await createPostgresBackend(url); const snapshot = await backend.loadSnapshot();
  return new Storage('unused-convrows.json', { initialData: snapshot ?? emptyStorageData(), backend });
}
const FLOW = [{ id: 'q1', kind: 'question', presentation: 'buttons', text: 'Pick', options: [{ id: 'a', text: 'A' }] }, { id: 'done', kind: 'message', text: 'Thanks' }];
const timed = new Set(['name', 'pre-name-prompt', 'decision', 'wait-reply', 'expired-decision', 'contact-card-confirmation', 'handoff']);
let scheduled = [];
const scheduleStub = (jid, state) => { scheduled.push(jid); return state.kind === 'needs_review' ? undefined : setTimeout(() => {}, 1e8).unref(); };
const restart = async (storage, file) => {
  await storage.close();
  const s2 = await boot();
  conversationState.__resetForTest(); scheduled = [];
  conversationState.configurePersistence(file, s2);
  const restored = conversationState.restore(scheduleStub, () => FLOW);
  return { storage: s2, restored };
};
const dec = (i, extra = {}) => ({ kind: 'decision', senderJid: `whatsapp:9725${String(i).padStart(7, '0')}`, senderPhone: `9725${String(i).padStart(7, '0')}`, campaignId: 'c1', campaignResultId: `r${i}`, flow: FLOW, stepId: 'q1', timestamp: Date.now(), ...extra });
const persistedRows = async () => Object.fromEntries((await pool.query('select jid, data from conversation_state')).rows.map((r) => [r.jid, r.data]));

(async () => {
  await migrateDatabase(url);

  await scenario('T1 flush -> restart from the database ALONE: same conversations, timers, needs_review + recovery + held messages; nothing else came back; no shadow file was ever written', async () => {
    await clear();
    const file = path.join(tmp, 't1', 'conversation-state.json');
    let storage = await boot();
    conversationState.__resetForTest(); conversationState.configurePersistence(file, storage); conversationState.restore(scheduleStub, () => FLOW);
    const a = dec(1), b = dec(2, { kind: 'wait-reply', flow: FLOW, humanHandoffEnabled: false }), c = dec(3, { kind: 'expired-decision' }), d = dec(4), e = dec(5);
    for (const st of [a, b, c, d, e]) conversationState.set(st.senderJid, st);
    conversationState.set('whatsapp:972590000009', { kind: 'needs_review', senderJid: 'whatsapp:972590000009', senderPhone: '972590000009', reason: 'delivery unknown', timestamp: Date.now(), recovery: { outboxId: 'ob1', unitId: 'fu_1' } });
    conversationState.appendHeldMessage('whatsapp:972590000009', { messageId: 'm1', source: 'baileys', bodyPreview: 'hi', timestamp: Date.now(), replay: { from: 'whatsapp:972590000009', senderPhone: '972590000009', body: 'hi there', hasUserSignal: true } });
    conversationState.pause(a.senderJid);                                     // in-place change
    conversationState.remove(d.senderJid);                                    // removal
    conversationState.removeByPhone(e.senderPhone);                           // removal by phone
    await storage.flush();
    assert.equal(fs.existsSync(file), false, 'PostgreSQL mode writes no shadow file');
    assert.equal(fs.existsSync(path.dirname(file)), false, 'not even its directory');
    const before = await persistedRows();
    assert.deepEqual(Object.keys(before).sort(), [a.senderJid, b.senderJid, c.senderJid, 'whatsapp:972590000009'].sort());
    assert.equal(before[a.senderJid].flow, undefined, 'the campaign flow is not stored per conversation');
    const r = await restart(storage, file); storage = r.storage;
    assert.equal(r.restored, 4);
    assert.deepEqual([...scheduled].sort(), Object.keys(before).sort(), 'every persisted conversation was restored (and its timer scheduled)');
    for (const jid of Object.keys(before)) {
      const live = conversationState.get(jid); assert.ok(live, jid);
      if (timed.has(live.kind)) assert.ok(live.timeoutHandle, 'timer rescheduled for ' + jid);
      assert.equal(live.kind, before[jid].kind);
    }
    assert.deepEqual(conversationState.get(a.senderJid).flow, FLOW, 'the flow was rebuilt from the campaign');
    const hold = conversationState.getNeedsReview('whatsapp:972590000009');
    assert.equal(hold.recovery.outboxId, 'ob1'); assert.equal(hold.heldMessages[0].replay.body, 'hi there', 'held message replay data survived');
    assert.equal(conversationState.get(d.senderJid), undefined); assert.equal(conversationState.get(e.senderJid), undefined);
    assert.equal(fs.existsSync(file), false, 'restore did not create the file either');
    await storage.close();
  });

  await scenario('T2 a failing database write is never reported durable, is retried, and lands when the database is back', async () => {
    await clear();
    const file = path.join(tmp, 't2', 'cs.json');
    let storage = await boot();
    conversationState.__resetForTest(); conversationState.configurePersistence(file, storage); conversationState.restore(scheduleStub, () => FLOW);
    await pool.query('alter table conversation_state rename to conversation_state_broken');
    try {
      const st = dec(11); conversationState.set(st.senderJid, st);
      await assert.rejects(() => storage.flush(), /conversation_state|relation|does not exist/i, 'flush must fail while the write cannot be committed');
      assert.equal(storage.getStorageHealth().ready, false, 'health reports the failure');
    } finally { await pool.query('alter table conversation_state_broken rename to conversation_state'); }
    let landed = false;
    for (let i = 0; i < 40 && !landed; i++) { try { await storage.flush(); landed = true; } catch { await sleep(250); } }
    assert.ok(landed, 'the retry committed once the table was back');
    assert.deepEqual(Object.keys(await persistedRows()), [dec(11).senderJid]);
    await storage.close();
  });

  await scenario('T3 the cost of ONE change does not grow with resident conversations (100 vs 20,000)', async () => {
    const measure = async (N) => {
      await clear();
      await pool.query(`insert into conversation_state(jid, kind, sender_phone, campaign_id, campaign_result_id, scheduled_at, data, updated_at)
        select 'whatsapp:9725' || lpad(g::text, 8, '0'), 'expired-decision', '9725' || lpad(g::text, 8, '0'), 'c1', 'r' || g, now() + interval '1 day',
               jsonb_build_object('kind','expired-decision','senderJid','whatsapp:9725' || lpad(g::text, 8, '0'),'senderPhone','9725' || lpad(g::text, 8, '0'),'campaignId','c1','campaignResultId','r' || g,'stepId','q1','timestamp',1), now()
          from generate_series(1, $1) g`, [N]);
      const file = path.join(tmp, `t3-${N}`, 'cs.json');
      const storage = await boot();
      conversationState.__resetForTest(); conversationState.configurePersistence(file, storage);
      assert.equal(conversationState.restore(scheduleStub, () => FLOW), N);
      await storage.flush();
      const sync = []; const h = monitorEventLoopDelay({ resolution: 1 }); h.enable();
      for (let r = 0; r < 60; r++) {
        const st = dec(1 + (r % N), { kind: 'decision', timestamp: Date.now() + r }); st.senderJid = `whatsapp:9725${String(1 + (r % N)).padStart(8, '0')}`; st.senderPhone = st.senderJid.slice(9);
        const t0 = process.hrtime.bigint(); conversationState.set(st.senderJid, st); sync.push(Number(process.hrtime.bigint() - t0) / 1e6);
        await storage.flush();
      }
      h.disable();
      await storage.close();
      const s = [...sync].sort((x, y) => x - y);
      return { N, setMedianMs: +s[Math.floor(s.length / 2)].toFixed(3), setMaxMs: +s[s.length - 1].toFixed(3), loopP99Ms: +(h.percentile(99) / 1e6).toFixed(2), loopMaxMs: +(h.max / 1e6).toFixed(2) };
    };
    const small = await measure(100); const large = await measure(20000);
    console.log('T3 measured:', JSON.stringify({ small, large }));
    assert.ok(large.setMedianMs <= small.setMedianMs * 3 + 0.5, `set() grew with N: ${small.setMedianMs} -> ${large.setMedianMs}ms`);
    assert.ok(large.loopMaxMs <= small.loopMaxMs + 25, `event-loop blocking grew with N: max ${small.loopMaxMs} -> ${large.loopMaxMs}ms`);
    assert.ok(large.setMedianMs < 2, `one conversation change costs ${large.setMedianMs}ms of synchronous time at 20,000 conversations`);
  });

  await scenario('T4 an EMPTY database never resurrects conversations from a stale leftover file', async () => {
    await clear();
    const file = path.join(tmp, 't4', 'conversation-state.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const stale = { version: 1, savedAt: new Date().toISOString(), conversations: { 'whatsapp:972500000777': { kind: 'expired-decision', senderJid: 'whatsapp:972500000777', senderPhone: '972500000777', campaignId: 'c1', stepId: 'q1', timestamp: Date.now() } } };
    fs.writeFileSync(file, JSON.stringify(stale));
    const storage = await boot();
    conversationState.__resetForTest(); conversationState.configurePersistence(file, storage);
    assert.equal(conversationState.restore(scheduleStub, () => FLOW), 0, 'nothing restored from the file');
    assert.equal(conversationState.get('whatsapp:972500000777'), undefined);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).conversations['whatsapp:972500000777'].kind, 'expired-decision', 'the leftover file is left alone');
    assert.equal(Object.keys(await persistedRows()).length, 0);
    await storage.close();
  });

  await scenario('T5 JSON mode is unchanged: the file is the source of truth, written atomically; a write failure REACHES the caller; restore from file / .bak', async () => {
    const file = path.join(tmp, 't5', 'conversation-state.json');
    const storage = new Storage(path.join(tmp, 't5-storage.json'));
    conversationState.__resetForTest(); conversationState.configurePersistence(file, storage); conversationState.restore(scheduleStub, () => FLOW);
    const st = dec(21); conversationState.set(st.senderJid, st);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(written.conversations[st.senderJid], 'JSON mode writes the conversation file'); assert.equal(written.conversations[st.senderJid].flow, undefined);
    const st2 = dec(22); conversationState.set(st2.senderJid, st2);
    assert.ok(fs.existsSync(file + '.bak'), 'the previous good copy is kept (.bak)');
    fs.writeFileSync(file, '{ truncated');                                            // crash mid-write of the main file
    const freshStorage = new Storage(path.join(tmp, 't5-storage-fresh.json'));                // a real restart: storage has no snapshot, so restore must use the file
    conversationState.__resetForTest(); conversationState.configurePersistence(file, freshStorage);
    const bakKeys = Object.keys(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')).conversations);
    assert.equal(conversationState.restore(scheduleStub, () => FLOW), bakKeys.length, 'restored exactly what the .bak copy holds (' + bakKeys.length + ')');
    assert.ok(bakKeys.length >= 1, 'the .bak copy holds the previous good state');
    const blocker = path.join(tmp, 'a-file-not-a-dir'); fs.writeFileSync(blocker, 'x');
    conversationState.configurePersistence(path.join(blocker, 'cs.json'), storage);
    assert.throws(() => conversationState.set(dec(23).senderJid, dec(23)), 'in JSON mode a failed write reaches the caller (the state is not durable)');
  });

  await scenario('T6 the database rows are what export / snapshot load see (backup and db:export do not need the file)', async () => {
    await clear();
    const file = path.join(tmp, 't6', 'cs.json');
    let storage = await boot();
    conversationState.__resetForTest(); conversationState.configurePersistence(file, storage); conversationState.restore(scheduleStub, () => FLOW);
    for (const i of [31, 32, 33]) conversationState.set(dec(i).senderJid, dec(i));
    conversationState.remove(dec(32).senderJid);
    await storage.flush();
    const snap = await loadStorageSnapshot(url);
    assert.deepEqual(Object.keys(snap.conversationStateSnapshot.conversations).sort(), [dec(31).senderJid, dec(33).senderJid].sort());
    assert.equal(fs.existsSync(file), false);
    await storage.close();
  });

  await scenario('restore drops non-restorable rows from the database (as the old full rewrite did) and a change after restore still lands', async () => {
    await clear();
    await pool.query("insert into conversation_state(jid, kind, sender_phone, data) values ('whatsapp:972500000801','unknown-kind','972500000801','{\"kind\":\"unknown-kind\",\"senderJid\":\"whatsapp:972500000801\"}'::jsonb)");
    const file = path.join(tmp, 't7', 'cs.json');
    let storage = await boot();
    conversationState.__resetForTest(); conversationState.configurePersistence(file, storage);
    assert.equal(conversationState.restore(scheduleStub, () => FLOW), 0);
    await storage.flush();
    assert.equal(Object.keys(await persistedRows()).length, 0, 'the unrestorable row was removed');
    const st = dec(41); conversationState.set(st.senderJid, st); await storage.flush();
    assert.equal(Object.keys(await persistedRows()).length, 1);
    await storage.close();
  });

  await pool.end();
  let failed = 0;
  for (const r of results) { if (r[1] === 'FAIL') failed++; console.log(r[1] + '  ' + r[0]); if (r[2]) console.log('      ' + r[2]); }
  console.log(`conversation-state-rows-postgres: ${results.length - failed} passed, ${failed} failed (real PostgreSQL ${parsed.hostname}:${parsed.port}${parsed.pathname})`);
  fs.rmSync(tmp, { recursive: true, force: true });
  setTimeout(() => process.exit(failed ? 1 : 0), 200);
})().catch((e) => { console.error(e); process.exit(1); });
