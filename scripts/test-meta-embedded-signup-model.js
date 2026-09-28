'use strict';

// embedded-signup-automation-plan-2026-09-28, stage 7 step 2: new ManagedClient
// fields (metaWabaId, metaOnboarding, metaConnectLinkTokenHash/ExpiresAt/UsedAt)
// and exposeOwnerClient must never leak the connect-link token hash or the
// Meta access/verify tokens to the owner dashboard response.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OwnerStorage } = require('../dist/ownerStorage');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowsbiz-embedded-signup-model-'));

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(temporaryDirectory, 'case-'));
  return fn(dir);
}

try {
  // 1. The new fields round-trip through persist + reload, exactly like every
  //    other ManagedClient field (updateClient is a generic patch - no special
  //    casing should have been needed, and none was added).
  withTempDir((dir) => {
    const storagePath = path.join(dir, 'clients.json');
    const storage = new OwnerStorage(storagePath);
    const client = storage.addClient('לקוחה עם מספר ייעודי', '12345678', { whatsappProvider: 'META_CLOUD_API' });

    const onboarding = {
      status: 'in_progress',
      step: 'code_exchanged',
      updatedAt: '2026-09-29T08:00:00.000Z',
    };
    const updated = storage.updateClient(client.id, {
      metaWabaId: 'waba-123456',
      metaOnboarding: onboarding,
      metaConnectLinkTokenHash: 'a'.repeat(64),
      metaConnectLinkExpiresAt: '2026-10-06T08:00:00.000Z',
    });
    assert.equal(updated.metaWabaId, 'waba-123456');
    assert.deepEqual(updated.metaOnboarding, onboarding);
    assert.equal(updated.metaConnectLinkTokenHash, 'a'.repeat(64));
    assert.equal(updated.metaConnectLinkExpiresAt, '2026-10-06T08:00:00.000Z');
    assert.equal(updated.metaConnectLinkUsedAt, undefined, 'a link that was not completed yet has no used-at timestamp');

    // Completion marks the link used and moves onboarding to connected/failed.
    const completed = storage.updateClient(client.id, {
      metaConnectLinkUsedAt: '2026-09-29T08:05:00.000Z',
      metaOnboarding: { status: 'connected', step: 'provisioned', completedAt: '2026-09-29T08:05:00.000Z', updatedAt: '2026-09-29T08:05:00.000Z' },
    });
    assert.equal(completed.metaOnboarding.status, 'connected');
    assert.equal(completed.metaConnectLinkUsedAt, '2026-09-29T08:05:00.000Z');

    const reloaded = new OwnerStorage(storagePath).getClient(client.id);
    assert.equal(reloaded.metaWabaId, 'waba-123456', 'metaWabaId must survive a restart');
    assert.deepEqual(reloaded.metaOnboarding, completed.metaOnboarding, 'metaOnboarding must survive a restart');
    assert.equal(reloaded.metaConnectLinkTokenHash, 'a'.repeat(64), 'the link hash must survive a restart (not the raw token, which is never stored)');
  });

  // 2. A failed onboarding attempt keeps the error, exactly as section 3.3
  //    ("כשל שומר גם error") requires - this is just the model holding
  //    whatever the (not-yet-built) completion endpoint writes into it.
  withTempDir((dir) => {
    const storage = new OwnerStorage(path.join(dir, 'clients.json'));
    const client = storage.addClient('לקוחה עם כשל', '12345678', { whatsappProvider: 'META_CLOUD_API' });
    const failed = storage.updateClient(client.id, {
      metaOnboarding: {
        status: 'failed',
        step: 'subscribed_apps',
        error: 'Graph API timeout',
        updatedAt: '2026-09-29T08:10:00.000Z',
      },
    });
    assert.equal(failed.metaOnboarding.status, 'failed');
    assert.equal(failed.metaOnboarding.error, 'Graph API timeout');
  });

  // 3. A corrupt metaOnboarding (wrong shape) must fail closed at startup,
  //    the same way every other corrupt-registry case in ownerStorage.ts does
  //    (validateRegistry rejects the whole file; no .bak here, so load() throws
  //    rather than silently starting with an empty or partially-trusted registry).
  withTempDir((dir) => {
    const storagePath = path.join(dir, 'clients.json');
    const corruptRegistry = [{
      id: 'client-1',
      name: 'לקוחה',
      accessCode: 'x',
      ownerAccessToken: 'token',
      createdAt: '2026-09-29T08:00:00.000Z',
      metaOnboarding: 'connected', // must be an object, not a bare string
    }];
    fs.writeFileSync(storagePath, JSON.stringify(corruptRegistry, null, 2), 'utf-8');
    assert.throws(() => new OwnerStorage(storagePath), /could not be parsed into a valid client registry/, 'a malformed metaOnboarding must be rejected like any other corrupt record, not silently accepted');
  });

  // 4. exposeOwnerClient (src/adminServer.ts) must keep hiding every Meta secret,
  //    and must now also hide the connect-link token hash - it is not needed by
  //    the dashboard (only the plain, one-time link itself is shown once, at
  //    creation time) and leaking the hash buys an attacker nothing but is
  //    needless exposure of internal state.
  const adminServerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'adminServer.ts'), 'utf8');
  const exposeMatch = adminServerSource.match(/const exposeOwnerClient = \(client: ManagedClient\) => \(\{[\s\S]*?\}\);/);
  assert.ok(exposeMatch, 'exposeOwnerClient must still be defined the same way');
  const exposeBody = exposeMatch[0];
  assert.match(exposeBody, /metaAccessToken:\s*undefined/, 'metaAccessToken must stay hidden from the owner dashboard');
  assert.match(exposeBody, /metaVerifyToken:\s*undefined/, 'metaVerifyToken must stay hidden from the owner dashboard');
  assert.match(exposeBody, /metaConnectLinkTokenHash:\s*undefined/, 'the connect-link token hash must not reach the owner dashboard response');
  assert.doesNotMatch(exposeBody, /metaWabaId:\s*undefined/, 'metaWabaId is not a secret and must stay visible for the connection-status UI');
  assert.doesNotMatch(exposeBody, /metaOnboarding:\s*undefined/, 'metaOnboarding is not a secret and must stay visible for the connection-status UI');

  console.log('Embedded Signup ManagedClient model tests passed.');
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
