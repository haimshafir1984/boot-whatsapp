'use strict';

/**
 * Measures, not guesses: the real cost of MetaGatewayInbox.persist() (the
 * fs.writeFileSync + fs.copyFileSync + fs.renameSync sequence) and
 * claimBatch()'s sort, at the CURRENT retention (5,000 completed items /
 * 24h) vs the PROPOSED retention (300 items / 2h) - using the real class
 * (src/metaGatewayInbox.ts, compiled), a realistic Meta webhook payload
 * shape/size, and a real temp file on disk (not an in-memory mock), so the
 * actual OS-level write cost is captured, not just JS overhead.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MetaGatewayInbox } = require('../dist/metaGatewayInbox');

// Approximates a real Meta webhook message payload (entry/changes/value/messages
// nesting, plus a text body) - matches the shape seen in real production logs.
function fakePayload(id) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: '123456789012345',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '972500000000', phone_number_id: '111111111111111' },
          contacts: [{ profile: { name: 'Test Participant Name' }, wa_id: '972500000000' }],
          messages: [{
            from: '972500000000',
            id,
            timestamp: String(Math.floor(Date.now() / 1000)),
            text: { body: 'גם אני רוצה להשתתף בפעילות הגדולה והטעימה של קרמוסו הגעתי דרך הסטטוס של A8664' },
            type: 'text',
          }],
        },
        field: 'messages',
      }],
    }],
  };
}

function buildInbox(filePath, completedCount) {
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1,
    items: Array.from({ length: completedCount }, (_, i) => ({
      id: `wamid.seed-${i}`,
      payload: fakePayload(`wamid.seed-${i}`),
      status: 'completed',
      attempts: 1,
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
      updatedAt: new Date(Date.now() - i * 1000).toISOString(),
    })),
  }));
  return new MetaGatewayInbox(filePath);
}

function measure(label, completedCount, activeOps) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-bench-'));
  const filePath = path.join(dir, 'inbox.json');
  const inbox = buildInbox(filePath, completedCount);
  const fileSizeKb = (fs.statSync(filePath).size / 1024).toFixed(1);

  // enqueue() cost - one new item, triggers pruneCompleted() + persist().
  const enqueueTimes = [];
  for (let i = 0; i < activeOps; i += 1) {
    const t0 = Date.now();
    inbox.enqueue(`wamid.new-${label}-${i}`, fakePayload(`wamid.new-${label}-${i}`));
    enqueueTimes.push(Date.now() - t0);
  }

  // claimBatch() cost - sorts the ENTIRE items array (including all completed
  // ones still retained) on every call, exactly as the real gateway/client
  // inbox loop does on every polling tick.
  const claimTimes = [];
  for (let i = 0; i < 20; i += 1) {
    const t0 = Date.now();
    inbox.claimBatch(20, (item) => item.id);
    claimTimes.push(Date.now() - t0);
  }

  // markCompleted() cost - another full persist() per item.
  const markTimes = [];
  const toMark = Array.from({ length: activeOps }, (_, i) => `wamid.new-${label}-${i}`);
  for (const id of toMark) {
    const t0 = Date.now();
    inbox.markCompleted(id);
    markTimes.push(Date.now() - t0);
  }

  fs.rmSync(dir, { recursive: true, force: true });

  const sum = (arr) => arr.reduce((a, b) => a + b, 0);
  const avg = (arr) => (arr.length ? sum(arr) / arr.length : 0);
  console.log(`\n=== ${label}: ${completedCount} retained completed items, file size ~${fileSizeKb} KB ===`);
  console.log(`enqueue():      avg=${avg(enqueueTimes).toFixed(2)}ms  total for ${activeOps} calls=${sum(enqueueTimes)}ms`);
  console.log(`claimBatch():   avg=${avg(claimTimes).toFixed(2)}ms  total for 20 calls=${sum(claimTimes)}ms`);
  console.log(`markCompleted():avg=${avg(markTimes).toFixed(2)}ms  total for ${activeOps} calls=${sum(markTimes)}ms`);
  const totalBlockingMs = sum(enqueueTimes) + sum(claimTimes) + sum(markTimes);
  console.log(`TOTAL synchronous blocking time for this simulated burst: ${totalBlockingMs}ms`);
  return totalBlockingMs;
}

const ACTIVE_OPS = 100; // simulates 100 messages moving through enqueue -> claim -> complete

const before = measure('CURRENT (5,000 item retention)', 5000, ACTIVE_OPS);
const after = measure('PROPOSED (300 item retention)', 300, ACTIVE_OPS);

console.log(`\n=== Summary ===`);
console.log(`Simulated burst: ${ACTIVE_OPS} messages through enqueue -> claimBatch(x20) -> markCompleted, against an inbox that already has completed-item history retained.`);
console.log(`Current retention (5,000):  ${before}ms total blocking time`);
console.log(`Proposed retention (300):   ${after}ms total blocking time`);
console.log(`Reduction: ${(before - after)}ms (${(100 * (before - after) / before).toFixed(1)}%)`);
