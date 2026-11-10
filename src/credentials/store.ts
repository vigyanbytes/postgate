// Load and save a channel's token. Rows live in social.channel_credentials (worker-only table):
//   source 'env'      -> env_ref names the environment variable that holds the token
//   source 'envelope' -> ciphertext + wrapped DEK (see envelope.ts)
import { toBytes, type Queryable } from '../db/db.ts';
import { ProviderError } from '../providers/errors.ts';
import type { TokenSet } from '../providers/types.ts';
import { credentialAad, open, seal, type KeyRing } from './envelope.ts';
import type { SecretResolver } from './secrets.ts';

export interface CredentialDeps {
  secrets: SecretResolver;
  keyRing?: KeyRing;
}

interface Row { source: 'env' | 'envelope'; env_ref: string | null; ciphertext: unknown; dek_wrapped: unknown; key_version: number | null }

type Serialized = { accessToken?: string; access_token?: string; refreshToken?: string; refresh_token?: string;
  expiresAt?: string; refreshExpiresAt?: string; scopes?: string[] };

/** An environment value may be a bare access token or a JSON TokenSet. */
export function parseTokenValue(raw: string): TokenSet {
  const s = raw.trim();
  if (!s.startsWith('{')) return { accessToken: s };
  const j = JSON.parse(s) as Serialized;
  const accessToken = j.accessToken ?? j.access_token;
  if (!accessToken) throw new Error('token JSON has no accessToken');
  const t: TokenSet = { accessToken };
  const rt = j.refreshToken ?? j.refresh_token;
  if (rt) t.refreshToken = rt;
  if (j.expiresAt) t.expiresAt = new Date(j.expiresAt);
  if (j.refreshExpiresAt) t.refreshExpiresAt = new Date(j.refreshExpiresAt);
  if (j.scopes) t.scopes = j.scopes;
  return t;
}

export const serializeToken = (t: TokenSet): string => JSON.stringify({
  accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt?.toISOString(),
  refreshExpiresAt: t.refreshExpiresAt?.toISOString(), scopes: t.scopes,
});

const missing = (provider: string, why: string) =>
  new ProviderError(provider, 'reconnect', `credential unavailable: ${why}`, { code: 'credential_missing' });

export async function loadToken(
  tx: Queryable, ids: { tenantId: string; channelId: string; provider: string }, deps: CredentialDeps,
): Promise<{ token: TokenSet; source: Row['source'] }> {
  const { rows } = await tx.query<Row>(
    'select source, env_ref, ciphertext, dek_wrapped, key_version from social.channel_credentials where channel_id = $1',
    [ids.channelId],
  );
  const row = rows[0];
  if (!row) throw missing(ids.provider, 'no credential row for this channel');
  if (row.source === 'env') {
    const raw = deps.secrets.get(row.env_ref ?? '');
    if (!raw) throw missing(ids.provider, `environment variable ${row.env_ref} is not set for this worker`);
    return { token: parseTokenValue(raw), source: 'env' };
  }
  if (!deps.keyRing) throw missing(ids.provider, 'no key ring configured for envelope credentials');
  const plain = open(
    { ciphertext: toBytes(row.ciphertext), dekWrapped: toBytes(row.dek_wrapped), keyVersion: row.key_version ?? 0 },
    credentialAad(ids.tenantId, ids.channelId), deps.keyRing,
  );
  return { token: parseTokenValue(plain), source: 'envelope' };
}

/** Values for social.store_channel_credential(...) for a tenant's OAuth token. */
export function sealToken(token: TokenSet, ids: { tenantId: string; channelId: string }, ring: KeyRing) {
  return seal(serializeToken(token), credentialAad(ids.tenantId, ids.channelId), ring);
}

/** After a refresh: envelope rows are re-sealed; env rows cannot be written by the worker (update the variable and restart). */
export async function saveRefreshedToken(
  tx: Queryable, ids: { tenantId: string; channelId: string }, token: TokenSet, source: Row['source'], ring?: KeyRing,
): Promise<boolean> {
  if (token.expiresAt) {
    await tx.query('update social.channels set token_expires_at = $2 where id = $1', [ids.channelId, token.expiresAt]);
  }
  if (source !== 'envelope' || !ring) return false;
  const s = sealToken(token, ids, ring);
  await tx.query(
    `update social.channel_credentials set ciphertext = $2, dek_wrapped = $3, key_version = $4, updated_at = now()
      where channel_id = $1`,
    [ids.channelId, s.ciphertext, s.dekWrapped, s.keyVersion],
  );
  return true;
}
