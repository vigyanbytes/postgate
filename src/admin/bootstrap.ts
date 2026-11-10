// First run: create a workspace (tenant), its owner and an owner key with every scope. Safe to run again: the
// workspace and owner are reused and a fresh owner key is issued (old keys keep working until revoked).
// Run: DATABASE_URL=… node src/admin/bootstrap.ts [slug] ["name"] [owner]
// Defaults: slug `default`, name `Default`, owner `user:<OS login of whoever runs it>` (identity derived, not typed).
// POSTGATE_OWNER_KEY: register a key generated elsewhere instead of minting one (it is never echoed back).
import { userInfo } from 'node:os';
import pg from 'pg';
import { API_SCOPES, createApiKey, hashKey } from '../api/keys.ts';
import { pgDb, withTenant, type Db } from '../db/db.ts';

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

export async function bootstrap(db: Db, o: { slug: string; name: string; owner: string; key?: string }): Promise<{ tenantId: string; key: string }> {
  if (!SLUG.test(o.slug)) throw new Error('slug must be lowercase letters, digits and dashes (2-63 chars)');
  if (!o.owner.trim()) throw new Error('owner is required');
  if (o.key !== undefined && !/^pgate_[A-Za-z0-9_-]{20,}$/.test(o.key)) throw new Error('key must look like pgate_ followed by at least 20 URL-safe characters');
  const tenantId = (await db.query<{ id: string }>(
    `insert into social.tenants (slug, name) values ($1, $2)
     on conflict (slug) do update set name = social.tenants.name returning id`, [o.slug, o.name])).rows[0]!.id;
  const key = await withTenant(db, tenantId, async (tx) => {
    await tx.query(`insert into social.members (tenant_id, user_ref, role) values ($1, $2, 'owner') on conflict do nothing`, [tenantId, o.owner]);
    if (o.key) {
      const known = (await tx.query(`select 1 from social.api_keys where key_hash = $1`, [hashKey(o.key)])).rows.length;
      if (known) return o.key;
    }
    return (await createApiKey(tx, { tenantId, name: `owner:${o.owner}:${Date.now()}`, scopes: API_SCOPES, createdBy: o.owner,
      memberRef: o.owner, ...(o.key ? { key: o.key } : {}) })).key;
  });
  return { tenantId, key };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [slug = 'default', name = 'Default', owner = process.env.POSTGATE_OWNER || `user:${userInfo().username}`] = process.argv.slice(2);
  if (!process.env.DATABASE_URL) {
    console.error('usage: DATABASE_URL=… node src/admin/bootstrap.ts [slug] ["name"] [owner]');
    process.exit(2);
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const given = process.env.POSTGATE_OWNER_KEY || undefined;
  const r = await bootstrap(pgDb(pool), { slug, name, owner, ...(given ? { key: given } : {}) });
  console.log(JSON.stringify(given ? { tenantId: r.tenantId, owner } : { tenantId: r.tenantId, owner, ownerKey: r.key,
    note: 'shown once: keep it in your secret manager; it can approve posts' }));
  await pool.end();
}
