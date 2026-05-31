/**
 * adminServer.ts
 * Express server for the admin dashboard.
 * Serves static files and exposes a REST API for settings and campaigns.
 */

import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Storage, AdminSettings, Campaign, CampaignConversationSettings, DecisionFlowOption, DecisionFlowStep } from './storage';
import { config } from './config';
import { botState } from './botState';
import { startWhatsAppBot, stopWhatsAppBot } from './whatsappLifecycle';
import {
  isGoogleConnected,
  getGoogleAuthUrl,
  handleGoogleCallback,
  disconnectGoogle,
  getGoogleRelayReturnUrl,
} from './googleContacts';
import { testICloudConnection } from './icloudContacts';
import { createAccessControl } from './accessControl';
import { ManagedClient, OwnerStorage } from './ownerStorage';
import { DokployProvisioner } from './dokployProvisioner';

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
  const base = path.basename(name, path.extname(name))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'file';
  return `${base}${ext}`;
}

function getClientCapabilities(storage: Storage) {
  const expiresAt = config.CLIENT_SERVICE_EXPIRES_AT || undefined;
  const expiresTime = expiresAt ? new Date(expiresAt).getTime() : Number.POSITIVE_INFINITY;
  const serviceExpired = Number.isFinite(expiresTime) && Date.now() > expiresTime;
  return {
    plan: config.CLIENT_PLAN,
    readonlyDashboard: config.CLIENT_READONLY_DASHBOARD,
    maxCampaigns: config.CLIENT_MAX_CAMPAIGNS,
    serviceExpiresAt: expiresAt,
    serviceExpired,
    whatsappProvider: config.WHATSAPP_PROVIDER,
    campaignCount: storage.getCampaigns().length,
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
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

function conversationSettings(
  input: Partial<CampaignConversationSettings> | undefined,
  defaults: CampaignConversationSettings,
): CampaignConversationSettings {
  return {
    askNameEnabled: typeof input?.askNameEnabled === 'boolean' ? input.askNameEnabled : defaults.askNameEnabled,
    nameTimeoutMinutes: typeof input?.nameTimeoutMinutes === 'number' && input.nameTimeoutMinutes > 0
      ? input.nameTimeoutMinutes
      : defaults.nameTimeoutMinutes,
    askNameText: typeof input?.askNameText === 'string' ? input.askNameText : defaults.askNameText,
    replyText: typeof input?.replyText === 'string' ? input.replyText : defaults.replyText,
    followupMessages: Array.isArray(input?.followupMessages)
      ? input.followupMessages.filter((message): message is string => typeof message === 'string')
      : defaults.followupMessages,
    decisionFlow: sanitizeDecisionFlow(input?.decisionFlow, defaults.decisionFlow),
  };
}

function sanitizeDecisionFlow(
  input: unknown,
  defaults: DecisionFlowStep[],
): DecisionFlowStep[] {
  if (!Array.isArray(input)) return defaults;

  const steps = input
    .map((raw, index): DecisionFlowStep | null => {
      if (!raw || typeof raw !== 'object') return null;
      const item = raw as Partial<DecisionFlowStep>;
      const id = typeof item.id === 'string' && item.id.trim()
        ? item.id.trim().slice(0, 80)
        : `step-${index + 1}`;
      const kind = item.kind === 'question' ? 'question' : 'message';
      const text = typeof item.text === 'string' ? item.text.trim().slice(0, 2000) : '';
      if (!text) return null;

      const step: DecisionFlowStep = { id, kind, text };
      if (typeof item.nextStepId === 'string' && item.nextStepId.trim()) {
        step.nextStepId = item.nextStepId.trim().slice(0, 80);
      }
      if (kind === 'question' && Array.isArray(item.options)) {
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
        step.options = item.options
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
            return clean;
          })
          .filter((option): option is DecisionFlowOption => Boolean(option))
          .slice(0, 3);
      }
      return step;
    })
    .filter((step): step is DecisionFlowStep => Boolean(step))
    .slice(0, 20);

  const ids = new Set(steps.map((step) => step.id));
  return steps.map((step) => ({
    ...step,
    nextStepId: step.nextStepId && ids.has(step.nextStepId) ? step.nextStepId : undefined,
    options: step.options?.map((option) => ({
      ...option,
      nextStepId: option.nextStepId && ids.has(option.nextStepId) ? option.nextStepId : undefined,
    })),
  }));
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

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '24mb' }));

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
    res.json({
      ok: true,
      clientConfigured: Boolean(process.env.CLIENT_ACCESS_TOKEN?.trim()),
    });
  });
  app.post('/auth/client/login', access.clientLogin);
  app.post('/auth/client/logout', access.requireClient, access.clientLogout);
  app.post('/auth/owner/login', access.ownerLogin);
  app.post('/auth/owner/logout', access.requireOwner, access.ownerLogout);

  app.use('/owner/api', access.requireOwner);

  app.get('/owner/api/clients', (_req, res) => {
    res.json(ownerStorage.getClients());
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

  app.post('/owner/api/clients', async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const accessCode = String(req.body?.accessCode ?? '').trim();
    const plan = ['basic', 'self_service', 'advanced'].includes(String(req.body?.plan))
      ? String(req.body.plan) as ManagedClient['plan']
      : 'self_service';
    const maxCampaigns = Math.max(1, Math.min(Number(req.body?.maxCampaigns) || (plan === 'advanced' ? 5 : plan === 'basic' ? 1 : 7), 50));
    const serviceExpiresAt = typeof req.body?.serviceExpiresAt === 'string' && req.body.serviceExpiresAt.trim()
      ? req.body.serviceExpiresAt.trim()
      : undefined;
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
    if (dokployProvisioner.configurationError) {
      res.status(503).json({ error: dokployProvisioner.configurationError });
      return;
    }
    const client = ownerStorage.addClient(name, accessCode, {
      plan,
      readonlyDashboard: plan === 'basic',
      maxCampaigns,
      serviceExpiresAt,
      whatsappProvider: plan === 'advanced' ? 'TWILIO_API' : 'WEB_JS',
    });
    try {
      res.status(201).json(await provisionClient(client.id));
    } catch (err: any) {
      res.status(502).json({
        error: err?.message ?? String(err),
        client: ownerStorage.getClient(client.id),
      });
    }
  });

  app.get('/owner/api/clients/:id', (req, res) => {
    const client = ownerStorage.getClient(req.params.id);
    if (!client) {
      res.status(404).json({ error: 'לקוחה לא נמצאה' });
      return;
    }
    res.json(client);
  });

  app.post('/owner/api/clients/:id/check-ready', async (req, res) => {
    const client = ownerStorage.getClient(req.params.id);
    if (!client) {
      res.status(404).json({ error: 'לקוחה לא נמצאה' });
      return;
    }
    if (!client.managementUrl) {
      res.json(client);
      return;
    }
    try {
      const healthUrl = new URL('/health', client.managementUrl).toString();
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(8_000) });
      const health = await response.json().catch(() => null) as { clientConfigured?: boolean } | null;
      if (response.ok && health?.clientConfigured === true) {
        res.json(ownerStorage.updateClient(client.id, { provisioningStatus: 'ready' }));
        return;
      }
    } catch {
      // A deployment may still be building; retain the current state.
    }
    res.json(client);
  });

  app.post('/owner/api/clients/:id/provision', async (req, res) => {
    const client = ownerStorage.getClient(req.params.id);
    if (!client) {
      res.status(404).json({ error: 'לקוחה לא נמצאה' });
      return;
    }
    try {
      res.json(await provisionClient(client.id));
    } catch (err: any) {
      res.status(502).json({
        error: err?.message ?? String(err),
        client: ownerStorage.getClient(client.id),
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

  app.use('/owner-api', requireOwnerApiToken);

  app.get('/owner-api/campaigns', (_req, res) => {
    res.json(storage.getCampaigns().map((campaign) => ({
      ...campaign,
      conversation: storage.getCampaignConversationSettings(campaign),
    })));
  });

  app.post('/owner-api/campaigns', (req, res) => {
    const { name, triggerType, triggerPhrase, basePhrase, referrerName, startAt, endAt, conversation } =
      req.body as Partial<Campaign>;
    const capabilities = getClientCapabilities(storage);

    if (!name?.trim()) { res.status(400).json({ error: 'שם הקמפיין חסר' }); return; }
    if (storage.getCampaigns().length >= capabilities.maxCampaigns) {
      res.status(403).json({ error: `המסלול מאפשר עד ${capabilities.maxCampaigns} קמפיינים.` });
      return;
    }
    if (triggerType !== 1 && triggerType !== 2) { res.status(400).json({ error: 'סוג טריגר לא תקין' }); return; }
    if (startAt && endAt && new Date(startAt).getTime() >= new Date(endAt).getTime()) {
      res.status(400).json({ error: 'שעת הסיום חייבת להיות אחרי שעת ההתחלה' });
      return;
    }
    if (capabilities.serviceExpiresAt) {
      const expiry = new Date(capabilities.serviceExpiresAt).getTime();
      const campaignEnd = endAt ? new Date(endAt).getTime() : expiry;
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

    const campaign = storage.addCampaign({
      name: name.trim(),
      triggerType,
      triggerPhrase: phrase,
      basePhrase: basePhraseVal,
      referrerName: refName,
      suffix,
      active: true,
      startAt: typeof startAt === 'string' && startAt ? startAt : undefined,
      endAt: typeof endAt === 'string' && endAt ? endAt : undefined,
      conversation: conversationSettings(conversation, storage.getAdminSettings()),
    });
    res.status(201).json(campaign);
  });

  app.patch('/owner-api/campaigns/:id/toggle', (req, res) => {
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
    res.json({
      qr: botState.qrDataUrl,
      authenticated: botState.authenticated,
      ready: botState.ready,
      pairingCode: botState.pairingCode,
      connectedPhone: botState.connectedPhone ?? profile.whatsappPhone,
      lifecycle: botState.lifecycle,
      listeningReason: botState.listeningReason,
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

  app.get('/api/config', (_req, res) => {
    const profile = storage.getClientProfile();
    const fallbackPhone = config.MY_CONTACT.phone.replace('+', '');
    res.json({ phone: botState.connectedPhone ?? (profile.whatsappPhone || fallbackPhone) });
  });

  app.get('/api/capabilities', (_req, res) => {
    res.json(getClientCapabilities(storage));
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
    if (body.contactsProvider === 'google' || body.contactsProvider === 'icloud' || body.contactsProvider === 'manual')
      patch.contactsProvider = body.contactsProvider;
    if (typeof body.icloudEmail === 'string')    patch.icloudEmail    = body.icloudEmail;
    if (typeof body.icloudPassword === 'string') patch.icloudPassword = body.icloudPassword;
    if (typeof body.askNameText === 'string')    patch.askNameText    = body.askNameText;
    if (typeof body.replyText === 'string')      patch.replyText      = body.replyText;
    if (Array.isArray(body.followupMessages))
      patch.followupMessages = body.followupMessages.filter((message): message is string => typeof message === 'string');
    if (typeof body.referralPrefix === 'string') patch.referralPrefix = body.referralPrefix;
    if (typeof body.botSuffix === 'string')      patch.botSuffix      = body.botSuffix;

    const updated = storage.updateAdminSettings(patch);
    res.json({ ok: true, settings: updated });
  });

  // ── iCloud test ──────────────────────────────────────────────────────────

  app.post('/api/icloud/test', requireWritableClient, async (req, res) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) { res.status(400).json({ error: 'חסרים פרטים' }); return; }
    try {
      await testICloudConnection(email, password);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? 'שגיאה' });
    }
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
    const filename = `${Date.now().toString(36)}-${safeUploadName(originalName)}`;
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
      ...storage.getCampaignResultSummary(campaign.id),
    }));
    res.json({ summaries });
  });

  app.get('/api/campaign-results/:id/export', (req, res) => {
    const campaign = storage.getCampaigns().find((item) => item.id === req.params.id);
    if (!campaign) {
      res.status(404).json({ error: 'קמפיין לא נמצא' });
      return;
    }

    const csvValue = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const rows = [
      'campaign,phone,status,triggeredAt,updatedAt',
      ...storage.getCampaignResults(campaign.id).map((result) => [
        csvValue(campaign.name),
        csvValue(result.phone),
        csvValue(result.status),
        csvValue(result.triggeredAt),
        csvValue(result.updatedAt),
      ].join(',')),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="campaign-${campaign.id}-results.csv"`);
    res.send('\uFEFF' + rows.join('\n'));
  });

  app.post('/api/campaigns', requireWritableClient, (req, res) => {
    const { name, triggerType, triggerPhrase, basePhrase, referrerName, startAt, endAt, conversation } =
      req.body as Partial<Campaign>;
    const capabilities = getClientCapabilities(storage);

    if (!name?.trim()) { res.status(400).json({ error: 'שם הקמפיין חסר' }); return; }
    if (storage.getCampaigns().length >= capabilities.maxCampaigns) {
      res.status(403).json({ error: `המסלול מאפשר עד ${capabilities.maxCampaigns} קמפיינים.` });
      return;
    }
    if (triggerType !== 1 && triggerType !== 2) { res.status(400).json({ error: 'סוג טריגר לא תקין' }); return; }
    if (startAt && endAt && new Date(startAt).getTime() >= new Date(endAt).getTime()) {
      res.status(400).json({ error: 'שעת הסיום חייבת להיות אחרי שעת ההתחלה' });
      return;
    }
    if (capabilities.serviceExpiresAt) {
      const expiry = new Date(capabilities.serviceExpiresAt).getTime();
      const campaignEnd = endAt ? new Date(endAt).getTime() : expiry;
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

    const campaign = storage.addCampaign({
      name: name.trim(),
      triggerType,
      triggerPhrase: phrase,
      basePhrase: basePhraseVal,
      referrerName: refName,
      suffix,
      active: true,
      startAt: typeof startAt === 'string' && startAt ? startAt : undefined,
      endAt: typeof endAt === 'string' && endAt ? endAt : undefined,
      conversation: conversationSettings(conversation, storage.getAdminSettings()),
    });
    res.json(campaign);
  });

  app.put('/api/campaigns/:id', requireWritableClient, (req, res) => {
    const { name, triggerType, triggerPhrase, basePhrase, referrerName, active, startAt, endAt, conversation } =
      req.body as Partial<Campaign>;

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
      const existing = storage.getCampaigns().find((campaign) => campaign.id === req.params.id);
      const defaults = existing
        ? storage.getCampaignConversationSettings(existing)
        : conversationSettings(undefined, storage.getAdminSettings());
      patch.conversation = conversationSettings(conversation, defaults);
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

  app.patch('/api/campaigns/:id/toggle', requireWritableClient, (req, res) => {
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
