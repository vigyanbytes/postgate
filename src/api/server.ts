// HTTP API for people (CLI, scripts) and agents (MCP server, automations). Full contract: docs/API.md.
// Binds to loopback by default and refuses all-interfaces binds unless explicitly allowed (inside a container whose
// port is published on loopback). Put a reverse proxy with TLS in front before exposing it beyond this machine.
//
// Two kinds of keys (`Authorization: Bearer pgate_…`, the tenant comes from the key):
//   member key     bound to one human member. May decide approvals (by role), cancel, retry, delete, manage channels.
//   automation key no member (agents, scripts). May draft, edit, upload media, ask for approval and set times —
//                  never decide. Nothing an automation key does can make a post go out without a human approval.
// Nothing here talks to a platform; publishing is the worker's job once a post is approved and due.
// One route needs no key: GET /media/<key>?exp&sig — a short-lived signed URL that platforms pull media from.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { withTenant, type Db } from '../db/db.ts';
import { ApprovalError, decideApproval, requestApproval } from '../approval/gate.ts';
import { createDraft, DraftError, getPost, listPosts, validatePost, type DraftTargetInput } from '../posts/drafts.ts';
import { cancelPost, deleteDraft, editPost, postHistory, retryPost, setSchedule, unpublishPost, unschedule } from '../posts/manage.ts';
import { DEFAULT_TIMEZONE, isTimeZone, parseScheduleTime } from '../posts/time.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { AUTOMATION_SCOPES, createApiKey, resolveApiKey, type ApiPrincipal, type ApiScope } from './keys.ts';
import { kindOfMime, type DiskStorage } from '../media/storage.ts';
import { SECRET_NAME } from '../credentials/secrets.ts';
import { HttpError } from './errors.ts';

export interface ApiDeps {
  /** Connection acting as role social_app (RLS applies). */
  db: Db;
  registry: ProviderRegistry;
  now?: () => Date;
  maxBodyBytes?: number;
  /** Browser origins allowed to call the API (CORS). */
  corsOrigins?: string[];
  /** Media files (uploads + signed public URLs). Without it, media upload answers 501. */
  storage?: DiskStorage;
  /** Largest accepted media upload, bytes (default 512 MB). */
  maxUploadBytes?: number;
}


