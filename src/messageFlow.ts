import { config } from './config';
import { conversationState } from './conversationState';
import { Storage } from './storage';
import { detectTrigger } from './triggerDetector';
import {
  IncomingWhatsAppMessage,
  WhatsAppMessageSource,
  WhatsAppTransport,
} from './types/whatsapp';

const handledMessageIds = new Set<string>();
const MAX_TRIGGER_AGE_MS = 2 * 60 * 1000;

export async function handleIncomingWhatsAppMessage(
  message: IncomingWhatsAppMessage,
  storage: Storage,
  transport: WhatsAppTransport,
  source: WhatsAppMessageSource,
): Promise<void> {
  if (!message.body?.trim()) return;
  if (!rememberMessage(message)) return;

  try {
    await handleMessage(message, storage, transport, source);
  } catch (err) {
    console.error(`[MSG] handler failed via ${source}:`, err);
  }
}

function rememberMessage(message: IncomingWhatsAppMessage): boolean {
  const id = message.id || `${message.from}:${message.timestamp ?? ''}`;

  if (handledMessageIds.has(id)) return false;
  handledMessageIds.add(id);

  if (handledMessageIds.size > 1000) {
    const first = handledMessageIds.values().next().value;
    if (first) handledMessageIds.delete(first);
  }

  return true;
}

async function handleMessage(
  message: IncomingWhatsAppMessage,
  storage: Storage,
  transport: WhatsAppTransport,
  source: WhatsAppMessageSource,
): Promise<void> {
  if (message.from === 'status@broadcast') return;
  if (message.from.endsWith('@g.us')) return;

  const senderJid = message.from;
  const messageAgeMs = message.timestamp
    ? Date.now() - message.timestamp * 1000
    : 0;
  const pending = conversationState.get(senderJid);

  if (pending) {
    const chosenName = message.body.trim();
    clearTimeout(pending.timeoutHandle);
    conversationState.remove(senderJid);

    const finalName = chosenName
      ? `${chosenName}${pending.suffix}`
      : `${pending.whatsappName}${pending.suffix}`;

    console.log(`\nName reply from ${pending.senderPhone}: "${finalName}"`);
    await queueAndReply(
      transport,
      storage,
      senderJid,
      pending.senderPhone,
      finalName,
      pending.campaignResultId,
    );
    return;
  }

  const activeCampaigns = storage.getActiveCampaigns();
  const trigger = detectTrigger(message.body, activeCampaigns);
  if (!trigger.matched) {
    console.log(`[MSG] no trigger match via=${source} age=${Math.round(messageAgeMs / 1000)}s from=${senderJid} active=${activeCampaigns.length}`);
    return;
  }
  if (messageAgeMs > MAX_TRIGGER_AGE_MS) {
    console.warn(`[MSG] stale trigger ignored via=${source} age=${Math.round(messageAgeMs / 1000)}s campaign="${trigger.campaignName}" from=${senderJid}`);
    return;
  }
  console.log(`[MSG] trigger matched via=${source} age=${Math.round(messageAgeMs / 1000)}s campaign="${trigger.campaignName}" from=${senderJid}`);

  const senderPhone = await transport.resolvePhone(senderJid);
  const displayName = await message.getDisplayName();
  const pushname =
    displayName.trim() ||
    config.CONTACT_NAME_FALLBACK.replace('{phone}', senderPhone);
  const campaignResult = storage.recordCampaignTrigger(trigger.campaignId, senderPhone);

  console.log(`\n[${trigger.campaignName}] from ${senderPhone} (${pushname})`);

  const settings = storage.getAdminSettings();
  if (settings.askNameEnabled) {
    const askText = settings.askNameText.replace(
      '{timeout}',
      String(settings.nameTimeoutMinutes),
    );
    await transport.sendMessage(senderJid, askText);
    console.log('   Asked for preferred name.');

    const timeoutHandle = setTimeout(async () => {
      conversationState.remove(senderJid);
      const finalName = `${pushname}${trigger.suffix}`;
      console.log(`\n   Timeout - saving ${senderPhone} as "${finalName}"`);
      await queueAndReply(
        transport,
        storage,
        senderJid,
        senderPhone,
        finalName,
        campaignResult.id,
      );
    }, settings.nameTimeoutMinutes * 60 * 1000);

    conversationState.set(senderJid, {
      senderJid,
      senderPhone,
      campaignResultId: campaignResult.id,
      suffix: trigger.suffix,
      whatsappName: pushname,
      timestamp: Date.now(),
      timeoutHandle,
    });
  } else {
    const contactName = `${pushname}${trigger.suffix}`;
    await queueAndReply(
      transport,
      storage,
      senderJid,
      senderPhone,
      contactName,
      campaignResult.id,
    );
  }
}

async function queueAndReply(
  transport: WhatsAppTransport,
  storage: Storage,
  senderJid: string,
  senderPhone: string,
  contactName: string,
  campaignResultId?: string,
): Promise<void> {
  const job = storage.enqueueContactSave(senderPhone, contactName, campaignResultId);
  if (job) console.log(`   Contact queued for background save/update: ${senderPhone}`);

  try {
    const { replyText, followupMessages } = storage.getAdminSettings();
    await transport.sendMessage(senderJid, replyText);
    console.log('   Text reply sent.');

    for (const followupText of followupMessages) {
      const text = followupText.trim();
      if (!text) continue;
      await transport.sendMessage(senderJid, text);
      console.log('   Follow-up reply sent.');
    }
  } catch (err) {
    console.error('   Failed to send text reply:', err);
  }
}
