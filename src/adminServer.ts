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
import { Pool } from 'pg';
import {
  Storage,
  AdminSettings,
  Campaign,
  CampaignConversationSettings,
  CompletionLink,
  DecisionFlowOption,
  DecisionFlowStep,
  ServiceBotConfig,
  TwilioTemplateDraft,
} from './storage';
import { validateServiceBotConfig } from './serviceBot';
import { config } from './config';
import { botState } from './botState';
import { resetAndStartWhatsAppBot, startWhatsAppBot, stopWhatsAppBot } from './whatsappLifecycle';
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
import { getFlowHealthSnapshot, handleIncomingWhatsAppMessage } from './messageFlow';
import { TwilioProvider } from './providers/TwilioProvider';
import { MetaCloudProvider } from './providers/MetaCloudProvider';
import { IncomingWhatsAppMessage } from './types/whatsapp';
import { getTwilioEvents, recordTwilioEvent } from './twilioEvents';
import { getPairingCodeBlockedUntil, pairingCodeRateLimitMessage } from './pairingRateLimit';
import {
  defaultMetaCampaignEndAt,
  metaCampaignReservesTrigger,
  normalizeMetaTrigger,
  selectMetaRouteCandidate,
} from './metaCampaignRouting';
import {
  decideMetaFallbackRoute,
  groupMetaItemsBySender,
  metaPayloadSenderKey,
  retryTransientMetaOperation,
  splitMetaWebhookMessages,
  splitMetaWebhookStatuses,
} from './metaGatewayReliability';

import { MetaGatewayInbox } from './metaGatewayInbox';
interface TwilioGatewaySession {
  from: string;
  clientId: string;
  campaignId: string;
  updatedAt: string;
}

export interface MetaGatewayRoute extends Campaign {
  routeKind: 'campaign' | 'service_bot';
}

const SERVICE_BOT_META_ROUTE_ID = '__service_bot__';

function serviceBotMetaRouteId(botId: string): string {
  return botId === 'service-bot-main' ? SERVICE_BOT_META_ROUTE_ID : `${SERVICE_BOT_META_ROUTE_ID}:${botId}`;
}

export function preferCampaignMetaRoutes<T extends {
  clientId: string;
  triggerText: string;
  campaign: Pick<MetaGatewayRoute, 'routeKind'>;
}>(candidates: T[]): T[] {
  return candidates.filter((candidate) =>
    candidate.campaign.routeKind !== 'service_bot'
    || !candidates.some((other) =>
      other.clientId === candidate.clientId
      && other.triggerText === candidate.triggerText
      && other.campaign.routeKind === 'campaign'));
}

export function campaignsToMetaGatewayRoutes(campaigns: Campaign[]): MetaGatewayRoute[] {
  return campaigns.map((campaign) => ({ ...campaign, routeKind: 'campaign' }));
}

export function buildMetaGatewayRoutes(storage: Storage, serviceBotFeatureEnabled = config.CLIENT_SERVICE_BOT_ENABLED): MetaGatewayRoute[] {
  const routes = campaignsToMetaGatewayRoutes(storage.getCampaigns());
  if (!serviceBotFeatureEnabled) return routes;
  for (const serviceBot of storage.getServiceBots().slice().reverse()) {
    if (!serviceBot.enabled || !serviceBot.triggerText.trim() || !validateServiceBotConfig(serviceBot).ok) continue;
    routes.push({
      id: serviceBotMetaRouteId(serviceBot.id),
      name: serviceBot.name || 'Service Bot',
      triggerType: 1,
      triggerPhrase: serviceBot.triggerText.trim(),
      suffix: '',
      active: true,
      runtimeStatus: 'active',
      routeKind: 'service_bot',
    });
  }
  return routes;
}

interface MetaPendingRouteResponse {
  pending: boolean;
  campaignId?: string;
  kind?: string;
  timestamp?: number;
}

interface MetaRoutingSnapshotResponse {
  routes: MetaGatewayRoute[];
  pendingRoute: MetaPendingRouteResponse;
}

