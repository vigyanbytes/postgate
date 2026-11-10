// Stand-in platform APIs. NOT the real networks: a local imitation of the endpoints this project calls on
// LinkedIn, Facebook Pages, Instagram, YouTube and X, shaped after their public documentation (see each provider's
// header for the doc links). Three uses:
//   * tests and the end-to-end suite (as an HTTP server on 127.0.0.1, reached through standinFetch in http.ts);
//   * `postgate doctor` dry runs (in-process, so the exact request sequence is built and nothing is sent);
//   * `postgate standin` for rehearsing the whole flow locally before a first real post.
// A stand-in passing proves our request building, sequencing and error handling. It does NOT prove a real platform
// accepts the request (app review, scopes, account type, media rules): that is what docs/REAL-TEST.md is for.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FetchLike } from '../providers/http.ts';

export interface StandinRequest { method: string; url: string; headers: Record<string, string>; body: Uint8Array }
export interface StandinReply { status: number; headers?: Record<string, string>; json?: unknown }

export interface StandinPost {
  provider: 'linkedin' | 'facebook' | 'instagram' | 'youtube' | 'x';
  id: string;
  author: string;
  text: string;
  body: unknown;
  deleted: boolean;
  comments: string[];
}

export interface StandinState {
  calls: StandinRequest[];
  posts: StandinPost[];
  /** Answer the next matching request(s) with this reply instead (fault injection). */
  fail(method: string, match: RegExp, reply: StandinReply, times?: number): void;
  /** Tokens the stand-in treats as revoked (401, like an expired or revoked token). */
  revoked: Set<string>;
  /** Media URLs the stand-in fetched (Meta pulls media from a public URL). */
  pulled: { url: string; status: number; bytes: number }[];
  handle(req: StandinRequest): Promise<StandinReply>;
}

