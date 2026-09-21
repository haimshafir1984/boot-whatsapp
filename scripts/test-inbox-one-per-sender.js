/**
 * Stage E / C2 - verifies (by execution, not by reading) the assumption the scheduler row rests on:
 * the drainer never receives more than ONE item per sender from the inbox, so per-sender order is enforced by the inbox
 * and `runGroup` always sees a group of exactly one item.
 *
 * It runs the CURRENT production class (MetaGatewayInbox) exactly the way adminServer.ts calls it
 * (claimBatch(limit, metaPayloadSenderKey) + groupMetaItemsBySender), with random enqueue / claim / complete / retry /
 * hold / fail / cancel / stale-reclaim sequences, and asserts after every claim:
 *   (1) every batch has at most one item per sender key,
 *   (2) groupMetaItemsBySender turns a batch into groups of exactly one item,
 *   (3) a sender never has two items in `processing` at once (outside a stale reclaim that first drops the old one),
 *   (4) an item is never offered while an older outstanding item of the same sender exists.
 * Pass --dist <dir> to run it against another build (e.g. the frozen base SHA).
 */
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const distArg = process.argv.indexOf('--dist');
const dist = distArg >= 0 ? path.resolve(process.argv[distArg + 1]) : path.join(__dirname, '..', 'dist');
const { MetaGatewayInbox } = require(path.join(dist, 'metaGatewayInbox'));
const { metaPayloadSenderKey, groupMetaItemsBySender } = require(path.join(dist, 'metaGatewayReliability'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-per-sender-'));
let seed = 987654321;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const payload = (id, from, pn = '1207335449126872') => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: pn }, messages: [{ id, from }] } }] }] });

let claims = 0, multi = 0;
try {
  for (const staleMs of [50, 1_000_000]) {
    const inbox = new MetaGatewayInbox(path.join(dir, `i-${staleMs}.json`), staleMs);
    const senders = ['972501000001', '972501000002', '972501000003', '972501000004'];
    let n = 0; let clock = Date.parse('2026-01-01T00:00:00Z');
    const processing = new Map();   // id -> item
    for (let step = 0; step < 600; step++) {
      const op = pick(['enq', 'enq', 'enq', 'claim', 'claim', 'complete', 'retry', 'hold', 'fail', 'time']);
      if (op === 'enq') { const id = `m${++n}`; inbox.enqueue(id, payload(id, pick(senders), pick(['1207335449126872', '999'])), new Date(clock)); }
      else if (op === 'time') clock += pick([10, 100, 5_000, 90_000]);
      else if (op === 'claim') {
        const batch = inbox.claimBatch(20, (item) => metaPayloadSenderKey(item.payload), new Date(clock));
        claims += 1;
        const keys = batch.map((item) => metaPayloadSenderKey(item.payload));
        assert.equal(new Set(keys).size, keys.length, 'one item per sender key in a claimed batch');
        for (const group of groupMetaItemsBySender(batch)) { assert.equal(group.length, 1, 'runGroup must always get exactly one item'); if (group.length > 1) multi += 1; }
        // (4) nothing older and still outstanding for the same sender may exist behind the offered item
        for (const item of batch) {
          const older = inbox.data.items.filter((x) => metaPayloadSenderKey(x.payload) === metaPayloadSenderKey(item.payload) && x.createdAt < item.createdAt && ['queued', 'retry', 'processing'].includes(x.status) && x.id !== item.id);
          assert.equal(older.length, 0, `offered ${item.id} while an older outstanding item exists: ${older.map((o) => o.id + ':' + o.status)}`);
          processing.set(item.id, item);
        }
        // (3) at most one processing item per sender after a claim (a stale reclaim re-offers the SAME item, never a second one)
        const perSender = new Map();
        for (const x of inbox.data.items.filter((y) => y.status === 'processing')) perSender.set(metaPayloadSenderKey(x.payload), (perSender.get(metaPayloadSenderKey(x.payload)) || 0) + 1);
        for (const [k, c] of perSender) assert.ok(c <= 1, `sender ${k} has ${c} processing items`);
      } else {
        const ids = [...processing.keys()]; if (!ids.length) continue;
        const id = pick(ids); processing.delete(id);
        const item = inbox.data.items.find((x) => x.id === id);
        if (!item || item.status !== 'processing') continue;
        if (op === 'complete') inbox.markCompleted(id, new Date(clock));
        else if (op === 'retry') inbox.markRetry(id, 'e', new Date(clock + pick([1_000, 60_000])), new Date(clock));
        else if (op === 'hold') inbox.markHeld(id, 'h', new Date(clock));
        else if (op === 'fail') inbox.markFailed(id, 'f', new Date(clock));
      }
    }
  }
  assert.ok(claims > 100);
  console.log(`PASS  one-item-per-sender assumption holds (${claims} claim calls, ${multi} multi-item groups) on ${dist}`);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
