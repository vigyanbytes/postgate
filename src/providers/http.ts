// HTTP for providers: injected fetch (mocked in tests), timeout, and redaction so tokens never reach
// errors or logs. Providers classify status codes; this layer only reports what happened.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpRequest {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | URLSearchParams | FormData;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  json: any;
  text: string;
}

/** Thrown when no response arrived; `timedOut` tells a create call its outcome is unknown. */
export class TransportError extends Error {
  readonly timedOut: boolean;
  constructor(message: string, timedOut: boolean, cause?: unknown) {
    super(message, { cause });
    this.name = 'TransportError';
    this.timedOut = timedOut;
  }
}

export const redact = (s: string): string =>
  String(s)
    .replace(/(access_token|refresh_token|client_secret|code|token)=[^&\s"]+/gi, '$1=***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer ***');

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export function httpClient(fetchImpl: FetchLike = fetch, defaultTimeoutMs = 30_000): HttpClient {
  return {
    async request({ method = 'GET', url, headers, body, timeoutMs = defaultTimeoutMs }) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(url, { method, headers, body: body as BodyInit | undefined, signal: ctrl.signal });
      } catch (e) {
        const timedOut = (e as Error).name === 'AbortError';
        throw new TransportError(
          `${method} ${redact(url)} failed: ${timedOut ? `timed out after ${timeoutMs} ms` : redact((e as Error).message)}`,
          timedOut,
        );
      } finally {
        clearTimeout(timer);
      }
      const text = await res.text();
      let json: unknown = undefined;
      if (text) {
        try { json = JSON.parse(text); } catch { json = undefined; }
      }
      return { status: res.status, ok: res.ok, headers: res.headers, json: json ?? {}, text: text.slice(0, 2000) };
    },
  };
}

/** Retry-After as milliseconds (seconds or HTTP date); undefined when absent or unparseable. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const v = headers.get('retry-after');
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** True when `url` points at this machine only (http(s)://127.0.0.1 | localhost | [::1]). */
export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * STAND-IN MODE (tests, `postgate standin`, local rehearsals). Every request for https://<host>/<path> goes to
 * <base>/<host>/<path> instead, where a local stand-in server answers like the platform would. The base must be a
 * loopback URL: this switch can only ever keep traffic ON this machine, never send a token somewhere new.
 * Requests that already target loopback (e.g. an upload URL the stand-in handed out) pass through unchanged.
 */
export function standinFetch(base: string, fetchImpl: FetchLike = fetch): FetchLike {
  if (!isLoopbackUrl(base)) throw new Error(`stand-in base must be a loopback URL (127.0.0.1, localhost, ::1), got ${redact(base)}`);
  const root = base.replace(/\/+$/, '');
  return (input, init) => {
    if (isLoopbackUrl(input)) return fetchImpl(input, init);
    const u = new URL(input);
    return fetchImpl(`${root}/${u.host}${u.pathname}${u.search}`, init);
  };
}
