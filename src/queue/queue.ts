// Thin TypeScript layer over the SQL queue functions (db/migrations/0004_queue.sql).
import type { Db, Queryable } from '../db/db.ts';

export interface Job {
  id: string;            // bigint as text
  tenant_id: string;
  kind: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  run_at: Date;
}

/** Exponential backoff with full jitter; a platform's Retry-After wins when it is longer. */
export function backoffMs(attempt: number, opts: { baseMs?: number; capMs?: number; retryAfterMs?: number; random?: () => number } = {}): number {
  const base = opts.baseMs ?? 30_000;
  const cap = opts.capMs ?? 6 * 3_600_000;
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.max(base / 2, Math.floor((opts.random ?? Math.random)() * ceiling));
  return Math.max(jittered, opts.retryAfterMs ?? 0);
}

/** Must run inside a tenant-scoped transaction (withTenant): the function refuses other tenants. */
export async function enqueue(
  tx: Queryable, job: { tenantId: string; kind: string; key: string; payload?: object; runAt?: Date; maxAttempts?: number },
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    'select social.enqueue_job($1, $2, $3, $4, $5, $6)::text as id',
    [job.tenantId, job.kind, job.key, JSON.stringify(job.payload ?? {}), job.runAt ?? new Date(), job.maxAttempts ?? 6]);
  return rows[0]!.id;
}

export async function claim(db: Db, workerId: string, limit = 10, leaseSeconds = 300): Promise<Job[]> {
  return db.transaction(async (tx) => (await tx.query<Job>(
    `select id::text as id, tenant_id, kind, idempotency_key, payload, attempts, max_attempts, run_at
       from social.claim_jobs($1, $2, $3)`, [workerId, limit, leaseSeconds])).rows);
}

export async function complete(db: Db, jobId: string, workerId: string): Promise<boolean> {
  return db.transaction(async (tx) =>
    (await tx.query<{ ok: boolean }>('select social.complete_job($1::bigint, $2) as ok', [jobId, workerId])).rows[0]!.ok);
}

/** retryAt null = give up. Returns 'queued' | 'dead', or null when this worker no longer holds the lease. */
export async function fail(db: Db, jobId: string, workerId: string, error: object, retryAt: Date | null): Promise<string | null> {
  return db.transaction(async (tx) => (await tx.query<{ status: string | null }>(
    'select social.fail_job($1::bigint, $2, $3, $4) as status', [jobId, workerId, JSON.stringify(error), retryAt])).rows[0]!.status);
}

export async function enqueueDuePublishes(db: Db, graceHours = 6, limit = 100): Promise<number> {
  return db.transaction(async (tx) => (await tx.query<{ n: number }>(
    `select social.enqueue_due_publishes(make_interval(hours => $1), $2) as n`, [graceHours, limit])).rows[0]!.n);
}
