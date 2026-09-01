/**
 * conversationState.ts
 * In-memory store for conversations that are waiting for the user's next reply.
 * The runtime timers stay in memory, while a small JSON snapshot lets the app
 * restore pending conversations after a restart/redeploy.
 */

import fs from 'fs';
import path from 'path';

export interface PendingNameConversation {
  kind: 'name';
  senderJid: string;
  senderPhone: string;
  campaignId?: string;
  campaignResultId?: string;
  replyText: string;
  completionLinks?: import('./storage').CompletionLink[];
  completionFileIds?: string[];
  sendContactCard?: boolean;
  contactCards?: import('./storage').ContactCard[];
  contactCardPlacement?: import('./storage').CampaignConversationSettings['contactCardPlacement'];
  contactCardSendMode?: import('./storage').CampaignConversationSettings['contactCardSendMode'];
  contactCardName?: string;
  contactCardPhone?: string;
  contactCardEmail?: string;
  contactCardOrganization?: string;
  contactCardIntroText?: string;
  contactCardWaitForConfirmation?: boolean;
  contactCardConfirmationTimeoutMinutes?: number;
  followupMessages: string[];
  decisionFlow: import('./storage').DecisionFlowStep[];
  humanHandoffEnabled?: boolean;
  humanHandoffText?: string;
  humanHandoffPhone?: string;
  nameTimeoutMinutes?: number;
  decisionTimeoutMinutes?: number;
  decisionTimeoutText?: string;
  decisionTimeoutMode?: 'message' | 'flow';
  decisionTimeoutNextStepId?: string;
  timeoutFlowStarted?: boolean;
  /** Suffix to append to the final contact name (" - Bot" or " - [referrer]"). */
  suffix: string;
  /** Fallback: the sender's WhatsApp pushname, used if they don't reply. */
  whatsappName: string;
  /** Timestamp when the pending state was created (ms). */
  timestamp: number;
  /** Cancel this to prevent the auto-save when the user replies in time. */
  timeoutHandle: NodeJS.Timeout;
}

export interface PendingPreNamePromptConversation {
  kind: 'pre-name-prompt';
  senderJid: string;
  senderPhone: string;
  campaignId?: string;
  campaignResultId?: string;
  replyText: string;
  completionLinks?: import('./storage').CompletionLink[];
  completionFileIds?: string[];
  sendContactCard?: boolean;
  contactCards?: import('./storage').ContactCard[];
  contactCardPlacement?: import('./storage').CampaignConversationSettings['contactCardPlacement'];
  contactCardSendMode?: import('./storage').CampaignConversationSettings['contactCardSendMode'];
  contactCardName?: string;
  contactCardPhone?: string;
  contactCardEmail?: string;
  contactCardOrganization?: string;
  contactCardIntroText?: string;
  contactCardWaitForConfirmation?: boolean;
  contactCardConfirmationTimeoutMinutes?: number;
  followupMessages: string[];
  decisionFlow: import('./storage').DecisionFlowStep[];
  humanHandoffEnabled?: boolean;
  humanHandoffText?: string;
  humanHandoffPhone?: string;
  nameTimeoutMinutes?: number;
  preNamePromptTimeoutMinutes?: number;
  askNameText: string;
  decisionTimeoutMinutes?: number;
  decisionTimeoutText?: string;
  decisionTimeoutMode?: 'message' | 'flow';
  decisionTimeoutNextStepId?: string;
  timeoutFlowStarted?: boolean;
  suffix: string;
  whatsappName: string;
  timestamp: number;
  timeoutHandle: NodeJS.Timeout;
}

export interface PendingDecisionConversation {
  kind: 'decision';
  senderJid: string;
  senderPhone?: string;
  campaignId?: string;
  campaignResultId?: string;
  flow: import('./storage').DecisionFlowStep[];
  stepId: string;
  humanHandoffEnabled?: boolean;
  humanHandoffText?: string;
  humanHandoffPhone?: string;
  decisionTimeoutMinutes?: number;
  decisionTimeoutText?: string;
  decisionTimeoutMode?: 'message' | 'flow';
  decisionTimeoutNextStepId?: string;
  /** Prevents the inactivity continuation route from running again inside itself. */
  timeoutFlowStarted?: boolean;
  timestamp: number;
  /** Cancel this to prevent stale unanswered decision prompts from staying in memory. */
  timeoutHandle?: NodeJS.Timeout;
}