/** The contract as data: docs/API.md is tested against it. */
export const API_ROUTES = [
  ['GET', '/v1/health'], ['GET', '/v1/me'], ['GET', '/v1/channels'], ['POST', '/v1/channels'], ['POST', '/v1/channels/:id/status'],
  ['GET', '/v1/media'], ['POST', '/v1/media'], ['GET', '/media/:key'], ['POST', '/v1/keys'],
  ['GET', '/v1/posts'], ['GET', '/v1/posts/:id'], ['POST', '/v1/drafts'], ['PATCH', '/v1/posts/:id'], ['DELETE', '/v1/posts/:id'],
  ['POST', '/v1/posts/:id/validate'], ['POST', '/v1/posts/:id/approval-requests'], ['POST', '/v1/posts/:id/decision'],
  ['POST', '/v1/approvals/decide'], ['POST', '/v1/posts/:id/schedule'], ['POST', '/v1/posts/:id/unschedule'],
  ['POST', '/v1/posts/:id/cancel'], ['POST', '/v1/posts/:id/retry'], ['POST', '/v1/posts/:id/unpublish'],
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIA = ['console', 'chat', 'email', 'api'] as const;
const APPROVER_ROLES = ['owner', 'admin', 'approver'];

const APPROVAL_STATUS: Record<string, number> = { not_found: 404, not_pending: 409, expired: 410, stale: 409, forbidden: 403, bad_request: 400 };
const DRAFT_STATUS: Record<string, number> = { not_found: 404, bad_request: 400, no_targets: 400, duplicate_target: 400, unknown_channel: 422,
  unknown_media: 422, ambiguous_channel: 422, not_editable: 409, busy: 409, nothing_to_retry: 409, in_past: 400 };

async function readJson(req: IncomingMessage, max: number): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new HttpError(413, 'too_large', `body larger than ${max} bytes`);
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  let v: unknown;
  try {
    v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_json', 'body is not valid JSON');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'bad_json', 'body must be a JSON object');
  return v;
}

const str = (v: unknown, field: string, opts: { optional?: boolean; max?: number } = {}): string | undefined => {
  if (v === undefined || v === null) {
    if (opts.optional) return undefined;
    throw new HttpError(400, 'bad_request', `${field} is required`);
  }
  if (typeof v !== 'string') throw new HttpError(400, 'bad_request', `${field} must be a string`);
  if (opts.max && v.length > opts.max) throw new HttpError(400, 'bad_request', `${field} is longer than ${opts.max}`);
  return v;
};

/** Field present -> string or null; absent -> undefined (PATCH semantics). */
const nullableStr = (b: any, key: string, max: number): string | null | undefined =>
  !(key in b) ? undefined : b[key] === null ? null : str(b[key], key, { max });

function need(p: ApiPrincipal, scope: string) {
  if (!p.scopes.includes(scope)) throw new HttpError(403, 'missing_scope', `this key lacks ${scope}`);
}

function needAdmin(p: ApiPrincipal): string {
  if (!p.memberRef || !p.role || !['owner', 'admin'].includes(p.role)) throw new HttpError(403, 'admin_required', 'this action needs an owner or admin member key');
  return p.memberRef;
}

async function readBytes(req: IncomingMessage, max: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new HttpError(413, 'too_large', `upload larger than ${max} bytes`);
    chunks.push(c as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function needMember(p: ApiPrincipal): string {
  if (!p.memberRef) throw new HttpError(403, 'human_required', 'this action needs a signed-in member, not an automation key');
  return p.memberRef;
}

function mediaIds(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((m) => typeof m !== 'string' || !UUID.test(m))) throw new HttpError(400, 'bad_request', 'mediaIds must be a list of uuids');
  return v;
}

/** Targets may name a channel id, or a provider when the tenant has exactly one active channel of it. */
async function resolveTargets(db: Db, tenantId: string, raw: unknown): Promise<DraftTargetInput[]> {
  if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, 'bad_request', 'targets must be a non-empty list');
  const channels = await withTenant(db, tenantId, async (tx) => (await tx.query<{ id: string; provider: string; status: string }>(
    'select id, provider, status from social.channels')).rows);
  return raw.map((t: any, i: number) => {
    if (!t || typeof t !== 'object') throw new HttpError(400, 'bad_request', `targets[${i}] must be an object`);
    let channelId = str(t.channelId, `targets[${i}].channelId`, { optional: true });
    if (!channelId) {
      const provider = str(t.provider, `targets[${i}].provider (or channelId)`);
      const matches = channels.filter((c) => c.provider === provider && c.status === 'active');
      if (matches.length !== 1) {
        throw new HttpError(422, 'ambiguous_channel', `${matches.length} active ${provider} channels: pass channelId`);
      }
      channelId = matches[0]!.id;
    }
    if (!UUID.test(channelId)) throw new HttpError(400, 'bad_request', `targets[${i}].channelId is not a uuid`);
    if (t.settings !== undefined && (typeof t.settings !== 'object' || Array.isArray(t.settings) || t.settings === null)) {
      throw new HttpError(400, 'bad_request', `targets[${i}].settings must be an object`);
    }
    return { channelId, bodyOverride: str(t.bodyOverride, `targets[${i}].bodyOverride`, { optional: true, max: 70_000 }) ?? null,
      settings: t.settings ?? {} };
  });
}

function timeZone(v: unknown): string {
  const tz = v === undefined || v === null ? DEFAULT_TIMEZONE : str(v, 'timezone', { max: 64 })!;
  if (!isTimeZone(tz)) throw new HttpError(400, 'bad_request', `unknown time zone ${tz}`);
  return tz;
}

function scheduleTime(v: unknown, tz: string, field = 'at'): Date {
  const d = typeof v === 'string' ? parseScheduleTime(v, tz) : null;
  if (!d) throw new HttpError(400, 'bad_request', `${field} must be ISO 8601 with an offset, or a local time like 2026-10-26T09:30`);
  return d;
}

function isoParam(v: string | null, field: string): Date | undefined {
  if (v === null) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'bad_request', `${field} must be an ISO timestamp`);
  return d;
}

