// The worker loop: scheduler tick -> claim -> run handler in a span -> complete / retry with backoff / dead.
// Stateless: run as many replicas as needed; SKIP LOCKED + leases keep them apart.
import { backoffMs, claim, complete, enqueueDuePublishes, fail, type Job } from '../queue/queue.ts';
import { deleteTarget, firstComment, publishTarget } from './publish.ts';
import type { Handler, Outcome, WorkerDeps } from './types.ts';

export const DEFAULT_HANDLERS: Record<string, Handler> = {
  publish_target: publishTarget,
  first_comment: firstComment,
  delete_target: deleteTarget,
};

export interface WorkerOptions {
  handlers?: Record<string, Handler>;
  batchSize?: number;
  leaseSeconds?: number;
  graceHours?: number;
  pollMs?: number;
}

export interface TickResult {
  enqueued: number;
  ran: { jobId: string; kind: string; outcome: Outcome['status'] | 'lost_lease' }[];
}

export function createWorker(d: WorkerDeps, opts: WorkerOptions = {}) {
  const handlers = opts.handlers ?? DEFAULT_HANDLERS;

  async function runJob(job: Job): Promise<TickResult['ran'][number]> {
    const handler = handlers[job.kind];
    const outcome: Outcome = await d.tracer.span(`social.job ${job.kind}`,
      { job_id: job.id, kind: job.kind, tenant: job.tenant_id, attempt: job.attempts },
      async (span) => {
        if (!handler) return { status: 'dead', error: { reason: `no handler for ${job.kind}` } };
        try {
          const o = await handler(job, d);
          span.setAttribute('outcome', o.status);
          return o;
        } catch (e) {
          // A bug or an infrastructure error (DB down): retry with backoff, never lose the job.
          span.recordException(e);
          span.setStatus({ code: 'error', message: (e as Error).message });
          return { status: 'retry', error: { reason: 'handler threw', message: (e as Error).message } };
        }
      });
    let lost = false;
    if (outcome.status === 'done') {
      lost = !(await complete(d.db, job.id, d.workerId));
    } else {
      const retryAt = outcome.status === 'retry'
        ? new Date(d.now().getTime() + backoffMs(job.attempts, {
            ...(outcome.retryAfterMs !== undefined ? { retryAfterMs: outcome.retryAfterMs } : {}),
            ...(d.random ? { random: d.random } : {}),
          }))
        : null;
      lost = (await fail(d.db, job.id, d.workerId, outcome.error, retryAt)) === null;
    }
    return { jobId: job.id, kind: job.kind, outcome: lost ? 'lost_lease' : outcome.status };
  }

  async function tick(): Promise<TickResult> {
    const enqueued = await enqueueDuePublishes(d.db, opts.graceHours ?? 6);
    const jobs = await claim(d.db, d.workerId, opts.batchSize ?? 10, opts.leaseSeconds ?? 300);
    const ran = [];
    for (const job of jobs) ran.push(await runJob(job)); // sequential per replica; scale with replicas
    return { enqueued, ran };
  }

  async function run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const r = await tick().catch((e) => { console.error(`[postgate-worker] tick failed: ${(e as Error).message}`); return null; });
      if (!r || r.ran.length === 0) await d.sleep(opts.pollMs ?? 30_000);
    }
  }

  return { tick, run, runJob };
}
