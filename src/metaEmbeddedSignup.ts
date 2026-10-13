/**
 * Embedded Signup for a customer-owned WhatsApp number. Two paths, decided server-side (never
 * from the browser) by detectMetaOnboardingPath below: Coexistence (the number stays active in
 * the WhatsApp Business app too - sync, never register) and the plain Cloud-API path (a new
 * number verified by code - register, no sync). See docs/embedded-signup-automation-plan-
 * 2026-09-28.md (sections 3.1-3.3), docs/embedded-signup-coexistence-event-contract-finding-
 * 2026-09-29.md, and docs/embedded-signup-first-live-test-2026-10-13.md (section 7, where the
 * Cloud-API path was added after a live test hit #133010 on a number Coexistence code had never
 * handled).
 *
 * Pure Graph API + connect-link helpers only - no ownerStorage/adminServer
 * access here, so this stays testable with a `global.fetch` stub the same way
 * dokployProvisioner.ts is (scripts/test-dokploy-provisioner-postgres.js).
 * Orchestration (persisting state, calling the Dokploy provisioner) lives in
 * adminServer.ts, where ownerStorage and provisionClient already are.
 */

import crypto from 'crypto';
import { redactSecrets } from './secretRedaction';

export const META_CONNECT_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function generateConnectLinkToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashConnectLinkToken(token) };
}

export function hashConnectLinkToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface ConnectLinkFields {
  metaConnectLinkTokenHash?: string;
  metaConnectLinkExpiresAt?: string;
  metaConnectLinkUsedAt?: string;
}

export type ConnectLinkInvalidReason = 'not_found' | 'expired' | 'used';
export type ConnectLinkValidation = { ok: true } | { ok: false; reason: ConnectLinkInvalidReason };

/** No client identity or reason ever needs to reach an anonymous caller - the
 * route handler must show the same generic "invalid link" message for every
 * `reason`, so a probing request cannot distinguish "wrong token" from
 * "expired" from "already used" (section 3.2: "אין דליפת מידע"). */
export function validateConnectLinkToken(client: ConnectLinkFields, tokenHash: string, now: number): ConnectLinkValidation {
  if (!client.metaConnectLinkTokenHash || client.metaConnectLinkTokenHash !== tokenHash) return { ok: false, reason: 'not_found' };
  if (client.metaConnectLinkUsedAt) return { ok: false, reason: 'used' };
  const expiresAt = client.metaConnectLinkExpiresAt ? new Date(client.metaConnectLinkExpiresAt).getTime() : NaN;
  if (!Number.isFinite(expiresAt) || expiresAt < now) return { ok: false, reason: 'expired' };
  return { ok: true };
}

export class MetaEmbeddedSignupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaEmbeddedSignupError';
  }
}

async function graphFetch(url: string, init?: RequestInit): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (err: any) {
    throw new MetaEmbeddedSignupError(redactSecrets(`הבקשה ל-Graph API נכשלה: ${err?.message ?? String(err)}`));
  }
  const text = await response.text();
  let body: any;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) {
    const message = body?.error?.message || body?.raw || `HTTP ${response.status}`;
    throw new MetaEmbeddedSignupError(redactSecrets(`שגיאת Graph API (${response.status}): ${message}`));
  }
  return body;
}

/** Step 3.3.2: the one-time `code` is exchanged first, before anything else,
 * because it is short-lived and single-use - see section 0 of the plan. */
export async function exchangeMetaEmbeddedSignupCode(params: {
  graphApiVersion: string; appId: string; appSecret: string; code: string;
}): Promise<{ accessToken: string }> {
  const url = `https://graph.facebook.com/${params.graphApiVersion}/oauth/access_token`
    + `?client_id=${encodeURIComponent(params.appId)}`
    + `&client_secret=${encodeURIComponent(params.appSecret)}`
    + `&code=${encodeURIComponent(params.code)}`;
  const body = await graphFetch(url);
  const accessToken = String(body?.access_token || '').trim();
  if (!accessToken) throw new MetaEmbeddedSignupError('Meta לא החזירה access_token עבור הקוד שהתקבל.');
  return { accessToken };
}

/** Step 3.3.3: never trust wabaId/phoneNumberId as reported by the browser -
 * confirm the exchanged token actually covers this WABA with the scopes we need. */
