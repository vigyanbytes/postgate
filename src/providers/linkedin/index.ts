// LinkedIn provider: personal profile (`linkedin`) and company page (`linkedin_page`) share this code
// and differ in scopes, author URN and how far a post can be looked up again (reconcile).
// Written from the official docs only (clean-room):
//   OAuth 3-legged flow   https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
//   Refresh tokens        https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens
//   OpenID userinfo       https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2
//   Posts API             https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
//   Images API            https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
//   Videos API            https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api
//   Documents API         https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/documents-api
//   MultiImage            https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/multiimage-post-api
//   Comments              https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api
//   Versioning            https://learn.microsoft.com/en-us/linkedin/marketing/versioning
import { ProviderError, unsupported } from '../errors.ts';
import { TransportError, retryAfterMs, type HttpClient, type HttpResponse } from '../http.ts';
import type {
  ChannelKind, ChannelProvider, ConnectResult, ExchangeInput, Issue, MediaItem, ProviderContext,
  PublishRequest, PublishResult, RefreshInput, TokenSet,
} from '../types.ts';
import { toCommentary } from './text.ts';

export const LINKEDIN_VERSION = '202610';
/** LinkedIn keeps a monthly version for at least a year; sunset from the Marketing API migrations page (checked 2026-11-10). */
export const LINKEDIN_VERSION_SUNSET = '2027-10-15';

const REST = 'https://api.linkedin.com/rest';
const OAUTH = 'https://www.linkedin.com/oauth/v2';
const enc = encodeURIComponent;

const SCOPES: Record<'personal' | 'page', string[]> = {
  // Self-serve products "Share on LinkedIn" + "Sign In with LinkedIn using OpenID Connect".
  personal: ['openid', 'profile', 'w_member_social'],
  // Community Management API (approval required).
  page: ['w_organization_social', 'r_organization_social', 'rw_organization_admin'],
};

const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/gif'];
const VIDEO_MIMES = ['video/mp4'];
const DOC_MIMES = [
  'application/pdf', 'application/msword', 'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
];
const MB = 1024 * 1024;
const VIDEO_POLL_INTERVAL_MS = 5_000;
const VIDEO_POLL_MAX = 60; // ~5 minutes

type Kind = 'personal' | 'page';

