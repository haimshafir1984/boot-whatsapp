'use strict';

/**
 * A5-1 - stale-while-revalidate routes cache with generation-aware invalidation.
 *
 * The gateway's routeMetaGatewayInbound() reads each managed client's campaign
 * route list through a shared AsyncExpiringCache instead of a live
 * /owner-api/meta-routes call per inbound message. getCachedRoutes() and
 * refreshAllRoutesCaches() live inside startAdminServer(), so this test
 * re-creates their exact semantics on top of the real cache class and a fake
 * HTTP layer, then checks the behaviours the plan calls out.
 */

const assert = require('node:assert/strict');
const {
  AsyncExpiringCache,
  decideMetaFallbackRoute,
} = require('../dist/metaGatewayReliability');

const TTL_MS = 5_000;
const REFRESH_INTERVAL_MS = 2_000;

/** Mirrors adminServer.ts getCachedRoutes(): cache.get() wrapped so any failure
 * degrades to 'unavailable' (the same fail-closed value a routing lookupFailure
 * produced before this change). Returns { routes, hit } so the test can see the
 * HIT/MISS the real code logs. */
function makeRoutesCache(now) {
  const cache = new AsyncExpiringCache(TTL_MS, now);
  const getCachedRoutes = async (clientId, fetchRoutes) => {
    const hit = cache.isFresh(clientId);
    try {
      const routes = await cache.get(clientId, fetchRoutes);
      return { routes, hit };
    } catch {
      return { routes: 'unavailable', hit };
    }
  };
  // Mirrors refreshAllRoutesCaches(): fire-and-forget get() for every active
  // client, result intentionally discarded - it only keeps entries warm.
  const refreshAll = (clientIds, fetchRoutes) => {
    for (const clientId of clientIds) {
      void cache.get(clientId, () => fetchRoutes(clientId)).catch(() => {});
    }
  };
  return { cache, getCachedRoutes, refreshAll };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function tick() {
  // Let any number of chained microtasks (cache .then handlers) settle.
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

async function main() {
  let clock = 0;
  const now = () => clock;

  // 1) A cache hit issues no HTTP call.
  {
    const { getCachedRoutes } = makeRoutesCache(now);
    let httpCalls = 0;
    const fetchRoutes = async () => { httpCalls += 1; return [{ id: 'c1-campaign' }]; };

    const first = await getCachedRoutes('c1', fetchRoutes);
    assert.deepEqual(first.routes, [{ id: 'c1-campaign' }]);
    assert.equal(first.hit, false, 'first-ever read is a MISS');
    assert.equal(httpCalls, 1);

    const second = await getCachedRoutes('c1', fetchRoutes);
    assert.deepEqual(second.routes, [{ id: 'c1-campaign' }]);
    assert.equal(second.hit, true, 'second read within TTL is a HIT');
    assert.equal(httpCalls, 1, 'a cache hit must not touch the network');
  }

  // 2) Single-flight: two concurrent reads of an expired/cold client share one
  //    HTTP call and both get the same result.
  {
    const { getCachedRoutes } = makeRoutesCache(now);
    let httpCalls = 0;
    const gate = deferred();
    const fetchRoutes = async () => { httpCalls += 1; await gate.promise; return [{ id: 'shared' }]; };

    const a = getCachedRoutes('c2', fetchRoutes);
    const b = getCachedRoutes('c2', fetchRoutes);
    await tick();
    assert.equal(httpCalls, 1, 'concurrent cold reads must not each fetch');
    gate.resolve();
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual(ra.routes, [{ id: 'shared' }]);
    assert.deepEqual(rb.routes, [{ id: 'shared' }]);
    assert.equal(httpCalls, 1);
  }

  // 3) Generation-aware invalidation (the race codex asked for explicitly):
  //    slow fetch starts -> invalidate() -> slow fetch lands -> the NEXT read
  //    must start a brand new fetch, and the stale result must NOT have
  //    resurrected the cache.
  let case3AssertionMessage = '';
  {
    const { cache, getCachedRoutes } = makeRoutesCache(now);
    let httpCalls = 0;
    const gates = [];
    const fetchRoutes = () => {
      httpCalls += 1;
      const g = deferred();
      gates.push(g);
      return g.promise;
    };

    const slow = getCachedRoutes('c3', fetchRoutes); // httpCalls -> 1, generation 0
    await tick();
    assert.equal(httpCalls, 1);

    cache.invalidate('c3'); // generation -> 1; the in-flight fetch is now stale

    gates[0].resolve([{ id: 'stale-v1' }]); // slow fetch lands AFTER invalidate
    const slowResult = await slow;
    assert.deepEqual(slowResult.routes, [{ id: 'stale-v1' }], 'the in-flight caller still gets an answer');

    // The next read must not see 'stale-v1' - it must fetch again.
    const nextRead = getCachedRoutes('c3', fetchRoutes);
    await tick();
    case3AssertionMessage = 'a fetch from before invalidate() must not repopulate the cache';
    assert.equal(httpCalls, 2, case3AssertionMessage);

    gates[1].resolve([{ id: 'fresh-v2' }]);
    const fresh = await nextRead;
    assert.deepEqual(fresh.routes, [{ id: 'fresh-v2' }]);

    const afterFresh = await getCachedRoutes('c3', fetchRoutes);
    assert.equal(afterFresh.hit, true, 'the post-invalidate fetch result is cached normally');
    assert.equal(httpCalls, 2);
  }

  // 4) The background refresh keeps entries warm: with refreshAll() running on a
  //    sub-TTL cadence, a "sudden" inbound read is almost always a HIT, and the
  //    number of real fetches is driven by the TTL, not by message volume.
  {
    clock = 0;
    const { getCachedRoutes, refreshAll } = makeRoutesCache(now);
    let httpCalls = 0;
    const fetchRoutes = async () => { httpCalls += 1; return [{ id: 'warm', at: clock }]; };
    const clientIds = ['c4'];

    // The first-ever read, before any refresh has run, is the cold MISS.
    const cold = await getCachedRoutes('c4', fetchRoutes);
    assert.equal(cold.hit, false, 'the first-ever read is the cold MISS');
    assert.equal(httpCalls, 1);

    let reads = 0;
    let hits = 0;

    // 30 simulated seconds, one inbound message per second, a refresh every 2s.
    for (let ms = 1_000; ms <= 30_000; ms += 1_000) {
      clock = ms;
      if (ms % REFRESH_INTERVAL_MS === 0) {
        refreshAll(clientIds, () => fetchRoutes());
        await tick();
      }
      const res = await getCachedRoutes('c4', fetchRoutes);
      assert.notEqual(res.routes, 'unavailable');
      reads += 1;
      if (res.hit) hits += 1;
    }
    const hitRatio = hits / reads;
    assert.ok(hitRatio >= 0.8, `sudden reads should almost always hit (got ${(hitRatio * 100).toFixed(0)}%)`);
    // 30 inbound reads, yet fetches track the 5s TTL (~6-8), never message volume.
    assert.ok(httpCalls <= 10, `fetch count should track the TTL, not message volume, got ${httpCalls}`);

    // Control: identical traffic with no background refresh -> lower hit ratio,
    // because every read that lands past the TTL has to fetch for itself.
    clock = 0;
    const bare = makeRoutesCache(now);
    const bareFetch = async () => [{ id: 'bare' }];
    let bareReads = 0;
    let bareHits = 0;
    for (let ms = 0; ms <= 30_000; ms += 1_000) {
      clock = ms;
      const res = await bare.getCachedRoutes('c4', bareFetch);
      bareReads += 1;
      if (res.hit) bareHits += 1;
    }
    assert.ok(bareHits / bareReads < hitRatio, 'the background refresh must raise the hit ratio');
  }

  // 5) 'unavailable' behaves exactly like a routing lookupFailure does today:
  //    a client whose fetch fails yields 'unavailable', and feeding that into
  //    the existing fallback decision produces the same 'retry' it always has.
  {
    clock = 0;
    const { getCachedRoutes } = makeRoutesCache(now);
    const failingFetch = async () => { throw new Error('client event loop saturated'); };

    const res = await getCachedRoutes('c5', failingFetch);
    assert.equal(res.routes, 'unavailable');

    // routeMetaGatewayInbound counts an 'unavailable' as lookupFailures += 1.
    const lookupFailures = res.routes === 'unavailable' ? 1 : 0;
    assert.equal(lookupFailures, 1);

    const decisionWithFailure = decideMetaFallbackRoute({
      routeLookupFailures: lookupFailures,
      pendingLookupFailures: 0,
      pendingClientIds: ['some-client-with-an-old-session'],
    });
    const decisionToday = decideMetaFallbackRoute({
      routeLookupFailures: 1, // what a dead snapshot call produced before A5-1
      pendingLookupFailures: 0,
      pendingClientIds: ['some-client-with-an-old-session'],
    });
    assert.deepEqual(decisionWithFailure, decisionToday);
    assert.deepEqual(decisionWithFailure, { action: 'retry' });

    // A recovered client is cached normally on the next read.
    let ok = 0;
    const recoveringFetch = async () => { ok += 1; return [{ id: 'recovered' }]; };
    const recovered = await getCachedRoutes('c5', recoveringFetch);
    assert.deepEqual(recovered.routes, [{ id: 'recovered' }]);
    assert.equal(ok, 1, 'a failed load must not have poisoned the cache');
  }

  // 6) Mutation guard: a cache whose success handler drops the generation check
  //    (the mutation the plan describes) DOES let a pre-invalidate fetch
  //    resurrect the entry - i.e. case 3 would fail against it. This keeps the
  //    generation check load-bearing even if someone deletes it from the class.
  {
    clock = 0;
    const mutated = new MutatedCacheWithoutGenerationCheck(TTL_MS, now);
    let httpCalls = 0;
    const gates = [];
    const fetchRoutes = () => {
      httpCalls += 1;
      const g = deferred();
      gates.push(g);
      return g.promise;
    };

    const slow = mutated.get('c6', fetchRoutes);
    await tick();
    mutated.invalidate('c6');
    gates[0].resolve([{ id: 'stale-v1' }]);
    await slow;

    let resurrected = false;
    try {
      const next = mutated.get('c6', fetchRoutes);
      await tick();
      // Against the real class this is 2 (fresh fetch). Against the mutation the
      // stale result wrote itself back, so no new fetch was started.
      if (httpCalls === 1) resurrected = true;
      if (gates[1]) gates[1].resolve([{ id: 'fresh-v2' }]);
      await next.catch(() => {});
    } catch {
      /* mutated.get may resolve synchronously from the resurrected value */
    }
    assert.equal(
      resurrected,
      true,
      'the mutation (no generation check) must reproduce the resurrection bug case 3 guards against',
    );
  }

  console.log('Meta routes cache tests passed.');
}

/**
 * The AsyncExpiringCache.get() success handler with its generation check
 * removed - exactly the mutation the plan's step 6 asks us to prove case 3
 * catches. Kept in the test file so the proof runs on every CI pass, not only
 * when someone hand-edits the source.
 */
class MutatedCacheWithoutGenerationCheck {
  constructor(ttlMs, now = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
  }

  isFresh(key) {
    const existing = this.entries.get(key);
    return existing?.value !== undefined && (existing.expiresAt ?? 0) > this.now();
  }

  async get(key, load) {
    const existing = this.entries.get(key);
    if (existing?.value !== undefined && (existing.expiresAt ?? 0) > this.now()) {
      return existing.value;
    }
    if (existing?.pending) return existing.pending;

    const generation = existing?.generation ?? 0;
    const pending = load().then(
      (value) => {
        // MUTATION: the `current.generation !== generation` guard is gone, so a
        // fetch started before invalidate() writes its stale value straight back.
        this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs, generation });
        return value;
      },
      (error) => {
        const current = this.entries.get(key);
        if (current && current.generation === generation) this.entries.delete(key);
        throw error;
      },
    );
    this.entries.set(key, { pending, generation });
    return pending;
  }

  invalidate(key) {
    const existing = this.entries.get(key);
    this.entries.set(key, { generation: (existing?.generation ?? 0) + 1 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
