-- Media generation jobs (v1: avatar_video through HeyGen). Async: submit -> poll -> fetch -> store as a media asset,
-- optionally attached to a DRAFT post. Generated media reaches a channel only inside a post that passes the approval
-- gate: attaching clears the post's content hash, so any earlier approval no longer applies.
--   * consent: who agreed that this face/voice may be animated (stock avatars: 'stock avatar'). Required.
--   * key_env: NAME of the environment variable holding the provider API key (per tenant BYO); never the key.
--   * usage: what the provider reported (e.g. duration seconds) for metering.
--   * Paid calls are never retried blind: an unknown outcome on create fails the job for a human to check.

create table social.media_jobs (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references social.tenants(id) on delete cascade,
  capability       text not null check (capability in ('avatar_video')),
  provider         text not null,
  params           jsonb not null default '{}'::jsonb,
  consent          text not null check (length(consent) between 3 and 500),
  key_env          text not null check (key_env ~ '^[A-Z][A-Z0-9_]*$'),
  post_id          uuid references social.posts(id) on delete set null,
  status           text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  external_job_id  text,
  polls            int not null default 0,
  result_asset_id  uuid references social.media_assets(id) on delete set null,
  usage            jsonb not null default '{}'::jsonb,
  error            jsonb,
  requested_by     text not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger media_jobs_touch before update on social.media_jobs for each row execute function social.touch_updated_at();
alter table social.media_jobs enable row level security;
alter table social.media_jobs force row level security;
create policy tenant_isolation on social.media_jobs using (tenant_id = social.current_tenant()) with check (tenant_id = social.current_tenant());
grant select, insert on social.media_jobs to social_app;
grant select, update on social.media_jobs to social_worker;
grant insert on social.media_assets to social_worker;

-- Generating media costs money: a separate scope, never in an automation key unless an owner grants it.
alter table social.api_keys drop constraint api_keys_scopes_check;
alter table social.api_keys add constraint api_keys_scopes_check check (scopes <@ array['drafts:read', 'drafts:write', 'approvals:request',
  'approvals:decide', 'schedule:write', 'channels:write', 'media:generate']::text[]);
