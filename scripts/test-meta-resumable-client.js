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

  server.closeAllConnections(); server.close();
  fs.rmSync(root, { recursive: true, force: true });
  let failed = 0;
  for (const [name, status, detail] of results) { console.log(`${status}  ${name}${detail ? '\n      ' + detail : ''}`); if (status !== 'PASS') failed += 1; }
  console.log(failed ? `\n${failed} scenario(s) FAILED` : `\nResumable client tests passed (${results.length} scenarios).`);
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
})().catch((e) => { console.error(e); if (server) { server.closeAllConnections(); server.close(); } process.exit(1); });
