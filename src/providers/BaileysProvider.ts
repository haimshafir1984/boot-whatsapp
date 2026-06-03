import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import { config } from '../config';
import { botState } from '../botState';
import { handleIncomingWhatsAppMessage } from '../messageFlow';
import { Storage } from '../storage';
import { IncomingWhatsAppMessage, WhatsAppProvider, WhatsAppTransport } from '../types/whatsapp';

type BaileysModule = typeof import('@whiskeysockets/baileys');
type BaileysSocket = ReturnType<BaileysModule['makeWASocket']>;
type BaileysMessage = NonNullable<Parameters<Parameters<BaileysSocket['ev']['on']>[1]>[0]> extends infer T
  ? T
  : any;

const RECONNECT_DELAY_MS = 10_000;

function authPath(): string {
  return path.join(config.SESSION_PATH, 'baileys');
}

function jidToPhone(jid: string): string {
  return jid.split('@')[0]?.split(':')[0] ?? jid;
}

function isPhoneJid(jid?: string | null): boolean {
  return Boolean(jid && jid.includes('@s.whatsapp.net'));
}

function pickSenderPhone(raw: any): string | undefined {
  const key = raw?.key ?? {};
  const candidates = [
    key.remoteJidAlt,
    key.participantAlt,
    key.remoteJid,
    key.participant,
  ];
  const phoneJid = candidates.find((jid) => isPhoneJid(jid));
  return phoneJid ? jidToPhone(phoneJid) : undefined;
}

function normalizeJid(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes('@')) return trimmed;
  const phone = trimmed.replace(/[^\d]/g, '');
  return `${phone}@s.whatsapp.net`;
}

function getMessageText(message: any): string {
  const content = message?.message;
  if (!content) return '';
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    ''
  );
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.mp4') return 'video/mp4';
  return 'application/octet-stream';
}

export class BaileysProvider implements WhatsAppProvider {
  private socket: BaileysSocket | null = null;
  private saveCreds: (() => Promise<void>) | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private intentionalClose = false;
  private readonly storage: Storage;
  private readonly pairingPhone?: string;

  constructor(storage: Storage, pairingPhone?: string) {
    this.storage = storage;
    this.pairingPhone = pairingPhone;
  }

