import { Storage, OutboxMessage } from './storage';
import { WhatsAppSendResult, WhatsAppTransport } from './types/whatsapp';

type TransportResolver = () => WhatsAppTransport | null | undefined;

const OUTBOX_POLL_MS = 15_000;
const OUTBOX_RETRY_MS = 60_000;
const OUTBOX_MAX_ATTEMPTS = 3;

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

  storage.markOutboxProcessing(message.id);
  await storage.flush();
  try {
    const result = message.kind === 'file'
      ? await sendOutboxFile(transport, message)
      : await transport.sendMessage(message.to, message.text || '');
    storage.markOutboxSent(message.id, providerMessageId(result));
    await storage.flush();
  } catch (err) {
    if (message.attempts + 1 >= OUTBOX_MAX_ATTEMPTS) storage.markOutboxFailed(message.id, err);
    else storage.markOutboxRetry(message.id, err, nextRetryIso());
    await storage.flush();
  }
}

async function sendOutboxFile(transport: WhatsAppTransport, message: OutboxMessage): Promise<void | WhatsAppSendResult> {
  if (!transport.sendFile) throw new Error('WhatsApp transport does not support files.');
  if (!message.filePath) throw new Error('Outbox file message is missing filePath.');
  return await transport.sendFile(message.to, message.filePath, message.caption, message.fileOptions);
}

export function startOutboxDispatcher(storage: Storage, getTransport: TransportResolver, intervalMs = OUTBOX_POLL_MS): NodeJS.Timeout {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const transport = getTransport();
      if (!transport) return;
      const pending = storage.getPendingOutboxMessages(20);
      for (const message of pending) {
        await dispatchMessage(storage, transport, message);
      }
    } catch (err) {
      console.warn('Outbox dispatcher failed:', err);
    } finally {
      running = false;
    }
  };
  const handle = setInterval(() => { void tick(); }, intervalMs);
  void tick();
  return handle;
}