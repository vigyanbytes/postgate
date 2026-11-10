// Facebook Page + Instagram (Instagram Login) on a mocked Graph API.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { facebookPage } from '../src/providers/facebook/index.ts';
import { instagram } from '../src/providers/instagram/index.ts';
import { META_GRAPH_SUNSET } from '../src/providers/meta/graph.ts';
import type { MediaItem, ProviderContext, PublishRequest } from '../src/providers/types.ts';
import { ctxFor, mockServer } from './helpers.ts';

const req = (p: Partial<PublishRequest> = {}): PublishRequest => ({ idempotencyKey: 'k', text: 'Hello Meta', media: [], settings: {}, ...p });
const jpg = (id: string): MediaItem => ({ id, kind: 'image', mime: 'image/jpeg', sizeBytes: 1000 });
const mp4 = (id: string): MediaItem => ({ id, kind: 'video', mime: 'video/mp4', sizeBytes: 1_000_000 });

function withUrls(ctx: ProviderContext): ProviderContext {
  return { ...ctx, media: { ...ctx.media, publicUrl: async (id) => `https://media.test/${id}?sig=x` } };
}
const fb = (s: ReturnType<typeof mockServer>) => withUrls(ctxFor(s, { kind: 'page', externalId: 'PAGE1' }, {}, { accessToken: 'page-token' }));
const ig = (s: ReturnType<typeof mockServer>) => withUrls(ctxFor(s, { kind: 'personal', externalId: 'IGU1' }, {}, { accessToken: 'ig-token', refreshToken: 'ig-token' }));

describe('meta: graph version', () => {
  it('pinned Graph version is not within 60 days of its sunset', () => {
    assert.ok(new Date(META_GRAPH_SUNSET).getTime() - Date.now() > 60 * 86_400_000, 'bump META_GRAPH_VERSION');
  });
});

