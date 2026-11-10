-- API keys + idempotent draft creation + the zone a post was scheduled in.
--   * api_keys: per-tenant keys; only the SHA-256 of a key is stored. The value is shown once.
--     member_ref set   = a key bound to one human member (may decide approvals, by role)
--     member_ref null  = an automation key (agents, scripts): may draft, ask for approval and set times, never decide
--   * posts.source_ref: the caller's id for the thing a draft came from (e.g. "rss:<guid>") so a retried
--     automation never creates a second draft.
--   * posts.timezone: the zone the time was entered in (display + wall-clock input). scheduled_at stays UTC.

alter table social.posts add column source_ref text check (source_ref is null or length(source_ref) between 1 and 300);
create unique index posts_source_ref on social.posts (tenant_id, source_ref) where source_ref is not null;

alter table social.posts add column timezone text not null default 'UTC'
  check (timezone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)*$' or timezone = 'UTC');

create table social.api_keys (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references social.tenants(id) on delete cascade,
  name          text not null,
  key_hash      text not null unique,                 -- sha256 hex of the full key
  key_prefix    text not null,                        -- first characters, for humans telling keys apart
  scopes        text[] not null check (scopes <@ array['drafts:read', 'drafts:write', 'approvals:request',
                                                       'approvals:decide', 'schedule:write', 'channels:write']::text[]),
  created_by    text not null,
  member_ref    text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  unique (tenant_id, name),
  foreign key (tenant_id, member_ref) references social.members (tenant_id, user_ref) on delete cascade
);
alter table social.api_keys enable row level security;
alter table social.api_keys force row level security;
create policy tenant_isolation on social.api_keys using (tenant_id = social.current_tenant())
  with check (tenant_id = social.current_tenant());
grant select, insert on social.api_keys to social_app;
grant update (revoked_at) on social.api_keys to social_app;

-- The API learns the tenant FROM the key, so the lookup cannot run under RLS (no tenant yet).
-- Security definer; returns only the tenant, scopes and member of a live key, and stamps last_used_at.
create function social.resolve_api_key(p_hash text)
returns table (tenant_id uuid, key_id uuid, scopes text[], member_ref text, role text)
language plpgsql security definer set search_path = social, pg_temp as $$
begin
  return query
  with k as (
    update social.api_keys k set last_used_at = now()
     where k.key_hash = p_hash and k.revoked_at is null and (k.expires_at is null or k.expires_at > now())
       and exists (select 1 from social.tenants t where t.id = k.tenant_id and t.status = 'active')
    returning k.tenant_id, k.id, k.scopes, k.member_ref)
  select k.tenant_id, k.id, k.scopes, k.member_ref, m.role
    from k left join social.members m on m.tenant_id = k.tenant_id and m.user_ref = k.member_ref;
end $$;
revoke all on function social.resolve_api_key(text) from public;
grant execute on function social.resolve_api_key(text) to social_app;
