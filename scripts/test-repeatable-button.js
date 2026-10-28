'use strict';
/**
 * option.repeatable: a button the campaign keeps live for the rest of the flow. Tapping it again later (once per participant)
 * takes her back to that option's branch and the flow continues from there in its normal order. Counted once for the raffle.
 * Without the flag an old button is an invalid answer exactly as before.
 */
process.env.NODE_ENV = 'test';
process.env.BOT_REPLY_DELAY_MS = '0';
process.env.PORT = String(35000 + Math.floor(Math.random() * 3000));
process.env.CLIENT_ACCESS_TOKEN = 'repeatable-test-token';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../dist/storage');
const { conversationState } = require('../dist/conversationState');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
const { startAdminServer } = require('../dist/adminServer');
const { startDeliveryRecovery } = require('../dist/deliveryRecovery');
const { repeatableWindowCampaignId } = require('../dist/messageFlow');

let wamidSeq = 0;
class FakeTransport {
  constructor() { this.sent = []; this.failText = null; }
  async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); }
  record(entry) {
    if (this.failText && entry.text === this.failText) { const err = new Error('socket reset'); err.code = 'ECONNRESET'; throw err; }
    entry.wamid = `wamid.T${++wamidSeq}`; this.sent.push(entry); return { messageId: entry.wamid };
  }
  async sendMessage(to, text) { return this.record({ type: 'text', to, text }); }
  async sendInteractiveButtons(to, text, buttons) { return this.record({ type: 'buttons', to, text, buttons }); }
  async sendInteractiveList(to, text, buttonText, items) { return this.record({ type: 'list', to, text, buttonText, items }); }
}

// the 15s "same button just tapped" guard reads Date.now(); tests move the clock instead of waiting
const realNow = Date.now.bind(Date);
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
const later = (seconds) => { clockOffset += seconds * 1000; };

const flow = (repeatable) => [
  { id: 'step-share', kind: 'question', presentation: 'buttons', text: 'Want 2 extra tickets? Share the video', timeoutMinutes: 30, options: [
    { id: 'opt-share', text: 'Yes I want to share', raffleEntry: true, ...(repeatable ? { repeatable: true } : {}), nextStepId: 'step-link' },
    { id: 'opt-later', text: 'Not now maybe later', nextStepId: 'step-go' },
  ] },
  { id: 'step-link', kind: 'message', text: 'LINK AND VIDEO', nextStepId: 'step-shared' },
  { id: 'step-shared', kind: 'question', presentation: 'buttons', text: 'Did you share?', timeoutMinutes: 30, options: [{ id: 'opt-done', text: 'I shared', nextStepId: 'step-tickets' }] },
  { id: 'step-go', kind: 'message', text: 'ON TO THE GAME', nextStepId: 'step-quiz1' },
  { id: 'step-tickets', kind: 'message', text: 'TWO MORE TICKETS', nextStepId: 'step-quiz1' },
  { id: 'step-quiz1', kind: 'question', presentation: 'buttons', text: 'Quiz one', timeoutMinutes: 30, options: [{ id: 'q1a', text: 'one a', nextStepId: 'step-quiz2' }, { id: 'q1b', text: 'one b', nextStepId: 'step-quiz2' }] },
  { id: 'step-quiz2', kind: 'question', presentation: 'buttons', text: 'Quiz two', timeoutMinutes: 30, options: [{ id: 'q2a', text: 'two a', nextStepId: 'step-end' }] },
  { id: 'step-end', kind: 'message', text: 'THE END' },
];

const conversation = (repeatable) => ({
  askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], decisionFlow: flow(repeatable),
  decisionTimeoutMinutes: 30, decisionTimeoutText: '', decisionTimeoutMode: 'message', decisionTimeoutNextStepId: '',
  invalidReplyText: '', flowRecoveryText: '', humanHandoffEnabled: false, humanHandoffText: '', humanHandoffPhone: '',
});

let seq = 0;
// A real button tap is a reply to the buttons message that carried it (Meta context.id). `replyTo` overrides that:
// a wamid string, or null for "no context at all".
const inbound = (storage, transport, phone, body, isButtonReply = false, replyTo) => handleIncomingWhatsAppMessage({
  id: `rep-${++seq}`, from: `whatsapp:${phone}`, body, hasUserSignal: true, isButtonReply,
  replyToMessageId: replyTo === null ? undefined : (replyTo ?? (isButtonReply ? [...transport.sent].reverse().find((m) => m.buttons?.some((b) => b.id === body))?.wamid : undefined)),
  timestamp: Math.floor(Date.now() / 1000),   // the shifted clock, so a message is never 'stale' just because the test moved time
  async getDisplayName() { return 'Tester'; },
}, storage, transport, 'webhook');

