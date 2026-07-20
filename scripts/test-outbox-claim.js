const fs = require('fs');
const os = require('os');
const path = require('path');
const { Storage } = require('../dist/storage');
const { startOutboxDispatcher } = require('../dist/outboxDispatcher');

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition.');
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowsbiz-outbox-claim-'));
  const storage = new Storage(path.join(dir, 'storage.json'));

  const first = storage.enqueueOutboxMessage({
    kind: 'text',
    to: '972501234567',
    text: 'hello',
    idempotencyKey: 'test:first',
  });
  const duplicate = storage.enqueueOutboxMessage({
    kind: 'text',
    to: '972501234567',
    text: 'hello',
    idempotencyKey: 'test:first',
  });
  if (duplicate.id !== first.id) throw new Error('Idempotency key created a duplicate outbox row.');

  const locked = storage.enqueueOutboxMessage({ kind: 'text', to: '972509999999', text: 'locked' });
  if (!storage.claimOutboxMessage(locked.id)) throw new Error('Could not claim locked test message.');

  const sent = [];
  const transport = {
    async sendMessage(to, text) {
      sent.push({ to, text });
      return { messageId: `provider-${sent.length}` };
    },
    async resolvePhone(jid) { return jid; },
  };

  const timer = startOutboxDispatcher(storage, () => transport, 25);
  try {
    await waitFor(() => storage.getOutboxHealth().sent === 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (sent.length !== 1) throw new Error('Fresh processing message was sent concurrently by dispatcher.');

    storage.markOutboxRetry(locked.id, 'planned retry', new Date(Date.now() - 1000).toISOString());
    await waitFor(() => storage.getOutboxHealth().sent === 2);
  } finally {
    clearInterval(timer);
  }

  const messages = storage.getOutboxMessages();
  if (messages.filter((message) => message.status === 'sent').length !== 2) {
    throw new Error('Expected both distinct outbox messages to be sent.');
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('Outbox claim and idempotency test passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

