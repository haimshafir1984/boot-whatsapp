'use strict';
/**
 * Client side of the resumable handover (real admin server, owner API): meta-pending-route reports `resumable` and `capabilities`;
 * meta-clear-pending marks the sender's runs as replaced (durably, before answering `cancelled`) and records who took over.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-resumable-client-'));
Object.assign(process.env, { NODE_ENV: 'test', WHATSAPP_PROVIDER: 'META_CLOUD_API',
  STORAGE_PATH: path.join(root, 'storage.json'), OWNER_STORAGE_PATH: path.join(root, 'owner.json'),
  CONVERSATION_STATE_PATH: path.join(root, 'state.json'), OWNER_ACCESS_TOKEN: 'synthetic-owner', CLIENT_ACCESS_TOKEN: 'synthetic-client',
  META_ACCESS_TOKEN: '', DOKPLOY_META_ACCESS_TOKEN: '', META_PHONE_NUMBER_ID: '', BOT_REPLY_DELAY_MS: '0', SESSION_PATH: path.join(root, 'session') });
const { Storage } = require('../dist/storage');
const { conversationState } = require('../dist/conversationState');
const { config } = require('../dist/config');
const storage = new Storage(process.env.STORAGE_PATH);

const campaignInput = (name, phrase) => ({ name, triggerType: 1, triggerPhrase: phrase, suffix: '', active: true,
  conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], decisionFlow: [{ id: 'm1', kind: 'message', text: 'M' }] } });
const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push([name, 'PASS']); }
  catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 5).join(' | ')]); }
}
let server;
(async () => {
  config.ADMIN_PORT = 0;
  server = require('../dist/adminServer').startAdminServer(storage);
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-owner-token': 'synthetic-owner' }, body: JSON.stringify(body) });
  const pendingRoute = async (phone) => (await post('/owner-api/meta-pending-route', { phone })).json();
  const A = storage.addCampaign(campaignInput('A', 'a-trigger'));
  const B = storage.addCampaign(campaignInput('B', 'b-trigger'));
  const row = (id) => storage.data.campaignResults.find((r) => r.id === id);

  await scenario('meta-pending-route reports capabilities always, and resumable only for a current, recent run in an active campaign', async () => {
    const unknown = await pendingRoute('972508880001');
    assert.deepEqual(unknown.capabilities, ['resumable-v1', 'durable-supersede-v1']);
    assert.equal(unknown.resumable, false, 'a sender this client has never seen');
    assert.equal(unknown.pending, false); assert.equal(unknown.activeWork, false);
    const r = storage.recordCampaignTrigger(A.id, '972508880002', 'x');
    const known = await pendingRoute('972508880002');
    assert.equal(known.resumable, true);
    assert.equal(known.pending, false, 'resumable is NOT a pending conversation: the existing fields keep their meaning');
    assert.ok('repeatWindowCampaignId' in known || known.repeatWindowCampaignId === undefined);
    row(r.id).lastEventAt = new Date(Date.now() - 25 * 3600_000).toISOString(); row(r.id).updatedAt = row(r.id).lastEventAt;
    assert.equal((await pendingRoute('972508880002')).resumable, false, 'older than the 24 hour window');
    row(r.id).lastEventAt = new Date(Date.now() - 23 * 3600_000).toISOString();
    assert.equal((await pendingRoute('972508880002')).resumable, true, 'inside the window');
    storage.updateCampaign(A.id, { active: false });
    assert.equal((await pendingRoute('972508880002')).resumable, false, 'the campaign is no longer active');
    storage.updateCampaign(A.id, { active: true });
  });

  await scenario('a replaced run is not resumable: newer run of hers replaces the older one, only the latest is reported', async () => {
    storage.recordCampaignTrigger(A.id, '972508880010', 'one');
    storage.recordCampaignTrigger(B.id, '972508880010', 'two');
    assert.equal((await pendingRoute('972508880010')).resumable, true, 'her current run (B)');
    await storage.supersedeRunsFromOutside('972508880010', 'test');
    assert.equal((await pendingRoute('972508880010')).resumable, false, 'taken over: nothing left to resume');
  });

  await scenario('meta-clear-pending replaces her runs, records who took over, saves it before answering, and a held sender is refused untouched', async () => {
    const r = storage.recordCampaignTrigger(A.id, '972508880020', 'x');
    assert.equal((await pendingRoute('972508880020')).resumable, true);
    const res = await post('/owner-api/meta-clear-pending', { phone: '972508880020', toClientId: 'client-b-9' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).cancelled, true);
    assert.equal(row(r.id).supersededBy, 'handover:to-client-b-9');
    assert.equal((await pendingRoute('972508880020')).resumable, false, 'no longer resumable here');
    const reopened = new Storage(process.env.STORAGE_PATH);                                     // read back from disk: it was saved before the answer
    assert.equal(reopened.data.campaignResults.find((x) => x.id === r.id).supersededBy, 'handover:to-client-b-9');
    // an older gateway sends no toClientId; a hostile value cannot inject characters
    const r2 = storage.recordCampaignTrigger(A.id, '972508880021', 'y');
    await post('/owner-api/meta-clear-pending', { phone: '972508880021' });
    assert.equal(row(r2.id).supersededBy, 'handover:to-other');
    const r3 = storage.recordCampaignTrigger(A.id, '972508880022', 'z');
    await post('/owner-api/meta-clear-pending', { phone: '972508880022', toClientId: '../../x y;<z>' });
    assert.match(row(r3.id).supersededBy, /^handover:to-[A-Za-z0-9_-]+$/);
    // held for review: the existing refusal wins and nothing is marked
    const r4 = storage.recordCampaignTrigger(A.id, '972508880023', 'held');
    conversationState.set('whatsapp:972508880023', { kind: 'needs_review', senderPhone: '972508880023', senderJid: 'whatsapp:972508880023', timestamp: Date.now(), reason: 'test' });
    assert.equal((await post('/owner-api/meta-clear-pending', { phone: '972508880023', toClientId: 'b' })).status, 409);
    assert.equal(row(r4.id).supersededAt, undefined, 'a refused handover marks nothing');
  });

  await scenario('a phone the client has never seen is cancelled as before (nothing to mark, still answers cancelled)', async () => {
    const res = await post('/owner-api/meta-clear-pending', { phone: '972508889999', toClientId: 'b' });
    assert.equal(res.status, 200); assert.equal((await res.json()).cancelled, true);
  });

  await scenario('a save that fails is never answered as cancelled (500, cancelled:false); once saving works again the same call succeeds', async () => {
    const r = storage.recordCampaignTrigger(A.id, '972508880030', 'x');
    const realFlush = storage.flush.bind(storage);
    storage.flush = async () => { throw new Error('disk full'); };
    try {
      const res = await post('/owner-api/meta-clear-pending', { phone: '972508880030', toClientId: 'b' });
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.notEqual(body.cancelled, true, 'the gateway must keep the trigger back');
    } finally { storage.flush = realFlush; }
    const again = await post('/owner-api/meta-clear-pending', { phone: '972508880030', toClientId: 'b' });
    assert.equal(again.status, 200); assert.equal((await again.json()).cancelled, true);
    assert.ok(row(r.id).supersededAt);
    const reopened = new Storage(process.env.STORAGE_PATH);
    assert.ok(reopened.data.campaignResults.find((x) => x.id === r.id).supersededAt, 'saved once flush worked again');
  });

  await scenario('the WRITE itself failing (not just flush): 500, the marks are taken back, the retry really writes, a fresh Storage sees it (Codex 33ce19b finding 4)', async () => {
    const r = storage.recordCampaignTrigger(A.id, '972508880035', 'x');
    const realWrite = fs.writeFileSync;
    fs.writeFileSync = function patched(file, ...rest) {
      if (String(file).endsWith('storage.json.tmp')) throw new Error('EIO: simulated write failure');
      return realWrite.call(this, file, ...rest);
    };
    try {
      const res = await post('/owner-api/meta-clear-pending', { phone: '972508880035', toClientId: 'b' });
      assert.equal(res.status, 500); assert.notEqual((await res.json()).cancelled, true);
      assert.equal(row(r.id).supersededAt, undefined, 'memory does not claim a replacement the disk does not have');
      const second = await post('/owner-api/meta-clear-pending', { phone: '972508880035', toClientId: 'b' });
      assert.equal(second.status, 500, 'still failing: still not cancelled (not a silent success on the second try)');
    } finally { fs.writeFileSync = realWrite; }
    const again = await post('/owner-api/meta-clear-pending', { phone: '972508880035', toClientId: 'b' });
    assert.equal(again.status, 200); assert.equal((await again.json()).cancelled, true);
    assert.ok(row(r.id).supersededAt);
    const reopened = new Storage(process.env.STORAGE_PATH);
    assert.ok(reopened.data.campaignResults.find((x) => x.id === r.id).supersededAt, 'on disk after the retry');
  });

  await scenario('the same handover twice in a row and twice in parallel: both answer cancelled, the run is marked once and the mark never moves', async () => {
    const r = storage.recordCampaignTrigger(A.id, '972508880040', 'x');
    const first = await post('/owner-api/meta-clear-pending', { phone: '972508880040', toClientId: 'one' });
    assert.equal((await first.json()).cancelled, true);
    const stamp = row(r.id).supersededAt; const by = row(r.id).supersededBy;
    const second = await post('/owner-api/meta-clear-pending', { phone: '972508880040', toClientId: 'two' });
    assert.equal(second.status, 200); assert.equal((await second.json()).cancelled, true);
    assert.equal(row(r.id).supersededAt, stamp); assert.equal(row(r.id).supersededBy, by, 'the first mark stays');
    const q = storage.recordCampaignTrigger(A.id, '972508880041', 'y');
    const both = await Promise.all([post('/owner-api/meta-clear-pending', { phone: '972508880041', toClientId: 'p1' }), post('/owner-api/meta-clear-pending', { phone: '972508880041', toClientId: 'p2' })]);
    for (const res of both) { assert.equal(res.status, 200); assert.equal((await res.json()).cancelled, true); }
    assert.match(row(q.id).supersededBy, /^handover:to-p[12]$/);
    assert.equal(storage.data.campaignResults.filter((x) => x.phone === '972508880041' && x.supersededAt).length, 1);
  });

  await scenario('a new trigger racing a handover of the same sender: whichever order, at most one run is left unreplaced and it is the newest', async () => {
    for (let round = 0; round < 25; round += 1) {
      const phone = `97250888${String(5000 + round)}`;
      const old = storage.recordCampaignTrigger(A.id, phone, 'old');
      const [, fresh] = await Promise.all([post('/owner-api/meta-clear-pending', { phone, toClientId: 'racer' }), Promise.resolve().then(() => storage.recordCampaignTrigger(B.id, phone, 'new'))]);
      const mine = storage.data.campaignResults.filter((x) => x.phone === phone);
      const live = mine.filter((x) => !x.supersededAt);
      assert.ok(live.length <= 1, `round ${round}: ${live.length} runs left unreplaced`);
      if (live.length === 1) assert.equal(live[0].id, fresh.id, `round ${round}: the one left is the newest`);
      assert.ok(row(old.id).supersededAt, `round ${round}: the older run is replaced`);
    }
  });

  await scenario('restart after a run was marked replaced and before any new message: still replaced, not resumable', async () => {
    const { hasResumableRun } = require('../dist/messageFlow');
    const r = storage.recordCampaignTrigger(A.id, '972508880060', 'x');
    assert.equal(hasResumableRun(storage, '972508880060'), true);
    await post('/owner-api/meta-clear-pending', { phone: '972508880060', toClientId: 'b' });
    const restarted = new Storage(process.env.STORAGE_PATH);                     // a fresh process: nothing in memory but what was saved
    assert.equal(restarted.getCurrentRun('972508880060'), undefined);
    assert.equal(hasResumableRun(restarted, '972508880060'), false);
    assert.equal(restarted.getLatestRun('972508880060').id, r.id);
  });

  await scenario('the 24 hour limit of "resumable" is exact: a few seconds inside is resumable, a few seconds outside is not', async () => {
    const { hasResumableRun } = require('../dist/messageFlow');
    const r = storage.recordCampaignTrigger(A.id, '972508880070', 'x');
    const setAge = (ms) => { const iso = new Date(Date.now() - ms).toISOString(); row(r.id).lastEventAt = iso; row(r.id).updatedAt = iso; };
    setAge(24 * 3600_000 - 5_000); assert.equal(hasResumableRun(storage, '972508880070'), true);
    setAge(24 * 3600_000 + 5_000); assert.equal(hasResumableRun(storage, '972508880070'), false);
    setAge(0); assert.equal(hasResumableRun(storage, '972508880070'), true);
  });

  server.closeAllConnections(); server.close();
  fs.rmSync(root, { recursive: true, force: true });
  let failed = 0;
  for (const [name, status, detail] of results) { console.log(`${status}  ${name}${detail ? '\n      ' + detail : ''}`); if (status !== 'PASS') failed += 1; }
  console.log(failed ? `\n${failed} scenario(s) FAILED` : `\nResumable client tests passed (${results.length} scenarios).`);
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
})().catch((e) => { console.error(e); if (server) { server.closeAllConnections(); server.close(); } process.exit(1); });
