// Human approval gate. What is approved is the CONTENT (hash over post + every target's override/settings),
// not the time: rescheduling keeps the approval, any content edit needs a new one. The database enforces the
// same rule with triggers (db/migrations/0003_approval_gate.sql); this module is the API and a second check.
import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from '../db/db.ts';

export type ApprovalVia = 'console' | 'chat' | 'email' | 'api';
const APPROVER_ROLES = ['owner', 'admin', 'approver'];

export class ApprovalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
  }
}

export interface HashInput {
  title: string | null;
  body: string;
  mediaIds: string[];
  linkUrl: string | null;
  targets: { channelId: string; bodyOverride: string | null; settings: unknown }[];
}

/** Canonical JSON: object keys sorted at every level, so equal content always hashes equal. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export function contentHash(c: HashInput): string {
  const doc = {
    v: 1, title: c.title ?? null, body: c.body, linkUrl: c.linkUrl ?? null,
    mediaIds: [...c.mediaIds].sort(),
    targets: [...c.targets].sort((a, b) => a.channelId.localeCompare(b.channelId))
      .map((t) => ({ channelId: t.channelId, bodyOverride: t.bodyOverride ?? null, settings: t.settings ?? {} })),
  };
  return createHash('sha256').update(canonicalJson(doc)).digest('hex');
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function computePostHash(tx: Queryable, postId: string): Promise<string> {
  const post = (await tx.query<{ title: string | null; body: string; media_ids: string[]; link_url: string | null }>(
    'select title, body, media_ids, link_url from social.posts where id = $1', [postId])).rows[0];
  if (!post) throw new ApprovalError('not_found', `post ${postId} not found`);
  const targets = (await tx.query<{ channel_id: string; body_override: string | null; settings: unknown }>(
    'select channel_id, body_override, settings from social.post_targets where post_id = $1', [postId])).rows;
  return contentHash({
    title: post.title, body: post.body, mediaIds: post.media_ids ?? [], linkUrl: post.link_url,
    targets: targets.map((t) => ({ channelId: t.channel_id, bodyOverride: t.body_override, settings: t.settings })),
  });
}

/** Recompute and store the post's hash; the DB supersedes approvals for any older hash. */
export async function rehashPost(tx: Queryable, postId: string): Promise<string> {
  const hash = await computePostHash(tx, postId);
  await tx.query('update social.posts set content_hash = $2 where id = $1', [postId, hash]);
  return hash;
}

async function audit(tx: Queryable, tenantId: string, actor: string, action: string, subjectId: string, detail: object) {
  await tx.query(
    `insert into social.audit_log (tenant_id, actor, action, subject_type, subject_id, detail) values ($1, $2, $3, 'post', $4, $5)`,
    [tenantId, actor, action, subjectId, JSON.stringify(detail)]);
}

async function event(tx: Queryable, tenantId: string, type: string, aggregateId: string, payload: object) {
  await tx.query(
    `insert into social.events (tenant_id, aggregate_type, aggregate_id, type, payload) values ($1, 'post', $2, $3, $4)`,
    [tenantId, aggregateId, type, JSON.stringify(payload)]);
}

export interface RequestInput {
  tenantId: string;
  postId: string;
  requestedBy: string;
  via?: ApprovalVia[];
  ttlHours?: number;
  now?: Date;
}

/**
 * Opens an approval request for the post's current content. Returns the one-time link token ONCE; only its
 * SHA-256 is stored, so the caller must hand it to the notifier (chat or e-mail link) right away.
 */
