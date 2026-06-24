/**
 * index.ts
 * Entry point – starts the admin HTTP server then the WhatsApp client.
 */

import fs from 'fs';
import path from 'path';
import { Storage } from './storage';
import { startAdminServer } from './adminServer';
import { config } from './config';
import { startContactSaveQueue } from './contactQueue';
import { startWhatsAppScheduler } from './whatsappLifecycle';
import { conversationState, PersistablePendingConversation } from './conversationState';

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

function removeSingletonLocks(dir: string): void {
  if (!fs.existsSync(dir)) return;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        removeSingletonLocks(full);
      } else if (entry.name.startsWith('Singleton')) {
        fs.unlinkSync(full);
        console.log(`  Removed stale lock: ${entry.name}`);
      }
    }
  } catch { /* ignore */ }
}

function restoredConversationTtlMs(state: PersistablePendingConversation): number {
  if (state.kind === 'name') {
    return Math.max(1, state.nameTimeoutMinutes ?? 5) * 60 * 1000;
  }
  if (state.kind === 'pre-name-prompt') {
    return Math.max(1, state.preNamePromptTimeoutMinutes ?? 1) * 60 * 1000;
  }
  if (state.kind === 'contact-card-confirmation') {
    const minutes = state.contactCardConfirmationTimeoutMinutes || 30;
    return Math.max(1, minutes) * 60 * 1000;
  }
  if (state.kind === 'decision' || state.kind === 'wait-reply') {
    const step = state.flow.find((item) => item.id === state.stepId);
    const minutes = step?.timeoutMinutes || state.decisionTimeoutMinutes || 30;
    return Math.max(1, minutes) * 60 * 1000;
  }
  return 24 * 60 * 60 * 1000;
}

function restoreConversationState(): void {
  conversationState.configurePersistence(config.CONVERSATION_STATE_PATH);
  const restored = conversationState.restore((jid, state) => {
    const ageMs = Date.now() - Number(state.timestamp || 0);
    const remainingMs = restoredConversationTtlMs(state) - ageMs;
    if (remainingMs <= 0) return undefined;
    return setTimeout(() => {
      conversationState.remove(jid);
      console.log(`Restored conversation expired: ${jid}`);
    }, remainingMs);
  });
  if (restored) {
    console.log(`  Restored pending conversations: ${restored}`);
  }
}

async function main(): Promise<void> {
  console.log('─'.repeat(50));
  console.log('  WhatsApp Status Bot – starting up…');
  console.log('─'.repeat(50));
  console.log(`  Contact card configured : ${config.MY_CONTACT.phone ? 'yes' : 'no'}`);
  console.log(`  Storage  : ${path.resolve(config.STORAGE_PATH)}`);
  console.log('─'.repeat(50) + '\n');

  removeSingletonLocks(config.SESSION_PATH);

  const storage = new Storage(config.STORAGE_PATH);
  restoreConversationState();

  startContactSaveQueue(storage);

  startAdminServer(storage);

  if (config.WHATSAPP_PROVIDER === 'TWILIO_API') {
    console.log('  WhatsApp provider: Twilio API (webhook mode, no Chromium scheduler)');
  } else {
    startWhatsAppScheduler(storage);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
