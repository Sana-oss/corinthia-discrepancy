# P2 audit coverage — FINAL plan (AWAITING EXPLICIT APPROVAL)

**Status: planning only.** No P2 implementation, migration, deployment, or production data change has been made. Commits `4c8a77e` (P1) and `faa1e98` (Activity UI) remain unchanged. P3 and the Offline Event Queue remain separate and unstarted.

Owner decision incorporated: **an identical room-list re-upload produces zero audit events.** If the only changed field is `list_uploaded_at`, the write is a metadata/timestamp update, not an operational transition.

---

## 1. Inspection basis

- `saveListBtn` (HTML ≈ 3649) is the only `saveState(true)` call site. It replaces `state.rooms` with parsed rooms, clears `state.confirmations`, preserves `state.extras`, then saves with a timestamp stamp.
- Extras: `addExtraBtn` pushes `{room}`; `removeExtraTarget` splices it out. Both use `saveState()`.
- Handoff handlers use `saveState()` and mutate `handoff.status` plus signature objects: submit, recall, receive, undo receive, sign, unsign.
- Migration `009_system_audit_logs.sql` currently returns early for **any** write where `list_uploaded_at` changed. P2 replaces that single branch; everything else in 009 stays intact.

---

## 2. Import diff and classification rules

### 2.1 Logical change detection

1. Resolve OLD and NEW room lists as arrays of objects keyed by `(room, occurrence_index)` so duplicate room numbers are matched deterministically in array order.
2. **Zero events** only when all of the following hold:
   - the logical room lists are identical (same rooms, statuses, arrival, departure, in the same order), **and**
   - `extras`, `handoff`, and `confirmations` are all unchanged.
   - In that case the only differing column is `list_uploaded_at`; return without inserting.
3. If `list_uploaded_at` changed **and any other payload field changed**, the write is a real import and is audited.

### 2.2 Classification (orthogonal categories)

| Category | Rule | Counted once per |
|---|---|---|
| `added_rooms` | NEW occurrence with no matching OLD occurrence | room occurrence |
| `removed_rooms` | OLD occurrence with no matching NEW occurrence | room occurrence |
| `reset_rooms` | matched room whose `status` changed (normally to `unconfirmed` when the imported list resets progress) | room occurrence |
| `changed_stay_rooms` | matched room whose `arrival` or `departure` changed | room occurrence |

Rules that prevent misleading counts:

- `added_rooms` and `removed_rooms` are mutually exclusive for a given occurrence.
- `reset_rooms` and `changed_stay_rooms` apply **only** to matched rooms.
- A single room may legitimately appear in both `reset_rooms` and `changed_stay_rooms` (different change dimensions). These are **not** double-counted within a category; `metadata.affected_room_count` is the size of the union of all room identifiers, and the description never sums overlapping category counts.
- No room-status event (`room_confirmed`, `room_unconfirmed`, `room_noluggage_on/off`, `room_dnd_on/off`) is emitted for an import write. The status change is preserved in `reset_rooms` on the aggregate import row.
- `confirmations` cleared by the import are preserved as `metadata.cleared_confirmations` with signer `name`, `email`, `time` only.

### 2.3 Bounded payload strategy (no silent truncation)

- A single import row may contain at most **50 detail entries per array**, and at most **50 detail entries total per row** across all arrays.
- If the import has more than 50 detail entries, emit **ordered continuation rows** of the same `room_list_imported` action, linked by `metadata.operation_id` (a UUID generated in the trigger) and `metadata.part` / `metadata.part_count`.
  - **Part 1** carries all aggregate counts, `affected_room_count`, cleared confirmations, and the first slice of detail arrays.
  - **Parts 2..N** carry `metadata.is_continuation = true`, the same `operation_id`, only the remaining detail slices, and omit counts entirely — so counts are never summed twice.
  - Every affected room occurrence appears in **exactly one** part. Nothing is truncated or dropped; a large import simply spans multiple bounded rows of the same logical operation.
- No second audit table is introduced. Continuation rows live in `system_audit_logs` and inherit the same actor snapshot, RLS and immutability.
- `description` identifies the operation id for part 1, e.g. `Room list imported (op …): +3 added, -1 removed, 2 resets, 1 stay change`.

---

## 3. Exact event payload examples

### 3.1 Combined import (single part)

