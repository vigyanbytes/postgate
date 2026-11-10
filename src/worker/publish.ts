// publish_target: publish one post on one channel, exactly once or not at all.
// Order of operations (docs/ARCHITECTURE.md §7):
//   preflight (tenant tx): idempotent exits, approval re-check, mark `publishing` and COMMIT before the call
//   ambiguous previous attempt (`publishing` already): reconcile if the platform allows, else needs_attention
//   call the platform, then record the result (tenant tx) with outbox event + audit row
import { withTenant, type Queryable } from '../db/db.ts';
import { checkGate } from '../approval/gate.ts';
import { loadToken, saveRefreshedToken } from '../credentials/store.ts';
import { ProviderError } from '../providers/errors.ts';
import type { ChannelKind, ChannelProvider, MediaItem, ProviderContext, PublishRequest, PublishResult, TokenSet } from '../providers/types.ts';
import { enqueue, type Job } from '../queue/queue.ts';
import type { Handler, Outcome, WorkerDeps } from './types.ts';

const REFRESH_MARGIN_MS = 5 * 60_000;

interface Loaded {
  targetId: string; postId: string; tenantId: string; idempotencyKey: string; settings: Record<string, unknown>;
  text: string; title: string | null; linkUrl: string | null;
  channel: { id: string; provider: string; kind: ChannelKind; externalId: string; settings: Record<string, unknown> };
  media: (MediaItem & { storageKey: string })[];
  token: TokenSet; tokenSource: 'env' | 'envelope';
  wasPublishing: boolean;
}

type Pre = { exit: Outcome } | { loaded: Loaded };

async function record(tx: Queryable, tenantId: string, targetId: string, type: string, actionDetail: object, traceId?: string) {
  await tx.query(
    `insert into social.events (tenant_id, aggregate_type, aggregate_id, type, payload) values ($1, 'post_target', $2, $3, $4)`,
    [tenantId, targetId, type, JSON.stringify(actionDetail)]);
  await tx.query(
    `insert into social.audit_log (tenant_id, actor, action, subject_type, subject_id, detail, trace_id)
     values ($1, 'system:worker', $2, 'post_target', $3, $4, $5)`,
    [tenantId, type, targetId, JSON.stringify(actionDetail), traceId ?? null]);
}

/** Post status follows its targets. */
async function rollUp(tx: Queryable, postId: string) {
  const s = (await tx.query<{ status: string }>('select status from social.post_targets where post_id = $1', [postId])).rows.map((r) => r.status);
  const live = s.filter((x) => x !== 'cancelled');
  let status: string;
  if (live.length && live.every((x) => x === 'published')) status = 'published';
  else if (live.some((x) => ['pending', 'queued', 'publishing'].includes(x))) status = 'publishing';
  else if (live.some((x) => x === 'published')) status = 'partially_failed';
  else if (live.length) status = 'failed';
  else status = 'cancelled';
  await tx.query('update social.posts set status = $2 where id = $1 and status <> $2', [postId, status]);
}

async function setTarget(tx: Queryable, targetId: string, status: string, error: object | null) {
  await tx.query('update social.post_targets set status = $2, last_error = $3 where id = $1',
    [targetId, status, error === null ? null : JSON.stringify(error)]);
}

