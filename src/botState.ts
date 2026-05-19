import type { Client } from 'whatsapp-web.js';

export const botState = {
  qrDataUrl: null as string | null,
  pairingCode: null as string | null,
  client: null as Client | null,
  authenticated: false,
  ready: false,
};
