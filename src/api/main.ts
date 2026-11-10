// API process: environment -> config -> HTTP server. Run: DATABASE_URL=… node src/api/main.ts
// Env: DATABASE_URL (required; the API acts as role social_app inside every transaction)
//      POSTGATE_API_HOST (127.0.0.1), POSTGATE_API_PORT (8787), POSTGATE_CORS_ORIGINS (comma list)
//      POSTGATE_API_ALLOW_ALL_INTERFACES=1 inside a container whose port is published on loopback only
//      POSTGATE_MEDIA_DIR (media files; shared with the worker), POSTGATE_MAX_UPLOAD_MB (512)
//      POSTGATE_PUBLIC_URL + POSTGATE_MEDIA_URL_SECRET: signed media URLs for platforms that pull media (Instagram, Facebook)
import pg from 'pg';
import { pgDb } from '../db/db.ts';
import { diskStorage } from '../media/storage.ts';
import { defaultRegistry } from '../providers/registry.ts';
import { startInternalApi } from './server.ts';

type Env = Record<string, string | undefined>;
export interface ApiConfig {
  databaseUrl: string; host: string; port: number; corsOrigins: string[]; allowAllInterfaces: boolean;
  mediaDir?: string; maxUploadBytes: number; publicUrl?: string; mediaUrlSecret?: string;
}

export function apiConfig(env: Env): ApiConfig {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const port = env.POSTGATE_API_PORT ? Number(env.POSTGATE_API_PORT) : 8787;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('POSTGATE_API_PORT must be a port number');
  const mb = env.POSTGATE_MAX_UPLOAD_MB ? Number(env.POSTGATE_MAX_UPLOAD_MB) : 512;
  if (!Number.isFinite(mb) || mb <= 0) throw new Error('POSTGATE_MAX_UPLOAD_MB must be a positive number');
  if (env.POSTGATE_MEDIA_URL_SECRET && env.POSTGATE_MEDIA_URL_SECRET.length < 16) throw new Error('POSTGATE_MEDIA_URL_SECRET must be at least 16 characters');
  return {
    databaseUrl: env.DATABASE_URL, host: env.POSTGATE_API_HOST || '127.0.0.1', port,
    corsOrigins: (env.POSTGATE_CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    allowAllInterfaces: env.POSTGATE_API_ALLOW_ALL_INTERFACES === '1',
    maxUploadBytes: Math.floor(mb * 1024 * 1024),
    ...(env.POSTGATE_MEDIA_DIR ? { mediaDir: env.POSTGATE_MEDIA_DIR } : {}),
    ...(env.POSTGATE_PUBLIC_URL ? { publicUrl: env.POSTGATE_PUBLIC_URL } : {}),
    ...(env.POSTGATE_MEDIA_URL_SECRET ? { mediaUrlSecret: env.POSTGATE_MEDIA_URL_SECRET } : {}),
  };
}

export const storageFor = (c: { mediaDir?: string; publicUrl?: string; mediaUrlSecret?: string }) =>
  c.mediaDir ? diskStorage({ dir: c.mediaDir, ...(c.publicUrl ? { publicBaseUrl: c.publicUrl } : {}), ...(c.mediaUrlSecret ? { urlSecret: c.mediaUrlSecret } : {}) }) : undefined;

if (import.meta.url === `file://${process.argv[1]}`) {
  const c = apiConfig(process.env);
  const pool = new pg.Pool({ connectionString: c.databaseUrl, max: 10 });
  const storage = storageFor(c);
  const api = await startInternalApi({ db: pgDb(pool, { role: 'social_app' }), registry: defaultRegistry(), corsOrigins: c.corsOrigins,
    maxUploadBytes: c.maxUploadBytes, ...(storage ? { storage } : {}) },
    { host: c.host, port: c.port, allowAllInterfaces: c.allowAllInterfaces });
  console.log(`[postgate-api] listening on ${api.url}${storage ? '' : ' (no POSTGATE_MEDIA_DIR: media upload disabled)'}`);
  const stop = async () => { await api.close(); await pool.end(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
