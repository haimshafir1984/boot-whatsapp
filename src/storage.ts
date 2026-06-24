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
  /** Optional scheduled campaign window. Existing campaigns without dates stay always-on while active. */
  startAt?: string;
  endAt?: string;
  /** Conversation copy for this campaign. Older campaigns fall back to legacy admin settings. */
  conversation?: CampaignConversationSettings;
  twilio?: CampaignTwilioSettings;
  runtimeStatus?: CampaignRuntimeStatus;
}

export type CampaignRuntimeStatus = 'draft' | 'scheduled' | 'active' | 'ended' | 'disabled';

export interface CampaignConversationSettings {
  askNameEnabled: boolean;
  nameTimeoutMinutes: number;
  askNameText: string;
  preNamePromptText?: string;
  preNamePromptAutoContinue?: boolean;
  preNamePromptTimeoutMinutes?: number;
  replyText: string;
  completionLinks?: CompletionLink[];
  completionFileIds?: string[];
  sendContactCard?: boolean;
  contactCardPlacement?: 'after_completion' | 'before_questions';
  contactCardName?: string;
  contactCardPhone?: string;
  contactCardEmail?: string;
  contactCardOrganization?: string;
  contactCardWaitForConfirmation?: boolean;
  contactCardConfirmationTimeoutMinutes?: number;
  followupMessages: string[];
  decisionFlow: DecisionFlowStep[];
  decisionTimeoutMinutes?: number;
  decisionTimeoutText?: string;
  humanHandoffEnabled?: boolean;
  humanHandoffText?: string;
  humanHandoffPhone?: string;
}

export interface CompletionLink {
  label: string;
  url: string;
}

export type TwilioCampaignMode = 'link' | 'template';

export interface CampaignTwilioSettings {
  mode: TwilioCampaignMode;
  templateId?: string;
  optInConfirmed?: boolean;
  audienceNotes?: string;
}

export interface DecisionFlowStep {
  id: string;
  kind: 'message' | 'question' | 'score_question';
  presentation?: 'text' | 'buttons' | 'list';
  text: string;
  nextStepId?: string;
  timeoutMinutes?: number;
  timeoutText?: string;
  timeoutFileId?: string;
  timeoutFileAsSticker?: boolean;
  options?: DecisionFlowOption[];
}

export interface DecisionFlowOption {
  id: string;
  text: string;
  nextStepId?: string;
  endText?: string;
  fileId?: string;
  fileAsSticker?: boolean;
  score?: number;
}

export interface AdminSettings {
  askNameEnabled: boolean;
  nameTimeoutMinutes: number;
  contactsProvider: 'google' | 'manual';
  askNameText: string;
  replyText: string;
  completionLinks: CompletionLink[];
  completionFileIds: string[];
  sendContactCard?: boolean;
  contactCardPlacement?: 'after_completion' | 'before_questions';
  contactCardName?: string;
  contactCardPhone?: string;
  contactCardEmail?: string;
  contactCardOrganization?: string;
  contactCardWaitForConfirmation?: boolean;
  contactCardConfirmationTimeoutMinutes?: number;
  followupMessages: string[];
  decisionFlow: DecisionFlowStep[];
  decisionTimeoutMinutes?: number;
  decisionTimeoutText?: string;
  humanHandoffEnabled?: boolean;
  humanHandoffText?: string;
  humanHandoffPhone?: string;
  referralPrefix: string;
  botSuffix: string;
}

export interface ClientProfile {
  whatsappPhone: string;
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
  campaignResultIds?: string[];
}

export type CampaignResultStatus = 'awaiting_name' | ContactSaveStatus;

export interface CampaignResult {
  id: string;
  campaignId: string;
  phone: string;
  whatsappName?: string;
  fallbackName?: string;
  lastStage?: string;
  lastEventAt?: string;
  status: CampaignResultStatus;
  triggeredAt: string;
  updatedAt: string;
  scoreAnswers?: CampaignScoreAnswer[];
  scoreTotal?: number;
}

