'use strict';

/**
 * Regression coverage for the Meta UX changes:
 * - Existing Dokploy clients may still carry BOT_REPLY_DELAY_MS=1000, but Meta
 *   conversations should use the capped provider default and feel fast.
 * - List questions should keep the WhatsApp picker tidy: numbered row titles,
 *   long answer copy in descriptions, and a configurable opener button.
 */

process.env.NODE_ENV = 'test';
process.env.WHATSAPP_PROVIDER = 'META_CLOUD_API';
process.env.BOT_REPLY_DELAY_MS = '1000';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-speed-list-'));

const { Storage } = require('../dist/storage');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
const { conversationState } = require('../dist/conversationState');

class FakeTransport {
  constructor() { this.sentLists = []; }
  async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); }
  async sendInteractiveList(to, text, buttonText, items) {
    this.sentLists.push({ to, text, buttonText, items, at: Date.now() });
    return { messageId: 'wamid.fake-list-1' };
  }
  async sendMessage(to, text) {
    throw new Error(`Unexpected plain-text fallback to ${to}: ${text}`);
  }
}

function addCampaign(storage) {
  storage.addCampaign({
    name: 'meta-list-speed',
    triggerType: 1,
    triggerPhrase: 'meta-list-speed',
    suffix: '',
    active: true,
    conversation: {
      askNameEnabled: false,
      nameTimeoutMinutes: 5,
      askNameText: '',
      replyText: '',
      followupMessages: [],
      decisionFlow: [{
        id: 'question',
        kind: 'question',
        presentation: 'list',
        listButtonText: 'לשאלות 👇',
        text: 'בחרי שאלה שמעניינת אותך',
        options: [
          { id: 'one', text: 'האם כדי להגיע ליעדים אצטרך לחיות בצמצום?' },
          { id: 'two', text: 'כבר ניסינו הכול, מה ישתנה?' },
          { id: 'three', text: 'אנחנו מרוויחים מעולה, למה אנחנו לא מצליחים לסגור את החודש?' },
        ],
      }],
    },
  });
}

async function inbound(storage, transport, phone, body) {
  await handleIncomingWhatsAppMessage({
    id: `meta-speed-list-${Date.now()}`,
    from: `whatsapp:${phone}`,
    body,
    hasUserSignal: true,
    timestamp: Math.floor(Date.now() / 1000),
    async getDisplayName() { return 'Meta list test'; },
  }, storage, transport, 'webhook');
}

(async () => {
  const storage = new Storage(path.join(directory, 'storage.json'));
  const transport = new FakeTransport();
  const phone = '972500000501';
  try {
    addCampaign(storage);
    const startedAt = Date.now();
    await inbound(storage, transport, phone, 'meta-list-speed');
    const elapsedMs = Date.now() - startedAt;

    assert.equal(transport.sentLists.length, 1, 'the question must be sent as an interactive list');
    assert.ok(elapsedMs < 700, `Meta default delay should be capped well below the old 1000ms env, took ${elapsedMs}ms`);

    const list = transport.sentLists[0];
    assert.equal(list.buttonText, 'לשאלות 👇');
    assert.deepEqual(list.items.map((item) => item.text), ['1', '2', '3']);
    assert.equal(list.items[0].description, 'האם כדי להגיע ליעדים אצטרך לחיות בצמצום?');
    assert.match(list.items[2].description, /אנחנו מרוויחים מעולה/);

    conversationState.remove(`whatsapp:${phone}`);
    console.log(`Meta speed/list presentation test passed in ${elapsedMs}ms.`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
