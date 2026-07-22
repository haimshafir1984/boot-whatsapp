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

class FakeTransport {
  constructor() { this.sent = []; }
  async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); }
  async sendMessage(to, text) { this.sent.push({ type: 'text', to, text }); }
  async sendInteractiveButtons(to, text, buttons) { this.sent.push({ type: 'buttons', to, text, buttons }); }
  async sendInteractiveList(to, text, buttonText, items) { this.sent.push({ type: 'list', to, text, buttonText, items }); }
}

function conversation(overrides = {}) {
  return {
    askNameEnabled: false,
    nameTimeoutMinutes: 5,
    askNameText: 'name?',
    replyText: '',
    followupMessages: [],
    decisionFlow: [
      {
        id: 'step-shared',
        kind: 'question',
        presentation: 'buttons',
        text: 'שמרת?',
        timeoutMinutes: 30,
        options: [{ id: 'option-shared', text: '✅ שמרתי', raffleEntry: true, nextStepId: 'step-done' }],
      },
      { id: 'step-done', kind: 'message', text: 'המשך תקין' },
    ],
    decisionTimeoutMinutes: 30,
    decisionTimeoutText: '',
    decisionTimeoutMode: 'message',
    decisionTimeoutNextStepId: '',
    invalidReplyText: '',
    flowRecoveryText: '',
    humanHandoffEnabled: false,
    humanHandoffText: '',
    humanHandoffPhone: '',
    ...overrides,
  };
}

function addCampaign(storage, name, triggerPhrase, overrides = {}) {
  return storage.addCampaign({
    name,
    triggerType: 1,
    triggerPhrase,
    suffix: ' - (Bot)',
    active: true,
    conversation: conversation(overrides),
  });
}

let messageSequence = 0;
async function inbound(storage, transport, phone, body, isButtonReply = false) {
  messageSequence += 1;
  await handleIncomingWhatsAppMessage({
    id: `test-${messageSequence}`,
    from: `whatsapp:${phone}`,
    body,
    hasUserSignal: Boolean(body) || isButtonReply,
    isButtonReply,
    timestamp: Math.floor(Date.now() / 1000),
    async getDisplayName() { return 'Test User'; },
  }, storage, transport, 'webhook');
}

