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
    await inbound(storage, transport, retryPhone, 'option-go', true);
    const retained = conversationState.get(`whatsapp:${retryPhone}`);
    assert.ok(retained && retained.kind === 'decision' && retained.stepId === 'step-one', 'failed transition must retain the previous recoverable question');
    transport.failText = '';
    await inbound(storage, transport, retryPhone, 'option-go', true);
    assert.strictEqual(conversationState.get(`whatsapp:${retryPhone}`).stepId, 'step-two', 'retry after transport recovery should advance normally');
    const retryEvents = storage.getCampaignEvents(retryCampaign.id);
    assert.strictEqual(retryEvents.filter((event) => event.type === 'step_answered').length, 1, 'retry must not duplicate step-answer events');
    assert.strictEqual(retryEvents.filter((event) => event.type === 'raffle_entry').length, 1, 'retry must not duplicate raffle eligibility');

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