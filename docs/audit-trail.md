# Audit Trail — Phase P1 (Room Checklist)

Owner requirement: a centralized, immutable, verifiable record of WHO / WHAT / WHERE / WHICH record / WHEN / old → new / persisted? for the Corinthia Discrepancy Report app.

This document records the design decided with the owner, what is actually live, the verification evidence, and what remains open. No UI, P2, or P3 work has been started.

---

## 1. Coverage start

- Migration `009_system_audit_logs.sql` was applied to the linked project `fylgfgwdrxjsarjahiaj` on **2026-11-23**.
- The table comment is the coverage marker. **There is no synthetic "coverage started" row** — a fabricated actor/timestamp would be indistinguishable from real activity.
- Activity before that date was **not** backfilled. The earliest real row will be the effective start of the visible timeline when the Activity UI is built.
- `occurred_at` is the database clock at capture time. Offline-replayed actions (current design) carry replay time; an original client time is **not** currently stored, so no claim of original-action timing is made. (The `occurred_at` column comment anticipates a future `metadata.client_occurred_at` field; it is **not** populated in P1.)

---

## 2. What is live

### 2.1 Centralized table

`public.system_audit_logs` (one table — no parallel per-module logs):

| Field | Meaning |
|---|---|
| `id` | `bigint generated always as identity` — stable event key |
| `occurred_at` | `timestamptz default now()` — DB clock |
| `actor_user_id`, `actor_email` | From `auth.uid()` / verified JWT — never browser-supplied |
| `actor_name`, `actor_role`, `actor_department` | Snapshot of `public.staff` at event time; historical identity survives later staff edits |
| `department`, `visibility` | Event scope (`hk` / `fo`, or `all`) and read rule (`department` / `shared_report`) |
| `module`, `action_type` | Logical module and transition name |
| `entity_type`, `entity_id`, `entity_label` | Which record (e.g. `room` / `9999` / `Room 9999`) |
| `old_values`, `new_values` | **Changed fields only**, as actually persisted |
| `description`, `source`, `metadata` | Human-readable line, `db_trigger`, and structured detail |

Indexes support the approved filters: time, actor, email, department, module+action, entity, and `metadata->>report_date`.

### 2.2 Actor and identity

- `audit_actor()` resolves the actor from `auth.uid()` + `auth.jwt()->>'email'`, joins `auth.users` and `public.staff` (email, case-insensitive), and snapshots name / role / department.
- `daily_reports.updated_by` is stamped by `trg_stamp_daily_report_actor` from `auth.uid()` on INSERT/UPDATE. The browser never sends this field (`grep updated_by discrepancy-report.html` → no matches).
- Service-role and SQL writes have no `auth.uid()`, so they emit **no** trigger row. That is deliberate: those paths must log their own verified caller when P2/P3 edge functions are added.
- If JWT identity does not resolve to a staff row, the row is still captured (never dropped) and `metadata.identity_unresolved = true` is set.

### 2.3 Immutability and RLS

- `authenticated`: `SELECT` only. `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE` privileges are **revoked**.
- `service_role` has table grants by default, but three row/statement triggers reject `UPDATE`, `DELETE`, and `TRUNCATE` unless `current_user` is `postgres` / `supabase_admin`.
- One read policy, `audit read scoped`:
  - actor sees their own rows (`actor_user_id = auth.uid()`)
  - `gm_admin`: all rows
  - managers: own department scope **plus** cross-department `shared_report` events
  - supervisors: own department scope only
  - other staff: own rows only

### 2.4 Room Checklist transitions (the only audited module in P1)

The app stores one mutually exclusive `status` per room. The trigger diffs persisted OLD/NEW payloads, so the overwritten state is preserved.

| Persisted transition | `action_type` | Notes |
|---|---|---|
| any → `confirmed` | `room_confirmed` | `set_flags: ["confirmed"]` |
| `confirmed` → `unconfirmed` | `room_unconfirmed` | `unset_flags: ["confirmed"]` |
| any → `noluggage` | `room_noluggage_on` | `set_flags: ["noluggage"]` |
| `noluggage` → `unconfirmed` | `room_noluggage_off` | `unset_flags: ["noluggage"]` |
| any → `dnd` | `room_dnd_on` | `set_flags: ["dnd"]` |
| `dnd` → `unconfirmed` | `room_dnd_off` | `unset_flags: ["dnd"]` |
| → unexpected value | `room_status_changed` | real persisted change is never silently dropped |

