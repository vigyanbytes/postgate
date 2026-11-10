// What went wrong decides what the worker does next. See docs/ARCHITECTURE.md §4 and §7.
//   retryable        nothing was created; try again later (429, 5xx on idempotent calls, network before send)
//   reconnect        the channel's token is unusable; a human must reconnect (401, refresh impossible)
//   fatal            retrying cannot help (validation, 400/403/422, API version sunset, unsupported)
//   unknown_outcome  a create call may have succeeded (timeout or 5xx on POST); never blindly retry
export type ProviderErrorKind = 'retryable' | 'reconnect' | 'fatal' | 'unknown_outcome';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: string;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    provider: string,
    kind: ProviderErrorKind,
    message: string,
    opts: { status?: number; code?: string; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(`${provider}: ${message}`, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ProviderError';
    this.provider = provider;
    this.kind = kind;
    this.status = opts.status;
    this.code = opts.code;
    this.retryAfterMs = opts.retryAfterMs;
  }

  toJSON() {
    return { kind: this.kind, provider: this.provider, status: this.status, code: this.code, message: this.message };
  }
}

export const unsupported = (provider: string, what: string) =>
  new ProviderError(provider, 'fatal', `${what} is not supported`, { code: 'unsupported' });
