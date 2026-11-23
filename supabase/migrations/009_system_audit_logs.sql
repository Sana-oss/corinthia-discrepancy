-- ============================================================================
-- 009_system_audit_logs.sql
-- Phase P1 - Centralized, append-only operational audit trail.
--
-- Approved design (see docs/audit-trail.md):
--   * ONE centralized audit table, no parallel per-module logs.
--   * The database is the authoritative source of truth: changes are detected
--     by diffing the persisted row, never taken from a client-supplied claim.
--   * Actor identity comes from the verified Supabase JWT (auth.uid()/auth.jwt())
--     and is snapshotted (name / role / department) at event time.
--   * Rows are immutable for every API role (no UPDATE / DELETE / TRUNCATE).
--   * One row per changed logical entity and actual state transition.
--     No-op writes and rolled-back writes emit nothing.
--
-- Scope of THIS migration (P1):
--   * system_audit_logs table, indexes, RLS read policies, immutability guards
--   * actor resolution / identity snapshot helpers
--   * daily_reports.updated_by is now stamped from auth.uid()
--   * Room Checklist status transitions (the four mutually exclusive states,
--     including cross-state replacements). One row per room per transition.
--
-- Deliberately NOT in this migration (later, separately reviewed phases):
--   * room-list import / extra rooms / report lifecycle  (P2)
--   * staff management / password reset logging           (P3)
--   * self-service password change logging                (P3, approved)
--   * offline outbox -> event queue                       (separate phase)
--   * historical baseline rows                            (rejected by owner)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Centralized audit table
-- ---------------------------------------------------------------------------
create table public.system_audit_logs (
  id                bigint generated always as identity primary key,
  occurred_at       timestamptz not null default now(),

  -- Actor snapshot, taken from the verified JWT + staff row at event time.
  -- Never supplied by the browser. Nullable on purpose: a write can only reach
  -- this table through an authenticated path, but the identity may not resolve
  -- (e.g. an auth user with no staff row); such rows are flagged in metadata.
  actor_user_id     uuid,
  actor_email       text,
  actor_name        text,
  actor_role        text,
  actor_department  text,

  -- Event scope (which department owns this event), not the actor's department.
  -- Used for read scoping so a manager always sees their department's events
  -- even if the row was technically written by someone else.
  department        text,
  visibility        text not null default 'department'
                    check (visibility in ('department', 'shared_report')),

  module            text not null,
  action_type       text not null,

  entity_type       text not null,   -- room | daily_report | extra_room | staff
  entity_id         text not null,   -- room number | report_date | staff email
  entity_label      text,

  old_values        jsonb,           -- only the fields that changed
  new_values        jsonb,
  description       text,
  source            text not null default 'db_trigger',
  metadata          jsonb not null default '{}'::jsonb
);

comment on table public.system_audit_logs is
  'Append-only operational audit trail (P1 rollout 2026-11-23). Written only by SECURITY DEFINER trigger functions and the service-role edge functions. No API role may update, delete or truncate rows. Coverage begins at the first row written after this migration; earlier activity was not captured and is never fabricated.';
comment on column public.system_audit_logs.occurred_at is
  'Database clock at capture time. For offline-replayed actions this is the replay time; the original client time (when available) is kept in metadata.client_occurred_at.';
comment on column public.system_audit_logs.actor_user_id is
  'auth.uid() at the moment of the write. Not client-supplied.';
comment on column public.system_audit_logs.actor_department is
  'Department derived from the actor role at event time (hk | fo | all).';
comment on column public.system_audit_logs.department is
  'Department that owns the event scope, used for read access. Nullable for shared/system events.';
comment on column public.system_audit_logs.visibility is
  'department = only the owning department (managers/supervisors) may read; shared_report = cross-department report lifecycle, readable by both department managers.';
comment on column public.system_audit_logs.old_values is
  'Changed fields only, as persisted before the write.';
comment on column public.system_audit_logs.new_values is
  'Changed fields only, as persisted after the write.';

-- ---------------------------------------------------------------------------
-- 2. Indexes for the Activity view filters and per-record timelines
-- ---------------------------------------------------------------------------
create index system_audit_logs_occurred_at_idx
  on public.system_audit_logs (occurred_at desc);
create index system_audit_logs_actor_idx
  on public.system_audit_logs (actor_user_id, occurred_at desc);
create index system_audit_logs_email_idx
  on public.system_audit_logs (actor_email);
create index system_audit_logs_department_idx
  on public.system_audit_logs (department, occurred_at desc);
create index system_audit_logs_module_action_idx
  on public.system_audit_logs (module, action_type);
create index system_audit_logs_entity_idx
  on public.system_audit_logs (entity_type, entity_id, occurred_at desc);
create index system_audit_logs_report_date_idx
  on public.system_audit_logs ((metadata ->> 'report_date'));

