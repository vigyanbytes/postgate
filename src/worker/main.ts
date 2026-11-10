// Worker process: environment -> config -> WorkerDeps -> claim loop until SIGTERM/SIGINT.
// Run: DATABASE_URL=… node src/worker/main.ts
//
// Env (only DATABASE_URL is required):
//   DATABASE_URL             Postgres; the worker acts as role social_worker inside every transaction
//   POSTGATE_WORKER_ID       default <hostname>-<pid>; POSTGATE_POLL_MS (15000), POSTGATE_BATCH (10)
//   POSTGATE_MEDIA_DIR       media files written by the API (same directory / volume)
//   POSTGATE_PUBLIC_URL + POSTGATE_MEDIA_URL_SECRET   signed media URLs (Instagram, Facebook pull media from a URL)
//   POSTGATE_KEK_VERSION     only for envelope-encrypted channel credentials: current key version
//   POSTGATE_STANDIN_URL     REHEARSAL ONLY: send every platform call to a local stand-in (loopback URL) instead
// Channel tokens are read from the environment variable each channel names (channel_credentials.env_ref).
import { hostname } from 'node:os';
import pg from 'pg';
import { keyRingFromSecrets } from '../credentials/envelope.ts';
import { envSecretResolver } from '../credentials/secrets.ts';
import { pgDb } from '../db/db.ts';
import { diskStorage } from '../media/storage.ts';
import { httpClient, standinFetch, type FetchLike } from '../providers/http.ts';
import { defaultRegistry } from '../providers/registry.ts';
import { noopTracer } from '../telemetry/tracer.ts';
import type { WorkerDeps } from './types.ts';
import { createWorker } from './worker.ts';

type Env = Record<string, string | undefined>;

export interface WorkerConfig {
  databaseUrl: string;
  workerId: string;
  pollMs: number;
  batchSize: number;
  kekVersion?: number;
  mediaDir?: string;
  publicUrl?: string;
  mediaUrlSecret?: string;
  standinUrl?: string;
}

const int = (v: string | undefined, def: number, name: string) => {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
};

export function workerConfig(env: Env): WorkerConfig {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const cfg: WorkerConfig = {
    databaseUrl: env.DATABASE_URL,
    workerId: env.POSTGATE_WORKER_ID || `${hostname()}-${process.pid}`,
    pollMs: int(env.POSTGATE_POLL_MS, 15_000, 'POSTGATE_POLL_MS'),
    batchSize: int(env.POSTGATE_BATCH, 10, 'POSTGATE_BATCH'),
  };
  if (env.POSTGATE_KEK_VERSION) cfg.kekVersion = int(env.POSTGATE_KEK_VERSION, 1, 'POSTGATE_KEK_VERSION');
  if (env.POSTGATE_MEDIA_DIR) cfg.mediaDir = env.POSTGATE_MEDIA_DIR;
  if (env.POSTGATE_PUBLIC_URL) cfg.publicUrl = env.POSTGATE_PUBLIC_URL;
  if (env.POSTGATE_MEDIA_URL_SECRET) cfg.mediaUrlSecret = env.POSTGATE_MEDIA_URL_SECRET;
  if (env.POSTGATE_STANDIN_URL) cfg.standinUrl = env.POSTGATE_STANDIN_URL;
  return cfg;
}

export function buildDeps(cfg: WorkerConfig, opts: { pool: pg.Pool; env: Env; fetch?: typeof fetch }): WorkerDeps {
  const base = opts.fetch ?? fetch;
  const routed = cfg.standinUrl ? standinFetch(cfg.standinUrl, base) : base;
  const http = httpClient(routed);
  const secrets = envSecretResolver(opts.env);
  const storage = cfg.mediaDir
    ? diskStorage({ dir: cfg.mediaDir, ...(cfg.publicUrl ? { publicBaseUrl: cfg.publicUrl } : {}), ...(cfg.mediaUrlSecret ? { urlSecret: cfg.mediaUrlSecret } : {}) })
    : { read: async () => { throw new Error('media storage is not configured for this worker (POSTGATE_MEDIA_DIR)'); } };
  return {
    db: pgDb(opts.pool, { role: 'social_worker' }),
    registry: defaultRegistry(),
    credentials: { secrets, ...(cfg.kekVersion ? { keyRing: keyRingFromSecrets(secrets, cfg.kekVersion) } : {}) },
    http,
    storage,
    tracer: noopTracer,
    workerId: cfg.workerId,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    download: (url, max) => downloadBytes(routed, url, max),
  };
}

/** GET a file into memory with a size cap (generated media from a provider's short-lived URL). */
export async function downloadBytes(f: FetchLike, url: string, maxBytes: number): Promise<{ bytes: Uint8Array; mime: string }> {
  const res = await f(url, { signal: AbortSignal.timeout(600_000) });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new Error(`download larger than ${maxBytes} bytes`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error(`download larger than ${maxBytes} bytes`);
  return { bytes, mime: (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim() };
}

/** One AbortController that SIGTERM or SIGINT aborts; the run loop finishes its current job and returns. */
export function stopOnSignals(proc: Pick<NodeJS.Process, 'once'> = process): AbortController {
  const ctl = new AbortController();
  const stop = () => { if (!ctl.signal.aborted) ctl.abort(); };
  proc.once('SIGTERM', stop);
  proc.once('SIGINT', stop);
  return ctl;
}

async function main() {
  const cfg = workerConfig(process.env);
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 4 });
  const deps = buildDeps(cfg, { pool, env: process.env });
  const ctl = stopOnSignals();
  if (cfg.standinUrl) console.log(`[postgate-worker] STAND-IN MODE: every platform call goes to ${cfg.standinUrl}; nothing reaches a real network`);
  console.log(`[postgate-worker] ${cfg.workerId} started; media=${Boolean(cfg.mediaDir)} publicMediaUrls=${Boolean(deps.storage.publicUrl)}`);
  try {
    await createWorker(deps, { batchSize: cfg.batchSize, pollMs: cfg.pollMs }).run(ctl.signal);
  } finally {
    await pool.end();
    console.log(`[postgate-worker] ${cfg.workerId} stopped`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`[postgate-worker] ${(e as Error).message}`); process.exit(1); });
}
