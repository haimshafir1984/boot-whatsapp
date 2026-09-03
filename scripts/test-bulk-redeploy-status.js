'use strict';

/**
 * docs/decision-recovery-scale-fix-plan-2026-09-03.md part B.1 / B.2.
 *
 * redeployExistingClient() must not trust Dokploy's "request accepted" response.
 * It polls GET /api/deployment.all, resolves OUR deployment by the unique title
 * we sent, then follows only that deploymentId to a terminal status:
 *   - status "done"  → ok:true
 *   - status "error" → ok:false with the real errorMessage
 *   - never finishing → ok:false after the timeout (no infinite hang)
 * A parallel unrelated deployment (different title) must not make us report
 * early. A single retry runs ONLY for a known transient clone failure, never for
 * a generic auth/config error.
 *
 * All Dokploy calls are mocked - this never talks to a real instance.
 */

const assert = require('node:assert/strict');
const { DokployProvisioner } = require('../dist/dokployProvisioner');

const env = {
  DOKPLOY_API_URL: 'https://dokploy.example.test/api',
  DOKPLOY_API_TOKEN: 'token',
  DOKPLOY_ENVIRONMENT_ID: 'env_1',
  DOKPLOY_GIT_URL: 'https://github.example.test/org/repo.git',
  DOKPLOY_GIT_BRANCH: 'master',
  DOKPLOY_CLIENT_DOMAIN_SUFFIX: 'clients.example.test',
};

function client(overrides = {}) {
  return {
    id: 'cccddd11-90ab-cdef-1234-567890abcdef',
    name: 'Polled Client',
    accessCode: 'x', ownerAccessToken: 'y', plan: 'self_service',
    readonlyDashboard: false, maxCampaigns: 5, whatsappProvider: 'META_CLOUD_API',
    managementUrl: '', provisioningStatus: 'ready', createdAt: new Date().toISOString(),
    dokployApplicationId: 'app_poll_1',
    ...overrides,
  };
}

function routeOf(url) {
  const afterApi = String(url).split('/api/')[1] || '';
  return afterApi.split('?')[0];
}

const noSleep = async () => {};
const fastOpts = { pollIntervalMs: 1, timeoutMs: 500, retryDelayMs: 1, sleepFn: noSleep };

/**
 * Installs a mock fetch. `plan` is a function (attemptIndex, pollIndex) that
 * returns the array of deployment rows deployment.all should return for that
 * poll. attemptIndex starts at 0 and increments on each application.redeploy.
 */
