/**
 * Stage B2 / step 2 - durable status forwarding (gateway) and exact status matching (client).
 *
 * Part A  MetaStatusQueue (journal): durability, dedupe, replay, torn tail vs corrupt journal, backoff, expiry.
 * Part B  real gateway (startAdminServer): a status is persisted BEFORE the webhook is acknowledged, is retried
 *         until each client acknowledges it, survives a gateway restart, is not delivered twice, and a
 *         persistence failure is answered with 503 so Meta re-sends.
 * Part C  Storage.applyMetaStatus: matching by attempt id / provider id ONLY, foreign / mismatch / duplicate /
 *         late / early statuses, and persistence across a restart.
 * Part D  the client endpoint acknowledges a status only after it is durable (503 on a failed flush).
 * No network beyond 127.0.0.1.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-fwd-'));
Object.assign(process.env, {
  NODE_ENV: 'test', WHATSAPP_PROVIDER: 'META_CLOUD_API',
  STORAGE_PATH: path.join(root, 'gateway-storage.json'), OWNER_STORAGE_PATH: path.join(root, 'owner.json'),
  CONVERSATION_STATE_PATH: path.join(root, 'conv.json'), UPLOADS_PATH: path.join(root, 'uploads'),
  OWNER_ACCESS_TOKEN: 'status-owner-token',  META_ATTEMPT_CALLBACK_DATA: 'on', CLIENT_ACCESS_TOKEN: 'status-client-token',
  META_ACCESS_TOKEN: '', META_PHONE_NUMBER_ID: 'shared-phone-id', META_DISPLAY_PHONE_NUMBER: '15550001111',
});
const { MetaStatusQueue, statusDedupeKey } = require('../dist/metaStatusQueue');
const { Storage } = require('../dist/storage');
const { newAttemptId } = require('../dist/sendAttempt');
const { config } = require('../dist/config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, label) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return; await sleep(20); } throw new Error(`timed out (${ms}ms): ${label}`); }
const results = [];
async function scenario(name, fn) { try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.message || String(e)).split('\n').slice(0, 3).join(' | ')]); } }
const statusPayload = (statuses) => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: 'shared-phone-id', display_phone_number: '15550001111' }, statuses } }] }] });
const st = (over = {}) => ({ id: 'wamid.A', status: 'delivered', timestamp: '1700000000', recipient_id: '972500000001', ...over });

(async () => {
  // ================================================================= Part A
  await scenario('A1 queue: enqueue is durable before returning; dedupes per (status, client); replay after restart keeps pending', async () => {
    const f = path.join(root, 'qa1.jsonl'); const q = new MetaStatusQueue(f);
    const p = statusPayload([st()]); const key = statusDedupeKey(p);
    assert.deepEqual(q.enqueue(key, p, ['c1', 'c2']), { added: 2, duplicates: 0 });
    assert.equal(fs.readFileSync(f, 'utf8').trim().split('\n').length, 2, 'journal written before enqueue returned');
    assert.deepEqual(q.enqueue(key, p, ['c1', 'c2', 'c3']), { added: 1, duplicates: 2 }, 'a re-sent webhook is not queued twice; a NEW client target is');
    const q2 = new MetaStatusQueue(f);   // restart
    assert.equal(q2.stats().pending, 3);
    assert.deepEqual(q2.due(10).map((i) => i.clientId).sort(), ['c1', 'c2', 'c3']);
  });
  await scenario('A2 queue: completed entries do not come back after restart and are remembered (Meta re-send of a delivered status is ignored)', async () => {
    const f = path.join(root, 'qa2.jsonl'); const q = new MetaStatusQueue(f); const p = statusPayload([st({ id: 'wamid.B' })]); const key = statusDedupeKey(p);
    q.enqueue(key, p, ['c1']); const [item] = q.due(1); q.begin(item.id); q.complete(item.id);
    const q2 = new MetaStatusQueue(f);
    assert.equal(q2.stats().pending, 0);
    assert.deepEqual(q2.enqueue(key, p, ['c1']), { added: 0, duplicates: 1 });
  });
  await scenario('A3 queue: failure backs off (capped) and keeps the entry; drop / expiry are journaled', async () => {
    let now = 1_000_000; const f = path.join(root, 'qa3.jsonl'); const q = new MetaStatusQueue(f, { now: () => now, maxAgeMs: 10_000 });
    q.enqueue('k', statusPayload([st()]), ['c1']); const [item] = q.due(1); q.begin(item.id);
    assert.equal(q.fail(item.id), 500); assert.equal(q.due(1).length, 0, 'not due during backoff');
    now += 600; assert.equal(q.due(1).length, 1);
    q.begin(item.id); assert.equal(q.fail(item.id), 1000);
    for (let i = 0; i < 12; i++) { now += 40_000; q.due(1); q.begin(item.id); q.fail(item.id); }
    assert.equal(q.fail(item.id) <= 30_000, true, 'backoff is capped at 30s');
    now += 60_000; const gone = q.expire(); assert.equal(gone.length, 1); assert.equal(q.stats().pending, 0);
    assert.equal(new MetaStatusQueue(f).stats().pending, 0, 'expiry survived restart');
  });
  await scenario('A4 journal: a torn LAST line (crash mid-append) is discarded; a corrupt line elsewhere REFUSES to load (never "empty")', async () => {
    const f = path.join(root, 'qa4.jsonl'); const q = new MetaStatusQueue(f);
    q.enqueue('k1', statusPayload([st()]), ['c1']); q.enqueue('k2', statusPayload([st({ id: 'wamid.Z' })]), ['c1']);
    fs.appendFileSync(f, '{"t":"add","id":"k3|c1","clientId":"c1","payl');   // torn, no newline
    assert.equal(new MetaStatusQueue(f).stats().pending, 2, 'the two complete entries survive');
    assert.ok(fs.readFileSync(f, 'utf8').endsWith('\n'), 'torn tail was truncated');
    const lines = fs.readFileSync(f, 'utf8').split('\n'); lines.splice(1, 0, 'this is not json'); fs.writeFileSync(f, lines.join('\n'));
    assert.throws(() => new MetaStatusQueue(f), /corrupt/);
  });
  await scenario('A5 queue: if the journal cannot be written, enqueue THROWS and nothing is queued in memory', async () => {
    const f = path.join(root, 'qa5.jsonl'); const q = new MetaStatusQueue(f);
    fs.mkdirSync(f);   // a directory where the file should be: append fails
    assert.throws(() => q.enqueue('k', statusPayload([st()]), ['c1']));
    assert.equal(q.stats().pending, 0);
  });

  // ================================================================= Part B
  const clients = [];
  function makeClient(id) {
    const c = { id, mode: 'ok', received: [], server: null, url: '' };
    c.server = http.createServer((req, res) => {
      let body = ''; req.on('data', (d) => { body += d; });
      req.on('end', () => {
        if (req.url === '/owner-api/meta-routes') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]'); return; }
        if (req.url === '/internal/meta/whatsapp') {
          if (c.mode === 'destroy') { req.socket.destroy(); return; }
          if (c.mode === 'fail') { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"busy"}'); return; }
          c.received.push(JSON.parse(body)); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
      });
    });
    return new Promise((resolve) => c.server.listen(0, '127.0.0.1', () => { c.url = `http://127.0.0.1:${c.server.address().port}`; clients.push(c); resolve(c); }));
  }
  const ownerRecord = (c) => ({ id: c.id, name: c.id, accessCode: c.id, ownerAccessToken: `${c.id}-owner-token`, plan: 'self_service', readonlyDashboard: false, maxCampaigns: 7, whatsappProvider: 'META_CLOUD_API', metaPhoneNumberId: 'shared-phone-id', metaDisplayPhoneNumber: '15550001111', managementUrl: c.url, provisioningStatus: 'ready', createdAt: new Date().toISOString() });
  const journalPath = path.join(root, 'meta-status-forward.jsonl');
  const c1 = await makeClient('client-one'); const c2 = await makeClient('client-two');
  fs.writeFileSync(config.OWNER_STORAGE_PATH, JSON.stringify([ownerRecord(c1), ownerRecord(c2)], null, 2));
  config.ADMIN_PORT = 0;
  const { startAdminServer } = require('../dist/adminServer');
  async function startGateway(tag) {
    const gw = startAdminServer(new Storage(path.join(root, `gateway-${tag}.json`)));
    if (!gw.listening) await new Promise((resolve) => gw.once('listening', resolve));
    return { server: gw, url: `http://127.0.0.1:${gw.address().port}` };
  }
  const post = (gw, body) => fetch(`${gw.url}/webhooks/meta/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let gw = await startGateway('a');

  await scenario('B1 gateway: status is in the journal BEFORE the 200; both clients receive it; acked entries are not redelivered', async () => {
    const res = await post(gw, statusPayload([st({ id: 'wamid.B1' })]));
    assert.equal(res.status, 200);
    const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.filter((l) => l.t === 'add').length, 2, 'one journal entry per client, written before the acknowledgement');
    await waitFor(() => c1.received.length === 1 && c2.received.length === 1, 5000, 'delivered to both');
    await sleep(1500);
    assert.equal(c1.received.length, 1); assert.equal(c2.received.length, 1, 'acknowledged entries are not sent again');
  });

  await scenario('B2 gateway: a client that is down/erroring is retried until it acknowledges; the healthy client is unaffected', async () => {
    c1.received.length = 0; c2.received.length = 0; c1.mode = 'fail';
    await post(gw, statusPayload([st({ id: 'wamid.B2', status: 'read' })]));
    await waitFor(() => c2.received.length === 1, 5000, 'healthy client got it');
    await sleep(2500); assert.equal(c1.received.length, 0, 'still failing');
    c1.mode = 'destroy'; await sleep(1500); c1.mode = 'ok';
    await waitFor(() => c1.received.length === 1, 15000, 'delivered after the client recovered');
    assert.equal(c2.received.length, 1);
  });

  await scenario('B3 gateway: Meta re-sending the same webhook (before and after delivery) is delivered ONCE per client', async () => {
    c1.received.length = 0; c2.received.length = 0;
    const p = statusPayload([st({ id: 'wamid.B3', biz_opaque_callback_data: newAttemptId() })]);
    await post(gw, p); await post(gw, p);
    await waitFor(() => c1.received.length >= 1 && c2.received.length >= 1, 5000, 'delivered');
    await post(gw, p); await sleep(1500);
    assert.equal(c1.received.length, 1); assert.equal(c2.received.length, 1);
  });

  await scenario('B4 gateway RESTART while a client is down: the queued status survives and is delivered after restart', async () => {
    c1.received.length = 0; c2.received.length = 0; c1.mode = 'fail';
    await post(gw, statusPayload([st({ id: 'wamid.B4' })]));
    await waitFor(() => c2.received.length === 1, 5000, 'c2 delivered');
    gw.server.closeAllConnections(); await new Promise((r) => gw.server.close(r));       // gateway process "dies"
    assert.ok(fs.readFileSync(journalPath, 'utf8').includes('wamid.B4'));
    c1.mode = 'ok';
    gw = await startGateway('b');                                                       // fresh process, same journal
    await waitFor(() => c1.received.length === 1, 10000, 'delivered by the restarted gateway');
    assert.equal(c2.received.length, 1, 'the client that already acknowledged it is not sent it again after the restart');
  });

  await scenario('B5 gateway: if the status cannot be persisted the webhook is answered 503 (Meta re-sends) and nothing is forwarded', async () => {
    c1.received.length = 0; c2.received.length = 0;
    fs.rmSync(journalPath); fs.mkdirSync(journalPath);   // journal not writable
    try {
      const res = await post(gw, statusPayload([st({ id: 'wamid.B5' })]));
      assert.equal(res.status, 503, 'no 200 without durability');
      await sleep(1500); assert.equal(c1.received.length + c2.received.length, 0, JSON.stringify([...c1.received, ...c2.received].map((p) => p.entry[0].changes[0].value.statuses.map((x) => x.id))));
    } finally { fs.rmSync(journalPath, { recursive: true, force: true }); }
  });

  // ================================================================= Part C
  const mk = (name) => new Storage(path.join(root, `${name}.json`));
  function sentRow(storage, to, wamid) {
    const m = storage.enqueueOutboxMessage({ kind: 'text', to, text: 'x' });
    const c = storage.claimOutboxMessage(m.id);
    if (wamid) storage.markOutboxSent(m.id, wamid); else storage.markOutboxUncertain(m.id, 'timeout');
    return { id: m.id, attemptId: c.attemptId };
  }

  await scenario('C1 tagged status matches the attempt EXACTLY, learns the provider id even though the POST response was lost, and (step 3) resolves the uncertain message', async () => {
    const s = mk('c1'); const r = sentRow(s, '972500000001', null);   // uncertain: no provider id known
    const out = s.applyMetaStatus({ wamid: 'wamid.LOST', status: 'delivered', recipientId: '972500000001', attemptId: r.attemptId, phoneNumberId: 'shared-phone-id' }, { expectedPhoneNumberId: 'shared-phone-id' });
    assert.equal(out.result, 'applied');
    const row = s.getOutboxMessage(r.id);
    assert.equal(row.attemptLog[0].providerMessageId, 'wamid.LOST'); assert.equal(row.attemptLog[0].deliveryStatus, 'delivered'); assert.equal(row.deliveryStatus, 'delivered');
    // Contract changed on purpose in step 3: delivery evidence for the attempt now resolves the uncertain message as sent.
    assert.equal(row.status, 'sent', 'step 3: exact delivery evidence resolves the uncertain message');
    assert.equal(row.providerMessageId, 'wamid.LOST');
  });
  await scenario('C2 foreign: a tagged status with an attempt id that is not ours changes NOTHING (11 clients see every status)', async () => {
    const s = mk('c2'); const r = sentRow(s, '972500000002', 'wamid.MINE');
    const out = s.applyMetaStatus({ wamid: 'wamid.OTHER', status: 'read', recipientId: '972500000002', attemptId: newAttemptId() });
    assert.equal(out.result, 'foreign');
    assert.equal(s.getOutboxMessage(r.id).deliveryStatus, undefined);
    assert.equal(s.applyMetaStatus({ wamid: 'wamid.OTHER', status: 'read', attemptId: 'not-an-attempt-id' }).result, 'buffered', 'a malformed tag is not trusted; it is treated as untagged');
  });
  await scenario('C3 mismatch: right attempt id but wrong recipient or wrong business number is REFUSED, never applied', async () => {
    const s = mk('c3'); const r = sentRow(s, '972500000003', 'wamid.M3');
    assert.equal(s.applyMetaStatus({ wamid: 'wamid.M3', status: 'delivered', recipientId: '972511111111', attemptId: r.attemptId }).result, 'mismatch');
    assert.equal(s.applyMetaStatus({ wamid: 'wamid.M3', status: 'delivered', recipientId: '972500000003', attemptId: r.attemptId, phoneNumberId: 'someone-elses-number' }, { expectedPhoneNumberId: 'shared-phone-id' }).result, 'mismatch');
    assert.equal(s.getOutboxMessage(r.id).deliveryStatus, undefined);
    assert.equal(s.applyMetaStatus({ wamid: 'wamid.M3', status: 'delivered', recipientId: '972500000003', attemptId: r.attemptId }).result, 'applied', 'the same status with the right recipient is applied');
  });
  await scenario('C4 duplicate / late / out-of-order: never regress; repeats are no-ops', async () => {
    const s = mk('c4'); const r = sentRow(s, '972500000004', 'wamid.M4');
    const apply = (status) => s.applyMetaStatus({ wamid: 'wamid.M4', status, recipientId: '972500000004', attemptId: r.attemptId }).result;
    assert.equal(apply('read'), 'applied'); assert.equal(apply('read'), 'duplicate');
    assert.equal(apply('delivered'), 'duplicate', 'a late delivered after read changes nothing');
    assert.equal(apply('sent'), 'duplicate');
    assert.equal(s.getOutboxMessage(r.id).deliveryStatus, 'read');
  });
  await scenario('C5 EARLY status (before the POST response is recorded) is kept and applied once the provider id is recorded', async () => {
    const s = mk('c5'); const m = s.enqueueOutboxMessage({ kind: 'text', to: '972500000005', text: 'x' }); s.claimOutboxMessage(m.id);
    assert.equal(s.applyMetaStatus({ wamid: 'wamid.EARLY', status: 'delivered', recipientId: '972500000005' }).result, 'buffered');
    assert.equal(s.getOutboxMessage(m.id).deliveryStatus, undefined);
    s.markOutboxSent(m.id, 'wamid.EARLY');
    assert.equal(s.getOutboxMessage(m.id).deliveryStatus, 'delivered', 'not thrown away');
  });
  await scenario('C6 status of an EARLIER attempt arrives after a retry: matched to that attempt, all ids kept, one logical message, later attempt untouched', async () => {
    const s = mk('c6'); const m = s.enqueueOutboxMessage({ kind: 'text', to: '972500000006', text: 'x' });
    const a1 = s.claimOutboxMessage(m.id).attemptId; s.markOutboxUncertain(m.id, 'timeout'); s.resolveOutboxUncertain(m.id, 'not_sent');
    const a2 = s.claimOutboxMessage(m.id).attemptId; s.markOutboxSent(m.id, 'wamid.SECOND');
    const out = s.applyMetaStatus({ wamid: 'wamid.FIRST', status: 'delivered', recipientId: '972500000006', attemptId: a1 });
    assert.equal(out.result, 'applied'); assert.equal(out.attemptId, a1);
    const row = s.getOutboxMessage(m.id);
    assert.equal(row.attemptLog.find((x) => x.attemptId === a1).providerMessageId, 'wamid.FIRST');
    assert.equal(row.attemptLog.find((x) => x.attemptId === a2).providerMessageId, 'wamid.SECOND');
    assert.equal(row.providerMessageId, 'wamid.SECOND');
    assert.equal(row.attemptLog.find((x) => x.attemptId === a2).deliveryStatus, undefined, 'the second attempt is not credited with the first one\'s delivery');
    assert.equal(s.applyMetaStatus({ wamid: 'wamid.SECOND_ALT', status: 'read', recipientId: '972500000006', attemptId: a2 }).result, 'applied');
    assert.deepEqual(s.getOutboxMessage(m.id).attemptLog.find((x) => x.attemptId === a2).providerMessageIds, ['wamid.SECOND_ALT'], 'an additional provider id for the same attempt is kept');
  });
  await scenario('C7 same phone, another campaign/client/run: a status tagged with THEIR attempt never touches ours (no phone+time guessing)', async () => {
    const s = mk('c7'); const mine = sentRow(s, '972500000007', 'wamid.MINE7');
    const theirs = mk('c7-other'); const t = sentRow(theirs, '972500000007', 'wamid.THEIRS7');
    assert.equal(s.applyMetaStatus({ wamid: 'wamid.THEIRS7', status: 'read', recipientId: '972500000007', attemptId: t.attemptId }).result, 'foreign');
    assert.equal(s.getOutboxMessage(mine.id).deliveryStatus, undefined);
    assert.equal(s.applyMetaStatus({ wamid: 'wamid.THEIRS7', status: 'read', recipientId: '972500000007' }).result, 'buffered', 'untagged + unknown id: kept aside, never applied to the same-phone message');
    assert.equal(s.getOutboxMessage(mine.id).deliveryStatus, undefined);
  });
  await scenario('C8 applied status survives a restart (JSON)', async () => {
    const file = path.join(root, 'c8.json'); const s = new Storage(file); const r = sentRow(s, '972500000008', 'wamid.M8');
    s.applyMetaStatus({ wamid: 'wamid.M8', status: 'delivered', recipientId: '972500000008', attemptId: r.attemptId }); await s.flush();
    const again = new Storage(file).getOutboxMessage(r.id);
    assert.equal(again.deliveryStatus, 'delivered'); assert.equal(again.attemptLog[0].deliveryStatus, 'delivered');
  });
  await scenario('C9 the unmatched buffer is bounded (cap) and per-message ids stay separate', async () => {
    const s = mk('c9');
    for (let i = 0; i < 2500; i++) s.applyMetaStatus({ wamid: `wamid.U${i}`, status: 'sent' });
    const m = s.enqueueOutboxMessage({ kind: 'text', to: '972500000009', text: 'x' }); s.claimOutboxMessage(m.id); s.markOutboxSent(m.id, 'wamid.U2499');
    assert.equal(s.getOutboxMessage(m.id).deliveryStatus, 'sent', 'a recent early status is still there');
    const old = s.enqueueOutboxMessage({ kind: 'text', to: '972500000010', text: 'x' }); s.claimOutboxMessage(old.id); s.markOutboxSent(old.id, 'wamid.U0');
    assert.equal(s.getOutboxMessage(old.id).deliveryStatus, undefined, 'evicted by the cap: bounded memory');
  });

  // ================================================================= Part D
  await scenario('D1 client endpoint: a status that changed an outbox row is acknowledged only AFTER it is durable (503 on a failed flush, 200 once it succeeds)', async () => {
    const port = await new Promise((resolve) => { const probe = http.createServer(); probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); }); });
    const clientStorage = new Storage(path.join(root, 'client-d1.json'));
    const r = sentRow(clientStorage, '972500000011', 'wamid.D1');
    config.ADMIN_PORT = port;
    const srv = startAdminServer(clientStorage);
    if (!srv.listening) await new Promise((resolve) => srv.once('listening', resolve));
    const realFlush = clientStorage.flush.bind(clientStorage); let failNext = true;
    clientStorage.flush = async () => { if (failNext) { failNext = false; throw new Error('disk full'); } return realFlush(); };
    const body = JSON.stringify(statusPayload([st({ id: 'wamid.D1', recipient_id: '972500000011', biz_opaque_callback_data: r.attemptId })]));
    const send = () => fetch(`http://127.0.0.1:${port}/internal/meta/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-owner-token': 'status-owner-token' }, body });
    const first = await send();
    assert.equal(first.status, 503, 'the flush failed: the gateway must be told to retry');
    const second = await send();                       // the gateway's retry
    assert.equal(second.status, 200);
    assert.equal(clientStorage.getOutboxMessage(r.id).deliveryStatus, 'delivered');
    const third = await send(); assert.equal(third.status, 200, 'a repeat is harmless');
    srv.closeAllConnections(); await new Promise((r2) => srv.close(r2));
  });

  let failed = 0;
  for (const [name, status, err] of results) { if (status === 'FAIL') failed++; console.log(`${status}  ${name}${err ? '\n      ' + err : ''}`); }
  console.log(`\nstatus-forwarding: ${results.length - failed} passed, ${failed} failed`);
  for (const c of clients) c.server.close();
  setTimeout(() => { fs.rmSync(root, { recursive: true, force: true }); process.exit(failed ? 1 : 0); }, 200);
})();
