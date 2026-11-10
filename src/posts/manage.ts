// Post lifecycle operations for the console: edit, (re)schedule, cancel, retry, delete.
// All run in a tenant-scoped transaction; the database gate (0003) still has the last word.
import type { Queryable } from '../db/db.ts';
import { enqueue } from '../queue/queue.ts';
import { DraftError, type DraftTargetInput } from './drafts.ts';
import { DEFAULT_TIMEZONE, formatInZone, isTimeZone } from './time.ts';

const EDITABLE = ['draft', 'in_review', 'approved', 'scheduled'];
const LOCKED_TARGETS = ['queued', 'publishing', 'published'];

async function audit(tx: Queryable, tenantId: string, actor: string, action: string, postId: string, detail: object) {
  await tx.query(
    `insert into social.audit_log (tenant_id, actor, action, subject_type, subject_id, detail) values ($1, $2, $3, 'post', $4, $5)`,
    [tenantId, actor, action, postId, JSON.stringify(detail)]);
  await tx.query(
    `insert into social.events (tenant_id, aggregate_type, aggregate_id, type, payload) values ($1, 'post', $2, $3, $4)`,
    [tenantId, postId, action, JSON.stringify(detail)]);
}

async function lockPost(tx: Queryable, postId: string) {
  const p = (await tx.query<{ id: string; status: string; scheduled_at: Date | null; timezone: string }>(
    'select id, status, scheduled_at, timezone from social.posts where id = $1 for update', [postId])).rows[0];
  if (!p) throw new DraftError('not_found', `post ${postId} not found`);
  return p;
}

export interface EditInput {
  title?: string | null;
  body?: string;
  linkUrl?: string | null;
  mediaIds?: string[];
  /** When given, the full target set: missing channels are removed, new ones added. */
  targets?: DraftTargetInput[];
}

/** Any content edit returns the post to `draft` and voids its approval (the content hash is cleared). */
export async function editPost(tx: Queryable, ids: { tenantId: string; postId: string; actor: string }, e: EditInput): Promise<{ status: string }> {
  const p = await lockPost(tx, ids.postId);
  if (!EDITABLE.includes(p.status)) throw new DraftError('not_editable', `post is ${p.status}; it can no longer be edited`);
  const locked = (await tx.query<{ n: number }>(
    'select count(*)::int as n from social.post_targets where post_id = $1 and status = any($2::text[])', [ids.postId, LOCKED_TARGETS])).rows[0]!.n;
  if (locked) throw new DraftError('not_editable', 'a target is already queued or published; cancel or wait');
  if (e.mediaIds?.length) {
    const found = (await tx.query<{ n: number }>('select count(*)::int as n from social.media_assets where id = any($1::uuid[])', [e.mediaIds])).rows[0]!.n;
    if (found !== new Set(e.mediaIds).size) throw new DraftError('unknown_media', 'media not found in this tenant');
  }
  const sets: string[] = [];
  const vals: unknown[] = [ids.postId];
  const put = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (e.title !== undefined) put('title', e.title);
  if (e.body !== undefined) put('body', e.body);
  if (e.linkUrl !== undefined) put('link_url', e.linkUrl);
  if (e.mediaIds !== undefined) put('media_ids', e.mediaIds);
  // Clearing the hash supersedes approvals (trigger); the post goes back to draft for a fresh review.
  // Targets get fresh idempotency keys below: edited content is a new publish, not a retry of an old job.
  await tx.query(`update social.posts set ${[...sets, 'content_hash = null', `status = 'draft'`].join(', ')} where id = $1`, vals);
  await tx.query(`update social.approvals set status = 'superseded', token_hash = null where post_id = $1 and status = 'pending'`, [ids.postId]);
  if (e.targets) {
    const want = new Map(e.targets.map((t) => [t.channelId, t]));
    if (want.size !== e.targets.length) throw new DraftError('duplicate_target', 'each channel may appear once per post');
    if (!want.size) throw new DraftError('no_targets', 'a post needs at least one channel');
    const channels = (await tx.query<{ id: string }>('select id from social.channels where id = any($1::uuid[])', [[...want.keys()]])).rows;
    if (channels.length !== want.size) throw new DraftError('unknown_channel', 'channel not found in this tenant');
    const have = (await tx.query<{ channel_id: string }>('select channel_id from social.post_targets where post_id = $1', [ids.postId])).rows;
    for (const h of have) {
      if (!want.has(h.channel_id)) await tx.query('delete from social.post_targets where post_id = $1 and channel_id = $2', [ids.postId, h.channel_id]);
    }
    for (const t of want.values()) {
      await tx.query(
        `insert into social.post_targets (tenant_id, post_id, channel_id, body_override, settings) values ($1, $2, $3, $4, $5)
         on conflict (post_id, channel_id) do update set body_override = excluded.body_override, settings = excluded.settings,
           status = 'pending', last_error = null, idempotency_key = gen_random_uuid()::text`,
        [ids.tenantId, ids.postId, t.channelId, t.bodyOverride ?? null, JSON.stringify(t.settings ?? {})]);
    }
  }
  await audit(tx, ids.tenantId, ids.actor, 'post.edited', ids.postId,
    { fields: Object.keys(e).filter((k) => (e as Record<string, unknown>)[k] !== undefined), previousStatus: p.status });
  return { status: 'draft' };
}

