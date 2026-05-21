/**
 * storage.ts
 * JSON-file persistence for saved contacts, admin settings, and campaigns.
 */

import fs from 'fs';
import path from 'path';
import { config } from './config';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Campaign {
  id: string;
  name: string;
  triggerType: 1 | 2;
  /** Exact phrase the end-user must send.
   *  Type 1: freely defined by the client.
   *  Type 2: TRIGGER_REFERRAL_PREFIX + referrerName (auto-built on save). */
  triggerPhrase: string;
  /** Type-2 only: the custom base phrase the client wrote (before "הגעתי דרך"). */
  basePhrase?: string;
  /** Type-2 only: the referrer name as entered by the client. */
  referrerName?: string;
  /** Appended to the saved Google Contact name. */
  suffix: string;
  active: boolean;
}

export interface AdminSettings {
  askNameEnabled: boolean;
  nameTimeoutMinutes: number;
  contactsProvider: 'google' | 'icloud' | 'manual';
  icloudEmail: string;
  icloudPassword: string;
  askNameText: string;
  replyText: string;
  followupMessages: string[];
  referralPrefix: string;
  botSuffix: string;
}

export interface SavedContact {
  phone: string;
  name: string;
  savedAt: string;
}

export type ContactSaveStatus = 'pending' | 'saved' | 'failed';

export interface ContactSaveJob {
  id: string;
  phone: string;
  name: string;
  provider: AdminSettings['contactsProvider'];
  status: ContactSaveStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt?: string;
  lastError?: string;
}

