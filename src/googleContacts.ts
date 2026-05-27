/**
 * googleContacts.ts
 * Google People API – OAuth 2.0 + contact creation.
 * Auth flow is driven by the admin dashboard (no terminal interaction needed).
 */

import { google, people_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import { config } from './config';

const SCOPES     = ['https://www.googleapis.com/auth/contacts'];
// ─── Internal helpers ─────────────────────────────────────────────────────────

function loadCredentials() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (clientId || clientSecret) {
    if (!clientId || !clientSecret) {
      throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together.');
    }
    return { client_id: clientId, client_secret: clientSecret };
  }

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
    // Always persist – access_token refreshes don't include refresh_token
    persistToken({ ...token, ...tokens });
  });

  return auth;
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

async function findContactByPhone(
  people: people_v1.People,
  phone: string,
): Promise<people_v1.Schema$Person | null> {
  const readMask = 'metadata,names,phoneNumbers';
  const normalizedTarget = normalizePhone(phone);

  await people.people.searchContacts({ query: '', pageSize: 1, readMask });

  const res = await people.people.searchContacts({
    query: phone,
    pageSize: 30,
    readMask,
  });

  for (const result of res.data.results ?? []) {
    const person = result.person;
    if (!person?.resourceName) continue;

    const hasPhone = (person.phoneNumbers ?? []).some((entry) =>
      normalizePhone(entry.value ?? '') === normalizedTarget,
    );
    if (hasPhone) return person;
  }

  return null;
}

async function updateGoogleContactName(
  people: people_v1.People,
  person: people_v1.Schema$Person,
  displayName: string,
): Promise<void> {
  if (!person.resourceName) throw new Error('Google contact resourceName is missing.');
  if (!person.metadata?.sources?.length) {
    throw new Error('Google contact metadata source is missing.');
  }

  await people.people.updateContact({
    resourceName: person.resourceName,
    updatePersonFields: 'names',
    personFields: 'metadata,names,phoneNumbers',
    requestBody: {
      resourceName: person.resourceName,
      etag: person.etag,
      metadata: person.metadata,
      names: [{ givenName: displayName }],
      phoneNumbers: person.phoneNumbers,
    },
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function isGoogleConnected(): boolean {
  return fs.existsSync(config.GOOGLE_TOKEN_PATH);
}

export function disconnectGoogle(): void {
  if (fs.existsSync(config.GOOGLE_TOKEN_PATH)) {
    fs.unlinkSync(config.GOOGLE_TOKEN_PATH);
  }
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
  const existing = await findContactByPhone(people, phone);

  if (existing) {
    await updateGoogleContactName(people, existing, displayName);
    console.log(`ג… Google Contacts: updated "${displayName}" (${phone})`);
    return;
  }

  await people.people.createContact({
    requestBody: {
      names:        [{ givenName: displayName }],
      phoneNumbers: [{ value: phone, type: 'mobile' }],
    },
  });

  console.log(`✅ Google Contacts: saved "${displayName}" (${phone})`);
}
