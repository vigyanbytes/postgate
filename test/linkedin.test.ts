import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProviderError } from '../src/providers/errors.ts';
import { LINKEDIN_VERSION_SUNSET, linkedinPage, linkedinPersonal } from '../src/providers/linkedin/index.ts';
import { toCommentary } from '../src/providers/linkedin/text.ts';
import { defaultRegistry } from '../src/providers/registry.ts';
import type { PublishRequest } from '../src/providers/types.ts';
import { ctxFor, mockServer } from './helpers.ts';

const req = (over: Partial<PublishRequest> = {}): PublishRequest =>
  ({ idempotencyKey: 'k1', text: 'Hello LinkedIn', media: [], settings: {}, ...over });
const created = (urn: string) => ({ status: 201, headers: { 'x-restli-id': urn } });
const rejects = async (p: Promise<unknown>, kind: ProviderError['kind']) => {
  await assert.rejects(p, (e: unknown) => e instanceof ProviderError && e.kind === kind);
};

describe('linkedin: registry and connect', () => {
  it('registers personal and page with separate scope sets (never org scopes on a personal connect)', () => {
    const reg = defaultRegistry();
    assert.deepEqual(reg.list().map((p) => p.id), ['linkedin', 'linkedin_page', 'facebook_page', 'instagram', 'x', 'youtube']);
    assert.deepEqual(linkedinPersonal.auth.scopes, ['openid', 'profile', 'w_member_social']);
    assert.ok(linkedinPage.auth.scopes.includes('w_organization_social'));
    const url = new URL(linkedinPersonal.authorizeUrl({ clientId: 'cid', redirectUri: 'https://x.test/cb', state: 's1' }));
    assert.equal(url.searchParams.get('scope'), 'openid profile w_member_social');
    assert.equal(url.searchParams.get('state'), 's1');
    assert.equal(url.searchParams.get('prompt'), null);
  });

  it('pinned LinkedIn-Version is not within 60 days of its sunset', () => {
    const daysLeft = (Date.parse(LINKEDIN_VERSION_SUNSET) - Date.now()) / 86_400_000;
    assert.ok(daysLeft > 60, `LinkedIn-Version sunsets in ${Math.floor(daysLeft)} days: bump LINKEDIN_VERSION`);
  });

  it('exchangeCode (personal): token + person URN from OpenID userinfo', async () => {
    const s = mockServer()
      .on('POST', /oauth\/v2\/accessToken$/, { json: { access_token: 'AT', expires_in: 5184000, scope: 'openid,profile,w_member_social' } })
      .on('GET', /v2\/userinfo$/, { json: { sub: 'abc123', name: 'Test Member' } });
    const out = await linkedinPersonal.exchangeCode({
      clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://x.test/cb', code: 'CODE', http: s.http,
      now: () => new Date('2026-10-19T00:00:00Z'),
    });
    assert.deepEqual(out.accounts, [{ externalId: 'urn:li:person:abc123', displayName: 'Test Member', kind: 'personal' }]);
    assert.equal(out.token.expiresAt?.toISOString(), '2026-12-18T00:00:00.000Z');
    assert.equal((s.calls[0]!.body as Record<string, string>).grant_type, 'authorization_code');
  });

  it('exchangeCode fails clearly when a scope was not granted', async () => {
    const s = mockServer().on('POST', /accessToken$/, { json: { access_token: 'AT', expires_in: 10, scope: 'openid,profile' } });
    await assert.rejects(
      linkedinPersonal.exchangeCode({ clientId: 'c', clientSecret: 's', redirectUri: 'r', code: 'x', http: s.http, now: () => new Date() }),
      /did not grant: w_member_social/,
    );
  });

  it('exchangeCode (page): lists administered organizations', async () => {
    const s = mockServer()
      .on('POST', /accessToken$/, { json: { access_token: 'AT', expires_in: 10, refresh_token: 'RT', refresh_token_expires_in: 100,
        scope: 'w_organization_social,r_organization_social,rw_organization_admin' } })
      .on('GET', /organizationAcls/, { json: { elements: [{ organization: 'urn:li:organization:42' }] } })
      .on('GET', /organizations\/42$/, { json: { localizedName: 'Acme' } });
    const out = await linkedinPage.exchangeCode({ clientId: 'c', clientSecret: 's', redirectUri: 'r', code: 'x', http: s.http, now: () => new Date() });
    assert.deepEqual(out.accounts, [{ externalId: 'urn:li:organization:42', displayName: 'Acme', kind: 'page' }]);
    assert.equal(out.token.refreshToken, 'RT');
  });

  it('refresh: personal without refresh token -> reconnect; page refresh keeps the refresh token', async () => {
    const s = mockServer().on('POST', /accessToken$/, { json: { access_token: 'AT2', expires_in: 60 } });
    await rejects(linkedinPersonal.refresh({ clientId: 'c', clientSecret: 's', token: { accessToken: 'AT' }, http: s.http, now: () => new Date() }), 'reconnect');
    const t = await linkedinPage.refresh({ clientId: 'c', clientSecret: 's', token: { accessToken: 'AT', refreshToken: 'RT' }, http: s.http, now: () => new Date() });
    assert.equal(t.accessToken, 'AT2');
    assert.equal(t.refreshToken, 'RT');
  });
});

