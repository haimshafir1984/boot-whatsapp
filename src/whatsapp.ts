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
import { conversationState } from './conversationState';
import { botState } from './botState';

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
    const settings = storage.getAdminSettings();
    const campaigns = storage.getActiveCampaigns();

    console.log('\nWhatsApp bot is ready.');
    console.log(`   Active campaigns : ${campaigns.length}`);
    campaigns.forEach((campaign) =>
      console.log(`     - [${campaign.triggerType === 1 ? 'Bot' : 'Ref'}] "${campaign.triggerPhrase}"`),
    );
    console.log(
      `   Ask for name     : ${settings.askNameEnabled ? `yes (${settings.nameTimeoutMinutes}m)` : 'no'}`,
    );
    console.log('');
  });

  client.on('auth_failure', (msg) => {
    console.error('Auth failure:', msg);
    botState.authenticated = false;
    botState.ready = false;
    botState.pairingAttempted = false;
    botState.pairingCode = null;
  });

  client.on('disconnected', (reason) => {
    console.warn('Disconnected:', reason);
    botState.authenticated = false;
    botState.ready = false;
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
    await handleMessage(message, storage, client);
  });

  botState.client = client;
  return client;
}

async function handleMessage(
  message: Message,
  storage: Storage,
  client: Client,
): Promise<void> {
  if (message.from.endsWith('@g.us')) return;

  const senderJid = message.from;
  const pending = conversationState.get(senderJid);

  if (pending) {
    const chosenName = message.body.trim();
    clearTimeout(pending.timeoutHandle);
    conversationState.remove(senderJid);

    const finalName = chosenName
      ? `${chosenName}${pending.suffix}`
      : `${pending.whatsappName}${pending.suffix}`;

    console.log(`\nName reply from ${pending.senderPhone}: "${finalName}"`);
    await queueAndReply(client, storage, senderJid, pending.senderPhone, finalName);
    return;
  }

  const activeCampaigns = storage.getActiveCampaigns();
  const trigger = detectTrigger(message.body, activeCampaigns);
  if (!trigger.matched) return;

  const contact = await message.getContact();
  let senderPhone: string;
  try {
    const resolved = await (client as any).getContactLidAndPhone([senderJid]);
    const pnJid: string | undefined = resolved?.[0]?.pn;
    senderPhone = pnJid ? pnJid.split('@')[0] : senderJid.split('@')[0];
  } catch {
    senderPhone = senderJid.split('@')[0];
  }

  const pushname =
    contact.pushname?.trim() ||
    contact.name?.trim() ||
    config.CONTACT_NAME_FALLBACK.replace('{phone}', senderPhone);

  console.log(`\n[${trigger.campaignName}] from ${senderPhone} (${pushname})`);

  const settings = storage.getAdminSettings();
  if (settings.askNameEnabled) {
    const askText = settings.askNameText.replace(
      '{timeout}',
      String(settings.nameTimeoutMinutes),
    );
    await client.sendMessage(senderJid, askText);
    console.log('   Asked for preferred name.');

    const timeoutHandle = setTimeout(async () => {
      conversationState.remove(senderJid);
      const finalName = `${pushname}${trigger.suffix}`;
      console.log(`\n   Timeout - saving ${senderPhone} as "${finalName}"`);
      await queueAndReply(client, storage, senderJid, senderPhone, finalName);
    }, settings.nameTimeoutMinutes * 60 * 1000);

    conversationState.set(senderJid, {
      senderJid,
      senderPhone,
      suffix: trigger.suffix,
      whatsappName: pushname,
      timestamp: Date.now(),
      timeoutHandle,
    });
  } else {
    const contactName = `${pushname}${trigger.suffix}`;
    await queueAndReply(client, storage, senderJid, senderPhone, contactName);
  }
}

async function queueAndReply(
  client: Client,
  storage: Storage,
  senderJid: string,
  senderPhone: string,
  contactName: string,
): Promise<void> {
  if (storage.isContactSaved(senderPhone)) {
    console.log(`   ${senderPhone} already saved - skipping contact queue.`);
  } else {
    const job = storage.enqueueContactSave(senderPhone, contactName);
    if (job) console.log(`   Contact queued for background save: ${senderPhone}`);
  }

  try {
    const { replyText, followupMessages } = storage.getAdminSettings();
    await client.sendMessage(senderJid, replyText);
    console.log('   Text reply sent.');

    for (const followupText of followupMessages) {
      const text = followupText.trim();
      if (!text) continue;
      await client.sendMessage(senderJid, text);
      console.log('   Follow-up reply sent.');
    }
  } catch (err) {
    console.error('   Failed to send text reply:', err);
  }
}