function localMetaPendingRoute(storage: Storage, phone: string): MetaPendingRouteResponse {
  const pending = conversationState.findByPhone(phone);
  // 'expired-decision' is kept around only to let a one-shot inactivity
  // continuation run once; the sender is no longer actively expected to
  // reply, so it must not keep winning future cross-client routing forever.
  if (pending?.campaignId && pending.kind !== 'expired-decision') {
    return { pending: true, campaignId: pending.campaignId, kind: pending.kind, timestamp: pending.timestamp };
  }
  const serviceBotSession = storage.getServiceBotSession(phone);
  const serviceBot = serviceBotSession
    ? storage.getServiceBots().find((item) => item.id === serviceBotSession.botId && item.enabled)
    : undefined;
  return serviceBotSession && serviceBot
    ? {
      pending: true,
      campaignId: serviceBotMetaRouteId(serviceBot.id),
      kind: 'service-bot',
      timestamp: new Date(serviceBotSession.updatedAt).getTime(),
    }
    : { pending: false };
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

/**
 * Meta sends replies to modern interactive messages under `interactive`, but
 * replies to legacy reply-buttons under `button`. Always prefer the payload
 * / id because it is stable even when WhatsApp truncates the visible title.
 */
export function getMetaInboundBody(message: any): string {
  const candidates = [
    message?.text?.body,
    message?.interactive?.button_reply?.id,
    message?.interactive?.list_reply?.id,
    message?.interactive?.button_reply?.title,
    message?.interactive?.list_reply?.title,
    message?.button?.payload,
    message?.button?.text,
    message?.button_reply?.id,
    message?.button_reply?.title,
    message?.list_reply?.id,
    message?.list_reply?.title,
    message?.reply?.id,
    message?.reply?.title,
  ];
  for (const candidate of candidates) {
    const body = String(candidate ?? '').trim();
    if (body) return body;
  }
  return '';
}

export function isMetaButtonReply(message: any): boolean {
  const type = String(message?.type ?? '').trim().toLowerCase();
  const interactiveType = String(message?.interactive?.type ?? '').trim().toLowerCase();
  return type === 'button'
    || type === 'interactive'
    || interactiveType === 'button_reply'
    || interactiveType === 'list_reply'
    || Boolean(message?.button || message?.button_reply || message?.list_reply || message?.reply);
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

function downloadDateStamp(value?: string): string {
  const parsed = value ? new Date(value) : new Date();
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function safeDownloadBaseName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120) || 'campaign';
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
  let digits = withoutJid.replace(/[^\d]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length === 10) return `972${digits.slice(1)}`;
  if (/^5\d{8}$/.test(digits)) return `972${digits}`;
  return digits;
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

function normalizeCampaignLimit(value: unknown): number | null {
  const limit = Number(String(value ?? '').trim());
  return Number.isInteger(limit) && limit >= 1 && limit <= 50 ? limit : null;
}

function campaignContactSuffix(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  const raw = typeof value === 'string' ? value.trim().slice(0, 80) : '';
  const wrapped = raw.match(/^-\s*\((.*)\)$/);
  const label = (wrapped ? wrapped[1] : raw).trim();
  return label ? ` - (${label})` : '';
}

export function buildContactsVCard(contacts: Array<{ name?: string; phone: string }>): string {
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

export function normalizeCampaignContactPhone(phone: string): string {
  let digits = String(phone ?? '').replace(/[^\d]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length === 10) return `972${digits.slice(1)}`;
  if (/^5\d{8}$/.test(digits)) return `972${digits}`;
  return digits;
}

export function resolveCampaignContactName(
  result: { phone: string; fallbackName?: string; whatsappName?: string },
  contactNames: Map<string, string>,
): string {
  const normalizedPhone = normalizeCampaignContactPhone(result.phone);
  return contactNames.get(normalizedPhone)?.trim()
    || result.fallbackName?.trim()
    || result.whatsappName?.trim()
    || result.phone;
}

function twilioConfigured(): boolean {
  return Boolean(config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN && (config.TWILIO_FROM || config.TWILIO_MESSAGING_SERVICE_SID));
}

function metaConfigured(): boolean {
  return Boolean(config.META_ACCESS_TOKEN && config.META_PHONE_NUMBER_ID && config.META_VERIFY_TOKEN);
}

export function getWhatsAppHealth(profilePhone?: string) {
  if (config.WHATSAPP_PROVIDER === 'META_CLOUD_API') {
    const configured = metaConfigured();
    return {
      ready: configured,
      authenticated: configured,
      lifecycle: configured ? 'running' : 'stopped',
      notReadySince: null,
      reconnectAttempts: 0,
      lastReconnectAt: null,
      lastWatchdogRestartAt: null,
      connectedPhone: config.META_DISPLAY_PHONE_NUMBER || profilePhone || null,
      listeningReason: configured ? 'meta webhook mode' : 'meta env missing',
      requestedProvider: config.WHATSAPP_PROVIDER,
      actualProvider: 'META_CLOUD_API',
      providerFallbackReason: null,
    };
  }
  if (config.WHATSAPP_PROVIDER === 'TWILIO_API') {
    const configured = twilioConfigured();
    return {
      ready: configured,
      authenticated: configured,
      lifecycle: configured ? 'running' : 'stopped',
      notReadySince: null,
      reconnectAttempts: 0,
      lastReconnectAt: null,
      lastWatchdogRestartAt: null,
      connectedPhone: config.TWILIO_FROM.replace(/^whatsapp:/, '') || profilePhone || null,
      listeningReason: configured ? 'twilio webhook mode' : 'twilio env missing',
      requestedProvider: config.WHATSAPP_PROVIDER,
      actualProvider: 'TWILIO_API',
      providerFallbackReason: null,
    };
  }
  return {
    ready: botState.ready,
    authenticated: botState.authenticated,
    lifecycle: botState.lifecycle,
    notReadySince: botState.notReadySince ? new Date(botState.notReadySince).toISOString() : null,
    reconnectAttempts: botState.reconnectAttempts,
    lastReconnectAt: botState.lastReconnectAt,
    lastWatchdogRestartAt: botState.lastWatchdogRestartAt,
    connectedPhone: botState.connectedPhone ?? profilePhone ?? null,
    listeningReason: botState.listeningReason,
    requestedProvider: botState.requestedProvider,
    actualProvider: botState.actualProvider,
    providerFallbackReason: botState.providerFallbackReason,
  };
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
  const storedCampaignLimit = storage.getAdminSettings().maxCampaignsOverride;
  const maxCampaigns = normalizeCampaignLimit(storedCampaignLimit) ?? config.CLIENT_MAX_CAMPAIGNS;
  return {
    plan: config.CLIENT_PLAN,
    readonlyDashboard: config.CLIENT_READONLY_DASHBOARD,
    maxCampaigns,
    serviceExpiresAt: expiresAt,
    serviceExpired,
    whatsappProvider: config.WHATSAPP_PROVIDER,
    twilioConfigured: twilioConfigured(),
    campaignCount,
    referralContestEnabled: true,
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
    decisionFlow: sanitizeDecisionFlow(input?.decisionFlow, defaults.decisionFlow, true),
    decisionTimeoutMinutes: typeof input?.decisionTimeoutMinutes === 'number' && input.decisionTimeoutMinutes > 0
      ? Math.min(Math.max(Math.round(input.decisionTimeoutMinutes), 1), 1440)
      : (defaults.decisionTimeoutMinutes ?? 30),
    decisionTimeoutText: typeof input?.decisionTimeoutText === 'string'
      ? input.decisionTimeoutText.trim().slice(0, 2000)
      : (defaults.decisionTimeoutText ?? ''),
    decisionTimeoutMode: input?.decisionTimeoutMode === 'flow' ? 'flow' : 'message',
    decisionTimeoutNextStepId: typeof input?.decisionTimeoutNextStepId === 'string'
      ? input.decisionTimeoutNextStepId.trim().slice(0, 80)
      : (defaults.decisionTimeoutNextStepId ?? ''),
    invalidReplyText: typeof input?.invalidReplyText === 'string'
      ? input.invalidReplyText.trim().slice(0, 2000)
      : (defaults.invalidReplyText ?? ''),
    flowRecoveryText: typeof input?.flowRecoveryText === 'string'
      ? input.flowRecoveryText.trim().slice(0, 2000)
      : (defaults.flowRecoveryText ?? ''),
    humanHandoffEnabled: typeof input?.humanHandoffEnabled === 'boolean'
      ? input.humanHandoffEnabled
      : Boolean(defaults.humanHandoffEnabled),
    humanHandoffText: typeof input?.humanHandoffText === 'string'
      ? input.humanHandoffText.trim().slice(0, 2000)
      : (defaults.humanHandoffText ?? ''),
    humanHandoffPhone: typeof input?.humanHandoffPhone === 'string'
      ? input.humanHandoffPhone.replace(/[^\d+]/g, '').slice(0, 30)
      : (defaults.humanHandoffPhone ?? ''),
    groupJoinManagerPhone: typeof input?.groupJoinManagerPhone === 'string' ? input.groupJoinManagerPhone.replace(/[^\d+]/g, '').slice(0, 30) : (defaults.groupJoinManagerPhone ?? ''),
    groupJoinParticipantConfirmationText: typeof input?.groupJoinParticipantConfirmationText === 'string' ? input.groupJoinParticipantConfirmationText.trim().slice(0, 2000) : (defaults.groupJoinParticipantConfirmationText ?? ''),
    groupJoinParticipantFailureText: typeof input?.groupJoinParticipantFailureText === 'string' ? input.groupJoinParticipantFailureText.trim().slice(0, 2000) : (defaults.groupJoinParticipantFailureText ?? ''),
    groupJoinMetaTemplateName: typeof input?.groupJoinMetaTemplateName === 'string' ? input.groupJoinMetaTemplateName.trim().replace(/[^a-z0-9_]/gi, '').slice(0, 512) : (defaults.groupJoinMetaTemplateName ?? ''),
    groupJoinMetaTemplateLanguage: typeof input?.groupJoinMetaTemplateLanguage === 'string' ? input.groupJoinMetaTemplateLanguage.trim().replace(/[^a-zA-Z_-]/g, '').slice(0, 20) : (defaults.groupJoinMetaTemplateLanguage ?? 'he'),
    groupJoinMetaTemplateParams: Array.isArray(input?.groupJoinMetaTemplateParams)
      ? input.groupJoinMetaTemplateParams.slice(0, 10).map((value: unknown) => String(value ?? '').slice(0, 500))
      : (defaults.groupJoinMetaTemplateParams ?? []),
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

function inferredReferralAction(option: Partial<DecisionFlowOption>, referralHub = false): DecisionFlowOption['action'] | undefined {
  if (option.action) return option.action;
  const endText = String(option.endText || '');
  if (endText.includes('{referral_link}')) return 'referral_link';
  if (endText.includes('{rank}') || endText.includes('{participants}') || endText.includes('{referrals}')) return 'referral_my_rank';
  if (referralHub) return 'referral_leaderboard';
  const text = String(option.text || '').trim();
  if (text === '\u05d9\u05e6\u05d9\u05e8\u05ea \u05dc\u05d9\u05e0\u05e7 \u05d0\u05d9\u05e9\u05d9') return 'referral_link';
  if (text === '\u05d4\u05e6\u05d2\u05ea \u05de\u05d5\u05d1\u05d9\u05dc\u05d9\u05dd') return 'referral_leaderboard';
  if (text === '\u05de\u05d4 \u05d4\u05de\u05e7\u05d5\u05dd \u05e9\u05dc\u05d9?') return 'referral_my_rank';
  return undefined;
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
      const kind = item.kind === 'question' || item.kind === 'score_question' || item.kind === 'score_result' || item.kind === 'wait_reply' || item.kind === 'email_capture' || item.kind === 'contact_card' || (referralContestEnabled && item.kind === 'referral_share') ? item.kind : 'message';
      let text = typeof item.text === 'string' ? item.text.trim().slice(0, 2000) : '';
      if (!text && kind === 'score_result') text = '\u05d7\u05d9\u05e9\u05d5\u05d1 \u05ea\u05d5\u05e6\u05d0\u05d4';
      const fileId = typeof item.fileId === 'string' ? item.fileId.trim().slice(0, 80) : '';
      const canSendWithoutText = kind === 'contact_card' || (kind === 'message' && Boolean(fileId));
      if (!text && !canSendWithoutText) return null;

      const step: DecisionFlowStep = { id, kind, text };
      if (kind === 'email_capture' && typeof item.emailInvalidText === 'string' && item.emailInvalidText.trim()) {
        step.emailInvalidText = item.emailInvalidText.trim().slice(0, 500);
      }
      if (kind === 'question' && item.referralHub === true) step.referralHub = true;
      if (typeof item.nextStepId === 'string' && item.nextStepId.trim()) {
        step.nextStepId = item.nextStepId.trim().slice(0, 80);
      }
      if (typeof item.delayMs === 'number' && Number.isFinite(item.delayMs) && item.delayMs > 0) {
        step.delayMs = Math.min(Math.max(Math.round(item.delayMs), 0), 60_000);
      }
      if (kind === 'message' || kind === 'referral_share') {
        if (fileId) step.fileId = fileId;
        if (kind === 'message' && typeof item.fileAsSticker === 'boolean') {
          step.fileAsSticker = item.fileAsSticker;
        }
      }
      if ((kind === 'wait_reply' || kind === 'email_capture' || kind === 'referral_share') && typeof item.timeoutMinutes === 'number' && item.timeoutMinutes > 0) {
        step.timeoutMinutes = Math.min(Math.max(Math.round(item.timeoutMinutes), 1), 1440);
      }
      if ((kind === 'wait_reply' || kind === 'email_capture' || kind === 'referral_share') && typeof item.timeoutSeconds === 'number' && Number.isFinite(item.timeoutSeconds) && item.timeoutSeconds > 0) {
        step.timeoutSeconds = Math.min(Math.max(Math.round(item.timeoutSeconds), 1), 86400);
      }
      if (kind === 'wait_reply' || kind === 'email_capture' || kind === 'referral_share') {
        if (item.timeoutMode === 'continue') {
          step.timeoutMode = 'continue';
          if (typeof item.timeoutNextStepId === 'string' && item.timeoutNextStepId.trim()) {
            step.timeoutNextStepId = item.timeoutNextStepId.trim().slice(0, 80);
          }
        } else if (item.timeoutMode === 'stop') {
          step.timeoutMode = 'stop';
        }
        if (typeof item.timeoutText === 'string' && item.timeoutText.trim()) {
          step.timeoutText = item.timeoutText.trim().slice(0, 2000);
        }
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
        const referralActionCount = rawOptions.filter((option) => {
          if (!option || typeof option !== 'object') return false;
          const action = inferredReferralAction(option as Partial<DecisionFlowOption>);
          return action === 'referral_link' || action === 'referral_leaderboard' || action === 'referral_my_rank';
        }).length;
        if (kind === 'question' && referralActionCount >= 2) step.referralHub = true;

        if (item.presentation === 'text' || item.presentation === 'buttons' || item.presentation === 'list') {
          step.presentation = item.presentation;
        }
        if (step.presentation === 'list' && typeof item.listButtonText === 'string' && item.listButtonText.trim()) {
          step.listButtonText = Array.from(item.listButtonText.trim()).slice(0, 20).join('');
        }
        if (typeof item.timeoutMinutes === 'number' && item.timeoutMinutes > 0) {
          step.timeoutMinutes = Math.min(Math.max(Math.round(item.timeoutMinutes), 1), 1440);
        }
        if (typeof item.timeoutSeconds === 'number' && Number.isFinite(item.timeoutSeconds) && item.timeoutSeconds > 0) {
          step.timeoutSeconds = Math.min(Math.max(Math.round(item.timeoutSeconds), 1), 86400);
        }
        if (item.timeoutMode === 'continue') {
          step.timeoutMode = 'continue';
          if (typeof item.timeoutNextStepId === 'string' && item.timeoutNextStepId.trim()) {
            step.timeoutNextStepId = item.timeoutNextStepId.trim().slice(0, 80);
          }
        } else if (item.timeoutMode === 'stop') {
          step.timeoutMode = 'stop';
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
            if (typeof rawOption.buttonLabel === 'string' && rawOption.buttonLabel.trim()) {
              clean.buttonLabel = Array.from(rawOption.buttonLabel.trim()).slice(0, 20).join('');
            }
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
            if (rawOption.raffleEntry === true) {
              clean.raffleEntry = true;
            }
            const action = inferredReferralAction(rawOption, step.referralHub === true);
            if (action === 'request_group_join' || action === 'referral_link' || action === 'referral_leaderboard' || action === 'referral_my_rank') {
              clean.action = action;
              delete clean.fileId; delete clean.fileAsSticker;
              if (step.referralHub && (action === 'referral_link' || action === 'referral_leaderboard' || action === 'referral_my_rank')) {
                delete clean.nextStepId;
              }
              if (action === 'request_group_join') delete clean.endText;
              if (action === 'referral_leaderboard') {
                clean.referralLeaderboardDisplay = rawOption.referralLeaderboardDisplay === 'names_only'
                  ? 'names_only'
                  : 'names_and_counts';
                if (typeof rawOption.referralLeaderboardEmptyText === 'string' && rawOption.referralLeaderboardEmptyText.trim()) {
                  clean.referralLeaderboardEmptyText = rawOption.referralLeaderboardEmptyText.trim().slice(0, 1000);
                }
                if (Array.isArray(rawOption.referralLeaderboardSeeds)) {
                  clean.referralLeaderboardSeeds = rawOption.referralLeaderboardSeeds
                    .map((entry) => ({
                      name: typeof entry?.name === 'string' ? entry.name.trim().slice(0, 80) : '',
                      invited: Number.isFinite(Number(entry?.invited))
                        ? Math.min(Math.max(Math.round(Number(entry.invited)), 0), 1_000_000)
                        : 3,
                    }))
                    .filter((entry) => Boolean(entry.name))
                    .slice(0, 20);
                }
              }
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
    const timeoutNextStepId = step.timeoutNextStepId === '__NEXT__' ? nextSequentialStepId : step.timeoutNextStepId;
    return {
      ...step,
      nextStepId: stepNextStepId && ids.has(stepNextStepId) ? stepNextStepId : undefined,
      timeoutNextStepId: timeoutNextStepId && ids.has(timeoutNextStepId) ? timeoutNextStepId : undefined,
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
    } else if (step.kind === 'email_capture') {
      messages.push({ from: 'bot', text: step.text.trim() });
      messages.push({ from: 'user', text: 'name@example.com' });
      const nextStepId = step.nextStepId;
      step = nextStepId ? flow.find((item) => item.id === nextStepId) : undefined;
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
  const metaGatewayInbox = new MetaGatewayInbox(path.join(path.dirname(config.OWNER_STORAGE_PATH), 'meta-gateway-inbox.json'));
  const metaClientInbox = new MetaGatewayInbox(path.join(path.dirname(config.STORAGE_PATH), 'meta-client-inbox.json'));

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

  const inspectMetaTriggerAvailability = async (
    requester: ManagedClient,
    triggerPhrase: string,
    routeId?: string,
    routeKind: MetaGatewayRoute['routeKind'] = 'campaign',
  ) => {
    const normalizedTrigger = normalizeMetaTrigger(triggerPhrase);
    if (!normalizedTrigger) return { available: false, conflicts: [], sameClientConflicts: [], crossClientConflicts: [] };
    const metaClients = ownerStorage.getClients().filter((client) =>
      client.whatsappProvider === 'META_CLOUD_API' && client.managementUrl && client.ownerAccessToken && client.provisioningStatus !== 'disabled');
    const results = await Promise.all(metaClients.map(async (client) => {
      const routeResult = await fetchClientAsOwner<MetaGatewayRoute[]>(client, '/owner-api/meta-routes');
      if (routeResult.ok && Array.isArray(routeResult.body)) return { client, result: routeResult };
      if (routeResult.status !== 404) return { client, result: routeResult };
      const campaignResult = await fetchClientAsOwner<Campaign[]>(client, '/owner-api/campaigns');
      return {
        client,
        result: campaignResult.ok && Array.isArray(campaignResult.body)
          ? { ...campaignResult, body: campaignsToMetaGatewayRoutes(campaignResult.body) }
          : campaignResult,
      };
    }));
    const unavailable = results.filter(({ result }) => !result.ok || !Array.isArray(result.body));
    if (unavailable.length) throw new Error(`Could not verify Meta triggers for ${unavailable.length} managed client(s).`);
    const conflicts: Array<{ clientId: string; routeId: string; routeKind: MetaGatewayRoute['routeKind']; routeName: string; triggerPhrase: string; exact: boolean }> = [];
    for (const { client, result } of results) {
      for (const route of result.body as MetaGatewayRoute[]) {
        if (client.id === requester.id && route.id === routeId && route.routeKind === routeKind) continue;
        if (!metaCampaignReservesTrigger(route)) continue;
        const otherTrigger = normalizeMetaTrigger(route.triggerPhrase || '');
        const exact = otherTrigger === normalizedTrigger;
        const overlaps = exact || otherTrigger.includes(normalizedTrigger) || normalizedTrigger.includes(otherTrigger);
        if (!otherTrigger || !overlaps) continue;
        conflicts.push({ clientId: client.id, routeId: route.id, routeKind: route.routeKind, routeName: route.name, triggerPhrase: route.triggerPhrase, exact });
      }
    }
    const sameClientConflicts = conflicts.filter((conflict) => conflict.clientId === requester.id);
    const crossClientConflicts = conflicts.filter((conflict) => conflict.clientId !== requester.id);
    const blockingCrossClientConflicts = crossClientConflicts.filter((conflict) => conflict.exact);
    const warningConflicts = [...sameClientConflicts, ...crossClientConflicts.filter((conflict) => !conflict.exact)];
    return {
      available: blockingCrossClientConflicts.length === 0,
      conflicts,
      sameClientConflicts,
      crossClientConflicts,
      blockingCrossClientConflicts,
      warning: warningConflicts.length
        ? 'אזהרה: קיים מסלול פעיל עם משפט טריגר זהה או דומה. במקרה של התאמה לשני מסלולים, סדר העדיפות של הניתוב יקבע מי מהם יופעל.'
        : undefined,
      warningCode: warningConflicts.length ? 'META_TRIGGER_OVERLAP' : undefined,
    };
  };

  const campaignWouldReserveTrigger = (active: boolean, endAt?: string): boolean => {
    if (!active) return false;
    if (!endAt) return true;
    const end = new Date(endAt).getTime();
    return Number.isNaN(end) || end >= Date.now();
  };

  type MetaTriggerVerification = {
    ok: boolean;
    status: number;
    error?: string;
    code?: string;
    warning?: string;
    warningCode?: string;
  };

  const verifyMetaTriggerBeforeActivation = async (
    triggerPhrase: string,
    routeId?: string,
    routeKind: MetaGatewayRoute['routeKind'] = 'campaign',
    blockOccupied = true,
  ): Promise<MetaTriggerVerification> => {
    if (config.WHATSAPP_PROVIDER !== 'META_CLOUD_API') return { ok: true, status: 200 };
    const ownerToken = process.env.OWNER_ACCESS_TOKEN?.trim();
    if (!ownerToken) return { ok: false, status: 503, error: 'לא ניתן לבדוק כרגע אם משפט הטריגר פנוי. יש לפנות למנהל המערכת.', code: 'META_TRIGGER_CHECK_UNAVAILABLE' };
    try {
      const url = new URL('/internal/meta/trigger-availability', config.META_GATEWAY_BASE_URL).toString();
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Owner-Token': ownerToken },
        body: JSON.stringify({ triggerPhrase, routeId, routeKind, campaignId: routeKind === 'campaign' ? routeId : undefined }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json().catch(() => ({})) as {
        available?: boolean;
        error?: string;
        warning?: string;
        warningCode?: string;
      };
      if (!response.ok) return { ok: false, status: response.status, error: body.error || 'בדיקת משפט הטריגר נכשלה.', code: 'META_TRIGGER_CHECK_UNAVAILABLE' };
      if (body.available !== true && blockOccupied) return { ok: false, status: 409, error: 'משפט הטריגר הזה כבר תפוס אצל לקוח Meta אחר. יש לבחור משפט טריגר אחר.', code: 'META_TRIGGER_OCCUPIED' };
      if (body.available !== true) return { ok: true, status: 200, warning: 'משפט הטריגר תפוס כרגע אצל לקוח אחר. ניתן לשמור את הבוט כבוי, אך לא יהיה ניתן להפעיל אותו.', warningCode: 'META_TRIGGER_OCCUPIED_DRAFT' };
      return { ok: true, status: 200, warning: body.warning, warningCode: body.warningCode };
    } catch (err) {
      console.error('[META_TRIGGER_CHECK_FAILED]', err);
      return { ok: false, status: 503, error: 'לא ניתן לבדוק כרגע אם משפט הטריגר פנוי. נסה שוב בעוד רגע.', code: 'META_TRIGGER_CHECK_UNAVAILABLE' };
    }
  };

  const withMetaTriggerWarning = <T extends object>(value: T, verification: MetaTriggerVerification): T & {
    warning?: string;
    warningCode?: string;
  } => verification.warning
    ? { ...value, warning: verification.warning, warningCode: verification.warningCode }
    : value;

  app.post('/internal/meta/trigger-availability', async (req, res) => {
    const requester = managedClientForOwnerToken(req.get('x-owner-token'));
    if (!requester || requester.whatsappProvider !== 'META_CLOUD_API') {
      res.status(401).json({ error: 'Managed client token is invalid' });
      return;
    }
    if (requester.provisioningStatus === 'disabled') {
      res.status(409).json({ error: 'Managed client is disabled in the central gateway' });
      return;
    }
    const triggerPhrase = String(req.body?.triggerPhrase || '').trim();
    if (!triggerPhrase) {
      res.status(400).json({ error: 'Trigger phrase is required' });
      return;
    }
    try {
      const routeKind = req.body?.routeKind === 'service_bot' ? 'service_bot' : 'campaign';
      const routeId = String(req.body?.routeId || req.body?.campaignId || '').trim() || undefined;
      res.json(await inspectMetaTriggerAvailability(requester, triggerPhrase, routeId, routeKind));
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
    const whatsappHealth = getWhatsAppHealth(storage.getClientProfile().whatsappPhone);
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
      outbox: { ...storage.getOutboxHealth(), deliveryFailed: storage.getFailedDeliveries(100).length },
      storage: storage.getStorageHealth(),
      conversations: {
        pending: conversationState.size(),
        durableTimers: storage.getDurableTimerHealth(),
        flowHealth: getFlowHealthSnapshot(),
        metaGatewayInbox: metaGatewayInbox.counts(),
      },
      whatsapp: {
        ...whatsappHealth,
        shouldRun: storage.hasCampaignsNeedingBot(),
      },
      twilio: {
        configured: twilioConfigured(),
        recentEvents: twilioEvents,
        lastEventAt: twilioEvents[0]?.at ?? null,
      },
    });
  });

  const twilioInboundMeta = (payload: any) => ({
    // Twilio's dynamically-created quick replies use numeric ButtonPayload ids;
    // the visible ButtonText is needed to distinguish navigation buttons from
    // numbered options in the current Service Bot node.
    body: String(payload?.ButtonText ?? payload?.ButtonPayload ?? payload?.ListId ?? payload?.Body ?? '').trim(),
    from: String(payload?.From ?? '').trim(),
    to: String(payload?.To ?? '').trim(),
    id: String(payload?.MessageSid ?? payload?.SmsMessageSid ?? (String(payload?.From ?? '') + ':' + Date.now())),
    profileName: String(payload?.ProfileName ?? '').trim(),
    media: Number(payload?.NumMedia || 0) > 0 ? {
      kind: String(payload?.MediaContentType0 || '').startsWith('image/') ? 'image'
        : String(payload?.MediaContentType0 || '').startsWith('video/') ? 'video'
          : String(payload?.MediaContentType0 || '').startsWith('audio/') ? 'audio'
            : 'document',
      mimeType: String(payload?.MediaContentType0 || '').trim() || undefined,
      providerUrl: String(payload?.MediaUrl0 || '').trim() || undefined,
    } as IncomingWhatsAppMessage['media'] : undefined,
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
      media: meta.media,
      hasUserSignal: Boolean(meta.body || meta.media),
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

  // Delivery statuses arrive on the same webhook as inbound messages but under `statuses`.
  // They carry the wamid we stored as providerMessageId, so the client that sent the message
  // can record whether it was actually delivered/read or failed after the API accepted it.
  const handleMetaStatusesForStorage = (payload: any): boolean => {
    const statuses = payload?.entry?.[0]?.changes?.[0]?.value?.statuses;
    if (!Array.isArray(statuses) || !statuses.length) return false;
    let matched = false;
    for (const status of statuses) {
      const wamid = String(status?.id || '').trim();
      const rawStatus = String(status?.status || '').trim();
      if (!wamid || !['sent', 'delivered', 'read', 'failed'].includes(rawStatus)) continue;
      const errorDetail = Array.isArray(status?.errors) && status.errors[0]
        ? `${status.errors[0].code ?? ''} ${status.errors[0].title ?? status.errors[0].message ?? ''}`.trim()
        : undefined;
      const updated = storage.recordOutboxDelivery(wamid, rawStatus as 'sent' | 'delivered' | 'read' | 'failed', errorDetail);
      if (updated) {
        matched = true;
        if (rawStatus === 'failed') console.error(`[META_DELIVERY_FAILED] to=${updated.to} wamid=${wamid} error=${errorDetail ?? ''}`);
        else console.log(`[META_DELIVERY] to=${updated.to} wamid=${wamid} status=${rawStatus}`);
      } else {
        const recipient = String(status?.recipient_id || '').replace(/\D/g, '');
        const label = rawStatus === 'failed' ? '[META_DELIVERY_UNTRACKED_FAILED]' : '[META_DELIVERY_UNTRACKED]';
        console.log(`${label} to=whatsapp:${recipient} wamid=${wamid} status=${rawStatus} error=${errorDetail ?? ''}`);
      }
    }
    return matched;
  };

  const handleMetaInboundForStorage = async (payload: any): Promise<void> => {
    const value = payload?.entry?.[0]?.changes?.[0]?.value;
    if (Array.isArray(value?.statuses)) {
      handleMetaStatusesForStorage(payload);
      return;
    }
    const message = value?.messages?.[0];
    if (!message?.from || !message?.id) {
      console.log('[META_WEBHOOK_IGNORED] reason=no_messages');
      return;
    }
    const contact = value?.contacts?.[0];
    const body = getMetaInboundBody(message);
    const isButtonReply = isMetaButtonReply(message);
    const mediaPayload = message?.image || message?.video || message?.audio || message?.document || message?.sticker;
    const mediaKind = ['image', 'video', 'audio', 'document', 'sticker'].includes(String(message?.type || ''))
      ? String(message.type) as NonNullable<IncomingWhatsAppMessage['media']>['kind']
      : undefined;
    const provider = new MetaCloudProvider();
    console.log('[META_INBOUND]', message.id, message.from, body.slice(0, 120), `type=${String(message?.type || 'unknown')}`);
    await handleIncomingWhatsAppMessage({
      id: String(message.id),
      from: 'whatsapp:' + String(message.from),
      to: 'whatsapp:' + normalizeSharePhone(config.META_DISPLAY_PHONE_NUMBER),
      body,
      hasUserSignal: Boolean(body || isButtonReply || mediaPayload),
      isButtonReply,
      media: mediaKind && mediaPayload ? {
        kind: mediaKind,
        mimeType: String(mediaPayload?.mime_type || '').trim() || undefined,
        fileName: String(mediaPayload?.filename || '').trim() || undefined,
        providerMediaId: String(mediaPayload?.id || '').trim() || undefined,
      } : undefined,
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
    const body = getMetaInboundBody(message);
    const normalizedBody = normalizeGatewayText(body);
    const campaignsByClient = new Map<string, MetaGatewayRoute[]>();
    const pendingByClient = new Map<string, MetaPendingRouteResponse>();
    const legacyRoutingClients = new Set<string>();
    const routingStartedAt = Date.now();
    let lookupFailures = 0;
    const candidates: Array<{ client: ManagedClient; clientId: string; campaign: MetaGatewayRoute; triggerText: string }> = [];
    await Promise.all(clients.map(async (client) => {
      try {
        // Correct isolation requires a fresh answer from every client. Cached
        // route data could hide a container that has just gone offline.
        const snapshotResult = await fetchClientAsOwner<MetaRoutingSnapshotResponse>(client, '/owner-api/meta-routing-snapshot', {
          method: 'POST',
          body: JSON.stringify({ phone: fromKey }),
          signal: AbortSignal.timeout(3_000),
        });
        let campaigns: MetaGatewayRoute[];
        if (snapshotResult.ok && Array.isArray(snapshotResult.body?.routes)) {
          campaigns = snapshotResult.body.routes;
          pendingByClient.set(client.id, snapshotResult.body.pendingRoute ?? { pending: false });
        } else {
          if (snapshotResult.status !== 404) throw new Error('Meta routing snapshot failed with status ' + snapshotResult.status);
          legacyRoutingClients.add(client.id);
          const routeResult = await fetchClientAsOwner<MetaGatewayRoute[]>(client, '/owner-api/meta-routes', {
            signal: AbortSignal.timeout(3_000),
          });
          if (routeResult.ok && Array.isArray(routeResult.body)) {
            campaigns = routeResult.body;
          } else {
            if (routeResult.status !== 404) throw new Error('Meta route lookup failed with status ' + routeResult.status);
            const campaignResult = await fetchClientAsOwner<Campaign[]>(client, '/owner-api/campaigns', {
              signal: AbortSignal.timeout(3_000),
            });
            if (!campaignResult.ok || !Array.isArray(campaignResult.body)) {
              throw new Error('Campaign fallback lookup failed with status ' + campaignResult.status);
            }
            campaigns = campaignsToMetaGatewayRoutes(campaignResult.body);
          }
        }
        campaignsByClient.set(client.id, campaigns);
        for (const campaign of campaigns) {
          if (!campaign.active || (campaign.runtimeStatus && campaign.runtimeStatus !== 'active')) continue;
          const triggerText = normalizeGatewayText(campaign.triggerPhrase ?? '');
          if (triggerText && normalizedBody.includes(triggerText)) candidates.push({ client, clientId: client.id, campaign, triggerText });
        }
      } catch (err) {
        lookupFailures += 1;
        console.error('[META_GATEWAY_CLIENT_SKIPPED]', client.id, err);
      }
    }));

    // With a shared Meta number, even one missing client makes the global
    // routing picture incomplete. Never let another client's trigger or an
    // old phone-only session win while the real owner may be unavailable.
    if (lookupFailures > 0) {
      throw new Error(`Campaign routing incomplete for ${lookupFailures} client(s); refusing unsafe fallback`);
    }

    const eligibleCandidates = preferCampaignMetaRoutes(candidates);
    const { best, ambiguous } = selectMetaRouteCandidate(eligibleCandidates);
    if (ambiguous) {
      console.error('[META_GATEWAY_AMBIGUOUS] reason=ambiguous_trigger', message.id, message.from);
      throw new Error('Ambiguous Meta trigger ownership; refusing cross-client routing');
    }

    let targetClient: ManagedClient | null = best?.client ?? null;
    let routedCampaignId = best?.campaign.id ?? '';
    let routedTriggerText = best?.triggerText ?? '';

    // A fresh trigger match means this sender has moved on, even if some
    // other client (sharing this same Meta number) still thinks it has a
    // conversation open with them - possibly still well inside its own
    // timeout. Clear those before forwarding, so a stale pending
    // conversation on client A can never intercept a reply meant for the
    // brand-new conversation on client B.
    if (targetClient) {
      const staleClients = clients.filter(
        (client) => client.id !== targetClient!.id && pendingByClient.get(client.id)?.pending,
      );
      if (staleClients.length) {
        await Promise.all(staleClients.map(async (client) => {
          try {
            const result = await fetchClientAsOwner<{ removed?: number }>(client, '/owner-api/meta-clear-pending', {
              method: 'POST',
              body: JSON.stringify({ phone: fromKey }),
              signal: AbortSignal.timeout(3_000),
            });
            if (result.ok) {
              console.log('[META_GATEWAY_CLEAR_PENDING]', client.id, `removed=${result.body?.removed ?? 0}`);
            } else {
              console.warn('[META_GATEWAY_CLEAR_PENDING_FAILED]', client.id, `status=${result.status}`);
            }
          } catch (err) {
            // Best-effort: worst case the stale conversation lingers until its
            // own timeout, which is exactly today's pre-fix behavior - never
            // block or fail the new trigger's own routing over this.
            console.warn('[META_GATEWAY_CLEAR_PENDING_FAILED]', client.id, err);
          }
        }));
      }
    }

    // META follow-ups are resolved from client-owned pending state, never from
    // the gateway's historical phone session. This prevents a conversation on
    // one customer from capturing a new or follow-up message for another.
    if (!targetClient && !best) {
      let pendingLookupFailures = 0;
      const pendingMatches = (await Promise.all(clients.map(async (client) => {
        try {
          let pendingRoute = pendingByClient.get(client.id);
          if (legacyRoutingClients.has(client.id)) {
            const result = await fetchClientAsOwner<MetaPendingRouteResponse>(client, '/owner-api/meta-pending-route', {
              method: 'POST',
              body: JSON.stringify({ phone: fromKey }),
              signal: AbortSignal.timeout(3_000),
            });
            if (!result.ok) {
              pendingLookupFailures += 1;
              console.warn('[META_GATEWAY_PENDING_LOOKUP_FAILED]', client.id, `status=${result.status}`);
              return null;
            }
            pendingRoute = result.body;
          }
          if (!pendingRoute?.pending || !pendingRoute.campaignId) return null;
          const routes = campaignsByClient.get(client.id) ?? [];
          const campaign = routes.find((route) => route.id === pendingRoute.campaignId);
          if (!campaign?.active || campaign.runtimeStatus !== 'active') return null;
          return { client, campaign };
        } catch (err) {
          pendingLookupFailures += 1;
          console.warn('[META_GATEWAY_PENDING_LOOKUP_FAILED]', client.id, err);
          return null;
        }
      }))).filter((match): match is { client: ManagedClient; campaign: MetaGatewayRoute } => Boolean(match));

      const fallbackDecision = decideMetaFallbackRoute({
        routeLookupFailures: lookupFailures,
        pendingLookupFailures,
        pendingClientIds: pendingMatches.map((match) => match.client.id),
      });
      if (fallbackDecision.action === 'retry') {
        throw new Error(`Pending Meta routing incomplete for ${pendingLookupFailures} client(s); refusing unsafe fallback`);
      }
      if (fallbackDecision.action === 'route') {
        const pendingMatch = pendingMatches.find((match) => match.client.id === fallbackDecision.clientId)!;
        targetClient = pendingMatch.client;
        routedCampaignId = pendingMatch.campaign.id;
        console.warn('[META_GATEWAY_PENDING_ROUTED]', message.id, message.from, targetClient.id, `campaign=${routedCampaignId}`);
      } else if (fallbackDecision.action === 'ambiguous') {
        console.error('[META_GATEWAY_AMBIGUOUS] reason=ambiguous_pending_conversation', message.id, message.from, `matches=${pendingMatches.length}`);
        throw new Error('Ambiguous pending Meta conversation ownership; refusing cross-client routing');
      }
    }

    if (!targetClient) {
      console.log('[META_GATEWAY_IGNORED] reason=no_trigger_or_pending_conversation', message.id, message.from);
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
      throw err;
    }
    if (!forwarded.ok) {
      console.error('[META_GATEWAY_FAILED]', selectedClient.id, forwarded.status, JSON.stringify(forwarded.body).slice(0, 300));
      throw new Error(`Meta gateway forward failed with status ${forwarded.status}`);
    } else {
      console.log(
        '[META_GATEWAY_ROUTED]',
        message.id,
        targetClient.id,
        routedCampaignId ? `campaign=${routedCampaignId}` : 'campaign=unknown',
        routedTriggerText ? `trigger=${routedTriggerText}` : 'trigger=pending',
        `clients_checked=${clients.length}`,
        `candidates=${eligibleCandidates.length}`,
        `route_ms=${Date.now() - routingStartedAt}`,
      );
    }
    return { handled: true };
  };

  let metaGatewayInboxRunning = false;
  const processMetaGatewayInbox = async (): Promise<void> => {
    if (metaGatewayInboxRunning) return;
    metaGatewayInboxRunning = true;
    try {
      while (true) {
        const batch = metaGatewayInbox.claimBatch(20, (item) => metaPayloadSenderKey(item.payload));
        if (!batch.length) break;
        await Promise.all(groupMetaItemsBySender(batch).map(async (items) => {
          for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
            const item = items[itemIndex];
            try {
              const gateway = await routeMetaGatewayInbound(item.payload);
              if (!gateway.handled) await handleMetaInboundForStorage(item.payload);
              metaGatewayInbox.markCompleted(item.id);
            } catch (err) {
              if (item.attempts >= 10) {
                metaGatewayInbox.markFailed(item.id, err);
                console.error('[META_GATEWAY_INBOX_FAILED]', item.id, err);
              } else {
                const retryDelayMs = Math.min(5_000 * (2 ** Math.max(0, item.attempts - 1)), 5 * 60_000);
                const nextAttemptAt = new Date(Date.now() + retryDelayMs);
                metaGatewayInbox.markRetry(item.id, err, nextAttemptAt);
                // The remaining items were already claimed as part of this
                // batch. Put them back on the same retry boundary so a reply
                // can never overtake its trigger for the same sender.
                for (const deferred of items.slice(itemIndex + 1)) {
                  metaGatewayInbox.markRetry(
                    deferred.id,
                    `Waiting for earlier Meta message ${item.id}`,
                    nextAttemptAt,
                  );
                }
                console.warn('[META_GATEWAY_INBOX_RETRY]', item.id, `attempt=${item.attempts}`, err);
                break;
              }
            }
          }
        }));
      }
    } finally {
      metaGatewayInboxRunning = false;
    }
  };
  setInterval(() => { void processMetaGatewayInbox(); }, 2_000);
  void processMetaGatewayInbox();

  let metaClientInboxRunning = false;
  const processMetaClientInbox = async (): Promise<void> => {
    if (metaClientInboxRunning) return;
    metaClientInboxRunning = true;
    try {
      while (true) {
        const batch = metaClientInbox.claimBatch(20, (item) => metaPayloadSenderKey(item.payload));
        if (!batch.length) break;
        await Promise.all(groupMetaItemsBySender(batch).map(async (items) => {
          for (const item of items) {
            try {
              await handleMetaInboundForStorage(item.payload);
              metaClientInbox.markCompleted(item.id);
            } catch (err) {
              if (item.attempts >= 10) {
                metaClientInbox.markFailed(item.id, err);
                console.error('[META_CLIENT_INBOX_FAILED]', item.id, err);
              } else {
                const retryDelayMs = Math.min(5_000 * (2 ** Math.max(0, item.attempts - 1)), 5 * 60_000);
                metaClientInbox.markRetry(item.id, err, new Date(Date.now() + retryDelayMs));
                console.warn('[META_CLIENT_INBOX_RETRY]', item.id, `attempt=${item.attempts}`, err);
              }
            }
          }
        }));
      }
    } finally {
      metaClientInboxRunning = false;
    }
  };
  setInterval(() => { void processMetaClientInbox(); }, 2_000);
  void processMetaClientInbox();

  // Broadcast a delivery-status webhook to every managed Meta client; each ignores wamids it
  // does not own. Fire-and-forget: statuses are high-volume and self-superseding, so a missed
  // one is corrected by the next, and we must not block the webhook response.
  const forwardMetaStatusToClients = (payload: any): void => {
    const clients = ownerStorage.getClients().filter((client) =>
      client.whatsappProvider === 'META_CLOUD_API' && client.managementUrl && client.ownerAccessToken && client.provisioningStatus !== 'disabled');
    for (const client of clients) {
      void fetchClientAsOwner(client, '/internal/meta/whatsapp', {
        method: 'POST',
        body: JSON.stringify(payload ?? {}),
      }).catch((err) => console.warn('[META_STATUS_FORWARD_FAILED]', client.id, err));
    }
  };

  app.post('/webhooks/meta/whatsapp', (req, res) => {
    const statusPayloads = splitMetaWebhookStatuses(req.body);
    const messagePayloads = splitMetaWebhookMessages(req.body);
    if (!statusPayloads.length && !messagePayloads.length) {
      res.sendStatus(200);
      return;
    }

    try {
      for (const statusPayload of statusPayloads) {
        handleMetaStatusesForStorage(statusPayload);
        forwardMetaStatusToClients(statusPayload);
      }
      for (const item of messagePayloads) {
        const message = item.payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        const body = getMetaInboundBody(message);
        console.log('[META_GATEWAY_INBOUND]', item.id, message?.from, `type=${String(message?.type || 'unknown')}`, body.slice(0, 120));
        metaGatewayInbox.enqueue(item.id, item.payload);
      }
      res.sendStatus(200);
      if (messagePayloads.length) void processMetaGatewayInbox();
    } catch (err) {
      console.error('[META_GATEWAY_INBOX_PERSIST_FAILED]', messagePayloads.map((item) => item.id).join(','), err);
      res.sendStatus(503);
    }
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
  app.get('/public/client-name', (req, res) => {
    const origin = String(req.get('origin') ?? '').trim();
    if (!origin) {
      res.status(400).json({ error: 'Origin header is required.' });
      return;
    }
    let normalizedOrigin = '';
    try {
      normalizedOrigin = new URL(origin).origin;
    } catch {
      res.status(400).json({ error: 'Invalid origin.' });
      return;
    }
    const client = ownerStorage.getClients().find((item) => getClientBaseUrl(item) === normalizedOrigin);
    if (!client) {
      res.status(404).json({ error: 'Client is not registered for this origin.' });
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', normalizedOrigin);
    res.setHeader('Vary', 'Origin');
    res.json({ clientName: client.name });
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
      if (client.provisioningStatus === 'disabled') {
        return {
          id: client.id,
          summary: {
            reachable: false,
            error: 'הלקוחה מושבתת במערכת המרכזית. הנתונים והשירות לא נמחקו.',
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
    dokployPostgresDatabasePassword: undefined,
    postgresStorageEnabled: Boolean(client.dokployPostgresId),
    metaWebhookUrl: dokployProvisioner.getMetaWebhookUrl(client),
    twilioWebhookUrl: dokployProvisioner.getTwilioWebhookUrl(client),
  });

  app.post('/owner/api/clients', async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const accessCode = String(req.body?.accessCode ?? '').trim();
    const providerInput = String(req.body?.whatsappProvider ?? '').trim();
    if (providerInput && !['BAILEYS', 'META_CLOUD_API'].includes(providerInput)) {
      res.status(400).json({ error: 'New clients can be created only as Baileys or Meta Cloud API clients.' });
      return;
    }
    const requestedProvider = (providerInput || 'BAILEYS') as Extract<ManagedClient['whatsappProvider'], 'BAILEYS' | 'META_CLOUD_API'>;
    const plan: ManagedClient['plan'] = 'self_service';
    const maxCampaigns = Math.max(1, Math.min(Number(req.body?.maxCampaigns) || 7, 50));
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
      readonlyDashboard: false,
      maxCampaigns,
      serviceExpiresAt,
      whatsappProvider: requestedProvider,
      twilioFrom: undefined,
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

  app.patch('/owner/api/clients/:id', async (req, res) => {
    const client = ownerStorage.getClient(req.params.id);
    if (!client) {
      res.status(404).json({ error: 'לקוחה לא נמצאה' });
      return;
    }
    const patch: Partial<ManagedClient> = {};
    if ('maxCampaigns' in req.body) {
      const maxCampaigns = normalizeCampaignLimit(req.body?.maxCampaigns);
      if (maxCampaigns === null) {
        res.status(400).json({ error: 'מגבלת הקמפיינים חייבת להיות מספר שלם בין 1 ל-50.' });
        return;
      }
      patch.maxCampaigns = maxCampaigns;
    }
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
    if (patch.maxCampaigns !== undefined && client.managementUrl && client.provisioningStatus !== 'disabled') {
      try {
        const synced = await fetchClientAsOwner(client, '/owner-api/settings/campaign-limit', {
          method: 'PATCH',
          body: JSON.stringify({ maxCampaigns: patch.maxCampaigns }),
        });
        if (!synced.ok) {
          res.status(502).json({
            error: synced.body?.error || 'שמירת המגבלה ביחידת הלקוח נכשלה. יש לעדכן את היחידה לגרסה האחרונה ולנסות שוב.',
          });
          return;
        }
      } catch (err) {
        res.status(502).json({
          error: err instanceof Error ? err.message : 'לא ניתן לעדכן כרגע את יחידת הלקוח.',
        });
        return;
      }
    }
    const updated = ownerStorage.updateClient(client.id, patch);
    res.json(updated ? exposeOwnerClient(updated) : null);
  });

  app.post('/owner/api/clients/:id/disable', (req, res) => {
    const client = ownerStorage.getClient(req.params.id);
    if (!client) {
      res.status(404).json({ error: 'לקוחה לא נמצאה' });
      return;
    }
    if (client.provisioningStatus === 'disabled') {
      res.json(exposeOwnerClient(client));
      return;
    }
    const updated = ownerStorage.updateClient(client.id, {
      provisioningStatus: 'disabled',
      disabledAt: new Date().toISOString(),
      disabledReason: String(req.body?.reason || 'הושבתה ידנית מדשבורד המנהלים').trim().slice(0, 240),
    });
    console.log('[OWNER_CLIENT_DISABLED]', client.id, client.name);
    res.json(updated ? exposeOwnerClient(updated) : null);
  });

  app.post('/owner/api/clients/:id/enable', async (req, res) => {
    const client = ownerStorage.getClient(req.params.id);
    if (!client) {
      res.status(404).json({ error: 'לקוחה לא נמצאה' });
      return;
    }
    if (client.provisioningStatus !== 'disabled') {
      res.json(exposeOwnerClient(client));
      return;
    }
    if (!client.managementUrl) {
      res.status(409).json({ error: 'לא ניתן להפעיל מחדש לקוחה ללא כתובת שירות.' });
      return;
    }
    try {
      const healthUrl = new URL('/health', client.managementUrl).toString();
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(8_000) });
      const health = await response.json().catch(() => null) as {
        clientConfigured?: boolean;
        storage?: { ready?: boolean };
      } | null;
      if (!response.ok || health?.clientConfigured !== true || health?.storage?.ready === false) {
        res.status(503).json({ error: 'השירות של הלקוחה עדיין אינו זמין או שהאחסון אינו מוכן. הלקוחה נשארה מושבתת.' });
        return;
      }
      if (client.whatsappProvider === 'META_CLOUD_API') {
        const routesResult = await fetchClientAsOwner<MetaGatewayRoute[]>(client, '/owner-api/meta-routes', {
          signal: AbortSignal.timeout(8_000),
        });
        if (!routesResult.ok || !Array.isArray(routesResult.body)) {
          res.status(503).json({ error: 'לא ניתן לקרוא את הטריגרים של הלקוחה. הלקוחה נשארה מושבתת ולא צורפה לניתוב.' });
          return;
        }
        const reservedRoutes = routesResult.body.filter(metaCampaignReservesTrigger);
        const checks = await Promise.all(reservedRoutes.map((route) =>
          inspectMetaTriggerAvailability(client, route.triggerPhrase, route.id, route.routeKind)));
        if (checks.some((check) => check.available !== true)) {
          res.status(409).json({ error: 'לא ניתן להפעיל מחדש: לפחות טריגר פעיל אחד של הלקוחה תפוס אצל לקוח Meta אחר.' });
          return;
        }
      }
      const updated = ownerStorage.updateClient(client.id, {
        provisioningStatus: 'ready',
        provisioningError: undefined,
        disabledAt: undefined,
        disabledReason: undefined,
      });
      console.log('[OWNER_CLIENT_ENABLED]', client.id, client.name);
      res.json(updated ? exposeOwnerClient(updated) : null);
    } catch (err) {
      console.warn('[OWNER_CLIENT_ENABLE_FAILED]', client.id, err);
      res.status(503).json({ error: 'לא ניתן להשלים את בדיקות הבריאות והטריגרים. הלקוחה נשארה מושבתת ולא צורפה לניתוב.' });
    }
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
    if (client.provisioningStatus === 'disabled') {
      res.status(409).json({ error: 'הלקוחה מושבתת. יש להשתמש בפעולת הפעלה מחדש.' });
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
    if (client.provisioningStatus === 'disabled') {
      res.status(409).json({ error: 'הלקוחה מושבתת. יש להפעיל אותה מחדש לפני פריסה.' });
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
    if (client.provisioningStatus === 'disabled') {
      res.json({
        reachable: false,
        error: 'הלקוחה מושבתת במערכת המרכזית. הנתונים והשירות לא נמחקו.',
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
      } satisfies OwnerClientSummary);
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

  app.post('/internal/meta/whatsapp', requireOwnerApiToken, async (req, res) => {
    if (config.WHATSAPP_PROVIDER !== 'META_CLOUD_API') {
      res.status(409).json({ error: 'Meta Cloud API provider is not enabled for this client' });
      return;
    }
    const statusPayloads = splitMetaWebhookStatuses(req.body);
    const messagePayloads = splitMetaWebhookMessages(req.body);
    if (!statusPayloads.length && !messagePayloads.length) {
      res.json({ ok: true, ignored: true });
      return;
    }
    try {
      for (const statusPayload of statusPayloads) handleMetaStatusesForStorage(statusPayload);
      for (const item of messagePayloads) metaClientInbox.enqueue(item.id, item.payload);
      res.status(messagePayloads.length ? 202 : 200).json({
        ok: true,
        queued: messagePayloads.length,
        statuses: statusPayloads.length,
      });
      if (messagePayloads.length) void processMetaClientInbox();
    } catch (err) {
      console.error('[META_CLIENT_INBOX_PERSIST_FAILED]', messagePayloads.map((item) => item.id).join(','), err);
      res.status(503).json({ error: 'Meta message could not be queued' });
    }
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

  app.patch('/owner-api/settings/campaign-limit', (req, res) => {
    const maxCampaigns = normalizeCampaignLimit(req.body?.maxCampaigns);
    if (maxCampaigns === null) {
      res.status(400).json({ error: 'Campaign limit must be an integer between 1 and 50.' });
      return;
    }
    storage.updateAdminSettings({ maxCampaignsOverride: maxCampaigns });
    res.json({ ok: true, maxCampaigns });
  });

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

  app.get('/owner-api/meta-routes', (_req, res) => {
    res.json(buildMetaGatewayRoutes(storage));
  });

  app.post('/owner-api/meta-routing-snapshot', (req, res) => {
    const phone = normalizeGatewayPhone(String(req.body?.phone || ''));
    if (!phone) {
      res.status(400).json({ error: 'Phone is required' });
      return;
    }
    res.json({
      routes: buildMetaGatewayRoutes(storage),
      pendingRoute: localMetaPendingRoute(storage, phone),
    } satisfies MetaRoutingSnapshotResponse);
  });

  app.post('/owner-api/meta-pending-route', (req, res) => {
    const phone = normalizeGatewayPhone(String(req.body?.phone || ''));
    if (!phone) {
      res.status(400).json({ error: 'Phone is required' });
      return;
    }
    res.json(localMetaPendingRoute(storage, phone));
  });

  // Called by the gateway right before forwarding a freshly-matched trigger
  // to its owning client, for every OTHER client that reported a pending
  // conversation for the same phone. A new trigger means the sender has
  // moved on, so any older pending conversation here - even one still well
  // inside its own timeout - must stop being a candidate immediately.
  app.post('/owner-api/meta-clear-pending', (req, res) => {
    const phone = normalizeGatewayPhone(String(req.body?.phone || ''));
    if (!phone) {
      res.status(400).json({ error: 'Phone is required' });
      return;
    }
    const removed = conversationState.removeByPhone(phone);
    res.json({ removed });
  });

  app.post('/owner-api/campaigns', async (req, res) => {
    const { name, triggerType, triggerPhrase, basePhrase, referrerName, startAt, endAt, conversation, twilio } =
      req.body as Partial<Campaign>;
    const contactNameSuffix = req.body?.contactNameSuffix;
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
      suffix = campaignContactSuffix(contactNameSuffix, storage.getAdminSettings().botSuffix);
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
    res.status(201).json(withMetaTriggerWarning(campaign, triggerAvailability));
  });

  app.patch('/owner-api/campaigns/:id/toggle', async (req, res) => {
    const current = storage.getCampaigns().find((campaign) => campaign.id === String(req.params.id));
    if (!current) {
      res.status(404).json({ error: 'קמפיין לא נמצא' });
      return;
    }
    let triggerAvailability: MetaTriggerVerification = { ok: true, status: 200 };
    if (!current.active && campaignWouldReserveTrigger(true, current.endAt)) {
      triggerAvailability = await verifyMetaTriggerBeforeActivation(current.triggerPhrase, current.id);
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
    res.json(withMetaTriggerWarning(updated, triggerAvailability));
  });

  app.delete('/owner-api/campaigns/:id', (req, res) => {
    res.json({ ok: storage.deleteCampaign(String(req.params.id)) });
  });

  // ── QR code status ────────────────────────────────────────────────────────

  app.get('/api/qr', (_req, res) => {
    const profile = storage.getClientProfile();
    if (config.WHATSAPP_PROVIDER === 'META_CLOUD_API' || config.WHATSAPP_PROVIDER === 'TWILIO_API') {
      res.json({
        qr: null,
        pairingCode: null,
        pairingError: null,
        ...getWhatsAppHealth(profile.whatsappPhone),
        shouldRun: storage.hasCampaignsNeedingBot(),
      });
      return;
    }
    res.json({
      qr: botState.qrDataUrl,
      authenticated: botState.authenticated,
      ready: botState.ready,
      pairingCode: botState.pairingCode,
      pairingError: botState.pairingError,
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
    if (config.WHATSAPP_PROVIDER === 'META_CLOUD_API' || config.WHATSAPP_PROVIDER === 'TWILIO_API') {
      res.status(409).json({ error: 'קוד התחברות זמין רק בחיבור WhatsApp Web/Baileys, לא בחיבור API רשמי.' });
      return;
    }

    let phone = String(req.body.phone ?? '').replace(/\D/g, '');
    if (phone.startsWith('0')) phone = '972' + phone.slice(1);
    if (!phone) { res.status(400).json({ error: 'מספר טלפון חסר' }); return; }
    const blockedUntil = botState.pairingCodeBlockedUntil ?? getPairingCodeBlockedUntil();
    if (blockedUntil && blockedUntil > Date.now()) {
      botState.pairingCodeBlockedUntil = blockedUntil;
      const message = pairingCodeRateLimitMessage(blockedUntil);
      botState.pairingError = message;
      res.status(429).json({ error: message });
      return;
    }

    try {
      // Reset and start in a single lifecycle transition. This prevents the
      // keep-connected scheduler from starting a second Baileys socket between
      // the session cleanup and the manual pairing-code startup.
      await resetAndStartWhatsAppBot(storage, 'pairing code request', phone);
    } catch (err: any) {
      botState.intentionalRestart = false;
      botState.pairingError = err?.message ?? 'שגיאה בהפעלת הבוט';
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
      await resetAndStartWhatsAppBot(storage, 'manual dashboard QR reset');
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
        clientName: config.CLIENT_NAME || undefined,
        clientDirectoryUrl: config.CLIENT_DIRECTORY_URL || undefined,
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
      clientName: config.CLIENT_NAME || undefined,
      clientDirectoryUrl: config.CLIENT_DIRECTORY_URL || undefined,
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

  app.get('/api/service-bot', (_req, res) => {
    res.json({
      featureEnabled: config.CLIENT_SERVICE_BOT_ENABLED,
      serviceBot: storage.getServiceBot(),
      serviceBots: storage.getServiceBots(),
    });
  });

  app.get('/api/service-bots', (_req, res) => {
    res.json({ featureEnabled: config.CLIENT_SERVICE_BOT_ENABLED, serviceBots: storage.getServiceBots() });
  });

  app.post('/api/service-bot/validate', (req, res) => {
    const result = validateServiceBotConfig(req.body);
    res.status(result.ok ? 200 : 400).json(result);
  });

  const saveServiceBotCandidate = async (candidate: ServiceBotConfig, botId?: string) => {
    const validation = validateServiceBotConfig(candidate);
    if (!validation.ok) return { ok: false as const, status: 400, body: validation };
    const routeId = botId ? serviceBotMetaRouteId(botId) : undefined;
    const verification = await verifyMetaTriggerBeforeActivation(candidate.triggerText, routeId, 'service_bot', candidate.enabled);
    if (!verification.ok) return { ok: false as const, status: verification.status, body: { error: verification.error, code: verification.code } };
    const serviceBot = botId ? storage.updateServiceBot({ ...candidate, id: botId }, botId) : storage.createServiceBot(candidate);
    return { ok: true as const, status: botId ? 200 : 201, body: withMetaTriggerWarning({ ok: true, featureEnabled: config.CLIENT_SERVICE_BOT_ENABLED, serviceBot, serviceBots: storage.getServiceBots() }, verification) };
  };

  app.post('/api/service-bots', requireWritableClient, async (req, res) => {
    const result = await saveServiceBotCandidate(req.body as ServiceBotConfig);
    res.status(result.status).json(result.body);
  });

  app.put('/api/service-bots/:id', requireWritableClient, async (req, res) => {
    const botId = String(req.params.id);
    if (!storage.getServiceBots().some((bot) => bot.id === botId)) { res.status(404).json({ error: 'בוט השירות לא נמצא.' }); return; }
    const result = await saveServiceBotCandidate(req.body as ServiceBotConfig, botId);
    res.status(result.status).json(result.body);
  });

  app.post('/api/service-bots/:id/duplicate', requireWritableClient, (req, res) => {
    const serviceBot = storage.duplicateServiceBot(String(req.params.id));
    if (!serviceBot) { res.status(404).json({ error: 'בוט השירות לא נמצא.' }); return; }
    res.status(201).json({ ok: true, serviceBot, serviceBots: storage.getServiceBots() });
  });

  app.delete('/api/service-bots/:id', requireWritableClient, (req, res) => {
    const deleted = storage.deleteServiceBot(String(req.params.id));
    res.status(deleted ? 200 : 404).json(deleted ? { ok: true, serviceBots: storage.getServiceBots() } : { error: 'בוט השירות לא נמצא.' });
  });

  app.put('/api/service-bot', requireWritableClient, async (req, res) => {
    const candidate = req.body as ServiceBotConfig;
    const validation = validateServiceBotConfig(candidate);
    if (!validation.ok) {
      res.status(400).json(validation);
      return;
    }
    const existing = storage.getServiceBots()[0];
    const result = await saveServiceBotCandidate(candidate, existing?.id);
    res.status(result.status).json(result.body);
  });

  app.get('/api/service-bot/records', (req, res) => {
    res.json({ records: storage.getServiceBotRecords(100, String(req.query.botId || '').trim() || undefined) });
  });

  app.delete('/api/service-bot/sessions', requireWritableClient, (req, res) => {
    const deleted = storage.clearServiceBotSessions(String(req.query.botId || '').trim() || undefined);
    res.json({ ok: true, deleted });
  });

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
    if (detectedMimeType.startsWith('image/') && buffer.length > 5 * 1024 * 1024) {
      res.status(400).json({ error: '\u05d4\u05ea\u05de\u05d5\u05e0\u05d4 \u05d2\u05d3\u05d5\u05dc\u05d4 \u05de\u05d3\u05d9. \u05e0\u05d9\u05ea\u05df \u05dc\u05d4\u05e2\u05dc\u05d5\u05ea \u05ea\u05de\u05d5\u05e0\u05d4 \u05e2\u05d3 5MB.' });
      return;
    }
    const maxBytes = 18 * 1024 * 1024;
    if (buffer.length > maxBytes) {
      res.status(400).json({ error: 'הקובץ גדול מדי. המגבלה כרגע היא 18MB.' });
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

  // Read-only recovery aid: app_state is the immutable import checkpoint, not the live delta store.
  app.get('/api/campaigns/:id/checkpoint', requireWritableClient, async (req, res) => {
    if (!config.DATABASE_URL) { res.status(404).json({ error: 'No PostgreSQL checkpoint is configured for this client.' }); return; }
    const pool = new Pool({ connectionString: config.DATABASE_URL });
    try {
      const result = await pool.query<{ data: { campaigns?: Campaign[] } }>('select data from app_state where key = $1', ['storage']);
      const campaign = result.rows[0]?.data?.campaigns?.find((item) => item.id === req.params.id) ?? null;
      res.json({ campaign, available: Boolean(campaign) });
    } catch (err) {
      console.error('[CAMPAIGN_CHECKPOINT_READ_FAILED]', err);
      res.status(502).json({ error: 'Could not read the PostgreSQL checkpoint.' });
    } finally {
      await pool.end();
    }
  });

  // Preflight: catch the misconfigurations that otherwise fail silently at runtime.
  const preflightCampaign = (campaign: Campaign) => {
    const settings = storage.getCampaignConversationSettings(campaign);
    const flow = settings.decisionFlow ?? [];
    const errors: string[] = [];
    const warnings: string[] = [];
    const stepIds = new Set(flow.map((step) => step.id));
    const referenced = new Set<string>();
    let usesGroupJoin = false;
    for (const step of flow) {
      for (const option of step.options ?? []) {
        if (option.nextStepId && option.nextStepId !== '__NEXT__') referenced.add(option.nextStepId);
        if (option.action === 'request_group_join') usesGroupJoin = true;
        if (option.fileId && !storage.getUploadedFile(option.fileId)) errors.push(`שלב "${step.text?.slice(0, 30) || step.id}": קובץ מצורף לא קיים.`);
      }
      if (step.nextStepId && step.nextStepId !== '__NEXT__') referenced.add(step.nextStepId);
      for (const option of step.options ?? []) {
        if (option.nextStepId && option.nextStepId !== '__NEXT__' && !stepIds.has(option.nextStepId)) {
          errors.push(`שלב "${step.text?.slice(0, 30) || step.id}": מפנה ליעד שלא קיים.`);
        }
      }
    }
    // Steps nobody reaches (besides the first sendable step) are usually mistakes.
    const firstSendable = flow.find((step) => (step.text?.trim() || step.kind === 'contact_card' || (step.kind === 'message' && step.fileId)));
    for (const step of flow) {
      if (step === firstSendable) continue;
      if (!referenced.has(step.id)) warnings.push(`שלב "${step.text?.slice(0, 30) || step.id}": אף שלב לא מוביל אליו.`);
    }
    if (usesGroupJoin) {
      if (!String(settings.groupJoinManagerPhone || '').trim()) errors.push('יש כפתור "בקשת צירוף לקבוצה" אבל לא הוגדר מספר WhatsApp של המנהלת.');
      if (config.WHATSAPP_PROVIDER === 'META_CLOUD_API' && !String(settings.groupJoinMetaTemplateName || '').trim()) {
        warnings.push('בקשת צירוף ללא תבנית Meta מאושרת תיכשל אם המנהלת לא כתבה לבוט ב-24 השעות האחרונות.');
      }
      if (!String(settings.groupJoinParticipantFailureText || '').trim()) warnings.push('לא הוגדרה הודעת כשל למשתתפת בבקשת צירוף; תישלח הודעת ברירת מחדל.');
    }
    if (!String(settings.flowRecoveryText || '').trim()) warnings.push('לא הוגדר טקסט התאוששות ממצב אבוד; ייעשה שימוש בברירת מחדל.');
    return { ok: errors.length === 0, errors, warnings };
  };

  app.get('/api/campaigns/:id/preflight', (req, res) => {
    const campaign = storage.getCampaigns().find((item) => item.id === req.params.id);
    if (!campaign) { res.status(404).json({ error: 'Campaign not found' }); return; }
    res.json(preflightCampaign(campaign));
  });

  // Send-test: exercise the group-join manager notification once, surfacing the provider's answer.
  app.post('/api/campaigns/:id/group-join/test', requireWritableClient, async (req, res) => {
    const campaign = storage.getCampaigns().find((item) => item.id === req.params.id);
    if (!campaign) { res.status(404).json({ error: 'Campaign not found' }); return; }
    if (config.WHATSAPP_PROVIDER !== 'META_CLOUD_API') { res.status(409).json({ error: 'זמין רק ללקוח Meta Cloud API.' }); return; }
    const settings = conversationSettings(req.body?.conversation, storage.getCampaignConversationSettings(campaign));
    const managerPhone = String(settings.groupJoinManagerPhone || '').replace(/\D/g, '');
    if (!managerPhone) { res.status(400).json({ error: 'לא הוגדר מספר WhatsApp של המנהלת.' }); return; }
    const templateName = String(settings.groupJoinMetaTemplateName || '').trim();
    const params = (settings.groupJoinMetaTemplateParams ?? []).length
      ? settings.groupJoinMetaTemplateParams!.map((value) => String(value ?? '').split('{phone}').join('972500000000').split('{campaign}').join(campaign.name).split('{name}').join('בדיקה').trim())
      : ['972500000000', campaign.name];
    try {
      const provider = new MetaCloudProvider();
      if (templateName) {
        const result = await provider.sendTemplateMessage(`whatsapp:${managerPhone}`, templateName, String(settings.groupJoinMetaTemplateLanguage || 'he'), params);
        res.json({ ok: true, mode: 'template', providerMessageId: result.messageId || null, note: 'Meta קיבלה את הבקשה. מסירה בפועל תופיע בסטטוס המסירה.' });
      } else {
        const result = await provider.sendMessage(`whatsapp:${managerPhone}`, `בדיקת בקשת צירוף מקמפיין ${campaign.name}.`);
        res.json({ ok: true, mode: 'text', providerMessageId: result.messageId || null, note: 'נשלחה הודעת טקסט (עובדת רק בתוך חלון 24 השעות).' });
      }
    } catch (err) {
      res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/delivery-failures', (_req, res) => {
    res.json({ failures: storage.getFailedDeliveries(30).map((message) => ({
      to: message.to, error: message.deliveryError, at: message.deliveryUpdatedAt, label: message.label || message.kind,
    })) });
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

  app.post('/api/campaign-results/:id/referrals/demo', requireWritableClient, (req, res) => {
    const campaign = storage.getCampaigns().find((item) => item.id === req.params.id);
    if (!campaign) { res.status(404).json({ error: 'Campaign not found' }); return; }
    const result = storage.seedCampaignReferralDemo(campaign.id);
    res.json({ ok: true, campaignId: campaign.id, ...result, referrals: storage.getCampaignReferralLeaderboard(campaign.id) });
  });

  app.delete('/api/campaign-results/:id/referrals/demo', requireWritableClient, (req, res) => {
    const campaign = storage.getCampaigns().find((item) => item.id === req.params.id);
    if (!campaign) { res.status(404).json({ error: 'Campaign not found' }); return; }
    const removed = storage.clearCampaignReferralDemo(campaign.id);
    res.json({ ok: true, campaignId: campaign.id, removed, referrals: storage.getCampaignReferralLeaderboard(campaign.id) });
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
      'campaign,phone,email,emailCollectedAt,whatsappName,fallbackName,lastStage,lastEventAt,status,triggeredAt,updatedAt',
      ...storage.getCampaignResults(campaign.id, resultBatchId).map((result) => [
        csvValue(campaign.name),
        csvValue(result.phone),
        csvValue(result.email ?? ''),
        csvValue(result.emailCollectedAt ?? ''),
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
    const statusLabels: Record<string, string> = {
      awaiting_name: 'ממתין לשם',
      pending: 'ממתין לשמירה',
      saved: 'נשמר',
      failed: 'שמירה נכשלה',
    };
    const eventTypeLabels: Record<string, string> = {
      step_sent: 'הגיעו לשלב',
      step_answered: 'לחצו או ענו',
      score_answered: 'ענו על שאלת ניקוד',
      email_captured: 'כתובת מייל נקלטה',
      raffle_entry: '\u05d6\u05db\u05d0\u05d5\u05ea \u05dc\u05d4\u05d2\u05e8\u05dc\u05d4',
      contact_card_confirmed: 'אישרו שמירת איש קשר',
      completion_sent: 'הודעת סיום נשלחה',
      completion_link_sent: 'קישור סיום נשלח',
      completed: 'השלימו את התהליך',
      human_handoff: 'עברו למענה אנושי',
      referral_link_sent: 'קישור הפניה נשלח',
      referral_attributed: 'כניסה יוחסה להפניה',
    };
    Object.assign(eventTypeLabels, {
      pre_name_prompt_sent: 'נשלחה הודעת פתיחה לפני שם',
      pre_name_prompt_failed: 'הודעת פתיחה לפני שם נכשלה',
      pre_name_replied: 'ענו לפתיחה לפני שם',
      pre_name_auto_continue: 'המשיכו אוטומטית אחרי פתיחה',
      ask_name_sent: 'נשלחה שאלת שם',
      group_join_request: 'בקשת צירוף נשלחה למנהלת',
      timeout_flow_started: 'המשיכו אוטומטית אחרי אי מענה',
      decision_timeout_sent: 'נשלחה הודעת אי מענה',
      file_sent: 'קובץ נשלח',
      file_failed: 'שליחת קובץ נכשלה',
      completion_file_sent: 'קובץ סיום נשלח',
      completion_file_failed: 'שליחת קובץ סיום נכשלה',
      referral_leaderboard_viewed: 'צפו בטבלת מפנות',
      referral_rank_viewed: 'בדקו דירוג אישי',
    });
    const reportableEventTypes = new Set(Object.keys(eventTypeLabels));
    const eventDisplayLabel = (event: { type: string; label?: string }): string => {
      const typeLabel = eventTypeLabels[event.type] ?? event.type;
      if (event.type === 'completed' || event.type === 'human_handoff') return typeLabel;
      return event.label ? `${typeLabel}: ${event.label}` : typeLabel;
    };
    const confirmsContactSave = (event: { type: string; label?: string }): boolean => {
      if (event.type === 'contact_card_confirmed') return true;
      if (event.type !== 'step_answered' && event.type !== 'score_answered') return false;
      const label = String(event.label ?? '')
        .normalize('NFKC')
        .replace(/[^\p{L}\p{N}()+\-.\s]/gu, '')
        .trim();
      return /^\u05e9\u05de\u05e8\u05ea\u05d9(?:\s*\([^)]*\))?$/.test(label);
    };
    const personDisplayName = (result: typeof results[number]): string =>
      contactNames.get(result.phone) || result.fallbackName || result.whatsappName || result.phone;
    const reportableEvents = events.filter((event) => reportableEventTypes.has(event.type));
    const participantTotal = summary.total || results.length;
    const eventPersonKey = (event: typeof events[number]): string => event.campaignResultId || event.phone || '';
    const eventCount = (type: string): number => events.filter((event) => event.type === type).length;
    const uniqueEventPeople = (predicate: (event: typeof events[number]) => boolean): number => {
      const people = new Set<string>();
      events.forEach((event) => {
        if (!predicate(event)) return;
        const key = eventPersonKey(event);
        if (key) people.add(key);
      });
      return people.size;
    };
    const percentText = (count: number): string => participantTotal ? `${Math.round((count / participantTotal) * 1000) / 10}%` : '0%';
    const cleanActionLabel = (event: { type: string; label?: string }): string => {
      const label = String(event.label ?? eventTypeLabels[event.type] ?? event.type).trim();
      if (event.type === 'group_join_request' && label.includes(':')) {
        return label.split(':').slice(1).join(':').trim() || label;
      }
      return label;
    };
    const checkpointCounts = new Map<string, { label: string; people: Set<string> }>();
    reportableEvents.forEach((event) => {
      const personKey = event.campaignResultId || event.phone;
      if (!personKey) return;
      const key = `${event.type}\\u0000${event.label ?? ''}`;
      const checkpoint = checkpointCounts.get(key) ?? { label: eventDisplayLabel(event), people: new Set<string>() };
      checkpoint.people.add(personKey);
      checkpointCounts.set(key, checkpoint);
    });

    const title = `דוח תוצאות קמפיין – ${campaign.name}`;
    const summaryRows: Array<[string, string | number]> = [
      ['שם הקמפיין', campaign.name],
      ['מזהה הקמפיין', campaign.id],
      ['מועד הפקת הדוח', new Date().toLocaleString('he-IL')],
      ['קובץ התוצאות', resultBatchId],
      ['סך המשתתפים', summary.total],
      ['אנשי קשר שנשמרו', summary.saved],
      ['ממתינים לשמירה', summary.pending],
      ['שמירת אנשי קשר שנכשלה', summary.failed],
      ['השלימו את התהליך', summary.completed],
      ['עברו למענה אנושי', summary.humanHandoff],
      ['ענו או לחצו על שאלת בחירה', uniqueEventPeople((event) => event.type === 'step_answered' || event.type === 'score_answered')],
      ['מסרו כתובת מייל', results.filter((result) => Boolean(result.email)).length],
      ['בקשות צירוף שנשלחו למנהלת', uniqueEventPeople((event) => event.type === 'group_join_request')],
      ['נכנסו להגרלה', uniqueEventPeople((event) => event.type === 'raffle_entry')],
      ['המשיכו אוטומטית אחרי אי מענה', uniqueEventPeople((event) => event.type === 'timeout_flow_started')],
      ['קיבלו הודעת אי מענה', uniqueEventPeople((event) => event.type === 'decision_timeout_sent')],
      ['קיבלו קובץ במהלך התהליך', uniqueEventPeople((event) => event.type === 'file_sent')],
      ['קיבלו קובץ סיום', uniqueEventPeople((event) => event.type === 'completion_file_sent')],
      ['ממוצע ניקוד', summary.scoreAverage],
      ['קישורי הפניה שנשלחו', storage.getCampaignEvents(campaign.id).filter((event) => event.type === 'referral_link_sent').length],
      ['כניסות שיוחסו להפניה', results.filter((result) => result.referredByCode).length],
    ];

    const maxEventsPerPerson = Math.max(0, ...results.map((result) => (eventsByResult.get(result.id) ?? []).length));
    const eventHeaders = Array.from({ length: maxEventsPerPerson }, (_, index) => [`אירוע ${index + 1} – סוג`, `אירוע ${index + 1} – פירוט`]).flat();
    const detailHeaders = ['קמפיין', 'שם', 'טלפון', 'מייל', 'מועד קליטת המייל', 'שם WhatsApp', 'שם שנשמר/שם חלופי', 'סטטוס', 'שלב אחרון', 'מועד כניסה', 'מועד עדכון', 'כל השלבים והפעולות', 'מספר אירועים', ...eventHeaders, 'ניקוד כולל', 'תשובות ניקוד'];
    const detailRows: Array<Array<string | number>> = results.map((result) => {
      const personEvents = eventsByResult.get(result.id) ?? [];
      const stepLabels = personEvents.map((event) => eventDisplayLabel(event)).join(' | ');
      const scoreAnswers = (result.scoreAnswers ?? []).map((answer) => `${answer.question}: ${answer.answerText} (${answer.score})`).join(' | ');
      const eventCells = personEvents.flatMap((event) => [event.type, event.label ?? '']);
      while (eventCells.length < maxEventsPerPerson * 2) eventCells.push('');
      return [campaign.name, personDisplayName(result), result.phone, result.email ?? '', result.emailCollectedAt ?? '', result.whatsappName ?? '', result.fallbackName ?? '', statusLabels[result.status] ?? result.status, eventTypeLabels[result.lastStage ?? ''] ?? result.lastStage ?? '', result.triggeredAt, result.updatedAt, stepLabels, personEvents.length, ...eventCells, result.scoreTotal ?? '', scoreAnswers];
    });

    const peopleHeaders = ['שם', 'טלפון', 'מייל', 'מועד קליטת המייל', 'סטטוס', 'מועד כניסה', 'שלב או פעולה אחרונים', 'מועד עדכון', 'מספר שלבים ופעולות', 'אישר/ה שמירה', 'סיים/ה', 'ניקוד'];
    const peopleRows: Array<Array<string | number>> = results.map((result) => {
      const personEvents = eventsByResult.get(result.id) ?? [];
      const personReportableEvents = personEvents.filter((event) => reportableEventTypes.has(event.type));
      const lastEvent = personReportableEvents[personReportableEvents.length - 1];
      return [
        personDisplayName(result),
        result.phone,
        result.email ?? '',
        result.emailCollectedAt ?? '',
        statusLabels[result.status] ?? result.status,
        result.triggeredAt,
        lastEvent ? eventDisplayLabel(lastEvent) : 'התחיל/ה את הקמפיין',
        result.updatedAt,
        personReportableEvents.length,
        personEvents.some(confirmsContactSave) ? 'כן' : 'לא',
        personEvents.some((event) => event.type === 'completed') ? 'כן' : 'לא',
        result.scoreTotal ?? '',
      ];
    });
    const metricsHeaders = ['מדד', 'משתתפים ייחודיים', 'מספר אירועים', 'אחוז מכל המשתתפים', 'פירוט'];
    const metricDefinitions: Array<{ label: string; types: string[]; note: string }> = [
      { label: 'התחילו קמפיין', types: [], note: 'כל מי שמופיע בתוצאות הקמפיין' },
      { label: 'קיבלו שלב או הודעה', types: ['step_sent'], note: 'כל שלב שנשלח מתוך זרימת הקמפיין' },
      { label: 'לחצו או ענו לשאלה', types: ['step_answered', 'score_answered'], note: 'תשובות רגילות ותשובות ניקוד' },
      { label: 'מסרו כתובת מייל', types: ['email_captured'], note: 'כתובות שעברו בדיקת תקינות ונשמרו' },
      { label: 'ביקשו צירוף דרך כפתור', types: ['group_join_request'], note: 'למשל הכפתור תצרפי אותי' },
      { label: 'נכנסו להגרלה', types: ['raffle_entry'], note: 'סומן באפשרות התשובה ככניסה להגרלה' },
      { label: 'קיבלו קובץ באמצע התהליך', types: ['file_sent'], note: 'קובץ שנשלח כתוצאה מבחירה או שלב' },
      { label: 'קיבלו קובץ סיום', types: ['completion_file_sent'], note: 'קובצי סיום שנשלחו' },
      { label: 'המשיכו אוטומטית אחרי אי מענה', types: ['timeout_flow_started'], note: 'המשך זרימה לאחר timeout' },
      { label: 'קיבלו הודעת אי מענה', types: ['decision_timeout_sent'], note: 'הודעת timeout בלי המשך אוטומטי' },
      { label: 'עברו למענה אנושי', types: ['human_handoff'], note: 'שאלה חופשית או בקשה לנציג' },
      { label: 'השלימו עד סוף הזרימה', types: ['completed'], note: 'רק מי הגיע לשלב סופי ללא המשך' },
    ];
    const metricsRows: Array<Array<string | number>> = metricDefinitions.map((metric) => {
      if (!metric.types.length) return [metric.label, participantTotal, participantTotal, '100%', metric.note];
      const typeSet = new Set(metric.types);
      const people = uniqueEventPeople((event) => typeSet.has(event.type));
      const count = events.filter((event) => typeSet.has(event.type)).length;
      return [metric.label, people, count, percentText(people), metric.note];
    });
    const eventTypeRows: Array<Array<string | number>> = Array.from(reportableEventTypes).map((type) => {
      const people = uniqueEventPeople((event) => event.type === type);
      return [eventTypeLabels[type] ?? type, type, people, eventCount(type), percentText(people)];
    }).filter((row) => Number(row[2]) > 0 || Number(row[3]) > 0);
    const actionCounts = new Map<string, { type: string; label: string; people: Set<string>; count: number }>();
    events
      .filter((event) => ['step_answered', 'score_answered', 'group_join_request', 'raffle_entry', 'contact_card_confirmed'].includes(event.type))
      .forEach((event) => {
        const label = cleanActionLabel(event);
        const key = `${event.type}\u0000${label}`;
        const item = actionCounts.get(key) ?? { type: event.type, label, people: new Set<string>(), count: 0 };
        const personKey = eventPersonKey(event);
        if (personKey) item.people.add(personKey);
        item.count += 1;
        actionCounts.set(key, item);
      });
    const actionRows: Array<Array<string | number>> = Array.from(actionCounts.values())
      .sort((a, b) => b.people.size - a.people.size || b.count - a.count || a.label.localeCompare(b.label))
      .map((item) => [item.label, eventTypeLabels[item.type] ?? item.type, item.people.size, item.count, percentText(item.people.size)]);

    const styleDataSheet = (sheet: ExcelJS.Worksheet, widths: number[], wrappedColumns: number[] = []): void => {
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF274E13' } };
      sheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      sheet.getRow(1).height = 32;
      sheet.columns = widths.map((width) => ({ width }));
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        row.height = 26;
        row.eachCell((cell, columnNumber) => {
          cell.alignment = { vertical: 'middle', wrapText: wrappedColumns.includes(columnNumber) };
        });
      });
      sheet.views = [{ rightToLeft: true, state: 'frozen', ySplit: 1 }];
    };
    const addDataTable = (sheet: ExcelJS.Worksheet, name: string, headers: string[], rows: Array<Array<string | number>>): void => {
      const safeRows = rows.map((values) => values.map((value) => typeof value === 'number' ? value : excelText(value)));
      if (safeRows.length) {
        sheet.addTable({ name, ref: 'A1', headerRow: true, totalsRow: false, style: { theme: 'TableStyleMedium4', showRowStripes: true }, columns: headers.map((header) => ({ name: header })), rows: safeRows });
      } else {
        sheet.addRow(headers);
      }
    };

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'FlowsBiz';
    workbook.created = new Date();
    workbook.modified = new Date();

    const summarySheet = workbook.addWorksheet('סיכום', { views: [{ rightToLeft: true }] });
    summarySheet.addRow([title]);
    summarySheet.mergeCells('A1:C1');
    summarySheet.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
    summarySheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF274E13' } };
    summarySheet.getCell('A1').alignment = { horizontal: 'right', vertical: 'middle' };
    summarySheet.addRow([]);
    summarySheet.addRow(['נתוני הקמפיין', 'ערך']);
    summaryRows.forEach(([label, value]) => summarySheet.addRow([label, typeof value === 'number' ? value : excelText(value)]));
    summarySheet.getRow(3).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    summarySheet.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF274E13' } };
    const stageHeaderRow = summarySheet.rowCount + 3;
    summarySheet.getRow(stageHeaderRow).values = ['הגעה לשלבים ופעולות', 'מספר משתתפים', 'אחוז מהמשתתפים'];
    summarySheet.getRow(stageHeaderRow).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    summarySheet.getRow(stageHeaderRow).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF274E13' } };
    const stages = [
      { label: 'התחילו את הקמפיין', count: summary.total },
      ...Array.from(checkpointCounts.values()).map((checkpoint) => ({ label: checkpoint.label, count: checkpoint.people.size })),
    ];
    stages.forEach((stage) => {
      const row = summarySheet.addRow([excelText(stage.label), stage.count]);
      row.getCell(3).value = { formula: `IFERROR(B${row.number}/$B$8,0)`, result: summary.total ? stage.count / summary.total : 0 };
      row.getCell(3).numFmt = '0%';
      row.height = 30;
    });
    summarySheet.columns = [{ width: 62 }, { width: 22 }, { width: 20 }];
    summarySheet.getColumn(1).alignment = { wrapText: true, vertical: 'middle' };
    summarySheet.views = [{ rightToLeft: true, state: 'frozen', ySplit: 3 }];

    const metricsSheet = workbook.addWorksheet('מדדים');
    addDataTable(metricsSheet, 'CampaignClearMetrics', metricsHeaders, metricsRows);
    styleDataSheet(metricsSheet, [36, 18, 16, 18, 46], [1, 5]);

    const actionSheet = workbook.addWorksheet('לחיצות וכפתורים');
    addDataTable(actionSheet, 'CampaignButtonClicks', ['כפתור או תשובה', 'סוג פעולה', 'משתתפים ייחודיים', 'מספר אירועים', 'אחוז מכל המשתתפים'], actionRows);
    styleDataSheet(actionSheet, [48, 28, 18, 16, 18], [1, 2]);

    const eventTypeSheet = workbook.addWorksheet('מדדים לפי סוג אירוע');
    addDataTable(eventTypeSheet, 'CampaignEventTypeMetrics', ['סוג אירוע', 'מזהה טכני', 'משתתפים ייחודיים', 'מספר אירועים', 'אחוז מכל המשתתפים'], eventTypeRows);
    styleDataSheet(eventTypeSheet, [34, 28, 18, 16, 18], [1]);

    const peopleSheet = workbook.addWorksheet('משתתפים ושלבים');
    addDataTable(peopleSheet, 'CampaignPeopleOverview', peopleHeaders, peopleRows);
    styleDataSheet(peopleSheet, [24, 18, 32, 22, 18, 22, 42, 22, 20, 16, 12, 12], [7]);

    const emailSheet = workbook.addWorksheet('כתובות מייל');
    const emailRows: Array<Array<string | number>> = results
      .filter((result) => Boolean(result.email))
      .map((result) => [personDisplayName(result), result.phone, result.email ?? '', result.emailCollectedAt ?? '', result.scoreTotal ?? '', campaign.name]);
    addDataTable(emailSheet, 'CampaignEmailAddresses', ['שם', 'טלפון', 'מייל', 'מועד קליטה', 'ניקוד', 'קמפיין'], emailRows);
    styleDataSheet(emailSheet, [24, 18, 34, 22, 12, 28]);

    const historySheet = workbook.addWorksheet('היסטוריית שלבים');
    const historyHeaders = ['שם', 'טלפון', 'סוג הפעולה', 'שלב או פעולה', 'תאריך ושעה'];
    const resultsById = new Map(results.map((result) => [result.id, result]));
    const historyRows: Array<Array<string | number>> = reportableEvents.map((event) => {
      const result = event.campaignResultId ? resultsById.get(event.campaignResultId) : undefined;
      return [result ? personDisplayName(result) : '', result?.phone ?? event.phone ?? '', eventTypeLabels[event.type] ?? event.type, event.label ?? eventTypeLabels[event.type] ?? '', event.createdAt];
    });
    addDataTable(historySheet, 'CampaignStageHistory', historyHeaders, historyRows);
    styleDataSheet(historySheet, [24, 18, 28, 58, 22], [4]);
    const raffleEntries = events.filter((event) => event.type === 'raffle_entry');
    const raffleSheet = workbook.addWorksheet('\u05d6\u05db\u05d0\u05d9\u05dd \u05dc\u05d4\u05d2\u05e8\u05dc\u05d4');
    const raffleHeaders = ['\u05d6\u05db\u05d0\u05d5\u05ea \u05dc\u05d4\u05d2\u05e8\u05dc\u05d4', '\u05e9\u05dd', '\u05d8\u05dc\u05e4\u05d5\u05df', '\u05de\u05d5\u05e2\u05d3 \u05dc\u05d7\u05d9\u05e6\u05d4'];
    const raffleRows: Array<Array<string | number>> = raffleEntries.map((event) => {
      const result = event.campaignResultId ? resultsById.get(event.campaignResultId) : undefined;
      return [event.label ?? '', result ? personDisplayName(result) : '', result?.phone ?? event.phone ?? '', event.createdAt];
    });
    addDataTable(raffleSheet, 'CampaignRaffleEntries', raffleHeaders, raffleRows);
    styleDataSheet(raffleSheet, [58, 24, 18, 22], [1]);


    const detailsSheet = workbook.addWorksheet('נתונים מלאים');
    addDataTable(detailsSheet, 'CampaignFullDetails', detailHeaders, detailRows);
    styleDataSheet(detailsSheet, detailHeaders.map((header) => /פירוט|תשובות|פעולות/.test(header) ? 42 : Math.min(Math.max(header.length + 3, 14), 28)), [10]);

    const eventsSheet = workbook.addWorksheet('אירועים מלאים');
    const normalizedEventHeaders = ['קמפיין', 'מזהה קמפיין', 'מזהה תוצאה', 'טלפון', 'סוג אירוע', 'פירוט', 'תאריך ושעה', 'נתונים גולמיים'];
    const normalizedEventRows = events.map((event) => {
      const result = results.find((item) => item.id === event.campaignResultId);
      return [campaign.name, campaign.id, event.campaignResultId ?? '', result?.phone ?? event.phone ?? '', event.type, event.label ?? '', event.createdAt, JSON.stringify(event)];
    });
    addDataTable(eventsSheet, 'CampaignEvents', normalizedEventHeaders, normalizedEventRows);
    styleDataSheet(eventsSheet, [24, 24, 28, 18, 26, 42, 22, 65], [6, 8]);

    const xlsx = await workbook.xlsx.writeBuffer();
    const resultBatch = storage.getCampaignResultBatches(campaign.id).find((batch) => batch.id === resultBatchId);
    const dateStamp = downloadDateStamp(resultBatch?.startedAt || campaign.currentResultBatchStartedAt);
    const downloadName = `${safeDownloadBaseName(campaign.name)} - ${dateStamp}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="campaign-${dateStamp}.xlsx"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
    );
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

    const contactNames = new Map(storage.getAllContacts().map((contact) => [
      normalizeCampaignContactPhone(contact.phone),
      contact.name,
    ]));
    const seen = new Set<string>();
    const resultBatchId = typeof req.query.batch === 'string' ? req.query.batch : storage.getCurrentCampaignResultBatchId(campaign.id);
    const contacts = storage.getCampaignResults(campaign.id, resultBatchId)
      .filter((result) => {
        const normalizedPhone = normalizeCampaignContactPhone(result.phone);
        if (!normalizedPhone || seen.has(normalizedPhone)) return false;
        seen.add(normalizedPhone);
        return true;
      })
      .map((result) => ({
        phone: result.phone,
        name: resolveCampaignContactName(result, contactNames),
      }));
    const vcard = buildContactsVCard(contacts);
    res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="campaign-${campaign.id}-contacts.vcf"`);
    res.send(vcard);
  });

  app.post('/api/campaigns', requireWritableClient, async (req, res) => {
    const { name, triggerType, triggerPhrase, basePhrase, referrerName, startAt, endAt, conversation, twilio } =
      req.body as Partial<Campaign>;
    const contactNameSuffix = req.body?.contactNameSuffix;
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
      suffix = campaignContactSuffix(contactNameSuffix, storage.getAdminSettings().botSuffix);
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
    res.json(withMetaTriggerWarning(campaign, triggerAvailability));
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
    const contactNameSuffix = req.body?.contactNameSuffix;
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
        patch.suffix = campaignContactSuffix(
          contactNameSuffix,
          existing.triggerType === 1 ? existing.suffix : storage.getAdminSettings().botSuffix,
        );
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
    let triggerAvailability: MetaTriggerVerification = { ok: true, status: 200 };
    if (campaignWouldReserveTrigger(resultingActive, resultingEndAt)) {
      triggerAvailability = await verifyMetaTriggerBeforeActivation(resultingTrigger, existing.id);
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
    res.json(withMetaTriggerWarning(updated, triggerAvailability));
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
    let triggerAvailability: MetaTriggerVerification = { ok: true, status: 200 };
    if (!current.active && campaignWouldReserveTrigger(true, current.endAt)) {
      triggerAvailability = await verifyMetaTriggerBeforeActivation(current.triggerPhrase, current.id);
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
    res.json(withMetaTriggerWarning(updated, triggerAvailability));
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
    app.get('/terms', (_req, res) => {
      res.sendFile(path.join(sitePublicDir, 'terms.html'));
    });
    app.get('/data-deletion', (_req, res) => {
      res.sendFile(path.join(sitePublicDir, 'data-deletion.html'));
    });
    app.get(['/rss/shayleshay-bereshit-pending.xml', '/shayleshay-bereshit-pending.xml'], (_req, res) => {
      res.type('application/rss+xml');
      res.sendFile(path.join(sitePublicDir, 'shayleshay-bereshit-pending.xml'));
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
