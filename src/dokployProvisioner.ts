import crypto from 'crypto';
import { ManagedClient } from './ownerStorage';

export interface ClientProvisioningPatch {
  dokployApplicationId?: string;
  dokployAppName?: string;
  dokployMountId?: string;
  dokployDomainId?: string;
  dokployDeploymentRequested?: boolean;
  dokployPostgresId?: string;
  dokployPostgresAppName?: string;
  dokployPostgresDatabaseName?: string;
  dokployPostgresDatabaseUser?: string;
  dokployPostgresDatabasePassword?: string;
  managementUrl?: string;
  metaPhoneNumberId?: string;
  metaDisplayPhoneNumber?: string;
}

export interface ClientDeletionResult {
  deleted: string[];
  warnings: string[];
}

interface DokployProvisioningConfig {
  endpoint: string;
  token: string;
  environmentId: string;
  gitUrl: string;
  gitBranch: string;
  domainSuffix: string;
  domainHttps: boolean;
  googleClientId?: string;
  googleClientSecret?: string;
  googleOauthCallbackUrl?: string;
  googleOauthStateSecret?: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFrom?: string;
  twilioMessagingServiceSid?: string;
  twilioWebhookToken?: string;
  twilioQuickReplyContentSid?: string;
  twilioListPickerContentSid?: string;
  twilioMediaBaseUrl?: string;
  metaAccessToken?: string;
  metaPhoneNumberId?: string;
  metaDisplayPhoneNumber?: string;
  metaVerifyToken?: string;
  metaAppSecret?: string;
  metaWebhookUrl?: string;
  botReplyDelayMs?: number;
}

interface DokployApplication {
  applicationId: string;
  appName: string;
}

interface DokployMount {
  mountId: string;
}

interface DokployDomain {
  domainId: string;
}

interface DokployPostgres {
  postgresId: string;
  appName: string;
  databaseName: string;
  databaseUser: string;
  databasePassword: string;
}

/**
 * One row of `GET /api/deployment.all?applicationId=...`. Field names are copied
 * from the Dokploy plan (docs/decision-recovery-scale-fix-plan-2026-09-03.md
 * §B.1) and were NOT independently re-verified against a live Dokploy instance
 * here - see the results doc. `status` is 'running' | 'done' | 'error' | ...
 */
interface DokployDeployment {
  deploymentId: string;
  title: string;
  description?: string;
  status: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  errorMessage?: string;
}

export interface RedeployExistingClientResult {
  ok: boolean;
  /** true when the client has no Dokploy application yet - nothing was called. */
  skipped?: boolean;
  error?: string;
  /** true when the transient-clone retry path ran. */
  retried?: boolean;
}

export interface RedeployExistingClientOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Delay before the single transient-clone retry. */
  retryDelayMs?: number;
  /** Test seam - defaults to a real setTimeout-based sleep. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * A redeploy failure that is safe to retry once: an anonymous `git clone` that
 * lost the race with GitHub's rate limiter, not a real auth/config problem.
 * A genuine permission error (revoked token, deleted repo) must NOT match here -
 * a blind retry only hides it.
 */
const TRANSIENT_CLONE_ERROR = /could not read Username|fatal: could not read/i;

const DEFAULT_REDEPLOY_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_REDEPLOY_POLL_INTERVAL_MS = 5_000;
const DEFAULT_REDEPLOY_RETRY_DELAY_MS = 45_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const HEBREW_SERVICE_SLUGS: Record<string, string> = {
  '\u05d0': 'a', '\u05d1': 'b', '\u05d2': 'g', '\u05d3': 'd', '\u05d4': 'h', '\u05d5': 'v', '\u05d6': 'z', '\u05d7': 'h', '\u05d8': 't', '\u05d9': 'y',
  '\u05db': 'k', '\u05da': 'k', '\u05dc': 'l', '\u05de': 'm', '\u05dd': 'm', '\u05e0': 'n', '\u05df': 'n', '\u05e1': 's', '\u05e2': 'a', '\u05e4': 'p', '\u05e3': 'p',
  '\u05e6': 'ts', '\u05e5': 'ts', '\u05e7': 'k', '\u05e8': 'r', '\u05e9': 'sh', '\u05ea': 't',
};

