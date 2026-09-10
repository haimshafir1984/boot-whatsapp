import net from 'net';
import tls from 'tls';
import { config } from './config';
import { redactSecrets } from './secretRedaction';

export type SystemAlertSeverity = 'warning' | 'critical';

export interface SystemAlert {
  key: string;
  severity: SystemAlertSeverity;
  title: string;
  message: string;
  details?: Record<string, unknown>;
}

type EmailSender = (message: { to: string[]; from: string; subject: string; body: string }) => Promise<void>;

const DEFAULT_THROTTLE_MS = 30 * 60 * 1000;
const sentAtByKey = new Map<string, number>();
const forwardedAtByKey = new Map<string, number>();
let testEmailSender: EmailSender | null = null;

export function notifySystemAlert(alert: SystemAlert): void {
  void dispatchLocalAlert(alert).catch((err) => {
    console.warn('[SYSTEM_ALERT_EMAIL_FAILED]', alert.key, err);
  });
}

export function notifyClientSystemAlert(alert: SystemAlert): void {
  notifySystemAlert(alert);
  void forwardAlertToGateway(alert).catch((err) => {
    console.warn('[SYSTEM_ALERT_FORWARD_FAILED]', alert.key, err);
  });
}

export function isMetaAuthError(status: number, body: unknown): boolean {
  const code = Number((body as any)?.error?.code);
  const type = String((body as any)?.error?.type || '');
  return status === 401 || code === 190 || /OAuthException/i.test(type);
}

export function metaApiAlert(status: number, body: unknown, operation: string): SystemAlert {
  const metaError = (body as any)?.error ?? {};
  const code = metaError?.code !== undefined ? String(metaError.code) : '';
  const subcode = metaError?.error_subcode !== undefined ? String(metaError.error_subcode) : '';
  const authFailure = isMetaAuthError(status, body);
  return {
    key: authFailure ? 'meta-auth-token-invalid' : `meta-api-${status}-${code || 'unknown'}`,
    severity: authFailure ? 'critical' : 'warning',
    title: authFailure ? 'Meta token is invalid' : 'Meta API request failed',
    message: authFailure
      ? 'Meta rejected a WhatsApp Cloud API request. Campaigns using this Meta token may stop responding until the token is replaced and affected services are redeployed.'
      : 'Meta rejected a WhatsApp Cloud API request. Check the error details and recent campaign traffic.',
    details: {
      operation,
      status,
      code,
      subcode,
      metaMessage: redactSecrets(String(metaError?.message || '').slice(0, 500)),
      provider: config.WHATSAPP_PROVIDER,
      clientName: config.CLIENT_NAME || undefined,
      phoneNumberId: config.META_PHONE_NUMBER_ID || undefined,
      displayPhoneNumber: config.META_DISPLAY_PHONE_NUMBER || undefined,
    },
  };
}

export function testSystemAlertEmail(subject = 'FlowsBiz alert test'): void {
  notifySystemAlert({
    key: `manual-test-${Date.now()}`,
    severity: 'warning',
    title: subject,
    message: 'This is a test alert from the FlowsBiz alerting system.',
    details: {
      provider: config.WHATSAPP_PROVIDER,
      clientName: config.CLIENT_NAME || undefined,
    },
  });
}

export function systemAlertEmailConfigured(): boolean {
  return Boolean(emailSettings());
}

export function resetSystemAlertStateForTest(): void {
  sentAtByKey.clear();
  forwardedAtByKey.clear();
  testEmailSender = null;
}

export function setSystemAlertEmailSenderForTest(sender: EmailSender | null): void {
  testEmailSender = sender;
}

async function dispatchLocalAlert(alert: SystemAlert): Promise<void> {
  const settings = emailSettings();
  if (!settings) return;
  const now = Date.now();
  const throttleMs = throttleMsSetting();
  const previous = sentAtByKey.get(alert.key) ?? 0;
  if (now - previous < throttleMs) {
    console.warn('[SYSTEM_ALERT_THROTTLED]', alert.key);
    return;
  }
  sentAtByKey.set(alert.key, now);

  const body = formatAlertBody(alert);
  await (testEmailSender ?? sendSmtpEmail)({
    to: settings.to,
    from: settings.from,
    subject: `[FlowsBiz ${alert.severity}] ${alert.title}`,
    body,
  });
  console.error('[SYSTEM_ALERT_SENT]', alert.key, alert.title);
}

