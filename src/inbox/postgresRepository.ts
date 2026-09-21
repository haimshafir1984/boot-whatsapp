import { Pool, PoolClient } from 'pg';
import {
  EnqueueResult, InboxClaimResult, InboxCounts, InboxEnqueueInput, InboxItem, InboxMetrics, InboxRepository, InboxResolution,
  InboxRole, InboxStatus, InvariantViolation,
} from './types';

/**
 * PostgreSQL inbox repository (stage E, C2). One row per message (`inbox_items`) and one scheduler row per sender
 * (`inbox_senders`) that points at the sender's head. No operation reads or writes anything proportional to the
 * retained history or to the total backlog: claim walks the partial `due_at` index, transitions touch the item, the
 * sender row and the sender's own outstanding items.
 *
 * Lock order is ALWAYS sender row -> item rows (enqueue, claim, every transition, cancel, resolve), and multi-sender
 * operations lock senders sorted by sender_key. That makes deadlocks impossible by construction.
 *
 * All time comparisons use the DATABASE clock (`clock_timestamp()`), never the application clock, so workers with
 * different clocks agree. `clockOffsetMs` exists for tests only (time travel without sleeping).
 *
 * The token (lease_token) fences DATABASE writes of a stale worker. It does NOT fence what that worker already did
 * on the network: for the client role an expired lease therefore never leads to a re-run (it becomes `review`).
 */

const DEFAULT_LEASE_MS = 120_000;
const OUTSTANDING = "('queued','retry','processing')";

interface Row { [key: string]: any }

const toItem = (r: Row): InboxItem => ({
  id: String(r.id), messageId: r.message_id, phoneNumberId: r.phone_number_id, senderKey: r.sender_key, senderPhone: r.sender_phone,
  senderSeq: String(r.sender_seq), status: r.status as InboxStatus, attempts: r.attempts, payload: r.payload,
  providerTs: r.provider_ts, receivedAt: r.received_at, firstClaimedAt: r.first_claimed_at, nextAttemptAt: r.next_attempt_at,
  leaseToken: r.lease_token, leaseExpiresAt: r.lease_expires_at, claimedBy: r.claimed_by, effectsState: r.effects_state,
  lastError: r.last_error, resolution: r.resolution, resolutionDetail: r.resolution_detail, updatedAt: r.updated_at, updatedAtText: r.updated_text, completedAt: r.completed_at,
});
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 1000);

export class PostgresInboxRepository implements InboxRepository {
  /** Test-only: shifts the database clock used by every comparison. */
  clockOffsetMs = 0;

  constructor(
    private readonly pool: Pool,
    private readonly opts: { namespace: string; role: InboxRole; ownsPool?: boolean },
  ) {}

