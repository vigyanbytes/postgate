// HeyGen avatar video (API v3). Written from HeyGen's public developer docs (read 2026-11-10):
//   Create video   https://developers.heygen.com/reference/create-video        POST /v3/videos  (type "avatar")
//   Video details  https://developers.heygen.com/reference/get-video           GET  /v3/videos/{video_id}
//   Status values  https://developers.heygen.com/video-details                 pending -> processing -> completed | failed
//   Errors         https://developers.heygen.com/docs/error-codes              {"error": {"code", "message", "request_id"}}
//   Limits         https://developers.heygen.com/docs/usage-limits             script <= 5,000 characters
//   Versions       https://developers.heygen.com/endpoint-version-comparison   v1/v2 sunset 2026-10-31; v3 is supported
//   Avatars/voices GET /v3/avatars/looks (data[].id), GET /v3/models/audio/voices (data[].voice_id)
// Auth: header x-api-key. There is no free test mode: every successful create spends credits.
import { ProviderError } from '../providers/errors.ts';
import { retryAfterMs, TransportError, type HttpClient, type HttpResponse } from '../providers/http.ts';
import type { MediaContext, MediaJobRequest, MediaJobStatus, MediaProvider } from './types.ts';

export const HEYGEN_API = 'https://api.heygen.com';
const ID = 'heygen';
const MAX_SCRIPT = 5000;
const ASPECT = ['16:9', '9:16', '1:1', '4:5', '5:4'];
const RES = ['720p', '1080p'];

function classify(op: string, res: HttpResponse, create: boolean): ProviderError {
  const err = res.json?.error ?? {};
  const code = String(err.code ?? res.status);
  const msg = `${op} -> ${res.status}: ${code}${err.message ? ` ${err.message}` : ''}${err.request_id ? ` (request ${err.request_id})` : ''}`;
  if (res.status === 429) return new ProviderError(ID, 'retryable', msg, { status: 429, code, retryAfterMs: retryAfterMs(res.headers) ?? 60_000 });
  if (res.status >= 500) return new ProviderError(ID, create ? 'unknown_outcome' : 'retryable', msg, { status: res.status, code });
  // 401 bad key, 402 credits/plan, 400 invalid/consent/policy, 404 avatar/voice: a human must act.
  return new ProviderError(ID, 'fatal', msg, { status: res.status, code });
}

async function call(ctx: MediaContext, op: string, method: string, path: string, body?: unknown, create = false): Promise<HttpResponse> {
  let res: HttpResponse;
  try {
    res = await ctx.http.request({ method, url: `${HEYGEN_API}${path}`, timeoutMs: 60_000,
      headers: { 'x-api-key': ctx.apiKey, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch (e) {
    if (e instanceof TransportError) throw new ProviderError(ID, create && e.timedOut ? 'unknown_outcome' : 'retryable', `${op}: ${e.message}`);
    throw e;
  }
  if (!res.ok) throw classify(op, res, create);
  return res;
}

export const heygen: MediaProvider = {
  id: ID,
  capabilities: ['avatar_video'],
  keyEnv: 'HEYGEN_API_TOKEN',
  docs: ['https://developers.heygen.com/reference/create-video', 'https://developers.heygen.com/reference/get-video'],

  validate({ capability, params: p }) {
    const out: string[] = [];
    if (capability !== 'avatar_video') out.push(`heygen: ${capability} is not supported (avatar_video only)`);
    if (typeof p.script !== 'string' || !p.script.trim()) out.push('script is required');
    else if ([...p.script].length > MAX_SCRIPT) out.push(`script allows ${MAX_SCRIPT} characters, got ${[...p.script].length}`);
    if (typeof p.avatarId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(p.avatarId)) out.push('avatarId is required (a look id from HeyGen)');
    if (p.voiceId !== undefined && (typeof p.voiceId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(p.voiceId))) out.push('voiceId is not a valid id');
    if (p.aspectRatio !== undefined && !ASPECT.includes(p.aspectRatio)) out.push(`aspectRatio must be one of ${ASPECT.join(', ')}`);
    if (p.resolution !== undefined && !RES.includes(p.resolution)) out.push(`resolution must be ${RES.join(' or ')}`);
    if (p.title !== undefined && (typeof p.title !== 'string' || p.title.length > 200)) out.push('title must be text of at most 200 characters');
    return out;
  },

  async submit(ctx, req: MediaJobRequest) {
    const problems = heygen.validate(req);
    if (problems.length) throw new ProviderError(ID, 'fatal', `invalid request: ${problems.join('; ')}`, { code: 'validation' });
    const p = req.params;
    const res = await call(ctx, 'videos.create', 'POST', '/v3/videos', {
      type: 'avatar', avatar_id: p.avatarId, script: p.script,
      ...(p.voiceId ? { voice_id: p.voiceId } : {}), aspect_ratio: p.aspectRatio ?? '16:9', resolution: p.resolution ?? '720p',
      title: p.title ?? `postgate ${req.idempotencyKey.slice(0, 8)}`, callback_id: req.idempotencyKey,
    }, true);
    const id = res.json?.data?.video_id;
    if (!id) throw new ProviderError(ID, 'unknown_outcome', 'videos.create returned no video_id');
    return { externalJobId: String(id) };
  },

  async poll(ctx, externalJobId): Promise<MediaJobStatus> {
    const res = await call(ctx, 'videos.get', 'GET', `/v3/videos/${encodeURIComponent(externalJobId)}`);
    const d = res.json?.data ?? {};
    if (d.status === 'completed') {
      if (!d.video_url) return { state: 'failed', error: 'completed without a video_url' };
      return { state: 'done', output: { fetchUrl: String(d.video_url), mime: 'video/mp4' },
        usage: { ...(typeof d.duration === 'number' ? { durationSeconds: d.duration } : {}), provider: ID } };
    }
    if (d.status === 'failed') return { state: 'failed', error: `${d.failure_code ?? 'failed'}: ${d.failure_message ?? 'no message'}` };
    return { state: 'running' };
  },
};

/** Read-only listing for choosing ids (`postgate heygen avatars|voices`). */
export async function heygenList(http: HttpClient, apiKey: string, what: 'avatars' | 'voices'): Promise<{ id: string; name: string; extra: string }[]> {
  const ctx: MediaContext = { apiKey, http, now: () => new Date() };
  if (what === 'avatars') {
    const r = await call(ctx, 'avatars.looks', 'GET', '/v3/avatars/looks?limit=50');
    return ((r.json?.data ?? []) as any[]).map((a) => ({ id: String(a.id), name: String(a.name ?? ''), extra: `${a.avatar_type ?? ''} default voice ${a.default_voice_id ?? '-'}` }));
  }
  const r = await call(ctx, 'voices.list', 'GET', '/v3/models/audio/voices?type=public&limit=100');
  return ((r.json?.data ?? []) as any[]).map((v) => ({ id: String(v.voice_id), name: String(v.name ?? ''), extra: `${v.language ?? ''} ${v.status ?? ''}`.trim() }));
}

export const MEDIA_PROVIDERS: Record<string, MediaProvider> = { heygen };
