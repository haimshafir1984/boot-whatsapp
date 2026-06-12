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
  followupMessages: string[];
  decisionFlow: import('./storage').DecisionFlowStep[];
  humanHandoffEnabled?: boolean;
  humanHandoffText?: string;
  humanHandoffPhone?: string;
  nameTimeoutMinutes?: number;
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

export interface PendingPreNamePromptConversation {
  kind: 'pre-name-prompt';
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
  nameTimeoutMinutes?: number;
  preNamePromptTimeoutMinutes?: number;
  askNameText: string;
  decisionTimeoutMinutes?: number;
  decisionTimeoutText?: string;
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

export type PendingConversation = PendingNameConversation | PendingPreNamePromptConversation | PendingDecisionConversation | PendingHandoffConversation;

export type PersistablePendingConversation =
  | Omit<PendingNameConversation, 'timeoutHandle'>
  | Omit<PendingPreNamePromptConversation, 'timeoutHandle'>
  | Omit<PendingDecisionConversation, 'timeoutHandle'>
  | Omit<PendingHandoffConversation, 'timeoutHandle'>;

interface ConversationStateSnapshot {
  version: 1;
  savedAt: string;
  conversations: Record<string, PersistablePendingConversation>;
}

class ConversationStateManager {
  private readonly map = new Map<string, PendingConversation>();
  private filePath = '';
  private hydrationComplete = false;

  set(jid: string, state: PendingConversation): void {
    this.clearTimer(this.map.get(jid));
    this.map.set(jid, state);
    this.persist();
  }

  get(jid: string): PendingConversation | undefined {
    return this.map.get(jid);
  }

  remove(jid: string): void {
    this.clearTimer(this.map.get(jid));
    this.map.delete(jid);
    this.persist();
  }

  size(): number {
    return this.map.size;
  }

  configurePersistence(filePath: string): void {
    this.filePath = filePath;
  }

  restore(
    schedule: (jid: string, state: PersistablePendingConversation) => NodeJS.Timeout | undefined,
  ): number {
    if (!this.filePath || !fs.existsSync(this.filePath)) {
      this.hydrationComplete = true;
      return 0;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Partial<ConversationStateSnapshot>;
      const entries = Object.entries(parsed.conversations ?? {});
      for (const [jid, state] of entries) {
        if (!state || typeof state !== 'object') continue;
        if (state.kind !== 'name' && state.kind !== 'pre-name-prompt' && state.kind !== 'decision' && state.kind !== 'handoff') continue;
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
      fs.writeFileSync(this.filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
    } catch (err) {
      console.warn('Could not persist conversation state:', err);
    }
  }
}

export const conversationState = new ConversationStateManager();