function installMock(plan) {
  const state = { attempt: -1, poll: 0, titles: [], redeploys: 0 };
  global.fetch = async (url, init = {}) => {
    const route = routeOf(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (route === 'application.redeploy') {
      state.attempt += 1;
      state.poll = 0;
      state.redeploys += 1;
      state.titles.push(body.title);
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
    }
    if (route === 'deployment.all') {
      const rows = plan(state.attempt, state.poll, state.titles[state.attempt]);
      state.poll += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
    }
    throw new Error(`unexpected route ${route}`);
  };
  return state;
}

(async () => {
  const provisioner = new DokployProvisioner(env);

  // ── 1. running → running → done, tracked by deploymentId.
  {
    const state = installMock((attempt, poll, myTitle) => {
      const status = poll >= 2 ? 'done' : 'running';
      return [{ deploymentId: 'dep_track_1', title: myTitle, status, errorMessage: null }];
    });
    const result = await provisioner.redeployExistingClient(client(), fastOpts);
    assert.equal(result.ok, true, 'must report ok only once the tracked deployment is "done"');
    assert.equal(result.retried, undefined, 'a clean run must not set retried');
    assert.ok(state.poll >= 3, `must have polled until "done" (saw ${state.poll} polls)`);
    console.log('1. running→running→done: ok:true only after the tracked deploymentId is done.');
  }

  // ── 2. error with a real errorMessage, non-transient → no retry.
  {
    const state = installMock((attempt, poll, myTitle) => ([
      { deploymentId: 'dep_err_1', title: myTitle, status: 'error', errorMessage: 'Build failed: TypeScript compile error in src/index.ts' },
    ]));
    const result = await provisioner.redeployExistingClient(client(), fastOpts);
    assert.equal(result.ok, false, 'a deployment that ends in status "error" must report failure');
    assert.equal(result.error, 'Build failed: TypeScript compile error in src/index.ts', 'the real Dokploy errorMessage must be surfaced');
    assert.equal(result.retried, undefined, 'a non-transient error must NOT trigger the retry path');
    assert.equal(state.redeploys, 1, 'exactly one redeploy for a non-transient failure');
    console.log('2. status "error": ok:false with the real errorMessage, no blind retry.');
  }

  // ── 3. Race: an unrelated parallel deployment (different title) is "done"
  //    immediately, ours is still "running". We must NOT report early.
  {
    const state = installMock((attempt, poll, myTitle) => ([
      { deploymentId: 'dep_other', title: 'Manual deploy by admin', status: 'done', errorMessage: null },
      { deploymentId: 'dep_ours', title: myTitle, status: poll >= 3 ? 'done' : 'running', errorMessage: null },
    ]));
    const result = await provisioner.redeployExistingClient(client(), fastOpts);
    assert.equal(result.ok, true, 'must eventually succeed on OUR deployment');
    assert.ok(state.poll >= 4, `must have kept polling past the unrelated "done" row (saw ${state.poll} polls)`);
    console.log('3. race: an unrelated "done" deployment does not cause an early success report.');
  }

  // ── 4. Timeout: ours never leaves "running".
  {
    installMock((attempt, poll, myTitle) => ([
      { deploymentId: 'dep_stuck', title: myTitle, status: 'running', errorMessage: null },
    ]));
    const started = Date.now();
    const result = await provisioner.redeployExistingClient(client(), { ...fastOpts, timeoutMs: 40 });
    assert.equal(result.ok, false, 'a deployment stuck on "running" must fail via timeout, not hang');
    assert.ok(/did not finish within/i.test(result.error || ''), `timeout error expected, got: ${result.error}`);
    assert.ok(Date.now() - started < 5000, 'must return promptly after the timeout, not spin forever');
    console.log('4. timeout: stuck "running" → ok:false after the deadline, no infinite loop.');
  }

  // ── 5a. Transient clone failure on attempt 1, success on attempt 2 → retried.
  {
    const state = installMock((attempt, poll, myTitle) => {
      if (attempt === 0) {
        return [{ deploymentId: 'dep_t1', title: myTitle, status: 'error', errorMessage: "fatal: could not read Username for 'https://github.com': No such device or address" }];
      }
      return [{ deploymentId: 'dep_t2', title: myTitle, status: 'done', errorMessage: null }];
    });
    const result = await provisioner.redeployExistingClient(client(), fastOpts);
    assert.equal(result.ok, true, 'a transient clone failure that clears on retry must end ok');
    assert.equal(result.retried, true, 'retried must be flagged so the operator knows a retry happened');
    assert.equal(state.redeploys, 2, 'the retry must actually issue a second application.redeploy');
    assert.equal(state.titles.length, 2, 'the retry must use a fresh unique title');
    assert.notEqual(state.titles[0], state.titles[1], 'retry title must differ from the first attempt');
    console.log('5a. transient clone failure → single retry → ok:true, retried:true, second redeploy issued.');
  }

  // ── 5b. Counter-case: generic auth error → NO retry.
  {
    const state = installMock((attempt, poll, myTitle) => ([
      { deploymentId: 'dep_401', title: myTitle, status: 'error', errorMessage: '401 Unauthorized' },
    ]));
    const result = await provisioner.redeployExistingClient(client(), fastOpts);
    assert.equal(result.ok, false, 'a 401 is a real config error and must fail');
    assert.equal(result.error, '401 Unauthorized');
    assert.notEqual(result.retried, true, 'a non-transient error must not be retried');
    assert.equal(state.redeploys, 1, 'no second redeploy for a 401');
    console.log('5b. generic "401 Unauthorized": no retry, immediate failure.');
  }

  console.log('\nbulk redeploy status/polling tests passed.');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
