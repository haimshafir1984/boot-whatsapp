'use strict';
// Regression: a cross-client cancellation stops an already-sleeping flow.
// Uses synthetic campaign data and a fake transport; no network or real account.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-switch-audit-'));
Object.assign(process.env, {
  NODE_ENV: 'test', WHATSAPP_PROVIDER: 'META_CLOUD_API', BOT_REPLY_DELAY_MS: '0',
  CONVERSATION_STATE_PATH: path.join(dir, 'state.json'), STORAGE_PATH: path.join(dir, 'storage.json'),
});
const { Storage } = require('../dist/storage');
const { stopCampaignWork } = require('../dist/campaignWork');
const { conversationState } = require('../dist/conversationState');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
const storage = new Storage(path.join(dir, 'storage.json'));
const phone = '972500000099';
const sent = [];
const transport = {
  resolvePhone: async () => phone,
  sendMessage: async (to, text) => { sent.push(text); return { messageId: `fake-${sent.length}` }; },
  sendInteractiveButtons: async (to, text) => { sent.push(text); return { messageId: `fake-${sent.length}` }; },
};
let sequence = 0;
const inbound = body => handleIncomingWhatsAppMessage({
  id: `audit-${++sequence}`, from: `whatsapp:${phone}`, body, hasUserSignal: true,
  timestamp: Math.floor(Date.now() / 1000), getDisplayName: async () => 'Synthetic audit',
}, storage, transport, 'webhook');
(async () => {
  storage.addCampaign({ name: 'Synthetic A', triggerType: 1, triggerPhrase: 'audit-start', active: true, suffix: '',
    conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [],
      decisionFlow: [
        { id: 'q', kind: 'question', presentation: 'buttons', text: 'Question A', options: [{ id: 'go', text: 'Go', nextStepId: 'end' }] },
        { id: 'end', kind: 'message', text: 'Late message A', delayMs: 400 },
      ],
    },
  });
  await inbound('audit-start');
  const processing = inbound('go');
  const deadline = Date.now() + 3000;
  while (!storage.data.outboxMessages.some(x => x.text === 'Late message A') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(storage.data.outboxMessages.some(x => x.text === 'Late message A'), 'reached delayed send');
  const removed = conversationState.removeByPhone(phone); // actual clear-pending operation
  assert.equal(removed, 1);
  assert.ok(!sent.includes('Late message A'), 'old send has not happened at switch time');
  await stopCampaignWork(phone, async () => { conversationState.removeByPhone(phone); storage.cancelOutboxForRecipient(phone); await storage.flush(); });
  await processing;
  assert.ok(!sent.includes('Late message A'), 'old flow must stop after clear-pending');
  assert.ok(!conversationState.isHeldForReview(phone), 'cancellation must not create needs_review');
  assert.equal(storage.hasOutstandingOutboxForRecipient(phone), false);
  const restored = new Storage(path.join(dir, 'storage.json'));
  assert.equal(restored.hasOutstandingOutboxForRecipient(phone), false, 'cancelled outbox must stay cancelled after restart');
  storage.addCampaign({ name:'Synthetic B', triggerType:1, triggerPhrase:'audit-second', active:true, suffix:'',
    conversation:{askNameEnabled:false,nameTimeoutMinutes:5,askNameText:'',replyText:'',followupMessages:[],decisionFlow:[{id:'b',kind:'message',text:'Message B'}]} });
  await inbound('audit-start');
  const again = inbound('go');
  const until = Date.now()+3000;
  while (!storage.data.outboxMessages.some(x=>x.text==='Late message A'&&x.status==='processing') && Date.now()<until) await new Promise(resolve=>setTimeout(resolve,5));
  await inbound('audit-second');
  await again;
  assert.equal(sent.filter(text=>text==='Late message A').length,0,'local campaign switch must interrupt A before entering the sender queue');
  assert.ok(sent.includes('Message B'),'new campaign still works');
  console.log(JSON.stringify({ confirmed: true, removed, sentAfterClear: false }));
  conversationState.remove(`whatsapp:${phone}`);
  console.log(`Synthetic data retained at ${dir}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
