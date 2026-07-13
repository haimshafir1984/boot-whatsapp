import type { Campaign } from './storage';

export const DEFAULT_META_CAMPAIGN_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

export function normalizeMetaTrigger(value: string): string {
  return String(value ?? '')
    .replace(/[\u200b-\u200f\ufeff\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase()
    .trim();
}

export function defaultMetaCampaignEndAt(startAt?: string, now = Date.now()): string {
  const parsedStart = startAt ? new Date(startAt).getTime() : Number.NaN;
  const base = Number.isNaN(parsedStart) ? now : Math.max(now, parsedStart);
  return new Date(base + DEFAULT_META_CAMPAIGN_DURATION_MS).toISOString();
}

export function metaCampaignReservesTrigger(campaign: Pick<Campaign, 'active' | 'runtimeStatus'>): boolean {
  return campaign.active === true && campaign.runtimeStatus !== 'ended';
}

export interface MetaRouteCandidate<TClient = unknown> {
  client: TClient;
  clientId: string;
  campaign: Campaign;
  triggerText: string;
}

export function selectMetaRouteCandidate<TClient>(candidates: MetaRouteCandidate<TClient>[]): {
  best: MetaRouteCandidate<TClient> | undefined;
  ambiguous: boolean;
} {
  candidates.sort((a, b) => b.triggerText.length - a.triggerText.length);
  const best = candidates[0];
  if (!best) return { best: undefined, ambiguous: false };

  const topClientIds = new Set(
    candidates
      .filter((candidate) => candidate.triggerText.length === best.triggerText.length)
      .map((candidate) => candidate.clientId),
  );
  return { best, ambiguous: topClientIds.size > 1 };
}
