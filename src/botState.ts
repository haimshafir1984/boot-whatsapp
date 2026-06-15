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
  requestedProvider: process.env.WHATSAPP_PROVIDER ?? 'WEB_JS',
  actualProvider: null as string | null,
  providerFallbackReason: null as string | null,
  authenticated: false,
  ready: false,
  notReadySince: null as number | null,
  reconnectAttempts: 0,
  lastReconnectAt: null as string | null,
  lastWatchdogRestartAt: null as string | null,
  connectedPhone: null as string | null,
  lifecycle: 'stopped' as 'stopped' | 'starting' | 'running' | 'stopping',
  listeningReason: 'startup' as string,
};
