import { WhatsAppProvider } from '../types/whatsapp';

export class TwilioProvider implements WhatsAppProvider {
  async initialize(): Promise<void> {
    throw new Error('Twilio provider is not implemented yet.');
  }

  async destroy(): Promise<void> {
    // Webhook-based providers do not keep a browser session open.
  }

  async logout(): Promise<void> {
    // Twilio connections are managed from the owner dashboard, not by QR logout.
  }

  async sendMessage(_to: string, _message: string): Promise<void> {
    throw new Error('Twilio message sending is not implemented yet.');
  }

  async sendInteractiveButtons(
    to: string,
    text: string,
    buttons: Array<{ id: string; text: string }>,
  ): Promise<void> {
    const fallback = buttons.length
      ? `${text}\n\n${buttons.map((button, index) => `${index + 1}. ${button.text}`).join('\n')}`
      : text;
    await this.sendMessage(to, fallback);
  }
}
