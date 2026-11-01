'use strict';
/**
 * Client side of signed v1 buttons (P1): every check of verifyClientButton (signatures, expiry, client, sender, run, step, option, rev),
 * and the real admin server: a bad v1 tap is dropped before the flow sees it, a valid one is only reported (no action yet), a legacy
 * id still reaches the flow. Nothing issues v1 ids in production yet.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-button-client-'));
const { issueButtonId, deriveRouteKey } = require('../dist/buttonToken');
const MASTER = Buffer.alloc(32, 7); const FULL = Buffer.alloc(32, 3); const ME = 'client-me';
const routeKey = deriveRouteKey(MASTER, ME);
Object.assign(process.env, { NODE_ENV: 'test', WHATSAPP_PROVIDER: 'META_CLOUD_API',
  STORAGE_PATH: path.join(root, 'storage.json'), OWNER_STORAGE_PATH: path.join(root, 'owner.json'),
  CONVERSATION_STATE_PATH: path.join(root, 'state.json'), OWNER_ACCESS_TOKEN: 'synthetic-owner', CLIENT_ACCESS_TOKEN: 'synthetic-client',
  META_ACCESS_TOKEN: '', DOKPLOY_META_ACCESS_TOKEN: '', META_PHONE_NUMBER_ID: '', BOT_REPLY_DELAY_MS: '0', SESSION_PATH: path.join(root, 'session'),
  META_BUTTON_CLIENT_ID: ME, META_BUTTON_ROUTE_KEYS: `k1:${routeKey.toString('base64url')}`, META_BUTTON_FULL_KEYS: `k1:${FULL.toString('base64url')}` });
const { Storage } = require('../dist/storage');
const { config } = require('../dist/config');
const { computeFlowRev } = require('../dist/flowRev');
const { verifyClientButton, loadClientButtonKeys, parseKeyList } = require('../dist/buttonVerify');
const storage = new Storage(process.env.STORAGE_PATH);

const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 5).join(' | ')]); }
}
const input = (name, phrase) => ({ name, triggerType: 1, triggerPhrase: phrase, suffix: '', active: true,
  conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], decisionFlow: [
    { id: 'q1', kind: 'question', presentation: 'buttons', text: 'Pick', options: [{ id: 'o1', text: 'Yes', nextStepId: 'm2' }, { id: 'o2', text: 'No', nextStepId: 'm2' }] },
    { id: 'm2', kind: 'message', text: 'Done' }] } });
const A = storage.addCampaign(input('A', 'a-trigger'));
const B = storage.addCampaign(input('B', 'b-trigger'));
const campaignOf = (id) => storage.getCampaigns().find((c) => c.id === id);
const revOf = (id) => computeFlowRev(campaignOf(id).conversation);
const lookups = {
  findResult: (id, phone) => storage.getResultsForPhoneKey(phone).find((r) => r.id === id),
  getCampaign: (id) => campaignOf(id),
  getCurrentRun: (phone) => storage.getCurrentRun(phone),
};
const keys = loadClientButtonKeys(process.env);
const nowSec = () => Math.floor(Date.now() / 1000);
function token(result, over = {}) {
  const claims = { kid: 'k1', clientId: ME, resultId: result.id, stepId: 'q1', optionId: 'o1', rev: revOf(result.campaignId), exp: nowSec() + 3600, ...over };
  return issueButtonId(claims, { routeKey: deriveRouteKey(MASTER, claims.clientId), fullKey: FULL });
}
const verdict = (id, phone, k = keys) => verifyClientButton(id, phone, k, lookups);
let seq = 0; const phoneFor = () => `97250777${String(1000 + (seq += 1))}`;

(async () => {
  await scenario('key lists: bad entries and short keys are skipped; nothing configured means nothing verifies', async () => {
    assert.equal(parseKeyList('k1:' + Buffer.alloc(32, 1).toString('base64url') + ',bad,:x,k2:AAAA,toolongkidxx:' + Buffer.alloc(32, 1).toString('base64url')).size, 1);
    const none = loadClientButtonKeys({});
    const phone = phoneFor(); const r = storage.recordCampaignTrigger(A.id, phone, 'x');
    assert.equal(verdict(token(r), phone, none).reason, 'unknown_kid');
    assert.equal(verdict(token(r), phone, { ...keys, clientId: '' }).reason, 'no_client_id');
  });

  await scenario('a valid tap of her own current run passes every check', async () => {
    const phone = phoneFor(); const r = storage.recordCampaignTrigger(A.id, phone, 'x');
    const v = verdict(token(r), phone);
    assert.equal(v.kind, 'verified'); assert.equal(v.result.id, r.id); assert.equal(v.claims.optionId, 'o1');
    assert.equal(verdict(token(r, { optionId: 'o2' }), phone).kind, 'verified', 'any option of that step');
  });

  await scenario('everything that is not exactly right is rejected with its own reason', async () => {
    const phone = phoneFor(); const r = storage.recordCampaignTrigger(A.id, phone, 'x');
    const other = phoneFor(); storage.recordCampaignTrigger(A.id, other, 'x');
    const reasons = (id, p = phone) => { const v = verdict(id, p); return v.kind === 'reject' ? v.reason : v.kind; };
    assert.equal(reasons(token(r, { exp: nowSec() - 3600 })), 'expired');
    assert.equal(reasons(token(r, { kid: 'k1', clientId: 'someone-else' })), 'bad_sig', 'signed with her key but for another client: the client key does not match');
    assert.equal(reasons(token(r, { resultId: 'nope' })), 'no_result');
    assert.equal(reasons(token(r), other), 'no_result', 'someone else taps a button that was sent to her');
    assert.equal(reasons(token(r, { stepId: 'zzz' })), 'no_step');
    assert.equal(reasons(token(r, { optionId: 'zzz' })), 'no_option');
    assert.equal(reasons(token(r, { rev: 'otherrev' })), 'rev_mismatch');
    assert.equal(reasons(token(r) + 'x'), 'malformed');
    assert.equal(reasons('v1.junk'), 'malformed');
    const parts = token(r).split('.'); parts[9] = (parts[9][0] === 'A' ? 'B' : 'A') + parts[9].slice(1);   // first char: all 6 bits count (the last one only has 4)
    assert.equal(reasons(parts.join('.')), 'bad_sig', 'tampered full signature');
    storage.updateCampaign(A.id, { active: false });
    assert.equal(reasons(token(r)), 'campaign_inactive');
    storage.updateCampaign(A.id, { active: true });
    assert.equal(verifyClientButton(token(r), phone, { ...keys, revoked: new Set(['k1']) }, lookups).reason, 'revoked_kid');
    assert.equal(verifyClientButton(token(r), phone, { ...keys, clientId: 'client-other' }, lookups).reason, 'wrong_client');
  });

  await scenario('a run that was replaced is not honoured (newer run of hers, or a handover)', async () => {
    const phone = phoneFor(); const old = storage.recordCampaignTrigger(A.id, phone, 'x');
    const oldToken = token(old);
    assert.equal(verdict(oldToken, phone).kind, 'verified');
    const fresh = storage.recordCampaignTrigger(B.id, phone, 'y');
    assert.equal(verdict(oldToken, phone).reason, 'not_current_run');
    assert.equal(verdict(token(fresh), phone).kind, 'verified');
    await storage.supersedeRunsFromOutside(phone, 'test');
    assert.equal(verdict(token(fresh), phone).reason, 'not_current_run', 'handed over to another client');
  });

  await scenario('a structural edit of the campaign cancels its buttons; a display-only edit does not', async () => {
    const phone = phoneFor(); const r = storage.recordCampaignTrigger(B.id, phone, 'x');
    const t = token(r);
    const flow = JSON.parse(JSON.stringify(campaignOf(B.id).conversation));
    flow.decisionFlow[0].text = 'Pick one of these, please';                 // display text only
    storage.updateCampaign(B.id, { conversation: flow });
    assert.equal(verdict(t, phone).kind, 'verified', 'wording change keeps buttons alive');
    flow.decisionFlow[0].options[0].nextStepId = 'q1';                       // changes the route
    storage.updateCampaign(B.id, { conversation: flow });
    assert.equal(verdict(t, phone).reason, 'rev_mismatch');
  });

  // The real admin server: what the webhook path does with each kind of tap.
  const lines = [];
  for (const level of ['log', 'warn']) { const original = console[level].bind(console); console[level] = (...args) => { lines.push(args.map(String).join(' ')); original(...args); }; }
  config.ADMIN_PORT = 0;
  const server = require('../dist/adminServer').startAdminServer(storage);
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let wam = 0;
  const tap = async (phone, buttonId, shape = 'interactive') => {
    wam += 1; const id = `wamid.v1client${wam}`;
    const payload = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'x', display_phone_number: '15550001111' }, contacts: [{ wa_id: phone, profile: { name: 'T' } }],
      messages: [{ id, from: phone, timestamp: String(nowSec()), context: { id: 'wamid.Q' },
        ...(shape === 'interactive' ? { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: buttonId, title: 'Yes' } } }
          : shape === 'button_payload' ? { type: 'button', button: { payload: buttonId, text: 'Yes' } }
          : shape === 'list_reply' ? { type: 'interactive', list_reply: { id: buttonId, title: 'Yes' } }
          : { type: 'interactive', reply: { id: buttonId, title: 'Yes' } }) }] } }] }] };
    const res = await fetch(base + '/internal/meta/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-owner-token': 'synthetic-owner' }, body: JSON.stringify(payload) });
    assert.ok(res.status === 200 || res.status === 202, `status ${res.status}`);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !lines.some((l) => l.includes(id))) await new Promise((resolve) => setTimeout(resolve, 25));
    await new Promise((resolve) => setTimeout(resolve, 150));
    return lines.filter((l) => l.includes(id));
  };

  await scenario('webhook: a bad v1 tap is dropped before the flow sees it; a valid one is only reported; a legacy id still reaches the flow', async () => {
    const phone = phoneFor(); const r = storage.recordCampaignTrigger(A.id, phone, 'x');
    const bad = await tap(phone, token(r, { exp: nowSec() - 3600 }));
    assert.ok(bad.some((l) => l.includes('[META_V1_BUTTON_REJECTED]') && l.includes('reason=expired')), bad.join(' | '));
    assert.ok(!bad.some((l) => l.includes('[META_INBOUND]')), 'the flow never saw it');
    const forged = await tap(phone, 'v1.forged.stuff');
    assert.ok(forged.some((l) => l.includes('[META_V1_BUTTON_REJECTED]')) && !forged.some((l) => l.includes('[META_INBOUND]')));
    const good = await tap(phone, token(r));
    assert.ok(good.some((l) => l.includes('[META_V1_BUTTON_VERIFIED]') && l.includes('no_action_yet')), good.join(' | '));
    assert.ok(!good.some((l) => l.includes('[META_INBOUND]')), 'a verified tap is not acted on yet');
    const legacy = await tap(phone, 'option-share');
    assert.ok(legacy.some((l) => l.includes('[META_INBOUND]')), 'a legacy id still reaches the flow: ' + legacy.join(' | '));
  });

  await scenario('webhook: a bad v1 id is dropped in every reply shape, never handed to the flow as a legacy answer', async () => {
    const phone = phoneFor(); const r = storage.recordCampaignTrigger(A.id, phone, 'x');
    for (const shape of ['button_payload', 'list_reply', 'reply']) {
      const out = await tap(phone, token(r, { exp: nowSec() - 3600 }), shape);
      assert.ok(out.some((l) => l.includes('[META_V1_BUTTON_REJECTED]') && l.includes('reason=expired')), `${shape}: ${out.join(' | ')}`);
      assert.ok(!out.some((l) => l.includes('[META_INBOUND]')), `${shape}: the flow never saw it`);
    }
  });

  server.closeAllConnections(); server.close();
  fs.rmSync(root, { recursive: true, force: true });
  let failed = 0;
  for (const [name, status, detail] of results) { console.info(`${status}  ${name}${detail ? '\n      ' + detail : ''}`); if (status !== 'PASS') failed += 1; }
  console.info(failed ? `\n${failed} scenario(s) FAILED` : `\nV1 button client tests passed (${results.length} scenarios).`);
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
})().catch((e) => { console.error(e); process.exit(1); });
