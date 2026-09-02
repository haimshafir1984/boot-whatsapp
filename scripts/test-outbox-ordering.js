'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Storage } = require('../dist/storage');
const { startOutboxDispatcher } = require('../dist/outboxDispatcher');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await wait(10);
  }
  throw new Error('Timed out waiting for outbox ordering test.');
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowsbiz-outbox-order-'));
  try {
    const storage = new Storage(path.join(directory, 'storage.json'));
    const media = storage.enqueueOutboxMessage({ kind: 'file', to: 'whatsapp:+972500000201', filePath: 'slow.jpg' });
    const afterMedia = storage.enqueueOutboxMessage({ kind: 'text', to: '972500000201@c.us', text: 'after media' });
    const otherRecipient = storage.enqueueOutboxMessage({ kind: 'text', to: '972500000202', text: 'parallel user' });

    const initial = storage.getPendingOutboxMessages(20);
    assert.deepEqual(initial.map((item) => item.id), [media.id, otherRecipient.id], 'only the head message per recipient may be dispatchable');
    assert.equal(storage.claimOutboxMessage(afterMedia.id), null, 'a later message must not bypass earlier media');

    const events = [];
    const transport = {
      async sendFile(to) {
        events.push(`file-start:${to}`);
        await wait(150);
        events.push(`file-end:${to}`);
        return { messageId: 'media-id' };
      },
      async sendMessage(to, text) {
        events.push(`text:${to}:${text}`);
        return { messageId: `text-${events.length}` };
      },
      async resolvePhone(jid) { return jid; },
    };

    const timer = startOutboxDispatcher(storage, () => transport, 5);
    try {
      await waitFor(() => storage.getOutboxHealth().sent === 3);
    } finally {
      await timer.stop();
    }

    const fileEnd = events.findIndex((event) => event.startsWith('file-end:'));
    const sameRecipientText = events.findIndex((event) => event.includes('after media'));
    const parallelText = events.findIndex((event) => event.includes('parallel user'));
    assert.ok(fileEnd >= 0 && sameRecipientText > fileEnd, 'text for the same recipient must wait for slow media completion');
    assert.ok(parallelText > 0 && parallelText < fileEnd, 'a different recipient should proceed while media is uploading');

    const blockedStorage = new Storage(path.join(directory, 'blocked.json'));
    const retrying = blockedStorage.enqueueOutboxMessage({ kind: 'file', to: '972500000203', filePath: 'retry.jpg' });
    const blockedText = blockedStorage.enqueueOutboxMessage({ kind: 'text', to: '972500000203', text: 'blocked' });
    blockedStorage.markOutboxRetry(retrying.id, 'temporary failure', new Date(Date.now() + 60_000).toISOString());
    assert.equal(blockedStorage.getPendingOutboxMessages(20).some((item) => item.id === blockedText.id), false, 'a scheduled media retry must block later text');
    assert.equal(blockedStorage.claimOutboxMessage(blockedText.id), null, 'direct claims must also respect recipient order');

    console.log('Outbox per-recipient ordering tests passed.');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