  async initialize(): Promise<void> {
    this.intentionalClose = false;
    const baileys = await import('@whiskeysockets/baileys');
    const pino = (await import('pino')).default;
    const { state, saveCreds } = await baileys.useMultiFileAuthState(authPath());
    const { version } = await baileys.fetchLatestBaileysVersion();

    this.saveCreds = saveCreds;
    this.socket = baileys.makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      version,
      browser: ['FlowsBiz', 'Chrome', '1.0.0'],
    });

    this.socket.ev.on('creds.update', saveCreds);
    this.socket.ev.on('connection.update', async (update: any) => {
      await this.handleConnectionUpdate(baileys, update);
    });
    this.socket.ev.on('messages.upsert', async (event: any) => {
      await this.handleMessages(event.messages ?? []);
    });

    if (this.pairingPhone) {
      setTimeout(() => {
        void this.requestPairingCode(this.pairingPhone!);
      }, 2_000);
    }
  }

  async destroy(): Promise<void> {
    this.intentionalClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket) {
      this.socket.end(undefined);
      this.socket = null;
    }
  }

  async logout(): Promise<void> {
    this.intentionalClose = true;
    if (this.socket) {
      await this.socket.logout();
    }
    await this.destroy();
  }

  async sendMessage(to: string, message: string): Promise<void> {
    this.assertReady();
    await this.socket!.sendMessage(normalizeJid(to), { text: message });
  }

  async sendFile(to: string, filePath: string, caption?: string, options: { asSticker?: boolean } = {}): Promise<void> {
    this.assertReady();
    const jid = normalizeJid(to);
    const buffer = fs.readFileSync(filePath);
    const mimeType = getMimeType(filePath);

    if (options.asSticker && mimeType.startsWith('image/')) {
      await this.socket!.sendMessage(jid, { sticker: buffer });
      return;
    }
    if (mimeType.startsWith('image/')) {
      await this.socket!.sendMessage(jid, { image: buffer, caption: caption?.trim() || undefined });
      return;
    }
    if (mimeType.startsWith('video/')) {
      await this.socket!.sendMessage(jid, { video: buffer, caption: caption?.trim() || undefined, mimetype: mimeType });
      return;
    }
    await this.socket!.sendMessage(jid, {
      document: buffer,
      fileName: path.basename(filePath),
      mimetype: mimeType,
      caption: caption?.trim() || undefined,
    });
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

  private async handleConnectionUpdate(baileys: BaileysModule, update: any): Promise<void> {
    if (update.qr) {
      botState.qrDataUrl = await QRCode.toDataURL(update.qr);
      botState.authenticated = false;
      botState.ready = false;
      console.log('\nBaileys QR received. Open the dashboard to connect WhatsApp.\n');
    }

    if (update.connection === 'open') {
      botState.qrDataUrl = null;
      botState.pairingCode = null;
      botState.authenticated = true;
      botState.ready = true;
      botState.connectedPhone = jidToPhone(this.socket?.user?.id ?? '');
      if (botState.connectedPhone) {
        this.storage.updateClientProfile({ whatsappPhone: botState.connectedPhone });
      }
      console.log(`Baileys WhatsApp socket ready. Connected phone: ${botState.connectedPhone ?? 'unknown'}`);
    }

    if (update.connection === 'close') {
      botState.authenticated = false;
      botState.ready = false;
      botState.connectedPhone = null;
      botState.pairingCode = null;

      const statusCode = update.lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === baileys.DisconnectReason.loggedOut;
      console.warn(`Baileys disconnected. status=${statusCode ?? 'unknown'}`);

      if (!this.intentionalClose && !loggedOut) {
        this.reconnectTimer = setTimeout(() => {
          console.log('Baileys reconnecting...');
          this.initialize().catch((err) => console.error('Baileys reconnect failed:', err));
        }, RECONNECT_DELAY_MS);
      }
    }
  }

  private async handleMessages(messages: BaileysMessage[]): Promise<void> {
    for (const raw of messages as any[]) {
      if (!raw?.message || raw.key?.fromMe) continue;
      const from = raw.key?.remoteJid;
      const body = getMessageText(raw).trim();
      if (!from || !body) continue;

      const incoming: IncomingWhatsAppMessage = {
        id: raw.key?.id ?? `${from}:${raw.messageTimestamp ?? ''}`,
        from,
        senderPhone: pickSenderPhone(raw),
        body,
        timestamp: Number(raw.messageTimestamp || Math.floor(Date.now() / 1000)),
        async getDisplayName() {
          return raw.pushName?.trim() || '';
        },
      };

      await handleIncomingWhatsAppMessage(incoming, this.storage, this.createTransport(), 'baileys');
    }
  }

  private createTransport(): WhatsAppTransport {
    return {
      sendMessage: (to, message) => this.sendMessage(to, message),
      sendFile: (to, filePath, caption, options) => this.sendFile(to, filePath, caption, options),
      sendInteractiveButtons: (to, text, buttons) => this.sendInteractiveButtons(to, text, buttons),
      sendInteractiveList: (to, text, buttonText, items) => this.sendInteractiveList(to, text, buttonText, items),
      resolvePhone: async (jid) => jidToPhone(jid),
    };
  }

  private async requestPairingCode(phone: string): Promise<void> {
    if (!this.socket || botState.pairingAttempted) return;
    botState.pairingAttempted = true;
    try {
      const code = await this.socket.requestPairingCode(phone);
      botState.pairingCode = code;
      console.log(`Baileys pairing code generated: ${code}`);
    } catch (err) {
      botState.pairingAttempted = false;
      console.error('Baileys pairing code request failed:', err);
    }
  }

  private assertReady(): void {
    if (!this.socket) throw new Error('Baileys socket is not initialized.');
  }
}

export function createBaileysProvider(storage: Storage, pairingPhone?: string): BaileysProvider {
  return new BaileysProvider(storage, pairingPhone);
}
