-- Teams: two or more people working on the same business in Invaro (see SYNC.md).
-- Run once in the Supabase SQL editor. Safe to run again: everything is "if not exists" / "or replace",
-- and running it on a database set up by an older version upgrades it (owner → admin, roles on invites).
--
--   teams         one row per shared business
--   team_members  who is in it (one team per person) and their role
--   team_invites  pending invitations, by email address, with the role they'll get
--   records       the shared data, one row per client / invoice, plus one "business" row (your details)
--
-- Roles (from 1.18.0). The database enforces them, not just the app:
--   admin       everything, plus inviting people, choosing their roles and removing them.
--               Whoever creates the team is its first admin; a team can have several.
--   accountant  sees every client and invoice and the business details; can only mark invoices
--               paid or unpaid. Adds, changes and deletes nothing else.
--   member      sees the clients and business details, but only the invoices and quotes they made
--               themselves. Makes invoices and quotes, adds clients and edits their contact details,
--               but can't change rates, currency, payment terms or tax, delete clients, mark invoices
--               paid, or change the business details.
--
-- Every change to a record gets a new, ever-increasing `version`, so the app can ask for
-- "everything changed since version N" every few seconds.

create table if not exists public.teams (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(name) between 1 and 100),
  created_by uuid default auth.uid() references auth.users on delete set null,
  created_at timestamptz not null default now()
);
-- Before 1.18.0, deleting the creator's account deleted the team. Now other admins keep it.
alter table public.teams alter column created_by drop not null;
alter table public.teams drop constraint if exists teams_created_by_fkey;
alter table public.teams add constraint teams_created_by_fkey foreign key (created_by) references auth.users on delete set null;

