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

function addCampaign(storage, trigger, text, delayMs) {
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
      decisionFlow: [{ id: `${trigger}-step`, kind: 'message', text, ...(delayMs === undefined ? {} : { delayMs }) }],
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
  const phones = ['972500000201', '972500000202'];
  try {
    addCampaign(storage, 'default-delay', 'Default delayed message');
    addCampaign(storage, 'custom-delay', 'Custom delayed message', 140);
    const defaultElapsed = await inbound(storage, transport, phones[0], 'default-delay', 'delay-default');
    const customElapsed = await inbound(storage, transport, phones[1], 'custom-delay', 'delay-custom');
    assert.ok(defaultElapsed >= 50, `default campaign delay was skipped (${defaultElapsed}ms)`);
    assert.ok(customElapsed >= 125, `configured step delay was skipped (${customElapsed}ms)`);
    assert.ok(customElapsed > defaultElapsed, 'configured delay should remain longer than the default delay');
    console.log('Campaign message delay tests passed.');
  } finally {
    for (const phone of phones) conversationState.remove(`whatsapp:${phone}`);
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