Cross-state replacements (e.g. `confirmed → dnd`, `noluggage → confirmed`) produce **one** row named for the state switched ON, with the cleared state in `metadata.unset_flags`. ON and OFF transitions are never merged into a single ambiguous event.

Every row carries `status_from`, `status_to`, `report_date`, `room`, and an entity-scoped `old_values` / `new_values` of `{status}`.

Zero rows are emitted for:
- identical payloads (no-op saves)
- failed / rolled-back writes (trigger insert is in the same transaction)
- list imports (`list_uploaded_at` changed — that is a P2 event, not checklist activity)
- room additions/removals (P2)
- INSERTs (no baseline rows for pre-existing days)

---

## 3. Verification evidence

All live probes used real staff identities from `public.staff`, ran as `authenticated` with simulated JWT claims, and were **rolled back** — no test rows remain (final check: `audit_rows_total = 0`, `synthetic_reports = 0`).

| Check | Result |
|---|---|
| 8-step scenario on synthetic room 9999 (confirm/unconfirm/noluggage on+off/dnd on+off/cross-state) | 8 rows, exact action sequence, `from`/`to` correct |
| Cross-state `confirmed → dnd` | `room_dnd_on`, `unset_flags: ["confirmed"]` (one row) |
| Three identical no-op saves (room 9998) | **0** rows |
| List import with status change (room 9997) | **0** rows |
| Actor snapshot | `uid e2ac…e9`, `hk-manager2@corinthia-tripoli.com`, `New Housekeeping Manager`, `hk_manager`, `hk`; `source: db_trigger`; `identity_unresolved: 0` |
| `updated_by` stamped | equals the actor uid |
| RLS — `hk_manager2` | 2 visible (own room event + shared report) |
| RLS — `fo_manager2` | 1 visible (shared report only; **0** HK room-checklist rows) |
| RLS — `gm_admin` | 2 visible (all) |
| `authenticated` INSERT / UPDATE / DELETE on audit table | denied (`42501`, privilege layer) |
| `service_role` UPDATE / DELETE on audit table | denied by trigger (`system_audit_logs is append-only … role service_role`) |
| Grants | `authenticated`: select=true, insert/update/delete=false; `anon`: select=false |
| Migration state | `009` recorded in `supabase_migrations.schema_migrations`; RLS enabled; 3 immutability triggers; 1 policy |
| Static tests | `node tests/audit-tests.js` → 16/16 passed |
| Regression tests | dnd 12/12, departmental-staff 24/24, password-change 17/17 |

Reproduce the live scenario with the transaction pattern used during verification:

```sql
begin;
select set_config('request.jwt.claims','{"sub":"<uid>","email":"<staff email>","role":"authenticated"}',true);
set local role authenticated;
-- insert synthetic daily_reports row, then UPDATE its room status
select * from public.system_audit_logs where entity_id='<room>';
rollback;
```

---

## 3b. Owner-required verification (post-approval)

Six **temporary** employees were created in `auth.users` + `public.staff` (`hk_staff`, `hk_supervisor`, `fo_staff`, `hk_manager`, `fo_manager`, `gm_admin`, all with `@corinthia-tripoli.com` addresses and a test-only password). They were used only for the checks below and then deleted together with their identities/sessions and all test audit rows. Final state: `audit_rows = 0`, `temp_staff = 0`, `temp_users = 0`, backup table dropped, and today's report restored byte-for-byte from a pre-test snapshot (97 rooms; status counts confirmed 3 / no-luggage 4 / DND 3 / unconfirmed 87).

### A. Staff and supervisor RLS (real identities, simulated JWT)

| Viewer | Visible rows | Expected | Result |
|---|---|---|---|
| HK staff (temp) | 13 — only their own UI actions | own only | pass |
| HK supervisor (temp) | 15 — all HK department rows, including another HK employee's row | own department only | pass |
| HK manager (temp) | 16 — 15 HK + 1 shared report | own department + shared | pass |
| FD staff (temp) | 1 — only their own FO row | own only | pass |
| FD manager (temp) | 3 — 2 FO + 1 shared | own department + shared | pass |
| GM (temp) | 18 — every row | all | pass |

Cross-department rows with `visibility='department'` were invisible to the other department's manager and supervisor at every step.

### B. Real UI end-to-end (deployed app, multiple authenticated employees)

Signed into `https://corinthia-discrepancy.vercel.app/discrepancy-report.html` with the temporary **HK staff** and **HK supervisor** accounts. A synthetic room `AUDIT1` was added to the persisted day by the database owner (no audit row emitted), then all changes were made by clicking the actual Checklist controls. Each click was followed by a database check that exactly one new row appeared with the expected action and identity.

