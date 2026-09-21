/**
 * storage.ts
 * JSON-file persistence for saved contacts, admin settings, and campaigns.
 */

import fs from 'fs';
import path from 'path';
import { config } from './config';
import type { ConversationStateSnapshot } from './conversationState';
import { attemptTaggingEnabled, isAttemptId, newAttemptId } from './sendAttempt';
import type { FlowUnitDescriptor } from './flowUnit';

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
  /** Text displayed on the WhatsApp list opener button. Meta limits it to 20 chars. */
  listButtonText?: string;
  /** Controls whether WhatsApp list replies show a numeric row title or the selected option text. */
  listSelectionDisplay?: 'number' | 'text';
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
  /** Controls whether leaderboard rows show the full saved name or the privacy-friendly short name. */
  referralLeaderboardNameDisplay?: 'short' | 'full';
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

/**
 * `uncertain` (stage B): the provider may or may not have accepted the message
 * (timeout / dropped connection / crash while `processing`). It is outstanding,
 * never claimable and blocks later messages to the same recipient. It only
 * leaves this state through resolveOutboxUncertain() or a supersede-cancel.
 */
export type OutboxMessageStatus = 'queued' | 'processing' | 'sent' | 'failed' | 'retry' | 'uncertain' | 'recoverable_failed';

/**
 * `recoverable_failed` (delivery recovery): the recovery budget is used up (every POST that might have
 * reached the provider produced no evidence). Terminal like `failed`: it does NOT block the recipient's
 * queue, it is NOT success, and nothing continues from it. A later delivery callback for it is recorded
 * as evidence only - it never revives the message.
 */
const RECOVERY_WINDOW_DEFAULT_MS = 60_000;
const RECOVERY_WINDOW_NO_CALLBACK_MS = 5_000;
const RECOVERY_POST_BUDGET_DEFAULT = 2;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}
/** How long an uncertain message waits for delivery evidence before a bounded retry. A starting value, not a measured one. */
export const recoveryWindowMs = (): number => {
  // Meta can send a delivery callback, so the window is time WAITING for that evidence (60s, unmeasured starting point).
  // Baileys (and every other non-Meta provider) never sends one: waiting is dead time in which the participant sits in
  // silence, so there the window is only a short backoff before the bounded retry.
  const provider = String(process.env.WHATSAPP_PROVIDER ?? 'BAILEYS').toUpperCase();
  const fallback = provider === 'META_CLOUD_API' ? RECOVERY_WINDOW_DEFAULT_MS : RECOVERY_WINDOW_NO_CALLBACK_MS;
  return envInt('OUTBOX_RECOVERY_WINDOW_MS', fallback, 1_000, 15 * 60_000);
};
/** Total POSTs that may have reached the provider for one message (the original + retries). */
export const recoveryPostBudget = (): number => envInt('OUTBOX_RECOVERY_POST_BUDGET', RECOVERY_POST_BUDGET_DEFAULT, 1, 3);

export interface OutboxRecoveryState {
  /** The attempt this window belongs to: a restart of the SAME attempt keeps its window, a new attempt starts a new one. */
  attemptId?: string;
  uncertainSince: string;
  windowEndsAt: string;
  retriesGranted: number;
  /** A retry after a silent window can deliver a second copy; declared, never hidden. */
  duplicateRiskDeclared?: boolean;
  lastDecision?: string;
}

/** Position of an outbox row inside a flow unit (see flowUnit.ts). */
export interface OutboxFlowRef { unitId: string; index: number }

/** What must happen once, after this message is confirmed delivered. */
export interface OutboxContinuation {
  descriptor: FlowUnitDescriptor;
  state: 'pending' | 'running' | 'done' | 'skipped';
  updatedAt?: string;
}

export type OutboxTransitionEvent = { type: 'sent_after_recovery' | 'retry_granted' | 'recoverable_failed' | 'late_evidence'; id: string };

function isOutboxTerminal(status: OutboxMessageStatus): boolean {
  return status === 'sent' || status === 'failed' || status === 'recoverable_failed';
}
export type OutboxMessageKind = 'text' | 'file' | 'interactive_buttons' | 'interactive_list' | 'contacts' | 'template';

/** One provider POST attempt of an outbox message (stage B2). Kept in the row's persisted JSON. */
export interface OutboxAttemptRecord {
  attemptId: string;
  startedAt: string;
  /** started = POST may be in flight; accepted = provider returned an id; rejected = provider refused / not sent; uncertain = unknown. */
  status: 'started' | 'accepted' | 'rejected' | 'uncertain';
  endedAt?: string;
  providerMessageId?: string;
  /** Further provider ids seen for this attempt (a status may carry a different id than the POST response). */
  providerMessageIds?: string[];
  /** Best delivery status a status webhook reported for THIS attempt. */
  deliveryStatus?: 'sent' | 'delivered' | 'read' | 'failed';
  error?: string;
}

const OUTBOX_ATTEMPT_LOG_MAX = 20;

/** A Meta delivery-status callback, reduced to what matching needs (stage B2, step 2). */
export interface MetaStatusInput {
  wamid: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp?: number;
  recipientId?: string;
  /** biz_opaque_callback_data echoed by Meta: our attemptId when the send was tagged. */
  attemptId?: string;
  phoneNumberId?: string;
  error?: string;
}
/**
 * applied   : matched an outbox message/attempt and changed it
 * duplicate : matched, nothing new (repeat / older than what is recorded)
 * buffered  : untagged status for a message id we do not know YET (may race the POST response); kept briefly
 * foreign   : tagged with an attempt id that is not ours, or an id we never buffer - not ours, dropped
 * mismatch  : matched by id but recipient / business number disagree - refused, never applied
 */
export type MetaStatusResult = 'applied' | 'duplicate' | 'buffered' | 'foreign' | 'mismatch';

const STATUS_RANK = { sent: 1, delivered: 2, read: 3, failed: 3 } as const;
const UNMATCHED_STATUS_MAX = 2000;
const UNMATCHED_STATUS_TTL_MS = 15 * 60 * 1000;

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
  /**
   * Attempt identity (stage B2). `id` is the logical message and never changes; `attemptId` is the
   * CURRENT/last POST attempt, generated and persisted at claim time - before the provider call - and
   * sent as biz_opaque_callback_data. `attemptLog` keeps every attempt so a late status of an
   * EARLIER attempt can still be matched after a retry.
   */
  attemptId?: string;
  attemptLog?: OutboxAttemptRecord[];
  /** Delivery recovery bookkeeping (set when the message first became uncertain). */
  recovery?: OutboxRecoveryState;
  flowRef?: OutboxFlowRef;
  continuation?: OutboxContinuation;
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

/**
 * Logical groups of StorageData that the PostgreSQL backend syncs as independent
 * tables (see writeSnapshotDelta in database.ts). Every call to persist() must name
 * exactly which of these it actually touched, so the backend can skip the expensive
 * full-history diff for tables nothing changed in. `serviceBotState` covers every
 * service-bot field (serviceBots, serviceBot, serviceBotSessions, serviceBotRecords,
 * serviceBotFollowUps), which are written together as one row.
 * `twilioOnboarding` has no dedicated table and is intentionally never listed here.
 */