function legacyServiceName(client: ManagedClient): string {
  const asciiName = client.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
  return `client-${asciiName || 'account'}-${client.id.slice(0, 8)}`;
}

function serviceName(client: ManagedClient): string {
  // Existing services keep their legacy address and persistent resource names.
  if (client.dokployApplicationId) return legacyServiceName(client);
  const transliterated = Array.from(client.name.normalize('NFKD'))
    .map((character) => HEBREW_SERVICE_SLUGS[character] ?? character)
    .join('');
  const clientSlug = transliterated
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20);
  const provider = client.whatsappProvider === 'META_CLOUD_API' ? 'meta' : 'baileys';
  return `client-${clientSlug || 'account'}-${provider}-${client.id.slice(0, 8)}`;
}

function escapeEnvValue(value: string): string {
  return JSON.stringify(value);
}

function generateDatabasePassword(): string {
  return crypto.randomBytes(24).toString('base64url').slice(0, 32);
}

function hasRecordedPostgres(client: ManagedClient): boolean {
  return Boolean(
    client.dokployPostgresId
    && client.dokployPostgresAppName
    && client.dokployPostgresDatabaseName
    && client.dokployPostgresDatabaseUser
    && client.dokployPostgresDatabasePassword,
  );
}

function databaseUrl(client: ManagedClient): string {
  if (!hasRecordedPostgres(client)) {
    throw new Error('PostgreSQL provisioning is incomplete for this client.');
  }
  return `postgres://${encodeURIComponent(client.dokployPostgresDatabaseUser!)}:${encodeURIComponent(client.dokployPostgresDatabasePassword!)}@${client.dokployPostgresAppName!}:5432/${encodeURIComponent(client.dokployPostgresDatabaseName!)}`;
}

function clientBaseUrl(config: DokployProvisioningConfig, service: string): string {
  const protocol = config.domainHttps ? 'https' : 'http';
  return `${protocol}://${service}.${config.domainSuffix}`;
}

function clientTwilioMediaBaseUrl(config: DokployProvisioningConfig, service: string, current: ManagedClient): string {
  if (config.twilioMediaBaseUrl) return config.twilioMediaBaseUrl;
  const baseUrl = current.managementUrl
    ? new URL('/', current.managementUrl).toString().replace(/\/$/, '')
    : clientBaseUrl(config, service);
  return `${baseUrl}/twilio-media`;
}

