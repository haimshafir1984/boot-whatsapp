const assert = require('assert');
const { DokployProvisioner } = require('../dist/dokployProvisioner');

const calls = [];
global.fetch = async (url, init) => {
  const route = String(url).split('/api/')[1];
  const body = JSON.parse(init.body || '{}');
  calls.push({ route, body });
  const json = (payload) => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });
  switch (route) {
    case 'application.create':
      return json({ applicationId: 'app_1', appName: body.appName });
    case 'mounts.create':
      return json({ mountId: 'mount_1' });
    case 'postgres.create':
      return json({
        postgresId: 'pg_1',
        appName: body.appName + '-abc123',
        databaseName: body.databaseName,
        databaseUser: body.databaseUser,
        databasePassword: body.databasePassword,
      });
    case 'domain.create':
      return json({ domainId: 'domain_1' });
    default:
      return json({ ok: true });
  }
};

const env = {
  DOKPLOY_API_URL: 'https://dokploy.example.test/api',
  DOKPLOY_API_TOKEN: 'token',
  DOKPLOY_ENVIRONMENT_ID: 'env_1',
  DOKPLOY_GIT_URL: 'https://github.example.test/org/repo.git',
  DOKPLOY_GIT_BRANCH: 'master',
  DOKPLOY_CLIENT_DOMAIN_SUFFIX: 'clients.example.test',
};

let current = {
  id: '12345678-90ab-cdef-1234-567890abcdef',
  name: 'Test Client',
  accessCode: 'client-secret-code',
  ownerAccessToken: 'owner-secret-token',
  plan: 'self_service',
  readonlyDashboard: false,
  maxCampaigns: 7,
  whatsappProvider: 'BAILEYS',
  managementUrl: '',
  provisioningStatus: 'provisioning',
  createdAt: new Date().toISOString(),
};

(async () => {
  const provisioner = new DokployProvisioner(env);
  assert.strictEqual(provisioner.configurationError, null);
  current = await provisioner.provision(current, (patch) => {
    current = { ...current, ...patch };
    return current;
  });

  const routes = calls.map((call) => call.route);
  assert(routes.includes('postgres.create'), 'postgres.create should be called');
  assert(routes.includes('postgres.deploy'), 'postgres.deploy should be called');
  assert(routes.indexOf('postgres.create') < routes.indexOf('application.saveEnvironment'), 'PostgreSQL must exist before env is saved');
  assert(routes.indexOf('postgres.deploy') < routes.indexOf('application.deploy'), 'PostgreSQL deployment should be requested before app deployment');

  const postgresCreate = calls.find((call) => call.route === 'postgres.create');
  assert.strictEqual(postgresCreate.body.name, 'client-test-client-12345678-postgres');
  assert.strictEqual(postgresCreate.body.appName, 'client-test-client-12345678-pg');
  assert.strictEqual(postgresCreate.body.databaseName, 'postgres');
  assert.strictEqual(postgresCreate.body.databaseUser, 'postgres');
  assert(postgresCreate.body.databasePassword.length >= 24, 'database password should be generated');

  const envSave = calls.find((call) => call.route === 'application.saveEnvironment');
  assert(envSave.body.env.includes('DATABASE_URL="postgres://postgres:'), 'DATABASE_URL should be configured');
  assert(envSave.body.env.includes('@client-test-client-12345678-pg-abc123:5432/postgres"'), 'DATABASE_URL should point at the created PostgreSQL service');
  assert(envSave.body.env.includes('STORAGE_PATH=./data/contacts.json'), 'JSON storage path should remain for uploads/rollback compatibility');

  assert.strictEqual(current.dokployPostgresId, 'pg_1');
  assert.strictEqual(current.dokployPostgresAppName, 'client-test-client-12345678-pg-abc123');
  assert(current.dokployPostgresDatabasePassword, 'password should be stored in owner storage metadata');

  const createCountsBeforeRetry = Object.fromEntries(
    ['application.create', 'mounts.create', 'postgres.create', 'domain.create']
      .map((route) => [route, calls.filter((call) => call.route === route).length]),
  );
  current = await provisioner.provision(current, (patch) => {
    current = { ...current, ...patch };
    return current;
  });
  for (const [route, count] of Object.entries(createCountsBeforeRetry)) {
    assert.strictEqual(
      calls.filter((call) => call.route === route).length,
      count,
      `Provisioning retry must not call ${route} again`,
    );
  }

  console.log('Dokploy PostgreSQL provisioning regression passed.');
})();
