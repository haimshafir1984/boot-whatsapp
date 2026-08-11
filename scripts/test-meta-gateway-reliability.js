const assert = require('node:assert/strict');
const {
  AsyncExpiringCache,
  groupMetaItemsBySender,
  isRetryableMetaStatus,
  retryTransientMetaOperation,
} = require('../dist/metaGatewayReliability');

async function main() {
  let now = 1_000;
  let loads = 0;
  const cache = new AsyncExpiringCache(5_000, () => now);
  const load = async () => {
    loads += 1;
    await Promise.resolve();
    return ['campaign'];
  };

  const [first, second] = await Promise.all([cache.get('client', load), cache.get('client', load)]);
  assert.deepEqual(first, ['campaign']);
  assert.deepEqual(second, ['campaign']);
  assert.equal(loads, 1, 'parallel cache misses should share one request');

  await cache.get('client', load);
  assert.equal(loads, 1, 'fresh cache entries should be reused');
  now += 5_001;
  await cache.get('client', load);
  assert.equal(loads, 2, 'expired cache entries should be refreshed');

  let recoveryLoads = 0;
  await assert.rejects(cache.get('recovering-client', async () => {
    recoveryLoads += 1;
    throw new Error('temporary lookup failure');
  }));
  const recovered = await cache.get('recovering-client', async () => {
    recoveryLoads += 1;
    return ['recovered'];
  });
  assert.deepEqual(recovered, ['recovered']);
  assert.equal(recoveryLoads, 2, 'failed loads must not poison the cache');

  assert.equal(isRetryableMetaStatus(408), true);
  assert.equal(isRetryableMetaStatus(429), true);
  assert.equal(isRetryableMetaStatus(503), true);
  assert.equal(isRetryableMetaStatus(401), false);
  assert.equal(isRetryableMetaStatus(409), false);

  let transientAttempts = 0;
  const transient = await retryTransientMetaOperation(async () => {
    transientAttempts += 1;
    return transientAttempts < 3
      ? { ok: false, status: 503 }
      : { ok: true, status: 200 };
  }, { delaysMs: [0, 0] });
  assert.equal(transient.ok, true);
  assert.equal(transientAttempts, 3);

  let networkAttempts = 0;
  const networkRecovery = await retryTransientMetaOperation(async () => {
    networkAttempts += 1;
    if (networkAttempts === 1) throw new Error('temporary network failure');
    return { ok: true, status: 200 };
  }, { delaysMs: [0, 0] });
  assert.equal(networkRecovery.ok, true);
  assert.equal(networkAttempts, 2);

  let permanentAttempts = 0;
  const permanent = await retryTransientMetaOperation(async () => {
    permanentAttempts += 1;
    return { ok: false, status: 409 };
  }, { delaysMs: [0, 0] });
  assert.equal(permanent.status, 409);
  assert.equal(permanentAttempts, 1, 'permanent failures should not be retried');

  const payload = (from, id) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'phone-1' }, messages: [{ from, id }] } }] }] });
  const grouped = groupMetaItemsBySender([
    { id: 'a1', payload: payload('111', 'a1') },
    { id: 'b1', payload: payload('222', 'b1') },
    { id: 'a2', payload: payload('111', 'a2') },
  ]);
  assert.deepEqual(grouped.map((group) => group.map((item) => item.id)), [['a1', 'a2'], ['b1']], 'gateway batches must preserve order per sender while separating different senders');

  console.log('Meta gateway reliability tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
