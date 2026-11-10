-- Core schema. Every tenant table carries tenant_id; RLS is in 0002.
-- Times are timestamptz (UTC). Enumerations are text + check so adding a value is a one-line migration.

create schema if not exists social;

create table social.tenants (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name        text not null,
  status      text not null default 'active' check (status in ('active', 'suspended', 'deleted')),
  settings    jsonb not null default '{}'::jsonb,   -- e.g. {"approver_must_differ": true}
  created_at  timestamptz not null default now()
);

-- tenant_id on the tenants table itself so the same RLS policy shape applies everywhere.
create table social.members (
  tenant_id   uuid not null references social.tenants(id) on delete cascade,
  user_ref    text not null,                         -- the member's login (user:<name>) or 'agent:<name>'
  role        text not null check (role in ('owner', 'admin', 'editor', 'approver', 'viewer')),
  created_at  timestamptz not null default now(),
  primary key (tenant_id, user_ref)
);

create table social.channels (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references social.tenants(id) on delete cascade,
  provider           text not null,                 -- registry id: linkedin, linkedin_page, facebook_page, …
  kind               text not null check (kind in ('personal', 'page', 'group', 'bot', 'blog', 'newsletter')),
  external_id        text not null,                 -- e.g. urn:li:person:abc, page id
  display_name       text not null,
  status             text not null default 'active' check (status in ('active', 'needs_reconnect', 'disabled')),
  scopes             text[] not null default '{}',
  token_expires_at   timestamptz,
  refresh_expires_at timestamptz,
  settings           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, provider, external_id)
);

-- Worker-only. Either the NAME of an environment variable that holds the token (value never in the DB),
-- or an envelope-encrypted token.
create table social.channel_credentials (
  channel_id   uuid primary key references social.channels(id) on delete cascade,
  tenant_id    uuid not null references social.tenants(id) on delete cascade,
  source       text not null check (source in ('env', 'envelope')),
  env_ref      text check (env_ref ~ '^[A-Z][A-Z0-9_]*$'),
  ciphertext   bytea,
  dek_wrapped  bytea,
  key_version  int,
  updated_at   timestamptz not null default now(),
  check (
    (source = 'env' and env_ref is not null and ciphertext is null and dek_wrapped is null)
    or (source = 'envelope' and env_ref is null and ciphertext is not null and dek_wrapped is not null and key_version is not null)
  )
);

create table social.media_assets (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references social.tenants(id) on delete cascade,
  kind         text not null check (kind in ('image', 'video', 'document')),
  mime         text not null,
  size_bytes   bigint not null check (size_bytes > 0),
  sha256       text not null,
  storage_key  text not null,
  alt_text     text,
  title        text,
  width        int,
  height       int,
  duration_ms  int,
  created_at   timestamptz not null default now()
);

create table social.posts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references social.tenants(id) on delete cascade,
  title         text,
  body          text not null default '',
  media_ids     uuid[] not null default '{}',
  link_url      text,
  status        text not null default 'draft' check (status in
                  ('draft', 'in_review', 'approved', 'scheduled', 'publishing', 'published',
                   'partially_failed', 'failed', 'cancelled')),
  scheduled_at  timestamptz,
  content_hash  text,                                -- set by the app (src/approval/gate.ts); null = must re-hash
  created_by    text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table social.post_targets (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references social.tenants(id) on delete cascade,
  post_id          uuid not null references social.posts(id) on delete cascade,
  channel_id       uuid not null references social.channels(id) on delete restrict,
  body_override    text,
  settings         jsonb not null default '{}'::jsonb,
  status           text not null default 'pending' check (status in
                     ('pending', 'queued', 'publishing', 'published', 'needs_attention', 'failed', 'cancelled')),
  idempotency_key  text not null unique default gen_random_uuid()::text,
  attempts         int not null default 0,
  external_id      text,
  external_url     text,
  published_at     timestamptz,
  deleted_at       timestamptz,                    -- removed from the platform again (unpublish)
  last_error       jsonb,
  updated_at       timestamptz not null default now(),
  unique (post_id, channel_id)
);

create table social.approvals (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references social.tenants(id) on delete cascade,
  post_id       uuid not null references social.posts(id) on delete cascade,
  content_hash  text not null,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired', 'superseded')),
  requested_by  text not null,
  requested_via text[] not null default '{console}',   -- console | api | email | chat
  requested_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  token_hash    text,                                  -- sha256 of the one-time link token; the token is never stored
  decided_by    text,
  decided_via   text check (decided_via in ('console', 'chat', 'email', 'api')),
  decided_at    timestamptz,
  note          text
);
create unique index approvals_one_pending_per_post on social.approvals (post_id) where status = 'pending';

create table social.jobs (
  id               bigint generated always as identity primary key,
  tenant_id        uuid not null references social.tenants(id) on delete cascade,
  kind             text not null,
  idempotency_key  text not null,
  payload          jsonb not null default '{}'::jsonb,
  status           text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'dead')),
  run_at           timestamptz not null default now(),
  attempts         int not null default 0,
  max_attempts     int not null default 6 check (max_attempts > 0),
  locked_by        text,
  locked_until     timestamptz,
  last_error       jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (kind, idempotency_key)
);
create index jobs_due on social.jobs (run_at) where status = 'queued';
create index jobs_leased on social.jobs (locked_until) where status = 'running';

-- Transactional outbox: written in the same transaction as the state change it describes.
create table social.events (
  id              bigint generated always as identity primary key,
  tenant_id       uuid not null references social.tenants(id) on delete cascade,
  aggregate_type  text not null,
  aggregate_id    text not null,
  type            text not null,
  payload         jsonb not null default '{}'::jsonb,
  occurred_at     timestamptz not null default now(),
  dispatched_at   timestamptz
);
create index events_undispatched on social.events (id) where dispatched_at is null;

create table social.audit_log (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references social.tenants(id) on delete cascade,
  actor         text not null,                       -- user:<id> | agent:<name> | system:worker
  action        text not null,
  subject_type  text not null,
  subject_id    text not null,
  detail        jsonb not null default '{}'::jsonb,  -- never tokens, never full post text
  trace_id      text,
  at            timestamptz not null default now()
);

-- Audit log is append-only for everyone, including the owner.
create function social.audit_log_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'social.audit_log is append-only';
end $$;
create trigger audit_log_no_update before update or delete on social.audit_log
  for each row execute function social.audit_log_append_only();

create function social.touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger channels_touch before update on social.channels for each row execute function social.touch_updated_at();
create trigger posts_touch before update on social.posts for each row execute function social.touch_updated_at();
create trigger post_targets_touch before update on social.post_targets for each row execute function social.touch_updated_at();
create trigger jobs_touch before update on social.jobs for each row execute function social.touch_updated_at();
