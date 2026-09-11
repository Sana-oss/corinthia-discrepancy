-- Fix 403 on first write of the day: every save is an upsert
-- (on_conflict=report_date). When today's row does NOT exist yet, PostgREST
-- routes the write as an INSERT — and the old insert policy only allowed FO
-- roles, so any HK user saving first (extra room before the list, Submit on an
-- empty list, fresh day) got 403 Forbidden.
--
-- New rule: any authenticated staff member (any of the six roles) may create
-- the day's row. This adds no exposure — the update policy already permits any
-- authenticated user to write the row — it just removes the dead end.
-- Replacing the daily list remains FD-only in the app UI (Setup tab), per the
-- Option A trust model.

drop policy if exists "fo upsert daily list" on public.daily_reports;
drop policy if exists "auth insert daily"    on public.daily_reports;

create policy "auth insert daily"
  on public.daily_reports for insert
  to authenticated
  with check ( public.my_staff_role() in
    ('hk_staff','hk_supervisor','hk_manager','fo_staff','fo_supervisor','fo_manager') );
