import { WhatsAppProvider } from '../types/whatsapp';
import { config } from '../config';
import { recordTwilioEvent } from '../twilioEvents';

export class TwilioProvider implements WhatsAppProvider {
  async initialize(): Promise<void> {
    this.assertConfigured();
  }

  async destroy(): Promise<void> {
    // Webhook-based providers do not keep a browser session open.
  }

  async logout(): Promise<void> {
    // Twilio connections are managed from the owner dashboard, not by QR logout.
  }

  async sendMessage(_to: string, _message: string): Promise<void> {
    await this.createMessage({
      To: normalizeWhatsAppAddress(_to),
      Body: _message,
    }, _message);
  }

  async sendContentTemplate(to: string, contentSid: string, contentVariables: Record<string, string> = {}): Promise<void> {
    const cleanSid = contentSid.trim();
    if (!cleanSid) throw new Error('ContentSid is required.');
    await this.createMessage({
      To: normalizeWhatsAppAddress(to),
      ContentSid: cleanSid,
      ContentVariables: Object.keys(contentVariables).length ? JSON.stringify(contentVariables) : undefined,
    }, cleanSid);
  }

  async sendFile(to: string, filePath: string, caption?: string, _options: { asSticker?: boolean } = {}): Promise<void> {
    const baseUrl = config.TWILIO_MEDIA_BASE_URL.trim().replace(/\/$/, '');
    if (!baseUrl) {
      await this.sendMessage(to, caption?.trim() || 'קובץ מוכן לשליחה, אבל כתובת מדיה ציבורית לא מוגדרת במסלול Twilio.');
      return;
    }
    const fileName = filePath.split(/[\\/]/).pop();
    if (!fileName) {
      await this.sendMessage(to, caption?.trim() || 'הקובץ לא זמין כרגע.');
      return;
    }
    await this.createMessage({
      To: normalizeWhatsAppAddress(to),
      Body: caption?.trim() || undefined,
      MediaUrl: `${baseUrl}/${encodeURIComponent(fileName)}`,
    }, caption);
  }

  async sendInteractiveButtons(
    to: string,
    text: string,
    buttons: Array<{ id: string; text: string }>,
  ): Promise<void> {
    const quickReplyButtons = buttons.slice(0, 3);
    if (quickReplyButtons.length) {
      const contentSid = await this.createContentTemplate({
        friendly_name: `flowsbiz_qr_${Date.now()}`,
        language: 'he',
        types: {
          'twilio/text': {
            body: formatNumberedOptions(text, quickReplyButtons),
          },
          'twilio/quick-reply': {
            body: text,
            actions: quickReplyButtons.map((button, index) => ({
              id: String(index + 1),
              title: button.text.slice(0, 20),
            })),
          },
        },
      });
      await this.createMessage({
        To: normalizeWhatsAppAddress(to),
        ContentSid: contentSid,
      }, text);
      return;
    }

    const fallback = buttons.length
      ? formatNumberedOptions(text, buttons)
      : text;
    await this.sendMessage(to, fallback);
  }

  async sendInteractiveList(
    to: string,
    text: string,
    buttonText: string,
    items: Array<{ id: string; text: string }>,
  ): Promise<void> {
    const listItems = items.slice(0, 10);
    if (!listItems.length) {
      await this.sendMessage(to, text);
      return;
    }
    const contentSid = await this.createContentTemplate({
      friendly_name: `flowsbiz_list_${Date.now()}`,
      language: 'he',
      types: {
        'twilio/text': {
          body: formatNumberedOptions(text, listItems),
        },
        'twilio/list-picker': {
          body: text,
          button: buttonText.slice(0, 20),
          items: listItems.map((item, index) => ({
            id: String(index + 1),
            item: item.text.slice(0, 24),
          })),
        },
      },
    });
    await this.createMessage({
      To: normalizeWhatsAppAddress(to),
      ContentSid: contentSid,
    }, text);
  }

  private assertConfigured(): void {
    if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN) {
      throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required for Twilio provider.');
    }
    if (!config.TWILIO_FROM && !config.TWILIO_MESSAGING_SERVICE_SID) {
      throw new Error('TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID is required for Twilio provider.');
    }
  }

  private async createMessage(fields: Record<string, string | undefined>, logBody?: string): Promise<void> {
    this.assertConfigured();
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      if (value) body.set(key, value);
    }
    if (config.TWILIO_MESSAGING_SERVICE_SID) {
      body.set('MessagingServiceSid', config.TWILIO_MESSAGING_SERVICE_SID);
    } else {
      body.set('From', normalizeWhatsAppAddress(config.TWILIO_FROM));
    }

    const auth = Buffer.from(`${config.TWILIO_ACCOUNT_SID}:${config.TWILIO_AUTH_TOKEN}`).toString('base64');
    try {
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.TWILIO_ACCOUNT_SID}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      const responseBody = await response.json().catch(async () => ({ raw: await response.text().catch(() => '') })) as any;
      if (!response.ok) {
        const errorText = JSON.stringify(responseBody).slice(0, 500);
        recordTwilioEvent({
          direction: 'outbound',
          status: 'failed',
          to: fields.To,
          body: logBody,
          details: `Twilio message failed (${response.status}): ${errorText}`,
        });
        throw new Error(`Twilio message failed (${response.status}): ${errorText}`);
      }
      recordTwilioEvent({
        direction: 'outbound',
        status: 'sent',
        from: body.get('From') || body.get('MessagingServiceSid') || undefined,
        to: fields.To,
        body: logBody,
        messageSid: responseBody.sid,
      });
    } catch (err: any) {
      if (!String(err?.message ?? '').startsWith('Twilio message failed')) {
        recordTwilioEvent({
          direction: 'outbound',
          status: 'failed',
          to: fields.To,
          body: logBody,
          details: err?.message ?? String(err),
        });
      }
      throw err;
    }
  }

  private async createContentTemplate(payload: Record<string, unknown>): Promise<string> {
    this.assertConfigured();
    const auth = Buffer.from(`${config.TWILIO_ACCOUNT_SID}:${config.TWILIO_AUTH_TOKEN}`).toString('base64');
    const response = await fetch('https://content.twilio.com/v1/Content', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const responseBody = await response.json().catch(async () => ({ raw: await response.text().catch(() => '') })) as any;
    if (!response.ok || typeof responseBody.sid !== 'string') {
      const errorText = JSON.stringify(responseBody).slice(0, 500);
      throw new Error(`Twilio content template failed (${response.status}): ${errorText}`);
    }
    return responseBody.sid;
  }
}

function normalizeWhatsAppAddress(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('whatsapp:')) return trimmed;
  const phone = trimmed.replace(/[^\d+]/g, '');
  return `whatsapp:${phone.startsWith('+') ? phone : `+${phone}`}`;
}

function formatNumberedOptions(text: string, options: Array<{ text: string }>): string {
  return options.length
    ? `${text}\n\n${options.map((option, index) => `${index + 1}. ${option.text}`).join('\n')}`
    : text;
}
