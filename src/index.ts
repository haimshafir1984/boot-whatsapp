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
import { startOutboxDispatcher } from './outboxDispatcher';
import { startServiceBotFollowUpDispatcher } from './serviceBotFollowUpDispatcher';
import { startWhatsAppScheduler } from './whatsappLifecycle';
import { createShutdownHandler } from './shutdown';
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

function currentOutboundTransport(): WhatsAppTransport | null {
  if (config.WHATSAPP_PROVIDER === 'TWILIO_API') return new TwilioProvider();
  if (config.WHATSAPP_PROVIDER === 'META_CLOUD_API') return new MetaCloudProvider();
  return currentWhatsAppTransport();
}

function restoreConversationState(storage: Storage): void {
  conversationState.configurePersistence(config.CONVERSATION_STATE_PATH, storage);
  // Conversations no longer store their own copy of the campaign flow; rebuild
  // it here. Cached per campaign so restoring thousands of conversations does
  // not re-scan the campaign list once per conversation - and so every
  // conversation on a campaign shares one flow object instead of a copy each.
  const flowByCampaign = new Map<string, ReturnType<Storage['getCampaignConversationSettings']>['decisionFlow']>();
  const restored = conversationState.restore(
    (jid, state) => scheduleRestoredConversationTimeout(
      storage,
      currentOutboundTransport,
      jid,
      state,
    ),
    (campaignId) => {
      if (!campaignId) return undefined;
      const cached = flowByCampaign.get(campaignId);
      if (cached) return cached;
      const campaign = storage.getCampaigns().find((item) => item.id === campaignId);
      if (!campaign) return undefined;
      const flow = storage.getCampaignConversationSettings(campaign).decisionFlow;
      flowByCampaign.set(campaignId, flow);
      return flow;
    },
  );
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

  const contactQueue = startContactSaveQueue(storage);
  const outbox = startOutboxDispatcher(storage, currentOutboundTransport);
  const followUps = startServiceBotFollowUpDispatcher(storage, currentOutboundTransport);

  const server = startAdminServer(storage);

  const shutdown = createShutdownHandler({
    server,
    workers: [contactQueue, outbox, followUps],
    storage,
  });
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

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

