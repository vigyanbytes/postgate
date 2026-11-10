// AI avatar video (HeyGen) end to end against the stand-in HeyGen API: no real HeyGen call, no credits spent.
// API over HTTP + CLI + worker (submit -> poll -> download -> store -> attach to the draft, which voids its approval).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { bootstrap } from '../src/admin/bootstrap.ts';
import { startInternalApi } from '../src/api/server.ts';
import { run as cli } from '../src/cli/cli.ts';
import { envSecretResolver } from '../src/credentials/secrets.ts';
import { heygen } from '../src/media/heygen.ts';
import { diskStorage } from '../src/media/storage.ts';
import { httpClient, isLoopbackUrl, standinFetch } from '../src/providers/http.ts';
import { defaultRegistry } from '../src/providers/registry.ts';
import { createStandin, startStandinServer } from '../src/standin/standin.ts';
import { noopTracer } from '../src/telemetry/tracer.ts';
import { downloadBytes } from '../src/worker/main.ts';
import { createWorker } from '../src/worker/worker.ts';
import { freshDb } from './helpers.ts';

const offMachine: string[] = [];
const guarded = ((input: string, init?: RequestInit) => {
  if (!isLoopbackUrl(String(input))) { offMachine.push(String(input)); return Promise.reject(new Error('network guard')); }
  return fetch(input, init);
}) as typeof fetch;
const HEYGEN_KEY = 'standin-heygen-key-value';

