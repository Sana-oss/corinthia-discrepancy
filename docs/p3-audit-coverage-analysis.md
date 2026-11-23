# P3 — Final implementation-ready plan (AWAITING EXPLICIT APPROVAL)

**Planning only.** No application code, migration, production data, permission, or commit was changed for this analysis. P1 (`4c8a77e`), Activity UI (`faa1e98`) and P2 (`71f98d9e572fe84d044a21be795ead005065f28f`) remain unchanged. `docs/offline-event-queue-plan.md` remains untouched and uncommitted.

All owner decisions from the latest review are incorporated below. Verified repository findings are labelled **VERIFIED**; proposals are labelled **RECOMMENDED**.

---

## 1. Executive summary

**VERIFIED:** the app has three public tables (`daily_reports`, `staff`, `system_audit_logs`) and two Edge Functions (`create-staff`, `change-password`). P1/P2 fully cover all `daily_reports.payload` mutations. Staff administration and every password operation are completely unaudited. The first write of a new report date is an `INSERT`, while the audit trigger is `AFTER UPDATE` only, so it emits no event.

**VERIFIED (new inspection):** `authenticated` and even `anon` have table-level `DELETE`/`TRUNCATE` grants on `public.staff`, and the RLS policy `manager write own dept` is `FOR ALL`, so a department manager can delete another staff row through the API today even though the UI has no Delete button. There are **no foreign keys referencing `public.staff`**; deleting a staff row therefore succeeds referentially but destroys the target of historical attribution. `public.daily_reports.updated_by` has a FK to `auth.users(id)` with `ON DELETE NO ACTION`, so deleting an auth user that is referenced by a report write is blocked unless that stamp is cleared first.

**RECOMMENDED:** implement exactly two batches:
- **Batch A (Critical):** staff administration + password accountability, with staff deletion blocked for normal roles.
- **Batch B (High):** a single `report_created` event on the first `INSERT` of a new report date.

Exclude auth session logging, export/print, offline local writes, platform-admin actions, and modules that do not exist.

---

## 2. Complete application module inventory (**VERIFIED**)

| Module | What it does | Persistence | Audit today |
|---|---|---|---|
| Login / session | `auth.signInWithPassword`, `signOut` | GoTrue session | No `system_audit_logs` event |
| Header → Change password | `change-password` Edge Function; verifies current password, writes new one with service role | `auth.users` | **Not audited** |
| Header → offline badge / outbox | IndexedDB `outbox` + `cache` | Local device only | Not appropriate (separate phase) |
| Setup (FD) | PDF/paste parse; `saveListBtn` replaces room list, stamps `list_uploaded_at` | `daily_reports` | P2 `room_list_imported` |
| Checklist (HK) | confirm/unconfirm, no-luggage, DND, cross-state | `daily_reports.payload.rooms` | P1 `room_*` |
| Extra (HK) | add/remove unlisted occupied rooms | `daily_reports.payload.extras` | P2 `extra_room_added/removed` |
| Summary | counts, copy/print, handoff submit/recall/receive/undo/sign/unsign | `daily_reports.payload.handoff` | P2 six lifecycle events; copy/print non-persistent |
| History → Reports | browse/print past days | read-only | Not appropriate |
| History → Activity | filter/search/detail over audit log | read-only | The audit viewer |
| Staff (managers/GM) | list; add; edit name/role/active/password; deactivate/reactivate | `staff` + `auth.users` via Edge Function | **Not audited** |
| Realtime / live reload | Supabase Realtime subscription | no business write | Not appropriate |

**VERIFIED absent:** bookings, reservations, guest records, assignments, extra services with cost/quantity/status, discrepancy tickets, resolution/closure, reassignment, reopening, approvals/rejections, supervisor-assignment field, staff-delete UI, admin settings.

---

## 3–5. Full Audit Coverage Matrix / missing operations

