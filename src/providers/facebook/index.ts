// Facebook Page provider (`facebook_page`): posts as a Page with that Page's own access token.
// Written from the official docs only (clean-room):
//   Facebook Login (manual flow) https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
//   Long-lived tokens            https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
//   Page access tokens           https://developers.facebook.com/docs/pages-api/getting-started
//   Page posts (feed)            https://developers.facebook.com/docs/pages-api/posts
//   Page photos                  https://developers.facebook.com/docs/graph-api/reference/page/photos
//   Page videos                  https://developers.facebook.com/docs/video-api/guides/publishing
//   Comments                     https://developers.facebook.com/docs/graph-api/reference/object/comments
import { ProviderError } from '../errors.ts';
import type { HttpResponse } from '../http.ts';
import type {
  ChannelProvider, ConnectResult, ExchangeInput, ProviderContext, PublishRequest, PublishResult,
} from '../types.ts';
import { byKind, chars, issues, MB, publicUrl, traced, validationError, type CallOpts } from '../shared.ts';
import { META_GRAPH_SUNSET, META_GRAPH_VERSION, metaClassifier } from '../meta/graph.ts';

const ID = 'facebook_page';
const GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
const GRAPH_VIDEO = `https://graph-video.facebook.com/${META_GRAPH_VERSION}`;
const DIALOG = `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`;
const SCOPES = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'pages_manage_engagement'];
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/gif'];
const VIDEO_MIMES = ['video/mp4', 'video/quicktime'];
/** Self-imposed: Meta's multi-photo posts accept more, but carousels beyond 10 read badly. */
const MAX_IMAGES = 10;
const MAX_CHARS = 63206;

const classify = metaClassifier(ID);
const enc = encodeURIComponent;