export function createApiHandler(deps: ApiDeps) {
  const now = deps.now ?? (() => new Date());
  const max = deps.maxBodyBytes ?? 256 * 1024;

  async function route(req: IncomingMessage): Promise<{ status: number; body: unknown; raw?: boolean }> {
    const url = new URL(req.url ?? '/', 'http://internal');
    const method = req.method ?? 'GET';
    const parts = url.pathname.split('/').filter(Boolean);
    if (method === 'GET' && url.pathname === '/v1/health') return { status: 200, body: { ok: true } };

    if (method === 'GET' && parts[0] === 'media' && parts.length === 3) {
      const bytes = deps.storage ? await deps.storage.readSigned(`${parts[1]}/${parts[2]}`, url.searchParams.get('exp'), url.searchParams.get('sig'), now()) : null;
      if (!bytes) throw new HttpError(404, 'not_found', 'no such media, or the link expired');
      return { status: 200, body: bytes, raw: true };
    }
    const auth = req.headers.authorization ?? '';
    const key = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
    const p = key ? await resolveApiKey(deps.db, key) : null;
    if (!p) throw new HttpError(401, 'unauthorized', 'missing, invalid or expired API key');
    const actor = p.memberRef ?? `agent:api-key:${p.keyId}`;
    const asTenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(deps.db, p.tenantId, fn);
    const postId = parts[0] === 'v1' && parts[1] === 'posts' && parts[2] ? parts[2] : undefined;
    if (postId && !UUID.test(postId)) throw new HttpError(404, 'not_found', 'no such post');
    const action = postId ? parts[3] : undefined;
    const ids = postId ? { tenantId: p.tenantId, postId, actor } : undefined;

    if (method === 'GET' && url.pathname === '/v1/me') {
      const tenant = await asTenant(async (tx) => (await tx.query('select id, slug, name from social.tenants')).rows[0]);
      return { status: 200, body: { tenant, actor, member: p.memberRef, role: p.role, isHuman: Boolean(p.memberRef), scopes: p.scopes,
        canDecide: Boolean(p.memberRef && p.role && APPROVER_ROLES.includes(p.role)), defaultTimezone: DEFAULT_TIMEZONE } };
    }
    if (method === 'GET' && url.pathname === '/v1/channels') {
      need(p, 'drafts:read');
      const rows = await asTenant(async (tx) => (await tx.query(
        `select c.id, c.provider, c.kind, c.external_id as "externalId", c.display_name as "displayName", c.status
           from social.channels c order by c.provider, c.display_name`)).rows);
      return { status: 200, body: { channels: rows, providers: deps.registry.describe().map((d) => ({ id: d.id, displayName: d.displayName,
        limits: d.limits, capabilities: d.capabilities })) } };
    }
    if (method === 'POST' && url.pathname === '/v1/channels') {
      need(p, 'channels:write');
      needAdmin(p);
      const b = await readJson(req, max);
      const provider = str(b.provider, 'provider', { max: 40 })!;
      if (!deps.registry.has(provider)) {
        throw new HttpError(422, 'unknown_provider', `no provider ${provider}; known: ${deps.registry.list().map((x) => x.id).join(', ')}`);
      }
      const tokenEnv = str(b.tokenEnv, 'tokenEnv', { max: 100 })!;
      if (!SECRET_NAME.test(tokenEnv)) throw new HttpError(400, 'bad_request', 'tokenEnv is the NAME of an environment variable (A-Z, 0-9, _), never a token');
      const kind = str(b.kind, 'kind', { optional: true, max: 20 }) ?? deps.registry.get(provider).channelKind;
      const externalId = str(b.externalId, 'externalId', { max: 300 })!;
      const displayName = str(b.displayName, 'displayName', { optional: true, max: 200 }) ?? `${provider} ${externalId}`;
      const settings = b.settings ?? {};
      if (typeof settings !== 'object' || Array.isArray(settings) || settings === null) throw new HttpError(400, 'bad_request', 'settings must be an object');
      const id = await asTenant(async (tx) => {
        await tx.query(`select set_config('app.actor', $1, true)`, [actor]);
        const row = (await tx.query<{ id: string }>(
          `insert into social.channels (tenant_id, provider, kind, external_id, display_name, settings) values ($1, $2, $3, $4, $5, $6)
           on conflict (tenant_id, provider, external_id) do update set display_name = excluded.display_name, settings = excluded.settings,
             kind = excluded.kind, status = 'active'
           returning id`, [p.tenantId, provider, kind, externalId, displayName, JSON.stringify(settings)])).rows[0]!;
        await tx.query(`select social.store_channel_credential($1, 'env', $2, null, null, null)`, [row.id, tokenEnv]);
        return row.id;
      });
      return { status: 201, body: { id, provider, kind, externalId, displayName, tokenEnv, status: 'active' } };
    }
    const chStatus = /^\/v1\/channels\/([0-9a-f-]{36})\/status$/i.exec(url.pathname);
    if (method === 'POST' && chStatus) {
      need(p, 'channels:write');
      needAdmin(p);
      const b = await readJson(req, max);
      if (b.status !== 'active' && b.status !== 'disabled') throw new HttpError(400, 'bad_request', 'status must be active or disabled');
      const n = await asTenant(async (tx) => {
        const r = (await tx.query('update social.channels set status = $2 where id = $1 returning id', [chStatus[1], b.status])).rows.length;
        if (r) {
          await tx.query(`insert into social.audit_log (tenant_id, actor, action, subject_type, subject_id, detail)
            values ($1, $2, 'channel.status', 'channel', $3, $4)`, [p.tenantId, actor, chStatus[1], JSON.stringify({ status: b.status })]);
        }
        return r;
      });
      if (!n) throw new HttpError(404, 'not_found', 'no such channel');
      return { status: 200, body: { id: chStatus[1], status: b.status } };
    }
    if (method === 'POST' && url.pathname === '/v1/media') {
      need(p, 'drafts:write');
      if (!deps.storage) throw new HttpError(501, 'no_storage', 'media storage is not configured (POSTGATE_MEDIA_DIR)');
      const mime = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      const kind = kindOfMime(mime);
      if (!kind) throw new HttpError(415, 'unsupported_media', `unsupported content-type ${mime || '(none)'}`);
      const altText = url.searchParams.get('altText');
      const title = url.searchParams.get('title');
      if ((altText?.length ?? 0) > 1000 || (title?.length ?? 0) > 300) throw new HttpError(400, 'bad_request', 'altText <= 1000, title <= 300 characters');
      const bytes = await readBytes(req, deps.maxUploadBytes ?? 512 * 1024 * 1024);
      if (!bytes.byteLength) throw new HttpError(400, 'bad_request', 'empty upload');
      const saved = await deps.storage.save(p.tenantId, bytes, mime);
      const id = await asTenant(async (tx) => {
        const row = (await tx.query<{ id: string }>(
          `insert into social.media_assets (tenant_id, kind, mime, size_bytes, sha256, storage_key, alt_text, title)
           values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
          [p.tenantId, kind, mime, bytes.byteLength, saved.sha256, saved.storageKey, altText, title])).rows[0]!;
        await tx.query(`insert into social.audit_log (tenant_id, actor, action, subject_type, subject_id, detail)
          values ($1, $2, 'media.uploaded', 'media', $3, $4)`,
          [p.tenantId, actor, row.id, JSON.stringify({ kind, mime, sizeBytes: bytes.byteLength, sha256: saved.sha256 })]);
        return row.id;
      });
      return { status: 201, body: { id, kind, mime, sizeBytes: bytes.byteLength, sha256: saved.sha256 } };
    }
    if (method === 'POST' && url.pathname === '/v1/keys') {
      needAdmin(p);
      const b = await readJson(req, max);
      const name = str(b.name, 'name', { max: 100 })!;
      const scopes = (b.scopes ?? AUTOMATION_SCOPES) as string[];
      if (!Array.isArray(scopes) || !scopes.length || !scopes.every((sc) => (AUTOMATION_SCOPES as readonly string[]).includes(sc))) {
        throw new HttpError(400, 'bad_request', `automation keys may only hold ${AUTOMATION_SCOPES.join(', ')} (never approvals:decide)`);
      }
      const days = typeof b.expiresInDays === 'number' ? Math.min(365, Math.max(1, b.expiresInDays)) : undefined;
      const k = await asTenant((tx) => createApiKey(tx, { tenantId: p.tenantId, name: `automation:${name}`, scopes: scopes as ApiScope[],
        createdBy: actor, ...(days ? { expiresAt: new Date(now().getTime() + days * 86_400_000) } : {}) }));
      return { status: 201, body: { id: k.id, key: k.key, name: `automation:${name}`, scopes, note: 'shown once; keep it in your secret manager' } };
    }
    if (method === 'GET' && url.pathname === '/v1/media') {
      need(p, 'drafts:read');
      const rows = await asTenant(async (tx) => (await tx.query(
        `select id, kind, mime, size_bytes::float8 as "sizeBytes", alt_text as "altText", title, width, height, created_at as "createdAt"
           from social.media_assets order by created_at desc limit 200`)).rows);
      return { status: 200, body: { media: rows } };
    }
    if (method === 'GET' && url.pathname === '/v1/posts') {
      need(p, 'drafts:read');
      const statuses = url.searchParams.get('status')?.split(',').filter(Boolean);
      const from = isoParam(url.searchParams.get('from'), 'from');
      const to = isoParam(url.searchParams.get('to'), 'to');
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined;
      if (limit !== undefined && !Number.isFinite(limit)) throw new HttpError(400, 'bad_request', 'limit must be a number');
      return { status: 200, body: { posts: await asTenant((tx) => listPosts(tx, {
        ...(statuses ? { statuses } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...(limit !== undefined ? { limit } : {}) })) } };
    }
    if (method === 'POST' && url.pathname === '/v1/drafts') {
      need(p, 'drafts:write');
      const b = await readJson(req, max);
      const targets = await resolveTargets(deps.db, p.tenantId, b.targets);
      const tz = timeZone(b.timezone);
      const out = await asTenant((tx) => createDraft(tx, {
        tenantId: p.tenantId, createdBy: actor, body: str(b.body, 'body', { max: 70_000 })!,
        title: str(b.title, 'title', { optional: true, max: 500 }) ?? null,
        linkUrl: str(b.linkUrl, 'linkUrl', { optional: true, max: 2000 }) ?? null,
        mediaIds: mediaIds(b.mediaIds) ?? [],
        scheduledAt: b.scheduledAt ? scheduleTime(b.scheduledAt, tz, 'scheduledAt') : null, timezone: tz,
        sourceRef: str(b.sourceRef, 'sourceRef', { optional: true, max: 300 }) ?? null,
        targets,
      }, deps.registry));
      return { status: out.created ? 201 : 200, body: out };
    }
    if (method === 'POST' && url.pathname === '/v1/approvals/decide') {
      need(p, 'approvals:decide');
      const b = await readJson(req, max);
      const token = str(b.token, 'token', { max: 200 })!;
      const memberRef = str(b.actor, 'actor', { max: 200 })!;
      if (/^(agent|system):/i.test(memberRef)) throw new HttpError(403, 'human_required', 'approvals are decided by a human member, not an automation');
      if (p.memberRef && p.memberRef !== memberRef) throw new HttpError(403, 'forbidden', 'a member key decides only as its own member');
      if (b.decision !== 'approved' && b.decision !== 'rejected') throw new HttpError(400, 'bad_request', 'decision must be approved or rejected');
      const via = b.via ?? 'chat';
      if (!(VIA as readonly unknown[]).includes(via)) throw new HttpError(400, 'bad_request', 'invalid via');
      const r = await asTenant((tx) => decideApproval(tx, { tenantId: p.tenantId, token, decision: b.decision, actor: memberRef, via, now: now(),
        ...(typeof b.note === 'string' ? { note: b.note.slice(0, 1000) } : {}) }));
      return { status: 200, body: r };
    }

    if (!postId || !ids) throw new HttpError(404, 'not_found', `no route ${method} ${url.pathname}`);

    if (method === 'GET' && !action) {
      need(p, 'drafts:read');
      const out = await asTenant(async (tx) => {
        const post = await getPost(tx, postId);
        return post ? { ...post, history: await postHistory(tx, postId) } : null;
      });
      if (!out) throw new HttpError(404, 'not_found', 'no such post');
      return { status: 200, body: out };
    }
    if (method === 'PATCH' && !action) {
      need(p, 'drafts:write');
      const b = await readJson(req, max);
      const targets = b.targets === undefined ? undefined : await resolveTargets(deps.db, p.tenantId, b.targets);
      const edit = {
        ...(nullableStr(b, 'title', 500) !== undefined ? { title: nullableStr(b, 'title', 500) } : {}),
        ...(b.body !== undefined ? { body: str(b.body, 'body', { max: 70_000 })! } : {}),
        ...(nullableStr(b, 'linkUrl', 2000) !== undefined ? { linkUrl: nullableStr(b, 'linkUrl', 2000) } : {}),
        ...(b.mediaIds !== undefined ? { mediaIds: mediaIds(b.mediaIds)! } : {}),
        ...(targets ? { targets } : {}),
      };
      if (!Object.keys(edit).length) throw new HttpError(400, 'bad_request', 'nothing to change (title, body, linkUrl, mediaIds, targets)');
      const out = await asTenant(async (tx) => {
        await editPost(tx, ids, edit);
        return { post: await getPost(tx, postId), issues: await validatePost(tx, postId, deps.registry) };
      });
      return { status: 200, body: out };
    }
    if (method === 'DELETE' && !action) {
      need(p, 'drafts:write');
      needMember(p);
      await asTenant((tx) => deleteDraft(tx, ids));
      return { status: 200, body: { deleted: postId } };
    }
    if (method === 'POST' && action === 'validate') {
      need(p, 'drafts:read');
      return { status: 200, body: { issues: await asTenant((tx) => validatePost(tx, postId, deps.registry)) } };
    }
    if (method === 'POST' && action === 'approval-requests') {
      need(p, 'approvals:request');
      const b = await readJson(req, max);
      const via = Array.isArray(b.via) ? b.via : ['console'];
      if (!via.every((v: unknown) => (VIA as readonly unknown[]).includes(v))) throw new HttpError(400, 'bad_request', `via must be from ${VIA.join(', ')}`);
      return asTenant(async (tx) => {
        const problems = (await validatePost(tx, postId, deps.registry)).filter((t) => t.issues.length);
        if (problems.length) throw new HttpError(422, 'invalid_post', 'fix these before asking for approval', problems);
        const r = await requestApproval(tx, { tenantId: p.tenantId, postId, requestedBy: actor, via, now: now(),
          ...(typeof b.ttlHours === 'number' ? { ttlHours: Math.min(168, Math.max(1, b.ttlHours)) } : {}) });
        // The token goes to the human (chat or e-mail link) and nowhere else; it is not stored in clear.
        return { status: 201, body: { approvalId: r.approvalId, approvalToken: r.token, contentHash: r.contentHash, status: 'in_review' } };
      });
    }
    if (method === 'POST' && action === 'decision') {
      need(p, 'approvals:decide');
      const member = needMember(p);
      const b = await readJson(req, max);
      if (b.decision !== 'approved' && b.decision !== 'rejected') throw new HttpError(400, 'bad_request', 'decision must be approved or rejected');
      const r = await asTenant(async (tx) => {
        const a = (await tx.query<{ id: string }>(`select id from social.approvals where post_id = $1 and status = 'pending'`, [postId])).rows[0];
        if (!a) throw new HttpError(409, 'no_pending_approval', 'request approval first (POST /v1/posts/:id/approval-requests)');
        return decideApproval(tx, { tenantId: p.tenantId, approvalId: a.id, decision: b.decision, actor: member, via: 'console', now: now(),
          ...(typeof b.note === 'string' ? { note: b.note.slice(0, 1000) } : {}) });
      });
      return { status: 200, body: r };
    }
    if (method === 'POST' && action === 'schedule') {
      need(p, 'schedule:write');
      const b = await readJson(req, max);
      const tz = timeZone(b.timezone);
      const at = scheduleTime(b.at, tz);
      return { status: 200, body: { postId, ...(await asTenant((tx) => setSchedule(tx, ids, at, tz, now()))) } };
    }
    if (method === 'POST' && action === 'unschedule') {
      need(p, 'schedule:write');
      return { status: 200, body: { postId, ...(await asTenant((tx) => unschedule(tx, ids))) } };
    }
    if (method === 'POST' && action === 'cancel') {
      need(p, 'schedule:write');
      needMember(p);
      return { status: 200, body: { postId, ...(await asTenant((tx) => cancelPost(tx, ids))) } };
    }
    if (method === 'POST' && action === 'unpublish') {
      need(p, 'schedule:write');
      needMember(p);
      return { status: 202, body: { postId, ...(await asTenant((tx) => unpublishPost(tx, ids))) } };
    }
    if (method === 'POST' && action === 'retry') {
      need(p, 'schedule:write');
      needMember(p);
      return { status: 200, body: { postId, ...(await asTenant((tx) => retryPost(tx, ids))) } };
    }
    throw new HttpError(404, 'not_found', `no route ${method} ${url.pathname}`);
  }

  function cors(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin;
    if (origin && deps.corsOrigins?.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('access-control-max-age', '600');
    }
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    cors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    let status = 500;
    let body: unknown;
    try {
      const r = await route(req);
      if (r.raw) {
        res.writeHead(r.status, { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=300' });
        res.end(r.body as Uint8Array);
        return;
      }
      ({ status, body } = r);
    } catch (e) {
      if (e instanceof HttpError) {
        status = e.status;
        body = { error: e.code, message: e.message, ...(e.detail !== undefined ? { detail: e.detail } : {}) };
      } else if (e instanceof ApprovalError) {
        status = APPROVAL_STATUS[e.code] ?? 400;
        body = { error: e.code, message: e.message };
      } else if (e instanceof DraftError) {
        status = DRAFT_STATUS[e.code] ?? 400;
        body = { error: e.code, message: e.message };
      } else if ((e as { code?: string }).code === '23514') {
        status = 409;
        body = { error: 'gate', message: 'the approval gate refused this change' };
      } else {
        status = 500;
        body = { error: 'internal', message: 'internal error' };
        console.error(`[postgate-api] ${req.method} ${req.url?.split('?')[0]}: ${(e as Error).message}`);
      }
    }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
}

const ALL_INTERFACES = new Set(['0.0.0.0', '::', '']);

/** Starts the API. Default 127.0.0.1; all interfaces needs an explicit opt-in. */
export async function startInternalApi(
  deps: ApiDeps, opts: { host?: string; port?: number; allowAllInterfaces?: boolean } = {},
): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  const host = opts.host ?? '127.0.0.1';
  if (ALL_INTERFACES.has(host) && !opts.allowAllInterfaces) {
    throw new Error('refusing to bind the API to all interfaces; use 127.0.0.1 or a private address (or allowAllInterfaces inside a container)');
  }
  const server = createServer(createApiHandler(deps));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 8787, host, () => resolve());
  });
  const a = server.address() as AddressInfo;
  const url = `http://${a.family === 'IPv6' ? `[${a.address}]` : a.address}:${a.port}`;
  return { server, url, close: () => new Promise((r) => server.close(() => r())) };
}
