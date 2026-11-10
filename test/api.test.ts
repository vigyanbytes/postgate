// HTTP API contract over real HTTP on loopback, against PGlite with the real migrations.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { withTenant } from '../src/db/db.ts';
import { createApiKey, type ApiScope } from '../src/api/keys.ts';
import { startInternalApi } from '../src/api/server.ts';
import { defaultRegistry } from '../src/providers/registry.ts';
import { freshDb, TENANT_A, TENANT_B } from './helpers.ts';
import { one, seedTenant } from './fixtures.ts';

const ALL: ApiScope[] = ['drafts:read', 'drafts:write', 'approvals:request', 'approvals:decide', 'schedule:write'];

describe('HTTP API contract', () => {
  let env: Awaited<ReturnType<typeof freshDb>>;
  let api: Awaited<ReturnType<typeof startInternalApi>>;
  const keys: Record<string, string> = {};
  const ch: Record<string, string> = {};

  const call = async (method: string, path: string, opts: { key?: string | null; body?: unknown } = {}) => {
    const key = opts.key === undefined ? keys.full : opts.key;
    const res = await fetch(`${api.url}${path}`, {
      method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(opts.body ? { 'content-type': 'application/json' } : {}) },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  const draft = (sourceRef: string, extra: object = {}) => call('POST', '/v1/drafts', { body: {
    title: 'The new release goes live Monday', body: 'A short launch note for the test.',
    linkUrl: 'https://github.com/example/project', sourceRef,
    targets: [
      { provider: 'linkedin', settings: { firstComment: 'Repo: https://github.com/example/project' } },
      { provider: 'x', bodyOverride: 'Release notes: what changed and why. Live Monday.' },
    ],
    ...extra,
  } });

  before(async () => {
    env = await freshDb();
    await seedTenant(env.db, TENANT_A, 'tenant-a');
    await seedTenant(env.db, TENANT_B, 'tenant-b');
    for (const [provider, kind, ext] of [['linkedin', 'personal', 'urn:li:person:abc'], ['x', 'personal', '42'], ['facebook_page', 'page', 'P1']] as const) {
      ch[provider] = (await env.db.query<{ id: string }>(
        `insert into social.channels (tenant_id, provider, kind, external_id, display_name) values ($1, $2, $3, $4, $2) returning id`,
        [TENANT_A, provider, kind, ext])).rows[0]!.id;
    }
    keys.full = (await withTenant(env.app, TENANT_A, (tx) => createApiKey(tx, { tenantId: TENANT_A, name: 'automation', scopes: ALL, createdBy: 'u-boss' }))).key;
    keys.readonly = (await withTenant(env.app, TENANT_A, (tx) => createApiKey(tx, { tenantId: TENANT_A, name: 'ro', scopes: ['drafts:read'], createdBy: 'u-boss' }))).key;
    keys.other = (await withTenant(env.app, TENANT_B, (tx) => createApiKey(tx, { tenantId: TENANT_B, name: 'automation', scopes: ALL, createdBy: 'u-boss' }))).key;
    keys.revoked = (await withTenant(env.app, TENANT_A, (tx) => createApiKey(tx, { tenantId: TENANT_A, name: 'old', scopes: ALL, createdBy: 'u-boss' }))).key;
    await withTenant(env.app, TENANT_A, (tx) => tx.query(`update social.api_keys set revoked_at = now() where name = 'old'`));
    api = await startInternalApi({ db: env.app, registry: defaultRegistry() }, { port: 0 });
  });
  after(async () => { await api?.close(); });

  it('health is open; everything else needs a live key', async () => {
    assert.equal((await call('GET', '/v1/health', { key: null })).status, 200);
    assert.equal((await call('GET', '/v1/posts', { key: null })).status, 401);
    assert.equal((await call('GET', '/v1/posts', { key: 'pgate_not-a-real-key-at-all-xxxxxxxx' })).status, 401);
    assert.equal((await call('GET', '/v1/posts', { key: keys.revoked })).status, 401);
    const stored = await one<{ key_hash: string }>(env.db, `select key_hash from social.api_keys where name = 'automation' and tenant_id = $1`, [TENANT_A]);
    assert.notEqual(stored.key_hash, keys.full, 'only the hash is stored');
  });

  it('creates a draft with per-channel variants; sourceRef makes it idempotent', async () => {
    const r = await draft('rss:post-1');
    assert.equal(r.status, 201);
    assert.ok(r.json.issues.every((t: any) => t.issues.length === 0));
    const again = await draft('rss:post-1');
    assert.equal(again.status, 200);
    assert.equal(again.json.postId, r.json.postId);
    const post = (await call('GET', `/v1/posts/${r.json.postId}`)).json;
    assert.equal(post.status, 'draft');
    assert.equal(post.createdBy.startsWith('agent:api-key:'), true);
    assert.deepEqual(post.targets.map((t: any) => [t.provider, t.bodyOverride !== null]), [['linkedin', false], ['x', true]]);
    const list = (await call('GET', '/v1/posts?status=draft')).json.posts;
    assert.ok(list.some((p: any) => p.id === r.json.postId && p.providers.join() === 'linkedin,x'));
    assert.equal((await one<{ n: number }>(env.db, `select count(*)::int as n from social.audit_log where action = 'post.drafted'`)).n, 1);
  });

  it('scopes are enforced', async () => {
    assert.equal((await call('GET', '/v1/channels', { key: keys.readonly })).status, 200);
    const r = await call('POST', '/v1/drafts', { key: keys.readonly, body: { body: 'x', targets: [{ provider: 'x' }] } });
    assert.deepEqual([r.status, r.json.error], [403, 'missing_scope']);
  });

  it('refuses an approval request while a channel variant is invalid', async () => {
    const r = await draft('rss:too-long', { sourceRef: 'rss:too-long', targets: [{ provider: 'x', bodyOverride: 'a'.repeat(300) }] });
    assert.equal(r.status, 201);
    assert.equal(r.json.issues[0].issues[0].code, 'too_long');
    const ask = await call('POST', `/v1/posts/${r.json.postId}/approval-requests`, { body: { via: ['chat'] } });
    assert.deepEqual([ask.status, ask.json.error], [422, 'invalid_post']);
  });

  it('draft -> approval request -> human decision -> schedule; automations cannot approve; nothing is enqueued or sent', async () => {
    const { postId } = (await draft('rss:post-2')).json;
    // Before approval a time is only a proposal: the post stays a draft.
    const early = await call('POST', `/v1/posts/${postId}/schedule`, { body: { at: new Date(Date.now() + 3_600_000).toISOString() } });
    assert.deepEqual([early.status, early.json.status], [200, 'draft']);
    const ask = await call('POST', `/v1/posts/${postId}/approval-requests`, { body: { via: ['chat'] } });
    assert.equal(ask.status, 201);
    assert.ok(ask.json.approvalToken.length > 20);
    const bot = await call('POST', '/v1/approvals/decide', { body: { token: ask.json.approvalToken, decision: 'approved', actor: 'agent:bot' } });
    assert.deepEqual([bot.status, bot.json.error], [403, 'human_required']);
    const editor = await call('POST', '/v1/approvals/decide', { body: { token: ask.json.approvalToken, decision: 'approved', actor: 'u-author' } });
    assert.deepEqual([editor.status, editor.json.error], [403, 'forbidden'], 'an editor is not an approver');
    const ok = await call('POST', '/v1/approvals/decide', { body: { token: ask.json.approvalToken, decision: 'approved', actor: 'u-boss', via: 'chat' } });
    assert.deepEqual([ok.status, ok.json.postStatus], [200, 'scheduled'], 'the proposed time takes effect on approval');
    const reuse = await call('POST', '/v1/approvals/decide', { body: { token: ask.json.approvalToken, decision: 'approved', actor: 'u-boss' } });
    assert.equal(reuse.status, 404, 'the one-time token is gone after use');
    const at = new Date(Date.now() + 86_400_000).toISOString();
    const s = await call('POST', `/v1/posts/${postId}/schedule`, { body: { at } });
    assert.deepEqual([s.status, s.json.status], [200, 'scheduled']);
    assert.equal((await call('GET', `/v1/posts/${postId}`)).json.status, 'scheduled');
    assert.equal((await one<{ n: number }>(env.db, 'select count(*)::int as n from social.jobs')).n, 0, 'the API never enqueues publishing');
    assert.equal((await call('POST', `/v1/posts/${postId}/schedule`, { body: { at: '2020-01-01T00:00:00Z' } })).status, 400);
  });

  it('tenants are isolated: another tenant\'s key sees nothing', async () => {
    const { postId } = (await draft('rss:post-3')).json;
    assert.equal((await call('GET', `/v1/posts/${postId}`, { key: keys.other })).status, 404);
    assert.deepEqual((await call('GET', '/v1/posts', { key: keys.other })).json.posts, []);
    const r = await call('POST', '/v1/drafts', { key: keys.other, body: { body: 'x', targets: [{ channelId: ch.x }] } });
    assert.deepEqual([r.status, r.json.error], [422, 'unknown_channel']);
  });

  it('bad input is a 4xx, never a 500', async () => {
    assert.equal((await call('POST', '/v1/drafts', { body: { body: 'x', targets: [] } })).status, 400);
    assert.equal((await call('POST', '/v1/drafts', { body: { body: 'x', targets: [{ provider: 'tiktok' }] } })).status, 422);
    assert.equal((await call('GET', '/v1/posts/not-a-uuid')).status, 404);
    assert.equal((await call('GET', '/v1/posts?status=bogus')).status, 400);
    const res = await fetch(`${api.url}/v1/drafts`, { method: 'POST', headers: { Authorization: `Bearer ${keys.full}` }, body: '{oops' });
    assert.equal(res.status, 400);
  });

  it('refuses to bind to all interfaces without an explicit opt-in', async () => {
    await assert.rejects(startInternalApi({ db: env.app, registry: defaultRegistry() }, { host: '0.0.0.0', port: 0 }), /all interfaces/);
  });
});
