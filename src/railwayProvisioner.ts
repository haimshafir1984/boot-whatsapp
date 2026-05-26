import crypto from 'crypto';
import { ManagedClient } from './ownerStorage';

interface RailwayGraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

export interface ClientProvisioningPatch {
  railwayServiceId?: string;
  railwayVolumeId?: string;
  railwayDeploymentId?: string;
  managementUrl?: string;
}

interface RailwayProvisioningConfig {
  endpoint: string;
  token: string;
  tokenHeader: 'Project-Access-Token' | 'Authorization';
  projectId: string;
  environmentId: string;
  repo: string;
  googleCredentialsBase64?: string;
}

function serviceName(client: ManagedClient): string {
  const asciiName = client.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
  return `client-${asciiName || 'account'}-${client.id.slice(0, 8)}`;
}

export class RailwayProvisioner {
  private readonly config: RailwayProvisioningConfig | null;
  readonly configurationError: string | null;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const projectToken = env.RAILWAY_PROJECT_TOKEN?.trim();
    const accountToken = env.RAILWAY_API_TOKEN?.trim();
    const token = projectToken || accountToken;
    const projectId = env.RAILWAY_PROJECT_ID?.trim();
    const environmentId = env.RAILWAY_ENVIRONMENT_ID?.trim();
    const repo = env.RAILWAY_SOURCE_REPO?.trim()
      || (env.RAILWAY_GIT_REPO_OWNER && env.RAILWAY_GIT_REPO_NAME
        ? `${env.RAILWAY_GIT_REPO_OWNER}/${env.RAILWAY_GIT_REPO_NAME}`
        : '');

    const missing = [
      !token && 'RAILWAY_PROJECT_TOKEN',
      !projectId && 'RAILWAY_PROJECT_ID',
      !environmentId && 'RAILWAY_ENVIRONMENT_ID',
      !repo && 'RAILWAY_SOURCE_REPO',
    ].filter(Boolean);

    if (missing.length) {
      this.config = null;
      this.configurationError = `חסרה הגדרת Railway: ${missing.join(', ')}`;
      return;
    }

    this.configurationError = null;
    this.config = {
      endpoint: env.RAILWAY_API_URL?.trim() || 'https://backboard.railway.app/graphql/v2',
      token: token!,
      tokenHeader: projectToken ? 'Project-Access-Token' : 'Authorization',
      projectId: projectId!,
      environmentId: environmentId!,
      repo,
      googleCredentialsBase64: env.GOOGLE_CREDENTIALS_BASE64?.trim(),
    };
  }

  async provision(
    client: ManagedClient,
    saveProgress: (patch: ClientProvisioningPatch) => ManagedClient,
  ): Promise<ManagedClient> {
    if (!this.config) throw new Error(this.configurationError ?? 'Railway is not configured');

    let current = client;
    let createdWithSource = false;
    if (!current.railwayServiceId) {
      const service = await this.graphql<{ serviceCreate: { id: string } }>(
        `mutation serviceCreate($input: ServiceCreateInput!) {
          serviceCreate(input: $input) { id }
        }`,
        {
          input: {
            projectId: this.config.projectId,
            environmentId: this.config.environmentId,
            name: serviceName(current),
            source: {
              repo: this.config.repo,
            },
          },
        },
      );
      current = saveProgress({ railwayServiceId: service.serviceCreate.id });
      createdWithSource = true;
    }

    if (!current.railwayVolumeId) {
      const volume = await this.graphql<{ volumeCreate: { id: string } }>(
        `mutation volumeCreate($input: VolumeCreateInput!) {
          volumeCreate(input: $input) { id }
        }`,
        {
          input: {
            projectId: this.config.projectId,
            environmentId: this.config.environmentId,
            serviceId: current.railwayServiceId,
            mountPath: '/app/data',
            name: `${serviceName(current)}-data`,
          },
        },
      );
      current = saveProgress({ railwayVolumeId: volume.volumeCreate.id });
    }

    const clientOwnerToken = crypto.randomBytes(32).toString('base64url');
    const variables: Record<string, string> = {
      CLIENT_ACCESS_TOKEN: current.accessCode,
      OWNER_ACCESS_TOKEN: clientOwnerToken,
      STORAGE_PATH: './data/contacts.json',
      SESSION_PATH: './data/session',
      GOOGLE_TOKEN_PATH: './data/google-token.json',
      OWNER_STORAGE_PATH: './data/owner/clients.json',
    };
    if (this.config.googleCredentialsBase64) {
      variables.GOOGLE_CREDENTIALS_BASE64 = this.config.googleCredentialsBase64;
    }

    await this.graphql<{ variableCollectionUpsert: boolean }>(
      `mutation variableCollectionUpsert(
        $projectId: String!,
        $environmentId: String!,
        $serviceId: String!,
        $variables: EnvironmentVariables!
      ) {
        variableCollectionUpsert(input: {
          projectId: $projectId,
          environmentId: $environmentId,
          serviceId: $serviceId,
          variables: $variables
        })
      }`,
      {
        projectId: this.config.projectId,
        environmentId: this.config.environmentId,
        serviceId: current.railwayServiceId,
        variables,
      },
    );

    if (!current.managementUrl) {
      const domain = await this.graphql<{ serviceDomainCreate: { domain: string } }>(
        `mutation serviceDomainCreate($input: ServiceDomainCreateInput!) {
          serviceDomainCreate(input: $input) { domain }
        }`,
        {
          input: {
            environmentId: this.config.environmentId,
            serviceId: current.railwayServiceId,
          },
        },
      );
      current = saveProgress({ managementUrl: `https://${domain.serviceDomainCreate.domain}/client/` });
    }

    // Retry can repair a service created before new services were created with a source.
    if (!createdWithSource && !current.railwayDeploymentId) {
      await this.graphql<{ serviceConnect: { id: string } }>(
        `mutation serviceConnect($id: String!, $input: ServiceConnectInput!) {
          serviceConnect(id: $id, input: $input) { id }
        }`,
        {
          id: current.railwayServiceId,
          input: {
            repo: this.config.repo,
          },
        },
      );
    }

    const deployment = await this.graphql<{ serviceInstanceDeployV2: string }>(
      `mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) {
        serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
      }`,
      {
        serviceId: current.railwayServiceId,
        environmentId: this.config.environmentId,
      },
    );
    current = saveProgress({ railwayDeploymentId: deployment.serviceInstanceDeployV2 });

    return current;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const config = this.config!;
    const tokenValue = config.tokenHeader === 'Authorization' ? `Bearer ${config.token}` : config.token;
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [config.tokenHeader]: tokenValue,
      },
      body: JSON.stringify({ query, variables }),
    });
    const result = await response.json() as RailwayGraphQLResponse<T>;
    if (!response.ok || result.errors?.length || !result.data) {
      const message = result.errors?.map((error) => error.message).filter(Boolean).join('; ')
        || `Railway API request failed (${response.status})`;
      throw new Error(message);
    }
    return result.data;
  }
}