export interface PendingWaitReplyConversation {
  kind: 'wait-reply';
  senderJid: string;
  senderPhone?: string;
  campaignId?: string;
  campaignResultId?: string;
  flow: import('./storage').DecisionFlowStep[];
  stepId: string;
  humanHandoffEnabled?: boolean;
  humanHandoffText?: string;
  humanHandoffPhone?: string;
  decisionTimeoutMinutes?: number;
  decisionTimeoutText?: string;
  decisionTimeoutMode?: 'message' | 'flow';
  decisionTimeoutNextStepId?: string;
  /** Prevents the inactivity continuation route from running again inside itself. */
  timeoutFlowStarted?: boolean;
  timestamp: number;
  timeoutHandle?: NodeJS.Timeout;
}
export interface PendingExpiredDecisionConversation {
  kind: 'expired-decision';
  senderJid: string;
  senderPhone?: string;
  campaignId?: string;
  campaignResultId?: string;
  flow: import('./storage').DecisionFlowStep[];
  stepId: string;
  humanHandoffEnabled?: boolean;
  humanHandoffText?: string;
  humanHandoffPhone?: string;
  decisionTimeoutMinutes?: number;
  decisionTimeoutText?: string;
  decisionTimeoutMode?: 'message' | 'flow';
  decisionTimeoutNextStepId?: string;
  timeoutFlowStarted?: boolean;
  timestamp: number;
  timeoutHandle?: NodeJS.Timeout;
}
export interface PendingContactCardConfirmationConversation {
  kind: 'contact-card-confirmation';
  senderJid: string;
  senderPhone?: string;
  campaignId?: string;
  campaignResultId?: string;
  followupMessages: string[];
  decisionFlow: import('./storage').DecisionFlowStep[];
  humanHandoffEnabled?: boolean;
  humanHandoffText?: string;
  humanHandoffPhone?: string;
  decisionTimeoutMinutes?: number;
  decisionTimeoutText?: string;
  decisionTimeoutMode?: 'message' | 'flow';
  decisionTimeoutNextStepId?: string;
  timeoutFlowStarted?: boolean;
  contactCardConfirmationTimeoutMinutes?: number;
  timestamp: number;
  timeoutHandle?: NodeJS.Timeout;
}
export interface PendingHandoffConversation {
  kind: 'handoff';
  senderJid: string;
  senderPhone?: string;
  campaignId?: string;
  campaignResultId?: string;
  humanHandoffEnabled?: boolean;
  humanHandoffText?: string;
  humanHandoffPhone?: string;
  timestamp: number;
  timeoutHandle?: NodeJS.Timeout;
}

export type PendingConversation = PendingNameConversation | PendingPreNamePromptConversation | PendingDecisionConversation | PendingWaitReplyConversation | PendingExpiredDecisionConversation | PendingContactCardConfirmationConversation | PendingHandoffConversation;

export type PersistablePendingConversation =
  | Omit<PendingNameConversation, 'timeoutHandle'>
  | Omit<PendingPreNamePromptConversation, 'timeoutHandle'>
  | Omit<PendingDecisionConversation, 'timeoutHandle'>
  | Omit<PendingWaitReplyConversation, 'timeoutHandle'>
  | Omit<PendingExpiredDecisionConversation, 'timeoutHandle'>
  | Omit<PendingContactCardConfirmationConversation, 'timeoutHandle'>
  | Omit<PendingHandoffConversation, 'timeoutHandle'>;

export interface ConversationStateSnapshot {
  version: 1;
  savedAt: string;
  conversations: Record<string, PersistablePendingConversation>;
}

interface ConversationStatePersistenceBackend {
  loadConversationStateSnapshot(): ConversationStateSnapshot | undefined;
  /**
   * @param changedJids Exactly which conversations this call changed, so the
   * PostgreSQL backend can skip re-comparing every other one. 'all' (the
   * default) forces the full comparison, matching pre-optimization behavior.
   */
  saveConversationStateSnapshot(
    snapshot: ConversationStateSnapshot,
    changedJids: readonly string[] | 'all',
  ): void;
}

