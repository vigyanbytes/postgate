-- Postgres job queue: leases + FOR UPDATE SKIP LOCKED. No Redis, no Temporal.
-- These functions are SECURITY DEFINER: the migration owner must be able to see every tenant's jobs
-- (a superuser, or a role with BYPASSRLS on managed Postgres).

-- Enqueue is idempotent on (kind, idempotency_key): a second call returns the existing job id.
create function social.enqueue_job(
  p_tenant uuid, p_kind text, p_key text, p_payload jsonb default '{}'::jsonb,
  p_run_at timestamptz default now(), p_max_attempts int default 6
) returns bigint language plpgsql security definer set search_path = social, pg_temp as $$
declare v_id bigint;
begin
  if p_tenant is distinct from social.current_tenant() then
    raise exception 'enqueue_job: tenant % is not the current tenant', p_tenant;
  end if;
  insert into social.jobs (tenant_id, kind, idempotency_key, payload, run_at, max_attempts)
  values (p_tenant, p_kind, p_key, coalesce(p_payload, '{}'::jsonb), coalesce(p_run_at, now()), p_max_attempts)
  on conflict (kind, idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from social.jobs where kind = p_kind and idempotency_key = p_key;
  end if;
  return v_id;
end $$;

-- Claim due jobs and jobs whose lease expired (crashed worker). Each claim increments attempts.
create function social.claim_jobs(p_worker text, p_limit int default 10, p_lease_seconds int default 300)
returns setof social.jobs language plpgsql security definer set search_path = social, pg_temp as $$
begin
  update social.jobs set status = 'dead', locked_by = null, locked_until = null,
    last_error = coalesce(last_error, '{}'::jsonb) || '{"reason": "lease expired on final attempt"}'::jsonb
  where id in (select id from social.jobs
               where status = 'running' and locked_until < now() and attempts >= max_attempts
               for update skip locked);

  return query
  update social.jobs j
     set status = 'running', locked_by = p_worker,
         locked_until = now() + make_interval(secs => p_lease_seconds), attempts = j.attempts + 1
   where j.id in (select id from social.jobs
                  where (status = 'queued' and run_at <= now())
                     or (status = 'running' and locked_until < now())
                  order by run_at, id
                  limit p_limit
                  for update skip locked)
  returning j.*;
end $$;

-- Only the lease holder may finish a job; a late worker gets false and must drop its result.
create function social.complete_job(p_id bigint, p_worker text) returns boolean
language plpgsql security definer set search_path = social, pg_temp as $$
begin
  update social.jobs set status = 'succeeded', locked_by = null, locked_until = null, last_error = null
   where id = p_id and locked_by = p_worker and status = 'running';
  return found;
end $$;

-- p_retry_at null = give up now. Returns the job's new status, or null when the lease was lost.
create function social.fail_job(p_id bigint, p_worker text, p_error jsonb, p_retry_at timestamptz)
returns text language plpgsql security definer set search_path = social, pg_temp as $$
declare v_status text;
begin
  update social.jobs
     set status = case when p_retry_at is null or attempts >= max_attempts then 'dead' else 'queued' end,
         run_at = coalesce(p_retry_at, run_at),
         locked_by = null, locked_until = null, last_error = p_error
   where id = p_id and locked_by = p_worker and status = 'running'
  returning status into v_status;
  return v_status;
end $$;

-- Scheduler tick: due targets of approved, scheduled posts -> queued + publish job.
-- Overdue beyond the grace window, or no longer approved -> needs_attention (never a surprise late post).
create function social.enqueue_due_publishes(p_grace interval default interval '6 hours', p_limit int default 100)
returns int language plpgsql security definer set search_path = social, pg_temp as $$
declare r record; n int := 0;
begin
  for r in
    select t.id, t.tenant_id, t.idempotency_key, t.post_id, p.scheduled_at
      from social.post_targets t join social.posts p on p.id = t.post_id
     where t.status = 'pending' and p.status = 'scheduled' and p.scheduled_at <= now()
     order by p.scheduled_at
     limit p_limit
     for update of t skip locked
  loop
    if r.scheduled_at < now() - p_grace then
      update social.post_targets set status = 'needs_attention',
        last_error = jsonb_build_object('kind', 'missed_window', 'scheduled_at', r.scheduled_at) where id = r.id;
      insert into social.events (tenant_id, aggregate_type, aggregate_id, type, payload)
      values (r.tenant_id, 'post_target', r.id::text, 'post_target.needs_attention', '{"reason": "missed_window"}');
    elsif not social.post_is_approved(r.post_id) then
      update social.post_targets set status = 'needs_attention',
        last_error = '{"kind": "not_approved"}'::jsonb where id = r.id;
      insert into social.events (tenant_id, aggregate_type, aggregate_id, type, payload)
      values (r.tenant_id, 'post_target', r.id::text, 'post_target.needs_attention', '{"reason": "not_approved"}');
    else
      update social.post_targets set status = 'queued' where id = r.id;
      insert into social.jobs (tenant_id, kind, idempotency_key, payload)
      values (r.tenant_id, 'publish_target', r.idempotency_key, jsonb_build_object('post_target_id', r.id))
      on conflict (kind, idempotency_key) do nothing;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

revoke all on function social.enqueue_job(uuid, text, text, jsonb, timestamptz, int) from public;
revoke all on function social.claim_jobs(text, int, int) from public;
revoke all on function social.complete_job(bigint, text) from public;
revoke all on function social.fail_job(bigint, text, jsonb, timestamptz) from public;
revoke all on function social.enqueue_due_publishes(interval, int) from public;
grant execute on function social.enqueue_job(uuid, text, text, jsonb, timestamptz, int) to social_app, social_worker;
grant execute on function social.claim_jobs(text, int, int) to social_worker;
grant execute on function social.complete_job(bigint, text) to social_worker;
grant execute on function social.fail_job(bigint, text, jsonb, timestamptz) to social_worker;
grant execute on function social.enqueue_due_publishes(interval, int) to social_worker;
