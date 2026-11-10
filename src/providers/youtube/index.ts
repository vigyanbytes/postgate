// YouTube provider (`youtube`): one video per post (long-form or a Short) with its metadata.
// Shorts are ordinary uploads that are vertical and at most 3 minutes; `settings.shorts` only adds the
// #Shorts tag to the title. Community posts have NO public API: validate() says so instead of pretending.
// Uploads default to `private` — unaudited API projects are forced private anyway, and going public is an
// explicit setting that the approval hash covers.
// Written from the official docs only (clean-room):
//   OAuth for web servers   https://developers.google.com/identity/protocols/oauth2/web-server
//   videos.insert           https://developers.google.com/youtube/v3/docs/videos/insert
//   Resumable uploads       https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
//   Quota costs             https://developers.google.com/youtube/v3/determine_quota_cost
//   Errors                  https://developers.google.com/youtube/v3/docs/errors
//   commentThreads          https://developers.google.com/youtube/v3/docs/commentThreads
//   Shorts                  https://support.google.com/youtube/answer/10059070
import { ProviderError } from '../errors.ts';
import { retryAfterMs, type HttpResponse } from '../http.ts';
import type {
  ChannelProvider, ConnectResult, ExchangeInput, ProviderContext, PublishRequest, PublishResult, RefreshInput, TokenSet,
} from '../types.ts';
import { byKind, chars, issues, MB, toTokenSet, tokenRequest, traced, validationError, type CallOpts, type Classify } from '../shared.ts';

const ID = 'youtube';
const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos';
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];
const VIDEO_MIMES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'];
const PRIVACY = ['private', 'unlisted', 'public'];
const MAX_TITLE = 100;
const MAX_DESCRIPTION_BYTES = 5000;
const MAX_TAGS_CHARS = 500;
/** Default category 28 = Science & Technology. */
const DEFAULT_CATEGORY = '28';

