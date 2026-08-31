'use strict';

process.env.NODE_ENV = 'test';
process.env.BOT_REPLY_DELAY_MS = '60';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../dist/storage');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
const { conversationState } = require('../dist/conversationState');

class FakeTransport {
  constructor() { this.sent = []; }
  async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); }
  async sendMessage(to, text) { this.sent.push({ to, text, sentAt: Date.now() }); }
}

function addCampaign(storage, trigger, text, delayMs, nextDelayMs) {
  const firstStep = { id: `${trigger}-step`, kind: 'message', text, ...(delayMs === undefined ? {} : { delayMs }) };
  if (nextDelayMs !== undefined) firstStep.nextStepId = `${trigger}-second-step`;
  const decisionFlow = [
    firstStep,
    ...(nextDelayMs === undefined ? [] : [{ id: `${trigger}-second-step`, kind: 'message', text: 'Second delayed message', delayMs: nextDelayMs }]),
  ];
  return storage.addCampaign({
    name: trigger,
    triggerType: 1,
    triggerPhrase: trigger,
    suffix: '',
    active: true,
    conversation: {
      askNameEnabled: false,
      nameTimeoutMinutes: 5,
      askNameText: '',
      replyText: '',
      followupMessages: [],
      decisionFlow,
    },
  });
}

async function inbound(storage, transport, phone, body, id) {
  const startedAt = Date.now();
  await handleIncomingWhatsAppMessage({
    id,
    from: `whatsapp:${phone}`,
    body,
    hasUserSignal: true,
    timestamp: Math.floor(Date.now() / 1000),
    async getDisplayName() { return 'Delay test'; },
  }, storage, transport, 'webhook');
  return transport.sent.find((item) => item.to === `whatsapp:${phone}`)?.sentAt - startedAt;
}

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'message-delay-test-'));
  const storage = new Storage(path.join(directory, 'storage.json'));
  const transport = new FakeTransport();
  const phones = ['972500000201', '972500000202', '972500000203'];
  try {
    addCampaign(storage, 'default-delay', 'Default delayed message');
    addCampaign(storage, 'custom-delay', 'Custom delayed message', 140);
    addCampaign(storage, 'second-delay', 'First fast message', 0, 140);
    const defaultElapsed = await inbound(storage, transport, phones[0], 'default-delay', 'delay-default');
    const customElapsed = await inbound(storage, transport, phones[1], 'custom-delay', 'delay-custom');
    const secondPhone = phones[2];
    await inbound(storage, transport, secondPhone, 'second-delay', 'delay-second');
    const secondSends = transport.sent.filter((item) => item.to === `whatsapp:${secondPhone}`);
    assert.equal(secondSends.length, 2, 'second-delay campaign should send two messages');
    const secondGap = secondSends[1].sentAt - secondSends[0].sentAt;
    assert.ok(defaultElapsed < 50, `default initial reply should use the fast lane (${defaultElapsed}ms)`);
    assert.ok(customElapsed < 80, `configured first step should still use the fast lane (${customElapsed}ms)`);
    assert.ok(secondGap >= 125, `configured delay after the first reply should be preserved (${secondGap}ms)`);
    console.log('Campaign message delay tests passed.');
  } finally {
    for (const phone of phones) conversationState.remove(`whatsapp:${phone}`);
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
