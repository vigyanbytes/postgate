import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { youtube } from '../src/providers/youtube/index.ts';
import type { PublishRequest } from '../src/providers/types.ts';
import { ctxFor, mockServer } from './helpers.ts';

const video = { id: 'v', kind: 'video' as const, mime: 'video/mp4', sizeBytes: 3 };
const req = (p: Partial<PublishRequest> = {}): PublishRequest =>
  ({ idempotencyKey: 'k', text: 'What the product does, in 60 seconds.', media: [video], settings: { title: 'Product in 60s' }, ...p });
const yctx = (s: ReturnType<typeof mockServer>) => ctxFor(s, { kind: 'page', externalId: 'UC123' });

describe('youtube: validate', () => {
  it('exactly one video, a title, no angle brackets, tag budget, privacy values', () => {
    const codes = (r: Partial<PublishRequest>) => youtube.validate(req(r)).map((i) => i.code);
    assert.deepEqual(codes({}), []);
    assert.ok(codes({ media: [] }).includes('media_required'));
    assert.ok(codes({ settings: {} }).includes('required'));
    assert.ok(codes({ text: 'a <b> c' }).includes('angle_brackets'));
    assert.ok(codes({ settings: { title: 't', tags: Array.from({ length: 60 }, () => 'longertag') } }).includes('too_long'));
    assert.ok(codes({ settings: { title: 't', privacyStatus: 'friends' } }).includes('invalid'));
    assert.ok(codes({ settings: { title: 't'.repeat(101) } }).includes('too_long'));
  });

  it('community posts are refused honestly (no public API)', () => {
    const [i] = youtube.validate(req({ media: [], settings: { youtubeType: 'community' } }));
    assert.equal(i!.code, 'unsupported');
    assert.match(i!.message, /no public API/);
  });
});

describe('youtube: publish', () => {
  it('resumable upload: session with metadata (private by default), then bytes; Shorts tag + URL', async () => {
    const s = mockServer()
      .on('POST', /upload\/youtube\/v3\/videos\?uploadType=resumable/, { headers: { location: 'https://upload.test/session/1' } })
      .on('PUT', /upload\.test\/session\/1$/, { json: { id: 'VID1' } });
    const out = await youtube.publish(yctx(s), req({ settings: { title: 'Product in 60s', shorts: true, tags: ['AI agents'] } }));
    assert.deepEqual(out, { externalId: 'VID1', url: 'https://www.youtube.com/shorts/VID1', notes: { privacyStatus: 'private' } });
    const meta = s.calls[0]!.body as any;
    assert.equal(meta.snippet.title, 'Product in 60s #Shorts');
    assert.equal(meta.status.privacyStatus, 'private');
    assert.equal(meta.status.selfDeclaredMadeForKids, false);
    assert.equal(meta.snippet.categoryId, '28');
    assert.equal(s.calls[0]!.headers['X-Upload-Content-Length'], '3');
  });

  it('quota errors are retryable; 5xx on the byte upload is unknown_outcome; 401 reconnect', async () => {
    const s1 = mockServer().on('POST', /resumable/, { status: 403, json: { error: { message: 'quota', errors: [{ reason: 'quotaExceeded' }] } } });
    await assert.rejects(youtube.publish(yctx(s1), req()), (e: any) => e.kind === 'retryable' && e.code === 'quotaExceeded');
    const s2 = mockServer().on('POST', /resumable/, { headers: { location: 'https://upload.test/s' } }).on('PUT', /upload\.test\/s$/, { status: 503, json: {} });
    await assert.rejects(youtube.publish(yctx(s2), req()), (e: any) => e.kind === 'unknown_outcome');
    const s3 = mockServer().on('POST', /resumable/, { status: 401, json: { error: { message: 'Invalid Credentials' } } });
    await assert.rejects(youtube.publish(yctx(s3), req()), (e: any) => e.kind === 'reconnect');
  });

  it('reconcile finds my recent upload by title', async () => {
    const s = mockServer().on('GET', /search\?part=snippet&forMine=true/, { json: { items: [{ id: { videoId: 'VID9' }, snippet: { title: 'Product in 60s' } }] } });
    assert.equal((await youtube.reconcile!(yctx(s), req()))?.externalId, 'VID9');
  });

  it('refresh keeps the stored refresh token when Google omits it', async () => {
    const s = mockServer().on('POST', /oauth2\.googleapis\.com\/token$/, { json: { access_token: 'at2', expires_in: 3599 } });
    const t = await youtube.refresh({ clientId: 'c', clientSecret: 's', token: { accessToken: 'at', refreshToken: 'rt' }, http: s.http, now: () => new Date(0) });
    assert.deepEqual([t.accessToken, t.refreshToken], ['at2', 'rt']);
  });

  it('authorize asks for offline access with consent (or no refresh token comes back)', () => {
    const u = new URL(youtube.authorizeUrl({ clientId: 'c', redirectUri: 'https://r', state: 's' }));
    assert.equal(u.searchParams.get('access_type'), 'offline');
    assert.equal(u.searchParams.get('prompt'), 'consent');
  });
});
