// End to end, nothing leaves this machine: Postgres (PGlite, real migrations, RLS roles) + the HTTP API on 127.0.0.1
// + the CLI and MCP handlers as clients + the worker + the stand-in platform server for all six providers.
// A fetch guard fails the test if anything tries to reach a non-loopback address.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { bootstrap } from '../src/admin/bootstrap.ts';
import { startInternalApi } from '../src/api/server.ts';
import { run as cli } from '../src/cli/cli.ts';
import { apiClient } from '../src/client/api.ts';
import { envSecretResolver } from '../src/credentials/secrets.ts';
import { withTenant } from '../src/db/db.ts';
import { diskStorage } from '../src/media/storage.ts';
import { assertAgentKey, createMcpHandler } from '../src/mcp/server.ts';
import { httpClient, isLoopbackUrl, standinFetch } from '../src/providers/http.ts';
import { defaultRegistry } from '../src/providers/registry.ts';
import { createStandin, startStandinServer } from '../src/standin/standin.ts';
import { noopTracer } from '../src/telemetry/tracer.ts';
import { createWorker } from '../src/worker/worker.ts';
import { freshDb } from './helpers.ts';

const offMachine: string[] = [];
const guarded: typeof fetch = (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!isLoopbackUrl(url)) { offMachine.push(url); return Promise.reject(new Error(`network guard: ${url}`)); }
  return fetch(input, init);
};

const freePort = () => new Promise<number>((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(64).fill(7), 0xff, 0xd9]);
const MP4 = new Uint8Array(200_000).fill(3);

const TOKENS = { LI_MEMBER_TOKEN: 'standin-li-member', LI_PAGE_TOKEN: 'standin-li-page', FB_PAGE_TOKEN: 'standin-fb-page',
  IG_TOKEN: 'standin-ig', YT_TOKEN: JSON.stringify({ accessToken: 'standin-yt', refreshToken: 'standin-yt-r', expiresAt: '2099-01-01T00:00:00Z' }), X_TOKEN: 'standin-x' };
const CHANNELS = [
  ['linkedin', 'urn:li:person:standinmember', 'LI_MEMBER_TOKEN'], ['linkedin_page', 'urn:li:organization:5550001', 'LI_PAGE_TOKEN'],
  ['facebook_page', '5550002', 'FB_PAGE_TOKEN'], ['instagram', '5550003', 'IG_TOKEN'],
  ['youtube', 'UCstandin0000000000000001', 'YT_TOKEN'], ['x', '5550004', 'X_TOKEN'],
] as const;

