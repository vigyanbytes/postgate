// Plumbing shared by the providers written after LinkedIn: one traced JSON call with transport errors
// mapped to the error taxonomy, OAuth token parsing, and the media-mix helpers every validate() needs.
// Each provider still owns its status-code classification (platforms disagree on what 403 means).
import { ProviderError } from './errors.ts';
import { TransportError, type HttpClient, type HttpRequest, type HttpResponse } from './http.ts';
import type { Issue, MediaItem, ProviderContext, PublishRequest, TokenSet } from './types.ts';

export type Classify = (op: string, res: HttpResponse, create: boolean) => ProviderError;

export interface CallOpts {
  /** A create call: a timeout or 5xx may have created the object (unknown_outcome, never blind retry). */
  create?: boolean;
  okStatuses?: number[];
}

/** One platform call inside a span. Tokens go in headers built by the caller; never in span attributes. */
export async function traced(
  ctx: ProviderContext, provider: string, op: string, req: HttpRequest, classify: Classify, opts: CallOpts = {},
): Promise<HttpResponse> {
  return ctx.tracer.span(`${provider}.${op}`, { provider, channel: ctx.channel.id }, async (span) => {
    let res: HttpResponse;
    try {
      res = await ctx.http.request(req);
    } catch (e) {
      if (e instanceof TransportError) {
        throw new ProviderError(provider, opts.create && e.timedOut ? 'unknown_outcome' : 'retryable', `${op}: ${e.message}`, { cause: e });
      }
      throw e;
    }
    span.setAttribute('http.status', res.status);
    if (res.ok || opts.okStatuses?.includes(res.status)) return res;
    throw classify(op, res, Boolean(opts.create));
  });
}

/** OAuth token endpoint POST; 5xx/429/network are retryable, a rejection is `onReject`. */
export async function tokenRequest(
  provider: string, http: HttpClient, url: string, form: URLSearchParams, onReject: 'fatal' | 'reconnect',
  headers: Record<string, string> = {},
): Promise<HttpResponse> {
  let res: HttpResponse;
  try {
    res = await http.request({ method: 'POST', url, body: form, headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers } });
  } catch (e) {
    throw new ProviderError(provider, 'retryable', `token endpoint: ${(e as Error).message}`, { cause: e });
  }
  if (res.status >= 500 || res.status === 429) throw new ProviderError(provider, 'retryable', `token endpoint -> ${res.status}`, { status: res.status });
  if (!res.ok || !res.json?.access_token) {
    const code = res.json?.error?.code ?? res.json?.error;
    throw new ProviderError(provider, onReject, `token endpoint -> ${res.status}: ${typeof code === 'string' ? code : 'rejected'}`,
      { status: res.status, ...(typeof code === 'string' ? { code } : {}) });
  }
  return res;
}

/** Standard OAuth JSON -> TokenSet. `scope` may be space- or comma-separated. */
export function toTokenSet(j: any, now: Date): TokenSet {
  const at = (secs: unknown) => (typeof secs === 'number' && secs > 0 ? new Date(now.getTime() + secs * 1000) : undefined);
  const t: TokenSet = { accessToken: String(j.access_token) };
  if (j.refresh_token) t.refreshToken = j.refresh_token;
  const exp = at(j.expires_in);
  if (exp) t.expiresAt = exp;
  const rexp = at(j.refresh_token_expires_in);
  if (rexp) t.refreshExpiresAt = rexp;
  if (typeof j.scope === 'string') t.scopes = j.scope.split(/[ ,]+/).filter(Boolean);
  return t;
}

export const byKind = (req: PublishRequest) => ({
  images: req.media.filter((m) => m.kind === 'image'),
  videos: req.media.filter((m) => m.kind === 'video'),
  docs: req.media.filter((m) => m.kind === 'document'),
});

export function issues() {
  const list: Issue[] = [];
  return { list, add: (field: string, code: string, message: string) => list.push({ field, code, message }) };
}

export const chars = (s: string) => [...s].length;

export const hashtagCount = (s: string) => (s.match(/(^|\s)#[\p{L}\p{M}\p{N}_]+/gu) ?? []).length;

/** Meta pulls media from a URL; the worker's storage must provide one. */
export async function publicUrl(ctx: ProviderContext, provider: string, item: MediaItem): Promise<string> {
  if (!ctx.media.publicUrl) {
    throw new ProviderError(provider, 'fatal', 'media storage cannot issue public URLs (needed for this platform)', { code: 'no_public_url' });
  }
  return ctx.media.publicUrl(item.id);
}

export const validationError = (provider: string, list: Issue[]) =>
  new ProviderError(provider, 'fatal', `invalid post: ${list.map((i) => i.message).join('; ')}`, { code: 'validation' });

export const MB = 1024 * 1024;