const QUOTA = new Set(['quotaExceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'uploadLimitExceeded']);

const classify: Classify = (op, res, create) => {
  const err = res.json?.error ?? {};
  const reason = err.errors?.[0]?.reason ?? err.status ?? '';
  const msg = `${op} -> ${res.status}: ${err.message ?? 'request failed'}${reason ? ` (${reason})` : ''}`;
  const o = { status: res.status, code: String(reason || res.status) };
  if (res.status === 401) return new ProviderError(ID, 'reconnect', msg, o);
  if (res.status === 429 || (res.status === 403 && QUOTA.has(reason))) {
    // Daily quota resets at midnight Pacific; an hour is a polite floor, backoff grows from there.
    return new ProviderError(ID, 'retryable', msg, { ...o, retryAfterMs: retryAfterMs(res.headers) ?? 3_600_000 });
  }
  if (res.status >= 500) return new ProviderError(ID, create ? 'unknown_outcome' : 'retryable', msg, o);
  return new ProviderError(ID, 'fatal', msg, o);
};

function call(ctx: ProviderContext, op: string, method: string, url: string, body?: unknown, opts: CallOpts = {}): Promise<HttpResponse> {
  return traced(ctx, ID, op, {
    method, url,
    headers: { Authorization: `Bearer ${ctx.token.accessToken}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, classify, opts);
}

const videoUrl = (id: string, shorts: boolean) => (shorts ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`);

function titleOf(req: PublishRequest): string {
  const base = String(req.settings.title ?? req.title ?? '').trim();
  return req.settings.shorts === true && !/#shorts\b/i.test(base) ? `${base} #Shorts`.trim() : base;
}

const tagsOf = (req: PublishRequest): string[] =>
  Array.isArray(req.settings.tags) ? (req.settings.tags as unknown[]).map(String).filter(Boolean) : [];

export const youtube: ChannelProvider = {
  id: ID,
  displayName: 'YouTube (videos and Shorts)',
  channelKind: 'page',
  capabilities: {
    post: { text: false, image: false, maxImages: 0, video: true, document: false, carousel: false,
            thread: false, firstComment: true, textOnlyAllowed: false },
    delete: true,
    reconcile: true,
  },
  limits: { maxChars: MAX_DESCRIPTION_BYTES, maxCommentChars: 10_000, maxVideoBytes: 256 * 1024 * MB, videoMimes: VIDEO_MIMES },
  auth: {
    type: 'oauth2', scopes: SCOPES, refreshable: true,
    secretNames: { clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET' },
  },

  authorizeUrl({ clientId, redirectUri, state }) {
    // prompt=consent: Google only returns a refresh token on consent; without it a reconnect yields none.
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '),
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  },

  async exchangeCode(input: ExchangeInput): Promise<ConnectResult> {
    const res = await tokenRequest(ID, input.http, 'https://oauth2.googleapis.com/token', new URLSearchParams({
      grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri,
      client_id: input.clientId, client_secret: input.clientSecret,
    }), 'fatal');
    const token = toTokenSet(res.json, input.now());
    const missing = token.scopes ? SCOPES.filter((s) => !token.scopes!.includes(s)) : [];
    if (missing.length) throw new ProviderError(ID, 'fatal', `Google did not grant: ${missing.join(', ')}`, { code: 'missing_scopes' });
    const ch = await input.http.request({ url: `${API}/channels?part=snippet&mine=true`, headers: { Authorization: `Bearer ${token.accessToken}` } });
    if (!ch.ok) throw classify('channels.mine', ch, false);
    const accounts = ((ch.json?.items ?? []) as { id: string; snippet?: { title?: string } }[])
      .map((c) => ({ externalId: c.id, displayName: c.snippet?.title ?? c.id, kind: 'page' as const }));
    if (!accounts.length) throw new ProviderError(ID, 'fatal', 'this Google account has no YouTube channel', { code: 'no_channel' });
    return { token, accounts };
  },

  async refresh(input: RefreshInput): Promise<TokenSet> {
    if (!input.token.refreshToken) throw new ProviderError(ID, 'reconnect', 'no refresh token: reconnect with consent', { code: 'no_refresh_token' });
    const res = await tokenRequest(ID, input.http, 'https://oauth2.googleapis.com/token', new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: input.token.refreshToken, client_id: input.clientId, client_secret: input.clientSecret,
    }), 'reconnect');
    const next = toTokenSet(res.json, input.now());
    // Google omits refresh_token on refresh: never overwrite the stored one with nothing.
    return { ...next, refreshToken: next.refreshToken ?? input.token.refreshToken };
  },

  validate(req: PublishRequest) {
    const { list, add } = issues();
    const { images, videos, docs } = byKind(req);
    if (req.settings.youtubeType === 'community') {
      add('settings.youtubeType', 'unsupported', 'YouTube has no public API for community posts: publish those by hand in YouTube Studio');
      return list;
    }
    if (videos.length !== 1) add('media', 'media_required', 'a YouTube post is exactly one video');
    if (images.length || docs.length) add('media', 'not_video', 'YouTube posts carry only the video');
    for (const m of videos) if (!VIDEO_MIMES.includes(m.mime)) add('media', 'video_type', `${m.mime} is not MP4/MOV/WEBM/MKV`);
    const title = titleOf(req);
    if (!title) add('settings.title', 'required', 'a YouTube video needs a title');
    if (chars(title) > MAX_TITLE) add('settings.title', 'too_long', `title allows ${MAX_TITLE} characters, got ${chars(title)}`);
    if (/[<>]/.test(title) || /[<>]/.test(req.text ?? '')) add('text', 'angle_brackets', 'YouTube rejects < and > in titles and descriptions');
    const bytes = Buffer.byteLength(req.text ?? '', 'utf8');
    if (bytes > MAX_DESCRIPTION_BYTES) add('text', 'too_long', `description allows ${MAX_DESCRIPTION_BYTES} bytes, got ${bytes}`);
    const tags = tagsOf(req);
    // Tags with spaces count their quotes too.
    const tagChars = tags.reduce((n, t) => n + chars(t) + (t.includes(' ') ? 2 : 0), 0) + Math.max(0, tags.length - 1);
    if (tagChars > MAX_TAGS_CHARS) add('settings.tags', 'too_long', `tags allow ${MAX_TAGS_CHARS} characters in total, got ${tagChars}`);
    const privacy = req.settings.privacyStatus;
    if (privacy !== undefined && !PRIVACY.includes(String(privacy))) add('settings.privacyStatus', 'invalid', `privacy must be one of ${PRIVACY.join(', ')}`);
    return list;
  },

  async publish(ctx, req): Promise<PublishResult> {
    const problems = youtube.validate(req);
    if (problems.length) throw validationError(ID, problems);
    const video = req.media[0]!;
    const bytes = await ctx.media.read(video.id);
    const shorts = req.settings.shorts === true;
    const metadata = {
      snippet: { title: titleOf(req), description: req.text ?? '', tags: tagsOf(req), categoryId: String(req.settings.categoryId ?? DEFAULT_CATEGORY) },
      status: { privacyStatus: String(req.settings.privacyStatus ?? 'private'), selfDeclaredMadeForKids: req.settings.madeForKids === true },
    };
    // Step 1 opens an upload session (nothing is created yet); step 2 sends the bytes and creates the video.
    const init = await traced(ctx, ID, 'videos.initUpload', {
      method: 'POST', url: `${UPLOAD}?uploadType=resumable&part=snippet,status`, body: JSON.stringify(metadata),
      headers: { Authorization: `Bearer ${ctx.token.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8',
                 'X-Upload-Content-Length': String(bytes.byteLength), 'X-Upload-Content-Type': video.mime },
    }, classify);
    const session = init.headers.get('location');
    if (!session) throw new ProviderError(ID, 'retryable', 'upload session returned no Location');
    const res = await traced(ctx, ID, 'videos.upload', {
      method: 'PUT', url: session, body: bytes, timeoutMs: 1_800_000,
      headers: { Authorization: `Bearer ${ctx.token.accessToken}`, 'Content-Type': video.mime },
    }, classify, { create: true });
    const id = res.json?.id;
    if (!id) throw new ProviderError(ID, 'unknown_outcome', 'upload finished without a video id');
    return { externalId: String(id), url: videoUrl(String(id), shorts), notes: { privacyStatus: metadata.status.privacyStatus } };
  },

  async reconcile(ctx, req) {
    const res = await call(ctx, 'search.mine', 'GET', `${API}/search?part=snippet&forMine=true&type=video&order=date&maxResults=10`);
    const want = titleOf(req);
    const hit = ((res.json?.items ?? []) as { id?: { videoId?: string }; snippet?: { title?: string } }[])
      .find((i) => i.snippet?.title === want && i.id?.videoId);
    return hit ? { externalId: hit.id!.videoId!, url: videoUrl(hit.id!.videoId!, req.settings.shorts === true) } : null;
  },

  async delete(ctx, externalId) {
    await call(ctx, 'videos.delete', 'DELETE', `${API}/videos?id=${encodeURIComponent(externalId)}`, undefined, { okStatuses: [404] });
  },

  async comment(ctx, externalId, text) {
    const res = await call(ctx, 'commentThreads.insert', 'POST', `${API}/commentThreads?part=snippet`,
      { snippet: { videoId: externalId, topLevelComment: { snippet: { textOriginal: text } } } }, { create: true });
    if (!res.json?.id) throw new ProviderError(ID, 'unknown_outcome', 'commentThreads.insert returned no id');
    return { externalId: String(res.json.id) };
  },
};
