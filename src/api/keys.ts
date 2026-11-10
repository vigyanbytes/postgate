// API keys. A key is shown once at creation; only its SHA-256 is stored. Keep the value in your own secret
// store and hand it to the caller (CLI, MCP server, script) through an environment variable.
import { createHash, randomBytes } from 'node:crypto';
import type { Db, Queryable } from '../db/db.ts';

export const API_SCOPES = ['drafts:read', 'drafts:write', 'approvals:request', 'approvals:decide', 'schedule:write',
  'channels:write'] as const;
/** What an agent or script gets: everything except deciding approvals and managing channels. */
export const AUTOMATION_SCOPES = ['drafts:read', 'drafts:write', 'approvals:request', 'schedule:write'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

/** Must run in a tenant-scoped transaction. */
export async function createApiKey(
  tx: Queryable,
  input: { tenantId: string; name: string; scopes: readonly ApiScope[]; createdBy: string; memberRef?: string; expiresAt?: Date;
    /** A key generated elsewhere (e.g. by your deployment tooling); only its hash is stored. */ key?: string },
): Promise<{ id: string; key: string }> {
  if (input.key !== undefined && !/^pgate_[A-Za-z0-9_-]{20,}$/.test(input.key)) throw new Error('key must look like pgate_ followed by at least 20 URL-safe characters');
  const key = input.key ?? `pgate_${randomBytes(32).toString('base64url')}`;
  const { rows } = await tx.query<{ id: string }>(
    `insert into social.api_keys (tenant_id, name, key_hash, key_prefix, scopes, created_by, member_ref, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [input.tenantId, input.name, hashKey(key), key.slice(0, 10), input.scopes, input.createdBy, input.memberRef ?? null, input.expiresAt ?? null]);
  await tx.query(
    `insert into social.audit_log (tenant_id, actor, action, subject_type, subject_id, detail) values ($1, $2, 'api_key.created', 'api_key', $3, $4)`,
    [input.tenantId, input.createdBy, rows[0]!.id, JSON.stringify({ name: input.name, scopes: input.scopes })]);
  return { id: rows[0]!.id, key };
}

/** memberRef set = a human member's console key (decisions allowed by role); null = an automation key. */
export interface ApiPrincipal { tenantId: string; keyId: string; scopes: string[]; memberRef: string | null; role: string | null }

export async function resolveApiKey(db: Db, key: string): Promise<ApiPrincipal | null> {
  if (!/^pgate_[A-Za-z0-9_-]{20,}$/.test(key)) return null;
  const row = await db.transaction(async (tx) => (await tx.query<{ tenant_id: string; key_id: string; scopes: string[]; member_ref: string | null; role: string | null }>(
    'select tenant_id, key_id, scopes, member_ref, role from social.resolve_api_key($1)', [hashKey(key)])).rows[0]);
  return row ? { tenantId: row.tenant_id, keyId: row.key_id, scopes: row.scopes, memberRef: row.member_ref, role: row.role } : null;
}
