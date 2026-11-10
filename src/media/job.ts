// media_job: one generation job, driven by the queue.
//   first run   -> mark running (committed BEFORE the paid call) -> submit -> store the provider's job id -> schedule a poll
//   each poll   -> still running: schedule the next poll | done: download, store as a media asset, attach to the draft
//                  (which voids any approval of that post) | failed: record why
// A submit whose outcome is unknown (timeout, 5xx) is NOT retried: retrying could pay twice. The job fails with a note
// to check the provider's dashboard.
import { createHash } from 'node:crypto';
import { withTenant, type Queryable } from '../db/db.ts';
import { ProviderError } from '../providers/errors.ts';
import { enqueue } from '../queue/queue.ts';
import type { Handler, Outcome, WorkerDeps } from '../worker/types.ts';
import { MEDIA_PROVIDERS } from './heygen.ts';
import { kindOfMime } from './storage.ts';
import type { MediaContext } from './types.ts';

export const MEDIA_POLL_MS = 15_000;
export const MEDIA_MAX_POLLS = 240; // one hour at 15 s
const MAX_DOWNLOAD = 2 * 1024 * 1024 * 1024;

async function note(tx: Queryable, tenantId: string, jobId: string, type: string, detail: object) {
  await tx.query(`insert into social.events (tenant_id, aggregate_type, aggregate_id, type, payload) values ($1, 'media_job', $2, $3, $4)`,
    [tenantId, jobId, type, JSON.stringify(detail)]);
  await tx.query(`insert into social.audit_log (tenant_id, actor, action, subject_type, subject_id, detail) values ($1, 'system:worker', $2, 'media_job', $3, $4)`,
    [tenantId, type, jobId, JSON.stringify(detail)]);
}

async function finish(d: WorkerDeps, tenantId: string, id: string, status: 'failed', error: object): Promise<Outcome> {
  await withTenant(d.db, tenantId, async (tx) => {
    await tx.query(`update social.media_jobs set status = $2, error = $3 where id = $1`, [id, status, JSON.stringify(error)]);
    await note(tx, tenantId, id, 'media_job.failed', error);
  });
  return { status: 'dead', error };
}

const schedulePoll = (tx: Queryable, tenantId: string, id: string, n: number, now: Date, pollMs: number) =>
  enqueue(tx, { tenantId, kind: 'media_job', key: `media_job:${id}:poll:${n}`, payload: { media_job_id: id }, runAt: new Date(now.getTime() + pollMs) });

