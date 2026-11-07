/**
 * messageUsage.ts - how many WhatsApp messages each campaign ("link") sent, and what Meta charges for them.
 *
 * Pure functions, no I/O. The CLIENT counts from its own outbox rows (computeMessageUsage); the ADMIN adds prices and the
 * monthly free tier across clients (priceUsage / buildCostReport). Prices live only on the admin (env), never in the client.
 *
 * What is counted
 *  - A message is BILLABLE once the provider reported it `delivered` (or `read`): Meta bills per delivered message.
 *  - `sent` without a delivery report is counted separately (`sentOnly`): accepted by Meta, not (yet) confirmed delivered.
 *  - `failed` is counted separately and never billed. Queued / retry / uncertain rows are not counted at all.
 *  - A `template` row is priced with the template price; everything else (text, file, buttons, list, contacts) with the service price.
 *  - A message belongs to a campaign through its flow unit: only the FIRST outbox row of a unit stores the continuation descriptor
 *    (with the campaignId), so the unit -> campaign map is built from those rows. Rows with no campaign (service bot, older rows
 *    without a flow reference) are reported under `campaignId: null`, never dropped.
 *  - The date of a message is its `createdAt` (when it was queued). Days and months are cut in Israel time.
 */

import type { Campaign, OutboxMessage } from './storage';

export const USAGE_TIME_ZONE = 'Asia/Jerusalem';
/** Meta (from 2026-10-01): each business phone number gets this many delivered service messages free per calendar month. */
export const DEFAULT_FREE_SERVICE_PER_MONTH = 1000;
/**
 * Israel, USD per delivered message (service = utility rate). Third-party sources say 0.0053; Meta's own usage page on 2026-11-07
 * showed $68.05 for 12,774 paid service messages = 0.005327, so the default is 0.00533. Overridable by env (META_PRICE_*): check it
 * against the rate card / the usage page when Meta changes prices (quarterly at most). A marketing template costs far more (~0.0353).
 */
export const DEFAULT_SERVICE_PRICE_USD = 0.00533;
export const DEFAULT_TEMPLATE_PRICE_USD = 0.00533;

/** The part of an outbox row this module reads. */
export type UsageRow = Pick<OutboxMessage,
  'kind' | 'to' | 'status' | 'deliveryStatus' | 'createdAt' | 'flowRef' | 'continuation' | 'campaignId'>;
export type UsageCampaign = Pick<Campaign, 'id' | 'name' | 'triggerPhrase'>;

export interface UsageCounts {
  /** Delivered / read messages: these are billed. */
  delivered: number;
  /** Of `delivered`: template messages (priced with the template price). */
  deliveredTemplate: number;
  /** Of `delivered`: everything else (priced as service messages). */
  deliveredService: number;
  /** Accepted by the provider, no delivery report (yet). Not billed. */
  sentOnly: number;
  /** Failed. Not billed. */
  failed: number;
  /** Distinct recipients that received at least one delivered message. */
  participants: number;
}

export interface UsageCampaignRow extends UsageCounts {
  /** null = messages that belong to no campaign (service bot, rows without a flow reference). */
  campaignId: string | null;
  name: string;
  triggerPhrase?: string;
  /** The campaign no longer exists in the client (its id is still on old rows). */
  deleted?: boolean;
}

export interface UsageDayRow { day: string; delivered: number; deliveredTemplate: number; deliveredService: number }
export interface UsageMonthRow { month: string; deliveredService: number; deliveredTemplate: number }

export interface MessageUsage {
  fromMs: number | null;
  toMs: number | null;
  totals: UsageCounts;
  campaigns: UsageCampaignRow[];
  byDay: UsageDayRow[];
  byMonth: UsageMonthRow[];
  rowsConsidered: number;
}

const tzFormatters = new Map<string, Intl.DateTimeFormat>();
function dayKey(ms: number, timeZone: string): string {
  let formatter = tzFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    tzFormatters.set(timeZone, formatter);
  }
  return formatter.format(new Date(ms));   // YYYY-MM-DD
}

function emptyCounts(): UsageCounts {
  return { delivered: 0, deliveredTemplate: 0, deliveredService: 0, sentOnly: 0, failed: 0, participants: 0 };
}

function digits(value: string | undefined): string {
  return String(value ?? '').replace(/\D/g, '');
}

type Outcome = 'delivered' | 'sentOnly' | 'failed' | 'ignored';

/** One row's billing outcome. `deliveryStatus` (a provider report) wins over `status` (our own send result). */
export function usageOutcome(row: Pick<UsageRow, 'status' | 'deliveryStatus'>): Outcome {
  if (row.deliveryStatus === 'delivered' || row.deliveryStatus === 'read') return 'delivered';
  if (row.deliveryStatus === 'failed') return 'failed';
  if (row.status === 'failed' || row.status === 'recoverable_failed') return 'failed';
  if (row.status === 'sent') return 'sentOnly';
  return 'ignored';
}

export interface ComputeUsageOptions {
  fromMs?: number;
  toMs?: number;
  timeZone?: string;
}

