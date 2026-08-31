'use strict';

process.env.NODE_ENV = 'test';
process.env.WHATSAPP_PROVIDER = 'META_CLOUD_API';
process.env.BOT_REPLY_DELAY_MS = '0';

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
  async sendMessage(to, text) { this.sent.push({ to, text }); }
}

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-trigger-age-test-'));
  const storage = new Storage(path.join(directory, 'storage.json'));
  const transport = new FakeTransport();
  const phone = '972500000901';
  try {
    storage.addCampaign({
      name: 'Meta delayed webhook',
      triggerType: 1,
      triggerPhrase: 'delayed meta trigger',
      suffix: '',
      active: true,
      conversation: {
        askNameEnabled: false,
        nameTimeoutMinutes: 5,
        askNameText: '',
        replyText: '',
        followupMessages: [],
        decisionFlow: [{ id: 'first', kind: 'message', text: 'accepted delayed trigger' }],
      },
    });

    await handleIncomingWhatsAppMessage({
      id: 'meta-delayed-trigger',
      from: `whatsapp:${phone}`,
      body: 'delayed meta trigger',
      hasUserSignal: true,
      timestamp: Math.floor((Date.now() - 5 * 60 * 1000) / 1000),
      async getDisplayName() { return 'Meta Delay'; },
    }, storage, transport, 'webhook');

    assert.equal(transport.sent.length, 1, 'Meta trigger delayed by 5 minutes should still be handled');
    assert.equal(transport.sent[0].text, 'accepted delayed trigger');
    console.log('Meta trigger age window test passed.');
  } finally {
    conversationState.remove(`whatsapp:${phone}`);
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
