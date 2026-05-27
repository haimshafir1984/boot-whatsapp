import crypto from 'crypto';
import { ManagedClient } from './ownerStorage';

export interface ClientProvisioningPatch {
  dokployApplicationId?: string;
  dokployAppName?: string;
  dokployMountId?: string;
  dokployDomainId?: string;
  dokployDeploymentRequested?: boolean;
  managementUrl?: string;
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

function serviceName(client: ManagedClient): string {
  const asciiName = client.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
  return `client-${asciiName || 'account'}-${client.id.slice(0, 8)}`;
}

function escapeEnvValue(value: string): string {
  return JSON.stringify(value);
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
    if (client.dokployApplicationId) {
      await remove('application', 'application.delete', { applicationId: client.dokployApplicationId });
    }

    return { deleted, warnings };
  }

  private async runProvision(
    client: ManagedClient,
    saveProgress: (patch: ClientProvisioningPatch) => ManagedClient,
  ): Promise<ManagedClient> {
    if (!this.config) throw new Error(this.configurationError ?? 'Dokploy is not configured');

    let current = client;
    const name = serviceName(current);
    console.log(`Dokploy provisioning started: ${name}.`);

    if (!current.dokployApplicationId) {
      const application = await this.post<DokployApplication>('application.create', {
        name,
        appName: name,
        description: `Isolated WhatsApp bot for ${current.name}`,
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

    if (!current.dokployMountId) {
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

    const ownerToken = crypto.randomBytes(32).toString('base64url');
    const envLines = [
      `CLIENT_ACCESS_TOKEN=${escapeEnvValue(current.accessCode)}`,
      `OWNER_ACCESS_TOKEN=${escapeEnvValue(ownerToken)}`,
      'STORAGE_PATH=./data/contacts.json',
      'SESSION_PATH=./data/session',
      'GOOGLE_TOKEN_PATH=./data/google-token.json',
      'OWNER_STORAGE_PATH=./data/owner/clients.json',
      'PORT=3001',
    ];
    if (this.config.googleClientId && this.config.googleClientSecret) {
      envLines.push(`GOOGLE_CLIENT_ID=${escapeEnvValue(this.config.googleClientId)}`);
      envLines.push(`GOOGLE_CLIENT_SECRET=${escapeEnvValue(this.config.googleClientSecret)}`);
    }
    if (this.config.googleOauthCallbackUrl && this.config.googleOauthStateSecret) {
      envLines.push(`GOOGLE_OAUTH_CALLBACK_URL=${escapeEnvValue(this.config.googleOauthCallbackUrl)}`);
      envLines.push(`GOOGLE_OAUTH_STATE_SECRET=${escapeEnvValue(this.config.googleOauthStateSecret)}`);
    }

    await this.post('application.saveEnvironment', {
      applicationId,
      env: envLines.join('\n'),
      buildArgs: null,
      buildSecrets: null,
      createEnvFile: false,
    });
    console.log(`Dokploy provisioning: application configured for ${name}.`);

    if (!current.dokployDomainId) {
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
}
