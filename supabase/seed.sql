-- Seed the first staff members.
-- IMPORTANT: every email listed here MUST already exist in auth.users
-- (Authentication > Users > Add user). Until a row exists in auth.users for
-- a given email, that person cannot sign in.
--
-- Roles are one of six values across two departments:
--   Housekeeping: hk_staff | hk_supervisor | hk_manager
--   Front Desk:   fo_staff | fo_supervisor | fo_manager
-- Roles are NOT changeable from the app — edit them in the Supabase
-- Dashboard (Table Editor > staff > role) or via SQL. See migration
-- 002_role_based_access.sql for mapping old 3-role rows to the new set.
--
-- The first manager account is bootstrapped as follows:
--   1. Authentication > Users > Add user → create your manager account
--      (email + password). Supabase sends a confirmation email by default;
--      turn that off or click the confirmation link for local dev.
--   2. Run this seed file with the manager's email filled in.
--   3. From then on, managers can add more staff rows from the dashboard or
--      via the SQL editor — there is no admin UI in the app yet.

insert into public.staff (email, full_name, role, active)
  values ('manager@corinthia-tripoli.com', 'Mohamed Gaja', 'hk_manager', true)
  on conflict (email) do update
    set full_name = excluded.full_name,
        role      = excluded.role,
        active    = excluded.active;
-- If the general manager actually fronts the Front Desk side, use
-- 'fo_manager' for this row instead (or add a second manager row).

insert into public.staff (email, full_name, role, active)
  values ('hk-lead@corinthia-tripoli.com', 'Housekeeping Lead', 'hk_supervisor', true)
  on conflict (email) do update
    set full_name = excluded.full_name,
        role      = excluded.role,
        active    = excluded.active;

insert into public.staff (email, full_name, role, active)
  values ('fd-lead@corinthia-tripoli.com', 'Front Desk Lead', 'fo_supervisor', true)
  on conflict (email) do update
    set full_name = excluded.full_name,
        role      = excluded.role,
        active    = excluded.active;

-- Add line staff the same way, e.g.:
--   insert into public.staff (email, full_name, role, active)
--     values ('hk1@corinthia-tripoli.com', 'Housekeeping Staff', 'hk_staff', true);

-- Soft-disable someone (keeps history attribution intact):
--   update public.staff set active = false where email = 'someone@x.com';

-- Hard-delete (only if they have no history attribution you care about):
--   delete from public.staff where email = 'someone@x.com';