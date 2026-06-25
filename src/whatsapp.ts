/**
 * whatsapp.ts
 * WhatsApp client setup and message-handling flow.
 *
 * Message flow:
 * 1. Pending name reply? Resolve name, queue contact save, send replies.
 * 2. Trigger match? Ask for name or queue save immediately, then send replies.
 * 3. No match: ignore.
 */

import { Client, LocalAuth, Message, MessageMedia } from 'whatsapp-web.js';
import QRCode from 'qrcode';
import { config } from './config';
import { Storage } from './storage';
import { detectTrigger } from './triggerDetector';
import { botState } from './botState';
import { handleIncomingWhatsAppMessage } from './messageFlow';
import { IncomingWhatsAppMessage, WhatsAppTransport } from './types/whatsapp';

const RECONNECT_BACKOFF_MS = [10_000, 30_000, 60_000, 120_000, 300_000];

export function createWhatsAppClient(storage: Storage, pairingPhone?: string): Client {
  let reconnectTimer: NodeJS.Timeout | null = null;
  let closed = false;
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
    botState.notReadySince = null;
    botState.reconnectAttempts = 0;
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
    botState.notReadySince = botState.notReadySince ?? Date.now();
    botState.connectedPhone = null;
    botState.pairingAttempted = false;
    botState.pairingCode = null;
  });

  client.on('disconnected', (reason) => {
    console.warn('Disconnected:', reason);
    botState.authenticated = false;
    botState.ready = false;
    botState.notReadySince = botState.notReadySince ?? Date.now();
    botState.connectedPhone = null;
    botState.pairingAttempted = false;
    botState.pairingCode = null;

    if (!botState.intentionalRestart && !closed) {
      const attempt = botState.reconnectAttempts + 1;
      const delay = RECONNECT_BACKOFF_MS[Math.min(attempt - 1, RECONNECT_BACKOFF_MS.length - 1)];
      botState.reconnectAttempts = attempt;
      botState.lastReconnectAt = new Date().toISOString();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      console.log(`   Reconnecting in ${delay}ms... attempt=${attempt}`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (botState.intentionalRestart || closed) return;
        console.log('   Reconnecting now...');
        client.initialize().catch((err) =>
          console.error('   Reconnect failed:', err),
        );
      }, delay);
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
    const connectedPhone = client.info?.wid?.user ?? '';
    const targetPhone = String(message.to ?? '').split('@')[0]?.split(':')[0] ?? '';
    if (trigger.matched && connectedPhone && targetPhone === connectedPhone) {
      console.log(`[SELF-TEST] WebJS self trigger matched for "${trigger.campaignName}".`);
      await handleIncomingMessage(message, storage, client, 'message_create');
    }
  });

  const originalDestroy = client.destroy.bind(client);
  const originalLogout = client.logout.bind(client);
  (client as any).destroy = async () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    return originalDestroy();
  };
  (client as any).logout = async () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    return originalLogout();
  };

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
  const hasMedia = Boolean((message as any).hasMedia);
  return {
    id: (message.id as any)?._serialized ?? `${message.from}:${message.timestamp ?? ''}`,
    from: message.from,
    to: message.to,
    body: message.body || (hasMedia ? '[media]' : ''),
    hasUserSignal: Boolean(message.body?.trim() || hasMedia),
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
    sendFile: async (to, filePath, caption, options = {}) => {
      const media = MessageMedia.fromFilePath(filePath);
      await client.sendMessage(to, media, {
        ...(caption?.trim() && !options.asSticker ? { caption: caption.trim() } : {}),
        ...(options.asSticker ? { sendMediaAsSticker: true } : {}),
      });
    },
    sendContactCard: async (to: string, vcard: string) => {
      await client.sendMessage(to, vcard, { parseVCards: true, linkPreview: false } as any);
    },
    sendInteractiveButtons: async (to, text, buttons) => {
      const buttonText = buttons.length
        ? `${text}\n\n${buttons.map((button, index) => `${index + 1}. ${button.text}`).join('\n')}`
        : text;
      await client.sendMessage(to, buttonText);
    },
    sendInteractiveList: async (to, text, _buttonText, items) => {
      const listText = items.length
        ? `${text}\n\n${items.map((item, index) => `${index + 1}. ${item.text}`).join('\n')}`
        : text;
      await client.sendMessage(to, listText);
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
