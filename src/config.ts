/**
 * config.ts
 * Static configuration – values that never change at runtime.
 * Campaigns and admin-controlled settings live in storage.ts / the dashboard.
 */

function envValue(value: string | undefined, fallback = ''): string {
  const trimmed = String(value ?? fallback).trim();
  return trimmed.replace(/^[\'\"]|[\'\"]$/g, '');
}

function envFlag(value: string | undefined, defaultValue: boolean): boolean {
  const normalized = envValue(value).toLowerCase();
  if (!normalized) return defaultValue;
  return !['false', '0', 'no', 'off'].includes(normalized);
}

export const config = {
  CLIENT_PLAN: envValue(process.env.CLIENT_PLAN, 'self_service'),
  CLIENT_READONLY_DASHBOARD: envFlag(process.env.CLIENT_READONLY_DASHBOARD, false),
  CLIENT_MAX_CAMPAIGNS: Number(envValue(process.env.CLIENT_MAX_CAMPAIGNS)) || 7,
  CLIENT_SERVICE_EXPIRES_AT: envValue(process.env.CLIENT_SERVICE_EXPIRES_AT),
  CLIENT_REFERRAL_CONTEST_ENABLED: envFlag(process.env.CLIENT_REFERRAL_CONTEST_ENABLED, false),
  WHATSAPP_PROVIDER: envValue(process.env.WHATSAPP_PROVIDER, 'BAILEYS'),
  META_ACCESS_TOKEN: envValue(process.env.META_ACCESS_TOKEN ?? process.env.DOKPLOY_META_ACCESS_TOKEN),
  META_PHONE_NUMBER_ID: envValue(process.env.META_PHONE_NUMBER_ID ?? process.env.DOKPLOY_META_PHONE_NUMBER_ID),
  META_DISPLAY_PHONE_NUMBER: envValue(process.env.META_DISPLAY_PHONE_NUMBER ?? process.env.DOKPLOY_META_DISPLAY_PHONE_NUMBER),
  META_VERIFY_TOKEN: envValue(process.env.META_VERIFY_TOKEN ?? process.env.DOKPLOY_META_VERIFY_TOKEN),
  META_APP_SECRET: envValue(process.env.META_APP_SECRET ?? process.env.DOKPLOY_META_APP_SECRET),
  META_GRAPH_API_VERSION: envValue(process.env.META_GRAPH_API_VERSION, 'v23.0'),
  META_GATEWAY_BASE_URL: envValue(process.env.META_GATEWAY_BASE_URL, 'https://admin.flowsbiz.com'),
  WHATSAPP_KEEP_CONNECTED: envFlag(process.env.WHATSAPP_KEEP_CONNECTED, true),
  BOT_REPLY_DELAY_MS: Number(process.env.BOT_REPLY_DELAY_MS ?? 3000),
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ?? process.env.DOKPLOY_TWILIO_ACCOUNT_SID ?? '',
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ?? process.env.DOKPLOY_TWILIO_AUTH_TOKEN ?? '',
  TWILIO_FROM: process.env.TWILIO_FROM ?? process.env.DOKPLOY_TWILIO_FROM ?? '',
  TWILIO_MESSAGING_SERVICE_SID: process.env.TWILIO_MESSAGING_SERVICE_SID ?? process.env.DOKPLOY_TWILIO_MESSAGING_SERVICE_SID ?? '',
  TWILIO_WEBHOOK_TOKEN: process.env.TWILIO_WEBHOOK_TOKEN ?? process.env.DOKPLOY_TWILIO_WEBHOOK_TOKEN ?? '',
  TWILIO_REQUIRE_SIGNATURE: process.env.TWILIO_REQUIRE_SIGNATURE !== 'false',
  TWILIO_MEDIA_BASE_URL: process.env.TWILIO_MEDIA_BASE_URL ?? process.env.DOKPLOY_TWILIO_MEDIA_BASE_URL ?? '',
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
  CONVERSATION_STATE_PATH: process.env.CONVERSATION_STATE_PATH ?? './data/conversation-state.json',
  GOOGLE_CREDENTIALS_PATH: process.env.GOOGLE_CREDENTIALS_PATH ?? './credentials.json',
  OWNER_STORAGE_PATH: process.env.OWNER_STORAGE_PATH ?? './data/owner/clients.json',
} as const;
