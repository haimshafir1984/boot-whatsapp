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
  DOKPLOY_META_ACCESS_TOKEN: 'central-token',
  DOKPLOY_META_PHONE_NUMBER_ID: '111111111111111',
  DOKPLOY_META_DISPLAY_PHONE_NUMBER: '972529771002',
  DOKPLOY_META_VERIFY_TOKEN: 'central-verify',
  DOKPLOY_META_APP_SECRET: 'central-app-secret',
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
  assert.strictEqual(postgresCreate.body.name, 'client-test-client-baileys-12345678-postgres');
  assert.strictEqual(postgresCreate.body.appName, 'client-test-client-baileys-12345678-postgres');
  assert.strictEqual(postgresCreate.body.databaseName, 'postgres');
  assert.strictEqual(postgresCreate.body.databaseUser, 'postgres');
  assert(postgresCreate.body.databasePassword.length >= 24, 'database password should be generated');

  const envSave = calls.find((call) => call.route === 'application.saveEnvironment');
  assert(envSave.body.env.includes('CLIENT_NAME="Test Client"'), 'CLIENT_NAME should be configured');
  assert(envSave.body.env.includes('DATABASE_URL="postgres://postgres:'), 'DATABASE_URL should be configured');
  assert(envSave.body.env.includes('@client-test-client-baileys-12345678-postgres-abc123:5432/postgres"'), 'DATABASE_URL should point at the created PostgreSQL service');
  assert(envSave.body.env.includes('STORAGE_PATH=./data/contacts.json'), 'JSON storage path should remain for uploads/rollback compatibility');

  assert.strictEqual(current.dokployPostgresId, 'pg_1');
  assert.strictEqual(current.dokployPostgresAppName, 'client-test-client-baileys-12345678-postgres-abc123');
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

  calls.length = 0;
  const legacyClient = {
    ...current,
    dokployPostgresId: undefined,
    dokployPostgresAppName: undefined,
    dokployPostgresDatabaseName: undefined,
    dokployPostgresDatabaseUser: undefined,
    dokployPostgresDatabasePassword: undefined,
  };
  await provisioner.provision(legacyClient, (patch) => ({ ...legacyClient, ...patch }));
  const legacyRoutes = calls.map((call) => call.route);
  assert(legacyRoutes.includes('application.redeploy'), 'legacy client should still be redeployed');
  assert(!legacyRoutes.includes('postgres.create'), 'legacy client must not receive a new PostgreSQL database');
  assert(!legacyRoutes.includes('application.saveEnvironment'), 'legacy client environment must not be overwritten');
  assert(!legacyRoutes.includes('mounts.create'), 'legacy client volume must not be replaced');

  calls.length = 0;
  let metaClient = {
    ...current,
    id: '87654321-90ab-cdef-1234-567890abcdef',
    name: 'Meta Dedicated',
    whatsappProvider: 'META_CLOUD_API',
    dokployApplicationId: undefined,
    dokployAppName: undefined,
    dokployMountId: undefined,
    dokployDomainId: undefined,
    dokployDeploymentRequested: undefined,
    dokployPostgresId: undefined,
    dokployPostgresAppName: undefined,
    dokployPostgresDatabaseName: undefined,
    dokployPostgresDatabaseUser: undefined,
    dokployPostgresDatabasePassword: undefined,
    managementUrl: '',
    metaAccessToken: 'dedicated-token',
    metaPhoneNumberId: '222222222222222',
    metaDisplayPhoneNumber: '972555123456',
    metaVerifyToken: 'dedicated-verify',
  };
  metaClient = await provisioner.provision(metaClient, (patch) => {
    metaClient = { ...metaClient, ...patch };
    return metaClient;
  });
  const metaEnv = calls.find((call) => call.route === 'application.saveEnvironment').body.env;
  assert(metaEnv.includes('META_ACCESS_TOKEN="dedicated-token"'), 'dedicated Meta token should be written when present');
  assert(metaEnv.includes('META_PHONE_NUMBER_ID="222222222222222"'), 'dedicated phone number id should be written when present');
  assert(metaEnv.includes('META_DISPLAY_PHONE_NUMBER="972555123456"'), 'dedicated display phone should be written when present');
  assert(metaEnv.includes('META_VERIFY_TOKEN="dedicated-verify"'), 'dedicated verify token should be written when present');
  assert(metaEnv.includes('META_APP_SECRET="central-app-secret"'), 'central app secret should still be written');
  assert(metaEnv.includes('META_DEDICATED_NUMBER=true'), 'dedicated Meta client should be marked explicitly');
  assert.strictEqual(metaClient.metaPhoneNumberId, '222222222222222');
  assert.strictEqual(metaClient.metaDisplayPhoneNumber, '972555123456');

  // Fallback path: a Meta client with NO dedicated fields of its own (the shape of every one of the
  // 11 existing shared-number clients today) must still fall back to the central DOKPLOY_META_*
  // values, byte for byte - this is the change that could quietly break existing campaigns.
  calls.length = 0;
  let sharedClient = {
    ...current,
    id: 'abcdef12-90ab-cdef-1234-567890abcdef',
    name: 'Meta Shared',
    whatsappProvider: 'META_CLOUD_API',
    dokployApplicationId: undefined,
    dokployAppName: undefined,
    dokployMountId: undefined,
    dokployDomainId: undefined,
    dokployDeploymentRequested: undefined,
    dokployPostgresId: undefined,
    dokployPostgresAppName: undefined,
    dokployPostgresDatabaseName: undefined,
    dokployPostgresDatabaseUser: undefined,
    dokployPostgresDatabasePassword: undefined,
    managementUrl: '',
    // metaAccessToken / metaPhoneNumberId / metaDisplayPhoneNumber / metaVerifyToken intentionally absent.
  };
  sharedClient = await provisioner.provision(sharedClient, (patch) => {
    sharedClient = { ...sharedClient, ...patch };
    return sharedClient;
  });
  const sharedEnv = calls.find((call) => call.route === 'application.saveEnvironment').body.env;
  assert(sharedEnv.includes('META_ACCESS_TOKEN="central-token"'), 'no dedicated token: must fall back to the central shared token');
  assert(sharedEnv.includes('META_PHONE_NUMBER_ID="111111111111111"'), 'no dedicated phone id: must fall back to the shared number');
  assert(sharedEnv.includes('META_DISPLAY_PHONE_NUMBER="972529771002"'), 'no dedicated display phone: must fall back to the shared display number');
  assert(sharedEnv.includes('META_VERIFY_TOKEN="central-verify"'), 'no dedicated verify token: must fall back to the shared verify token');
  assert(sharedEnv.includes('META_APP_SECRET="central-app-secret"'), 'central app secret still written for a shared-number client');
  assert(sharedEnv.includes('META_DEDICATED_NUMBER=false'), 'a shared-number client must be marked as NOT dedicated');
  assert.strictEqual(sharedClient.metaPhoneNumberId, '111111111111111', 'the shared phone number id is recorded on the client too, exactly as before this feature');
  assert.strictEqual(sharedClient.metaDisplayPhoneNumber, '972529771002');

  console.log('Dokploy PostgreSQL provisioning regression passed.');
})();
