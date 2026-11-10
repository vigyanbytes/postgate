// Tracing seam with the same shape as @opentelemetry/api's startActiveSpan, so the OTel SDK can be
// plugged in at the worker entry point without touching providers. Default: no-op.
// Attributes must never carry tokens or post text.

export type SpanAttributes = Record<string, string | number | boolean | undefined>;

export interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  recordException(e: unknown): void;
  setStatus(s: { code: 'ok' | 'error'; message?: string }): void;
  end(): void;
  traceId(): string | undefined;
}

export interface Tracer {
  span<T>(name: string, attrs: SpanAttributes, fn: (span: Span) => Promise<T>): Promise<T>;
}

const noopSpan: Span = {
  setAttribute() {}, recordException() {}, setStatus() {}, end() {}, traceId: () => undefined,
};

export const noopTracer: Tracer = {
  span: (_name, _attrs, fn) => fn(noopSpan),
};

/** Test helper / local debugging: keeps finished spans in memory. */
export function memoryTracer() {
  const spans: { name: string; attrs: SpanAttributes; status?: string; error?: string }[] = [];
  const tracer: Tracer = {
    async span(name, attrs, fn) {
      const rec: (typeof spans)[number] = { name, attrs: { ...attrs } };
      spans.push(rec);
      const span: Span = {
        setAttribute: (k, v) => { rec.attrs[k] = v; },
        recordException: (e) => { rec.error = (e as Error)?.message; },
        setStatus: (s) => { rec.status = s.code; },
        end() {},
        traceId: () => undefined,
      };
      try {
        const out = await fn(span);
        rec.status ??= 'ok';
        return out;
      } catch (e) {
        rec.status = 'error';
        rec.error ??= (e as Error)?.message;
        throw e;
      }
    },
  };
  return { tracer, spans };
}