export function computeMessageUsage(rows: ReadonlyArray<UsageRow>, campaigns: ReadonlyArray<UsageCampaign>, options: ComputeUsageOptions = {}): MessageUsage {
  const timeZone = options.timeZone ?? USAGE_TIME_ZONE;
  const fromMs = options.fromMs ?? null;
  const toMs = options.toMs ?? null;

  // unit -> campaign, from the one row per unit that carries the continuation descriptor
  const campaignOfUnit = new Map<string, string>();
  for (const row of rows) {
    const unitId = row.flowRef?.unitId;
    const campaignId = row.continuation?.descriptor?.campaignId;
    if (unitId && campaignId && !campaignOfUnit.has(unitId)) campaignOfUnit.set(unitId, campaignId);
  }
  const campaignById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));

  type Acc = UsageCounts & { phones: Set<string> };
  const newAcc = (): Acc => ({ ...emptyCounts(), phones: new Set<string>() });
  const total = newAcc();
  const perCampaign = new Map<string | null, Acc>();
  const perDay = new Map<string, UsageDayRow>();
  const perMonth = new Map<string, UsageMonthRow>();
  let considered = 0;

  for (const row of rows) {
    const outcome = usageOutcome(row);
    if (outcome === 'ignored') continue;
    const at = Date.parse(row.createdAt);
    if (!Number.isFinite(at)) continue;
    if (fromMs !== null && at < fromMs) continue;
    if (toMs !== null && at >= toMs) continue;
    considered += 1;

    const campaignId = row.campaignId ?? (row.flowRef?.unitId ? campaignOfUnit.get(row.flowRef.unitId) : undefined) ?? null;
    let acc = perCampaign.get(campaignId);
    if (!acc) { acc = newAcc(); perCampaign.set(campaignId, acc); }

    if (outcome === 'sentOnly') { acc.sentOnly += 1; total.sentOnly += 1; continue; }
    if (outcome === 'failed') { acc.failed += 1; total.failed += 1; continue; }

    const isTemplate = row.kind === 'template';
    const phone = digits(row.to);
    for (const target of [acc, total]) {
      target.delivered += 1;
      if (isTemplate) target.deliveredTemplate += 1; else target.deliveredService += 1;
      if (phone) target.phones.add(phone);
    }
    const day = dayKey(at, timeZone);
    const dayRow = perDay.get(day) ?? { day, delivered: 0, deliveredTemplate: 0, deliveredService: 0 };
    dayRow.delivered += 1;
    if (isTemplate) dayRow.deliveredTemplate += 1; else dayRow.deliveredService += 1;
    perDay.set(day, dayRow);
    const month = day.slice(0, 7);
    const monthRow = perMonth.get(month) ?? { month, deliveredService: 0, deliveredTemplate: 0 };
    if (isTemplate) monthRow.deliveredTemplate += 1; else monthRow.deliveredService += 1;
    perMonth.set(month, monthRow);
  }

  const finish = (acc: Acc): UsageCounts => ({
    delivered: acc.delivered, deliveredTemplate: acc.deliveredTemplate, deliveredService: acc.deliveredService,
    sentOnly: acc.sentOnly, failed: acc.failed, participants: acc.phones.size,
  });

  const campaignRows: UsageCampaignRow[] = [...perCampaign.entries()].map(([campaignId, acc]) => {
    const known = campaignId ? campaignById.get(campaignId) : undefined;
    return {
      campaignId,
      name: campaignId === null ? 'ללא קמפיין (בוט שירות / הודעות ישנות)' : (known?.name ?? 'קמפיין שנמחק'),
      triggerPhrase: known?.triggerPhrase,
      ...(campaignId !== null && !known ? { deleted: true } : {}),
      ...finish(acc),
    };
  }).sort((a, b) => b.delivered - a.delivered || a.name.localeCompare(b.name));

  return {
    fromMs, toMs,
    totals: finish(total),
    campaigns: campaignRows,
    byDay: [...perDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    byMonth: [...perMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
    rowsConsidered: considered,
  };
}

// ─── pricing (admin side) ─────────────────────────────────────────────────────

export interface UsagePrices {
  serviceUsd: number;
  templateUsd: number;
  freeServicePerMonth: number;
  /** Optional: shekels per dollar, only for display. */
  usdIlsRate: number | null;
}

function positiveNumber(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && String(value ?? '').trim() !== '' ? parsed : null;
}

export function readUsagePrices(env: NodeJS.ProcessEnv = process.env): UsagePrices {
  return {
    serviceUsd: positiveNumber(env.META_PRICE_SERVICE_USD) ?? DEFAULT_SERVICE_PRICE_USD,
    templateUsd: positiveNumber(env.META_PRICE_TEMPLATE_USD) ?? DEFAULT_TEMPLATE_PRICE_USD,
    freeServicePerMonth: Math.trunc(positiveNumber(env.META_FREE_SERVICE_PER_MONTH) ?? DEFAULT_FREE_SERVICE_PER_MONTH),
    usdIlsRate: positiveNumber(env.USD_ILS_RATE),
  };
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

/** Gross cost (before the free tier) of a set of counts. */
export function priceUsage(counts: Pick<UsageCounts, 'deliveredService' | 'deliveredTemplate'>, prices: UsagePrices): number {
  return round6(counts.deliveredService * prices.serviceUsd + counts.deliveredTemplate * prices.templateUsd);
}

/** What one client reported, as the admin receives it. */
export interface ClientUsageInput {
  clientId: string;
  clientName: string;
  disabled: boolean;
  /** 'shared' for the shared Meta number, 'phone:<id>' for a dedicated number: the free tier is per number. */
  scope: string;
  /** Only META_CLOUD_API messages are billed by Meta; others are counted but cost 0. */
  billed: boolean;
  usage: MessageUsage | null;
  error?: string;
}

export interface CostCampaignRow extends UsageCampaignRow {
  costUsd: number;
  costPerParticipantUsd: number | null;
}
export interface CostClientRow {
  clientId: string;
  clientName: string;
  disabled: boolean;
  scope: string;
  billed: boolean;
  reachable: boolean;
  error?: string;
  totals: UsageCounts;
  costUsd: number;
  costPerParticipantUsd: number | null;
  campaigns: CostCampaignRow[];
}
export interface CostReport {
  prices: UsagePrices;
  clients: CostClientRow[];
  totals: UsageCounts & { costGrossUsd: number; freeTierCreditUsd: number; costNetUsd: number; costPerParticipantUsd: number | null };
  /** The free tier applied per number and month: `used` messages of `allowance`, worth `creditUsd`. */
  freeTier: Array<{ scope: string; month: string; deliveredService: number; freeMessages: number; creditUsd: number }>;
  unreachable: string[];
}

const perParticipant = (costUsd: number, participants: number): number | null => (participants > 0 ? round6(costUsd / participants) : null);

/**
 * Prices every client and campaign (gross), then takes the monthly free tier off the TOTAL only: the free 1,000 service messages
 * belong to the phone number, so by-link amounts stay gross and exact, and the credit is reported once per number and month.
 * Participants are distinct per client (a person who joined two links of one client is counted once in the client's total).
 */
export function buildCostReport(inputs: ReadonlyArray<ClientUsageInput>, prices: UsagePrices): CostReport {
  const clients: CostClientRow[] = [];
  const unreachable: string[] = [];
  const total = emptyCounts();
  let gross = 0;
  const monthlyService = new Map<string, number>();   // `${scope}|${month}` -> delivered service messages (billed clients only)

  for (const input of inputs) {
    if (!input.usage) {
      unreachable.push(input.clientName);
      clients.push({
        clientId: input.clientId, clientName: input.clientName, disabled: input.disabled, scope: input.scope, billed: input.billed,
        reachable: false, error: input.error, totals: emptyCounts(), costUsd: 0, costPerParticipantUsd: null, campaigns: [],
      });
      continue;
    }
    const usage = input.usage;
    const price = (counts: Pick<UsageCounts, 'deliveredService' | 'deliveredTemplate'>) => (input.billed ? priceUsage(counts, prices) : 0);
    const campaigns: CostCampaignRow[] = usage.campaigns.map((campaign) => {
      const costUsd = price(campaign);
      return { ...campaign, costUsd, costPerParticipantUsd: perParticipant(costUsd, campaign.participants) };
    });
    const costUsd = price(usage.totals);
    clients.push({
      clientId: input.clientId, clientName: input.clientName, disabled: input.disabled, scope: input.scope, billed: input.billed,
      reachable: true, totals: usage.totals, costUsd, costPerParticipantUsd: perParticipant(costUsd, usage.totals.participants), campaigns,
    });
    gross += costUsd;
    for (const key of ['delivered', 'deliveredTemplate', 'deliveredService', 'sentOnly', 'failed', 'participants'] as const) total[key] += usage.totals[key];
    if (input.billed) {
      for (const month of usage.byMonth) {
        const key = `${input.scope}|${month.month}`;
        monthlyService.set(key, (monthlyService.get(key) ?? 0) + month.deliveredService);
      }
    }
  }

  const freeTier = [...monthlyService.entries()].map(([key, deliveredService]) => {
    const [scope, month] = key.split('|');
    const freeMessages = Math.min(prices.freeServicePerMonth, deliveredService);
    return { scope, month, deliveredService, freeMessages, creditUsd: round6(freeMessages * prices.serviceUsd) };
  }).sort((a, b) => a.month.localeCompare(b.month) || a.scope.localeCompare(b.scope));
  const credit = round6(freeTier.reduce((sum, row) => sum + row.creditUsd, 0));

  clients.sort((a, b) => b.costUsd - a.costUsd || b.totals.delivered - a.totals.delivered || a.clientName.localeCompare(b.clientName));
  const net = round6(Math.max(0, gross - credit));
  return {
    prices,
    clients,
    totals: { ...total, costGrossUsd: round6(gross), freeTierCreditUsd: credit, costNetUsd: net, costPerParticipantUsd: perParticipant(net, total.participants) },
    freeTier,
    unreachable,
  };
}
