# Implementation Plan

[Overview]

Rebrand the presentation layer of the Room Discrepancy Report PWA (Corinthia Hotel Tripoli) to the official Corinthia Hotels visual identity, without touching any business logic, backend functionality, event handlers, or data structures.

**Context.** The app is a single-file static HTML PWA: `c:\Users\user\OneDrive\Desktop\Discrepancy\discrepancy-report.html` (~2,378 lines). All styling lives in one inline `<style>` block (lines 22–247). The DOM structure, element IDs, class names, and the entire `<script>` IIFE (lines 412–2376) must remain functionally identical. Supporting presentation-only files: `manifest.webmanifest` (theme colors) and `sw.js` (asset cache version).

**Researched official brand identity** (extracted from corinthia.com's production CSS `/static/css/app-42JSHWYR.css` and Typekit `xrt3nny.css` on 2026-09-11):

| Token | Value | Source usage on corinthia.com |
|---|---|---|
| Ink / charcoal | `#1f1d19` | Primary text, dark button backgrounds, dark surfaces |
| Ivory / off-white | `#fdfdfc` | Light backgrounds, button text on dark |
| Ivory (theme bg) | `#f1f0ee` / `#f6f5f4` | Page/theme backgrounds |
| Warm greige | `#d8d5cf` | Muted text, dividers/lines |
| Cream (display text) | `#E9E1D6` | Hero/display text on dark |
| Dark secondary | `#332f29` | Menu/dark surfaces |
| Muted brown | `#60594e` | Disabled/secondary text |
| **Gold accent** | `#ffd285` | Button hover/active backgrounds, 6px focus outline |
| Gold (strong) | `#ffa300` / `#ffc157` | Stronger gold states |
| Cream wash | `#fff2db` | Gold-tinted backgrounds |

Typography (corinthia.com production `@font-face` + font stacks):
- Headings/display: **IvyOra Display** (`ivyora-display`) — provided as `Font/IvyOraDisplay-Regular.otf`.
- Body / buttons / labels: **GT America LC Extended** (`gt-america`) — provided as `Font/GT-America-LC-Extended-Regular.otf` (400) and `Font/GT-America-LC-Extended-Medium.otf` (500).
- corinthia.com button spec: `text-transform:uppercase; font-family:gt-america; letter-spacing:.6–.9px; font-weight:400; padding:.9rem 1.2rem`; dark `#1f1d19` bg + `#fdfdfc` text; gold `#ffd285` hover with `#1f1300` text; focus outline `6px solid #ffd285`.
- Border radius: 0–3px on controls (luxury minimal), `50%` only for round dots/ticks.

Status colors in this operational tool (verified/pending/alert) do not exist on corinthia.com; they will be re-derived from the brand palette so they stay harmonious (deep bronze-gold for pending, deep antique red for alert, deep bronze-green for verified) while remaining legible.

**High-level approach.** Replace the `:root` design tokens and all font stacks with the Corinthia identity, add local `@font-face` declarations for the provided OTF files served from the existing `Font/` folder, restyle buttons/inputs/cards/nav per the corinthia.com specs, update PWA theme colors, and remove the Google Fonts (IBM Plex) dependency. No HTML structural changes; only presentational styling. All IDs, class names, handlers, and JS untouched.

[Types]

No TypeScript/data types exist. "Types" here = CSS custom properties (design tokens) replacing lines 23–35 of `discrepancy-report.html`:

```css
:root{
  /* Corinthia palette (corinthia.com production CSS) */
  --bg:#f1f0ee;            /* page background — ivory theme bg */
  --bg-soft:#f6f5f4;       /* secondary ivory */
  --surface:#fdfdfc;       /* cards, inputs */
  --ink:#1f1d19;           /* primary text — charcoal */
  --ink-soft:#60594e;      /* secondary text — muted brown */
  --ink-display:#E9E1D6;   /* display text on dark — cream */
  --ink-on-dark:#fdfdfc;   /* text on charcoal */
  --line:#d8d5cf;          /* borders/dividers — warm greige */
  --line-dark:#332f29;     /* dark surface borders */
  --gold:#ffd285;          /* gold accent — hover/focus */
  --gold-strong:#ffa300;   /* stronger gold */
  --gold-wash:#fff2db;     /* gold-tinted background */
  --dark-2:#332f29;        /* dark surface */
  --focus:#ffd285;         /* focus outline color */

  /* Status (re-derived from brand palette) */
  --verified:#414940;      /* deep bronze-green (corinthia.com --background:#414940) */
  --verified-bg:#e8dfde;   /* corinthia.com button-background-active */
  --pending:#a3762f;       /* deep bronze-gold, legible on ivory */
  --pending-bg:#fff2db;    /* cream wash (corinthia.com) */
  --alert:#7a2e26;         /* deep antique red, brand-harmonious */
  --alert-bg:#f5e4e1;      /* keep existing tint (harmonises) */

  /* Typography */
  --font-display:'IvyOra Display',Georgia,serif;
  --font-body:'GT America LC Extended',Helvetica,Arial,sans-serif;
  --font-mono:'GT America LC Extended',ui-monospace,monospace;

  /* Shape */
  --radius:3px;            /* corinthia.com control radius */
}
```

[Files]

New files: none required. Fonts are served from the existing `c:\Users\user\OneDrive\Desktop\Discrepancy\Font\` folder (already on disk, not git-ignored). Referenced relatively: `Font/IvyOraDisplay-Regular.otf`, `Font/GT-America-LC-Extended-Regular.otf`, `Font/GT-America-LC-Extended-Medium.otf`.

Modified files:
1. `c:\Users\user\OneDrive\Desktop\Discrepancy\discrepancy-report.html` — the only substantive edit target:
   - Line 8: `<meta name="theme-color" content="#1B2420">` → `content="#1f1d19"`.
   - Lines 17–18: remove the Google Fonts `<link rel="preconnect">` and the IBM Plex `<link href="https://fonts.googleapis.com/css2?...">`.
   - Lines 22–247 (`<style>` block): replace entirely with the new Corinthia stylesheet (full CSS rewrite, preserving every selector name currently used by HTML/JS — see [Functions] selector inventory).
2. `c:\Users\user\OneDrive\Desktop\Discrepancy\manifest.webmanifest` — presentation-only: `"background_color": "#F6F4EF"` → `"#f1f0ee"`; `"theme_color": "#1B2420"` → `"#1f1d19"`. Name/short_name/icons untouched.
3. `c:\Users\user\OneDrive\Desktop\Discrepancy\sw.js` — asset-cache reliability for local fonts: add the three font files to `SHELL_FILES` so brand typography is available offline, and bump `VERSION = 'v1'` → `'v2'` so existing clients pick up the restyled shell + manifest. Pure asset caching — no app behavior change.

Files NOT modified: `build.js`, `config.js`, `.env*`, `package.json`, everything under `supabase\`, `new-logo.svg`, icons, `make-icons.js`, `smoke-test.js`.

[Functions]

No JavaScript functions are added, modified, or removed. The `<script>` IIFE (lines 412–2376), all event wiring (`document.addEventListener('click', ...)`, `.tab-btn` handling, outbox logic), and all JS-generated markup class names (`sign-block`, `summary-item`, `empty`, `room-row`, `staff-row`, `badge-soft`, `you-tag`, `act-off`, `mono`, etc.) are consumed **as-is** by the new CSS. The `.mono` utility (line 40) is re-pointed from IBM Plex Mono to GT America (per the "all text elements" font requirement) — a CSS-only change; no `mono` class usages are touched.

Complete CSS selector inventory to preserve (all exist in the current stylesheet and are used by HTML or JS — the new stylesheet must style every one of them, same names):
`:root, *, html, body, .mono, #app, header, header .title, header .date, .offline-badge, main, .hidden, .panel-label, .panel-title, textarea, .row-input, input[type=text], button, .btn-primary, .btn-secondary, .btn-add, .stat-row, .stat, .stat .num, .stat .lbl, .stat.alert .num, .stat.verified .num, ul.ledger, ul.ledger li, .room-row, .room-tick, .room-tick.on, .room-tick.flagged, .room-tick svg, .room-main, .room-num, .room-arrival, .luggage-btn, .luggage-btn.flagged, .extra-row, .trash-btn, .empty, .summary-block, .summary-head, .dot, .dot.alert, .dot.pending, .dot.verified, .summary-head h3, .summary-item, .summary-item .note, .summary-block ul, #emailPreview, .toast, .toast.show, nav, nav button, nav button svg, nav button span, nav button.active, nav .badge, nav .badge::after, .loading, .sign-block, .sign-row, .sign-row input, .sign-done, .sign-done-text, .sign-label, .sign-name, .sign-time, .sign-check, .handoff-track, .handoff-step, .handoff-dot, .handoff-num, .handoff-step-label, .handoff-step-time, .link-btn, #printArea, .login-card, .login-title, .login-error, .who, .who .role-chip, .who .role-chip.chip-hk, .who .role-chip.chip-fo, .readonly-banner, .is-readonly (5 rules), .staff-row, .staff-main, .staff-name, .staff-email, .staff-chip, .staff-chip .role-chip, .chip-hk, .chip-fo, .staff-controls, .btn-sm, .badge-soft, .you-tag, .act-off, select, #staffFormWrap input, @media print block (.print-header, .print-date, .print-meta, .print-section, .print-table, .print-none, .print-signatures, .print-sig, .sig-line, .sig-role)`.
(The current `.needs-fd` wrapper has no CSS rule — the new stylesheet adds one purely presentational `.needs-fd{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:16px;margin-bottom:22px;}` card treatment; no HTML change.)

[Classes]

No classes are added to, removed from, or renamed in HTML/JS. Class styling changes (all CSS-only, within `discrepancy-report.html`):

- `.btn-primary` → Corinthia button spec: `background:#1f1d19; color:#fdfdfc; text-transform:uppercase; letter-spacing:.75px; font-weight:400 (GT America Regular); font-size:1.4rem; padding:1.1rem 1.2rem; border-radius:0; transition:background .5s ease-in-out,color .5s ease-in-out;` hover/active: `background:var(--gold); color:#1f1300;` focus-visible: `outline:6px solid #ffd285; outline-offset:0;` (mirrors corinthia.com `.btn` + `--button-background-hover:#ffd285`, `--focus-outline:#ffd285`).
- `.btn-secondary` → `border:1px solid #d8d5cf; color:#1f1d19; background:transparent; text-transform:uppercase; letter-spacing:.75px; border-radius:0;` hover: `border-color:#1f1d19` (corinthia.com `--button-border-color-hover:#1f1d19`).
- `.btn-add` → same primary spec, inline width (keeps `padding:0 1.4rem` proportions).
- `.login-card` → luxury card: `background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); padding:32px 28px;` with `.login-title` in IvyOra Display `font-size:22px; font-weight:400;` (corinthia.com display headings use regular-weight serif).
- `header .title` → IvyOra Display, `font-size:19px; font-weight:400; letter-spacing:0;` (serif wordmark treatment; element text untouched).
- `.panel-title`, `.summary-head h3`, `.sign-name`, `.staff-name` → IvyOra Display for section headings; `.stat .num` and `.room-num` stay GT America at 400–500 — GT America LC Extended has no true bold, so `font-weight:600/700` usages are normalized to 400/500 to avoid faux-bold.
- `.stat`, `.sign-block`, `.handoff-track`, `#emailPreview`, `textarea`, `input`, `select` → `border-radius:var(--radius); border:1px solid var(--line); background:var(--surface);` plain focus: `border-color:#1f1d19` (keeps current `outline:none` behavior on mobile); `:focus-visible` on buttons/links: `outline:6px solid #ffd285`.
- `nav` → `background:#fdfdfc; border-top:1px solid #d8d5cf;` active tab charcoal; tab label `letter-spacing:.6px; text-transform:uppercase; font-size:10px;` (corinthia.com `.label`/`.btn--sm` spec). Badge dot: `background:var(--alert); border-radius:50%`.
- `.offline-badge`, `.role-chip`, `.badge-soft`, `.readonly-banner` → chips using `--pending-bg:#fff2db` + `--pending:#a3762f` (corinthia.com cream wash) and `--radius:0` (brand-minimal); chips stay uppercase with `.6px` letter-spacing.
- `.toast` → `background:#1f1d19; color:#fdfdfc; border-radius:0;`.
- SVG strokes (`nav button svg`, `.luggage-btn svg`, `.room-tick svg`, `.trash-btn svg`, `.sign-check svg`, `.handoff-dot svg`) → re-pointed to brand tokens; ticks/fills that currently stroke `var(--bg)` on colored fills switch to `#fdfdfc` so checkmarks stay visible on `--verified`/`--pending` fills.
- `@media print` → `#printArea` header `h1` uses `var(--font-display)`, tables/meta use `var(--font-body)`; replaces IBM Plex stacks; print stays monochrome `#111` for legibility.

[Dependencies]

Removed dependencies:
- Google Fonts (IBM Plex Sans / IBM Plex Mono) — delete lines 17–18 of `discrepancy-report.html`.

Local assets (no package installs) — `@font-face` rules with `font-display:swap`, served from repo-root-relative `Font/` paths (correct because the HTML lives at repo root):
- `Font/IvyOraDisplay-Regular.otf` → family `'IvyOra Display'`, weight 400, `format('opentype')`.
- `Font/GT-America-LC-Extended-Regular.otf` → family `'GT America LC Extended'`, weight 400, `format('opentype')`.
- `Font/GT-America-LC-Extended-Medium.otf` → same family, weight 500.
- Untracked-but-present `Font/AdobeArabic-Regular.otf` and `Font/AdobeFnt25.lst` are left untouched and unused.

Unchanged dependencies: `pdf.js 2.16.105` (cdnjs), `@supabase/supabase-js@2` (jsdelivr) — both still loaded and still cached by `sw.js` `cacheFirst`. One comment in `sw.js` (line 6, "IBM Plex fonts") is updated to "Corinthia brand fonts" for accuracy.

[Testing]

- **Manual visual validation (primary):** run `npm start` (builds `config.js` + serves on :8080 via `npx http-server`) and open `http://localhost:8080/discrepancy-report.html`. Verify the login screen first (works without data), then each tab the current role permits: Setup, Checklist, Extra, Summary, History, Staff. Check: fonts load (DevTools → Network → Font from local `Font/`), charcoal buttons hover to gold `#ffd285`, uppercase button labels, 0–3px radii, nav bar, chips, toast, read-only dimming (`is-readonly`), offline badge.
- **Offline/PWA validation:** serve once online, then DevTools → Application → Service Workers → offline, reload. Confirm fonts render offline (now in `SHELL_FILES` of `sw.js` v2) and no console errors reference the removed Google Fonts link; no 404s for `Font/*.otf`.
- **Interaction regression (business-logic guard):** confirm all handlers still fire — login/sign out, PDF upload, paste + parse preview, save list, room tick + luggage flag, extra add/trash, summary counts, email copy, handoff submit/receive/undo, signatures, print, history back, staff add/edit/cancel. Guard: `git diff` must show changes only in the head/meta/style region (lines 1–247) of `discrepancy-report.html`, `manifest.webmanifest` colors, and `sw.js` `SHELL_FILES`/`VERSION`/comment — **zero** changes from `</head>` (line 248) onward.
- **Print validation:** Ctrl+P preview shows the brand-styled report with signature lines and unchanged layout (print CSS keeps the `visibility` strategy; only font stacks change).
- **Faux-bold sanity:** both OTFs ship single weights; `body{font-synthesis-weight:none;}` ensures headings styled at 400 stay crisp and nothing renders with synthesized bold.

[Implementation Order]

1. Add the three local `@font-face` rules and replace the `:root` token block (lines 23–35) in `discrepancy-report.html`.
2. Replace the global font stacks (`html,body`, `.mono`) and remove the Google Fonts `<link>`s (lines 17–18); update the `theme-color` meta (line 8).
3. Restyle components in stylesheet order: header → forms/inputs → buttons (primary/secondary/add/sm/link) → stat cards → ledger/room rows/ticks/luggage → extras/trash → summary/email preview → toast → nav → handoff/sign blocks → staff/chips → login card → readonly state → print block. Preserve every selector name from the inventory.
4. Update `manifest.webmanifest` background/theme colors.
5. Update `sw.js`: font files into `SHELL_FILES`, `VERSION` → `'v2'`, fix the IBM Plex comment.
6. Validate with `npm start`: walk all tabs + print + offline, and run the `git diff` guard check (no changes in HTML body or JS beyond lines 1–247).




