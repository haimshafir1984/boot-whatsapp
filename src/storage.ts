/**
 * storage.ts
 * JSON-file persistence for saved contacts, admin settings, and campaigns.
 */

import fs from 'fs';
import path from 'path';
import { config } from './config';
import type { ConversationStateSnapshot } from './conversationState';

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
  currentResultBatchId?: string;
  currentResultBatchStartedAt?: string;
}

export type CampaignRuntimeStatus = 'draft' | 'scheduled' | 'active' | 'ended' | 'disabled';

export interface ContactCard {
  name?: string;
  phone?: string;
  email?: string;
  organization?: string;
}

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
  contactCardSendMode?: 'separate' | 'combined';
  contactCards?: ContactCard[];
  contactCardName?: string;
  contactCardPhone?: string;
  contactCardEmail?: string;
  contactCardOrganization?: string;
  contactCardIntroText?: string;
  contactCardWaitForConfirmation?: boolean;
  contactCardConfirmationTimeoutMinutes?: number;
  followupMessages: string[];
  decisionFlow: DecisionFlowStep[];
  decisionTimeoutMinutes?: number;
  decisionTimeoutText?: string;
  /** What to do when a decision is left unanswered. Defaults to the legacy final message. */
  decisionTimeoutMode?: 'message' | 'flow';
  /** First step of the one-time continuation flow after inactivity. */
  decisionTimeoutNextStepId?: string;
  /** Internal pending-state flag; never saved as a campaign choice. */
  timeoutFlowStarted?: boolean;
  /** Optional campaign-level reply used when an answer does not match the current structured question. */
  invalidReplyText?: string;
  /** Optional campaign-level notice sent before safely restarting a lost flow from its first decision step. */
  flowRecoveryText?: string;
  humanHandoffEnabled?: boolean;
  humanHandoffText?: string;
  humanHandoffPhone?: string;
  groupJoinManagerPhone?: string;
  groupJoinParticipantConfirmationText?: string;
  groupJoinParticipantFailureText?: string;
  groupJoinMetaTemplateName?: string;
  groupJoinMetaTemplateLanguage?: string;
  /**
   * Ordered body parameters for the approved Meta template, one per {{n}}.
   * Each entry may contain the placeholders {phone}, {campaign} and {name}.
   * Empty means the legacy pair [participant phone, campaign name].
   */
  groupJoinMetaTemplateParams?: string[];
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
  kind: 'message' | 'wait_reply' | 'email_capture' | 'contact_card' | 'referral_share' | 'question' | 'score_question' | 'score_result';
  presentation?: 'text' | 'buttons' | 'list';
  text: string;
  nextStepId?: string;
  delayMs?: number;
  fileId?: string;
  fileAsSticker?: boolean;
  timeoutMinutes?: number;
  timeoutSeconds?: number;
  timeoutMode?: 'stop' | 'continue';
  timeoutNextStepId?: string;
  timeoutText?: string;
  timeoutFileId?: string;
  timeoutFileAsSticker?: boolean;
  options?: DecisionFlowOption[];
  resultRules?: ScoreResultRule[];
  fallbackText?: string;
  fallbackNextStepId?: string;
  /** Reply sent when an email-capture answer is not a valid email address. */
  emailInvalidText?: string;
  referralHub?: boolean;
}

export interface ScoreResultRule {
  id: string;
  type: 'majority' | 'sum_range';
  label?: string;
  value?: number;
  min?: number;
  max?: number;
  nextStepId?: string;
  endText?: string;
  fileId?: string;
  fileAsSticker?: boolean;
}

export interface DecisionFlowOption {
  id: string;
  text: string;
  buttonLabel?: string;
  nextStepId?: string;
  endText?: string;
  fileId?: string;
  fileAsSticker?: boolean;
  /** Marks a verified button choice as one raffle entry in the campaign export. */
  raffleEntry?: boolean;
  /** Auxiliary action that keeps the participant on the current question. */
  action?: 'request_group_join' | 'referral_link' | 'referral_leaderboard' | 'referral_my_rank';
  /** Controls whether a referral leaderboard exposes each participant's share count. */
  referralLeaderboardDisplay?: 'names_only' | 'names_and_counts';
  /** Message shown when the referral leaderboard has no participants with shares yet. */
  referralLeaderboardEmptyText?: string;
  /** Optional display-only starting rows, merged with live referral totals. */
  referralLeaderboardSeeds?: Array<{ name: string; invited: number }>;
  score?: number;
}

