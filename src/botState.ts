export interface RuntimeWhatsAppClient {
  destroy(): Promise<void>;
  logout(): Promise<void>;
}

export const botState = {
  qrDataUrl: null as string | null,
  pairingCode: null as string | null,
  pairingPhone: null as string | null,
  pairingAttempted: false,
  intentionalRestart: false,
  client: null as RuntimeWhatsAppClient | null,
  authenticated: false,
  ready: false,
  connectedPhone: null as string | null,
  lifecycle: 'stopped' as 'stopped' | 'starting' | 'running' | 'stopping',
  listeningReason: 'startup' as string,
};
