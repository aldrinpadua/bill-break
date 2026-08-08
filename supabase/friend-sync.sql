-- UNO Ledger — reliable "claim my memberships on login".
-- Run this ONCE in Supabase → SQL Editor (after schema.sql + invites.sql).
--
-- Why: when someone is added/invited by email, their ledger_members row starts
-- with user_id = NULL. They only become a real, visible member once that row's
-- user_id is set to them. The old client-side claim relied on the JWT carrying an
-- "email" claim plus an RLS policy, which didn't always fire — so the invitee
-- stayed invisible until the INVITER's app next healed the row. This function
-- runs as the invitee, keys off their authoritative auth.users email, and bypasses
-- RLS (security definer), so a person always claims their own pending rows the
-- first time they sign in — no dependency on the inviter refreshing.
create or replace function claim_my_invites()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
  mail text;
begin
  select lower(email) into mail from auth.users where id = auth.uid();
  if mail is null then return 0; end if;
  update ledger_members
     set user_id = auth.uid()
   where user_id is null
     and lower(email) = mail;
  get diagnostics n = row_count;
  return n;
end;
$$;

grant execute on function claim_my_invites() to authenticated;
