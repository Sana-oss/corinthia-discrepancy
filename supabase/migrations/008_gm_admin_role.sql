-- 008_gm_admin_role.sql — add the cross-department GM Admin role
--
-- gm_admin is the "Super Admin / General Admin" role: it keeps full
-- cross-department staff management (view/add/edit/deactivate every
-- department's staff) while hk_manager / fo_manager stay strictly
-- departmental (migration 004). Apply after 004–007. Re-runnable.
--
-- NOTE: a gm_admin row must also exist in auth.users before that person
-- can sign in (Supabase → Authentication → Users), same as every role.

-- ----------------------------------------------------------------------------
-- 1. staff.role — add gm_admin to the allowed set
-- ----------------------------------------------------------------------------
alter table public.staff drop constraint if exists staff_role_check;

alter table public.staff add constraint staff_role_check
  check (role in ('hk_staff','hk_supervisor','hk_manager','fo_staff','fo_supervisor','fo_manager','gm_admin'));

-- ----------------------------------------------------------------------------
-- 2. staff RLS — gm_admin manages every department's rows
-- ----------------------------------------------------------------------------

-- (self-read is unchanged — recreate for completeness, re-runnable)
drop policy if exists "staff self read" on public.staff;
create policy "staff self read"
  on public.staff for select
  to authenticated
  using (email = auth.jwt() ->> 'email');

-- Read: departmental managers keep their own-dept restriction; gm_admin reads
-- every row.
drop policy if exists "manager read own dept" on public.staff;
create policy "manager read own dept"
  on public.staff for select
  to authenticated
  using (
    public.my_staff_role() = 'gm_admin'
    or
    (public.my_staff_role() = 'hk_manager' and role like 'hk\_%')
    or
    (public.my_staff_role() = 'fo_manager' and role like 'fo\_%')
  );

-- Write: departmental managers keep their own-dept restriction (WITH CHECK
-- evaluates the resulting row, so a row can't be moved into the other
-- department); gm_admin may write any row — including its own email, so the
-- account can't lock itself out of editing via API.
drop policy if exists "manager write own dept" on public.staff;
create policy "manager write own dept"
  on public.staff for all
  to authenticated
  using (
    public.my_staff_role() = 'gm_admin'
    or
    (public.my_staff_role() = 'hk_manager' and role like 'hk\_%')
    or
    (public.my_staff_role() = 'fo_manager' and role like 'fo\_%')
  )
  with check (
    public.my_staff_role() = 'gm_admin'
    or
    (
      (
        (public.my_staff_role() = 'hk_manager' and role like 'hk\_%')
        or
        (public.my_staff_role() = 'fo_manager' and role like 'fo\_%')
      )
      and email <> auth.jwt() ->> 'email'
    )
  );

-- ----------------------------------------------------------------------------
-- 3. daily_reports — gm_admin joins the allowed inserters (same as any staff)
-- ----------------------------------------------------------------------------
drop policy if exists "auth insert daily" on public.daily_reports;
create policy "auth insert daily"
  on public.daily_reports for insert
  to authenticated
  with check ( public.my_staff_role() in
    ('hk_staff','hk_supervisor','hk_manager','fo_staff','fo_supervisor','fo_manager','gm_admin') );
