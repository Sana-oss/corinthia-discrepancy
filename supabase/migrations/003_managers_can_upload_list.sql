-- 003_managers_can_upload_list.sql
-- Managers can now upload/replace the daily list in Setup — but ONLY within
-- their own department (strictly departmental access):
--   fo_manager  → Setup full (Front Desk's own tab)
--   hk_manager  → Setup hidden (Housekeeping has no Setup access at all)
-- Apply this after 002 if you already ran it; if you haven't, 002 already
-- includes this change. Re-runnable (drop + recreate). If you ran an earlier
-- draft that granted hk_manager upload here, re-running this fixes the policy.

drop policy if exists "fo upsert daily list" on public.daily_reports;

create policy "fo upsert daily list"
  on public.daily_reports for insert
  to authenticated
  with check ( public.my_staff_role() in ('fo_staff','fo_supervisor','fo_manager') );