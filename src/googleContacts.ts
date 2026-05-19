/**
 * googleContacts.ts
 * Google People API – OAuth 2.0 + contact creation.
 * Auth flow is driven by the admin dashboard (no terminal interaction needed).
 */

import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import { config } from './config';

const SCOPES     = ['https://www.googleapis.com/auth/contacts'];
// ─── Internal helpers ─────────────────────────────────────────────────────────

function loadCredentials() {
  // Cloud deployments: set GOOGLE_CREDENTIALS_BASE64 to the base64-encoded credentials.json
  if (process.env.GOOGLE_CREDENTIALS_BASE64) {
    try {
      const raw = JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf-8'));
      const creds = raw.installed ?? raw.web;
      if (!creds) throw new Error('unexpected format');
      return creds;
    } catch (err: any) {
      throw new Error(`GOOGLE_CREDENTIALS_BASE64 is invalid: ${err.message}`);
    }
  }

  if (!fs.existsSync(config.GOOGLE_CREDENTIALS_PATH)) {
    throw new Error(
      `credentials.json not found at "${config.GOOGLE_CREDENTIALS_PATH}".\n` +
      'Download it from Google Cloud Console → APIs & Services → Credentials.',
    );
  }
  const raw  = JSON.parse(fs.readFileSync(config.GOOGLE_CREDENTIALS_PATH, 'utf-8'));
  const creds = raw.installed ?? raw.web;
  if (!creds) throw new Error('credentials.json has an unexpected format.');
  return creds;
}

function makeOAuth2Client(redirectUri = 'http://localhost:3001/oauth2callback'): OAuth2Client {
  const creds = loadCredentials();
  return new google.auth.OAuth2(creds.client_id, creds.client_secret, redirectUri);
}

function persistToken(token: object): void {
  const dir = path.dirname(config.GOOGLE_TOKEN_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(config.GOOGLE_TOKEN_PATH, JSON.stringify(token, null, 2), 'utf-8');
}

async function buildAuthClient(): Promise<OAuth2Client> {
  const auth = makeOAuth2Client();

  if (!fs.existsSync(config.GOOGLE_TOKEN_PATH)) {
    throw new Error('Google account not connected. Open the admin dashboard to connect.');
  }

  const token = JSON.parse(fs.readFileSync(config.GOOGLE_TOKEN_PATH, 'utf-8'));
  auth.setCredentials(token);

  auth.on('tokens', (tokens) => {
    if (tokens.refresh_token) persistToken({ ...token, ...tokens });
  });

  return auth;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function isGoogleConnected(): boolean {
  return fs.existsSync(config.GOOGLE_TOKEN_PATH);
}

export function getGoogleAuthUrl(baseUrl = 'http://localhost:3001'): string {
  const redirectUri = `${baseUrl}/oauth2callback`;
  const auth = makeOAuth2Client(redirectUri);
  return auth.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
}

export async function handleGoogleCallback(code: string, baseUrl = 'http://localhost:3001'): Promise<void> {
  const redirectUri = `${baseUrl}/oauth2callback`;
  const auth = makeOAuth2Client(redirectUri);
  const { tokens } = await auth.getToken(code);
  persistToken(tokens);
}

export async function saveContactToGoogle(displayName: string, phone: string): Promise<void> {
  const auth   = await buildAuthClient();
  const people = google.people({ version: 'v1', auth });

  await people.people.createContact({
    requestBody: {
      names:        [{ givenName: displayName }],
      phoneNumbers: [{ value: phone, type: 'mobile' }],
    },
  });

  console.log(`✅ Google Contacts: saved "${displayName}" (${phone})`);
}