const texts = (transport) => transport.sent.map((m) => m.text);
const count = (transport, text) => transport.sent.filter((m) => m.text === text).length;
const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push([name, 'PASS']); }
  catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 5).join(' | ')]); }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repeatable-'));
  process.env.STORAGE_PATH = path.join(dir, 'storage.json');
  const storage = new Storage(process.env.STORAGE_PATH);
  const mk = (name, phrase, repeatable) => storage.addCampaign({ name, triggerType: 1, triggerPhrase: phrase, suffix: ' - (Bot)', active: true, conversation: conversation(repeatable) });
  const live = mk('Live button', 'join-live', true);
  const plain = mk('Plain button', 'join-plain', false);
  const events = (campaign, type) => storage.getCampaignEvents(campaign.id).filter((e) => e.type === type);
  const last = (transport) => transport.sent[transport.sent.length - 1];

  await scenario('regression: the normal path is unchanged (share -> link -> "did you share" -> tickets -> quiz)', async () => {
    const t = new FakeTransport(); const phone = '972500700001';
    await inbound(storage, t, phone, 'join-live');
    assert.equal(last(t).text, 'Want 2 extra tickets? Share the video');
    await inbound(storage, t, phone, 'opt-share', true);
    assert.deepEqual(texts(t).slice(-2), ['LINK AND VIDEO', 'Did you share?']);
    later(20);
    await inbound(storage, t, phone, 'opt-done', true);
    assert.deepEqual(texts(t).slice(-2), ['TWO MORE TICKETS', 'Quiz one']);
    assert.equal(events(live, 'share_repeated').length, 0, 'the first tap is not a repeat');
    conversationState.remove(`whatsapp:${phone}`);
  });

  await scenario('declined, then taps the old button later: back to the branch 4->5->7, then the flow continues in order (quiz one again); raffle counted once', async () => {
    const t = new FakeTransport(); const phone = '972500700002';
    await inbound(storage, t, phone, 'join-live');
    await inbound(storage, t, phone, 'opt-later', true);
    assert.deepEqual(texts(t).slice(-2), ['ON TO THE GAME', 'Quiz one']);
    later(20);
    await inbound(storage, t, phone, 'q1a', true);
    assert.equal(last(t).text, 'Quiz two');
    later(20);
    const before = t.sent.length;
    await inbound(storage, t, phone, 'opt-share', true);              // she scrolls up and taps the share button again
    assert.deepEqual(texts(t).slice(before), ['LINK AND VIDEO', 'Did you share?'], 'link + video, then the confirmation question');
    assert.equal(events(live, 'share_repeated').filter((e) => e.phone === phone).length, 1);
    later(20);
    await inbound(storage, t, phone, 'opt-done', true);
    assert.deepEqual(texts(t).slice(-2), ['TWO MORE TICKETS', 'Quiz one'], 'the flow continues in its normal order (it goes back to quiz one)');
    later(20);
    await inbound(storage, t, phone, 'q1b', true);
    assert.equal(last(t).text, 'Quiz two', 'and carries on normally from there');
    const raffle = events(live, 'raffle_entry').filter((e) => e.phone === phone);
    assert.equal(raffle.length, 1, 'one raffle entry, not two');
    conversationState.remove(`whatsapp:${phone}`);
  });

  await scenario('only once: the second tap sends no link/video again (the old-button answer is the usual "not understood" + the current question)', async () => {
    const t = new FakeTransport(); const phone = '972500700003';
    await inbound(storage, t, phone, 'join-live');
    await inbound(storage, t, phone, 'opt-later', true);
    later(20); await inbound(storage, t, phone, 'opt-share', true);        // the one allowed repeat
    assert.equal(count(t, 'LINK AND VIDEO'), 1);
    later(20); await inbound(storage, t, phone, 'opt-done', true);
    assert.equal(last(t).text, 'Quiz one');
    later(20);
    const before = t.sent.length;
    await inbound(storage, t, phone, 'opt-share', true);                 // second repeat
    assert.equal(count(t, 'LINK AND VIDEO'), 1, 'no second delivery of the link and video');
    assert.ok(!texts(t).slice(before).includes('Did you share?'));
    assert.equal(last(t).text, 'Quiz one', 'she stays on the question she was on');
    assert.equal(events(live, 'share_repeated').filter((e) => e.phone === phone).length, 1);
    assert.equal(events(live, 'raffle_entry').filter((e) => e.phone === phone).length, 1);
    conversationState.remove(`whatsapp:${phone}`);
  });

  await scenario('tapping it again while waiting on "did you share?" (after the first tap) also works once, and returns to that branch', async () => {
    const t = new FakeTransport(); const phone = '972500700004';
    await inbound(storage, t, phone, 'join-live');
    await inbound(storage, t, phone, 'opt-share', true);
    assert.equal(last(t).text, 'Did you share?');
    later(20);
    const before = t.sent.length;
    await inbound(storage, t, phone, 'opt-share', true);
    assert.deepEqual(texts(t).slice(before), ['LINK AND VIDEO', 'Did you share?']);
    conversationState.remove(`whatsapp:${phone}`);
  });

  await scenario('a quick double tap on the share button is one tap, not a repeat', async () => {
    const t = new FakeTransport(); const phone = '972500700005';
    await inbound(storage, t, phone, 'join-live');
    await inbound(storage, t, phone, 'opt-share', true);
    const before = t.sent.length;
    await inbound(storage, t, phone, 'opt-share', true);              // same moment: duplicate of the first tap
    assert.equal(t.sent.length, before, 'ignored');
    assert.equal(events(live, 'share_repeated').filter((e) => e.phone === phone).length, 0, 'her one repeat is not consumed');
    conversationState.remove(`whatsapp:${phone}`);
  });

  await scenario('without the flag an old button is an invalid answer exactly as before (no link, no jump back)', async () => {
    const t = new FakeTransport(); const phone = '972500700006';
    await inbound(storage, t, phone, 'join-plain');
    await inbound(storage, t, phone, 'opt-later', true);
    later(20);
    const before = t.sent.length;
    await inbound(storage, t, phone, 'opt-share', true);
    assert.ok(!texts(t).slice(before).includes('LINK AND VIDEO'));
    assert.equal(events(plain, 'share_repeated').length, 0);
    assert.equal(last(t).text.includes('Quiz one'), true, 'the current question is shown again');
    conversationState.remove(`whatsapp:${phone}`);
  });

  const wamidOf = (transport, text) => transport.sent.find((m) => m.text === text)?.wamid;

  await scenario("origin: a tap that does not answer HER buttons message for that step is an invalid answer (no context / another person's message / another step)", async () => {
    const other = new FakeTransport(); const t = new FakeTransport(); const phone = '972500700007';
    await inbound(storage, other, '972500700099', 'join-live');           // somebody else's identical question
    await inbound(storage, t, phone, 'join-live');
    await inbound(storage, t, phone, 'opt-later', true);
    for (const [label, replyTo] of [['no context', null], ['unknown id', 'wamid.NOPE'], ['another person', wamidOf(other, 'Want 2 extra tickets? Share the video')], ['her own but another step', wamidOf(t, 'Quiz one')]]) {
      later(20);
      const before = t.sent.length;
      await inbound(storage, t, phone, 'opt-share', true, replyTo);
      assert.ok(!texts(t).slice(before).includes('LINK AND VIDEO'), `${label}: must not jump back`);
    }
    assert.equal(events(live, 'share_repeated').filter((e) => e.phone === phone).length, 0, 'nothing consumed');
    later(20);
    const before = t.sent.length;
    await inbound(storage, t, phone, 'opt-share', true);                    // the real one: reply to her own question
    assert.deepEqual(texts(t).slice(before), ['LINK AND VIDEO', 'Did you share?']);
    conversationState.remove(`whatsapp:${phone}`); conversationState.remove('whatsapp:972500700099');
  });

  await scenario("origin, cloned campaigns: the same button ids in a copied campaign do not accept a tap on the ORIGINAL campaign's message", async () => {
    const t = new FakeTransport(); const phone = '972500700008';
    const clone = storage.duplicateCampaign(live.id, 'Live copy');
    storage.updateCampaign(clone.id, { name: 'Live copy', triggerPhrase: 'join-copy', active: true });
    await inbound(storage, t, phone, 'join-live');
    const oldQuestion = wamidOf(t, 'Want 2 extra tickets? Share the video');
    await inbound(storage, t, phone, 'opt-later', true);
    await inbound(storage, t, phone, 'q1a', true);
    conversationState.remove(`whatsapp:${phone}`);
    later(20);
    await inbound(storage, t, phone, 'join-copy');                          // a new run, in the copy (new result, same ids)
    later(20);
    await inbound(storage, t, phone, 'opt-later', true);
    assert.equal(last(t).text, 'Quiz one');
    later(20);
    let before = t.sent.length;
    await inbound(storage, t, phone, 'opt-share', true, oldQuestion);        // scrolls up to the OTHER campaign's message
    assert.ok(!texts(t).slice(before).includes('LINK AND VIDEO'), "a message of the other campaign's run is not proof");
    later(20);
    before = t.sent.length;
    const ownQuestion = [...t.sent].reverse().find((m) => m.text === 'Want 2 extra tickets? Share the video').wamid;
    await inbound(storage, t, phone, 'opt-share', true, ownQuestion);
    assert.deepEqual(texts(t).slice(before), ['LINK AND VIDEO', 'Did you share?'], 'its own message works');
    conversationState.remove(`whatsapp:${phone}`);
  });

  await scenario('delivery of the branch ends UNCERTAIN: the extra tap counts as used (recovery finishes the same branch), so it cannot be used again after recovery', async () => {
    const t = new FakeTransport(); const phone = '972500700009';
    await inbound(storage, t, phone, 'join-live');
    await inbound(storage, t, phone, 'opt-later', true);
    later(20);
    const rec = startDeliveryRecovery(storage, () => t);
    try {
      t.failText = 'Did you share?';
      try { await inbound(storage, t, phone, 'opt-share', true); } catch { /* the uncertain send holds the participant until the delivery is resolved */ }
      t.failText = null;
      assert.equal(count(t, 'LINK AND VIDEO'), 1, 'the link did go out');
      assert.equal(events(live, 'share_repeated').filter((e) => e.phone === phone).length, 1, 'used: recovery completes this branch');
      const row = storage.getUncertainOutboxMessages().find((m) => m.text === 'Did you share?' && m.to.includes(phone));
      assert.ok(row, 'the question is the unresolved message');
      storage.applyMetaStatus({ wamid: 'wamid.EVREPEAT', status: 'delivered', recipientId: phone, attemptId: row.attemptId });   // Meta confirms it arrived
      for (let i = 0; i < 200 && conversationState.get(`whatsapp:${phone}`)?.kind !== 'decision'; i += 1) await new Promise((r) => setTimeout(r, 20));
      assert.equal(conversationState.get(`whatsapp:${phone}`)?.kind, 'decision', 'pending question restored by recovery');
      assert.equal(count(t, 'LINK AND VIDEO'), 1, 'recovery did not send the link again');
      later(20);
      const before = t.sent.length;
      await inbound(storage, t, phone, 'opt-share', true);                     // taps share a second time
      assert.ok(!texts(t).slice(before).includes('LINK AND VIDEO'), 'the one extra tap was already used');
      assert.equal(events(live, 'raffle_entry').filter((e) => e.phone === phone).length, 1, 'raffle still once');
    } finally { await rec.stop(); conversationState.remove(`whatsapp:${phone}`); }
  });

  await scenario('the branch fails for any OTHER reason: nothing was delivered that she could tap through, so the extra tap is NOT used up', async () => {
    const t = new FakeTransport(); const phone = '972500700010';
    await inbound(storage, t, phone, 'join-live');
    await inbound(storage, t, phone, 'opt-later', true);
    later(20);
    const original = t.sendMessage.bind(t);
    t.sendMessage = async (to, text) => { if (text === 'LINK AND VIDEO') throw new Error('Meta refused: invalid parameter'); return original(to, text); };
    try { await inbound(storage, t, phone, 'opt-share', true); } catch { /* held for review */ }
    assert.equal(events(live, 'share_repeated').filter((e) => e.phone === phone).length, 0, 'not recorded');
    conversationState.remove(`whatsapp:${phone}`);
  });

  const finishFlow = async (t, phone) => {
    clockOffset = 0;                                                       // stored timestamps use the real clock; the window is measured from them
    await inbound(storage, t, phone, 'join-live');
    await inbound(storage, t, phone, 'opt-later', true);
    later(20); await inbound(storage, t, phone, 'q1a', true);
    later(20); await inbound(storage, t, phone, 'q2a', true);
    assert.equal(last(t).text, 'THE END');
    assert.equal(conversationState.get(`whatsapp:${phone}`), undefined, 'the flow has ended: no pending question');
  };

  await scenario('after the flow ENDED: within the window the repeatable button still works (once); the flow then ends again', async () => {
    const t = new FakeTransport(); const phone = '972500700011';
    await finishFlow(t, phone);
    later(5 * 60);                                                         // five minutes after the last message
    const before = t.sent.length;
    await inbound(storage, t, phone, 'opt-share', true);
    assert.deepEqual(texts(t).slice(before), ['LINK AND VIDEO', 'Did you share?']);
    assert.equal(events(live, 'share_repeated').filter((e) => e.phone === phone).length, 1);
    later(20);
    await inbound(storage, t, phone, 'opt-done', true);
    assert.deepEqual(texts(t).slice(-2), ['TWO MORE TICKETS', 'Quiz one'], 'and the flow continues in its normal order from there');
    assert.equal(events(live, 'raffle_entry').filter((e) => e.phone === phone).length, 1, 'raffle still once');
    conversationState.remove(`whatsapp:${phone}`);
  });

  await scenario('after the flow ended: a second tap does not repeat, a tap after the window is not served, and a foreign message is not accepted', async () => {
    const t = new FakeTransport(); const phone = '972500700012';
    await finishFlow(t, phone);
    later(60);
    await inbound(storage, t, phone, 'opt-share', true, 'wamid.NOPE');                // not her own message
    assert.ok(!texts(t).includes('LINK AND VIDEO'), 'origin is checked after the end too');
    later(60);
    await inbound(storage, t, phone, 'opt-share', true);
    assert.equal(count(t, 'LINK AND VIDEO'), 1);
    conversationState.remove(`whatsapp:${phone}`);
    later(60);
    await inbound(storage, t, phone, 'opt-share', true);                               // the one repeat is used
    assert.equal(count(t, 'LINK AND VIDEO'), 1, 'only once');

    const t2 = new FakeTransport(); const late = '972500700013';
    await finishFlow(t2, late);
    later(11 * 60);                                                                    // past the 10 minute window
    const before = t2.sent.length;
    await inbound(storage, t2, late, 'opt-share', true);
    assert.ok(!texts(t2).slice(before).includes('LINK AND VIDEO'), 'too late');
    assert.equal(t2.sent.length, before, 'as for any old button after a finished flow: no new link, nothing sent');
  });

  await scenario('the gateway signal: the client reports an open repeat window only inside the window, only while the tap is unused', async () => {
    const t = new FakeTransport(); const phone = '972500700014';
    assert.equal(repeatableWindowCampaignId(storage, phone), undefined, 'never entered');
    await finishFlow(t, phone);
    later(5 * 60);
    assert.equal(repeatableWindowCampaignId(storage, phone), live.id, 'inside the window');
    await inbound(storage, t, phone, 'opt-share', true);
    assert.equal(repeatableWindowCampaignId(storage, phone), undefined, 'the one tap is used');
    const t2 = new FakeTransport(); const late = '972500700015';
    await finishFlow(t2, late);
    later(11 * 60);
    assert.equal(repeatableWindowCampaignId(storage, late), undefined, 'past the window');
    conversationState.remove(`whatsapp:${phone}`);
  });

  await scenario('saving a campaign keeps the flag on a normal option and drops it from the referral actions', async () => {
    startAdminServer(storage);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const base = `http://127.0.0.1:${process.env.PORT}`;
    const login = await fetch(`${base}/auth/client/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessCode: process.env.CLIENT_ACCESS_TOKEN }) });
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
    const body = { name: 'Saved flag', triggerType: 1, triggerPhrase: 'join-saved', conversation: { ...conversation(false), decisionFlow: [
      { id: 'sq', kind: 'question', presentation: 'buttons', text: 'Q', options: [
        { id: 'o1', text: 'Share', repeatable: true, raffleEntry: true, nextStepId: 'sm' },
        { id: 'o2', text: 'Plain', nextStepId: 'sm' },
        { id: 'o3', text: 'Link', action: 'referral_link', repeatable: true },
      ] },
      { id: 'sm', kind: 'message', text: 'M' },
    ] } };
    const res = await fetch(`${base}/api/campaigns`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    assert.ok([200, 201].includes(res.status), `create status ${res.status}`);
    const saved = (await (await fetch(`${base}/api/campaigns`, { headers: { cookie } })).json());
    const campaign = (Array.isArray(saved) ? saved : saved.campaigns).find((c) => c.name === 'Saved flag');
    const options = campaign.conversation.decisionFlow[0].options;
    assert.equal(options.find((o) => o.id === 'o1').repeatable, true);
    assert.equal(options.find((o) => o.id === 'o2').repeatable, undefined);
    assert.equal(options.find((o) => o.action === 'referral_link')?.repeatable, undefined, 'an auxiliary action cannot be a repeatable branch');
  });

  Date.now = realNow;
  fs.rmSync(dir, { recursive: true, force: true });
  let failed = 0;
  for (const [name, status, detail] of results) { console.log(`${status}  ${name}${detail ? '\n      ' + detail : ''}`); if (status !== 'PASS') failed += 1; }
  console.log(failed ? `\n${failed} scenario(s) FAILED` : `\nRepeatable button tests passed (${results.length} scenarios).`);
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
})().catch((e) => { console.error(e); process.exit(1); });
