import fs from 'fs';
import path from 'path';
import { config } from './config';

const PAIRING_RATE_LIMIT_FILE = path.join(config.SESSION_PATH, 'pairing-rate-limit.json');

export const PAIRING_CODE_RATE_LIMIT_COOLDOWN_MS = 2 * 60 * 60 * 1_000;

type PairingRateLimitState = {
  blockedUntil?: number;
};

export function getPairingCodeBlockedUntil(): number | null {
  try {
    if (!fs.existsSync(PAIRING_RATE_LIMIT_FILE)) return null;
    const raw = fs.readFileSync(PAIRING_RATE_LIMIT_FILE, 'utf8');
    const parsed = JSON.parse(raw) as PairingRateLimitState;
    const blockedUntil = Number(parsed.blockedUntil ?? 0);
    return blockedUntil > Date.now() ? blockedUntil : null;
  } catch {
    return null;
  }
}

export function setPairingCodeRateLimit(blockedUntil = Date.now() + PAIRING_CODE_RATE_LIMIT_COOLDOWN_MS): number {
  fs.mkdirSync(path.dirname(PAIRING_RATE_LIMIT_FILE), { recursive: true });
  fs.writeFileSync(PAIRING_RATE_LIMIT_FILE, JSON.stringify({ blockedUntil }, null, 2));
  return blockedUntil;
}

export function clearPairingCodeRateLimit(): void {
  try {
    if (fs.existsSync(PAIRING_RATE_LIMIT_FILE)) fs.unlinkSync(PAIRING_RATE_LIMIT_FILE);
  } catch {
    // Best effort only; a stale file expires automatically.
  }
}

export function pairingCodeRateLimitMessage(blockedUntil: number): string {
  const blockedForMinutes = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 60_000));
  return `WhatsApp חסמה זמנית יצירת קוד בגלל יותר מדי ניסיונות. המתן כ-${blockedForMinutes} דקות ואז נסה שוב.`;
}
