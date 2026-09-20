import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { metaApiAlert, notifyClientSystemAlert } from '../systemAlerts';
import { IncomingWhatsAppMessage, InteractiveListItem, WhatsAppProvider, WhatsAppSendResult } from '../types/whatsapp';
import { attemptTaggingEnabled, currentSendAttempt } from '../sendAttempt';
import { ProviderSendError, classifyHttpStatus, classifySendError, parseRetryAfterMs } from '../sendOutcome';

type MetaMessage = Record<string, unknown>;
type CachedMetaMedia = { id: string; expiresAt: number };

const META_MEDIA_CACHE_MS = 29 * 24 * 60 * 60 * 1000;

/**
 * Explicit time budgets for Graph API calls (stage B). They cover the whole request including
 * reading the response body. Timing out a message POST is an UNKNOWN outcome (the request may
 * have been accepted) and is classified `uncertain` - see sendOutcome.ts. Configurable and bounded.
 */
function budgetMs(envName: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[envName]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
export const metaSendTimeoutMs = (): number => budgetMs('META_SEND_TIMEOUT_MS', 15_000, 1_000, 120_000);
export const metaMediaUploadTimeoutMs = (): number => budgetMs('META_MEDIA_UPLOAD_TIMEOUT_MS', 60_000, 1_000, 300_000);
const metaMediaCache = new Map<string, CachedMetaMedia>();
const metaMediaUploads = new Map<string, Promise<string>>();

export class MetaCloudProvider implements WhatsAppProvider {
  async initialize(): Promise<void> { this.assertConfigured(); }
  async destroy(): Promise<void> {}
  async logout(): Promise<void> {}
  async resolvePhone(jid: string): Promise<string> { return normalizePhone(jid); }

  async sendMessage(to: string, message: string): Promise<WhatsAppSendResult> {
    return await this.postMessages({ messaging_product: 'whatsapp', to: normalizePhone(to), type: 'text', text: { body: message } });
  }

  async sendTemplateMessage(to: string, templateName: string, languageCode: string, bodyParameters: string[] = []): Promise<WhatsAppSendResult> {
    const template: Record<string, unknown> = { name: templateName, language: { code: languageCode || 'he' } };
    if (bodyParameters.length) template.components = [{ type: 'body', parameters: bodyParameters.map((text) => ({ type: 'text', text })) }];
    return await this.postMessages({ messaging_product: 'whatsapp', to: normalizePhone(to), type: 'template', template });
  }

  async sendFile(to: string, filePath: string, caption?: string, options: { asSticker?: boolean } = {}): Promise<WhatsAppSendResult> {
    this.assertConfigured();
    const fileName = path.basename(filePath);
    const mimeType = mimeTypeForFile(fileName);
    const recipient = normalizePhone(to);
    const type = mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : 'document';
    const cacheKey = metaMediaCacheKey(filePath);
    const cached = getCachedMetaMedia(cacheKey);
    let mediaId = cached?.id || await this.uploadAndCacheMedia(cacheKey, filePath, mimeType, fileName);
    const send = async (): Promise<WhatsAppSendResult> => {
      if (options.asSticker && mimeType === 'image/webp') {
        return await this.postMessages({ messaging_product: 'whatsapp', to: recipient, type: 'sticker', sticker: { id: mediaId } });
      }
      const media: Record<string, string> = { id: mediaId };
      if (caption && (type === 'image' || type === 'video' || type === 'document')) media.caption = caption;
      if (type === 'document') media.filename = fileName;
      return await this.postMessages({ messaging_product: 'whatsapp', to: recipient, type, [type]: media });
    };
    try {
      return await send();
    } catch (err) {
      if (!cached) throw err;
      // A stale cached media id is a provider REJECTION. If the first send's outcome is unknown
      // (timeout / dropped connection) it may already have been delivered: re-uploading and
      // sending again would duplicate it.
      if (classifySendError(err).outcome === 'uncertain') throw err;
      metaMediaCache.delete(cacheKey);
      mediaId = await this.uploadAndCacheMedia(cacheKey, filePath, mimeType, fileName);
      return await send();
    }
  }

  async sendContactCard(to: string, vcard: string, displayName: string): Promise<WhatsAppSendResult> {
    return await this.sendContactCards(to, [{ vcard, displayName }], displayName);
  }

  async sendContactCards(to: string, contacts: Array<{ vcard: string; displayName: string }>, _displayName: string): Promise<WhatsAppSendResult> {
    const parsed = contacts.slice(0, 2).map((contact) => buildMetaContactFromVCard(contact.vcard, contact.displayName)).filter(Boolean);
    if (!parsed.length) return {};
    console.log('[META_CONTACTS_SEND] count=' + parsed.length);
    return await this.postMessages({ messaging_product: 'whatsapp', to: normalizePhone(to), type: 'contacts', contacts: parsed });
  }

  async sendInteractiveButtons(to: string, text: string, buttons: Array<{ id: string; text: string }>): Promise<WhatsAppSendResult> {
    return await this.postMessages({
      messaging_product: 'whatsapp', to: normalizePhone(to), type: 'interactive',
      interactive: {
        type: 'button', body: { text },
        action: { buttons: buttons.slice(0, 3).map((button, index) => ({ type: 'reply', reply: { id: button.id || String(index + 1), title: button.text.slice(0, 20) } })) },
      },
    });
  }

  async sendInteractiveList(to: string, text: string, buttonText: string, items: InteractiveListItem[]): Promise<WhatsAppSendResult> {
    return await this.postMessages({
      messaging_product: 'whatsapp', to: normalizePhone(to), type: 'interactive',
      interactive: {
        type: 'list', body: { text },
        action: {
          button: buttonText.slice(0, 20),
          sections: [{
            title: 'Options',
            rows: items.slice(0, 10).map((item, index) => ({
              id: item.id || String(index + 1),
              title: item.text.slice(0, 24),
              ...(item.description ? { description: item.description.slice(0, 72) } : {}),
            })),
          }],
        },
      },
    });
  }

  async markRead(message: IncomingWhatsAppMessage): Promise<void> {
    if (message.id) await this.postMessages({ messaging_product: 'whatsapp', status: 'read', message_id: message.id });
  }

  async showTypingIndicator(message: IncomingWhatsAppMessage): Promise<void> {
    if (message.id) {
      await this.postMessages({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: message.id,
        typing_indicator: { type: 'text' },
      });
    }
  }

  private assertConfigured(): void {
    if (!config.META_ACCESS_TOKEN || !config.META_PHONE_NUMBER_ID) {
      throw new Error('META_ACCESS_TOKEN and META_PHONE_NUMBER_ID are required for Meta Cloud API.');
    }
  }

  private graphUrl(resource: string): string {
    return 'https://graph.facebook.com/' + config.META_GRAPH_API_VERSION + '/' + config.META_PHONE_NUMBER_ID + '/' + resource;
  }

  private async uploadMedia(filePath: string, mimeType: string, fileName: string): Promise<string> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', new Blob([fs.readFileSync(filePath)], { type: mimeType }), fileName);
    let response: Response;
    try {
      response = await fetch(this.graphUrl('media'), { method: 'POST', headers: { Authorization: 'Bearer ' + config.META_ACCESS_TOKEN }, body: form, signal: AbortSignal.timeout(metaMediaUploadTimeoutMs()) });
    } catch (err) {
      // An upload never sends a message to the recipient, so any transport failure here is safe to retry.
      throw new ProviderSendError('Meta media upload transport failure: ' + describeFetchError(err), 'rejected_transient', { cause: err });
    }
    const body = await response.json().catch(() => ({})) as any;
    if (!response.ok || typeof body.id !== 'string') {
      notifyClientSystemAlert(metaApiAlert(response.status, body, 'media_upload'));
      const outcome = classifyHttpStatus(response.status);
      throw new ProviderSendError(
        'Meta media upload failed (' + response.status + '): ' + JSON.stringify(body).slice(0, 500),
        outcome === 'uncertain' ? 'rejected_transient' : outcome,
        { status: response.status, retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')) },
      );
    }
    return body.id;
  }

  private async uploadAndCacheMedia(cacheKey: string, filePath: string, mimeType: string, fileName: string): Promise<string> {
    const pending = metaMediaUploads.get(cacheKey);
    if (pending) return await pending;
    const upload = this.uploadMedia(filePath, mimeType, fileName).then((id) => {
      if (metaMediaCache.size >= 500) metaMediaCache.delete(metaMediaCache.keys().next().value as string);
      metaMediaCache.set(cacheKey, { id, expiresAt: Date.now() + META_MEDIA_CACHE_MS });
      return id;
    }).finally(() => {
      metaMediaUploads.delete(cacheKey);
    });
    metaMediaUploads.set(cacheKey, upload);
    return await upload;
  }

  private async postMessages(originalPayload: MetaMessage): Promise<WhatsAppSendResult> {
    this.assertConfigured();
    // Tag a real message send (it has a recipient) with our attempt id so Meta echoes it back in the status
    // webhook. read receipts / typing indicators have no message id and are never tagged.
    // OFF by default: the field is documented on the status-webhook side but not verified on the send side, and an unsupported
    // field would be a 400 for that message type. Enable explicitly per client (its own env) with META_ATTEMPT_CALLBACK_DATA=on.
    const attempt = typeof originalPayload.to === 'string' && attemptTaggingEnabled() ? currentSendAttempt() : undefined;
    const payload: MetaMessage = attempt ? { ...originalPayload, biz_opaque_callback_data: attempt.attemptId } : originalPayload;
    let response: Response;
    try {
      response = await fetch(this.graphUrl('messages'), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + config.META_ACCESS_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(metaSendTimeoutMs()),
      });
    } catch (err) {
      // No HTTP response. Only a connection that was never established proves nothing was accepted;
      // any other failure (reset, abort, timeout) may have happened after Meta accepted the request.
      const outcome = classifySendError(err);
      throw new ProviderSendError(
        'Meta message request failed without a response: ' + describeFetchError(err),
        outcome.classified ? outcome.outcome : 'uncertain',
        { cause: err },
      );
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      notifyClientSystemAlert(metaApiAlert(response.status, body, String(payload.type || payload.status || 'messages')));
      throw new ProviderSendError(
        'Meta message failed (' + response.status + '): ' + JSON.stringify(body).slice(0, 500),
        classifyHttpStatus(response.status),
        { status: response.status, retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')) },
      );
    }
    const messageId = Array.isArray((body as any).messages) ? (body as any).messages[0]?.id : undefined;
    return typeof messageId === 'string' ? { messageId } : {};
  }
}

function describeFetchError(err: unknown): string {
  const anyErr = err as { message?: string; cause?: { code?: string; message?: string } };
  return [anyErr?.message, anyErr?.cause?.code || anyErr?.cause?.message].filter(Boolean).join(' / ') || String(err);
}

function metaMediaCacheKey(filePath: string): string {
  const stat = fs.statSync(filePath);
  return `${config.META_PHONE_NUMBER_ID}:${path.resolve(filePath)}:${stat.size}:${stat.mtimeMs}`;
}

function getCachedMetaMedia(key: string): CachedMetaMedia | undefined {
  const cached = metaMediaCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    metaMediaCache.delete(key);
    return undefined;
  }
  return cached;
}