export interface CampaignScoreAnswer {
  stepId: string;
  question: string;
  optionId: string;
  answerText: string;
  score: number;
  answeredAt: string;
}

export type CampaignEventType =
  | 'pre_name_prompt_sent'
  | 'pre_name_prompt_failed'
  | 'pre_name_replied'
  | 'pre_name_auto_continue'
  | 'ask_name_sent'
  | 'step_sent'
  | 'step_answered'
  | 'score_answered'
  | 'file_sent'
  | 'file_failed'
  | 'completion_sent'
  | 'completion_link_sent'
  | 'completion_file_sent'
  | 'completion_file_failed'
  | 'contact_card_confirmed'
  | 'completed'
  | 'human_handoff';

export interface CampaignEvent {
  id: string;
  campaignId: string;
  campaignResultId?: string;
  phone?: string;
  type: CampaignEventType;
  label?: string;
  createdAt: string;
}

export interface UploadedFile {
  id: string;
  originalName: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface TwilioOnboardingDetails {
  businessName: string;
  brandName: string;
  businessWebsite: string;
  businessCategory: string;
  businessDescription: string;
  supportEmail: string;
  supportPhone: string;
  country: string;
  optInDescription: string;
  firstCampaignUseCase: string;
  notes: string;
  updatedAt?: string;
}

export type TwilioTemplateStatus =
  | 'draft'
  | 'created'
  | 'submitted'
  | 'received'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'paused'
  | 'disabled'
  | 'failed';

export interface TwilioTemplateDraft {
  id: string;
  friendlyName: string;
  templateName: string;
  language: string;
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
  body: string;
  variables: Record<string, string>;
  status: TwilioTemplateStatus;
  contentSid?: string;
  approvalStatus?: string;
  rejectionReason?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

interface StorageData {
  savedContacts: string[];
  contactsList: SavedContact[];
  contactQueue: ContactSaveJob[];
  campaignResults: CampaignResult[];
  campaignEvents: CampaignEvent[];
  uploadedFiles: UploadedFile[];
  clientProfile: ClientProfile;
  adminSettings: AdminSettings;
  campaigns: Campaign[];
  twilioOnboarding: TwilioOnboardingDetails;
  twilioTemplates: TwilioTemplateDraft[];
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: AdminSettings = {
  askNameEnabled: false,
  nameTimeoutMinutes: 5,
  contactsProvider: config.WHATSAPP_PROVIDER === 'TWILIO_API' ? 'manual' : 'google',
  askNameText: config.ASK_NAME_TEXT,
  replyText: config.REPLY_TEXT,
  followupMessages: [],
  completionLinks: [],
  completionFileIds: [],
  contactCardPlacement: 'after_completion',
  contactCardWaitForConfirmation: false,
  contactCardConfirmationTimeoutMinutes: 30,
  decisionFlow: [],
  decisionTimeoutMinutes: 30,
  decisionTimeoutText: '',
  humanHandoffEnabled: true,
  humanHandoffText: 'אני מענה אוטומטי.\nלשאלות נוספות אפשר לעבור לשיחה אנושית כאן:\n[מעבר ל-WhatsApp]',
  humanHandoffPhone: '',
  referralPrefix: config.TRIGGER_REFERRAL_PREFIX,
  botSuffix: config.BOT_SUFFIX,
};

const DEFAULT_CLIENT_PROFILE: ClientProfile = {
  whatsappPhone: '',
};

const DEFAULT_TWILIO_ONBOARDING: TwilioOnboardingDetails = {
  businessName: '',
  brandName: '',
  businessWebsite: '',
  businessCategory: '',
  businessDescription: '',
  supportEmail: '',
  supportPhone: '',
  country: 'IL',
  optInDescription: '',
  firstCampaignUseCase: '',
  notes: '',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function normalizeContactsProvider(provider: unknown): AdminSettings['contactsProvider'] {
  return provider === 'google' || provider === 'manual'
    ? provider
    : DEFAULT_SETTINGS.contactsProvider;
}

function emptyStorageData(): StorageData {
  return {
    savedContacts: [],
    contactsList: [],
    contactQueue: [],
    campaignResults: [],
    campaignEvents: [],
    uploadedFiles: [],
    clientProfile: { ...DEFAULT_CLIENT_PROFILE },
    adminSettings: { ...DEFAULT_SETTINGS },
    campaigns: [],
    twilioOnboarding: { ...DEFAULT_TWILIO_ONBOARDING },
    twilioTemplates: [],
  };
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

    if (!fs.existsSync(this.filePath)) return emptyStorageData();
    try {
      return this.parseStorageFile(this.filePath);
    } catch {
      const backupPath = `${this.filePath}.bak`;
      if (fs.existsSync(backupPath)) {
        try {
          console.warn('⚠️  Could not parse storage file - loading backup.');
          return this.parseStorageFile(backupPath);
        } catch {
          console.warn('⚠️  Could not parse storage backup - starting fresh.');
        }
      } else {
        console.warn('⚠️  Could not parse storage file - starting fresh.');
      }
      return emptyStorageData();
    }
  }

  private parseStorageFile(filePath: string): StorageData {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, 'utf-8'),
    ) as Partial<StorageData> & { adminSettings?: Partial<AdminSettings> & { triggerType?: number } };

