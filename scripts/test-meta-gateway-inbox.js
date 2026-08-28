const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MetaGatewayInbox } = require('../dist/metaGatewayInbox');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-gateway-inbox-'));
const filePath = path.join(directory, 'inbox.json');

try {
  const inbox = new MetaGatewayInbox(filePath, 1_000);
  inbox.enqueue('wamid.1', { message: 1 });
  inbox.enqueue('wamid.1', { message: 'duplicate' });
  assert.equal(inbox.counts().queued, 1);
  const first = inbox.claimNext(new Date('2026-01-01T00:00:00.000Z'));
  assert.equal(first.id, 'wamid.1');
  assert.equal(first.attempts, 1);
  const afterRestart = new MetaGatewayInbox(filePath, 1_000);
  assert.equal(afterRestart.claimNext(new Date('2026-01-01T00:00:00.500Z')), null);
  const reclaimed = afterRestart.claimNext(new Date('2026-01-01T00:00:01.001Z'));
  assert.equal(reclaimed.id, 'wamid.1');
  assert.equal(reclaimed.attempts, 2);
  afterRestart.markRetry('wamid.1', new Error('temporary failure'), new Date('2026-01-01T00:01:00.000Z'));
  assert.equal(afterRestart.claimNext(new Date('2026-01-01T00:00:59.999Z')), null);
  const retry = afterRestart.claimNext(new Date('2026-01-01T00:01:00.000Z'));
  assert.equal(retry.id, 'wamid.1');
  assert.equal(retry.attempts, 3);
  afterRestart.markCompleted('wamid.1');
  assert.equal(afterRestart.counts().completed, 1);
  assert.equal(afterRestart.claimNext(), null);

  const orderedInbox = new MetaGatewayInbox(path.join(directory, 'ordered-inbox.json'));
  orderedInbox.enqueue('sender-a-1', { sender: 'a' });
  orderedInbox.enqueue('sender-a-2', { sender: 'a' });
  orderedInbox.enqueue('sender-b-1', { sender: 'b' });
  const firstBatch = orderedInbox.claimBatch(20, (item) => item.payload.sender);
  assert.deepEqual(firstBatch.map((item) => item.id), ['sender-a-1', 'sender-b-1'], 'only one message per sender may be in flight');
  orderedInbox.markRetry('sender-a-1', 'temporary', new Date(Date.now() + 60_000));
  orderedInbox.markCompleted('sender-b-1');
  assert.equal(
    orderedInbox.claimBatch(20, (item) => item.payload.sender).some((item) => item.id === 'sender-a-2'),
    false,
    'a retrying message must block later messages from the same sender',
  );

  const prunePath = path.join(directory, 'prune.json');
  const pruneInbox = new MetaGatewayInbox(prunePath);
  pruneInbox.enqueue('old-completed', {}, new Date('2026-01-01T00:00:00.000Z'));
  pruneInbox.claimNext(new Date('2026-01-01T00:00:00.000Z'));
  pruneInbox.markCompleted('old-completed', new Date('2026-01-01T00:00:01.000Z'));
  pruneInbox.enqueue('new-message', {}, new Date('2026-01-03T00:00:00.000Z'));
  assert.equal(pruneInbox.counts().completed, 0, 'old completed inbox entries should be pruned');
  console.log('Meta gateway inbox tests passed.');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
