-- Room Discrepancy Report — Supabase schema
-- Run this in the Supabase SQL editor (Database > SQL Editor > New query).
-- Re-runnable: every CREATE uses IF NOT EXISTS where possible.

-- ============================================================================
-- 1. staff
--    One row per person who can sign in. email must match an auth.users row.
--    The role determines what the UI allows them to do (enforced in the app,
--    AND in RLS below for defense-in-depth).
-- ============================================================================
create table if not exists public.staff (
  email       text primary key,
  full_name   text not null,
  role        text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Six roles across two departments (kept in sync with the app's ROLE_* maps):
--   Housekeeping: hk_staff | hk_supervisor | hk_manager
--   Front Desk:   fo_staff | fo_supervisor | fo_manager
-- This script is re-runnable over the old 3-role table. ORDER MATTERS: drop the
-- old check, re-map legacy roles, then add the new check — adding the check
-- before the re-map would fail (23514) while rows still hold legacy values.
alter table public.staff drop constraint if exists staff_role_check;

update public.staff set role = 'hk_supervisor' where role = 'housekeeping';
update public.staff set role = 'fo_supervisor' where role = 'front_desk';
update public.staff set role = 'hk_manager'    where role = 'manager';
-- update public.staff set role = 'fo_manager' where role = 'manager';

alter table public.staff add constraint staff_role_check
  check (role in ('hk_staff','hk_supervisor','hk_manager','fo_staff','fo_supervisor','fo_manager'));

alter table public.staff enable row level security;

-- security definer helper: reads the current user's role WITHOUT triggering
-- RLS (runs as the table owner, not the calling user). This breaks the
-- infinite-recursion that would occur if policies queried public.staff directly.
create or replace function public.my_staff_role()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select role
  from public.staff
  where email = auth.jwt() ->> 'email'
    and active = true
  limit 1;
$$;

drop policy if exists "staff self read"       on public.staff;
drop policy if exists "manager read all"      on public.staff;
drop policy if exists "manager write staff"   on public.staff;
drop policy if exists "manager read own dept" on public.staff;
drop policy if exists "manager write own dept" on public.staff;

-- A logged-in user can read their own staff row.
create policy "staff self read"
  on public.staff for select
  to authenticated
  using (email = auth.jwt() ->> 'email');

-- Managers can read ONLY their own department's staff rows (strictly
-- departmental). `role like 'hk\_%'` / `'fo\_%'` matches the role prefix.
create policy "manager read own dept"
  on public.staff for select
  to authenticated
  using (
    (public.my_staff_role() = 'hk_manager' and role like 'hk\_%')
    or
    (public.my_staff_role() = 'fo_manager' and role like 'fo\_%')
  );

-- Managers can insert / update / delete ONLY their own department's staff rows.
-- WITH CHECK evaluates the resulting row (new role for insert/update), so a
-- manager can't move a row into the other department; excluding their own email
-- prevents a self-demotion/self-disable lockout via a direct API call.
create policy "manager write own dept"
  on public.staff for all
  to authenticated
  using (
    (public.my_staff_role() = 'hk_manager' and role like 'hk\_%')
    or
    (public.my_staff_role() = 'fo_manager' and role like 'fo\_%')
  )
  with check ( email <> auth.jwt() ->> 'email' );

-- ============================================================================
-- 2. daily_reports
--    One row per calendar day. payload is a free-form jsonb blob holding the
--    rooms, extras, and confirmations for that day. Keyed by report_date (text
--    'YYYY-MM-DD') so a single upsert replaces the whole day.
-- ============================================================================
create table if not exists public.daily_reports (
  report_date text primary key,
  payload     jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);

alter table public.daily_reports enable row level security;

drop policy if exists "auth read daily"            on public.daily_reports;
drop policy if exists "auth insert daily"          on public.daily_reports;
drop policy if exists "auth update daily"          on public.daily_reports;
drop policy if exists "fd or manager insert"       on public.daily_reports;
drop policy if exists "fd or manager update"       on public.daily_reports;
drop policy if exists "anon read"                  on public.daily_reports;
drop policy if exists "anon insert"                on public.daily_reports;
drop policy if exists "anon update"                on public.daily_reports;
drop policy if exists "fo upsert daily list"       on public.daily_reports;
drop policy if exists "authenticated update daily" on public.daily_reports;

-- Logged-in users can read any day's report (Summary/History) — no anonymous access.
create policy "auth read daily"
  on public.daily_reports for select
  to authenticated
  using (true);

-- Front Desk line staff and FO manager create/replace the day's list (Setup).
-- Strictly departmental: HK roles (including hk_manager) have NO Setup access.
create policy "fo upsert daily list"
  on public.daily_reports for insert
  to authenticated
  with check ( public.my_staff_role() in ('fo_staff','fo_supervisor','fo_manager') );

-- Option A from roles-implementation-plan.md: a single permissive update policy.
-- RLS cannot restrict writes to individual jsonb keys inside `payload`, so
-- per-action write rules are enforced client-side; any authenticated user can
-- still PATCH the row directly. If stricter per-field enforcement is needed
-- later, split payload into per-concern tables (Option B) — see the plan.
create policy "authenticated update daily"
  on public.daily_reports for update
  to authenticated
  using (true);