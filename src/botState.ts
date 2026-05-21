import type { Client } from 'whatsapp-web.js';

export const botState = {
  qrDataUrl: null as string | null,
  pairingCode: null as string | null,
  pairingPhone: null as string | null,
  pairingAttempted: false,
  intentionalRestart: false,
  client: null as Client | null,
  authenticated: false,
  ready: false,
  connectedPhone: null as string | null,
};