/**
 * Sets the publish time. Draft / in_review: only the proposed time (it takes effect on approval).
 * Approved / scheduled: the post is (re)scheduled. The approval is for the content, so moving the time keeps it.
 */
export async function setSchedule(
  tx: Queryable, ids: { tenantId: string; postId: string; actor: string }, at: Date, timezone = DEFAULT_TIMEZONE, now = new Date(),
): Promise<{ status: string; scheduledAt: string; scheduledLocal: string; timezone: string }> {
  if (!isTimeZone(timezone)) throw new DraftError('bad_request', `unknown time zone ${timezone}`);
  if (at.getTime() < now.getTime() - 60_000) throw new DraftError('in_past', 'schedule time is in the past');
  const p = await lockPost(tx, ids.postId);
  if (!EDITABLE.includes(p.status)) throw new DraftError('not_editable', `post is ${p.status}; it cannot be rescheduled`);
  const status = p.status === 'approved' || p.status === 'scheduled' ? 'scheduled' : p.status;
  // Targets that a previous tick parked for a missed window may be published again at the new time.
  await tx.query(`update social.post_targets set status = 'pending', last_error = null
    where post_id = $1 and status = 'needs_attention' and last_error->>'kind' = 'missed_window'`, [ids.postId]);
  await tx.query('update social.posts set scheduled_at = $2, timezone = $3, status = $4 where id = $1', [ids.postId, at, timezone, status]);
  await audit(tx, ids.tenantId, ids.actor, p.scheduled_at ? 'post.rescheduled' : 'post.scheduled', ids.postId,
    { at: at.toISOString(), timezone, status, previous: p.scheduled_at ? new Date(p.scheduled_at).toISOString() : null });
  return { status, scheduledAt: at.toISOString(), scheduledLocal: formatInZone(at, timezone), timezone };
}

/** Removes the time; an approved post stays approved (not scheduled). */
export async function unschedule(tx: Queryable, ids: { tenantId: string; postId: string; actor: string }): Promise<{ status: string }> {
  const p = await lockPost(tx, ids.postId);
  if (!EDITABLE.includes(p.status)) throw new DraftError('not_editable', `post is ${p.status}`);
  const status = p.status === 'scheduled' ? 'approved' : p.status;
  await tx.query('update social.posts set scheduled_at = null, status = $2 where id = $1', [ids.postId, status]);
  await audit(tx, ids.tenantId, ids.actor, 'post.unscheduled', ids.postId, { status });
  return { status };
}

/** Stops everything not yet published. Published targets stay as they are (deleting live posts is separate). */
export async function cancelPost(tx: Queryable, ids: { tenantId: string; postId: string; actor: string }): Promise<{ status: string; cancelledTargets: number }> {
  const p = await lockPost(tx, ids.postId);
  if (['published', 'cancelled'].includes(p.status)) throw new DraftError('not_editable', `post is already ${p.status}`);
  const busy = (await tx.query<{ n: number }>(`select count(*)::int as n from social.post_targets where post_id = $1 and status = 'publishing'`, [ids.postId])).rows[0]!.n;
  if (busy) throw new DraftError('busy', 'a target is being published right now; try again in a minute');
  const n = (await tx.query(`update social.post_targets set status = 'cancelled' where post_id = $1 and status not in ('published', 'cancelled') returning id`,
    [ids.postId])).rows.length;
  const anyPublished = (await tx.query<{ n: number }>(`select count(*)::int as n from social.post_targets where post_id = $1 and status = 'published'`, [ids.postId])).rows[0]!.n;
  const status = anyPublished ? 'partially_failed' : 'cancelled';
  await tx.query('update social.posts set status = $2 where id = $1', [ids.postId, status]);
  await tx.query(`update social.approvals set status = 'superseded', token_hash = null where post_id = $1 and status = 'pending'`, [ids.postId]);
  await audit(tx, ids.tenantId, ids.actor, 'post.cancelled', ids.postId, { cancelledTargets: n });
  return { status, cancelledTargets: n };
}

