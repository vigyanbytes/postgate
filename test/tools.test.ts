// doctor (dry run + live check against the stand-in), the OAuth helper, signed media URLs and the MCP protocol edges.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { run as cli } from '../src/cli/cli.ts';
import { doctor, whoami } from '../src/doctor/doctor.ts';
import { diskStorage } from '../src/media/storage.ts';
import { createMcpHandler } from '../src/mcp/server.ts';
import { oauthConnect } from '../src/oauth/connect.ts';
import { httpClient, standinFetch } from '../src/providers/http.ts';
import { defaultRegistry } from '../src/providers/registry.ts';
import { createStandin, inProcessFetch, startStandinServer } from '../src/standin/standin.ts';

const reg = defaultRegistry();
const JPEG = { bytes: new Uint8Array([0xff, 0xd8, 1, 2, 3]), mime: 'image/jpeg', kind: 'image' as const, name: 'a.jpg' };

describe('doctor', () => {
  it('LinkedIn: builds the exact request sequence, shows the variable NAME instead of the token, sends nothing', async () => {
    const r = await doctor({ provider: 'linkedin', externalId: 'urn:li:person:abc', tokenEnv: 'LI_TOKEN', env: { LI_TOKEN: 'super-secret-value' },
      post: { text: 'Hello #world', media: [JPEG] }, now: new Date('2026-11-10T00:00:00Z') }, reg);
    assert.equal(r.ok, true, JSON.stringify(r.checks));
    assert.deepEqual(r.requests.map((q) => `${q.method} ${q.url.split('?')[0]}`), [
      'POST https://api.linkedin.com/rest/images', 'PUT https://www.linkedin.com/dms-uploads/image/1001', 'POST https://api.linkedin.com/rest/posts']);
    const createPost = r.requests[2]!;
    assert.equal(createPost.headers.authorization, 'Bearer <value of $LI_TOKEN>');
    assert.equal(createPost.headers['linkedin-version'], '202610');
    assert.equal((createPost.body as any).commentary, 'Hello {hashtag|\\#|world}');
    assert.ok(!JSON.stringify(r).includes('super-secret-value'), 'the token never appears');
  });

  it('flags a missing token, a bad account id, invalid content and a missing public media URL for Instagram', async () => {
    const r = await doctor({ provider: 'instagram', externalId: 'not-numeric', tokenEnv: 'IG_TOKEN', env: {},
      post: { text: 'caption', media: [{ ...JPEG, mime: 'image/png' }] } }, reg);
    assert.equal(r.ok, false);
    const lv = Object.fromEntries(r.checks.map((c) => [c.name, c.level]));
    assert.equal(lv.token, 'fail');
    assert.equal(lv['account id'], 'warn');
    assert.equal(lv['public media url'], 'fail');
    assert.equal(lv['post media'], 'fail');
  });

  it('an expired, non-refreshable token fails; every provider has a dry run that passes with valid input', async () => {
    const expired = JSON.stringify({ accessToken: 'x', expiresAt: '2026-01-01T00:00:00Z' });
    const r = await doctor({ provider: 'linkedin', externalId: 'urn:li:person:abc', tokenEnv: 'T', env: { T: expired }, post: { text: 'hi' } }, reg);
    assert.match(r.checks.find((c) => c.name === 'token')!.detail, /EXPIRED/);
    const env = { T: 't', POSTGATE_PUBLIC_URL: 'https://media.example.com', POSTGATE_MEDIA_URL_SECRET: 'x'.repeat(20) };
    const video = { bytes: new Uint8Array(100_000), mime: 'video/mp4', kind: 'video' as const };
    const cases = [['linkedin_page', 'urn:li:organization:1', {}, []], ['facebook_page', '123', {}, [JPEG]], ['instagram', '123', {}, [JPEG]],
      ['youtube', 'UCabcdefghijklmnopqrstuv', { title: 'A video' }, [video]], ['x', '42', {}, []]] as const;
    for (const [provider, externalId, settings, media] of cases) {
      const d = await doctor({ provider, externalId, tokenEnv: 'T', env, post: { text: 'hello', settings: { ...settings }, media: [...media] } }, reg);
      assert.equal(d.ok, true, `${provider}: ${JSON.stringify(d.checks)}`);
      assert.ok(d.requests.length >= 1);
    }
  });

  it('--live whoami: one read-only GET, and it notices a token for a different account', async () => {
    const s = createStandin();
    const http = httpClient(inProcessFetch(s));
    const ok = await whoami('x', '5550004', 'tok', http);
    assert.deepEqual([ok.ok, ok.matches], [true, true]);
    const other = await whoami('x', '999', 'tok', http);
    assert.equal(other.matches, false);
    assert.deepEqual(s.calls.map((c) => c.method), ['GET', 'GET']);
    s.revoked.add('bad');
    assert.equal((await whoami('x', '5550004', 'bad', http)).ok, false);
  });

  it('the CLI prints the plan and exits 0, or 1 when something fails', async () => {
    const out: string[] = [];
    const io = { env: { T: 'tok' }, fetch: (() => { throw new Error('no network'); }) as any, out: (s: string) => out.push(s), err: (s: string) => out.push(s),
      readBytes: async () => JPEG.bytes };
    assert.equal(await cli(['doctor', '--provider', 'x', '--external-id', '42', '--token-env', 'T', '--text', 'hi'], io), 0);
    assert.match(out.join('\n'), /NOTHING is sent[\s\S]*POST https:\/\/api\.x\.com\/2\/tweets/);
    assert.equal(await cli(['doctor', '--provider', 'x', '--external-id', '42', '--token-env', 'MISSING'], io), 1);
  });
});

