// `postgate doctor`: check one channel's configuration and show the EXACT requests a publish would make, without
// sending anything. The provider's real publish code runs against the in-process stand-in (src/standin), so the
// method, URL, headers and body of every call are the ones the worker would send. Replies (ids, upload URLs) come
// from the stand-in, so values that a real platform hands back differ.
// The token is never put into a dry-run request: the Authorization header shows the variable NAME instead.
// `whoami` is the one live check: a single read-only GET to the platform, only when asked (--live).
import { LINKEDIN_VERSION } from '../providers/linkedin/index.ts';
import { META_GRAPH_VERSION } from '../providers/meta/graph.ts';
import { httpClient, type HttpClient } from '../providers/http.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { ChannelKind, MediaItem, PublishRequest } from '../providers/types.ts';
import { createStandin, inProcessFetch } from '../standin/standin.ts';
import { parseTokenValue } from '../credentials/store.ts';
import { SECRET_NAME } from '../credentials/secrets.ts';
import { noopTracer } from '../telemetry/tracer.ts';
import { ProviderError } from '../providers/errors.ts';

export interface DoctorMedia { bytes: Uint8Array; mime: string; kind: MediaItem['kind']; altText?: string; title?: string; name?: string }

export interface DoctorInput {
  provider: string;
  externalId: string;
  tokenEnv: string;
  kind?: ChannelKind;
  channelSettings?: Record<string, unknown>;
  post: { text: string; title?: string; linkUrl?: string; settings?: Record<string, unknown>; media?: DoctorMedia[] };
  env: Record<string, string | undefined>;
  now?: Date;
}

export interface Check { name: string; level: 'ok' | 'warn' | 'fail'; detail: string }
export interface DryRequest { method: string; url: string; headers: Record<string, string>; body: unknown }
export interface DoctorReport { provider: string; ok: boolean; checks: Check[]; requests: DryRequest[]; result?: unknown; error?: string }

const ID_SHAPE: Record<string, [RegExp, string]> = {
  linkedin: [/^urn:li:person:[A-Za-z0-9_-]+$/, 'urn:li:person:<id> (from GET /v2/userinfo "sub")'],
  linkedin_page: [/^urn:li:organization:\d+$/, 'urn:li:organization:<number>'],
  facebook_page: [/^\d+$/, 'the numeric Page id'],
  instagram: [/^\d+$/, 'the numeric Instagram professional account id (user_id)'],
  youtube: [/^UC[A-Za-z0-9_-]{22}$/, 'the channel id (UC… 24 characters)'],
  x: [/^\d+$/, 'the numeric X user id'],
};

/** Platforms that download media from a URL instead of receiving bytes. */
const PULLS_MEDIA = new Set(['facebook_page', 'instagram']);

function summarize(headers: Record<string, string>, body: Uint8Array, tokenEnv: string): { headers: Record<string, string>; body: unknown } {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) h[k] = k === 'authorization' ? v.replace(/^(Bearer|Basic)\s+.*/i, `$1 <value of $${tokenEnv}>`) : v;
  const ct = (headers['content-type'] ?? '').toLowerCase();
  const text = Buffer.from(body).toString('utf8');
  let b: unknown = body.byteLength ? `<${body.byteLength} bytes>` : undefined;
  if (ct.includes('json')) { try { b = JSON.parse(text); } catch { b = text; } }
  else if (ct.includes('x-www-form-urlencoded')) b = Object.fromEntries(new URLSearchParams(text));
  else if (ct.includes('multipart/form-data')) b = `<multipart form, ${body.byteLength} bytes>`;
  return { headers: h, body: b };
}