const text = (b: Uint8Array) => Buffer.from(b).toString('utf8');
function parseBody(req: StandinRequest): any {
  const ct = (req.headers['content-type'] ?? '').toLowerCase();
  const t = text(req.body);
  if (ct.includes('json')) { try { return JSON.parse(t); } catch { return {}; } }
  if (ct.includes('x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(t));
  return { bytes: req.body.byteLength };
}

type Route = { method: string; host: RegExp; path: RegExp; auth: boolean; fn: (r: Ctx) => Promise<StandinReply> | StandinReply };
interface Ctx { req: StandinRequest; url: URL; m: RegExpExecArray; body: any; token: string }

const graphErr = (status: number, message: string, code: number) => ({ status, json: { error: { message, type: 'OAuthException', code } } });

export function createStandin(opts: { pullMedia?: FetchLike } = {}): StandinState {
  let seq = 1000;
  const next = () => String(++seq);
  const faults: { method: string; match: RegExp; reply: StandinReply; times: number }[] = [];
  const state: StandinState = {
    calls: [], posts: [], revoked: new Set(), pulled: [],
    fail(method, match, reply, times = 1) { faults.push({ method, match, reply, times }); },
    handle,
  };
  const containers = new Map<string, { status: string; body: any }>();
  const uploads = new Map<string, { kind: string; size: number }>();

  async function pull(url: unknown): Promise<StandinReply | null> {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return graphErr(400, 'media url missing', 100);
    if (!opts.pullMedia) return null;
    try {
      const res = await opts.pullMedia(url);
      const b = new Uint8Array(await res.arrayBuffer());
      state.pulled.push({ url, status: res.status, bytes: b.byteLength });
      if (!res.ok) return graphErr(400, `could not download media (${res.status})`, 9004);
    } catch (e) {
      state.pulled.push({ url, status: 0, bytes: 0 });
      return graphErr(400, `could not download media: ${(e as Error).message}`, 9004);
    }
    return null;
  }

  const post = (provider: StandinPost['provider'], author: string, txt: string, body: unknown, id = next()): StandinPost => {
    const p = { provider, id, author, text: txt, body, deleted: false, comments: [] };
    state.posts.push(p);
    return p;
  };
  const find = (id: string) => state.posts.find((p) => p.id === id && !p.deleted);
  const token = (provider: string) => ({ status: 200, json: { access_token: `standin-${provider}-access`, refresh_token: `standin-${provider}-refresh`,
    expires_in: 3600, refresh_token_expires_in: 31536000, token_type: 'bearer' } });

  const routes: Route[] = [];
  const on = (method: string, host: RegExp, path: RegExp, fn: Route['fn'], auth = true) => routes.push({ method, host, path, fn, auth });

  // ---- LinkedIn -----------------------------------------------------------------------------------------------
  const LI = /^api\.linkedin\.com$/;
  const liUpload = (kind: string, size = 0) => { const n = next(); uploads.set(n, { kind, size }); return `https://www.linkedin.com/dms-uploads/${kind}/${n}`; };
  on('POST', /^www\.linkedin\.com$/, /^\/oauth\/v2\/accessToken$/, ({ body }) =>
    body.grant_type ? { ...token('linkedin'), json: { ...(token('linkedin').json as object), scope: 'openid,profile,w_member_social,w_organization_social,r_organization_social,rw_organization_admin' } }
      : { status: 400, json: { error: 'invalid_request' } }, false);
  on('GET', LI, /^\/v2\/userinfo$/, () => ({ status: 200, json: { sub: 'standin-member', name: 'Stand-in Member' } }));
  on('GET', LI, /^\/rest\/organizationAcls$/, () => ({ status: 200, json: { elements: [{ organization: 'urn:li:organization:5550001' }] } }));
  on('GET', LI, /^\/rest\/organizations\/(\d+)$/, ({ m }) => ({ status: 200, json: { id: Number(m[1]), localizedName: 'Stand-in Page' } }));
  on('POST', LI, /^\/rest\/(images|documents)$/, ({ url, m, body }) => {
    if (url.searchParams.get('action') !== 'initializeUpload' || !body?.initializeUploadRequest?.owner) return { status: 400, json: { message: 'bad initializeUpload' } };
    const kind = m[1] === 'images' ? 'image' : 'document';
    return { status: 200, json: { value: { uploadUrl: liUpload(kind), [kind]: `urn:li:${kind}:${next()}` } } };
  });
  on('POST', LI, /^\/rest\/videos$/, ({ url, body }) => {
    if (url.searchParams.get('action') === 'finalizeUpload') return { status: 200, json: {} };
    const size = Number(body?.initializeUploadRequest?.fileSizeBytes ?? 0);
    if (!size) return { status: 400, json: { message: 'fileSizeBytes required' } };
    return { status: 200, json: { value: { video: `urn:li:video:${next()}`, uploadToken: '',
      uploadInstructions: [{ uploadUrl: liUpload('video', size), firstByte: 0, lastByte: size - 1 }] } } };
  });
  on('PUT', /^www\.linkedin\.com$/, /^\/dms-uploads\/\w+\/\d+$/, ({ req }) => ({ status: 201, headers: { etag: `"etag-${req.body.byteLength}"` } }));
  on('GET', LI, /^\/rest\/videos\/(.+)$/, () => ({ status: 200, json: { status: 'AVAILABLE' } }));
  on('POST', LI, /^\/rest\/posts$/, ({ body }) => {
    if (!body?.author || typeof body.commentary !== 'string' || body.lifecycleState !== 'PUBLISHED') return { status: 422, json: { message: 'invalid post' } };
    const dup = state.posts.find((p) => p.provider === 'linkedin' && !p.deleted && p.author === body.author && p.text === body.commentary);
    if (dup) return { status: 422, json: { message: `Content is a duplicate of ${dup.id}` } };
    const p = post('linkedin', body.author, body.commentary, body, `urn:li:share:${next()}`);
    return { status: 201, headers: { 'x-restli-id': p.id } };
  });
  on('GET', LI, /^\/rest\/posts$/, ({ url }) => ({ status: 200, json: { elements: state.posts
    .filter((p) => p.provider === 'linkedin' && !p.deleted && p.author === url.searchParams.get('author')).slice(-10).reverse()
    .map((p) => ({ id: p.id, commentary: p.text })) } }));
  on('DELETE', LI, /^\/rest\/posts\/(.+)$/, ({ m }) => {
    const p = find(decodeURIComponent(m[1]!));
    if (!p) return { status: 404, json: { message: 'not found' } };
    p.deleted = true;
    return { status: 204 };
  });
  on('POST', LI, /^\/rest\/socialActions\/(.+)\/comments$/, ({ m, body }) => {
    const p = find(decodeURIComponent(m[1]!));
    if (!p) return { status: 404, json: { message: 'not found' } };
    p.comments.push(String(body?.message?.text ?? ''));
    return { status: 201, headers: { 'x-restli-id': `urn:li:comment:(${p.id},${next()})` } };
  });

  // ---- Meta: Facebook Pages + Instagram ----------------------------------------------------------------------
  const FB = /^graph(-video)?\.facebook\.com$/;
  const V = '/v\\d+\\.\\d+';
  on('GET', FB, new RegExp(`^${V}/oauth/access_token$`), ({ url }) =>
    url.searchParams.get('code') || url.searchParams.get('fb_exchange_token') ? token('facebook') : graphErr(400, 'missing code', 100), false);
  on('GET', FB, new RegExp(`^${V}/me/accounts$`), () => ({ status: 200, json: { data: [
    { id: '5550002', name: 'Stand-in Page', access_token: 'standin-page-token', tasks: ['CREATE_CONTENT', 'MANAGE'] }] } }), false);
  on('POST', FB, new RegExp(`^${V}/(\\w+)/feed$`), ({ m, body }) => {
    if (!body?.message && !body?.link && !body?.attached_media) return graphErr(400, 'empty post', 100);
    return { status: 200, json: { id: post('facebook', m[1]!, body.message ?? '', body, `${m[1]}_${next()}`).id } };
  });
  on('POST', FB, new RegExp(`^${V}/(\\w+)/photos$`), async ({ m, body }) => {
    const bad = await pull(body?.url);
    if (bad) return bad;
    const photo = next();
    if (body.published === false) return { status: 200, json: { id: photo } };
    return { status: 200, json: { id: photo, post_id: post('facebook', m[1]!, body.message ?? '', body, `${m[1]}_${photo}`).id } };
  });
  on('POST', FB, new RegExp(`^${V}/(\\w+)/videos$`), async ({ m, body }) => {
    const bad = await pull(body?.file_url);
    if (bad) return bad;
    return { status: 200, json: { id: post('facebook', m[1]!, body.description ?? '', body).id } };
  });
  on('GET', FB, new RegExp(`^${V}/(\\w+)/posts$`), ({ m }) => ({ status: 200, json: { data: state.posts
    .filter((p) => p.provider === 'facebook' && !p.deleted && p.author === m[1]).slice(-10).reverse()
    .map((p) => ({ id: p.id, message: p.text, permalink_url: `https://www.facebook.com/${p.id}` })) } }));
  on('POST', FB, new RegExp(`^${V}/(\\w+)/comments$`), ({ m, body }) => {
    const p = find(m[1]!);
    if (!p) return graphErr(400, 'object does not exist', 100);
    p.comments.push(String(body?.message ?? ''));
    return { status: 200, json: { id: `${m[1]}_c${next()}` } };
  });
  on('DELETE', FB, new RegExp(`^${V}/(\\w+)$`), ({ m }) => {
    const p = find(m[1]!);
    if (!p) return graphErr(404, 'object does not exist', 100);
    p.deleted = true;
    return { status: 200, json: { success: true } };
  });
  on('GET', FB, new RegExp(`^${V}/(\\w+)$`), ({ m }) => ({ status: 200, json: { id: m[1], name: 'Stand-in Page' } }));

  const IG = /^graph\.instagram\.com$/;
  on('POST', /^api\.instagram\.com$/, /^\/oauth\/access_token$/, ({ body }) => body.code
    ? { status: 200, json: { access_token: 'standin-ig-short', user_id: 5550003, permissions: 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_insights' } }
    : { status: 400, json: { error_message: 'missing code' } }, false);
  on('GET', IG, /^\/access_token$/, () => ({ status: 200, json: { access_token: 'standin-ig-long', token_type: 'bearer', expires_in: 5184000 } }), false);
  on('GET', IG, /^\/refresh_access_token$/, () => ({ status: 200, json: { access_token: 'standin-ig-long', token_type: 'bearer', expires_in: 5184000 } }), false);
  on('GET', IG, new RegExp(`^${V}/me$`), () => ({ status: 200, json: { user_id: '5550003', username: 'standin.account' } }));
  on('GET', IG, new RegExp(`^${V}/(\\w+)/content_publishing_limit$`), () => ({ status: 200, json: { data: [{ quota_usage: 0, config: { quota_total: 100, quota_duration: 86400 } }] } }));
  on('POST', IG, new RegExp(`^${V}/(\\w+)/media$`), async ({ body }) => {
    if (body?.media_type !== 'CAROUSEL') {
      const bad = await pull(body?.image_url ?? body?.video_url);
      if (bad) return bad;
    }
    const id = next();
    containers.set(id, { status: 'FINISHED', body });
    return { status: 200, json: { id } };
  });
  on('POST', IG, new RegExp(`^${V}/(\\w+)/media_publish$`), ({ m, body }) => {
    const c = containers.get(String(body?.creation_id));
    if (!c || c.status !== 'FINISHED') return graphErr(400, 'media not ready', 9007);
    c.status = 'PUBLISHED';
    return { status: 200, json: { id: post('instagram', m[1]!, c.body.caption ?? '', c.body).id } };
  });
  on('GET', IG, new RegExp(`^${V}/(\\w+)/media$`), ({ m }) => ({ status: 200, json: { data: state.posts
    .filter((p) => p.provider === 'instagram' && !p.deleted && p.author === m[1]).slice(-10).reverse()
    .map((p) => ({ id: p.id, caption: p.text, permalink: `https://www.instagram.com/p/${p.id}/` })) } }));
  on('POST', IG, new RegExp(`^${V}/(\\w+)/comments$`), ({ m, body }) => {
    const p = find(m[1]!);
    if (!p) return graphErr(400, 'object does not exist', 100);
    p.comments.push(String(body?.message ?? ''));
    return { status: 200, json: { id: `c${next()}` } };
  });
  on('GET', IG, new RegExp(`^${V}/(\\w+)$`), ({ m, url }) => {
    const c = containers.get(m[1]!);
    if (c && (url.searchParams.get('fields') ?? '').includes('status_code')) return { status: 200, json: { status_code: c.status, id: m[1] } };
    const p = find(m[1]!);
    if (p) return { status: 200, json: { id: p.id, permalink: `https://www.instagram.com/p/${p.id}/` } };
    return graphErr(400, 'object does not exist', 100);
  });

  // ---- YouTube ------------------------------------------------------------------------------------------------
  const G = /^www\.googleapis\.com$/;
  on('POST', /^oauth2\.googleapis\.com$/, /^\/token$/, ({ body }) => body.grant_type
    ? { ...token('google'), json: { ...(token('google').json as object), scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl' } }
    : { status: 400, json: { error: 'invalid_request' } }, false);
  on('GET', G, /^\/youtube\/v3\/channels$/, () => ({ status: 200, json: { items: [{ id: 'UCstandin0000000000000001', snippet: { title: 'Stand-in Channel' } }] } }));
  on('POST', G, /^\/upload\/youtube\/v3\/videos$/, ({ url, body, req }) => {
    if (url.searchParams.get('uploadType') !== 'resumable' || !body?.snippet?.title) return { status: 400, json: { error: { message: 'bad metadata', errors: [{ reason: 'invalidMetadata' }] } } };
    const id = next();
    containers.set(`yt${id}`, { status: 'OPEN', body: { ...body, size: Number(req.headers['x-upload-content-length'] ?? 0) } });
    return { status: 200, headers: { location: `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=${id}` } };
  });
  on('PUT', G, /^\/upload\/youtube\/v3\/videos$/, ({ url, req }) => {
    const c = containers.get(`yt${url.searchParams.get('upload_id')}`);
    if (!c || c.status !== 'OPEN') return { status: 404, json: { error: { message: 'upload session not found' } } };
    if (c.body.size && c.body.size !== req.body.byteLength) return { status: 400, json: { error: { message: 'size mismatch' } } };
    c.status = 'DONE';
    const p = post('youtube', 'mine', c.body.snippet.title, c.body, `vid${next()}`);
    return { status: 200, json: { id: p.id, snippet: c.body.snippet, status: c.body.status } };
  });
  on('GET', G, /^\/youtube\/v3\/search$/, () => ({ status: 200, json: { items: state.posts
    .filter((p) => p.provider === 'youtube' && !p.deleted).slice(-10).reverse()
    .map((p) => ({ id: { kind: 'youtube#video', videoId: p.id }, snippet: { title: p.text } })) } }));
  on('DELETE', G, /^\/youtube\/v3\/videos$/, ({ url }) => {
    const p = find(url.searchParams.get('id') ?? '');
    if (!p) return { status: 404, json: { error: { message: 'video not found', errors: [{ reason: 'videoNotFound' }] } } };
    p.deleted = true;
    return { status: 204 };
  });
  on('POST', G, /^\/youtube\/v3\/commentThreads$/, ({ body }) => {
    const p = find(body?.snippet?.videoId ?? '');
    if (!p) return { status: 404, json: { error: { message: 'video not found' } } };
    p.comments.push(String(body?.snippet?.topLevelComment?.snippet?.textOriginal ?? ''));
    return { status: 200, json: { id: `ct${next()}` } };
  });

  // ---- X ------------------------------------------------------------------------------------------------------
  const X = /^api\.x\.com$/;
  on('POST', X, /^\/2\/oauth2\/token$/, ({ body, req }) => body.grant_type && /^Basic /.test(req.headers.authorization ?? '')
    ? { ...token('x'), json: { ...(token('x').json as object), scope: 'tweet.read tweet.write users.read media.write offline.access' } }
    : { status: 400, json: { error: 'invalid_request' } }, false);
  on('GET', X, /^\/2\/users\/me$/, () => ({ status: 200, json: { data: { id: '5550004', username: 'standin_account', name: 'Stand-in' } } }));
  on('POST', X, /^\/2\/media\/upload\/initialize$/, ({ body }) => {
    if (!body?.media_type || !body?.total_bytes) return { status: 400, json: { title: 'Invalid Request', detail: 'media_type and total_bytes required' } };
    const id = next();
    uploads.set(id, { kind: String(body.media_category), size: Number(body.total_bytes) });
    return { status: 200, json: { data: { id, media_key: `3_${id}` } } };
  });
  on('POST', X, /^\/2\/media\/upload\/(\d+)\/append$/, ({ m }) => (uploads.has(m[1]!) ? { status: 200, json: {} } : { status: 404, json: { detail: 'unknown media' } }));
  on('POST', X, /^\/2\/media\/upload\/(\d+)\/finalize$/, ({ m }) => {
    const u = uploads.get(m[1]!);
    if (!u) return { status: 404, json: { detail: 'unknown media' } };
    return { status: 200, json: { data: { id: m[1], ...(u.kind === 'tweet_video' ? { processing_info: { state: 'pending', check_after_secs: 1 } } : {}) } } };
  });
  on('GET', X, /^\/2\/media\/upload$/, ({ url }) => ({ status: 200, json: { data: { id: url.searchParams.get('media_id'), processing_info: { state: 'succeeded' } } } }));
  on('POST', X, /^\/2\/media\/metadata$/, () => ({ status: 200, json: { data: { associated_metadata: true } } }));
  on('POST', X, /^\/2\/tweets$/, ({ body }) => {
    if (typeof body?.text !== 'string') return { status: 400, json: { title: 'Invalid Request', detail: 'text required' } };
    if (body.reply?.in_reply_to_tweet_id) {
      const parent = find(body.reply.in_reply_to_tweet_id);
      if (!parent) return { status: 400, json: { title: 'Invalid Request', detail: 'reply target not found' } };
    } else if (state.posts.some((p) => p.provider === 'x' && !p.deleted && p.text === body.text && body.text)) {
      return { status: 403, json: { title: 'Forbidden', detail: 'You are not allowed to create a Tweet with duplicate content.' } };
    }
    return { status: 201, json: { data: { id: post('x', '5550004', body.text, body).id, text: body.text } } };
  });
  on('GET', X, /^\/2\/users\/(\w+)\/tweets$/, () => ({ status: 200, json: { data: state.posts
    .filter((p) => p.provider === 'x' && !p.deleted).slice(-10).reverse().map((p) => ({ id: p.id, text: p.text })) } }));
  on('DELETE', X, /^\/2\/tweets\/(\w+)$/, ({ m }) => {
    const p = find(m[1]!);
    if (!p) return { status: 404, json: { title: 'Not Found Error', detail: 'post not found' } };
    p.deleted = true;
    return { status: 200, json: { data: { deleted: true } } };
  });

  async function handle(req: StandinRequest): Promise<StandinReply> {
    state.calls.push(req);
    const url = new URL(req.url);
    const fault = faults.find((f) => f.times > 0 && f.method === req.method && f.match.test(req.url));
    if (fault) { fault.times--; return fault.reply; }
    for (const r of routes) {
      if (r.method !== req.method || !r.host.test(url.host)) continue;
      const m = r.path.exec(url.pathname);
      if (!m) continue;
      const auth = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '')?.[1]
        ?? (url.host.endsWith('instagram.com') || url.host.endsWith('facebook.com') ? url.searchParams.get('access_token') ?? '' : '');
      if (r.auth && (!auth || state.revoked.has(auth))) {
        if (url.host.includes('facebook') || url.host.includes('instagram')) return graphErr(400, 'Error validating access token', 190);
        return { status: 401, json: { message: 'Unauthorized', title: 'Unauthorized', error: { message: 'invalid token' } } };
      }
      if (url.host === 'api.linkedin.com' && url.pathname.startsWith('/rest/') && !req.headers['linkedin-version']) {
        return { status: 426, json: { message: 'LinkedIn-Version header required' } };
      }
      return r.fn({ req, url, m, body: parseBody(req), token: auth });
    }
    return { status: 404, json: { message: `stand-in has no route for ${req.method} ${url.host}${url.pathname}` } };
  }

  return state;
}

const lowerHeaders = (h: HeadersInit | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  new Headers(h).forEach((v, k) => { out[k] = v; });
  return out;
};

/** In-process fetch that answers from the stand-in (no socket, no network). */
export function inProcessFetch(state: StandinState): FetchLike {
  return async (input, init = {}) => {
    const r = new Request(input, init as RequestInit);
    const headers = lowerHeaders(r.headers);
    const reply = await state.handle({ method: r.method, url: input, headers, body: new Uint8Array(await r.arrayBuffer()) });
    const body = reply.status === 204 || reply.json === undefined ? null : JSON.stringify(reply.json);
    return new Response(body, { status: reply.status, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...reply.headers } });
  };
}

/** The stand-in as an HTTP server on 127.0.0.1: GET <url>/<host>/<path> answers for https://<host>/<path>. */
export async function startStandinServer(state: StandinState, port = 0): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const [, host, ...rest] = (req.url ?? '/').split('/');
    if (host === '__standin') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ posts: state.posts, calls: state.calls.length }));
      return;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
    const reply = await state.handle({ method: req.method ?? 'GET', url: `https://${host}/${rest.join('/')}`, headers, body: new Uint8Array(Buffer.concat(chunks)) });
    const body = reply.status === 204 || reply.json === undefined ? '' : JSON.stringify(reply.json);
    res.writeHead(reply.status, { ...(body ? { 'content-type': 'application/json' } : {}), ...reply.headers });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

