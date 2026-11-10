// X provider (`x`): posts, threads (reply chain) and first comments as one user, OAuth 2.0 with PKCE.
// X API access is paid and tiered; every post is metered per tenant in `usage` by the worker.
// Written from the official docs only (clean-room):
//   OAuth 2.0 PKCE      https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code
//   Create post         https://docs.x.com/x-api/posts/create-post
//   Delete post         https://docs.x.com/x-api/posts/delete-post
//   Media upload (v2)   https://docs.x.com/x-api/media/quickstart/media-upload-chunked
//   Media metadata      https://docs.x.com/x-api/media/metadata-create
//   User posts          https://docs.x.com/x-api/users/get-posts
//   Rate limits         https://docs.x.com/x-api/fundamentals/rate-limits
//   Counting characters https://docs.x.com/resources/fundamentals/counting-characters
import { ProviderError } from '../errors.ts';
import type { HttpResponse } from '../http.ts';
import type {
  ChannelProvider, ConnectResult, ExchangeInput, MediaItem, ProviderContext, PublishRequest, PublishResult,
  RefreshInput, TokenSet,
} from '../types.ts';
import { byKind, issues, MB, toTokenSet, tokenRequest, traced, validationError, type CallOpts, type Classify } from '../shared.ts';
import { X_MAX_WEIGHTED, xWeightedLength } from './text.ts';

const ID = 'x';
const API = 'https://api.x.com/2';
const SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'];
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const VIDEO_MIMES = ['video/mp4'];
const MAX_THREAD = 10;
const CHUNK = 4 * MB;
const POLL_MAX = 60;

const classify: Classify = (op, res, create) => {
  const detail = res.json?.detail ?? res.json?.title ?? res.json?.errors?.[0]?.message ?? 'request failed';
  const msg = `${op} -> ${res.status}: ${detail}`;
  const o = { status: res.status, code: String(res.json?.type ?? res.status) };
  if (res.status === 401) return new ProviderError(ID, 'reconnect', msg, o);
  if (res.status === 429) {
    const reset = Number(res.headers.get('x-rate-limit-reset'));
    const wait = Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : 15 * 60_000;
    return new ProviderError(ID, 'retryable', msg, { ...o, retryAfterMs: wait });
  }
  if (res.status === 403 && /duplicate/i.test(String(detail))) return new ProviderError(ID, 'fatal', msg, { ...o, code: 'duplicate' });
  if (res.status >= 500) return new ProviderError(ID, create ? 'unknown_outcome' : 'retryable', msg, o);
  return new ProviderError(ID, 'fatal', msg, o);
};

function call(ctx: ProviderContext, op: string, method: string, path: string, body?: unknown, opts: CallOpts = {}): Promise<HttpResponse> {
  const form = body instanceof FormData;
  return traced(ctx, ID, op, {
    method, url: `${API}/${path}`,
    headers: { Authorization: `Bearer ${ctx.token.accessToken}`, ...(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: form ? body : JSON.stringify(body) } : {}),
  }, classify, opts);
}

const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;
const postUrl = (id: string) => `https://x.com/i/web/status/${id}`;
const thread = (req: PublishRequest): string[] =>
  Array.isArray(req.settings.thread) ? (req.settings.thread as unknown[]).map(String).filter((s) => s.trim()) : [];

async function uploadMedia(ctx: ProviderContext, m: MediaItem): Promise<string> {
  const bytes = await ctx.media.read(m.id);
  const category = m.kind === 'video' ? 'tweet_video' : m.mime === 'image/gif' ? 'tweet_gif' : 'tweet_image';
  const init = await call(ctx, 'media.initialize', 'POST', 'media/upload/initialize',
    { media_type: m.mime, total_bytes: bytes.byteLength, media_category: category });
  const id = init.json?.data?.id;
  if (!id) throw new ProviderError(ID, 'retryable', 'media initialize returned no id');
  for (let i = 0, seg = 0; i < bytes.byteLength; i += CHUNK, seg++) {
    const form = new FormData();
    form.append('segment_index', String(seg));
    form.append('media', new Blob([Uint8Array.from(bytes.subarray(i, i + CHUNK))], { type: 'application/octet-stream' }));
    await call(ctx, 'media.append', 'POST', `media/upload/${id}/append`, form);
  }
  let info = (await call(ctx, 'media.finalize', 'POST', `media/upload/${id}/finalize`)).json?.data?.processing_info;
  for (let i = 0; info && info.state !== 'succeeded'; i++) {
    if (info.state === 'failed') throw new ProviderError(ID, 'fatal', `media ${id} processing failed`, { code: 'media_processing_failed' });
    if (i >= POLL_MAX) throw new ProviderError(ID, 'retryable', `media ${id} still processing`);
    await ctx.sleep(Math.max(1, Number(info.check_after_secs ?? 5)) * 1000);
    info = (await call(ctx, 'media.status', 'GET', `media/upload?command=STATUS&media_id=${id}`)).json?.data?.processing_info;
  }
  if (m.altText) await call(ctx, 'media.metadata', 'POST', 'media/metadata', { id, metadata: { alt_text: { text: m.altText.slice(0, 1000) } } });
  return String(id);
}