(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-recovery-test-'));
  const storage = new Storage(path.join(tempDir, 'storage.json'));
  const transport = new FakeTransport();
  const phone = '972500000001';

  try {
    const first = addCampaign(storage, 'First campaign', 'join-first', {
      invalidReplyText: 'נא להשתמש באפשרות שמופיעה כאן',
      flowRecoveryText: 'חוזרים לתחילת הקמפיין הראשון',
      humanHandoffEnabled: true,
      humanHandoffText: 'handoff must not be sent',
    });

    await inbound(storage, transport, phone, 'join-first');
    assert.strictEqual(storage.getCampaignResults(first.id).length, 1, 'trigger should create one participant result');
    assert.strictEqual(transport.sent.at(-1).type, 'buttons', 'first question should be interactive');

    const beforeInvalid = transport.sent.length;
    await inbound(storage, transport, phone, 'תשובה אחרת');
    const invalidMessages = transport.sent.slice(beforeInvalid);
    assert.strictEqual(invalidMessages[0].text, 'נא להשתמש באפשרות שמופיעה כאן', 'configured invalid-answer message should be sent');
    assert.strictEqual(invalidMessages.at(-1).type, 'buttons', 'the same question should be sent again');
    assert.strictEqual(invalidMessages.at(-1).text, 'שמרת?', 'the repeated question should be the current question');
    assert.ok(!invalidMessages.some((item) => item.text === 'handoff must not be sent'), 'invalid answer must not close the flow via handoff');

    await inbound(storage, transport, phone, 'שמרתי');
    assert.ok(transport.sent.some((item) => item.text === 'המשך תקין'), 'typed text without the checkbox emoji should match the option');
    assert.strictEqual(storage.getCampaignEvents(first.id).filter((event) => event.type === 'raffle_entry').length, 1, 'valid answer should add exactly one raffle entry');

    const beforeDuplicate = transport.sent.length;
    await inbound(storage, transport, phone, 'option-shared', true);
    assert.strictEqual(transport.sent.length, beforeDuplicate, 'a rapid duplicate button reply should be ignored');
    assert.strictEqual(storage.getCampaignEvents(first.id).filter((event) => event.type === 'raffle_entry').length, 1, 'duplicate reply must not add a raffle entry');

    const truncatedTitlePhone = '972500000003';
    const longTitle = 'Long button title that Meta truncates';
    addCampaign(storage, 'Truncated Meta button title', 'join-truncated', {
      decisionFlow: [
        {
          id: 'step-truncated',
          kind: 'question',
          presentation: 'buttons',
          text: 'Pick one',
          timeoutMinutes: 30,
          options: [{ id: 'option-truncated', text: longTitle, nextStepId: 'step-truncated-next' }],
        },
        { id: 'step-truncated-next', kind: 'message', text: 'continued after truncated title' },
      ],
    });
    await inbound(storage, transport, truncatedTitlePhone, 'join-truncated');
    await inbound(storage, transport, truncatedTitlePhone, longTitle.slice(0, 20), true);
    assert.ok(transport.sent.some((item) => item.text === 'continued after truncated title'), 'Meta button title truncated to 20 chars should still match and continue');
    conversationState.remove(`whatsapp:${truncatedTitlePhone}`);

    const second = addCampaign(storage, 'Second campaign', 'join-second', {
      invalidReplyText: 'בחרו שוב',
      flowRecoveryText: 'חוזרים לתחילת הקמפיין השני',
    });
    await inbound(storage, transport, phone, 'join-second');
    const secondResults = storage.getCampaignResults(second.id);
    assert.strictEqual(secondResults.length, 1, 'second campaign should have one participant result');
    conversationState.remove(`whatsapp:${phone}`);

    const beforeRecovery = transport.sent.length;
    await inbound(storage, transport, phone, 'option-shared', true);
    const recoveryMessages = transport.sent.slice(beforeRecovery);
    assert.strictEqual(recoveryMessages[0].text, 'חוזרים לתחילת הקמפיין השני', 'recovery must use the latest campaign even when cloned option ids are shared');
    assert.strictEqual(recoveryMessages.at(-1).type, 'buttons', 'recovery should restart at the first flow question');
    assert.strictEqual(storage.getCampaignResults(second.id).length, 1, 'recovery must reuse the existing participant result');
    conversationState.remove(`whatsapp:${phone}`);

    const beforeEmptyButtonRecovery = transport.sent.length;
    await inbound(storage, transport, phone, '', true);
    const emptyButtonRecoveryMessages = transport.sent.slice(beforeEmptyButtonRecovery);
    assert.strictEqual(emptyButtonRecoveryMessages[0].text, storage.getCampaignConversationSettings(second).flowRecoveryText, 'an interactive reply without a readable body should still recover the latest flow');
    assert.strictEqual(emptyButtonRecoveryMessages.at(-1).type, 'buttons', 'empty interactive recovery should restart the first question');
    assert.strictEqual(storage.getCampaignResults(second.id).length, 1, 'empty interactive recovery must reuse the existing participant result');
    conversationState.remove(`whatsapp:${phone}`);

    const guarded = addCampaign(storage, 'Guarded campaign', 'join-guarded', {
      flowRecoveryText: 'guarded recovery',
      decisionFlow: [
        {
          id: 'step-guarded',
          kind: 'question',
          presentation: 'buttons',
          text: 'Guarded question?',
          timeoutMinutes: 30,
          options: [{ id: 'option-guarded', text: 'Continue' }],
        },
      ],
    });
    await inbound(storage, transport, phone, 'join-guarded');
    conversationState.remove(`whatsapp:${phone}`);
    const beforeForeignButton = transport.sent.length;
    await inbound(storage, transport, phone, 'option-shared', true);
    assert.strictEqual(transport.sent.length, beforeForeignButton, 'a button id from another campaign must not restart the latest campaign');
    assert.strictEqual(storage.getCampaignResults(guarded.id).length, 1, 'foreign button protection must not create another result');

    const inactive = addCampaign(storage, 'Inactive recovery fields', 'join-inactive');
    await inbound(storage, transport, phone, 'join-inactive');
    conversationState.remove(`whatsapp:${phone}`);
    const beforeInactive = transport.sent.length;
    await inbound(storage, transport, phone, 'option-shared', true);
    assert.strictEqual(transport.sent.length, beforeInactive, 'empty recovery fields must preserve legacy behavior');
    assert.strictEqual(storage.getCampaignResults(inactive.id).length, 1, 'inactive recovery must not create a new participant result');

    const legacyPhone = '972500000002';
    addCampaign(storage, 'Legacy invalid answer', 'join-legacy', {
      humanHandoffEnabled: true,
      humanHandoffText: 'legacy handoff',
    });
    await inbound(storage, transport, legacyPhone, 'join-legacy');
    const beforeLegacyInvalid = transport.sent.length;
    await inbound(storage, transport, legacyPhone, 'not-an-option');
    assert.ok(transport.sent.slice(beforeLegacyInvalid).some((item) => String(item.text || '').includes('legacy handoff')), 'an empty invalid-answer field must preserve the legacy handoff behavior');
    conversationState.remove(`whatsapp:${legacyPhone}`);

    console.log('Flow recovery tests passed.');
  } finally {
    conversationState.remove(`whatsapp:${phone}`);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});