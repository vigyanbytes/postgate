// The common post model, as callers see it: one post (text, media refs, link, proposed time) with one
// target per channel, each optionally carrying its own text (per-channel variant) and settings.
// Drafts may be incomplete; validation issues are returned, not thrown, until approval is requested.
// Lifecycle (DB-enforced in 0003): draft -> in_review -> approved/scheduled -> publishing -> published |
// partially_failed | failed (retries with backoff happen per target in the worker), or cancelled.
import type { Queryable } from '../db/db.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { Issue, MediaItem, PublishRequest } from '../providers/types.ts';
import { DEFAULT_TIMEZONE, formatInZone } from './time.ts';

export class DraftError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DraftError';
    this.code = code;
  }
}

export interface DraftTargetInput {
  channelId: string;
  /** Per-channel variant of the text; null/undefined = use the post body. */
  bodyOverride?: string | null;
  settings?: Record<string, unknown>;
}

export interface DraftInput {
  tenantId: string;
  createdBy: string;
  title?: string | null;
  body: string;
  linkUrl?: string | null;
  mediaIds?: string[];
  /** Proposed publish time. Stored with the draft; it only takes effect once the content is approved. */
  scheduledAt?: Date | null;
  /** Caller's id for the source (rss:<guid>, pack:<name>:<key>): makes creation idempotent. */
  sourceRef?: string | null;
  /** IANA zone the time was entered in (default UTC); scheduledAt itself is an instant. */
  timezone?: string;
  targets: DraftTargetInput[];
}

export interface TargetIssues {
  channelId: string;
  provider: string;
  issues: Issue[];
}

interface ChannelRow { id: string; provider: string; kind: string; status: string; display_name: string }

async function mediaItems(tx: Queryable, ids: string[]): Promise<MediaItem[]> {
  if (!ids.length) return [];
  const rows = (await tx.query<{ id: string; kind: MediaItem['kind']; mime: string; size_bytes: string; alt_text: string | null; title: string | null }>(
    'select id, kind, mime, size_bytes, alt_text, title from social.media_assets where id = any($1::uuid[])', [ids])).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw new DraftError('unknown_media', `media not found in this tenant: ${missing.join(', ')}`);
  return ids.map((id) => {
    const m = byId.get(id)!;
    return { id, kind: m.kind, mime: m.mime, sizeBytes: Number(m.size_bytes), ...(m.alt_text ? { altText: m.alt_text } : {}), ...(m.title ? { title: m.title } : {}) };
  });
}

function validateTargets(
  registry: ProviderRegistry, channels: Map<string, ChannelRow>, media: MediaItem[],
  post: { title?: string | null; body: string; linkUrl?: string | null },
  targets: { channelId: string; bodyOverride?: string | null; settings?: Record<string, unknown> }[],
): TargetIssues[] {
  return targets.map((t) => {
    const ch = channels.get(t.channelId)!;
    const req: PublishRequest = {
      idempotencyKey: 'validate', text: t.bodyOverride ?? post.body, media, settings: t.settings ?? {},
      ...(post.title ? { title: post.title } : {}), ...(post.linkUrl ? { linkUrl: post.linkUrl } : {}),
    };
    const issues = registry.has(ch.provider)
      ? registry.get(ch.provider).validate(req)
      : [{ field: 'channel', code: 'unknown_provider', message: `no provider plugin for ${ch.provider}` }];
    return { channelId: t.channelId, provider: ch.provider, issues };
  });
}

async function loadChannels(tx: Queryable, ids: string[]): Promise<Map<string, ChannelRow>> {
  const rows = (await tx.query<ChannelRow>(
    'select id, provider, kind, status, display_name from social.channels where id = any($1::uuid[])', [ids])).rows;
  return new Map(rows.map((r) => [r.id, r]));
}

