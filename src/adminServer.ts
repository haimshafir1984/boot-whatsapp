/**
 * adminServer.ts
 * Express server for the admin dashboard.
 * Serves static files and exposes a REST API for settings and campaigns.
 */

import express from 'express';
import ExcelJS from 'exceljs';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  Storage,
  AdminSettings,
  Campaign,
  CampaignConversationSettings,
  CompletionLink,
  DecisionFlowOption,
  DecisionFlowStep,
  TwilioTemplateDraft,
} from './storage';
import { config } from './config';
import { botState } from './botState';
import { resetWhatsAppSession, startWhatsAppBot, stopWhatsAppBot } from './whatsappLifecycle';
import {
  isGoogleConnected,
  getGoogleAuthUrl,
  handleGoogleCallback,
  disconnectGoogle,
  getGoogleRelayReturnUrl,
} from './googleContacts';
import { createAccessControl } from './accessControl';
import { ManagedClient, OwnerStorage } from './ownerStorage';
import { DokployProvisioner } from './dokployProvisioner';
import { conversationState } from './conversationState';
import { handleIncomingWhatsAppMessage } from './messageFlow';
import { TwilioProvider } from './providers/TwilioProvider';
import { MetaCloudProvider } from './providers/MetaCloudProvider';
import { getTwilioEvents, recordTwilioEvent } from './twilioEvents';
import {
  defaultMetaCampaignEndAt,
  metaCampaignReservesTrigger,
  normalizeMetaTrigger,
  selectMetaRouteCandidate,
} from './metaCampaignRouting';
import {
  AsyncExpiringCache,
  META_CAMPAIGN_CACHE_TTL_MS,
  retryTransientMetaOperation,
} from './metaGatewayReliability';

interface TwilioGatewaySession {
  from: string;
  clientId: string;
  campaignId: string;
  updatedAt: string;
}

interface TwilioGatewaySessionStore {
  get(from: string): TwilioGatewaySession | null;
  set(session: TwilioGatewaySession): void;
  delete(from: string): void;
}

const TWILIO_GATEWAY_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_TWILIO_MESSAGE_LIMIT = 500;
const recentTwilioMessageIds = new Map<string, number>();

function rememberTwilioMessage(id: string): boolean {
  const cleanId = id.trim();
  if (!cleanId) return false;
  if (recentTwilioMessageIds.has(cleanId)) return true;
  recentTwilioMessageIds.set(cleanId, Date.now());
  if (recentTwilioMessageIds.size > RECENT_TWILIO_MESSAGE_LIMIT) {
    const oldest = [...recentTwilioMessageIds.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, recentTwilioMessageIds.size - RECENT_TWILIO_MESSAGE_LIMIT);
    for (const [oldId] of oldest) recentTwilioMessageIds.delete(oldId);
  }
  return false;
}

function normalizeGatewayPhone(value: string): string {
  return value.replace(/^whatsapp:/i, '').replace(/[^\d+]/g, '').replace(/^\+/, '');
}

function normalizeGatewayText(value: string): string {
  return normalizeMetaTrigger(value);
}

function twilioMediaSecret(): string {
  return config.TWILIO_WEBHOOK_TOKEN || config.TWILIO_AUTH_TOKEN;
}

function signTwilioMediaFilename(filename: string): string {
  return crypto.createHmac('sha256', twilioMediaSecret()).update(filename).digest('hex');
}

function twilioMediaTokenMatches(filename: string, provided: unknown): boolean {
  const token = typeof provided === 'string' ? provided.trim() : '';
  const secret = twilioMediaSecret();
  if (!secret || !token) return false;
  const expected = signTwilioMediaFilename(filename);
  const left = Buffer.from(token);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createTwilioGatewaySessionStore(filePath: string): TwilioGatewaySessionStore {
  const load = (): Record<string, TwilioGatewaySession> => {
    try {
      if (!fs.existsSync(filePath)) return {};
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };
  let sessions = load();

  const persist = () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(sessions, null, 2), 'utf8');
  };
  const prune = () => {
    const cutoff = Date.now() - TWILIO_GATEWAY_SESSION_TTL_MS;
    let changed = false;
    for (const [key, session] of Object.entries(sessions)) {
      if (new Date(session.updatedAt).getTime() < cutoff) {
        delete sessions[key];
        changed = true;
      }
    }
    if (changed) persist();
  };

  return {
    get(from: string) {
      prune();
      return sessions[normalizeGatewayPhone(from)] ?? null;
    },
    set(session: TwilioGatewaySession) {
      prune();
      sessions[normalizeGatewayPhone(session.from)] = { ...session, from: normalizeGatewayPhone(session.from) };
      persist();
    },
    delete(from: string) {
      const key = normalizeGatewayPhone(from);
      if (!(key in sessions)) return;
      delete sessions[key];
      persist();
    },
  };
}

interface OwnerClientSummary {
  reachable: boolean;
  error?: string;
  campaignCount: number;
  activeCampaigns: number;
  endedCampaigns: number;
  savedContacts: number;
  pendingContacts: number;
  failedContacts: number;
  whatsappReady: boolean;
  whatsappShouldRun: boolean;
  whatsappLifecycle?: string;
  whatsappListeningReason?: string;
  whatsappRequestedProvider?: string;
  whatsappActualProvider?: string;
  whatsappProviderFallbackReason?: string;
  connectedPhone?: string;
  googleConnected: boolean;
  serviceExpired?: boolean;
  serviceExpiresAt?: string;
  campaigns: Array<{
    id: string;
    name: string;
    active: boolean;
    runtimeStatus?: string;
    triggerPhrase?: string;
    startAt?: string;
    endAt?: string;
    total: number;
    saved: number;
    pending: number;
    failed: number;
    awaitingName: number;
  }>;
}

function getClientBaseUrl(client: ManagedClient): string | null {
  if (!client.managementUrl) return null;
  return new URL('/', client.managementUrl).toString().replace(/\/$/, '');
}

function cookieHeaderFromSetCookie(setCookie: string | null): string {
  if (!setCookie) return '';
  return setCookie
    .split(/,(?=[^;,]+=)/)
    .map((cookie) => cookie.split(';')[0]?.trim())
    .filter(Boolean)
    .join('; ');
}

function ownerTokenMatches(provided: unknown): boolean {
  const expected = process.env.OWNER_ACCESS_TOKEN?.trim();
  if (!expected || typeof provided !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(provided.trim());
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function safeUploadName(name: string): string {
  const ext = path.extname(name).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12);
  const base = crypto.randomUUID();
  return `${base}${ext}`;
}

function deleteUploadedFileFromDisk(filename: string): void {
  const safeName = path.basename(filename);
  if (!safeName || safeName !== filename) return;
  const fullPath = path.join(config.UPLOADS_PATH, safeName);
  if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
}

function escapeVCardValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function normalizeVCardPhone(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.startsWith('+')) return trimmed;
  return `+${trimmed.replace(/[^\d]/g, '')}`;
}

function normalizeTwilioFrom(value: unknown): string | null | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  const withoutPrefix = raw.replace(/^whatsapp:/i, '').trim();
  const compact = withoutPrefix.replace(/[\s().-]/g, '');
  if (!/^\+\d{8,15}$/.test(compact)) return null;
  return `whatsapp:${compact}`;
}

function normalizeSharePhone(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const withoutWhatsappPrefix = raw.replace(/^whatsapp:/i, '');
  const withoutJid = withoutWhatsappPrefix.split('@')[0]?.split(':')[0] ?? withoutWhatsappPrefix;
  return withoutJid.replace(/[^\d]/g, '');
}

function getCampaignSharePhone(storage: Storage): string {
  const profile = storage.getClientProfile();
  if (config.WHATSAPP_PROVIDER === 'TWILIO_API') {
    return normalizeSharePhone(config.TWILIO_FROM) || normalizeSharePhone(profile.whatsappPhone || config.MY_CONTACT.phone);
  }
  if (config.WHATSAPP_PROVIDER === 'META_CLOUD_API') {
    return normalizeSharePhone(config.META_DISPLAY_PHONE_NUMBER) || normalizeSharePhone(profile.whatsappPhone || config.MY_CONTACT.phone);
  }
  return normalizeSharePhone(botState.connectedPhone) || normalizeSharePhone(profile.whatsappPhone) || normalizeSharePhone(config.MY_CONTACT.phone);
}

function normalizeBotReplyDelayMs(value: unknown): number | null | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  const delay = Number(raw);
  if (!Number.isFinite(delay) || delay < 0 || delay > 60_000) return null;
  return Math.round(delay);
}

function buildContactsVCard(contacts: Array<{ name?: string; phone: string }>): string {
  return contacts
    .filter((contact) => contact.phone.trim())
    .map((contact) => {
      const phone = normalizeVCardPhone(contact.phone);
      const name = contact.name?.trim() || phone;
      return [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `FN:${escapeVCardValue(name)}`,
        `TEL;TYPE=CELL:${phone}`,
        'END:VCARD',
      ].join('\r\n');
    })
    .join('\r\n');
}

function twilioConfigured(): boolean {
  return Boolean(config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN && (config.TWILIO_FROM || config.TWILIO_MESSAGING_SERVICE_SID));
}

function metaConfigured(): boolean {
  return Boolean(config.META_ACCESS_TOKEN && config.META_PHONE_NUMBER_ID && config.META_VERIFY_TOKEN);
}

function twilioAuthHeader(): string {
  return `Basic ${Buffer.from(`${config.TWILIO_ACCOUNT_SID}:${config.TWILIO_AUTH_TOKEN}`).toString('base64')}`;
}

function sanitizeTwilioTemplateName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 512);
}

function normalizeTemplateVariables(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object') return {};
  return Object.entries(input as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, value]) => {
    const normalizedKey = key.replace(/[^\d]/g, '');
    if (!normalizedKey) return acc;
    acc[normalizedKey] = String(value ?? '').trim();
    return acc;
  }, {});
}

