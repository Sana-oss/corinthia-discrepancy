-- ============================================================================
-- 011_p3_staff_audit.sql
-- Batch A - staff administration and password accountability.
--
-- Approved plan: docs/p3-audit-coverage-analysis.md
-- This migration:
--   * extends system_audit_logs.visibility with 'staff_admin'
--   * tightens the read policy so supervisors cannot see staff-admin events
--   * removes DELETE/TRUNCATE from anon/authenticated on public.staff
--   * replaces the broad FOR ALL staff write policy with INSERT/UPDATE policies
--   * adds an append-only AFTER trigger on public.staff
--
-- Passwords, hashes, tokens and request bodies are never stored in audit rows.
-- Edge Functions own the auth.user events (create/reset/self-change) and insert
-- their own audit rows with an explicitly verified actor; service-role INSERT
-- and UPDATE of public.staff are suppressed here to avoid duplicate events.
-- Service-role DELETE is NOT suppressed, so exceptional deletions are recorded
-- with identity_unresolved = true.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Visibility value
-- ---------------------------------------------------------------------------
alter table public.system_audit_logs
  drop constraint if exists system_audit_logs_visibility_check;
alter table public.system_audit_logs
  add constraint system_audit_logs_visibility_check
  check (visibility in ('department', 'shared_report', 'staff_admin'));