    // Migrate: drop legacy triggerType field from adminSettings
    const { triggerType: _legacy, ...cleanSettings } = parsed.adminSettings ?? {};
    const rawSettings = cleanSettings as Partial<AdminSettings> & { contactsProvider?: unknown };
    const migratedSettings: Partial<AdminSettings> = {
      ...cleanSettings,
      contactsProvider: normalizeContactsProvider(rawSettings.contactsProvider),
    };

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
      campaignResults: parsed.campaignResults ?? [],
      campaignEvents: (parsed as any).campaignEvents ?? [],
      uploadedFiles: (parsed as any).uploadedFiles ?? [],
      clientProfile: { ...DEFAULT_CLIENT_PROFILE, ...parsed.clientProfile },
      adminSettings: { ...DEFAULT_SETTINGS, ...migratedSettings },
      campaigns: parsed.campaigns ?? [],
      twilioOnboarding: { ...DEFAULT_TWILIO_ONBOARDING, ...(parsed as any).twilioOnboarding },
      twilioTemplates: (parsed as any).twilioTemplates ?? [],
    };
  }

  private persist(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tempPath = `${this.filePath}.tmp`;
    const backupPath = `${this.filePath}.bak`;
    fs.writeFileSync(tempPath, JSON.stringify(this.data), 'utf-8');
    if (fs.existsSync(this.filePath)) {
      fs.copyFileSync(this.filePath, backupPath);
    }
    fs.renameSync(tempPath, this.filePath);
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
      this.updateCampaignResultStatuses(job.campaignResultIds, 'saved', now);
    }
    this.persist();
  }

  getAllContacts(): SavedContact[] {
    return [...this.data.contactsList];
  }

  enqueueContactSave(phone: string, name: string, campaignResultId?: string): ContactSaveJob | null {
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
      if (campaignResultId && !existing.campaignResultIds?.includes(campaignResultId)) {
        existing.campaignResultIds = [...(existing.campaignResultIds ?? []), campaignResultId];
      }
      this.updateCampaignResultStatuses(existing.campaignResultIds, 'pending', now);
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
      campaignResultIds: campaignResultId ? [campaignResultId] : [],
    };
    this.updateCampaignResultStatuses(job.campaignResultIds, 'pending', now);
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
    this.updateCampaignResultStatuses(job.campaignResultIds, job.status, job.updatedAt);
    this.persist();
    return { ...job };
  }

  retryFailedContactSaves(provider: AdminSettings['contactsProvider']): number {
    const now = new Date().toISOString();
    let count = 0;
    for (const job of this.data.contactQueue) {
      if (job.status !== 'failed') continue;
      job.provider = provider;
      job.status = 'pending';
      job.attempts = 0;
      job.updatedAt = now;
      job.nextAttemptAt = now;
      job.lastError = undefined;
      this.updateCampaignResultStatuses(job.campaignResultIds, 'pending', now);
      count += 1;
    }
    if (count) this.persist();
    return count;
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

  // Uploaded files

  addUploadedFile(file: Omit<UploadedFile, 'id' | 'createdAt'>): UploadedFile {
    const uploaded: UploadedFile = {
      id: generateId(),
      createdAt: new Date().toISOString(),
      ...file,
    };
    this.data.uploadedFiles.push(uploaded);
    this.persist();
    return { ...uploaded };
  }

  getUploadedFiles(): UploadedFile[] {
    return [...this.data.uploadedFiles]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((file) => ({ ...file }));
  }

  getUploadedFile(id: string): UploadedFile | null {
    const file = this.data.uploadedFiles.find((item) => item.id === id);
    return file ? { ...file } : null;
  }

  // Campaign results

  recordCampaignTrigger(campaignId: string, phone: string, whatsappName = ''): CampaignResult {
    const now = new Date().toISOString();
    const result: CampaignResult = {
      id: generateId(),
      campaignId,
      phone,
      whatsappName,
      fallbackName: '',
      lastStage: 'triggered',
      lastEventAt: now,
      status: 'awaiting_name',
      triggeredAt: now,
      updatedAt: now,
    };
    this.data.campaignResults.push(result);
    this.persist();
    return { ...result };
  }

  markCampaignResultStage(resultId: string | undefined, stage: string, fallbackName?: string): void {
    if (!resultId) return;
    const result = this.data.campaignResults.find((item) => item.id === resultId);
    if (!result) return;
    const now = new Date().toISOString();
    result.lastStage = stage;
    result.lastEventAt = now;
    result.updatedAt = now;
    if (fallbackName !== undefined) result.fallbackName = fallbackName;
    this.persist();
  }

  queueAwaitingNameCampaignResults(campaignId: string): { queued: number; skipped: number } {
    const campaign = this.data.campaigns.find((item) => item.id === campaignId);
    const suffix = campaign?.suffix ?? '';
    const campaignName = campaign?.name?.trim() || 'קמפיין';
    let queued = 0;
    let skipped = 0;

    for (const result of this.data.campaignResults) {
      if (result.campaignId !== campaignId || result.status !== 'awaiting_name') continue;
      const baseName = result.whatsappName?.trim()
        || result.fallbackName?.trim()
        || `${campaignName} - ${result.phone}`;
      const finalName = baseName.endsWith(suffix) ? baseName : `${baseName}${suffix}`;
      const job = this.enqueueContactSave(result.phone, finalName, result.id);
      if (job) {
        result.lastStage = 'manually_queued_stuck';
        result.lastEventAt = new Date().toISOString();
        queued += 1;
      } else {
        skipped += 1;
      }
    }
    if (queued || skipped) this.persist();
    return { queued, skipped };
  }

  getCampaignResults(campaignId?: string): CampaignResult[] {
    return this.data.campaignResults
      .filter((result) => !campaignId || result.campaignId === campaignId)
      .sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt))
      .map((result) => ({ ...result }));
  }

  recordScoreAnswer(resultId: string | undefined, input: Omit<CampaignScoreAnswer, 'answeredAt'>): void {
    if (!resultId) return;
    const result = this.data.campaignResults.find((item) => item.id === resultId);
    if (!result) return;
    const answeredAt = new Date().toISOString();
    const answers = result.scoreAnswers ?? [];
    const nextAnswer: CampaignScoreAnswer = { ...input, answeredAt };
    const existingIndex = answers.findIndex((answer) => answer.stepId === input.stepId);
    if (existingIndex >= 0) answers[existingIndex] = nextAnswer;
    else answers.push(nextAnswer);
    result.scoreAnswers = answers;
    result.scoreTotal = answers.reduce((sum, answer) => sum + answer.score, 0);
    result.updatedAt = answeredAt;
    result.lastEventAt = answeredAt;
    this.persist();
  }

  recordCampaignEvent(event: Omit<CampaignEvent, 'id' | 'createdAt'>): CampaignEvent {
    const saved: CampaignEvent = {
      id: generateId(),
      createdAt: new Date().toISOString(),
      ...event,
    };
    this.data.campaignEvents.push(saved);
    if (event.campaignResultId) {
      const result = this.data.campaignResults.find((item) => item.id === event.campaignResultId);
      if (result) {
        result.lastStage = event.type;
        result.lastEventAt = saved.createdAt;
        result.updatedAt = saved.createdAt;
      }
    }
    this.persist();
    return { ...saved };
  }

  getCampaignEvents(campaignId?: string): CampaignEvent[] {
    return this.data.campaignEvents
      .filter((event) => !campaignId || event.campaignId === campaignId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((event) => ({ ...event }));
  }

  getCampaignResultSummary(campaignId: string): {
    total: number;
    awaitingName: number;
    pending: number;
    saved: number;
    failed: number;
    progressed: number;
    sentMessages: number;
    filesSent: number;
    filesFailed: number;
    completionSent: number;
    completionLinksSent: number;
    completionFilesSent: number;
    completionFilesFailed: number;
    preNamePromptSent: number;
    preNamePromptFailed: number;
    preNameReplied: number;
    preNameAutoContinued: number;
    askNameSent: number;
    completed: number;
    humanHandoff: number;
    scoreAnswered: number;
    scoreTotal: number;
    scoreAverage: number;
  } {
    const results = this.data.campaignResults.filter((result) => result.campaignId === campaignId);
    const events = this.data.campaignEvents.filter((event) => event.campaignId === campaignId);
    const uniqueCount = (type: CampaignEventType) => new Set(
      events
        .filter((event) => event.type === type)
        .map((event) => event.campaignResultId || event.phone || event.id),
    ).size;
    const stats = results.reduce((acc, result) => {
      acc.total += 1;
      if (result.status === 'awaiting_name') acc.awaitingName += 1;
      else acc[result.status] += 1;
      return acc;
    }, {
      total: 0,
      awaitingName: 0,
      pending: 0,
      saved: 0,
      failed: 0,
      progressed: 0,
      sentMessages: 0,
      filesSent: 0,
      filesFailed: 0,
      completionSent: 0,
      completionLinksSent: 0,
      completionFilesSent: 0,
      completionFilesFailed: 0,
      preNamePromptSent: 0,
      preNamePromptFailed: 0,
      preNameReplied: 0,
      preNameAutoContinued: 0,
      askNameSent: 0,
      completed: 0,
      humanHandoff: 0,
      scoreAnswered: 0,
      scoreTotal: 0,
      scoreAverage: 0,
    });
    stats.progressed = uniqueCount('step_answered');
    stats.sentMessages = stats.total + events.filter((event) => event.type === 'step_sent').length;
    stats.filesSent = uniqueCount('file_sent');
    stats.filesFailed = uniqueCount('file_failed');
    stats.completionSent = uniqueCount('completion_sent');
    stats.completionLinksSent = uniqueCount('completion_link_sent');
    stats.completionFilesSent = uniqueCount('completion_file_sent');
    stats.completionFilesFailed = uniqueCount('completion_file_failed');
    stats.preNamePromptSent = uniqueCount('pre_name_prompt_sent');
    stats.preNamePromptFailed = uniqueCount('pre_name_prompt_failed');
    stats.preNameReplied = uniqueCount('pre_name_replied');
    stats.preNameAutoContinued = uniqueCount('pre_name_auto_continue');
    stats.askNameSent = uniqueCount('ask_name_sent');
    stats.completed = uniqueCount('completed');
    stats.humanHandoff = uniqueCount('human_handoff');
    stats.scoreAnswered = uniqueCount('score_answered');
    stats.scoreTotal = results.reduce((sum, result) => sum + (result.scoreTotal ?? 0), 0);
    stats.scoreAverage = stats.scoreAnswered > 0 ? Math.round((stats.scoreTotal / stats.scoreAnswered) * 100) / 100 : 0;
    return stats;
  }

  private updateCampaignResultStatuses(resultIds: string[] | undefined, status: ContactSaveStatus, updatedAt: string): void {
    if (!resultIds?.length) return;
    const ids = new Set(resultIds);
    for (const result of this.data.campaignResults) {
      if (ids.has(result.id)) {
        result.status = status;
        result.updatedAt = updatedAt;
      }
    }
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

  getClientProfile(): ClientProfile {
    return { ...this.data.clientProfile };
  }

  updateClientProfile(patch: Partial<ClientProfile>): ClientProfile {
    this.data.clientProfile = { ...this.data.clientProfile, ...patch };
    this.persist();
    return this.getClientProfile();
  }

  getTwilioOnboarding(): TwilioOnboardingDetails {
    return { ...this.data.twilioOnboarding };
  }

  updateTwilioOnboarding(patch: Partial<TwilioOnboardingDetails>): TwilioOnboardingDetails {
    this.data.twilioOnboarding = {
      ...this.data.twilioOnboarding,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.persist();
    return this.getTwilioOnboarding();
  }

  getTwilioTemplates(): TwilioTemplateDraft[] {
    return this.data.twilioTemplates
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((template) => ({ ...template, variables: { ...template.variables } }));
  }

  getTwilioTemplate(id: string): TwilioTemplateDraft | null {
    const template = this.data.twilioTemplates.find((item) => item.id === id);
    return template ? { ...template, variables: { ...template.variables } } : null;
  }

  addTwilioTemplate(input: Omit<TwilioTemplateDraft, 'id' | 'createdAt' | 'updatedAt' | 'status'> & { status?: TwilioTemplateStatus }): TwilioTemplateDraft {
    const now = new Date().toISOString();
    const template: TwilioTemplateDraft = {
      id: generateId(),
      status: input.status ?? 'draft',
      ...input,
      variables: { ...input.variables },
      createdAt: now,
      updatedAt: now,
    };
    this.data.twilioTemplates.push(template);
    this.persist();
    return { ...template, variables: { ...template.variables } };
  }

  updateTwilioTemplate(id: string, patch: Partial<Omit<TwilioTemplateDraft, 'id' | 'createdAt'>>): TwilioTemplateDraft | null {
    const idx = this.data.twilioTemplates.findIndex((item) => item.id === id);
    if (idx === -1) return null;
    this.data.twilioTemplates[idx] = {
      ...this.data.twilioTemplates[idx],
      ...patch,
      variables: patch.variables ? { ...patch.variables } : this.data.twilioTemplates[idx].variables,
      updatedAt: new Date().toISOString(),
    };
    this.persist();
    const template = this.data.twilioTemplates[idx];
    return { ...template, variables: { ...template.variables } };
  }

  // ─── Campaigns ─────────────────────────────────────────────────────────────

  getCampaignConversationSettings(campaign: Campaign): CampaignConversationSettings {
    const defaults = this.getAdminSettings();
    return {
      askNameEnabled: campaign.conversation?.askNameEnabled ?? defaults.askNameEnabled,
      nameTimeoutMinutes: campaign.conversation?.nameTimeoutMinutes ?? defaults.nameTimeoutMinutes,
      askNameText: campaign.conversation?.askNameText ?? defaults.askNameText,
      preNamePromptText: campaign.conversation?.preNamePromptText ?? '',
      preNamePromptAutoContinue: campaign.conversation?.preNamePromptAutoContinue ?? true,
      preNamePromptTimeoutMinutes: campaign.conversation?.preNamePromptTimeoutMinutes ?? 1,
      replyText: campaign.conversation?.replyText ?? defaults.replyText,
      completionLinks: campaign.conversation?.completionLinks ?? [],
      completionFileIds: campaign.conversation?.completionFileIds ?? [],
      sendContactCard: campaign.conversation?.sendContactCard ?? defaults.sendContactCard ?? false,
      contactCardPlacement: campaign.conversation?.contactCardPlacement ?? defaults.contactCardPlacement ?? 'after_completion',
      contactCardName: campaign.conversation?.contactCardName ?? defaults.contactCardName ?? '',
      contactCardPhone: campaign.conversation?.contactCardPhone ?? defaults.contactCardPhone ?? '',
      contactCardEmail: campaign.conversation?.contactCardEmail ?? defaults.contactCardEmail ?? '',
      contactCardOrganization: campaign.conversation?.contactCardOrganization ?? defaults.contactCardOrganization ?? '',
      contactCardWaitForConfirmation: campaign.conversation?.contactCardWaitForConfirmation ?? defaults.contactCardWaitForConfirmation ?? false,
      contactCardConfirmationTimeoutMinutes: campaign.conversation?.contactCardConfirmationTimeoutMinutes ?? defaults.contactCardConfirmationTimeoutMinutes ?? 30,
      followupMessages: campaign.conversation?.followupMessages ?? defaults.followupMessages,
      decisionFlow: campaign.conversation?.decisionFlow ?? defaults.decisionFlow,
      decisionTimeoutMinutes: campaign.conversation?.decisionTimeoutMinutes ?? defaults.decisionTimeoutMinutes,
      decisionTimeoutText: campaign.conversation?.decisionTimeoutText ?? defaults.decisionTimeoutText,
      humanHandoffEnabled: campaign.conversation?.humanHandoffEnabled ?? defaults.humanHandoffEnabled,
      humanHandoffText: campaign.conversation?.humanHandoffText ?? defaults.humanHandoffText,
      humanHandoffPhone: campaign.conversation?.humanHandoffPhone ?? defaults.humanHandoffPhone,
    };
  }

  getCampaigns(): Campaign[] {
    return this.data.campaigns.map((campaign) => ({
      ...campaign,
      runtimeStatus: this.getCampaignRuntimeStatus(campaign),
    }));
  }

  getActiveCampaigns(): Campaign[] {
    return this.data.campaigns
      .filter((campaign) => this.isCampaignListeningNow(campaign))
      .map((campaign) => ({
        ...campaign,
        runtimeStatus: this.getCampaignRuntimeStatus(campaign),
      }));
  }

  hasCampaignsNeedingBot(now = new Date(), leadMs = 15 * 60 * 1000): boolean {
    if (config.CLIENT_SERVICE_EXPIRES_AT) {
      const expires = new Date(config.CLIENT_SERVICE_EXPIRES_AT).getTime();
      if (!Number.isNaN(expires) && now.getTime() > expires) return false;
    }

    return this.data.campaigns.some((campaign) => {
      if (!campaign.active) return false;
      if (!campaign.startAt && !campaign.endAt) return true;

      const time = now.getTime();
      const start = campaign.startAt ? new Date(campaign.startAt).getTime() : Number.NEGATIVE_INFINITY;
      const end = campaign.endAt ? new Date(campaign.endAt).getTime() : Number.POSITIVE_INFINITY;

      if (Number.isNaN(start) || Number.isNaN(end)) return true;
      return time >= start - leadMs && time <= end;
    });
  }

  getCampaignRuntimeStatus(campaign: Campaign, now = new Date()): CampaignRuntimeStatus {
    if (!campaign.active) return 'disabled';
    if (!campaign.startAt && !campaign.endAt) return 'active';

    const time = now.getTime();
    const start = campaign.startAt ? new Date(campaign.startAt).getTime() : Number.NEGATIVE_INFINITY;
    const end = campaign.endAt ? new Date(campaign.endAt).getTime() : Number.POSITIVE_INFINITY;

    if (Number.isNaN(start) || Number.isNaN(end)) return 'active';
    if (time < start) return 'scheduled';
    if (time > end) return 'ended';
    return 'active';
  }

  private isCampaignListeningNow(campaign: Campaign, now = new Date()): boolean {
    return this.getCampaignRuntimeStatus(campaign, now) === 'active';
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
