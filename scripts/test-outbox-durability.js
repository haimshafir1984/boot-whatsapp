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
      return { messageId: 'provider-1' };
    },
    async resolvePhone(jid) { return jid; },
  };

  const timer = startOutboxDispatcher(storage, () => transport, 25);
  try {
    await waitFor(() => storage.getOutboxHealth().sent === 1);
  } finally {
    clearInterval(timer);
  }

  const messages = storage.getOutboxMessages();
  if (sent.length !== 1) throw new Error(`Expected one sent message, got ${sent.length}.`);
  if (messages[0].status !== 'sent') throw new Error(`Expected outbox status sent, got ${messages[0].status}.`);
  if (messages[0].providerMessageId !== 'provider-1') throw new Error('Provider message id was not persisted.');
  if (storage.getDurableTimerHealth().scheduled !== 1) throw new Error('Durable conversation timer snapshot was not counted.');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('Outbox durability test passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});