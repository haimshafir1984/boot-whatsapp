/**
 * Stage B2 / step 3 (fix from step 2): the early-status buffer used to live in memory only, so a restart lost the
 * evidence. It is now journaled. Also: a status that cannot be journaled is NOT acknowledged (the call throws).
 */
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../dist/storage');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'early-'));
const mk = (n) => new Storage(path.join(root, n + '.json'));
const results = [];
function scenario(name, fn) { try { fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 3).join(' | ')]); } }
const early = (id, extra = {}) => ({ wamid: id, status: 'delivered', recipientId: '972590000001', ...extra });
function recordId(s, to, wamid) { const m = s.enqueueOutboxMessage({ kind: 'text', to, text: 'x' }); s.claimOutboxMessage(m.id); s.markOutboxSent(m.id, wamid); return m.id; }

scenario('a buffered early status survives a restart and is applied when the id is recorded', () => {
  const j = path.join(root, 'j1.jsonl'); const a = mk('a1'); a.attachEarlyStatusJournal(j);
  assert.equal(a.applyMetaStatus(early('wamid.E1')).result, 'buffered');
  const b = mk('b1'); b.attachEarlyStatusJournal(j);   // "restart"
  const id = recordId(b, '972590000001', 'wamid.E1');
  assert.equal(b.getOutboxMessage(id).deliveryStatus, 'delivered');
});
scenario('once applied it is not applied again after another restart (done record); later ones still are', () => {
  const j = path.join(root, 'j2.jsonl'); const a = mk('a2'); a.attachEarlyStatusJournal(j);
  a.applyMetaStatus(early('wamid.E2')); a.applyMetaStatus(early('wamid.E3', { recipientId: '972590000002' }));
  recordId(a, '972590000001', 'wamid.E2');
  const b = mk('b2'); b.attachEarlyStatusJournal(j);
  const id2 = recordId(b, '972590000001', 'wamid.E2'); const id3 = recordId(b, '972590000002', 'wamid.E3');
  assert.equal(b.getOutboxMessage(id2).deliveryStatus, undefined, 'E2 was already consumed before the restart');
  assert.equal(b.getOutboxMessage(id3).deliveryStatus, 'delivered', 'E3 was still waiting and survived');
});
scenario('a journal write failure is NOT swallowed: applyMetaStatus throws, so the caller must not acknowledge the status', () => {
  const j = path.join(root, 'j3.jsonl'); const a = mk('a3'); a.attachEarlyStatusJournal(j);
  fs.rmSync(j); fs.mkdirSync(j);   // the journal path becomes unwritable
  assert.throws(() => a.applyMetaStatus(early('wamid.E4')));
});
scenario('torn last line is discarded, a corrupt line elsewhere REFUSES to load (never "empty")', () => {
  const j = path.join(root, 'j4.jsonl'); const a = mk('a4'); a.attachEarlyStatusJournal(j); a.applyMetaStatus(early('wamid.E5'));
  fs.appendFileSync(j, '{"t":"buf","input":{"wamid":"wamid.TORN');
  const b = mk('b4'); b.attachEarlyStatusJournal(j);
  assert.equal(recordId(b, '972590000001', 'wamid.E5') && b.getOutboxMessages(5).find((r) => r.providerMessageId === 'wamid.E5').deliveryStatus, 'delivered');
  const lines = fs.readFileSync(j, 'utf8').split('\n'); lines.splice(0, 0, 'not json at all'); fs.writeFileSync(j, lines.join('\n'));
  assert.throws(() => mk('c4').attachEarlyStatusJournal(j), /corrupt/);
});
scenario('entries older than the retention window are dropped on load (bounded)', () => {
  const j = path.join(root, 'j5.jsonl');
  fs.writeFileSync(j, JSON.stringify({ t: 'buf', input: early('wamid.OLD'), at: Date.now() - 60 * 60 * 1000 }) + '\n');
  const b = mk('b5'); b.attachEarlyStatusJournal(j);
  const id = recordId(b, '972590000001', 'wamid.OLD');
  assert.equal(b.getOutboxMessage(id).deliveryStatus, undefined);
});

let failed = 0;
for (const r of results) { if (r[1] === 'FAIL') failed++; console.log(r[1] + '  ' + r[0]); if (r[2]) console.log('      ' + r[2]); }
console.log('early-status-journal: ' + (results.length - failed) + ' passed, ' + failed + ' failed');
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
