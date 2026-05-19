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

  // ─── Your contact card (sent as vCard to every user who triggers the bot) ────
  MY_CONTACT: {
    name: 'hadas gigi',        // <── EDIT: your full name
    phone: '+972508522907',    // <── EDIT: your phone in E.164 format
    email: '',                 // optional – leave '' to omit
    organization: '',          // optional – leave '' to omit
  },

  // ─── Reply messages ───────────────────────────────────────────────────────────
  REPLY_TEXT:
    'שמרתי אותך באנשי קשר, אשמח שתשמור אותי גם, כדי שתהנה מהסטטוס שלי',

  /** Sent when "ask for name" mode is enabled. {timeout} is replaced at runtime. */
  ASK_NAME_TEXT:
    'באיזה שם תרצה שנשמור אותך? ענה/י עם שמך המלא.\n' +
    'אם לא תענה תוך {timeout} דקות נשמור אותך לפי שמך בפרופיל הווטסאפ.',

  // ─── Admin dashboard ──────────────────────────────────────────────────────────
  /** Falls back to process.env.PORT for Render/cloud deployments. */
  ADMIN_PORT: Number(process.env.PORT) || 3001,

  // ─── File paths ───────────────────────────────────────────────────────────────
  SESSION_PATH: './session',
  STORAGE_PATH: './data/contacts.json',
  GOOGLE_TOKEN_PATH: './data/google-token.json',
  GOOGLE_CREDENTIALS_PATH: './credentials.json',
} as const;
