-- UNO Ledger — expense edit permissions + group/trip admins.
-- Run this ONCE in Supabase → SQL Editor, after schema.sql.

-- Each ledger has a list of admin user_ids. The creator is always an admin
-- (implicitly), so this list is the EXTRA admins they designate.
alter table ledgers add column if not exists admins uuid[] not null default '{}';

-- Am I an admin (or the creator) of this ledger? A trip also inherits its parent
-- group's admins while it's tagged to that group (dynamic — untag reverts it).
create or replace function is_ledger_admin(l uuid)
returns boolean
language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from ledgers g
    where g.id = l and (g.created_by = auth.uid() or auth.uid() = any(g.admins))
  )
  or exists (
    select 1 from ledgers t
    join ledgers p on p.id = t.parent_id
    where t.id = l and (p.created_by = auth.uid() or auth.uid() = any(p.admins))
  );
$$;
grant execute on function is_ledger_admin(uuid) to authenticated;

-- Replace the single expense policy with granular ones:
--   read/insert: any member of the ledger
--   update/delete: ONLY the expense's creator, or an admin of the ledger
drop policy if exists "rw expenses" on expenses;
drop policy if exists "read expenses" on expenses;
drop policy if exists "insert expenses" on expenses;
drop policy if exists "update expenses" on expenses;
drop policy if exists "delete expenses" on expenses;

create policy "read expenses"   on expenses for select using (is_ledger_member(ledger_id));
create policy "insert expenses" on expenses for insert with check (is_ledger_member(ledger_id) and created_by = auth.uid());
create policy "update expenses" on expenses for update using (created_by = auth.uid() or is_ledger_admin(ledger_id));
create policy "delete expenses" on expenses for delete using (created_by = auth.uid() or is_ledger_admin(ledger_id));

-- Management is admin-only: only admins can rename/change/delete a ledger or
-- add/remove its members. Any member can still view, add expenses, and settle up.
drop policy if exists "update ledgers" on ledgers;
create policy "update ledgers" on ledgers for update using (is_ledger_admin(id)) with check (is_ledger_admin(id));
drop policy if exists "delete ledgers" on ledgers;
create policy "delete ledgers" on ledgers for delete using (is_ledger_admin(id));

drop policy if exists "rw members" on ledger_members;
drop policy if exists "read members" on ledger_members;
drop policy if exists "insert members" on ledger_members;
drop policy if exists "update members" on ledger_members;
drop policy if exists "delete members" on ledger_members;
create policy "read members" on ledger_members for select
  using (is_ledger_member(ledger_id) or exists (select 1 from ledgers g where g.id = ledger_id and g.created_by = auth.uid()));
create policy "insert members" on ledger_members for insert with check (is_ledger_admin(ledger_id));
-- update: an admin (to heal/rename) OR you updating your OWN row (claim/identity)
create policy "update members" on ledger_members for update using (is_ledger_admin(ledger_id) or user_id = auth.uid());
create policy "delete members" on ledger_members for delete using (is_ledger_admin(ledger_id));

-- Promote/demote an admin — only an existing admin (or the creator) may do it.
create or replace function set_ledger_admin(p_ledger uuid, p_user uuid, p_make boolean)
returns json
language plpgsql security definer
set search_path = public
as $$
declare g ledgers;
begin
  select * into g from ledgers where id = p_ledger;
  if g.id is null then return json_build_object('ok', false, 'error', 'Group not found.'); end if;
  if not (g.created_by = auth.uid() or auth.uid() = any(g.admins)) then
    return json_build_object('ok', false, 'error', 'Only an admin can change admins.');
  end if;
  if p_make then
    update ledgers set admins = (select array(select distinct e from unnest(admins || p_user) e)) where id = p_ledger;
  else
    update ledgers set admins = array_remove(admins, p_user) where id = p_ledger;
  end if;
  return json_build_object('ok', true);
end;
$$;
grant execute on function set_ledger_admin(uuid, uuid, boolean) to authenticated;