```json
{
  "module": "setup",
  "action_type": "room_list_imported",
  "entity_type": "daily_report",
  "entity_id": "2026-11-23",
  "entity_label": "Report 2026-11-23",
  "department": "fo",
  "visibility": "department",
  "old_values": {
    "total_rooms": 3,
    "added": [], "removed": ["1070"], "reset": ["1069"], "changed_stay": ["1069"]
  },
  "new_values": {
    "total_rooms": 4,
    "added": ["1071", "1072"], "removed": [], "reset": [], "changed_stay": []
  },
  "description": "Room list imported (op 9f2c…): +2 added, -1 removed, 1 reset, 1 stay change",
  "metadata": {
    "report_date": "2026-11-23",
    "operation_id": "9f2c1c0e-6f0a-4b62-9a13-2f6fb13f0d11",
    "part": 1, "part_count": 1, "is_continuation": false,
    "added_count": 2, "removed_count": 1, "reset_count": 1,
    "changed_stay_count": 1, "affected_room_count": 4,
    "added_rooms": [
      {"room": "1071", "arrival": "24-11-26", "departure": "26-11-26", "status": "unconfirmed"},
      {"room": "1072", "arrival": null, "departure": null, "status": "unconfirmed"}
    ],
    "removed_rooms": [
      {"room": "1070", "status": "confirmed", "arrival": "20-11-26", "departure": "22-11-26"}
    ],
    "reset_rooms": [
      {"room": "1069", "from_status": "noluggage", "to_status": "unconfirmed"}
    ],
    "changed_stay_rooms": [
      {"room": "1069", "old_arrival": "25-08-26", "new_arrival": "24-11-26",
       "old_departure": "08-09-26", "new_departure": "26-11-26"}
    ],
    "cleared_confirmations": [
      {"key": "housekeeping", "name": "HK Supervisor", "email": "hk-sup@example.com", "time": "08:12"}
    ]
  }
}
```

*Note:* room `1069` appears in both `reset_rooms` and `changed_stay_rooms`; the category counts remain 1 each and `affected_room_count = 4` (1069, 1070, 1071, 1072).

### 3.2 Extra room added

```json
{
  "module": "extra_rooms", "action_type": "extra_room_added",
  "entity_type": "extra_room", "entity_id": "AUDIT-EXTRA",
  "old_values": null,
  "new_values": {"room": "AUDIT-EXTRA"},
  "metadata": {"report_date": "2026-11-23", "room": "AUDIT-EXTRA"}
}
```

### 3.3 Lifecycle — signed

```json
{
  "module": "report_lifecycle", "action_type": "report_signed",
  "entity_type": "daily_report", "entity_id": "2026-11-23",
  "visibility": "shared_report", "department": "fo",
  "old_values": {"status": "received", "signature": null},
  "new_values": {
    "status": "signed",
    "signature": {"name": "FD Manager", "email": "fd-mgr@example.com", "time": "14:05"}
  },
  "metadata": {"report_date": "2026-11-23", "from_status": "received", "to_status": "signed"}
}
```

No password, hash or token field appears in any example.

---

## 4. Lifecycle transition validation

First resolve a **logical status** for both OLD and NEW: prefer `handoff->>'status'`; if missing/empty, derive from confirmations (`frontdesk` → `signed`, `housekeeping` → `submitted`, else `in_progress`). This prevents status normalization during load from being mistaken for a user transition.

An event is emitted **only** when the logical status changes AND the matching companion condition holds. A changed JSON field with an unchanged logical status emits nothing.

| Action | Required OLD → NEW | Companion condition |
|---|---|---|
| `report_submitted` | `in_progress` → `submitted` | NEW `handoff.hk_sign` present and its email equals the verified actor email; NEW `confirmations.housekeeping` present |
| `report_recalled` | `submitted` → `in_progress` | NEW `handoff.hk_sign` absent and NEW `confirmations.housekeeping` absent |
| `report_received` | `submitted` → `received` | NEW `handoff.fd_received` present and its email equals the verified actor email |
| `report_receive_undone` | `received` → `submitted` | NEW `handoff.fd_received` absent |
| `report_signed` | `received` → `signed` | NEW `confirmations.frontdesk` present with actor email; OLD `confirmations.frontdesk` absent |
| `report_signature_undone` | `signed` → `received` **or** `signed` → `submitted` | NEW `confirmations.frontdesk` absent; target `received` iff NEW `handoff.fd_received` is present, else `submitted` |

Distinguishability: `report_signed` is identified by `received → signed` plus a newly added `frontdesk` confirmation; `report_signature_undone` by `signed → …` plus removal of that confirmation. They can never both fire for one write.

Additional rules:

- If a valid status change has an unexpected companion state, still emit a `report_lifecycle_changed` fallback row with `metadata.reason = 'unexpected_companion_state'` — never silently drop a real persisted transition.
- If the signer email in the payload differs from the verified actor, emit with `metadata.identity_mismatch = true`; attribution remains the verified JWT actor.
- Signature snapshots in `old_values`/`new_values` contain only `name`, `email`, `time`. Static tests forbid password/hash/token/secret columns or reads.
- A changed signature `time` alone, or any other field churn without a logical status change, produces **zero** lifecycle rows.

---

## 5. Extra rooms and combined writes

