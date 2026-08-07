-- Bill Break — invite-by-email support.
-- Run this ONCE in Supabase → SQL Editor, AFTER schema.sql.
-- It powers "add members by email" + "auto-join on signup" and tightens
-- profile privacy.

-- 1) Claim pending invites on first login.
--    When you invite someone who isn't a user yet, a ledger_members row is
--    created with their email and user_id = NULL. This policy lets that person,
--    the first time they sign in, set user_id to themselves on rows matching
--    their own email — which is how they auto-join the groups they were invited to.
drop policy if exists "claim own invite" on ledger_members;
create policy "claim own invite" on ledger_members for update
  using (user_id is null and lower(email) = lower(auth.jwt() ->> 'email'))
  with check (user_id = auth.uid());

create index if not exists idx_ledger_members_email on ledger_members (lower(email));

-- 2) Secure user lookup by exact email.
--    SECURITY DEFINER lets this bypass row-level security to check the profiles
--    table, but it only ever returns a single exact match — it never exposes the
--    whole table. This is how "add by email" finds an existing member.
create or replace function find_member(p_email text)
returns table (id uuid, display_name text)
language sql
security definer
stable
set search_path = public
as $$
  select id, display_name
  from profiles
  where lower(email) = lower(trim(p_email))
  limit 1;
$$;
grant execute on function find_member(text) to authenticated;

-- 3) Privacy: stop exposing everyone's email through the public anon key.
--    Originally profiles were world-readable; now you can only read your OWN
--    profile directly, and email lookups go through find_member() above.
drop policy if exists "read profiles" on profiles;
-- (the existing "own profile" policy from schema.sql still lets you read/update your own row)
