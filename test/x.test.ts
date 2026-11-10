import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProviderError } from '../src/providers/errors.ts';
import { x } from '../src/providers/x/index.ts';
import { xWeightedLength } from '../src/providers/x/text.ts';
import type { PublishRequest } from '../src/providers/types.ts';
import { ctxFor, mockServer } from './helpers.ts';

const req = (p: Partial<PublishRequest> = {}): PublishRequest => ({ idempotencyKey: 'k1', text: 'Hello X', media: [], settings: {}, ...p });
const xctx = (s: ReturnType<typeof mockServer>) => ctxFor(s, { kind: 'personal', externalId: '1234' });

describe('x: text weighting', () => {
  it('counts URLs as 23, Latin/Devanagari as 1, CJK/emoji as 2', () => {
    assert.equal(xWeightedLength('abc'), 3);
    assert.equal(xWeightedLength('see https://github.com/example/project/very/long/path'), 4 + 23);
    assert.equal(xWeightedLength('नमस्ते'), [...'नमस्ते'].length); // U+0900 block is inside the light range
    assert.equal(xWeightedLength('ok 🚀'), 5);
    assert.equal(xWeightedLength('漢字'), 4);
  });
});

describe('x: validate', () => {
  it('rejects >280 weighted chars, >4 images, image+video mixes, documents and long thread items', () => {
    const img = { id: 'i', kind: 'image' as const, mime: 'image/png', sizeBytes: 10 };
    const codes = x.validate(req({
      text: 'a'.repeat(281),
      media: [img, img, img, img, img, { id: 'v', kind: 'video', mime: 'video/mp4', sizeBytes: 10 }, { id: 'd', kind: 'document', mime: 'application/pdf', sizeBytes: 1 }],
      settings: { thread: ['ok', 'b'.repeat(300)] },
    })).map((i) => i.code);
    for (const c of ['too_long', 'too_many_images', 'mixed', 'document']) assert.ok(codes.includes(c), c);
    assert.ok(x.validate(req({ settings: { thread: ['b'.repeat(300)] } })).some((i) => i.field === 'settings.thread[0]'));
    // A long URL still weighs 23: 250 + 1 + 23 = 274 fits; 258 + 1 + 23 = 282 does not.
    assert.deepEqual(x.validate(req({ text: 'x'.repeat(250) + ' https://example.com/' + 'y'.repeat(100) })), []);
    assert.deepEqual(x.validate(req({ text: 'x'.repeat(258) + ' https://example.com/' + 'y'.repeat(100) })).map((i) => i.code), ['too_long']);
  });

  it('PKCE is mandatory for authorizeUrl', () => {
    assert.throws(() => x.authorizeUrl({ clientId: 'c', redirectUri: 'https://r', state: 's' }), /PKCE/);
    const u = new URL(x.authorizeUrl({ clientId: 'c', redirectUri: 'https://r', state: 's', codeChallenge: 'abc' }));
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.match(u.searchParams.get('scope')!, /offline\.access/);
  });
});

