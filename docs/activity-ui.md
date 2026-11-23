# Activity UI — delivered

The audit Activity view lives inside the existing **History** tab as a `Reports | Activity` segment. It reads only `public.system_audit_logs` (the P1 table) through the logged-in Supabase client. No new audit database, no duplicated event history, no new dependencies.

## Access model

| Role | History access | Activity visibility | Reports visibility |
|---|---|---|---|
| GM Admin | yes | all authorized rows | yes |
| HK Manager | yes | HK department + `shared_report` | yes |
| FD Manager | yes | FD department + `shared_report` | yes |
| HK / FD Supervisor | yes | own department only (read-only) | yes |
| HK / FD Staff | yes | **only their own rows** | **no** — segment and panel are hidden |

The Reports restriction for staff is enforced in `canSeeHistoryReports()` and `applyHistoryGating()`; staff never load past reports. Row visibility itself is enforced by the database RLS policy — the UI never attempts to substitute frontend filtering for authorization and never uses a service role.

## What is shown

- Employee name, role and department snapshot from event time.
- Action description plus raw `action_type`, module and source.
- Affected record (`entity_type` / `entity_id` / `entity_label`), room and report ID from metadata.
- Previous → new values, plus `status_from`, `status_to` and `unset_flags` for cross-state replacements.
- Server recording timestamp (`occurred_at`). The original action timestamp is shown **only** when `metadata.client_occurred_at` actually exists; P1 rows display "Not recorded for this event (server time only)" rather than an invented time.
- Coverage banner: audit begins 2026-11-23; earlier activity was not captured. The earliest event available to the viewer is also shown.

## Filters, search, loading

Employee, department (including a shared-report option for managers and `all` for GM), role, module, action type, UTC date range, and a room/record search. The search string is restricted to alphanumeric/hyphen characters before being used in a PostgREST `.or()` filter over `entity_id`, `entity_label`, `metadata->>room` and `metadata->>report_date`.

Events are ordered by `occurred_at desc, id desc` and loaded 50 at a time via `.range()` with a Load more control. Filter changes reset and reload the first page.

## Layout

Uses the existing Corinthia design tokens, uppercase segmented control, ledger list, and detail panel. CSS uses logical properties (`margin-block-*`, `border-block-*`, `text-align: start`) so LTR/RTL document direction is respected; dates are formatted with `Intl.DateTimeFormat` using the document language. The filter grid uses `auto-fit/minmax` so it works on mobile and desktop without new breakpoints or dependencies.

## Files changed

- `discrepancy-report.html` — History markup, Activity CSS, role gating, query/render/filter code and event wiring.
- `tests/activity-ui-tests.js` — new static suite (10 assertions).
- `tests/departmental-staff-admin-tests.js` — updated role matrix (History now reachable by staff; Reports remains restricted).
- `docs/audit-trail.md` — verification addendum and status update.

## Verification

See `docs/audit-trail.md` §3c for the six-role browser verification and cleanup evidence. `node tests/activity-ui-tests.js` → 10/10; existing suites: dnd 12/12, departmental-staff 25/25, audit 16/16.
