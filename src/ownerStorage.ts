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
  disabledAt?: string;
  disabledReason?: string;
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
  dokployPostgresId?: string;
  dokployPostgresAppName?: string;
  dokployPostgresDatabaseName?: string;
  dokployPostgresDatabaseUser?: string;
  dokployPostgresDatabasePassword?: string;
  provisioningError?: string;
  createdAt: string;
}

const DEFAULT_WHATSAPP_PROVIDER: ManagedClient['whatsappProvider'] = 'BAILEYS';

/** Essential-field check for finding 11, point 3: Array.isArray alone is not
 * enough - `[null]` or a record missing `id` must not be treated as a valid
 * (if empty-ish) registry. */
function isValidClientRecord(raw: unknown): raw is Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  return (
    typeof record.id === 'string' && record.id.trim().length > 0 &&
    typeof record.name === 'string' &&
    typeof record.accessCode === 'string' &&
    typeof record.createdAt === 'string'
  );
}

/**
 * Returns the validated, defaulted client list, or null if `parsed` is not a
 * valid registry at all (wrong shape, invalid record, or duplicate ids).
 * Known defaults are applied for backward compatibility with older files, but
 * they are always overridden by the record's own field via the spread below
 * - never the other way around - so an existing secret/infra id already on a
 * record is never replaced to "rescue" a partially corrupt one.
 */
function validateRegistry(parsed: unknown): ManagedClient[] | null {
  if (!Array.isArray(parsed)) return null;
  const seenIds = new Set<string>();
  const result: ManagedClient[] = [];
  for (const raw of parsed) {
    if (!isValidClientRecord(raw)) return null;
    const id = raw.id as string;
    if (seenIds.has(id)) return null;
    seenIds.add(id);
    result.push({
      plan: 'self_service',
      readonlyDashboard: false,
      maxCampaigns: 7,
      whatsappProvider: DEFAULT_WHATSAPP_PROVIDER,
      ownerAccessToken: crypto.randomBytes(32).toString('base64url'),
      ...raw,
    } as ManagedClient);
  }
  return result;
}

export class OwnerStorage {
  private readonly filePath: string;
  private clients: ManagedClient[];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.clients = this.load();
    // No auto-persist here (finding 11, point 2). The previous code called
    // persist() right after load(), which - on a backup-recovery path - would
    // copy the still-on-disk CORRUPT main file over the good .bak before the
    // rename ever landed a valid main file. The recovered, defaulted state
    // lives correctly in memory already; it reaches disk on the next real
    // mutation (addClient/updateClient/deleteClient), by which point persist()
    // below only backs up a main file it can prove is valid.
  }

  private load(): ManagedClient[] {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const backupPath = `${this.filePath}.bak`;
    const mainExists = fs.existsSync(this.filePath);
    const backupExists = fs.existsSync(backupPath);
    // Only the absence of BOTH files justifies "fresh install". A .bak that
    // exists but is corrupt is an error, not a green light for [] (finding
    // 11, point 1) - checked below by including it in the candidate loop.
    if (!mainExists && !backupExists) return [];

    for (const candidate of [this.filePath, backupPath]) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        const validated = validateRegistry(parsed);
        if (validated === null) {
          // Do not log parsed content or secrets - just that this candidate
          // failed validation.
          console.error(`[OWNER_STORAGE_CORRUPT] ${candidate} does not contain a valid client registry.`);
          continue;
        }
        // A valid main file containing [] is legitimate and returned as-is -
        // this loop only reaches the .bak candidate when the main candidate
        // above failed to parse/validate.
        if (candidate !== this.filePath) {
          console.error(`[OWNER_STORAGE_RECOVERED_FROM_BACKUP] ${this.filePath} was unreadable or invalid; recovered ${validated.length} client(s) from ${candidate}. Fix or remove the corrupt main file - it is kept on disk for diagnosis.`);
        }
        return validated;
      } catch (err) {
        console.error(`[OWNER_STORAGE_CORRUPT] ${candidate} is unreadable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // A file (main and/or .bak) exists but neither could be parsed into a
    // valid registry - this is corruption, not a fresh install. Refusing to
    // start is safer than silently running with an empty client registry,
    // which the next persist() would make permanent (every managed client's
    // Dokploy IDs and tokens gone). This is a deliberate fail-fast crash, not
    // a new degraded mode - see docs/silent-data-loss-fix-plan-review-2026-09-05.md, finding 11.
    throw new Error(
      `Owner storage file ${this.filePath} exists but could not be parsed into a valid client registry, and no usable .bak was found. ` +
      'Refusing to start with an empty client registry - restore from a backup or fix the file manually.',
    );
  }

  /** True only if `filePath` currently holds JSON that validateRegistry() accepts. */
  private isFileValidRegistry(filePath: string): boolean {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return validateRegistry(parsed) !== null;
    } catch {
      return false;
    }
  }

  /**
   * Commit-then-publish (finding 11, point 4 / finding 03's contract applied
   * here too): writes `next` durably and only assigns it to `this.clients`
   * after the write actually lands. A throw at any stage (temp write, backup
   * copy, rename) leaves `this.clients` exactly as it was, so a failed
   * add/update/delete cannot look like it was saved.
   *
   * The backup copy step only fires when the CURRENT on-disk main file is
   * itself provably a valid registry (finding 11, point 2) - a corrupt main
   * file is never copied over a good .bak, and a rename failure during a
   * later repair therefore cannot destroy it either.
   */
  private persistClients(next: ManagedClient[]): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    const backupPath = `${this.filePath}.bak`;
    fs.writeFileSync(tempPath, JSON.stringify(next, null, 2), 'utf-8');
    if (fs.existsSync(this.filePath) && this.isFileValidRegistry(this.filePath)) {
      fs.copyFileSync(this.filePath, backupPath);
    }
    fs.renameSync(tempPath, this.filePath);
    this.clients = next;
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
    // Persist the candidate list first; this.clients is only updated inside
    // persistClients() once the write actually succeeds (finding 11, point 4).
    this.persistClients([...this.clients, client]);
    return client;
  }

  updateClient(id: string, patch: Partial<Omit<ManagedClient, 'id' | 'createdAt'>>): ManagedClient | null {
    const index = this.clients.findIndex((client) => client.id === id);
    if (index === -1) return null;
    const updated = { ...this.clients[index], ...patch };
    const next = this.clients.map((client, i) => (i === index ? updated : client));
    this.persistClients(next);
    return { ...updated };
  }

  deleteClient(id: string): boolean {
    const before = this.clients.length;
    const next = this.clients.filter((client) => client.id !== id);
    if (next.length === before) return false;
    this.persistClients(next);
    return true;
  }
}
