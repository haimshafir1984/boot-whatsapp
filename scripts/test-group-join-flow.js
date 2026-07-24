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
  await handleIncomingWhatsAppMessage({ id: `group-${sequence}`, from: `whatsapp:${phone}`, body, isButtonReply, hasUserSignal: true, timestamp: Math.floor(Date.now() / 1000), async getDisplayName() { return 'Participant'; } }, storage, transport, 'webhook');
}
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-join-flow-'));
  try {
    const storage = new Storage(path.join(dir, 'storage.json'));
    const campaign = storage.addCampaign({ name: 'Group join', triggerType: 1, triggerPhrase: 'join-group', suffix: '', active: true, conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], groupJoinManagerPhone: '972500000099', groupJoinParticipantConfirmationText: 'Request sent', decisionFlow: [{ id: 'question', kind: 'question', presentation: 'buttons', text: 'Need a group?', options: [{ id: 'manager', text: 'Send manager', action: 'request_group_join', nextStepId: 'next' }] }, { id: 'next', kind: 'message', text: 'Next flow message' }] } });
    const transport = new Transport();
    await inbound(storage, transport, '972500000001', 'join-group');
    await inbound(storage, transport, '972500000001', 'manager', true);
    assert(transport.sent.some((item) => item.to === 'whatsapp:972500000099' && item.text.includes('Group join')));
    assert(transport.sent.some((item) => item.to === 'whatsapp:972500000001' && item.text === 'Next flow message'));
    assert.strictEqual(transport.sent.filter((item) => item.type === 'buttons' && item.to === 'whatsapp:972500000001').length, 1, 'must not repeat the previous question');
    conversationState.remove('whatsapp:972500000001');
    console.log('Group join next-flow test passed.');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((err) => { console.error(err); process.exit(1); });
