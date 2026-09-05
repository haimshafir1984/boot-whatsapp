'use strict';

process.env.NODE_ENV = 'test';
process.env.BOT_REPLY_DELAY_MS = '0';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Storage } = require('../dist/storage');
const { conversationState } = require('../dist/conversationState');
const { getFlowHealthSnapshot, handleIncomingWhatsAppMessage } = require('../dist/messageFlow');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeTransport {
  constructor(delayMs = 0) {
    this.delayMs = delayMs;
    this.sent = [];
    this.activeSends = 0;
    this.maxActiveSends = 0;
    this.failText = '';
    this.failCount = 0;
    this.fileDelayMs = 0;
  }
  async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); }
  async deliver(item) {
    this.activeSends += 1;
    this.maxActiveSends = Math.max(this.maxActiveSends, this.activeSends);
    try {
      if (this.delayMs) await wait(this.delayMs);
      if (item.text === this.failText && this.failCount > 0) {
        this.failCount -= 1;
        throw new Error('planned transport failure');
      }
      this.sent.push(item);
    } finally {
      this.activeSends -= 1;
    }
  }
  async sendMessage(to, text) { await this.deliver({ type: 'text', to, text }); }
  async sendInteractiveButtons(to, text, buttons) { await this.deliver({ type: 'buttons', to, text, buttons }); }
  async sendInteractiveList(to, text, buttonText, items) { await this.deliver({ type: 'list', to, text, buttonText, items }); }
  async sendFile(to, filePath, caption, options) {
    this.activeSends += 1;
    this.maxActiveSends = Math.max(this.maxActiveSends, this.activeSends);
    try {
      if (this.fileDelayMs) await wait(this.fileDelayMs);
      this.sent.push({ type: 'file', to, filePath, caption, options });
    } finally {
      this.activeSends -= 1;
    }
  }
}

function flowConversation(overrides = {}) {
  return {
    askNameEnabled: false,
    nameTimeoutMinutes: 5,
    askNameText: 'Name?',
    replyText: '',
    followupMessages: [],
    decisionFlow: [
      {
        id: 'step-one',
        kind: 'question',
        presentation: 'buttons',
        text: 'First question',
        timeoutMinutes: 30,
        options: [{ id: 'option-go', text: 'Continue', raffleEntry: true, endText: 'transition-message', nextStepId: 'step-two' }],
      },
      {
        id: 'step-two',
        kind: 'question',
        presentation: 'buttons',
        text: 'Second question',
        timeoutMinutes: 30,
        options: [{ id: 'option-finish', text: 'Finish' }],
      },
    ],
    decisionTimeoutMinutes: 30,
    decisionTimeoutText: '',
    decisionTimeoutMode: 'message',
    decisionTimeoutNextStepId: '',
    invalidReplyText: 'Choose one of the shown options',
    flowRecoveryText: 'Restarting flow',
    humanHandoffEnabled: false,
    humanHandoffText: '',
    humanHandoffPhone: '',
    ...overrides,
  };
}

function addCampaign(storage, name, trigger, overrides = {}) {
  return storage.addCampaign({
    name,
    triggerType: 1,
    triggerPhrase: trigger,
    suffix: ' - Bot',
    active: true,
    conversation: flowConversation(overrides),
  });
}

let sequence = 0;
function inbound(storage, transport, phone, body, isButtonReply = false) {
  sequence += 1;
  return handleIncomingWhatsAppMessage({
    id: `concurrency-${sequence}`,
    from: `whatsapp:${phone}`,
    senderPhone: phone,
    body,
    hasUserSignal: Boolean(body) || isButtonReply,
    isButtonReply,
    timestamp: Math.floor(Date.now() / 1000),
    async getDisplayName() { return `User ${phone}`; },
  }, storage, transport, 'webhook');
}