| Module / operation | Actor roles | Persistence | Coverage | Event | Missing info | Priority | Recommendation |
|---|---|---|---|---|---|---|---|
| Room status confirm/unconfirm, no-luggage, DND, cross-state | hk_staff/supervisor/manager | `daily_reports` | **Fully (P1)** | `room_*` | none | — | no change |
| Changed room-list import; identical re-upload | fo_staff/supervisor/manager | `daily_reports` | **Fully / correctly silent (P2)** | `room_list_imported` | none | — | no change |
| Extra room add/remove | hk_staff/supervisor/manager | `daily_reports` | **Fully (P2)** | `extra_room_added/removed` | none | — | no change |
| Six handoff transitions incl. reversals | HK/FD supervisor+manager | `daily_reports` | **Fully (P2)** | `report_lifecycle` actions | none | — | no change |
| **First write of a new report date (INSERT)** | any authenticated role | `daily_reports` INSERT | **Not covered** | none | creator, time, report date, initial counts/source | **High** | `report_created` (Batch B) |
| **Staff create (profile + login)** | hk_manager, fo_manager, gm_admin | `staff` + auth via Edge Function | **Not covered** | none | created name/role/dept, login flag, actor | **Critical** | one `staff_created` (Batch A) |
| **Staff edit name/role** | managers, GM | `staff` | **Not covered** | none | old/new name/role | **Critical** | `staff_updated` |
| **Deactivate / reactivate** | managers, GM | `staff.active` | **Not covered** | none | old/new active | **Critical** | `staff_active_changed` |
| **Permanent staff delete (no UI; API/SQL possible)** | managers/GM via RLS; privileged DB role | `staff` DELETE | **Not covered** | none | deleted identity | **Critical** | block for app roles; `staff_deleted` for exceptional admin |
| **Manager password reset** | managers, GM | `auth.users` via Edge Function | **Not covered** | none | actor, target, time; no secret | **Critical** | `staff_password_reset` |
| **Self password change** | any employee | `auth.users` via Edge Function | **Not covered** | none | actor, time; no secret | **Critical** | `staff_password_changed_self` |
| Sign-in/out, failed login | any | GoTrue | Not appropriate | none | platform logs only | Low | exclude |
| Offline outbox/cache writes | any offline user | IndexedDB | Not appropriate | none | — | — | separate phase |
| Tab switch, filter, search, PDF parse, copy, print | any | none | Not appropriate | none | — | Low | exclude |
| Direct dashboard/SQL edits | postgres/service role | DB | Partial | none | unverifiable actor | Medium | document limitation; never fabricate actor |

Full matrix per role/security/notes is retained in the earlier accepted analysis; the table above is the implementation-ready subset.

---

## 6. Critical security/accountability gaps (**VERIFIED** reason)

- Role/active changes and password operations have no detective control.
- Managers can currently DELETE staff via direct API because `authenticated` has a `DELETE` grant and the write policy is `FOR ALL`. Hiding a UI button is not protection.
- No FK references `staff`, so a deletion succeeds but destroys the entity that historical audit rows describe.
- The first action of each day is untraceable because the audit trigger never sees the `INSERT`.

---

## 7. Final event names, actor attribution, trigger vs Edge Function, duplicate prevention

### 7.1 Event catalogue

| Event | Produced by | Actor source | Old/new values | Visibility |
|---|---|---|---|---|
| `staff_created` | DB trigger for authenticated/direct inserts; **Edge Function for manager create path** | DB: `auth.uid()` + `audit_actor()`; EF: verified caller JWT via `auth.getUser()` + staff row | `new_values`: full_name, role, active; `old_values: null` | `staff_admin` |
| `staff_updated` | DB trigger | `auth.uid()` + `audit_actor()` | changed fields only (full_name, role, active) | `staff_admin` |
| `staff_active_changed` | DB trigger | same | `{active: old}` → `{active: new}` when active is the only changed field | `staff_admin` |
| `staff_deleted` | DB trigger (including exceptional service-role DELETE) | authenticated: JWT; service role: null + `identity_unresolved=true` | `old_values`: last known full_name, role, active; `new_values: null` | `staff_admin` |
| `staff_password_reset` | `create-staff` Edge Function after successful GoTrue update | verified caller JWT only; target from body email after dept/staff checks | none (no secret) | `staff_admin` |
| `staff_password_changed_self` | `change-password` Edge Function after successful update | verified caller JWT only; body has no identity | none (no secret) | `staff_admin` |
| `report_created` | DB trigger on `INSERT` | `auth.uid()` + `audit_actor()` | concise initial-state summary (§8) | `shared_report` |

### 7.2 Trigger vs Edge Function responsibilities (**RECOMMENDED**)