async function forwardAlertToGateway(alert: SystemAlert): Promise<void> {
  if (!config.CLIENT_NAME) return;
  const ownerToken = process.env.OWNER_ACCESS_TOKEN?.trim();
  if (!ownerToken || process.env.ALERT_FORWARD_TO_GATEWAY === 'false') return;
  const base = config.META_GATEWAY_BASE_URL || config.CLIENT_DIRECTORY_URL;
  if (!base || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/i.test(base)) return;
  const now = Date.now();
  const throttleMs = throttleMsSetting();
  const previous = forwardedAtByKey.get(alert.key) ?? 0;
  if (now - previous < throttleMs) return;
  forwardedAtByKey.set(alert.key, now);
  const url = new URL('/internal/client-alerts', base).toString();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Owner-Token': ownerToken,
    },
    body: JSON.stringify(alert),
    signal: AbortSignal.timeout(Number(process.env.ALERT_FORWARD_TIMEOUT_MS || 5_000)),
  });
  if (!response.ok) {
    throw new Error(`Gateway alert forward failed with status ${response.status}`);
  }
}

function emailSettings(): { to: string[]; from: string } | null {
  const to = splitEmails(process.env.ALERT_EMAIL_TO || process.env.SYSTEM_ALERT_EMAIL_TO || '');
  const from = clean(process.env.ALERT_EMAIL_FROM || process.env.SYSTEM_ALERT_EMAIL_FROM || process.env.ALERT_SMTP_USER || process.env.SMTP_USER || '');
  const host = clean(process.env.ALERT_SMTP_HOST || process.env.SMTP_HOST || '');
  if (!to.length || !from || (!host && !testEmailSender)) return null;
  return { to, from };
}

function smtpSettings(): {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  timeoutMs: number;
} {
  const host = clean(process.env.ALERT_SMTP_HOST || process.env.SMTP_HOST || '');
  if (!host) throw new Error('ALERT_SMTP_HOST is required to send alert email.');
  const port = Number(process.env.ALERT_SMTP_PORT || process.env.SMTP_PORT || 587);
  const secure = /^true$/i.test(clean(process.env.ALERT_SMTP_SECURE || process.env.SMTP_SECURE || '')) || port === 465;
  return {
    host,
    port,
    secure,
    user: clean(process.env.ALERT_SMTP_USER || process.env.SMTP_USER || ''),
    pass: clean(process.env.ALERT_SMTP_PASS || process.env.SMTP_PASS || ''),
    timeoutMs: Number(process.env.ALERT_EMAIL_TIMEOUT_MS || 10_000),
  };
}