async function preflight(job: Job, d: WorkerDeps): Promise<Pre> {
  const targetId = String(job.payload.post_target_id ?? '');
  return withTenant(d.db, job.tenant_id, async (tx) => {
    const t = (await tx.query<any>(
      `select t.id, t.post_id, t.status, t.idempotency_key, t.settings, t.body_override,
              p.status as post_status, p.title, p.body, p.link_url, p.media_ids,
              c.id as channel_id, c.provider, c.kind, c.external_id, c.status as channel_status, c.settings as channel_settings
         from social.post_targets t join social.posts p on p.id = t.post_id join social.channels c on c.id = t.channel_id
        where t.id = $1 for update of t`, [targetId])).rows[0];
    if (!t) return { exit: { status: 'dead', error: { reason: 'post target not found (or other tenant)' } } };
    if (t.status === 'published') return { exit: { status: 'done' } };
    if (t.status === 'cancelled' || t.post_status === 'cancelled') {
      if (t.status !== 'cancelled') await setTarget(tx, t.id, 'cancelled', null);
      return { exit: { status: 'done' } };
    }
    if (t.status === 'failed' || t.status === 'needs_attention') {
      return { exit: { status: 'dead', error: { reason: `target is ${t.status}` } } };
    }
    if (t.channel_status !== 'active') {
      await setTarget(tx, t.id, 'needs_attention', { kind: 'channel', reason: `channel is ${t.channel_status}` });
      await record(tx, job.tenant_id, t.id, 'post_target.needs_attention', { reason: `channel_${t.channel_status}` });
      await rollUp(tx, t.post_id);
      return { exit: { status: 'dead', error: { reason: `channel ${t.channel_status}` } } };
    }
    const gate = await checkGate(tx, t.post_id);
    if (!gate.ok) {
      await setTarget(tx, t.id, 'needs_attention', { kind: 'approval', reason: gate.reason });
      await record(tx, job.tenant_id, t.id, 'post_target.needs_attention', { reason: gate.reason });
      await rollUp(tx, t.post_id);
      return { exit: { status: 'dead', error: { reason: `approval gate: ${gate.reason}` } } };
    }
    const wasPublishing = t.status === 'publishing';
    if (!wasPublishing) {
      await tx.query(`update social.post_targets set status = 'publishing', attempts = attempts + 1 where id = $1`, [t.id]);
      await tx.query(`update social.posts set status = 'publishing' where id = $1 and status in ('approved', 'scheduled')`, [t.post_id]);
    }
    const media = (await tx.query<any>(
      `select id, kind, mime, size_bytes, alt_text, title, storage_key from social.media_assets where id = any($1::uuid[])`,
      [t.media_ids ?? []])).rows;
    const byId = new Map(media.map((m) => [m.id, m]));
    const { token, source } = await loadToken(tx, { tenantId: job.tenant_id, channelId: t.channel_id, provider: t.provider }, d.credentials);
    return { loaded: {
      targetId: t.id, postId: t.post_id, tenantId: job.tenant_id, idempotencyKey: t.idempotency_key, settings: t.settings ?? {},
      text: t.body_override ?? t.body, title: t.title, linkUrl: t.link_url,
      channel: { id: t.channel_id, provider: t.provider, kind: t.kind, externalId: t.external_id, settings: t.channel_settings ?? {} },
      // keep the post's media order
      media: (t.media_ids ?? []).map((id: string) => byId.get(id)).filter(Boolean).map((m: any) => ({
        id: m.id, kind: m.kind, mime: m.mime, sizeBytes: Number(m.size_bytes), storageKey: m.storage_key,
        ...(m.alt_text ? { altText: m.alt_text } : {}), ...(m.title ? { title: m.title } : {}),
      })),
      token, tokenSource: source, wasPublishing,
    } };
  });
}

async function freshToken(provider: ChannelProvider, l: Loaded, d: WorkerDeps): Promise<TokenSet> {
  const exp = l.token.expiresAt?.getTime();
  if (exp === undefined || exp - d.now().getTime() > REFRESH_MARGIN_MS) return l.token;
  if (!provider.auth.refreshable || !l.token.refreshToken) {
    throw new ProviderError(provider.id, 'reconnect', 'access token expired and cannot be refreshed', { code: 'token_expired' });
  }
  const clientId = d.credentials.secrets.get(provider.auth.secretNames.clientId ?? '');
  const clientSecret = d.credentials.secrets.get(provider.auth.secretNames.clientSecret ?? '');
  if (!clientId || !clientSecret) throw new ProviderError(provider.id, 'retryable', 'app credentials not synced to this worker');
  const token = await provider.refresh({ clientId, clientSecret, token: l.token, http: d.http, now: d.now });
  await withTenant(d.db, l.tenantId, (tx) =>
    saveRefreshedToken(tx, { tenantId: l.tenantId, channelId: l.channel.id }, token, l.tokenSource, d.credentials.keyRing));
  return token;
}

