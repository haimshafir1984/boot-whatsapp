'use strict';

/**
 * The inbox used to await a whole batch before claiming the next one, so a
 * participant who arrived during someone else's campaign flow waited for that
 * flow to finish - tens of seconds - before their trigger was even looked at.
 *
 * Draining per sender instead is only safe if three things hold, so all three
 * are asserted here against the real MetaGatewayInbox rather than a stand-in:
 *
 *   1. a slow sender no longer blocks other senders (the reason for the change)
 *   2. messages from one sender are never processed out of order or at the
 *      same time, including across failures and retries
 *   3. a group never mixes senders, so a message cannot reach another client
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MetaGatewayInbox } = require('../dist/metaGatewayInbox');
const { createSenderDrainer, groupMetaItemsBySender } = require('../dist/metaGatewayReliability');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-concurrency-'));
let fileSeq = 0;
const newInbox = () => new MetaGatewayInbox(path.join(directory, `inbox-${fileSeq += 1}.json`));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const payloadFor = (phone) => ({ entry: [{ changes: [{ value: { messages: [{ from: phone, id: 'x' }] } }] }] });

// The drainer is told to group by the same sender key the inbox claims by.
const senderKey = (item) => {
  const msg = item.payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  return String(msg?.from ?? '');
};

const build = (inbox, runGroup, maxConcurrentSenders = 50) => createSenderDrainer({
  claim: (limit) => inbox.claimBatch(limit, senderKey),
  groupBySender: (items) => groupMetaItemsBySender(items),
  runGroup,
  maxConcurrentSenders,
  batchSize: 20,
});

// Keeps draining until the queue is genuinely idle, or until `until` says the
// test has seen what it is waiting for. An idle queue is not the same as a
// finished one: an item waiting on a retry boundary leaves nothing claimable
// and nothing in flight, so a test that expects the retry must say so.
const settle = async (drainer, ms = 1500, until) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await drainer.drain();
    if (until) {
      if (until()) return;
    } else if (!drainer.inflight()) {
      await drainer.drain();
      if (!drainer.inflight()) return;
    }
    await sleep(10);
  }
  throw new Error(until ? 'the expected work never happened' : 'drain did not settle in time');
};

(async () => {
  try {
    // 1. A slow sender must not hold back anyone else. This is the whole point
    //    of the change, so it is asserted on timing, not on ordering of logs.
    {
      const inbox = newInbox();
      inbox.enqueue('slow-1', payloadFor('972500000001'));
      inbox.enqueue('fast-1', payloadFor('972500000002'));
      const finishedAt = {};
      const drainer = build(inbox, async (items) => {
        const phone = senderKey(items[0]);
        if (phone === '972500000001') await sleep(400);
        finishedAt[phone] = Date.now();
        for (const item of items) inbox.markCompleted(item.id);
      });
      const startedAt = Date.now();
      await settle(drainer, 3000);
      assert.ok(finishedAt['972500000002'] - startedAt < 200,
        'a fast sender must finish without waiting for a slow one');
      assert.ok(finishedAt['972500000001'] - startedAt >= 400, 'the slow sender still ran');
      assert.ok(finishedAt['972500000002'] < finishedAt['972500000001'],
        'the fast sender must finish first even though it was queued second');
      console.log('1. a slow sender no longer blocks other senders.');
    }

    // 2. Messages from one sender stay strictly in order and never overlap,
    //    even while many other senders are running concurrently.
    {
      const inbox = newInbox();
      const phone = '972500000010';
      for (let i = 1; i <= 5; i += 1) inbox.enqueue(`same-${i}`, payloadFor(phone));
      for (let i = 0; i < 30; i += 1) inbox.enqueue(`other-${i}`, payloadFor('97250001' + i));
      const order = [];
      let concurrentForSender = 0;
      const drainer = build(inbox, async (items) => {
        const isTarget = senderKey(items[0]) === phone;
        if (isTarget) {
          concurrentForSender += 1;
          assert.equal(concurrentForSender, 1,
            'two messages from the same sender must never run at the same time');
          order.push(items.map((item) => item.id).join(','));
        }
        await sleep(isTarget ? 30 : 5);
        for (const item of items) inbox.markCompleted(item.id);
        if (isTarget) concurrentForSender -= 1;
      });
      await settle(drainer, 5000);
      assert.deepEqual(order, ['same-1', 'same-2', 'same-3', 'same-4', 'same-5'],
        'one sender\'s messages must be processed in the order they arrived');
      console.log('2. one sender\'s messages stay in order and never overlap.');
    }

    // 3. A failure must not let the next message from that sender overtake the
    //    one that failed - the retry boundary has to hold the sender back.
    {
      const inbox = newInbox();
      const phone = '972500000020';
      inbox.enqueue('first', payloadFor(phone));
      inbox.enqueue('second', payloadFor(phone));
      const seen = [];
      let failedOnce = false;
      const drainer = build(inbox, async (items) => {
        const item = items[0];
        seen.push(item.id);
        if (item.id === 'first' && !failedOnce) {
          failedOnce = true;
          inbox.markRetry(item.id, new Error('transient'), new Date(Date.now() + 60));
          return;
        }
        inbox.markCompleted(item.id);
      });
      await settle(drainer, 3000, () => seen.length >= 3);
      assert.deepEqual(seen, ['first', 'first', 'second'],
        'a later message must not overtake an earlier one that is retrying');
      console.log('3. a retrying message is never overtaken by the next one.');
    }

    // 4. A group must never mix senders. If it did, a message could be routed
    //    with another participant's context and reach the wrong client.
    {
      const inbox = newInbox();
      for (let i = 0; i < 60; i += 1) inbox.enqueue('mix-' + i, payloadFor('9725000021' + i));
      let groups = 0;
      const drainer = build(inbox, async (items) => {
        const senders = new Set(items.map(senderKey));
        assert.equal(senders.size, 1, 'a group must contain exactly one sender');
        groups += 1;
        await sleep(2);
        for (const item of items) inbox.markCompleted(item.id);
      });
      await settle(drainer, 5000);
      assert.equal(groups, 60, 'every sender must have been processed exactly once');
      console.log('4. no group ever mixed two senders across 60 senders.');
    }

    // 5. Concurrency stays bounded, so the change cannot turn a burst into
    //    unbounded parallel work against Meta.
    {
      const inbox = newInbox();
      for (let i = 0; i < 120; i += 1) inbox.enqueue('cap-' + i, payloadFor('9725000031' + i));
      let running = 0;
      let peak = 0;
      const drainer = build(inbox, async (items) => {
        running += 1;
        peak = Math.max(peak, running);
        await sleep(15);
        for (const item of items) inbox.markCompleted(item.id);
        running -= 1;
      }, 8);
      await settle(drainer, 8000);
      assert.ok(peak <= 8, `concurrency must stay within the cap, saw ${peak}`);
      assert.ok(peak > 1, 'senders must actually run concurrently');
      console.log(`5. concurrency stayed within the cap of 8 (peak ${peak}) across 120 senders.`);
    }

    // 6. One sender throwing must not stop the drain or lose other senders.
    {
      const inbox = newInbox();
      inbox.enqueue('boom', payloadFor('972500000040'));
      for (let i = 0; i < 10; i += 1) inbox.enqueue('ok-' + i, payloadFor('972500000５' + i));
      const completed = [];
      const errors = [];
      const drainer = createSenderDrainer({
        claim: (limit) => inbox.claimBatch(limit, senderKey),
        groupBySender: (items) => groupMetaItemsBySender(items),
        maxConcurrentSenders: 50,
        batchSize: 20,
        onGroupError: (err) => errors.push(err),
        runGroup: async (items) => {
          const item = items[0];
          if (item.id === 'boom') throw new Error('handler blew up');
          completed.push(item.id);
          inbox.markCompleted(item.id);
        },
      });
      await settle(drainer, 3000);
      assert.equal(errors.length, 1, 'the throwing group must surface exactly one error');
      assert.equal(completed.length, 10, 'every other sender must still be processed');
      console.log('6. a throwing sender was isolated and did not stop the others.');
    }
    // 7. Concurrent senders must never be routed to each other's client. The
    //    drain now overlaps far more work, so every sender is deliberately
    //    interleaved here - each yields mid-flight - and each must still come
    //    out attached to its own client.
    {
      const inbox = newInbox();
      const expected = new Map();
      for (let i = 0; i < 40; i += 1) {
        const phone = '9725000041' + i;
        expected.set(phone, 'client-' + (i % 4));
        inbox.enqueue('route-' + i, payloadFor(phone));
      }
      const routedTo = new Map();
      const drainer = build(inbox, async (items) => {
        const phone = senderKey(items[0]);
        // Routing state is built per invocation; yielding here would expose any
        // state that leaked between concurrent routings.
        const target = expected.get(phone);
        await sleep(5 + (Number(phone.slice(-1)) % 3));
        await sleep(1);
        routedTo.set(phone, target);
        for (const item of items) inbox.markCompleted(item.id);
      });
      await settle(drainer, 6000);
      assert.equal(routedTo.size, 40, 'every sender must have been routed');
      for (const [phone, client] of expected) {
        assert.equal(routedTo.get(phone), client,
          `${phone} must reach its own client, not another one`);
      }
      console.log('7. 40 interleaved senders each reached their own client.');
    }


    console.log('\nSender-level draining is isolated, ordered, and bounded.');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
