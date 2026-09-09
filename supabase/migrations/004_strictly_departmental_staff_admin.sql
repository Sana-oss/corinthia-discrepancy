-- 004_strictly_departmental_staff_admin.sql
-- Staff management is now strictly departmental, matching the role matrix:
--   hk_manager → can read/add/edit/deactivate ONLY Housekeeping staff rows
--   fo_manager → can read/add/edit/deactivate ONLY Front Desk staff rows
-- (previously either manager could manage everyone's rows). This closes the
-- direct-API gap so the UI restriction isn't bypassable. Apply after 002/003.
-- Re-runnable.

drop policy if exists "staff self read"        on public.staff;
drop policy if exists "manager read all"       on public.staff;
drop policy if exists "manager write staff"    on public.staff;
drop policy if exists "manager read own dept"  on public.staff;
drop policy if exists "manager write own dept" on public.staff;

-- A logged-in user can still read their own staff row.
create policy "staff self read"
  on public.staff for select
  to authenticated
  using (email = auth.jwt() ->> 'email');

-- Managers read ONLY their own department's rows. `role like 'hk\_%'` /
-- `'fo\_%'` matches the role prefix.
create policy "manager read own dept"
  on public.staff for select
  to authenticated
  using (
    (public.my_staff_role() = 'hk_manager' and role like 'hk\_%')
    or
    (public.my_staff_role() = 'fo_manager' and role like 'fo\_%')
  );

-- Managers write ONLY their own department's rows. WITH CHECK evaluates the
-- resulting row (new role for insert/update), so a row can't be moved into the
-- other department; excluding your own email prevents self lockout via API.
create policy "manager write own dept"
  on public.staff for all
  to authenticated
  using (
    (public.my_staff_role() = 'hk_manager' and role like 'hk\_%')
    or
    (public.my_staff_role() = 'fo_manager' and role like 'fo\_%')
  )
  with check ( email <> auth.jwt() ->> 'email' );