function createLinkedIn(kind: Kind): ChannelProvider {
  const id = kind === 'personal' ? 'linkedin' : 'linkedin_page';
  const fail = (k: ProviderError['kind'], msg: string, o: ConstructorParameters<typeof ProviderError>[3] = {}) =>
    new ProviderError(id, k, msg, o);

  // ---- HTTP + error classification -------------------------------------------------------------

  const version = (ctx: ProviderContext) => String(ctx.channel.settings.linkedinVersion ?? LINKEDIN_VERSION);

  function classify(op: string, res: HttpResponse, create: boolean): ProviderError {
    const detail = res.json?.message ?? res.json?.error_description ?? res.json?.serviceErrorCode ?? 'request failed';
    const o = { status: res.status, code: String(res.json?.serviceErrorCode ?? res.json?.code ?? res.status) };
    const msg = `${op} -> ${res.status}: ${detail}`;
    if (res.status === 401) return fail('reconnect', msg, o);
    if (res.status === 426) return fail('fatal', `${msg} (LinkedIn-Version sunset: bump LINKEDIN_VERSION)`, { ...o, code: 'version_sunset' });
    if (res.status === 429) return fail('retryable', msg, { ...o, retryAfterMs: retryAfterMs(res.headers) });
    if (res.status >= 500) return fail(create ? 'unknown_outcome' : 'retryable', msg, o);
    return fail('fatal', msg, o);
  }

  async function call(
    ctx: ProviderContext, op: string,
    req: { method?: string; path: string; query?: string; body?: unknown },
    opts: { create?: boolean; okStatuses?: number[] } = {},
  ): Promise<HttpResponse> {
    const url = `${REST}/${req.path}${req.query ? `?${req.query}` : ''}`;
    return ctx.tracer.span(`${id}.${op}`, { provider: id, channel: ctx.channel.id }, async (span) => {
      let res: HttpResponse;
      try {
        res = await ctx.http.request({
          method: req.method ?? 'GET',
          url,
          headers: {
            Authorization: `Bearer ${ctx.token.accessToken}`,
            'LinkedIn-Version': version(ctx),
            'X-Restli-Protocol-Version': '2.0.0',
            ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        });
      } catch (e) {
        if (e instanceof TransportError) {
          throw fail(opts.create && e.timedOut ? 'unknown_outcome' : 'retryable', `${op}: ${e.message}`, { cause: e });
        }
        throw e;
      }
      span.setAttribute('http.status', res.status);
      if (res.ok || opts.okStatuses?.includes(res.status)) return res;
      throw classify(op, res, Boolean(opts.create));
    });
  }

  async function putBytes(ctx: ProviderContext, op: string, uploadUrl: string, bytes: Uint8Array, mime: string) {
    let res: HttpResponse;
    try {
      res = await ctx.http.request({
        method: 'PUT', url: uploadUrl, body: bytes,
        headers: { Authorization: `Bearer ${ctx.token.accessToken}`, 'Content-Type': mime, 'Content-Length': String(bytes.byteLength) },
        timeoutMs: 300_000,
      });
    } catch (e) {
      throw fail('retryable', `${op}: ${(e as Error).message}`, { cause: e });
    }
    if (!res.ok) throw classify(op, res, false);
    return res;
  }

  // ---- media uploads -----------------------------------------------------------------------------

  async function uploadImage(ctx: ProviderContext, item: MediaItem): Promise<string> {
    const init = await call(ctx, 'images.initializeUpload', {
      method: 'POST', path: 'images', query: 'action=initializeUpload',
      body: { initializeUploadRequest: { owner: ctx.channel.externalId } },
    });
    const { uploadUrl, image } = init.json?.value ?? {};
    if (!uploadUrl || !image) throw fail('retryable', 'images.initializeUpload returned no uploadUrl/image');
    await putBytes(ctx, 'images.upload', uploadUrl, await ctx.media.read(item.id), item.mime);
    return image;
  }

  async function uploadDocument(ctx: ProviderContext, item: MediaItem): Promise<string> {
    const init = await call(ctx, 'documents.initializeUpload', {
      method: 'POST', path: 'documents', query: 'action=initializeUpload',
      body: { initializeUploadRequest: { owner: ctx.channel.externalId } },
    });
    const { uploadUrl, document } = init.json?.value ?? {};
    if (!uploadUrl || !document) throw fail('retryable', 'documents.initializeUpload returned no uploadUrl/document');
    await putBytes(ctx, 'documents.upload', uploadUrl, await ctx.media.read(item.id), item.mime);
    return document;
  }

  async function uploadVideo(ctx: ProviderContext, item: MediaItem): Promise<string> {
    const bytes = await ctx.media.read(item.id);
    const init = await call(ctx, 'videos.initializeUpload', {
      method: 'POST', path: 'videos', query: 'action=initializeUpload',
      body: { initializeUploadRequest: {
        owner: ctx.channel.externalId, fileSizeBytes: bytes.byteLength, uploadCaptions: false, uploadThumbnail: false,
      } },
    });
    const { video, uploadToken = '', uploadInstructions = [] } = init.json?.value ?? {};
    if (!video || !uploadInstructions.length) throw fail('retryable', 'videos.initializeUpload returned no instructions');
    const etags: string[] = [];
    for (const part of uploadInstructions as { uploadUrl: string; firstByte: number; lastByte: number }[]) {
      const res = await putBytes(ctx, 'videos.uploadPart', part.uploadUrl,
        bytes.subarray(part.firstByte, part.lastByte + 1), 'application/octet-stream');
      const etag = res.headers.get('etag');
      if (!etag) throw fail('retryable', 'video part upload returned no ETag');
      etags.push(etag);
    }
    await call(ctx, 'videos.finalizeUpload', {
      method: 'POST', path: 'videos', query: 'action=finalizeUpload',
      body: { finalizeUploadRequest: { video, uploadToken, uploadedPartIds: etags } },
    });
    for (let i = 0; i < VIDEO_POLL_MAX; i++) {
      const st = (await call(ctx, 'videos.get', { path: `videos/${enc(video)}` })).json?.status;
      if (st === 'AVAILABLE') return video;
      if (st === 'PROCESSING_FAILED') throw fail('fatal', `video ${video} processing failed`, { code: 'video_processing_failed' });
      await ctx.sleep(VIDEO_POLL_INTERVAL_MS);
    }
    throw fail('retryable', `video ${video} still processing after ${(VIDEO_POLL_MAX * VIDEO_POLL_INTERVAL_MS) / 1000}s`);
  }

  async function buildContent(ctx: ProviderContext, req: PublishRequest): Promise<Record<string, unknown> | undefined> {
    const images = req.media.filter((m) => m.kind === 'image');
    const [video] = req.media.filter((m) => m.kind === 'video');
    const [doc] = req.media.filter((m) => m.kind === 'document');
    if (video) return { media: { id: await uploadVideo(ctx, video), title: video.title ?? req.title ?? '' } };
    if (doc) return { media: { id: await uploadDocument(ctx, doc), title: doc.title ?? req.title ?? '' } };
    if (images.length === 1) {
      const [img] = images as [MediaItem];
      return { media: { id: await uploadImage(ctx, img), ...(img.altText ? { altText: img.altText } : {}) } };
    }
    if (images.length > 1) {
      const out = [];
      for (const img of images) out.push({ id: await uploadImage(ctx, img), ...(img.altText ? { altText: img.altText } : {}) });
      return { multiImage: { images: out } };
    }
    if (req.linkUrl) return { article: { source: req.linkUrl, title: req.title ?? req.linkUrl } };
    return undefined;
  }

  const postUrl = (urn: string) => `https://www.linkedin.com/feed/update/${urn}/`;

  // ---- provider ------------------------------------------------------------------------------------

  const provider: ChannelProvider = {
    id,
    displayName: kind === 'personal' ? 'LinkedIn (personal profile)' : 'LinkedIn Page',
    channelKind: kind as ChannelKind,
    capabilities: {
      post: { text: true, image: true, maxImages: 20, video: true, document: true, carousel: true,
              thread: false, firstComment: true, textOnlyAllowed: true },
      delete: true,
      // Reading a member's own posts needs r_member_social (closed), so personal posts cannot be looked up.
      reconcile: kind === 'page',
    },
    limits: {
      maxChars: 3000, maxCommentChars: 1250,
      maxVideoBytes: 500 * MB, maxDocumentBytes: 100 * MB,
      imageMimes: IMAGE_MIMES, videoMimes: VIDEO_MIMES, documentMimes: DOC_MIMES,
    },
    auth: {
      type: 'oauth2', scopes: SCOPES[kind], refreshable: kind === 'page', tokenLifetimeDays: 60,
      secretNames: { clientId: 'LINKEDIN_CLIENT_ID', clientSecret: 'LINKEDIN_CLIENT_SECRET' },
    },
    apiVersion: { value: LINKEDIN_VERSION, sunsetsOn: LINKEDIN_VERSION_SUNSET },

    authorizeUrl({ clientId, redirectUri, state }) {
      const q = new URLSearchParams({
        response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state, scope: SCOPES[kind].join(' '),
      });
      return `${OAUTH}/authorization?${q}`;
    },

    async exchangeCode(input: ExchangeInput): Promise<ConnectResult> {
      const res = await tokenRequest(input.http, new URLSearchParams({
        grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri,
        client_id: input.clientId, client_secret: input.clientSecret,
      }), 'fatal');
      const token = toTokenSet(res.json, input.now());
      const missing = SCOPES[kind].filter((s) => token.scopes && !token.scopes.includes(s));
      if (missing.length) {
        throw fail('fatal', `LinkedIn did not grant: ${missing.join(', ')}. Check the app's products, then reconnect.`, { code: 'missing_scopes' });
      }
      const http = input.http;
      const auth = { Authorization: `Bearer ${token.accessToken}` };
      if (kind === 'personal') {
        const me = await http.request({ url: 'https://api.linkedin.com/v2/userinfo', headers: auth });
        if (!me.ok || !me.json?.sub) throw fail('fatal', `userinfo -> ${me.status}`, { status: me.status });
        return { token, accounts: [{ externalId: `urn:li:person:${me.json.sub}`, displayName: me.json.name ?? me.json.sub, kind: 'personal' }] };
      }
      const restHeaders = { ...auth, 'LinkedIn-Version': LINKEDIN_VERSION, 'X-Restli-Protocol-Version': '2.0.0' };
      const acls = await http.request({
        url: `${REST}/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&count=50`, headers: restHeaders,
      });
      if (!acls.ok) throw fail('fatal', `organizationAcls -> ${acls.status}`, { status: acls.status });
      const accounts = [];
      for (const el of (acls.json?.elements ?? []) as { organization?: string; organizationTarget?: string }[]) {
        const urn = el.organization ?? el.organizationTarget;
        if (!urn) continue;
        const org = await http.request({ url: `${REST}/organizations/${urn.split(':').pop()}`, headers: restHeaders });
        accounts.push({ externalId: urn, displayName: org.json?.localizedName ?? urn, kind: 'page' as const });
      }
      return { token, accounts };
    },

    async refresh(input: RefreshInput): Promise<TokenSet> {
      if (!input.token.refreshToken) {
        throw fail('reconnect', 'no refresh token (self-serve LinkedIn apps get none): reconnect within 60 days', { code: 'no_refresh_token' });
      }
      const res = await tokenRequest(input.http, new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: input.token.refreshToken,
        client_id: input.clientId, client_secret: input.clientSecret,
      }), 'reconnect');
      const next = toTokenSet(res.json, input.now());
      return { ...next, refreshToken: next.refreshToken ?? input.token.refreshToken,
               refreshExpiresAt: next.refreshExpiresAt ?? input.token.refreshExpiresAt };
    },

    validate(req: PublishRequest): Issue[] {
      const issues: Issue[] = [];
      const add = (field: string, code: string, message: string) => issues.push({ field, code, message });
      const text = req.text ?? '';
      if ([...text].length > 3000) add('text', 'too_long', `LinkedIn allows 3000 characters, got ${[...text].length}`);
      const images = req.media.filter((m) => m.kind === 'image');
      const videos = req.media.filter((m) => m.kind === 'video');
      const docs = req.media.filter((m) => m.kind === 'document');
      if (!text.trim() && !req.media.length && !req.linkUrl) add('text', 'empty', 'post has no text, media or link');
      if ([images.length > 0, videos.length > 0, docs.length > 0].filter(Boolean).length > 1) {
        add('media', 'mixed', 'LinkedIn posts carry images, one video or one document — not a mix');
      }
      if (videos.length > 1) add('media', 'too_many_videos', 'one video per post');
      if (docs.length > 1) add('media', 'too_many_documents', 'one document per post');
      if (images.length > 20) add('media', 'too_many_images', 'at most 20 images per post');
      for (const m of images) if (!IMAGE_MIMES.includes(m.mime)) add('media', 'image_type', `${m.mime} is not JPG/PNG/GIF`);
      for (const m of videos) {
        if (!VIDEO_MIMES.includes(m.mime)) add('media', 'video_type', `${m.mime} is not MP4`);
        if (m.sizeBytes > 500 * MB || m.sizeBytes < 75 * 1024) add('media', 'video_size', 'video must be 75 KB to 500 MB');
      }
      for (const m of docs) {
        if (!DOC_MIMES.includes(m.mime)) add('media', 'document_type', `${m.mime} is not PDF/PPT/PPTX/DOC/DOCX`);
        if (m.sizeBytes > 100 * MB) add('media', 'document_size', 'document must be at most 100 MB');
        if (!(m.title ?? req.title)) add('title', 'required', 'a document post needs a title');
      }
      const fc = req.settings.firstComment;
      if (fc !== undefined && (typeof fc !== 'string' || [...fc].length > 1250)) {
        add('settings.firstComment', 'invalid', 'first comment must be text of at most 1250 characters');
      }
      return issues;
    },

    async publish(ctx: ProviderContext, req: PublishRequest): Promise<PublishResult> {
      const issues = provider.validate(req);
      if (issues.length) throw fail('fatal', `invalid post: ${issues.map((i) => i.message).join('; ')}`, { code: 'validation' });
      const content = await buildContent(ctx, req);
      const body = {
        author: ctx.channel.externalId,
        commentary: toCommentary(req.text ?? ''),
        visibility: req.settings.visibility === 'CONNECTIONS' && kind === 'personal' ? 'CONNECTIONS' : 'PUBLIC',
        distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
        ...(content ? { content } : {}),
      };
      let res: HttpResponse;
      try {
        res = await call(ctx, 'posts.create', { method: 'POST', path: 'posts', body }, { create: true });
      } catch (e) {
        // LinkedIn rejects an identical recent post with 422 naming the existing URN: that post IS ours.
        const dup = e instanceof ProviderError && e.status === 422 && /duplicate.*?(urn:li:(?:share|ugcPost):\d+)/i.exec(e.message);
        if (dup && dup[1]) return { externalId: dup[1], url: postUrl(dup[1]) };
        throw e;
      }
      const urn = res.headers.get('x-restli-id') ?? res.json?.id;
      if (!urn) throw fail('unknown_outcome', 'posts.create returned no post id', { status: res.status });
      return { externalId: urn, url: postUrl(urn) };
    },

    async reconcile(ctx: ProviderContext, req: PublishRequest): Promise<PublishResult | null> {
      if (kind !== 'page') throw unsupported(id, 'reconcile');
      const res = await call(ctx, 'posts.byAuthor', {
        path: 'posts', query: `q=author&author=${enc(ctx.channel.externalId)}&count=10&sortBy=LAST_MODIFIED`,
      });
      const want = toCommentary(req.text ?? '');
      const hit = ((res.json?.elements ?? []) as { id: string; commentary?: string }[]).find((p) => p.commentary === want);
      return hit ? { externalId: hit.id, url: postUrl(hit.id) } : null;
    },

    async delete(ctx: ProviderContext, externalId: string): Promise<void> {
      await call(ctx, 'posts.delete', { method: 'DELETE', path: `posts/${enc(externalId)}` }, { okStatuses: [404] });
    },

    async comment(ctx: ProviderContext, externalId: string, text: string) {
      const res = await call(ctx, 'comments.create', {
        method: 'POST', path: `socialActions/${enc(externalId)}/comments`,
        body: { actor: ctx.channel.externalId, object: externalId, message: { text } }, // plain text, no escaping
      }, { create: true });
      const cid = res.headers.get('x-restli-id') ?? res.json?.commentUrn ?? res.json?.id;
      if (!cid) throw fail('unknown_outcome', 'comments.create returned no id');
      return { externalId: String(cid) };
    },
  };

  async function tokenRequest(http: HttpClient, form: URLSearchParams, onReject: 'fatal' | 'reconnect') {
    let res: HttpResponse;
    try {
      res = await http.request({
        method: 'POST', url: `${OAUTH}/accessToken`, body: form,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    } catch (e) {
      throw fail('retryable', `token endpoint: ${(e as Error).message}`, { cause: e });
    }
    if (res.status >= 500 || res.status === 429) throw fail('retryable', `token endpoint -> ${res.status}`, { status: res.status });
    if (!res.ok || !res.json?.access_token) {
      throw fail(onReject, `token endpoint -> ${res.status}: ${res.json?.error ?? 'rejected'}`, { status: res.status, code: res.json?.error });
    }
    return res;
  }

  return provider;
}

function toTokenSet(j: any, now: Date): TokenSet {
  const at = (secs: unknown) => (typeof secs === 'number' ? new Date(now.getTime() + secs * 1000) : undefined);
  const t: TokenSet = { accessToken: j.access_token };
  if (j.refresh_token) t.refreshToken = j.refresh_token;
  const exp = at(j.expires_in);
  if (exp) t.expiresAt = exp;
  const rexp = at(j.refresh_token_expires_in);
  if (rexp) t.refreshExpiresAt = rexp;
  if (typeof j.scope === 'string') t.scopes = j.scope.split(/[ ,]+/).filter(Boolean);
  return t;
}

export const linkedinPersonal = createLinkedIn('personal');
export const linkedinPage = createLinkedIn('page');
