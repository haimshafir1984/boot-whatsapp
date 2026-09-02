import { Storage, OutboxMessage } from './storage';
import { WhatsAppSendResult, WhatsAppTransport } from './types/whatsapp';

type TransportResolver = () => WhatsAppTransport | null | undefined;

const OUTBOX_POLL_MS = 15_000;
const OUTBOX_RETRY_MS = 60_000;
const OUTBOX_MAX_ATTEMPTS = 3;
const OUTBOX_MAX_MESSAGES_PER_TICK = 100;

function providerMessageId(result: void | WhatsAppSendResult): string | undefined {
  return result && typeof result === 'object' && typeof result.messageId === 'string'
    ? result.messageId
    : undefined;
}

function nextRetryIso(): string {
  return new Date(Date.now() + OUTBOX_RETRY_MS).toISOString();
}

async function dispatchMessage(storage: Storage, transport: WhatsAppTransport, message: OutboxMessage): Promise<void> {
  if (message.attempts >= OUTBOX_MAX_ATTEMPTS) {
    storage.markOutboxFailed(message.id, message.lastError || 'Outbox retry limit reached.');
    await storage.flush();
    return;
  }

  const claimed = storage.claimOutboxMessage(message.id);
  if (!claimed) return;
  await storage.flush();
  try {
    const result = await sendOutboxMessage(transport, claimed);
    storage.markOutboxSent(claimed.id, providerMessageId(result));
    await storage.flush();
  } catch (err) {
    if (claimed.attempts >= OUTBOX_MAX_ATTEMPTS) storage.markOutboxFailed(claimed.id, err);
    else storage.markOutboxRetry(claimed.id, err, nextRetryIso());
    await storage.flush();
  }
}

async function sendOutboxMessage(transport: WhatsAppTransport, message: OutboxMessage): Promise<void | WhatsAppSendResult> {
  switch (message.kind) {
    case 'file':
      return await sendOutboxFile(transport, message);
    case 'interactive_buttons':
      if (!transport.sendInteractiveButtons) throw new Error('WhatsApp transport does not support interactive buttons.');
      return await transport.sendInteractiveButtons(message.to, message.text || '', message.buttons ?? []);
    case 'interactive_list':
      if (!transport.sendInteractiveList) throw new Error('WhatsApp transport does not support interactive lists.');
      return await transport.sendInteractiveList(message.to, message.text || '', message.buttonText || '', message.items ?? []);
    case 'contacts':
      if (transport.sendContactCards) {
        return await transport.sendContactCards(message.to, message.contacts ?? [], message.displayName || '');
      }
      if (transport.sendContactCard && message.contacts?.length === 1) {
        const contact = message.contacts[0];
        return await transport.sendContactCard(message.to, contact.vcard, contact.displayName);
      }
      throw new Error('WhatsApp transport does not support contact cards.');
    case 'template':
      if (!transport.sendTemplateMessage) throw new Error('WhatsApp transport does not support Meta templates.');
      return await transport.sendTemplateMessage(
        message.to,
        message.templateName || '',
        message.templateLanguageCode || 'he',
        message.templateBodyParameters ?? [],
      );
    case 'text':
    default:
      return await transport.sendMessage(message.to, message.text || '');
  }
}

async function sendOutboxFile(transport: WhatsAppTransport, message: OutboxMessage): Promise<void | WhatsAppSendResult> {
  if (!transport.sendFile) throw new Error('WhatsApp transport does not support files.');
  if (!message.filePath) throw new Error('Outbox file message is missing filePath.');
  return await transport.sendFile(message.to, message.filePath, message.caption, message.fileOptions);
}

export function startOutboxDispatcher(
  storage: Storage,
  getTransport: TransportResolver,
  intervalMs = OUTBOX_POLL_MS,
): { stop: () => Promise<void> } {
  let stopping = false;
  let inFlight: Promise<void> | null = null;

  const tick = async () => {
    try {
      const transport = getTransport();
      if (!transport) return;
      let processed = 0;
      while (processed < OUTBOX_MAX_MESSAGES_PER_TICK) {
        if (stopping) break;
        // Storage returns at most the head message for each recipient. Process
        // different recipients in parallel, then ask again so the next message
        // for a recipient starts only after its predecessor completed.
        const pending = storage.getPendingOutboxMessages(
          Math.min(20, OUTBOX_MAX_MESSAGES_PER_TICK - processed),
        );
        if (!pending.length) break;
        await Promise.all(pending.map((message) => dispatchMessage(storage, transport, message)));
        processed += pending.length;
      }
    } catch (err) {
      console.warn('Outbox dispatcher failed:', err);
    }
  };

  const runTick = (): Promise<void> => {
    if (inFlight || stopping) return inFlight ?? Promise.resolve();
    inFlight = tick().finally(() => { inFlight = null; });
    return inFlight;
  };

  const handle = setInterval(() => { void runTick(); }, intervalMs);
  void runTick();

  return {
    stop: async () => {
      stopping = true;
      clearInterval(handle);
      // Wait for whatever tick is mid-flight so no dispatchMessage() write races
      // storage.close().
      await (inFlight ?? Promise.resolve());
    },
  };
}
