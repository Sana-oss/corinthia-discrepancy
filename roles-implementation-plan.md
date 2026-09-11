# Role-Based Access Control — Implementation Plan

## Context

The Room Discrepancy Report app currently has login/authentication already implemented, but every logged-in user sees and can do everything — there is no role-based restriction yet.

This document defines the roles that must exist, what each role should be able to see and do on each screen, and the work needed to enforce it. Apply this against the current codebase (not the old single-file HTML prototype — the structure may have changed since then).

**Before making changes**, inspect the existing auth implementation and answer/confirm:
- How is the logged-in user's identity available on the client (session object, JWT claims, etc.)?
- Is there already a `role` (or similar) field anywhere — on a `profiles`/`users` table, in Supabase Auth `user_metadata`, or elsewhere? If not, one needs to be added.
- Is Supabase Auth being used, or a custom auth system?

Do not assume — check the current code and report back if anything below conflicts with what's already built.

## Roles

Six roles across two departments:

| Department | Roles |
|---|---|
| Housekeeping | `hk_staff`, `hk_supervisor`, `hk_manager` |
| Front Desk | `fo_staff`, `fo_supervisor`, `fo_manager` |

(Exact role key names above are suggestions — match whatever naming convention the existing codebase already uses, if any.)

## Permission Matrix

Legend: **Full** = can view and use normally · **View** = visible but read-only, actions disabled · **Hidden** = tab/section not shown at all

