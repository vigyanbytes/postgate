// Test doubles: a scripted HTTP server for providers and a migrated PGlite database.
import { PGlite } from '@electric-sql/pglite';
import { pgliteDb, type Db } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';
import { httpClient, type FetchLike } from '../src/providers/http.ts';
import type { ProviderContext, TokenSet } from '../src/providers/types.ts';
import { noopTracer } from '../src/telemetry/tracer.ts';

export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status?: number; json?: unknown; headers?: Record<string, string> } | Error;
interface Route { method: string; match: RegExp; reply: Reply | ((r: Recorded) => Reply); times: number }

/** Routes are matched in order; each route answers `times` requests (default: unlimited). */
export function mockServer() {
  const routes: Route[] = [];
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = async (url, init = {}) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const raw = init.body;
    const body = typeof raw === 'string' ? safeJson(raw) : raw instanceof URLSearchParams ? Object.fromEntries(raw) : raw;
    const rec: Recorded = { method: init.method ?? 'GET', url, headers, body };
    calls.push(rec);
    const route = routes.find((r) => r.times > 0 && r.method === rec.method && r.match.test(url));
    if (!route) return new Response(JSON.stringify({ message: `no mock for ${rec.method} ${url}` }), { status: 599 });
    route.times--;
    const reply = typeof route.reply === 'function' ? route.reply(rec) : route.reply;
    if (reply instanceof Error) throw reply;
    const status = reply.status ?? 200;
    return new Response(status === 204 || reply.json === undefined ? null : JSON.stringify(reply.json),
      { status, headers: reply.headers ?? {} });
  };
  const api = {
    calls,
    http: httpClient(fetchImpl),
    on(method: string, match: RegExp, reply: Route['reply'], times = Infinity) {
      routes.push({ method, match, reply, times });
      return api;
    },
    find: (method: string, match: RegExp) => calls.filter((c) => c.method === method && match.test(c.url)),
  };
  return api;
}

const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return s; } };

export function ctxFor(
  server: ReturnType<typeof mockServer>,
  channel: Partial<ProviderContext['channel']> = {},
  media: Record<string, Uint8Array> = {},
  token: TokenSet = { accessToken: 'test-access-token' },
): ProviderContext {
  return {
    channel: { id: 'ch-1', kind: 'personal', externalId: 'urn:li:person:abc', settings: {}, ...channel },
    token,
    http: server.http,
    media: { read: async (id) => media[id] ?? new Uint8Array([1, 2, 3]) },
    tracer: noopTracer,
    now: () => new Date('2026-10-19T10:00:00Z'),
    sleep: async () => {},
  };
}

export async function freshDb(): Promise<{ pg: PGlite; db: Db; worker: Db; app: Db }> {
  const pg = new PGlite();
  const db = pgliteDb(pg);
  await migrate(db);
  // Same connection, but every transaction assumes the runtime role, so RLS and grants are exercised.
  return { pg, db, worker: pgliteDb(pg, { role: 'social_worker' }), app: pgliteDb(pg, { role: 'social_app' }) };
}

export const TENANT_A = '00000000-0000-4000-8000-00000000000a';
export const TENANT_B = '00000000-0000-4000-8000-00000000000b';
