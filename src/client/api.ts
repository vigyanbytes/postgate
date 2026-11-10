// Thin client for the HTTP API, shared by the CLI and the MCP server. The pgate_ key decides the tenant and what
// the caller may do; this client adds nothing to that.
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export type Request = (method: string, path: string, opts?: { query?: Record<string, string | number | undefined>; body?: unknown;
  raw?: { bytes: Uint8Array; contentType: string } }) => Promise<any>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: unknown;
  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(`${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export function apiClient(o: { baseUrl: string | undefined; key: string | undefined; fetch?: FetchFn; timeoutMs?: number }): Request {
  if (!o.baseUrl) throw new Error('POSTGATE_URL is not set (e.g. http://127.0.0.1:8787)');
  if (!o.key) throw new Error('POSTGATE_KEY is not set (a pgate_ key)');
  const base = o.baseUrl.replace(/\/+$/, '');
  const f = o.fetch ?? fetch;
  return async (method, path, opts = {}) => {
    const q = new URLSearchParams(Object.entries(opts.query ?? {}).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
    const headers: Record<string, string> = { Authorization: `Bearer ${o.key}` };
    let body: BodyInit | undefined;
    if (opts.raw) { headers['content-type'] = opts.raw.contentType; body = opts.raw.bytes as BodyInit; }
    else if (opts.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body); }
    const res = await f(`${base}${path}${[...q].length ? `?${q}` : ''}`, {
      method, headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
    });
    const text = await res.text();
    let json: any = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) throw new ApiError(res.status, String(json?.error ?? 'error'), String(json?.message ?? text), json?.detail);
    return json;
  };
}

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  pdf: 'application/pdf', doc: 'application/msword', ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export const mimeOfPath = (p: string): string | undefined => EXT_MIME[p.toLowerCase().split('.').pop() ?? ''];