describe('oauth helper', () => {
  it('runs the loopback flow (PKCE for X) and writes 0600 token files without printing tokens', async () => {
    const s = createStandin();
    const out = mkdtempSync(join(tmpdir(), 'postgate-oauth-'));
    let authorize = '';
    const p = oauthConnect({ provider: 'x', registry: reg, env: { X_CLIENT_ID: 'cid', X_CLIENT_SECRET: 'csecret' }, http: httpClient(inProcessFetch(s)),
      outDir: out, port: 0, onAuthorizeUrl: (u) => { authorize = u; } });
    while (!authorize) await new Promise((r) => setTimeout(r, 5));
    const u = new URL(authorize);
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    const cb = new URL(u.searchParams.get('redirect_uri')!);
    assert.equal(cb.hostname, '127.0.0.1');
    const refused = assert.rejects(p, /state mismatch/);
    const bad = await fetch(`${cb}?code=c&state=wrong`);
    assert.equal(bad.status, 400);
    await refused;

    let auth2 = '';
    const p2 = oauthConnect({ provider: 'facebook_page', registry: reg, env: { META_APP_ID: 'a', META_APP_SECRET: 'b' }, http: httpClient(inProcessFetch(s)),
      outDir: out, port: 0, onAuthorizeUrl: (u2) => { auth2 = u2; } });
    while (!auth2) await new Promise((r) => setTimeout(r, 5));
    const u2 = new URL(auth2);
    await fetch(`${u2.searchParams.get('redirect_uri')}?code=c&state=${u2.searchParams.get('state')}`);
    const r = await p2;
    assert.equal(r.files.length, 1);
    assert.equal(r.files[0]!.externalId, '5550002');
    assert.equal(statSync(r.files[0]!.path).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(r.files[0]!.path, 'utf8')).accessToken, 'standin-page-token', 'the PAGE token, not the user token');
  });

  it('refuses to start without the app credentials', async () => {
    await assert.rejects(oauthConnect({ provider: 'youtube', registry: reg, env: {}, http: httpClient(), outDir: '/nonexistent', onAuthorizeUrl: () => {} }),
      /GOOGLE_CLIENT_ID/);
  });
});

describe('media storage', () => {
  it('content-addressed save/read; signed URLs verify, expire and resist tampering', async () => {
    let t = new Date('2026-11-10T00:00:00Z');
    const st = diskStorage({ dir: mkdtempSync(join(tmpdir(), 'postgate-media-')), publicBaseUrl: 'https://m.example.com', urlSecret: 's'.repeat(32), now: () => t });
    const tenant = '00000000-0000-4000-8000-00000000000a';
    const a = await st.save(tenant, JPEG.bytes, 'image/jpeg');
    assert.equal((await st.save(tenant, JPEG.bytes, 'image/jpeg')).storageKey, a.storageKey);
    assert.deepEqual(await st.read(a.storageKey), JPEG.bytes);
    const url = new URL(await st.publicUrl!(a.storageKey));
    const key = url.pathname.replace(/^\/media\//, '');
    assert.ok(await st.readSigned(key, url.searchParams.get('exp'), url.searchParams.get('sig')));
    assert.equal(await st.readSigned(key, url.searchParams.get('exp'), 'x' + url.searchParams.get('sig')!.slice(1)), null);
    t = new Date(t.getTime() + 2 * 3_600_000);
    assert.equal(await st.readSigned(key, url.searchParams.get('exp'), url.searchParams.get('sig')), null);
    await assert.rejects(st.read('../../etc/passwd'), /invalid storage key/);
    await assert.rejects(st.save(tenant, JPEG.bytes, 'text/html'), /unsupported/);
    assert.equal(diskStorage({ dir: '/tmp' }).publicUrl, undefined, 'no public URLs without base + secret');
  });
});

describe('stand-in mode', () => {
  it('only rewrites to loopback, and the stand-in server answers like the platform', async () => {
    assert.throws(() => standinFetch('https://api.example.com'), /loopback/);
    const s = createStandin();
    const srv = await startStandinServer(s);
    try {
      const http = httpClient(standinFetch(srv.url));
      const r = await http.request({ method: 'POST', url: 'https://api.x.com/2/tweets', headers: { Authorization: 'Bearer t', 'content-type': 'application/json' }, body: '{"text":"hi"}' });
      assert.equal(r.status, 201);
      assert.equal(s.posts[0]!.text, 'hi');
      assert.equal((await http.request({ url: 'https://api.x.com/2/users/me' })).status, 401, 'no token, no answer');
    } finally { await srv.close(); }
  });
});

describe('mcp protocol', () => {
  const mcp = createMcpHandler(async (m, p) => ({ m, p }));
  it('answers initialize/ping/list, rejects unknown methods and bad arguments, ignores notifications', async () => {
    assert.equal(((await mcp({ jsonrpc: '2.0', id: 1, method: 'ping' })) as any).result !== undefined, true);
    assert.equal(((await mcp({ jsonrpc: '2.0', id: 2, method: 'nope' })) as any).error.code, -32601);
    assert.equal(await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    const bad: any = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'post_get', arguments: { postId: 'x' } } });
    assert.equal(bad.result.isError, true);
    const extra: any = await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'approval_request', arguments: { postId: '00000000-0000-4000-8000-000000000001', decision: 'approved' } } });
    assert.match(extra.result.content[0].text, /unknown argument decision/);
    const ok: any = await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'posts_list', arguments: { status: 'draft' } } });
    assert.deepEqual(JSON.parse(ok.result.content[0].text), { m: 'GET', p: '/v1/posts' });
  });
});
