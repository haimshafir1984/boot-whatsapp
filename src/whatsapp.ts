/**
 * whatsapp.ts
 * WhatsApp client setup and message-handling flow.
 *
 * Message flow:
 * 1. Pending name reply? Resolve name, queue contact save, send replies.
 * 2. Trigger match? Ask for name or queue save immediately, then send replies.
 * 3. No match: ignore.
 */

import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import QRCode from 'qrcode';
import { config } from './config';
import { Storage } from './storage';
import { detectTrigger } from './triggerDetector';
import { botState } from './botState';
import { handleIncomingWhatsAppMessage } from './messageFlow';
import { IncomingWhatsAppMessage, WhatsAppTransport } from './types/whatsapp';

export function createWhatsAppClient(storage: Storage, pairingPhone?: string): Client {
  const clientOptions: any = {
    authStrategy: new LocalAuth({ dataPath: config.SESSION_PATH }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    },
  };

  if (pairingPhone) {
    clientOptions.pairWithPhoneNumber = { phoneNumber: pairingPhone };
    console.log(`Client starting in pairing-code mode for ${pairingPhone}`);
  }

  const client = new Client(clientOptions);

  client.on('code' as any, (code: string) => {
    botState.pairingCode = code;
    console.log(`Pairing code received: ${code}`);
  });

  client.on('qr', async (qr) => {
    botState.qrDataUrl = await QRCode.toDataURL(qr);
    console.log('\nOpen the admin dashboard to connect WhatsApp.\n');

    if (botState.pairingPhone && !botState.pairingAttempted) {
      botState.pairingAttempted = true;
      try {
        const code = await (client as any).requestPairingCode(botState.pairingPhone);
        botState.pairingCode = code;
        console.log(`Pairing code generated: ${code}`);
      } catch (err) {
        console.error('Pairing code request failed:', err);
        botState.pairingAttempted = false;
      }
    }
  });

  client.on('authenticated', () => {
    botState.qrDataUrl = null;
    botState.pairingCode = null;
    botState.authenticated = true;
    console.log('Session authenticated and saved to disk.');
  });

  client.on('ready', () => {
    botState.ready = true;
    botState.connectedPhone = (client.info?.wid?.user ?? null) as string | null;
    if (botState.connectedPhone) {
      storage.updateClientProfile({ whatsappPhone: botState.connectedPhone });
    }
    const campaigns = storage.getActiveCampaigns();
    const namePromptCount = campaigns.filter(
      (campaign) => storage.getCampaignConversationSettings(campaign).askNameEnabled,
    ).length;

    console.log('\nWhatsApp bot is ready.');
    console.log(`   Connected phone  : ${botState.connectedPhone ?? 'unknown'}`);
    console.log(`   Active campaigns : ${campaigns.length}`);
    campaigns.forEach((campaign) =>
      console.log(`     - [${campaign.triggerType === 1 ? 'Bot' : 'Ref'}] "${campaign.triggerPhrase}"`),
    );
    console.log(`   Ask for name     : ${namePromptCount}/${campaigns.length} active campaigns`);
    console.log('');
  });

  client.on('auth_failure', (msg) => {
    console.error('Auth failure:', msg);
    botState.authenticated = false;
    botState.ready = false;
    botState.connectedPhone = null;
    botState.pairingAttempted = false;
    botState.pairingCode = null;
  });

  client.on('disconnected', (reason) => {
    console.warn('Disconnected:', reason);
    botState.authenticated = false;
    botState.ready = false;
    botState.connectedPhone = null;
    botState.pairingAttempted = false;
    botState.pairingCode = null;

    if (!botState.intentionalRestart) {
      console.log('   Reconnecting in 10s...');
      setTimeout(() => {
        console.log('   Reconnecting now...');
        client.initialize().catch((err) =>
          console.error('   Reconnect failed:', err),
        );
      }, 10_000);
    }
  });

  client.on('message', async (message: Message) => {
    await handleIncomingMessage(message, storage, client, 'message');
  });

  client.on('message_create', async (message: Message) => {
    if (!message.fromMe) {
      await handleIncomingMessage(message, storage, client, 'message_create');
      return;
    }
    if (!message.body?.trim()) return;
    if (message.to?.endsWith('@g.us')) return;

    const trigger = detectTrigger(message.body, storage.getActiveCampaigns());
    if (trigger.matched) {
      console.log(`[SELF-TEST] Outgoing trigger detected for "${trigger.campaignName}". Incoming messages use the normal message handler.`);
    }
  });

  botState.client = client;
  return client;
}

async function handleIncomingMessage(
  message: Message,
  storage: Storage,
  client: Client,
  source: 'message' | 'message_create',
): Promise<void> {
  const incoming = toIncomingMessage(message);
  const transport = createWebJsTransport(client);
  await handleIncomingWhatsAppMessage(incoming, storage, transport, source);
}

function toIncomingMessage(message: Message): IncomingWhatsAppMessage {
  return {
    id: (message.id as any)?._serialized ?? `${message.from}:${message.timestamp ?? ''}`,
    from: message.from,
    to: message.to,
    body: message.body,
    timestamp: message.timestamp,
    async getDisplayName() {
      const contact = await message.getContact();
      return contact.pushname?.trim() || contact.name?.trim() || '';
    },
  };
}

function createWebJsTransport(client: Client): WhatsAppTransport {
  return {
    sendMessage: async (to, text) => {
      await client.sendMessage(to, text);
    },
    resolvePhone: async (jid) => {
      try {
        const resolved = await (client as any).getContactLidAndPhone([jid]);
        const pnJid: string | undefined = resolved?.[0]?.pn;
        return pnJid ? pnJid.split('@')[0] : jid.split('@')[0];
      } catch {
        return jid.split('@')[0];
      }
    },
  };
}
