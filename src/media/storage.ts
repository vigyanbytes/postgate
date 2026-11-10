// Media on local disk (a Docker volume in the compose setup). The API writes, the worker reads.
// Files are content-addressed: <tenant>/<sha256>.<ext>, so an upload repeated by a retrying client is one file.
// Platforms that PULL media (Instagram; Facebook photos/videos) need a public URL: when POSTGATE_PUBLIC_URL and
// POSTGATE_MEDIA_URL_SECRET are set, publicUrl() returns <public>/media/<key>?exp=…&sig=… (HMAC-SHA256, short-lived),
// served by the API without an API key. Without them those platforms fail with a clear `no_public_url` error.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { MediaStorage } from '../worker/types.ts';

export const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv',
  'application/pdf': 'pdf', 'application/msword': 'doc', 'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

export const kindOfMime = (mime: string): 'image' | 'video' | 'document' | null =>
  !MIME_EXT[mime] ? null : mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'document';

const KEY = /^[0-9a-f-]{36}\/[0-9a-f]{64}\.[a-z0-9]{2,5}$/;

export interface DiskStorage extends MediaStorage {
  save(tenantId: string, bytes: Uint8Array, mime: string): Promise<{ storageKey: string; sha256: string }>;
  /** Checks a signed public URL's query and returns the key's bytes, or null when the signature is bad/expired. */
  readSigned(storageKey: string, exp: string | null, sig: string | null, now?: Date): Promise<Uint8Array | null>;
}

export function diskStorage(opts: { dir: string; publicBaseUrl?: string; urlSecret?: string; urlTtlSeconds?: number; now?: () => Date }): DiskStorage {
  const root = resolve(opts.dir);
  const now = opts.now ?? (() => new Date());
  const path = (key: string) => {
    if (!KEY.test(key)) throw new Error('invalid storage key');
    const p = resolve(join(root, key));
    if (!p.startsWith(root + sep)) throw new Error('invalid storage key');
    return p;
  };
  const sign = (key: string, exp: number) => createHmac('sha256', opts.urlSecret ?? '').update(`${key}\n${exp}`).digest('base64url');
  const canSign = Boolean(opts.publicBaseUrl && opts.urlSecret && opts.urlSecret.length >= 16);

  const storage: DiskStorage = {
    async save(tenantId, bytes, mime) {
      const ext = MIME_EXT[mime];
      if (!ext) throw new Error(`unsupported media type ${mime}`);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const storageKey = `${tenantId}/${sha256}.${ext}`;
      const p = path(storageKey);
      await mkdir(dirname(p), { recursive: true });
      const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, bytes, { mode: 0o640 });
      await rename(tmp, p);
      return { storageKey, sha256 };
    },
    async read(storageKey) {
      return new Uint8Array(await readFile(path(storageKey)));
    },
    async readSigned(storageKey, exp, sig, at = now()) {
      if (!canSign || !exp || !sig || !KEY.test(storageKey)) return null;
      const e = Number(exp);
      if (!Number.isInteger(e) || e * 1000 < at.getTime()) return null;
      const want = Buffer.from(sign(storageKey, e));
      const got = Buffer.from(sig);
      if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
      try { return await storage.read(storageKey); } catch { return null; }
    },
  };
  if (canSign) {
    storage.publicUrl = async (storageKey: string) => {
      path(storageKey);
      const exp = Math.floor(now().getTime() / 1000) + (opts.urlTtlSeconds ?? 3600);
      return `${opts.publicBaseUrl!.replace(/\/+$/, '')}/media/${storageKey}?exp=${exp}&sig=${sign(storageKey, exp)}`;
    };
  }
  return storage;
}
