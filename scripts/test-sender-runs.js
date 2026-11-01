'use strict';
/**
 * Run bookkeeping on campaign results: openedSeq (monotonic, clock independent), the current run of a participant, supersession by a
 * newer run and from outside (handover), durability across a reload (JSON file and PostgreSQL). Nothing in the product acts on these marks
 * yet; this proves they are recorded correctly and do not disturb the existing record.
 */
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sender-runs-'));
process.env.STORAGE_PATH = path.join(dir, 'storage.json');
process.env.SESSION_PATH = path.join(dir, 'session');
const { Storage } = require('../dist/storage');

const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push([name, 'PASS']); }
  catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 5).join(' | ')]); }
}
const campaignInput = (name, phrase) => ({ name, triggerType: 1, triggerPhrase: phrase, suffix: '', active: true,
  conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], decisionFlow: [{ id: 'm1', kind: 'message', text: 'M' }] } });
const digits = (p) => String(p).replace(/\D/g, '');

(async () => {
  if (process.argv.includes('--pg-child')) {
    const { createStorage } = require('../dist/storageFactory');
    const st = await createStorage();
    const c = st.addCampaign(campaignInput('pg-runs', `pg-runs-${Date.now()}`));
    const a = st.recordCampaignTrigger(c.id, '972507770001', 'A');
    const b = st.recordCampaignTrigger(c.id, '972507770001', 'B');
    const n = await st.supersedeRunsFromOutside('972507770001', 'test');
    await st.flush();
    const back = await createStorage();
    const ra = back.getCampaignResults().find((x) => x.id === a.id); const rb = back.getCampaignResults().find((x) => x.id === b.id);
    assert.equal(typeof ra.openedSeq, 'number'); assert.ok(rb.openedSeq > ra.openedSeq);
    assert.equal(ra.supersededBy, b.id, 'replaced by the newer run, saved to PostgreSQL');
    assert.ok(rb.supersededAt && rb.supersededBy === 'handover:test', 'handover mark saved to PostgreSQL');
    assert.equal(n, 1);
    assert.equal(back.getCurrentRun('972507770001'), undefined);
    console.log('PG_CHILD_OK');
    setTimeout(() => process.exit(0), 300);
    return;
  }

  const storage = new Storage(process.env.STORAGE_PATH);
  const A = storage.addCampaign(campaignInput('A', 'a-trigger'));
  const B = storage.addCampaign(campaignInput('B', 'b-trigger'));

  await scenario('openedSeq grows with every result, regardless of the clock; legacy results (no seq) are the oldest', async () => {
    const legacy = storage.recordCampaignTrigger(A.id, '972507770100', 'legacy');
    const row = storage.data.campaignResults.find((r) => r.id === legacy.id); delete row.openedSeq;           // as saved before this existed
    const seqs = [];
    for (let i = 0; i < 20; i += 1) seqs.push(storage.recordCampaignTrigger(B.id, `97250777${String(1000 + i)}`, `n${i}`).openedSeq);
    for (let i = 1; i < seqs.length; i += 1) assert.ok(seqs[i] > seqs[i - 1], 'strictly increasing even inside one millisecond');
    const later = storage.recordCampaignTrigger(A.id, '972507770100', 'newer');
    assert.equal(storage.getLatestRun('972507770100').id, later.id, 'a numbered run beats a legacy one');
    assert.equal(storage.getCurrentRun('972507770100').id, later.id);
  });

  await scenario('a new trigger replaces the participant\'s earlier runs at this client (any campaign), and only hers; the replaced run keeps its other fields', async () => {
    const first = storage.recordCampaignTrigger(A.id, '972507770200', 'one');
    const other = storage.recordCampaignTrigger(A.id, '972507770201', 'someone else');
    const before = JSON.stringify({ ...storage.data.campaignResults.find((r) => r.id === first.id), supersededAt: undefined, supersededBy: undefined });
    const second = storage.recordCampaignTrigger(B.id, '+972 50-777-0200', 'two');            // another campaign, phone written differently
    const rowFirst = storage.data.campaignResults.find((r) => r.id === first.id);
    assert.ok(rowFirst.supersededAt); assert.equal(rowFirst.supersededBy, second.id);
    assert.equal(JSON.stringify({ ...rowFirst, supersededAt: undefined, supersededBy: undefined }), before, 'nothing else about the replaced run changed (not even updatedAt)');
    assert.equal(storage.data.campaignResults.find((r) => r.id === other.id).supersededAt, undefined, 'someone else is untouched');
    assert.equal(storage.getCurrentRun('972507770200').id, second.id);
    assert.equal(storage.getCurrentRun('972507770201').id, other.id);
    const stamp = rowFirst.supersededAt;
    storage.recordCampaignTrigger(B.id, '972507770200', 'three');
    assert.equal(storage.data.campaignResults.find((r) => r.id === first.id).supersededAt, stamp, 'the first mark is never rewritten');
    assert.equal(storage.data.campaignResults.find((r) => r.id === second.id).supersededBy, storage.getCurrentRun('972507770200').id);
  });

  await scenario('replacement from outside (handover) is durable before the call returns and survives a reload; a newer trigger afterwards is current again', async () => {
    const r = storage.recordCampaignTrigger(A.id, '972507770300', 'x');
    assert.equal(await storage.supersedeRunsFromOutside('972507770300', 'other-client'), 1);
    assert.equal(storage.getCurrentRun('972507770300'), undefined, 'no current run: her latest was taken over');
    assert.equal(storage.getLatestRun('972507770300').id, r.id);
    assert.equal(await storage.supersedeRunsFromOutside('972507770300', 'again'), 0, 'already replaced: nothing to change');
    assert.equal(await storage.supersedeRunsFromOutside('972509999999', 'nobody'), 0);
    const reopened = new Storage(process.env.STORAGE_PATH);                              // read back from the saved file, no extra flush by us
    assert.equal(reopened.getCurrentRun('972507770300'), undefined, 'still replaced after a reload');
    assert.equal(reopened.getLatestRun('972507770300').supersededBy, 'handover:other-client');
    const fresh = reopened.recordCampaignTrigger(B.id, '972507770300', 'back');
    assert.equal(reopened.getCurrentRun('972507770300').id, fresh.id);
    assert.ok(fresh.openedSeq > r.openedSeq, 'the counter continues above everything saved');
  });

  await scenario('a reset campaign\'s runs are gone from the lookup; counters keep working; replaced marks of other campaigns stay', async () => {
    const a = storage.recordCampaignTrigger(A.id, '972507770400', 'a');
    const b = storage.recordCampaignTrigger(B.id, '972507770400', 'b');
    storage.resetCampaignData(B.id);
    assert.equal(storage.getLatestRun('972507770400').id, a.id, 'only A\'s run is left');
    assert.ok(storage.getLatestRun('972507770400').supersededAt, 'it was replaced by the run that no longer exists: the mark stays');
    assert.equal(storage.getCurrentRun('972507770400'), undefined);
    const c = storage.recordCampaignTrigger(A.id, '972507770400', 'c');
    assert.ok(c.openedSeq > b.openedSeq);
  });

  await scenario('PostgreSQL: the marks are saved with the result rows and read back (child process, local test database only)', async () => {
    const url = process.env.TEST_DATABASE_URL || '';
    if (!url || !/flowsbiz_test/.test(url)) { console.log('      SKIPPED: TEST_DATABASE_URL (local flowsbiz_test database) is not set in this environment'); return; }
    const { spawnSync } = require('node:child_process');
    const child = spawnSync(process.execPath, [__filename, '--pg-child'], { env: { ...process.env, DATABASE_URL: url, STORAGE_PATH: path.join(dir, 'pg-unused.json') }, encoding: 'utf8', timeout: 120000 });
    assert.equal(child.status, 0, `child failed: ${String(child.stdout).slice(-500)} ${String(child.stderr).slice(-500)}`);
    assert.match(child.stdout, /PG_CHILD_OK/);
    assert.match(child.stdout, /Storage mode: PostgreSQL/);
  });

  fs.rmSync(dir, { recursive: true, force: true });
  let failed = 0;
  for (const [name, status, detail] of results) { console.log(`${status}  ${name}${detail ? '\n      ' + detail : ''}`); if (status !== 'PASS') failed += 1; }
  console.log(failed ? `\n${failed} scenario(s) FAILED` : `\nSender run tests passed (${results.length} scenarios).`);
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
})().catch((e) => { console.error(e); process.exit(1); });
