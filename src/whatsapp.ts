/**
 * whatsapp.ts
 * WhatsApp client setup and the full message-handling flow.
 *
 * Message flow:
 *   1. Is this a reply to a pending "what name?" conversation?
 *      → resolve name, save contact, send replies.
 *   2. Is this a valid trigger (type 1 or 2, per admin settings)?
 *      → if askName is ON: ask user for name, register pending state + timeout.
 *      → if askName is OFF: save immediately, send replies.
 *   3. Otherwise: ignore.
 */

import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import QRCode from 'qrcode';
import { config } from './config';
import { Storage } from './storage';
import { saveContactToGoogle } from './googleContacts';
import { saveContactToICloud } from './icloudContacts';
import { detectTrigger } from './triggerDetector';
import { conversationState } from './conversationState';
import { botState } from './botState';

// ─── Client factory ──────────────────────────────────────────────────────────

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
    console.log(`🔑 Client starting in pairing-code mode for ${pairingPhone}`);
  }
  const client = new Client(clientOptions);

  // Listen for code_received event (fires on first code + every 3-min refresh)
  client.on('code' as any, (code: string) => {
    botState.pairingCode = code;
    console.log(`🔑 Pairing code received: ${code}`);
  });

  client.on('qr', async (qr) => {
    botState.qrDataUrl = await QRCode.toDataURL(qr);
    console.log('\n📱 פתח את דף הניהול כדי לחבר את WhatsApp\n');
    // Auto-request pairing code ONCE per session when a phone is pre-configured
    if (botState.pairingPhone && !botState.pairingAttempted) {
      botState.pairingAttempted = true;
      try {
        const code = await (client as any).requestPairingCode(botState.pairingPhone);
        botState.pairingCode = code;
        console.log(`🔑 Pairing code generated: ${code}`);
      } catch (err) {
        console.error('❌ Pairing code request failed:', err);
        botState.pairingAttempted = false; // allow retry after manual click
      }
    }
  });

  client.on('authenticated', () => {
    botState.qrDataUrl   = null;
    botState.pairingCode = null;
    botState.authenticated = true;
    console.log('🔐 Session authenticated – saved to disk.');
  });

  client.on('ready', () => {
    botState.ready = true;
    const s = storage.getAdminSettings();
    const campaigns = storage.getActiveCampaigns();
    console.log('\n✅ WhatsApp bot is ready.');
    console.log(`   Active campaigns : ${campaigns.length}`);
    campaigns.forEach((c) =>
      console.log(`     • [${c.triggerType === 1 ? 'Bot' : 'Ref'}] "${c.triggerPhrase}"`),
    );
    console.log(
      `   Ask for name     : ${s.askNameEnabled ? `yes (${s.nameTimeoutMinutes}m)` : 'no'}`,
    );
    console.log('');
  });

  client.on('auth_failure', (msg) => {
    console.error('\u274c Auth failure:', msg);
    botState.authenticated = false;
    botState.ready = false;
    botState.pairingAttempted = false;
    botState.pairingCode = null;
  });

  client.on('disconnected', (reason) => {
    console.warn('\u26a0\ufe0f  Disconnected:', reason);
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
    if (!message.from.endsWith('@g.us')) {
      console.log(`[MSG] from=${message.from} body="${message.body.slice(0, 80)}"`);
    }
    await handleMessage(message, storage, client);
  });

  botState.client = client;
  return client;
}

// ─── Main message handler ────────────────────────────────────────────────────

async function handleMessage(
  message: Message,
  storage: Storage,
  client: Client,
): Promise<void> {
  if (message.from.endsWith('@g.us')) return; // ignore groups

  const senderJid = message.from;

  // ── Step 1: pending name reply? ──────────────────────────────────────────
  const pending = conversationState.get(senderJid);
  if (pending) {
    const chosenName = message.body.trim();
    clearTimeout(pending.timeoutHandle); // cancel the auto-save timer
    conversationState.remove(senderJid);

    const finalName = chosenName
      ? `${chosenName}${pending.suffix}`
      : `${pending.whatsappName}${pending.suffix}`;

    console.log(`\n📝 Name reply from ${pending.senderPhone}: "${finalName}"`);
    await saveAndReply(client, storage, senderJid, pending.senderPhone, finalName);
    return;
  }

  // ── Step 2: is this a trigger? ───────────────────────────────────────────
  const activeCampaigns = storage.getActiveCampaigns();
  const trigger = detectTrigger(message.body, activeCampaigns);
  if (!trigger.matched) return;

  // Resolve real phone number (handles @lid format)
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

  console.log(
    `\n📩 [${trigger.campaignName}] from ${senderPhone} (${pushname})`,
  );

  const settings = storage.getAdminSettings();
  if (settings.askNameEnabled) {
    // ── Ask for preferred name ─────────────────────────────────────────────
    const askText = config.ASK_NAME_TEXT.replace(
      '{timeout}',
      String(settings.nameTimeoutMinutes),
    );
    await client.sendMessage(senderJid, askText);
    console.log('   💬 Asked for preferred name.');

    // Register timeout: auto-save with pushname if no reply comes
    const timeoutHandle = setTimeout(async () => {
      conversationState.remove(senderJid);
      const finalName = `${pushname}${trigger.suffix}`;
      console.log(`\n   ⏰ Timeout – saving ${senderPhone} as "${finalName}"`);
      await saveAndReply(client, storage, senderJid, senderPhone, finalName);
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
    // ── Save immediately ───────────────────────────────────────────────────
    const contactName = `${pushname}${trigger.suffix}`;
    await saveAndReply(client, storage, senderJid, senderPhone, contactName);
  }
}

// ─── Shared save + reply helper ──────────────────────────────────────────────

async function saveAndReply(
  client: Client,
  storage: Storage,
  senderJid: string,
  senderPhone: string,
  contactName: string,
): Promise<void> {
  // 1. Save contact (skip duplicates)
  if (storage.isContactSaved(senderPhone)) {
    console.log(`   ℹ️  ${senderPhone} already saved – skipping.`);
  } else {
    const { contactsProvider, icloudEmail, icloudPassword } = storage.getAdminSettings();
    try {
      if (contactsProvider === 'google') {
        await saveContactToGoogle(contactName, `+${senderPhone}`);
      } else if (contactsProvider === 'icloud') {
        await saveContactToICloud(icloudEmail, icloudPassword, contactName, `+${senderPhone}`);
      } else {
        console.log(`   📋 Manual mode: contact recorded locally.`);
      }
      storage.markContactSaved(senderPhone, contactName);
    } catch (err) {
      console.error('   ❌ Contacts save error:', err);
    }
  }

  // 2. Text reply
  try {
    await client.sendMessage(senderJid, config.REPLY_TEXT);
    console.log('   ✅ Text reply sent.');
  } catch (err) {
    console.error('   ❌ Failed to send text reply:', err);
  }

  // 3. Contact card (tap-to-save UI)
  try {
    const myPhone = config.MY_CONTACT.phone.replace('+', '');
    const myContact = await client.getContactById(`${myPhone}@c.us`);
    await client.sendMessage(senderJid, myContact as any);
    console.log('   ✅ Contact card sent.');
  } catch (err) {
    console.error('   ❌ Failed to send contact card:', err);
  }
}
