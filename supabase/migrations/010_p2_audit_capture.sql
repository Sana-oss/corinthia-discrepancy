-- ============================================================================
-- 010_p2_audit_capture.sql
-- Phase P2 - Room list imports, extra rooms and report lifecycle audit capture.
--
-- Approved plan: docs/p2-audit-plan.md
-- This migration ONLY replaces public.audit_daily_report_changes(). It does not
-- touch migration 009, the audit table, its indexes, RLS policies or the
-- immutability triggers. No backfill, no data change, no second audit table.
--
-- Branch order for one UPDATE:
--   1. room-list import (when list_uploaded_at changed)
--   2. extra-room additions / removals
--   3. report lifecycle transitions
--   4. P1 room-checklist status diffs (suppressed for import writes)
-- ============================================================================

create or replace function public.audit_daily_report_changes()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor           record;
  v_identity_ok     boolean;
  v_is_import       boolean;

  v_old_rooms       jsonb;
  v_new_rooms       jsonb;
  v_old_extras      jsonb;
  v_new_extras      jsonb;

  -- import diff
  v_added           jsonb;
  v_removed         jsonb;
  v_reset           jsonb;
  v_stay            jsonb;
  v_cleared         jsonb;
  v_details         jsonb;
  v_total           integer;
  v_part_count      integer;
  v_part            integer;
  v_operation_id    uuid;
  v_slice           jsonb;
  v_slice_added     jsonb;
  v_slice_removed   jsonb;
  v_slice_reset     jsonb;
  v_slice_stay      jsonb;
  v_slice_cleared   jsonb;
  v_meta            jsonb;
  v_oldvals         jsonb;
  v_newvals         jsonb;
  v_desc            text;

  -- extra rooms
  v_x_room          text;
  v_x_obj           jsonb;

  -- lifecycle
  v_old_status      text;
  v_new_status      text;
  v_action          text;
  v_old_sig         jsonb;
  v_new_sig         jsonb;
  v_sig             jsonb;
  v_signer_email    text;
  v_mismatch        boolean;
  v_lc_meta         jsonb;

  -- P1 room status loop
  v_room_key        text;
  v_new_room        jsonb;
  v_old_room        jsonb;
  v_from            text;
  v_to              text;
  v_p1_action       text;
  v_set_flags       jsonb;
  v_unset_flags     jsonb;
  v_p1_meta         jsonb;