async function createPost(ctx: ProviderContext, op: string, body: Record<string, unknown>): Promise<string> {
  const res = await call(ctx, op, 'POST', 'tweets', body, { create: true });
  const id = res.json?.data?.id;
  if (!id) throw new ProviderError(ID, 'unknown_outcome', `${op} returned no id`);
  return String(id);
}

export const x: ChannelProvider = {
  id: ID,
  displayName: 'X',
  channelKind: 'personal',
  capabilities: {
    post: { text: true, image: true, maxImages: 4, video: true, document: false, carousel: true,
            thread: true, firstComment: true, textOnlyAllowed: true },
    delete: true,
    reconcile: true,
  },
  limits: { maxChars: X_MAX_WEIGHTED, maxCommentChars: X_MAX_WEIGHTED, maxImageBytes: 5 * MB, maxVideoBytes: 512 * MB,
            imageMimes: IMAGE_MIMES, videoMimes: VIDEO_MIMES },
  auth: {
    type: 'oauth2', scopes: SCOPES, refreshable: true,
    secretNames: { clientId: 'X_CLIENT_ID', clientSecret: 'X_CLIENT_SECRET' },
  },

  authorizeUrl({ clientId, redirectUri, state, codeChallenge }) {
    if (!codeChallenge) throw new ProviderError(ID, 'fatal', 'X requires a PKCE code challenge', { code: 'pkce_required' });
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: SCOPES.join(' '),
      state, code_challenge: codeChallenge, code_challenge_method: 'S256' });
    return `https://x.com/i/oauth2/authorize?${q}`;
  },

  async exchangeCode(input: ExchangeInput): Promise<ConnectResult> {
    if (!input.codeVerifier) throw new ProviderError(ID, 'fatal', 'X requires the PKCE code verifier', { code: 'pkce_required' });
    const res = await tokenRequest(ID, input.http, `${API}/oauth2/token`, new URLSearchParams({
      grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri, code_verifier: input.codeVerifier,
      client_id: input.clientId,
    }), 'fatal', { Authorization: basic(input.clientId, input.clientSecret) });
    const token = toTokenSet(res.json, input.now());
    const missing = token.scopes ? SCOPES.filter((s) => !token.scopes!.includes(s)) : [];
    if (missing.length) throw new ProviderError(ID, 'fatal', `X did not grant: ${missing.join(', ')}`, { code: 'missing_scopes' });
    // Validate the token at connect time: a token that cannot read /users/me will not post either.
    const me = await input.http.request({ url: `${API}/users/me`, headers: { Authorization: `Bearer ${token.accessToken}` } });
    if (!me.ok || !me.json?.data?.id) throw classify('users.me', me, false);
    return { token, accounts: [{ externalId: String(me.json.data.id), displayName: `@${me.json.data.username ?? me.json.data.id}`, kind: 'personal' }] };
  },

  async refresh(input: RefreshInput): Promise<TokenSet> {
    if (!input.token.refreshToken) throw new ProviderError(ID, 'reconnect', 'no refresh token (offline.access not granted)', { code: 'no_refresh_token' });
    const res = await tokenRequest(ID, input.http, `${API}/oauth2/token`, new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: input.token.refreshToken, client_id: input.clientId,
    }), 'reconnect', { Authorization: basic(input.clientId, input.clientSecret) });
    // X rotates refresh tokens: the new one replaces the old one, which stops working.
    return toTokenSet(res.json, input.now());
  },

  validate(req: PublishRequest) {
    const { list, add } = issues();
    const text = req.text ?? '';
    const { images, videos, docs } = byKind(req);
    const len = xWeightedLength(text);
    if (len > X_MAX_WEIGHTED) add('text', 'too_long', `X allows ${X_MAX_WEIGHTED} weighted characters, got ${len}`);
    if (!text.trim() && !req.media.length) add('text', 'empty', 'post has no text or media');
    if (docs.length) add('media', 'document', 'X does not take documents');
    if (images.length && videos.length) add('media', 'mixed', 'up to 4 images or one video, not both');
    if (images.length > 4) add('media', 'too_many_images', 'at most 4 images per post');
    if (videos.length > 1) add('media', 'too_many_videos', 'one video per post');
    for (const m of images) {
      if (!IMAGE_MIMES.includes(m.mime)) add('media', 'image_type', `${m.mime} is not JPG/PNG/WEBP/GIF`);
      if (m.sizeBytes > 5 * MB && m.mime !== 'image/gif') add('media', 'image_size', 'images must be at most 5 MB');
    }
    for (const m of videos) {
      if (!VIDEO_MIMES.includes(m.mime)) add('media', 'video_type', `${m.mime} is not MP4`);
      if (m.sizeBytes > 512 * MB) add('media', 'video_size', 'video must be at most 512 MB');
    }
    const t = req.settings.thread;
    if (t !== undefined && (!Array.isArray(t) || t.some((s) => typeof s !== 'string'))) add('settings.thread', 'invalid', 'thread must be a list of texts');
    const items = thread(req);
    if (items.length > MAX_THREAD) add('settings.thread', 'too_long', `at most ${MAX_THREAD} follow-up posts`);
    items.forEach((s, i) => {
      const n = xWeightedLength(s);
      if (n > X_MAX_WEIGHTED) add(`settings.thread[${i}]`, 'too_long', `thread post ${i + 1} has ${n} weighted characters (max ${X_MAX_WEIGHTED})`);
    });
    const fc = req.settings.firstComment;
    if (fc !== undefined && (typeof fc !== 'string' || xWeightedLength(fc) > X_MAX_WEIGHTED)) {
      add('settings.firstComment', 'invalid', `first comment must be text of at most ${X_MAX_WEIGHTED} weighted characters`);
    }
    return list;
  },

  async publish(ctx, req): Promise<PublishResult> {
    const problems = x.validate(req);
    if (problems.length) throw validationError(ID, problems);
    const mediaIds: string[] = [];
    for (const m of req.media) mediaIds.push(await uploadMedia(ctx, m));
    const head = await createPost(ctx, 'tweets.create', { text: req.text ?? '', ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}) });
    // The head post exists now. A failure further down the thread must not make the worker post the head
    // again, so it is reported as a note on a successful result, never thrown.
    const posted: string[] = [];
    let parent = head;
    try {
      for (const text of thread(req)) {
        parent = await createPost(ctx, 'tweets.reply', { text, reply: { in_reply_to_tweet_id: parent } });
        posted.push(parent);
      }
    } catch (e) {
      return { externalId: head, url: postUrl(head),
        notes: { threadIncomplete: { posted: posted.length, of: thread(req).length, error: (e as Error).message } } };
    }
    return { externalId: head, url: postUrl(head), ...(posted.length ? { notes: { thread: posted } } : {}) };
  },

  async reconcile(ctx, req) {
    const res = await call(ctx, 'users.tweets', 'GET', `users/${ctx.channel.externalId}/tweets?max_results=10&tweet.fields=text,created_at`);
    // X shortens links in returned text, so compare with URLs stripped.
    const norm = (s: string) => s.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
    const want = norm(req.text ?? '');
    const hit = ((res.json?.data ?? []) as { id: string; text: string }[]).find((t) => norm(t.text) === want);
    return hit ? { externalId: hit.id, url: postUrl(hit.id) } : null;
  },

  async delete(ctx, externalId) {
    await call(ctx, 'tweets.delete', 'DELETE', `tweets/${externalId}`, undefined, { okStatuses: [404] });
  },

  async comment(ctx, externalId, text) {
    return { externalId: await createPost(ctx, 'tweets.reply', { text, reply: { in_reply_to_tweet_id: externalId } }) };
  },
};