describe('facebook_page', () => {
  it('text + link -> /feed with the Page token', async () => {
    const s = mockServer().on('POST', /PAGE1\/feed$/, { json: { id: 'PAGE1_55' } });
    const out = await facebookPage.publish(fb(s), req({ linkUrl: 'https://www.example.com/' }));
    assert.deepEqual(out, { externalId: 'PAGE1_55', url: 'https://www.facebook.com/PAGE1_55' });
    const c = s.calls[0]!;
    assert.equal(c.headers.Authorization, 'Bearer page-token');
    assert.deepEqual(c.body, { message: 'Hello Meta', link: 'https://www.example.com/' });
    assert.match(c.url, /graph\.facebook\.com\/v\d+\.0\//);
  });

  it('multi-image: unpublished photos staged, then one feed post attaching them', async () => {
    let n = 0;
    const s = mockServer()
      .on('POST', /PAGE1\/photos$/, () => ({ json: { id: `ph${n++}` } }))
      .on('POST', /PAGE1\/feed$/, { json: { id: 'PAGE1_9' } });
    await facebookPage.publish(fb(s), req({ media: [jpg('a'), jpg('b')] }));
    const staged = s.find('POST', /photos$/).map((c) => c.body as any);
    assert.deepEqual(staged.map((b) => [b.url, b.published]), [['https://media.test/a?sig=x', false], ['https://media.test/b?sig=x', false]]);
    assert.deepEqual((s.find('POST', /feed$/)[0]!.body as any).attached_media, [{ media_fbid: 'ph0' }, { media_fbid: 'ph1' }]);
  });

  it('video goes to graph-video with file_url; single photo returns the post id', async () => {
    const s = mockServer()
      .on('POST', /graph-video\.facebook\.com\/.*PAGE1\/videos$/, { json: { id: 'v1' } })
      .on('POST', /PAGE1\/photos$/, { json: { id: 'ph', post_id: 'PAGE1_7' } });
    assert.equal((await facebookPage.publish(fb(s), req({ media: [mp4('v')] }))).externalId, 'v1');
    assert.equal((s.calls[0]!.body as any).file_url, 'https://media.test/v?sig=x');
    assert.equal((await facebookPage.publish(fb(s), req({ media: [jpg('p')] }))).externalId, 'PAGE1_7');
  });

  it('classifies Graph errors: 190 reconnect, 32 throttled, 506 duplicate, transient on create = unknown_outcome', async () => {
    const run = async (status: number, error: object) => {
      const s = mockServer().on('POST', /feed$/, { status, json: { error } });
      return facebookPage.publish(fb(s), req()).then(() => null, (e) => [e.kind, e.code]);
    };
    assert.deepEqual(await run(400, { code: 190, message: 'expired' }), ['reconnect', '190']);
    assert.equal((await run(400, { code: 32, message: 'Page request limit reached' }))![0], 'retryable');
    assert.deepEqual(await run(400, { code: 506, message: 'Duplicate status message' }), ['fatal', 'duplicate']);
    assert.equal((await run(500, { code: 2, message: 'Service temporarily unavailable', is_transient: true }))![0], 'unknown_outcome');
    assert.equal((await run(400, { code: 100, message: 'Invalid parameter' }))![0], 'fatal');
  });

  it('validate: no documents, no image+video, no link with media', () => {
    const codes = facebookPage.validate(req({ linkUrl: 'https://x', media: [jpg('a'), mp4('b'), { id: 'd', kind: 'document', mime: 'application/pdf', sizeBytes: 1 }] })).map((i) => i.code);
    assert.deepEqual(codes.sort(), ['document', 'mixed', 'with_media']);
  });

  it('needs public media URLs from storage', async () => {
    const s = mockServer();
    await assert.rejects(facebookPage.publish(ctxFor(s, { externalId: 'PAGE1' }), req({ media: [jpg('a')] })), /public URLs/);
  });

  it('connect: long-lived user token -> Page tokens for Pages the user can create content on', async () => {
    const s = mockServer()
      .on('GET', /oauth\/access_token\?client_id/, { json: { access_token: 'short' } })
      .on('GET', /oauth\/access_token\?grant_type=fb_exchange_token/, { json: { access_token: 'long' } })
      .on('GET', /me\/accounts/, { json: { data: [
        { id: 'P1', name: 'Acme', access_token: 'pt1', tasks: ['CREATE_CONTENT', 'MANAGE'] },
        { id: 'P2', name: 'Read only', access_token: 'pt2', tasks: ['ANALYZE'] },
      ] } });
    const r = await facebookPage.exchangeCode({ clientId: 'c', clientSecret: 's', redirectUri: 'https://r', code: 'x', http: s.http, now: () => new Date() });
    assert.deepEqual(r.accounts.map((a) => [a.externalId, a.token?.accessToken]), [['P1', 'pt1']]);
  });

  it('reconcile finds the post by message', async () => {
    const s = mockServer()
      .on('GET', /PAGE1\/posts\?/, { json: { data: [{ id: 'PAGE1_1', message: 'Hello Meta', permalink_url: 'https://fb/1' }] } });
    assert.deepEqual(await facebookPage.reconcile!(fb(s), req()), { externalId: 'PAGE1_1', url: 'https://fb/1' });
  });
});

describe('instagram', () => {
  it('validate: media required, JPEG only, <=2200 chars, <=30 hashtags, <=10 items', () => {
    const codes = (r: Partial<PublishRequest>) => instagram.validate(req(r)).map((i) => i.code);
    assert.deepEqual(codes({}), ['media_required']);
    assert.ok(codes({ media: [{ id: 'p', kind: 'image', mime: 'image/png', sizeBytes: 1 }] }).includes('image_type'));
    assert.ok(codes({ media: [jpg('a')], text: 'x'.repeat(2201) }).includes('too_long'));
    assert.ok(codes({ media: [jpg('a')], text: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ') }).includes('too_many_hashtags'));
    assert.ok(codes({ media: Array.from({ length: 11 }, (_, i) => jpg(String(i))) }).includes('too_many_items'));
    assert.deepEqual(codes({ media: [jpg('a')] }), []);
  });

  it('single image: container -> FINISHED -> media_publish -> permalink', async () => {
    const s = mockServer()
      .on('GET', /content_publishing_limit/, { json: { data: [{ quota_usage: 3, config: { quota_total: 100 } }] } })
      .on('POST', /IGU1\/media$/, { json: { id: 'C1' } })
      .on('GET', /C1\?fields=status_code/, { json: { status_code: 'FINISHED' } })
      .on('POST', /IGU1\/media_publish$/, { json: { id: 'M1' } })
      .on('GET', /M1\?fields=permalink/, { json: { permalink: 'https://www.instagram.com/p/abc/' } });
    const out = await instagram.publish(ig(s), req({ media: [{ ...jpg('a'), altText: 'chip' }] }));
    assert.deepEqual(out, { externalId: 'M1', url: 'https://www.instagram.com/p/abc/' });
    assert.deepEqual(s.find('POST', /media$/)[0]!.body, { image_url: 'https://media.test/a?sig=x', alt_text: 'chip', caption: 'Hello Meta' });
    assert.deepEqual(s.find('POST', /media_publish$/)[0]!.body, { creation_id: 'C1' });
  });

  it('carousel: child containers (waited for), then a CAROUSEL container; Reels poll until FINISHED', async () => {
    let n = 0;
    let polls = 0;
    const s = mockServer()
      .on('GET', /content_publishing_limit/, { json: { data: [] } })
      .on('POST', /IGU1\/media$/, () => ({ json: { id: `C${n++}` } }))
      .on('GET', /\?fields=status_code/, () => ({ json: { status_code: polls++ === 0 ? 'IN_PROGRESS' : 'FINISHED' } }))
      .on('POST', /media_publish$/, { json: { id: 'M2' } })
      .on('GET', /M2\?fields=permalink/, { status: 500, json: {} });
    const out = await instagram.publish(ig(s), req({ media: [jpg('a'), mp4('b')] }));
    assert.equal(out.externalId, 'M2');
    assert.equal(out.url, undefined, 'a failed permalink lookup does not fail the publish');
    const bodies = s.find('POST', /IGU1\/media$/).map((c) => c.body as any);
    assert.deepEqual(bodies[0], { image_url: 'https://media.test/a?sig=x', is_carousel_item: true });
    assert.deepEqual(bodies[1], { media_type: 'VIDEO', video_url: 'https://media.test/b?sig=x', is_carousel_item: true });
    assert.deepEqual(bodies[2], { media_type: 'CAROUSEL', children: 'C0,C1', caption: 'Hello Meta' });
  });

  it('publishing limit reached -> retryable, nothing created', async () => {
    const s = mockServer().on('GET', /content_publishing_limit/, { json: { data: [{ quota_usage: 100, config: { quota_total: 100 } }] } });
    await assert.rejects(instagram.publish(ig(s), req({ media: [jpg('a')] })), (e: any) => e.kind === 'retryable' && e.code === 'publishing_limit');
    assert.equal(s.find('POST', /./).length, 0);
  });

  it('container ERROR is fatal; media_publish 5xx is unknown_outcome', async () => {
    const s1 = mockServer().on('GET', /limit/, { json: { data: [] } }).on('POST', /media$/, { json: { id: 'C' } })
      .on('GET', /status_code/, { json: { status_code: 'ERROR' } });
    await assert.rejects(instagram.publish(ig(s1), req({ media: [jpg('a')] })), (e: any) => e.kind === 'fatal');
    const s2 = mockServer().on('GET', /limit/, { json: { data: [] } }).on('POST', /media$/, { json: { id: 'C' } })
      .on('GET', /status_code/, { json: { status_code: 'FINISHED' } }).on('POST', /media_publish$/, { status: 503, json: { error: { code: 2 } } });
    await assert.rejects(instagram.publish(ig(s2), req({ media: [jpg('a')] })), (e: any) => e.kind === 'unknown_outcome');
  });

  it('refresh renews the long-lived token and keeps it as its own refresh handle', async () => {
    const s = mockServer().on('GET', /refresh_access_token\?grant_type=ig_refresh_token/, { json: { access_token: 'new', expires_in: 5_184_000 } });
    const t = await instagram.refresh({ clientId: 'c', clientSecret: 's', token: { accessToken: 'old', refreshToken: 'old' }, http: s.http, now: () => new Date(0) });
    assert.deepEqual([t.accessToken, t.refreshToken, t.expiresAt?.toISOString()], ['new', 'new', new Date(5_184_000_000).toISOString()]);
  });

  it('delete is not offered by the API', async () => {
    assert.equal(instagram.capabilities.delete, false);
    await assert.rejects(instagram.delete(ig(mockServer()), 'M1'), /not supported/);
  });
});
