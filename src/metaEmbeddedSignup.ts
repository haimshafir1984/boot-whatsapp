/**
 * Embedded Signup for a customer-owned WhatsApp number, Coexistence mode.
 * See docs/embedded-signup-automation-plan-2026-09-28.md (sections 3.1-3.3) and
 * docs/embedded-signup-coexistence-event-contract-finding-2026-09-29.md.
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

export type MetaSmbSyncType = 'smb_app_state_sync' | 'history';

/** Step 3.3.7: Coexistence never calls .../register (Meta: the number is already
 * registered, and doing so risks disconnecting the business app). These two
 * syncs replace it and are idempotent - re-running a sync_type is not a failure. */
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
