/**
 * index.ts
 * Entry point – starts the admin HTTP server then the WhatsApp client.
 */

import fs from 'fs';
import path from 'path';
import { Storage } from './storage';
import { createStorage } from './storageFactory';
import { startAdminServer } from './adminServer';
import { config } from './config';
import { startContactSaveQueue } from './contactQueue';
import { startWhatsAppScheduler } from './whatsappLifecycle';
import { conversationState } from './conversationState';
import { scheduleRestoredConversationTimeout } from './messageFlow';
import { botState } from './botState';
import { TwilioProvider } from './providers/TwilioProvider';
import { MetaCloudProvider } from './providers/MetaCloudProvider';
import { WhatsAppTransport } from './types/whatsapp';

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

function currentWhatsAppTransport(): WhatsAppTransport | null {
  const candidate = botState.client as unknown as Partial<WhatsAppTransport> | null;
  if (!candidate?.sendMessage || !candidate.resolvePhone) return null;
  return candidate as WhatsAppTransport;
}

function restoreConversationState(storage: Storage): void {
  conversationState.configurePersistence(config.CONVERSATION_STATE_PATH);
  const twilioTransport = config.WHATSAPP_PROVIDER === 'TWILIO_API' ? new TwilioProvider() : null;
  const metaTransport = config.WHATSAPP_PROVIDER === 'META_CLOUD_API' ? new MetaCloudProvider() : null;
  const restored = conversationState.restore((jid, state) => scheduleRestoredConversationTimeout(
    storage,
    () => twilioTransport ?? metaTransport ?? currentWhatsAppTransport(),
    jid,
    state,
  ));
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

  const storage = await createStorage();
  restoreConversationState(storage);

  startContactSaveQueue(storage);

  startAdminServer(storage);

  if (config.WHATSAPP_PROVIDER === 'TWILIO_API') {
    console.log('  WhatsApp provider: Twilio API (webhook mode, no Chromium scheduler)');
  } else if (config.WHATSAPP_PROVIDER === 'META_CLOUD_API') {
    console.log('  WhatsApp provider: Meta Cloud API (webhook mode, no Chromium scheduler)');
  } else {
    startWhatsAppScheduler(storage);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  console.error('Startup aborted. If DATABASE_URL is set, verify PostgreSQL is reachable and migrations can run.');
  process.exit(1);
});

