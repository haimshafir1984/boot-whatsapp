import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type ClientProvisioningStatus = 'pending_railway_setup' | 'ready' | 'disabled';

export interface ManagedClient {
  id: string;
  name: string;
  accessCode: string;
  managementUrl: string;
  provisioningStatus: ClientProvisioningStatus;
  createdAt: string;
}

export class OwnerStorage {
  private readonly filePath: string;
  private clients: ManagedClient[];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.clients = this.load();
  }

  private load(): ManagedClient[] {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      return Array.isArray(parsed) ? parsed : [];
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

  addClient(name: string, accessCode: string): ManagedClient {
    const client: ManagedClient = {
      id: crypto.randomUUID(),
      name: name.trim(),
      accessCode: accessCode.trim(),
      managementUrl: '',
      provisioningStatus: 'pending_railway_setup',
      createdAt: new Date().toISOString(),
    };
    this.clients.push(client);
    this.persist();
    return client;
  }
}
