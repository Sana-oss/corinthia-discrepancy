# Room Discrepancy Report — Project Summary

**Property:** Corinthia Hotel Tripoli
**Prepared by:** Mohamed Gaja
**Departments involved:** Housekeeping, Front Desk

## The Problem

Every day, Housekeeping and Front Desk must independently verify which rooms are actually occupied, to catch any mismatch between what the hotel system (Opera) shows and what's physically true on the floor (e.g. a guest who checked out but the room wasn't released, or an occupied room not reflected in the system).

The current process does this by having **both departments physically walk every room, twice**:

1. Housekeeping walks all ~200+ rooms, writing down the status of each one (Occupied, Vacant, House Use, Out of Order) on a paper form.
2. Housekeeping hands the paper to Front Desk.
3. Front Desk walks the **same ~200+ rooms again**, independently recording their own findings on the same sheet.
4. Both departments sign the paper, and it's forwarded to Finance.

**Why this is a problem:**
- Two full physical room checks per day, every day — a significant time cost for both departments.
- Doing it twice doesn't reduce errors; it just doubles the manual effort, especially during busy periods.
- The comparison and sign-off is entirely manual and paper-based, so discrepancies can be slow to surface and act on.

## The Proposed Solution

Instead of both departments walking every room, only **one physical walk is needed** — Housekeeping's — because Front Desk already has an accurate occupied-room list sitting in the property management system (Opera).

1. At 3:30 PM, Front Desk exports the **Guests In House** report from Opera (sorted by room number) — the same report already used today.
2. Housekeeping does its usual physical room walk, but instead of writing statuses from scratch, it **confirms against the system-generated list**: any room on the list that isn't actually occupied, or any occupied room not on the list, is a discrepancy.
3. Housekeeping also flags any occupied room with no luggage, for Front Desk to follow up on (possible early departure or walk-out).
4. Housekeeping emails the discrepancies (if any) to Front Desk, who takes over follow-up from there — no second physical walk required.

This removes Front Desk's redundant room walk entirely, while keeping the same accountability the paper process had.

## The Tool Built

To make this practical on a phone with no extra software or training, a lightweight mobile web app was built:

- **PDF upload:** Front Desk uploads the Guests In House PDF directly — no retyping. The app reads the report's layout and extracts each room number and arrival date automatically, ignoring names, rates, and other columns. (Tested against a live report from the property — matched the report's own room count exactly.)
- **Live checklist:** Housekeeping opens the same list on their phone and taps each room as they confirm it's occupied, with a one-tap flag for "no luggage."
- **Extra rooms:** Any occupied room found that isn't on the list at all can be logged on the spot as a discrepancy.
- **Auto-generated summary & email:** The app calculates all discrepancies and no-luggage flags and generates ready-to-send email text for Front Desk.
- **Digital confirmation:** Both Housekeeping and Front Desk confirm digitally (name + timestamp) once reviewed — replacing the paper signatures, with the confirmation recorded directly in the email.
- All staff see the same shared, live data on their own phones — no separate spreadsheets or paper copies to reconcile.

## Suggested Next Step

Trial the new process for a few days alongside the existing one, using the tool to generate and confirm the daily report, and adjust the format based on feedback from the Housekeeping team before fully replacing the paper process.

## Access & Roles

The app is gated by Supabase Auth — staff sign in with email + password. Each user is looked up in a `staff` table that defines their role:

| Role | Can do |
|---|---|
| `housekeeping` | View today's list, tick rooms, flag no-luggage, add extras, sign off as Housekeeping |
| `front_desk` | Upload the PDF, paste a list, sign off as Front Desk, view history |
| `manager` | Everything both can do, plus can view every archived day |

The sign-off is no longer a typed name — it's the user's full name from the staff table, so it can't be spoofed. Row Level Security in Supabase enforces the same rules at the database layer as a safety net.

Bootstrap (first-time setup):

1. In Supabase: Authentication → Users → Add user — create each staff account with email + password.
2. Run `supabase/schema.sql` in the SQL editor to create the `staff` and `daily_reports` tables with their RLS policies.
3. Run `supabase/seed.sql` to register the same emails in the `staff` table with their role.
4. Copy `.env.example` to `.env`, fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Project Settings → API), then `npm run build` to generate `config.js`. Don't commit `.env` or `config.js`.