export type StorageTableName =
  | 'adminSettings'
  | 'clientProfile'
  | 'campaigns'
  | 'campaignResults'
  | 'campaignEvents'
  | 'contactQueue'
  /** The `saved_contacts` table syncs from the `contactsList` field, not the separate `savedContacts: string[]` phone list (which has no dedicated table). */
  | 'contactsList'
  | 'uploadedFiles'
  | 'twilioTemplates'
  | 'outboxMessages'
  | 'conversationStateSnapshot'
  | 'scheduledJobs'
  | 'serviceBotState';

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: AdminSettings = {
  askNameEnabled: false,
  nameTimeoutMinutes: 5,
  contactsProvider: config.WHATSAPP_PROVIDER === 'TWILIO_API' || config.WHATSAPP_PROVIDER === 'META_CLOUD_API' ? 'manual' : 'google',
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

/** Recipient comparison for status matching. Meta's recipient_id can differ from the number we sent to in a few markets, so fall back to the last 8 digits. */
function sameRecipient(statusRecipient: string, outboxTo: string): boolean {
  const a = String(statusRecipient).replace(/\D/g, '');
  const b = String(outboxTo).replace(/\D/g, '');
  if (!a || !b) return true;
  return a === b || (a.length >= 8 && b.length >= 8 && a.slice(-8) === b.slice(-8));
}

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

/** The tables that support row-level dirty tracking. For mutable tables, the
 * ids pinpoint changed rows. For append-only campaignEvents, they identify the
 * new tail so the backend can reuse the already-detached historical prefix. */
const ROW_TRACKED_TABLES: readonly StorageTableName[] = ['outboxMessages', 'campaignResults', 'campaignEvents', 'contactQueue', 'contactsList', 'conversationStateSnapshot'];

export interface StoragePersistBackend {
  mode: 'postgres';
  persistSnapshot(
    data: StorageData,
    dirtyTables: ReadonlySet<StorageTableName> | 'all',
    dirtyRowIds: Partial<Record<StorageTableName, ReadonlySet<string> | 'all'>>,
  ): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  health(): { enabled: boolean; ready: boolean; lastError?: string; pendingWrites: number; lastWriteAt?: string };
}

interface StorageOptions {
  initialData?: StorageData;
  backend?: StoragePersistBackend;
}

export class Storage {
  private readonly claimedInThisProcess = new Set<string>();
  private outboxAttemptIndex: Map<string, string> | null = null;
  private outboxAttemptIndexSource: unknown = null;
  private earlyStatusJournalPath: string | null = null;
  private readonly unmatchedStatuses = new Map<string, Array<{ input: MetaStatusInput; at: number }>>();
  private readonly outboxWakeListeners = new Set<() => void>();
  private readonly outboxTransitionListeners = new Set<(event: OutboxTransitionEvent) => void>();
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

  /**
   * @param dirtyTables Exactly which logical tables this call just changed (can be
   * empty, e.g. a field with no dedicated Postgres table). The PostgreSQL backend
   * uses this to skip re-diffing tables nothing touched. The JSON-file backend
   * ignores it and always rewrites the whole file, so behavior there is unchanged.
   * @param dirtyRowIds For any of ROW_TRACKED_TABLES that's in dirtyTables: the
   * exact row id(s) (or a single id) that changed, letting the backend skip
   * re-comparing the rest of that table. Omit a table's entry when multiple or
   * unknown rows changed - the backend then safely compares every row in it,
   * exactly as before this optimization.
   */
  private persist(dirtyTables: StorageTableName[], dirtyRowIds: Partial<Record<StorageTableName, string | readonly string[]>> = {}): void {
    if (this.backend) {
      const rowIds: Partial<Record<StorageTableName, ReadonlySet<string> | 'all'>> = {};
      for (const table of ROW_TRACKED_TABLES) {
        if (!dirtyTables.includes(table)) continue;
        const ids = dirtyRowIds[table];
        rowIds[table] = ids === undefined ? 'all' : new Set(Array.isArray(ids) ? ids : [ids]);
      }
      this.backend.persistSnapshot(this.data, new Set(dirtyTables), rowIds);
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

  getOutboxMessage(id: string): OutboxMessage | null {
    const message = this.data.outboxMessages.find((item) => item.id === id);
    return message ? this.copyOutboxMessage(message) : null;
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
    this.persist(['outboxMessages'], { outboxMessages: message.id });
    this.notifyOutboxWake();
    return this.copyOutboxMessage(message);
  }

  markOutboxProcessing(id: string): void {
    const message = this.data.outboxMessages.find((item) => item.id === id);
    if (!message) return;
    message.status = 'processing';
    this.claimedInThisProcess.add(id);
    message.attempts += 1;
    // One attempt = one claim = at most one provider POST. Persisted with this same write, i.e. before the send.
    const attemptId = newAttemptId();
    message.attemptId = attemptId;
    const log = message.attemptLog ?? (message.attemptLog = []);
    log.push({ attemptId, startedAt: new Date().toISOString(), status: 'started' });
    if (log.length > OUTBOX_ATTEMPT_LOG_MAX) log.splice(0, log.length - OUTBOX_ATTEMPT_LOG_MAX);
    this.outboxAttemptIndex?.set(attemptId, message.id);
    message.updatedAt = new Date().toISOString();
    message.processingStartedAt = message.updatedAt;
    message.lastError = undefined;
    this.persist(['outboxMessages'], { outboxMessages: message.id });
  }

  hasOutstandingOutboxForRecipient(to: string): boolean {
    const recipient = normalizeOutboxRecipient(to);
    return this.data.outboxMessages.some(item => !isOutboxTerminal(item.status) && normalizeOutboxRecipient(item.to) === recipient);
  }

  cancelOutboxForRecipient(to: string): number {
    const recipient = normalizeOutboxRecipient(to);
    const ids: string[] = [];
    for (const item of this.data.outboxMessages) {
      if (isOutboxTerminal(item.status) || normalizeOutboxRecipient(item.to) !== recipient) continue;
      item.status = 'failed';
      item.lastError = 'Campaign superseded by another campaign; do not retry.';
      item.updatedAt = new Date().toISOString();
      item.nextAttemptAt = undefined;
      ids.push(item.id);
    }
    if (ids.length) this.persist(['outboxMessages'], { outboxMessages: ids });
    return ids.length;
  }

  markOutboxSent(id: string, providerMessageId?: string): void {
    const message = this.data.outboxMessages.find((item) => item.id === id);
    if (!message) return;
    this.claimedInThisProcess.delete(id);
    this.closeCurrentAttempt(message, 'accepted', { providerMessageId });
    // A message that was sent cleanly on its first attempt, with tagging off, has nothing for an attempt record to
    // match later (no provider echo of our id). Not keeping it keeps every outbox row - which lives for the whole
    // history - small. Rows that went through recovery or retries, and every row while tagging is on, keep theirs.
    if (!message.recovery && !attemptTaggingEnabled() && (message.attemptLog?.length ?? 0) <= 1) {
      message.attemptLog = undefined;
      message.attemptId = undefined;
    }
    message.status = 'sent';
    message.providerMessageId = providerMessageId;
    message.nextAttemptAt = undefined;
    message.processingStartedAt = undefined;
    message.lastError = undefined;
    message.updatedAt = new Date().toISOString();
    this.persist(['outboxMessages'], { outboxMessages: message.id });
    if (providerMessageId) this.drainBufferedStatuses(providerMessageId);
    if (message.recovery) this.emitOutboxTransition({ type: 'sent_after_recovery', id: message.id });
  }

  /** Closes the current attempt record with its outcome (no-op if the row has no attempt). */
  private closeCurrentAttempt(message: OutboxMessage, status: OutboxAttemptRecord['status'], detail: { providerMessageId?: string; error?: unknown } = {}): void {
    const record = message.attemptLog?.find((entry) => entry.attemptId === message.attemptId);
    if (!record) return;
    record.status = status;
    record.endedAt = new Date().toISOString();
    if (detail.providerMessageId) record.providerMessageId = detail.providerMessageId;
    if (detail.error !== undefined) record.error = (detail.error instanceof Error ? detail.error.message : String(detail.error)).slice(0, 300);
  }

  /** attemptId of the current attempt of an outbox message (cheap; used to tag the provider call). */
  getOutboxAttemptId(id: string): string | undefined {
    return this.data.outboxMessages.find((item) => item.id === id)?.attemptId;
  }

  /**
   * Exact lookup of the outbox message an attemptId belongs to, over ALL recorded attempts (also
   * earlier ones after a retry). Authoritative: a miss means "not ours" - important on the shared
   * Meta number where every client sees every status.
   */
  private locateAttempt(attemptId: string): { message: OutboxMessage; attempt: OutboxAttemptRecord } | null {
    if (!this.outboxAttemptIndex || this.outboxAttemptIndexSource !== this.data.outboxMessages) {
      this.outboxAttemptIndex = new Map();
      this.outboxAttemptIndexSource = this.data.outboxMessages;
      for (const item of this.data.outboxMessages) {
        for (const entry of item.attemptLog ?? []) this.outboxAttemptIndex.set(entry.attemptId, item.id);
      }
    }
    const id = this.outboxAttemptIndex.get(attemptId);
    const message = id ? this.data.outboxMessages.find((item) => item.id === id) : undefined;
    const attempt = message?.attemptLog?.find((entry) => entry.attemptId === attemptId);
    return message && attempt ? { message, attempt } : null;
  }

  findOutboxByAttemptId(attemptId: string): { message: OutboxMessage; attempt: OutboxAttemptRecord } | null {
    const found = this.locateAttempt(attemptId);
    return found ? { message: this.copyOutboxMessage(found.message), attempt: { ...found.attempt } } : null;
  }

  /**
   * Applies a delivery-status callback with EXACT matching: by our attempt id when the send was tagged,
   * otherwise by provider message id. Never by phone number or time. A tagged status whose attempt id is
   * not ours is foreign (on the shared number every client sees every status). Idempotent: repeats, late
   * and out-of-order statuses never move a message backwards. A status for an id we do not know yet is
   * kept briefly (it can arrive before the POST response is processed) and re-applied when the id is recorded.
   */
  applyMetaStatus(input: MetaStatusInput, context: { expectedPhoneNumberId?: string } = {}): { result: MetaStatusResult; message?: OutboxMessage; attemptId?: string } {
    const wamid = String(input.wamid || '').trim();
    if (!wamid) return { result: 'foreign' };
    let message: OutboxMessage | undefined;
    let attempt: OutboxAttemptRecord | undefined;
    const tagged = isAttemptId(input.attemptId);
    if (tagged) {
      const found = this.locateAttempt(input.attemptId as string);
      if (!found) return { result: 'foreign' };
      message = found.message; attempt = found.attempt;
    } else {
      for (const item of this.data.outboxMessages) {
        const byAttempt = item.attemptLog?.find((entry) => entry.providerMessageId === wamid || entry.providerMessageIds?.includes(wamid));
        if (item.providerMessageId === wamid || byAttempt) { message = item; attempt = byAttempt; break; }
      }
      if (!message) {
        this.bufferUnmatchedStatus({ ...input, wamid });
        return { result: 'buffered' };
      }
    }
    if (input.recipientId && !sameRecipient(input.recipientId, message.to)) return { result: 'mismatch', attemptId: attempt?.attemptId };
    if (input.phoneNumberId && context.expectedPhoneNumberId && input.phoneNumberId !== context.expectedPhoneNumberId) return { result: 'mismatch', attemptId: attempt?.attemptId };

    let changed = false;
    if (attempt) {
      if (!attempt.providerMessageId) { attempt.providerMessageId = wamid; changed = true; }
      else if (attempt.providerMessageId !== wamid && !(attempt.providerMessageIds ?? []).includes(wamid)) { (attempt.providerMessageIds ??= []).push(wamid); changed = true; }
      if (!attempt.deliveryStatus || STATUS_RANK[input.status] > STATUS_RANK[attempt.deliveryStatus]) { attempt.deliveryStatus = input.status; changed = true; }
    }
    if (!message.deliveryStatus || STATUS_RANK[input.status] > STATUS_RANK[message.deliveryStatus]
      || (STATUS_RANK[input.status] === STATUS_RANK[message.deliveryStatus] && input.status !== message.deliveryStatus)) {
      message.deliveryStatus = input.status;
      message.deliveryError = input.status === 'failed' ? (input.error || 'Delivery failed') : undefined;
      message.deliveryUpdatedAt = new Date().toISOString();
      changed = true;
    }
    changed = this.applyDeliveryEvidence(message, attempt, wamid, input.status) || changed;
    if (!changed) return { result: 'duplicate', message: this.copyOutboxMessage(message), attemptId: attempt?.attemptId };
    this.persist(['outboxMessages'], { outboxMessages: message.id });
    return { result: 'applied', message: this.copyOutboxMessage(message), attemptId: attempt?.attemptId };
  }

  /**
   * What a delivery status means for the message state machine. `sent`/`delivered`/`read` prove the provider
   * accepted THAT attempt; `failed` proves it did not. Only messages in recovery move; a message that already
   * reached a terminal state is never revived (late evidence is recorded and reported, nothing else).
   */
  private applyDeliveryEvidence(message: OutboxMessage, attempt: OutboxAttemptRecord | undefined, wamid: string, status: MetaStatusInput['status']): boolean {
    if (!attempt) return false;
    const now = new Date().toISOString();
    if (status === 'failed') {
      if (message.status === 'uncertain' && attempt.attemptId === message.attemptId) {
        attempt.status = 'rejected'; attempt.endedAt = now;   // proven NOT delivered: it no longer counts against the POST budget
        this.releaseUncertainForRetry(message, 'delivery_failed_evidence');
        return true;
      }
      return false;
    }
    // sent / delivered / read
    if (message.status === 'processing') {
      // The POST is still in the air: the send itself decides its own outcome (markOutboxSent / markOutboxUncertain). Marking the
      // row `sent` here would race with that call. The evidence is already durable on the attempt record (deliveryStatus +
      // providerMessageId, persisted by applyMetaStatus) and is consulted where the outcome is decided - see
      // settleSentByDeliveryEvidence (markOutboxUncertain, markOutboxRetry, releaseUncertainForRetry).
      return false;
    }
    if (message.status === 'uncertain' || message.status === 'retry' || message.status === 'queued') {
      attempt.status = 'accepted'; attempt.endedAt = attempt.endedAt ?? now; attempt.providerMessageId = attempt.providerMessageId ?? wamid;
      this.claimedInThisProcess.delete(message.id);
      message.status = 'sent'; message.providerMessageId = wamid; message.nextAttemptAt = undefined;
      message.processingStartedAt = undefined; message.lastError = undefined; message.updatedAt = now;
      if (message.recovery) message.recovery.lastDecision = 'delivery_evidence';
      this.emitOutboxTransition({ type: 'sent_after_recovery', id: message.id });
      return true;
    }
    if (message.status === 'recoverable_failed' || message.status === 'failed') {
      this.emitOutboxTransition({ type: 'late_evidence', id: message.id });   // recorded, never revived
    }
    return false;
  }

  /** An attempt of this message that the provider has confirmed (a `sent` / `delivered` / `read` status matched to it). */
  private attemptWithDeliveryEvidence(message: OutboxMessage): OutboxAttemptRecord | undefined {
    return message.attemptLog?.find((entry) => entry.status !== 'rejected'
      && (entry.deliveryStatus === 'sent' || entry.deliveryStatus === 'delivered' || entry.deliveryStatus === 'read'));
  }

  /**
   * Delivery evidence that arrived while the send was still in the air (or before the outcome was decided) wins over an
   * unknown / retryable outcome: the provider already confirmed a copy, so the message is `sent` and no further POST may
   * be granted. Returns true when it settled the message.
   */
  private settleSentByDeliveryEvidence(message: OutboxMessage): boolean {
    const attempt = this.attemptWithDeliveryEvidence(message);
    if (!attempt) return false;
    const now = new Date().toISOString();
    attempt.status = 'accepted'; attempt.endedAt = attempt.endedAt ?? now;
    this.claimedInThisProcess.delete(message.id);
    message.status = 'sent'; message.providerMessageId = attempt.providerMessageId ?? message.providerMessageId; message.nextAttemptAt = undefined;
    message.processingStartedAt = undefined; message.lastError = undefined; message.updatedAt = now;
    if (message.recovery) message.recovery.lastDecision = 'delivery_evidence_during_send';
    this.persist(['outboxMessages'], { outboxMessages: message.id });
    this.emitOutboxTransition({ type: 'sent_after_recovery', id: message.id });
    return true;
  }

  /** uncertain -> retry (a new POST attempt) if the budget allows, else recoverable_failed. */
  private releaseUncertainForRetry(message: OutboxMessage, reason: string): void {
    if (reason !== 'delivery_failed_evidence' && this.settleSentByDeliveryEvidence(message)) return;
    const possiblyDelivered = (message.attemptLog ?? []).filter((a) => a.status === 'uncertain' || a.status === 'accepted' || a.status === 'started').length;
    const now = new Date().toISOString();
    message.updatedAt = now;
    const recovery = message.recovery ?? (message.recovery = { attemptId: message.attemptId, uncertainSince: now, windowEndsAt: now, retriesGranted: 0 });
    recovery.lastDecision = reason;
    if (possiblyDelivered < recoveryPostBudget()) {
      message.status = 'retry';
      message.nextAttemptAt = undefined;
      recovery.retriesGranted += 1;
      // Only a silent window leaves a genuine chance that BOTH copies arrive; a proven failure does not.
      if (reason === 'window_elapsed_no_evidence') { recovery.duplicateRiskDeclared = true; message.lastError = `${message.lastError ?? ''} | auto-retry after ${recoveryWindowMs()}ms without delivery evidence (duplicate risk declared)`.slice(0, 500); }
      this.emitOutboxTransition({ type: 'retry_granted', id: message.id });
      this.notifyOutboxWake();
    } else {
      message.status = 'recoverable_failed';
      message.nextAttemptAt = undefined;
      message.lastError = `${message.lastError ?? ''} | recovery budget (${recoveryPostBudget()} POSTs) used without delivery evidence`.slice(0, 500);
      this.emitOutboxTransition({ type: 'recoverable_failed', id: message.id });
    }
  }

  /** Window bookkeeping: uncertain messages whose window ended with no evidence get their bounded retry or their terminal state. */
  advanceUncertainRecovery(now = new Date()): Array<{ id: string; to: OutboxMessage['status'] }> {
    const moved: Array<{ id: string; to: OutboxMessage['status'] }> = [];
    for (const message of this.data.outboxMessages) {
      if (message.status !== 'uncertain') continue;
      const endsAt = message.recovery ? Date.parse(message.recovery.windowEndsAt) : NaN;
      if (Number.isFinite(endsAt) && endsAt > now.getTime()) continue;
      this.releaseUncertainForRetry(message, 'window_elapsed_no_evidence');
      this.persist(['outboxMessages'], { outboxMessages: message.id });
      moved.push({ id: message.id, to: message.status });
    }
    return moved;
  }

  private emitOutboxTransition(event: OutboxTransitionEvent): void {
    if (!this.outboxTransitionListeners.size) return;
    setImmediate(() => { for (const listener of this.outboxTransitionListeners) { try { listener(event); } catch { /* listener errors must not affect storage */ } } });
  }

  onOutboxTransition(listener: (event: OutboxTransitionEvent) => void): () => void {
    this.outboxTransitionListeners.add(listener);
    return () => { this.outboxTransitionListeners.delete(listener); };
  }

  /** The row that a flow unit's index-th send created, if any (used to skip already delivered sends when a unit is replayed). */
  findOutboxByFlowRef(unitId: string, index: number): OutboxMessage | null {
    const found = this.data.outboxMessages.find((item) => item.flowRef?.unitId === unitId && item.flowRef.index === index);
    return found ? this.copyOutboxMessage(found) : null;
  }

  /** The row that holds the continuation of the flow unit `message` belongs to (the first row that unit created). */
  private continuationOwner(message: OutboxMessage): OutboxMessage | undefined {
    if (message.continuation) return message;
    const unitId = message.flowRef?.unitId;
    return unitId ? this.data.outboxMessages.find((item) => item.flowRef?.unitId === unitId && item.continuation) : undefined;
  }

  /** Continuation of the flow unit a message belongs to, if any. */
  getUnitContinuation(id: string): OutboxContinuation | null {
    const message = this.data.outboxMessages.find((item) => item.id === id);
    const owner = message ? this.continuationOwner(message) : undefined;
    return owner?.continuation ? { ...owner.continuation, descriptor: { ...owner.continuation.descriptor } } : null;
  }

  /** Atomically takes ownership of the unit's continuation: returns it once, then never again (until reset). */
  claimContinuation(id: string): OutboxContinuation | null {
    const message = this.data.outboxMessages.find((item) => item.id === id);
    const owner = message ? this.continuationOwner(message) : undefined;
    if (!owner?.continuation || owner.continuation.state !== 'pending') return null;
    owner.continuation.state = 'running';
    owner.continuation.updatedAt = new Date().toISOString();
    this.persist(['outboxMessages'], { outboxMessages: owner.id });
    return { ...owner.continuation, descriptor: { ...owner.continuation.descriptor } };
  }

  finishContinuation(id: string, state: 'done' | 'skipped'): void {
    const message = this.data.outboxMessages.find((item) => item.id === id);
    const owner = message ? this.continuationOwner(message) : undefined;
    if (!owner?.continuation) return;
    owner.continuation.state = state;
    owner.continuation.updatedAt = new Date().toISOString();
    this.persist(['outboxMessages'], { outboxMessages: owner.id });
  }

  /** After a restart, a continuation that was `running` may not have finished. Replay is idempotent (delivered sends are skipped), so run it again. */
  resetRunningContinuations(): string[] {
    const ids: string[] = [];
    for (const message of this.data.outboxMessages) {
      if (message.continuation?.state === 'running') { message.continuation.state = 'pending'; ids.push(message.id); }
    }
    if (ids.length) this.persist(['outboxMessages'], { outboxMessages: ids });
    return ids;
  }

  /** Messages whose delivery is still being resolved and whose continuation has not run - the controller's work list. */
  getOutboxMessagesWithPendingContinuation(): OutboxMessage[] {
    return this.data.outboxMessages.filter((item) => item.recovery && this.continuationOwner(item)?.continuation?.state === 'pending').map((item) => this.copyOutboxMessage(item));
  }

  /**
   * Makes the early-status buffer durable (JSON-lines journal). A status that arrives before the id it refers to is
   * recorded must survive a restart - a restart is exactly what creates uncertain messages. If a buffered status cannot
   * be journaled, applyMetaStatus THROWS so the caller does not acknowledge it and the gateway sends it again.
   */
  attachEarlyStatusJournal(filePath: string): void {
    this.earlyStatusJournalPath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const live = new Map<string, Array<{ input: MetaStatusInput; at: number }>>();
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const lines = raw.split('\n');
      const endsClean = raw.endsWith('\n') || raw.length === 0;
      const cutoff = Date.now() - UNMATCHED_STATUS_TTL_MS;
      lines.forEach((line, i) => {
        if (!line) return;
        let record: { t: 'buf' | 'done'; input?: MetaStatusInput; at?: number; wamid?: string };
        try { record = JSON.parse(line); } catch (err) {
          if (!endsClean && i === lines.length - 1) return;   // torn last append
          throw new Error(`Early-status journal ${filePath} is corrupt at line ${i + 1}; refusing to load it as empty: ${(err as Error).message}`);
        }
        if (record.t === 'done' && record.wamid) live.delete(record.wamid);
        else if (record.t === 'buf' && record.input && (record.at ?? 0) >= cutoff) {
          const list = live.get(record.input.wamid) ?? [];
          list.push({ input: record.input, at: record.at as number });
          live.set(record.input.wamid, list);
        }
      });
    }
    for (const [key, list] of live) this.unmatchedStatuses.set(key, list);
    const compact = [...live.values()].flat().map((entry) => JSON.stringify({ t: 'buf', input: entry.input, at: entry.at })).join('\n');
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, compact ? compact + '\n' : '');
    fs.renameSync(tmp, filePath);
  }

  private appendEarlyStatusJournal(record: object, mustSucceed: boolean): void {
    if (!this.earlyStatusJournalPath) return;
    try { fs.appendFileSync(this.earlyStatusJournalPath, JSON.stringify(record) + '\n'); }
    catch (err) { if (mustSucceed) throw err; }
  }

  private bufferUnmatchedStatus(input: MetaStatusInput): void {
    const now = Date.now();
    this.appendEarlyStatusJournal({ t: 'buf', input, at: now }, true);
    for (const [key, list] of this.unmatchedStatuses) {
      const fresh = list.filter((entry) => now - entry.at < UNMATCHED_STATUS_TTL_MS);
      if (fresh.length) this.unmatchedStatuses.set(key, fresh); else this.unmatchedStatuses.delete(key);
    }
    let total = 0; for (const list of this.unmatchedStatuses.values()) total += list.length;
    while (total >= UNMATCHED_STATUS_MAX) {
      const oldestKey = this.unmatchedStatuses.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      total -= this.unmatchedStatuses.get(oldestKey)?.length ?? 0;
      this.unmatchedStatuses.delete(oldestKey);
    }
    const list = this.unmatchedStatuses.get(input.wamid) ?? [];
    list.push({ input, at: now });
    this.unmatchedStatuses.set(input.wamid, list);
  }

  /** Re-applies statuses that arrived before this provider id was recorded. */
  private drainBufferedStatuses(wamid: string): void {
    const list = this.unmatchedStatuses.get(wamid);
    if (!list) return;
    this.unmatchedStatuses.delete(wamid);
    this.appendEarlyStatusJournal({ t: 'done', wamid }, false);   // if this fails the entries are re-applied after a restart; applying is idempotent
    const now = Date.now();
    for (const entry of list.sort((a, b) => a.at - b.at)) if (now - entry.at < UNMATCHED_STATUS_TTL_MS) this.applyMetaStatus(entry.input);
  }

  /** Provider acceptance is unknown. Never retried automatically; see OutboxMessageStatus. */
  /** Returns true when delivery evidence that arrived during the send settled the message as `sent` (it is then NOT uncertain). */
  markOutboxUncertain(id: string, error: unknown): boolean {
    const message = this.data.outboxMessages.find((item) => item.id === id);
    if (!message) return false;
    if (this.settleSentByDeliveryEvidence(message)) return true;
    this.claimedInThisProcess.delete(id);
    this.closeCurrentAttempt(message, 'uncertain', { error });
    message.status = 'uncertain';
    // The window belongs to the attempt and is created once: a restart that re-detects the same uncertain
    // attempt must not restart (or extend) the wait, and must not reset the retry count.
    if (!message.recovery || message.recovery.attemptId !== message.attemptId) {
      const since = new Date();
      message.recovery = {
        attemptId: message.attemptId,
        uncertainSince: since.toISOString(),
        windowEndsAt: new Date(since.getTime() + recoveryWindowMs()).toISOString(),
        retriesGranted: message.recovery?.retriesGranted ?? 0,
        duplicateRiskDeclared: message.recovery?.duplicateRiskDeclared,
      };
    }
    message.lastError = error instanceof Error ? error.message : String(error);
    message.nextAttemptAt = undefined;
    message.processingStartedAt = undefined;
    message.updatedAt = new Date().toISOString();
    this.persist(['outboxMessages'], { outboxMessages: message.id });
    return false;
  }

  /**
   * A `processing` row that THIS process is not working on was left by a
   * crashed/restarted process. A stale `processing` row is not proof the message
   * was not sent, so it becomes `uncertain` instead of being re-claimed.
   */
  recoverOrphanedOutboxProcessing(): OutboxMessage[] {
    const recovered: OutboxMessage[] = [];
    for (const message of this.data.outboxMessages) {
      if (message.status !== 'processing' || this.claimedInThisProcess.has(message.id)) continue;
      // Evidence that arrived before the crash settles it as sent: it is not an orphan any more, and nothing alerts.
      if (this.markOutboxUncertain(message.id, `Process ended while sending (attempt ${message.attempts}); provider acceptance unknown - needs review.`)) continue;
      recovered.push(this.copyOutboxMessage(message));
    }
    return recovered;
  }

  /** Operator/webhook decision for an uncertain message. Returns false if it is not uncertain. */
  resolveOutboxUncertain(id: string, resolution: 'sent' | 'not_sent', providerMessageId?: string): boolean {
    const message = this.data.outboxMessages.find((item) => item.id === id);
    if (!message || message.status !== 'uncertain') return false;
    if (resolution === 'sent') {
      this.markOutboxSent(id, providerMessageId);
    } else {
      message.status = 'retry';
      message.nextAttemptAt = undefined;
      message.updatedAt = new Date().toISOString();
      this.persist(['outboxMessages'], { outboxMessages: message.id });
      this.notifyOutboxWake();
    }
    return true;
  }

  getUncertainOutboxMessages(): OutboxMessage[] {
    return this.data.outboxMessages.filter((item) => item.status === 'uncertain').map((item) => this.copyOutboxMessage(item));
  }

  /** Wake-up hook for the dispatcher: fired (asynchronously) after an enqueue or a retry schedule. */
  onOutboxWake(listener: () => void): () => void {
    this.outboxWakeListeners.add(listener);
    return () => { this.outboxWakeListeners.delete(listener); };
  }

  private notifyOutboxWake(): void {
    if (!this.outboxWakeListeners.size) return;
    setImmediate(() => {
      for (const listener of this.outboxWakeListeners) {
        try { listener(); } catch { /* listener errors must not affect storage */ }
      }
    });
  }

  /** Earliest future `nextAttemptAt` of a recipient's head message, so the dispatcher can sleep exactly until then. */
  getNextOutboxDueAtMs(now = new Date()): number | undefined {
    const nowMs = now.getTime();
    let next: number | undefined;
    for (const message of this.getOutboxHeads()) {
      const when = message.status === 'retry' ? message.nextAttemptAt : message.status === 'uncertain' ? message.recovery?.windowEndsAt : undefined;
      if (!when) continue;
      const at = Date.parse(when);
      if (Number.isFinite(at) && at > nowMs && (next === undefined || at < next)) next = at;
    }
    return next;
  }

  markOutboxRetry(id: string, error: unknown, nextAttemptAt?: string): void {
    const message = this.data.outboxMessages.find((item) => item.id === id);
    if (!message) return;
    if (this.settleSentByDeliveryEvidence(message)) return;   // the provider already confirmed a copy: no further POST
    this.claimedInThisProcess.delete(id);
    this.closeCurrentAttempt(message, 'rejected', { error });
    message.status = 'retry';
    message.lastError = error instanceof Error ? error.message : String(error);
    message.nextAttemptAt = nextAttemptAt;
    message.processingStartedAt = undefined;
    message.updatedAt = new Date().toISOString();
    this.persist(['outboxMessages'], { outboxMessages: message.id });
    this.notifyOutboxWake();
  }

  /** Terminal, non-blocking, not success: the message that went through recovery could not be confirmed within its budget. */
  markOutboxRecoverableFailed(id: string, error: unknown): void {
    const message = this.data.outboxMessages.find((item) => item.id === id);
    if (!message) return;
    this.claimedInThisProcess.delete(id);
    this.closeCurrentAttempt(message, 'rejected', { error });
    message.status = 'recoverable_failed';
    message.lastError = error instanceof Error ? error.message : String(error);
    message.nextAttemptAt = undefined;
    message.processingStartedAt = undefined;
    message.updatedAt = new Date().toISOString();
    this.persist(['outboxMessages'], { outboxMessages: message.id });
    this.emitOutboxTransition({ type: 'recoverable_failed', id: message.id });
  }

  /**
   * The participant started a new run while this message was unresolved: it is abandoned as recoverable_failed (never a
   * success, never revived by late evidence) and its continuation is skipped. Refused (false) when the message is being
   * sent right now or its continuation is already running - the caller then keeps the hold and waits.
   */
  supersedeRecoveryOutbox(id: string, reason: string): boolean {
    const message = this.data.outboxMessages.find((item) => item.id === id);
    if (!message) return true;   // nothing left to wait for
    const owner = this.continuationOwner(message);
    if (owner?.continuation?.state === 'running') return false;
    if (message.status === 'processing') return false;
    if (!isOutboxTerminal(message.status)) this.markOutboxRecoverableFailed(id, reason);
    if (owner?.continuation?.state === 'pending') this.finishContinuation(id, 'skipped');
    return true;
  }

  markOutboxFailed(id: string, error: unknown): void {
    const message = this.data.outboxMessages.find((item) => item.id === id);
    if (!message) return;
    this.claimedInThisProcess.delete(id);
    this.closeCurrentAttempt(message, 'rejected', { error });
    message.status = 'failed';
    message.lastError = error instanceof Error ? error.message : String(error);
    message.nextAttemptAt = undefined;
    message.processingStartedAt = undefined;
    message.updatedAt = new Date().toISOString();
    this.persist(['outboxMessages'], { outboxMessages: message.id });
  }

  getOutboxMessages(limit = 100): OutboxMessage[] {
    return this.data.outboxMessages
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((message) => this.copyOutboxMessage(message));
  }

  /** Oldest outstanding message per recipient, oldest first. Later messages of a recipient never overtake it. */
  private getOutboxHeads(): OutboxMessage[] {
    const firstOutstandingByRecipient = new Map<string, OutboxMessage>();
    const ordered = this.data.outboxMessages
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const message of ordered) {
      if (isOutboxTerminal(message.status)) continue;
      const recipient = normalizeOutboxRecipient(message.to);
      if (!firstOutstandingByRecipient.has(recipient)) {
        firstOutstandingByRecipient.set(recipient, message);
      }
    }
    return [...firstOutstandingByRecipient.values()];
  }

  /**
   * Head-of-queue messages that are due AND eligible, oldest first, at most `limit`.
   * `isBlocked(recipient)` (e.g. a needs_review hold) is applied BEFORE the limit:
   * blocked recipients neither consume slots nor starve eligible ones behind them.
   * A blocked head is never skipped to reach a later message of the same recipient.
   */
  getPendingOutboxMessages(
    limit = 50,
    now = new Date(),
    _processingStaleMs = 2 * 60 * 1000,
    isBlocked?: (recipient: string, message: OutboxMessage) => boolean,
  ): OutboxMessage[] {
    const nowMs = now.getTime();
    return this.getOutboxHeads()
      .filter((message) => this.isOutboxClaimable(message, nowMs))
      .filter((message) => !isBlocked || !isBlocked(message.to, message))
      .slice(0, limit)
      .map((message) => this.copyOutboxMessage(message));
  }

  claimOutboxMessage(id: string, now = new Date(), _processingStaleMs = 2 * 60 * 1000): OutboxMessage | null {
    const messageIndex = this.data.outboxMessages.findIndex((item) => item.id === id);
    const message = messageIndex >= 0 ? this.data.outboxMessages[messageIndex] : undefined;
    if (!message || !this.isOutboxClaimable(message, now.getTime())) return null;
    const recipient = normalizeOutboxRecipient(message.to);
    const hasEarlierOutstanding = this.data.outboxMessages.slice(0, messageIndex).some((earlier) =>
      normalizeOutboxRecipient(earlier.to) === recipient
      && !isOutboxTerminal(earlier.status));
    if (hasEarlierOutstanding) return null;
    this.markOutboxProcessing(id);
    return this.copyOutboxMessage(message);
  }

  private isOutboxClaimable(message: OutboxMessage, nowMs: number): boolean {
    if (message.status === 'queued') return true;
    if (message.status === 'retry') {
      return !message.nextAttemptAt || Date.parse(message.nextAttemptAt) <= nowMs;
    }
    // `processing` and `uncertain` are never claimable: a stale `processing` row is not proof the
    // message was not sent. recoverOrphanedOutboxProcessing() turns orphans into `uncertain`.
    return false;
  }

  private copyOutboxMessage(message: OutboxMessage): OutboxMessage {
    return {
      ...message,
      fileOptions: message.fileOptions ? { ...message.fileOptions } : undefined,
      attemptLog: message.attemptLog?.map((entry) => ({ ...entry })),
      recovery: message.recovery ? { ...message.recovery } : undefined,
      flowRef: message.flowRef ? { ...message.flowRef } : undefined,
      continuation: message.continuation ? { ...message.continuation, descriptor: { ...message.continuation.descriptor } } : undefined,
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
    // Every provider id a message ever received counts (a retry after an unknown outcome can leave the earlier attempt's id behind).
    const message = this.data.outboxMessages.find((item) => item.providerMessageId === id
      || item.attemptLog?.some((entry) => entry.providerMessageId === id || entry.providerMessageIds?.includes(id)));
    if (!message) return null;
    // Never let a late 'sent' clobber a terminal 'delivered'/'read'/'failed' already recorded.
    const rank = { sent: 1, delivered: 2, read: 3, failed: 3 } as const;
    if (message.deliveryStatus && rank[status] < rank[message.deliveryStatus]) return message;
    message.deliveryStatus = status;
    message.deliveryError = status === 'failed' ? (error || 'Delivery failed') : undefined;
    message.deliveryUpdatedAt = new Date().toISOString();
    this.persist(['outboxMessages'], { outboxMessages: message.id });
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
    const counts = { total: this.data.outboxMessages.length, queued: 0, processing: 0, sent: 0, failed: 0, retry: 0, uncertain: 0, recoverable_failed: 0 };
    for (const message of this.data.outboxMessages) counts[message.status] += 1;
    return counts;
  }

  /** JSON mode has no DB backend, so the conversation-state file is authoritative. */
  isPrimaryConversationStore(): boolean {
    return !this.backend;
  }

  loadConversationStateSnapshot(): ConversationStateSnapshot | undefined {
    return this.data.conversationStateSnapshot
      ? JSON.parse(JSON.stringify(this.data.conversationStateSnapshot)) as ConversationStateSnapshot
      : undefined;
  }

  saveConversationStateSnapshot(
    snapshot: ConversationStateSnapshot,
    changedJids: readonly string[] | 'all' = 'all',
  ): void {
    this.data.conversationStateSnapshot = JSON.parse(JSON.stringify(snapshot)) as ConversationStateSnapshot;
    this.persist(
      ['conversationStateSnapshot'],
      changedJids === 'all' ? {} : { conversationStateSnapshot: changedJids },
    );
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
    this.persist(['contactsList', 'contactQueue', 'campaignResults'], {
      contactsList: phone,
      contactQueue: job?.id,
      campaignResults: job?.campaignResultIds,
    });
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
      this.persist(['contactQueue', 'campaignResults'], { contactQueue: existing.id, campaignResults: existing.campaignResultIds });
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
    this.persist(['contactQueue', 'campaignResults'], { contactQueue: job.id, campaignResults: job.campaignResultIds });
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
    this.persist(['contactQueue'], { contactQueue: job.id });
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
    this.persist(['contactQueue', 'campaignResults'], { contactQueue: job.id, campaignResults: job.campaignResultIds });
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
    if (count) this.persist(['contactQueue', 'campaignResults']);
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
    this.persist(['uploadedFiles']);
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
    this.persist(['uploadedFiles']);
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
    this.persist(['campaigns']);
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
    this.persist(['campaignResults'], { campaignResults: result.id });
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
    this.persist(['campaignResults']);
    return { added, removed };
  }

  clearCampaignReferralDemo(campaignId: string, persist = true): number {
    const before = this.data.campaignResults.length;
    this.data.campaignResults = this.data.campaignResults.filter((result) => !(result.campaignId === campaignId && result.isDemo));
    const removed = before - this.data.campaignResults.length;
    if (persist && removed) this.persist(['campaignResults']);
    return removed;
  }
  ensureCampaignResultReferralCode(resultId: string | undefined): string {
    if (!resultId) return '';
    const result = this.data.campaignResults.find((item) => item.id === resultId);
    if (!result) return '';
    const currentCode = normalizeReferralCode(result.referralCode);
    if (!/^[A-Z]{1,2}\d{4}$/.test(currentCode)) {
      const nextCode = this.generateUniqueReferralCode(result.campaignId, result.phone);
      const touchedResultIds = [result.id];
      if (currentCode) {
        result.referralCodeAliases = [...new Set([...(result.referralCodeAliases || []), currentCode])];
        for (const invitee of this.data.campaignResults) {
          if (invitee.campaignId !== result.campaignId) continue;
          if (invitee.referredByResultId === result.id || normalizeReferralCode(invitee.referredByCode) === currentCode) {
            invitee.referredByCode = nextCode;
            touchedResultIds.push(invitee.id);
          }
        }
      }
      result.referralCode = nextCode;
      this.persist(['campaignResults'], { campaignResults: touchedResultIds });
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
    return rows.sort((a, b) => b.invited - a.invited || b.saved - a.saved || a.name.localeCompare(b.name) || a.phone.localeCompare(b.phone));
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
    this.persist(['campaignResults'], { campaignResults: resultId });
  }

  queueAwaitingNameCampaignResults(campaignId: string, resultBatchId?: string): { queued: number; skipped: number } {
    const campaign = this.data.campaigns.find((item) => item.id === campaignId);
    const suffix = campaign?.suffix ?? '';
    const campaignName = campaign?.name?.trim() || 'קמפיין';
    let queued = 0;
    let skipped = 0;
    const touchedResultIds: string[] = [];

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
        touchedResultIds.push(result.id);
        queued += 1;
      } else {
        skipped += 1;
      }
    }
    if (queued || skipped) this.persist(['campaignResults'], { campaignResults: touchedResultIds });
    return { queued, skipped };
  }

  queueUnsavedCampaignResults(campaignId: string, resultBatchId?: string): { queued: number; skipped: number } {
    const campaign = this.data.campaigns.find((item) => item.id === campaignId);
    const suffix = campaign?.suffix ?? '';
    const campaignName = campaign?.name?.trim() || 'Campaign';
    let queued = 0;
    let skipped = 0;
    const touchedResultIds: string[] = [];

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
        touchedResultIds.push(result.id);
        queued += 1;
      } else {
        skipped += 1;
      }
    }
    if (queued || skipped) this.persist(['campaignResults'], { campaignResults: touchedResultIds });
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
    this.persist(['campaignResults'], { campaignResults: resultId });
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
    this.persist(['campaignResults'], { campaignResults: resultId });
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
    this.persist(
      event.campaignResultId ? ['campaignEvents', 'campaignResults'] : ['campaignEvents'],
      event.campaignResultId
        ? { campaignEvents: saved.id, campaignResults: event.campaignResultId }
        : { campaignEvents: saved.id },
    );
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
    this.persist(['campaigns', 'campaignResults', 'campaignEvents', 'contactQueue']);
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
    this.persist(['adminSettings']);
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
    this.persist(['serviceBotState']);
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
    this.persist(['serviceBotState']);
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
    this.persist(['serviceBotState']);
    return true;
  }

  getServiceBotSession(phone: string, botId?: string): ServiceBotSession | null {
    const session = this.data.serviceBotSessions.find((item) => item.phone === phone && (!botId || item.botId === botId));
    const serviceBot = session ? this.data.serviceBots.find((item) => item.id === session.botId) : undefined;
    const timeoutMinutes = Math.max(1, Number(serviceBot?.sessionTimeoutMinutes) || 60);
    if (session && Date.now() - new Date(session.updatedAt).getTime() > timeoutMinutes * 60 * 1000) {
      this.data.serviceBotSessions = this.data.serviceBotSessions.filter((item) => item.phone !== phone);
      this.persist(['serviceBotState']);
      return null;
    }
    return session ? { ...session, path: [...(session.path ?? [])], variables: { ...(session.variables ?? {}) } } : null;
  }

  clearServiceBotSessionForPhone(phone: string): void {
    const before = this.data.serviceBotSessions.length;
    this.data.serviceBotSessions = this.data.serviceBotSessions.filter(item => item.phone !== phone);
    if (before !== this.data.serviceBotSessions.length) this.persist(['serviceBotState']);
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
      this.persist(['serviceBotState']);
      return { ...existing, path: [...(existing.path ?? [])], variables: { ...(existing.variables ?? {}) } };
    }
    const session = { botId, phone, nodeId, path: [...path], variables: { ...(variables ?? {}) }, startedAt: updatedAt, updatedAt };
    this.data.serviceBotSessions.push(session);
    this.persist(['serviceBotState']);
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
    this.persist(['serviceBotState']);
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
    this.persist(['serviceBotState']);
    return { ...followUp };
  }

  cancelServiceBotFollowUps(phone: string, includeProcessing = false): number {
    let cancelled = 0;
    const now = new Date().toISOString();
    for (const followUp of this.data.serviceBotFollowUps) {
      if (followUp.phone !== phone || (followUp.status !== 'scheduled' && !(includeProcessing && followUp.status === 'processing'))) continue;
      followUp.status = 'cancelled';
      followUp.updatedAt = now;
      cancelled += 1;
    }
    if (cancelled) this.persist(['serviceBotState']);
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
    this.persist(['serviceBotState']);
    return { ...followUp };
  }

  completeServiceBotFollowUp(id: string): void {
    const followUp = this.data.serviceBotFollowUps.find((item) => item.id === id);
    if (!followUp) return;
    followUp.status = 'sent';
    followUp.updatedAt = new Date().toISOString();
    followUp.lastError = undefined;
    this.persist(['serviceBotState']);
  }

  failServiceBotFollowUp(id: string, error: unknown): void {
    const followUp = this.data.serviceBotFollowUps.find((item) => item.id === id);
    if (!followUp) return;
    followUp.status = followUp.attempts < 3 ? 'scheduled' : 'failed';
    if (followUp.status === 'scheduled') followUp.runAt = new Date(Date.now() + 60_000).toISOString();
    followUp.updatedAt = new Date().toISOString();
    followUp.lastError = error instanceof Error ? error.message : String(error);
    this.persist(['serviceBotState']);
  }

  clearServiceBotSessions(botId?: string): number {
    const count = this.data.serviceBotSessions.filter((item) => !botId || item.botId === botId).length;
    this.data.serviceBotSessions = this.data.serviceBotSessions.filter((item) => botId && item.botId !== botId);
    for (const followUp of this.data.serviceBotFollowUps) {
      if (followUp.status === 'scheduled' && (!botId || followUp.botId === botId)) followUp.status = 'cancelled';
    }
    this.persist(['serviceBotState']);
    return count;
  }

  getClientProfile(): ClientProfile {
    return { ...this.data.clientProfile };
  }

  updateClientProfile(patch: Partial<ClientProfile>): ClientProfile {
    this.data.clientProfile = { ...this.data.clientProfile, ...patch };
    this.persist(['clientProfile']);
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
    // twilioOnboarding has no dedicated PostgreSQL table (see StorageTableName).
    this.persist([]);
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
    this.persist(['twilioTemplates']);
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
    this.persist(['twilioTemplates']);
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
    this.persist(['campaigns']);
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
    this.persist(['campaigns']);
    return this.data.campaigns[idx];
  }

  deleteCampaign(id: string): boolean {
    const before = this.data.campaigns.length;
    this.data.campaigns = this.data.campaigns.filter((c) => c.id !== id);
    if (this.data.campaigns.length !== before) {
      this.persist(['campaigns']);
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
