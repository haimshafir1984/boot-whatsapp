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

  if (!configuredClientToken) {
    console.warn(`CLIENT_ACCESS_TOKEN is not configured. Temporary client access code: ${clientToken}`);
  }
  if (!configuredOwnerToken) {
    console.warn(`OWNER_ACCESS_TOKEN is not configured. Temporary owner access code: ${ownerToken}`);
  }

  return {
    clientLogin: (req, res) => {
      if (!tokenEquals(clientToken, req.body?.accessCode)) {
        res.status(401).json({ error: 'קוד גישה לא תקין' });
        return;
      }
      issueSession(res, req, CLIENT_COOKIE, clientSessions);
      res.json({ ok: true });
    },
    clientLogout: (req, res) => {
      clearSession(req, res, CLIENT_COOKIE, clientSessions);
      res.json({ ok: true });
    },
    ownerLogin: (req, res) => {
      if (!tokenEquals(ownerToken, req.body?.accessCode)) {
        res.status(401).json({ error: 'קוד גישה לא תקין' });
        return;
      }
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
