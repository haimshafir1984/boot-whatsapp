import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type ClientProvisioningStatus = 'pending_setup' | 'pending_railway_setup' | 'provisioning' | 'deploying' | 'ready' | 'failed' | 'disabled';

export interface ManagedClient {
  id: string;
  name: string;
  accessCode: string;
  ownerAccessToken: string;
  plan: 'basic' | 'self_service' | 'advanced';
  readonlyDashboard: boolean;
  maxCampaigns: number;
  serviceExpiresAt?: string;
  whatsappProvider: 'WEB_JS' | 'BAILEYS' | 'TWILIO_API' | 'META_CLOUD_API';
  metaPhoneNumberId?: string;
  metaDisplayPhoneNumber?: string;
  metaAccessToken?: string;
  metaVerifyToken?: string;
  twilioFrom?: string;
  botReplyDelayMs?: number;
  managementUrl: string;
  provisioningStatus: ClientProvisioningStatus;
  railwayServiceId?: string;
  railwayVolumeId?: string;
  railwaySourceAttached?: boolean;
  railwayDeploymentId?: string;
  railwayWorkflowId?: string;
  dokployApplicationId?: string;
  dokployAppName?: string;
  dokployMountId?: string;
  dokployDomainId?: string;
  dokployDeploymentRequested?: boolean;
  provisioningError?: string;
  createdAt: string;
}

const DEFAULT_WHATSAPP_PROVIDER: ManagedClient['whatsappProvider'] = 'BAILEYS';

export class OwnerStorage {
  private readonly filePath: string;
  private clients: ManagedClient[];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.clients = this.load();
    if (this.clients.length) this.persist();
  }

  private load(): ManagedClient[] {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.map((client) => ({
        plan: 'self_service',
        readonlyDashboard: false,
        maxCampaigns: 7,
        whatsappProvider: DEFAULT_WHATSAPP_PROVIDER,
        ownerAccessToken: crypto.randomBytes(32).toString('base64url'),
        ...client,
      }));
    } catch {
      return [];
    }
  }

  private persist(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.clients, null, 2), 'utf-8');
  }

  getClients(): ManagedClient[] {
    return [...this.clients].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getClient(id: string): ManagedClient | null {
    const client = this.clients.find((item) => item.id === id);
    return client ? { ...client } : null;
  }

  addClient(
    name: string,
    accessCode: string,
    options: Partial<Pick<ManagedClient, 'plan' | 'readonlyDashboard' | 'maxCampaigns' | 'serviceExpiresAt' | 'whatsappProvider' | 'twilioFrom' | 'metaPhoneNumberId' | 'metaDisplayPhoneNumber' | 'metaAccessToken' | 'metaVerifyToken' | 'botReplyDelayMs'>> = {},
  ): ManagedClient {
    const plan = options.plan ?? 'self_service';
    const client: ManagedClient = {
      id: crypto.randomUUID(),
      name: name.trim(),
      accessCode: accessCode.trim(),
      ownerAccessToken: crypto.randomBytes(32).toString('base64url'),
      plan,
      readonlyDashboard: options.readonlyDashboard ?? plan === 'basic',
      maxCampaigns: options.maxCampaigns ?? (plan === 'advanced' ? 5 : plan === 'basic' ? 1 : 7),
      serviceExpiresAt: options.serviceExpiresAt,
      whatsappProvider: options.whatsappProvider ?? (plan === 'advanced' ? 'TWILIO_API' : DEFAULT_WHATSAPP_PROVIDER),
      twilioFrom: options.twilioFrom,
      metaPhoneNumberId: options.metaPhoneNumberId,
      metaDisplayPhoneNumber: options.metaDisplayPhoneNumber,
      metaAccessToken: options.metaAccessToken,
      metaVerifyToken: options.metaVerifyToken,
      botReplyDelayMs: options.botReplyDelayMs,
      managementUrl: '',
      provisioningStatus: 'pending_setup',
      createdAt: new Date().toISOString(),
    };
    this.clients.push(client);
    this.persist();
    return client;
  }

  updateClient(id: string, patch: Partial<Omit<ManagedClient, 'id' | 'createdAt'>>): ManagedClient | null {
    const index = this.clients.findIndex((client) => client.id === id);
    if (index === -1) return null;
    this.clients[index] = { ...this.clients[index], ...patch };
    this.persist();
    return { ...this.clients[index] };
  }

  deleteClient(id: string): boolean {
    const before = this.clients.length;
    this.clients = this.clients.filter((client) => client.id !== id);
    if (this.clients.length === before) return false;
    this.persist();
    return true;
  }
}
