export type WhatsAppMessageSource = 'message' | 'message_create' | 'webhook' | 'baileys';

export interface WhatsAppSendResult {
  messageId?: string;
}

export interface IncomingWhatsAppMessage {
  id: string;
  from: string;
  senderPhone?: string;
  to?: string;
  body: string;
  hasUserSignal?: boolean;
  /** Meta reported a reply-button interaction, even if its reply id was omitted. */
  isButtonReply?: boolean;
  isReaction?: boolean;
  timestamp?: number;
  getDisplayName(): Promise<string>;
}

export interface WhatsAppTransport {
  sendMessage(to: string, message: string): Promise<void | WhatsAppSendResult>;
  sendFile?(to: string, filePath: string, caption?: string, options?: { asSticker?: boolean }): Promise<void | WhatsAppSendResult>;
  sendContactCard?(to: string, vcard: string, displayName: string): Promise<void | WhatsAppSendResult>;
  sendContactCards?(to: string, contacts: Array<{ vcard: string; displayName: string }>, displayName: string): Promise<void | WhatsAppSendResult>;
  sendContentTemplate?(to: string, contentSid: string, contentVariables?: Record<string, string>): Promise<void | WhatsAppSendResult>;
  sendInteractiveButtons?(to: string, text: string, buttons: Array<{ id: string; text: string }>): Promise<void | WhatsAppSendResult>;
  sendInteractiveList?(to: string, text: string, buttonText: string, items: Array<{ id: string; text: string }>): Promise<void | WhatsAppSendResult>;
  resolvePhone(jid: string): Promise<string>;
  markRead?(message: IncomingWhatsAppMessage): Promise<void>;
}

export interface WhatsAppProvider {
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  logout(): Promise<void>;
  sendMessage(to: string, message: string): Promise<void | WhatsAppSendResult>;
  sendFile?(to: string, filePath: string, caption?: string, options?: { asSticker?: boolean }): Promise<void | WhatsAppSendResult>;
  sendContactCard?(to: string, vcard: string, displayName: string): Promise<void | WhatsAppSendResult>;
  sendContactCards?(to: string, contacts: Array<{ vcard: string; displayName: string }>, displayName: string): Promise<void | WhatsAppSendResult>;
  sendContentTemplate?(to: string, contentSid: string, contentVariables?: Record<string, string>): Promise<void | WhatsAppSendResult>;
  sendInteractiveButtons(
    to: string,
    text: string,
    buttons: Array<{ id: string; text: string }>,
  ): Promise<void | WhatsAppSendResult>;
  sendInteractiveList?(
    to: string,
    text: string,
    buttonText: string,
    items: Array<{ id: string; text: string }>,
  ): Promise<void | WhatsAppSendResult>;
  markRead?(message: IncomingWhatsAppMessage): Promise<void>;
}
