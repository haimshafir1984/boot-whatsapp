export type WhatsAppMessageSource = 'message' | 'message_create' | 'webhook';

export interface IncomingWhatsAppMessage {
  id: string;
  from: string;
  to?: string;
  body: string;
  timestamp?: number;
  getDisplayName(): Promise<string>;
}

export interface WhatsAppTransport {
  sendMessage(to: string, message: string): Promise<void>;
  sendFile?(to: string, filePath: string, caption?: string, options?: { asSticker?: boolean }): Promise<void>;
  sendInteractiveButtons?(to: string, text: string, buttons: Array<{ id: string; text: string }>): Promise<void>;
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
}
