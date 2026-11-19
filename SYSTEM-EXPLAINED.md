# Room Discrepancy Report — Plain English Guide

This document explains the app in everyday language. No technical words needed.

---

## 1. What is this app for?

Every morning the Front Desk prints a list of guests who are supposed to be in the hotel that night. Housekeeping staff walk the floors and check which rooms are really occupied.

Usually the two lists match. Sometimes they don't. A room on the list may be empty. A guest may be in a room that isn't on the list. A guest may not have any luggage. A guest may not want to be disturbed.

This app is where those differences — called **discrepancies** — are recorded and shared. It replaces paper notes, phone calls, and Excel sheets.

The app runs on a phone, tablet, or computer through a web browser. It can also be added to the phone's home screen and used like a normal app.

---

## 2. Who uses it?

There are two groups: **Front Desk** and **Housekeeping**, plus a **General Manager** who oversees both.

| Job title | What they mainly do |
|---|---|
| Front Desk Staff | Uploads or pastes the morning guest list; receives the final report by email |
| Front Desk Supervisor | Same as above, and can sign off the Front Desk confirmation |
| Front Desk Manager | Same as above, and can add/manage Front Desk staff |
| Housekeeping Staff | Checks rooms, marks empty/occupied, flags no-luggage and Do Not Disturb rooms |
| Housekeeping Supervisor | Same as above, and can sign off the Housekeeping confirmation |
| Housekeeping Manager | Same as above, and can add/manage Housekeeping staff |
| General Manager (GM) | Can see everything and manage staff in both departments |

Managers can only manage employees in **their own department**. The General Manager can manage everyone.

---

## 3. A normal day, step by step

**Morning — Front Desk**
1. Front Desk gets the "Guests In House" PDF report from the hotel system.
2. They open the app and upload that PDF (or paste the room numbers as text).
3. The app reads the PDF and shows the list of rooms in the app.

**During the day — Housekeeping**
4. Housekeeping opens the app on their phone or tablet.
5. For each room on the list, they tap the room once after physically checking it.
6. If a room is occupied but not on the list, they add it as an "extra room".
7. If a guest has no luggage, they flag it.
8. If a guest has a "Do Not Disturb" sign on the door, they flag that too.

**Afternoon — sharing the result**
9. The app counts everything automatically: how many rooms are confirmed, how many are missing, how many have no luggage, and how many are Do Not Disturb.
10. Housekeeping can copy an email summary and send it to Front Desk.
11. Housekeeping confirms the report; Front Desk reads and confirms it back.
12. A clean printable version can be printed or saved for records.

Every day's report is kept. The **History** tab lets you look back at previous days.

---

## 4. Accounts and passwords

### How you get an account
You cannot sign yourself up. A manager adds you in the **Staff** tab and gives you:
- your work email address, and
- an **initial password**.

Sign in with those. You should change your password right away (see below).

### Changing your own password
Anyone who can log in can change their own password:

1. Look at the top bar of the app — next to your name there is a **Change password** link.
2. Tap it.
3. Type your **current password**, your **new password** (at least 6 characters), and type the new one again to confirm.
4. Press **Update password**.

If you type the wrong current password, the app will tell you. If the two new passwords don't match, it will tell you too. Once it succeeds, your new password works immediately and the old one stops working. You stay signed in — no need to log in again.

### If you forget your password
You cannot reset it yourself — that is intentional, so nobody else can take over your account.

Ask your manager to reset it for you. They can do that in the Staff tab. Your department manager can reset passwords for their own team; the General Manager can reset anyone's.

Your password is never stored as readable text. The system keeps only a protected "fingerprint" of it, so even the app's database cannot reveal your actual password.

---

## 5. Where is the information saved?

All reports are saved in a secure cloud database. That means:

- Everyone in the same role sees the **same** up-to-date information.
- If one person changes something, other devices see the change.
- You can close the app and come back later — your work is still there.

If the internet drops while you are using the app, you can keep working. Your changes are saved on the device and sent automatically when the connection returns. The small word **offline** appears at the top so you know.

---

## 6. Recent improvements (in plain English)

| What was fixed | What it means for you |
|---|---|
| Department permissions | Housekeeping managers now only see and manage Housekeeping staff; Front Desk managers only Front Desk staff. The General Manager can still manage everyone. This is checked by the system itself, not just by hiding buttons. |
| Self-service password change | Employees now have the "Change password" link described above. Before, only a manager could change a password. |
| Login setup on the published website | Fixed a problem where the website sometimes showed "Supabase not configured" at the login screen. The published site now has the correct settings saved with it, so this should not happen again. |

---

## 7. If something looks wrong

| What you see | What to do |
|---|---|
| "Supabase not configured..." at login | Refresh the page with **Ctrl + Shift + R** (or restart the app if installed on the phone). If it still shows, tell the manager — the published website needs to be republished. |
| "Wrong email or password" | Check the email is the one your manager gave you. If you changed your password recently, use the new one. If you forgot it, ask your manager to reset it. |
| "Your current password is incorrect" | You typed the old password wrong in the Change password box — try again carefully. |
| The app looks old / a button is missing | Close the app fully and reopen it once. On a phone, the update installs itself in the background. |
| "offline" at the top | Normal — your changes are saved on the device and will be sent when the internet returns. |
| Something else is broken | Take a screenshot and send it to your manager with a note about what you were trying to do. |

---

## 8. In one sentence

**Front Desk gives the app the guest list, Housekeeping checks the rooms against it, the app collects the differences and emails them to Front Desk — and every employee can manage their own password from the top bar.**

---

*Questions? Ask your manager or the person who set up the app. This guide is kept in the project folder as `SYSTEM-EXPLAINED.md`.*
