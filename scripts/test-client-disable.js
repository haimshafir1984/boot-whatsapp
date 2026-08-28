const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OwnerStorage } = require('../dist/ownerStorage');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowsbiz-client-disable-'));
const storagePath = path.join(temporaryDirectory, 'clients.json');

try {
  const storage = new OwnerStorage(storagePath);
  const original = storage.addClient('לקוח בדיקה', '123456789', {
    whatsappProvider: 'META_CLOUD_API',
    maxCampaigns: 7,
  });
  storage.updateClient(original.id, {
    provisioningStatus: 'ready',
    managementUrl: 'https://client.example.test/client/',
    dokployApplicationId: 'app-1',
    dokployMountId: 'mount-1',
    dokployPostgresId: 'postgres-1',
  });

  const beforeDisable = storage.getClient(original.id);
  const disabled = storage.updateClient(original.id, {
    provisioningStatus: 'disabled',
    disabledAt: '2026-08-28T15:00:00.000Z',
    disabledReason: 'manual test',
  });

  assert.equal(disabled.provisioningStatus, 'disabled');
  assert.equal(disabled.managementUrl, beforeDisable.managementUrl);
  assert.equal(disabled.dokployApplicationId, beforeDisable.dokployApplicationId);
  assert.equal(disabled.dokployMountId, beforeDisable.dokployMountId);
  assert.equal(disabled.dokployPostgresId, beforeDisable.dokployPostgresId);
  assert.equal(storage.getClients().length, 1, 'disable must not delete the managed-client record');

  const reloaded = new OwnerStorage(storagePath).getClient(original.id);
  assert.equal(reloaded.provisioningStatus, 'disabled', 'disabled state must survive restart');
  assert.equal(reloaded.disabledReason, 'manual test');

  const enabled = storage.updateClient(original.id, {
    provisioningStatus: 'ready',
    disabledAt: undefined,
    disabledReason: undefined,
  });
  assert.equal(enabled.provisioningStatus, 'ready');
  assert.equal(enabled.dokployApplicationId, 'app-1');
  assert.equal(enabled.dokployPostgresId, 'postgres-1');

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'adminServer.ts'), 'utf8');
  assert.match(serverSource, /clients\/:id\/disable/);
  assert.match(serverSource, /clients\/:id\/enable/);
  assert.match(serverSource, /provisioningStatus !== 'disabled'/, 'Meta routing must exclude disabled clients');
  assert.match(serverSource, /requester\.provisioningStatus === 'disabled'/, 'disabled clients must not reserve or activate Meta triggers');
  assert.match(serverSource, /reservedRoutes\.map/, 're-enable must verify existing active Meta triggers before routing resumes');
  assert.match(serverSource, /storage\?\.ready === false/, 're-enable must verify storage readiness');

  const ownerUi = fs.readFileSync(path.join(__dirname, '..', 'owner-public', 'index.html'), 'utf8');
  assert.match(ownerUi, /השבת/);
  assert.match(ownerUi, /הפעל מחדש/);
  assert.match(ownerUi, /לא יימחקו/);
  for (const [, script] of ownerUi.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    assert.doesNotThrow(() => new Function(script), 'owner dashboard inline JavaScript must remain syntactically valid');
  }

  console.log('Managed-client disable/enable regression tests passed.');
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