describe('x: publish', () => {
  it('posts text, then a thread as a reply chain', async () => {
    const s = mockServer();
    let n = 0;
    s.on('POST', /\/2\/tweets$/, () => ({ status: 201, json: { data: { id: String(100 + n++) } } }));
    const out = await x.publish(xctx(s), req({ settings: { thread: ['two', 'three'] } }));
    assert.equal(out.externalId, '100');
    assert.equal(out.url, 'https://x.com/i/web/status/100');
    const bodies = s.find('POST', /tweets$/).map((c) => c.body as any);
    assert.deepEqual(bodies.map((b) => b.text), ['Hello X', 'two', 'three']);
    assert.equal(bodies[1].reply.in_reply_to_tweet_id, '100');
    assert.equal(bodies[2].reply.in_reply_to_tweet_id, '101');
    assert.equal(s.calls[0]!.headers.Authorization, 'Bearer test-access-token');
  });

  it('a failure after the head post is a note, never a throw (no double post on retry)', async () => {
    const s = mockServer()
      .on('POST', /\/2\/tweets$/, { status: 201, json: { data: { id: '1' } } }, 1)
      .on('POST', /\/2\/tweets$/, { status: 503, json: { title: 'Service Unavailable' } });
    const out = await x.publish(xctx(s), req({ settings: { thread: ['two'] } }));
    assert.equal(out.externalId, '1');
    assert.equal((out.notes as any).threadIncomplete.posted, 0);
  });

  it('uploads media (initialize/append/finalize/status) with alt text before posting', async () => {
    const s = mockServer()
      .on('POST', /media\/upload\/initialize$/, { json: { data: { id: 'm1' } } })
      .on('POST', /media\/upload\/m1\/append$/, { status: 204 })
      .on('POST', /media\/upload\/m1\/finalize$/, { json: { data: { id: 'm1', processing_info: { state: 'pending', check_after_secs: 1 } } } })
      .on('GET', /media\/upload\?command=STATUS&media_id=m1$/, { json: { data: { processing_info: { state: 'succeeded' } } } })
      .on('POST', /media\/metadata$/, { json: {} })
      .on('POST', /\/2\/tweets$/, { status: 201, json: { data: { id: '9' } } });
    await x.publish(xctx(s), req({ media: [{ id: 'img', kind: 'image', mime: 'image/png', sizeBytes: 3, altText: 'diagram' }] }));
    assert.ok(s.find('POST', /append$/)[0]!.body instanceof FormData);
    assert.deepEqual((s.find('POST', /tweets$/)[0]!.body as any).media, { media_ids: ['m1'] });
    assert.equal((s.find('POST', /metadata$/)[0]!.body as any).metadata.alt_text.text, 'diagram');
  });

  it('classifies 401 reconnect, 429 retryable with reset, duplicate fatal, 5xx on create unknown_outcome', async () => {
    const kind = async (reply: any) => {
      const s = mockServer().on('POST', /\/2\/tweets$/, reply);
      return x.publish(xctx(s), req()).then(() => 'ok', (e: ProviderError) => [e.kind, e.code, e.retryAfterMs]);
    };
    assert.equal(((await kind({ status: 401, json: { title: 'Unauthorized' } })) as any)[0], 'reconnect');
    const reset = String(Math.floor(Date.now() / 1000) + 600);
    const r429 = (await kind({ status: 429, headers: { 'x-rate-limit-reset': reset }, json: {} })) as any;
    assert.equal(r429[0], 'retryable');
    assert.ok(r429[2] > 500_000);
    assert.deepEqual(((await kind({ status: 403, json: { detail: 'You are not allowed to create a Tweet with duplicate content.' } })) as any).slice(0, 2), ['fatal', 'duplicate']);
    assert.equal(((await kind({ status: 503, json: {} })) as any)[0], 'unknown_outcome');
  });

  it('reconcile matches recent posts ignoring shortened links', async () => {
    const s = mockServer().on('GET', /users\/1234\/tweets/, { json: { data: [{ id: '77', text: 'Read it https://t.co/abc' }] } });
    const hit = await x.reconcile!(xctx(s), req({ text: 'Read it https://www.example.com/blog/x' }));
    assert.equal(hit?.externalId, '77');
  });

  it('exchangeCode sends the PKCE verifier with Basic auth and validates /users/me', async () => {
    const s = mockServer()
      .on('POST', /oauth2\/token$/, { json: { access_token: 'at', refresh_token: 'rt', expires_in: 7200, scope: 'tweet.read tweet.write users.read media.write offline.access' } })
      .on('GET', /users\/me$/, { json: { data: { id: '42', username: 'acme' } } });
    const r = await x.exchangeCode({ clientId: 'c', clientSecret: 's', redirectUri: 'https://r', code: 'code', codeVerifier: 'v', http: s.http, now: () => new Date(0) });
    assert.equal(r.accounts[0]!.externalId, '42');
    assert.equal(r.token.refreshToken, 'rt');
    const tok = s.find('POST', /token$/)[0]!;
    assert.equal((tok.body as any).code_verifier, 'v');
    assert.match(tok.headers.Authorization!, /^Basic /);
  });
});
