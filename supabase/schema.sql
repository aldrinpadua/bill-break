-- Bill Break — Supabase schema (Phase 2)
-- Run this in Supabase → SQL Editor. It creates the tables, row-level security
-- policies, and the settings table the email reminder function reads from.
--
-- Design notes:
--  * A "ledger" is a group, a trip, or a 1:1 friend ledger (kind column).
--  * A "member" of a ledger may be a real signed-in user OR just a name+email
--    (a friend who hasn't made an account). member_ref is a stable string id
--    used by the app's split math, matching the local data model.
--  * Each expense stores its full split payload as JSONB so the front-end and
--    the reminder function share one shape (see js/split.js).

-- ---------- profiles (one row per auth user) --------------------------------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  email text,
  created_at timestamptz default now()
);

-- ---------- ledgers ---------------------------------------------------------
create table if not exists ledgers (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('group','trip','individual')),
  name text not null,
  base_currency text not null default 'USD',
  parent_id uuid references ledgers(id) on delete set null,
  reminder jsonb not null default '{"enabled":false,"frequency":"weekly","message":"","lastSentAt":null}',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);

-- ---------- ledger members --------------------------------------------------
create table if not exists ledger_members (
  ledger_id uuid references ledgers(id) on delete cascade,
  member_ref text not null,             -- stable id used by split math
  name text not null,
  email text,
  user_id uuid references auth.users(id) on delete set null, -- null = non-user friend
  primary key (ledger_id, member_ref)
);
create index if not exists idx_ledger_members_user on ledger_members(user_id);

-- ---------- expenses --------------------------------------------------------
create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid references ledgers(id) on delete cascade,
  data jsonb not null,                  -- {description, amountMinor, currency, fxToBase, paidBy, split, category, date, receipt, settlement...}
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);
create index if not exists idx_expenses_ledger on expenses(ledger_id);

-- ---------- Row Level Security ---------------------------------------------
alter table profiles         enable row level security;
alter table ledgers          enable row level security;
alter table ledger_members   enable row level security;
alter table expenses         enable row level security;

-- helper: is the current user a member of this ledger?
create or replace function is_ledger_member(l uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from ledger_members m
    where m.ledger_id = l and m.user_id = auth.uid()
  );
$$;

-- profiles: you can see/edit your own profile; anyone can read basic profiles
drop policy if exists "own profile" on profiles;
create policy "own profile" on profiles
  for all using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists "read profiles" on profiles;
create policy "read profiles" on profiles for select using (true);

-- ledgers: members (and the creator) can read; members can update; any auth user can create
drop policy if exists "read ledgers" on ledgers;
create policy "read ledgers" on ledgers for select
  using (is_ledger_member(id) or created_by = auth.uid());
drop policy if exists "insert ledgers" on ledgers;
create policy "insert ledgers" on ledgers for insert
  with check (created_by = auth.uid());
drop policy if exists "update ledgers" on ledgers;
create policy "update ledgers" on ledgers for update
  using (is_ledger_member(id) or created_by = auth.uid());
drop policy if exists "delete ledgers" on ledgers;
create policy "delete ledgers" on ledgers for delete
  using (created_by = auth.uid());

-- ledger_members: readable/writable by members of the same ledger
drop policy if exists "rw members" on ledger_members;
create policy "rw members" on ledger_members for all
  using (is_ledger_member(ledger_id) or exists (select 1 from ledgers g where g.id = ledger_id and g.created_by = auth.uid()))
  with check (is_ledger_member(ledger_id) or exists (select 1 from ledgers g where g.id = ledger_id and g.created_by = auth.uid()));

-- expenses: readable/writable by members of the ledger
drop policy if exists "rw expenses" on expenses;
create policy "rw expenses" on expenses for all
  using (is_ledger_member(ledger_id))
  with check (is_ledger_member(ledger_id));

-- ---------- Storage bucket for receipt photos -------------------------------
-- Run once (or create the bucket "receipts" in the Storage UI and make it public-read):
insert into storage.buckets (id, name, public)
values ('receipts','receipts', true)
on conflict (id) do nothing;
