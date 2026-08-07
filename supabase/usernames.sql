-- Bill Break — unique usernames.
-- Run this ONCE in Supabase → SQL Editor, AFTER schema.sql and invites.sql.

-- 1) Add the column + a case-insensitive uniqueness guarantee.
alter table profiles add column if not exists username text;
create unique index if not exists idx_profiles_username on profiles (lower(username));

-- ledger_members keeps a display copy of each member's username, kept in sync by
-- the app so everyone sees a person's real handle (not just an email prefix).
alter table ledger_members add column if not exists username text;

-- 2) Set / change your own username (validates format + uniqueness atomically).
create or replace function set_username(p_username text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare u text := lower(trim(p_username));
begin
  if u !~ '^[a-z0-9_]{3,20}$' then
    return json_build_object('ok', false, 'error', 'Use 3–20 characters: lowercase letters, numbers, or underscore.');
  end if;
  if exists (select 1 from profiles where lower(username) = u and id <> auth.uid()) then
    return json_build_object('ok', false, 'error', 'That username is already taken.');
  end if;
  update profiles set username = u where id = auth.uid();
  return json_build_object('ok', true, 'username', u);
end;
$$;
grant execute on function set_username(text) to authenticated;

-- 3) Quick availability check for live feedback while typing.
create or replace function username_available(p_username text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select not exists (
    select 1 from profiles
    where lower(username) = lower(trim(p_username)) and id <> auth.uid()
  );
$$;
grant execute on function username_available(text) to authenticated;

-- 4) Look up a member by EITHER email or username (replaces the email-only one).
--    Returns the matched person's email too, so adding by @username still stores
--    an email (needed for reminders + the members list). Only ever returns a
--    single EXACT match, so it isn't a way to browse the user table.
drop function if exists find_member(text);
create or replace function find_member(p_identifier text)
returns table (id uuid, display_name text, username text, email text)
language sql
security definer
stable
set search_path = public
as $$
  select id, display_name, username, email
  from profiles
  where lower(email) = lower(trim(p_identifier))
     or lower(username) = lower(regexp_replace(trim(p_identifier), '^@', ''))
  limit 1;
$$;
grant execute on function find_member(text) to authenticated;

-- 5) Current profiles for everyone in my ledgers — matched by user_id OR by the
--    email of a still-pending invite. Lets the app show real names/usernames and
--    heal "pending" rows for friends who have since signed up. Only exposes
--    people you already share a ledger with (or invited by email).
create or replace function member_profiles()
returns table (id uuid, display_name text, username text, email text)
language sql
security definer
stable
set search_path = public
as $$
  with my_ledgers as (
    select ledger_id from ledger_members where user_id = auth.uid()
  ), my_members as (
    select user_id, lower(email) as email
    from ledger_members
    where ledger_id in (select ledger_id from my_ledgers)
  )
  select distinct p.id, p.display_name, p.username, p.email
  from profiles p
  where p.id in (select user_id from my_members where user_id is not null)
     or lower(p.email) in (select email from my_members where email is not null);
$$;
grant execute on function member_profiles() to authenticated;
