-- 002_role_based_access.sql — six-role access control
-- Implements roles-implementation-plan.md against the existing schema.
-- Run this in the Supabase SQL editor (after 001). Re-runnable.

-- ----------------------------------------------------------------------------
-- 1. staff.role — widen from 3 roles to six
--    Housekeeping: hk_staff | hk_supervisor | hk_manager
--    Front Desk:   fo_staff | fo_supervisor | fo_manager
--
-- ORDER MATTERS: the legacy→six-role re-map MUST run BEFORE the new CHECK
-- constraint is added. Postgres validates a new CHECK against all existing
-- rows, so adding it first fails with 23514 while rows still say
-- 'housekeeping' / 'front_desk' / 'manager'.
-- ----------------------------------------------------------------------------
alter table public.staff drop constraint if exists staff_role_check;

-- Re-map legacy role values (EDIT per person — defaults match the seeds):
--   'housekeeping' → hk_supervisor  (the old "Housekeeping Lead")
--   'front_desk'   → fo_supervisor  (the old "Front Desk Lead")
--   'manager'      → hk_manager by default; uncomment the fo_manager line
--                     instead if this user fronts the Front Desk side.
update public.staff set role = 'hk_supervisor' where role = 'housekeeping';
update public.staff set role = 'fo_supervisor' where role = 'front_desk';
update public.staff set role = 'hk_manager'    where role = 'manager';
-- update public.staff set role = 'fo_manager' where role = 'manager';

alter table public.staff add constraint staff_role_check
  check (role in ('hk_staff','hk_supervisor','hk_manager','fo_staff','fo_supervisor','fo_manager'));

-- ----------------------------------------------------------------------------
-- 3. staff RLS — keep self-read for everyone, widen staff admin to both managers
-- ----------------------------------------------------------------------------
drop policy if exists "staff self read"      on public.staff;
drop policy if exists "manager read all"     on public.staff;
drop policy if exists "manager write staff"  on public.staff;

create policy "staff self read"
  on public.staff for select
  to authenticated
  using (email = auth.jwt() ->> 'email');

create policy "manager read all"
  on public.staff for select
  to authenticated
  using (public.my_staff_role() in ('hk_manager','fo_manager'));

create policy "manager write staff"
  on public.staff for all
  to authenticated
  using (public.my_staff_role() in ('hk_manager','fo_manager'))
  with check (public.my_staff_role() in ('hk_manager','fo_manager'));

-- ----------------------------------------------------------------------------
-- 4. daily_reports RLS — role-aware:
--      read:  any logged-in user (Summary/History)
--      insert: Front Desk line staff + FO manager — Setup upload (strictly departmental)
--      update: any authenticated user (Option A — see roles-implementation-plan.md)
-- ----------------------------------------------------------------------------
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

create policy "auth read daily"
  on public.daily_reports for select
  to authenticated
  using (true);

-- Front Desk line staff + FO manager can create/replace the day's list.
-- Strictly departmental: HK roles (including hk_manager) have NO Setup access.
create policy "fo upsert daily list"
  on public.daily_reports for insert
  to authenticated
  with check ( public.my_staff_role() in ('fo_staff','fo_supervisor','fo_manager') );

create policy "authenticated update daily"
  on public.daily_reports for update
  to authenticated
  using (true);