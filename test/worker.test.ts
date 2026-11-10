// End to end against PGlite + a mocked LinkedIn: approve -> schedule -> scheduler tick -> worker -> provider.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withTenant } from '../src/db/db.ts';
import { decideApproval, rehashPost, requestApproval, schedulePost } from '../src/approval/gate.ts';
import { envSecretResolver } from '../src/credentials/secrets.ts';
import { defaultRegistry } from '../src/providers/registry.ts';
import { memoryTracer } from '../src/telemetry/tracer.ts';
import { createWorker } from '../src/worker/worker.ts';
import { freshDb, mockServer, TENANT_A } from './helpers.ts';
import { one, seedPost, seedTenant } from './fixtures.ts';

type Server = ReturnType<typeof mockServer>;

async function setup(opts: Parameters<typeof seedPost>[2] & { scheduledAgoMs?: number; media?: boolean; secrets?: Record<string, string> } = {}) {
  const env = await freshDb();
  await seedTenant(env.db, TENANT_A, 'tenant-a');
  let mediaIds: string[] = [];
  if (opts.media) {
    mediaIds = [(await env.db.query<{ id: string }>(
      `insert into social.media_assets (tenant_id, kind, mime, size_bytes, sha256, storage_key, alt_text)
       values ($1, 'image', 'image/png', 4, 'x', 'tenant-a/img.png', 'diagram') returning id`, [TENANT_A])).rows[0]!.id];
  }
  const s = await seedPost(env.db, TENANT_A, { ...opts, mediaIds });
  const asApp = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(env.app, TENANT_A, fn);
  const approveAndSchedule = async () => {
    const r = await asApp((tx) => requestApproval(tx, { tenantId: TENANT_A, postId: s.postId, requestedBy: 'u-author', via: ['chat'] }));
    await asApp((tx) => decideApproval(tx, { tenantId: TENANT_A, token: r.token, decision: 'approved', actor: 'u-boss', via: 'chat' }));
    await asApp((tx) => schedulePost(tx, s.postId, new Date(Date.now() - (opts.scheduledAgoMs ?? 60_000))));
  };
  const server = mockServer();
  const { tracer, spans } = memoryTracer();
  const makeWorker = () => createWorker({
    db: env.worker, registry: defaultRegistry(), http: server.http, tracer, workerId: 'w1',
    credentials: { secrets: envSecretResolver(opts.secrets ?? { LINKEDIN_MEMBER_TOKEN: 'member-token' }) },
    storage: { read: async (key) => { assert.equal(key, 'tenant-a/img.png'); return new Uint8Array([1, 2, 3, 4]); } },
    now: () => new Date(), sleep: async () => {}, random: () => 0.5,
  });
  const target = () => one<{ status: string; external_id: string | null; last_error: any; attempts: number }>(env.db,
    'select status, external_id, last_error, attempts from social.post_targets where id = $1', [s.targetId]);
  const post = () => one<{ status: string }>(env.db, 'select status from social.posts where id = $1', [s.postId]);
  const events = async () => (await env.db.query<{ type: string }>('select type from social.events order by id')).rows.map((r) => r.type);
  const jobs = async () => (await env.db.query<{ kind: string; status: string; run_at: Date }>('select kind, status, run_at from social.jobs order by id')).rows;
  const dueNow = () => env.db.query(`update social.jobs set run_at = now() - interval '1 second' where status = 'queued'`);
  const posts = (srv: Server) => srv.find('POST', /\/rest\/posts$/);
  return { ...env, s, asApp, approveAndSchedule, server, spans, w: makeWorker(), target, post, events, jobs, dueNow, posts };
}