function call(ctx: ProviderContext, op: string, method: string, url: string, body?: unknown, opts: CallOpts = {}): Promise<HttpResponse> {
  return traced(ctx, ID, op, {
    method, url,
    headers: { Authorization: `Bearer ${ctx.token.accessToken}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(op.startsWith('videos') ? { timeoutMs: 300_000 } : {}),
  }, classify, opts);
}

const postUrl = (id: string) => `https://www.facebook.com/${id}`;

async function graphGet(input: { http: ExchangeInput['http'] }, url: string, op: string): Promise<any> {
  let res: HttpResponse;
  try {
    res = await input.http.request({ url });
  } catch (e) {
    throw new ProviderError(ID, 'retryable', `${op}: ${(e as Error).message}`, { cause: e });
  }
  if (!res.ok) throw classify(op, res, false);
  return res.json;
}

export const facebookPage: ChannelProvider = {
  id: ID,
  displayName: 'Facebook Page',
  channelKind: 'page',
  capabilities: {
    post: { text: true, image: true, maxImages: MAX_IMAGES, video: true, document: false, carousel: true,
            thread: false, firstComment: true, textOnlyAllowed: true },
    delete: true,
    reconcile: true,
  },
  limits: { maxChars: MAX_CHARS, maxCommentChars: 8000, maxVideoBytes: 1024 * MB, imageMimes: IMAGE_MIMES, videoMimes: VIDEO_MIMES },
  auth: {
    type: 'oauth2', scopes: SCOPES, refreshable: false,
    secretNames: { clientId: 'META_APP_ID', clientSecret: 'META_APP_SECRET' },
  },
  apiVersion: { value: META_GRAPH_VERSION, sunsetsOn: META_GRAPH_SUNSET },

  authorizeUrl({ clientId, redirectUri, state }) {
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state, response_type: 'code', scope: SCOPES.join(',') });
    return `${DIALOG}?${q}`;
  },

  async exchangeCode(input: ExchangeInput): Promise<ConnectResult> {
    const short = await graphGet(input, `${GRAPH}/oauth/access_token?${new URLSearchParams({
      client_id: input.clientId, client_secret: input.clientSecret, redirect_uri: input.redirectUri, code: input.code })}`, 'oauth.code');
    if (!short?.access_token) throw new ProviderError(ID, 'fatal', 'no user access token from code exchange');
    // A Page token derived from a LONG-LIVED user token does not expire; from a short-lived one it does.
    const long = await graphGet(input, `${GRAPH}/oauth/access_token?${new URLSearchParams({
      grant_type: 'fb_exchange_token', client_id: input.clientId, client_secret: input.clientSecret, fb_exchange_token: short.access_token })}`, 'oauth.longLived');
    const userToken = String(long?.access_token ?? '');
    if (!userToken) throw new ProviderError(ID, 'fatal', 'no long-lived user token');
    const pages = await graphGet(input, `${GRAPH}/me/accounts?fields=id,name,access_token,tasks&limit=100&access_token=${enc(userToken)}`, 'me.accounts');
    const accounts = ((pages?.data ?? []) as { id: string; name?: string; access_token?: string; tasks?: string[] }[])
      .filter((p) => p.access_token && (!p.tasks || p.tasks.includes('CREATE_CONTENT')))
      .map((p) => ({ externalId: p.id, displayName: p.name ?? p.id, kind: 'page' as const, token: { accessToken: p.access_token! } }));
    if (!accounts.length) throw new ProviderError(ID, 'fatal', 'no Page this user can create content on', { code: 'no_pages' });
    return { token: { accessToken: userToken }, accounts };
  },

  async refresh() {
    throw new ProviderError(ID, 'reconnect', 'Page tokens do not expire; an invalid one needs a reconnect', { code: 'no_refresh' });
  },

  validate(req: PublishRequest) {
    const { list, add } = issues();
    const text = req.text ?? '';
    const { images, videos, docs } = byKind(req);
    if (chars(text) > MAX_CHARS) add('text', 'too_long', `Facebook allows ${MAX_CHARS} characters, got ${chars(text)}`);
    if (!text.trim() && !req.media.length && !req.linkUrl) add('text', 'empty', 'post has no text, media or link');
    if (docs.length) add('media', 'document', 'Facebook Pages do not take document posts');
    if (images.length && videos.length) add('media', 'mixed', 'images or one video, not both');
    if (videos.length > 1) add('media', 'too_many_videos', 'one video per post');
    if (images.length > MAX_IMAGES) add('media', 'too_many_images', `at most ${MAX_IMAGES} images per post`);
    for (const m of images) if (!IMAGE_MIMES.includes(m.mime)) add('media', 'image_type', `${m.mime} is not JPG/PNG/GIF`);
    for (const m of videos) {
      if (!VIDEO_MIMES.includes(m.mime)) add('media', 'video_type', `${m.mime} is not MP4/MOV`);
      if (m.sizeBytes > 1024 * MB) add('media', 'video_size', 'video must be at most 1 GB');
    }
    if (req.media.length && req.linkUrl) add('linkUrl', 'with_media', 'a link preview cannot be combined with media; put the link in the text');
    return list;
  },

  async publish(ctx, req): Promise<PublishResult> {
    const problems = facebookPage.validate(req);
    if (problems.length) throw validationError(ID, problems);
    const page = ctx.channel.externalId;
    const { images, videos } = byKind(req);
    const message = req.text ?? '';
    if (videos.length) {
      const v = videos[0]!;
      const res = await call(ctx, 'videos.create', 'POST', `${GRAPH_VIDEO}/${page}/videos`, {
        file_url: await publicUrl(ctx, ID, v), description: message, ...(v.title ?? req.title ? { title: v.title ?? req.title } : {}),
      }, { create: true });
      const id = res.json?.id;
      if (!id) throw new ProviderError(ID, 'unknown_outcome', 'videos.create returned no id');
      return { externalId: String(id), url: postUrl(String(id)) };
    }
    if (images.length === 1) {
      const img = images[0]!;
      const res = await call(ctx, 'photos.create', 'POST', `${GRAPH}/${page}/photos`,
        { url: await publicUrl(ctx, ID, img), message, published: true, ...(img.altText ? { alt_text_custom: img.altText } : {}) },
        { create: true });
      const id = res.json?.post_id ?? res.json?.id;
      if (!id) throw new ProviderError(ID, 'unknown_outcome', 'photos.create returned no id');
      return { externalId: String(id), url: postUrl(String(id)) };
    }
    const body: Record<string, unknown> = { message };
    if (images.length > 1) {
      // Unpublished photos first (nothing visible yet, safe to retry), then one feed post that attaches them.
      const ids: string[] = [];
      for (const img of images) {
        const r = await call(ctx, 'photos.stage', 'POST', `${GRAPH}/${page}/photos`,
          { url: await publicUrl(ctx, ID, img), published: false, ...(img.altText ? { alt_text_custom: img.altText } : {}) });
        if (!r.json?.id) throw new ProviderError(ID, 'retryable', 'photos.stage returned no id');
        ids.push(String(r.json.id));
      }
      body.attached_media = ids.map((media_fbid) => ({ media_fbid }));
    } else if (req.linkUrl) {
      body.link = req.linkUrl;
    }
    const res = await call(ctx, 'feed.create', 'POST', `${GRAPH}/${page}/feed`, body, { create: true });
    const id = res.json?.id;
    if (!id) throw new ProviderError(ID, 'unknown_outcome', 'feed.create returned no id');
    return { externalId: String(id), url: postUrl(String(id)) };
  },

  async reconcile(ctx, req) {
    const res = await call(ctx, 'posts.recent', 'GET',
      `${GRAPH}/${ctx.channel.externalId}/posts?fields=id,message,permalink_url,created_time&limit=10`);
    const hit = ((res.json?.data ?? []) as { id: string; message?: string; permalink_url?: string }[])
      .find((p) => (p.message ?? '') === (req.text ?? ''));
    return hit ? { externalId: hit.id, url: hit.permalink_url ?? postUrl(hit.id) } : null;
  },

  async delete(ctx, externalId) {
    await call(ctx, 'posts.delete', 'DELETE', `${GRAPH}/${externalId}`, undefined, { okStatuses: [404] });
  },

  async comment(ctx, externalId, text) {
    const res = await call(ctx, 'comments.create', 'POST', `${GRAPH}/${externalId}/comments`, { message: text }, { create: true });
    if (!res.json?.id) throw new ProviderError(ID, 'unknown_outcome', 'comments.create returned no id');
    return { externalId: String(res.json.id) };
  },
};