| Operation (room AUDIT1) | Audited transition | Actor | Rows |
|---|---|---|---|
| Occupied confirmation | unconfirmed → confirmed | HK staff | 1 |
| No Luggage on / off (two routes) | confirmed → noluggage; noluggage → unconfirmed | HK staff | 1 each |
| DND on / off / on | unconfirmed → dnd → unconfirmed → dnd | HK staff | 1 each |
| Cross-state: DND → confirmed via tick | dnd → confirmed, `unset_flags: ["dnd"]` | HK staff | 1 |
| Cross-state: confirmed → No Luggage | confirmed → noluggage, `unset_flags: ["confirmed"]` | HK staff | 1 |
| Cross-state: No Luggage → DND | noluggage → dnd, `unset_flags: ["noluggage"]` | HK supervisor | 1 |

14 rows were produced by 14 registered clicks — never zero, never two — with `actor_email`, `actor_name`, `actor_role` and `actor_user_id` matching the signed-in employee on every row. (The first automated pass used fixed delays and one click did not register; the pass was repeated with per-action database confirmation rather than assuming a click had succeeded. No duplicate or misattributed row was observed.)

### C. Departmental visibility of the shared workflow

With `visibility='shared_report'` provisioned in the schema, both the HK manager and the FD manager saw the shared lifecycle event, while neither saw the other department's `department`-scoped events (`fo_department = 0` for the HK manager; `hk_department = 0` for the FD manager). Supervisors remained confined to their own department and did not receive shared events. This confirms managers can follow the cross-department handoff without unrestricted access to unrelated departmental activity.

---

## 3c. Activity UI verification (separate milestone)

`docs/activity-ui.md` records the delivered UI. It reads only `system_audit_logs`; no separate audit store exists. Row visibility is enforced by the RLS policy from P1 — the frontend filters only narrow the already-authorized result set.

Verified in the deployed app code path (local build of the same HTML, real Supabase auth) with six temporary employees and real Room Checklist events on a synthetic room:

| Viewer | Events visible | Expected |
|---|---|---|
| HK staff | 3 — own actions only; Reports segment hidden | own only |
| FD staff | 1 — own action only; Reports segment hidden | own only |
| HK supervisor | 4 — all HK rows incl. another employee, no shared/FD | own department, read-only |
| HK manager | 5 — 4 HK + 1 shared handoff, no FD department row | own dept + shared |
| FD manager | 2 — 1 FD + 1 shared handoff, no HK rows | own dept + shared |
| GM | 6 — all rows | all |

Also verified: per-event detail (actor snapshot, role, department, action, record, old→new, `unset_flags`, module, source, server timestamp with "not recorded" original time), room/record search respecting RLS, coverage banner, staff-only notice, existing Reports tab still available to supervisors/managers, Summary still read-only for staff, and the change-password modal still works. All temporary accounts/rows were removed and the day restored (97 rooms, test room absent, `audit_rows = 0`).

---

## 3d. P2 verification (separate milestone)

Migration `010_p2_audit_capture.sql` extends the **same** `audit_daily_report_changes()` trigger (009 is untouched). It adds `room_list_imported`, `extra_room_added`, `extra_room_removed` and the six shared lifecycle actions. No new table, no RLS/grant change, no backfill.

| Check | Result |
|---|---|
| Combined import (add 1, remove 2, reset 1, stay-change 1, clear 1 confirmation, add 1 extra) | exactly 2 rows: one import with full detail arrays/counts, one extra add; zero per-room status rows |
| Aggregate arrays | `added/removed/reset/changed_stay` lists hold real room IDs and before/after values; `affected_room_count = 4` (union) |
| Identical re-upload (only `list_uploaded_at` changes) | **0** new rows |
| Large import (60 rooms reset + 60 stay changes) | 3 bounded continuation parts, one `operation_id`, counts only on part 1, 50 entries max per row, 120 total details, no loss |
| Extras add (2) / remove (1) / no-op | exactly 3 rows, correct entities; no-op emitted 0 |
| Lifecycle chain + reversals | `submitted → received → signed → signature_undone → receive_undone → recalled` — 6 rows, 0 fallbacks, correct actors and `shared_report` visibility |
| Failed write (update then forced rollback) | 0 rows persisted; synthetic reports also rolled back |
| RLS — six temporary accounts | HK staff 1 own; HK supervisor 3 (own dept); HK manager 5 (HK dept + 3 shared); FD staff 1 own; FD manager 4 (FD dept + 3 shared); GM 6. HK manager saw **0** FD department rows; FD manager saw **0** HK department rows |
| Browser regression | Checklist status clicks, extra add/remove, FD list import (2 continuation parts), HK submit, FD receive + confirm, History Reports, Activity, staff self-only view, manager Staff tab, password modal — all behaved as before |
| Cleanup | temp accounts/rows and synthetic reports removed; day restored to 97 rooms with original status counts; `audit_rows = 0`; backup tables dropped |

