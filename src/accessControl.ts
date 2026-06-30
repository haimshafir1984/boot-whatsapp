import crypto from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

const CLIENT_COOKIE = 'client_dashboard_session';
const OWNER_COOKIE = 'owner_dashboard_session';

function readCookie(req: Request, name: string): string | undefined {
  const prefix = `${name}=`;
  const cookie = (req.headers.cookie ?? '')
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : undefined;
}

function tokenEquals(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(provided.trim());
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX_FAILURES = 8;

type LoginAttempt = { count: number; firstAt: number; blockedUntil?: number };

function loginRateLimitKey(req: Request, scope: 'client' | 'owner'): string {
  const forwarded = String(req.get('x-forwarded-for') || '').split(',')[0]?.trim();
  const ip = forwarded || req.ip || req.socket.remoteAddress || 'unknown';
  return scope + ':' + ip;
}

function checkLoginRateLimit(attempts: Map<string, LoginAttempt>, key: string): number {
  const now = Date.now();
  const attempt = attempts.get(key);
  if (!attempt) return 0;
  if (attempt.blockedUntil && attempt.blockedUntil > now) return attempt.blockedUntil - now;
  if (now - attempt.firstAt > LOGIN_RATE_LIMIT_WINDOW_MS) attempts.delete(key);
  return 0;
}

function recordLoginFailure(attempts: Map<string, LoginAttempt>, key: string): void {
  const now = Date.now();
  const current = attempts.get(key);
  const next: LoginAttempt = !current || now - current.firstAt > LOGIN_RATE_LIMIT_WINDOW_MS
    ? { count: 1, firstAt: now }
    : { ...current, count: current.count + 1 };
  if (next.count >= LOGIN_RATE_LIMIT_MAX_FAILURES) {
    next.blockedUntil = now + LOGIN_RATE_LIMIT_WINDOW_MS;
  }
  attempts.set(key, next);
}

function clearLoginFailures(attempts: Map<string, LoginAttempt>, key: string): void {
  attempts.delete(key);
}

function sendRateLimited(res: Response, retryAfterMs: number): void {
  res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
  res.status(429).json({ error: 'יותר מדי ניסיונות התחברות. נסה שוב בעוד כמה דקות.' });
}

function issueSession(res: Response, req: Request, cookieName: string, sessions: Set<string>): void {
  const id = crypto.randomBytes(32).toString('hex');
  sessions.add(id);
  res.cookie(cookieName, id, {
    httpOnly: true,
    // OAuth returns from Google in a top-level navigation; Lax sends the
    // session cookie on that callback while still blocking cross-site POSTs.
    sameSite: 'lax',
    secure: req.secure || req.get('x-forwarded-proto') === 'https',
    maxAge: 12 * 60 * 60 * 1000,
  });
}

function clearSession(req: Request, res: Response, cookieName: string, sessions: Set<string>): void {
  const id = readCookie(req, cookieName);
  if (id) sessions.delete(id);
  res.clearCookie(cookieName);
}

function requireSession(cookieName: string, sessions: Set<string>, loginPath: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const id = readCookie(req, cookieName);
    if (id && sessions.has(id)) {
      next();
      return;
    }
    if (req.path.startsWith('/api') || req.originalUrl.includes('/api/')) {
      res.status(401).json({ error: 'נדרשת התחברות' });
      return;
    }
    res.redirect(loginPath);
  };
}

export interface AccessControl {
  clientLogin: RequestHandler;
  clientLogout: RequestHandler;
  ownerLogin: RequestHandler;
  ownerLogout: RequestHandler;
  requireClient: RequestHandler;
  requireOwner: RequestHandler;
}

export function createAccessControl(): AccessControl {
  const configuredClientToken = process.env.CLIENT_ACCESS_TOKEN?.trim();
  const configuredOwnerToken = process.env.OWNER_ACCESS_TOKEN?.trim();
  const clientToken = configuredClientToken || crypto.randomBytes(18).toString('base64url');
  const ownerToken = configuredOwnerToken || crypto.randomBytes(18).toString('base64url');
  const clientSessions = new Set<string>();
  const ownerSessions = new Set<string>();
  const loginAttempts = new Map<string, LoginAttempt>();

  if (!configuredClientToken) {
    console.warn(`CLIENT_ACCESS_TOKEN is not configured. Temporary client access code: ${clientToken}`);
  }
  if (!configuredOwnerToken) {
    console.warn(`OWNER_ACCESS_TOKEN is not configured. Temporary owner access code: ${ownerToken}`);
  }

  return {
    clientLogin: (req, res) => {
      const rateKey = loginRateLimitKey(req, 'client');
      const retryAfterMs = checkLoginRateLimit(loginAttempts, rateKey);
      if (retryAfterMs > 0) { sendRateLimited(res, retryAfterMs); return; }
      if (!tokenEquals(clientToken, req.body?.accessCode)) {
        recordLoginFailure(loginAttempts, rateKey);
        res.status(401).json({ error: 'קוד גישה לא תקין' });
        return;
      }
      clearLoginFailures(loginAttempts, rateKey);
      issueSession(res, req, CLIENT_COOKIE, clientSessions);
      res.json({ ok: true });
    },
    clientLogout: (req, res) => {
      clearSession(req, res, CLIENT_COOKIE, clientSessions);
      res.json({ ok: true });
    },
    ownerLogin: (req, res) => {
      const rateKey = loginRateLimitKey(req, 'owner');
      const retryAfterMs = checkLoginRateLimit(loginAttempts, rateKey);
      if (retryAfterMs > 0) { sendRateLimited(res, retryAfterMs); return; }
      if (!tokenEquals(ownerToken, req.body?.accessCode)) {
        recordLoginFailure(loginAttempts, rateKey);
        res.status(401).json({ error: 'קוד גישה לא תקין' });
        return;
      }
      clearLoginFailures(loginAttempts, rateKey);
      issueSession(res, req, OWNER_COOKIE, ownerSessions);
      res.json({ ok: true });
    },
    ownerLogout: (req, res) => {
      clearSession(req, res, OWNER_COOKIE, ownerSessions);
      res.json({ ok: true });
    },
    requireClient: requireSession(CLIENT_COOKIE, clientSessions, '/client/login'),
    requireOwner: requireSession(OWNER_COOKIE, ownerSessions, '/owner/login'),
  };
}
