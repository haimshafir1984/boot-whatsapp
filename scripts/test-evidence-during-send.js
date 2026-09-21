/**
 * Delivery evidence that arrives while the POST is still in the air (row `processing`) used to be thrown away: the POST then
 * timed out, the row became uncertain -> retry, and the message was sent AGAIN although the provider had confirmed it.
 * The evidence is now kept on the attempt record and consulted where the outcome is decided. The row is NOT marked sent
 * while the POST is in the air (that would race with the POST's own outcome).
 */
process.env.NODE_ENV = 'test';
process.env.OUTBOX_RECOVERY_WINDOW_MS = '1000';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage, recoveryWindowMs } = require('../dist/storage');
const { startOutboxDispatcher } = require('../dist/outboxDispatcher');

const dirs = [];
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'evsend-')); dirs.push(d); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, label) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return; await sleep(15); } throw new Error(`timed out (${ms}ms): ${label}`); }
const results = [];
async function scenario(name, fn) { try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 3).join(' | ')]); } }
const timeoutError = () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; return e; };
const afterWindow = () => new Date(Date.now() + recoveryWindowMs() + 50);
const fresh = () => new Storage(path.join(mk(), 's.json'));
const TO = '972505000001';
let n = 0;
const status = (s, row, st, tagged = true) => s.applyMetaStatus({ wamid: `wamid.EV${++n}`, status: st, recipientId: TO, ...(tagged ? { attemptId: row.attemptId } : {}) });