describe('avatar video through the stand-in HeyGen', () => {
  let env: Awaited<ReturnType<typeof freshDb>>;
  let api: Awaited<ReturnType<typeof startInternalApi>>;
  let srv: Awaited<ReturnType<typeof startStandinServer>>;
  const standin = createStandin();
  let owner = '';
  let agent = '';
  let mediaAgent = '';
  let worker: ReturnType<typeof createWorker>;
  const out: string[] = [];
  const io = (key: string, extra: Record<string, string> = {}) => ({ env: { POSTGATE_URL: api.url, POSTGATE_KEY: key, ...extra }, fetch: guarded,
    out: (s: string) => out.push(s), err: (s: string) => out.push(`ERR ${s}`), readBytes: async () => new Uint8Array() });
  const j = async (key: string, ...argv: string[]) => { out.length = 0; const c = await cli([...argv, '--json'], io(key)); assert.equal(c, 0, out.join('\n')); return JSON.parse(out.join('\n')); };
  const fails = async (key: string, re: RegExp, ...argv: string[]) => { out.length = 0; assert.notEqual(await cli(argv, io(key)), 0); assert.match(out.join('\n'), re); };
  const due = () => env.db.query(`update social.jobs set run_at = now() - interval '1 second' where status = 'queued'`);
  const job = async (id: string) => j(owner, 'video', 'status', id);

  before(async () => {
    env = await freshDb();
    srv = await startStandinServer(standin);
    const storage = diskStorage({ dir: mkdtempSync(join(tmpdir(), 'postgate-mj-')) });
    api = await startInternalApi({ db: env.app, registry: defaultRegistry(), storage }, { port: 0 });
    const routed = standinFetch(srv.url, guarded);
    worker = createWorker({ db: env.worker, registry: defaultRegistry(), http: httpClient(routed), storage, tracer: noopTracer, workerId: 'mj',
      credentials: { secrets: envSecretResolver({ HEYGEN_API_TOKEN: HEYGEN_KEY }) }, now: () => new Date(), sleep: async () => {}, random: () => 0.5,
      download: (u, m) => downloadBytes(routed, u, m) });
    owner = (await bootstrap(env.db, { slug: 'default', name: 'Default', owner: 'user:owner' })).key;
    await j(owner, 'channel', 'add', '--provider', 'linkedin', '--external-id', 'urn:li:person:standinmember', '--token-env', 'LI_TOKEN');
    agent = (await j(owner, 'key', 'create', 'plain-agent')).key;
    mediaAgent = (await j(owner, 'key', 'create', 'video-agent', '--scope', 'media:generate')).key;
  });
  after(async () => { await api?.close(); await srv?.close(); });

  it('needs the media:generate scope, a consent statement and a valid request; never a key value', async () => {
    await fails(agent, /403 missing_scope/, 'video', 'avatar', '--script', 'hi', '--avatar', 'a1', '--consent', 'stock avatar');
    await fails(mediaAgent, /needs --script, --avatar and --consent/, 'video', 'avatar', '--script', 'hi', '--avatar', 'a1');
    await fails(mediaAgent, /422 invalid_request: script allows 5000/, 'video', 'avatar', '--script', 'x'.repeat(5001), '--avatar', 'a1', '--consent', 'stock avatar');
    await fails(mediaAgent, /403 admin_required/, 'video', 'avatar', '--script', 'hi', '--avatar', 'a1', '--consent', 'stock avatar', '--key-env', 'OTHER_HEYGEN_KEY');
    await fails(mediaAgent, /400 bad_request: keyEnv/, 'video', 'avatar', '--script', 'hi', '--avatar', 'a1', '--consent', 'stock avatar', '--key-env', 'hg-live-abc');
    await assert.rejects(j(owner, 'key', 'create', 'x', '--scope', 'approvals:decide'), /0/);
  });

  it('script -> HeyGen v3 -> poll -> video stored and attached to the draft; the draft must be approved again', async () => {
    const d = await j(mediaAgent, 'draft', '--body', 'Our 30-second explainer', '--target', 'linkedin');
    await j(mediaAgent, 'request-approval', d.postId);
    const r = await j(mediaAgent, 'video', 'avatar', '--script', 'Hello, this is a stand-in video.', '--avatar', 'standin_look_1',
      '--voice', 'standin_voice_1', '--aspect', '9:16', '--consent', 'stock avatar', '--post', d.postId, '--title', 'Explainer');
    assert.equal(r.status, 'queued');

    await worker.tick();                                  // submit
    const create = standin.calls.find((c) => c.method === 'POST' && c.url.endsWith('/v3/videos'))!;
    assert.equal(create.headers['x-api-key'], HEYGEN_KEY, 'the key travels only in the header to the provider');
    const sent = JSON.parse(Buffer.from(create.body).toString());
    assert.deepEqual([sent.type, sent.avatar_id, sent.voice_id, sent.aspect_ratio, sent.script], ['avatar', 'standin_look_1', 'standin_voice_1', '9:16', 'Hello, this is a stand-in video.']);
    assert.equal((await job(r.id)).status, 'running');
    await due(); await worker.tick();                     // poll 1: processing
    assert.equal((await job(r.id)).polls, 1);
    await due(); await worker.tick();                     // poll 2: completed -> download -> store -> attach
    const done = await job(r.id);
    assert.equal(done.status, 'done', JSON.stringify(done));
    assert.equal(done.usage.durationSeconds, 12.5);
    const post = await j(owner, 'post', d.postId);
    assert.equal(post.status, 'draft', 'attaching media is a content change: back to draft');
    assert.equal(post.approval.status, 'superseded', 'the earlier approval request no longer applies');
    assert.deepEqual(post.mediaIds, [done.assetId]);
    const v = await j(owner, 'validate', d.postId);
    assert.deepEqual(v.issues[0].issues, [], 'the draft with the generated video is valid for LinkedIn');

    const dump = JSON.stringify((await env.db.query('select * from social.media_jobs')).rows) + JSON.stringify((await env.db.query('select * from social.audit_log')).rows)
      + JSON.stringify((await env.db.query('select * from social.events')).rows) + JSON.stringify((await env.db.query('select * from social.jobs')).rows);
    assert.ok(!dump.includes(HEYGEN_KEY), 'the HeyGen key is never stored');
    assert.deepEqual(offMachine, []);
  });

  it('a render failure, a revoked key and an unknown create outcome all fail the job for a human; a rate limit retries', async () => {
    const mk = async (script: string) => (await j(mediaAgent, 'video', 'avatar', '--script', script, '--avatar', 'standin_look_1', '--consent', 'stock avatar')).id;
    const failing = await mk('please FAIL this one');
    await worker.tick(); await due(); await worker.tick(); await due(); await worker.tick();
    assert.match(JSON.stringify((await job(failing)).error), /render_failed/);

    const before = standin.posts.length;
    standin.fail('POST', /\/v3\/videos$/, { status: 503, json: { error: { code: 'internal_error', message: 'upstream' } } });
    const unknown = await mk('unknown outcome');
    await worker.tick();
    const u = await job(unknown);
    assert.equal(u.status, 'failed');
    assert.match(u.error.detail, /not retried/);
    assert.equal(standin.posts.length, before, 'no second paid create was attempted');

    standin.fail('POST', /\/v3\/videos$/, { status: 429, headers: { 'retry-after': '1' }, json: { error: { code: 'rate_limit_exceeded', message: 'slow down' } } });
    const limited = await mk('rate limited first');
    await worker.tick();
    assert.equal((await job(limited)).status, 'queued');
    await due(); await worker.tick();
    assert.equal((await job(limited)).status, 'running');

    standin.revoked.add(HEYGEN_KEY);
    const revoked = await mk('revoked key');
    await due(); await worker.tick();
    assert.match(JSON.stringify((await job(revoked)).error), /unauthorized/);
    standin.revoked.delete(HEYGEN_KEY);
  });

  it('provider validation and the read-only listing', async () => {
    assert.deepEqual(heygen.validate({ capability: 'avatar_video', idempotencyKey: 'k', params: { script: 'hi', avatarId: 'ok_1' } }), []);
    assert.ok(heygen.validate({ capability: 'avatar_video', idempotencyKey: 'k', params: { script: '', avatarId: 'bad id!', aspectRatio: '2:1' as any } }).length >= 3);
    out.length = 0;
    assert.equal(await cli(['heygen', 'avatars'], { ...io(owner, { HEYGEN_API_TOKEN: HEYGEN_KEY }), fetch: standinFetch(srv.url, guarded) as typeof fetch }), 0);
    assert.match(out.join('\n'), /standin_look_1/);
  });
});