- **DB triggers** own all writes to `public.staff` and `public.daily_reports`, because they are atomic with the business write and cannot be bypassed by direct API calls.
- **Edge Functions** own only events whose underlying write happens in `auth.users` (GoTrue) and therefore cannot be captured by a `public` table trigger. They receive the caller JWT, verify it with `auth.getUser()`, and insert the audit row using the service role (INSERT is granted; immutability triggers still block UPDATE/DELETE).
- The `staff` trigger **skips INSERT/UPDATE when `current_user = 'service_role'`** to prevent duplicate `staff_created` events for the `create-staff` path. The Edge Function emits the single logical `staff_created` event for that path. Direct authenticated inserts (fallback when the function is not deployed, or ALREADY_EXISTS fallback) are captured by the trigger.
- The `staff` trigger **does not skip DELETE**, so an exceptional privileged deletion is still recorded (with unverifiable actor flagged).

### 7.3 Duplicate-prevention rules (**RECOMMENDED**)

1. Manager create via `create-staff`: Edge Function emits `staff_created`; trigger suppresses service-role INSERT. Exactly one event.
2. Direct/authenticated staff INSERT: trigger emits `staff_created`; Edge Function not involved.
3. `report_created` is emitted only on `INSERT`; the diff branches run only on `UPDATE`. A later UPDATE emits normal P1/P2 events, never a second `report_created`.
4. No-op `staff` UPDATE (OLD not distinct from NEW) emits zero rows.
5. Failed/rolled-back writes emit zero rows (trigger inserts are inside the transaction; Edge Function inserts occur only after confirmed success).
6. If a single `staff` UPDATE changes both `active` and name/role, emit **one** `staff_updated` row containing all changed fields; use `staff_active_changed` only when `active` is the sole change.

### 7.4 Actor verification (**RECOMMENDED**)

- Never read actor identity from the request body. `create-staff` request body may contain target email/password; `change-password` body contains only passwords.
- If `auth.getUser()` fails → 401, no business write, no audit event.
- If the verified JWT is valid but has no active `staff` row, set `actor_user_id`/`actor_email` from the JWT, leave `actor_role`/`actor_department` null, and set `metadata.identity_unresolved=true`. **Never substitute the target employee's identity.**
- Service-role trigger DELETE: all actor fields null, `identity_unresolved=true`.

---

## 8. Exact payload examples and initial room-list representation

```json
// report_created — first INSERT of a new report date
{
  "module": "daily_report",
  "action_type": "report_created",
  "entity_type": "daily_report",
  "entity_id": "2026-11-24",
  "entity_label": "Report 2026-11-24",
  "department": "hk",
  "visibility": "shared_report",
  "old_values": null,
  "new_values": {
    "rooms_count": 98,
    "status_counts": {"unconfirmed": 98, "confirmed": 0, "noluggage": 0, "dnd": 0},
    "extras_count": 0,
    "creation_source": "room_list_import"
  },
  "metadata": {
    "report_date": "2026-11-24",
    "initial_room_numbers_hash": "md5-of-canonical-sorted-room-list",
    "initial_room_numbers_sample": ["1069", "1091", "1092"],
    "initial_room_numbers_truncated": true,
    "source_hint": "list_uploaded_at was stamped on this INSERT"
  }
}
```

**RECOMMENDED initial-room-list rule:** do **not** copy the full payload. Store `rooms_count`, `status_counts`, `extras_count`, a canonical MD5 hash of the sorted room-number list (proves exactly which list was created), and a bounded sample of room numbers (first 25) with a truncation flag. `creation_source` is derived deterministically: `room_list_import` if `list_uploaded_at` is set, else `first_checklist_action` if any status is non-unconfirmed, else `extras_first` if extras exist, else `new_day`. This keeps the creation accountable without duplicating the report body and without emitting P1/P2 events on INSERT.

```json
// staff_created — manager path (single logical event from create-staff)
{
  "module": "staff", "action_type": "staff_created",
  "entity_type": "staff", "entity_id": "hk.new@corinthia-tripoli.com",
  "entity_label": "New HK Staff",
  "department": "hk", "visibility": "staff_admin",
  "old_values": null,
  "new_values": {"full_name": "New HK Staff", "role": "hk_staff", "active": true},
  "metadata": {"login_created": true, "target_department": "hk", "report_date": null}
}
```

```json
// staff_updated — role change
{
  "module": "staff", "action_type": "staff_updated",
  "entity_type": "staff", "entity_id": "hk.example@corinthia-tripoli.com",
  "department": "hk", "visibility": "staff_admin",
  "old_values": {"role": "hk_staff"},
  "new_values": {"role": "hk_supervisor"}
}
```

