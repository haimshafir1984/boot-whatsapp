const fs = require('fs');
const os = require('os');
const path = require('path');
const { Storage } = require('../dist/storage');
const { startOutboxDispatcher } = require('../dist/outboxDispatcher');

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for condition.');
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowsbiz-outbox-'));
  const storage = new Storage(path.join(dir, 'storage.json'));

  storage.enqueueOutboxMessage({ kind: 'text', to: '972501234567', text: 'hello' });
  storage.enqueueOutboxMessage({
    kind: 'interactive_buttons',
    to: '972501234567',
    text: 'choose',
    buttons: [{ id: 'option-1', text: 'one' }],
    campaignId: 'campaign-1',
    campaignResultId: 'result-1',
    stepId: 'step-1',
  });
  storage.enqueueOutboxMessage({
    kind: 'interactive_list',
    to: '972501234567',
    text: 'choose list',
    buttonText: 'open',
    items: [{ id: 'option-2', text: 'two' }],
    campaignId: 'campaign-1',
    campaignResultId: 'result-1',
    stepId: 'step-2',
  });
  storage.enqueueOutboxMessage({
    kind: 'contacts',
    to: '972501234567',
    contacts: [{ vcard: 'BEGIN:VCARD\nFN:Test\nEND:VCARD', displayName: 'Test' }],
    displayName: 'Test',
    campaignId: 'campaign-1',
    campaignResultId: 'result-1',
    stepId: 'contact-card',
  });
  storage.enqueueOutboxMessage({
    kind: 'template',
    to: '972509999999',
    templateName: 'join_request',
    templateLanguageCode: 'he',
    templateBodyParameters: ['972501234567', 'Campaign'],
    campaignId: 'campaign-1',
    campaignResultId: 'result-1',
    stepId: 'step-join',
  });
  storage.saveConversationStateSnapshot({
    version: 1,
    savedAt: new Date().toISOString(),
    conversations: {
      '972501234567@c.us': {
        kind: 'decision',
        senderJid: '972501234567@c.us',
        senderPhone: '972501234567',
        flow: [],
        stepId: 'step-1',
        timestamp: Date.now(),
      },
    },
  });

  const sent = [];
  const transport = {
    async sendMessage(to, text) {
      sent.push({ to, text });
      return { messageId: `provider-${sent.length}` };
    },
    async sendInteractiveButtons(to, text, buttons) {
      sent.push({ type: 'buttons', to, text, buttons });
      return { messageId: `provider-${sent.length}` };
    },
    async sendInteractiveList(to, text, buttonText, items) {
      sent.push({ type: 'list', to, text, buttonText, items });
      return { messageId: `provider-${sent.length}` };
    },
    async sendContactCards(to, contacts, displayName) {
      sent.push({ type: 'contacts', to, contacts, displayName });
      return { messageId: `provider-${sent.length}` };
    },
    async sendTemplateMessage(to, templateName, languageCode, bodyParameters) {
      sent.push({ type: 'template', to, templateName, languageCode, bodyParameters });
      return { messageId: `provider-${sent.length}` };
    },
    async resolvePhone(jid) { return jid; },
  };

  const timer = startOutboxDispatcher(storage, () => transport, 25);
  try {
    await waitFor(() => storage.getOutboxHealth().sent === 5);
  } finally {
    await timer.stop();
  }

  const messages = storage.getOutboxMessages();
  if (sent.length !== 5) throw new Error(`Expected five sent messages, got ${sent.length}.`);
  if (messages.some((message) => message.status !== 'sent')) throw new Error('Every outbox message should be sent.');
  if (messages.some((message) => !message.providerMessageId)) throw new Error('Every provider message id should be persisted.');
  const buttonsMessage = messages.find((message) => message.kind === 'interactive_buttons');
  if (buttonsMessage?.campaignId !== 'campaign-1' || buttonsMessage.stepId !== 'step-1') {
    throw new Error('Interactive outbox campaign context was not persisted.');
  }
  if (!messages.some((message) => message.kind === 'contacts') || !messages.some((message) => message.kind === 'template')) {
    throw new Error('Contact-card and template outbox messages were not dispatched.');
  }
  if (storage.getDurableTimerHealth().scheduled !== 1) throw new Error('Durable conversation timer snapshot was not counted.');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('Outbox durability test passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