function normalizePhone(value: string): string {
  return value.trim().replace(/^whatsapp:/i, '').replace(/^\+/, '').split('@')[0].replace(/\D/g, '');
}

function mimeTypeForFile(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.3gp': 'video/3gpp', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.pdf': 'application/pdf', '.vcf': 'text/vcard' } as Record<string, string>)[ext] || 'application/octet-stream';
}

export function buildMetaContactFromVCard(vcard: string, fallbackName: string): Record<string, unknown> | null {
  const name = (vcard.match(/^FN(?:;[^:]*)?:(.*)$/mi)?.[1] || fallbackName || 'Contact').trim();
  const phone = (vcard.match(/^TEL(?:;[^:]*)?:(.*)$/mi)?.[1] || '').trim();
  const email = (vcard.match(/^EMAIL(?:;[^:]*)?:(.*)$/mi)?.[1] || '').trim();
  const organization = (vcard.match(/^ORG(?:;[^:]*)?:(.*)$/mi)?.[1] || '').trim();
  if (!phone && !email && !name) return null;
  const contact: Record<string, unknown> = { name: { formatted_name: name, first_name: name } };
  if (phone) {
    const waId = normalizeContactWaId(phone);
    contact.phones = [{ phone, type: 'CELL', ...(waId ? { wa_id: waId } : {}) }];
  }
  if (email) contact.emails = [{ email, type: 'WORK' }];
  if (organization) contact.org = { company: organization };
  return contact;
}

function normalizeContactWaId(value: string): string {
  const clean = value.trim().replace(/^whatsapp:/i, '').split('@')[0];
  let digits = clean.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length >= 9) digits = '972' + digits.slice(1);
  return digits;
}