-- ---------------------------------------------------------------------------
-- 3. Read scoping helpers
-- ---------------------------------------------------------------------------
-- Department is derived from the role prefix, exactly like ROLE_DEPT in the app.
create or replace function public.audit_department(p_role text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case
    when p_role is null then null
    when p_role ~ '^hk_' then 'hk'
    when p_role ~ '^fo_' then 'fo'
    when p_role = 'gm_admin' then 'all'
    else null
  end;
$$;

-- Tier is the role suffix: hk_staff -> staff, hk_manager -> manager, gm_admin -> admin.
create or replace function public.audit_role_tier(p_role text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case
    when p_role is null then null
    else split_part(p_role, '_', 2)
  end;
$$;

-- Resolve the verified actor and snapshot their identity. SECURITY DEFINER so
-- it can read auth.users and bypass staff RLS; owner bypasses RLS (not FORCED).
create or replace function public.audit_actor()
returns table (
  actor_user_id    uuid,
  actor_email      text,
  actor_name       text,
  actor_role       text,
  actor_department text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (
    select auth.uid() as uid,
           nullif(auth.jwt() ->> 'email', '') as jwt_email
  )
  select
    me.uid,
    coalesce(me.jwt_email, u.email),
    s.full_name,
    s.role,
    public.audit_department(s.role)
  from me
  left join auth.users u on u.id = me.uid
  left join public.staff s
    on lower(s.email) = lower(coalesce(me.jwt_email, u.email))
  limit 1;
$$;

-- Resolve the reader's role/department for RLS. Active staff only, mirroring
-- my_staff_role(). Unknown or inactive users resolve to nulls.
create or replace function public.audit_viewer()
returns table (
  viewer_user_id    uuid,
  viewer_email      text,
  viewer_role       text,
  viewer_department text,
  viewer_tier       text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    auth.uid(),
    nullif(auth.jwt() ->> 'email', ''),
    s.role,
    public.audit_department(s.role),
    public.audit_role_tier(s.role)
  from (select 1) as one
  left join public.staff s
    on lower(s.email) = lower(nullif(auth.jwt() ->> 'email', ''))
   and s.active = true
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- 4. RLS: read-only, scoped. No INSERT/UPDATE/DELETE policies at all.
-- ---------------------------------------------------------------------------
alter table public.system_audit_logs enable row level security;

revoke all on table public.system_audit_logs from anon, authenticated;
grant select on table public.system_audit_logs to authenticated;
revoke all on sequence public.system_audit_logs_id_seq from anon, authenticated;

-- Read rules (approved):
--   * every authenticated user sees their own recorded actions (staff self-view)
--   * gm_admin sees everything
--   * managers see their own department's scope + cross-department shared
--     report lifecycle events (the operational handoff timeline)
--   * supervisors see their own department's scope only
--   * ordinary staff see nothing beyond their own rows
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
         or (v.viewer_tier = 'manager'
             and (department = v.viewer_department
                  or visibility = 'shared_report'))
         or (v.viewer_tier = 'supervisor'
             and department = v.viewer_department)
    )
  );

-- ---------------------------------------------------------------------------
-- 5. Immutability: ordinary API roles can never rewrite history.
--    Row triggers return OLD/NEW so the table owner (postgres) can still run
--    maintenance; every other role gets an explicit exception.
-- ---------------------------------------------------------------------------
create or replace function public.audit_logs_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('postgres', 'supabase_admin') then
    raise exception 'system_audit_logs is append-only: % is not permitted (role %)',
      tg_op, current_user
      using errcode = 'insufficient_privilege';
  end if;

  if tg_level = 'ROW' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  return null;
end;
$$;

create trigger trg_system_audit_logs_no_update
  before update on public.system_audit_logs
  for each row execute function public.audit_logs_immutable();

create trigger trg_system_audit_logs_no_delete
  before delete on public.system_audit_logs
  for each row execute function public.audit_logs_immutable();

create trigger trg_system_audit_logs_no_truncate
  before truncate on public.system_audit_logs
  for each statement execute function public.audit_logs_immutable();

-- ---------------------------------------------------------------------------
-- 6. Trusted actor stamping on daily_reports
--    The client has never written updated_by; stamp it server-side from the
--    verified JWT. SQL-console / service-role writes leave it untouched.
-- ---------------------------------------------------------------------------
create or replace function public.stamp_daily_report_actor()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null then
    new.updated_by := auth.uid();
  end if;
  return new;
end;
$$;

create trigger trg_stamp_daily_report_actor
  before insert or update on public.daily_reports
  for each row execute function public.stamp_daily_report_actor();

-- ---------------------------------------------------------------------------
-- 7. P1 capture: Room Checklist status transitions
--
-- The app stores ONE mutually exclusive status per room:
--   unconfirmed | confirmed | noluggage | dnd
-- Every click replaces that single field, so the previous state is only
-- recoverable by diffing the persisted payload. This trigger does exactly that,
-- inside the same transaction as the write:
--   * one row per room whose status actually changed
--   * no row for a no-op save (identical payload)
--   * no row for a failed/rolled-back write (the insert is part of the update)
--   * no row for a room added/removed (room-list import is P2)
--   * no row when the save is a list import (list_uploaded_at changed), so an
--     FD list re-import is never mislabelled as HK checklist activity
-- ---------------------------------------------------------------------------
create or replace function public.audit_daily_report_changes()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor         record;
  v_identity_ok   boolean;
  v_old_rooms     jsonb;
  v_new_rooms     jsonb;
  v_room_key      text;
  v_new_room      jsonb;
  v_old_room      jsonb;
  v_from          text;
  v_to            text;
  v_action        text;
  v_set_flags     jsonb;
  v_unset_flags   jsonb;
  v_meta          jsonb;
begin
  -- Only authenticated end-user writes are captured here. Service-role writes
  -- (edge functions, migrations) have no auth.uid(); those paths log their own
  -- rows with the caller identity they verify.
  if auth.uid() is null then
    return null;
  end if;

  if tg_op <> 'UPDATE' then
    return null;
  end if;

  -- Identical payload => the write changed nothing meaningful. Emit nothing.
  if new.payload is not distinct from old.payload then
    return null;
  end if;

  -- "Save & start today's checklist" (room-list import) stamps
  -- list_uploaded_at; its status churn is list replacement, not a checklist
  -- action. It is captured as one room-list event in P2.
  if new.list_uploaded_at is distinct from old.list_uploaded_at then
    return null;
  end if;

  select * into v_actor from public.audit_actor();
  v_identity_ok := v_actor.actor_role is not null;

  v_old_rooms := coalesce(old.payload -> 'rooms', '[]'::jsonb);
  v_new_rooms := coalesce(new.payload -> 'rooms', '[]'::jsonb);

  for v_room_key, v_new_room in
    select r ->> 'room', r
    from jsonb_array_elements(v_new_rooms) as r
    where coalesce(r ->> 'room', '') <> ''
  loop
    select r
      into v_old_room
      from jsonb_array_elements(v_old_rooms) as r
     where r ->> 'room' = v_room_key
     limit 1;

    -- Added room: room-list concern, handled in P2.
    if v_old_room is null then
      continue;
    end if;

    v_from := coalesce(nullif(btrim(v_old_room ->> 'status'), ''), 'unconfirmed');
    v_to   := coalesce(nullif(btrim(v_new_room ->> 'status'), ''), 'unconfirmed');

    if v_from = v_to then
      continue;
    end if;

    -- Name the transition by the state that was turned ON. A cross-state
    -- replacement (e.g. confirmed -> dnd) is one row with the old flag in
    -- unset_flags, so nothing is lost and no duplicate row is created.
    if v_to = 'confirmed' then
      v_action := 'room_confirmed';
    elsif v_to = 'noluggage' then
      v_action := 'room_noluggage_on';
    elsif v_to = 'dnd' then
      v_action := 'room_dnd_on';
    elsif v_to = 'unconfirmed' then
      v_action := case v_from
                    when 'noluggage' then 'room_noluggage_off'
                    when 'dnd'       then 'room_dnd_off'
                    else                  'room_unconfirmed'
                  end;
    else
      -- Unexpected value: never drop a real persisted change.
      v_action := 'room_status_changed';
    end if;

    v_set_flags := case v_to
                     when 'confirmed' then '["confirmed"]'::jsonb
                     when 'noluggage' then '["noluggage"]'::jsonb
                     when 'dnd'       then '["dnd"]'::jsonb
                     else '[]'::jsonb
                   end;
    v_unset_flags := case
                       when v_from in ('confirmed', 'noluggage', 'dnd')
                        and v_from <> v_to
                         then jsonb_build_array(v_from)
                       else '[]'::jsonb
                     end;

    v_meta := jsonb_build_object(
      'report_date',  new.report_date,
      'room',         v_room_key,
      'status_from',  v_from,
      'status_to',    v_to,
      'set_flags',    v_set_flags,
      'unset_flags',  v_unset_flags
    );
    if not v_identity_ok then
      v_meta := v_meta || jsonb_build_object('identity_unresolved', true);
    end if;

    insert into public.system_audit_logs (
      actor_user_id, actor_email, actor_name, actor_role, actor_department,
      department, visibility,
      module, action_type,
      entity_type, entity_id, entity_label,
      old_values, new_values, description, source, metadata
    ) values (
      v_actor.actor_user_id, v_actor.actor_email, v_actor.actor_name,
      v_actor.actor_role, v_actor.actor_department,
      'hk', 'department',
      'room_checklist', v_action,
      'room', v_room_key, 'Room ' || v_room_key,
      jsonb_build_object('status', v_from),
      jsonb_build_object('status', v_to),
      format('Room %s: status %s -> %s', v_room_key, v_from, v_to),
      'db_trigger',
      v_meta
    );
  end loop;

  return null;
end;
$$;

create trigger trg_audit_daily_report_changes
  after update on public.daily_reports
  for each row execute function public.audit_daily_report_changes();

-- ---------------------------------------------------------------------------
-- 8. Deployment marker
--
-- There is intentionally no marker ROW in this table: a synthetic "coverage
-- started" row would be indistinguishable from real activity and would violate
-- the rule that no actor/timestamp is ever fabricated. The coverage start is
-- carried in the table comment above, and the earliest real row provides the
-- effective start of the visible timeline.
-- ---------------------------------------------------------------------------
