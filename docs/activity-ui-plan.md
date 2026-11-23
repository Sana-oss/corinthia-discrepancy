# Activity UI — approved implementation plan (IMPLEMENTED)

This plan was approved and implemented. See `docs/activity-ui.md` for the delivered behaviour and `docs/audit-trail.md` §3c for verification evidence.

## 1. Scope

Add an `Activity` view inside the **existing History tab**, reusing the current Corinthia design system and RTL/LTR infrastructure. No new navigation item, no new dependencies, no redesign of the Reports view.

- Tab: `tab-history` already exists and is visible to supervisors, managers and GM (`tabAccess('history')`).
- Structure: segmented control `Reports | Activity`, default `Reports`. Switching segments only swaps the panel; it does not change routes or nav.
- Data source: `public.system_audit_logs` via the existing Supabase client. RLS is already in place: GM all; managers own department + `shared_report`; supervisors own department; other users only their own rows.
- Important access note: line staff currently cannot open the History tab at all. Their DB-level self-read works, but the UI cannot expose it without changing the role matrix. This needs an owner decision before implementation; default plan = keep staff hidden and document DB-only self-view.

## 2. Layout and components

### Activity panel

1. **Coverage banner** — "Audit coverage begins <date>", derived from `min(occurred_at)`; if empty, "No activity recorded yet. Coverage starts 2026-11-23. Pre-deployment activity was not captured."
2. **Filter bar** — collapsible `<details>` on mobile, inline grid on desktop:
   - employee (from `public.staff` names/emails available to the viewer)
   - department (`hk` / `fo` / `all`)
   - role (`hk_staff`, `hk_supervisor`, `hk_manager`, `fo_staff`, `fo_supervisor`, `fo_manager`, `gm_admin`)
   - module (`room_checklist`, plus future P2/P3 modules rendered from data)
   - action type (rendered from data, not hardcoded)
   - date range (`from` / `to`, applied to `occurred_at`)
   - room (`metadata->room`)
   - report ID (`metadata->report_date`)
   - Reset filters button
3. **Event list** — `occurred_at` desc, `id` desc; 100 rows per page with "Load more" via Supabase `.range()`. Desktop: table with columns When / Employee / Action / Record / From → To. Mobile: stacked cards.
4. **Detail view** — click/tap a row opens a drawer or modal with every stored field:
   - actor snapshot (name, email, role, department) and note that it is a point-in-time snapshot
   - `module`, `action_type`, `entity_type`, `entity_id`, `entity_label`
   - `old_values` → `new_values` rendered as key/value pairs (full JSON, not truncated)
   - `description`, `source`, `occurred_at`, `department`, `visibility`
   - metadata fields including `report_date`, `room`, `status_from`, `status_to`, `set_flags`, `unset_flags`
   - "Stored" indicator: the row's existence is the proof of persistence; failed/no-op writes produce no row, so no separate badge is fabricated
5. **States** — loading skeleton, empty result ("No activity matches these filters"), and error state with retry.

### Visual / accessibility

- Reuse existing CSS variables, buttons, chips, cards, and the `dir` attribute. Dates/times via `Intl.DateTimeFormat` using the document direction and the browser locale.
- Keyboard accessible filter controls and detail close; focus returns to the triggering row.
- Action labels derived from `action_type` with human-readable mapping; unknown values render the raw value, never a blank.

## 3. Data access details

- Base query: `supabaseClient.from('system_audit_logs').select('*').order('occurred_at', { ascending:false }).order('id', { ascending:false })`.
- JSON filters use PostgREST jsonb operators, e.g. `.filter('metadata->>room', 'eq', room)` and `.filter('metadata->>report_date', 'eq', reportId)`.
- Employee filter uses `actor_user_id` or `actor_email`; department/role/module/action_type map to real columns.
- No write path is added to the UI. The table grants already deny insert/update/delete to `authenticated`.

## 4. Implementation steps

1. Add the segment markup and `activity` panel inside `tab-history` (preserve existing Reports markup exactly).
2. Add `renderActivity()`, `loadActivity(reset)`, filter state, and pagination state near the other History functions.
3. Add JS syntax, DOM-id, and filter-wiring assertions to `tests/audit-tests.js` (extend, do not replace, current assertions).
4. Manual browser verification with temporary accounts: supervisor sees department events; HK/FD managers see own + shared; GM sees all; line staff cannot reach the tab (or decide otherwise).
5. Mobile + RTL visual check using the existing design system.

## 5. Acceptance criteria

- No new nav item; Reports view unchanged.
- Every stored row is reachable; filters combine correctly; detail shows all fields including `unset_flags`.
- Coverage banner never claims pre-deployment history.
- Read visibility matches RLS for each role; no client-side attempt to bypass it.
- Existing test suites still pass; no new dependencies.

## 6. Risks / open decisions

- **Staff access**: History is hidden for `staff`; confirming whether they should get an Activity-only view is required.
- **Action labels** for future P2/P3 modules must be added as those modules are implemented.
- **Large tables**: pagination and indexed filters are mandatory; avoid loading the whole log.
- **Privacy**: never render password/hash/token fields; the schema has none, keep it that way.
- Offline events (pending/unverified/conflict) will need extra status badges once that phase ships; leave a clear extension point in the row renderer.