Note: migration 010 was applied, then a live probe revealed that aggregate `old_values`/`new_values` room-ID arrays used the wrong JSON path. The uncommitted migration was corrected in place and the function definition re-applied before any P2 commit; all affected probes were rolled back, so no incorrect audit row was ever persisted.

---

## 4. Implementation status (final-report basis)

| Requirement | Status | Evidence |
|---|---|---|
| Centralized audit table, immutable, RLS | **Implemented** | migration 009; live grants/RLS/trigger probes above |
| Actor from verified auth + snapshot, no fabrication | **Implemented** | `audit_actor()`, `updated_by` stamp; snapshot probe |
| DB-authoritative successful-write capture | **Implemented** | AFTER UPDATE trigger; no-op/import/rollback probes |
| One row per changed entity/transition, no retries duplicates | **Implemented (P1 path)** | diff on persisted payload; immutable identity key; 8/8, 0/0 counts |
| Room Checklist transitions incl. cross-state, ON/OFF separate | **Implemented** | action table above; 8-step probe |
| Read scope GM / manager / supervisor / staff | **Implemented** | §3b.A — all four branches exercised with temporary real identities (plus both departments); all counts matched. Test accounts and rows were removed |
| Password-change audit | **Unimplemented** | P3; deliberately not done. No password/hash/token field exists in the table |
| Room Management / extras / report lifecycle audit | **Implemented (P2)** | Migration `010_p2_audit_capture.sql`; §3d |
| Staff management / reset audit | **Unimplemented** | P3 |
| UI (History → `Reports | Activity`, filters, detail, RTL/mobile) | **Implemented in a later milestone** | See `docs/activity-ui.md` and §3c |
| Offline intermediate-transition preservation | **Unimplemented** | Outbox still keeps only latest payload per date; see §6 |
| Historical baseline backfill | **Not applicable (rejected)** | No marker/backfill rows; coverage starts at deployment |
| Export logging (copy email / print) | **Out of scope** | Per owner decision |

**P1 classification at that milestone was: database/backend implemented.** The Activity UI has since been delivered as a separate milestone (see `docs/activity-ui.md` and §3c). P2, P3 and the offline event queue remain unimplemented.

---

## 5. Files changed

- `supabase/migrations/009_system_audit_logs.sql` — new (applied to remote).
- `tests/audit-tests.js` — new static regression suite (16 assertions).
- `docs/audit-trail.md` — this document.

No application code, UI, seed data, or existing migrations were modified.

---

## 6. Offline outbox → event queue: scope and risks (awaiting approval)

Current behavior: the IndexedDB outbox stores only the **latest** payload per `report_date`. If an employee works offline and changes room 1069 three times, replay sends one upsert. The database can only see the final state, so intermediate transitions are irrecoverably collapsed. Replay time is recorded as `occurred_at`; original action times are lost.

Proposed separate phase:

1. Replace the per-date "latest payload" outbox entry with an **ordered append-only event queue** (one event per user action: room, from/to status, client timestamp, action id).
2. Replay events in order, using the action id as an idempotency/dedupe key so a retry after a partial success cannot create a second audit row.
3. Re-verify the actor at replay time from the live JWT (never trust a stored identity claim). Store `metadata.client_occurred_at` alongside the DB time, and mark `metadata.verified = false` while queued / unverified.
4. Handle conflicts explicitly: if the server state no longer matches the event's expected `from` state, do not silently overwrite — flag the event and surface it for review rather than inventing a transition.
5. Add a UI indicator for queued / unverified events and a coverage note in the Activity view.

Risks to accept before implementation:

- Larger offline storage and more complex replay logic; failure modes around partial replay and event ordering.
- Client timestamps are untrusted; they can be recorded but never presented as authoritative.
- Auth tokens can expire between action and replay — replay must be re-authenticated or held.
- Existing queued entries created with the old shape need a one-time migration/discard policy.
- Conflict resolution needs a product decision (block, force-latest, or manual review) before code is written.

Until this phase is approved and shipped, the audit trail must **not** be described as having complete offline coverage.
