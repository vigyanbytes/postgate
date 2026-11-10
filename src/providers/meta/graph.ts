// Meta Graph API conventions shared by Facebook Pages and Instagram (Instagram Login).
// Written from the official docs only (clean-room):
//   Error handling   https://developers.facebook.com/docs/graph-api/guides/error-handling
//   Rate limiting    https://developers.facebook.com/docs/graph-api/overview/rate-limiting
//   Versioning       https://developers.facebook.com/docs/graph-api/guides/versioning
import { ProviderError } from '../errors.ts';
import { retryAfterMs, type HttpResponse } from '../http.ts';
import type { Classify } from '../shared.ts';

/** Pinned Graph API version. Meta keeps a version for at least two years after the next one ships. */
export const META_GRAPH_VERSION = 'v24.0';
/** Estimated end of v24.0 availability (verify on the versioning page when bumping). */
export const META_GRAPH_SUNSET = '2027-10-01';

// Throttling codes: app (4), user (17), page/business-use-case (32, 613, 80001-80014).
const THROTTLE = new Set([4, 17, 32, 613]);
// Token unusable: expired/invalid (190), session (102), password changed / logged out (463, 467).
const RECONNECT = new Set([102, 190, 463, 467]);

export function metaClassifier(provider: string): Classify {
  return (op: string, res: HttpResponse, create: boolean): ProviderError => {
    const err = res.json?.error ?? {};
    const code = Number(err.code ?? 0);
    const sub = err.error_subcode;
    const msg = `${op} -> ${res.status}: ${err.message ?? 'request failed'}${code ? ` (code ${code}${sub ? `/${sub}` : ''})` : ''}`;
    const o = { status: res.status, code: String(code || res.status) };
    if (RECONNECT.has(code) || res.status === 401) return new ProviderError(provider, 'reconnect', msg, o);
    if (THROTTLE.has(code) || (code >= 80001 && code <= 80014) || res.status === 429) {
      return new ProviderError(provider, 'retryable', msg, { ...o, retryAfterMs: retryAfterMs(res.headers) ?? 3_600_000 });
    }
    if (code === 506) return new ProviderError(provider, 'fatal', `${msg}: duplicate post`, { ...o, code: 'duplicate' });
    if (err.is_transient === true || code === 1 || code === 2 || res.status >= 500) {
      return new ProviderError(provider, create ? 'unknown_outcome' : 'retryable', msg, o);
    }
    return new ProviderError(provider, 'fatal', msg, o);
  };
}