describe('linkedin: commentary text', () => {
  it('escapes little-text reserved characters and keeps hashtags clickable', () => {
    assert.equal(toCommentary('Cost (INR) is <5k> @team #AI_x'), 'Cost \\(INR\\) is \\<5k\\> \\@team {hashtag|\\#|AI}\\_x');
    assert.equal(toCommentary('#Start and #end'), '{hashtag|\\#|Start} and {hashtag|\\#|end}');
    assert.equal(toCommentary('a\\b*c~d|e{f}g[h]'), 'a\\\\b\\*c\\~d\\|e\\{f\\}g\\[h\\]');
  });
});

describe('linkedin: validate', () => {
  it('accepts text-only and rejects bad media mixes, sizes and lengths', () => {
    assert.deepEqual(linkedinPersonal.validate(req()), []);
    const codes = (r: PublishRequest) => linkedinPersonal.validate(r).map((i) => i.code);
    assert.deepEqual(codes(req({ text: 'x'.repeat(3001) })), ['too_long']);
    assert.deepEqual(codes(req({ text: '' })), ['empty']);
    assert.ok(codes(req({ media: [
      { id: 'i', kind: 'image', mime: 'image/png', sizeBytes: 10 },
      { id: 'v', kind: 'video', mime: 'video/mp4', sizeBytes: 1e6 },
    ] })).includes('mixed'));
    assert.deepEqual(codes(req({ media: [{ id: 'v', kind: 'video', mime: 'video/quicktime', sizeBytes: 1e9 }] })), ['video_type', 'video_size']);
    assert.deepEqual(codes(req({ media: [{ id: 'd', kind: 'document', mime: 'application/pdf', sizeBytes: 10 }] })), ['required']);
    assert.deepEqual(codes(req({ settings: { firstComment: 'y'.repeat(1251) } })), ['invalid']);
  });
});