```json
// staff_active_changed
{
  "module": "staff", "action_type": "staff_active_changed",
  "entity_type": "staff", "entity_id": "hk.example@corinthia-tripoli.com",
  "department": "hk", "visibility": "staff_admin",
  "old_values": {"active": true}, "new_values": {"active": false}
}
```

```json
// staff_password_reset / staff_password_changed_self (no credential material)
{
  "module": "staff", "action_type": "staff_password_reset",
  "entity_type": "staff", "entity_id": "fo.example@corinthia-tripoli.com",
  "department": "fo", "visibility": "staff_admin",
  "old_values": null, "new_values": null,
  "metadata": {"target_email": "fo.example@corinthia-tripoli.com", "password_material_logged": false}
}
```

No event stores passwords, hashes, tokens, request bodies, or secrets.

---

## 9. Password-event reliability and failure handling (**RECOMMENDED**)

GoTrue writes cannot share a transaction with an audit insert. Therefore:

1. Perform the password write only after existing security checks pass.
2. Immediately insert the audit row via the Edge Function's service-role client with explicit actor fields derived from the verified JWT.
3. Check the database response. Retry transient failures up to **3 attempts** with short backoff.
4. **Only if the database confirms the insert**, return `audit_recorded: true`. If all attempts fail, return HTTP 200 for the password operation but `audit_recorded: false` with a clear error string; the UI must show "Password changed, but the audit record could not be saved — contact IT." Never claim the event was recorded.
5. Emit a server-side monitoring log/alert for every failed audit insert. Monitoring query can also alert on unusual gaps in `staff_password_reset` / `staff_password_changed_self` events, but there is no second audit table.
6. Never re-attribute a failed/unverifiable actor event to the target employee; leave actor fields null/flagged.

Frontend files requiring a small additive change: the password modal handler and the Staff form hint, to display the `audit_recorded: false` warning. No behaviour change when `audit_recorded: true`.

---

## 10. Staff deletion / deactivation enforcement (**RECOMMENDED**)

**VERIFIED:** `authenticated` and `anon` have table-level `DELETE` and `TRUNCATE` grants on `public.staff`; the `manager write own dept` policy is `FOR ALL` (so includes DELETE). No table has an FK to `public.staff`.

Controls to implement in migration 011:

1. `revoke delete, truncate on public.staff from anon, authenticated;` (service_role keeps DELETE only for exceptional privileged operations).
2. Replace `manager write own dept` (`FOR ALL`) with separate `manager insert own dept` and `manager update own dept` policies, preserving the existing department prefix checks and the `email <> auth.jwt()->>'email'` self-demotion guard.
3. Keep SELECT policies unchanged.
4. UI already has no Delete control; deactivation via `sbSetStaffActive()` is the only application workflow.
5. Add `staff_deleted` AFTER DELETE trigger for exceptional service-role deletions. Actor cannot be verified for service role, so the row is flagged `identity_unresolved=true`; this is the documented limitation.
6. Document operational procedure: exceptional deletion requires a privileged DB session, must be accompanied by an incident record outside the app, and cannot be attributed to a named employee by the audit system.

---

## 11. Final RLS visibility matrix (**RECOMMENDED**)

| Event visibility | GM Admin | HK Manager | FD Manager | HK/FD Supervisor | Ordinary staff |
|---|---|---|---|---|---|
| `department` (P1/P2 normal events) | all | own dept | own dept | own dept | own rows only |
| `shared_report` (P2 lifecycle, new `report_created`) | all | all shared | all shared | **no** (supervisor has no shared access) | own rows only |
| `staff_admin` (all staff/password events except self) | all | HK only | FD only | **none** | **none** |
| `staff_password_changed_self` (actor-self) | all | own-dept + own row | own-dept + own row | own row only via actor-self | **own row only** |

**Important implementation detail:** the current `audit read scoped` policy lets any supervisor see every row whose `department` equals their own, regardless of `visibility`. Adding `staff_admin` rows with `department='hk'/'fo'` would therefore leak them to supervisors unless the policy is tightened. Migration 011 must recreate the policy so that:
- manager: `(visibility='department' and department=viewer_department) OR visibility='shared_report' OR (visibility='staff_admin' and department=viewer_department)`
- supervisor: only `visibility='department' and department=viewer_department`
- GM: all
- actor-self: always own rows

This preserves all P1/P2 visibility exactly while excluding supervisors and other departments from staff-admin events.

---

## 12. Exact migration responsibilities

