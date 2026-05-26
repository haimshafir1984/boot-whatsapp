/**
 * adminServer.ts
 * Express server for the admin dashboard.
 * Serves static files and exposes a REST API for settings and campaigns.
 */

import express from 'express';
import path from 'path';
import { Storage, AdminSettings, Campaign, CampaignConversationSettings } from './storage';
import { config } from './config';
import { botState } from './botState';
import { startWhatsAppBot, stopWhatsAppBot } from './whatsappLifecycle';
import { isGoogleConnected, getGoogleAuthUrl, handleGoogleCallback, disconnectGoogle } from './googleContacts';
import { testICloudConnection } from './icloudContacts';
import { createAccessControl } from './accessControl';
import { OwnerStorage } from './ownerStorage';

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
  };
}

export function startAdminServer(storage: Storage): void {
  const app = express();
  const publicDir = path.join(__dirname, '..', 'public');
  const ownerPublicDir = path.join(__dirname, '..', 'owner-public');
  const ownerStorage = new OwnerStorage(config.OWNER_STORAGE_PATH);
  const access = createAccessControl();

  app.set('trust proxy', 1);
  app.use(express.json());

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
    res.json({ ok: true });
  });
  app.post('/auth/client/login', access.clientLogin);
  app.post('/auth/client/logout', access.requireClient, access.clientLogout);
  app.post('/auth/owner/login', access.ownerLogin);
  app.post('/auth/owner/logout', access.requireOwner, access.ownerLogout);

  app.use('/owner/api', access.requireOwner);

  app.get('/owner/api/clients', (_req, res) => {
    res.json(ownerStorage.getClients());
  });

  app.post('/owner/api/clients', (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const accessCode = String(req.body?.accessCode ?? '').trim();
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
    res.status(201).json(ownerStorage.addClient(name, accessCode));
  });

  app.get('/owner/api/clients/:id', (req, res) => {
    const client = ownerStorage.getClient(req.params.id);
    if (!client) {
      res.status(404).json({ error: 'לקוחה לא נמצאה' });
      return;
    }
    res.json(client);
  });

  app.use('/owner', access.requireOwner, express.static(ownerPublicDir));
  app.use('/api', access.requireClient);

  // ── QR code status ────────────────────────────────────────────────────────

  app.get('/api/qr', (_req, res) => {
    res.json({
      qr: botState.qrDataUrl,
      authenticated: botState.authenticated,
      ready: botState.ready,
      pairingCode: botState.pairingCode,
      connectedPhone: botState.connectedPhone,
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

  app.get('/oauth2callback', access.requireClient, async (req, res) => {
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
  });

  // ── Public config (phone number for wa.me links) ─────────────────────────

  app.get('/api/config', (_req, res) => {
    const profile = storage.getClientProfile();
    const fallbackPhone = config.MY_CONTACT.phone.replace('+', '');
    res.json({ phone: botState.connectedPhone ?? (profile.whatsappPhone || fallbackPhone) });
  });

  // ── Settings ──────────────────────────────────────────────────────────────

  app.get('/api/settings', (_req, res) => {
    res.json(storage.getAdminSettings());
  });

  app.post('/api/settings', (req, res) => {
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

  app.post('/api/icloud/test', async (req, res) => {
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

  app.post('/api/campaigns', (req, res) => {
    const { name, triggerType, triggerPhrase, basePhrase, referrerName, startAt, endAt, conversation } =
      req.body as Partial<Campaign>;

    if (!name?.trim()) { res.status(400).json({ error: 'שם הקמפיין חסר' }); return; }
    if (triggerType !== 1 && triggerType !== 2) { res.status(400).json({ error: 'סוג טריגר לא תקין' }); return; }
    if (startAt && endAt && new Date(startAt).getTime() >= new Date(endAt).getTime()) {
      res.status(400).json({ error: 'שעת הסיום חייבת להיות אחרי שעת ההתחלה' });
      return;
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

  app.put('/api/campaigns/:id', (req, res) => {
    const { name, triggerType, triggerPhrase, basePhrase, referrerName, active, startAt, endAt, conversation } =
      req.body as Partial<Campaign>;

    const patch: Partial<Omit<Campaign, 'id'>> = {};

    if (name?.trim()) patch.name = name.trim();
    if (typeof active === 'boolean') patch.active = active;
    if (startAt && endAt && new Date(startAt).getTime() >= new Date(endAt).getTime()) {
      res.status(400).json({ error: 'שעת הסיום חייבת להיות אחרי שעת ההתחלה' });
      return;
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

    const updated = storage.updateCampaign(req.params.id, patch);
    if (!updated) {
      res.status(404).json({ error: 'קמפיין לא נמצא' });
      return;
    }
    res.json(updated);
  });

  app.delete('/api/campaigns/:id', (req, res) => {
    const ok = storage.deleteCampaign(req.params.id);
    res.json({ ok });
  });

  app.patch('/api/campaigns/:id/toggle', (req, res) => {
    const updated = storage.toggleCampaign(req.params.id);
    if (!updated) {
      res.status(404).json({ error: 'קמפיין לא נמצא' });
      return;
    }
    res.json(updated);
  });

  // ─────────────────────────────────────────────────────────────────────────

  app.get('/', (_req, res) => {
    res.redirect('/owner/');
  });
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