describe('linkedin: publish', () => {
  it('text post: Posts API body, pinned headers, URN from x-restli-id', async () => {
    const s = mockServer().on('POST', /\/rest\/posts$/, created('urn:li:share:111'));
    const out = await linkedinPersonal.publish(ctxFor(s), req({ text: 'Launch (beta) #AI' }));
    assert.deepEqual(out, { externalId: 'urn:li:share:111', url: 'https://www.linkedin.com/feed/update/urn:li:share:111/' });
    const call = s.calls[0]!;
    assert.equal(call.headers['LinkedIn-Version'], '202610');
    assert.equal(call.headers['X-Restli-Protocol-Version'], '2.0.0');
    assert.equal(call.headers.Authorization, 'Bearer test-access-token');
    assert.deepEqual(call.body, {
      author: 'urn:li:person:abc', commentary: 'Launch \\(beta\\) {hashtag|\\#|AI}', visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
    });
  });

  it('link post becomes an article share', async () => {
    const s = mockServer().on('POST', /\/rest\/posts$/, created('urn:li:share:2'));
    await linkedinPersonal.publish(ctxFor(s), req({ linkUrl: 'https://www.example.com/blog/x', title: 'X' }));
    assert.deepEqual((s.calls[0]!.body as any).content, { article: { source: 'https://www.example.com/blog/x', title: 'X' } });
  });

  it('single image: initializeUpload -> PUT bytes -> media id with alt text', async () => {
    const s = mockServer()
      .on('POST', /images\?action=initializeUpload$/, { json: { value: { uploadUrl: 'https://upload.test/img1', image: 'urn:li:image:1' } } })
      .on('PUT', /upload\.test\/img1$/, { status: 201 })
      .on('POST', /\/rest\/posts$/, created('urn:li:share:3'));
    const bytes = new Uint8Array([9, 9, 9, 9]);
    await linkedinPage.publish(ctxFor(s, { kind: 'page', externalId: 'urn:li:organization:42' }, { m1: bytes }),
      req({ media: [{ id: 'm1', kind: 'image', mime: 'image/png', sizeBytes: 4, altText: 'chart' }] }));
    assert.deepEqual((s.calls[0]!.body as any).initializeUploadRequest, { owner: 'urn:li:organization:42' });
    assert.deepEqual(s.calls[1]!.body, bytes);
    assert.equal(s.calls[1]!.headers['Content-Type'], 'image/png');
    assert.deepEqual((s.calls[2]!.body as any).content, { media: { id: 'urn:li:image:1', altText: 'chart' } });
    assert.equal((s.calls[2]!.body as any).author, 'urn:li:organization:42');
  });

  it('several images become a multiImage post (LinkedIn-native carousel)', async () => {
    let n = 0;
    const s = mockServer()
      .on('POST', /images\?action=initializeUpload$/, () => ({ json: { value: { uploadUrl: `https://upload.test/${++n}`, image: `urn:li:image:${n}` } } }))
      .on('PUT', /upload\.test/, { status: 201 })
      .on('POST', /\/rest\/posts$/, created('urn:li:share:4'));
    const media = [1, 2, 3].map((i) => ({ id: `m${i}`, kind: 'image' as const, mime: 'image/jpeg', sizeBytes: 3 }));
    await linkedinPersonal.publish(ctxFor(s), req({ media }));
    assert.deepEqual((s.find('POST', /rest\/posts$/)[0]!.body as any).content,
      { multiImage: { images: [{ id: 'urn:li:image:1' }, { id: 'urn:li:image:2' }, { id: 'urn:li:image:3' }] } });
  });

  it('video: multipart upload by instructions, finalize with ETags, wait for AVAILABLE', async () => {
    const bytes = new Uint8Array(200_000).map((_, i) => i % 251);
    let polls = 0;
    const s = mockServer()
      .on('POST', /videos\?action=initializeUpload$/, { json: { value: { video: 'urn:li:video:7', uploadToken: 'tok', uploadInstructions: [
        { uploadUrl: 'https://upload.test/p1', firstByte: 0, lastByte: 99_999 },
        { uploadUrl: 'https://upload.test/p2', firstByte: 100_000, lastByte: 199_999 },
      ] } } })
      .on('PUT', /p1$/, { status: 200, headers: { etag: 'e1' } })
      .on('PUT', /p2$/, { status: 200, headers: { etag: 'e2' } })
      .on('POST', /videos\?action=finalizeUpload$/, { status: 200 })
      .on('GET', /videos\/urn%3Ali%3Avideo%3A7$/, () => ({ json: { status: ++polls < 3 ? 'PROCESSING' : 'AVAILABLE' } }))
      .on('POST', /\/rest\/posts$/, created('urn:li:ugcPost:8'));
    const out = await linkedinPersonal.publish(ctxFor(s, {}, { v: bytes }),
      req({ title: 'Demo', media: [{ id: 'v', kind: 'video', mime: 'video/mp4', sizeBytes: bytes.byteLength }] }));
    assert.equal(out.externalId, 'urn:li:ugcPost:8');
    assert.equal((s.calls[0]!.body as any).initializeUploadRequest.fileSizeBytes, 200_000);
    assert.equal((s.find('PUT', /p2$/)[0]!.body as Uint8Array).byteLength, 100_000);
    assert.deepEqual((s.find('POST', /finalizeUpload/)[0]!.body as any).finalizeUploadRequest,
      { video: 'urn:li:video:7', uploadToken: 'tok', uploadedPartIds: ['e1', 'e2'] });
    assert.equal(polls, 3);
    assert.deepEqual((s.find('POST', /rest\/posts$/)[0]!.body as any).content, { media: { id: 'urn:li:video:7', title: 'Demo' } });
  });

  it('video processing failure is fatal', async () => {
    const s = mockServer()
      .on('POST', /videos\?action=initializeUpload$/, { json: { value: { video: 'urn:li:video:9', uploadInstructions: [
        { uploadUrl: 'https://upload.test/p', firstByte: 0, lastByte: 99_999 }] } } })
      .on('PUT', /upload\.test\/p$/, { headers: { etag: 'e' } })
      .on('POST', /finalizeUpload/, {})
      .on('GET', /videos\//, { json: { status: 'PROCESSING_FAILED' } });
    await rejects(linkedinPersonal.publish(ctxFor(s), req({ media: [{ id: 'v', kind: 'video', mime: 'video/mp4', sizeBytes: 100_000 }] })), 'fatal');
    assert.equal(s.find('POST', /rest\/posts$/).length, 0);
  });

  it('document post (PDF carousel)', async () => {
    const s = mockServer()
      .on('POST', /documents\?action=initializeUpload$/, { json: { value: { uploadUrl: 'https://upload.test/d', document: 'urn:li:document:5' } } })
      .on('PUT', /upload\.test\/d$/, { status: 201 })
      .on('POST', /\/rest\/posts$/, created('urn:li:share:6'));
    await linkedinPersonal.publish(ctxFor(s), req({ media: [{ id: 'd', kind: 'document', mime: 'application/pdf', sizeBytes: 10, title: 'Deck' }] }));
    assert.deepEqual((s.find('POST', /rest\/posts$/)[0]!.body as any).content, { media: { id: 'urn:li:document:5', title: 'Deck' } });
  });

  it('classifies failures: 401 reconnect, 429 retryable with Retry-After, 5xx on create unknown_outcome, 426 fatal, timeout unknown_outcome', async () => {
    const one = (reply: Parameters<ReturnType<typeof mockServer>['on']>[2]) =>
      linkedinPersonal.publish(ctxFor(mockServer().on('POST', /rest\/posts$/, reply)), req());
    await rejects(one({ status: 401, json: { message: 'Expired' } }), 'reconnect');
    await assert.rejects(one({ status: 429, headers: { 'retry-after': '120' } }),
      (e: unknown) => e instanceof ProviderError && e.kind === 'retryable' && e.retryAfterMs === 120_000);
    await rejects(one({ status: 503 }), 'unknown_outcome');
    await rejects(one({ status: 426, json: { message: 'NONEXISTENT_VERSION' } }), 'fatal');
    await rejects(one({ status: 422, json: { message: 'bad' } }), 'fatal');
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await rejects(one(timeout), 'unknown_outcome');
    // Upload calls are safe to retry: 5xx there is retryable, not unknown.
    const s = mockServer().on('POST', /images\?action=initializeUpload$/, { status: 502 });
    await rejects(linkedinPersonal.publish(ctxFor(s), req({ media: [{ id: 'i', kind: 'image', mime: 'image/png', sizeBytes: 1 }] })), 'retryable');
  });

  it('a 422 duplicate naming an existing URN is treated as already published', async () => {
    const s = mockServer().on('POST', /rest\/posts$/, { status: 422, json: { message: 'Content is a duplicate of urn:li:share:999', status: 422 } });
    assert.deepEqual(await linkedinPersonal.publish(ctxFor(s), req()),
      { externalId: 'urn:li:share:999', url: 'https://www.linkedin.com/feed/update/urn:li:share:999/' });
  });

  it('error messages never contain the access token', async () => {
    const s = mockServer().on('POST', /rest\/posts$/, { status: 400, json: { message: 'bad request' } });
    await assert.rejects(linkedinPersonal.publish(ctxFor(s), req()), (e: Error) => !e.message.includes('test-access-token'));
  });
});

describe('linkedin: delete, comment, reconcile', () => {
  it('delete treats 404 as already gone', async () => {
    const s = mockServer().on('DELETE', /posts\/urn%3Ali%3Ashare%3A1$/, { status: 204 }, 1).on('DELETE', /posts\//, { status: 404 });
    await linkedinPersonal.delete(ctxFor(s), 'urn:li:share:1');
    await linkedinPersonal.delete(ctxFor(s), 'urn:li:share:1');
    assert.equal(s.calls.length, 2);
  });

  it('first comment is plain text (no little-text escaping)', async () => {
    const s = mockServer().on('POST', /socialActions\/urn%3Ali%3Ashare%3A1\/comments$/, { status: 201, headers: { 'x-restli-id': 'urn:li:comment:(urn:li:activity:1,2)' } });
    const out = await linkedinPersonal.comment!(ctxFor(s), 'urn:li:share:1', 'Read more (link) #AI');
    assert.equal(out.externalId, 'urn:li:comment:(urn:li:activity:1,2)');
    assert.deepEqual(s.calls[0]!.body, { actor: 'urn:li:person:abc', object: 'urn:li:share:1', message: { text: 'Read more (link) #AI' } });
  });

  it('reconcile finds a page post by exact commentary; personal cannot reconcile', async () => {
    const s = mockServer().on('GET', /rest\/posts\?q=author/, { json: { elements: [
      { id: 'urn:li:share:1', commentary: 'other' }, { id: 'urn:li:share:2', commentary: 'Hello \\(world\\)' }] } });
    const ctx = ctxFor(s, { kind: 'page', externalId: 'urn:li:organization:42' });
    assert.deepEqual(await linkedinPage.reconcile!(ctx, req({ text: 'Hello (world)' })),
      { externalId: 'urn:li:share:2', url: 'https://www.linkedin.com/feed/update/urn:li:share:2/' });
    assert.equal(await linkedinPage.reconcile!(ctx, req({ text: 'missing' })), null);
    assert.equal(linkedinPersonal.capabilities.reconcile, false);
    await rejects(linkedinPersonal.reconcile!(ctxFor(mockServer()), req()), 'fatal');
  });
});
