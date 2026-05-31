/**
 * config.ts
 * Static configuration – values that never change at runtime.
 * Campaigns and admin-controlled settings live in storage.ts / the dashboard.
 */

export const config = {
  CLIENT_PLAN: process.env.CLIENT_PLAN ?? 'self_service',
  CLIENT_READONLY_DASHBOARD: process.env.CLIENT_READONLY_DASHBOARD === 'true',
  CLIENT_MAX_CAMPAIGNS: Number(process.env.CLIENT_MAX_CAMPAIGNS) || 7,
  CLIENT_SERVICE_EXPIRES_AT: process.env.CLIENT_SERVICE_EXPIRES_AT ?? '',
  WHATSAPP_PROVIDER: process.env.WHATSAPP_PROVIDER ?? 'WEB_JS',
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ?? '',
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ?? '',
  TWILIO_FROM: process.env.TWILIO_FROM ?? '',
  TWILIO_MESSAGING_SERVICE_SID: process.env.TWILIO_MESSAGING_SERVICE_SID ?? '',
  TWILIO_WEBHOOK_TOKEN: process.env.TWILIO_WEBHOOK_TOKEN ?? '',
  TWILIO_REQUIRE_SIGNATURE: process.env.TWILIO_REQUIRE_SIGNATURE !== 'false',
  TWILIO_MEDIA_BASE_URL: process.env.TWILIO_MEDIA_BASE_URL ?? '',
  TWILIO_QUICK_REPLY_CONTENT_SID: process.env.TWILIO_QUICK_REPLY_CONTENT_SID ?? '',
  TWILIO_LIST_PICKER_CONTENT_SID: process.env.TWILIO_LIST_PICKER_CONTENT_SID ?? '',

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
