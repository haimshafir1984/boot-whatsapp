export type WhatsAppMessageSource = 'message' | 'message_create' | 'webhook' | 'baileys';

export interface IncomingWhatsAppMessage {
  id: string;
  from: string;
  senderPhone?: string;
  to?: string;
  body: string;
  isReaction?: boolean;
  timestamp?: number;
  getDisplayName(): Promise<string>;
}

export interface WhatsAppTransport {
  sendMessage(to: string, message: string): Promise<void>;
  sendFile?(to: string, filePath: string, caption?: string, options?: { asSticker?: boolean }): Promise<void>;
  sendInteractiveButtons?(to: string, text: string, buttons: Array<{ id: string; text: string }>): Promise<void>;
  sendInteractiveList?(to: string, text: string, buttonText: string, items: Array<{ id: string; text: string }>): Promise<void>;
  resolvePhone(jid: string): Promise<string>;
}

export interface WhatsAppProvider {
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  logout(): Promise<void>;
  sendMessage(to: string, message: string): Promise<void>;
  sendFile?(to: string, filePath: string, caption?: string, options?: { asSticker?: boolean }): Promise<void>;
  sendInteractiveButtons(
    to: string,
    text: string,
    buttons: Array<{ id: string; text: string }>,
  ): Promise<void>;
  sendInteractiveList?(
    to: string,
    text: string,
    buttonText: string,
    items: Array<{ id: string; text: string }>,
  ): Promise<void>;
}
