-- Invite-only sign-up: only approved people can create an Invaro account (see SYNC.md).
-- Run once in the Supabase SQL editor, then turn the hook on:
--   Authentication → Hooks → Before User Created → Postgres → public.hook_before_user_created
--
-- Someone may sign up when either:
--   - their email (or their email's @domain) is in public.allowed_signups, or
--   - a team has invited them (public.team_invites), so inviting your partner is enough.
-- Existing accounts aren't affected: the check only runs when a new account is created.
--
-- To approve people, in the SQL editor (or Table Editor → allowed_signups → Insert row):
--   insert into public.allowed_signups (email, note) values ('partner@example.com', 'my partner');
--   insert into public.allowed_signups (email, note) values ('@mycompany.com', 'everyone at my company');
-- To stop approving someone: delete from public.allowed_signups where email = 'partner@example.com';

create table if not exists public.allowed_signups (
  email    text primary key check (email = lower(email) and (email like '%_@_%' or email like '@_%')),
  note     text,
  added_at timestamptz not null default now()
);
-- Nobody can read or change the list through the app: no policies, and RLS on.
alter table public.allowed_signups enable row level security;
revoke all on public.allowed_signups from anon, authenticated;

-- Everyone who already has an account stays approved (e.g. if they delete their account and come back).
insert into public.allowed_signups (email, note)
  select lower(email), 'had an account when sign-up became invite-only' from auth.users where email is not null
  on conflict (email) do nothing;

create or replace function public.hook_before_user_created(event jsonb) returns jsonb
  language plpgsql security definer set search_path = '' as $$
declare
  addr text := lower(coalesce(event -> 'user' ->> 'email', ''));
begin
  if addr <> '' and (
       exists (select 1 from public.allowed_signups a where a.email = addr or a.email = '@' || split_part(addr, '@', 2))
    or exists (select 1 from public.team_invites i where i.email = addr)
  ) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'Invaro is invite-only for now. To get access, send the Invaro developer a WhatsApp with your email address ('
      || coalesce(nullif(addr, ''), 'the one you sign in with') || '). Once you are approved, sign in again.'));
end $$;

-- Only Supabase Auth may run the check.
revoke all on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