/** Must run in a tenant-scoped transaction (withTenant). */
export async function createDraft(
  tx: Queryable, input: DraftInput, registry: ProviderRegistry,
): Promise<{ postId: string; created: boolean; issues: TargetIssues[] }> {
  if (!input.targets.length) throw new DraftError('no_targets', 'a draft needs at least one channel');
  const ids = input.targets.map((t) => t.channelId);
  if (new Set(ids).size !== ids.length) throw new DraftError('duplicate_target', 'each channel may appear once per post');
  if (input.sourceRef) {
    const existing = (await tx.query<{ id: string }>('select id from social.posts where source_ref = $1', [input.sourceRef])).rows[0];
    if (existing) return { postId: existing.id, created: false, issues: await validatePost(tx, existing.id, registry) };
  }
  const channels = await loadChannels(tx, ids);
  const unknown = ids.filter((id) => !channels.has(id));
  if (unknown.length) throw new DraftError('unknown_channel', `channel not found in this tenant: ${unknown.join(', ')}`);
  const media = await mediaItems(tx, input.mediaIds ?? []);
  const issues = validateTargets(registry, channels, media, input, input.targets);

  const postId = (await tx.query<{ id: string }>(
    `insert into social.posts (tenant_id, title, body, media_ids, link_url, scheduled_at, created_by, source_ref, timezone)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [input.tenantId, input.title ?? null, input.body, input.mediaIds ?? [], input.linkUrl ?? null, input.scheduledAt ?? null,
     input.createdBy, input.sourceRef ?? null, input.timezone ?? DEFAULT_TIMEZONE])).rows[0]!.id;
  for (const t of input.targets) {
    await tx.query(
      'insert into social.post_targets (tenant_id, post_id, channel_id, body_override, settings) values ($1, $2, $3, $4, $5)',
      [input.tenantId, postId, t.channelId, t.bodyOverride ?? null, JSON.stringify(t.settings ?? {})]);
  }
  const detail = { targets: issues.map((i) => i.provider), issues: issues.reduce((n, i) => n + i.issues.length, 0), sourceRef: input.sourceRef ?? null };
  await tx.query(
    `insert into social.events (tenant_id, aggregate_type, aggregate_id, type, payload) values ($1, 'post', $2, 'post.drafted', $3)`,
    [input.tenantId, postId, JSON.stringify(detail)]);
  await tx.query(
    `insert into social.audit_log (tenant_id, actor, action, subject_type, subject_id, detail) values ($1, $2, 'post.drafted', 'post', $3, $4)`,
    [input.tenantId, input.createdBy, postId, JSON.stringify(detail)]);
  return { postId, created: true, issues };
}

/** Current validation issues of a stored post, per target (empty lists = ready for approval). */
export async function validatePost(tx: Queryable, postId: string, registry: ProviderRegistry): Promise<TargetIssues[]> {
  const p = (await tx.query<{ title: string | null; body: string; link_url: string | null; media_ids: string[] }>(
    'select title, body, link_url, media_ids from social.posts where id = $1', [postId])).rows[0];
  if (!p) throw new DraftError('not_found', `post ${postId} not found`);
  const targets = (await tx.query<{ channel_id: string; body_override: string | null; settings: Record<string, unknown> }>(
    'select channel_id, body_override, settings from social.post_targets where post_id = $1 order by channel_id', [postId])).rows;
  const channels = await loadChannels(tx, targets.map((t) => t.channel_id));
  const media = await mediaItems(tx, p.media_ids ?? []);
  return validateTargets(registry, channels, media, { title: p.title, body: p.body, linkUrl: p.link_url },
    targets.map((t) => ({ channelId: t.channel_id, bodyOverride: t.body_override, settings: t.settings ?? {} })));
}

export interface PostView {
  id: string; status: string; title: string | null; body: string; linkUrl: string | null; mediaIds: string[];
  scheduledAt: string | null; scheduledLocal: string | null; timezone: string; sourceRef: string | null; createdBy: string;
  createdAt: string; updatedAt: string;
  approval: { id: string; status: string; requestedAt: string; decidedAt: string | null } | null;
  targets: { id: string; channelId: string; provider: string; status: string; bodyOverride: string | null;
             settings: Record<string, unknown>; externalUrl: string | null; publishedAt: string | null; deletedAt: string | null; lastError: unknown }[];
}

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

export async function getPost(tx: Queryable, postId: string): Promise<PostView | null> {
  const p = (await tx.query<any>(
    `select id, status, title, body, link_url, media_ids, scheduled_at, timezone, source_ref, created_by, created_at, updated_at
       from social.posts where id = $1`,
    [postId])).rows[0];
  if (!p) return null;
  const a = (await tx.query<any>(
    `select id, status, requested_at, decided_at from social.approvals where post_id = $1 order by requested_at desc limit 1`, [postId])).rows[0];
  const targets = (await tx.query<any>(
    `select t.id, t.channel_id, c.provider, t.status, t.body_override, t.settings, t.external_url, t.published_at, t.deleted_at, t.last_error
       from social.post_targets t join social.channels c on c.id = t.channel_id where t.post_id = $1 order by c.provider`, [postId])).rows;
  return {
    id: p.id, status: p.status, title: p.title, body: p.body, linkUrl: p.link_url, mediaIds: p.media_ids ?? [],
    scheduledAt: iso(p.scheduled_at), scheduledLocal: p.scheduled_at ? formatInZone(new Date(p.scheduled_at), p.timezone) : null,
    timezone: p.timezone, sourceRef: p.source_ref, createdBy: p.created_by, createdAt: iso(p.created_at)!, updatedAt: iso(p.updated_at)!,
    approval: a ? { id: a.id, status: a.status, requestedAt: iso(a.requested_at)!, decidedAt: iso(a.decided_at) } : null,
    targets: targets.map((t) => ({ id: t.id, channelId: t.channel_id, provider: t.provider, status: t.status, bodyOverride: t.body_override,
      settings: t.settings ?? {}, externalUrl: t.external_url, publishedAt: iso(t.published_at), deletedAt: iso(t.deleted_at), lastError: t.last_error })),
  };
}

export const POST_STATUSES = ['draft', 'in_review', 'approved', 'scheduled', 'publishing', 'published', 'partially_failed', 'failed', 'cancelled'];

export interface ListOptions {
  statuses?: string[];
  /** Calendar range on scheduled_at: from inclusive, to exclusive. Posts without a time are left out when set. */
  from?: Date;
  to?: Date;
  limit?: number;
}

export async function listPosts(tx: Queryable, opts: ListOptions = {}) {
  const statuses = opts.statuses?.length ? opts.statuses : POST_STATUSES;
  const bad = statuses.filter((s) => !POST_STATUSES.includes(s));
  if (bad.length) throw new DraftError('bad_request', `unknown status: ${bad.join(', ')}`);
  const ranged = Boolean(opts.from || opts.to);
  const rows = (await tx.query<any>(
    `select p.id, p.status, p.title, left(p.body, 280) as excerpt, p.scheduled_at, p.timezone, p.source_ref, p.created_at, p.updated_at,
            coalesce((select json_agg(json_build_object('id', t.id, 'channelId', t.channel_id, 'provider', c.provider, 'status', t.status,
                       'externalUrl', t.external_url) order by c.provider)
                        from social.post_targets t join social.channels c on c.id = t.channel_id where t.post_id = p.id), '[]'::json) as targets
       from social.posts p
      where p.status = any($1::text[])
        and ($3::boolean is false or (p.scheduled_at is not null
             and ($4::timestamptz is null or p.scheduled_at >= $4) and ($5::timestamptz is null or p.scheduled_at < $5)))
      order by ${ranged ? 'p.scheduled_at asc' : 'p.created_at desc'} limit $2`,
    [statuses, Math.min(500, Math.max(1, opts.limit ?? (ranged ? 500 : 50))), ranged, opts.from ?? null, opts.to ?? null])).rows;
  return rows.map((r) => ({
    id: r.id, status: r.status, title: r.title, excerpt: r.excerpt, scheduledAt: iso(r.scheduled_at),
    scheduledLocal: r.scheduled_at ? formatInZone(new Date(r.scheduled_at), r.timezone) : null, timezone: r.timezone,
    sourceRef: r.source_ref, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
    providers: (r.targets as { provider: string }[]).map((t) => t.provider), targets: r.targets,
  }));
}