create table if not exists public.team_members (
  team_id   uuid not null references public.teams on delete cascade,
  user_id   uuid not null references auth.users on delete cascade,
  email     text not null,
  role      text not null,
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create unique index if not exists team_members_one_team on public.team_members (user_id);
alter table public.team_members drop constraint if exists team_members_role_check;
update public.team_members set role = 'admin' where role = 'owner';
alter table public.team_members add constraint team_members_role_check check (role in ('admin', 'accountant', 'member'));

create table if not exists public.team_invites (
  id            uuid primary key default gen_random_uuid(),
  team_id       uuid not null references public.teams on delete cascade,
  email         text not null check (email = lower(email) and email like '%_@_%'),
  invited_by    uuid not null default auth.uid() references auth.users on delete cascade,
  inviter_email text not null,
  created_at    timestamptz not null default now(),
  unique (team_id, email)
);
alter table public.team_invites add column if not exists role text not null default 'member';
alter table public.team_invites drop constraint if exists team_invites_role_check;
alter table public.team_invites add constraint team_invites_role_check check (role in ('admin', 'accountant', 'member'));

create sequence if not exists public.records_version;
create table if not exists public.records (
  team_id    uuid not null references public.teams on delete cascade,
  kind       text not null check (kind in ('client', 'invoice', 'business')),
  id         text not null check (length(id) between 1 and 200),
  data       jsonb,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  version    bigint not null default 0,
  primary key (team_id, kind, id)
);
create index if not exists records_team_version on public.records (team_id, version);
-- Who made each record. A member only sees the invoices they made.
alter table public.records add column if not exists created_by uuid;
drop trigger if exists records_stamp on public.records;
update public.records set created_by = updated_by where created_by is null; -- older rows: the last person to save them

-- ---------- who may do what ----------
create or replace function public.my_role(t uuid) returns text
  language sql security definer stable set search_path = '' as $$
  select role from public.team_members where team_id = t and user_id = auth.uid() $$;
create or replace function public.is_member(t uuid) returns boolean
  language sql security definer stable set search_path = '' as $$
  select exists (select 1 from public.team_members where team_id = t and user_id = auth.uid()) $$;
create or replace function public.is_admin(t uuid) returns boolean
  language sql security definer stable set search_path = '' as $$
  select exists (select 1 from public.team_members where team_id = t and user_id = auth.uid() and role = 'admin') $$;
create or replace function public.is_owner(t uuid) returns boolean -- the name used before 1.18.0
  language sql security definer stable set search_path = '' as $$ select public.is_admin(t) $$;
create or replace function public.my_email() returns text
  language sql stable set search_path = '' as $$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;
-- Whether a team still has someone, other than you, who is an admin / in it at all.
create or replace function public.other_admins(t uuid) returns boolean
  language sql security definer stable set search_path = '' as $$
  select exists (select 1 from public.team_members where team_id = t and user_id <> auth.uid() and role = 'admin') $$;
create or replace function public.others_in(t uuid) returns boolean
  language sql security definer stable set search_path = '' as $$
  select exists (select 1 from public.team_members where team_id = t and user_id <> auth.uid()) $$;
-- What a record is visible to: everyone in the team, except that members only see their own invoices.
create or replace function public.can_see(t uuid, k text, maker uuid) returns boolean
  language sql security definer stable set search_path = '' as $$
  select coalesce(public.my_role(t) in ('admin', 'accountant') or (public.my_role(t) = 'member' and (k <> 'invoice' or maker = auth.uid())), false) $$;

-- Copies keys from one JSON object to another (or removes them when the source doesn't have them).
create or replace function public.keep_keys(target jsonb, source jsonb, keys text[]) returns jsonb
  language plpgsql immutable set search_path = '' as $$
declare k text;
begin
  if target is null or jsonb_typeof(target) <> 'object' then return target; end if;
  foreach k in array keys loop
    if source is not null and source ? k then target := jsonb_set(target, array[k], source -> k);
    else target := target - k; end if;
  end loop;
  return target;
end $$;
create or replace function public.json_num(v jsonb) returns numeric
  language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(v) = 'number' then v::text::numeric
              when jsonb_typeof(v) = 'string' and v #>> '{}' ~ '^\s*-?\d+(\.\d+)?\s*$' then (v #>> '{}')::numeric end $$;

-- Stamps every insert and update (who, when, the next version number), and keeps each role to
-- what it may change. A change a role isn't allowed to make is quietly undone rather than refused,
-- so one bad record never stops the rest of a sync; the corrected record goes back to that person's
-- computer with the next sync.
create or replace function public.records_stamp() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  r text := public.my_role(new.team_id);
  billing constant text[] := array['currency', 'dueDays', 'hourlyRate', 'dailyRate', 'dayOffRate', 'taxRate'];
  reserved boolean := coalesce(new.data ->> 'private', '') = 'true';
begin
  if tg_op = 'INSERT' then
    -- An upsert of a record that already exists becomes an update, checked when it gets there.
    -- (Skipping it here would skip the update too.)
    -- Its maker is the existing one's, so who can see it doesn't change.
    if exists (select 1 from public.records x where x.team_id = new.team_id and x.kind = new.kind and x.id = new.id) then
      select x.created_by into new.created_by from public.records x where x.team_id = new.team_id and x.kind = new.kind and x.id = new.id;
      return new;
    end if;
    new.created_by := auth.uid();
  else
    new.created_by := coalesce(old.created_by, auth.uid());
  end if;

  if r = 'accountant' then
    if tg_op = 'INSERT' then return null; end if;                -- adds nothing
    if new.kind = 'invoice' and not old.deleted and old.data is not null then
      new.data := public.keep_keys(old.data, new.data, array['paidAt']); -- only the paid date
    else
      new.data := old.data;
    end if;
    new.deleted := old.deleted;
  elsif r = 'member' then
    if new.kind = 'business' then
      if tg_op = 'INSERT' then return null; end if;
      -- Only the "next number" counters move on (never back) when a member saves an invoice.
      new.data := old.data || jsonb_strip_nulls(jsonb_build_object(
        'nextNumber', greatest(public.json_num(old.data -> 'nextNumber'), public.json_num(new.data -> 'nextNumber')),
        'nextQuoteNumber', greatest(public.json_num(old.data -> 'nextQuoteNumber'), public.json_num(new.data -> 'nextQuoteNumber'))));
      new.deleted := old.deleted;
    elsif new.kind = 'client' and tg_op = 'UPDATE' and not old.deleted then
      if new.deleted then                                         -- can't delete clients
        new.deleted := false; new.data := old.data;
      else                                                        -- nor change their billing
        new.data := public.keep_keys(new.data, old.data, billing);
      end if;
    elsif new.kind = 'invoice' and tg_op = 'UPDATE' and not new.deleted and not reserved and not old.deleted then
      new.data := public.keep_keys(new.data, old.data, array['paidAt']); -- can't mark paid
    end if;
  elsif r is null and auth.uid() is not null then
    return null;                                                  -- not in the team (RLS stops this anyway)
  end if;                                                         -- (no user at all: the SQL editor, unrestricted)

  new.updated_at := now();
  new.updated_by := auth.uid();
  new.version := nextval('public.records_version');
  return new;
end $$;
create trigger records_stamp before insert or update on public.records
  for each row execute function public.records_stamp();

alter table public.teams        enable row level security;
alter table public.team_members enable row level security;
alter table public.team_invites enable row level security;
alter table public.records      enable row level security;

-- Teams: members see their team; an invitee sees the name of the team they're invited to.
drop policy if exists "Members and invitees see the team" on public.teams;
create policy "Members and invitees see the team" on public.teams for select
  using (public.is_member(id) or exists (select 1 from public.team_invites i where i.team_id = teams.id and i.email = public.my_email()));
drop policy if exists "Owner renames the team" on public.teams;
drop policy if exists "Admins rename the team" on public.teams;
create policy "Admins rename the team" on public.teams for update using (public.is_admin(id)) with check (public.is_admin(id));
drop policy if exists "Owner deletes the team" on public.teams;
drop policy if exists "Admins delete the team" on public.teams;
create policy "Admins delete the team" on public.teams for delete using (public.is_admin(id));
-- (Teams are created with create_team() below.)

-- Members: everyone in a team sees who's in it and their roles. Anyone can leave, except the last
-- admin while others are still in the team; admins can remove others. Roles change with set_member_role().
drop policy if exists "Members see each other" on public.team_members;
create policy "Members see each other" on public.team_members for select using (public.is_member(team_id));
drop policy if exists "Leave or remove" on public.team_members;
create policy "Leave or remove" on public.team_members for delete
  using ((user_id = auth.uid() and (role <> 'admin' or public.other_admins(team_id) or not public.others_in(team_id)))
      or (public.is_admin(team_id) and user_id <> auth.uid()));
-- (Members are added with create_team() and accept_invite() below.)

-- Invites: admins invite and cancel; the invited person sees and declines their own.
drop policy if exists "See invites" on public.team_invites;
create policy "See invites" on public.team_invites for select using (public.is_admin(team_id) or email = public.my_email());
drop policy if exists "Owner invites" on public.team_invites;
drop policy if exists "Admins invite" on public.team_invites;
create policy "Admins invite" on public.team_invites for insert
  with check (public.is_admin(team_id) and invited_by = auth.uid() and inviter_email = public.my_email());
drop policy if exists "Cancel or decline" on public.team_invites;
create policy "Cancel or decline" on public.team_invites for delete using (public.is_admin(team_id) or email = public.my_email());

-- Records: what each person sees depends on their role (can_see); what they may change is kept
-- in check by records_stamp(). Records are never hard-deleted by the app (deleted = true instead).
drop policy if exists "Members share the data" on public.records;
drop policy if exists "See records" on public.records;
drop policy if exists "Add records" on public.records;
drop policy if exists "Change records" on public.records;
drop policy if exists "Admins delete records" on public.records;
create policy "See records" on public.records for select using (public.can_see(team_id, kind, created_by));
create policy "Add records" on public.records for insert with check (public.is_member(team_id));
create policy "Change records" on public.records for update
  using (public.can_see(team_id, kind, created_by)) with check (public.is_member(team_id));
create policy "Admins delete records" on public.records for delete using (public.is_admin(team_id));

-- ---------- actions ----------
create or replace function public.create_team(team_name text) returns uuid
  language plpgsql security definer set search_path = '' as $$
declare t uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if exists (select 1 from public.team_members where user_id = auth.uid()) then
    raise exception 'You are already in a team. Leave it first.';
  end if;
  insert into public.teams (name, created_by) values (trim(team_name), auth.uid()) returning id into t;
  insert into public.team_members (team_id, user_id, email, role) values (t, auth.uid(), public.my_email(), 'admin');
  return t;
end $$;

create or replace function public.accept_invite(invite_id uuid) returns uuid
  language plpgsql security definer set search_path = '' as $$
declare t uuid; r text;
begin
  select team_id, role into t, r from public.team_invites where id = invite_id and email = public.my_email();
  if t is null then raise exception 'This invitation is no longer valid.'; end if;
  if exists (select 1 from public.team_members where user_id = auth.uid()) then
    raise exception 'You are already in a team. Leave it first.';
  end if;
  insert into public.team_members (team_id, user_id, email, role) values (t, auth.uid(), public.my_email(), coalesce(r, 'member'));
  delete from public.team_invites where id = invite_id;
  return t;
end $$;

-- An admin gives someone in their team a role. A team always keeps at least one admin.
create or replace function public.set_member_role(member uuid, new_role text) returns void
  language plpgsql security definer set search_path = '' as $$
declare t uuid; old_role text;
begin
  if new_role not in ('admin', 'accountant', 'member') then raise exception 'Unknown role: %', new_role; end if;
  select team_id, role into t, old_role from public.team_members where user_id = member;
  if t is null or not public.is_admin(t) then raise exception 'Only an admin of the team can change roles.'; end if;
  if old_role = 'admin' and new_role <> 'admin'
     and not exists (select 1 from public.team_members where team_id = t and role = 'admin' and user_id <> member) then
    raise exception 'A team needs at least one admin. Make someone else an admin first.';
  end if;
  update public.team_members set role = new_role where team_id = t and user_id = member;
end $$;

-- The numbers of the team's invoices and quotes (not their details), for everyone in the team:
-- a member, who only sees their own invoices, still needs to know which numbers are taken.
create or replace function public.team_invoice_numbers(t uuid) returns setof text
  language sql security definer stable set search_path = '' as $$
  select id from public.records where team_id = t and kind = 'invoice' and not deleted and public.is_member(t) $$;

revoke all on function public.create_team(text), public.accept_invite(uuid), public.set_member_role(uuid, text), public.team_invoice_numbers(uuid) from public, anon;
grant execute on function public.create_team(text), public.accept_invite(uuid), public.set_member_role(uuid, text), public.team_invoice_numbers(uuid) to authenticated;
grant select, insert, update, delete on public.teams, public.team_members, public.team_invites, public.records to authenticated;

-- "Delete my cloud data" also removes the account. The last admin of a team that still has other
-- people must make someone else an admin, remove them, or delete the team first, so nobody loses
-- the shared data by surprise. A team you're alone in is deleted with you.
create or replace function public.delete_own_account() returns void
  language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.team_members m where m.user_id = auth.uid() and m.role = 'admin'
             and public.others_in(m.team_id) and not public.other_admins(m.team_id)) then
    raise exception 'You are the only admin of a team that still has other people in it. Make someone else an admin, remove them, or delete the team first.';
  end if;
  delete from public.teams t where exists (select 1 from public.team_members m where m.team_id = t.id and m.user_id = auth.uid())
    and not public.others_in(t.id);
  delete from public.teams where created_by = auth.uid() and not exists (select 1 from public.team_members m where m.team_id = teams.id);
  delete from auth.users where id = auth.uid();
end $$;
revoke all on function public.delete_own_account() from public, anon;
grant execute on function public.delete_own_account() to authenticated;