  private get ns(): string { return this.opts.namespace; }
  private get role(): InboxRole { return this.opts.role; }
  /** Time used for VALUES written to rows (received_at, lease expiry ...). */
  private get T(): string {
    const ms = Math.trunc(this.clockOffsetMs);
    return ms ? `(clock_timestamp() + interval '${ms} milliseconds')` : 'clock_timestamp()';
  }
  /**
   * Time used in WHERE comparisons. It MUST be a STABLE expression: clock_timestamp() is volatile, so PostgreSQL cannot use
   * `due_at <= clock_timestamp()` as an index condition and applies it as a filter over every row of the index range
   * (measured: every not-yet-due sender was visited). statement_timestamp() is stable, so the scan stops at the boundary.
   */
  private get TS(): string {
    const ms = Math.trunc(this.clockOffsetMs);
    return ms ? `(statement_timestamp() + interval '${ms} milliseconds')` : 'statement_timestamp()';
  }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    // A checked-out client has no pool error listener: if the server kills its connection between two statements, the client emits 'error'
    // and, unhandled, that takes the whole process down. Handle it here; the connection is then destroyed instead of returned to the pool.
    let broken = false;
    const onClientError = (err: Error): void => { broken = true; console.error('[INBOX_CLIENT_ERROR]', err.message); };
    c.on('error', onClientError);
    try {
      await c.query('begin');
      const result = await fn(c);
      await c.query('commit');
      return result;
    } catch (err) {
      if (!broken) await c.query('rollback').catch(() => { broken = true; });
      throw err;
    } finally {
      c.off('error', onClientError);
      c.release(broken ? true : undefined);
    }
  }

  /** Recomputes the sender's head from its OUTSTANDING items (partial index) and republishes the pointer. Caller holds the sender row lock. */
  private async recomputeHead(c: PoolClient, senderKey: string): Promise<void> {
    await c.query(
      `with h as (
         select id, status, received_at, next_attempt_at, lease_expires_at from inbox_items
          where namespace = $1 and role = $2 and sender_key = $3 and status in ${OUTSTANDING}
          order by sender_seq limit 1)
       update inbox_senders s set
         head_id = (select id from h),
         head_status = (select status from h),
         due_at = (select case status when 'queued' then received_at when 'retry' then next_attempt_at when 'processing' then lease_expires_at end from h),
         updated_at = ${this.T}
       where s.namespace = $1 and s.role = $2 and s.sender_key = $3`,
      [this.ns, this.role, senderKey],
    );
  }

  private async lockSenders(c: PoolClient, keys: string[]): Promise<void> {
    const sorted = [...new Set(keys)].sort();
    if (!sorted.length) return;
    await c.query(
      `select 1 from inbox_senders where namespace = $1 and role = $2 and sender_key = any($3::text[]) order by sender_key for update`,
      [this.ns, this.role, sorted],
    );
  }

  // ---------------------------------------------------------------------------------------------------- enqueue

  async enqueueMany(inputs: InboxEnqueueInput[]): Promise<EnqueueResult> {
    const result: EnqueueResult = { inserted: [], duplicates: [] };
    if (!inputs.length) return result;
    // One transaction for the whole webhook: all or nothing. Sender rows are touched in sorted order (no deadlock).
    const ordered = inputs.map((input, index) => ({ input, index })).sort((a, b) => (a.input.senderKey < b.input.senderKey ? -1 : a.input.senderKey > b.input.senderKey ? 1 : a.index - b.index));
    await this.tx(async (c) => {
      for (const { input } of ordered) {
        const exists = await c.query(
          'select 1 from inbox_items where namespace = $1 and role = $2 and phone_number_id = $3 and message_id = $4',
          [this.ns, this.role, input.phoneNumberId, input.messageId],
        );
        if (exists.rowCount) { result.duplicates.push(input.messageId); continue; }
        // Allocating the sequence number LOCKS the sender row until commit: a later transaction for the same sender waits,
        // so a later message can never be published ahead of an uncommitted earlier one.
        const seq = await c.query(
          `insert into inbox_senders(namespace, role, sender_key, sender_phone, next_seq, updated_at)
           values ($1, $2, $3, $4, 2, ${this.T})
           on conflict (namespace, role, sender_key) do update set next_seq = inbox_senders.next_seq + 1, updated_at = ${this.T}
           returning next_seq - 1 as seq, head_id`,
          [this.ns, this.role, input.senderKey, input.senderPhone],
        );
        const inserted = await c.query(
          `insert into inbox_items(namespace, role, phone_number_id, message_id, sender_key, sender_phone, sender_seq, status, payload, provider_ts, received_at, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, 'queued', $8::jsonb, $9, ${this.T}, ${this.T}, ${this.T})
           on conflict (namespace, role, phone_number_id, message_id) do nothing
           returning id, received_at`,
          [this.ns, this.role, input.phoneNumberId, input.messageId, input.senderKey, input.senderPhone, seq.rows[0].seq, JSON.stringify(input.payload ?? null), input.providerTs ?? null],
        );
        if (!inserted.rowCount) { result.duplicates.push(input.messageId); continue; }   // lost a race on identity: the other insert won
        result.inserted.push(input.messageId);
        if (seq.rows[0].head_id === null) {
          await c.query(
            // due_at is copied by SQL from the item row (a JS Date would drop the microseconds and make the pointer drift).
            `update inbox_senders s set head_id = i.id, head_status = 'queued', due_at = i.received_at, updated_at = ${this.T}
               from inbox_items i where i.id = $4 and s.namespace = $1 and s.role = $2 and s.sender_key = $3`,
            [this.ns, this.role, input.senderKey, inserted.rows[0].id],
          );
        }
      }
    });
    return result;
  }

  // ---------------------------------------------------------------------------------------------------- claim

  async claim(limit: number, opts: { workerId: string; leaseMs?: number }): Promise<InboxClaimResult> {
    const leaseMs = Math.max(1, Math.trunc(opts.leaseMs ?? DEFAULT_LEASE_MS));
    return this.tx(async (c) => {
      const out: InboxClaimResult = { claimed: [], reviewed: [] };
      const due = await c.query(
        `select sender_key, head_id from inbox_senders
          where namespace = $1 and role = $2 and head_id is not null and due_at <= ${this.TS}
          order by due_at limit $3 for update skip locked`,
        [this.ns, this.role, Math.max(0, Math.trunc(limit))],
      );
      if (!due.rowCount) return out;
      const heads = await c.query(
        `select i.*, (i.status = 'queued' or (i.status = 'retry' and i.next_attempt_at <= ${this.TS})) as ready,
                (i.status = 'processing' and i.lease_expires_at <= ${this.TS}) as lease_expired
           from inbox_items i where i.id = any($1::bigint[]) for update`,
        [due.rows.map((r) => r.head_id)],
      );
      const claimIds: string[] = [];
      const reviewIds: string[] = [];
      const skipped: string[] = [];
      for (const h of heads.rows) {
        if (h.ready) claimIds.push(h.id);
        else if (h.lease_expired) (this.role === 'gateway' ? claimIds : reviewIds).push(h.id);
        else skipped.push(h.sender_key);        // a due sender whose head is not actually due: pointer drift (must never happen)
      }
      if (claimIds.length) {
        const upd = await c.query(
          `update inbox_items set status = 'processing', attempts = attempts + 1, lease_token = gen_random_uuid(),
                  lease_expires_at = ${this.T} + ($2::int * interval '1 millisecond'), claimed_by = $3,
                  first_claimed_at = coalesce(first_claimed_at, ${this.T}),
                  effects_state = case when role = 'client' then 'possible' else effects_state end,
                  next_attempt_at = null, last_error = null, updated_at = ${this.T}
            where id = any($1::bigint[]) returning *`,
          [claimIds, leaseMs, opts.workerId],
        );
        await c.query(
          `update inbox_senders s set head_status = 'processing', due_at = i.lease_expires_at, updated_at = ${this.T}
             from inbox_items i where i.id = any($1::bigint[]) and s.namespace = i.namespace and s.role = i.role and s.sender_key = i.sender_key`,
          [claimIds],
        );
        for (const r of upd.rows) out.claimed.push({ item: toItem(r), leaseToken: r.lease_token });
      }
      if (reviewIds.length) {
        // The client already had effects possibly underway: do NOT run it again. Keep the lease token so a late completion by the
        // original worker (which may simply have been slow) can still close it truthfully.
        const rev = await c.query(
          `update inbox_items set status = 'review', resolution = 'ambiguous_processing',
                  resolution_detail = jsonb_build_object('attempts', attempts, 'claimedBy', claimed_by, 'leaseExpiredAt', lease_expires_at),
                  last_error = 'lease expired while effects may have started', updated_at = ${this.T}
            where id = any($1::bigint[]) returning *`,
          [reviewIds],
        );
        for (const r of rev.rows) { await this.recomputeHead(c, r.sender_key); out.reviewed.push(toItem(r)); }
      }
      for (const key of skipped) await this.recomputeHead(c, key);
      return out;
    });
  }

  // ---------------------------------------------------------------------------------------------------- worker transitions

  async renew(id: string, leaseToken: string, leaseMs = DEFAULT_LEASE_MS): Promise<boolean> {
    return this.workerTransition(id, leaseToken, async (c, item) => {
      const r = await c.query(
        `update inbox_items set lease_expires_at = ${this.T} + ($3::int * interval '1 millisecond'), updated_at = ${this.T}
          where id = $1 and status = 'processing' and lease_token = $2 returning id`,
        [id, leaseToken, Math.max(1, Math.trunc(leaseMs))],
      );
      if (!r.rowCount) return null;
      await this.recomputeHead(c, item.sender_key);   // due_at follows the new lease expiry (I3)
      return item.sender_key;
    });
  }

  complete(id: string, leaseToken: string, resolution: InboxResolution = 'processed', detail?: unknown): Promise<boolean> {
    return this.finish(id, leaseToken, 'completed', { resolution, detail, allowLate: true });
  }

  retry(id: string, leaseToken: string, error: unknown, nextAttemptAt: Date): Promise<boolean> {
    return this.finish(id, leaseToken, 'retry', { error, nextAttemptAt });
  }

  hold(id: string, leaseToken: string, reason: unknown): Promise<boolean> {
    return this.finish(id, leaseToken, 'held', { error: reason, resolution: 'sender_held' });
  }

  fail(id: string, leaseToken: string, error: unknown, resolution: InboxResolution = 'exhausted'): Promise<boolean> {
    return this.finish(id, leaseToken, 'failed', { error, resolution });
  }

  review(id: string, leaseToken: string, resolution: InboxResolution, detail?: unknown): Promise<boolean> {
    return this.finish(id, leaseToken, 'review', { resolution, detail });
  }

  /** Lock order: sender row first, then the item. Returns false for a stale token (a stale worker changes NOTHING). */
  private async workerTransition(id: string, leaseToken: string, body: (c: PoolClient, item: Row) => Promise<string | null>): Promise<boolean> {
    return this.tx(async (c) => {
      const found = await c.query('select sender_key from inbox_items where id = $1 and namespace = $2 and role = $3', [id, this.ns, this.role]);
      if (!found.rowCount) return false;
      await this.lockSenders(c, [found.rows[0].sender_key]);
      const key = await body(c, found.rows[0]);
      return key !== null;
    });
  }

  private async finish(
    id: string, leaseToken: string, to: 'completed' | 'retry' | 'held' | 'failed' | 'review',
    f: { resolution?: InboxResolution; detail?: unknown; error?: unknown; nextAttemptAt?: Date; allowLate?: boolean },
  ): Promise<boolean> {
    return this.workerTransition(id, leaseToken, async (c, item) => {
      const keepLease = to === 'review';
      const r = await c.query(
        `update inbox_items set status = $3, resolution = $4, resolution_detail = $5::jsonb,
                last_error = $6, next_attempt_at = $7,
                lease_token = case when $8 then lease_token else null end, lease_expires_at = case when $8 then lease_expires_at else null end,
                completed_at = case when $3 = 'completed' then ${this.T} else completed_at end, updated_at = ${this.T}
          where id = $1 and status = 'processing' and lease_token = $2 returning id`,
        [id, leaseToken, to, f.resolution ?? null, f.detail === undefined ? null : JSON.stringify(f.detail), f.error === undefined ? null : errText(f.error), f.nextAttemptAt ?? null, keepLease],
      );
      if (!r.rowCount && f.allowLate) {
        // The original worker finished after its lease was declared ambiguous: nobody else ever ran it, so this is truthful.
        const late = await c.query(
          `update inbox_items set status = 'completed', resolution = 'processed_late', completed_at = ${this.T}, updated_at = ${this.T},
                  lease_token = null, lease_expires_at = null, last_error = null
            where id = $1 and status = 'review' and resolution = 'ambiguous_processing' and lease_token = $2 returning id`,
          [id, leaseToken],
        );
        if (!late.rowCount) return null;
      } else if (!r.rowCount) return null;
      await this.recomputeHead(c, item.sender_key);
      return item.sender_key;
    });
  }

  // ---------------------------------------------------------------------------------------------------- admin / cancel

  async cancelForPhone(phoneDigits: string, reason = 'Campaign superseded; do not replay.'): Promise<number> {
    return this.tx(async (c) => {
      const senders = await c.query(
        'select sender_key from inbox_senders where namespace = $1 and role = $2 and sender_phone = $3 order by sender_key for update',
        [this.ns, this.role, phoneDigits],
      );
      if (!senders.rowCount) return 0;
      const keys = senders.rows.map((r) => r.sender_key);
      const upd = await c.query(
        `update inbox_items set status = 'failed', resolution = 'superseded', last_error = $4, next_attempt_at = null,
                lease_token = null, lease_expires_at = null, updated_at = ${this.T}
          where namespace = $1 and role = $2 and sender_key = any($3::text[]) and status in ${OUTSTANDING} returning sender_key`,
        [this.ns, this.role, keys, reason],
      );
      for (const key of new Set(upd.rows.map((r) => r.sender_key))) await this.recomputeHead(c, key);
      return upd.rowCount ?? 0;
    });
  }

  async resolveForPhone(
    phoneDigits: string, action: 'requeue' | 'discard', actor: string,
    opts: { statuses?: Array<'held' | 'failed' | 'review'>; acknowledgeDuplicateRisk?: boolean } = {},
  ): Promise<number> {
    const statuses = opts.statuses ?? ['held'];
    return this.tx(async (c) => {
      const senders = await c.query(
        'select sender_key from inbox_senders where namespace = $1 and role = $2 and sender_phone = $3 order by sender_key for update',
        [this.ns, this.role, phoneDigits],
      );
      if (!senders.rowCount) return 0;
      const items = await c.query(
        `select id, sender_key, status, sender_seq, resolution, last_error from inbox_items
          where namespace = $1 and role = $2 and sender_phone = $3 and status = any($4::text[])
          order by sender_key, sender_seq for update`,
        [this.ns, this.role, phoneDigits, statuses],
      );
      let touched = 0;
      const touchedKeys = new Set<string>();
      for (const it of items.rows) {
        // An ambiguous item can produce a duplicate effect: it needs an explicit acknowledgement to be replayed.
        if (action === 'requeue' && it.status === 'review' && it.resolution === 'ambiguous_processing' && !opts.acknowledgeDuplicateRisk) continue;
        if (action === 'requeue') {
          const seq = await c.query('update inbox_senders set next_seq = next_seq + 1 where namespace = $1 and role = $2 and sender_key = $3 returning next_seq - 1 as seq', [this.ns, this.role, it.sender_key]);
          await c.query(
            `update inbox_items set status = 'queued', sender_seq = $2, attempts = 0, next_attempt_at = null, last_error = null,
                    resolution = null, resolution_detail = null, lease_token = null, lease_expires_at = null, first_claimed_at = null,
                    effects_state = 'none', completed_at = null, updated_at = ${this.T}
              where id = $1`,
            [it.id, seq.rows[0].seq],
          );
        } else {
          await c.query(
            `update inbox_items set status = 'failed', resolution = 'admin_discarded', next_attempt_at = null, lease_token = null, lease_expires_at = null,
                    last_error = '[ADMIN_DISCARDED] ' || coalesce(last_error, ''), updated_at = ${this.T}
              where id = $1`,
            [it.id],
          );
        }
        await c.query('insert into inbox_admin_audit(actor, action, item_id, from_status, to_status, detail) values ($1, $2, $3, $4, $5, $6::jsonb)',
          [actor, action, it.id, it.status, action === 'requeue' ? 'queued' : 'failed', JSON.stringify({ resolution: it.resolution ?? null })]);
        touchedKeys.add(it.sender_key);
        touched += 1;
      }
      for (const key of touchedKeys) await this.recomputeHead(c, key);
      return touched;
    });
  }

  async listReview(opts: { statuses?: Array<'held' | 'failed' | 'review'>; limit?: number; after?: { updatedAt: Date | string; id: string } }): Promise<InboxItem[]> {
    const statuses = opts.statuses ?? ['held', 'failed', 'review'];
    const limit = Math.min(1000, Math.max(1, opts.limit ?? 100));
    const after = opts.after;
    // One indexed, ordered, LIMITed query per status (idx_inbox_items_review: namespace, role, status, updated_at, id), merged here.
    // A single `status = any(...)` + ORDER BY cannot use that index order and would sort every parked row.
    const pages = await Promise.all(statuses.map((status) => (after
      ? this.pool.query(
        `select *, updated_at::text as updated_text from inbox_items where namespace = $1 and role = $2 and status = $3 and (updated_at, id) > ($4::timestamptz, $5::bigint)
          order by updated_at, id limit $6`, [this.ns, this.role, status, after.updatedAt, after.id, limit])
      : this.pool.query(
        `select *, updated_at::text as updated_text from inbox_items where namespace = $1 and role = $2 and status = $3 order by updated_at, id limit $4`,
        [this.ns, this.role, status, limit]))));
    return pages.flatMap((r) => r.rows).sort((x, y) => (x.updated_at - y.updated_at) || (Number(x.id) - Number(y.id))).slice(0, limit).map(toItem);
  }

  // ---------------------------------------------------------------------------------------------------- observability

  async counts(): Promise<InboxCounts> {
    const out: InboxCounts = { queued: 0, processing: 0, retry: 0, held: 0, failed: 0, review: 0, completedLastHour: 0 };
    const active = await this.pool.query(
      `select status, count(*)::int as n from inbox_items where namespace = $1 and role = $2 and status in ('queued','processing','retry') group by status`, [this.ns, this.role]);
    for (const r of active.rows) (out as any)[r.status] = r.n;
    const parked = await this.pool.query(
      `select status, count(*)::int as n from inbox_items where namespace = $1 and role = $2 and status in ('held','failed','review') group by status`, [this.ns, this.role]);
    for (const r of parked.rows) (out as any)[r.status] = r.n;
    const done = await this.pool.query(
      `select count(*)::int as n from inbox_items where namespace = $1 and role = $2 and status = 'completed' and updated_at > ${this.TS} - interval '1 hour'`, [this.ns, this.role]);
    out.completedLastHour = done.rows[0].n;
    return out;
  }

  async metrics(): Promise<InboxMetrics> {
    const oldest = await this.pool.query(
      `select extract(epoch from (${this.TS} - min(due_at))) * 1000 as age_ms from inbox_senders
        where namespace = $1 and role = $2 and head_id is not null and due_at <= ${this.TS}`, [this.ns, this.role]);
    const counts = await this.pool.query(
      `select count(*)::int as with_outstanding, count(*) filter (where due_at <= ${this.TS})::int as due
         from inbox_senders where namespace = $1 and role = $2 and head_id is not null`, [this.ns, this.role]);
    const age = oldest.rows[0].age_ms;
    return { oldestDueAgeMs: age === null ? null : Math.max(0, Number(age)), senders: { withOutstanding: counts.rows[0].with_outstanding, due: counts.rows[0].due } };
  }

  /** Bounded batches through partial indexes; never a table scan. */
  async cleanup(opts: { dedupeDays?: number; payloadDays?: number; batch?: number } = {}): Promise<{ deleted: number; payloadsPurged: number; sendersRemoved: number }> {
    const dedupeDays = opts.dedupeDays ?? 30;
    const payloadDays = opts.payloadDays ?? 7;
    const batch = Math.max(1, Math.trunc(opts.batch ?? 1000));
    const purged = await this.pool.query(
      `update inbox_items set payload = null where id in (
         select id from inbox_items where namespace = $1 and role = $2 and status = 'completed' and payload is not null
            and updated_at < ${this.TS} - ($3::int * interval '1 day') order by updated_at, id limit $4 for update skip locked)`,
      [this.ns, this.role, payloadDays, batch]);
    const deleted = await this.pool.query(
      `delete from inbox_items where id in (
         select id from inbox_items where namespace = $1 and role = $2 and status = 'completed'
            and updated_at < ${this.TS} - ($3::int * interval '1 day') order by updated_at, id limit $4 for update skip locked)`,
      [this.ns, this.role, dedupeDays, batch]);
    // A sender row goes only when it has no item left at all (else next_seq would restart under existing seqs).
    const senders = await this.pool.query(
      `delete from inbox_senders s where (s.namespace, s.role, s.sender_key) in (
         select namespace, role, sender_key from inbox_senders
          where namespace = $1 and role = $2 and head_id is null and updated_at < ${this.TS} - ($3::int * interval '1 day')
            and not exists (select 1 from inbox_items i where i.namespace = inbox_senders.namespace and i.role = inbox_senders.role and i.sender_key = inbox_senders.sender_key)
          limit $4 for update skip locked)`,
      [this.ns, this.role, dedupeDays, batch]);
    return { deleted: deleted.rowCount ?? 0, payloadsPurged: purged.rowCount ?? 0, sendersRemoved: senders.rowCount ?? 0 };
  }

  /** Cost is O(outstanding items), never O(history). Used by tests, the reconciler and the admin endpoint. */
  async checkInvariants(): Promise<InvariantViolation[]> {
    const v: InvariantViolation[] = [];
    // I2/I3: every sender's pointer equals the computed head (lowest outstanding seq) and its derived due_at.
    const drift = await this.pool.query(
      `with exp as (
         select distinct on (sender_key) sender_key, id, status,
                case status when 'queued' then received_at when 'retry' then next_attempt_at when 'processing' then lease_expires_at end as due
           from inbox_items where namespace = $1 and role = $2 and status in ${OUTSTANDING} order by sender_key, sender_seq)
       select coalesce(e.sender_key, s.sender_key) as sender_key, e.id as exp_id, e.status as exp_status, e.due as exp_due,
              s.head_id, s.head_status, s.due_at
         from exp e full join (select * from inbox_senders where namespace = $1 and role = $2 and head_id is not null) s using (sender_key)
        where e.id is distinct from s.head_id or e.status is distinct from s.head_status or e.due is distinct from s.due_at`,
      [this.ns, this.role]);
    for (const r of drift.rows) v.push({ code: 'I2_I3_pointer_drift', senderKey: r.sender_key, detail: JSON.stringify(r) });
    // I1: at most one processing item per sender, and it must be the head.
    const multi = await this.pool.query(
      `select sender_key, count(*)::int as n from inbox_items where namespace = $1 and role = $2 and status = 'processing' group by sender_key having count(*) > 1`, [this.ns, this.role]);
    for (const r of multi.rows) v.push({ code: 'I1_multiple_processing', senderKey: r.sender_key, detail: `n=${r.n}` });
    const nonHead = await this.pool.query(
      `select i.sender_key, i.id from inbox_items i left join inbox_senders s on s.namespace = i.namespace and s.role = i.role and s.sender_key = i.sender_key
        where i.namespace = $1 and i.role = $2 and i.status = 'processing' and s.head_id is distinct from i.id`, [this.ns, this.role]);
    for (const r of nonHead.rows) v.push({ code: 'I1_processing_not_head', senderKey: r.sender_key, detail: `item=${r.id}` });
    // I5-shape: a processing item must carry a token and a lease.
    const noLease = await this.pool.query(
      `select id from inbox_items where namespace = $1 and role = $2 and status = 'processing' and (lease_token is null or lease_expires_at is null)`, [this.ns, this.role]);
    for (const r of noLease.rows) v.push({ code: 'processing_without_lease', detail: `item=${r.id}` });
    // I4: next_seq is ahead of every assigned sequence (only for senders with outstanding work: bounded).
    const seq = await this.pool.query(
      `select s.sender_key, s.next_seq, max(i.sender_seq) as max_seq from inbox_senders s
         join inbox_items i on i.namespace = s.namespace and i.role = s.role and i.sender_key = s.sender_key and i.status in ${OUTSTANDING}
        where s.namespace = $1 and s.role = $2 group by s.sender_key, s.next_seq having max(i.sender_seq) >= s.next_seq`, [this.ns, this.role]);
    for (const r of seq.rows) v.push({ code: 'I4_seq_not_ahead', senderKey: r.sender_key, detail: `next=${r.next_seq} max=${r.max_seq}` });
    return v;
  }

  async close(): Promise<void> {
    if (this.opts.ownsPool) await this.pool.end();
  }

  // ---------------------------------------------------------------------------------------------------- test helpers

  /** Test-only: read one item by identity. */
  async getByMessage(phoneNumberId: string, messageId: string): Promise<InboxItem | null> {
    const r = await this.pool.query('select * from inbox_items where namespace = $1 and role = $2 and phone_number_id = $3 and message_id = $4', [this.ns, this.role, phoneNumberId, messageId]);
    return r.rowCount ? toItem(r.rows[0]) : null;
  }
}