export async function doctor(input: DoctorInput, registry: ProviderRegistry): Promise<DoctorReport> {
  const now = input.now ?? new Date();
  const checks: Check[] = [];
  const add = (name: string, level: Check['level'], detail: string) => checks.push({ name, level, detail });
  if (!registry.has(input.provider)) {
    add('provider', 'fail', `unknown provider ${input.provider}; known: ${registry.list().map((p) => p.id).join(', ')}`);
    return { provider: input.provider, ok: false, checks, requests: [] };
  }
  const provider = registry.get(input.provider);
  add('provider', 'ok', `${provider.displayName} (${provider.id})`);

  // Token: by name only. Report its shape, never its value.
  if (!SECRET_NAME.test(input.tokenEnv)) add('token', 'fail', `${input.tokenEnv} is not a valid environment variable name`);
  else {
    const raw = input.env[input.tokenEnv];
    if (!raw) add('token', 'fail', `$${input.tokenEnv} is not set in this environment (the worker needs it too)`);
    else {
      try {
        const t = parseTokenValue(raw);
        const parts = [raw.trim().startsWith('{') ? 'JSON token set' : `bare token (${raw.trim().length} chars)`];
        if (t.refreshToken) parts.push('has refresh token');
        if (t.expiresAt) {
          const days = (t.expiresAt.getTime() - now.getTime()) / 86_400_000;
          parts.push(`expires ${t.expiresAt.toISOString()}`);
          if (days < 0 && !(provider.auth.refreshable && t.refreshToken)) add('token', 'fail', `${parts.join(', ')}: EXPIRED, reconnect`);
          else if (days < 7) add('token', 'warn', `${parts.join(', ')}: expires within 7 days`);
          else add('token', 'ok', parts.join(', '));
        } else add('token', 'ok', `${parts.join(', ')}${provider.auth.tokenLifetimeDays ? `; no expiry recorded (platform default ~${provider.auth.tokenLifetimeDays} days)` : ''}`);
        if (provider.auth.refreshable && t.refreshToken) {
          const missing = [provider.auth.secretNames.clientId, provider.auth.secretNames.clientSecret].filter((n) => n && !input.env[n]);
          add('app credentials', missing.length ? 'warn' : 'ok',
            missing.length ? `refresh needs $${missing.join(' and $')} in the worker's environment` : 'present for token refresh');
        }
      } catch (e) {
        add('token', 'fail', `$${input.tokenEnv} is set but unreadable: ${(e as Error).message}`);
      }
    }
  }

  const shape = ID_SHAPE[provider.id];
  if (shape) add('account id', shape[0].test(input.externalId) ? 'ok' : 'warn', shape[0].test(input.externalId) ? input.externalId : `${input.externalId} does not look like ${shape[1]}`);

  if (provider.apiVersion) {
    const days = Math.floor((Date.parse(provider.apiVersion.sunsetsOn) - now.getTime()) / 86_400_000);
    add('api version', days > 60 ? 'ok' : days > 0 ? 'warn' : 'fail', `${provider.apiVersion.value}, sunsets ${provider.apiVersion.sunsetsOn} (${days} days)`);
  }

  const media = input.post.media ?? [];
  if (media.length && PULLS_MEDIA.has(provider.id)) {
    const okUrl = Boolean(input.env.POSTGATE_PUBLIC_URL && (input.env.POSTGATE_MEDIA_URL_SECRET?.length ?? 0) >= 16);
    add('public media url', okUrl ? 'ok' : 'fail', okUrl
      ? `${provider.displayName} will download media from ${input.env.POSTGATE_PUBLIC_URL}/media/… (must be reachable from the internet over https)`
      : `${provider.displayName} downloads media from a URL: set POSTGATE_PUBLIC_URL (public https base of the API) and POSTGATE_MEDIA_URL_SECRET (>= 16 chars)`);
  }

  const items: MediaItem[] = media.map((m, i) => ({ id: `m${i + 1}`, kind: m.kind, mime: m.mime, sizeBytes: m.bytes.byteLength,
    ...(m.altText ? { altText: m.altText } : {}), ...(m.title ? { title: m.title } : {}) }));
  const req: PublishRequest = { idempotencyKey: 'doctor-dry-run', text: input.post.text, media: items, settings: input.post.settings ?? {},
    ...(input.post.title ? { title: input.post.title } : {}), ...(input.post.linkUrl ? { linkUrl: input.post.linkUrl } : {}) };
  const issues = provider.validate(req);
  for (const i of issues) add(`post ${i.field}`, 'fail', `${i.code}: ${i.message}`);
  if (!issues.length) add('post', 'ok', 'passes this platform\'s rules as we know them');

  // Dry run: the real publish code against the in-process stand-in. Placeholder token, nothing leaves the process.
  const standin = createStandin();
  const http = httpClient(inProcessFetch(standin));
  const base = (input.env.POSTGATE_PUBLIC_URL || 'https://media.example.invalid').replace(/\/+$/, '');
  let result: unknown;
  let error: string | undefined;
  try {
    result = await provider.publish({
      channel: { id: 'doctor', kind: input.kind ?? provider.channelKind, externalId: input.externalId, settings: input.channelSettings ?? {} },
      token: { accessToken: `DRY-RUN-${input.tokenEnv}` }, http, tracer: noopTracer, now: () => now, sleep: async () => {},
      media: {
        read: async (id) => media[Number(id.slice(1)) - 1]!.bytes,
        publicUrl: async (id) => `${base}/media/<tenant>/<sha256-of-${media[Number(id.slice(1)) - 1]?.name ?? id}>?exp=…&sig=…`,
      },
    }, req);
  } catch (e) {
    error = e instanceof ProviderError ? `${e.kind}: ${e.message}` : (e as Error).message;
  }
  const requests = standin.calls.map((c) => ({ method: c.method, url: c.url, ...summarize(c.headers, c.body, input.tokenEnv) }));
  if (error && !issues.length) add('dry run', 'fail', error);
  else if (!error) add('dry run', 'ok', `${requests.length} request(s) built; nothing was sent`);
  return { provider: provider.id, ok: !checks.some((c) => c.level === 'fail'), checks, requests, ...(result ? { result } : {}), ...(error ? { error } : {}) };
}