interface StorageData {
  savedContacts: string[];
  contactsList: SavedContact[];
  contactQueue: ContactSaveJob[];
  adminSettings: AdminSettings;
  campaigns: Campaign[];
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: AdminSettings = {
  askNameEnabled: false,
  nameTimeoutMinutes: 5,
  contactsProvider: 'google',
  icloudEmail: '',
  icloudPassword: '',
  askNameText: config.ASK_NAME_TEXT,
  replyText: config.REPLY_TEXT,
  followupMessages: [],
  referralPrefix: config.TRIGGER_REFERRAL_PREFIX,
  botSuffix: config.BOT_SUFFIX,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ─── Storage class ────────────────────────────────────────────────────────────

export class Storage {
  private readonly filePath: string;
  private data: StorageData;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.load();
  }

  private load(): StorageData {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      return {
        savedContacts: [],
        contactsList: [],
        contactQueue: [],
        adminSettings: { ...DEFAULT_SETTINGS },
        campaigns: [],
      };
    }
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, 'utf-8'),
      ) as Partial<StorageData> & { adminSettings?: Partial<AdminSettings> & { triggerType?: number } };

      // Migrate: drop legacy triggerType field from adminSettings
      const { triggerType: _legacy, ...cleanSettings } = parsed.adminSettings ?? {};
      const migratedSettings: Partial<AdminSettings> = cleanSettings;

      const contactsList = (parsed as any).contactsList ?? [];
      const existingQueue = (parsed as any).contactQueue;
      const contactQueue = Array.isArray(existingQueue)
        ? existingQueue
        : contactsList.map((contact: SavedContact) => ({
            id: generateId(),
            phone: contact.phone,
            name: contact.name,
            provider: migratedSettings.contactsProvider ?? DEFAULT_SETTINGS.contactsProvider,
            status: 'saved' as const,
            attempts: 1,
            createdAt: contact.savedAt,
            updatedAt: contact.savedAt,
          }));

      return {
        savedContacts: parsed.savedContacts ?? [],
        contactsList,
        contactQueue,
        adminSettings: { ...DEFAULT_SETTINGS, ...migratedSettings },
        campaigns: parsed.campaigns ?? [],
      };
    } catch {
      console.warn('⚠️  Could not parse storage file – starting fresh.');
      return {
        savedContacts: [],
        contactsList: [],
        contactQueue: [],
        adminSettings: { ...DEFAULT_SETTINGS },
        campaigns: [],
      };
    }
  }

  private persist(): void {
    fs.writeFileSync(
      this.filePath,
      JSON.stringify(this.data, null, 2),
      'utf-8',
    );
  }

  // ─── Contacts ──────────────────────────────────────────────────────────────

  isContactSaved(phone: string): boolean {
    return this.data.savedContacts.includes(phone);
  }

  markContactSaved(phone: string, name = ''): void {
    const now = new Date().toISOString();
    const contact = this.data.contactsList.find((item) => item.phone === phone);
    if (!this.isContactSaved(phone)) {
      this.data.savedContacts.push(phone);
    }
    if (contact) {
      contact.name = name || contact.name;
      contact.savedAt = now;
    } else {
      this.data.contactsList.push({ phone, name, savedAt: now });
    }
    const job = this.data.contactQueue.find((item) => item.phone === phone);
    if (job) {
      job.status = 'saved';
      job.name = name || job.name;
      job.updatedAt = now;
      job.nextAttemptAt = undefined;
      job.lastError = undefined;
    }
    this.persist();
  }

  getAllContacts(): SavedContact[] {
    return [...this.data.contactsList];
  }

  enqueueContactSave(phone: string, name: string): ContactSaveJob | null {
    const provider = this.getAdminSettings().contactsProvider;
    const now = new Date().toISOString();

    const existing = this.data.contactQueue.find((item) => item.phone === phone);
    if (existing) {
      if (existing.status === 'saved' || existing.status === 'failed') existing.attempts = 0;
      existing.name = name;
      existing.provider = provider;
      existing.status = 'pending';
      existing.updatedAt = now;
      existing.nextAttemptAt = now;
      existing.lastError = undefined;
      this.persist();
      return { ...existing };
    }

    const job: ContactSaveJob = {
      id: generateId(),
      phone,
      name,
      provider,
      status: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
    };
    this.data.contactQueue.push(job);
    this.persist();
    return { ...job };
  }

  getDueContactSaveJob(now = new Date()): ContactSaveJob | null {
    const due = this.data.contactQueue
      .filter((job) => {
        if (job.status !== 'pending') return false;
        if (!job.nextAttemptAt) return true;
        return new Date(job.nextAttemptAt).getTime() <= now.getTime();
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return due[0] ? { ...due[0] } : null;
  }

  markContactSaveAttempt(jobId: string): ContactSaveJob | null {
    const job = this.data.contactQueue.find((item) => item.id === jobId);
    if (!job) return null;
    job.attempts += 1;
    job.updatedAt = new Date().toISOString();
    this.persist();
    return { ...job };
  }

  markContactSaveFailed(jobId: string, error: string, maxAttempts: number, retryDelayMs: number): ContactSaveJob | null {
    const job = this.data.contactQueue.find((item) => item.id === jobId);
    if (!job) return null;
    const now = Date.now();
    job.status = job.attempts >= maxAttempts ? 'failed' : 'pending';
    job.lastError = error.slice(0, 500);
    job.updatedAt = new Date(now).toISOString();
    job.nextAttemptAt = job.status === 'pending'
      ? new Date(now + retryDelayMs).toISOString()
      : undefined;
    this.persist();
    return { ...job };
  }

  getContactQueueStats(): Record<ContactSaveStatus, number> & { total: number } {
    const stats = { pending: 0, saved: 0, failed: 0, total: this.data.contactQueue.length };
    for (const job of this.data.contactQueue) {
      stats[job.status] += 1;
    }
    return stats;
  }

  getContactQueue(limit = 50): ContactSaveJob[] {
    return [...this.data.contactQueue]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((job) => ({ ...job }));
  }

  // ─── Admin settings ────────────────────────────────────────────────────────

  getAdminSettings(): AdminSettings {
    return { ...this.data.adminSettings };
  }

  updateAdminSettings(patch: Partial<AdminSettings>): AdminSettings {
    this.data.adminSettings = { ...this.data.adminSettings, ...patch };
    this.persist();
    return this.getAdminSettings();
  }

  // ─── Campaigns ─────────────────────────────────────────────────────────────

  getCampaigns(): Campaign[] {
    return [...this.data.campaigns];
  }

  getActiveCampaigns(): Campaign[] {
    return this.data.campaigns.filter((c) => c.active);
  }

  addCampaign(data: Omit<Campaign, 'id'>): Campaign {
    const campaign: Campaign = { id: generateId(), ...data };
    this.data.campaigns.push(campaign);
    this.persist();
    return campaign;
  }

  updateCampaign(id: string, patch: Partial<Omit<Campaign, 'id'>>): Campaign | null {
    const idx = this.data.campaigns.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    this.data.campaigns[idx] = { ...this.data.campaigns[idx], ...patch };
    this.persist();
    return this.data.campaigns[idx];
  }

  deleteCampaign(id: string): boolean {
    const before = this.data.campaigns.length;
    this.data.campaigns = this.data.campaigns.filter((c) => c.id !== id);
    if (this.data.campaigns.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }

  toggleCampaign(id: string): Campaign | null {
    return this.updateCampaign(id, {
      active: !this.data.campaigns.find((c) => c.id === id)?.active,
    });
  }
}