export async function verifyMetaEmbeddedSignupToken(params: {
  graphApiVersion: string; appId: string; appSecret: string; accessToken: string; wabaId: string;
}): Promise<void> {
  const url = `https://graph.facebook.com/${params.graphApiVersion}/debug_token`
    + `?input_token=${encodeURIComponent(params.accessToken)}`
    + `&access_token=${encodeURIComponent(params.appId)}%7C${encodeURIComponent(params.appSecret)}`;
  const body = await graphFetch(url);
  const data = body?.data;
  if (!data || data.is_valid !== true) throw new MetaEmbeddedSignupError('הטוקן שהתקבל מ-Meta אינו תקף.');
  const scopes: string[] = Array.isArray(data.scopes) ? data.scopes : [];
  for (const required of ['whatsapp_business_management', 'whatsapp_business_messaging']) {
    if (!scopes.includes(required)) throw new MetaEmbeddedSignupError(`לטוקן שהתקבל חסרה ההרשאה ${required}.`);
  }
  const targetIds = new Set<string>();
  for (const scope of Array.isArray(data.granular_scopes) ? data.granular_scopes : []) {
    for (const id of Array.isArray(scope?.target_ids) ? scope.target_ids : []) targetIds.add(String(id));
  }
  if (!targetIds.has(String(params.wabaId))) {
    throw new MetaEmbeddedSignupError('הטוקן שהתקבל אינו מכסה את חשבון ה-WhatsApp Business שאליו הלקוחה מנסה להתחבר.');
  }
}

/**
 * Step 3.3.4, corrected per docs/embedded-signup-coexistence-event-contract-finding-2026-09-29.md:
 * the Coexistence FINISH event only carries `waba_id`, never `phone_number_id`, so the phone
 * number is discovered here server-side - never trusted from the browser. Per the owner's
 * decision on that finding, a WABA with anything other than exactly one phone number at
 * connection time is treated as an error (no picker UI).
 */
export async function discoverMetaDedicatedPhoneNumberId(params: {
  graphApiVersion: string; wabaId: string; accessToken: string;
}): Promise<string> {
  const url = `https://graph.facebook.com/${params.graphApiVersion}/${encodeURIComponent(params.wabaId)}/phone_numbers`;
  const body = await graphFetch(url, { headers: { Authorization: `Bearer ${params.accessToken}` } });
  const ids: string[] = Array.isArray(body?.data)
    ? body.data.map((item: any) => String(item?.id || '').trim()).filter(Boolean)
    : [];
  if (ids.length === 0) throw new MetaEmbeddedSignupError('לא נמצא אף מספר טלפון תחת חשבון ה-WhatsApp Business הזה.');
  if (ids.length > 1) throw new MetaEmbeddedSignupError('נמצא יותר ממספר טלפון אחד תחת חשבון ה-WhatsApp Business הזה. יש לפנות לבעל המערכת.');
  return ids[0];
}

export interface MetaPhoneNumberDetails {
  displayPhoneNumber: string;
  verifiedName?: string;
  qualityRating?: string;
  codeVerificationStatus?: string;
}

export async function getMetaPhoneNumberDetails(params: {
  graphApiVersion: string; phoneNumberId: string; accessToken: string;
}): Promise<MetaPhoneNumberDetails> {
  const url = `https://graph.facebook.com/${params.graphApiVersion}/${encodeURIComponent(params.phoneNumberId)}`
    + '?fields=display_phone_number,verified_name,quality_rating,code_verification_status';
  const body = await graphFetch(url, { headers: { Authorization: `Bearer ${params.accessToken}` } });
  const displayPhoneNumber = String(body?.display_phone_number || '').replace(/\D/g, '');
  if (!displayPhoneNumber) throw new MetaEmbeddedSignupError('Meta לא החזירה מספר תצוגה עבור המספר הייעודי.');
  return {
    displayPhoneNumber,
    verifiedName: body?.verified_name,
    qualityRating: body?.quality_rating,
    codeVerificationStatus: body?.code_verification_status,
  };
}

/** Step 3.3.6: makes `boot1` receive webhooks for this WABA. Idempotent - a
 * repeat call for an already-subscribed WABA is not a failure. */
export async function subscribeMetaWabaApp(params: {
  graphApiVersion: string; wabaId: string; accessToken: string;
}): Promise<void> {
  const url = `https://graph.facebook.com/${params.graphApiVersion}/${encodeURIComponent(params.wabaId)}/subscribed_apps`;
  await graphFetch(url, { method: 'POST', headers: { Authorization: `Bearer ${params.accessToken}` } });
}

/**
 * Section 7.1 of docs/embedded-signup-first-live-test-2026-10-13.md: decide server-side, right
 * after subscribeMetaWabaApp, which Embedded Signup path this number is actually on - never from
 * the browser-reported FINISH event name (`FINISH` vs `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`),
 * because a wrong guess toward register() on a number still active in the WhatsApp Business app
 * risks disconnecting it from that app (see syncMetaSmbAppData's comment below).
 *
 * Checked against Meta's own guide - developers.facebook.com/documentation/business-messaging/
 * whatsapp/embedded-signup/onboarding-business-app-users/ ("Confirm successful onboarding"):
 * `GET /<phone_number_id>?fields=is_on_biz_app,platform_type`, worked example - "if is_on_biz_app
 * is true and platform_type is CLOUD_API, the business phone number is able to use Cloud API and
 * the WhatsApp Business app" (i.e. Coexistence - both signals together). The phone-number node
 * reference (developers.facebook.com/docs/whatsapp/phone-numbers and the "About the Platform"
 * sample response) documents `CLOUD_API` as the value `platform_type` takes for a number that
 * Cloud API can use; no other value is documented there. Per the owner's decision (section 7a):
 * a value other than exactly this combination - either field missing, non-boolean, or
 * `platform_type` anything other than `CLOUD_API` - is treated as "not unambiguous" and stops
 * with an error rather than guessing.
 */
