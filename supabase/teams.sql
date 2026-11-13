-- Teams: two or more people working on the same business in Invaro (see SYNC.md).
-- Run once in the Supabase SQL editor. Safe to run again: everything is "if not exists" / "or replace".
--
--   teams         one row per shared business
--   team_members  who is in it (one team per person); the creator is the owner
--   team_invites  pending invitations, by email address
--   records       the shared data, one row per client / invoice, plus one "business" row (your details)
--
-- Every change to a record gets a new, ever-increasing `version`, so the app can ask for
-- "everything changed since version N" every few seconds.

create table if not exists public.teams (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(name) between 1 and 100),
  created_by uuid not null default auth.uid() references auth.users on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.team_members (
  team_id   uuid not null references public.teams on delete cascade,
  user_id   uuid not null references auth.users on delete cascade,
  email     text not null,
  role      text not null check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create unique index if not exists team_members_one_team on public.team_members (user_id);

create table if not exists public.team_invites (
  id            uuid primary key default gen_random_uuid(),
  team_id       uuid not null references public.teams on delete cascade,
  email         text not null check (email = lower(email) and email like '%_@_%'),
  invited_by    uuid not null default auth.uid() references auth.users on delete cascade,
  inviter_email text not null,
  created_at    timestamptz not null default now(),
  unique (team_id, email)
);

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

-- Stamp every insert and update: who, when, and the next version number.
create or replace function public.records_stamp() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  new.version := nextval('public.records_version');
  return new;
end $$;
drop trigger if exists records_stamp on public.records;
create trigger records_stamp before insert or update on public.records
  for each row execute function public.records_stamp();

-- ---------- who may do what ----------
create or replace function public.is_member(t uuid) returns boolean
  language sql security definer stable set search_path = '' as $$
  select exists (select 1 from public.team_members where team_id = t and user_id = auth.uid()) $$;
create or replace function public.is_owner(t uuid) returns boolean
  language sql security definer stable set search_path = '' as $$
  select exists (select 1 from public.team_members where team_id = t and user_id = auth.uid() and role = 'owner') $$;
create or replace function public.my_email() returns text
  language sql stable set search_path = '' as $$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

alter table public.teams        enable row level security;
alter table public.team_members enable row level security;
alter table public.team_invites enable row level security;
alter table public.records      enable row level security;

-- Teams: members see their team; an invitee sees the name of the team they're invited to.
drop policy if exists "Members and invitees see the team" on public.teams;
create policy "Members and invitees see the team" on public.teams for select
  using (public.is_member(id) or exists (select 1 from public.team_invites i where i.team_id = teams.id and i.email = public.my_email()));
drop policy if exists "Owner renames the team" on public.teams;
create policy "Owner renames the team" on public.teams for update using (public.is_owner(id)) with check (public.is_owner(id));
drop policy if exists "Owner deletes the team" on public.teams;
create policy "Owner deletes the team" on public.teams for delete using (public.is_owner(id));
-- (Teams are created with create_team() below.)

-- Members: everyone in a team sees who's in it. A member can leave; the owner can remove others.
drop policy if exists "Members see each other" on public.team_members;
create policy "Members see each other" on public.team_members for select using (public.is_member(team_id));
drop policy if exists "Leave or remove" on public.team_members;
create policy "Leave or remove" on public.team_members for delete
  using ((user_id = auth.uid() and role <> 'owner') or (public.is_owner(team_id) and user_id <> auth.uid()));
-- (Members are added with create_team() and accept_invite() below.)

-- Invites: the owner invites and cancels; the invited person sees and declines their own.
drop policy if exists "See invites" on public.team_invites;
create policy "See invites" on public.team_invites for select using (public.is_member(team_id) or email = public.my_email());
drop policy if exists "Owner invites" on public.team_invites;
create policy "Owner invites" on public.team_invites for insert
  with check (public.is_owner(team_id) and invited_by = auth.uid() and inviter_email = public.my_email());
drop policy if exists "Cancel or decline" on public.team_invites;
create policy "Cancel or decline" on public.team_invites for delete using (public.is_owner(team_id) or email = public.my_email());

-- Records: every member reads and writes all of the team's data.
drop policy if exists "Members share the data" on public.records;
create policy "Members share the data" on public.records for all
  using (public.is_member(team_id)) with check (public.is_member(team_id));

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
  insert into public.team_members (team_id, user_id, email, role) values (t, auth.uid(), public.my_email(), 'owner');
  return t;
end $$;

create or replace function public.accept_invite(invite_id uuid) returns uuid
  language plpgsql security definer set search_path = '' as $$
declare t uuid;
begin
  select team_id into t from public.team_invites where id = invite_id and email = public.my_email();
  if t is null then raise exception 'This invitation is no longer valid.'; end if;
  if exists (select 1 from public.team_members where user_id = auth.uid()) then
    raise exception 'You are already in a team. Leave it first.';
  end if;
  insert into public.team_members (team_id, user_id, email, role) values (t, auth.uid(), public.my_email(), 'member');
  delete from public.team_invites where id = invite_id;
  return t;
end $$;

revoke all on function public.create_team(text), public.accept_invite(uuid) from public, anon;
grant execute on function public.create_team(text), public.accept_invite(uuid) to authenticated;
grant select, insert, update, delete on public.teams, public.team_members, public.team_invites, public.records to authenticated;

-- "Delete my cloud data" also removes the account. An owner whose team still has other people
-- must remove them or delete the team first, so nobody loses the shared data by surprise.
create or replace function public.delete_own_account() returns void
  language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.team_members m where m.user_id = auth.uid() and m.role = 'owner'
             and exists (select 1 from public.team_members o where o.team_id = m.team_id and o.user_id <> auth.uid())) then
    raise exception 'You own a team that still has other people in it. Remove them or delete the team first.';
  end if;
  delete from public.teams where created_by = auth.uid();
  delete from auth.users where id = auth.uid();
end $$;
revoke all on function public.delete_own_account() from public, anon;
grant execute on function public.delete_own_account() to authenticated;