begin
  -- Same trust model as P1: only authenticated end-user UPDATEs are captured.
  if auth.uid() is null then
    return null;
  end if;
  if tg_op <> 'UPDATE' then
    return null;
  end if;
  if new.payload is not distinct from old.payload then
    return null;
  end if;

  select * into v_actor from public.audit_actor();
  v_identity_ok := v_actor.actor_role is not null;
  v_is_import := new.list_uploaded_at is distinct from old.list_uploaded_at;

  v_old_rooms := coalesce(old.payload -> 'rooms', '[]'::jsonb);
  v_new_rooms := coalesce(new.payload -> 'rooms', '[]'::jsonb);
  v_old_extras := coalesce(old.payload -> 'extras', '[]'::jsonb);
  v_new_extras := coalesce(new.payload -> 'extras', '[]'::jsonb);

  -- -------------------------------------------------------------------------
  -- 1. Room-list import: one aggregate row, with bounded continuation parts.
  -- -------------------------------------------------------------------------
  if v_is_import then
    with old_r as (
      select r.value ->> 'room' as room,
             row_number() over (partition by r.value ->> 'room' order by r.ord) as occ,
             r.value as obj,
             coalesce(r.value ->> 'status', 'unconfirmed') as status,
             r.value ->> 'arrival' as arr,
             r.value ->> 'departure' as dep
      from jsonb_array_elements(v_old_rooms) with ordinality as r(value, ord)
      where coalesce(r.value ->> 'room', '') <> ''
    ), new_r as (
      select r.value ->> 'room' as room,
             row_number() over (partition by r.value ->> 'room' order by r.ord) as occ,
             r.value as obj,
             coalesce(r.value ->> 'status', 'unconfirmed') as status,
            r.value ->> 'arrival' as arr,
             r.value ->> 'departure' as dep
      from jsonb_array_elements(v_new_rooms) with ordinality as r(value, ord)
      where coalesce(r.value ->> 'room', '') <> ''
    )
    select
      (select coalesce(jsonb_agg(jsonb_build_object(
         'room', n.room, 'arrival', n.arr, 'departure', n.dep, 'status', n.status) order by n.room, n.occ), '[]'::jsonb)
       from new_r n left join old_r o on o.room = n.room and o.occ = n.occ where o.room is null),
      (select coalesce(jsonb_agg(jsonb_build_object(
         'room', o.room, 'status', o.status, 'arrival', o.arr, 'departure', o.dep) order by o.room, o.occ), '[]'::jsonb)
       from old_r o left join new_r n on n.room = o.room and n.occ = o.occ where n.room is null),
      (select coalesce(jsonb_agg(jsonb_build_object(
         'room', o.room, 'from_status', o.status, 'to_status', n.status) order by o.room, o.occ), '[]'::jsonb)
       from old_r o join new_r n on n.room = o.room and n.occ = o.occ
       where o.status is distinct from n.status),
      (select coalesce(jsonb_agg(jsonb_build_object(
         'room', o.room, 'old_arrival', o.arr, 'new_arrival', n.arr,
         'old_departure', o.dep, 'new_departure', n.dep) order by o.room, o.occ), '[]'::jsonb)
       from old_r o join new_r n on n.room = o.room and n.occ = o.occ
       where o.arr is distinct from n.arr or o.dep is distinct from n.dep)
    into v_added, v_removed, v_reset, v_stay;

    select coalesce(jsonb_agg(jsonb_build_object(
             'key', e.key, 'name', e.value ->> 'name',
             'email', e.value ->> 'email', 'time', e.value ->> 'time') order by e.key), '[]'::jsonb)
    into v_cleared
    from jsonb_each(coalesce(old.payload -> 'confirmations', '{}'::jsonb)) as e(key, value)
    where not (coalesce(new.payload -> 'confirmations', '{}'::jsonb) ? e.key);

    v_details :=
      (select coalesce(jsonb_agg(jsonb_build_object('kind', 'added', 'data', d) order by ord), '[]'::jsonb)
       from jsonb_array_elements(v_added) with ordinality as t(d, ord))
      || (select coalesce(jsonb_agg(jsonb_build_object('kind', 'removed', 'data', d) order by ord), '[]'::jsonb)
          from jsonb_array_elements(v_removed) with ordinality as t(d, ord))
      || (select coalesce(jsonb_agg(jsonb_build_object('kind', 'reset', 'data', d) order by ord), '[]'::jsonb)
          from jsonb_array_elements(v_reset) with ordinality as t(d, ord))
      || (select coalesce(jsonb_agg(jsonb_build_object('kind', 'stay', 'data', d) order by ord), '[]'::jsonb)
          from jsonb_array_elements(v_stay) with ordinality as t(d, ord))
      || (select coalesce(jsonb_agg(jsonb_build_object('kind', 'cleared', 'data', d) order by ord), '[]'::jsonb)
          from jsonb_array_elements(v_cleared) with ordinality as t(d, ord));

    v_total := jsonb_array_length(v_details);

    -- Logical no-op: no room change and no confirmation cleared. Other payload
    -- fields (extras/lifecycle) are handled by their own branches below.
    if v_total > 0 then
      v_operation_id := gen_random_uuid();
      v_part_count := greatest(1, ceil(v_total::numeric / 50.0)::integer);
      for v_part in 1..v_part_count loop
        v_slice := (select coalesce(jsonb_agg(d order by ord), '[]'::jsonb)
                    from jsonb_array_elements(v_details) with ordinality as t(d, ord)
                    where ord > (v_part - 1) * 50 and ord <= v_part * 50);

        v_slice_added := (select coalesce(jsonb_agg(d -> 'data'), '[]'::jsonb)
                          from jsonb_array_elements(v_slice) as d where d ->> 'kind' = 'added');
        v_slice_removed := (select coalesce(jsonb_agg(d -> 'data'), '[]'::jsonb)
                            from jsonb_array_elements(v_slice) as d where d ->> 'kind' = 'removed');
        v_slice_reset := (select coalesce(jsonb_agg(d -> 'data'), '[]'::jsonb)
                          from jsonb_array_elements(v_slice) as d where d ->> 'kind' = 'reset');
        v_slice_stay := (select coalesce(jsonb_agg(d -> 'data'), '[]'::jsonb)
                         from jsonb_array_elements(v_slice) as d where d ->> 'kind' = 'stay');
        v_slice_cleared := (select coalesce(jsonb_agg(d -> 'data'), '[]'::jsonb)
                            from jsonb_array_elements(v_slice) as d where d ->> 'kind' = 'cleared');

        v_meta := jsonb_build_object(
          'report_date', new.report_date,
          'operation_id', v_operation_id,
          'part', v_part,
          'part_count', v_part_count,
          'is_continuation', v_part > 1,
          'added_rooms', v_slice_added,
          'removed_rooms', v_slice_removed,
          'reset_rooms', v_slice_reset,
          'changed_stay_rooms', v_slice_stay,
          'cleared_confirmations', v_slice_cleared
        );

        if v_part = 1 then
          v_meta := v_meta || jsonb_build_object(
            'added_count', jsonb_array_length(v_added),
            'removed_count', jsonb_array_length(v_removed),
            'reset_count', jsonb_array_length(v_reset),
            'changed_stay_count', jsonb_array_length(v_stay),
            'affected_room_count',
              (select count(distinct d -> 'data' ->> 'room')
               from jsonb_array_elements(v_details) as d
               where d ->> 'kind' in ('added', 'removed', 'reset', 'stay'))
          );
          v_oldvals := jsonb_build_object(
            'total_rooms', jsonb_array_length(v_old_rooms),
            'removed', (select coalesce(jsonb_agg(d ->> 'room'), '[]'::jsonb)
                        from jsonb_array_elements(v_removed) as d),
            'reset', (select coalesce(jsonb_agg(d ->> 'room'), '[]'::jsonb)
                      from jsonb_array_elements(v_reset) as d),
            'changed_stay', (select coalesce(jsonb_agg(d ->> 'room'), '[]'::jsonb)
                             from jsonb_array_elements(v_stay) as d)
          );
          v_newvals := jsonb_build_object(
            'total_rooms', jsonb_array_length(v_new_rooms),
            'added', (select coalesce(jsonb_agg(d ->> 'room'), '[]'::jsonb)
                      from jsonb_array_elements(v_added) as d)
          );
          v_desc := format('Room list imported (op %s): +%s added, -%s removed, %s reset, %s stay change',
            left(v_operation_id::text, 8), jsonb_array_length(v_added),
            jsonb_array_length(v_removed), jsonb_array_length(v_reset), jsonb_array_length(v_stay));
        else
          v_oldvals := jsonb_build_object('operation_id', v_operation_id, 'part', v_part, 'is_continuation', true);
          v_newvals := v_oldvals;
          v_desc := format('Room list imported (op %s) — continuation %s/%s',
            left(v_operation_id::text, 8), v_part, v_part_count);
        end if;

        if not v_identity_ok then
          v_meta := v_meta || jsonb_build_object('identity_unresolved', true);
        end if;

        insert into public.system_audit_logs (
          actor_user_id, actor_email, actor_name, actor_role, actor_department,
          department, visibility, module, action_type,
          entity_type, entity_id, entity_label,
          old_values, new_values, description, source, metadata
        ) values (
          v_actor.actor_user_id, v_actor.actor_email, v_actor.actor_name,
          v_actor.actor_role, v_actor.actor_department,
          'fo', 'department', 'setup', 'room_list_imported',
          'daily_report', new.report_date, 'Report ' || new.report_date,
          v_oldvals, v_newvals, v_desc, 'db_trigger', v_meta
        );
      end loop;
    end if;
  end if;

  -- -------------------------------------------------------------------------
  -- 2. Extra rooms: one row per actual occurrence added or removed.
  -- -------------------------------------------------------------------------
  for v_x_room, v_x_obj in
    select n.room, n.obj
    from (
      select r.value ->> 'room' as room,
             row_number() over (partition by r.value ->> 'room' order by r.ord) as occ,
             r.value as obj
      from jsonb_array_elements(v_new_extras) with ordinality as r(value, ord)
      where coalesce(r.value ->> 'room', '') <> ''
    ) n
    where not exists (
      select 1 from (
        select r.value ->> 'room' as room,
               row_number() over (partition by r.value ->> 'room' order by r.ord) as occ
        from jsonb_array_elements(v_old_extras) with ordinality as r(value, ord)
        where coalesce(r.value ->> 'room', '') <> ''
      ) o where o.room = n.room and o.occ = n.occ
    )
  loop
    v_meta := jsonb_build_object('report_date', new.report_date, 'room', v_x_room);
    if not v_identity_ok then
      v_meta := v_meta || jsonb_build_object('identity_unresolved', true);
    end if;
    insert into public.system_audit_logs (
      actor_user_id, actor_email, actor_name, actor_role, actor_department,
      department, visibility, module, action_type,
      entity_type, entity_id, entity_label,
      old_values, new_values, description, source, metadata
    ) values (
      v_actor.actor_user_id, v_actor.actor_email, v_actor.actor_name,
      v_actor.actor_role, v_actor.actor_department,
      'hk', 'department', 'extra_rooms', 'extra_room_added',
      'extra_room', v_x_room, 'Extra room ' || v_x_room,
      null, v_x_obj, format('Extra room %s added', v_x_room), 'db_trigger', v_meta
    );
  end loop;

  for v_x_room, v_x_obj in
    select o.room, o.obj
    from (
      select r.value ->> 'room' as room,
             row_number() over (partition by r.value ->> 'room' order by r.ord) as occ,
             r.value as obj
      from jsonb_array_elements(v_old_extras) with ordinality as r(value, ord)
      where coalesce(r.value ->> 'room', '') <> ''
    ) o
    where not exists (
      select 1 from (
        select r.value ->> 'room' as room,
               row_number() over (partition by r.value ->> 'room' order by r.ord) as occ
        from jsonb_array_elements(v_new_extras) with ordinality as r(value, ord)
        where coalesce(r.value ->> 'room', '') <> ''
      ) n where n.room = o.room and n.occ = o.occ
    )
  loop
    v_meta := jsonb_build_object('report_date', new.report_date, 'room', v_x_room);
    if not v_identity_ok then
      v_meta := v_meta || jsonb_build_object('identity_unresolved', true);
    end if;
    insert into public.system_audit_logs (
      actor_user_id, actor_email, actor_name, actor_role, actor_department,
      department, visibility, module, action_type,
      entity_type, entity_id, entity_label,
      old_values, new_values, description, source, metadata
    ) values (
      v_actor.actor_user_id, v_actor.actor_email, v_actor.actor_name,
      v_actor.actor_role, v_actor.actor_department,
      'hk', 'department', 'extra_rooms', 'extra_room_removed',
      'extra_room', v_x_room, 'Extra room ' || v_x_room,
      v_x_obj, null, format('Extra room %s removed', v_x_room), 'db_trigger', v_meta
    );
  end loop;

  -- -------------------------------------------------------------------------
  -- 3. Report lifecycle: only on a real handoff.status change.
  -- -------------------------------------------------------------------------
  if (old.payload -> 'handoff' ->> 'status') is distinct from (new.payload -> 'handoff' ->> 'status') then
    v_old_status := coalesce(nullif(old.payload -> 'handoff' ->> 'status', ''),
      case when old.payload -> 'confirmations' ? 'frontdesk' then 'signed'
           when old.payload -> 'confirmations' ? 'housekeeping' then 'submitted'
           else 'in_progress' end);
    v_new_status := coalesce(nullif(new.payload -> 'handoff' ->> 'status', ''),
      case when new.payload -> 'confirmations' ? 'frontdesk' then 'signed'
           when new.payload -> 'confirmations' ? 'housekeeping' then 'submitted'
           else 'in_progress' end);

    if v_old_status is distinct from v_new_status then
      v_action := null;
      v_old_sig := null;
      v_new_sig := null;

      if v_old_status = 'in_progress' and v_new_status = 'submitted'
         and new.payload -> 'handoff' -> 'hk_sign' is not null
         and new.payload -> 'confirmations' -> 'housekeeping' is not null then
        v_action := 'report_submitted';
        v_new_sig := new.payload -> 'confirmations' -> 'housekeeping';

      elsif v_old_status = 'submitted' and v_new_status = 'in_progress'
            and new.payload -> 'handoff' -> 'hk_sign' is null
            and not (new.payload -> 'confirmations' ? 'housekeeping') then
        v_action := 'report_recalled';
        v_old_sig := old.payload -> 'confirmations' -> 'housekeeping';

      elsif v_old_status = 'submitted' and v_new_status = 'received'
            and new.payload -> 'handoff' -> 'fd_received' is not null then
        v_action := 'report_received';
        v_new_sig := new.payload -> 'handoff' -> 'fd_received';

      elsif v_old_status = 'received' and v_new_status = 'submitted'
            and new.payload -> 'handoff' -> 'fd_received' is null then
        v_action := 'report_receive_undone';
        v_old_sig := old.payload -> 'handoff' -> 'fd_received';

      elsif v_old_status = 'received' and v_new_status = 'signed'
            and new.payload -> 'confirmations' -> 'frontdesk' is not null
            and old.payload -> 'confirmations' -> 'frontdesk' is null then
        v_action := 'report_signed';
        v_new_sig := new.payload -> 'confirmations' -> 'frontdesk';

      elsif v_old_status = 'signed' and v_new_status in ('received', 'submitted')
            and new.payload -> 'confirmations' -> 'frontdesk' is null
            and ((v_new_status = 'received' and new.payload -> 'handoff' -> 'fd_received' is not null)
                 or (v_new_status = 'submitted' and new.payload -> 'handoff' -> 'fd_received' is null)) then
        v_action := 'report_signature_undone';
        v_old_sig := old.payload -> 'confirmations' -> 'frontdesk';

      else
        v_action := 'report_lifecycle_changed';
      end if;

      v_sig := coalesce(v_new_sig, v_old_sig);
      v_signer_email := case when v_sig is null then null else v_sig ->> 'email' end;
      v_mismatch := v_signer_email is not null
                    and lower(v_signer_email) <> lower(coalesce(v_actor.actor_email, ''));

      v_lc_meta := jsonb_build_object(
        'report_date', new.report_date,
        'from_status', v_old_status,
        'to_status', v_new_status
      );
      if v_action = 'report_lifecycle_changed' then
        v_lc_meta := v_lc_meta || jsonb_build_object('reason', 'unexpected_companion_state');
      end if;
      if v_mismatch then
        v_lc_meta := v_lc_meta || jsonb_build_object('identity_mismatch', true);
      end if;
      if not v_identity_ok then
        v_lc_meta := v_lc_meta || jsonb_build_object('identity_unresolved', true);
      end if;

      insert into public.system_audit_logs (
        actor_user_id, actor_email, actor_name, actor_role, actor_department,
        department, visibility, module, action_type,
        entity_type, entity_id, entity_label,
        old_values, new_values, description, source, metadata
      ) values (
        v_actor.actor_user_id, v_actor.actor_email, v_actor.actor_name,
        v_actor.actor_role, v_actor.actor_department,
        coalesce(v_actor.actor_department, 'hk'), 'shared_report', 'report_lifecycle', v_action,
        'daily_report', new.report_date, 'Report ' || new.report_date,
        jsonb_build_object('status', v_old_status, 'signature',
          case when v_old_sig is null then null else jsonb_build_object(
            'name', v_old_sig ->> 'name', 'email', v_old_sig ->> 'email', 'time', v_old_sig ->> 'time') end),
        jsonb_build_object('status', v_new_status, 'signature',
          case when v_new_sig is null then null else jsonb_build_object(
            'name', v_new_sig ->> 'name', 'email', v_new_sig ->> 'email', 'time', v_new_sig ->> 'time') end),
        format('Report %s -> %s', v_old_status, v_new_status), 'db_trigger', v_lc_meta
      );
    end if;
  end if;

  -- -------------------------------------------------------------------------
  -- 4. P1 room-checklist status diffs (unchanged, except import writes skip it).
  -- -------------------------------------------------------------------------
  if not v_is_import then
    for v_room_key, v_new_room in
      select r ->> 'room', r
      from jsonb_array_elements(v_new_rooms) as r
      where coalesce(r ->> 'room', '') <> ''
    loop
      select r into v_old_room
      from jsonb_array_elements(v_old_rooms) as r
      where r ->> 'room' = v_room_key
      limit 1;

      if v_old_room is null then
        continue;
      end if;

      v_from := coalesce(nullif(btrim(v_old_room ->> 'status'), ''), 'unconfirmed');
      v_to := coalesce(nullif(btrim(v_new_room ->> 'status'), ''), 'unconfirmed');
      if v_from = v_to then
        continue;
      end if;

      if v_to = 'confirmed' then
        v_p1_action := 'room_confirmed';
      elsif v_to = 'noluggage' then
        v_p1_action := 'room_noluggage_on';
      elsif v_to = 'dnd' then
        v_p1_action := 'room_dnd_on';
      elsif v_to = 'unconfirmed' then
        v_p1_action := case v_from
                         when 'noluggage' then 'room_noluggage_off'
                         when 'dnd' then 'room_dnd_off'
                         else 'room_unconfirmed'
                       end;
      else
        v_p1_action := 'room_status_changed';
      end if;

      v_set_flags := case v_to
                       when 'confirmed' then '["confirmed"]'::jsonb
                       when 'noluggage' then '["noluggage"]'::jsonb
                       when 'dnd' then '["dnd"]'::jsonb
                       else '[]'::jsonb
                     end;
      v_unset_flags := case
                         when v_from in ('confirmed', 'noluggage', 'dnd') and v_from <> v_to
                           then jsonb_build_array(v_from)
                         else '[]'::jsonb
                       end;

      v_p1_meta := jsonb_build_object(
        'report_date', new.report_date, 'room', v_room_key,
        'status_from', v_from, 'status_to', v_to,
        'set_flags', v_set_flags, 'unset_flags', v_unset_flags
      );
      if not v_identity_ok then
        v_p1_meta := v_p1_meta || jsonb_build_object('identity_unresolved', true);
      end if;

      insert into public.system_audit_logs (
        actor_user_id, actor_email, actor_name, actor_role, actor_department,
        department, visibility, module, action_type,
        entity_type, entity_id, entity_label,
        old_values, new_values, description, source, metadata
      ) values (
        v_actor.actor_user_id, v_actor.actor_email, v_actor.actor_name,
        v_actor.actor_role, v_actor.actor_department,
        'hk', 'department', 'room_checklist', v_p1_action,
        'room', v_room_key, 'Room ' || v_room_key,
        jsonb_build_object('status', v_from), jsonb_build_object('status', v_to),
        format('Room %s: status %s -> %s', v_room_key, v_from, v_to),
        'db_trigger', v_p1_meta
      );
    end loop;
  end if;

  return null;
end;
$$;

comment on function public.audit_daily_report_changes() is
  'P2 audit capture: room-list import (bounded continuation parts), extra rooms, shared report lifecycle, plus the P1 room-status diff. Appends only to public.system_audit_logs inside the writing transaction.';