function cleanTwilioTemplateInput(body: any): Pick<TwilioTemplateDraft, 'friendlyName' | 'templateName' | 'language' | 'category' | 'body' | 'variables'> {
  const friendlyName = String(body?.friendlyName ?? '').trim();
  const templateName = sanitizeTwilioTemplateName(String(body?.templateName ?? friendlyName));
  const language = String(body?.language ?? 'he').trim() || 'he';
  const category = ['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(String(body?.category))
    ? String(body.category) as TwilioTemplateDraft['category']
    : 'MARKETING';
  const templateBody = String(body?.body ?? '').trim();
  return {
    friendlyName,
    templateName,
    language,
    category,
    body: templateBody,
    variables: normalizeTemplateVariables(body?.variables),
  };
}

async function twilioContentRequest(pathName: string, init: RequestInit = {}): Promise<any> {
  if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN) {
    throw new Error('Twilio Account SID/Auth Token are not configured.');
  }
  const response = await fetch(`https://content.twilio.com/v1${pathName}`, {
    ...init,
    headers: {
      Authorization: twilioAuthHeader(),
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const responseBody = await response.json().catch(async () => ({ raw: await response.text().catch(() => '') })) as any;
  if (!response.ok) {
    throw new Error(`Twilio Content API failed (${response.status}): ${JSON.stringify(responseBody).slice(0, 500)}`);
  }
  return responseBody;
}

function validateTwilioSignature(req: express.Request): boolean {
  if (!config.TWILIO_REQUIRE_SIGNATURE) return true;
  const signature = req.get('x-twilio-signature');
  if (!signature || !config.TWILIO_AUTH_TOKEN) return false;
  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0]?.trim();
  const protocol = forwardedProto || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  if (!host) return false;
  const params = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const urls = Array.from(new Set([
    `${protocol}://${host}${req.originalUrl}`,
    `https://${host}${req.originalUrl}`,
  ]));
  return urls.some((url) => {
    const data = Object.keys(params)
      .sort()
      .reduce((acc, key) => `${acc}${key}${String(params[key] ?? '')}`, url);
    const expected = crypto
      .createHmac('sha1', config.TWILIO_AUTH_TOKEN)
      .update(data)
      .digest('base64');
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  });
}

function getClientCapabilities(storage: Storage) {
  const expiresAt = config.CLIENT_SERVICE_EXPIRES_AT || undefined;
  const expiresTime = expiresAt ? new Date(expiresAt).getTime() : Number.POSITIVE_INFINITY;
  const serviceExpired = Number.isFinite(expiresTime) && Date.now() > expiresTime;
  const campaignCount = storage.getCampaigns().length;
  return {
    plan: config.CLIENT_PLAN,
    readonlyDashboard: config.CLIENT_READONLY_DASHBOARD,
    maxCampaigns: config.CLIENT_MAX_CAMPAIGNS,
    serviceExpiresAt: expiresAt,
    serviceExpired,
    whatsappProvider: config.WHATSAPP_PROVIDER,
    twilioConfigured: twilioConfigured(),
    campaignCount,
    referralContestEnabled: config.CLIENT_REFERRAL_CONTEST_ENABLED || campaignCount === 0,
  };
}

async function fetchClientSummary(client: ManagedClient): Promise<OwnerClientSummary> {
  const empty: OwnerClientSummary = {
    reachable: false,
    campaignCount: 0,
    activeCampaigns: 0,
    endedCampaigns: 0,
    savedContacts: 0,
    pendingContacts: 0,
    failedContacts: 0,
    whatsappReady: false,
    whatsappShouldRun: false,
    googleConnected: false,
    campaigns: [],
  };
  const baseUrl = getClientBaseUrl(client);
  if (!baseUrl) return { ...empty, error: 'Client URL is not ready yet' };

  const login = await fetch(`${baseUrl}/auth/client/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessCode: client.accessCode }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!login.ok) {
    return { ...empty, error: `Client login failed (${login.status})` };
  }
  const cookie = cookieHeaderFromSetCookie(login.headers.get('set-cookie'));
  if (!cookie) return { ...empty, error: 'Client session cookie was not returned' };

  const getJson = async <T>(pathName: string): Promise<T | null> => {
    const response = await fetch(`${baseUrl}${pathName}`, {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    return await response.json() as T;
  };

  const [campaigns, results, queue, google, qr, capabilities] = await Promise.all([
    getJson<any[]>('/api/campaigns'),
    getJson<{ summaries: any[] }>('/api/campaign-results'),
    getJson<{ stats: { pending: number; saved: number; failed: number; total: number } }>('/api/contacts/queue?limit=1'),
    getJson<{ connected: boolean }>('/api/google/status'),
    getJson<{
      ready: boolean;
      authenticated: boolean;
      lifecycle?: string;
      listeningReason?: string;
      shouldRun?: boolean;
      connectedPhone?: string;
      requestedProvider?: string;
      actualProvider?: string;
      providerFallbackReason?: string;
    }>('/api/qr'),
    getJson<{ serviceExpired?: boolean; serviceExpiresAt?: string; campaignCount?: number }>('/api/capabilities'),
  ]);

  const summaries = new Map((results?.summaries ?? []).map((summary) => [summary.campaignId, summary]));
  const campaignRows = (campaigns ?? []).map((campaign) => {
    const summary = summaries.get(campaign.id) ?? {};
    return {
      id: campaign.id,
      name: campaign.name,
      active: Boolean(campaign.active),
      runtimeStatus: campaign.runtimeStatus,
      triggerPhrase: campaign.triggerPhrase,
      startAt: campaign.startAt,
      endAt: campaign.endAt,
      total: Number(summary.total ?? 0),
      saved: Number(summary.saved ?? 0),
      pending: Number(summary.pending ?? 0),
      failed: Number(summary.failed ?? 0),
      awaitingName: Number(summary.awaitingName ?? 0),
    };
  });

  return {
    reachable: true,
    campaignCount: Number(capabilities?.campaignCount ?? campaignRows.length),
    activeCampaigns: campaignRows.filter((campaign) => campaign.runtimeStatus === 'active').length,
    endedCampaigns: campaignRows.filter((campaign) => campaign.runtimeStatus === 'ended').length,
    savedContacts: Number(queue?.stats?.saved ?? 0),
    pendingContacts: Number(queue?.stats?.pending ?? 0),
    failedContacts: Number(queue?.stats?.failed ?? 0),
    whatsappReady: Boolean(qr?.ready || qr?.authenticated),
    whatsappShouldRun: Boolean(qr?.shouldRun),
    whatsappLifecycle: qr?.lifecycle,
    whatsappListeningReason: qr?.listeningReason,
    whatsappRequestedProvider: qr?.requestedProvider,
    whatsappActualProvider: qr?.actualProvider,
    whatsappProviderFallbackReason: qr?.providerFallbackReason,
    connectedPhone: qr?.connectedPhone,
    googleConnected: Boolean(google?.connected),
    serviceExpired: Boolean(capabilities?.serviceExpired),
    serviceExpiresAt: capabilities?.serviceExpiresAt,
    campaigns: campaignRows,
  };
}

async function fetchClientAsOwner<T>(
  client: ManagedClient,
  pathName: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; body: T | any }> {
  const baseUrl = getClientBaseUrl(client);
  if (!baseUrl) return { ok: false, status: 409, body: { error: 'Client URL is not ready yet' } };
  if (!client.ownerAccessToken) return { ok: false, status: 409, body: { error: 'Owner token is missing. Reprovision this client.' } };

  const headers = new Headers(init.headers);
  headers.set('Content-Type', headers.get('Content-Type') || 'application/json');
  headers.set('X-Owner-Token', client.ownerAccessToken);

  const response = await fetch(`${baseUrl}${pathName}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

function conversationSettings(
  input: Partial<CampaignConversationSettings> | undefined,
  defaults: CampaignConversationSettings,
): CampaignConversationSettings {
  const contactCards = sanitizeContactCards(input, defaults);
  const primaryContactCard = contactCards[0] ?? {};
  return {
    askNameEnabled: typeof input?.askNameEnabled === 'boolean' ? input.askNameEnabled : defaults.askNameEnabled,
    nameTimeoutMinutes: typeof input?.nameTimeoutMinutes === 'number' && input.nameTimeoutMinutes > 0
      ? input.nameTimeoutMinutes
      : defaults.nameTimeoutMinutes,
    askNameText: typeof input?.askNameText === 'string' ? input.askNameText : defaults.askNameText,
    preNamePromptText: typeof input?.preNamePromptText === 'string'
      ? input.preNamePromptText.trim().slice(0, 2000)
      : (defaults.preNamePromptText ?? ''),
    preNamePromptAutoContinue: typeof input?.preNamePromptAutoContinue === 'boolean'
      ? input.preNamePromptAutoContinue
      : (defaults.preNamePromptAutoContinue ?? true),
    preNamePromptTimeoutMinutes: typeof input?.preNamePromptTimeoutMinutes === 'number' && input.preNamePromptTimeoutMinutes > 0
      ? Math.min(Math.max(Math.round(input.preNamePromptTimeoutMinutes), 1), 60)
      : (defaults.preNamePromptTimeoutMinutes ?? 1),
    replyText: typeof input?.replyText === 'string' ? input.replyText : defaults.replyText,
    completionLinks: sanitizeCompletionLinks(input?.completionLinks, defaults.completionLinks ?? []),
    completionFileIds: Array.isArray(input?.completionFileIds)
      ? input.completionFileIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())).map((id) => id.trim().slice(0, 80)).slice(0, 10)
      : (defaults.completionFileIds ?? []),
    sendContactCard: typeof input?.sendContactCard === 'boolean'
      ? input.sendContactCard
      : Boolean(defaults.sendContactCard),
    contactCardPlacement: input?.contactCardPlacement === 'before_questions'
      ? 'before_questions'
      : (defaults.contactCardPlacement ?? 'after_completion'),
    contactCardSendMode: input?.contactCardSendMode === 'combined' || input?.contactCardSendMode === 'separate'
      ? input.contactCardSendMode
      : (defaults.contactCardSendMode ?? 'separate'),
    contactCards,
    contactCardName: primaryContactCard.name ?? '',
    contactCardPhone: primaryContactCard.phone ?? '',
    contactCardEmail: primaryContactCard.email ?? '',
    contactCardOrganization: primaryContactCard.organization ?? '',
    contactCardIntroText: typeof input?.contactCardIntroText === 'string'
      ? input.contactCardIntroText.trim().slice(0, 2000)
      : (defaults.contactCardIntroText ?? ''),
    contactCardWaitForConfirmation: typeof input?.contactCardWaitForConfirmation === 'boolean'
      ? input.contactCardWaitForConfirmation
      : Boolean(defaults.contactCardWaitForConfirmation),
    contactCardConfirmationTimeoutMinutes: typeof input?.contactCardConfirmationTimeoutMinutes === 'number' && input.contactCardConfirmationTimeoutMinutes > 0
      ? Math.min(Math.max(Math.round(input.contactCardConfirmationTimeoutMinutes), 1), 1440)
      : (defaults.contactCardConfirmationTimeoutMinutes ?? 30),
    followupMessages: Array.isArray(input?.followupMessages)
      ? input.followupMessages.filter((message): message is string => typeof message === 'string')
      : defaults.followupMessages,
    decisionFlow: sanitizeDecisionFlow(input?.decisionFlow, defaults.decisionFlow, config.CLIENT_REFERRAL_CONTEST_ENABLED),
    decisionTimeoutMinutes: typeof input?.decisionTimeoutMinutes === 'number' && input.decisionTimeoutMinutes > 0
      ? Math.min(Math.max(Math.round(input.decisionTimeoutMinutes), 1), 1440)
      : (defaults.decisionTimeoutMinutes ?? 30),
    decisionTimeoutText: typeof input?.decisionTimeoutText === 'string'
      ? input.decisionTimeoutText.trim().slice(0, 2000)
      : (defaults.decisionTimeoutText ?? ''),
    humanHandoffEnabled: typeof input?.humanHandoffEnabled === 'boolean'
      ? input.humanHandoffEnabled
      : Boolean(defaults.humanHandoffEnabled),
    humanHandoffText: typeof input?.humanHandoffText === 'string'
      ? input.humanHandoffText.trim().slice(0, 2000)
      : (defaults.humanHandoffText ?? ''),
    humanHandoffPhone: typeof input?.humanHandoffPhone === 'string'
      ? input.humanHandoffPhone.replace(/[^\d+]/g, '').slice(0, 30)
      : (defaults.humanHandoffPhone ?? ''),
  };
}

function sanitizeContactCards(
  input: Partial<CampaignConversationSettings> | undefined,
  defaults: CampaignConversationSettings,
): NonNullable<CampaignConversationSettings['contactCards']> {
  const fallbackCard = {
    name: input?.contactCardName ?? defaults.contactCardName,
    phone: input?.contactCardPhone ?? defaults.contactCardPhone,
    email: input?.contactCardEmail ?? defaults.contactCardEmail,
    organization: input?.contactCardOrganization ?? defaults.contactCardOrganization,
  };
  const source = Array.isArray(input?.contactCards)
    ? input.contactCards
    : (Array.isArray(defaults.contactCards) && defaults.contactCards.length ? defaults.contactCards : [fallbackCard]);
  return source
    .map((item) => ({
      name: typeof item?.name === 'string' ? item.name.trim().slice(0, 120) : '',
      phone: typeof item?.phone === 'string' ? item.phone.replace(/[^\d+]/g, '').slice(0, 30) : '',
      email: typeof item?.email === 'string' ? item.email.trim().slice(0, 160) : '',
      organization: typeof item?.organization === 'string' ? item.organization.trim().slice(0, 120) : '',
    }))
    .filter((item) => item.name || item.phone || item.email || item.organization)
    .slice(0, 2);
}

function sanitizeCompletionLinks(input: unknown, defaults: CompletionLink[]): CompletionLink[] {
  if (!Array.isArray(input)) return defaults;
  return input
    .map((raw): CompletionLink | null => {
      if (!raw || typeof raw !== 'object') return null;
      const item = raw as Partial<CompletionLink>;
      const label = typeof item.label === 'string' ? item.label.trim().slice(0, 120) : '';
      const url = typeof item.url === 'string' ? item.url.trim().slice(0, 1000) : '';
      if (!url) return null;
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      } catch {
        return null;
      }
      return { label: label || url, url };
    })
    .filter((link): link is CompletionLink => Boolean(link))
    .slice(0, 10);
}

function sanitizeDecisionFlow(
  input: unknown,
  defaults: DecisionFlowStep[],
  referralContestEnabled = false,
): DecisionFlowStep[] {
  if (!Array.isArray(input)) return defaults;

  const steps = input
    .map((raw, index): DecisionFlowStep | null => {
      if (!raw || typeof raw !== 'object') return null;
      const item = raw as Partial<DecisionFlowStep>;
      const id = typeof item.id === 'string' && item.id.trim()
        ? item.id.trim().slice(0, 80)
        : `step-${index + 1}`;
      const kind = item.kind === 'question' || item.kind === 'score_question' || item.kind === 'score_result' || item.kind === 'wait_reply' || item.kind === 'contact_card' || (referralContestEnabled && item.kind === 'referral_share') ? item.kind : 'message';
      let text = typeof item.text === 'string' ? item.text.trim().slice(0, 2000) : '';
      if (!text && kind === 'score_result') text = '\u05d7\u05d9\u05e9\u05d5\u05d1 \u05ea\u05d5\u05e6\u05d0\u05d4';
      const fileId = typeof item.fileId === 'string' ? item.fileId.trim().slice(0, 80) : '';
      const canSendWithoutText = kind === 'contact_card' || (kind === 'message' && Boolean(fileId));
      if (!text && !canSendWithoutText) return null;

      const step: DecisionFlowStep = { id, kind, text };
      if (typeof item.nextStepId === 'string' && item.nextStepId.trim()) {
        step.nextStepId = item.nextStepId.trim().slice(0, 80);
      }
      if (typeof item.delayMs === 'number' && Number.isFinite(item.delayMs) && item.delayMs > 0) {
        step.delayMs = Math.min(Math.max(Math.round(item.delayMs), 0), 60_000);
      }
      if (kind === 'message') {
        if (fileId) step.fileId = fileId;
        if (typeof item.fileAsSticker === 'boolean') {
          step.fileAsSticker = item.fileAsSticker;
        }
      }
      if ((kind === 'wait_reply' || kind === 'referral_share') && typeof item.timeoutMinutes === 'number' && item.timeoutMinutes > 0) {
        step.timeoutMinutes = Math.min(Math.max(Math.round(item.timeoutMinutes), 1), 1440);
      }
      if (kind === 'score_result') {
        const rawRules = Array.isArray(item.resultRules) ? item.resultRules : [];
        step.resultRules = rawRules
          .map((rule, ruleIndex) => {
            if (!rule || typeof rule !== 'object') return null;
            const rawRule = rule as any;
            const type = rawRule.type === 'majority' || rawRule.type === 'sum_range' ? rawRule.type : null;
            if (!type) return null;
            const clean: NonNullable<DecisionFlowStep['resultRules']>[number] = {
              id: typeof rawRule.id === 'string' && rawRule.id.trim() ? rawRule.id.trim().slice(0, 80) : `${id}-rule-${ruleIndex + 1}`,
              type,
            };
            if (typeof rawRule.label === 'string' && rawRule.label.trim()) clean.label = rawRule.label.trim().slice(0, 160);
            if (typeof rawRule.value === 'number' && Number.isFinite(rawRule.value)) clean.value = Math.round(rawRule.value);
            if (typeof rawRule.min === 'number' && Number.isFinite(rawRule.min)) clean.min = Math.round(rawRule.min);
            if (typeof rawRule.max === 'number' && Number.isFinite(rawRule.max)) clean.max = Math.round(rawRule.max);
            if (typeof rawRule.nextStepId === 'string' && rawRule.nextStepId.trim()) clean.nextStepId = rawRule.nextStepId.trim().slice(0, 80);
            if (typeof rawRule.endText === 'string' && rawRule.endText.trim()) clean.endText = rawRule.endText.trim().slice(0, 2000);
            if (typeof rawRule.fileId === 'string' && rawRule.fileId.trim()) clean.fileId = rawRule.fileId.trim().slice(0, 80);
            if (typeof rawRule.fileAsSticker === 'boolean') clean.fileAsSticker = rawRule.fileAsSticker;
            return clean;
          })
          .filter((rule): rule is NonNullable<DecisionFlowStep['resultRules']>[number] => Boolean(rule))
          .slice(0, 10);
        if (typeof item.fallbackText === 'string' && item.fallbackText.trim()) {
          step.fallbackText = item.fallbackText.trim().slice(0, 2000);
        }
        if (typeof item.fallbackNextStepId === 'string' && item.fallbackNextStepId.trim()) {
          step.fallbackNextStepId = item.fallbackNextStepId.trim().slice(0, 80);
        }
      }
      if (kind === 'question' || kind === 'score_question') {
        const rawOptions = Array.isArray(item.options) ? item.options : [];

        if (item.presentation === 'text' || item.presentation === 'buttons' || item.presentation === 'list') {
          step.presentation = item.presentation;
        }
        if (typeof item.timeoutMinutes === 'number' && item.timeoutMinutes > 0) {
          step.timeoutMinutes = Math.min(Math.max(Math.round(item.timeoutMinutes), 1), 1440);
        }
        if (typeof item.timeoutText === 'string' && item.timeoutText.trim()) {
          step.timeoutText = item.timeoutText.trim().slice(0, 2000);
        }
        if (typeof item.timeoutFileId === 'string' && item.timeoutFileId.trim()) {
          step.timeoutFileId = item.timeoutFileId.trim().slice(0, 80);
        }
        if (typeof item.timeoutFileAsSticker === 'boolean') {
          step.timeoutFileAsSticker = item.timeoutFileAsSticker;
        }
        step.options = rawOptions
          .map((option, optionIndex): DecisionFlowOption | null => {
            if (!option || typeof option !== 'object') return null;
            const rawOption = option as Partial<DecisionFlowOption>;
            const optionText = typeof rawOption.text === 'string' ? rawOption.text.trim().slice(0, 500) : '';
            if (!optionText) return null;
            const clean: DecisionFlowOption = {
              id: typeof rawOption.id === 'string' && rawOption.id.trim()
                ? rawOption.id.trim().slice(0, 80)
                : `${id}-option-${optionIndex + 1}`,
              text: optionText,
            };
            if (typeof rawOption.nextStepId === 'string' && rawOption.nextStepId.trim()) {
              clean.nextStepId = rawOption.nextStepId.trim().slice(0, 80);
            }
            if (typeof rawOption.endText === 'string' && rawOption.endText.trim()) {
              clean.endText = rawOption.endText.trim().slice(0, 2000);
            }
            if (typeof rawOption.fileId === 'string' && rawOption.fileId.trim()) {
              clean.fileId = rawOption.fileId.trim().slice(0, 80);
            }
            if (typeof rawOption.fileAsSticker === 'boolean') {
              clean.fileAsSticker = rawOption.fileAsSticker;
            }
            if (typeof rawOption.score === 'number' && Number.isFinite(rawOption.score)) {
              clean.score = Math.round(rawOption.score);
            }
            return clean;
          })
          .filter((option): option is DecisionFlowOption => Boolean(option))
          .slice(0, step.presentation === 'buttons' || !step.presentation ? 3 : 10);
      }
      return step;
    })
    .filter((step): step is DecisionFlowStep => Boolean(step))
    .filter((step, index, list) => step.kind !== 'contact_card' || list.findIndex((item) => item.kind === 'contact_card') === index)
    .slice(0, 20);

  const ids = new Set(steps.map((step) => step.id));
  return steps.map((step, index) => {
    const nextSequentialStepId = steps[index + 1]?.id;
    const stepNextStepId = step.nextStepId === '__NEXT__' ? nextSequentialStepId : step.nextStepId;
    return {
      ...step,
      nextStepId: stepNextStepId && ids.has(stepNextStepId) ? stepNextStepId : undefined,
      fallbackNextStepId: step.fallbackNextStepId && ids.has(step.fallbackNextStepId) ? step.fallbackNextStepId : undefined,
      resultRules: step.resultRules?.map((rule) => ({
        ...rule,
        nextStepId: rule.nextStepId && ids.has(rule.nextStepId) ? rule.nextStepId : undefined,
      })),
      options: step.options?.map((option) => {
        const optionNextStepId = option.nextStepId === '__NEXT__' ? nextSequentialStepId : option.nextStepId;
        return {
          ...option,
          nextStepId: optionNextStepId && ids.has(optionNextStepId) ? optionNextStepId : undefined,
        };
      }),
    };
  });
}

function campaignTwilioSettings(input: any): Campaign['twilio'] {
  const mode = input?.mode === 'template' ? 'template' : 'link';
  return {
    mode,
    templateId: mode === 'template' && typeof input?.templateId === 'string' ? input.templateId.trim() : undefined,
    optInConfirmed: Boolean(input?.optInConfirmed),
    audienceNotes: typeof input?.audienceNotes === 'string' ? input.audienceNotes.trim() : undefined,
  };
}

function buildCampaignDryRun(campaign: Campaign, storage: Storage) {
  const conversation = storage.getCampaignConversationSettings(campaign);
  const messages: Array<{ from: 'user' | 'bot' | 'system'; text: string }> = [
    { from: 'user', text: campaign.triggerPhrase },
  ];
  if (conversation.askNameEnabled) {
    if (conversation.preNamePromptText?.trim()) {
      messages.push({
        from: 'bot',
        text: conversation.preNamePromptText.trim(),
      });
      messages.push({ from: 'user', text: 'שמרתי' });
    }
    messages.push({
      from: 'bot',
      text: conversation.askNameText.replace('{timeout}', String(conversation.nameTimeoutMinutes)),
    });
    messages.push({ from: 'user', text: 'שם לדוגמה' });
  }
  const dryRunContactCardText = conversation.sendContactCard
    ? `איש קשר לשמירה: ${conversation.contactCardName || 'איש קשר'}`
    : '';
  const contactCardIsEarly = Boolean(dryRunContactCardText && conversation.contactCardPlacement === 'before_questions');
  if (conversation.replyText.trim() && !contactCardIsEarly) {
    messages.push({ from: 'bot', text: conversation.replyText.trim() });
  }
  if (contactCardIsEarly) {
    if (conversation.contactCardIntroText?.trim()) messages.push({ from: 'bot', text: conversation.contactCardIntroText.trim() });
    messages.push({ from: 'bot', text: dryRunContactCardText });
    if (conversation.contactCardWaitForConfirmation) messages.push({ from: 'user', text: 'שמרתי' });
  }
  if (conversation.completionLinks?.length) {
    messages.push({
      from: 'bot',
      text: conversation.completionLinks.map((link) => `${link.label}: ${link.url}`).join('\n'),
    });
  }
  for (const fileId of conversation.completionFileIds ?? []) {
    const file = storage.getUploadedFile(fileId);
    messages.push({ from: 'bot', text: file ? `קובץ סיום: ${file.originalName}` : 'קובץ סיום לא זמין' });
  }
  for (const followup of conversation.followupMessages) {
    if (followup.trim()) messages.push({ from: 'bot', text: followup.trim() });
  }
  if (dryRunContactCardText && conversation.contactCardPlacement !== 'before_questions') {
    if (conversation.contactCardIntroText?.trim()) messages.push({ from: 'bot', text: conversation.contactCardIntroText.trim() });
    messages.push({ from: 'bot', text: dryRunContactCardText });
  }
  const flow = conversation.decisionFlow || [];
  const visited = new Set<string>();
  let step = flow.find((item) => item.text.trim());
  while (step && !visited.has(step.id) && visited.size < 20) {
    visited.add(step.id);
    if (step.kind === 'contact_card') {
      if (step.text.trim()) messages.push({ from: 'bot', text: step.text.trim() });
      messages.push({ from: 'bot', text: dryRunContactCardText || `Contact card: ${conversation.contactCardName || 'Contact'}` });
      const nextStepId = step.nextStepId;
      step = nextStepId ? flow.find((item) => item.id === nextStepId) : undefined;
    } else if (step.kind === 'question') {
      const options = (step.options ?? []).map((option, index) => `${index + 1}. ${option.text}`).join('\n');
      messages.push({ from: 'bot', text: options ? `${step.text.trim()}\n\n${options}` : step.text.trim() });
      const selected = step.options?.[0];
      if (!selected) break;
      messages.push({ from: 'user', text: selected.text });
      if (selected.fileId) {
        const file = storage.getUploadedFile(selected.fileId);
        messages.push({ from: 'bot', text: file ? `קובץ לדוגמה: ${file.originalName}` : 'קובץ לא זמין' });
      }
      if (selected.endText?.trim()) messages.push({ from: 'bot', text: selected.endText.trim() });
      step = selected.nextStepId ? flow.find((item) => item.id === selected.nextStepId) : undefined;
    } else {
      messages.push({ from: 'bot', text: step.text.trim() });
      const nextStepId = step.nextStepId;
      step = nextStepId ? flow.find((item) => item.id === nextStepId) : undefined;
    }
  }
  if (conversation.humanHandoffEnabled) {
    messages.push({ from: 'system', text: 'אם המשתמש ישאל משהו שלא קשור לבחירות, תישלח הודעת מעבר לנציג.' });
  }
  return {
    campaignId: campaign.id,
    campaignName: campaign.name,
    triggerPhrase: campaign.triggerPhrase,
    messages,
  };
}

export function startAdminServer(storage: Storage): void {
  const app = express();
  const publicDir = path.join(__dirname, '..', 'public');
  const ownerPublicDir = path.join(__dirname, '..', 'owner-public');
  const sitePublicDir = path.join(__dirname, '..', 'site-public');
  const publicSiteEnabled = process.env.PUBLIC_SITE_ENABLED === 'true';
  const ownerStorage = new OwnerStorage(config.OWNER_STORAGE_PATH);
  const dokployProvisioner = new DokployProvisioner();
  const access = createAccessControl();
  const twilioGatewaySessions = createTwilioGatewaySessionStore(
    path.join(path.dirname(config.OWNER_STORAGE_PATH), 'twilio-gateway-sessions.json'),
  );
  const metaGatewaySessions = createTwilioGatewaySessionStore(
    path.join(path.dirname(config.OWNER_STORAGE_PATH), 'meta-gateway-sessions.json'),
  );
  const metaCampaignCache = new AsyncExpiringCache<Campaign[]>(META_CAMPAIGN_CACHE_TTL_MS);

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '24mb' }));
  app.use(express.urlencoded({ extended: false }));

  const managedClientForOwnerToken = (provided: unknown): ManagedClient | null => {
    if (typeof provided !== 'string' || !provided.trim()) return null;
    const right = Buffer.from(provided.trim());
    return ownerStorage.getClients().find((client) => {
      const left = Buffer.from(client.ownerAccessToken || '');
      return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
    }) ?? null;
  };

  const inspectMetaTriggerAvailability = async (requester: ManagedClient, triggerPhrase: string, campaignId?: string) => {
    const normalizedTrigger = normalizeMetaTrigger(triggerPhrase);
    if (!normalizedTrigger) return { available: false, conflicts: [] };
    const metaClients = ownerStorage.getClients().filter((client) =>
      client.whatsappProvider === 'META_CLOUD_API' && client.managementUrl && client.ownerAccessToken && client.provisioningStatus !== 'disabled');
    const results = await Promise.all(metaClients.map(async (client) => ({
      client,
      result: await fetchClientAsOwner<Campaign[]>(client, '/owner-api/campaigns'),
    })));
    const unavailable = results.filter(({ result }) => !result.ok || !Array.isArray(result.body));
    if (unavailable.length) throw new Error(`Could not verify Meta triggers for ${unavailable.length} managed client(s).`);
    const conflicts: Array<{ clientId: string; campaignId: string; campaignName: string }> = [];
    for (const { client, result } of results) {
      for (const campaign of result.body as Campaign[]) {
        if (client.id === requester.id && campaign.id === campaignId) continue;
        if (!metaCampaignReservesTrigger(campaign)) continue;
        if (normalizeMetaTrigger(campaign.triggerPhrase || '') !== normalizedTrigger) continue;
        conflicts.push({ clientId: client.id, campaignId: campaign.id, campaignName: campaign.name });
      }
    }
    return { available: conflicts.length === 0, conflicts };
  };

  const campaignWouldReserveTrigger = (active: boolean, endAt?: string): boolean => {
    if (!active) return false;
    if (!endAt) return true;
    const end = new Date(endAt).getTime();
    return Number.isNaN(end) || end >= Date.now();
  };

  const verifyMetaTriggerBeforeActivation = async (triggerPhrase: string, campaignId?: string) => {
    if (config.WHATSAPP_PROVIDER !== 'META_CLOUD_API') return { ok: true, status: 200 };
    const ownerToken = process.env.OWNER_ACCESS_TOKEN?.trim();
    if (!ownerToken) return { ok: false, status: 503, error: 'לא ניתן לבדוק כרגע אם משפט הטריגר פנוי. יש לפנות למנהל המערכת.', code: 'META_TRIGGER_CHECK_UNAVAILABLE' };
    try {
      const url = new URL('/internal/meta/trigger-availability', config.META_GATEWAY_BASE_URL).toString();
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Owner-Token': ownerToken },
        body: JSON.stringify({ triggerPhrase, campaignId }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json().catch(() => ({})) as { available?: boolean; error?: string };
      if (!response.ok) return { ok: false, status: response.status, error: body.error || 'בדיקת משפט הטריגר נכשלה.', code: 'META_TRIGGER_CHECK_UNAVAILABLE' };
      if (body.available !== true) return { ok: false, status: 409, error: 'משפט הטריגר הזה כבר תפוס בקמפיין Meta פעיל. יש לבחור משפט טריגר אחר.', code: 'META_TRIGGER_OCCUPIED' };
      return { ok: true, status: 200 };
    } catch (err) {
      console.error('[META_TRIGGER_CHECK_FAILED]', err);
      return { ok: false, status: 503, error: 'לא ניתן לבדוק כרגע אם משפט הטריגר פנוי. נסה שוב בעוד רגע.', code: 'META_TRIGGER_CHECK_UNAVAILABLE' };
    }
  };

  app.post('/internal/meta/trigger-availability', async (req, res) => {
    const requester = managedClientForOwnerToken(req.get('x-owner-token'));
    if (!requester || requester.whatsappProvider !== 'META_CLOUD_API') {
      res.status(401).json({ error: 'Managed client token is invalid' });
      return;
    }
    const triggerPhrase = String(req.body?.triggerPhrase || '').trim();
    if (!triggerPhrase) {
      res.status(400).json({ error: 'Trigger phrase is required' });
      return;
    }
    try {
      res.json(await inspectMetaTriggerAvailability(requester, triggerPhrase, String(req.body?.campaignId || '').trim() || undefined));
    } catch (err) {
      console.error('[META_TRIGGER_REGISTRY_FAILED]', err);
      res.status(503).json({ error: 'Could not verify all managed Meta campaign triggers' });
    }
  });

  app.get('/client/login', (_req, res) => {
    res.sendFile(path.join(publicDir, 'login.html'));
  });
  app.get('/login', (_req, res) => {
    res.redirect('/client/login');
  });
  app.get('/owner/login', (_req, res) => {
    res.sendFile(path.join(ownerPublicDir, 'login.html'));
  });
  app.get('/health', (_req, res) => {
    const campaigns = storage.getCampaigns();
    const activeCampaigns = campaigns.filter((campaign) => campaign.runtimeStatus === 'active');
    const queueStats = storage.getContactQueueStats();
    const twilioEvents = getTwilioEvents(5);
    res.json({
      ok: true,
      clientConfigured: Boolean(process.env.CLIENT_ACCESS_TOKEN?.trim()),
      whatsappProvider: config.WHATSAPP_PROVIDER,
      twilioConfigured: twilioConfigured(),
      googleConnected: isGoogleConnected(),
      readonlyDashboard: config.CLIENT_READONLY_DASHBOARD,
      serviceExpiresAt: config.CLIENT_SERVICE_EXPIRES_AT || null,
      campaigns: {
        total: campaigns.length,
        active: activeCampaigns.length,
        scheduled: campaigns.filter((campaign) => campaign.runtimeStatus === 'scheduled').length,
        ended: campaigns.filter((campaign) => campaign.runtimeStatus === 'ended').length,
        disabled: campaigns.filter((campaign) => campaign.runtimeStatus === 'disabled').length,
      },
      contactQueue: queueStats,
      conversations: {
        pending: conversationState.size(),
      },
      whatsapp: {
        ready: botState.ready,
        authenticated: botState.authenticated,
        lifecycle: botState.lifecycle,
        shouldRun: storage.hasCampaignsNeedingBot(),
        notReadySince: botState.notReadySince ? new Date(botState.notReadySince).toISOString() : null,
        reconnectAttempts: botState.reconnectAttempts,
        lastReconnectAt: botState.lastReconnectAt,
        lastWatchdogRestartAt: botState.lastWatchdogRestartAt,
        connectedPhone: (botState.connectedPhone ?? storage.getClientProfile().whatsappPhone) || null,
        listeningReason: botState.listeningReason,
        requestedProvider: botState.requestedProvider,
        actualProvider: botState.actualProvider,
        providerFallbackReason: botState.providerFallbackReason,
      },
      twilio: {
        configured: twilioConfigured(),
        recentEvents: twilioEvents,
        lastEventAt: twilioEvents[0]?.at ?? null,
      },
    });
  });

  const twilioInboundMeta = (payload: any) => ({
    body: String(payload?.ButtonPayload ?? payload?.ListId ?? payload?.ButtonText ?? payload?.Body ?? '').trim(),
    from: String(payload?.From ?? '').trim(),
    to: String(payload?.To ?? '').trim(),
    id: String(payload?.MessageSid ?? payload?.SmsMessageSid ?? (String(payload?.From ?? '') + ':' + Date.now())),
    profileName: String(payload?.ProfileName ?? '').trim(),
  });

  const handleTwilioInboundForStorage = async (payload: any): Promise<void> => {
    const meta = twilioInboundMeta(payload);
    if (!meta.from) throw new Error('Missing From');
    recordTwilioEvent({
      direction: 'inbound',
      status: 'received',
      from: meta.from,
      to: meta.to,
      body: meta.body,
      messageSid: meta.id,
    });
    const provider = new TwilioProvider();
    await handleIncomingWhatsAppMessage({
      id: meta.id,
      from: meta.from,
      to: meta.to,
      body: meta.body,
      timestamp: Math.floor(Date.now() / 1000),
      async getDisplayName() {
        return meta.profileName;
      },
    }, storage, {
      sendMessage: (target, message) => provider.sendMessage(target, message),
      sendFile: (target, filePath, caption, options) => provider.sendFile(target, filePath, caption, options),
      sendContactCards: (target, contacts, displayName) => provider.sendContactCards(target, contacts, displayName),
      sendContentTemplate: (target, contentSid, contentVariables) => provider.sendContentTemplate(target, contentSid, contentVariables),
      sendInteractiveButtons: (target, text, buttons) => provider.sendInteractiveButtons(target, text, buttons),
      sendInteractiveList: (target, text, buttonText, items) => provider.sendInteractiveList(target, text, buttonText, items),
      resolvePhone: async (jid) => jid.replace(/^whatsapp:/, '').replace(/^\+/, ''),
    }, 'webhook');
  };

  const handleMetaInboundForStorage = async (payload: any): Promise<void> => {
    const value = payload?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message?.from || !message?.id) {
      console.log('[META_WEBHOOK_IGNORED] reason=no_messages');
      return;
    }
    const contact = value?.contacts?.[0];
    const body = String(message?.text?.body || message?.interactive?.button_reply?.title || message?.interactive?.list_reply?.title || message?.interactive?.button_reply?.id || message?.interactive?.list_reply?.id || '').trim();
    const provider = new MetaCloudProvider();
    console.log('[META_INBOUND]', message.id, message.from, body.slice(0, 120));
    await handleIncomingWhatsAppMessage({
      id: String(message.id),
      from: 'whatsapp:' + String(message.from),
      to: 'whatsapp:' + normalizeSharePhone(config.META_DISPLAY_PHONE_NUMBER),
      body,
      timestamp: Number(message.timestamp) || Math.floor(Date.now() / 1000),
      async getDisplayName() { return String(contact?.profile?.name || '').trim(); },
    }, storage, provider, 'webhook');
  };

  app.get('/webhooks/meta/whatsapp', (req, res) => {
    const mode = String(req.query['hub.mode'] || '');
    const token = String(req.query['hub.verify_token'] || '');
    const challenge = String(req.query['hub.challenge'] || '');
    if (mode === 'subscribe' && config.META_VERIFY_TOKEN && token === config.META_VERIFY_TOKEN) { res.status(200).send(challenge); return; }
    res.status(403).send('Meta webhook verification failed');
  });

  const routeMetaGatewayInbound = async (payload: any): Promise<{ handled: boolean; reason?: string }> => {
    const value = payload?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message?.from || !message?.id) {
      console.log('[META_WEBHOOK_IGNORED] reason=no_messages');
      return { handled: true };
    }

    const phoneNumberId = String(value?.metadata?.phone_number_id || '').trim();
    const displayPhoneNumber = normalizeGatewayPhone(String(value?.metadata?.display_phone_number || ''));
    const allMetaClients = ownerStorage.getClients()
      .filter((client) => client.whatsappProvider === 'META_CLOUD_API'
        && client.managementUrl
        && client.ownerAccessToken
        && client.provisioningStatus !== 'disabled');
    if (!allMetaClients.length) {
      return { handled: false, reason: 'No managed Meta clients configured for gateway routing' };
    }

    const exactPhoneIdClients = phoneNumberId
      ? allMetaClients.filter((client) => String(client.metaPhoneNumberId || '').trim() === phoneNumberId)
      : [];
    const exactDisplayClients = displayPhoneNumber
      ? allMetaClients.filter((client) => normalizeGatewayPhone(client.metaDisplayPhoneNumber || '') === displayPhoneNumber)
      : [];
    const sharedAdminNumber = (phoneNumberId && phoneNumberId === String(config.META_PHONE_NUMBER_ID || '').trim())
      || (displayPhoneNumber && displayPhoneNumber === normalizeGatewayPhone(config.META_DISPLAY_PHONE_NUMBER || ''));
    const clients = sharedAdminNumber
      ? allMetaClients
      : exactPhoneIdClients.length
        ? exactPhoneIdClients
        : exactDisplayClients.length
          ? exactDisplayClients
          : [];

    if (!clients.length) {
      console.log('[META_GATEWAY_IGNORED] reason=no_matching_phone_number', phoneNumberId || displayPhoneNumber);
      return { handled: true };
    }

    const fromKey = normalizeGatewayPhone(String(message.from));
    const body = String(message?.text?.body
      || message?.interactive?.button_reply?.title
      || message?.interactive?.list_reply?.title
      || message?.interactive?.button_reply?.id
      || message?.interactive?.list_reply?.id
      || '').trim();
    const normalizedBody = normalizeGatewayText(body);
    const campaignsByClient = new Map<string, Campaign[]>();
    const candidates: Array<{ client: ManagedClient; clientId: string; campaign: Campaign; triggerText: string }> = [];
    await Promise.all(clients.map(async (client) => {
      try {
        const campaigns = await metaCampaignCache.get(client.id, async () => {
          const result = await fetchClientAsOwner<Campaign[]>(client, '/owner-api/campaigns', {
            signal: AbortSignal.timeout(3_000),
          });
          if (!result.ok || !Array.isArray(result.body)) throw new Error('Campaign lookup failed with status ' + result.status);
          return result.body;
        });
        campaignsByClient.set(client.id, campaigns);
        for (const campaign of campaigns) {
          if (!campaign.active || (campaign.runtimeStatus && campaign.runtimeStatus !== 'active')) continue;
          const triggerText = normalizeGatewayText(campaign.triggerPhrase ?? '');
          if (triggerText && normalizedBody.includes(triggerText)) candidates.push({ client, clientId: client.id, campaign, triggerText });
        }
      } catch (err) {
        console.error('[META_GATEWAY_CLIENT_SKIPPED]', client.id, err);
      }
    }));

    const { best, ambiguous } = selectMetaRouteCandidate(candidates);
    if (ambiguous) {
      console.log('[META_GATEWAY_IGNORED] reason=ambiguous_trigger', message.id, message.from);
      return { handled: true };
    }

    const destinationKey = phoneNumberId || displayPhoneNumber;
    const sessionKey = destinationKey ? fromKey + ':' + destinationKey : fromKey;
    let targetClient: ManagedClient | null = best?.client ?? null;
    let routedCampaignId = best?.campaign.id ?? '';
    let routedTriggerText = best?.triggerText ?? '';
    if (best) {
      metaGatewaySessions.set({
        from: sessionKey,
        clientId: best.client.id,
        campaignId: best.campaign.id,
        updatedAt: new Date().toISOString(),
      });
    } else {
      const session = metaGatewaySessions.get(sessionKey);
      const sessionCampaigns = session ? campaignsByClient.get(session.clientId) : undefined;
      const sessionCampaign = sessionCampaigns?.find((campaign) => campaign.id === session?.campaignId);
      if (session && sessionCampaign?.active && sessionCampaign.runtimeStatus === 'active') {
        targetClient = clients.find((client) => client.id === session.clientId) ?? null;
        routedCampaignId = session.campaignId;
      } else if (session && sessionCampaigns) {
        metaGatewaySessions.delete(sessionKey);
        console.log('[META_GATEWAY_SESSION_RELEASED] reason=campaign_not_active', session.clientId, session.campaignId);
      } else if (session) {
        console.log('[META_GATEWAY_IGNORED] reason=session_client_unavailable', session.clientId, session.campaignId);
      }
    }

    if (!targetClient) {
      console.log('[META_GATEWAY_IGNORED] reason=no_trigger_or_session', message.id, message.from);
      return { handled: true };
    }

    const selectedClient = targetClient;
    let forwarded: { ok: boolean; status: number; body: any };
    try {
      forwarded = await retryTransientMetaOperation(
        () => fetchClientAsOwner(selectedClient, '/internal/meta/whatsapp', {
          method: 'POST',
          body: JSON.stringify(payload ?? {}),
        }),
        {
          onRetry: ({ attempt, result, error }) => console.warn(
            '[META_GATEWAY_RETRY]',
            selectedClient.id,
            'attempt=' + attempt,
            result ? 'status=' + result.status : 'network_error',
            error ?? '',
          ),
        },
      );
    } catch (err) {
      console.error('[META_GATEWAY_FAILED]', selectedClient.id, 'network_error', err);
      return { handled: true };
    }
    if (!forwarded.ok) {
      console.error('[META_GATEWAY_FAILED]', selectedClient.id, forwarded.status, JSON.stringify(forwarded.body).slice(0, 300));
    } else {
      console.log(
        '[META_GATEWAY_ROUTED]',
        message.id,
        targetClient.id,
        routedCampaignId ? `campaign=${routedCampaignId}` : 'campaign=unknown',
        routedTriggerText ? `trigger=${routedTriggerText}` : 'trigger=session',
        `clients_checked=${clients.length}`,
        `candidates=${candidates.length}`,
      );
    }
    return { handled: true };
  };

  app.post('/webhooks/meta/whatsapp', (req, res) => {
    res.sendStatus(200);
    void (async () => {
      try {
        const gateway = await routeMetaGatewayInbound(req.body);
        if (gateway.handled) return;
        await handleMetaInboundForStorage(req.body);
      } catch (err) {
        console.error('Meta webhook failed:', err);
      }
    })();
  });
  const routeTwilioGatewayInbound = async (payload: any): Promise<{ handled: boolean; status?: number; reason?: string }> => {
    const meta = twilioInboundMeta(payload);
    const fromKey = normalizeGatewayPhone(meta.from);
    const toKey = normalizeGatewayPhone(meta.to);
    if (!fromKey) return { handled: false, status: 400, reason: 'Missing From' };
    const allClients = ownerStorage.getClients()
      .filter((client) => client.managementUrl && client.ownerAccessToken && client.provisioningStatus !== 'disabled');
    if (!allClients.length) return { handled: false, status: 409, reason: 'No managed clients configured for gateway routing' };
    const matchedToClients = toKey
      ? allClients.filter((client) => normalizeGatewayPhone(client.twilioFrom ?? '') === toKey)
      : [];
    const clients = matchedToClients.length ? matchedToClients : allClients;

    const sessionKey = toKey ? fromKey + ':' + toKey : fromKey;
    const normalizedBody = normalizeGatewayText(meta.body);
    const candidates: Array<{ client: ManagedClient; campaign: Campaign; triggerText: string }> = [];
    await Promise.all(clients.map(async (client) => {
      const result = await fetchClientAsOwner<Campaign[]>(client, '/owner-api/campaigns');
      if (!result.ok || !Array.isArray(result.body)) return;
      for (const campaign of result.body) {
        if (!campaign.active || (campaign.runtimeStatus && campaign.runtimeStatus !== 'active')) continue;
        const triggerText = normalizeGatewayText(campaign.triggerPhrase ?? '');
        if (triggerText && normalizedBody.includes(triggerText)) candidates.push({ client, campaign, triggerText });
      }
    }));

    candidates.sort((a, b) => b.triggerText.length - a.triggerText.length);
    const best = candidates[0];
    if (best && candidates[1] && candidates[1].triggerText.length === best.triggerText.length && candidates[1].client.id !== best.client.id) {
      recordTwilioEvent({
        direction: 'inbound',
        status: 'ignored',
        from: meta.from,
        to: meta.to,
        body: meta.body,
        messageSid: meta.id,
        details: 'Ambiguous gateway trigger matched more than one client campaign',
      });
      return { handled: true };
    }

    let targetClient: ManagedClient | null = best?.client ?? null;
    if (best) {
      twilioGatewaySessions.set({
        from: sessionKey,
        clientId: best.client.id,
        campaignId: best.campaign.id,
        updatedAt: new Date().toISOString(),
      });
    } else {
      const session = twilioGatewaySessions.get(sessionKey);
      targetClient = session ? clients.find((client) => client.id === session.clientId) ?? null : null;
    }

    if (!targetClient) {
      recordTwilioEvent({
        direction: 'inbound',
        status: 'ignored',
        from: meta.from,
        to: meta.to,
        body: meta.body,
        messageSid: meta.id,
        details: 'No gateway trigger or active session matched this sender',
      });
      return { handled: true };
    }

    const forwarded = await fetchClientAsOwner(targetClient, '/internal/twilio/whatsapp', {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    });
    recordTwilioEvent({
      direction: 'inbound',
      status: forwarded.ok ? 'received' : 'failed',
      from: meta.from,
      to: meta.to,
      body: meta.body,
      messageSid: meta.id,
      details: forwarded.ok
        ? 'Gateway routed to client ' + targetClient.id
        : 'Gateway route to client ' + targetClient.id + ' failed (' + forwarded.status + '): ' + JSON.stringify(forwarded.body).slice(0, 300),
    });
    return { handled: true };
  };

  app.post('/webhooks/twilio/whatsapp', async (req, res) => {
    const meta = twilioInboundMeta(req.body);
    if (config.TWILIO_WEBHOOK_TOKEN && req.query.token !== config.TWILIO_WEBHOOK_TOKEN) {
      recordTwilioEvent({
        direction: 'inbound',
        status: 'ignored',
        from: meta.from,
        to: meta.to,
        body: meta.body,
        messageSid: meta.id,
        details: 'Invalid webhook token',
      });
      res.status(401).send('Invalid webhook token');
      return;
    }
    const validTwilioSignature = validateTwilioSignature(req);
    if (!validTwilioSignature) {
      recordTwilioEvent({
        direction: 'inbound',
        status: 'ignored',
        from: meta.from,
        to: meta.to,
        body: meta.body,
        messageSid: meta.id,
        details: 'Invalid Twilio signature',
      });
      res.status(403).send('Invalid Twilio signature');
      return;
    }
    if (rememberTwilioMessage(meta.id)) {
      recordTwilioEvent({
        direction: 'inbound',
        status: 'ignored',
        from: meta.from,
        to: meta.to,
        body: meta.body,
        messageSid: meta.id,
        details: 'Duplicate Twilio webhook message ignored',
      });
      res.type('text/xml').send('<Response></Response>');
      return;
    }

    res.type('text/xml').send('<Response></Response>');
    void (async () => {
      try {
        const gateway = await routeTwilioGatewayInbound(req.body);
        if (gateway.handled) return;

        if (config.WHATSAPP_PROVIDER !== 'TWILIO_API') {
          recordTwilioEvent({
            direction: 'inbound',
            status: 'ignored',
            from: meta.from,
            to: meta.to,
            body: meta.body,
            messageSid: meta.id,
            details: gateway.reason || 'Twilio provider is not enabled for this client',
          });
          return;
        }

        await handleTwilioInboundForStorage(req.body);
      } catch (err) {
        console.error('Twilio webhook failed:', err);
        recordTwilioEvent({
          direction: 'inbound',
          status: 'failed',
          from: meta.from,
          to: meta.to,
          body: meta.body,
          messageSid: meta.id,
          details: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  });

  app.get('/twilio-media/:filename', (req, res) => {
    const filename = path.basename(String(req.params.filename ?? ''));
    if (!/^[a-z0-9.-]+$/i.test(filename)) {
      res.status(400).send('Invalid filename');
      return;
    }
    if (!twilioMediaTokenMatches(filename, req.query.token)) {
      res.status(403).send('Forbidden');
      return;
    }
    const fullPath = path.join(config.UPLOADS_PATH, filename);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');
    if (!filename || !fs.existsSync(fullPath)) {
      res.status(404).send('Not found');
      return;
    }
    const lowerFilename = filename.toLowerCase();
    if (lowerFilename.endsWith('.vcf')) {
      res.type('text/x-vcard');
    } else if (lowerFilename.endsWith('.jpg') || lowerFilename.endsWith('.jpeg') || lowerFilename.endsWith('.jfif')) {
      res.type('image/jpeg');
    } else if (lowerFilename.endsWith('.mp4')) {
      res.type('video/mp4');
    }
    res.sendFile(path.resolve(fullPath));
  });
  app.post('/auth/client/login', access.clientLogin);
  app.post('/auth/client/logout', access.requireClient, access.clientLogout);
  app.post('/auth/owner/login', access.ownerLogin);
  app.post('/auth/owner/logout', access.requireOwner, access.ownerLogout);

  app.use('/owner/api', access.requireOwner);

  app.get('/owner/api/clients', (_req, res) => {
    res.json(ownerStorage.getClients().map(exposeOwnerClient));
  });

  app.get('/owner/api/client-summaries', async (_req, res) => {
    const clients = ownerStorage.getClients();
    const summaries = await Promise.all(clients.map(async (client) => {
      try {
        return { id: client.id, summary: await fetchClientSummary(client) };
      } catch (err: any) {
        return {
          id: client.id,
          summary: {
            reachable: false,
            error: err?.message ?? String(err),
            campaignCount: 0,
            activeCampaigns: 0,
            endedCampaigns: 0,
            savedContacts: 0,
            pendingContacts: 0,
            failedContacts: 0,
            whatsappReady: false,
            whatsappShouldRun: false,
            googleConnected: false,
            campaigns: [],
          } satisfies OwnerClientSummary,
        };
      }
    }));
    res.json({ summaries });
  });

  app.get('/owner/api/provisioning-status', (_req, res) => {
    res.json({
      configured: !dokployProvisioner.configurationError,
      error: dokployProvisioner.configurationError,
    });
  });

  const provisionClient = async (id: string) => {
    const client = ownerStorage.getClient(id);
    if (!client) throw new Error('לקוחה לא נמצאה');
    if (dokployProvisioner.configurationError) {
      throw new Error(dokployProvisioner.configurationError);
    }

    let current = ownerStorage.updateClient(id, {
      provisioningStatus: 'provisioning',
      provisioningError: undefined,
    })!;
    try {
      current = await dokployProvisioner.provision(current, (patch) => {
        return ownerStorage.updateClient(id, patch)!;
      });
      return ownerStorage.updateClient(id, {
        provisioningStatus: 'deploying',
        provisioningError: undefined,
      })!;
    } catch (err: any) {
      const message = err?.message ?? String(err);
      console.error(`Dokploy provisioning failed for client ${id}: ${message}`);
      ownerStorage.updateClient(id, {
        provisioningStatus: 'failed',
        provisioningError: message,
      });
      throw new Error(message);
    }
  };

  type BulkRedeployResult = { id: string; name: string; ok: boolean; error?: string };
  let bulkRedeployJob: {
    running: boolean;
    startedAt: string;
    finishedAt?: string;
    total: number;
    current?: string;
    results: BulkRedeployResult[];
  } | null = null;

  const runBulkRedeploy = async () => {
    const clients = ownerStorage
      .getClients()
      .filter((client) => client.provisioningStatus !== 'disabled');
    bulkRedeployJob = {
      running: true,
      startedAt: new Date().toISOString(),
      total: clients.length,
      results: [],
    };

    for (const client of clients) {
      bulkRedeployJob.current = client.name;
      try {
        await provisionClient(client.id);
        bulkRedeployJob.results.push({ id: client.id, name: client.name, ok: true });
      } catch (err: any) {
        bulkRedeployJob.results.push({
          id: client.id,
          name: client.name,
          ok: false,
          error: err?.message ?? String(err),
        });
      }
    }

    bulkRedeployJob.running = false;
    bulkRedeployJob.current = undefined;
    bulkRedeployJob.finishedAt = new Date().toISOString();
  };

  const exposeBulkRedeployJob = () => {
    const job = bulkRedeployJob;
    if (!job) {
      return {
        running: false,
        total: 0,
        succeeded: 0,
        failed: 0,
        results: [] as BulkRedeployResult[],
      };
    }
    return {
      ...job,
      succeeded: job.results.filter((item) => item.ok).length,
      failed: job.results.filter((item) => !item.ok).length,
    };
  };

  const exposeOwnerClient = (client: ManagedClient) => ({
    ...client,
    metaAccessToken: undefined,
    metaVerifyToken: undefined,
    metaWebhookUrl: dokployProvisioner.getMetaWebhookUrl(client),
    twilioWebhookUrl: dokployProvisioner.getTwilioWebhookUrl(client),
  });

  app.post('/owner/api/clients', async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const accessCode = String(req.body?.accessCode ?? '').trim();
    const requestedProvider = ['BAILEYS', 'WEB_JS', 'TWILIO_API', 'META_CLOUD_API'].includes(String(req.body?.whatsappProvider))
      ? String(req.body.whatsappProvider) as ManagedClient['whatsappProvider']
      : (String(req.body?.plan) === 'advanced' ? 'TWILIO_API' : 'BAILEYS');
    const plan = ['basic', 'self_service', 'advanced'].includes(String(req.body?.plan))
      ? String(req.body.plan) as ManagedClient['plan']
      : 'self_service';
    const maxCampaigns = Math.max(1, Math.min(Number(req.body?.maxCampaigns) || (plan === 'advanced' ? 5 : plan === 'basic' ? 1 : 7), 50));
    const serviceExpiresAt = typeof req.body?.serviceExpiresAt === 'string' && req.body.serviceExpiresAt.trim()
      ? req.body.serviceExpiresAt.trim()
      : undefined;
    const twilioFrom = normalizeTwilioFrom(req.body?.twilioFrom);
    const botReplyDelayMs = normalizeBotReplyDelayMs(req.body?.botReplyDelayMs);
    if (!name) {
      res.status(400).json({ error: 'שם לקוחה חסר' });
      return;
    }
    if (accessCode.length < 8) {
      res.status(400).json({ error: 'הסיסמה ללקוחה חייבת להכיל לפחות 8 תווים' });
      return;
    }
    if (accessCode.length > 128) {
      res.status(400).json({ error: 'הסיסמה ללקוחה ארוכה מדי' });
      return;
    }
    if (twilioFrom === null) {
      res.status(400).json({ error: 'מספר Twilio חייב להיות בפורמט מלא עם קידומת מדינה, למשל +16602902811' });
      return;
    }
    if (botReplyDelayMs === null) {
      res.status(400).json({ error: 'דיליי הודעות חייב להיות מספר בין 0 ל-60000 מילישניות' });
      return;
    }
    const client = ownerStorage.addClient(name, accessCode, {
      plan,
      readonlyDashboard: plan === 'basic',
      maxCampaigns,
      serviceExpiresAt,
      whatsappProvider: requestedProvider,
      twilioFrom: plan === 'advanced' ? twilioFrom : undefined,
      botReplyDelayMs,
    });
    if (dokployProvisioner.configurationError) {
      const localClient = ownerStorage.updateClient(client.id, {
        provisioningStatus: 'failed',
        provisioningError: dokployProvisioner.configurationError,
      })!;
      res.status(201).json({
        ...exposeOwnerClient(localClient),
        warning: dokployProvisioner.configurationError,
      });
      return;
    }
    try {
      res.status(201).json(exposeOwnerClient(await provisionClient(client.id)));
    } catch (err: any) {
      res.status(502).json({
        error: err?.message ?? String(err),
        client: ownerStorage.getClient(client.id) ? exposeOwnerClient(ownerStorage.getClient(client.id)!) : null,
      });
    }
  });

  app.patch('/owner/api/clients/:id', (req, res) => {
    const client = ownerStorage.getClient(req.params.id);
    if (!client) {
      res.status(404).json({ error: 'לקוחה לא נמצאה' });
      return;
    }
    const patch: Partial<ManagedClient> = {};
    if ('twilioFrom' in req.body) {
      const twilioFrom = normalizeTwilioFrom(req.body?.twilioFrom);
      if (twilioFrom === null) {
        res.status(400).json({ error: 'מספר Twilio חייב להיות בפורמט מלא עם קידומת מדינה, למשל +16602902811' });
        return;
      }
      patch.twilioFrom = twilioFrom;
    }
    if ('botReplyDelayMs' in req.body) {
      const botReplyDelayMs = normalizeBotReplyDelayMs(req.body?.botReplyDelayMs);
      if (botReplyDelayMs === null) {
        res.status(400).json({ error: 'דיליי הודעות חייב להיות מספר בין 0 ל-60000 מילישניות' });
        return;
      }
      patch.botReplyDelayMs = botReplyDelayMs;
    }
    const updated = ownerStorage.updateClient(client.id, patch);
    res.json(updated ? exposeOwnerClient(updated) : null);
  });

  app.post('/owner/api/clients/:id/migrate-to-meta', async (req, res) => {
    const client = ownerStorage.getClient(req.params.id);
    if (!client) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }
    if (client.whatsappProvider === 'META_CLOUD_API') {
      res.json(exposeOwnerClient(client));
      return;
    }
    if (client.whatsappProvider !== 'TWILIO_API') {
      res.status(409).json({ error: 'Only Twilio clients can be migrated to Meta Cloud API.' });
      return;
    }

    const metaRouting = dokployProvisioner.getMetaRoutingConfig();
    if (!metaRouting) {
      res.status(409).json({ error: 'Meta provisioning is not fully configured in flowsbiz-admin.' });
      return;
    }

    const campaignsResult = await fetchClientAsOwner<any[]>(client, '/owner-api/campaigns');
    if (!campaignsResult.ok || !Array.isArray(campaignsResult.body)) {
      res.status(502).json({ error: 'Could not verify that all client campaigns are inactive.' });
      return;
    }
    const activeCampaigns = campaignsResult.body.filter((campaign: any) => campaign?.active === true && campaign?.runtimeStatus !== 'ended');
    if (activeCampaigns.length) {
      res.status(409).json({
        error: 'Disable all active or scheduled campaigns before migrating this client to Meta Cloud API.',
        campaigns: activeCampaigns.map((campaign: any) => ({ id: campaign.id, name: campaign.name, runtimeStatus: campaign.runtimeStatus })),
      });
      return;
    }

    ownerStorage.updateClient(client.id, {
      whatsappProvider: 'META_CLOUD_API',
      metaPhoneNumberId: metaRouting.phoneNumberId,
      metaDisplayPhoneNumber: metaRouting.displayPhoneNumber,
      provisioningError: undefined,
    });

    try {
      res.json(exposeOwnerClient(await provisionClient(client.id)));
    } catch (err: any) {
      res.status(502).json({
        error: err?.message ?? String(err),
        client: ownerStorage.getClient(client.id) ? exposeOwnerClient(ownerStorage.getClient(client.id)!) : null,
      });
    }
  });

  app.get('/owner/api/clients/:id', (req, res) => {
    const client = ownerStorage.getClient(req.params.id);
    if (!client) {
      res.status(404).json({ error: 'לקוחה לא נמצאה' });
      return;
    }
    res.json(exposeOwnerClient(client));
  });

  app.post('/owner/api/clients/redeploy-all', async (_req, res) => {
    if (bulkRedeployJob?.running) {
      res.status(409).json(exposeBulkRedeployJob());
      return;
    }
    void runBulkRedeploy().catch((err) => {
      console.error('Bulk client redeploy failed:', err);
      if (bulkRedeployJob) {
        bulkRedeployJob.running = false;
        bulkRedeployJob.finishedAt = new Date().toISOString();
        bulkRedeployJob.results.push({
          id: 'bulk-redeploy',
          name: 'פריסה לכל הלקוחות',
          ok: false,
          error: err?.message ?? String(err),
        });
      }
    });
    res.status(202).json(exposeBulkRedeployJob());
  });

  app.get('/owner/api/clients/redeploy-all/status', (_req, res) => {
    res.json(exposeBulkRedeployJob());
  });

  app.post('/owner/api/clients/:id/check-ready', async (req, res) => {
    const client = ownerStorage.getClient(req.params.id);
    if (!client) {
      res.status(404).json({ error: 'לקוחה לא נמצאה' });
      return;
    }
    if (!client.managementUrl) {
      res.json(exposeOwnerClient(client));
      return;
    }
    try {
      const healthUrl = new URL('/health', client.managementUrl).toString();
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(8_000) });
      const health = await response.json().catch(() => null) as { clientConfigured?: boolean } | null;
      if (response.ok && health?.clientConfigured === true) {
        const updated = ownerStorage.updateClient(client.id, { provisioningStatus: 'ready' });
        res.json(updated ? exposeOwnerClient(updated) : null);
        return;
      }
    } catch {
      // A deployment may still be building; retain the current state.
    }
    res.json(exposeOwnerClient(client));
  });

  app.post('/owner/api/clients/:id/provision', async (req, res) => {
    const client = ownerStorage.getClient(req.params.id);
    if (!client) {
      res.status(404).json({ error: 'לקוחה לא נמצאה' });
      return;
    }
    try {
      res.json(exposeOwnerClient(await provisionClient(client.id)));
    } catch (err: any) {
      res.status(502).json({
        error: err?.message ?? String(err),
        client: ownerStorage.getClient(client.id) ? exposeOwnerClient(ownerStorage.getClient(client.id)!) : null,
      });
    }
  });

  app.get('/owner/api/clients/:id/summary', async (req, res) => {
    const client = ownerStorage.getClient(req.params.id);
    if (!client) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }
    try {
      res.json(await fetchClientSummary(client));
    } catch (err: any) {
      res.json({
        reachable: false,
        error: err?.message ?? String(err),
        activeCampaigns: 0,
        endedCampaigns: 0,
        savedContacts: 0,
        pendingContacts: 0,
        failedContacts: 0,
        whatsappReady: false,
        googleConnected: false,
        campaigns: [],
      });
    }
  });

  app.get('/owner/api/clients/:id/files', async (req, res) => {
    const client = ownerStorage.getClient(req.params.id);
    if (!client) { res.status(404).json({ error: 'Client not found' }); return; }
    const result = await fetchClientAsOwner(client, '/owner-api/files');
    res.status(result.status).json(result.body);
  });

  app.delete('/owner/api/clients/:id/files/:fileId', async (req, res) => {
    const client = ownerStorage.getClient(req.params.id);
    if (!client) { res.status(404).json({ error: 'Client not found' }); return; }
    const result = await fetchClientAsOwner(client, `/owner-api/files/${encodeURIComponent(String(req.params.fileId))}`, {
      method: 'DELETE',
    });
    res.status(result.status).json(result.body);
  });

  app.get('/owner/api/clients/:id/campaigns', async (req, res) => {
    const client = ownerStorage.getClient(req.params.id);
    if (!client) { res.status(404).json({ error: 'Client not found' }); return; }
    const result = await fetchClientAsOwner<any[]>(client, '/owner-api/campaigns');
    res.status(result.status).json(result.body);
  });

  app.post('/owner/api/clients/:id/campaigns', async (req, res) => {
    const client = ownerStorage.getClient(req.params.id);
    if (!client) { res.status(404).json({ error: 'Client not found' }); return; }
    const result = await fetchClientAsOwner(client, '/owner-api/campaigns', {
      method: 'POST',
      body: JSON.stringify(req.body ?? {}),
    });
    res.status(result.status).json(result.body);
  });

  app.patch('/owner/api/clients/:id/campaigns/:campaignId/toggle', async (req, res) => {
    const client = ownerStorage.getClient(req.params.id);
    if (!client) { res.status(404).json({ error: 'Client not found' }); return; }
    const result = await fetchClientAsOwner(client, `/owner-api/campaigns/${encodeURIComponent(String(req.params.campaignId))}/toggle`, {
      method: 'PATCH',
    });
    res.status(result.status).json(result.body);
  });

  app.delete('/owner/api/clients/:id/campaigns/:campaignId', async (req, res) => {
    const client = ownerStorage.getClient(req.params.id);
    if (!client) { res.status(404).json({ error: 'Client not found' }); return; }
    const result = await fetchClientAsOwner(client, `/owner-api/campaigns/${encodeURIComponent(String(req.params.campaignId))}`, {
      method: 'DELETE',
    });
    res.status(result.status).json(result.body);
  });

  app.delete('/owner/api/clients/:id', async (req, res) => {
    const client = ownerStorage.getClient(req.params.id);
    if (!client) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }

    const warnings: string[] = [];
    let deletedResources: string[] = [];
    if (client.dokployApplicationId || client.dokployMountId || client.dokployDomainId) {
      try {
        const result = await dokployProvisioner.deleteClientResources(client);
        deletedResources = result.deleted;
        warnings.push(...result.warnings);
      } catch (err: any) {
        res.status(502).json({ error: err?.message ?? String(err) });
        return;
      }
    }

    const removed = ownerStorage.deleteClient(client.id);
    res.json({ ok: removed, deletedResources, warnings });
  });

  app.use('/owner', access.requireOwner, express.static(ownerPublicDir));
  app.use('/api', access.requireClient);

  const requireWritableClient = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const capabilities = getClientCapabilities(storage);
    if (capabilities.readonlyDashboard) {
      res.status(403).json({ error: 'המסלול הנוכחי מאפשר צפייה בלבד. שינוי קמפיינים מתבצע דרך מנהל המערכת.' });
      return;
    }
    if (capabilities.serviceExpired) {
      res.status(403).json({ error: 'תקופת הפעילות הסתיימה. ניתן לצפות בנתונים, אך לא לבצע שינויים.' });
      return;
    }
    next();
  };

  const requireOwnerApiToken = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!ownerTokenMatches(req.get('x-owner-token'))) {
      res.status(401).json({ error: 'Owner token is invalid' });
      return;
    }
    next();
  };

  app.post('/internal/meta/whatsapp', requireOwnerApiToken, (req, res) => {
    if (config.WHATSAPP_PROVIDER !== 'META_CLOUD_API') {
      res.status(409).json({ error: 'Meta Cloud API provider is not enabled for this client' });
      return;
    }
    res.json({ ok: true });
    void handleMetaInboundForStorage(req.body).catch((err) => {
      console.error('Internal Meta dispatch failed:', err);
    });
  });

  app.post('/internal/twilio/whatsapp', requireOwnerApiToken, async (req, res) => {
    if (config.WHATSAPP_PROVIDER !== 'TWILIO_API') {
      res.status(409).json({ error: 'Twilio provider is not enabled for this client' });
      return;
    }
    const meta = twilioInboundMeta(req.body);
    if (rememberTwilioMessage(meta.id)) {
      recordTwilioEvent({
        direction: 'inbound',
        status: 'ignored',
        from: meta.from,
        to: meta.to,
        body: meta.body,
        messageSid: meta.id,
        details: 'Duplicate internal Twilio message ignored',
      });
      res.json({ ok: true, duplicate: true });
      return;
    }
    res.json({ ok: true });
    void handleTwilioInboundForStorage(req.body).catch((err) => {
      console.error('Internal Twilio dispatch failed:', err);
      recordTwilioEvent({
        direction: 'inbound',
        status: 'failed',
        from: meta.from,
        to: meta.to,
        body: meta.body,
        messageSid: meta.id,
        details: err instanceof Error ? err.message : String(err),
      });
    });
  });

  app.use('/owner-api', requireOwnerApiToken);

  app.get('/owner-api/files', (_req, res) => {
    res.json(storage.getUploadedFiles());
  });

  app.delete('/owner-api/files/:id', (req, res) => {
    const file = storage.deleteUploadedFile(String(req.params.id));
    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    deleteUploadedFileFromDisk(file.filename);
    res.json({ ok: true, file });
  });

  app.get('/owner-api/campaigns', (_req, res) => {
    res.json(storage.getCampaigns().map((campaign) => ({
      ...campaign,
      conversation: storage.getCampaignConversationSettings(campaign),
    })));
  });

  app.post('/owner-api/campaigns', async (req, res) => {
    const { name, triggerType, triggerPhrase, basePhrase, referrerName, startAt, endAt, conversation, twilio } =
      req.body as Partial<Campaign>;
    const capabilities = getClientCapabilities(storage);
    const explicitNoEnd = req.body?.endAt === null;
    const resolvedEndAt = explicitNoEnd
      ? undefined
      : (typeof endAt === 'string' && endAt.trim()
        ? endAt.trim()
        : (config.WHATSAPP_PROVIDER === 'META_CLOUD_API' ? defaultMetaCampaignEndAt(typeof startAt === 'string' ? startAt : undefined) : undefined));

    if (!name?.trim()) { res.status(400).json({ error: 'שם הקמפיין חסר' }); return; }
    if (storage.getCampaigns().length >= capabilities.maxCampaigns) {
      res.status(403).json({ error: `המסלול מאפשר עד ${capabilities.maxCampaigns} קמפיינים.` });
      return;
    }
    if (triggerType !== 1 && triggerType !== 2) { res.status(400).json({ error: 'סוג טריגר לא תקין' }); return; }
    if (startAt && resolvedEndAt && new Date(startAt).getTime() >= new Date(resolvedEndAt).getTime()) {
      res.status(400).json({ error: 'שעת הסיום חייבת להיות אחרי שעת ההתחלה' });
      return;
    }
    if (capabilities.serviceExpiresAt) {
      const expiry = new Date(capabilities.serviceExpiresAt).getTime();
      const campaignEnd = resolvedEndAt ? new Date(resolvedEndAt).getTime() : expiry;
      if (!Number.isNaN(expiry) && campaignEnd > expiry) {
        res.status(400).json({ error: 'זמן סיום הקמפיין חייב להיות בתוך תקופת הפעילות של הלקוח.' });
        return;
      }
    }

    let phrase: string;
    let suffix: string;
    let basePhraseVal: string | undefined;
    let refName: string | undefined;
    if (triggerType === 1) {
      if (!triggerPhrase?.trim()) { res.status(400).json({ error: 'משפט הטריגר חסר' }); return; }
      phrase = triggerPhrase.trim();
      suffix = storage.getAdminSettings().botSuffix;
    } else {
      if (!basePhrase?.trim()) { res.status(400).json({ error: 'משפט הטריגר חסר' }); return; }
      if (!referrerName?.trim()) { res.status(400).json({ error: 'שם הממליץ חובה לטיפוס 2' }); return; }
      basePhraseVal = basePhrase.trim();
      refName = referrerName.trim();
      phrase = `${basePhraseVal} ${storage.getAdminSettings().referralPrefix}${refName}`;
      suffix = ` - (${refName})`;
    }

    const triggerAvailability = await verifyMetaTriggerBeforeActivation(phrase);
    if (!triggerAvailability.ok) {
      res.status(triggerAvailability.status).json({ error: triggerAvailability.error, code: triggerAvailability.code });
      return;
    }

    const campaign = storage.addCampaign({
      name: name.trim(),
      triggerType,
      triggerPhrase: phrase,
      basePhrase: basePhraseVal,
      referrerName: refName,
      suffix,
      active: true,
      startAt: typeof startAt === 'string' && startAt ? startAt : undefined,
      endAt: resolvedEndAt,
      conversation: conversationSettings(conversation, storage.getAdminSettings()),
      twilio: campaignTwilioSettings(twilio),
    });
    res.status(201).json(campaign);
  });

  app.patch('/owner-api/campaigns/:id/toggle', async (req, res) => {
    const current = storage.getCampaigns().find((campaign) => campaign.id === String(req.params.id));
    if (!current) {
      res.status(404).json({ error: 'קמפיין לא נמצא' });
      return;
    }
    if (!current.active && campaignWouldReserveTrigger(true, current.endAt)) {
      const triggerAvailability = await verifyMetaTriggerBeforeActivation(current.triggerPhrase, current.id);
      if (!triggerAvailability.ok) {
        res.status(triggerAvailability.status).json({ error: triggerAvailability.error, code: triggerAvailability.code });
        return;
      }
    }
    const updated = storage.toggleCampaign(String(req.params.id));
    if (!updated) {
      res.status(404).json({ error: 'קמפיין לא נמצא' });
      return;
    }
    res.json(updated);
  });

  app.delete('/owner-api/campaigns/:id', (req, res) => {
    res.json({ ok: storage.deleteCampaign(String(req.params.id)) });
  });

  // ── QR code status ────────────────────────────────────────────────────────

  app.get('/api/qr', (_req, res) => {
    const profile = storage.getClientProfile();
    if (config.WHATSAPP_PROVIDER === 'META_CLOUD_API') {
      res.json({ qr: null, authenticated: metaConfigured(), ready: metaConfigured(), pairingCode: null,
        connectedPhone: config.META_DISPLAY_PHONE_NUMBER || profile.whatsappPhone,
        lifecycle: metaConfigured() ? 'running' : 'stopped',
        listeningReason: metaConfigured() ? 'meta webhook mode' : 'meta env missing',
        requestedProvider: config.WHATSAPP_PROVIDER, actualProvider: 'META_CLOUD_API', providerFallbackReason: null,
        shouldRun: storage.hasCampaignsNeedingBot(), });
      return;
    }
    if (config.WHATSAPP_PROVIDER === 'TWILIO_API') {
      res.json({
        qr: null,
        authenticated: twilioConfigured(),
        ready: twilioConfigured(),
        pairingCode: null,
        connectedPhone: config.TWILIO_FROM.replace(/^whatsapp:/, '') || profile.whatsappPhone,
        lifecycle: twilioConfigured() ? 'running' : 'stopped',
        listeningReason: twilioConfigured() ? 'twilio webhook mode' : 'twilio env missing',
        requestedProvider: config.WHATSAPP_PROVIDER,
        actualProvider: 'TWILIO_API',
        providerFallbackReason: null,
        shouldRun: storage.hasCampaignsNeedingBot(),
      });
      return;
    }
    res.json({
      qr: botState.qrDataUrl,
      authenticated: botState.authenticated,
      ready: botState.ready,
      pairingCode: botState.pairingCode,
      connectedPhone: botState.connectedPhone ?? profile.whatsappPhone,
      lifecycle: botState.lifecycle,
      listeningReason: botState.listeningReason,
      requestedProvider: botState.requestedProvider,
      actualProvider: botState.actualProvider,
      providerFallbackReason: botState.providerFallbackReason,
      shouldRun: storage.hasCampaignsNeedingBot(),
    });
  });

  // ── Pairing code ──────────────────────────────────────────────────────────

  app.post('/api/pair', async (req, res) => {
    let phone = String(req.body.phone ?? '').replace(/\D/g, '');
    if (phone.startsWith('0')) phone = '972' + phone.slice(1);
    if (!phone) { res.status(400).json({ error: 'מספר טלפון חסר' }); return; }
    // Store phone and restart client in pairing-code mode
    botState.pairingPhone      = phone;
    botState.pairingCode       = null;
    botState.pairingAttempted  = false;
    botState.intentionalRestart = true;

    try {
      await stopWhatsAppBot('pairing restart');
      startWhatsAppBot(storage, 'pairing code request', phone)
        .catch((err) => console.error('❌ Pairing-mode init error:', err))
        .finally(() => { botState.intentionalRestart = false; });
    } catch (err: any) {
      botState.intentionalRestart = false;
      res.status(500).json({ error: err?.message ?? 'שגיאה בהפעלת הבוט' });
      return;
    }

    res.json({ waiting: true });
  });

  app.post('/api/whatsapp/start', async (_req, res) => {
    try {
      await startWhatsAppBot(storage, 'manual dashboard start');
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'שגיאה בהפעלת הבוט' });
    }
  });

  app.post('/api/whatsapp/stop', async (_req, res) => {
    try {
      await stopWhatsAppBot('manual dashboard stop');
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'שגיאה בכיבוי הבוט' });
    }
  });

  app.post('/api/whatsapp/reset-session', async (_req, res) => {
    try {
      await resetWhatsAppSession('manual dashboard QR reset');
      await startWhatsAppBot(storage, 'manual dashboard QR reset');
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'שגיאה באיפוס חיבור WhatsApp' });
    }
  });

  // ── WhatsApp logout ──────────────────────────────────────────────────────

  app.post('/api/whatsapp/logout', async (_req, res) => {
    if (!botState.client) { res.status(503).json({ error: 'הבוט לא מוכן' }); return; }
    try {
      await botState.client.logout();
      botState.authenticated = false;
      botState.ready = false;
      botState.qrDataUrl = null;
      console.log('🔓 WhatsApp logged out – session cleared.');
      res.json({ ok: true });
    } catch (err: any) {
      console.error('❌ logout error:', err);
      res.status(500).json({ error: err?.message ?? 'שגיאה בניתוק' });
    }
  });

  // ── Google Contacts OAuth ─────────────────────────────────────────────────

  app.get('/api/google/status', (_req, res) => {
    res.json({ connected: isGoogleConnected() });
  });

  app.delete('/api/google/disconnect', (_req, res) => {
    disconnectGoogle();
    res.json({ ok: true });
  });

  app.get('/api/google/auth-url', (req, res) => {
    try {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      res.json({ url: getGoogleAuthUrl(baseUrl) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'שגיאה' });
    }
  });

  const completeGoogleCallback = async (req: express.Request, res: express.Response) => {
    const code  = String(req.query.code  ?? '');
    const error = String(req.query.error ?? '');
    if (error || !code) {
      res.send('<h2>שגיאה בהתחברות. סגור חלון זה ונסה שוב.</h2>');
      return;
    }
    try {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      await handleGoogleCallback(code, baseUrl);
      res.send(`
        <html><head><meta charset="UTF-8"></head><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>✅ Google Contacts מחובר בהצלחה!</h2>
          <p>ניתן לסגור חלון זה.</p>
          <script>setTimeout(() => window.close(), 2000);</script>
        </body></html>
      `);
    } catch (err: any) {
      res.send(`<h2>שגיאה: ${err?.message}</h2>`);
    }
  };

  app.get('/oauth2callback', (req, res, next) => {
    const state = String(req.query.state ?? '');
    if (!state) {
      access.requireClient(req, res, () => { void completeGoogleCallback(req, res); });
      return;
    }
    try {
      const code = String(req.query.code ?? '');
      const error = String(req.query.error ?? '');
      res.redirect(getGoogleRelayReturnUrl(state, code, error));
    } catch (err: any) {
      res.status(400).send(`<h2>Google connection failed: ${err?.message ?? 'Invalid request'}</h2>`);
    }
  });

  app.get('/google-oauth-return', access.requireClient, completeGoogleCallback);

  // ── Public config (phone number for wa.me links) ─────────────────────────

  // Public short campaign links. Opens WhatsApp with the campaign trigger phrase.
  app.get('/c/:campaignId', (req, res) => {
    const campaignId = String(req.params.campaignId ?? '').trim();
    const campaign = storage.getCampaigns().find((item) => item.id === campaignId);
    if (!campaign) {
      res.status(404).send('Campaign not found');
      return;
    }
    const phone = getCampaignSharePhone(storage);
    if (!phone) {
      res.status(409).send('WhatsApp phone is not configured');
      return;
    }
    res.redirect(302, 'https://wa.me/' + phone + '?text=' + encodeURIComponent(campaign.triggerPhrase));
  });

  app.get('/api/config', (_req, res) => {
    const profile = storage.getClientProfile();
    if (config.WHATSAPP_PROVIDER === 'TWILIO_API') {
      const twilioPhone = normalizeSharePhone(config.TWILIO_FROM);
      const fallbackPhone = normalizeSharePhone(profile.whatsappPhone || config.MY_CONTACT.phone);
      const phone = getCampaignSharePhone(storage);
      res.json({
        phone,
        phoneSource: twilioPhone ? 'twilio' : (fallbackPhone ? 'profile' : 'missing'),
        missingPhoneReason: phone ? undefined : 'לא הוגדר מספר לקמפיין הפרסומי.',
      });
      return;
    }
    const connectedPhone = normalizeSharePhone(botState.connectedPhone);
    const savedPhone = normalizeSharePhone(profile.whatsappPhone);
    const fallbackPhone = normalizeSharePhone(config.MY_CONTACT.phone);
    const phone = getCampaignSharePhone(storage);
    res.json({
      phone,
      phoneSource: connectedPhone ? 'connected' : (savedPhone ? 'profile' : (fallbackPhone ? 'environment' : 'missing')),
      missingPhoneReason: phone ? undefined : 'אין עדיין מספר WhatsApp מחובר ללקוחה.',
    });
  });

  app.get('/api/capabilities', (_req, res) => {
    res.json(getClientCapabilities(storage));
  });

  app.get('/api/twilio/status', (_req, res) => {
    res.json({
      enabled: config.WHATSAPP_PROVIDER === 'TWILIO_API',
      configured: twilioConfigured(),
      from: config.TWILIO_FROM,
      messagingServiceSid: config.TWILIO_MESSAGING_SERVICE_SID,
      webhookSignatureRequired: config.TWILIO_REQUIRE_SIGNATURE,
      quickReplyContentSidConfigured: Boolean(config.TWILIO_QUICK_REPLY_CONTENT_SID),
      listPickerContentSidConfigured: Boolean(config.TWILIO_LIST_PICKER_CONTENT_SID),
      mediaBaseUrlConfigured: Boolean(config.TWILIO_MEDIA_BASE_URL),
      recentEvents: getTwilioEvents(10),
    });
  });

  app.get('/api/twilio/logs', (req, res) => {
    res.json({ items: getTwilioEvents(Number(req.query.limit) || 50) });
  });

  app.get('/api/twilio/onboarding', (_req, res) => {
    res.json(storage.getTwilioOnboarding());
  });

  app.put('/api/twilio/onboarding', requireWritableClient, (req, res) => {
    const allowed = ['businessName', 'brandName', 'businessWebsite', 'businessCategory', 'businessDescription', 'supportEmail', 'supportPhone', 'country', 'optInDescription', 'firstCampaignUseCase', 'notes'];
    const patch: Record<string, string> = {};
    for (const key of allowed) {
      if (typeof req.body?.[key] === 'string') patch[key] = req.body[key].trim();
    }
    res.json(storage.updateTwilioOnboarding(patch));
  });

  app.get('/api/twilio/templates', (_req, res) => {
    res.json(storage.getTwilioTemplates());
  });

  app.post('/api/twilio/templates', requireWritableClient, (req, res) => {
    const input = cleanTwilioTemplateInput(req.body);
    if (!input.friendlyName) { res.status(400).json({ error: 'friendlyName is required' }); return; }
    if (!input.templateName) { res.status(400).json({ error: 'templateName must contain lowercase letters, numbers or underscores' }); return; }
    if (!input.body) { res.status(400).json({ error: 'Template body is required' }); return; }
    res.status(201).json(storage.addTwilioTemplate(input));
  });

  app.put('/api/twilio/templates/:id', requireWritableClient, (req, res) => {
    const current = storage.getTwilioTemplate(String(req.params.id));
    if (!current) { res.status(404).json({ error: 'Template not found' }); return; }
    if (current.contentSid) {
      res.status(409).json({ error: 'Template was already created in Twilio and cannot be edited here. Duplicate it as a new draft.' });
      return;
    }
    const input = cleanTwilioTemplateInput(req.body);
    if (!input.friendlyName || !input.templateName || !input.body) {
      res.status(400).json({ error: 'friendlyName, templateName and body are required' });
      return;
    }
    res.json(storage.updateTwilioTemplate(current.id, input));
  });

  app.post('/api/twilio/templates/:id/create-content', requireWritableClient, async (req, res) => {
    const template = storage.getTwilioTemplate(String(req.params.id));
    if (!template) { res.status(404).json({ error: 'Template not found' }); return; }
    if (template.contentSid) { res.json(template); return; }
    try {
      const created = await twilioContentRequest('/Content', {
        method: 'POST',
        body: JSON.stringify({
          friendly_name: template.friendlyName,
          language: template.language,
          variables: template.variables,
          types: { 'twilio/text': { body: template.body } },
        }),
      });
      res.json(storage.updateTwilioTemplate(template.id, { contentSid: created.sid, status: 'created', lastError: undefined }));
    } catch (err: any) {
      const updated = storage.updateTwilioTemplate(template.id, { status: 'failed', lastError: err?.message ?? String(err) });
      res.status(502).json({ error: err?.message ?? String(err), template: updated });
    }
  });

  app.post('/api/twilio/templates/:id/submit-approval', requireWritableClient, async (req, res) => {
    let template = storage.getTwilioTemplate(String(req.params.id));
    if (!template) { res.status(404).json({ error: 'Template not found' }); return; }
    try {
      if (!template.contentSid) {
        const created = await twilioContentRequest('/Content', {
          method: 'POST',
          body: JSON.stringify({
            friendly_name: template.friendlyName,
            language: template.language,
            variables: template.variables,
            types: { 'twilio/text': { body: template.body } },
          }),
        });
        template = storage.updateTwilioTemplate(template.id, { contentSid: created.sid, status: 'created', lastError: undefined })!;
      }
      const approval = await twilioContentRequest(`/Content/${encodeURIComponent(template.contentSid!)}/ApprovalRequests/whatsapp`, {
        method: 'POST',
        body: JSON.stringify({ name: template.templateName, category: template.category }),
      });
      const status = String(approval.status ?? 'submitted').toLowerCase() as TwilioTemplateDraft['status'];
      res.json(storage.updateTwilioTemplate(template.id, {
        status: ['received', 'pending', 'approved', 'rejected', 'paused', 'disabled'].includes(status) ? status : 'submitted',
        approvalStatus: String(approval.status ?? ''),
        rejectionReason: String(approval.rejection_reason ?? ''),
        lastError: undefined,
      }));
    } catch (err: any) {
      const updated = storage.updateTwilioTemplate(template.id, { status: 'failed', lastError: err?.message ?? String(err) });
      res.status(502).json({ error: err?.message ?? String(err), template: updated });
    }
  });

  app.post('/api/twilio/templates/:id/sync-approval', requireWritableClient, async (req, res) => {
    const template = storage.getTwilioTemplate(String(req.params.id));
    if (!template) { res.status(404).json({ error: 'Template not found' }); return; }
    if (!template.contentSid) { res.status(409).json({ error: 'Template was not created in Twilio yet' }); return; }
    try {
      const approval = await twilioContentRequest(`/Content/${encodeURIComponent(template.contentSid)}/ApprovalRequests`, { method: 'GET' });
      const whatsapp = approval.whatsapp ?? {};
      const status = String(whatsapp.status ?? template.status).toLowerCase() as TwilioTemplateDraft['status'];
      res.json(storage.updateTwilioTemplate(template.id, {
        status: ['received', 'pending', 'approved', 'rejected', 'paused', 'disabled'].includes(status) ? status : template.status,
        approvalStatus: String(whatsapp.status ?? ''),
        rejectionReason: String(whatsapp.rejection_reason ?? ''),
        lastError: undefined,
      }));
    } catch (err: any) {
      const updated = storage.updateTwilioTemplate(template.id, { status: 'failed', lastError: err?.message ?? String(err) });
      res.status(502).json({ error: err?.message ?? String(err), template: updated });
    }
  });

  // ── Settings ──────────────────────────────────────────────────────────────

  app.get('/api/settings', (_req, res) => {
    res.json(storage.getAdminSettings());
  });

  app.post('/api/settings', requireWritableClient, (req, res) => {
    const body = req.body as Partial<AdminSettings>;
    const patch: Partial<AdminSettings> = {};

    if (typeof body.askNameEnabled === 'boolean')
      patch.askNameEnabled = body.askNameEnabled;
    if (typeof body.nameTimeoutMinutes === 'number' && body.nameTimeoutMinutes > 0)
      patch.nameTimeoutMinutes = body.nameTimeoutMinutes;
    if (body.contactsProvider === 'google' || body.contactsProvider === 'manual')
      patch.contactsProvider = body.contactsProvider;
    if (typeof body.readReceiptsEnabled === 'boolean')
      patch.readReceiptsEnabled = config.WHATSAPP_PROVIDER === 'TWILIO_API' ? false : body.readReceiptsEnabled;
    if (typeof body.askNameText === 'string')    patch.askNameText    = body.askNameText;
    if (typeof body.replyText === 'string')      patch.replyText      = body.replyText;
    if (Array.isArray(body.followupMessages))
      patch.followupMessages = body.followupMessages.filter((message): message is string => typeof message === 'string');
    if (typeof body.referralPrefix === 'string') patch.referralPrefix = body.referralPrefix;
    if (typeof body.botSuffix === 'string')      patch.botSuffix      = body.botSuffix;

    const updated = storage.updateAdminSettings(patch);
    const retriedFailedContacts = patch.contactsProvider
      ? storage.retryFailedContactSaves(patch.contactsProvider)
      : 0;
    res.json({ ok: true, settings: updated, retriedFailedContacts });
  });

  // ── Contacts CSV export ───────────────────────────────────────────────────

  app.get('/api/contacts/export', (req, res) => {
    const contacts = storage.getAllContacts();
    const rows = ['שם,טלפון,תאריך', ...contacts.map(c =>
      `"${c.name.replace(/"/g, '""')}","${c.phone}","${c.savedAt.slice(0, 10)}"`,
    )];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
    res.send('﻿' + rows.join('\n'));
  });

  app.get('/api/contacts/export.vcf', (_req, res) => {
    const vcard = buildContactsVCard(storage.getAllContacts());
    res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts.vcf"');
    res.send(vcard);
  });

  // ── Campaigns ─────────────────────────────────────────────────────────────

  app.get('/api/contacts/queue', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    res.json({
      stats: storage.getContactQueueStats(),
      items: storage.getContactQueue(limit),
    });
  });

  app.get('/api/files', (_req, res) => {
    res.json(storage.getUploadedFiles());
  });

  app.delete('/api/files/:id', requireWritableClient, (req, res) => {
    const file = storage.deleteUploadedFile(String(req.params.id));
    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    deleteUploadedFileFromDisk(file.filename);
    res.json({ ok: true, file });
  });

  app.post('/api/files', requireWritableClient, (req, res) => {
    const originalName = String(req.body?.name ?? '').trim();
    const mimeType = String(req.body?.mimeType ?? 'application/octet-stream').trim();
    const dataUrl = String(req.body?.dataUrl ?? '');
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!originalName || !match) {
      res.status(400).json({ error: 'קובץ לא תקין' });
      return;
    }

    const allowedTypes = new Set([
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'video/mp4',
    ]);
    const detectedMimeType = match[1] || mimeType;
    if (!allowedTypes.has(detectedMimeType)) {
      res.status(400).json({ error: 'סוג קובץ לא נתמך. ניתן להעלות PDF, תמונה או MP4.' });
      return;
    }

    const buffer = Buffer.from(match[2], 'base64');
    const maxBytes = 15 * 1024 * 1024;
    if (buffer.length > maxBytes) {
      res.status(400).json({ error: 'הקובץ גדול מדי. המגבלה כרגע היא 15MB.' });
      return;
    }

    fs.mkdirSync(config.UPLOADS_PATH, { recursive: true });
    const filename = safeUploadName(originalName);
    fs.writeFileSync(path.join(config.UPLOADS_PATH, filename), buffer);
    const file = storage.addUploadedFile({
      originalName,
      filename,
      mimeType: detectedMimeType,
      size: buffer.length,
    });
    res.status(201).json(file);
  });

  app.get('/api/campaigns', (_req, res) => {
    res.json(storage.getCampaigns().map((campaign) => ({
      ...campaign,
      conversation: storage.getCampaignConversationSettings(campaign),
    })));
  });

  app.get('/api/campaign-results', (_req, res) => {
    const summaries = storage.getCampaigns().map((campaign) => ({
      campaignId: campaign.id,
      campaignName: campaign.name,
      referrerName: campaign.referrerName,
      runtimeStatus: campaign.runtimeStatus,
      currentResultBatchId: storage.getCurrentCampaignResultBatchId(campaign.id),
      resultBatches: storage.getCampaignResultBatches(campaign.id),
      ...storage.getCampaignResultSummary(campaign.id, storage.getCurrentCampaignResultBatchId(campaign.id)),
    }));
    res.json({ summaries });
  });

  app.get('/api/campaign-results/:id/referrals', (req, res) => {
    const campaign = storage.getCampaigns().find((item) => item.id === req.params.id);
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }
    res.json({ campaignId: campaign.id, referrals: storage.getCampaignReferralLeaderboard(campaign.id) });
  });

  app.get('/api/campaign-results/:id/referrals/export.xls', async (req, res) => {
    const campaign = storage.getCampaigns().find((item) => item.id === req.params.id);
    if (!campaign) { res.status(404).json({ error: 'Campaign not found' }); return; }
    const rows = storage.getCampaignReferralLeaderboard(campaign.id);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'FlowsBiz';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Referrals', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    const headers = ['#', 'שם', 'טלפון', 'כניסות מהשיתוף', 'נשמרו'];
    const tableRows = rows.map((referral, index) => [index + 1, referral.name ?? '', referral.phone ?? '', referral.invited, referral.saved]);
    sheet.addRow(headers);
    tableRows.forEach((row) => sheet.addRow(row));
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF274E13' } };
    sheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.columns = [{ width: 8 }, { width: 30 }, { width: 20 }, { width: 16 }, { width: 16 }];
    if (sheet.rowCount > 1) {
      sheet.addTable({ name: 'CampaignReferrals', ref: `A1:E${sheet.rowCount}`, headerRow: true, totalsRow: false, style: { theme: 'TableStyleMedium4', showRowStripes: true }, columns: headers.map((name) => ({ name })), rows: tableRows });
    }
    const xlsx = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`referrals-${campaign.name}.xlsx`)}`);
    res.send(Buffer.from(xlsx));
  });
  app.get('/api/campaign-results/:id/export', (req, res) => {
    const campaign = storage.getCampaigns().find((item) => item.id === req.params.id);
    if (!campaign) {
      res.status(404).json({ error: 'קמפיין לא נמצא' });
      return;
    }

    const resultBatchId = typeof req.query.batch === 'string' ? req.query.batch : storage.getCurrentCampaignResultBatchId(campaign.id);
    const csvValue = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const rows = [
      'campaign,phone,whatsappName,fallbackName,lastStage,lastEventAt,status,triggeredAt,updatedAt',
      ...storage.getCampaignResults(campaign.id, resultBatchId).map((result) => [
        csvValue(campaign.name),
        csvValue(result.phone),
        csvValue(result.whatsappName ?? ''),
        csvValue(result.fallbackName ?? ''),
        csvValue(result.lastStage ?? ''),
        csvValue(result.lastEventAt ?? ''),
        csvValue(result.status),
        csvValue(result.triggeredAt),
        csvValue(result.updatedAt),
      ].join(',')),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="campaign-${campaign.id}-results.csv"`);
    res.send('\uFEFF' + rows.join('\n'));
  });

  app.get('/api/campaign-results/:id/export.xls', async (req, res) => {
    const campaign = storage.getCampaigns().find((item) => item.id === req.params.id);
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    const resultBatchId = typeof req.query.batch === 'string' ? req.query.batch : storage.getCurrentCampaignResultBatchId(campaign.id);
    const results = storage.getCampaignResults(campaign.id, resultBatchId);
    const events = storage.getCampaignEvents(campaign.id, resultBatchId).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const eventsByResult = new Map<string, typeof events>();
    for (const event of events) {
      const key = event.campaignResultId || '';
      if (!key) continue;
      const group = eventsByResult.get(key) ?? [];
      group.push(event);
      eventsByResult.set(key, group);
    }
    const contactNames = new Map(storage.getAllContacts().map((contact) => [contact.phone, contact.name]));
    const summary = storage.getCampaignResultSummary(campaign.id, resultBatchId);

    const excelText = (value: unknown): string => {
      const textValue = String(value ?? '');
      return /^[=+\-@\t\r]/.test(textValue) ? `'${textValue}` : textValue;
    };
    const title = `${campaign.name} - detailed campaign export`;
    const generatedAt = new Date().toISOString();
    const summaryRows = [
      ['Campaign', campaign.name], ['Campaign ID', campaign.id], ['Twilio mode', campaign.twilio?.mode ?? ''],
      ['Twilio template ID', campaign.twilio?.templateId ?? ''], ['Generated at', generatedAt], ['Results file', resultBatchId],
      ['Total people', String(summary.total)], ['Saved contacts', String(summary.saved)], ['Pending saves', String(summary.pending)],
      ['Failed saves', String(summary.failed)], ['Completed', String(summary.completed)],
      ['Referral links sent', String(storage.getCampaignEvents(campaign.id).filter((event) => event.type === 'referral_link_sent').length)],
      ['Referral attributed entries', String(results.filter((result) => result.referredByCode).length)],
      ['Human handoff', String(summary.humanHandoff)], ['Score average', String(summary.scoreAverage)],
    ];
    const maxEventsPerPerson = Math.max(0, ...results.map((result) => (eventsByResult.get(result.id) ?? []).length));
    const eventHeaders = Array.from({ length: maxEventsPerPerson }, (_, index) => [`Event ${index + 1} type`, `Event ${index + 1} details`]).flat();
    const headers = ['Campaign', 'Name', 'Phone', 'WhatsApp name', 'Saved/fallback name', 'Status', 'Last stage', 'Triggered at', 'Updated at', 'Steps passed', 'Events count', ...eventHeaders, 'Score total', 'Score answers'];
    const detailRows: Array<Array<string | number>> = results.map((result) => {
      const personEvents = eventsByResult.get(result.id) ?? [];
      const stepLabels = personEvents.map((event) => event.label ? `${event.type}: ${event.label}` : event.type).join(' | ');
      const scoreAnswers = (result.scoreAnswers ?? []).map((answer) => `${answer.question}: ${answer.answerText} (${answer.score})`).join(' | ');
      const name = contactNames.get(result.phone) || result.fallbackName || result.whatsappName || result.phone;
      const eventCells = personEvents.flatMap((event) => [event.type, event.label ?? '']);
      while (eventCells.length < maxEventsPerPerson * 2) eventCells.push('');
      return [campaign.name, name, result.phone, result.whatsappName ?? '', result.fallbackName ?? '', result.status, result.lastStage ?? '', result.triggeredAt, result.updatedAt, stepLabels, personEvents.length, ...eventCells, result.scoreTotal ?? '', scoreAnswers];
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'FlowsBiz';
    workbook.created = new Date();
    workbook.modified = new Date();
    const summarySheet = workbook.addWorksheet('Summary', { views: [{ rightToLeft: true }] });
    summarySheet.addRow([title]);
    summarySheet.mergeCells('A1:B1');
    summarySheet.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
    summarySheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF274E13' } };
    summarySheet.addRow([]); summarySheet.addRow(['Summary', 'Value']);
    summaryRows.forEach(([label, value]) => summarySheet.addRow([label, excelText(value)]));
    summarySheet.getRow(3).font = { bold: true };
    summarySheet.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9EAD3' } };
    summarySheet.columns = [{ width: 30 }, { width: 58 }];
    summarySheet.getColumn(2).alignment = { wrapText: true, vertical: 'top' };
    summarySheet.views = [{ rightToLeft: true, state: 'frozen', ySplit: 3 }];

    const peopleSheet = workbook.addWorksheet('People and stages', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    peopleSheet.addRow(headers);
    detailRows.forEach((values) => peopleSheet.addRow(values.map((value) => typeof value === 'number' ? value : excelText(value))));
    peopleSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    peopleSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF274E13' } };
    peopleSheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    peopleSheet.getRow(1).height = 32;
    peopleSheet.columns = headers.map((header) => ({ width: /details|answers|passed/i.test(header) ? 38 : Math.min(Math.max(header.length + 3, 14), 28) }));
    peopleSheet.eachRow((worksheetRow, rowNumber) => { if (rowNumber === 1) return; worksheetRow.eachCell((worksheetCell) => { worksheetCell.alignment = { vertical: 'top', wrapText: true }; }); });
    if (peopleSheet.rowCount > 1) {
      peopleSheet.addTable({ name: 'CampaignPeopleStages', ref: `A1:${peopleSheet.getCell(1, headers.length).address.replace(/1$/, peopleSheet.rowCount.toString())}`, headerRow: true, totalsRow: false, style: { theme: 'TableStyleMedium4', showRowStripes: true }, columns: headers.map((name) => ({ name })), rows: detailRows.map((values) => values.map((value) => typeof value === 'number' ? value : excelText(value))) });
    }

    const eventsSheet = workbook.addWorksheet('Events', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    const normalizedEventHeaders = ['Campaign', 'Campaign ID', 'Result ID', 'Phone', 'Event type', 'Label', 'Details'];
    eventsSheet.addRow(normalizedEventHeaders);
    const normalizedEventRows = events.map((event) => { const result = results.find((item) => item.id === event.campaignResultId); return [campaign.name, campaign.id, event.campaignResultId ?? '', result?.phone ?? '', event.type, event.label ?? '', JSON.stringify(event)].map((value) => excelText(value)); });
    normalizedEventRows.forEach((rowValues) => eventsSheet.addRow(rowValues));
    eventsSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    eventsSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF274E13' } };
    eventsSheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    eventsSheet.columns = [{ width: 24 }, { width: 24 }, { width: 28 }, { width: 18 }, { width: 24 }, { width: 32 }, { width: 60 }];
    eventsSheet.eachRow((worksheetRow, rowNumber) => { if (rowNumber === 1) return; worksheetRow.eachCell((worksheetCell) => { worksheetCell.alignment = { vertical: 'top', wrapText: true }; }); });
    if (eventsSheet.rowCount > 1) {
      eventsSheet.addTable({ name: 'CampaignEvents', ref: `A1:G${eventsSheet.rowCount}`, headerRow: true, totalsRow: false, style: { theme: 'TableStyleMedium4', showRowStripes: true }, columns: normalizedEventHeaders.map((name) => ({ name })), rows: normalizedEventRows });
    }

    const xlsx = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="campaign-${campaign.id}-detailed.xlsx"`);
    res.send(Buffer.from(xlsx));
  });
  app.post('/api/campaign-results/:id/reset', requireWritableClient, (req, res) => {
    const campaign = storage.getCampaigns().find((item) => item.id === req.params.id);
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }
    const reset = storage.resetCampaignData(campaign.id);
    const conversations = conversationState.removeByCampaign(campaign.id);
    res.json({ ok: true, campaignId: campaign.id, ...reset, conversations });
  });
  app.post('/api/campaign-results/:id/new-batch', requireWritableClient, (req, res) => {
    const campaign = storage.getCampaigns().find((item) => item.id === req.params.id);
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }
    const batch = storage.startNewCampaignResultBatch(campaign.id);
    res.json({
      ok: true,
      campaignId: campaign.id,
      currentResultBatchId: batch?.id,
      resultBatches: storage.getCampaignResultBatches(campaign.id),
      summary: storage.getCampaignResultSummary(campaign.id, batch?.id),
    });
  });
  app.post('/api/campaign-results/:id/queue-awaiting-name', requireWritableClient, (req, res) => {
    const campaign = storage.getCampaigns().find((item) => item.id === req.params.id);
    if (!campaign) {
      res.status(404).json({ error: 'קמפיין לא נמצא' });
      return;
    }
    const resultBatchId = storage.getCurrentCampaignResultBatchId(campaign.id);
    const result = storage.queueAwaitingNameCampaignResults(campaign.id, resultBatchId);
    res.json({
      ok: true,
      campaignId: campaign.id,
      ...result,
      summary: storage.getCampaignResultSummary(campaign.id, resultBatchId),
    });
  });
  app.post('/api/campaign-results/:id/queue-unsaved', requireWritableClient, (req, res) => {
    const campaign = storage.getCampaigns().find((item) => item.id === req.params.id);
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }
    const resultBatchId = storage.getCurrentCampaignResultBatchId(campaign.id);
    const result = storage.queueUnsavedCampaignResults(campaign.id, resultBatchId);
    res.json({
      ok: true,
      campaignId: campaign.id,
      ...result,
      summary: storage.getCampaignResultSummary(campaign.id, resultBatchId),
    });
  });
  app.get('/api/campaign-results/:id/export.vcf', (req, res) => {
    const campaign = storage.getCampaigns().find((item) => item.id === req.params.id);
    if (!campaign) {
      res.status(404).json({ error: 'קמפיין לא נמצא' });
      return;
    }

    const contactNames = new Map(storage.getAllContacts().map((contact) => [contact.phone, contact.name]));
    const seen = new Set<string>();
    const resultBatchId = typeof req.query.batch === 'string' ? req.query.batch : storage.getCurrentCampaignResultBatchId(campaign.id);
    const contacts = storage.getCampaignResults(campaign.id, resultBatchId)
      .filter((result) => {
        if (seen.has(result.phone)) return false;
        seen.add(result.phone);
        return true;
      })
      .map((result) => ({
        phone: result.phone,
        name: contactNames.get(result.phone) || result.phone,
      }));
    const vcard = buildContactsVCard(contacts);
    res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="campaign-${campaign.id}-contacts.vcf"`);
    res.send(vcard);
  });

  app.post('/api/campaigns', requireWritableClient, async (req, res) => {
    const { name, triggerType, triggerPhrase, basePhrase, referrerName, startAt, endAt, conversation, twilio } =
      req.body as Partial<Campaign>;
    const capabilities = getClientCapabilities(storage);
    const explicitNoEnd = req.body?.endAt === null;
    const resolvedEndAt = explicitNoEnd
      ? undefined
      : (typeof endAt === 'string' && endAt.trim()
        ? endAt.trim()
        : (config.WHATSAPP_PROVIDER === 'META_CLOUD_API' ? defaultMetaCampaignEndAt(typeof startAt === 'string' ? startAt : undefined) : undefined));

    if (!name?.trim()) { res.status(400).json({ error: 'שם הקמפיין חסר' }); return; }
    if (storage.getCampaigns().length >= capabilities.maxCampaigns) {
      res.status(403).json({ error: `המסלול מאפשר עד ${capabilities.maxCampaigns} קמפיינים.` });
      return;
    }
    if (triggerType !== 1 && triggerType !== 2) { res.status(400).json({ error: 'סוג טריגר לא תקין' }); return; }
    if (startAt && resolvedEndAt && new Date(startAt).getTime() >= new Date(resolvedEndAt).getTime()) {
      res.status(400).json({ error: 'שעת הסיום חייבת להיות אחרי שעת ההתחלה' });
      return;
    }
    if (capabilities.serviceExpiresAt) {
      const expiry = new Date(capabilities.serviceExpiresAt).getTime();
      const campaignEnd = resolvedEndAt ? new Date(resolvedEndAt).getTime() : expiry;
      if (!Number.isNaN(expiry) && campaignEnd > expiry) {
        res.status(400).json({ error: 'זמן סיום הקמפיין חייב להיות בתוך תקופת הפעילות של הלקוח.' });
        return;
      }
    }

    let phrase: string;
    let suffix: string;
    let basePhraseVal: string | undefined;
    let refName: string | undefined;

    if (triggerType === 1) {
      if (!triggerPhrase?.trim()) { res.status(400).json({ error: 'משפט הטריגר חסר' }); return; }
      phrase = triggerPhrase.trim();
      suffix = storage.getAdminSettings().botSuffix;
    } else {
      if (!basePhrase?.trim()) { res.status(400).json({ error: 'משפט הטריגר חסר' }); return; }
      if (!referrerName?.trim()) { res.status(400).json({ error: 'שם הממליץ חובה לטיפוס 2' }); return; }
      basePhraseVal = basePhrase.trim();
      refName = referrerName.trim();
      // Full trigger: "[base phrase] הגעתי דרך [referrer name]"
      phrase = `${basePhraseVal} ${storage.getAdminSettings().referralPrefix}${refName}`;
      suffix = ` - (${refName})`;
    }

    const triggerAvailability = await verifyMetaTriggerBeforeActivation(phrase);
    if (!triggerAvailability.ok) {
      res.status(triggerAvailability.status).json({ error: triggerAvailability.error, code: triggerAvailability.code });
      return;
    }

    const campaign = storage.addCampaign({
      name: name.trim(),
      triggerType,
      triggerPhrase: phrase,
      basePhrase: basePhraseVal,
      referrerName: refName,
      suffix,
      active: true,
      startAt: typeof startAt === 'string' && startAt ? startAt : undefined,
      endAt: resolvedEndAt,
      conversation: conversationSettings(conversation, storage.getAdminSettings()),
      twilio: campaignTwilioSettings(twilio),
    });
    res.json(campaign);
  });

  app.post('/api/campaigns/:id/duplicate', requireWritableClient, (req, res) => {
    const source = storage.getCampaigns().find((campaign) => campaign.id === req.params.id);
    if (!source) {
      res.status(404).json({ error: 'קמפיין לא נמצא' });
      return;
    }

    const capabilities = getClientCapabilities(storage);
    if (storage.getCampaigns().length >= capabilities.maxCampaigns) {
      res.status(403).json({ error: `המסלול מאפשר עד ${capabilities.maxCampaigns} קמפיינים.` });
      return;
    }

    const requestedName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const campaign = storage.duplicateCampaign(source.id, requestedName || `${source.name} - עותק`);
    if (!campaign) {
      res.status(404).json({ error: 'קמפיין לא נמצא' });
      return;
    }

    res.status(201).json(campaign);
  });

  app.put('/api/campaigns/:id', requireWritableClient, async (req, res) => {
    const { name, triggerType, triggerPhrase, basePhrase, referrerName, active, startAt, endAt, conversation, twilio } =
      req.body as Partial<Campaign>;
    const existing = storage.getCampaigns().find((campaign) => campaign.id === String(req.params.id));
    if (!existing) {
      res.status(404).json({ error: 'קמפיין לא נמצא' });
      return;
    }

    const patch: Partial<Omit<Campaign, 'id'>> = {};

    if (name?.trim()) patch.name = name.trim();
    if (typeof active === 'boolean') patch.active = active;
    if (startAt && endAt && new Date(startAt).getTime() >= new Date(endAt).getTime()) {
      res.status(400).json({ error: 'שעת הסיום חייבת להיות אחרי שעת ההתחלה' });
      return;
    }
    const capabilities = getClientCapabilities(storage);
    if (capabilities.serviceExpiresAt) {
      const expiry = new Date(capabilities.serviceExpiresAt).getTime();
      const campaignEnd = endAt ? new Date(endAt).getTime() : expiry;
      if (!Number.isNaN(expiry) && campaignEnd > expiry) {
        res.status(400).json({ error: 'זמן סיום הקמפיין חייב להיות בתוך תקופת הפעילות של הלקוח.' });
        return;
      }
    }
    if ('startAt' in req.body) patch.startAt = typeof startAt === 'string' && startAt ? startAt : undefined;
    if ('endAt' in req.body) patch.endAt = typeof endAt === 'string' && endAt ? endAt : undefined;
    if ('conversation' in req.body) {
      const defaults = storage.getCampaignConversationSettings(existing);
      patch.conversation = conversationSettings(conversation, defaults);
    }
    if ('twilio' in req.body) {
      patch.twilio = campaignTwilioSettings(twilio);
    }

    if (triggerType === 1) {
      patch.triggerType = 1;
      if (triggerPhrase?.trim()) {
        patch.triggerPhrase = triggerPhrase.trim();
        patch.suffix = storage.getAdminSettings().botSuffix;
        patch.basePhrase = undefined;
        patch.referrerName = undefined;
      }
    } else if (triggerType === 2) {
      if (!basePhrase?.trim()) { res.status(400).json({ error: 'משפט הטריגר חסר' }); return; }
      if (!referrerName?.trim()) { res.status(400).json({ error: 'שם הממליץ חובה לטיפוס 2' }); return; }
      const basePhraseVal = basePhrase.trim();
      const refName = referrerName.trim();
      patch.triggerType = 2;
      patch.basePhrase = basePhraseVal;
      patch.referrerName = refName;
      patch.triggerPhrase = `${basePhraseVal} ${storage.getAdminSettings().referralPrefix}${refName}`;
      patch.suffix = ` - (${refName})`;
    }

    const resultingActive = patch.active ?? existing.active;
    const resultingEndAt = Object.prototype.hasOwnProperty.call(patch, 'endAt') ? patch.endAt : existing.endAt;
    const resultingTrigger = patch.triggerPhrase ?? existing.triggerPhrase;
    if (campaignWouldReserveTrigger(resultingActive, resultingEndAt)) {
      const triggerAvailability = await verifyMetaTriggerBeforeActivation(resultingTrigger, existing.id);
      if (!triggerAvailability.ok) {
        res.status(triggerAvailability.status).json({ error: triggerAvailability.error, code: triggerAvailability.code });
        return;
      }
    }

    const updated = storage.updateCampaign(String(req.params.id), patch);
    if (!updated) {
      res.status(404).json({ error: 'קמפיין לא נמצא' });
      return;
    }
    res.json(updated);
  });

  app.delete('/api/campaigns/:id', requireWritableClient, (req, res) => {
    const ok = storage.deleteCampaign(String(req.params.id));
    res.json({ ok });
  });

  app.get('/api/campaigns/:id/dry-run', (req, res) => {
    const campaign = storage.getCampaigns().find((item) => item.id === req.params.id);
    if (!campaign) {
      res.status(404).json({ error: 'קמפיין לא נמצא' });
      return;
    }
    res.json(buildCampaignDryRun(campaign, storage));
  });

  app.patch('/api/campaigns/:id/toggle', requireWritableClient, async (req, res) => {
    const current = storage.getCampaigns().find((campaign) => campaign.id === String(req.params.id));
    if (!current) {
      res.status(404).json({ error: 'קמפיין לא נמצא' });
      return;
    }
    if (!current.active && campaignWouldReserveTrigger(true, current.endAt)) {
      const triggerAvailability = await verifyMetaTriggerBeforeActivation(current.triggerPhrase, current.id);
      if (!triggerAvailability.ok) {
        res.status(triggerAvailability.status).json({ error: triggerAvailability.error, code: triggerAvailability.code });
        return;
      }
    }
    const updated = storage.toggleCampaign(String(req.params.id));
    if (!updated) {
      res.status(404).json({ error: 'קמפיין לא נמצא' });
      return;
    }
    res.json(updated);
  });

  // ─────────────────────────────────────────────────────────────────────────

  app.get('/', (_req, res) => {
    if (publicSiteEnabled) {
      res.sendFile(path.join(sitePublicDir, 'index.html'));
      return;
    }
    res.redirect('/owner/');
  });
  if (publicSiteEnabled) {
    app.get('/privacy', (_req, res) => {
      res.sendFile(path.join(sitePublicDir, 'privacy.html'));
    });
    app.use('/site-assets', express.static(path.join(sitePublicDir, 'assets')));
  }
  app.get('/client', access.requireClient, (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });
  app.get('/client/', access.requireClient, (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });
  app.use('/client', access.requireClient, express.static(publicDir));

  app.listen(config.ADMIN_PORT, () => {
    console.log(`🖥️  Admin dashboard → http://localhost:${config.ADMIN_PORT}`);
  });
}