/**
 * Rebuilds a campaign's decision flow on restore. The flow is an identical copy
 * for every conversation on the same campaign, so it is stripped before the
 * snapshot is written (see persist) and resolved back afterwards.
 */
export type DecisionFlowResolver = (campaignId: string | undefined)
  => import('./storage').DecisionFlowStep[] | undefined;

/** State kinds that carry the campaign flow under `flow`. */
const FLOW_KINDS = new Set(['decision', 'wait-reply', 'expired-decision']);
/** State kinds that carry the same list under `decisionFlow`. */
const DECISION_FLOW_KINDS = new Set(['name', 'pre-name-prompt', 'contact-card-confirmation']);

function flowFieldFor(kind: unknown): 'flow' | 'decisionFlow' | null {
  if (typeof kind !== 'string') return null;
  if (FLOW_KINDS.has(kind)) return 'flow';
  if (DECISION_FLOW_KINDS.has(kind)) return 'decisionFlow';
  return null;
}

class ConversationStateManager {
  private readonly map = new Map<string, PendingConversation>();
  private filePath = '';
  private backend?: ConversationStatePersistenceBackend;
  private hydrationComplete = false;

  set(jid: string, state: PendingConversation): void {
    this.clearTimer(this.map.get(jid));
    this.map.set(jid, state);
    this.persist([jid]);
  }

  get(jid: string): PendingConversation | undefined {
    return this.map.get(jid);
  }

  /**
   * Keep the last recoverable state while a reply is being processed, but stop
   * its timeout. The next successfully-sent step replaces it; a failed send
   * leaves the previous question available for a safe retry.
   */
  pause(jid: string): boolean {
    const state = this.map.get(jid);
    if (!state) return false;
    this.clearTimer(state);
    state.timestamp = Date.now();
    (state as PendingConversation & { timeoutHandle?: NodeJS.Timeout }).timeoutHandle = undefined;
    this.map.set(jid, state);
    this.persist([jid]);
    return true;
  }

  findByPhone(phone: string | undefined): PendingConversation | undefined {
    const normalized = normalizePhone(phone);
    if (!normalized) return undefined;
    for (const state of this.map.values()) {
      if (normalizePhone(state.senderPhone) === normalized) return state;
    }
    return undefined;
  }

  remove(jid: string): void {
    this.clearTimer(this.map.get(jid));
    this.map.delete(jid);
    this.persist([jid]);
  }

  /**
   * Drops every pending conversation for a phone number, regardless of kind
   * or how close its own timeout is. Used when a fresh trigger message from
   * this phone (possibly for a different campaign, or on another client
   * sharing the same Meta number) makes any older pending conversation moot -
   * the sender has moved on, so it should stop being a candidate for future
   * replies immediately rather than waiting for its own timeout.
   */
  removeByPhone(phone: string | undefined): number {
    const normalized = normalizePhone(phone);
    if (!normalized) return 0;
    const touched: string[] = [];
    for (const [jid, state] of this.map.entries()) {
      if (normalizePhone(state.senderPhone) !== normalized) continue;
      this.clearTimer(state);
      this.map.delete(jid);
      touched.push(jid);
    }
    if (touched.length) this.persist(touched);
    return touched.length;
  }

  removeByCampaign(campaignId: string): number {
    const touched: string[] = [];
    for (const [jid, state] of this.map.entries()) {
      if (state.campaignId !== campaignId) continue;
      this.clearTimer(state);
      this.map.delete(jid);
      touched.push(jid);
    }
    if (touched.length) this.persist(touched);
    return touched.length;
  }

  size(): number {
    return this.map.size;
  }

  configurePersistence(filePath: string, backend?: ConversationStatePersistenceBackend): void {
    this.filePath = filePath;
    this.backend = backend;
  }

