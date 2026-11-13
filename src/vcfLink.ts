/**
 * vcfLink.ts
 * Meta's Cloud API cannot deliver a real .vcf document (media upload rejects text/vcard; text/plain arrives as ".vcf.txt").
 * So a campaign that should let the participant save several contacts in one tap sends a LINK to a .vcf file served by the
 * client's own public domain (PUBLIC_BASE_URL).
 *
 * One file per (campaign, contact-set version): the id is an HMAC of the campaign id and the file content under a
 * per-client secret, so the same contacts always map to the same link (a burst of participants creates one file, not hundreds)
 * and editing the contacts creates a NEW link while links already sent keep showing the contacts they were sent with.
 * The id is 128 bits and unguessable without the secret, but the link itself is the access key: whoever has it can download the
 * contacts. It carries only the business contact details the campaign owner configured for publication.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import fs from 'fs';
import path from 'path';
import type { Express, Request, Response, NextFunction } from 'express';
import { config } from './config';

export interface VcfLinkContact { name: string; phone: string; email: string; organization: string }

const ID_LENGTH = 22; // 16 bytes in base64url
const FILE_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${ID_LENGTH}}\\.vcf$`);
export const VCF_LINK_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const REFRESH_AFTER_MS = 60 * 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 16 * 1024;

function linksDir(): string { return path.join(config.UPLOADS_PATH, 'vcf-links'); }

export function publicBaseUrl(): string | null {
  const raw = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch { return null; }
}

function escapeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

function oneVCard(contact: VcfLinkContact): string {
  const displayName = contact.name || contact.phone || contact.email || 'Contact';
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${escapeValue(displayName)}`, `N:${escapeValue(displayName)};;;;`];
  if (contact.phone) lines.push(`TEL;TYPE=CELL,VOICE:${escapeValue(contact.phone)}`);
  if (contact.email) lines.push(`EMAIL:${escapeValue(contact.email)}`);
  if (contact.organization) lines.push(`ORG:${escapeValue(contact.organization)}`);
  lines.push('END:VCARD');
  return `${lines.join('\r\n')}\r\n`;
}

export function buildVcfFileContent(contacts: VcfLinkContact[]): string {
  return contacts.map(oneVCard).join('');
}

function secretKey(): Buffer {
  const dir = linksDir();
  const keyPath = path.join(dir, '.key');
  try {
    const existing = fs.readFileSync(keyPath);
    if (existing.length >= 32) return existing;
  } catch { /* create below */ }
  fs.mkdirSync(dir, { recursive: true });
  const key = randomBytes(32);
  try {
    fs.writeFileSync(keyPath, key, { flag: 'wx', mode: 0o600 });
    return key;
  } catch {
    // Another process won the race; use what it wrote.
    return fs.readFileSync(keyPath);
  }
}

function idFor(campaignId: string, content: string): string {
  const digest = createHash('sha256').update(content).digest('hex');
  return createHmac('sha256', secretKey()).update(`vcf-link|${campaignId}|${digest}`).digest().subarray(0, 16).toString('base64url');
}

/** Creates (or reuses) the file for this contact set and returns its public URL, or null when no public base URL is configured. */
export function issueVcfLink(campaignId: string | undefined, contacts: VcfLinkContact[]): string | null {
  const base = publicBaseUrl();
  if (!base) return null;
  const content = buildVcfFileContent(contacts);
  if (!content || Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('VCF link: contact set is empty or too large');
  const id = idFor(campaignId || 'default', content);
  const file = path.join(linksDir(), `${id}.vcf`);
  let write = true;
  try {
    const stat = fs.statSync(file);
    write = Date.now() - stat.mtimeMs > REFRESH_AFTER_MS; // keep an old link alive while it is still being sent
  } catch { /* not there yet */ }
  if (write) {
    fs.mkdirSync(linksDir(), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
  }
  return `${base}/vcf/${id}.vcf`;
}

/** Returns the file content for a request path segment, or null (unknown id, wrong shape, or expired). */
export function readVcfLink(fileName: string): string | null {
  if (!FILE_PATTERN.test(fileName)) return null;
  const file = path.join(linksDir(), fileName);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || Date.now() - stat.mtimeMs > VCF_LINK_MAX_AGE_MS) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;

/** Public, unauthenticated: GET /vcf/<id>.vcf. Mount it BEFORE any auth-gated prefix it could fall under. */
export function mountVcfLinkRoutes(app: Express): void {
  const hits = new Map<string, { count: number; windowStart: number }>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (now - entry.windowStart >= RATE_WINDOW_MS) hits.delete(key);
  }, RATE_WINDOW_MS);
  if (typeof (sweep as any).unref === 'function') (sweep as any).unref();

  const limit = (req: Request, res: Response, next: NextFunction) => {
    const key = String(req.get('x-forwarded-for') || '').split(',')[0]?.trim() || req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) { hits.set(key, { count: 1, windowStart: now }); next(); return; }
    entry.count += 1;
    if (entry.count > RATE_MAX) { res.setHeader('Retry-After', '60'); res.status(429).send('Too many requests'); return; }
    next();
  };

  app.get('/vcf/:file', limit, (req, res) => {
    const content = readVcfLink(String(req.params.file || ''));
    if (!content) { res.status(404).send('Not found'); return; }
    res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="contacts.vcf"');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).send(content);
  });
}
