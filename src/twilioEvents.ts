import fs from 'fs';
import path from 'path';
import { config } from './config';

export type TwilioEventDirection = 'inbound' | 'outbound';
export type TwilioEventStatus = 'received' | 'sent' | 'ignored' | 'failed';

export interface TwilioEvent {
  id: string;
  at: string;
  direction: TwilioEventDirection;
  status: TwilioEventStatus;
  from?: string;
  to?: string;
  body?: string;
  messageSid?: string;
  details?: string;
}

const MAX_EVENTS = 5000;
const EVENTS_PATH = path.join(path.dirname(config.STORAGE_PATH), 'twilio-events.json');

function loadEvents(): TwilioEvent[] {
  try {
    if (!fs.existsSync(EVENTS_PATH)) return [];
    const parsed = JSON.parse(fs.readFileSync(EVENTS_PATH, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((event): event is TwilioEvent => (
      event
      && typeof event.id === 'string'
      && typeof event.at === 'string'
      && (event.direction === 'inbound' || event.direction === 'outbound')
      && ['received', 'sent', 'ignored', 'failed'].includes(event.status)
    )).slice(0, MAX_EVENTS);
  } catch {
    return [];
  }
}

const events: TwilioEvent[] = loadEvents();

function persistEvents(): void {
  try {
    fs.mkdirSync(path.dirname(EVENTS_PATH), { recursive: true });
    fs.writeFileSync(EVENTS_PATH, JSON.stringify(events, null, 2), 'utf8');
  } catch (err) {
    console.warn('Failed to persist Twilio events:', err);
  }
}

export function recordTwilioEvent(event: Omit<TwilioEvent, 'id' | 'at'>): TwilioEvent {
  const saved: TwilioEvent = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    ...event,
  };
  events.unshift(saved);
  events.splice(MAX_EVENTS);
  persistEvents();
  return saved;
}

export function getTwilioEvents(limit = 50): TwilioEvent[] {
  return events.slice(0, Math.max(1, Math.min(limit, MAX_EVENTS)));
}
