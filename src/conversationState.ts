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

export type PendingConversation = PendingNameConversation | PendingPreNamePromptConversation | PendingDecisionConversation | PendingWaitReplyConversation | PendingContactCardConfirmationConversation | PendingHandoffConversation;

export type PersistablePendingConversation =
  | Omit<PendingNameConversation, 'timeoutHandle'>
  | Omit<PendingPreNamePromptConversation, 'timeoutHandle'>
  | Omit<PendingDecisionConversation, 'timeoutHandle'>
  | Omit<PendingWaitReplyConversation, 'timeoutHandle'>
  | Omit<PendingContactCardConfirmationConversation, 'timeoutHandle'>
  | Omit<PendingHandoffConversation, 'timeoutHandle'>;

export interface ConversationStateSnapshot {
  version: 1;
  savedAt: string;
  conversations: Record<string, PersistablePendingConversation>;
}

interface ConversationStatePersistenceBackend {
  loadConversationStateSnapshot(): ConversationStateSnapshot | undefined;
  saveConversationStateSnapshot(snapshot: ConversationStateSnapshot): void;
}

class ConversationStateManager {
  private readonly map = new Map<string, PendingConversation>();
  private filePath = '';
  private backend?: ConversationStatePersistenceBackend;
  private hydrationComplete = false;

  set(jid: string, state: PendingConversation): void {
    this.clearTimer(this.map.get(jid));
    this.map.set(jid, state);
    this.persist();
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
    this.persist();
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
    this.persist();
  }

  removeByCampaign(campaignId: string): number {
    let removed = 0;
    for (const [jid, state] of this.map.entries()) {
      if (state.campaignId !== campaignId) continue;
      this.clearTimer(state);
      this.map.delete(jid);
      removed += 1;
    }
    if (removed) this.persist();
    return removed;
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
        if (state.kind !== 'name' && state.kind !== 'pre-name-prompt' && state.kind !== 'decision' && state.kind !== 'wait-reply' && state.kind !== 'contact-card-confirmation' && state.kind !== 'handoff') continue;
        const timeoutHandle = schedule(jid, state);
        if (!timeoutHandle) continue;
        this.map.set(jid, { ...state, timeoutHandle } as PendingConversation);
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

  private persist(): void {
    if (!this.filePath || !this.hydrationComplete) return;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const conversations: Record<string, PersistablePendingConversation> = {};
      for (const [jid, state] of this.map.entries()) {
        const { timeoutHandle: _timeoutHandle, ...persistable } = state;
        conversations[jid] = persistable;
      }
      const snapshot: ConversationStateSnapshot = {
        version: 1,
        savedAt: new Date().toISOString(),
        conversations,
      };
      this.backend?.saveConversationStateSnapshot(snapshot);
      if (this.filePath) fs.writeFileSync(this.filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
    } catch (err) {
      console.warn('Could not persist conversation state:', err);
    }
  }
}

function normalizePhone(phone: string | undefined): string {
  return String(phone ?? '').replace(/\D/g, '');
}

export const conversationState = new ConversationStateManager();
