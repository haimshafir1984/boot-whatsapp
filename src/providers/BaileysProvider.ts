import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import QRCode from 'qrcode';
import { config } from '../config';
import { botState } from '../botState';
import { handleIncomingWhatsAppMessage } from '../messageFlow';
import { Storage } from '../storage';
import { detectTrigger } from '../triggerDetector';
import { IncomingWhatsAppMessage, InteractiveListItem, WhatsAppProvider, WhatsAppTransport } from '../types/whatsapp';

type BaileysModule = typeof import('@whiskeysockets/baileys');
type BaileysSocket = ReturnType<BaileysModule['makeWASocket']>;
type BaileysMessage = NonNullable<Parameters<Parameters<BaileysSocket['ev']['on']>[1]>[0]> extends infer T
  ? T
  : any;

const RECONNECT_BACKOFF_MS = [10_000, 30_000, 60_000, 120_000, 300_000];
const PAIRING_CODE_SETTLE_MS = 2_500;

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

function getMessageContent(message: any): { body: string; isReaction: boolean; hasUserSignal: boolean; media?: IncomingWhatsAppMessage['media'] } {
  const content = message?.message;
  if (!content) return { body: '', isReaction: false, hasUserSignal: false };

  const reactionText = content.reactionMessage?.text;
  if (typeof reactionText === 'string') {
    return { body: reactionText.trim() || 'תגובה', isReaction: true, hasUserSignal: true };
  }

  const body = (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    ''
  );
  const hasUserSignal = Boolean(
    body.trim() ||
    content.imageMessage ||
    content.videoMessage ||
    content.documentMessage ||
    content.audioMessage ||
    content.stickerMessage,
  );
  const mediaMessage = content.imageMessage || content.videoMessage || content.audioMessage || content.documentMessage || content.stickerMessage;
  const mediaKind = content.imageMessage ? 'image'
    : content.videoMessage ? 'video'
      : content.audioMessage ? 'audio'
        : content.documentMessage ? 'document'
          : content.stickerMessage ? 'sticker'
            : undefined;
  return {
    body,
    isReaction: false,
    hasUserSignal,
    media: mediaKind ? {
      kind: mediaKind,
      mimeType: String(mediaMessage?.mimetype || '') || undefined,
      fileName: String(mediaMessage?.fileName || '') || undefined,
      providerMediaId: String(mediaMessage?.directPath || mediaMessage?.url || '') || undefined,
    } : undefined,
  };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BaileysProvider implements WhatsAppProvider {
  private socket: BaileysSocket | null = null;
  private saveCreds: (() => Promise<void>) | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pairingRetryTimer: NodeJS.Timeout | null = null;
  private pairingRequestAttempts = 0;
  private intentionalClose = false;
  private readonly storage: Storage;
  private readonly pairingPhone?: string;

  constructor(storage: Storage, pairingPhone?: string) {
    this.storage = storage;
    this.pairingPhone = pairingPhone;
  }

  async initialize(): Promise<void> {
    this.intentionalClose = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.pairingRetryTimer) clearTimeout(this.pairingRetryTimer);
    this.pairingRetryTimer = null;
    if (this.pairingPhone) {
      botState.pairingCode = null;
      botState.pairingError = null;
      botState.pairingAttempted = false;
      this.pairingRequestAttempts = 0;
    }
    if (this.socket) {
      try {
        this.socket.end(undefined);
      } catch {
        // Best effort cleanup before replacing the socket.
      }
      this.socket = null;
    }
    const baileys = await import('@whiskeysockets/baileys');
    const pino = (await import('pino')).default;
    const { state, saveCreds } = await baileys.useMultiFileAuthState(authPath());
    const version = await this.resolveBaileysVersion(baileys);

    this.saveCreds = saveCreds;
    this.socket = baileys.makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      version,
      browser: this.resolveBrowserConfig(baileys),
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
    });

    this.socket.ev.on('creds.update', saveCreds);
    this.socket.ev.on('connection.update', async (update: any) => {
      await this.handleConnectionUpdate(baileys, update);
    });
    this.socket.ev.on('messages.upsert', async (event: any) => {
      await this.handleMessages(event.messages ?? []);
    });
  }

  async destroy(): Promise<void> {
    this.intentionalClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.pairingRetryTimer) clearTimeout(this.pairingRetryTimer);
    this.pairingRetryTimer = null;
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
    const mimeType = getMimeType(filePath);
    const media = { url: filePath };

    if (options.asSticker && mimeType.startsWith('image/')) {
      await this.socket!.sendMessage(jid, { sticker: media });
      return;
    }
    if (mimeType.startsWith('image/')) {
      await this.socket!.sendMessage(jid, { image: media, caption: caption?.trim() || undefined });
      return;
    }
    if (mimeType.startsWith('video/')) {
      await this.socket!.sendMessage(jid, { video: media, caption: caption?.trim() || undefined, mimetype: mimeType });
      return;
    }
    await this.socket!.sendMessage(jid, {
      document: media,
      fileName: path.basename(filePath),
      mimetype: mimeType,
      caption: caption?.trim() || undefined,
    });
  }

  async sendContactCard(to: string, vcard: string, displayName: string): Promise<void> {
    await this.sendContactCards(to, [{ displayName, vcard }], displayName);
  }

  async sendContactCards(to: string, contacts: Array<{ vcard: string; displayName: string }>, displayName: string): Promise<void> {
    this.assertReady();
    await this.socket!.sendMessage(normalizeJid(to), {
      contacts: {
        displayName,
        contacts: contacts.map((contact) => ({ displayName: contact.displayName, vcard: contact.vcard })),
      },
    } as any);
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
    items: InteractiveListItem[],
  ): Promise<void> {
    const listText = items.length
      ? `${text}\n\n${items.map((item, index) => `${index + 1}. ${item.text}${item.description ? ` ${item.description}` : ''}`).join('\n')}`
      : text;
    await this.sendMessage(to, listText);
  }

  private async handleConnectionUpdate(baileys: BaileysModule, update: any): Promise<void> {
    if (update.qr) {
      botState.authenticated = false;
      botState.ready = false;
      if (this.pairingPhone) {
        // Pairing-code mode: the qr event only signals the socket has
        // reached a state where a pairing code can be requested. Request
        // the code instead of exposing this QR - running both linking
        // methods on the same socket at once caused the phone to reject
        // the entered code.
        void this.requestPairingCode(baileys, this.pairingPhone);
      } else {
        botState.qrDataUrl = await QRCode.toDataURL(update.qr);
        botState.pairingError = null;
        console.log('\nBaileys QR received. Open the dashboard to connect WhatsApp.\n');
      }
    }

    if (update.connection === 'open') {
      botState.qrDataUrl = null;
      botState.pairingCode = null;
      botState.pairingError = null;
      botState.pairingPhone = null;
      botState.pairingAttempted = false;
      this.pairingRequestAttempts = 0;
      if (this.pairingRetryTimer) clearTimeout(this.pairingRetryTimer);
      this.pairingRetryTimer = null;
      botState.authenticated = true;
      botState.ready = true;
      botState.notReadySince = null;
      botState.reconnectAttempts = 0;
      botState.connectedPhone = jidToPhone(this.socket?.user?.id ?? '');
      if (botState.connectedPhone) {
        this.storage.updateClientProfile({ whatsappPhone: botState.connectedPhone });
      }
      console.log(`Baileys WhatsApp socket ready. Connected phone: ${botState.connectedPhone ?? 'unknown'}`);
    }

    if (update.connection === 'close') {
      botState.authenticated = false;
      botState.ready = false;
      botState.notReadySince = botState.notReadySince ?? Date.now();
      botState.connectedPhone = null;
      botState.pairingCode = null;

      const statusCode = update.lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === baileys.DisconnectReason.loggedOut;
      console.warn(`Baileys disconnected. status=${statusCode ?? 'unknown'}`);
      botState.listeningReason = loggedOut
        ? 'connection failed: החיבור ל-WhatsApp התנתק. יש לסרוק QR מחדש.'
        : `reconnecting after disconnect (${statusCode ?? 'unknown'})`;
      if (loggedOut) {
        botState.lifecycle = 'stopped';
        botState.qrDataUrl = null;
        if (this.pairingPhone) {
          botState.pairingCode = null;
          botState.pairingError = 'החיבור ל-WhatsApp התנתק. מבקשים קוד התחברות חדש באופן אוטומטי.';
        }
        // WhatsApp confirmed this session is dead. Clear it so the next start
        // (keep-connected scheduler or manual reset) loads a clean auth state
        // and actually issues a fresh QR, instead of retrying forever with
        // the same rejected credentials.
        try {
          fs.rmSync(authPath(), { recursive: true, force: true });
          console.log(`Baileys session cleared after logout: ${authPath()}`);
        } catch (err) {
          console.error('Failed to clear Baileys session after logout:', err);
        }
      } else if (this.pairingPhone && !this.intentionalClose) {
        // The pairing code expired or the connection dropped before it was
        // used. A reconnect will be scheduled below, which re-requests a
        // fresh code (initialize() resets pairingAttempted for the same
        // pairingPhone) - surface that clearly instead of leaving a dead
        // code on screen or silently falling back to QR.
        botState.pairingCode = null;
        botState.pairingError = 'הקוד פג תוקף או שהחיבור נותק. מבקשים קוד חדש באופן אוטומטי.';
      }

      if (!this.intentionalClose && !loggedOut) {
        const attempt = botState.reconnectAttempts + 1;
        const delay = RECONNECT_BACKOFF_MS[Math.min(attempt - 1, RECONNECT_BACKOFF_MS.length - 1)];
        botState.reconnectAttempts = attempt;
        botState.lastReconnectAt = new Date().toISOString();
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
          console.log(`Baileys reconnecting... attempt=${attempt} delay=${delay}`);
          this.initialize().catch((err) => console.error('Baileys reconnect failed:', err));
        }, delay);
      }
    }
  }

  private async handleMessages(messages: BaileysMessage[]): Promise<void> {
    for (const raw of messages as any[]) {
      if (!raw?.message) continue;
      const from = raw.key?.remoteJid;
      const content = getMessageContent(raw);
      const body = content.body.trim();
      if (!from || (!body && !content.hasUserSignal)) continue;
      const fromMe = Boolean(raw.key?.fromMe);
      if (fromMe && !this.isSelfTriggerMessage(from, body)) continue;

      const incoming: IncomingWhatsAppMessage = {
        id: raw.key?.id ?? `${from}:${raw.messageTimestamp ?? ''}`,
        from,
        senderPhone: pickSenderPhone(raw) || (fromMe ? jidToPhone(this.socket?.user?.id ?? from) : undefined),
        body,
        isReaction: content.isReaction,
        hasUserSignal: content.hasUserSignal,
        media: content.media,
        timestamp: Number(raw.messageTimestamp || Math.floor(Date.now() / 1000)),
        async getDisplayName() {
          return raw.pushName?.trim() || (fromMe ? 'המספר המחובר' : '');
        },
      };

      await handleIncomingWhatsAppMessage(incoming, this.storage, this.createTransport(), 'baileys');
    }
  }

  private isSelfTriggerMessage(remoteJid: string, body: string): boolean {
    const connectedPhone = jidToPhone(this.socket?.user?.id ?? '');
    const remotePhone = jidToPhone(remoteJid);
    if (!connectedPhone || !remotePhone || connectedPhone !== remotePhone) return false;
    const trigger = detectTrigger(body, this.storage.getActiveCampaigns());
    if (trigger.matched) {
      console.log(`[SELF-TEST] Baileys self trigger matched for "${trigger.campaignName}".`);
      return true;
    }
    return false;
  }

  private createTransport(): WhatsAppTransport {
    return {
      sendMessage: (to, message) => this.sendMessage(to, message),
      sendFile: (to, filePath, caption, options) => this.sendFile(to, filePath, caption, options),
      sendContactCard: (to, vcard, displayName) => this.sendContactCard(to, vcard, displayName),
      sendContactCards: (to, contacts, displayName) => this.sendContactCards(to, contacts, displayName),
      sendInteractiveButtons: (to, text, buttons) => this.sendInteractiveButtons(to, text, buttons),
      sendInteractiveList: (to, text, buttonText, items) => this.sendInteractiveList(to, text, buttonText, items),
      markRead: async (message) => {
        this.assertReady();
        await this.socket!.readMessages([{ remoteJid: normalizeJid(message.from), id: message.id, fromMe: false } as any]);
      },
      resolvePhone: async (jid) => jidToPhone(jid),
    };
  }

  private async resolveBaileysVersion(baileys: BaileysModule): Promise<BaileysModule['DEFAULT_CONNECTION_CONFIG']['version']> {
    try {
      const { version } = await baileys.fetchLatestWaWebVersion();
      return version;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`WA Web version fetch failed; falling back to Baileys bundled version lookup. ${message}`);
    }
    try {
      const { version } = await baileys.fetchLatestBaileysVersion();
      return version;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Baileys latest version fetch failed; using bundled default version. ${message}`);
      return baileys.DEFAULT_CONNECTION_CONFIG.version;
    }
  }

  private resolveBrowserConfig(baileys: BaileysModule): BaileysModule['DEFAULT_CONNECTION_CONFIG']['browser'] {
    // Pairing-code registration is stricter than QR registration about the
    // browser/platform display. A custom OS label can produce a locally
    // generated code that WhatsApp later rejects as invalid.
    return baileys.Browsers?.macOS?.('Chrome') ?? baileys.DEFAULT_CONNECTION_CONFIG.browser;
  }

  private async requestPairingCode(baileys: BaileysModule, phone: string): Promise<void> {
    if (!this.socket || botState.pairingAttempted || botState.pairingCode) return;
    const isRegistered = Boolean((this.socket as any).authState?.creds?.registered);
    if (isRegistered) {
      botState.pairingError = 'קיים כבר session מחובר. אם צריך לחבר מספר אחר, אפס את חיבור WhatsApp ונסה שוב.';
      return;
    }
    botState.pairingAttempted = true;
    botState.pairingError = null;
    this.pairingRequestAttempts += 1;
    try {
      const code = await this.requestConfirmedPairingCode(baileys, phone);
      console.log(`Baileys pairing code generated, waiting ${PAIRING_CODE_SETTLE_MS}ms for early rejection signals.`);
      await sleep(PAIRING_CODE_SETTLE_MS);
      if (botState.pairingError || !this.socket || this.intentionalClose) {
        console.warn(`Baileys pairing code discarded before display: ${botState.pairingError || 'socket closed'}`);
        return;
      }
      botState.pairingCode = code;
      botState.pairingError = null;
      if (this.pairingRetryTimer) clearTimeout(this.pairingRetryTimer);
      this.pairingRetryTimer = null;
      console.log(`Baileys pairing code ready for display: ${code}`);
    } catch (err) {
      botState.pairingAttempted = false;
      const message = err instanceof Error ? err.message : String(err);
      const shouldRetry = !this.intentionalClose && Boolean(this.socket) && this.pairingRequestAttempts < 5;
      botState.pairingError = shouldRetry
        ? `עדיין לא הצלחנו ליצור קוד התחברות, מנסים שוב בעוד רגע. ${message || ''}`.trim()
        : message || 'לא הצלחנו ליצור קוד התחברות. נסה שוב או סרוק QR.';
      botState.listeningReason = `connection failed: ${botState.pairingError}`;
      console.error('Baileys pairing code request failed:', err);

      if (shouldRetry) {
        const delay = Math.min(1_000 * this.pairingRequestAttempts, 5_000);
        if (this.pairingRetryTimer) clearTimeout(this.pairingRetryTimer);
        this.pairingRetryTimer = setTimeout(() => {
          this.pairingRetryTimer = null;
          void this.requestPairingCode(baileys, phone);
        }, delay);
      }
    }
  }

  private async requestConfirmedPairingCode(baileys: BaileysModule, phone: string): Promise<string> {
    const socket = this.socket as any;
    const pairingCode = (baileys as any).bytesToCrockford(randomBytes(5));
    const browserConfig = this.resolveBrowserConfig(baileys);
    const creds = socket.authState.creds;
    creds.pairingCode = pairingCode;
    creds.me = {
      id: (baileys as any).jidEncode(phone, 's.whatsapp.net'),
      name: '~',
    };
    socket.ev.emit('creds.update', creds);

    const salt = randomBytes(32);
    const randomIv = randomBytes(16);
    const key = await (baileys as any).derivePairingCodeKey(pairingCode, salt);
    const encryptedPairingKey = (baileys as any).aesEncryptCTR(
      creds.pairingEphemeralKeyPair.public,
      key,
      randomIv,
    );

    const response = await socket.query({
      tag: 'iq',
      attrs: {
        to: (baileys as any).S_WHATSAPP_NET,
        type: 'set',
        xmlns: 'md',
      },
      content: [
        {
          tag: 'link_code_companion_reg',
          attrs: {
            jid: creds.me.id,
            stage: 'companion_hello',
            should_show_push_notification: 'true',
          },
          content: [
            {
              tag: 'link_code_pairing_wrapped_companion_ephemeral_pub',
              attrs: {},
              content: Buffer.concat([salt, randomIv, encryptedPairingKey]),
            },
            {
              tag: 'companion_server_auth_key_pub',
              attrs: {},
              content: creds.noiseKey.public,
            },
            {
              tag: 'companion_platform_id',
              attrs: {},
              content: (baileys as any).getCompanionPlatformId(browserConfig),
            },
            {
              tag: 'companion_platform_display',
              attrs: {},
              content: `${browserConfig[1]} (${browserConfig[0]})`,
            },
            {
              tag: 'link_code_pairing_nonce',
              attrs: {},
              content: '0',
            },
          ],
        },
      ],
    }, 15_000);

    if (!response) {
      botState.pairingAttempted = false;
      throw new Error('WhatsApp לא אישרה את קוד ההתחברות בזמן. נסה שוב או סרוק QR.');
    }

    return pairingCode;
  }

  private assertReady(): void {
    if (!this.socket) throw new Error('Baileys socket is not initialized.');
  }
}

export function createBaileysProvider(storage: Storage, pairingPhone?: string): BaileysProvider {
  return new BaileysProvider(storage, pairingPhone);
}
