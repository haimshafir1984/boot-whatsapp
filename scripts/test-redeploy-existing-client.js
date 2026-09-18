'use strict';

/**
 * docs/decision-recovery-scale-fix-plan-2026-09-03.md part B.0 / B.1, updated
 * 2026-09-18 (docs/load-testing-and-deploy-findings-2026-09-18.md): the bulk
 * button was found to be rebuilding from whatever was already cloned onto the
 * server rather than pulling new commits, because application.redeploy does
 * not re-clone. It now calls application.deploy instead.
 *
 * The bulk "redeploy every client" button must go through
 * DokployProvisioner.redeployExistingClient(), which is allowed to call ONLY
 * application.deploy (+ the deployment.all GET it polls, + a best-effort
 * /health check on success). It must never touch configuration:
 * saveGitProvider / saveEnvironment / saveBuildType / mounts.create /
 * postgres.create / postgres.deploy / domain.create / application.create /
 * application.redeploy. That unconditional saveGitProvider in
 * provisionClient() is exactly what reset every client's Git provider to
 * "Custom" with no credentials and broke `git clone` fleet-wide on 2026-09-03.
 *
 * A client with no dokployApplicationId must be skipped with zero API calls -
 * never silently re-provisioned.
 */

const assert = require('node:assert/strict');
const { DokployProvisioner } = require('../dist/dokployProvisioner');

const FORBIDDEN_ROUTES = new Set([
  'application.create',
  'application.redeploy',
  'application.saveGitProvider',
  'application.saveEnvironment',
  'application.saveBuildType',
  'mounts.create',
  'postgres.create',
  'postgres.deploy',
  'domain.create',
]);

const env = {
  DOKPLOY_API_URL: 'https://dokploy.example.test/api',
  DOKPLOY_API_TOKEN: 'token',
  DOKPLOY_ENVIRONMENT_ID: 'env_1',
  DOKPLOY_GIT_URL: 'https://github.example.test/org/repo.git',
  DOKPLOY_GIT_BRANCH: 'master',
  DOKPLOY_CLIENT_DOMAIN_SUFFIX: 'clients.example.test',
};

function baseClient(overrides = {}) {
  return {
    id: 'abcdef12-90ab-cdef-1234-567890abcdef',
    name: 'Bulk Redeploy Client',
    accessCode: 'client-secret-code',
    ownerAccessToken: 'owner-secret-token',
    plan: 'self_service',
    readonlyDashboard: false,
    maxCampaigns: 7,
    whatsappProvider: 'META_CLOUD_API',
    managementUrl: '',
    provisioningStatus: 'ready',
    createdAt: new Date().toISOString(),
    dokployApplicationId: 'app_existing_1',
    ...overrides,
  };
}

/** Parses "application.redeploy" / "deployment.all?applicationId=x" from a URL. */
function routeOf(url) {
  const afterApi = String(url).split('/api/')[1] || '';
  return afterApi.split('?')[0];
}

const noSleep = async () => {};

