'use strict';
/**
 * Micro-benchmark of the per-message / per-tap lookups that the returning-buttons work adds to the hot path, on synthetic history sizes.
 * Local only. Prints median / p95 / p99 in microseconds per call. Run before and after a change to see the cost.
 *
 *   node scripts/bench-returning-buttons-hotpath.js [--results 20000 --events 100000 --outbox 50000 --calls 3000]
 */
process.env.NODE_ENV = 'test';
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const num = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? Number(argv[i + 1]) : d; };
const RESULTS = num('results', 700); const EVENTS = num('events', 15000); const OUTBOX = num('outbox', 8000); const CALLS = num('calls', 2000);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-rb-'));
process.env.STORAGE_PATH = path.join(dir, 'storage.json');
process.env.SESSION_PATH = path.join(dir, 'session');
const { Storage } = require('../dist/storage');
const messageFlow = require('../dist/messageFlow');

const storage = new Storage(process.env.STORAGE_PATH);
const flow = [
  { id: 's1', kind: 'question', presentation: 'buttons', text: 'Q1', options: [{ id: 'o1', text: 'a', nextStepId: 's2', repeatable: true }] },
  { id: 's2', kind: 'message', text: 'M' },
];
const campaign = storage.addCampaign({ name: 'bench', triggerType: 1, triggerPhrase: 'bench', suffix: '', active: true,
  conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], decisionFlow: flow } });
const plain = storage.addCampaign({ name: 'bench-plain', triggerType: 1, triggerPhrase: 'bench2', suffix: '', active: true,
  conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], decisionFlow: [{ id: 'p1', kind: 'message', text: 'M' }] } });

const now = Date.now();
const iso = (t) => new Date(t).toISOString();
const phones = [];
for (let i = 0; i < RESULTS; i += 1) {
  const phone = `97250${String(1000000 + i)}`; phones.push(phone);
  const c = i % 2 ? campaign : plain;
  storage.data.campaignResults.push({ id: `r${i}`, campaignId: c.id, phone, status: 'saved', triggeredAt: iso(now - (i % 5000) * 1000), updatedAt: iso(now - (i % 5000) * 1000), lastEventAt: iso(now - (i % 5000) * 1000), resultBatchId: 'b1' });
}
for (let i = 0; i < EVENTS; i += 1) {
  const r = storage.data.campaignResults[i % RESULTS];
  storage.data.campaignEvents.push({ id: `e${i}`, campaignId: r.campaignId, campaignResultId: r.id, phone: r.phone, type: 'step_sent', dedupeKey: `k${i}`, createdAt: iso(now - i * 100), resultBatchId: 'b1' });
}
for (let i = 0; i < OUTBOX; i += 1) {
  const r = storage.data.campaignResults[i % RESULTS];
  storage.data.outboxMessages.push({ id: `m${i}`, kind: 'text', to: `whatsapp:${r.phone}`, text: 'x', campaignId: r.campaignId, campaignResultId: r.id, stepId: 's1', status: 'sent', attempts: 1, createdAt: iso(now - i * 100), updatedAt: iso(now - i * 100), providerMessageId: `wamid.${i}`, attemptLog: [{ attemptId: `a${i}`, startedAt: iso(now), status: 'accepted', providerMessageId: `wamid.${i}` }] });
}
if (typeof storage.rebuildReturningButtonIndexes === 'function') storage.rebuildReturningButtonIndexes();

function bench(label, fn) {
  const t = [];
  for (let i = 0; i < 50; i += 1) fn(i);   // warm up
  for (let i = 0; i < CALLS; i += 1) { const s = process.hrtime.bigint(); fn(i); t.push(Number(process.hrtime.bigint() - s) / 1000); }
  t.sort((a, b) => a - b);
  const q = (p) => t[Math.min(t.length - 1, Math.floor(t.length * p))];
  console.log(`${label.padEnd(58)} p50 ${q(0.5).toFixed(1).padStart(9)}us  p95 ${q(0.95).toFixed(1).padStart(9)}us  p99 ${q(0.99).toFixed(1).padStart(9)}us`);
}

console.log(`history: ${RESULTS} results, ${EVENTS} events, ${OUTBOX} outbox rows, ${CALLS} calls each`);
const hitIdx = (i) => (i * 7919) % OUTBOX;
bench('outboxMessageBelongsToStep (hit)', (i) => { const k = hitIdx(i); storage.outboxMessageBelongsToStep(`wamid.${k}`, { campaignResultId: `r${k % RESULTS}`, stepId: 's1' }); });
bench('outboxMessageBelongsToStep (miss)', (i) => { storage.outboxMessageBelongsToStep(`wamid.nope${i}`, { campaignResultId: 'r1', stepId: 's1' }); });
// phones whose last activity is inside the 10 minute window (the expensive branch): the 600 most recent results
const activePhone = (i) => phones[i % Math.min(600, RESULTS)];
bench('repeatableWindowCampaignId (sender active in window)', (i) => { messageFlow.repeatableWindowCampaignId(storage, activePhone(i)); });
bench('repeatableWindowCampaignId (sender not seen)', (i) => { messageFlow.repeatableWindowCampaignId(storage, `97299${String(i).padStart(7, '0')}`); });
bench('getCampaignEvents(campaign) (copy+sort, for reference)', () => { storage.getCampaignEvents(campaign.id); });
fs.rmSync(dir, { recursive: true, force: true });
setTimeout(() => process.exit(0), 100);
