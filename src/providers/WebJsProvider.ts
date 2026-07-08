import { Client, MessageMedia } from 'whatsapp-web.js';
import { Storage } from '../storage';
import { WhatsAppProvider } from '../types/whatsapp';
import { createWhatsAppClient } from '../whatsapp';

export class WebJsProvider implements WhatsAppProvider {
  readonly client: Client;

  constructor(storage: Storage, pairingPhone?: string) {
    this.client = createWhatsAppClient(storage, pairingPhone);
  }

  async initialize(): Promise<void> {
    await this.client.initialize();
  }

  async destroy(): Promise<void> {
    await this.client.destroy();
  }

  async logout(): Promise<void> {
    await this.client.logout();
  }

  async sendMessage(to: string, message: string): Promise<void> {
    await this.client.sendMessage(to, message);
  }

  async sendFile(to: string, filePath: string, caption?: string, options: { asSticker?: boolean } = {}): Promise<void> {
    const media = MessageMedia.fromFilePath(filePath);
    await this.client.sendMessage(to, media, {
      ...(caption?.trim() && !options.asSticker ? { caption: caption.trim() } : {}),
      ...(options.asSticker ? { sendMediaAsSticker: true } : {}),
    });
  }

  async sendContactCard(to: string, vcard: string, _displayName: string): Promise<void> {
    await this.client.sendMessage(to, vcard, { parseVCards: true, linkPreview: false } as any);
  }

  async sendContactCards(to: string, contacts: Array<{ vcard: string; displayName: string }>, _displayName: string): Promise<void> {
    throw new Error('WebJS multi-contact native send is not reliable; use combined VCF fallback.');
  }

  async sendInteractiveButtons(
    to: string,
    text: string,
    buttons: Array<{ id: string; text: string }>,
  ): Promise<void> {
    const buttonText = buttons.length
      ? `${text}\n\n${buttons.map((button, index) => `${index + 1}. ${button.text}`).join('\n')}`
      : text;
    await this.sendMessage(to, buttonText);
  }

  async sendInteractiveList(
    to: string,
    text: string,
    _buttonText: string,
    items: Array<{ id: string; text: string }>,
  ): Promise<void> {
    const listText = items.length
      ? `${text}\n\n${items.map((item, index) => `${index + 1}. ${item.text}`).join('\n')}`
      : text;
    await this.sendMessage(to, listText);
  }
}

export function createWebJsProvider(storage: Storage, pairingPhone?: string): WebJsProvider {
  return new WebJsProvider(storage, pairingPhone);
}