  restore(
    schedule: (jid: string, state: PersistablePendingConversation) => NodeJS.Timeout | undefined,
    resolveDecisionFlow?: DecisionFlowResolver,
  ): number {
    try {
      const parsed = this.backend?.loadConversationStateSnapshot()
        ?? (this.filePath && fs.existsSync(this.filePath)
          ? JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Partial<ConversationStateSnapshot>
          : undefined);
      if (!parsed) {
        this.hydrationComplete = true;
        return 0;
      }
      const entries = Object.entries(parsed.conversations ?? {});
      for (const [jid, state] of entries) {
        if (!state || typeof state !== 'object') continue;
        if (state.kind !== 'name' && state.kind !== 'pre-name-prompt' && state.kind !== 'decision' && state.kind !== 'wait-reply' && state.kind !== 'expired-decision' && state.kind !== 'contact-card-confirmation' && state.kind !== 'handoff') continue;
        const hydrated = hydrateDecisionFlow(state, resolveDecisionFlow);
        const timeoutHandle = schedule(jid, hydrated);
        if (!timeoutHandle) continue;
        this.map.set(jid, { ...hydrated, timeoutHandle } as PendingConversation);
      }
      this.hydrationComplete = true;
      this.persist();
      return this.map.size;
    } catch (err) {
      console.warn('Could not restore conversation state:', err);
      this.hydrationComplete = true;
      return 0;
    }
  }

  private clearTimer(state: PendingConversation | undefined): void {
    if (state?.timeoutHandle) {
      clearTimeout(state.timeoutHandle);
    }
  }

  /**
   * @param changedJids The conversations this call actually changed. Every
   * mutator names them, so the PostgreSQL sync compares only those instead of
   * scanning all pending conversations - measured at 47.5ms per change with
   * ~1,200 conversations in state, on every single step transition.
   * 'all' keeps the full scan for bulk paths such as restore().
   */
  private persist(changedJids: readonly string[] | 'all' = 'all'): void {
    if (!this.filePath || !this.hydrationComplete) return;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const conversations: Record<string, PersistablePendingConversation> = {};
      for (const [jid, state] of this.map.entries()) {
        const { timeoutHandle: _timeoutHandle, ...persistable } = state;
        // The campaign flow is an identical copy in every conversation on the
        // same campaign and dominates the snapshot (measured ~7.0 KB of a
        // ~7.6 KB conversation - 13 MB across ~1,200 live conversations).
        // persist() runs synchronously on every conversation change, so that
        // size is paid as event-loop blocking on each step transition.
        // It is rebuilt from the campaign in restore(), so it is not stored.
        conversations[jid] = stripDecisionFlow(persistable);
      }
      const snapshot: ConversationStateSnapshot = {
        version: 1,
        savedAt: new Date().toISOString(),
        conversations,
      };
      this.backend?.saveConversationStateSnapshot(snapshot, changedJids);
      if (this.filePath) fs.writeFileSync(this.filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
    } catch (err) {
      console.warn('Could not persist conversation state:', err);
    }
  }
}

function normalizePhone(phone: string | undefined): string {
  return String(phone ?? '').replace(/\D/g, '');
}

/** Drops the campaign flow from a conversation before it is written to disk/Postgres. */
function stripDecisionFlow(state: PersistablePendingConversation): PersistablePendingConversation {
  const field = flowFieldFor((state as { kind?: unknown }).kind);
  if (!field) return state;
  const lean = { ...(state as unknown as Record<string, unknown>) };
  delete lean[field];
  return lean as unknown as PersistablePendingConversation;
}

/**
 * Puts the campaign flow back after a restore. Snapshots written before this
 * optimization still carry their own copy and are left untouched. When the
 * campaign is gone (deleted, or its flow emptied) the conversation is restored
 * with an empty flow: every reader already treats "step not found" as a stale
 * conversation and ends it cleanly, which is the correct outcome here too.
 */
function hydrateDecisionFlow(
  state: PersistablePendingConversation,
  resolve?: DecisionFlowResolver,
): PersistablePendingConversation {
  const field = flowFieldFor((state as { kind?: unknown }).kind);
  if (!field) return state;
  const raw = state as unknown as Record<string, unknown>;
  const existing = raw[field];
  if (Array.isArray(existing) && existing.length) return state;
  const campaignId = typeof raw.campaignId === 'string' ? raw.campaignId : undefined;
  const resolved = resolve?.(campaignId);
  return { ...raw, [field]: Array.isArray(resolved) ? resolved : [] } as unknown as PersistablePendingConversation;
}

export const conversationState = new ConversationStateManager();