### `011_p3_staff_audit.sql`
- Alter `system_audit_logs` visibility constraint to allow `'staff_admin'` (keep existing values).
- Drop/recreate `audit read scoped` with the tightened expression in §11.
- `revoke delete, truncate on public.staff from anon, authenticated`.
- Drop `manager write own dept` FOR ALL; add INSERT-only and UPDATE-only policies with the same dept/self guards. Keep SELECT policies.
- Create `audit_staff_changes()` AFTER INSERT OR UPDATE OR DELETE on `public.staff`, `SECURITY DEFINER`, fixed `search_path`, skipping service-role INSERT/UPDATE but never DELETE.
- No new table, no new column, no change to immutability triggers or `audit_actor()`.

### `012_p3_report_creation.sql`
- `CREATE OR REPLACE FUNCTION public.audit_daily_report_changes()` adding an `AFTER INSERT` branch that emits exactly one `report_created` row (§8) and returning before the existing UPDATE logic.
- Keep the existing UPDATE trust guards and P1/P2 branches unchanged.
- No table, RLS, policy, trigger, or column changes.

Do not edit migrations 001–010. Apply dry-run first, then `supabase db push --linked`.

---

## 13. Rollback considerations (**RECOMMENDED**)

- Migrations are forward-only. Rollback = new migrations that restore prior policy/function definitions; existing audit rows are never deleted (append-only evidence).
- Keep `'staff_admin'` in the visibility constraint even if rolling back write triggers, otherwise historical staff-admin rows become unreadable. Roll back only the staff trigger and policy additions; do not remove the visibility value.
- Rolling back 012 restores the previous function definition; `report_created` rows already written remain historical records.
- Do **not** re-grant DELETE/TRUNCATE to `authenticated` during rollback — that would restore a verified security gap. If an emergency requires it, it must be an explicit, separately approved action.
- No data backfill or actor fabrication in any rollback.

---

## 14. Test cases and required evidence

| Area | Test case | Expected evidence |
|---|---|---|
| Six role categories | GM / HK mgr / FD mgr / HK sup / FD sup / HK staff / FO staff / self | RLS count tables: GM all; HK mgr HK-only staff_admin; FD mgr FD-only; supervisors 0 staff_admin; staff only own self event |
| Staff create | Manager creates hk_staff via UI (Edge Function path) | exactly 1 `staff_created`; actor = manager JWT; no duplicate trigger event; new_values name/role/active; `login_created:true` |
| Staff create fallback | create-staff unavailable → direct staff insert | exactly 1 `staff_created` from trigger; `login_created` unknown/false |
| Staff update | Role and full-name change; active-only change | `staff_updated` with changed fields; `staff_active_changed` only when active sole change; no-op update = 0 rows |
| Staff deletion | Direct DELETE as authenticated | blocked (permission denied), 0 audit rows |
| Exceptional deletion | DELETE as service role in rolled-back transaction | exactly 1 `staff_deleted`, actor null, `identity_unresolved=true` |
| Password reset | Manager resets own-dept target; cross-dept attempt | success → 1 `staff_password_reset`, no secret; cross-dept → 403, 0 rows |
| Self password | Employee changes own password; wrong current password | success → 1 `staff_password_changed_self`; failure → 0 rows |
| Audit reliability | Simulate audit insert failure after GoTrue success | response has `audit_recorded:false`; no false success claim; monitoring log emitted; retry count 3 |
| Report creation | First INSERT with list / with room status / with extras / empty | exactly 1 `report_created`; source hint correct; counts/hash present; no P1/P2 events on INSERT |
| Non-duplication | INSERT then UPDATE same day | 1 `report_created` + normal P1/P2 update events only |
| No-op/failed | identical payload; rolled-back write | 0 audit rows |
| Immutability | UPDATE/DELETE/TRUNCATE audit rows | blocked for API and service role |
| Regression | all P1/P2/Activity suites + real-browser Setup, Checklist, Extra, Summary, History, Staff, password | all suites green; prior event counts unchanged |

Before each batch is considered complete: pass/fail counts for every suite, SQL probe output with exact action sequences, RLS matrices, edge-function responses showing `audit_recorded`, browser evidence, and cleanup verification (`audit_rows = 0`, temp accounts removed, report restored).

---

## 15. Recommended implementation order

1. **Batch A — Staff and password accountability (Critical)**, including deletion hardening and the tightened RLS policy.
2. **Batch B — `report_created` on first INSERT (High)**.
3. **Stop.** No auth session logging, no export logging, no invented modules, no Offline Event Queue.

**Awaiting explicit approval. No implementation has begun.**