| Screen / Action | hk_staff | hk_supervisor | hk_manager | fo_staff | fo_supervisor | fo_manager |
|---|---|---|---|---|---|---|
| Setup (upload/paste today's list, Save) | Hidden | Hidden | Hidden | Full | Full | Full |
| Checklist (tick room, flag no-luggage) | Full | Full | Full | Hidden | Hidden | Hidden |
| Extra (report unlisted occupied room) | Full | Full | Full | Hidden | Hidden | Hidden |
| Summary (view discrepancies/no-luggage lists) | View | Full | Full | View | Full | Full |
| Submit report to Front Desk (locks HK checklist) | Hidden | Full | Full (optional) | Hidden | Hidden | Hidden |
| Receive report (Front Desk) | Hidden | Hidden | Hidden | Hidden | Full | Full (optional) |
| Confirm receipt as Front Desk | Hidden | Hidden | Hidden | Hidden | Full | Full (optional) |
| Print report | Hidden | Full | Full | Hidden | Full | Full |
| History (browse past days) | Hidden | Full | Full | Hidden | Full | Full |
| Staff management (own department) | Hidden | Hidden | Full | Hidden | Hidden | Full |

Notes on intent (for judgment calls not explicitly covered above):
- Line staff (`hk_staff`, `fo_staff`) should only see what's needed for their direct daily task — nothing else, to keep their view simple and avoid confusion.
- Sign-off (confirmation) is a supervisor/manager responsibility only — never available to line staff — so accountability for the final report is always traceable to a named supervisor or manager.
- Access is **strictly departmental**: each role can only work within its own department. Managers have **Full** access to their own department's operational tabs (an `hk_manager` can tick rooms and flag luggage; an `fo_manager` can upload/replace the daily list) and **no access at all** to the other department's operational tabs.
- **Staff management** (manager admin tab) is also strictly departmental: each manager can only see, add, edit, and deactivate people in their own department — enforced both in the UI and in the `staff` table RLS (migration 004).
- History (archive) is supervisor/manager only, so line staff stay focused on today's task.
- **Report handoff workflow** (in-app delivery between departments): Housekeeping submits the report to Front Desk — this records the HK supervisor/manager's confirmation *and locks the HK checklist & extra rooms* so no further edits are possible until the report is recalled. Front Desk then **receives** the report, and finally a FD supervisor/manager **confirms receipt**. Status flows `in_progress → submitted → received → signed`, tracked visually on the Summary tab for all roles. HK can **recall** (un-submit) at any point before FD confirms, which unlocks the checklist. FD can **undo receive** or **un-confirm** to step status back. Email text and the print report reflect the current handoff status and both signatures.

## Implementation Requirements

### 1. Client-side gating (UI)
For each screen/action in the matrix:
- **Hidden**: don't render the tab/button/control at all for that role (not just CSS-hidden — don't mount it, so there's nothing to inspect/re-enable via dev tools).
- **View**: render normally, but disable all interactive elements (tap targets, buttons, inputs) and make this visually obvious (e.g., a "Read-only" badge or dimmed state) so it's clear it's not a bug.
- **Full**: current existing behavior, unchanged.

The navigation bar itself should only list tabs the current role has at least View access to — don't show a nav item for a Hidden tab.

### 2. Server-side enforcement (required, not optional)
Client-side hiding alone is not real security — anyone can call the Supabase REST API directly with valid credentials and bypass UI restrictions entirely. The current Supabase RLS policies (`anon read`/`anon insert`/`anon update`, all `using (true)`) predate the login system and allow **any** authenticated (or even anonymous, if the anon key is still used anywhere) request to read/write everything.

Now that real user accounts with roles exist, replace those permissive policies with role-aware ones. Roughly:

```sql
-- Example shape — adapt column/table names to match the actual schema.
-- Assumes a way to look up the current user's role, e.g. a `profiles` table
-- keyed by auth.uid(), or a custom claim on the JWT.

drop policy if exists "anon insert" on daily_reports;
drop policy if exists "anon update" on daily_reports;

-- Everyone logged in can still read (needed for Summary/History views).
-- (Keep "anon read" or replace with an authenticated-only equivalent —
-- decide based on whether anonymous access should still be possible at all.)

create policy "fo_can_upload_list" on daily_reports
  for insert
  with check ( current_user_role() in ('fo_staff','fo_supervisor','fo_manager') );

create policy "authenticated_can_update_own_fields" on daily_reports
  for update
  using ( true ); -- refine: ideally restrict which JSON keys each role can touch,
                  -- which may require a Postgres function rather than a plain policy,
                  -- since RLS can't easily restrict individual JSONB keys within `payload`.
```

Flag this back explicitly: **enforcing different permissions on different parts of the same `payload` jsonb blob (e.g., hk_staff can only touch `rooms[].status`, fo_staff can only touch nothing in payload, only trigger the list upload) is hard to do with RLS alone**, since RLS operates at the row level, not the JSON-field level. Two reasonable options — pick based on how strict this needs to be:
   - **Option A (simpler, recommended to start):** Keep one `update` policy allowing any authenticated user to update the row, and rely on client-side gating to prevent the wrong role's *app UI* from making the wrong kind of update. Accept that a malicious authenticated user could technically bypass this via direct API calls — same trust model as most internal tools.
   - **Option B (stricter):** Split the single `payload` jsonb column into separate columns/tables per concern (e.g., a separate `room_checks` table that only Housekeeping roles can write to, keyed by `report_date` + `room`), so RLS can cleanly enforce per-role write access at the table level. This is a larger schema change — don't do this unless asked to.

Implement Option A now, but write this trade-off clearly in your summary back to me so I can decide if Option B is worth doing later.

### 3. Role source of truth
- Add a `role` column (or reuse an existing equivalent) on whatever table represents user profiles, with one of the six values above.
- If there's no profiles table yet, create one keyed by the auth user id, and set roles manually per person for now (no self-service role picker — roles should only be assignable by whoever manages the Supabase project directly, e.g. via the Supabase table editor).
- Load the current user's role once at login/app start and keep it in whatever shared app state already exists, so it doesn't need to be re-fetched on every screen change.

## Testing Checklist

After implementing, verify for **each** of the six roles:
- [ ] Only the correct tabs appear in navigation.
- [ ] Hidden tabs are not reachable by directly navigating/deep-linking, not just absent from the nav bar.
- [ ] View-only tabs render data correctly but reject any attempted write (test by trying the underlying Supabase call directly, not just clicking disabled buttons).
- [ ] A `hk_staff` account cannot upload/replace the daily list.
- [ ] An `fo_staff` account cannot tick rooms or confirm the report.
- [ ] Only supervisor/manager roles can submit the report (Housekeeping) and receive/confirm it (Front Desk), respectively.
- [ ] Managers have **Full** access to their own department's operational tabs and **no access** to the other department's (Setup hidden for `hk_manager`; Checklist/Extra hidden for `fo_manager`).
- [ ] **Handoff workflow:** a HK supervisor/manager can submit, which locks the checklist (HK staff can no longer tick/flag/remove-extras until recall); FD cannot sign before receiving; FD receive then confirm sets the final `signed` status; the Summary tracker shows the correct status for all roles.
- [ ] **Undo chain:** HK recall unlocks the checklist; FD un-confirm returns to `received`; FD undo-receive returns to `submitted`.
- [ ] Email text and print output reflect the current handoff status and both signatures at each step.
- [ ] Legacy days (saved before the handoff field existed) load with status derived correctly from their stored signatures.

## Open Questions to Resolve Before Starting

1. What does the existing login system already store about each user (any role/department field at all)?
2. Should `hk_manager` / `fo_manager` be two separate roles, or a single `general_manager` role with full view access across both departments? (The matrix above assumes separate manager roles per department — confirm this matches the real org structure.)
3. Is there a need for a role to be assignable/changeable from within the app itself, or is manual assignment via the Supabase dashboard acceptable indefinitely?
