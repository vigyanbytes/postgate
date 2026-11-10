import type { Db } from '../db/db.ts';
import type { CredentialDeps } from '../credentials/store.ts';
import type { HttpClient } from '../providers/http.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { Tracer } from '../telemetry/tracer.ts';
import type { Job } from '../queue/queue.ts';

/** Where media bytes live (disk by default; S3-like stores fit the same shape); keyed by media_assets.storage_key. */
export interface MediaStorage {
  read(storageKey: string): Promise<Uint8Array>;
  /** Short-lived signed public URL; required by platforms that pull media (Instagram, Facebook video). */
  publicUrl?(storageKey: string): Promise<string>;
  /** Needed by media generation jobs, which store their output. */
  save?(tenantId: string, bytes: Uint8Array, mime: string): Promise<{ storageKey: string; sha256: string }>;
}

export interface WorkerDeps {
  /** Connection acting as role social_worker. */
  db: Db;
  registry: ProviderRegistry;
  credentials: CredentialDeps;
  http: HttpClient;
  storage: MediaStorage;
  tracer: Tracer;
  workerId: string;
  now(): Date;
  sleep(ms: number): Promise<void>;
  random?: () => number;
  /** Downloads a generated file (media jobs). Same network path as platform calls (stand-in mode applies). */
  download?(url: string, maxBytes: number): Promise<{ bytes: Uint8Array; mime: string }>;
}

export type Outcome =
  | { status: 'done' }
  | { status: 'retry'; error: object; retryAfterMs?: number }
  | { status: 'dead'; error: object };

export type Handler = (job: Job, deps: WorkerDeps) => Promise<Outcome>;
