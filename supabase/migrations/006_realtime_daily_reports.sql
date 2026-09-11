-- Live updates: include daily_reports in the supabase_realtime publication so
-- the app's Realtime subscription receives an event whenever any device saves
-- today's report — every open screen re-fetches and re-renders automatically.
-- Without this, postgres_changes events are never delivered for the table
-- (the subscription connects fine but stays silent).

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'daily_reports'
  ) then
    alter publication supabase_realtime add table public.daily_reports;
  end if;
end $$;