/**
 * A human retries failed / needs_attention targets now. For an unknown outcome this is the human saying "it did
 * not post, try again" — recorded in the audit log. Still gated: the DB refuses `queued` without a valid approval.
 */
export async function retryPost(tx: Queryable, ids: { tenantId: string; postId: string; actor: string }): Promise<{ retried: number }> {
  const p = await lockPost(tx, ids.postId);
  if (p.status === 'cancelled') throw new DraftError('not_editable', 'post is cancelled');
  const targets = (await tx.query<{ id: string; idempotency_key: string; attempts: number; status: string; last_error: any }>(
    `select t.id, t.idempotency_key, t.attempts, t.status, t.last_error from social.post_targets t join social.channels c on c.id = t.channel_id
      where t.post_id = $1 and t.status in ('failed', 'needs_attention') and c.status = 'active'`, [ids.postId])).rows;
  if (!targets.length) throw new DraftError('nothing_to_retry', 'no failed target on an active channel');
  for (const t of targets) {
    await tx.query(`update social.post_targets set status = 'queued', last_error = null where id = $1`, [t.id]);
    await enqueue(tx, { tenantId: ids.tenantId, kind: 'publish_target', key: `${t.idempotency_key}:retry:${t.attempts}:${Date.now()}`,
      payload: { post_target_id: t.id } });
  }
  await tx.query(`update social.posts set status = 'publishing' where id = $1`, [ids.postId]);
  await audit(tx, ids.tenantId, ids.actor, 'post.retried', ids.postId,
    { targets: targets.map((t) => ({ id: t.id, from: t.status, reason: t.last_error?.reason ?? t.last_error?.kind ?? null })) });
  return { retried: targets.length };
}

/**
 * A human asks for the live copies of a post to be removed from the platforms (e.g. after a test post). Each
 * published target gets a delete_target job; the worker calls the platform's delete. Not every platform allows it
 * (Instagram media cannot be deleted through the API): those targets record the failure and need a manual delete.
 */
export async function unpublishPost(tx: Queryable, ids: { tenantId: string; postId: string; actor: string }): Promise<{ queued: number }> {
  await lockPost(tx, ids.postId);
  const targets = (await tx.query<{ id: string; idempotency_key: string }>(
    `select id, idempotency_key from social.post_targets where post_id = $1 and status = 'published' and deleted_at is null`, [ids.postId])).rows;
  if (!targets.length) throw new DraftError('nothing_to_retry', 'no published target to remove');
  for (const t of targets) {
    await enqueue(tx, { tenantId: ids.tenantId, kind: 'delete_target', key: `${t.idempotency_key}:delete`, payload: { post_target_id: t.id }, maxAttempts: 3 });
  }
  await audit(tx, ids.tenantId, ids.actor, 'post.unpublish_requested', ids.postId, { targets: targets.map((t) => t.id) });
  return { queued: targets.length };
}

/** Only drafts are deleted; anything that was ever reviewed keeps its record (cancel instead). */
export async function deleteDraft(tx: Queryable, ids: { tenantId: string; postId: string; actor: string }): Promise<void> {
  const p = await lockPost(tx, ids.postId);
  if (p.status !== 'draft') throw new DraftError('not_editable', `only drafts can be deleted; this post is ${p.status} (cancel it)`);
  await audit(tx, ids.tenantId, ids.actor, 'post.deleted', ids.postId, {});
  await tx.query('delete from social.posts where id = $1', [ids.postId]);
}

export async function postHistory(tx: Queryable, postId: string, limit = 50) {
  const rows = (await tx.query<{ action: string; at: Date; actor: string; detail: unknown; subject_type: string }>(
    `select a.action, a.at, a.actor, a.detail, a.subject_type from social.audit_log a
      where (a.subject_type = 'post' and a.subject_id = $1)
         or (a.subject_type = 'post_target' and a.subject_id in (select id::text from social.post_targets where post_id = $2))
      order by a.at desc, a.id desc limit $3`, [postId, postId, limit])).rows;
  return rows.map((r) => ({ type: r.action, at: new Date(r.at).toISOString(), actor: r.actor, detail: r.detail }));
}
