-- Approval gate enforced by the database: no code path can queue or publish unapproved content.
--   * a post can only become approved/scheduled, and a target can only become queued/publishing,
--     when an approved approval exists for the post's CURRENT content_hash;
--   * changing post content requires a new content_hash; a new hash supersedes older approvals;
--   * changing a target's override/settings (or the target set) clears the post's hash.
-- `expires_at` limits how long a PENDING request can be decided; an approval, once given, does not expire.

create function social.post_is_approved(p_post uuid) returns boolean language sql stable as $$
  select exists (
    select 1
    from social.approvals a
    join social.posts p on p.id = a.post_id
    where a.post_id = p_post and a.status = 'approved'
      and p.content_hash is not null and a.content_hash = p.content_hash
  )
$$;
grant execute on function social.post_is_approved(uuid) to social_app, social_worker;

create function social.posts_gate() returns trigger language plpgsql as $$
begin
  if (new.title, new.body, new.media_ids, new.link_url) is distinct from (old.title, old.body, old.media_ids, old.link_url)
     and old.content_hash is not null and new.content_hash is not distinct from old.content_hash then
    raise exception 'post % content changed without a new content_hash', new.id using errcode = 'check_violation';
  end if;

  if new.content_hash is distinct from old.content_hash then
    update social.approvals set status = 'superseded'
      where post_id = new.id and status in ('pending', 'approved')
        and content_hash is distinct from new.content_hash;
    if new.status in ('approved', 'scheduled') then
      new.status := 'in_review';
    end if;
  end if;

  if new.status in ('approved', 'scheduled') and new.status is distinct from old.status then
    if new.content_hash is null or not exists (
         select 1 from social.approvals
         where post_id = new.id and status = 'approved' and content_hash = new.content_hash) then
      raise exception 'post % has no approval for its current content', new.id using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger posts_gate before update on social.posts for each row execute function social.posts_gate();

create function social.post_targets_gate() returns trigger language plpgsql as $$
begin
  if new.status in ('queued', 'publishing')
     and (tg_op = 'INSERT' or new.status is distinct from old.status)
     and not social.post_is_approved(new.post_id) then
    raise exception 'post target % cannot be %: post % is not approved for its current content',
      new.id, new.status, new.post_id using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger post_targets_gate before insert or update of status on social.post_targets
  for each row execute function social.post_targets_gate();

create function social.post_targets_invalidate_hash() returns trigger language plpgsql as $$
begin
  update social.posts set content_hash = null
    where id = coalesce(new.post_id, old.post_id) and content_hash is not null;
  return null;
end $$;
create trigger post_targets_content_insert_delete after insert or delete on social.post_targets
  for each row execute function social.post_targets_invalidate_hash();
create trigger post_targets_content_update after update of body_override, settings, channel_id on social.post_targets
  for each row when ((new.body_override, new.settings, new.channel_id) is distinct from (old.body_override, old.settings, old.channel_id))
  execute function social.post_targets_invalidate_hash();
