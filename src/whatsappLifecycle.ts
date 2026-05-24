import { Storage } from './storage';
import { createWhatsAppClient } from './whatsapp';
import { botState } from './botState';

const SCHEDULER_INTERVAL_MS = 60 * 1000;
const CAMPAIGN_START_LEAD_MS = 15 * 60 * 1000;

let scheduler: NodeJS.Timeout | null = null;
let transition: Promise<void> | null = null;

export async function startWhatsAppBot(storage: Storage, reason = 'manual', pairingPhone?: string): Promise<void> {
  if (transition) await transition;
  if (botState.lifecycle === 'running' || botState.lifecycle === 'starting') return;

  transition = (async () => {
    botState.lifecycle = 'starting';
    botState.listeningReason = reason;
    botState.intentionalRestart = false;

    const client = createWhatsAppClient(storage, pairingPhone);
    botState.client = client;
    await client.initialize();
    botState.lifecycle = 'running';
  })();

  try {
    await transition;
  } finally {
    transition = null;
  }
}

export async function stopWhatsAppBot(reason = 'manual'): Promise<void> {
  if (transition) await transition;
  if (!botState.client || botState.lifecycle === 'stopped' || botState.lifecycle === 'stopping') return;

  transition = (async () => {
    botState.lifecycle = 'stopping';
    botState.listeningReason = reason;
    botState.intentionalRestart = true;

    try {
      await botState.client?.destroy();
    } catch (err) {
      console.warn('WhatsApp client destroy failed:', err);
    } finally {
      botState.client = null;
      botState.qrDataUrl = null;
      botState.pairingCode = null;
      botState.pairingAttempted = false;
      botState.authenticated = false;
      botState.ready = false;
      botState.connectedPhone = null;
      botState.lifecycle = 'stopped';
      botState.intentionalRestart = false;
    }
  })();

  try {
    await transition;
  } finally {
    transition = null;
  }
}

export function startWhatsAppScheduler(storage: Storage): void {
  if (scheduler) return;

  const tick = () => {
    const shouldRun = storage.hasCampaignsNeedingBot(new Date(), CAMPAIGN_START_LEAD_MS);
    if (shouldRun) {
      startWhatsAppBot(storage, 'scheduled campaign window').catch((err) =>
        console.error('Scheduled WhatsApp start failed:', err),
      );
    } else {
      stopWhatsAppBot('no active campaign window').catch((err) =>
        console.error('Scheduled WhatsApp stop failed:', err),
      );
    }
  };

  tick();
  scheduler = setInterval(tick, SCHEDULER_INTERVAL_MS);
}