async function onSuccess(job: Job, d: WorkerDeps, l: Loaded, res: PublishResult, how: 'published' | 'reconciled', traceId?: string) {
  await withTenant(d.db, l.tenantId, async (tx) => {
    await tx.query(
      `update social.post_targets set status = 'published', external_id = $2, external_url = $3, published_at = $4, last_error = null
        where id = $1`, [l.targetId, res.externalId, res.url ?? null, d.now()]);
    await record(tx, l.tenantId, l.targetId, 'post_target.published',
      { provider: l.channel.provider, externalId: res.externalId, url: res.url, how, jobId: job.id, ...(res.notes ? { notes: res.notes } : {}) }, traceId);
    await rollUp(tx, l.postId);
    if (typeof l.settings.firstComment === 'string' && l.settings.firstComment.trim()) {
      await enqueue(tx, { tenantId: l.tenantId, kind: 'first_comment', key: `${l.idempotencyKey}:first_comment`,
        payload: { post_target_id: l.targetId } });
    }
  });
}

async function onFailure(job: Job, d: WorkerDeps, l: Loaded, e: ProviderError, traceId?: string): Promise<Outcome> {
  const err = e.toJSON();
  const lastAttempt = job.attempts >= job.max_attempts;
  return withTenant(d.db, l.tenantId, async (tx) => {
    let outcome: Outcome;
    if (e.kind === 'reconnect') {
      await tx.query(`update social.channels set status = 'needs_reconnect' where id = $1`, [l.channel.id]);
      await setTarget(tx, l.targetId, 'needs_attention', err);
      await record(tx, l.tenantId, l.targetId, 'channel.needs_reconnect', { channelId: l.channel.id, provider: l.channel.provider, code: e.code }, traceId);
      outcome = { status: 'dead', error: err };
    } else if (e.kind === 'fatal') {
      await setTarget(tx, l.targetId, 'failed', err);
      await record(tx, l.tenantId, l.targetId, 'post_target.failed', err, traceId);
      outcome = { status: 'dead', error: err };
    } else if (e.kind === 'unknown_outcome') {
      // Stay `publishing`: the next attempt reconciles instead of posting again.
      if (lastAttempt) {
        await setTarget(tx, l.targetId, 'needs_attention', err);
        await record(tx, l.tenantId, l.targetId, 'post_target.needs_attention', { reason: 'unknown_outcome', ...err }, traceId);
        outcome = { status: 'dead', error: err };
      } else {
        await tx.query('update social.post_targets set last_error = $2 where id = $1', [l.targetId, JSON.stringify(err)]);
        outcome = { status: 'retry', error: err, retryAfterMs: 0 };
      }
    } else if (lastAttempt) {
      await setTarget(tx, l.targetId, 'failed', { ...err, reason: 'retries exhausted' });
      await record(tx, l.tenantId, l.targetId, 'post_target.failed', { ...err, reason: 'retries exhausted' }, traceId);
      outcome = { status: 'dead', error: err };
    } else {
      // Nothing was created: back to queued, unless the content lost its approval meanwhile.
      const approved = (await tx.query<{ ok: boolean }>('select social.post_is_approved($1) as ok', [l.postId])).rows[0]?.ok;
      await setTarget(tx, l.targetId, approved ? 'queued' : 'needs_attention', approved ? err : { kind: 'approval', reason: 'content changed since approval' });
      outcome = approved
        ? { status: 'retry', error: err, ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}) }
        : { status: 'dead', error: { reason: 'approval lost during retry' } };
    }
    await rollUp(tx, l.postId);
    return outcome;
  });
}