export class DokployProvisioner {
  private readonly config: DokployProvisioningConfig | null;
  private provisioningQueue: Promise<void> = Promise.resolve();
  readonly configurationError: string | null;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const token = env.DOKPLOY_API_TOKEN?.trim();
    const environmentId = env.DOKPLOY_ENVIRONMENT_ID?.trim();
    const gitUrl = env.DOKPLOY_GIT_URL?.trim();
    const domainSuffix = env.DOKPLOY_CLIENT_DOMAIN_SUFFIX?.trim()?.replace(/^\./, '');
    const googleClientId = env.DOKPLOY_GOOGLE_CLIENT_ID?.trim();
    const googleClientSecret = env.DOKPLOY_GOOGLE_CLIENT_SECRET?.trim();
    const googleOauthCallbackUrl = env.DOKPLOY_GOOGLE_OAUTH_CALLBACK_URL?.trim();
    const googleOauthStateSecret = env.DOKPLOY_GOOGLE_OAUTH_STATE_SECRET?.trim();
    const twilioAccountSid = env.DOKPLOY_TWILIO_ACCOUNT_SID?.trim();
    const twilioAuthToken = env.DOKPLOY_TWILIO_AUTH_TOKEN?.trim();
    const twilioFrom = env.DOKPLOY_TWILIO_FROM?.trim();
    const twilioMessagingServiceSid = env.DOKPLOY_TWILIO_MESSAGING_SERVICE_SID?.trim();
    const twilioWebhookToken = env.DOKPLOY_TWILIO_WEBHOOK_TOKEN?.trim();
    const twilioQuickReplyContentSid = env.DOKPLOY_TWILIO_QUICK_REPLY_CONTENT_SID?.trim();
    const twilioListPickerContentSid = env.DOKPLOY_TWILIO_LIST_PICKER_CONTENT_SID?.trim();
    const twilioMediaBaseUrl = env.DOKPLOY_TWILIO_MEDIA_BASE_URL?.trim();
    const metaAccessToken = env.DOKPLOY_META_ACCESS_TOKEN?.trim();
    const metaPhoneNumberId = env.DOKPLOY_META_PHONE_NUMBER_ID?.trim();
    const metaDisplayPhoneNumber = env.DOKPLOY_META_DISPLAY_PHONE_NUMBER?.trim();
    const metaVerifyToken = env.DOKPLOY_META_VERIFY_TOKEN?.trim();
    const metaAppSecret = env.DOKPLOY_META_APP_SECRET?.trim();
    const metaWebhookUrl = env.DOKPLOY_META_WEBHOOK_URL?.trim() || 'https://admin.flowsbiz.com/webhooks/meta/whatsapp';
    const botReplyDelayMs = Number(env.DOKPLOY_BOT_REPLY_DELAY_MS);
    const missing = [
      !token && 'DOKPLOY_API_TOKEN',
      !environmentId && 'DOKPLOY_ENVIRONMENT_ID',
      !gitUrl && 'DOKPLOY_GIT_URL',
      !domainSuffix && 'DOKPLOY_CLIENT_DOMAIN_SUFFIX',
    ].filter(Boolean);

    if (missing.length) {
      this.config = null;
      this.configurationError = `Missing Dokploy configuration: ${missing.join(', ')}`;
      return;
    }
    if (Boolean(googleClientId) !== Boolean(googleClientSecret)) {
      this.config = null;
      this.configurationError = 'DOKPLOY_GOOGLE_CLIENT_ID and DOKPLOY_GOOGLE_CLIENT_SECRET must be configured together';
      return;
    }
    if (Boolean(googleOauthCallbackUrl) !== Boolean(googleOauthStateSecret)) {
      this.config = null;
      this.configurationError = 'DOKPLOY_GOOGLE_OAUTH_CALLBACK_URL and DOKPLOY_GOOGLE_OAUTH_STATE_SECRET must be configured together';
      return;
    }

