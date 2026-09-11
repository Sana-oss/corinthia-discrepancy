-- Trim whitespace from staff.role (and full_name) before the row is written.
-- Hand-typed values in the Table Editor often carry a trailing space, which
-- fails the staff_role_check constraint (23514) — e.g. 'hk_manager ' is not
-- 'hk_manager'. A BEFORE ROW trigger fires before CHECK constraints, so
-- btrim() here makes 'hk_manager ' pass as 'hk_manager'.
create or replace function public.trim_staff_fields()
returns trigger as $$
begin
  new.role := btrim(new.role);
  new.full_name := btrim(new.full_name);
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_trim_staff_fields on public.staff;
create trigger trg_trim_staff_fields
  before insert or update of role, full_name on public.staff
  for each row execute function public.trim_staff_fields();

-- Clean up any existing rows that kept stray whitespace (idempotent no-ops
-- when everything is already clean):
update public.staff set role      = btrim(role)      where role      <> btrim(role);
update public.staff set full_name = btrim(full_name) where full_name <> btrim(full_name);