describe('worker: publish_target end to end (LinkedIn personal, mocked)', () => {
  it('publishes an approved, due post exactly once, with media, outbox event and audit row', async () => {
    const t = await setup({ media: true });
    t.server
      .on('POST', /images\?action=initializeUpload$/, { json: { value: { uploadUrl: 'https://upload.test/i', image: 'urn:li:image:1' } } })
      .on('PUT', /upload\.test\/i$/, { status: 201 })
      .on('POST', /\/rest\/posts$/, { status: 201, headers: { 'x-restli-id': 'urn:li:share:100' } });
    await t.approveAndSchedule();

    const r = await t.w.tick();
    assert.equal(r.enqueued, 1);
    assert.deepEqual(r.ran.map((x) => [x.kind, x.outcome]), [['publish_target', 'done']]);
    const tg = await t.target();
    assert.equal(tg.status, 'published');
    assert.equal(tg.external_id, 'urn:li:share:100');
    assert.equal((await t.post()).status, 'published');
    assert.equal(t.posts(t.server)[0]!.headers.Authorization, 'Bearer member-token');
    assert.deepEqual((t.posts(t.server)[0]!.body as any).content, { media: { id: 'urn:li:image:1', altText: 'diagram' } });
    assert.ok((await t.events()).includes('post_target.published'));
    const audit = await one<{ actor: string; action: string }>(t.db, `select actor, action from social.audit_log where action = 'post_target.published'`);
    assert.equal(audit.actor, 'system:worker');
    assert.ok(t.spans.some((s) => s.name === 'social.job publish_target' && s.attrs.outcome === 'done'));
    assert.ok(!JSON.stringify(t.spans).includes('member-token'));

    // Idempotency: another tick, a duplicate enqueue, and a forced re-run do not post again.
    assert.deepEqual((await t.w.tick()).ran, []);
    const job = { id: '0', tenant_id: TENANT_A, kind: 'publish_target', idempotency_key: 'x', payload: { post_target_id: t.s.targetId }, attempts: 1, max_attempts: 6, run_at: new Date() };
    assert.equal((await (await import('../src/worker/publish.ts')).publishTarget(job, {
      db: t.worker, registry: defaultRegistry(), http: t.server.http, tracer: memoryTracer().tracer, workerId: 'w9',
      credentials: { secrets: envSecretResolver({}) }, storage: { read: async () => new Uint8Array() }, now: () => new Date(), sleep: async () => {},
    })).status, 'done');
    assert.equal(t.posts(t.server).length, 1);
  });

  it('429 is retried after Retry-After, then succeeds', async () => {
    const t = await setup();
    t.server
      .on('POST', /\/rest\/posts$/, { status: 429, headers: { 'retry-after': '600' }, json: { message: 'throttled' } }, 1)
      .on('POST', /\/rest\/posts$/, { status: 201, headers: { 'x-restli-id': 'urn:li:share:2' } });
    await t.approveAndSchedule();
    assert.equal((await t.w.tick()).ran[0]!.outcome, 'retry');
    assert.equal((await t.target()).status, 'queued');
    const [j] = await t.jobs();
    assert.equal(j!.status, 'queued');
    assert.ok(new Date(j!.run_at).getTime() - Date.now() > 590_000, 'waits at least Retry-After');
    assert.deepEqual((await t.w.tick()).ran, [], 'not due yet');
    await t.dueNow();
    assert.equal((await t.w.tick()).ran[0]!.outcome, 'done');
    assert.equal((await t.target()).external_id, 'urn:li:share:2');
    assert.equal(t.posts(t.server).length, 2);
  });

  it('unknown outcome (5xx on create) is never re-posted blind: personal -> needs_attention', async () => {
    const t = await setup();
    t.server.on('POST', /\/rest\/posts$/, { status: 503 });
    await t.approveAndSchedule();
    assert.equal((await t.w.tick()).ran[0]!.outcome, 'retry');
    assert.equal((await t.target()).status, 'publishing');
    await t.dueNow();
    assert.equal((await t.w.tick()).ran[0]!.outcome, 'dead');
    const tg = await t.target();
    assert.equal(tg.status, 'needs_attention');
    assert.match(tg.last_error.reason, /cannot be looked up/);
    assert.equal(t.posts(t.server).length, 1, 'exactly one create call');
    assert.ok((await t.events()).includes('post_target.needs_attention'));
  });

  it('unknown outcome on a page is reconciled by looking the post up', async () => {
    const t = await setup({ provider: 'linkedin_page', kind: 'page', externalId: 'urn:li:organization:42', envRef: 'LINKEDIN_PAGE_TOKEN',
      secrets: { LINKEDIN_PAGE_TOKEN: 'page-token' } });
    t.server
      .on('POST', /\/rest\/posts$/, { status: 504 })
      .on('GET', /rest\/posts\?q=author/, { json: { elements: [{ id: 'urn:li:share:55', commentary: 'Hello from Acme' }] } });
    await t.approveAndSchedule();
    await t.w.tick();
    await t.dueNow();
    assert.equal((await t.w.tick()).ran[0]!.outcome, 'done');
    assert.equal((await t.target()).external_id, 'urn:li:share:55');
    assert.equal(t.posts(t.server).length, 1);
  });

  it('401 marks the channel needs_reconnect and stops', async () => {
    const t = await setup();
    t.server.on('POST', /\/rest\/posts$/, { status: 401, json: { message: 'Invalid access token' } });
    await t.approveAndSchedule();
    assert.equal((await t.w.tick()).ran[0]!.outcome, 'dead');
    assert.equal((await one<{ status: string }>(t.db, 'select status from social.channels where id = $1', [t.s.channelId])).status, 'needs_reconnect');
    assert.equal((await t.target()).status, 'needs_attention');
    assert.equal((await t.post()).status, 'failed');
    assert.ok((await t.events()).includes('channel.needs_reconnect'));
  });

  it('a missing token variable parks the target instead of leaving it queued', async () => {
    const t = await setup({ secrets: {} });
    await t.approveAndSchedule();
    assert.equal((await t.w.tick()).ran[0]!.outcome, 'dead');
    assert.equal((await t.target()).status, 'needs_attention');
    assert.equal(t.server.calls.length, 0);
  });

  it('content edited after the job was queued: the worker re-checks the gate and does not post', async () => {
    const t = await setup();
    t.server.on('POST', /\/rest\/posts$/, { status: 201, headers: { 'x-restli-id': 'urn:li:share:9' } });
    await t.approveAndSchedule();
    await t.db.query(`select social.enqueue_due_publishes()`);
    await t.asApp(async (tx) => {
      await tx.query(`update social.posts set body = 'edited after approval', content_hash = null where id = $1`, [t.s.postId]);
      await rehashPost(tx, t.s.postId);
    });
    assert.equal((await t.w.tick()).ran[0]!.outcome, 'dead');
    assert.equal((await t.target()).status, 'needs_attention');
    assert.equal(t.server.calls.length, 0);
  });

  it('missed publishing window -> needs_attention, no job, no post', async () => {
    const t = await setup({ scheduledAgoMs: 7 * 3_600_000 });
    await t.approveAndSchedule();
    const r = await t.w.tick();
    assert.equal(r.enqueued, 0);
    assert.equal((await t.target()).status, 'needs_attention');
    assert.equal((await t.target()).last_error.kind, 'missed_window');
    assert.equal(t.server.calls.length, 0);
  });

  it('first comment runs as its own job, in plain text', async () => {
    const t = await setup({ settings: { firstComment: 'Full article (free): https://www.example.com/blog/x' } });
    t.server
      .on('POST', /\/rest\/posts$/, { status: 201, headers: { 'x-restli-id': 'urn:li:share:7' } })
      .on('POST', /socialActions\/urn%3Ali%3Ashare%3A7\/comments$/, { status: 201, headers: { 'x-restli-id': 'urn:li:comment:(urn:li:activity:7,1)' } });
    await t.approveAndSchedule();
    const r = await t.w.tick();
    assert.deepEqual(r.ran.map((x) => x.kind), ['publish_target']);
    const r2 = await t.w.tick();
    assert.deepEqual(r2.ran.map((x) => [x.kind, x.outcome]), [['first_comment', 'done']]);
    const c = t.server.find('POST', /comments$/)[0]!;
    assert.equal((c.body as any).message.text, 'Full article (free): https://www.example.com/blog/x');
    assert.ok((await t.events()).includes('post_target.first_comment'));
  });
});