export const publishTarget: Handler = async (job, d) => {
  let pre: Pre;
  try {
    pre = await preflight(job, d);
  } catch (e) {
    if (e instanceof ProviderError && e.kind === 'reconnect') {
      // Credential unusable before anything was sent. Preflight rolled back; park the target where a human
      // sees it instead of leaving it `queued` behind a dead job.
      const targetId = String(job.payload.post_target_id ?? '');
      await withTenant(d.db, job.tenant_id, async (tx) => {
        const t = (await tx.query<{ post_id: string; channel_id: string }>(
          'select post_id, channel_id from social.post_targets where id = $1', [targetId])).rows[0];
        if (!t) return;
        await tx.query(`update social.channels set status = 'needs_reconnect' where id = $1`, [t.channel_id]);
        await setTarget(tx, targetId, 'needs_attention', e.toJSON());
        await record(tx, job.tenant_id, targetId, 'channel.needs_reconnect', { channelId: t.channel_id, code: e.code });
        await rollUp(tx, t.post_id);
      });
      return { status: 'dead', error: e.toJSON() };
    }
    throw e;
  }
  if ('exit' in pre) return pre.exit;
  const l = pre.loaded;
  const provider = d.registry.get(l.channel.provider);
  const req: PublishRequest = {
    idempotencyKey: l.idempotencyKey, text: l.text, media: l.media, settings: l.settings,
    ...(l.title ? { title: l.title } : {}), ...(l.linkUrl ? { linkUrl: l.linkUrl } : {}),
  };
  const storageKeys = new Map(l.media.map((m) => [m.id, m.storageKey]));

  return d.tracer.span(`publish ${provider.id}`, { tenant: l.tenantId, provider: provider.id, channel: l.channel.id, attempt: job.attempts }, async (span) => {
    const traceId = span.traceId();
    let sent = false;
    try {
      const token = await freshToken(provider, l, d);
      const ctx: ProviderContext = {
        channel: { id: l.channel.id, kind: l.channel.kind, externalId: l.channel.externalId, settings: l.channel.settings },
        token, http: d.http, tracer: d.tracer, now: d.now, sleep: d.sleep,
        media: {
          read: (id) => d.storage.read(storageKeys.get(id) ?? ''),
          ...(d.storage.publicUrl ? { publicUrl: (id: string) => d.storage.publicUrl!(storageKeys.get(id) ?? '') } : {}),
        },
      };
      if (l.wasPublishing) {
        // A previous attempt may have created the post. Never post again blind.
        const found = provider.capabilities.reconcile && provider.reconcile ? await provider.reconcile(ctx, req) : null;
        if (found) {
          await onSuccess(job, d, l, found, 'reconciled', traceId);
          return { status: 'done' };
        }
        const why = provider.capabilities.reconcile ? 'previous attempt outcome unknown and the post was not found' :
          `previous attempt outcome unknown and ${provider.id} posts cannot be looked up`;
        await withTenant(d.db, l.tenantId, async (tx) => {
          await setTarget(tx, l.targetId, 'needs_attention', { kind: 'unknown_outcome', reason: why });
          await record(tx, l.tenantId, l.targetId, 'post_target.needs_attention', { reason: 'unknown_outcome', detail: why }, traceId);
          await rollUp(tx, l.postId);
        });
        return { status: 'dead', error: { reason: why } };
      }
      sent = true;
      const res = await provider.publish(ctx, req);
      await onSuccess(job, d, l, res, 'published', traceId);
      span.setAttribute('external_id', res.externalId);
      return { status: 'done' };
    } catch (e) {
      span.recordException(e);
      const pe = e instanceof ProviderError ? e
        : new ProviderError(provider.id, sent ? 'unknown_outcome' : 'retryable', (e as Error).message, { cause: e });
      span.setAttribute('error.kind', pe.kind);
      return onFailure(job, d, l, pe, traceId);
    }
  });
};

