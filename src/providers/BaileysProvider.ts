import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import QRCode from 'qrcode';
import { config } from '../config';
import { botState } from '../botState';
import { handleIncomingWhatsAppMessage } from '../messageFlow';
import { Storage } from '../storage';
import { detectTrigger } from '../triggerDetector';
import {
  clearPairingCodeRateLimit,
  getPairingCodeBlockedUntil,
  pairingCodeRateLimitMessage,
  setPairingCodeRateLimit,
} from '../pairingRateLimit';
import { IncomingWhatsAppMessage, InteractiveListItem, WhatsAppProvider, WhatsAppTransport } from '../types/whatsapp';

type BaileysModule = typeof import('@whiskeysockets/baileys');
type BaileysSocket = ReturnType<BaileysModule['makeWASocket']>;
type BaileysMessage = NonNullable<Parameters<Parameters<BaileysSocket['ev']['on']>[1]>[0]> extends infer T
  ? T
  : any;

const RECONNECT_BACKOFF_MS = [10_000, 30_000, 60_000, 120_000, 300_000];
const PAIRING_CODE_SETTLE_MS = 2_500;
const PAIRING_RESTART_RECONNECT_MS = 250;

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
  private pairingRequestTerminal = false;
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
    if (this.pairingPhone) {
      botState.pairingCode = null;
      botState.pairingError = null;
      botState.pairingAttempted = false;
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

    this.socket.ev.on('creds.update', (update: any) => {
      if (this.pairingPhone && typeof update?.registered === 'boolean') {
        console.log(`Baileys pairing credentials update: registered=${update.registered}.`);
      }
      void saveCreds().catch((err) => console.error('Failed to persist Baileys credentials:', err));
    });
    this.socket.ev.on('connection.update', async (update: any) => {
      await this.handleConnectionUpdate(baileys, update);
    });
    this.socket.ev.on('messages.upsert', async (event: any) => {
      await this.handleMessages(event.messages ?? []);
    });
    const rawSocket = (this.socket as any).ws;
    rawSocket?.on?.('CB:notification,type:companion_reg_refresh', (node: any) => {
      console.warn(`Baileys received companion_reg_refresh during pairing (id=${node?.attrs?.id || 'unknown'}); acknowledging through the patched pre-login handler.`);
    });
    rawSocket?.on?.('CB:notification,type:link_code_companion_reg', (node: any) => {
      const stage = node?.attrs?.stage || node?.content?.[0]?.attrs?.stage || 'primary response';
      console.log(`Baileys received link_code_companion_reg during pairing: stage=${stage}.`);
    });
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
        console.log('Baileys pair-device readiness reached; requesting a phone pairing code.');
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
      botState.pairingCodeBlockedUntil = null;
      clearPairingCodeRateLimit();
      botState.pairingAttempted = false;
      this.pairingRequestTerminal = false;
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
      const restartRequired = statusCode === baileys.DisconnectReason.restartRequired;
      console.warn(`Baileys disconnected. status=${statusCode ?? 'unknown'}`);
      botState.listeningReason = loggedOut
        ? 'connection failed: החיבור ל-WhatsApp התנתק. יש לסרוק QR מחדש.'
        : restartRequired
          ? 'finalizing WhatsApp pairing after required restart'
        : `reconnecting after disconnect (${statusCode ?? 'unknown'})`;
      if (loggedOut) {
        botState.lifecycle = 'stopped';
        botState.qrDataUrl = null;
        if (this.pairingPhone) {
          this.pairingRequestTerminal = true;
          botState.pairingCode = null;
          botState.pairingPhone = null;
          botState.pairingAttempted = false;
          botState.pairingError = 'החיבור ל-WhatsApp התנתק. לחץ על "קבל קוד" כדי לבצע ניסיון חדש.';
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
      } else if (this.pairingPhone && !this.intentionalClose && !restartRequired) {
        // A pairing attempt is one-shot. Never reconnect with the same phone
        // after a timeout/drop: doing so silently requests another code and
        // can renew WhatsApp's rate limit without a user click.
        this.pairingRequestTerminal = true;
        botState.pairingCode = null;
        botState.pairingPhone = null;
        botState.pairingAttempted = false;
        botState.pairingError = 'הקוד פג תוקף או שהחיבור נותק. לחץ על "קבל קוד" כדי לבצע ניסיון חדש.';
      }

      if (!this.intentionalClose && !loggedOut && (!this.pairingPhone || restartRequired)) {
        const attempt = botState.reconnectAttempts + 1;
        // WhatsApp intentionally closes a newly paired socket with 515. The
        // saved credentials must be reused immediately; waiting for the normal
        // reconnect backoff can make the phone report that linking failed.
        const delay = restartRequired
          ? PAIRING_RESTART_RECONNECT_MS
          : RECONNECT_BACKOFF_MS[Math.min(attempt - 1, RECONNECT_BACKOFF_MS.length - 1)];
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
      const result = await baileys.fetchLatestWaWebVersion();
      if (result.isLatest) {
        console.log(`Baileys using live WhatsApp Web version ${result.version.join('.')}.`);
        return result.version;
      }
      const detail = result.error instanceof Error ? result.error.message : String(result.error || 'unknown response');
      if (this.pairingPhone) {
        throw new Error(`לא ניתן לאמת את גרסת WhatsApp Web העדכנית לפני יצירת קוד. ${detail}`);
      }
      console.warn(`Live WA Web version lookup was not authoritative; trying Baileys repository version. ${detail}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.pairingPhone) throw err;
      console.warn(`WA Web version fetch failed; falling back to Baileys repository version. ${message}`);
    }
    try {
      const result = await baileys.fetchLatestBaileysVersion();
      console.log(`Baileys using repository WhatsApp Web version ${result.version.join('.')} (latest=${result.isLatest}).`);
      return result.version;
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
    return baileys.Browsers?.windows?.('Chrome') ?? baileys.Browsers?.macOS?.('Chrome') ?? baileys.DEFAULT_CONNECTION_CONFIG.browser;
  }

  private async requestPairingCode(baileys: BaileysModule, phone: string): Promise<void> {
    if (!this.socket || this.pairingRequestTerminal || botState.pairingAttempted || botState.pairingCode) return;
    const blockedUntil = botState.pairingCodeBlockedUntil ?? getPairingCodeBlockedUntil();
    if (blockedUntil && blockedUntil > Date.now()) {
      this.pairingRequestTerminal = true;
      botState.pairingCodeBlockedUntil = blockedUntil;
      botState.pairingPhone = null;
      botState.pairingError = pairingCodeRateLimitMessage(blockedUntil);
      botState.listeningReason = `pairing code rate limited until ${new Date(blockedUntil).toISOString()}`;
      return;
    }
    const isRegistered = Boolean((this.socket as any).authState?.creds?.registered);
    if (isRegistered) {
      botState.pairingError = 'קיים כבר session מחובר. אם צריך לחבר מספר אחר, אפס את חיבור WhatsApp ונסה שוב.';
      return;
    }
    botState.pairingAttempted = true;
    botState.pairingError = null;
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
      console.log(`Baileys pairing code ready for display: ${code}`);
    } catch (err) {
      this.pairingRequestTerminal = true;
      botState.pairingAttempted = false;
      botState.pairingPhone = null;
      const message = err instanceof Error ? err.message : String(err);
      const isRateLimited = message.includes('rate-overlimit') || (err as any)?.data === 429;
      if (isRateLimited) {
        botState.pairingCodeBlockedUntil = setPairingCodeRateLimit();
      }
      botState.pairingError = isRateLimited
        ? pairingCodeRateLimitMessage(botState.pairingCodeBlockedUntil ?? Date.now())
        : message || 'לא הצלחנו ליצור קוד התחברות. לחץ על "קבל קוד" כדי לנסות שוב.';
      botState.listeningReason = `connection failed: ${botState.pairingError}`;
      console.error('Baileys pairing code request failed:', err);
    }
  }

  private async requestConfirmedPairingCode(baileys: BaileysModule, phone: string): Promise<string> {
    const socket = this.socket as any;
    const pairingCode = (baileys as any).bytesToCrockford(randomBytes(5));
    const browserConfig = this.resolveBrowserConfig(baileys);
    const creds = socket.authState.creds;
    creds.pairingCode = pairingCode;
    const jid = (baileys as any).jidEncode(phone, 's.whatsapp.net');

    const salt = randomBytes(32);
    const randomIv = randomBytes(16);
    const key = await (baileys as any).derivePairingCodeKey(pairingCode, salt);
    const encryptedPairingKey = (baileys as any).aesEncryptCTR(
      creds.pairingEphemeralKeyPair.public,
      key,
      randomIv,
    );

    let response: any;
    try {
      response = await socket.query({
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
              jid,
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
    } catch (err) {
      if (creds.pairingCode === pairingCode) creds.pairingCode = undefined;
      console.error('Baileys companion_hello was rejected by WhatsApp:', err);
      throw err;
    }

    if (!response) {
      if (creds.pairingCode === pairingCode) creds.pairingCode = undefined;
      botState.pairingAttempted = false;
      throw new Error('WhatsApp לא אישרה את קוד ההתחברות בזמן. נסה שוב או סרוק QR.');
    }

    console.log(`Baileys companion_hello accepted by WhatsApp: type=${response.attrs?.type || 'unknown'}.`);
    // Persist the phone identity only after WhatsApp accepted companion_hello.
    // Saving it earlier makes pre-login notifications look authenticated and
    // can leave a dead pairing session behind after an IQ rejection.
    creds.me = { id: jid, name: '~' };
    socket.ev.emit('creds.update', creds);

    return pairingCode;
  }

  private assertReady(): void {
    if (!this.socket) throw new Error('Baileys socket is not initialized.');
  }
}

export function createBaileysProvider(storage: Storage, pairingPhone?: string): BaileysProvider {
  return new BaileysProvider(storage, pairingPhone);
}
