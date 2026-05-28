import { config } from './config';
import path from 'path';
import { conversationState } from './conversationState';
import { DecisionFlowOption, DecisionFlowStep, Storage } from './storage';
import { detectTrigger } from './triggerDetector';
import {
  IncomingWhatsAppMessage,
  WhatsAppMessageSource,
  WhatsAppTransport,
} from './types/whatsapp';

const handledMessageIds = new Set<string>();
const MAX_TRIGGER_AGE_MS = 2 * 60 * 1000;
const DECISION_REPLY_TIMEOUT_MS = 30 * 60 * 1000;

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
    if (pending.kind === 'decision') {
      await handleDecisionReply(message.body.trim(), pending.flow, pending.stepId, senderJid, storage, transport);
      return;
    }

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
      pending.replyText,
      pending.followupMessages,
      pending.decisionFlow,
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
  const campaign = activeCampaigns.find((item) => item.id === trigger.campaignId);
  if (!campaign) return;
  const campaignResult = storage.recordCampaignTrigger(trigger.campaignId, senderPhone);

  console.log(`\n[${trigger.campaignName}] from ${senderPhone} (${pushname})`);

  const settings = storage.getCampaignConversationSettings(campaign);
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
        settings.replyText,
        settings.followupMessages,
        settings.decisionFlow,
      );
    }, settings.nameTimeoutMinutes * 60 * 1000);

    conversationState.set(senderJid, {
      kind: 'name',
      senderJid,
      senderPhone,
      campaignResultId: campaignResult.id,
      replyText: settings.replyText,
      followupMessages: settings.followupMessages,
      decisionFlow: settings.decisionFlow,
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
      settings.replyText,
      settings.followupMessages,
      settings.decisionFlow,
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
  replyText = storage.getAdminSettings().replyText,
  followupMessages = storage.getAdminSettings().followupMessages,
  decisionFlow: DecisionFlowStep[] = [],
): Promise<void> {
  const job = storage.enqueueContactSave(senderPhone, contactName, campaignResultId);
  if (job) console.log(`   Contact queued for background save/update: ${senderPhone}`);

  try {
    await transport.sendMessage(senderJid, replyText);
    console.log('   Text reply sent.');

    for (const followupText of followupMessages) {
      const text = followupText.trim();
      if (!text) continue;
      await transport.sendMessage(senderJid, text);
      console.log('   Follow-up reply sent.');
    }

    await sendDecisionFlowStart(transport, senderJid, decisionFlow);
  } catch (err) {
    console.error('   Failed to send text reply:', err);
  }
}

async function handleDecisionReply(
  answer: string,
  flow: DecisionFlowStep[],
  stepId: string,
  senderJid: string,
  storage: Storage,
  transport: WhatsAppTransport,
): Promise<void> {
  const step = flow.find((item) => item.id === stepId);
  if (!step || step.kind !== 'question') {
    conversationState.remove(senderJid);
    return;
  }

  const normalized = answer.trim().toLowerCase();
  const option = step.options?.find((item, index) => {
    return normalized === String(index + 1) || normalized === item.text.trim().toLowerCase();
  });

  if (!option) {
    await transport.sendMessage(senderJid, `לא הבנתי את הבחירה.\n\n${formatQuestion(step)}`);
    return;
  }

  conversationState.remove(senderJid);
  if (option.fileId) {
    const file = storage.getUploadedFile(option.fileId);
    if (file && transport.sendFile) {
      await transport.sendFile(senderJid, path.join(config.UPLOADS_PATH, file.filename), option.endText?.trim());
      console.log('   Decision file sent.');
    } else {
      await transport.sendMessage(senderJid, option.endText?.trim() || 'הקובץ לא זמין כרגע.');
      console.warn(`   Decision file unavailable: ${option.fileId}`);
    }
  } else if (option.endText?.trim()) {
    await transport.sendMessage(senderJid, option.endText.trim());
    console.log('   Decision reply sent.');
  }

  if (option.nextStepId) {
    await sendDecisionStep(transport, senderJid, flow, option.nextStepId);
  }
}

async function sendDecisionFlowStart(
  transport: WhatsAppTransport,
  senderJid: string,
  flow: DecisionFlowStep[],
): Promise<void> {
  const first = flow.find((step) => step.text.trim());
  if (!first) return;
  await sendDecisionStep(transport, senderJid, flow, first.id);
}

async function sendDecisionStep(
  transport: WhatsAppTransport,
  senderJid: string,
  flow: DecisionFlowStep[],
  stepId: string,
): Promise<void> {
  const step = flow.find((item) => item.id === stepId);
  if (!step?.text.trim()) return;

  if (step.kind === 'message') {
    await transport.sendMessage(senderJid, step.text.trim());
    console.log('   Decision message sent.');
    if (step.nextStepId) {
      await sendDecisionStep(transport, senderJid, flow, step.nextStepId);
    }
    return;
  }

  await transport.sendMessage(senderJid, formatQuestion(step));
  console.log('   Decision question sent.');
  const timeoutHandle = setTimeout(() => {
    conversationState.remove(senderJid);
    console.log(`   Decision reply timeout - cleared pending state for ${senderJid}.`);
  }, DECISION_REPLY_TIMEOUT_MS);
  conversationState.set(senderJid, {
    kind: 'decision',
    senderJid,
    flow,
    stepId: step.id,
    timestamp: Date.now(),
    timeoutHandle,
  });
}

function formatQuestion(step: DecisionFlowStep): string {
  const options = (step.options ?? [])
    .map((option: DecisionFlowOption, index) => `${index + 1}. ${option.text}`)
    .join('\n');
  return options ? `${step.text.trim()}\n\n${options}` : step.text.trim();
}
