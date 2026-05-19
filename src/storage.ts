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
}

export interface SavedContact {
  phone: string;
  name: string;
  savedAt: string;
}

interface StorageData {
  savedContacts: string[];
  contactsList: SavedContact[];
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

      return {
        savedContacts: parsed.savedContacts ?? [],
        contactsList: (parsed as any).contactsList ?? [],
        adminSettings: { ...DEFAULT_SETTINGS, ...cleanSettings },
        campaigns: parsed.campaigns ?? [],
      };
    } catch {
      console.warn('⚠️  Could not parse storage file – starting fresh.');
      return {
        savedContacts: [],
        contactsList: [],
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
    if (!this.isContactSaved(phone)) {
      this.data.savedContacts.push(phone);
      this.data.contactsList.push({ phone, name, savedAt: new Date().toISOString() });
      this.persist();
    }
  }

  getAllContacts(): SavedContact[] {
    return [...this.data.contactsList];
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