-- ---------------------------------------------------------------------------
-- 2. Read policy: preserve P1/P2 behaviour, exclude supervisors from staff_admin
-- ---------------------------------------------------------------------------
drop policy if exists "audit read scoped" on public.system_audit_logs;
create policy "audit read scoped"
  on public.system_audit_logs
  for select
  to authenticated
  using (
    actor_user_id = auth.uid()
    or exists (
      select 1
      from public.audit_viewer() v
      where v.viewer_role = 'gm_admin'
         or (
           v.viewer_tier = 'manager'
           and (
             (visibility = 'department' and department = v.viewer_department)
             or visibility = 'shared_report'
             or (visibility = 'staff_admin' and department = v.viewer_department)
           )
         )
         or (
           v.viewer_tier = 'supervisor'
           and visibility = 'department'
           and department = v.viewer_department
         )
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Resolve an auth user id for the TARGET employee (never used as the actor)
-- ---------------------------------------------------------------------------
create or replace function public.audit_user_id_by_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.id
  from auth.users u
  where lower(u.email) = lower(p_email)
  limit 1;
$$;

revoke all on function public.audit_user_id_by_email(text) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Staff write hardening: no application-role DELETE/TRUNCATE
-- ---------------------------------------------------------------------------
revoke delete, truncate on table public.staff from anon, authenticated;

drop policy if exists "manager write own dept" on public.staff;
drop policy if exists "manager insert own dept" on public.staff;
drop policy if exists "manager update own dept" on public.staff;

create policy "manager insert own dept"
  on public.staff
  for insert
  to authenticated
  with check (
    public.my_staff_role() = 'gm_admin'
    or (
      (
        (public.my_staff_role() = 'hk_manager' and role like 'hk\_%')
        or (public.my_staff_role() = 'fo_manager' and role like 'fo\_%')
      )
      and email <> auth.jwt() ->> 'email'
    )
  );

create policy "manager update own dept"
  on public.staff
  for update
  to authenticated
  using (
    public.my_staff_role() = 'gm_admin'
    or (public.my_staff_role() = 'hk_manager' and role like 'hk\_%')
    or (public.my_staff_role() = 'fo_manager' and role like 'fo\_%')
  )
  with check (
    public.my_staff_role() = 'gm_admin'
    or (
      (
        (public.my_staff_role() = 'hk_manager' and role like 'hk\_%')
        or (public.my_staff_role() = 'fo_manager' and role like 'fo\_%')
      )
      and email <> auth.jwt() ->> 'email'
    )
  );

-- ---------------------------------------------------------------------------
-- 5. Staff audit trigger
-- ---------------------------------------------------------------------------
create or replace function public.audit_staff_changes()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_uid          uuid;
  v_actor_email        text;
  v_actor_name         text;
  v_actor_role         text;
  v_actor_dept         text;
  v_identity_unresolved boolean;
  v_target_email       text;
  v_target_name        text;
  v_target_role        text;
  v_target_active      boolean;
  v_target_department  text;
  v_target_uid         uuid;
  v_action             text;
  v_old_vals           jsonb;
  v_new_vals           jsonb;
  v_description        text;
  v_meta               jsonb;
begin
  -- The create-staff Edge Function emits one logical staff_created event for
  -- the manager path. Its service-role writes (and any direct privileged SQL
  -- write) have no verified JWT, so suppress INSERT/UPDATE here to avoid a
  -- duplicate or fabricated-actor event. DELETE is never suppressed: an
  -- exceptional deletion is still recorded with identity_unresolved = true.
  if tg_op in ('INSERT', 'UPDATE') and auth.uid() is null then
    return null;
  end if;

  -- Successful auth operations use the verified JWT actor. Privileged
  -- service-role/postgres writes have no JWT; record the event with an
  -- unresolved actor rather than attributing it to the target employee.
  v_identity_unresolved := auth.uid() is null;
  if v_identity_unresolved then
    v_actor_uid := null;
    v_actor_email := null;
    v_actor_name := null;
    v_actor_role := null;
    v_actor_dept := null;
  else
    select actor_user_id, actor_email, actor_name, actor_role, actor_department
      into v_actor_uid, v_actor_email, v_actor_name, v_actor_role, v_actor_dept
      from public.audit_actor();
    v_identity_unresolved := v_actor_role is null;
  end if;

  if tg_op = 'INSERT' then
    v_target_email := new.email;
    v_target_name := new.full_name;
    v_target_role := new.role;
    v_target_active := new.active;
    v_action := 'staff_created';
    v_old_vals := null;
    v_new_vals := jsonb_build_object(
      'full_name', new.full_name, 'role', new.role, 'active', new.active
    );
    v_description := format('Staff created: %s (%s)', new.full_name, new.role);
  elsif tg_op = 'UPDATE' then
    if old is not distinct from new then
      return null;
    end if;
    v_target_email := new.email;
    v_target_name := new.full_name;
    v_target_role := new.role;
    v_target_active := new.active;

    v_old_vals := '{}'::jsonb;
    v_new_vals := '{}'::jsonb;
    if old.full_name is distinct from new.full_name then
      v_old_vals := v_old_vals || jsonb_build_object('full_name', old.full_name);
      v_new_vals := v_new_vals || jsonb_build_object('full_name', new.full_name);
    end if;
    if old.role is distinct from new.role then
      v_old_vals := v_old_vals || jsonb_build_object('role', old.role);
      v_new_vals := v_new_vals || jsonb_build_object('role', new.role);
    end if;
    if old.active is distinct from new.active then
      v_old_vals := v_old_vals || jsonb_build_object('active', old.active);
      v_new_vals := v_new_vals || jsonb_build_object('active', new.active);
    end if;

    if old.full_name is not distinct from new.full_name
       and old.role is not distinct from new.role
       and old.active is distinct from new.active then
      v_action := 'staff_active_changed';
      v_description := format('Staff %s: %s',
        case when new.active then 'reactivated' else 'deactivated' end, new.email);
    else
      v_action := 'staff_updated';
      v_description := format('Staff updated: %s', new.email);
    end if;
  else
    v_target_email := old.email;
    v_target_name := old.full_name;
    v_target_role := old.role;
    v_target_active := old.active;
    v_action := 'staff_deleted';
    v_old_vals := jsonb_build_object(
      'full_name', old.full_name, 'role', old.role, 'active', old.active
    );
    v_new_vals := null;
    v_description := format('Staff deleted: %s', old.full_name);
  end if;

  v_target_department := public.audit_department(v_target_role);
  v_target_uid := public.audit_user_id_by_email(v_target_email);

  v_meta := jsonb_build_object(
    'target_email', v_target_email,
    'target_full_name', v_target_name,
    'target_role', v_target_role,
    'target_department', v_target_department,
    'target_user_id', v_target_uid,
    'login_created', case when tg_op = 'INSERT' then null end
  );
  if v_identity_unresolved then
    v_meta := v_meta || jsonb_build_object('identity_unresolved', true);
  end if;

  insert into public.system_audit_logs (
    actor_user_id, actor_email, actor_name, actor_role, actor_department,
    department, visibility, module, action_type,
    entity_type, entity_id, entity_label,
    old_values, new_values, description, source, metadata
  ) values (
    v_actor_uid, v_actor_email, v_actor_name,
    v_actor_role, v_actor_dept,
    v_target_department, 'staff_admin', 'staff', v_action,
    'staff', v_target_email, v_target_name,
    v_old_vals, v_new_vals, v_description, 'db_trigger', v_meta
  );

  return null;
end;
$$;

drop trigger if exists trg_audit_staff_changes on public.staff;
create trigger trg_audit_staff_changes
  after insert or update or delete on public.staff
  for each row execute function public.audit_staff_changes();

comment on function public.audit_staff_changes() is
  'Append-only staff administration audit. Actor comes from the verified JWT; the affected employee is recorded as entity + target_* metadata. Service-role INSERT/UPDATE are suppressed because the Edge Function logs that logical operation.';
