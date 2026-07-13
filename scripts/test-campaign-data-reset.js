const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../dist/storage');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowsbiz-reset-'));
const file = path.join(dir, 'contacts.json');

try {
  const storage = new Storage(file);
  const campaignA = storage.addCampaign({
    name: 'Test A', triggerType: 1, triggerPhrase: 'trigger a', suffix: '', active: true,
  });
  const campaignB = storage.addCampaign({
    name: 'Test B', triggerType: 1, triggerPhrase: 'trigger b', suffix: '', active: true,
  });

  const resultA = storage.recordCampaignTrigger(campaignA.id, '972500000001', 'A');
  const resultB = storage.recordCampaignTrigger(campaignB.id, '972500000001', 'B');
  storage.recordCampaignEvent({ campaignId: campaignA.id, campaignResultId: resultA.id, type: 'completed' });
  storage.recordCampaignEvent({ campaignId: campaignB.id, campaignResultId: resultB.id, type: 'completed' });
  storage.enqueueContactSave('972500000001', 'Shared contact', resultA.id);
  storage.enqueueContactSave('972500000001', 'Shared contact', resultB.id);

  const reset = storage.resetCampaignData(campaignA.id);
  assert.ok(reset);
  assert.equal(reset.results, 1);
  assert.equal(reset.events, 1);
  assert.equal(storage.getCampaignResults(campaignA.id).length, 0);
  assert.equal(storage.getCampaignEvents(campaignA.id).length, 0);
  assert.equal(storage.getCampaignResults(campaignB.id).length, 1);
  assert.equal(storage.getCampaignEvents(campaignB.id).length, 1);
  assert.notEqual(storage.getCurrentCampaignResultBatchId(campaignA.id), resultA.resultBatchId);

  const queue = storage.getContactQueue(10);
  assert.equal(queue.length, 1);
  assert.deepEqual(queue[0].campaignResultIds, [resultB.id]);
  console.log('Campaign data reset tests passed.');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
