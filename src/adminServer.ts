/**
 * adminServer.ts
 * Express server for the admin dashboard.
 * Serves static files and exposes a REST API for settings and campaigns.
 */

import express from 'express';
import path from 'path';
import { Storage, AdminSettings, Campaign } from './storage';
import { config } from './config';
import { botState } from './botState';
import { isGoogleConnected, getGoogleAuthUrl, handleGoogleCallback } from './googleContacts';
import { testICloudConnection } from './icloudContacts';

export function startAdminServer(storage: Storage): void {
  const app = express();

  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ── QR code status ────────────────────────────────────────────────────────

  app.get('/api/qr', (_req, res) => {
    res.json({ qr: botState.qrDataUrl, authenticated: botState.authenticated });
  });

  // ── Pairing code ──────────────────────────────────────────────────────────

  app.post('/api/pair', async (req, res) => {
    let phone = String(req.body.phone ?? '').replace(/\D/g, '');
    if (phone.startsWith('0')) phone = '972' + phone.slice(1);
    if (!phone) { res.status(400).json({ error: 'מספר טלפון חסר' }); return; }
    if (!botState.client) { res.status(503).json({ error: 'הבוט עדיין לא מוכן' }); return; }
    try {
      const code = await (botState.client as any).requestPairingCode(phone);
      botState.pairingCode = code;
      res.json({ code });
    } catch (err: any) {
      console.error('❌ requestPairingCode error:', err);
      res.status(500).json({ error: err?.message ?? 'שגיאה בהפקת קוד' });
    }
  });

  // ── Google Contacts OAuth ─────────────────────────────────────────────────

  app.get('/api/google/status', (_req, res) => {
    res.json({ connected: isGoogleConnected() });
  });

  app.get('/api/google/auth-url', (req, res) => {
    try {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      res.json({ url: getGoogleAuthUrl(baseUrl) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'שגיאה' });
    }
  });

  app.get('/oauth2callback', async (req, res) => {
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
    res.json({ phone: config.MY_CONTACT.phone.replace('+', '') });
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

  app.get('/api/campaigns', (_req, res) => {
    res.json(storage.getCampaigns());
  });

  app.post('/api/campaigns', (req, res) => {
    const { name, triggerType, triggerPhrase, basePhrase, referrerName } =
      req.body as Partial<Campaign>;

    if (!name?.trim()) { res.status(400).json({ error: 'שם הקמפיין חסר' }); return; }
    if (triggerType !== 1 && triggerType !== 2) { res.status(400).json({ error: 'סוג טריגר לא תקין' }); return; }

    let phrase: string;
    let suffix: string;
    let basePhraseVal: string | undefined;
    let refName: string | undefined;

    if (triggerType === 1) {
      if (!triggerPhrase?.trim()) { res.status(400).json({ error: 'משפט הטריגר חסר' }); return; }
      phrase = triggerPhrase.trim();
      suffix = config.BOT_SUFFIX;
    } else {
      if (!basePhrase?.trim()) { res.status(400).json({ error: 'משפט הטריגר חסר' }); return; }
      if (!referrerName?.trim()) { res.status(400).json({ error: 'שם הממליץ חובה לטיפוס 2' }); return; }
      basePhraseVal = basePhrase.trim();
      refName = referrerName.trim();
      // Full trigger: "[base phrase] הגעתי דרך [referrer name]"
      phrase = `${basePhraseVal} ${config.TRIGGER_REFERRAL_PREFIX}${refName}`;
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
    });
    res.json(campaign);
  });

  app.put('/api/campaigns/:id', (req, res) => {
    const { name, triggerType, triggerPhrase, basePhrase, referrerName, active } =
      req.body as Partial<Campaign>;

    const patch: Partial<Omit<Campaign, 'id'>> = {};

    if (name?.trim()) patch.name = name.trim();
    if (typeof active === 'boolean') patch.active = active;

    if (triggerType === 1) {
      patch.triggerType = 1;
      if (triggerPhrase?.trim()) {
        patch.triggerPhrase = triggerPhrase.trim();
        patch.suffix = config.BOT_SUFFIX;
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
      patch.triggerPhrase = `${basePhraseVal} ${config.TRIGGER_REFERRAL_PREFIX}${refName}`;
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

  app.listen(config.ADMIN_PORT, () => {
    console.log(`🖥️  Admin dashboard → http://localhost:${config.ADMIN_PORT}`);
  });
}