export type MetaOnboardingPath = 'coexistence' | 'cloud_api';

export async function detectMetaOnboardingPath(params: {
  graphApiVersion: string; phoneNumberId: string; accessToken: string;
}): Promise<MetaOnboardingPath> {
  const url = `https://graph.facebook.com/${params.graphApiVersion}/${encodeURIComponent(params.phoneNumberId)}`
    + '?fields=is_on_biz_app,platform_type';
  const body = await graphFetch(url, { headers: { Authorization: `Bearer ${params.accessToken}` } });
  const isOnBizApp = body?.is_on_biz_app;
  const platformType = body?.platform_type;
  if (platformType !== 'CLOUD_API') {
    throw new MetaEmbeddedSignupError(
      `Meta החזירה platform_type לא ידוע עבור המספר הייעודי (${platformType === undefined ? 'חסר' : JSON.stringify(platformType)}). לא ניתן לקבוע את מסלול החיבור בבטחה - יש לפנות לבעל המערכת.`,
    );
  }
  if (isOnBizApp === true) return 'coexistence';
  if (isOnBizApp === false) return 'cloud_api';
  throw new MetaEmbeddedSignupError(
    `Meta החזירה is_on_biz_app לא ידוע עבור המספר הייעודי (${isOnBizApp === undefined ? 'חסר' : JSON.stringify(isOnBizApp)}). לא ניתן לקבוע את מסלול החיבור בבטחה - יש לפנות לבעל המערכת.`,
  );
}

/** Section 7.2: a 6-digit PIN for the Cloud-API-only path's two-step verification. Generated once
 * per client, BEFORE the first register() call, and reused for every later register() (including
 * a retry) - never regenerated, since sending a different PIN than the number's current one would
 * itself be rejected. */
export function generateMetaRegistrationPin(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Section 7.2: the Cloud-API-only path's equivalent of Coexistence's smb_app_data syncs below - a
 * number that is not on the WhatsApp Business app cannot send or receive anything on Cloud API
 * until this succeeds (production incident 2026-10-13, docs/embedded-signup-first-live-test-
 * 2026-10-13.md section 2-3: `#133010 Account not registered`).
 *
 * On calling this again for an already-registered number (e.g. a stray extra "try again" click
 * after a previous run already succeeded): Meta's registration guide
 * (developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/
 * registration/) documents re-registering an already-registered number as a normal, supported
 * operation - used deliberately e.g. after a display-name change - provided the PIN sent matches
 * the number's current one, which is exactly what happens here since the same stored PIN is
 * always reused (generateMetaRegistrationPin's contract above). The only documented hazard is a
 * per-number rate limit (10 register attempts per rolling 72h, error 133016) - not a concern for
 * a manual, human-triggered "connect" or "retry" click. Any failure (that or any other) surfaces
 * as an ordinary thrown MetaEmbeddedSignupError, exactly like every other call in this file - the
 * caller (adminServer.ts) is the one that decides this must not look like a crash.
 */
export async function registerMetaPhoneNumber(params: {
  graphApiVersion: string; phoneNumberId: string; accessToken: string; pin: string;
}): Promise<void> {
  const url = `https://graph.facebook.com/${params.graphApiVersion}/${encodeURIComponent(params.phoneNumberId)}/register`;
  await graphFetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${params.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', pin: params.pin }),
  });
}

export type MetaSmbSyncType = 'smb_app_state_sync' | 'history';

/** Step 3.3.7: on the Coexistence path only, never call .../register (Meta: the number is
 * already registered, and doing so risks disconnecting the business app). These two syncs
 * replace it there and are idempotent - re-running a sync_type is not a failure. The plain
 * Cloud-API path (detectMetaOnboardingPath above) has no business app to sync with and calls
 * registerMetaPhoneNumber below instead - the two are mutually exclusive per connection. */
export async function syncMetaSmbAppData(params: {
  graphApiVersion: string; phoneNumberId: string; accessToken: string; syncType: MetaSmbSyncType;
}): Promise<void> {
  const url = `https://graph.facebook.com/${params.graphApiVersion}/${encodeURIComponent(params.phoneNumberId)}/smb_app_data`;
  await graphFetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${params.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', sync_type: params.syncType }),
  });
}
