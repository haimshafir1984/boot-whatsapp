import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { IncomingWhatsAppMessage, WhatsAppProvider } from '../types/whatsapp';

type MetaMessage = Record<string, unknown>;

export class MetaCloudProvider implements WhatsAppProvider {
  async initialize(): Promise<void> { this.assertConfigured(); }
  async destroy(): Promise<void> {}
  async logout(): Promise<void> {}
  async resolvePhone(jid: string): Promise<string> { return normalizePhone(jid); }

  async sendMessage(to: string, message: string): Promise<void> {
    await this.postMessages({ messaging_product: 'whatsapp', to: normalizePhone(to), type: 'text', text: { body: message } });
  }

  async sendFile(to: string, filePath: string, caption?: string, options: { asSticker?: boolean } = {}): Promise<void> {
    this.assertConfigured();
    const fileName = path.basename(filePath);
    const mimeType = mimeTypeForFile(fileName);
    const mediaId = await this.uploadMedia(filePath, mimeType, fileName);
    const recipient = normalizePhone(to);
    if (options.asSticker && mimeType === 'image/webp') {
      await this.postMessages({ messaging_product: 'whatsapp', to: recipient, type: 'sticker', sticker: { id: mediaId } });
      return;
    }
    const type = mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : 'document';
    const media: Record<string, string> = { id: mediaId };
    if (caption && (type === 'image' || type === 'video' || type === 'document')) media.caption = caption;
    if (type === 'document') media.filename = fileName;
    await this.postMessages({ messaging_product: 'whatsapp', to: recipient, type, [type]: media });
  }

  async sendContactCard(to: string, vcard: string, displayName: string): Promise<void> {
    await this.sendContactCards(to, [{ vcard, displayName }], displayName);
  }

  async sendContactCards(to: string, contacts: Array<{ vcard: string; displayName: string }>, _displayName: string): Promise<void> {
    const parsed = contacts.slice(0, 2).map((contact) => parseVCard(contact.vcard, contact.displayName)).filter(Boolean);
    if (!parsed.length) return;
    await this.postMessages({ messaging_product: 'whatsapp', to: normalizePhone(to), type: 'contacts', contacts: parsed });
  }

  async sendInteractiveButtons(to: string, text: string, buttons: Array<{ id: string; text: string }>): Promise<void> {
    await this.postMessages({
      messaging_product: 'whatsapp', to: normalizePhone(to), type: 'interactive',
      interactive: {
        type: 'button', body: { text },
        action: { buttons: buttons.slice(0, 3).map((button, index) => ({ type: 'reply', reply: { id: button.id || String(index + 1), title: button.text.slice(0, 20) } })) },
      },
    });
  }

  async sendInteractiveList(to: string, text: string, buttonText: string, items: Array<{ id: string; text: string }>): Promise<void> {
    await this.postMessages({
      messaging_product: 'whatsapp', to: normalizePhone(to), type: 'interactive',
      interactive: {
        type: 'list', body: { text },
        action: { button: buttonText.slice(0, 20), sections: [{ title: 'Options', rows: items.slice(0, 10).map((item, index) => ({ id: item.id || String(index + 1), title: item.text.slice(0, 24) })) }] },
      },
    });
  }

  async markRead(message: IncomingWhatsAppMessage): Promise<void> {
    if (message.id) await this.postMessages({ messaging_product: 'whatsapp', status: 'read', message_id: message.id });
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
    const response = await fetch(this.graphUrl('media'), { method: 'POST', headers: { Authorization: 'Bearer ' + config.META_ACCESS_TOKEN }, body: form });
    const body = await response.json().catch(() => ({})) as any;
    if (!response.ok || typeof body.id !== 'string') throw new Error('Meta media upload failed (' + response.status + '): ' + JSON.stringify(body).slice(0, 500));
    return body.id;
  }

  private async postMessages(payload: MetaMessage): Promise<void> {
    this.assertConfigured();
    const response = await fetch(this.graphUrl('messages'), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + config.META_ACCESS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error('Meta message failed (' + response.status + '): ' + JSON.stringify(body).slice(0, 500));
  }
}

function normalizePhone(value: string): string {
  return value.trim().replace(/^whatsapp:/i, '').replace(/^\+/, '').split('@')[0].replace(/\D/g, '');
}

function mimeTypeForFile(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.3gp': 'video/3gpp', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.pdf': 'application/pdf', '.vcf': 'text/vcard' } as Record<string, string>)[ext] || 'application/octet-stream';
}

function parseVCard(vcard: string, fallbackName: string): Record<string, unknown> | null {
  const name = (vcard.match(/^FN(?:;[^:]*)?:(.*)$/mi)?.[1] || fallbackName || 'Contact').trim();
  const phone = (vcard.match(/^TEL(?:;[^:]*)?:(.*)$/mi)?.[1] || '').trim();
  const email = (vcard.match(/^EMAIL(?:;[^:]*)?:(.*)$/mi)?.[1] || '').trim();
  const organization = (vcard.match(/^ORG(?:;[^:]*)?:(.*)$/mi)?.[1] || '').trim();
  if (!phone && !email && !name) return null;
  const contact: Record<string, unknown> = { name: { formatted_name: name, first_name: name } };
  if (phone) contact.phones = [{ phone, type: 'CELL' }];
  if (email) contact.emails = [{ email, type: 'WORK' }];
  if (organization) contact.org = { company: organization };
  return contact;
}
