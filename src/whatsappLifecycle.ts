import { Storage } from './storage';
import { botState } from './botState';
import { config } from './config';
import { createBaileysProvider } from './providers/BaileysProvider';
import { createWebJsProvider } from './providers/WebJsProvider';
import { WhatsAppProvider } from './types/whatsapp';

const SCHEDULER_INTERVAL_MS = 60 * 1000;
const CAMPAIGN_START_LEAD_MS = 15 * 60 * 1000;

let scheduler: NodeJS.Timeout | null = null;
let transition: Promise<void> | null = null;

function createProvider(storage: Storage, pairingPhone?: string): WhatsAppProvider {
  if (config.WHATSAPP_PROVIDER === 'BAILEYS') {
    return createBaileysProvider(storage, pairingPhone);
  }
  return createWebJsProvider(storage, pairingPhone);
}

export async function startWhatsAppBot(storage: Storage, reason = 'manual', pairingPhone?: string): Promise<void> {
  if (transition) await transition;
  if (botState.lifecycle === 'running' || botState.lifecycle === 'starting') return;

  transition = (async () => {
    console.log(`WhatsApp client starting: ${reason}.`);
    botState.lifecycle = 'starting';
    botState.listeningReason = reason;
    botState.intentionalRestart = false;

    const provider = createProvider(storage, pairingPhone);
    botState.client = provider;
    await provider.initialize();
    botState.lifecycle = 'running';
    console.log(`WhatsApp client start requested: ${reason}.`);
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
    console.log(`WhatsApp client stopping: ${reason}.`);
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
      console.log(`WhatsApp client stopped: ${reason}.`);
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
      if (botState.lifecycle === 'stopped') {
        console.log('Scheduled campaign window found - starting WhatsApp client.');
      }
      startWhatsAppBot(storage, 'scheduled campaign window').catch((err) =>
        console.error('Scheduled WhatsApp start failed:', err),
      );
    } else {
      if (botState.lifecycle === 'running') {
        console.log('No active campaign window - stopping WhatsApp client.');
      }
      stopWhatsAppBot('no active campaign window').catch((err) =>
        console.error('Scheduled WhatsApp stop failed:', err),
      );
    }
  };

  tick();
  scheduler = setInterval(tick, SCHEDULER_INTERVAL_MS);
}