- Extras are diffed by room occurrence; one `extra_room_added` or `extra_room_removed` row per actual occurrence, with full changed object in `new_values` / `old_values`. Unchanged extras emit nothing.
- For a single UPDATE that is an import, independent extras/lifecycle branches are still evaluated in order: **import → extras → lifecycle → P1 room status (only when `list_uploaded_at` did not change)**. This means a combined write is represented accurately without duplicate room-status rows.
- A failed or rolled-back write emits nothing in any branch; all inserts are part of the triggering transaction.

---

## 6. RLS visibility matrix

| Viewer | Room checklist | Room list import | Extras | Lifecycle (`shared_report`) | Reports tab |
|---|---|---|---|---|---|
| GM Admin | all | all | all | all | yes |
| HK Manager | HK | — (FD scope) | HK | HK + FD shared | yes |
| FD Manager | — (HK scope) | FD | — (HK scope) | FD + HK shared | yes |
| HK/FD Supervisor | own dept only | own dept only | own dept only | **no** (shared not granted to supervisors) | yes |
| HK/FD Staff | own rows only | own rows only | own rows only | own rows only | **no** |

Verification must show HK manager sees zero FD `department`-scoped rows and FD manager sees zero HK `department`-scoped rows, while both see the six shared lifecycle actions.

---

## 7. Migration and rollback considerations

- **New file:** `supabase/migrations/010_p2_audit_capture.sql`. It only `CREATE OR REPLACE FUNCTION public.audit_daily_report_changes()` with the ordered branches above.
- No change to `system_audit_logs` columns, indexes, constraints, grants, RLS policies, or immutability triggers. Migration 009 is **not** edited or reapplied. No backfill, no data update, no new tables, no new dependencies.
- Apply only after approval, using dry-run first: `npx supabase db push --linked --dry-run`, then `npx supabase db push --linked`.
- **Rollback:** forward-only by deploying a migration 011 that restores the previous function body (the 009/P1+UI version). Audit rows already written are **not deleted** — the table is append-only and history is evidence. Any incorrect P2 rows would remain as historical records; correction would be a new explicit event, not a DELETE. Rollback does not touch `daily_reports` data.
- Local `supabase db reset` is for development only and would rebuild from migrations; never run against the linked project.

---

## 8. Affected files

| File | Change |
|---|---|
| `supabase/migrations/010_p2_audit_capture.sql` | new — extended trigger function only |
| `tests/audit-tests.js` | extend static assertions (new actions, import/no-op, shared visibility) |
| `tests/p2-audit-tests.js` | new — import detail/classification, bounded parts, lifecycle conditions |
| `docs/audit-trail.md` | add P2 coverage + verification evidence |
| `docs/p2-audit-plan.md` | this final plan (updated now) |
| `discrepancy-report.html` | **no change expected** — Activity derives filters/labels from data |

---

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Large import creates huge JSONB row | 50-entry bound with linked continuation rows; no truncation, counts only on part 1 |
| Misleading double counts | Orthogonal categories, `affected_room_count` union, added/removed mutually exclusive |
| Duplicate status events on import | Import branch suppresses P1 room-status loop for that write |
| Identical re-upload noise | Logical list + other-field comparison; zero rows when only `list_uploaded_at` differs |
| Lifecycle event from mere field churn | Logical status transition plus companion condition required |
| Signature data leak | name/email/time only; static credential-field test |
| Combined-write gaps | Explicit branch order; rolled-back probes for all categories in one UPDATE |
| Large payload cost in UI | Existing indexes and 50-row pagination already in place |

---

## 10. Test cases (to run after approval)

1. **Combined import** — one import that adds 2 rooms, removes 1, resets 1 status, changes 1 stay period, and clears 1 confirmation → exactly one bounded row (or correctly linked parts) with all arrays and counts; zero per-room status rows.
2. **Identical re-upload** — only `list_uploaded_at` changes → zero rows.
3. **Large import** — >50 affected occurrences → part 1 has counts, continuation parts carry remaining details; every room appears once; counts appear once.
4. **Extra add / remove** — one row each; re-adding the same room after removal produces a new event; unchanged extras → zero.
5. **No-op save** — identical payload → zero rows in every branch.
6. **Failed / rolled-back write** — update then rollback → zero rows; audit inserts are atomic with the write.
7. **Lifecycle forward chain** — submit → receive → sign, each with exact old/new conditions and correct actor.
8. **Lifecycle reversals** — recall, undo receive, unsign; `signed → received` vs `signed → submitted` distinguished by `fd_received`; no event from signature-time-only churn.
9. **Identity snapshot** — actor name/role/department from JWT+staff at event time; signer email mismatch flagged, never attributed to another employee.
10. **RLS matrix** — six temporary accounts; GM all; HK/FD managers own dept + shared lifecycle; supervisors own dept only; staff own rows only; no cross-department `department` rows.
11. **Regression** — dnd, departmental-staff, audit, activity-ui suites all green; Reports/checklist/extras/handoff/password behaviour unchanged; temp accounts and data removed; `audit_rows = 0` at cleanup.

---

**Awaiting explicit approval. No implementation changes will be made before it.**
