/**
 * conversationState.ts
 * In-memory store for conversations that are waiting for the user's
 * name-preference reply (when "ask for name" mode is enabled).
 *
 * Each entry has a Node.js timeout handle that fires automatically if the
 * user does not reply within the configured window.
 */

export interface PendingNameConversation {
  kind: 'name';
  senderJid: string;
  senderPhone: string;
  campaignId?: string;
  campaignResultId?: string;
  replyText: string;
  followupMessages: string[];
  decisionFlow: import('./storage').DecisionFlowStep[];
  humanHandoffEnabled?: boolean;
  humanHandoffText?: string;
  humanHandoffPhone?: string;
  decisionTimeoutMinutes?: number;
  decisionTimeoutText?: string;
  /** Suffix to append to the final contact name (" - Bot" or " - [referrer]"). */
  suffix: string;
  /** Fallback: the sender's WhatsApp pushname, used if they don't reply. */
  whatsappName: string;
  /** Timestamp when the pending state was created (ms). */
  timestamp: number;
  /** Cancel this to prevent the auto-save when the user replies in time. */
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
  timestamp: number;
  /** Cancel this to prevent stale unanswered decision prompts from staying in memory. */
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

export type PendingConversation = PendingNameConversation | PendingDecisionConversation | PendingHandoffConversation;

class ConversationStateManager {
  private readonly map = new Map<string, PendingConversation>();

  set(jid: string, state: PendingConversation): void {
    this.clearTimer(this.map.get(jid));
    this.map.set(jid, state);
  }

  get(jid: string): PendingConversation | undefined {
    return this.map.get(jid);
  }

  remove(jid: string): void {
    this.clearTimer(this.map.get(jid));
    this.map.delete(jid);
  }

  size(): number {
    return this.map.size;
  }

  private clearTimer(state: PendingConversation | undefined): void {
    if (state?.timeoutHandle) {
      clearTimeout(state.timeoutHandle);
    }
  }
}

export const conversationState = new ConversationStateManager();
