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

type ProviderRuntime = {
  name: 'WEB_JS' | 'BAILEYS';
  provider: WhatsAppProvider;
};

function createProvider(storage: Storage, pairingPhone?: string, providerName = config.WHATSAPP_PROVIDER): ProviderRuntime {
  if (providerName === 'BAILEYS') {
    return { name: 'BAILEYS', provider: createBaileysProvider(storage, pairingPhone) };
  }
  return { name: 'WEB_JS', provider: createWebJsProvider(storage, pairingPhone) };
}

async function initializeProvider(runtime: ProviderRuntime): Promise<WhatsAppProvider> {
  botState.actualProvider = runtime.name;
  botState.client = runtime.provider;
  await runtime.provider.initialize();
  return runtime.provider;
}

export async function startWhatsAppBot(storage: Storage, reason = 'manual', pairingPhone?: string): Promise<void> {
  if (transition) await transition;
  if (botState.lifecycle === 'running' || botState.lifecycle === 'starting') return;

  transition = (async () => {
    console.log(`WhatsApp client starting: ${reason}.`);
    botState.lifecycle = 'starting';
    botState.listeningReason = reason;
    botState.intentionalRestart = false;
    botState.requestedProvider = config.WHATSAPP_PROVIDER;
    botState.actualProvider = null;
    botState.providerFallbackReason = null;

    const runtime = createProvider(storage, pairingPhone);
    try {
      await initializeProvider(runtime);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const canFallback = runtime.name === 'BAILEYS' && process.env.BAILEYS_FALLBACK_TO_WEBJS !== 'false';
      if (!canFallback) throw err;

      console.warn(`Baileys provider failed during startup; falling back to WEB_JS: ${message}`);
      botState.providerFallbackReason = message;
      try {
        await runtime.provider.destroy();
      } catch {
        // Best effort cleanup before starting the fallback provider.
      }
      await initializeProvider(createProvider(storage, pairingPhone, 'WEB_JS'));
    }
    botState.lifecycle = 'running';
    console.log(`WhatsApp client start requested: ${reason}. provider=${botState.actualProvider ?? 'unknown'}`);
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
      botState.actualProvider = null;
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
    if (config.WHATSAPP_KEEP_CONNECTED) {
      if (botState.lifecycle === 'stopped') {
        console.log('WhatsApp keep-connected mode is enabled - starting client.');
      }
      startWhatsAppBot(storage, 'keep connected').catch((err) =>
        console.error('Keep-connected WhatsApp start failed:', err),
      );
      return;
    }

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