(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-concurrency-test-'));
  const storage = new Storage(path.join(tempDir, 'storage.json'));
  const transport = new FakeTransport(35);
  const usedPhones = new Set();

  try {
    const concurrentCampaign = addCampaign(storage, 'Concurrent campaign', 'join-concurrent');
    const phone = '972500000101';
    usedPhones.add(phone);
    await inbound(storage, transport, phone, 'join-concurrent');

    const beforeSecondQuestion = transport.sent.filter((item) => item.text === 'Second question').length;
    await Promise.all([
      inbound(storage, transport, phone, 'option-go', true),
      inbound(storage, transport, phone, 'option-go', true),
    ]);
    const afterSecondQuestion = transport.sent.filter((item) => item.text === 'Second question').length;
    assert.strictEqual(afterSecondQuestion - beforeSecondQuestion, 1, 'two rapid replies from one user must advance only once');
    assert.strictEqual(storage.getCampaignEvents(concurrentCampaign.id).filter((event) => event.type === 'raffle_entry').length, 1, 'rapid duplicate must create one raffle entry');
    assert.strictEqual(conversationState.get(`whatsapp:${phone}`).stepId, 'step-two', 'serialized reply should leave the next question pending');

    const retryCampaign = addCampaign(storage, 'Retry campaign', 'join-retry');
    const retryPhone = '972500000102';
    usedPhones.add(retryPhone);
    await inbound(storage, transport, retryPhone, 'join-retry');
    transport.failText = 'transition-message';
    transport.failCount = 2;
    // silent-data-loss-fix (finding 01): handleIncomingWhatsAppMessage now
    // rethrows a processing failure instead of swallowing it, and holds the
    // sender (needs_review) instead of silently allowing an automatic retry
    // of the same button reply - a second run of handleMessage could
    // otherwise resend a step the first attempt already progressed past.
    // This deliberately replaces the old "just send the same button reply
    // again and it recovers silently" assumption this test used to encode -
    // see silent-data-loss-fix-plan-review-2026-09-05.md, finding 01.
    await assert.rejects(
      inbound(storage, transport, retryPhone, 'option-go', true),
      /planned transport failure/,
      'a send failure during a decision transition must now propagate, not be swallowed',
    );
    const blockedAfterFailure = conversationState.get(`whatsapp:${retryPhone}`);
    assert.ok(blockedAfterFailure && blockedAfterFailure.kind === 'needs_review', 'the sender must be held for admin review after a send failure, not silently retryable');

    // A duplicate provider re-delivery (or the user just tapping the button
    // again) must stay blocked, not quietly re-attempt the flow.
    await inbound(storage, transport, retryPhone, 'option-go', true).catch(() => {});
    assert.strictEqual(conversationState.get(`whatsapp:${retryPhone}`).kind, 'needs_review', 'further messages from a needs_review sender must stay held, not re-attempt the flow');
    assert.strictEqual(transport.sent.filter((item) => item.text === 'Second question' && item.to === `whatsapp:${retryPhone}`).length, 0, 'a blocked sender must not have advanced past the failed step');

    // Mirrors what POST /api/needs-review/:jid/resolve does in production -
    // an explicit, authenticated admin action lifts the hold. This round does
    // not attempt to resume the exact prior flow position automatically
    // (full-replay recovery was explicitly rejected as unsafe); the admin
    // reopens the conversation, which here means a fresh trigger.
    conversationState.remove(`whatsapp:${retryPhone}`);
    transport.failText = '';
    await inbound(storage, transport, retryPhone, 'join-retry');
    await inbound(storage, transport, retryPhone, 'option-go', true);
    assert.strictEqual(conversationState.get(`whatsapp:${retryPhone}`).stepId, 'step-two', 'after the admin resolves the hold, a fresh attempt should advance normally');
    const retryEvents = storage.getCampaignEvents(retryCampaign.id);
    // Two attempts happened at the campaign level (the failed one, then the
    // admin-reopened fresh one), so - unlike the old same-message-retry
    // design - two step_answered/raffle_entry events are expected here, one
    // per campaignResult. What matters is that recovery works at all and
    // that the SAME reopened attempt is not itself duplicated.
    assert.strictEqual(retryEvents.filter((event) => event.type === 'step_answered').length, 2, 'one step_answered per attempt (failed + admin-reopened), no additional duplication within either');
    assert.strictEqual(retryEvents.filter((event) => event.type === 'raffle_entry').length, 2, 'one raffle_entry per attempt (failed + admin-reopened), no additional duplication within either');

    const timeoutCampaign = addCampaign(storage, 'Timeout resume campaign', 'join-timeout', {
      decisionFlow: [
        {
          id: 'timeout-step',
          kind: 'question',
          presentation: 'buttons',
          text: 'Timed question',
          timeoutMinutes: 0.001,
          timeoutText: 'Timed out',
          options: [{ id: 'timeout-option', text: 'Resume here', nextStepId: 'timeout-next' }],
        },
        { id: 'timeout-next', kind: 'message', text: 'Resumed exact flow' },
      ],
    });
    const timeoutPhone = '972500000103';
    usedPhones.add(timeoutPhone);
    await inbound(storage, transport, timeoutPhone, 'join-timeout');
    await wait(180);
    assert.strictEqual(conversationState.get(`whatsapp:${timeoutPhone}`), undefined, 'decision timeout should clear its pending state');
    await inbound(storage, transport, timeoutPhone, 'timeout-option', true);
    assert.ok(transport.sent.some((item) => item.to === `whatsapp:${timeoutPhone}` && item.text === 'Resumed exact flow'), 'an old valid button should resume its exact timed-out step');
    assert.strictEqual(storage.getCampaignResults(timeoutCampaign.id).length, 1, 'timeout resume must reuse the same participant result');

    const raceCampaign = addCampaign(storage, 'Timeout race campaign', 'join-timeout-race', {
      decisionFlow: [
        {
          id: 'race-step',
          kind: 'question',
          presentation: 'buttons',
          text: 'Race question',
          timeoutMinutes: 0.001,
          timeoutText: 'should-not-timeout',
          options: [{ id: 'race-option', text: 'Race answer', endText: 'race reply', nextStepId: 'race-next' }],
        },
        { id: 'race-next', kind: 'message', text: 'race completed' },
      ],
    });
    const racePhone = '972500000106';
    usedPhones.add(racePhone);
    transport.delayMs = 80;
    await inbound(storage, transport, racePhone, 'join-timeout-race');
    await inbound(storage, transport, racePhone, 'race-option', true);
    await wait(120);
    assert.ok(transport.sent.some((item) => item.to === `whatsapp:${racePhone}` && item.text === 'race completed'), 'reply racing its timeout should complete normally');
    assert.ok(!transport.sent.some((item) => item.to === `whatsapp:${racePhone}` && item.text === 'should-not-timeout'), 'stale timeout must not fire after a valid reply started processing');
    assert.strictEqual(storage.getCampaignResults(raceCampaign.id).length, 1, 'timeout race must keep one participant result');
    transport.delayMs = 35;

    addCampaign(storage, 'Timeout continuation cancellation', 'join-timeout-cancel', {
      decisionFlow: [
        {
          id: 'cancel-timeout-step',
          kind: 'question',
          presentation: 'buttons',
          text: 'Cancellation question',
          timeoutMinutes: 0.001,
          timeoutMode: 'continue',
          timeoutNextStepId: 'delayed-timeout-message',
          options: [{ id: 'cancel-option', text: 'Answer' }],
        },
        { id: 'delayed-timeout-message', kind: 'message', text: 'should-not-send-after-new-inbound', delayMs: 180 },
      ],
    });
    const cancelPhone = '972500000107';
    usedPhones.add(cancelPhone);
    await inbound(storage, transport, cancelPhone, 'join-timeout-cancel');
    await wait(100);
    await inbound(storage, transport, cancelPhone, 'join-timeout-cancel');
    assert.ok(!transport.sent.some((item) => item.to === `whatsapp:${cancelPhone}` && item.text === 'should-not-send-after-new-inbound'), 'new inbound must cancel a delayed timeout continuation before it sends');

    const parallelCampaign = addCampaign(storage, 'Parallel users campaign', 'join-parallel');
    const phoneA = '972500000104';
    const phoneB = '972500000105';
    usedPhones.add(phoneA);
    usedPhones.add(phoneB);
    transport.maxActiveSends = 0;
    await Promise.all([
      inbound(storage, transport, phoneA, 'join-parallel'),
      inbound(storage, transport, phoneB, 'join-parallel'),
    ]);
    assert.ok(transport.maxActiveSends >= 2, 'different users should continue processing in parallel');
    assert.strictEqual(storage.getCampaignResults(parallelCampaign.id).length, 2, 'parallel users must each create one result');

    const media = storage.addUploadedFile({
      originalName: 'slow-image.jpg',
      filename: 'slow-image.jpg',
      mimeType: 'image/jpeg',
      size: 1024,
    });
    addCampaign(storage, 'Ordered media campaign', 'join-ordered-media', {
      decisionFlow: [
        { id: 'slow-media', kind: 'message', text: 'media caption', fileId: media.id, nextStepId: 'after-media', delayMs: 0 },
        { id: 'after-media', kind: 'message', text: 'must follow media', delayMs: 0 },
      ],
    });
    const mediaPhone = '972500000108';
    usedPhones.add(mediaPhone);
    transport.fileDelayMs = 180;
    await inbound(storage, transport, mediaPhone, 'join-ordered-media');
    transport.fileDelayMs = 0;
    const mediaEvents = transport.sent.filter((item) => item.to === `whatsapp:${mediaPhone}`);
    assert.deepStrictEqual(
      mediaEvents.map((item) => item.type),
      ['file', 'text'],
      'a message after slow media must not overtake the media send',
    );
    assert.strictEqual(mediaEvents[1].text, 'must follow media');

    const isolatedStorageA = new Storage(path.join(tempDir, 'isolated-a.json'));
    const isolatedStorageB = new Storage(path.join(tempDir, 'isolated-b.json'));
    const isolatedTransportA = new FakeTransport(80);
    const isolatedTransportB = new FakeTransport(80);
    addCampaign(isolatedStorageA, 'Isolated A', 'join-isolated-a');
    addCampaign(isolatedStorageB, 'Isolated B', 'join-isolated-b');
    const isolatedPhoneA = '972500000109';
    const isolatedPhoneB = '972500000110';
    usedPhones.add(isolatedPhoneA);
    usedPhones.add(isolatedPhoneB);
    await Promise.all([
      inbound(isolatedStorageA, isolatedTransportA, isolatedPhoneA, 'join-isolated-a'),
      inbound(isolatedStorageB, isolatedTransportB, isolatedPhoneB, 'join-isolated-b'),
    ]);
    assert.ok(isolatedStorageA.getOutboxMessages().every((item) => item.to === `whatsapp:${isolatedPhoneA}`), 'concurrent client A must retain its own outbox context');
    assert.ok(isolatedStorageB.getOutboxMessages().every((item) => item.to === `whatsapp:${isolatedPhoneB}`), 'concurrent client B must retain its own outbox context');

    const health = getFlowHealthSnapshot();
    assert.ok(health.serializedWaits >= 1, 'health metrics should report a same-user queue wait');
    assert.ok(health.timedOutRepliesResumed >= 1, 'health metrics should report timeout resumption');
    assert.ok(health.maxQueueDepth >= 2, 'health metrics should capture concurrent same-user depth');

    console.log('Flow concurrency and timeout tests passed.');
  } finally {
    for (const phone of usedPhones) conversationState.remove(`whatsapp:${phone}`);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