/** The one live check (`doctor --live`): a single read-only GET that proves the token works for this account. */
export async function whoami(providerId: string, externalId: string, token: string, http: HttpClient = httpClient()): Promise<{ ok: boolean; status: number; account?: string; matches?: boolean; detail: string }> {
  const auth = { Authorization: `Bearer ${token}` };
  const li = { ...auth, 'LinkedIn-Version': LINKEDIN_VERSION, 'X-Restli-Protocol-Version': '2.0.0' };
  const reqs: Record<string, { url: string; headers: Record<string, string>; pick(j: any): string | undefined }> = {
    linkedin: { url: 'https://api.linkedin.com/v2/userinfo', headers: auth, pick: (j) => j.sub && `urn:li:person:${j.sub} (${j.name ?? ''})` },
    linkedin_page: { url: `https://api.linkedin.com/rest/organizations/${externalId.split(':').pop()}`, headers: li, pick: (j) => j.localizedName ?? (j.id && String(j.id)) },
    facebook_page: { url: `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(externalId)}?fields=id,name`, headers: auth, pick: (j) => j.id && `${j.id} (${j.name ?? ''})` },
    instagram: { url: `https://graph.instagram.com/${META_GRAPH_VERSION}/me?fields=user_id,username`, headers: auth, pick: (j) => j.user_id && `${j.user_id} (@${j.username ?? ''})` },
    youtube: { url: 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', headers: auth, pick: (j) => j.items?.[0] && `${j.items[0].id} (${j.items[0].snippet?.title ?? ''})` },
    x: { url: 'https://api.x.com/2/users/me', headers: auth, pick: (j) => j.data?.id && `${j.data.id} (@${j.data.username ?? ''})` },
  };
  const r = reqs[providerId];
  if (!r) return { ok: false, status: 0, detail: `no live check for ${providerId}` };
  const res = await http.request({ url: r.url, headers: r.headers, timeoutMs: 20_000 });
  const account = res.ok ? r.pick(res.json) : undefined;
  // Page names cannot be compared with the id; every other account reply starts with the id.
  const matches = account && providerId !== 'linkedin_page' ? account.startsWith(externalId) : undefined;
  return { ok: Boolean(res.ok && account), status: res.status, ...(account ? { account } : {}), ...(matches !== undefined ? { matches } : {}),
    detail: res.ok ? (account ? `token works as ${account}` : 'unexpected reply shape') : `${res.status}: ${JSON.stringify(res.json).slice(0, 300)}` };
}
