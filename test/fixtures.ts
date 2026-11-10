// Seed data as the migration owner (bypasses RLS), so tests then exercise the runtime roles.
import type { Db } from '../src/db/db.ts';

export interface Seeded {
  tenantId: string;
  channelId: string;
  postId: string;
  targetId: string;
}

export async function seedTenant(db: Db, tenantId: string, slug: string): Promise<void> {
  await db.query(`insert into social.tenants (id, slug, name) values ($1, $2, $3)`, [tenantId, slug, slug]);
  await db.query(`insert into social.members (tenant_id, user_ref, role) values ($1, 'u-author', 'editor'), ($1, 'u-boss', 'owner')`, [tenantId]);
}

export async function seedPost(
  db: Db, tenantId: string,
  opts: { provider?: string; kind?: string; externalId?: string; envRef?: string; body?: string; settings?: object; mediaIds?: string[] } = {},
): Promise<Seeded> {
  const ch = (await db.query<{ id: string }>(
    `insert into social.channels (tenant_id, provider, kind, external_id, display_name)
     values ($1, $2, $3, $4, 'Test channel')
     on conflict (tenant_id, provider, external_id) do update set display_name = excluded.display_name returning id`,
    [tenantId, opts.provider ?? 'linkedin', opts.kind ?? 'personal', opts.externalId ?? 'urn:li:person:abc'])).rows[0]!.id;
  await db.query(
    `insert into social.channel_credentials (channel_id, tenant_id, source, env_ref) values ($1, $2, 'env', $3)
     on conflict (channel_id) do nothing`,
    [ch, tenantId, opts.envRef ?? 'LINKEDIN_MEMBER_TOKEN']);
  const post = (await db.query<{ id: string }>(
    `insert into social.posts (tenant_id, body, media_ids, created_by) values ($1, $2, $3, 'u-author') returning id`,
    [tenantId, opts.body ?? 'Hello from Acme', opts.mediaIds ?? []])).rows[0]!.id;
  const target = (await db.query<{ id: string }>(
    `insert into social.post_targets (tenant_id, post_id, channel_id, settings) values ($1, $2, $3, $4) returning id`,
    [tenantId, post, ch, JSON.stringify(opts.settings ?? {})])).rows[0]!.id;
  return { tenantId, channelId: ch, postId: post, targetId: target };
}

export const one = async <T>(db: Db, sql: string, params: unknown[] = []): Promise<T> => (await db.query<T>(sql, params)).rows[0]!;
