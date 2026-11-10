// Instagram provider (`instagram`): a professional (Business/Creator) account through Instagram Login —
// no Facebook Page needed. Publishing is two-step: create a media container, wait until it is FINISHED,
// then media_publish. Containers are invisible until published, so only media_publish is a "create" call.
// Written from the official docs only (clean-room):
//   Instagram Login            https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
//   Long-lived tokens/refresh  https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token
//   Content publishing         https://developers.facebook.com/docs/instagram-platform/content-publishing
//   Publishing limit           https://developers.facebook.com/docs/instagram-platform/reference/ig-user/content_publishing_limit
//   Container status           https://developers.facebook.com/docs/instagram-platform/reference/ig-container
//   Comments                   https://developers.facebook.com/docs/instagram-platform/comment-moderation
import { ProviderError, unsupported } from '../errors.ts';
import type { HttpResponse } from '../http.ts';
import type {
  ChannelProvider, ConnectResult, ExchangeInput, MediaItem, ProviderContext, PublishRequest, PublishResult,
  RefreshInput, TokenSet,
} from '../types.ts';
import { byKind, chars, hashtagCount, issues, MB, publicUrl, toTokenSet, tokenRequest, traced, validationError, type CallOpts } from '../shared.ts';
import { META_GRAPH_SUNSET, META_GRAPH_VERSION, metaClassifier } from '../meta/graph.ts';

const ID = 'instagram';
const GRAPH = `https://graph.instagram.com/${META_GRAPH_VERSION}`;
const SCOPES = ['instagram_business_basic', 'instagram_business_content_publish',
  'instagram_business_manage_comments', 'instagram_business_manage_insights'];
const IMAGE_MIMES = ['image/jpeg'];
const VIDEO_MIMES = ['video/mp4', 'video/quicktime'];
const MAX_CHARS = 2200;
const MAX_HASHTAGS = 30;
const MAX_CAROUSEL = 10;
const POLL_INTERVAL_MS = 5_000;
const POLL_MAX = 60;

const classify = metaClassifier(ID);

