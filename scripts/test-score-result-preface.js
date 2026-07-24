'use strict';
process.env.NODE_ENV = 'test';
process.env.BOT_REPLY_DELAY_MS = '0';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Storage } = require('../dist/storage');
const { conversationState } = require('../dist/conversationState');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
class Transport {
  constructor() { this.sent = []; }
  async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); }
  async sendMessage(to, text) { this.sent.push({ type: 'text', to, text }); }
  async sendInteractiveButtons(to, text, buttons) { this.sent.push({ type: 'buttons', to, text, buttons }); }
}
let sequence = 0;
async function inbound(storage, transport, phone, body, isButtonReply = false) {
  sequence += 1;
  await handleIncomingWhatsAppMessage({ id: 'score-' + sequence, from: 'whatsapp:' + phone, body, isButtonReply, hasUserSignal: true, timestamp: Math.floor(Date.now() / 1000), async getDisplayName() { return 'Participant'; } }, storage, transport, 'webhook');
}
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-result-preface-'));
  try {
    const storage = new Storage(path.join(dir, 'storage.json'));
    storage.addCampaign({ name: 'Score result', triggerType: 1, triggerPhrase: 'score-result', suffix: '', active: true, conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], decisionFlow: [
      { id: 'score', kind: 'score_question', presentation: 'buttons', text: 'Pick one', options: [{ id: 'one', text: 'One', score: 1, nextStepId: 'result' }] },
      { id: 'result', kind: 'score_result', text: 'Calculating your result', resultRules: [{ id: 'rule', type: 'majority', value: 1, endText: 'Your result is one' }] },
    ] } });
    const transport = new Transport();
    await inbound(storage, transport, '972500000002', 'score-result');
    await inbound(storage, transport, '972500000002', 'one', true);
    const texts = transport.sent.filter((item) => item.type === 'text' && item.to === 'whatsapp:972500000002').map((item) => item.text);
    assert.deepStrictEqual(texts.slice(-2), ['Calculating your result', 'Your result is one']);
    conversationState.remove('whatsapp:972500000002');
    console.log('Score-result preface test passed.');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((err) => { console.error(err); process.exit(1); });