(async () => {
  // ── Case 1: existing client → only application.deploy + deployment.all.
  // No managementUrl on baseClient(), so the best-effort post-success /health
  // check is a no-op (healthOk stays undefined) - covered separately below.
  {
    const calls = [];
    let sentTitle;
    global.fetch = async (url, init = {}) => {
      const route = routeOf(url);
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ route, method, body });
      if (route === 'application.deploy') {
        sentTitle = body.title;
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
      }
      if (route === 'deployment.all') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify([
            { deploymentId: 'dep_1', title: sentTitle, status: 'done', errorMessage: null },
          ]),
        };
      }
      // Any other route (e.g. a regressed saveGitProvider/saveEnvironment call)
      // is still recorded above and returns benignly, so the assertions below -
      // not a thrown error - are what catch the regression.
      return { ok: true, status: 200, text: async () => '{}' };
    };

    const provisioner = new DokployProvisioner(env);
    const result = await provisioner.redeployExistingClient(baseClient(), {
      pollIntervalMs: 1, timeoutMs: 2000, retryDelayMs: 1, sleepFn: noSleep,
    });

    assert.equal(result.ok, true, 'an existing client deploy that reaches status "done" must report ok');
    assert.equal(result.skipped, undefined);
    assert.equal(result.healthOk, undefined, 'no managementUrl means the health check is skipped, not failed');

    const routes = calls.map((c) => c.route);
    assert.deepEqual(
      [...new Set(routes)].sort(),
      ['application.deploy', 'deployment.all'],
      `only application.deploy + deployment.all may be called, saw: ${routes.join(', ')}`,
    );
    for (const route of routes) {
      assert.ok(!FORBIDDEN_ROUTES.has(route), `forbidden route was called: ${route}`);
    }
    const deployCalls = calls.filter((c) => c.route === 'application.deploy');
    assert.equal(deployCalls.length, 1, 'exactly one deploy for a clean run');
    assert.equal(deployCalls[0].method, 'POST');
    assert.equal(deployCalls[0].body.applicationId, 'app_existing_1');
    assert.ok(/^Bulk deploy abcdef12-90ab-cdef-1234-567890abcdef \d+-\d+-[0-9a-f]{8}$/.test(deployCalls[0].body.title),
      `deploy title must be unique per invocation (client id + timestamp + counter + random), saw: ${deployCalls[0].body.title}`);
    const pollCalls = calls.filter((c) => c.route === 'deployment.all');
    assert.equal(pollCalls[0].method, 'GET', 'deployment.all must be a GET, not a POST through post()');
    console.log('1. existing client: only application.deploy + deployment.all(GET); no config routes touched.');
  }

  // ── Case 2: client with no dokployApplicationId → skipped, zero API calls.
  {
    const calls = [];
    global.fetch = async (url, init = {}) => {
      calls.push(routeOf(url));
      return { ok: true, status: 200, text: async () => '{}' };
    };
    const provisioner = new DokployProvisioner(env);
    const result = await provisioner.redeployExistingClient(
      baseClient({ dokployApplicationId: undefined }),
      { pollIntervalMs: 1, timeoutMs: 100, sleepFn: noSleep },
    );
    assert.equal(result.skipped, true, 'a client with no Dokploy application must be skipped');
    assert.equal(result.ok, false);
    assert.ok(/provision it explicitly/i.test(result.error || ''), 'skip reason should point at explicit provisioning');
    assert.equal(calls.length, 0, 'a skipped client must trigger no Dokploy API call at all');
    console.log('2. client with no dokployApplicationId: skipped, zero API calls, no silent provisioning.');
  }

  // ── Case 3: client with a managementUrl → success is followed by a
  // best-effort /health check, reported as healthOk without affecting ok.
  {
    const calls = [];
    let sentTitle;
    global.fetch = async (url, init = {}) => {
      const urlStr = String(url);
      if (urlStr.includes('/health')) {
        calls.push({ route: 'health' });
        return { ok: true, status: 200, json: async () => ({ storage: { ready: true } }) };
      }
      const route = routeOf(url);
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ route, method, body });
      if (route === 'application.deploy') {
        sentTitle = body.title;
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
      }
      if (route === 'deployment.all') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify([
            { deploymentId: 'dep_2', title: sentTitle, status: 'done', errorMessage: null },
          ]),
        };
      }
      return { ok: true, status: 200, text: async () => '{}' };
    };

    const provisioner = new DokployProvisioner(env);
    const result = await provisioner.redeployExistingClient(
      baseClient({ managementUrl: 'https://client-demo.example.test/client/' }),
      { pollIntervalMs: 1, timeoutMs: 2000, retryDelayMs: 1, sleepFn: noSleep },
    );

    assert.equal(result.ok, true);
    assert.equal(result.healthOk, true, 'a healthy /health response must report healthOk:true');
    assert.ok(calls.some((c) => c.route === 'health'), 'a client with managementUrl must be health-checked after a successful deploy');
    console.log('3. client with managementUrl: /health checked after success, healthOk reported.');
  }

  console.log('\nredeployExistingClient tests passed.');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