export interface AdminSettings {
  /** Runtime override managed by the owner dashboard. Falls back to CLIENT_MAX_CAMPAIGNS. */
  maxCampaignsOverride?: number;
  askNameEnabled: boolean;
  nameTimeoutMinutes: number;
  contactsProvider: 'google' | 'manual';
  readReceiptsEnabled?: boolean;
  askNameText: string;
  replyText: string;
  completionLinks: CompletionLink[];
  completionFileIds: string[];
  sendContactCard?: boolean;
  contactCardPlacement?: 'after_completion' | 'before_questions';
  contactCardSendMode?: 'separate' | 'combined';
  contactCards?: ContactCard[];
  contactCardName?: string;
  contactCardPhone?: string;
  contactCardEmail?: string;
  contactCardOrganization?: string;
  contactCardIntroText?: string;
  contactCardWaitForConfirmation?: boolean;
  contactCardConfirmationTimeoutMinutes?: number;
  followupMessages: string[];
  decisionFlow: DecisionFlowStep[];
  decisionTimeoutMinutes?: number;
  decisionTimeoutText?: string;
  /** What to do when a decision is left unanswered. Defaults to the legacy final message. */
  decisionTimeoutMode?: 'message' | 'flow';
  /** First step of the one-time continuation flow after inactivity. */
  decisionTimeoutNextStepId?: string;
  /** Internal pending-state flag; never saved as a campaign choice. */
  timeoutFlowStarted?: boolean;
  invalidReplyText?: string;
  flowRecoveryText?: string;
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

export type OutboxMessageStatus = 'queued' | 'processing' | 'sent' | 'failed' | 'retry';
export type OutboxMessageKind = 'text' | 'file' | 'interactive_buttons' | 'interactive_list' | 'contacts' | 'template';

export interface OutboxMessage {
  id: string;
  kind: OutboxMessageKind;
  to: string;
  text?: string;
  filePath?: string;
  caption?: string;
  fileOptions?: { asSticker?: boolean };
  label?: string;
  buttons?: Array<{ id: string; text: string }>;
  buttonText?: string;
  items?: Array<{ id: string; text: string; description?: string }>;
  contacts?: Array<{ vcard: string; displayName: string }>;
  displayName?: string;
  templateName?: string;
  templateLanguageCode?: string;
  templateBodyParameters?: string[];
  campaignId?: string;
  campaignResultId?: string;
  stepId?: string;
  idempotencyKey?: string;
  status: OutboxMessageStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt?: string;
  processingStartedAt?: string;
  lastError?: string;
  providerMessageId?: string;
  /** Delivery outcome reported by the provider webhook, not by the send call. */
  deliveryStatus?: 'sent' | 'delivered' | 'read' | 'failed';
  deliveryError?: string;
  deliveryUpdatedAt?: string;
}

export interface ScheduledJobRecord {
  id: string;
  kind: 'conversation-timeout' | 'outbox-retry';
  targetId: string;
  runAt: string;
  status: 'scheduled' | 'running' | 'completed' | 'cancelled' | 'failed';
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  data?: Record<string, unknown>;
}

export type CampaignResultStatus = 'awaiting_name' | ContactSaveStatus;

export interface CampaignResult {
  id: string;
  campaignId: string;
  resultBatchId?: string;
  phone: string;
  whatsappName?: string;
  referralCode?: string;
  /** Previous codes remain valid after switching to the phone-suffix format. */
  referralCodeAliases?: string[];
  referredByCode?: string;
  referredByResultId?: string;
  referredByName?: string;
  referredByPhone?: string;
  fallbackName?: string;
  email?: string;
  emailCollectedAt?: string;
  lastStage?: string;
  lastEventAt?: string;
  status: CampaignResultStatus;
  triggeredAt: string;
  updatedAt: string;
  scoreAnswers?: CampaignScoreAnswer[];
  scoreTotal?: number;
  /** Local preview record, excluded by the demo cleanup action. */
  isDemo?: boolean;
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
  | 'email_captured'
  | 'raffle_entry'
  | 'group_join_request'
  | 'timeout_flow_started'
  | 'decision_timeout_sent'
  | 'file_sent'
  | 'file_failed'
  | 'completion_sent'
  | 'completion_link_sent'
  | 'completion_file_sent'
  | 'completion_file_failed'
  | 'contact_card_confirmed'
  | 'completed'
  | 'human_handoff'
  | 'referral_link_sent'
  | 'referral_leaderboard_viewed'
  | 'referral_rank_viewed'
  | 'referral_attributed';

export interface CampaignEvent {
  id: string;
  campaignId: string;
  resultBatchId?: string;
  campaignResultId?: string;
  phone?: string;
  type: CampaignEventType;
  label?: string;
  /** Stable key used to make retryable flow side effects idempotent. */
  dedupeKey?: string;
  createdAt: string;
}

export interface CampaignResultBatch {
  id: string;
  label: string;
  startedAt?: string;
  total: number;
  isCurrent: boolean;
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

export type ServiceBotNodeType = 'menu' | 'message' | 'handoff' | 'input' | 'condition';
export type ServiceBotInputType = 'text' | 'number' | 'image' | 'document' | 'media';
export type ServiceBotConditionOperator = 'equals' | 'not_equals' | 'contains' | 'exists';

export interface ServiceBotCondition {
  variableKey: string;
  operator: ServiceBotConditionOperator;
  value?: string;
}

export interface ServiceBotConditionRule {
  id: string;
  label?: string;
  conditions: ServiceBotCondition[];
  targetNodeId: string;
}

export interface ServiceBotOption {
  id: string;
  label: string;
  targetNodeId: string;
  variableKey?: string;
  variableValue?: string;
}

export interface ServiceBotNode {
  id: string;
  title: string;
  type: ServiceBotNodeType;
  text: string;
  options?: ServiceBotOption[];
  handoffPhone?: string;
  inputType?: ServiceBotInputType;
  variableKey?: string;
  nextNodeId?: string;
  inputErrorText?: string;
  conditionRules?: ServiceBotConditionRule[];
  defaultTargetNodeId?: string;
  followUpDelayMinutes?: number;
  followUpText?: string;
  followUpTargetNodeId?: string;
}

export interface ServiceBotConfig {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  enabled: boolean;
  name: string;
  triggerText: string;
  mainMenuNodeId: string;
  fallbackText: string;
  sessionTimeoutMinutes: number;
  navigationPromptText: string;
  backLabel: string;
  mainMenuLabel: string;
  outsideHoursEnabled: boolean;
  outsideHoursStart: string;
  outsideHoursEnd: string;
  outsideHoursText: string;
  globalHandoffEnabled: boolean;
  globalHandoffLabel: string;
  globalHandoffPhone: string;
  globalHandoffText: string;
  nodes: ServiceBotNode[];
}

export interface ServiceBotSession {
  botId: string;
  phone: string;
  nodeId: string;
  path?: string[];
  variables?: Record<string, string>;
  startedAt?: string;
  updatedAt: string;
}

export interface ServiceBotAttachment {
  messageId: string;
  variableKey: string;
  kind: string;
  mimeType?: string;
  fileName?: string;
  providerMediaId?: string;
  providerUrl?: string;
  capturedAt: string;
}

export interface ServiceBotRecord {
  botId: string;
  phone: string;
  variables: Record<string, string>;
  attachments: ServiceBotAttachment[];
  currentNodeId: string;
  startedAt: string;
  updatedAt: string;
}

export interface ServiceBotFollowUp {
  id: string;
  botId: string;
  phone: string;
  to: string;
  nodeId: string;
  targetNodeId?: string;
  text?: string;
  runAt: string;
  status: 'scheduled' | 'processing' | 'sent' | 'cancelled' | 'failed';
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface StorageData {
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
  outboxMessages: OutboxMessage[];
  conversationStateSnapshot?: ConversationStateSnapshot;
  scheduledJobs: ScheduledJobRecord[];
  serviceBots: ServiceBotConfig[];
  /** Compatibility mirror for snapshots created before multi-bot support. */
  serviceBot: ServiceBotConfig;
  serviceBotSessions: ServiceBotSession[];
  serviceBotRecords: ServiceBotRecord[];
  serviceBotFollowUps: ServiceBotFollowUp[];
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: AdminSettings = {
  askNameEnabled: false,
  nameTimeoutMinutes: 5,
  contactsProvider: config.WHATSAPP_PROVIDER === 'TWILIO_API' ? 'manual' : 'google',
  readReceiptsEnabled: false,
  askNameText: config.ASK_NAME_TEXT,
  replyText: config.REPLY_TEXT,
  followupMessages: [],
  completionLinks: [],
  completionFileIds: [],
  contactCardPlacement: 'after_completion',
  contactCardSendMode: 'separate',
  contactCardIntroText: '',
  contactCardWaitForConfirmation: false,
  contactCardConfirmationTimeoutMinutes: 30,
  decisionFlow: [],
  decisionTimeoutMinutes: 30,
  decisionTimeoutText: '',
  decisionTimeoutMode: 'message',
  decisionTimeoutNextStepId: '',
  invalidReplyText: '\u05dc\u05d0 \u05d4\u05e6\u05dc\u05d7\u05ea\u05d9 \u05dc\u05d6\u05d4\u05d5\u05ea \u05d0\u05ea \u05d4\u05ea\u05e9\u05d5\u05d1\u05d4. \u05d1\u05d1\u05e7\u05e9\u05d4 \u05dc\u05d1\u05d7\u05d5\u05e8 \u05d0\u05d7\u05ea \u05de\u05d4\u05d0\u05e4\u05e9\u05e8\u05d5\u05d9\u05d5\u05ea \u05e9\u05de\u05d5\u05e4\u05d9\u05e2\u05d5\u05ea \u05d1\u05d4\u05d5\u05d3\u05e2\u05d4.',
  flowRecoveryText: '\u05e0\u05e8\u05d0\u05d4 \u05e9\u05d4\u05e9\u05d9\u05d7\u05d4 \u05e0\u05e7\u05d8\u05e2\u05d4. \u05e0\u05d7\u05d6\u05d5\u05e8 \u05dc\u05e9\u05d0\u05dc\u05d4 \u05d4\u05d0\u05d7\u05e8\u05d5\u05e0\u05d4 \u05db\u05d3\u05d9 \u05e9\u05d0\u05e4\u05e9\u05e8 \u05d9\u05d4\u05d9\u05d4 \u05dc\u05d4\u05de\u05e9\u05d9\u05da.',
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

export const DEFAULT_SERVICE_BOT: ServiceBotConfig = {
  id: 'service-bot-main',
  enabled: false,
  name: '',
  triggerText: '\u05ea\u05e4\u05e8\u05d9\u05d8',
  mainMenuNodeId: '',
  fallbackText: '\u05dc\u05d0 \u05d4\u05e6\u05dc\u05d7\u05ea\u05d9 \u05dc\u05d6\u05d4\u05d5\u05ea \u05d0\u05ea \u05d4\u05d1\u05d7\u05d9\u05e8\u05d4. \u05d0\u05e4\u05e9\u05e8 \u05dc\u05d1\u05d7\u05d5\u05e8 \u05d0\u05d7\u05ea \u05de\u05d4\u05d0\u05e4\u05e9\u05e8\u05d5\u05d9\u05d5\u05ea.',
  sessionTimeoutMinutes: 60,
  navigationPromptText: '\u05de\u05d4 \u05ea\u05e8\u05e6\u05d5 \u05dc\u05e9\u05e2\u05d5\u05ea \u05e2\u05db\u05e9\u05d9\u05d5?',
  backLabel: '\u05d7\u05d6\u05e8\u05d4 \u05dc\u05ea\u05e4\u05e8\u05d9\u05d8 \u05d4\u05e7\u05d5\u05d3\u05dd',
  mainMenuLabel: '\u05d7\u05d6\u05e8\u05d4 \u05dc\u05ea\u05e4\u05e8\u05d9\u05d8 \u05d4\u05e8\u05d0\u05e9\u05d9',
  outsideHoursEnabled: false,
  outsideHoursStart: '09:00',
  outsideHoursEnd: '17:00',
  outsideHoursText: '',
  globalHandoffEnabled: false,
  globalHandoffLabel: '\u05e9\u05d9\u05d7\u05d4 \u05e2\u05dd \u05e0\u05e6\u05d9\u05d2',
  globalHandoffPhone: '',
  globalHandoffText: '\u05d0\u05e4\u05e9\u05e8 \u05dc\u05d4\u05de\u05e9\u05d9\u05da \u05dc\u05e0\u05e6\u05d9\u05d2.',
  nodes: [],
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

function cloneServiceBot(value: Partial<ServiceBotConfig> | undefined, fallbackId = DEFAULT_SERVICE_BOT.id): ServiceBotConfig {
  const now = new Date().toISOString();
  return {
    ...DEFAULT_SERVICE_BOT,
    ...(value ?? {}),
    id: String(value?.id || fallbackId).trim() || fallbackId,
    createdAt: value?.createdAt || now,
    updatedAt: value?.updatedAt || value?.createdAt || now,
    nodes: Array.isArray(value?.nodes) ? JSON.parse(JSON.stringify(value.nodes)) : [],
  };
}

function serviceBotsFromSnapshot(value: Partial<StorageData>): ServiceBotConfig[] {
  const rawBots = Array.isArray(value.serviceBots) ? value.serviceBots : [];
  if (rawBots.length) return rawBots.map((bot, index) => cloneServiceBot(bot, `service-bot-${index + 1}`));
  const legacy = value.serviceBot;
  if (!legacy) return [];
  return [cloneServiceBot(legacy, DEFAULT_SERVICE_BOT.id)];
}

function withMigratedServiceBotRelations(
  bots: ServiceBotConfig[],
  sessions: ServiceBotSession[],
  records: ServiceBotRecord[],
  followUps: ServiceBotFollowUp[],
): Pick<StorageData, 'serviceBotSessions' | 'serviceBotRecords' | 'serviceBotFollowUps'> {
  const fallbackBotId = bots[0]?.id || DEFAULT_SERVICE_BOT.id;
  return {
    serviceBotSessions: sessions.map((item) => ({ ...item, botId: String(item.botId || fallbackBotId) })),
    serviceBotRecords: records.map((item) => ({ ...item, botId: String(item.botId || fallbackBotId) })),
    serviceBotFollowUps: followUps.map((item) => ({ ...item, botId: String(item.botId || fallbackBotId) })),
  };
}

export function emptyStorageData(): StorageData {
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
    outboxMessages: [],
    scheduledJobs: [],
    serviceBots: [],
    serviceBot: { ...DEFAULT_SERVICE_BOT, nodes: [] },
    serviceBotSessions: [],
    serviceBotRecords: [],
    serviceBotFollowUps: [],
  };
}

// ─── Storage class ────────────────────────────────────────────────────────────

export interface StoragePersistBackend {
  mode: 'postgres';
  persistSnapshot(data: StorageData): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  health(): { enabled: boolean; ready: boolean; lastError?: string; pendingWrites: number; lastWriteAt?: string };
}

interface StorageOptions {
  initialData?: StorageData;
  backend?: StoragePersistBackend;
}

export class Storage {
  private readonly filePath: string;
  private readonly backend?: StoragePersistBackend;
  private data: StorageData;

  constructor(filePath: string, options: StorageOptions = {}) {
    this.filePath = filePath;
    this.backend = options.backend;
    if (options.initialData) {
      const initial = options.initialData as Partial<StorageData>;
      const serviceBots = serviceBotsFromSnapshot(initial);
      const relations = withMigratedServiceBotRelations(
        serviceBots,
        Array.isArray(initial.serviceBotSessions) ? initial.serviceBotSessions : [],
        Array.isArray(initial.serviceBotRecords) ? initial.serviceBotRecords : [],
        Array.isArray(initial.serviceBotFollowUps) ? initial.serviceBotFollowUps : [],
      );
      this.data = {
        ...emptyStorageData(),
        ...initial,
        serviceBots,
        serviceBot: serviceBots[0] ?? cloneServiceBot(undefined),
        ...relations,
      };
    } else {
      this.data = this.load();
    }
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

    const serviceBots = serviceBotsFromSnapshot(parsed);
    const relations = withMigratedServiceBotRelations(
      serviceBots,
      Array.isArray((parsed as any).serviceBotSessions) ? (parsed as any).serviceBotSessions : [],
      Array.isArray((parsed as any).serviceBotRecords) ? (parsed as any).serviceBotRecords : [],
      Array.isArray((parsed as any).serviceBotFollowUps) ? (parsed as any).serviceBotFollowUps : [],
    );

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
      outboxMessages: (parsed as any).outboxMessages ?? [],
      conversationStateSnapshot: (parsed as any).conversationStateSnapshot,
      scheduledJobs: (parsed as any).scheduledJobs ?? [],
      serviceBots,
      serviceBot: serviceBots[0] ?? cloneServiceBot(undefined),
      ...relations,
    };
  }

  private persist(): void {
    if (this.backend) {
      this.backend.persistSnapshot(this.data);
      return;
    }

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

  getStorageHealth(): ReturnType<StoragePersistBackend['health']> | { enabled: false; ready: true; pendingWrites: 0 } {
    return this.backend?.health() ?? { enabled: false, ready: true, pendingWrites: 0 };
  }

  async flush(): Promise<void> {
    await this.backend?.flush();
  }

  async close(): Promise<void> {
    await this.backend?.close();
  }

  enqueueOutboxMessage(input: Omit<OutboxMessage, 'id' | 'status' | 'attempts' | 'createdAt' | 'updatedAt'>): OutboxMessage {
    const existing = input.idempotencyKey
      ? this.data.outboxMessages.find((item) => item.idempotencyKey === input.idempotencyKey)
      : undefined;
    if (existing) return this.copyOutboxMessage(existing);

    const now = new Date().toISOString();
    const message: OutboxMessage = {
      id: generateId(),
      status: 'queued',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    this.data.outboxMessages.push(message);
    this.persist();
    return this.copyOutboxMessage(message);
  }

  markOutboxProcessing(id: string): void {
    const message = this.data.outboxMessages.find((item) => item.id === id);
    if (!message) return;
    message.status = 'processing';
    message.attempts += 1;
    message.updatedAt = new Date().toISOString();
    message.processingStartedAt = message.updatedAt;
    message.lastError = undefined;
    this.persist();
  }

  markOutboxSent(id: string, providerMessageId?: string): void {
    const message = this.data.outboxMessages.find((item) => item.id === id);
    if (!message) return;
    message.status = 'sent';
    message.providerMessageId = providerMessageId;
    message.nextAttemptAt = undefined;
    message.processingStartedAt = undefined;
    message.lastError = undefined;
    message.updatedAt = new Date().toISOString();
    this.persist();
  }

  markOutboxRetry(id: string, error: unknown, nextAttemptAt?: string): void {
    const message = this.data.outboxMessages.find((item) => item.id === id);
    if (!message) return;
    message.status = 'retry';
    message.lastError = error instanceof Error ? error.message : String(error);
    message.nextAttemptAt = nextAttemptAt;
    message.processingStartedAt = undefined;
    message.updatedAt = new Date().toISOString();
    this.persist();
  }

  markOutboxFailed(id: string, error: unknown): void {
    const message = this.data.outboxMessages.find((item) => item.id === id);
    if (!message) return;
    message.status = 'failed';
    message.lastError = error instanceof Error ? error.message : String(error);
    message.nextAttemptAt = undefined;
    message.processingStartedAt = undefined;
    message.updatedAt = new Date().toISOString();
    this.persist();
  }

  getOutboxMessages(limit = 100): OutboxMessage[] {
    return this.data.outboxMessages
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((message) => this.copyOutboxMessage(message));
  }

  getPendingOutboxMessages(limit = 50, now = new Date(), processingStaleMs = 2 * 60 * 1000): OutboxMessage[] {
    const nowMs = now.getTime();
    const firstOutstandingByRecipient = new Map<string, OutboxMessage>();
    const ordered = this.data.outboxMessages
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const message of ordered) {
      if (message.status === 'sent' || message.status === 'failed') continue;
      const recipient = normalizeOutboxRecipient(message.to);
      if (!firstOutstandingByRecipient.has(recipient)) {
        firstOutstandingByRecipient.set(recipient, message);
      }
    }
    return [...firstOutstandingByRecipient.values()]
      .filter((message) => this.isOutboxClaimable(message, nowMs, processingStaleMs))
      .slice(0, limit)
      .map((message) => this.copyOutboxMessage(message));
  }

  claimOutboxMessage(id: string, now = new Date(), processingStaleMs = 2 * 60 * 1000): OutboxMessage | null {
    const messageIndex = this.data.outboxMessages.findIndex((item) => item.id === id);
    const message = messageIndex >= 0 ? this.data.outboxMessages[messageIndex] : undefined;
    if (!message || !this.isOutboxClaimable(message, now.getTime(), processingStaleMs)) return null;
    const recipient = normalizeOutboxRecipient(message.to);
    const hasEarlierOutstanding = this.data.outboxMessages.slice(0, messageIndex).some((earlier) =>
      normalizeOutboxRecipient(earlier.to) === recipient
      && earlier.status !== 'sent'
      && earlier.status !== 'failed');
    if (hasEarlierOutstanding) return null;
    this.markOutboxProcessing(id);
    return this.copyOutboxMessage(message);
  }

  private isOutboxClaimable(message: OutboxMessage, nowMs: number, processingStaleMs: number): boolean {
    if (message.status === 'queued') return true;
    if (message.status === 'retry') {
      return !message.nextAttemptAt || Date.parse(message.nextAttemptAt) <= nowMs;
    }
    if (message.status !== 'processing') return false;
    const processingStartedMs = Date.parse(message.processingStartedAt || message.updatedAt);
    return !Number.isFinite(processingStartedMs) || processingStartedMs <= nowMs - processingStaleMs;
  }

  private copyOutboxMessage(message: OutboxMessage): OutboxMessage {
    return {
      ...message,
      fileOptions: message.fileOptions ? { ...message.fileOptions } : undefined,
      buttons: message.buttons?.map((button) => ({ ...button })),
      items: message.items?.map((item) => ({ ...item })),
      contacts: message.contacts?.map((contact) => ({ ...contact })),
      templateBodyParameters: message.templateBodyParameters ? [...message.templateBodyParameters] : undefined,
    };
  }

  /** Record an async delivery result reported by the provider's status webhook. */
  recordOutboxDelivery(providerMessageId: string, status: 'sent' | 'delivered' | 'read' | 'failed', error?: string): OutboxMessage | null {
    const id = String(providerMessageId || '').trim();
    if (!id) return null;
    const message = this.data.outboxMessages.find((item) => item.providerMessageId === id);
    if (!message) return null;
    // Never let a late 'sent' clobber a terminal 'delivered'/'read'/'failed' already recorded.
    const rank = { sent: 1, delivered: 2, read: 3, failed: 3 } as const;
    if (message.deliveryStatus && rank[status] < rank[message.deliveryStatus]) return message;
    message.deliveryStatus = status;
    message.deliveryError = status === 'failed' ? (error || 'Delivery failed') : undefined;
    message.deliveryUpdatedAt = new Date().toISOString();
    this.persist();
    return message;
  }

  /** Recent messages the provider reported as failed to deliver, newest first. */
  getFailedDeliveries(limit = 20): OutboxMessage[] {
    return this.data.outboxMessages
      .filter((item) => item.deliveryStatus === 'failed')
      .sort((a, b) => String(b.deliveryUpdatedAt ?? '').localeCompare(String(a.deliveryUpdatedAt ?? '')))
      .slice(0, limit);
  }

  getOutboxHealth(): Record<OutboxMessageStatus | 'total', number> {
    const counts = { total: this.data.outboxMessages.length, queued: 0, processing: 0, sent: 0, failed: 0, retry: 0 };
    for (const message of this.data.outboxMessages) counts[message.status] += 1;
    return counts;
  }

  loadConversationStateSnapshot(): ConversationStateSnapshot | undefined {
    return this.data.conversationStateSnapshot
      ? JSON.parse(JSON.stringify(this.data.conversationStateSnapshot)) as ConversationStateSnapshot
      : undefined;
  }

  saveConversationStateSnapshot(snapshot: ConversationStateSnapshot): void {
    this.data.conversationStateSnapshot = JSON.parse(JSON.stringify(snapshot)) as ConversationStateSnapshot;
    this.persist();
  }

  getDurableTimerHealth(): { scheduled: number; jobs: number } {
    return {
      scheduled: Object.keys(this.data.conversationStateSnapshot?.conversations ?? {}).length,
      jobs: this.data.scheduledJobs.filter((job) => job.status === 'scheduled' || job.status === 'running').length,
    };
  }

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

  getDueContactSaveJob(now = new Date(), options: { includeGoogle?: boolean } = {}): ContactSaveJob | null {
    const due = this.data.contactQueue
      .filter((job) => {
        if (job.status !== 'pending') return false;
        if (job.provider === 'google' && options.includeGoogle === false) return false;
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

  deleteUploadedFile(id: string): UploadedFile | null {
    const index = this.data.uploadedFiles.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const [removed] = this.data.uploadedFiles.splice(index, 1);
    this.persist();
    return { ...removed };
  }

  private matchesResultBatch(itemBatchId: string | undefined, requestedBatchId?: string): boolean {
    if (!requestedBatchId) return true;
    return (itemBatchId || 'legacy') === requestedBatchId;
  }

  getCurrentCampaignResultBatchId(campaignId: string): string {
    const campaign = this.data.campaigns.find((item) => item.id === campaignId);
    if (!campaign) return 'legacy';
    if (!campaign.currentResultBatchId) {
      campaign.currentResultBatchId = 'legacy';
      campaign.currentResultBatchStartedAt = campaign.currentResultBatchStartedAt || campaign.startAt || undefined;
    }
    return campaign.currentResultBatchId;
  }

  startNewCampaignResultBatch(campaignId: string): CampaignResultBatch | null {
    const campaign = this.data.campaigns.find((item) => item.id === campaignId);
    if (!campaign) return null;
    const now = new Date().toISOString();
    const batchId = generateId();
    campaign.currentResultBatchId = batchId;
    campaign.currentResultBatchStartedAt = now;
    this.persist();
    return { id: batchId, label: this.getCampaignResultBatchLabel(campaign, batchId), startedAt: now, total: 0, isCurrent: true };
  }

  getCampaignResultBatches(campaignId: string): CampaignResultBatch[] {
    const campaign = this.data.campaigns.find((item) => item.id === campaignId);
    const currentBatchId = campaign?.currentResultBatchId || 'legacy';
    const startedById = new Map<string, string | undefined>();
    if (campaign?.currentResultBatchStartedAt) startedById.set(currentBatchId, campaign.currentResultBatchStartedAt);
    const totals = new Map<string, number>();
    for (const result of this.data.campaignResults) {
      if (result.campaignId !== campaignId) continue;
      const batchId = result.resultBatchId || 'legacy';
      totals.set(batchId, (totals.get(batchId) || 0) + 1);
      const existing = startedById.get(batchId);
      if (!existing || result.triggeredAt < existing) startedById.set(batchId, result.triggeredAt);
    }
    if (campaign && !totals.has(currentBatchId)) totals.set(currentBatchId, 0);
    return [...totals.entries()]
      .map(([id, total]) => ({
        id,
        label: campaign ? this.getCampaignResultBatchLabel(campaign, id) : id,
        startedAt: startedById.get(id),
        total,
        isCurrent: id === currentBatchId,
      }))
      .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  }

  private getCampaignResultBatchLabel(campaign: Campaign, batchId: string): string {
    if (batchId === 'legacy') return 'First file';
    const batches = new Set(this.data.campaignResults
      .filter((result) => result.campaignId === campaign.id)
      .map((result) => result.resultBatchId || 'legacy'));
    if (campaign.currentResultBatchId) batches.add(campaign.currentResultBatchId);
    const sortedIds = [...batches].sort();
    const index = sortedIds.includes(batchId) ? sortedIds.indexOf(batchId) + 1 : sortedIds.length + 1;
    return `File ${index}`;
  }
  // Campaign results
  recordCampaignTrigger(campaignId: string, phone: string, whatsappName = '', referredByCode = '', isDemo = false): CampaignResult {
    const now = new Date().toISOString();
    const resultBatchId = this.getCurrentCampaignResultBatchId(campaignId);
    const referrer = referredByCode ? this.findCampaignReferral(campaignId, referredByCode) : null;
    const result: CampaignResult = {
      id: generateId(),
      campaignId,
      resultBatchId,
      phone,
      whatsappName,
      referralCode: this.generateUniqueReferralCode(campaignId, phone),
      referredByCode: referrer?.referralCode,
      referredByResultId: referrer?.id,
      referredByName: referrer ? this.resultDisplayName(referrer) : undefined,
      referredByPhone: referrer?.phone,
      fallbackName: '',
      lastStage: 'triggered',
      lastEventAt: now,
      status: 'awaiting_name',
      triggeredAt: now,
      updatedAt: now,
      isDemo,
    };
    this.data.campaignResults.push(result);
    this.persist();
    return { ...result };
  }

  seedCampaignReferralDemo(campaignId: string): { added: number; removed: number } {
    const removed = this.clearCampaignReferralDemo(campaignId, false);
    const leaders = [
      { name: 'Demo - Noa', phone: '972599100001', invited: 14 },
      { name: 'Demo - Maya', phone: '972599100002', invited: 10 },
      { name: 'Demo - Lior', phone: '972599100003', invited: 7 },
      { name: 'Demo - Yael', phone: '972599100004', invited: 4 },
      { name: 'Demo - Shira', phone: '972599100005', invited: 2 },
    ];
    let added = 0;
    for (const leader of leaders) {
      const referrer = this.recordCampaignTrigger(campaignId, leader.phone, leader.name, '', true);
      const storedReferrer = this.data.campaignResults.find((item) => item.id === referrer.id);
      if (storedReferrer) storedReferrer.status = 'saved';
      added += 1;
      for (let index = 1; index <= leader.invited; index += 1) {
        const phone = '972598' + String(leader.phone.slice(-3)) + String(index).padStart(3, '0');
        const invitee = this.recordCampaignTrigger(campaignId, phone, leader.name + ' invite ' + index, referrer.referralCode, true);
        const storedInvitee = this.data.campaignResults.find((item) => item.id === invitee.id);
        if (storedInvitee) {
          storedInvitee.status = index % 3 === 0 ? 'pending' : 'saved';
          // Invitees should contribute to their leader, not appear as leaders themselves.
          storedInvitee.referralCode = undefined;
        }
        added += 1;
      }
    }
    this.persist();
    return { added, removed };
  }

  clearCampaignReferralDemo(campaignId: string, persist = true): number {
    const before = this.data.campaignResults.length;
    this.data.campaignResults = this.data.campaignResults.filter((result) => !(result.campaignId === campaignId && result.isDemo));
    const removed = before - this.data.campaignResults.length;
    if (persist && removed) this.persist();
    return removed;
  }
  ensureCampaignResultReferralCode(resultId: string | undefined): string {
    if (!resultId) return '';
    const result = this.data.campaignResults.find((item) => item.id === resultId);
    if (!result) return '';
    const currentCode = normalizeReferralCode(result.referralCode);
    if (!/^[A-Z]{1,2}\d{4}$/.test(currentCode)) {
      const nextCode = this.generateUniqueReferralCode(result.campaignId, result.phone);
      if (currentCode) {
        result.referralCodeAliases = [...new Set([...(result.referralCodeAliases || []), currentCode])];
        for (const invitee of this.data.campaignResults) {
          if (invitee.campaignId !== result.campaignId) continue;
          if (invitee.referredByResultId === result.id || normalizeReferralCode(invitee.referredByCode) === currentCode) {
            invitee.referredByCode = nextCode;
          }
        }
      }
      result.referralCode = nextCode;
      this.persist();
    }
    return result.referralCode || '';
  }

  findCampaignReferral(campaignId: string, code: string): CampaignResult | null {
    const cleanCode = normalizeReferralCode(code);
    if (!cleanCode) return null;
    const result = this.data.campaignResults.find((item) => item.campaignId === campaignId && (
      normalizeReferralCode(item.referralCode) === cleanCode
      || (item.referralCodeAliases || []).some((alias) => normalizeReferralCode(alias) === cleanCode)
    ));
    return result ? { ...result } : null;
  }

  getCampaignReferralLeaderboard(campaignId: string, resultBatchId?: string): Array<{ referralCode: string; name: string; phone: string; invited: number; saved: number; lastReferralAt?: string }> {
    const batchId = resultBatchId || this.getCurrentCampaignResultBatchId(campaignId);
    const results = this.data.campaignResults.filter((result) => result.campaignId === campaignId && this.matchesResultBatch(result.resultBatchId, batchId));
    const referrerByPhone = new Map<string, CampaignResult>();
    const referrerPhoneByCode = new Map<string, string>();
    for (const result of results) {
      const phoneKey = normalizeCampaignPhone(result.phone);
      const code = normalizeReferralCode(result.referralCode);
      if (!phoneKey || !code) continue;
      if (!referrerByPhone.has(phoneKey)) referrerByPhone.set(phoneKey, result);
      referrerPhoneByCode.set(code, phoneKey);
      for (const alias of result.referralCodeAliases || []) {
        const aliasCode = normalizeReferralCode(alias);
        if (aliasCode) referrerPhoneByCode.set(aliasCode, phoneKey);
      }
    }
    const invitedByReferrer = new Map<string, Map<string, CampaignResult>>();
    for (const result of results) {
      const referrerPhone = referrerPhoneByCode.get(normalizeReferralCode(result.referredByCode));
      const invitedPhone = normalizeCampaignPhone(result.phone);
      if (!referrerPhone || !invitedPhone || referrerPhone === invitedPhone) continue;
      const invited = invitedByReferrer.get(referrerPhone) || new Map<string, CampaignResult>();
      const existing = invited.get(invitedPhone);
      if (!existing || (existing.status !== 'saved' && result.status === 'saved')) invited.set(invitedPhone, result);
      invitedByReferrer.set(referrerPhone, invited);
    }
    const rows = [...referrerByPhone.entries()].map(([phoneKey, referrer]) => {
      const invitedResults = [...(invitedByReferrer.get(phoneKey)?.values() || [])];
      return { referralCode: referrer.referralCode || '', name: this.resultDisplayName(referrer), phone: referrer.phone, invited: invitedResults.length, saved: invitedResults.filter((result) => result.status === 'saved').length, lastReferralAt: invitedResults.map((result) => result.triggeredAt).sort().at(-1) };
    });
    return rows.sort((a, b) => b.invited - a.invited || b.saved - a.saved || a.name.localeCompare(b.name));
  }

  getCampaignReferralRank(campaignId: string, phone: string, resultBatchId?: string): { rank: number; participants: number; invited: number; saved: number; nextGap: number } | null {
    const rows = this.getCampaignReferralLeaderboard(campaignId, resultBatchId);
    const index = rows.findIndex((row) => normalizeCampaignPhone(row.phone) === normalizeCampaignPhone(phone));
    if (index < 0) return null;
    const row = rows[index];
    const rank = rows.findIndex((candidate) => candidate.invited === row.invited && candidate.saved === row.saved) + 1;
    const previous = rank > 1 ? rows[rank - 2] : undefined;
    return { rank, participants: rows.length, invited: row.invited, saved: row.saved, nextGap: previous ? Math.max(0, previous.invited - row.invited + 1) : 0 };
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

  queueAwaitingNameCampaignResults(campaignId: string, resultBatchId?: string): { queued: number; skipped: number } {
    const campaign = this.data.campaigns.find((item) => item.id === campaignId);
    const suffix = campaign?.suffix ?? '';
    const campaignName = campaign?.name?.trim() || 'קמפיין';
    let queued = 0;
    let skipped = 0;

    for (const result of this.data.campaignResults) {
      if (result.campaignId !== campaignId || result.status !== 'awaiting_name' || !this.matchesResultBatch(result.resultBatchId, resultBatchId)) continue;
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

  queueUnsavedCampaignResults(campaignId: string, resultBatchId?: string): { queued: number; skipped: number } {
    const campaign = this.data.campaigns.find((item) => item.id === campaignId);
    const suffix = campaign?.suffix ?? '';
    const campaignName = campaign?.name?.trim() || 'Campaign';
    let queued = 0;
    let skipped = 0;

    for (const result of this.data.campaignResults) {
      if (result.campaignId !== campaignId || result.status === 'saved' || !this.matchesResultBatch(result.resultBatchId, resultBatchId)) continue;
      const baseName = result.whatsappName?.trim()
        || result.fallbackName?.trim()
        || `${campaignName} - ${result.phone}`;
      const finalName = baseName.endsWith(suffix) ? baseName : `${baseName}${suffix}`;
      const job = this.enqueueContactSave(result.phone, finalName, result.id);
      if (job) {
        result.lastStage = 'manually_queued_unsaved';
        result.lastEventAt = new Date().toISOString();
        queued += 1;
      } else {
        skipped += 1;
      }
    }
    if (queued || skipped) this.persist();
    return { queued, skipped };
  }
  getCampaignResults(campaignId?: string, resultBatchId?: string): CampaignResult[] {
    return this.data.campaignResults
      .filter((result) => (!campaignId || result.campaignId === campaignId) && this.matchesResultBatch(result.resultBatchId, resultBatchId))
      .sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt))
      .map((result) => ({ ...result }));
  }

  recordCampaignEmail(resultId: string | undefined, email: string): void {
    if (!resultId) return;
    const result = this.data.campaignResults.find((item) => item.id === resultId);
    if (!result) return;
    const collectedAt = new Date().toISOString();
    result.email = email;
    result.emailCollectedAt = collectedAt;
    result.updatedAt = collectedAt;
    result.lastEventAt = collectedAt;
    this.persist();
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

  getCampaignScoreAnswers(resultId: string | undefined): CampaignScoreAnswer[] {
    if (!resultId) return [];
    const result = this.data.campaignResults.find((item) => item.id === resultId);
    return result?.scoreAnswers ? result.scoreAnswers.map((answer) => ({ ...answer })) : [];
  }

  recordCampaignEvent(event: Omit<CampaignEvent, 'id' | 'createdAt'>): CampaignEvent {
    if (event.dedupeKey && event.campaignResultId) {
      const existing = this.data.campaignEvents.find((item) =>
        item.campaignId === event.campaignId &&
        item.campaignResultId === event.campaignResultId &&
        item.dedupeKey === event.dedupeKey,
      );
      if (existing) return { ...existing };
    }
    const resultBatchId = event.resultBatchId ?? (event.campaignResultId ? this.data.campaignResults.find((item) => item.id === event.campaignResultId)?.resultBatchId : undefined) ?? this.getCurrentCampaignResultBatchId(event.campaignId);
    const saved: CampaignEvent = {
      id: generateId(),
      createdAt: new Date().toISOString(),
      ...event,
      resultBatchId,
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

  getCampaignEvents(campaignId?: string, resultBatchId?: string): CampaignEvent[] {
    return this.data.campaignEvents
      .filter((event) => (!campaignId || event.campaignId === campaignId) && this.matchesResultBatch(event.resultBatchId, resultBatchId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((event) => ({ ...event }));
  }

  resetCampaignData(campaignId: string): { results: number; events: number; queueJobs: number; batchId: string } | null {
    const campaign = this.data.campaigns.find((item) => item.id === campaignId);
    if (!campaign) return null;

    const resultIds = new Set(this.data.campaignResults
      .filter((result) => result.campaignId === campaignId)
      .map((result) => result.id));
    const results = resultIds.size;
    const events = this.data.campaignEvents.filter((event) => event.campaignId === campaignId).length;
    this.data.campaignResults = this.data.campaignResults.filter((result) => result.campaignId !== campaignId);
    this.data.campaignEvents = this.data.campaignEvents.filter((event) => event.campaignId !== campaignId);

    let queueJobs = 0;
    this.data.contactQueue = this.data.contactQueue.filter((job) => {
      const linkedIds = job.campaignResultIds ?? [];
      const remainingIds = linkedIds.filter((id) => !resultIds.has(id));
      if (remainingIds.length === linkedIds.length) return true;
      queueJobs += 1;
      if (!remainingIds.length) return false;
      job.campaignResultIds = remainingIds;
      return true;
    });

    const now = new Date().toISOString();
    const batchId = generateId();
    campaign.currentResultBatchId = batchId;
    campaign.currentResultBatchStartedAt = now;
    this.persist();
    return { results, events, queueJobs, batchId };
  }

  getCampaignResultSummary(campaignId: string, resultBatchId?: string): {
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
    const results = this.data.campaignResults.filter((result) => result.campaignId === campaignId && this.matchesResultBatch(result.resultBatchId, resultBatchId));
    const events = this.data.campaignEvents.filter((event) => event.campaignId === campaignId && this.matchesResultBatch(event.resultBatchId, resultBatchId));
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

  private generateUniqueReferralCode(campaignId: string, phone: string): string {
    const phoneDigits = normalizeCampaignPhone(phone);
    const phoneSuffix = phoneDigits.length >= 4
      ? phoneDigits.slice(-4)
      : String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
    const usedCodes = new Set(this.data.campaignResults
      .filter((result) => result.campaignId === campaignId)
      .flatMap((result) => [result.referralCode, ...(result.referralCodeAliases || [])])
      .map((code) => normalizeReferralCode(code))
      .filter(Boolean));

    // A4821 is the first owner of the suffix, B4821 the second, then C4821, etc.
    for (let index = 0; index < 26 * 26; index += 1) {
      const code = referralLetter(index) + phoneSuffix;
      if (!usedCodes.has(code)) return code;
    }

    return `${Date.now().toString(36).toUpperCase()}${phoneSuffix}`;
  }

  private resultDisplayName(result: CampaignResult): string {
    return result.fallbackName?.trim() || result.whatsappName?.trim() || result.phone;
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

  private syncLegacyServiceBotMirror(): void {
    this.data.serviceBot = this.data.serviceBots[0] ?? cloneServiceBot(undefined);
  }

  getServiceBots(): ServiceBotConfig[] {
    return JSON.parse(JSON.stringify(this.data.serviceBots)) as ServiceBotConfig[];
  }

  getServiceBot(botId?: string): ServiceBotConfig {
    const bot = (botId ? this.data.serviceBots.find((item) => item.id === botId) : this.data.serviceBots[0])
      ?? this.data.serviceBot
      ?? cloneServiceBot(undefined);
    return JSON.parse(JSON.stringify(bot)) as ServiceBotConfig;
  }

  createServiceBot(input: Partial<ServiceBotConfig> = {}): ServiceBotConfig {
    const now = new Date().toISOString();
    let id = String(input.id || `service-bot-${generateId()}`).trim();
    while (this.data.serviceBots.some((item) => item.id === id)) id = `service-bot-${generateId()}`;
    const bot = cloneServiceBot({ ...input, id, createdAt: now, updatedAt: now }, id);
    this.data.serviceBots.push(bot);
    this.syncLegacyServiceBotMirror();
    this.persist();
    return this.getServiceBot(id);
  }

  updateServiceBot(serviceBot: ServiceBotConfig, botId?: string): ServiceBotConfig {
    const requestedId = String(botId || serviceBot.id || this.data.serviceBots[0]?.id || DEFAULT_SERVICE_BOT.id).trim();
    const index = this.data.serviceBots.findIndex((item) => item.id === requestedId);
    const existing = index >= 0 ? this.data.serviceBots[index] : undefined;
    const updated = cloneServiceBot({
      ...serviceBot,
      id: requestedId,
      createdAt: existing?.createdAt || serviceBot.createdAt,
      updatedAt: new Date().toISOString(),
    }, requestedId);
    if (index >= 0) this.data.serviceBots[index] = updated;
    else this.data.serviceBots.push(updated);
    this.syncLegacyServiceBotMirror();
    this.persist();
    return this.getServiceBot(requestedId);
  }

  duplicateServiceBot(botId: string): ServiceBotConfig | null {
    const source = this.data.serviceBots.find((item) => item.id === botId);
    if (!source) return null;
    return this.createServiceBot({
      ...JSON.parse(JSON.stringify(source)),
      id: undefined,
      name: `${source.name || 'Service Bot'} - עותק`,
      enabled: false,
      createdAt: undefined,
      updatedAt: undefined,
    });
  }

  deleteServiceBot(botId: string): boolean {
    const before = this.data.serviceBots.length;
    this.data.serviceBots = this.data.serviceBots.filter((item) => item.id !== botId);
    if (this.data.serviceBots.length === before) return false;
    this.data.serviceBotSessions = this.data.serviceBotSessions.filter((item) => item.botId !== botId);
    this.data.serviceBotRecords = this.data.serviceBotRecords.filter((item) => item.botId !== botId);
    for (const followUp of this.data.serviceBotFollowUps) {
      if (followUp.botId === botId && followUp.status === 'scheduled') followUp.status = 'cancelled';
    }
    this.syncLegacyServiceBotMirror();
    this.persist();
    return true;
  }

  getServiceBotSession(phone: string, botId?: string): ServiceBotSession | null {
    const session = this.data.serviceBotSessions.find((item) => item.phone === phone && (!botId || item.botId === botId));
    const serviceBot = session ? this.data.serviceBots.find((item) => item.id === session.botId) : undefined;
    const timeoutMinutes = Math.max(1, Number(serviceBot?.sessionTimeoutMinutes) || 60);
    if (session && Date.now() - new Date(session.updatedAt).getTime() > timeoutMinutes * 60 * 1000) {
      this.data.serviceBotSessions = this.data.serviceBotSessions.filter((item) => item.phone !== phone);
      this.persist();
      return null;
    }
    return session ? { ...session, path: [...(session.path ?? [])], variables: { ...(session.variables ?? {}) } } : null;
  }

  saveServiceBotSession(phone: string, nodeId: string, path: string[] = [], variables?: Record<string, string>, botId = this.data.serviceBots[0]?.id || DEFAULT_SERVICE_BOT.id): ServiceBotSession {
    const updatedAt = new Date().toISOString();
    const existing = this.data.serviceBotSessions.find((item) => item.phone === phone);
    if (existing) {
      existing.botId = botId;
      existing.nodeId = nodeId;
      existing.path = [...path];
      if (variables) existing.variables = { ...variables };
      existing.updatedAt = updatedAt;
      this.persist();
      return { ...existing, path: [...(existing.path ?? [])], variables: { ...(existing.variables ?? {}) } };
    }
    const session = { botId, phone, nodeId, path: [...path], variables: { ...(variables ?? {}) }, startedAt: updatedAt, updatedAt };
    this.data.serviceBotSessions.push(session);
    this.persist();
    return { ...session, path: [...session.path], variables: { ...session.variables } };
  }

  recordServiceBotProgress(
    phone: string,
    nodeId: string,
    variables: Record<string, string>,
    attachment?: Omit<ServiceBotAttachment, 'capturedAt'>,
    botId = this.data.serviceBots[0]?.id || DEFAULT_SERVICE_BOT.id,
  ): ServiceBotRecord {
    const now = new Date().toISOString();
    let record = this.data.serviceBotRecords.find((item) => item.phone === phone && item.botId === botId);
    if (!record) {
      record = { botId, phone, variables: {}, attachments: [], currentNodeId: nodeId, startedAt: now, updatedAt: now };
      this.data.serviceBotRecords.push(record);
    }
    record.variables = { ...variables };
    record.currentNodeId = nodeId;
    record.updatedAt = now;
    if (attachment && !record.attachments.some((item) => item.messageId === attachment.messageId)) {
      record.attachments.push({ ...attachment, capturedAt: now });
    }
    this.persist();
    return JSON.parse(JSON.stringify(record)) as ServiceBotRecord;
  }

  getServiceBotRecords(limit = 100, botId?: string): ServiceBotRecord[] {
    return this.data.serviceBotRecords
      .filter((record) => !botId || record.botId === botId)
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(1, limit))
      .map((record) => JSON.parse(JSON.stringify(record)) as ServiceBotRecord);
  }

  scheduleServiceBotFollowUp(input: Omit<ServiceBotFollowUp, 'id' | 'status' | 'attempts' | 'createdAt' | 'updatedAt'>): ServiceBotFollowUp {
    const now = new Date().toISOString();
    const followUp: ServiceBotFollowUp = {
      id: generateId(),
      status: 'scheduled',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    this.data.serviceBotFollowUps.push(followUp);
    this.persist();
    return { ...followUp };
  }

  cancelServiceBotFollowUps(phone: string): number {
    let cancelled = 0;
    const now = new Date().toISOString();
    for (const followUp of this.data.serviceBotFollowUps) {
      if (followUp.phone !== phone || followUp.status !== 'scheduled') continue;
      followUp.status = 'cancelled';
      followUp.updatedAt = now;
      cancelled += 1;
    }
    if (cancelled) this.persist();
    return cancelled;
  }

  getDueServiceBotFollowUps(limit = 20, now = new Date()): ServiceBotFollowUp[] {
    return this.data.serviceBotFollowUps
      .filter((item) => item.status === 'scheduled' && Date.parse(item.runAt) <= now.getTime())
      .sort((a, b) => a.runAt.localeCompare(b.runAt))
      .slice(0, limit)
      .map((item) => ({ ...item }));
  }

  claimServiceBotFollowUp(id: string): ServiceBotFollowUp | null {
    const followUp = this.data.serviceBotFollowUps.find((item) => item.id === id);
    if (!followUp || followUp.status !== 'scheduled') return null;
    followUp.status = 'processing';
    followUp.attempts += 1;
    followUp.updatedAt = new Date().toISOString();
    this.persist();
    return { ...followUp };
  }

  completeServiceBotFollowUp(id: string): void {
    const followUp = this.data.serviceBotFollowUps.find((item) => item.id === id);
    if (!followUp) return;
    followUp.status = 'sent';
    followUp.updatedAt = new Date().toISOString();
    followUp.lastError = undefined;
    this.persist();
  }

  failServiceBotFollowUp(id: string, error: unknown): void {
    const followUp = this.data.serviceBotFollowUps.find((item) => item.id === id);
    if (!followUp) return;
    followUp.status = followUp.attempts < 3 ? 'scheduled' : 'failed';
    if (followUp.status === 'scheduled') followUp.runAt = new Date(Date.now() + 60_000).toISOString();
    followUp.updatedAt = new Date().toISOString();
    followUp.lastError = error instanceof Error ? error.message : String(error);
    this.persist();
  }

  clearServiceBotSessions(botId?: string): number {
    const count = this.data.serviceBotSessions.filter((item) => !botId || item.botId === botId).length;
    this.data.serviceBotSessions = this.data.serviceBotSessions.filter((item) => botId && item.botId !== botId);
    for (const followUp of this.data.serviceBotFollowUps) {
      if (followUp.status === 'scheduled' && (!botId || followUp.botId === botId)) followUp.status = 'cancelled';
    }
    this.persist();
    return count;
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
    const invalidReplyText = campaign.conversation?.invalidReplyText?.trim()
      || defaults.invalidReplyText?.trim()
      || DEFAULT_SETTINGS.invalidReplyText;
    const flowRecoveryText = campaign.conversation?.flowRecoveryText?.trim()
      || defaults.flowRecoveryText?.trim()
      || DEFAULT_SETTINGS.flowRecoveryText;
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
      contactCardSendMode: campaign.conversation?.contactCardSendMode ?? defaults.contactCardSendMode ?? 'separate',
      contactCards: campaign.conversation?.contactCards ?? defaults.contactCards ?? [],
      contactCardName: campaign.conversation?.contactCardName ?? defaults.contactCardName ?? '',
      contactCardPhone: campaign.conversation?.contactCardPhone ?? defaults.contactCardPhone ?? '',
      contactCardEmail: campaign.conversation?.contactCardEmail ?? defaults.contactCardEmail ?? '',
      contactCardOrganization: campaign.conversation?.contactCardOrganization ?? defaults.contactCardOrganization ?? '',
      contactCardIntroText: campaign.conversation?.contactCardIntroText ?? defaults.contactCardIntroText ?? '',
      contactCardWaitForConfirmation: campaign.conversation?.contactCardWaitForConfirmation ?? defaults.contactCardWaitForConfirmation ?? false,
      contactCardConfirmationTimeoutMinutes: campaign.conversation?.contactCardConfirmationTimeoutMinutes ?? defaults.contactCardConfirmationTimeoutMinutes ?? 30,
      followupMessages: campaign.conversation?.followupMessages ?? defaults.followupMessages,
      decisionFlow: campaign.conversation?.decisionFlow ?? defaults.decisionFlow,
      decisionTimeoutMinutes: campaign.conversation?.decisionTimeoutMinutes ?? defaults.decisionTimeoutMinutes,
      decisionTimeoutText: campaign.conversation?.decisionTimeoutText ?? defaults.decisionTimeoutText,
      decisionTimeoutMode: campaign.conversation?.decisionTimeoutMode ?? defaults.decisionTimeoutMode ?? 'message',
      decisionTimeoutNextStepId: campaign.conversation?.decisionTimeoutNextStepId ?? defaults.decisionTimeoutNextStepId ?? '',
      invalidReplyText,
      flowRecoveryText,
      humanHandoffEnabled: campaign.conversation?.humanHandoffEnabled ?? defaults.humanHandoffEnabled,
      humanHandoffText: campaign.conversation?.humanHandoffText ?? defaults.humanHandoffText,
      humanHandoffPhone: campaign.conversation?.humanHandoffPhone ?? defaults.humanHandoffPhone,
      // Group-join settings are campaign-level only; AdminSettings has no defaults for them.
      groupJoinManagerPhone: campaign.conversation?.groupJoinManagerPhone ?? '',
      groupJoinParticipantConfirmationText: campaign.conversation?.groupJoinParticipantConfirmationText ?? '',
      groupJoinParticipantFailureText: campaign.conversation?.groupJoinParticipantFailureText ?? '',
      groupJoinMetaTemplateName: campaign.conversation?.groupJoinMetaTemplateName ?? '',
      groupJoinMetaTemplateLanguage: campaign.conversation?.groupJoinMetaTemplateLanguage ?? 'he',
      groupJoinMetaTemplateParams: campaign.conversation?.groupJoinMetaTemplateParams ?? [],
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

  duplicateCampaign(id: string, name: string): Campaign | null {
    const source = this.data.campaigns.find((campaign) => campaign.id === id);
    if (!source) return null;

    const copy = JSON.parse(JSON.stringify(source)) as Campaign;
    const {
      id: _sourceId,
      runtimeStatus: _runtimeStatus,
      currentResultBatchId: _currentResultBatchId,
      currentResultBatchStartedAt: _currentResultBatchStartedAt,
      ...campaignData
    } = copy;

    return this.addCampaign({
      ...campaignData,
      name,
      // A duplicate must never start responding before its trigger is reviewed.
      active: false,
    });
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

  exportDataSnapshot(): StorageData {
    return JSON.parse(JSON.stringify(this.data)) as StorageData;
  }
}

function normalizeCampaignPhone(value: string | undefined): string {
  return String(value || '').replace(/^whatsapp:/i, '').split('@')[0].replace(/\D/g, '');
}

function normalizeOutboxRecipient(value: string | undefined): string {
  const raw = String(value || '').trim().toLowerCase().replace(/^whatsapp:/i, '').split('@')[0];
  return raw.replace(/\D/g, '') || raw;
}

function referralLetter(index: number): string {
  let value = index;
  let letters = '';
  do {
    letters = String.fromCharCode(65 + (value % 26)) + letters;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return letters;
}

function normalizeReferralCode(code: string | undefined): string {
  const clean = String(code ?? '').trim().toUpperCase();
  if (/[A-Z]/.test(clean)) return clean.replace(/[^A-Z0-9]/g, '');
  return normalizeReferralPhone(clean);
}

function normalizeReferralPhone(phone: string | undefined): string {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('972') && digits.length === 12) return '0' + digits.slice(3);
  if (digits.startsWith('00972') && digits.length === 14) return '0' + digits.slice(5);
  return digits;
}

export function loadStorageDataFromFile(filePath: string): StorageData {
  return new Storage(filePath).exportDataSnapshot();
}