export async function requestApproval(tx: Queryable, input: RequestInput): Promise<{ approvalId: string; token: string; contentHash: string }> {
  const now = input.now ?? new Date();
  const via = input.via ?? ['console'];
  const hash = await rehashPost(tx, input.postId);
  await tx.query(`update social.approvals set status = 'superseded' where post_id = $1 and status = 'pending'`, [input.postId]);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + (input.ttlHours ?? 48) * 3_600_000);
  const { rows } = await tx.query<{ id: string }>(
    `insert into social.approvals (tenant_id, post_id, content_hash, requested_by, requested_via, requested_at, expires_at, token_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [input.tenantId, input.postId, hash, input.requestedBy, via, now, expiresAt, sha256(token)]);
  const approvalId = rows[0]!.id;
  await tx.query(`update social.posts set status = 'in_review' where id = $1 and status in ('draft', 'in_review', 'approved', 'scheduled')`, [input.postId]);
  await event(tx, input.tenantId, 'approval.requested', input.postId, { approvalId, via, expiresAt: expiresAt.toISOString() });
  await audit(tx, input.tenantId, input.requestedBy, 'approval.requested', input.postId, { approvalId, via, contentHash: hash });
  return { approvalId, token, contentHash: hash };
}

export interface DecideInput {
  tenantId: string;
  decision: 'approved' | 'rejected';
  actor: string;              // member user_ref
  via: ApprovalVia;
  approvalId?: string;        // console/API: an authenticated member
  token?: string;             // link: possession of the one-time token
  note?: string;
  now?: Date;
}

export async function decideApproval(tx: Queryable, input: DecideInput): Promise<{ approvalId: string; postStatus: string }> {
  const now = input.now ?? new Date();
  if (!input.approvalId && !input.token) throw new ApprovalError('bad_request', 'approvalId or token required');
  const where = input.token ? 'a.token_hash = $1' : 'a.id = $1';
  const a = (await tx.query<{ id: string; post_id: string; content_hash: string; status: string; expires_at: Date;
    created_by: string; post_hash: string | null; scheduled_at: Date | null; settings: Record<string, unknown> }>(
    `select a.id, a.post_id, a.content_hash, a.status, a.expires_at, p.created_by, p.content_hash as post_hash,
            p.scheduled_at, t.settings
       from social.approvals a join social.posts p on p.id = a.post_id join social.tenants t on t.id = a.tenant_id
      where ${where} for update of a`,
    [input.token ? sha256(input.token) : input.approvalId])).rows[0];
  if (!a) throw new ApprovalError('not_found', 'approval request not found');
  if (a.status !== 'pending') throw new ApprovalError('not_pending', `approval is ${a.status}`);
  // Throwing rolls the caller's transaction back, so no status is written here: expireApprovals() sweeps
  // expired requests, and the posts trigger supersedes stale ones when the hash is recomputed.
  if (new Date(a.expires_at) <= now) throw new ApprovalError('expired', 'approval request expired; request a new one');
  const current = await computePostHash(tx, a.post_id);
  if (a.post_hash !== a.content_hash || current !== a.content_hash) {
    throw new ApprovalError('stale', 'content changed after the request; request approval again');
  }
  const role = (await tx.query<{ role: string }>(
    'select role from social.members where user_ref = $1', [input.actor])).rows[0]?.role;
  if (!role || !APPROVER_ROLES.includes(role)) throw new ApprovalError('forbidden', `${input.actor} may not approve posts`);
  if (input.decision === 'approved' && a.settings?.approver_must_differ === true && a.created_by === input.actor) {
    throw new ApprovalError('forbidden', 'this tenant requires the approver to differ from the author');
  }
  await tx.query(
    `update social.approvals set status = $2, decided_by = $3, decided_via = $4, decided_at = $5, note = $6, token_hash = null
      where id = $1`,
    [a.id, input.decision, input.actor, input.via, now, input.note ?? null]);
  const postStatus = input.decision === 'rejected' ? 'draft' : a.scheduled_at ? 'scheduled' : 'approved';
  await tx.query('update social.posts set status = $2 where id = $1', [a.post_id, postStatus]);
  await event(tx, input.tenantId, `approval.${input.decision}`, a.post_id, { approvalId: a.id, via: input.via });
  await audit(tx, input.tenantId, input.actor, `approval.${input.decision}`, a.post_id, { approvalId: a.id, via: input.via, note: input.note });
  return { approvalId: a.id, postStatus };
}

/** Sweep for the current tenant: pending requests past their expiry become `expired`. */
export async function expireApprovals(tx: Queryable, now = new Date()): Promise<number> {
  return (await tx.query(`update social.approvals set status = 'expired', token_hash = null
    where status = 'pending' and expires_at <= $1 returning id`, [now])).rows.length;
}

/** Second, in-code check used by the worker right before publishing. */
export async function checkGate(tx: Queryable, postId: string): Promise<{ ok: true; approvalId: string } | { ok: false; reason: string }> {
  const current = await computePostHash(tx, postId);
  const row = (await tx.query<{ id: string; content_hash: string; post_hash: string | null }>(
    `select a.id, a.content_hash, p.content_hash as post_hash from social.approvals a join social.posts p on p.id = a.post_id
      where a.post_id = $1 and a.status = 'approved' order by a.decided_at desc nulls last limit 1`, [postId])).rows[0];
  if (!row) return { ok: false, reason: 'no approval' };
  if (row.content_hash !== current || row.post_hash !== current) return { ok: false, reason: 'content changed since approval' };
  return { ok: true, approvalId: row.id };
}

/** Schedule an approved post (the DB rejects scheduling unapproved content). */
export async function schedulePost(tx: Queryable, postId: string, at: Date): Promise<void> {
  await tx.query(`update social.posts set scheduled_at = $2, status = 'scheduled' where id = $1`, [postId, at]);
}