    this.configurationError = null;
    this.config = {
      endpoint: (env.DOKPLOY_API_URL?.trim() || 'http://127.0.0.1:3000/api').replace(/\/$/, ''),
      token: token!,
      environmentId: environmentId!,
      gitUrl: gitUrl!,
      gitBranch: env.DOKPLOY_GIT_BRANCH?.trim() || 'master',
      domainSuffix: domainSuffix!,
      domainHttps: env.DOKPLOY_CLIENT_DOMAIN_HTTPS?.trim().toLowerCase() !== 'false',
      googleClientId,
      googleClientSecret,
      googleOauthCallbackUrl,
      googleOauthStateSecret,
      twilioAccountSid,
      twilioAuthToken,
      twilioFrom,
      twilioMessagingServiceSid,
      twilioWebhookToken,
      twilioQuickReplyContentSid,
      twilioListPickerContentSid,
      twilioMediaBaseUrl,
      metaAccessToken,
      metaPhoneNumberId,
      metaDisplayPhoneNumber,
      metaVerifyToken,
      metaAppSecret,
      metaWebhookUrl,
      botReplyDelayMs: Number.isFinite(botReplyDelayMs) && botReplyDelayMs >= 0 ? Math.round(botReplyDelayMs) : undefined,
    };
  }

  async provision(
    client: ManagedClient,
    saveProgress: (patch: ClientProvisioningPatch) => ManagedClient,
  ): Promise<ManagedClient> {
    const pending = this.provisioningQueue.then(() => this.runProvision(client, saveProgress));
    this.provisioningQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async deleteClientResources(client: ManagedClient): Promise<ClientDeletionResult> {
    if (!this.config) throw new Error(this.configurationError ?? 'Dokploy is not configured');

    const deleted: string[] = [];
    const warnings: string[] = [];

    const remove = async (label: string, route: string, body: Record<string, unknown>) => {
      try {
        await this.post(route, body);
        deleted.push(label);
      } catch (err: any) {
        warnings.push(`${label}: ${err?.message ?? String(err)}`);
      }
    };

    console.log(`Dokploy deletion requested for client ${client.id}.`);
    if (client.dokployDomainId) {
      await remove('domain', 'domain.delete', { domainId: client.dokployDomainId });
    }
    if (client.dokployMountId) {
      await remove('mount', 'mounts.remove', { mountId: client.dokployMountId });
    }
    if (client.dokployPostgresId) {
      await remove('postgres', 'postgres.delete', { postgresId: client.dokployPostgresId });
    }
    if (client.dokployApplicationId) {
      await remove('application', 'application.delete', { applicationId: client.dokployApplicationId });
    }

    return { deleted, warnings };
  }

  /**
   * Rebuilds an already-provisioned client with the current code and waits for
   * the build to actually finish. This path deliberately touches NOTHING but
   * `application.redeploy` - no saveGitProvider / saveEnvironment / saveBuildType
   * / mounts.create / postgres.create / domain.create / application.deploy. The
   * bulk "redeploy every client" button used to call provisionClient(), whose
   * unconditional saveGitProvider reset every client's Git provider to "Custom"
   * with no credentials and broke `git clone` fleet-wide (2026-09-03). Config
   * changes are a separate, explicit action (provisionClient / the "update
   * configuration" flow), never a side effect of a redeploy.
   */
  async redeployExistingClient(
    client: ManagedClient,
    options: RedeployExistingClientOptions = {},
  ): Promise<RedeployExistingClientResult> {
    if (!this.config) throw new Error(this.configurationError ?? 'Dokploy is not configured');
    if (!client.dokployApplicationId) {
      return {
        ok: false,
        skipped: true,
        error: 'Client has no Dokploy application yet - provision it explicitly before redeploying.',
      };
    }

    const applicationId = client.dokployApplicationId;
    const timeoutMs = options.timeoutMs ?? DEFAULT_REDEPLOY_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_REDEPLOY_POLL_INTERVAL_MS;
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_REDEPLOY_RETRY_DELAY_MS;
    const sleepFn = options.sleepFn ?? defaultSleep;

    let attemptSeq = 0;
    const runOnce = async (): Promise<{ ok: boolean; error?: string }> => {
      // Unique per attempt (timestamp + per-call counter + random) so polling
      // can identify OUR deployment by title even if an unrelated
      // manual/Autodeploy build starts on the same application at the same
      // moment, and so the retry can never collide with the first attempt.
      attemptSeq += 1;
      const title = `Bulk redeploy ${client.id} ${Date.now()}-${attemptSeq}-${crypto.randomBytes(4).toString('hex')}`;
      await this.post('application.redeploy', {
        applicationId,
        title,
        description: 'Redeploy existing client with current code - no configuration changes',
      });
      return this.waitForTitledDeployment(applicationId, title, timeoutMs, pollIntervalMs, sleepFn);
    };

    const first = await runOnce();
    if (first.ok) return { ok: true };
    if (!first.error || !TRANSIENT_CLONE_ERROR.test(first.error)) {
      return { ok: false, error: first.error };
    }

    console.warn(`Bulk redeploy: transient clone failure for client ${client.id}, retrying once after ${retryDelayMs}ms: ${first.error}`);
    await sleepFn(retryDelayMs);
    const second = await runOnce();
    return second.ok
      ? { ok: true, retried: true }
      : { ok: false, retried: true, error: second.error };
  }

  /**
   * Polls `GET /api/deployment.all` for the deployment whose title we sent.
   * Two-phase: first resolve `title` -> `deploymentId`, then follow only that
   * id to a terminal `status`. Anything newer or unrelated on the same
   * application is ignored, so a parallel build cannot make us report success
   * (or failure) early.
   */
  private async waitForTitledDeployment(
    applicationId: string,
    title: string,
    timeoutMs: number,
    pollIntervalMs: number,
    sleepFn: (ms: number) => Promise<void>,
  ): Promise<{ ok: boolean; error?: string }> {
    const deadline = Date.now() + timeoutMs;
    let trackedId: string | undefined;
    while (Date.now() < deadline) {
      let deployments: DokployDeployment[];
      try {
        deployments = await this.getJson<DokployDeployment[]>('deployment.all', { applicationId });
      } catch (err: any) {
        // A transient API hiccup should not abort the wait; keep polling until
        // the deadline.
        console.warn(`Bulk redeploy: deployment.all poll failed for ${applicationId}: ${err?.message ?? String(err)}`);
        await sleepFn(pollIntervalMs);
        continue;
      }
      const rows = Array.isArray(deployments) ? deployments : [];
      if (!trackedId) {
        const match = rows.find((row) => row.title === title);
        if (match) trackedId = match.deploymentId;
      }
      if (trackedId) {
        const tracked = rows.find((row) => row.deploymentId === trackedId);
        if (tracked?.status === 'done') return { ok: true };
        if (tracked?.status === 'error') {
          return { ok: false, error: tracked.errorMessage || 'Deployment failed' };
        }
      }
      await sleepFn(pollIntervalMs);
    }
    return { ok: false, error: `Deployment did not finish within ${Math.round(timeoutMs / 1000)}s` };
  }

  getMetaRoutingConfig(): { phoneNumberId: string; displayPhoneNumber: string } | null {
    if (!this.config?.metaPhoneNumberId || !this.config.metaDisplayPhoneNumber || !this.config.metaAccessToken || !this.config.metaVerifyToken) {
      return null;
    }
    return {
      phoneNumberId: this.config.metaPhoneNumberId,
      displayPhoneNumber: this.config.metaDisplayPhoneNumber,
    };
  }

  getMetaWebhookUrl(client: ManagedClient): string {
    if (client.whatsappProvider !== 'META_CLOUD_API') return '';
    return this.config?.metaWebhookUrl || '';
  }

  getTwilioWebhookUrl(client: ManagedClient): string {
    if (client.whatsappProvider !== 'TWILIO_API' || !client.managementUrl || !this.config?.twilioWebhookToken) {
      return '';
    }
    const url = new URL('/webhooks/twilio/whatsapp', client.managementUrl);
    url.searchParams.set('token', this.config.twilioWebhookToken);
    return url.toString();
  }

  private async runProvision(
    client: ManagedClient,
    saveProgress: (patch: ClientProvisioningPatch) => ManagedClient,
  ): Promise<ManagedClient> {
    if (!this.config) throw new Error(this.configurationError ?? 'Dokploy is not configured');
    this.assertClientProvisioningConfig(client);

    let current = client;
    const provisionPostgresForNewClient = !current.dokployApplicationId;
    // Some clients were migrated before PostgreSQL details were recorded in owner storage.
    // Keep their live Dokploy environment intact until their metadata is reconciled.
    const preserveExistingEnvironment = Boolean(current.dokployApplicationId && !hasRecordedPostgres(current));
    const name = serviceName(current);
    console.log(`Dokploy provisioning started: ${name}.`);

    if (!current.dokployApplicationId) {
      const application = await this.post<DokployApplication>('application.create', {
        name: `${name}-app`,
        appName: `${name}-app`,
        description: `Isolated WhatsApp bot for ${current.name} (${current.whatsappProvider})`,
        environmentId: this.config.environmentId,
        serverId: null,
      });
      current = saveProgress({
        dokployApplicationId: application.applicationId,
        dokployAppName: application.appName,
      });
      console.log(`Dokploy provisioning: application created for ${name}.`);
    }

    const applicationId = current.dokployApplicationId!;

    if (!current.dokployMountId && !preserveExistingEnvironment) {
      const mount = await this.post<DokployMount>('mounts.create', {
        type: 'volume',
        volumeName: `${name}-data`,
        mountPath: '/app/data',
        serviceType: 'application',
        serviceId: applicationId,
      });
      current = saveProgress({ dokployMountId: mount.mountId });
      console.log(`Dokploy provisioning: persistent volume created for ${name}.`);
    }

    if (!hasRecordedPostgres(current) && provisionPostgresForNewClient) {
      const postgres = await this.post<DokployPostgres>('postgres.create', {
        name: `${name}-postgres`,
        appName: `${name}-postgres`,
        description: `PostgreSQL storage for ${current.name} (${current.whatsappProvider})`,
        dockerImage: 'postgres:18',
        databaseName: 'postgres',
        databaseUser: 'postgres',
        databasePassword: generateDatabasePassword(),
        environmentId: this.config.environmentId,
        serverId: null,
      });
      current = saveProgress({
        dokployPostgresId: postgres.postgresId,
        dokployPostgresAppName: postgres.appName,
        dokployPostgresDatabaseName: postgres.databaseName,
        dokployPostgresDatabaseUser: postgres.databaseUser,
        dokployPostgresDatabasePassword: postgres.databasePassword,
      });
      console.log(`Dokploy provisioning: PostgreSQL created for ${name}.`);
      await this.post('postgres.deploy', { postgresId: postgres.postgresId });
      console.log(`Dokploy provisioning: PostgreSQL deployment requested for ${name}.`);
    }
    if (preserveExistingEnvironment) {
      console.warn(`Dokploy provisioning: preserving the existing environment for ${name}; PostgreSQL metadata is not recorded in owner storage.`);
    }

    await this.post('application.saveBuildType', {
      applicationId,
      buildType: 'dockerfile',
      dockerfile: 'Dockerfile',
      dockerContextPath: '/',
      dockerBuildStage: null,
      herokuVersion: null,
      railpackVersion: null,
      publishDirectory: null,
      isStaticSpa: null,
    });

    await this.post('application.saveGitProvider', {
      applicationId,
      customGitUrl: this.config.gitUrl,
      customGitBranch: this.config.gitBranch,
      customGitBuildPath: '/',
      customGitSSHKeyId: null,
      watchPaths: null,
      enableSubmodules: false,
    });

    if (!preserveExistingEnvironment) {
      const envLines = [
      `CLIENT_ACCESS_TOKEN=${escapeEnvValue(current.accessCode)}`,
      `OWNER_ACCESS_TOKEN=${escapeEnvValue(current.ownerAccessToken)}`,
      `CLIENT_NAME=${escapeEnvValue(current.name)}`,
      `CLIENT_PLAN=${escapeEnvValue(current.plan)}`,
      `CLIENT_READONLY_DASHBOARD=${current.readonlyDashboard ? 'true' : 'false'}`,
      `CLIENT_MAX_CAMPAIGNS=${String(current.maxCampaigns)}`,
      'CLIENT_REFERRAL_CONTEST_ENABLED=true',
      `WHATSAPP_PROVIDER=${escapeEnvValue(current.whatsappProvider)}`,
      'WHATSAPP_KEEP_CONNECTED=true',
      'BAILEYS_FALLBACK_TO_WEBJS=false',
      `DATABASE_URL=${escapeEnvValue(databaseUrl(current))}`,
      'STORAGE_PATH=./data/contacts.json',
      'SESSION_PATH=./data/session',
      'GOOGLE_TOKEN_PATH=./data/google-token.json',
      'CONVERSATION_STATE_PATH=./data/conversation-state.json',
      'OWNER_STORAGE_PATH=./data/owner/clients.json',
      'PORT=3001',
    ];
    if (current.serviceExpiresAt) {
      envLines.push(`CLIENT_SERVICE_EXPIRES_AT=${escapeEnvValue(current.serviceExpiresAt)}`);
    }
    const botReplyDelayMs = current.botReplyDelayMs ?? this.config.botReplyDelayMs ?? (current.whatsappProvider === 'META_CLOUD_API' ? 250 : 1000);
    if (typeof botReplyDelayMs === 'number') {
      envLines.push(`BOT_REPLY_DELAY_MS=${String(Math.max(0, Math.round(botReplyDelayMs)))}`);
    }
    if (this.config.googleClientId && this.config.googleClientSecret) {
      envLines.push(`GOOGLE_CLIENT_ID=${escapeEnvValue(this.config.googleClientId)}`);
      envLines.push(`GOOGLE_CLIENT_SECRET=${escapeEnvValue(this.config.googleClientSecret)}`);
    }
    if (this.config.googleOauthCallbackUrl && this.config.googleOauthStateSecret) {
      envLines.push(`GOOGLE_OAUTH_CALLBACK_URL=${escapeEnvValue(this.config.googleOauthCallbackUrl)}`);
      envLines.push(`GOOGLE_OAUTH_STATE_SECRET=${escapeEnvValue(this.config.googleOauthStateSecret)}`);
    }
    if (current.whatsappProvider === 'TWILIO_API') {
      const twilioFrom = current.twilioFrom || this.config.twilioFrom;
      envLines.push(`TWILIO_ACCOUNT_SID=${escapeEnvValue(this.config.twilioAccountSid!)}`);
      envLines.push(`TWILIO_AUTH_TOKEN=${escapeEnvValue(this.config.twilioAuthToken!)}`);
      if (twilioFrom) envLines.push(`TWILIO_FROM=${escapeEnvValue(twilioFrom)}`);
      if (this.config.twilioMessagingServiceSid) envLines.push(`TWILIO_MESSAGING_SERVICE_SID=${escapeEnvValue(this.config.twilioMessagingServiceSid)}`);
      envLines.push(`TWILIO_WEBHOOK_TOKEN=${escapeEnvValue(this.config.twilioWebhookToken!)}`);
      if (this.config.twilioQuickReplyContentSid) envLines.push(`TWILIO_QUICK_REPLY_CONTENT_SID=${escapeEnvValue(this.config.twilioQuickReplyContentSid)}`);
      if (this.config.twilioListPickerContentSid) envLines.push(`TWILIO_LIST_PICKER_CONTENT_SID=${escapeEnvValue(this.config.twilioListPickerContentSid)}`);
      envLines.push(`DOKPLOY_TWILIO_MEDIA_BASE_URL=${escapeEnvValue(clientTwilioMediaBaseUrl(this.config, name, current))}`);
      envLines.push('TWILIO_REQUIRE_SIGNATURE=true');
    }
    if (current.whatsappProvider === 'META_CLOUD_API') {
      current = saveProgress({
        metaPhoneNumberId: this.config.metaPhoneNumberId,
        metaDisplayPhoneNumber: this.config.metaDisplayPhoneNumber,
      });
      envLines.push('META_ACCESS_TOKEN=' + escapeEnvValue(this.config.metaAccessToken!));
      envLines.push('META_PHONE_NUMBER_ID=' + escapeEnvValue(this.config.metaPhoneNumberId!));
      envLines.push('META_DISPLAY_PHONE_NUMBER=' + escapeEnvValue(this.config.metaDisplayPhoneNumber!));
      envLines.push('META_VERIFY_TOKEN=' + escapeEnvValue(this.config.metaVerifyToken!));
      if (this.config.metaAppSecret) envLines.push('META_APP_SECRET=' + escapeEnvValue(this.config.metaAppSecret));
      envLines.push('META_GRAPH_API_VERSION="v23.0"');
      envLines.push('META_GATEWAY_BASE_URL=' + escapeEnvValue(new URL('/', this.config.metaWebhookUrl!).toString().replace(/\/$/, '')));
    }

      await this.post('application.saveEnvironment', {
        applicationId,
        env: envLines.join('\n'),
        buildArgs: null,
        buildSecrets: null,
        createEnvFile: false,
      });
      console.log(`Dokploy provisioning: application configured for ${name}.`);
    }

    if (!current.dokployDomainId && !preserveExistingEnvironment) {
      const host = `${name}.${this.config.domainSuffix}`;
      const domain = await this.post<DokployDomain>('domain.create', {
        host,
        path: '/',
        port: 3001,
        https: this.config.domainHttps,
        applicationId,
        certificateType: this.config.domainHttps ? 'letsencrypt' : 'none',
        stripPath: false,
      });
      const protocol = this.config.domainHttps ? 'https' : 'http';
      current = saveProgress({
        dokployDomainId: domain.domainId,
        managementUrl: `${protocol}://${host}/client/`,
      });
      console.log(`Dokploy provisioning: domain created for ${name}.`);
    }

    if (current.dokployDeploymentRequested) {
      await this.post('application.redeploy', {
        applicationId,
        title: `Update ${name}`,
        description: 'Apply isolated client configuration',
      });
    } else {
      await this.post('application.deploy', { applicationId });
      current = saveProgress({ dokployDeploymentRequested: true });
    }
    console.log(`Dokploy provisioning: deployment requested for ${name}.`);
    return current;
  }

  private assertClientProvisioningConfig(client: ManagedClient): void {
    if (client.whatsappProvider === 'META_CLOUD_API') {
      const missing = [
        !this.config?.metaAccessToken && 'DOKPLOY_META_ACCESS_TOKEN',
        !this.config?.metaPhoneNumberId && 'DOKPLOY_META_PHONE_NUMBER_ID',
        !this.config?.metaDisplayPhoneNumber && 'DOKPLOY_META_DISPLAY_PHONE_NUMBER',
        !this.config?.metaVerifyToken && 'DOKPLOY_META_VERIFY_TOKEN',
      ].filter(Boolean);
      if (missing.length) throw new Error('Meta client configuration is missing: ' + missing.join(', '));
      return;
    }
    if (client.whatsappProvider !== 'TWILIO_API') return;
    const missing = [
      !this.config?.twilioAccountSid && 'DOKPLOY_TWILIO_ACCOUNT_SID',
      !this.config?.twilioAuthToken && 'DOKPLOY_TWILIO_AUTH_TOKEN',
      !(client.twilioFrom || this.config?.twilioFrom || this.config?.twilioMessagingServiceSid) && 'client Twilio number or DOKPLOY_TWILIO_FROM or DOKPLOY_TWILIO_MESSAGING_SERVICE_SID',
      !this.config?.twilioWebhookToken && 'DOKPLOY_TWILIO_WEBHOOK_TOKEN',
    ].filter(Boolean);
    if (missing.length) {
      throw new Error(`Advanced/Twilio clients cannot be provisioned until these admin environment variables are configured: ${missing.join(', ')}`);
    }
  }

  private async post<T = unknown>(route: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.config!.endpoint}/${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config!.token,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text || `Dokploy API request failed (${response.status})`;
      try {
        const parsed = JSON.parse(text) as { message?: string; error?: string };
        message = parsed.message || parsed.error || message;
      } catch {
        // Keep text response when it is not JSON.
      }
      throw new Error(message);
    }
    return text ? JSON.parse(text) as T : undefined as T;
  }

  private async getJson<T = unknown>(route: string, query: Record<string, string>): Promise<T> {
    const url = new URL(`${this.config!.endpoint}/${route}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'x-api-key': this.config!.token },
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text || `Dokploy API GET ${route} failed (${response.status})`;
      try {
        const parsed = JSON.parse(text) as { message?: string; error?: string };
        message = parsed.message || parsed.error || message;
      } catch {
        // Keep text response when it is not JSON.
      }
      throw new Error(message);
    }
    return text ? JSON.parse(text) as T : undefined as T;
  }
}
