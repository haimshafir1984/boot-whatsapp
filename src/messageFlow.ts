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
const BOT_REPLY_DELAY_MS = Math.max(
  0,
  Number.isFinite(config.BOT_REPLY_DELAY_MS) ? config.BOT_REPLY_DELAY_MS : 3000,
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitBeforeBotReply(): Promise<void> {
  if (BOT_REPLY_DELAY_MS > 0) await sleep(BOT_REPLY_DELAY_MS);
}

async function sendBotMessage(transport: WhatsAppTransport, to: string, text: string): Promise<void> {
  await waitBeforeBotReply();
  await transport.sendMessage(to, text);
}

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
      await handleDecisionReply(
        message.body.trim(),
        pending.flow,
        pending.stepId,
        senderJid,
        storage,
        transport,
        pending.campaignId,
        pending.campaignResultId,
        pending.senderPhone,
        {
          enabled: pending.humanHandoffEnabled,
          text: pending.humanHandoffText,
          phone: pending.humanHandoffPhone,
        },
      );
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
      pending.campaignId,
      {
        enabled: pending.humanHandoffEnabled,
        text: pending.humanHandoffText,
        phone: pending.humanHandoffPhone,
      },
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

  const senderPhone = message.senderPhone || await transport.resolvePhone(senderJid);
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
    await sendBotMessage(transport, senderJid, askText);
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
        campaign.id,
        {
          enabled: settings.humanHandoffEnabled,
          text: settings.humanHandoffText,
          phone: settings.humanHandoffPhone,
        },
      );
    }, settings.nameTimeoutMinutes * 60 * 1000);

    conversationState.set(senderJid, {
      kind: 'name',
      senderJid,
      senderPhone,
      campaignResultId: campaignResult.id,
      campaignId: campaign.id,
      replyText: settings.replyText,
      followupMessages: settings.followupMessages,
      decisionFlow: settings.decisionFlow,
      humanHandoffEnabled: settings.humanHandoffEnabled,
      humanHandoffText: settings.humanHandoffText,
      humanHandoffPhone: settings.humanHandoffPhone,
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
      campaign.id,
      {
        enabled: settings.humanHandoffEnabled,
        text: settings.humanHandoffText,
        phone: settings.humanHandoffPhone,
      },
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
  campaignId?: string,
  humanHandoff: { enabled?: boolean; text?: string; phone?: string } = {},
): Promise<void> {
  const job = storage.enqueueContactSave(senderPhone, contactName, campaignResultId);
  if (job) console.log(`   Contact queued for background save/update: ${senderPhone}`);

  try {
    const finalReplyText = replyText.trim();
    if (finalReplyText) {
      await sendBotMessage(transport, senderJid, finalReplyText);
      console.log('   Text reply sent.');
    }

    for (const followupText of followupMessages) {
      const text = followupText.trim();
      if (!text) continue;
      await sendBotMessage(transport, senderJid, text);
      console.log('   Follow-up reply sent.');
    }

    await sendDecisionFlowStart(
      transport,
      storage,
      senderJid,
      decisionFlow,
      campaignId,
      campaignResultId,
      senderPhone,
      humanHandoff,
    );
  } catch (err) {
    console.error('   Failed to send reply flow:', err);
  }
}

async function handleDecisionReply(
  answer: string,
  flow: DecisionFlowStep[],
  stepId: string,
  senderJid: string,
  storage: Storage,
  transport: WhatsAppTransport,
  campaignId?: string,
  campaignResultId?: string,
  senderPhone?: string,
  humanHandoff: { enabled?: boolean; text?: string; phone?: string } = {},
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

  if (!option && humanHandoff.enabled) {
    const handoffText = formatHumanHandoffText(humanHandoff.text, humanHandoff.phone);
    if (handoffText) await sendBotMessage(transport, senderJid, handoffText);
    if (campaignId) {
      storage.recordCampaignEvent({
        campaignId,
        campaignResultId,
        phone: senderPhone,
        type: 'human_handoff',
        label: 'מענה אנושי',
      });
    }
    conversationState.remove(senderJid);
    return;
  }

  if (!option) {
    await sendBotMessage(transport, senderJid, `לא הבנתי את הבחירה.\n\n${formatQuestion(step)}`);
    return;
  }

  conversationState.remove(senderJid);
  if (campaignId) {
    storage.recordCampaignEvent({
      campaignId,
      campaignResultId,
      phone: senderPhone,
      type: 'step_answered',
      label: option.text,
    });
  }
  if (option.fileId) {
    await sendDecisionFile(
      transport,
      storage,
      senderJid,
      option.fileId,
      option.endText?.trim(),
      option.fileAsSticker,
      campaignId,
      campaignResultId,
      senderPhone,
    );
  } else if (option.endText?.trim()) {
    await sendBotMessage(transport, senderJid, option.endText.trim());
    console.log('   Decision reply sent.');
  }

  if (option.nextStepId) {
    await sendDecisionStep(transport, storage, senderJid, flow, option.nextStepId, campaignId, campaignResultId, senderPhone, humanHandoff);
  } else if (campaignId) {
    storage.recordCampaignEvent({
      campaignId,
      campaignResultId,
      phone: senderPhone,
      type: 'completed',
      label: 'סיום תהליך',
    });
  }
}

async function sendDecisionFlowStart(
  transport: WhatsAppTransport,
  storage: Storage,
  senderJid: string,
  flow: DecisionFlowStep[],
  campaignId?: string,
  campaignResultId?: string,
  senderPhone?: string,
  humanHandoff: { enabled?: boolean; text?: string; phone?: string } = {},
): Promise<void> {
  const first = flow.find((step) => step.text.trim());
  if (!first) return;
  await sendDecisionStep(transport, storage, senderJid, flow, first.id, campaignId, campaignResultId, senderPhone, humanHandoff);
}

async function sendDecisionStep(
  transport: WhatsAppTransport,
  storage: Storage,
  senderJid: string,
  flow: DecisionFlowStep[],
  stepId: string,
  campaignId?: string,
  campaignResultId?: string,
  senderPhone?: string,
  humanHandoff: { enabled?: boolean; text?: string; phone?: string } = {},
): Promise<void> {
  const step = flow.find((item) => item.id === stepId);
  if (!step?.text.trim()) return;

  if (step.kind === 'message') {
    await sendBotMessage(transport, senderJid, step.text.trim());
    console.log('   Decision message sent.');
    if (campaignId) {
      storage.recordCampaignEvent({
        campaignId,
        campaignResultId,
        phone: senderPhone,
        type: 'step_sent',
        label: step.text.slice(0, 120),
      });
    }
    if (step.nextStepId) {
      await sendDecisionStep(transport, storage, senderJid, flow, step.nextStepId, campaignId, campaignResultId, senderPhone, humanHandoff);
    } else if (campaignId) {
      storage.recordCampaignEvent({
        campaignId,
        campaignResultId,
        phone: senderPhone,
        type: 'completed',
        label: 'סיום תהליך',
      });
    }
    return;
  }

  const presentation = step.presentation ?? 'buttons';
  let sentInteractive = false;
  if (presentation === 'list' && transport.sendInteractiveList && step.options?.length) {
    try {
      await waitBeforeBotReply();
      await transport.sendInteractiveList(
        senderJid,
        step.text.trim(),
        'בחר/י תשובה',
        step.options.slice(0, 10).map((option) => ({ id: option.id, text: option.text })),
      );
      sentInteractive = true;
    } catch (err) {
      console.warn('   Interactive decision list failed, falling back to text:', err);
    }
  }
  if (presentation === 'buttons' && transport.sendInteractiveButtons && step.options?.length) {
    try {
      await waitBeforeBotReply();
      await transport.sendInteractiveButtons(
        senderJid,
        step.text.trim(),
        step.options.slice(0, 3).map((option) => ({ id: option.id, text: option.text })),
      );
      sentInteractive = true;
    } catch (err) {
      console.warn('   Interactive decision question failed, falling back to text:', err);
    }
  }
  if (!sentInteractive) {
    await sendBotMessage(transport, senderJid, formatQuestion(step));
  }
  console.log('   Decision question sent.');
  if (campaignId) {
    storage.recordCampaignEvent({
      campaignId,
      campaignResultId,
      phone: senderPhone,
      type: 'step_sent',
      label: step.text.slice(0, 120),
    });
  }
  const timeoutMinutes = step.timeoutMinutes && step.timeoutMinutes > 0
    ? step.timeoutMinutes
    : DECISION_REPLY_TIMEOUT_MS / 60_000;
  const timeoutHandle = setTimeout(async () => {
    conversationState.remove(senderJid);
    console.log(`   Decision reply timeout - cleared pending state for ${senderJid}.`);
    await sendDecisionTimeoutAction(transport, storage, senderJid, step, campaignId, campaignResultId, senderPhone);
  }, timeoutMinutes * 60 * 1000);
  conversationState.set(senderJid, {
    kind: 'decision',
    senderJid,
    senderPhone,
    campaignId,
    campaignResultId,
    flow,
    stepId: step.id,
    humanHandoffEnabled: humanHandoff.enabled,
    humanHandoffText: humanHandoff.text,
    humanHandoffPhone: humanHandoff.phone,
    timestamp: Date.now(),
    timeoutHandle,
  });
}

async function sendDecisionTimeoutAction(
  transport: WhatsAppTransport,
  storage: Storage,
  senderJid: string,
  step: DecisionFlowStep,
  campaignId?: string,
  campaignResultId?: string,
  senderPhone?: string,
): Promise<void> {
  const caption = step.timeoutText?.trim();
  if (step.timeoutFileId) {
    await sendDecisionFile(
      transport,
      storage,
      senderJid,
      step.timeoutFileId,
      caption,
      step.timeoutFileAsSticker,
      campaignId,
      campaignResultId,
      senderPhone,
    );
    return;
  }
  if (caption) {
    await sendBotMessage(transport, senderJid, caption);
    console.log('   Decision timeout message sent.');
  }
}

async function sendDecisionFile(
  transport: WhatsAppTransport,
  storage: Storage,
  senderJid: string,
  fileId: string,
  caption?: string,
  asSticker?: boolean,
  campaignId?: string,
  campaignResultId?: string,
  senderPhone?: string,
): Promise<void> {
  const file = storage.getUploadedFile(fileId);
  if (file && transport.sendFile) {
    const canSendAsSticker = Boolean(asSticker && file.mimeType.startsWith('image/'));
    await waitBeforeBotReply();
    await transport.sendFile(senderJid, path.join(config.UPLOADS_PATH, file.filename), caption, { asSticker: canSendAsSticker });
    console.log(canSendAsSticker ? '   Decision sticker sent.' : '   Decision file sent.');
    if (campaignId) {
      storage.recordCampaignEvent({
        campaignId,
        campaignResultId,
        phone: senderPhone,
        type: 'file_sent',
        label: file.originalName,
      });
    }
  } else {
    await sendBotMessage(transport, senderJid, caption || 'הקובץ לא זמין כרגע.');
    console.warn(`   Decision file unavailable: ${fileId}`);
  }
}

function formatQuestion(step: DecisionFlowStep): string {
  const options = (step.options ?? [])
    .map((option: DecisionFlowOption, index) => `${index + 1}. ${option.text}`)
    .join('\n');
  return options ? `${step.text.trim()}\n\n${options}` : step.text.trim();
}

function formatHumanHandoffText(text?: string, phone?: string): string {
  const base = (text || 'אני מענה אוטומטי.\nלשאלות נוספות אפשר לעבור לשיחה אנושית כאן:\n[מעבר ל-WhatsApp]').trim();
  const cleanPhone = String(phone || '').replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (!cleanPhone) return base;
  return `${base}\nhttps://wa.me/${cleanPhone}`;
}