(async () => {
  for (const tagging of ['on', 'off']) {
    process.env.META_ATTEMPT_CALLBACK_DATA = tagging;
    const tagged = tagging === 'on';

    if (tagged) {
      await scenario(`[tagging ${tagging}] THE BUG: delivery callback while the POST is in the air, then the POST times out => NOT sent again, ends sent`, async () => {
        const s = fresh();
        const m = s.enqueueOutboxMessage({ kind: 'text', to: TO, text: 'x' });
        const claimed = s.claimOutboxMessage(m.id);
        const r = status(s, claimed, 'delivered');
        assert.equal(r.result, 'applied', 'the evidence is matched to the attempt (and kept)');
        assert.equal(s.getOutboxMessage(m.id).status, 'processing', 'the row is NOT marked sent while the POST is in the air (no race)');
        assert.equal(s.getOutboxMessage(m.id).attemptLog[0].deliveryStatus, 'delivered', 'the evidence is on the attempt record');
        assert.equal(s.markOutboxUncertain(m.id, timeoutError()), true, 'the outcome decision took the evidence into account');
        const row = s.getOutboxMessage(m.id);
        assert.equal(row.status, 'sent'); assert.equal(row.attemptLog.length, 1); assert.equal(row.attemptLog[0].status, 'accepted');
        assert.deepEqual(s.advanceUncertainRecovery(afterWindow()), [], 'no retry is ever granted');
        assert.equal(s.getOutboxMessage(m.id).status, 'sent');
        assert.equal(s.getOutboxMessage(m.id).deliveryStatus, 'delivered');
      });

      await scenario(`[tagging ${tagging}] through the REAL dispatcher: callback arrives mid-POST, the POST times out => exactly one POST, message sent, no uncertain alert state`, async () => {
        const s = fresh();
        const m = s.enqueueOutboxMessage({ kind: 'text', to: TO, text: 'via dispatcher' });
        let posts = 0;
        const transport = { async resolvePhone(j) { return j; }, async sendMessage() { posts++; const row = s.getOutboxMessage(m.id); status(s, row, 'delivered'); await sleep(20); throw timeoutError(); } };
        const d = startOutboxDispatcher(s, () => transport, 100);
        try {
          await waitFor(() => s.getOutboxMessage(m.id).status === 'sent', 5000, 'settled as sent');
          await sleep(recoveryWindowMs() + 800);
          assert.equal(posts, 1, 'never POSTed again'); assert.equal(s.getOutboxMessage(m.id).status, 'sent');
          assert.equal(s.getOutboxMessage(m.id).recovery, undefined, 'it never entered recovery');
        } finally { await d.stop(); }
      });

      await scenario(`[tagging ${tagging}] evidence during the POST, then a transient rejection => sent, not retried`, async () => {
        const s = fresh();
        const m = s.enqueueOutboxMessage({ kind: 'text', to: TO, text: 'x' });
        const claimed = s.claimOutboxMessage(m.id);
        status(s, claimed, 'sent');
        s.markOutboxRetry(m.id, new Error('502 after accept'));
        assert.equal(s.getOutboxMessage(m.id).status, 'sent');
      });

      await scenario(`[tagging ${tagging}] evidence that says FAILED during the POST changes nothing: the POST outcome decides (uncertain stays uncertain)`, async () => {
        const s = fresh();
        const m = s.enqueueOutboxMessage({ kind: 'text', to: TO, text: 'x' });
        const claimed = s.claimOutboxMessage(m.id);
        status(s, claimed, 'failed');
        assert.equal(s.getOutboxMessage(m.id).status, 'processing');
        assert.equal(s.markOutboxUncertain(m.id, timeoutError()), false);
        assert.equal(s.getOutboxMessage(m.id).status, 'uncertain');
      });

      await scenario(`[tagging ${tagging}] legacy row: uncertain with a confirmed attempt (written by the buggy version) is settled as sent at the retry decision, not retried`, async () => {
        const s = fresh();
        const m = s.enqueueOutboxMessage({ kind: 'text', to: TO, text: 'x' });
        s.claimOutboxMessage(m.id); s.markOutboxUncertain(m.id, timeoutError());
        const internal = s.data.outboxMessages.find((x) => x.id === m.id);
        internal.attemptLog[0].deliveryStatus = 'delivered'; internal.attemptLog[0].providerMessageId = 'wamid.LEGACY';
        assert.deepEqual(s.advanceUncertainRecovery(afterWindow()), [{ id: m.id, to: 'sent' }]);
        assert.equal(s.getOutboxMessage(m.id).providerMessageId, 'wamid.LEGACY');
      });
    }

    await scenario(`[tagging ${tagging}] callback that arrives AFTER the send closed: behaviour unchanged (row sent, delivery status recorded, no state change)`, async () => {
      const s = fresh();
      const m = s.enqueueOutboxMessage({ kind: 'text', to: TO, text: 'x' });
      const claimed = s.claimOutboxMessage(m.id); s.markOutboxSent(m.id, 'wamid.CLOSED');
      const r = s.applyMetaStatus({ wamid: 'wamid.CLOSED', status: 'delivered', recipientId: TO, ...(tagged ? { attemptId: claimed.attemptId } : {}) });
      assert.ok(['applied', 'duplicate'].includes(r.result), r.result);
      assert.equal(s.getOutboxMessage(m.id).status, 'sent'); assert.equal(s.getOutboxMessage(m.id).deliveryStatus, 'delivered');
    });

    await scenario(`[tagging ${tagging}] callback during the POST, then the POST SUCCEEDS: sent with the delivery status applied`, async () => {
      const s = fresh();
      const m = s.enqueueOutboxMessage({ kind: 'text', to: TO, text: 'x' });
      const claimed = s.claimOutboxMessage(m.id);
      const early = s.applyMetaStatus({ wamid: 'wamid.OK1', status: 'delivered', recipientId: TO, ...(tagged ? { attemptId: claimed.attemptId } : {}) });
      assert.ok(['applied', 'buffered'].includes(early.result), early.result);
      s.markOutboxSent(m.id, 'wamid.OK1');
      assert.equal(s.getOutboxMessage(m.id).status, 'sent'); assert.equal(s.getOutboxMessage(m.id).deliveryStatus, 'delivered');
    });

    if (!tagged) {
      await scenario(`[tagging ${tagging}] KNOWN LIMIT (unchanged): untagged callback during the POST + a timeout cannot be matched (no attempt id, no provider id) => it is buffered, the message goes uncertain`, async () => {
        const s = fresh();
        const m = s.enqueueOutboxMessage({ kind: 'text', to: TO, text: 'x' });
        s.claimOutboxMessage(m.id);
        assert.equal(s.applyMetaStatus({ wamid: 'wamid.NOID', status: 'delivered', recipientId: TO }).result, 'buffered');
        assert.equal(s.markOutboxUncertain(m.id, timeoutError()), false);
        assert.equal(s.getOutboxMessage(m.id).status, 'uncertain');
      });
    }
  }

  let failed = 0;
  for (const r of results) { if (r[1] === 'FAIL') failed++; console.log(r[1] + '  ' + r[0]); if (r[2]) console.log('      ' + r[2]); }
  console.log('evidence-during-send: ' + (results.length - failed) + ' passed, ' + failed + ' failed');
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  setTimeout(() => process.exit(failed ? 1 : 0), 100);
})();