function call(ctx: ProviderContext, op: string, method: string, path: string, body?: unknown, opts: CallOpts = {}): Promise<HttpResponse> {
  return traced(ctx, ID, op, {
    method, url: `${GRAPH}/${path}`,
    headers: { Authorization: `Bearer ${ctx.token.accessToken}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, classify, opts);
}

/** Instagram refreshes the access token itself (no separate refresh token): keep it as its own refresh handle. */
const selfRefreshing = (t: TokenSet): TokenSet => ({ ...t, refreshToken: t.accessToken });

async function container(ctx: ProviderContext, body: Record<string, unknown>): Promise<string> {
  const res = await call(ctx, 'media.container', 'POST', `${ctx.channel.externalId}/media`, body);
  const id = res.json?.id;
  if (!id) throw new ProviderError(ID, 'retryable', 'media container returned no id');
  return String(id);
}

async function waitFinished(ctx: ProviderContext, id: string): Promise<void> {
  for (let i = 0; i < POLL_MAX; i++) {
    const st = (await call(ctx, 'media.status', 'GET', `${id}?fields=status_code,status`)).json?.status_code;
    if (st === 'FINISHED' || st === 'PUBLISHED') return;
    if (st === 'ERROR' || st === 'EXPIRED') {
      throw new ProviderError(ID, 'fatal', `media container ${id} is ${st}`, { code: 'container_failed' });
    }
    await ctx.sleep(POLL_INTERVAL_MS);
  }
  throw new ProviderError(ID, 'retryable', `media container ${id} still processing after ${(POLL_MAX * POLL_INTERVAL_MS) / 1000}s`);
}

async function itemBody(ctx: ProviderContext, m: MediaItem, carouselItem: boolean): Promise<Record<string, unknown>> {
  const url = await publicUrl(ctx, ID, m);
  if (m.kind === 'video') return { media_type: carouselItem ? 'VIDEO' : 'REELS', video_url: url, ...(carouselItem ? { is_carousel_item: true } : {}) };
  return { image_url: url, ...(carouselItem ? { is_carousel_item: true } : {}), ...(m.altText && !carouselItem ? { alt_text: m.altText } : {}) };
}

export const instagram: ChannelProvider = {
  id: ID,
  displayName: 'Instagram (professional account)',
  channelKind: 'personal',
  capabilities: {
    post: { text: true, image: true, maxImages: MAX_CAROUSEL, video: true, document: false, carousel: true,
            thread: false, firstComment: true, textOnlyAllowed: false },
    delete: false,
    reconcile: true,
  },
  limits: { maxChars: MAX_CHARS, maxCommentChars: 2200, maxImageBytes: 8 * MB, maxVideoBytes: 300 * MB, imageMimes: IMAGE_MIMES, videoMimes: VIDEO_MIMES },
  auth: {
    type: 'oauth2', scopes: SCOPES, refreshable: true, tokenLifetimeDays: 60,
    secretNames: { clientId: 'INSTAGRAM_APP_ID', clientSecret: 'INSTAGRAM_APP_SECRET' },
  },
  apiVersion: { value: META_GRAPH_VERSION, sunsetsOn: META_GRAPH_SUNSET },

  authorizeUrl({ clientId, redirectUri, state }) {
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(','), state });
    return `https://www.instagram.com/oauth/authorize?${q}`;
  },

  async exchangeCode(input: ExchangeInput): Promise<ConnectResult> {
    const short = await tokenRequest(ID, input.http, 'https://api.instagram.com/oauth/access_token', new URLSearchParams({
      client_id: input.clientId, client_secret: input.clientSecret, grant_type: 'authorization_code',
      redirect_uri: input.redirectUri, code: input.code,
    }), 'fatal');
    const granted: string[] = Array.isArray(short.json.permissions) ? short.json.permissions
      : String(short.json.permissions ?? '').split(',').filter(Boolean);
    const missing = granted.length ? SCOPES.filter((s) => !granted.includes(s)) : [];
    if (missing.length) throw new ProviderError(ID, 'fatal', `Instagram did not grant: ${missing.join(', ')}`, { code: 'missing_scopes' });
    const longRes = await input.http.request({ url: `https://graph.instagram.com/access_token?${new URLSearchParams({
      grant_type: 'ig_exchange_token', client_secret: input.clientSecret, access_token: short.json.access_token })}` });
    if (!longRes.ok || !longRes.json?.access_token) throw classify('oauth.longLived', longRes, false);
    const token = selfRefreshing(toTokenSet(longRes.json, input.now()));
    const me = await input.http.request({ url: `${GRAPH}/me?fields=user_id,username`, headers: { Authorization: `Bearer ${token.accessToken}` } });
    if (!me.ok || !me.json?.user_id) throw classify('me', me, false);
    return { token, accounts: [{ externalId: String(me.json.user_id), displayName: me.json.username ?? String(me.json.user_id), kind: 'personal' }] };
  },

  async refresh(input: RefreshInput): Promise<TokenSet> {
    const res = await input.http.request({ url: `https://graph.instagram.com/refresh_access_token?${new URLSearchParams({
      grant_type: 'ig_refresh_token', access_token: input.token.accessToken })}` }).catch((e) => {
      throw new ProviderError(ID, 'retryable', `refresh: ${(e as Error).message}`, { cause: e });
    });
    if (res.status >= 500 || res.status === 429) throw new ProviderError(ID, 'retryable', `refresh -> ${res.status}`, { status: res.status });
    if (!res.ok || !res.json?.access_token) throw new ProviderError(ID, 'reconnect', `refresh -> ${res.status}`, { status: res.status });
    return selfRefreshing(toTokenSet(res.json, input.now()));
  },

  validate(req: PublishRequest) {
    const { list, add } = issues();
    const text = req.text ?? '';
    const { images, videos, docs } = byKind(req);
    if (!req.media.length) add('media', 'media_required', 'Instagram posts need at least one image or video');
    if (docs.length) add('media', 'document', 'Instagram does not take documents');
    if (chars(text) > MAX_CHARS) add('text', 'too_long', `Instagram captions allow ${MAX_CHARS} characters, got ${chars(text)}`);
    if (hashtagCount(text) > MAX_HASHTAGS) add('text', 'too_many_hashtags', `at most ${MAX_HASHTAGS} hashtags, got ${hashtagCount(text)}`);
    if (images.length + videos.length > MAX_CAROUSEL) add('media', 'too_many_items', `a carousel holds at most ${MAX_CAROUSEL} items`);
    for (const m of images) {
      if (!IMAGE_MIMES.includes(m.mime)) add('media', 'image_type', `${m.mime}: Instagram publishing takes JPEG only`);
      if (m.sizeBytes > 8 * MB) add('media', 'image_size', 'images must be at most 8 MB');
    }
    for (const m of videos) {
      if (!VIDEO_MIMES.includes(m.mime)) add('media', 'video_type', `${m.mime} is not MP4/MOV`);
      if (m.sizeBytes > 300 * MB) add('media', 'video_size', 'Reels must be at most 300 MB');
    }
    return list;
  },

  async publish(ctx, req): Promise<PublishResult> {
    const problems = instagram.validate(req);
    if (problems.length) throw validationError(ID, problems);
    const me = ctx.channel.externalId;
    const quota = (await call(ctx, 'publishingLimit', 'GET', `${me}/content_publishing_limit?fields=quota_usage,config`)).json?.data?.[0];
    if (quota && typeof quota.quota_usage === 'number' && typeof quota.config?.quota_total === 'number'
      && quota.quota_usage >= quota.config.quota_total) {
      throw new ProviderError(ID, 'retryable', `publishing limit reached (${quota.quota_usage}/${quota.config.quota_total} in 24 h)`,
        { code: 'publishing_limit', retryAfterMs: 3_600_000 });
    }
    const caption = req.text ?? '';
    let creationId: string;
    if (req.media.length === 1) {
      const m = req.media[0]!;
      creationId = await container(ctx, { ...(await itemBody(ctx, m, false)), caption,
        ...(m.kind === 'video' ? { share_to_feed: req.settings.shareToFeed !== false } : {}) });
    } else {
      const children: string[] = [];
      for (const m of req.media) {
        const id = await container(ctx, await itemBody(ctx, m, true));
        await waitFinished(ctx, id);
        children.push(id);
      }
      creationId = await container(ctx, { media_type: 'CAROUSEL', children: children.join(','), caption });
    }
    await waitFinished(ctx, creationId);
    const res = await call(ctx, 'media.publish', 'POST', `${me}/media_publish`, { creation_id: creationId }, { create: true });
    const mediaId = res.json?.id;
    if (!mediaId) throw new ProviderError(ID, 'unknown_outcome', 'media_publish returned no id');
    let url: string | undefined;
    try {
      url = (await call(ctx, 'media.permalink', 'GET', `${mediaId}?fields=permalink`)).json?.permalink;
    } catch { /* the post exists; a missing permalink is not a failure */ }
    return { externalId: String(mediaId), ...(url ? { url } : {}) };
  },

  async reconcile(ctx, req) {
    const res = await call(ctx, 'media.recent', 'GET', `${ctx.channel.externalId}/media?fields=id,caption,permalink,timestamp&limit=10`);
    const hit = ((res.json?.data ?? []) as { id: string; caption?: string; permalink?: string }[])
      .find((m) => (m.caption ?? '') === (req.text ?? ''));
    return hit ? { externalId: hit.id, ...(hit.permalink ? { url: hit.permalink } : {}) } : null;
  },

  async delete() {
    throw unsupported(ID, 'deleting Instagram media through the API');
  },

  async comment(ctx, externalId, text) {
    const res = await call(ctx, 'comments.create', 'POST', `${externalId}/comments`, { message: text }, { create: true });
    if (!res.json?.id) throw new ProviderError(ID, 'unknown_outcome', 'comments.create returned no id');
    return { externalId: String(res.json.id) };
  },
};