function throttleMsSetting(): number {
  const value = Number(process.env.ALERT_EMAIL_THROTTLE_MS || DEFAULT_THROTTLE_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_THROTTLE_MS;
}

function splitEmails(value: string): string[] {
  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function clean(value: string): string {
  return String(value ?? '').trim().replace(/^['"]|['"]$/g, '');
}

function formatAlertBody(alert: SystemAlert): string {
  const lines = [
    alert.title,
    '',
    redactSecrets(alert.message),
    '',
    `Severity: ${alert.severity}`,
    `Key: ${alert.key}`,
    `Time: ${new Date().toISOString()}`,
  ];
  if (alert.details && Object.keys(alert.details).length) {
    lines.push('', 'Details:');
    for (const [key, value] of Object.entries(alert.details)) {
      if (value === undefined || value === null || value === '') continue;
      lines.push(`${key}: ${redactSecrets(String(value)).slice(0, 1000)}`);
    }
  }
  return lines.join('\n');
}

async function sendSmtpEmail(message: { to: string[]; from: string; subject: string; body: string }): Promise<void> {
  const settings = smtpSettings();
  const socket = settings.secure
    ? tls.connect({ host: settings.host, port: settings.port, servername: settings.host })
    : net.connect({ host: settings.host, port: settings.port });
  const client = new SmtpClient(socket, settings.timeoutMs);
  try {
    await client.expect(220);
    await client.command(`EHLO ${smtpLocalName()}`, 250);
    if (!settings.secure && process.env.ALERT_SMTP_STARTTLS !== 'false') {
      await client.command('STARTTLS', 220);
      client.upgradeTls(settings.host);
      await client.command(`EHLO ${smtpLocalName()}`, 250);
    }
    if (settings.user || settings.pass) {
      await client.command(`AUTH PLAIN ${Buffer.from(`\0${settings.user}\0${settings.pass}`).toString('base64')}`, 235);
    }
    await client.command(`MAIL FROM:<${message.from}>`, 250);
    for (const recipient of message.to) await client.command(`RCPT TO:<${recipient}>`, [250, 251]);
    await client.command('DATA', 354);
    await client.writeData(smtpMessage(message));
    await client.expect(250);
    await client.command('QUIT', 221).catch(() => undefined);
  } finally {
    client.destroy();
  }
}

function smtpLocalName(): string {
  return (process.env.ALERT_SMTP_HELO || 'flowsbiz.local').replace(/[^\w.-]/g, '').slice(0, 80) || 'flowsbiz.local';
}

function smtpMessage(message: { to: string[]; from: string; subject: string; body: string }): string {
  const headers = [
    `From: ${message.from}`,
    `To: ${message.to.join(', ')}`,
    `Subject: =?UTF-8?B?${Buffer.from(message.subject, 'utf8').toString('base64')}?=`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  const body = message.body.replace(/\r?\n/g, '\r\n').split('\r\n').map((line) => line.startsWith('.') ? `.${line}` : line).join('\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n.\r\n`;
}

class SmtpClient {
  private socket: net.Socket | tls.TLSSocket;
  private buffer = '';
  private waiters: Array<{
    resolve: (line: string) => void;
    reject: (err: Error) => void;
    expected: number[];
    timer: NodeJS.Timeout;
  }> = [];

  constructor(socket: net.Socket | tls.TLSSocket, private readonly timeoutMs: number) {
    this.socket = socket;
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk) => this.onData(String(chunk)));
    this.socket.on('error', (err) => this.rejectAll(err instanceof Error ? err : new Error(String(err))));
    this.socket.on('close', () => this.rejectAll(new Error('SMTP connection closed')));
  }

  async command(command: string, expected: number | number[]): Promise<string> {
    this.socket.write(command + '\r\n');
    return this.expect(expected);
  }

  async writeData(data: string): Promise<void> {
    this.socket.write(data);
  }

  expect(expected: number | number[]): Promise<string> {
    const expectedCodes = Array.isArray(expected) ? expected : [expected];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('SMTP response timed out'));
      }, this.timeoutMs);
      this.waiters.push({ resolve, reject, expected: expectedCodes, timer });
      this.flushResponses();
    });
  }

  upgradeTls(host: string): void {
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('error');
    this.socket.removeAllListeners('close');
    this.socket = tls.connect({ socket: this.socket, servername: host });
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk) => this.onData(String(chunk)));
    this.socket.on('error', (err) => this.rejectAll(err instanceof Error ? err : new Error(String(err))));
    this.socket.on('close', () => this.rejectAll(new Error('SMTP connection closed')));
    this.buffer = '';
  }

  destroy(): void {
    this.socket.destroy();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    this.flushResponses();
  }

  private flushResponses(): void {
    while (this.waiters.length) {
      const response = this.nextCompleteResponse();
      if (!response) return;
      const waiter = this.waiters.shift()!;
      clearTimeout(waiter.timer);
      const code = Number(response.slice(0, 3));
      if (waiter.expected.includes(code)) waiter.resolve(response);
      else waiter.reject(new Error(`SMTP expected ${waiter.expected.join('/')} but got ${response.slice(0, 500)}`));
    }
  }

  private nextCompleteResponse(): string | null {
    const lines = this.buffer.split(/\r?\n/);
    if (!this.buffer.match(/\r?\n$/)) lines.pop();
    if (!lines.length) return null;
    let consumed = 0;
    for (const line of lines) {
      consumed += line.length + 2;
      if (/^\d{3} /.test(line)) {
        const response = lines.slice(0, lines.indexOf(line) + 1).join('\n');
        this.buffer = this.buffer.slice(consumed);
        return response;
      }
      if (!/^\d{3}-/.test(line) && !/^\d{3} /.test(line)) {
        this.buffer = this.buffer.slice(consumed);
        return line;
      }
    }
    return null;
  }

  private rejectAll(err: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }
}
