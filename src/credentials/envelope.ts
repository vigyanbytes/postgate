// Envelope encryption for tenant OAuth tokens.
//   data key (DEK): random 256-bit per credential, encrypts the token JSON with AES-256-GCM
//   key-encryption key (KEK): 256-bit, from the environment by NAME (POSTGATE_KEK_V<n>), wraps the DEK
// AAD binds both ciphertexts to tenant + channel: a ciphertext copied to another row fails to open.
// Layout of each blob: iv (12) | tag (16) | ciphertext.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SecretResolver } from './secrets.ts';

export interface Kek {
  version: number;
  key: Uint8Array;
}

export interface KeyRing {
  current(): Kek;
  get(version: number): Kek;
}

export interface Sealed {
  ciphertext: Uint8Array;
  dekWrapped: Uint8Array;
  keyVersion: number;
}

export const KEK_NAME_PREFIX = 'POSTGATE_KEK_V';

function gcmSeal(key: Uint8Array, plaintext: Uint8Array, aad: string): Uint8Array {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return new Uint8Array(Buffer.concat([iv, c.getAuthTag(), ct]));
}

function gcmOpen(key: Uint8Array, blob: Uint8Array, aad: string): Uint8Array {
  const b = Buffer.from(blob);
  if (b.length < 28) throw new Error('ciphertext too short');
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(b.subarray(12, 28));
  return new Uint8Array(Buffer.concat([d.update(b.subarray(28)), d.final()]));
}

export const credentialAad = (tenantId: string, channelId: string) => `postgate:${tenantId}:${channelId}`;

export function seal(plaintext: string, aad: string, ring: KeyRing): Sealed {
  const kek = ring.current();
  const dek = randomBytes(32);
  try {
    return {
      ciphertext: gcmSeal(dek, Buffer.from(plaintext, 'utf8'), aad),
      dekWrapped: gcmSeal(kek.key, dek, `dek:${aad}`),
      keyVersion: kek.version,
    };
  } finally {
    dek.fill(0);
  }
}

export function open(sealed: Sealed, aad: string, ring: KeyRing): string {
  const dek = gcmOpen(ring.get(sealed.keyVersion).key, sealed.dekWrapped, `dek:${aad}`);
  try {
    return Buffer.from(gcmOpen(dek, sealed.ciphertext, aad)).toString('utf8');
  } finally {
    dek.fill(0);
  }
}

/** KEKs are base64 32-byte values supplied in the environment as POSTGATE_KEK_V1, _V2, … */
export function keyRingFromSecrets(secrets: SecretResolver, currentVersion: number): KeyRing {
  const load = (version: number): Kek => {
    const name = `${KEK_NAME_PREFIX}${version}`;
    const raw = secrets.get(name);
    if (!raw) throw new Error(`key-encryption key ${name} is not available to this process`);
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error(`${name} must be 32 bytes (base64)`);
    return { version, key: new Uint8Array(key) };
  };
  return { current: () => load(currentVersion), get: load };
}