/** first_comment: one plain-text comment under a published post. Not retried after an unknown outcome. */
export const firstComment: Handler = async (job, d) => {
  const targetId = String(job.payload.post_target_id ?? '');
  const row = await withTenant(d.db, job.tenant_id, async (tx) => {
    const t = (await tx.query<any>(
      `select t.id, t.status, t.external_id, t.settings, c.id as channel_id, c.provider, c.kind, c.external_id as channel_external_id, c.settings as channel_settings
         from social.post_targets t join social.channels c on c.id = t.channel_id where t.id = $1`, [targetId])).rows[0];
    if (!t) return null;
    const { token } = await loadToken(tx, { tenantId: job.tenant_id, channelId: t.channel_id, provider: t.provider }, d.credentials);
    return { ...t, token };
  });
  if (!row || row.status !== 'published' || !row.external_id) return { status: 'dead', error: { reason: 'target not published' } };
  const provider = d.registry.get(row.provider);
  if (!provider.comment) return { status: 'dead', error: { reason: `${provider.id} has no comments` } };
  const ctx: ProviderContext = {
    channel: { id: row.channel_id, kind: row.kind, externalId: row.channel_external_id, settings: row.channel_settings ?? {} },
    token: row.token, http: d.http, tracer: d.tracer, now: d.now, sleep: d.sleep, media: { read: async () => new Uint8Array() },
  };
  try {
    const out = await provider.comment(ctx, row.external_id, String(row.settings?.firstComment ?? ''));
    await withTenant(d.db, job.tenant_id, (tx) => record(tx, job.tenant_id, targetId, 'post_target.first_comment', { externalId: out.externalId }));
    return { status: 'done' };
  } catch (e) {
    const pe = e instanceof ProviderError ? e : new ProviderError(provider.id, 'unknown_outcome', (e as Error).message);
    if (pe.kind === 'retryable') return { status: 'retry', error: pe.toJSON(), ...(pe.retryAfterMs !== undefined ? { retryAfterMs: pe.retryAfterMs } : {}) };
    await withTenant(d.db, job.tenant_id, (tx) => record(tx, job.tenant_id, targetId, 'post_target.first_comment_failed', pe.toJSON()));
    return { status: 'dead', error: pe.toJSON() };
  }
};


/** delete_target: remove one published post from its platform (a human asked via unpublish). */
export const deleteTarget: Handler = async (job, d) => {
  const targetId = String(job.payload.post_target_id ?? '');
  const row = await withTenant(d.db, job.tenant_id, async (tx) => {
    const t = (await tx.query<any>(
      `select t.id, t.status, t.external_id, t.deleted_at, c.id as channel_id, c.provider, c.kind, c.external_id as channel_external_id, c.settings as channel_settings
         from social.post_targets t join social.channels c on c.id = t.channel_id where t.id = $1`, [targetId])).rows[0];
    if (!t) return null;
    const { token } = await loadToken(tx, { tenantId: job.tenant_id, channelId: t.channel_id, provider: t.provider }, d.credentials);
    return { ...t, token };
  });
  if (!row || row.status !== 'published' || !row.external_id) return { status: 'dead', error: { reason: 'target not published' } };
  if (row.deleted_at) return { status: 'done' };
  const provider = d.registry.get(row.provider);
  const ctx: ProviderContext = {
    channel: { id: row.channel_id, kind: row.kind, externalId: row.channel_external_id, settings: row.channel_settings ?? {} },
    token: row.token, http: d.http, tracer: d.tracer, now: d.now, sleep: d.sleep, media: { read: async () => new Uint8Array() },
  };
  try {
    await provider.delete(ctx, row.external_id);
    await withTenant(d.db, job.tenant_id, async (tx) => {
      await tx.query('update social.post_targets set deleted_at = $2 where id = $1', [targetId, d.now()]);
      await record(tx, job.tenant_id, targetId, 'post_target.deleted', { provider: provider.id, externalId: row.external_id });
    });
    return { status: 'done' };
  } catch (e) {
    const pe = e instanceof ProviderError ? e : new ProviderError(provider.id, 'retryable', (e as Error).message);
    if (pe.kind === 'retryable' || pe.kind === 'unknown_outcome') return { status: 'retry', error: pe.toJSON(), ...(pe.retryAfterMs !== undefined ? { retryAfterMs: pe.retryAfterMs } : {}) };
    await withTenant(d.db, job.tenant_id, (tx) => record(tx, job.tenant_id, targetId, 'post_target.delete_failed', pe.toJSON()));
    return { status: 'dead', error: pe.toJSON() };
  }
};
