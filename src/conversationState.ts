/**
 * conversationState.ts
 * In-memory store for conversations that are waiting for the user's
 * name-preference reply (when "ask for name" mode is enabled).
 *
 * Each entry has a Node.js timeout handle that fires automatically if the
 * user does not reply within the configured window.
 */

export interface PendingConversation {
  senderJid: string;
  senderPhone: string;
  /** Suffix to append to the final contact name (" - Bot" or " - [referrer]"). */
  suffix: string;
  /** Fallback: the sender's WhatsApp pushname, used if they don't reply. */
  whatsappName: string;
  /** Timestamp when the pending state was created (ms). */
  timestamp: number;
  /** Cancel this to prevent the auto-save when the user replies in time. */
  timeoutHandle: NodeJS.Timeout;
}

class ConversationStateManager {
  private readonly map = new Map<string, PendingConversation>();

  set(jid: string, state: PendingConversation): void {
    this.map.set(jid, state);
  }

  get(jid: string): PendingConversation | undefined {
    return this.map.get(jid);
  }

  remove(jid: string): void {
    this.map.delete(jid);
  }

  size(): number {
    return this.map.size;
  }
}

export const conversationState = new ConversationStateManager();
