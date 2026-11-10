-- Tenant isolation. The current tenant is a transaction-scoped setting:
--   select set_config('app.tenant_id', '<uuid>', true);
-- Roles: social_app (console/API), social_worker (background worker). Neither is a superuser or BYPASSRLS.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'social_app') then
    create role social_app nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'social_worker') then
    create role social_worker nologin;
  end if;
end $$;

create function social.current_tenant() returns uuid language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

grant usage on schema social to social_app, social_worker;
grant execute on function social.current_tenant() to social_app, social_worker;

-- Force RLS on every table (owners included) and add the single tenant policy.
do $$
declare t text;
begin
  foreach t in array array['members', 'channels', 'channel_credentials', 'media_assets', 'posts', 'post_targets',
                           'approvals', 'jobs', 'events', 'audit_log']
  loop
    execute format('alter table social.%I enable row level security', t);
    execute format('alter table social.%I force row level security', t);
    execute format('create policy tenant_isolation on social.%I using (tenant_id = social.current_tenant()) '
                   'with check (tenant_id = social.current_tenant())', t);
  end loop;
end $$;
alter table social.tenants enable row level security;
alter table social.tenants force row level security;
create policy tenant_isolation on social.tenants using (id = social.current_tenant());

-- Console/API.
grant select on social.tenants to social_app;
grant select, insert, update, delete on social.members, social.channels, social.media_assets, social.posts,
  social.post_targets to social_app;
grant select, insert, update on social.approvals to social_app;
grant select, insert on social.events, social.audit_log to social_app;
-- No grant on channel_credentials or jobs: credentials are written through store_channel_credential(),
-- jobs through enqueue_job().

-- Worker.
grant select on social.tenants, social.members, social.media_assets to social_worker;
grant select, update on social.channels, social.posts, social.post_targets, social.approvals to social_worker;
grant select, update on social.channel_credentials to social_worker;
grant select, insert on social.audit_log to social_worker;
grant select, insert, update (dispatched_at) on social.events to social_worker;

-- Write-only credential path for the API (channel registration): it may store, never read.
create function social.store_channel_credential(
  p_channel_id uuid, p_source text, p_env_ref text, p_ciphertext bytea, p_dek_wrapped bytea, p_key_version int
) returns void language plpgsql security definer set search_path = social, pg_temp as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from social.channels where id = p_channel_id;
  if v_tenant is null or v_tenant is distinct from social.current_tenant() then
    raise exception 'channel % is not in the current tenant', p_channel_id;
  end if;
  insert into social.channel_credentials (channel_id, tenant_id, source, env_ref, ciphertext, dek_wrapped, key_version)
  values (p_channel_id, v_tenant, p_source, p_env_ref, p_ciphertext, p_dek_wrapped, p_key_version)
  on conflict (channel_id) do update set source = excluded.source, env_ref = excluded.env_ref,
    ciphertext = excluded.ciphertext, dek_wrapped = excluded.dek_wrapped, key_version = excluded.key_version,
    updated_at = now();
  insert into social.audit_log (tenant_id, actor, action, subject_type, subject_id, detail)
  values (v_tenant, 'user:' || coalesce(current_setting('app.actor', true), 'unknown'), 'credential.stored', 'channel',
          p_channel_id::text, jsonb_build_object('source', p_source, 'env_ref', p_env_ref, 'key_version', p_key_version));
end $$;
revoke all on function social.store_channel_credential(uuid, text, text, bytea, bytea, int) from public;
grant execute on function social.store_channel_credential(uuid, text, text, bytea, bytea, int) to social_app, social_worker;
