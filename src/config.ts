/**
 * config.ts
 * Static configuration – values that never change at runtime.
 * Campaigns and admin-controlled settings live in storage.ts / the dashboard.
 */

export const config = {
  // ─── Trigger prefixes (static – used when building campaign trigger phrases) ──
  /** Fixed prefix prepended to the referrer name for every type-2 campaign. */
  TRIGGER_REFERRAL_PREFIX: 'הגעתי דרך ',

  // ─── Contact suffixes ─────────────────────────────────────────────────────────
  /** Appended to the saved contact name for type-1 campaigns. */
  BOT_SUFFIX: ' - (Bot)',

  /** Fallback display name when the sender has no WhatsApp pushname. */
  CONTACT_NAME_FALLBACK: 'New Contact {phone}',

  // ─── Optional contact-card values; configure per client via environment only ─
  MY_CONTACT: {
    name: process.env.CLIENT_CONTACT_NAME ?? '',
    phone: process.env.CLIENT_PHONE ?? '',
    email: process.env.CLIENT_CONTACT_EMAIL ?? '',
    organization: process.env.CLIENT_CONTACT_ORGANIZATION ?? '',
  },

  // ─── Reply messages ───────────────────────────────────────────────────────────
  REPLY_TEXT:
    'שמרתי אותך. כדי ליהנות מהסטטוסים שלי, אשמח שתשמרי אותי גם באנשי הקשר.',

  /** Sent when "ask for name" mode is enabled. {timeout} is replaced at runtime. */
  ASK_NAME_TEXT:
    'ברוכה הבאה🥰\nבאיזה שם תרצי שאשמור אותך?',

  // ─── Admin dashboard ──────────────────────────────────────────────────────────
  /** Falls back to process.env.PORT for Render/cloud deployments. */
  ADMIN_PORT: Number(process.env.PORT) || 3001,

  // ─── File paths ───────────────────────────────────────────────────────────────
  SESSION_PATH: process.env.SESSION_PATH ?? './data/session',
  STORAGE_PATH: process.env.STORAGE_PATH ?? './data/contacts.json',
  UPLOADS_PATH: process.env.UPLOADS_PATH ?? './data/uploads',
  GOOGLE_TOKEN_PATH: process.env.GOOGLE_TOKEN_PATH ?? './data/google-token.json',
  GOOGLE_CREDENTIALS_PATH: process.env.GOOGLE_CREDENTIALS_PATH ?? './credentials.json',
  OWNER_STORAGE_PATH: process.env.OWNER_STORAGE_PATH ?? './data/owner/clients.json',
} as const;