export const mediaJob: Handler = async (job, d) => {
  const id = String(job.payload.media_job_id ?? '');
  const row = await withTenant(d.db, job.tenant_id, async (tx) => (await tx.query<any>(
    `select id, capability, provider, params, key_env, post_id, status, external_job_id, polls from social.media_jobs where id = $1 for update`, [id])).rows[0]);
  if (!row) return { status: 'dead', error: { reason: 'media job not found' } };
  if (row.status === 'done' || row.status === 'failed') return { status: 'done' };
  const provider = MEDIA_PROVIDERS[row.provider];
  if (!provider) return finish(d, job.tenant_id, id, 'failed', { reason: `unknown media provider ${row.provider}` });
  const apiKey = d.credentials.secrets.get(row.key_env);
  if (!apiKey) return finish(d, job.tenant_id, id, 'failed', { reason: `$${row.key_env} is not set for this worker` });
  const ctx: MediaContext = { apiKey, http: d.http, now: d.now };
  const pollMs = Number(job.payload.poll_ms ?? MEDIA_POLL_MS);

  if (!row.external_job_id) {
    if (row.status === 'running') {
      return finish(d, job.tenant_id, id, 'failed', { reason: 'unknown_outcome', detail: `a previous submit may have created a ${row.provider} job; check the provider dashboard before trying again` });
    }
    await withTenant(d.db, job.tenant_id, (tx) => tx.query(`update social.media_jobs set status = 'running' where id = $1`, [id]));
    try {
      const { externalJobId } = await provider.submit(ctx, { capability: row.capability, params: row.params, idempotencyKey: id });
      await withTenant(d.db, job.tenant_id, async (tx) => {
        await tx.query(`update social.media_jobs set external_job_id = $2 where id = $1`, [id, externalJobId]);
        await note(tx, job.tenant_id, id, 'media_job.submitted', { provider: row.provider, externalJobId });
        await schedulePoll(tx, job.tenant_id, id, 1, d.now(), pollMs);
      });
      return { status: 'done' };
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError(row.provider, 'unknown_outcome', (e as Error).message);
      if (pe.kind === 'retryable') {
        // Nothing was created (rate limit, network before send): back to queued, try again later.
        await withTenant(d.db, job.tenant_id, (tx) => tx.query(`update social.media_jobs set status = 'queued', error = $2 where id = $1`, [id, JSON.stringify(pe.toJSON())]));
        return { status: 'retry', error: pe.toJSON(), ...(pe.retryAfterMs !== undefined ? { retryAfterMs: pe.retryAfterMs } : {}) };
      }
      return finish(d, job.tenant_id, id, 'failed', { ...pe.toJSON(), ...(pe.kind === 'unknown_outcome' ? { detail: 'not retried: it may have been created and billed; check the provider dashboard' } : {}) });
    }
  }

  let st;
  try {
    st = await provider.poll(ctx, row.external_job_id);
  } catch (e) {
    const pe = e instanceof ProviderError ? e : new ProviderError(row.provider, 'retryable', (e as Error).message);
    if (pe.kind === 'fatal') return finish(d, job.tenant_id, id, 'failed', pe.toJSON());
    return { status: 'retry', error: pe.toJSON(), ...(pe.retryAfterMs !== undefined ? { retryAfterMs: pe.retryAfterMs } : {}) };
  }
  if (st.state === 'failed') return finish(d, job.tenant_id, id, 'failed', { reason: st.error });
  if (st.state === 'running') {
    if (row.polls + 1 >= MEDIA_MAX_POLLS) return finish(d, job.tenant_id, id, 'failed', { reason: `still running after ${row.polls + 1} polls` });
    await withTenant(d.db, job.tenant_id, async (tx) => {
      await tx.query('update social.media_jobs set polls = polls + 1 where id = $1', [id]);
      await schedulePoll(tx, job.tenant_id, id, row.polls + 2, d.now(), pollMs);
    });
    return { status: 'done' };
  }

  // done: fetch the output into our storage (provider URLs are short-lived), then record and attach.
  if (!d.download || !d.storage.save) return { status: 'retry', error: { reason: 'this worker has no media storage/download configured' } };
  const { bytes, mime } = await d.download(st.output.fetchUrl, MAX_DOWNLOAD);
  const type = kindOfMime(mime) ? mime : st.output.mime;
  const saved = await d.storage.save(job.tenant_id, bytes, type);
  const usage = st.usage ?? {};
  await withTenant(d.db, job.tenant_id, async (tx) => {
    const asset = (await tx.query<{ id: string }>(
      `insert into social.media_assets (tenant_id, kind, mime, size_bytes, sha256, storage_key, title) values ($1, 'video', $2, $3, $4, $5, $6) returning id`,
      [job.tenant_id, type, bytes.byteLength, saved.sha256, saved.storageKey, String(row.params?.title ?? 'avatar video').slice(0, 300)])).rows[0]!.id;
    let attached: string | null = null;
    if (row.post_id) {
      const p = (await tx.query<{ status: string; locked: number }>(
        `select p.status, (select count(*)::int from social.post_targets t where t.post_id = p.id and t.status in ('queued', 'publishing', 'published')) as locked
           from social.posts p where p.id = $1 for update`, [row.post_id])).rows[0];
      if (p && ['draft', 'in_review'].includes(p.status) && !p.locked) {
        // A content change: the hash is cleared, pending approvals are superseded, the post goes back to draft.
        await tx.query(`update social.posts set media_ids = media_ids || $2::uuid, content_hash = null, status = 'draft' where id = $1`, [row.post_id, asset]);
        await tx.query(`update social.approvals set status = 'superseded', token_hash = null where post_id = $1 and status = 'pending'`, [row.post_id]);
        attached = row.post_id;
      }
    }
    await tx.query(`update social.media_jobs set status = 'done', result_asset_id = $2, usage = $3, error = $4 where id = $1`,
      [id, asset, JSON.stringify(usage), row.post_id && !attached ? JSON.stringify({ note: 'not attached: the post is no longer a draft' }) : null]);
    await note(tx, job.tenant_id, id, 'media_job.done', { assetId: asset, attachedToPost: attached, usage,
      sha256: createHash('sha256').update(bytes).digest('hex') });
  });
  return { status: 'done' };
};
