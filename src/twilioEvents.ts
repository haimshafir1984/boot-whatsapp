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

const events: TwilioEvent[] = [];
const MAX_EVENTS = 200;

export function recordTwilioEvent(event: Omit<TwilioEvent, 'id' | 'at'>): TwilioEvent {
  const saved: TwilioEvent = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    ...event,
  };
  events.unshift(saved);
  events.splice(MAX_EVENTS);
  return saved;
}

export function getTwilioEvents(limit = 50): TwilioEvent[] {
  return events.slice(0, Math.max(1, Math.min(limit, MAX_EVENTS)));
}