describe('end to end against the stand-in platforms (no network)', () => {
  let env: Awaited<ReturnType<typeof freshDb>>;
  let api: Awaited<ReturnType<typeof startInternalApi>>;
  let standinSrv: Awaited<ReturnType<typeof startStandinServer>>;
  const standin = createStandin({ pullMedia: guarded });
  let ownerKey = '';
  let agentKey = '';
  let worker: ReturnType<typeof createWorker>;
  const out: string[] = [];
  const io = (key: string) => ({ env: { POSTGATE_URL: api.url, POSTGATE_KEY: key, ...TOKENS }, fetch: guarded,
    out: (s: string) => out.push(s), err: (s: string) => out.push(`ERR ${s}`), readBytes: async (p: string) => new Uint8Array(readFileSync(p)) });
  const cliJson = async (key: string, ...argv: string[]) => {
    out.length = 0;
    const code = await cli([...argv, '--json'], io(key));
    assert.equal(code, 0, out.join('\n'));
    return JSON.parse(out.join('\n'));
  };

  before(async () => {
    env = await freshDb();
    const port = await freePort();
    const dir = mkdtempSync(join(tmpdir(), 'postgate-e2e-'));
    const storage = diskStorage({ dir, publicBaseUrl: `http://127.0.0.1:${port}`, urlSecret: 'e2e-media-url-secret-0123456789' });
    api = await startInternalApi({ db: env.app, registry: defaultRegistry(), storage }, { port });
    standinSrv = await startStandinServer(standin);
    worker = createWorker({
      db: env.worker, registry: defaultRegistry(), http: httpClient(standinFetch(standinSrv.url, guarded)), storage, tracer: noopTracer,
      credentials: { secrets: envSecretResolver(TOKENS) }, workerId: 'e2e', now: () => new Date(), sleep: async () => {}, random: () => 0.5,
    });
    ownerKey = (await bootstrap(env.db, { slug: 'default', name: 'Default', owner: 'user:owner' })).key;
    writeFixtures(dir);
  });
  after(async () => { await api?.close(); await standinSrv?.close(); });

  let dir = '';
  function writeFixtures(d: string) {
    dir = d;
    for (const [n, b] of [['photo.jpg', JPEG], ['clip.mp4', MP4]] as const) writeFileSync(join(d, n), b);
  }

  let postA = '';
  let postB = '';

  it('the owner connects six channels by token variable NAME; the token value never reaches the API', async () => {
    for (const [provider, externalId, tokenEnv] of CHANNELS) {
      const r = await cliJson(ownerKey, 'channel', 'add', '--provider', provider, '--external-id', externalId, '--token-env', tokenEnv);
      assert.equal(r.tokenEnv, tokenEnv);
    }
    const ch = await cliJson(ownerKey, 'channels');
    assert.equal(ch.channels.length, 6);
    const creds = (await env.db.query<{ env_ref: string }>('select env_ref from social.channel_credentials order by env_ref')).rows.map((r) => r.env_ref);
    assert.deepEqual(creds, [...CHANNELS.map((c) => c[2])].sort());
    const dump = JSON.stringify((await env.db.query('select * from social.channel_credentials')).rows) + JSON.stringify((await env.db.query('select * from social.audit_log')).rows);
    for (const v of Object.values(TOKENS)) assert.ok(!dump.includes(v), 'no token value is stored');
    out.length = 0;
    assert.equal(await cli(['channel', 'add', '--provider', 'x', '--external-id', '1', '--token-env', 'sk-not-a-name'], io(ownerKey)), 1);
  });

  it('the owner mints an automation key; the MCP server accepts it and refuses the owner key', async () => {
    agentKey = (await cliJson(ownerKey, 'key', 'create', 'e2e-agent')).key;
    await assertAgentKey(apiClient({ baseUrl: api.url, key: agentKey, fetch: guarded }));
    await assert.rejects(assertAgentKey(apiClient({ baseUrl: api.url, key: ownerKey, fetch: guarded })), /can approve/);
    out.length = 0;
    assert.equal(await cli(['key', 'create', 'sneaky'], io(agentKey)), 1, 'an automation key cannot mint keys');
  });

  it('an agent composes through MCP: media, two drafts with per-channel variants, approval requests, a proposed time', async () => {
    const mcp = createMcpHandler(apiClient({ baseUrl: api.url, key: agentKey, fetch: guarded }), async (p) => new Uint8Array(readFileSync(p)));
    const call = async (name: string, args: object) => {
      const r: any = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
      assert.ok(!r.result.isError, r.result.content[0].text);
      return JSON.parse(r.result.content[0].text);
    };
    const init: any = await mcp({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    assert.equal(init.result.serverInfo.name, 'postgate');
    const names = ((await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as any).result.tools.map((t: any) => t.name);
    assert.ok(!names.some((n: string) => /approve|decide|publish|cancel|delete/.test(n)), `no approval/publish tool: ${names}`);

    const photo = await call('media_upload', { path: join(dir, 'photo.jpg'), altText: 'a test image' });
    const clip = await call('media_upload', { path: join(dir, 'clip.mp4'), title: 'clip' });
    const a = await call('draft_create', { body: 'Stand-in launch post #postgate', mediaIds: [photo.id], sourceRef: 'e2e:a', targets: [
      { provider: 'linkedin', bodyOverride: 'LinkedIn variant (personal) #postgate', settings: { firstComment: 'More in the comments' } },
      { provider: 'linkedin_page' }, { provider: 'facebook_page', bodyOverride: 'Facebook variant' }, { provider: 'instagram' },
      { provider: 'x', bodyOverride: 'X variant', settings: { thread: ['second post in the thread'] } }] });
    assert.equal(a.issues.flatMap((t: any) => t.issues).length, 0, JSON.stringify(a.issues));
    const again = await call('draft_create', { body: 'ignored', sourceRef: 'e2e:a', targets: [{ provider: 'x' }] });
    assert.equal(again.postId, a.postId, 'sourceRef makes draft creation idempotent');
    const b = await call('draft_create', { body: 'Stand-in video description', mediaIds: [clip.id], targets: [
      { provider: 'youtube', settings: { title: 'Stand-in upload', privacyStatus: 'private' } }] });
    postA = a.postId; postB = b.postId;
    for (const id of [postA, postB]) assert.equal((await call('approval_request', { postId: id })).status, 'in_review');
    const soon = new Date(Date.now() + 1500).toISOString();
    await call('schedule_set', { postId: postA, at: soon });
    await call('schedule_set', { postId: postB, at: soon });
  });

  it('nothing publishes before a human approves, and the agent key cannot approve', async () => {
    await new Promise((r) => setTimeout(r, 1600));
    const t = await worker.tick();
    assert.deepEqual([t.enqueued, t.ran.length], [0, 0]);
    assert.equal(standin.posts.length, 0);
    out.length = 0;
    assert.equal(await cli(['approve', postA], io(agentKey)), 1);
    assert.match(out.join('\n'), /403 (missing_scope|human_required)/);
    const tenant = (await env.db.query<{ tenant_id: string }>('select tenant_id from social.posts where id = $1', [postA])).rows[0]!.tenant_id;
    await assert.rejects(withTenant(env.app, tenant, (tx) => tx.query(`update social.post_targets set status = 'queued' where post_id = $1`, [postA])),
      /not approved/, 'the database refuses to queue unapproved content');
  });

  it('after the owner approves, one worker tick publishes all six channels through the stand-ins', async () => {
    standin.fail('POST', /graph\.facebook\.com\/v24\.0\/5550002\/photos/, { status: 400, json: { error: { message: 'busy', code: 4 } } });
    for (const id of [postA, postB]) assert.equal((await cliJson(ownerKey, 'approve', id)).postStatus, 'scheduled');
    let r = await worker.tick();
    assert.equal(r.enqueued, 6);
    const pa = await cliJson(ownerKey, 'post', postA);
    const fb = pa.targets.find((x: any) => x.provider === 'facebook_page');
    assert.equal(fb.status, 'queued', 'a rate-limited Facebook call goes back to the queue');
    await env.db.query(`update social.jobs set run_at = now() - interval '1 second' where status = 'queued'`);
    r = await worker.tick();
    await env.db.query(`update social.jobs set run_at = now() - interval '1 second' where status = 'queued'`);
    await worker.tick();
    const done = await cliJson(ownerKey, 'post', postA);
    assert.equal(done.status, 'published', JSON.stringify(done.targets));
    assert.equal((await cliJson(ownerKey, 'post', postB)).status, 'published');
    const by = (p: string) => standin.posts.filter((x) => x.provider === p && !x.deleted);
    assert.equal(by('linkedin').length, 2);
    assert.ok(by('linkedin').some((x) => x.text.includes('LinkedIn variant') && x.comments.includes('More in the comments')), 'variant + first comment');
    assert.equal(by('facebook')[0]!.text, 'Facebook variant');
    assert.equal(by('instagram').length, 1);
    assert.deepEqual(by('x').map((x) => x.text).sort(), ['X variant', 'second post in the thread']);
    assert.equal(by('youtube')[0]!.text, 'Stand-in upload');
    assert.ok(standin.pulled.length >= 2 && standin.pulled.every((p) => p.status === 200 && p.bytes === JPEG.length), 'Meta pulled the image from the signed URL');
    assert.deepEqual(offMachine, [], 'nothing tried to leave this machine');
  });

  it('an expired signed media URL is refused', async () => {
    const r = await guarded(`${api.url}/media/00000000-0000-4000-8000-000000000000/${'a'.repeat(64)}.jpg?exp=1&sig=x`);
    assert.equal(r.status, 404);
  });

  it('unpublish removes the live copies again (Instagram cannot, and says so)', async () => {
    const q = await cliJson(ownerKey, 'unpublish', postA);
    assert.equal(q.queued, 5);
    await worker.tick();
    // Left live: Instagram (no delete API) and the X thread reply (only the head post is ours to track).
    assert.deepEqual(standin.posts.filter((p) => p.provider !== 'youtube' && !p.deleted).map((p) => `${p.provider}:${p.text}`).sort(),
      ['instagram:Stand-in launch post #postgate', 'x:second post in the thread']);
    const ev = (await env.db.query<{ type: string }>(`select type from social.events where type like 'post_target.delete%'`)).rows.map((r) => r.type).sort();
    assert.deepEqual(ev, ['post_target.delete_failed', 'post_target.deleted', 'post_target.deleted', 'post_target.deleted', 'post_target.deleted']);
  });
});
