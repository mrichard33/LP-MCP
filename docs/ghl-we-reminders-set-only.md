# Window Estimate reminders: Set and Verif only (GHL edits)

**Ruling (2026-10-13):** appointment reminders go only to visits whose LP status is **Set** (or **Verif**, which
Mark ruled counts as Set). **Cnf** and **Issue** visits get no reminders.

These are GHL workflow edits, made by hand in the GHL builder. No code changes are needed.

## What is true today (HL mirror, 2026-09-25)

- **A.WE-1 Window Estimate Reminders** (GHL id `75829de7…`) is published, and **every text and email step in it is
  switched off** ("isDisabled"). The Window Estimate calendar's own notifications were also turned off on 2026-10-13,
  so right now **no Window Estimate reminder goes out to anyone**.
- Before every message, A.WE-1 already runs **"Check If Appointment is Confirmed"** on the contact field
  **LP Disposition** (`URWTGtobi9a9Y7gwGxC8`):
  - **Marked Confirmed (Cnf or Issue)**: LP Disposition is `Cnf` or `Issue`.
  - **Not Confirmed**: everything else (`Set`, `Verif`, or blank because LP doesn't have it yet).
  Each branch has its own copy of the message. That split is exactly the rule; the branches only need their sends
  switched on or off.
- LP-MCP writes LP Disposition from the contact's newest LP lead every 15 minutes (`src/ghl-field-sync.js`).

## The edits, in A.WE-1 Window Estimate Reminders

1. **Turn ON** every send step on the **Not Confirmed** side of each "Check If Appointment is Confirmed". These are
   the "(Unconfirmed)" steps:
   - SMS #1.1 / #1.2 / #1.3 (Unconfirmed): "your window estimate is on the books … our team is reaching out to confirm"
   - Email #1 (Unconfirmed): "Still good for {{appointment.only_start_date}}?"
   - Email 3B (Unconfirmed), two days before
   - SMS 2 (Unconfirmed), two days before
   - SMS #3, the day before ("Quick reminder … is tomorrow at …"), on the Not Confirmed branch
   - Email 5 (Unconfirmed), the day before
   - SMS 3 final reminder (Unconfirmed), two hours before
2. **Leave OFF** every send step on the **Marked Confirmed (Cnf or Issue)** side ("Same Day Booking Confirmed",
   SMS #1.2/#1.3 confirmed, Email #1 "Your in-home visit is scheduled", the confirmed SMS 2 / SMS 3 / Email 3B /
   Email 5). A confirmed visit then gets nothing.
3. **Canvassing check "Is Confirmed?"** tests `Cnf` only. Add **OR LP Disposition is `Issue`** so it matches the
   other checks. (That path sends nothing today, so this is consistency, not a behavior change.)
4. **Triggers.** The mirror shows A.WE-1 with its own appointment triggers (status `new` and `confirmed` on the Window
   Estimate calendar `aJj14ONxh1oFyDcQ706O`), while **A.WE Window Estimate Handler** also adds contacts to A.WE-1.
   Open A.WE-1's trigger panel. If those triggers are there, remove them: A.WE already enrolls every booking, and the
   `estimate-reminders-started` tag is the only thing stopping a double run.
5. **Keep the Window Estimate calendar's built-in notifications OFF**, so nothing sends outside this gate.
6. Save and publish.

## How it behaves after the edit

- Because the check runs again right before each message, a visit that goes **Set → Cnf** (after the confirmation
  call) stops getting reminders at the next step. A visit that goes **Cnf → Set** starts getting them again.
- A brand-new booking that LP has not seen yet has a blank LP Disposition and is treated like Set.
- **Known gap:** LP's Cnf reaches GHL about 15 to 30 minutes after it is keyed in LP (LP's real-time webhook has been
  mostly silent since 2026-09-24, so the 15-minute sync carries it). A visit confirmed in the last half hour can
  still get the next reminder. Every other reminder is gated correctly.

## Check it worked (a day after publishing)

Silence is not proof. Read the HL mirror (MCP `hl_query`) for A.WE-1 messages in the last day and the contact's
LP Disposition when each went out. Expect **zero** sends to `Cnf` / `Issue`, and at least one send to each `Set`
visit in its window:

```sql
SELECT json_agg(row_to_json(s)) FROM (
  SELECT m.contact_id, m.date_added, left(m.body, 80) AS body,
         (SELECT f->>'value' FROM jsonb_array_elements(c.raw_json->'customFields') f
           WHERE f->>'id' = 'URWTGtobi9a9Y7gwGxC8') AS lp_disposition
    FROM messages m JOIN contacts c ON c.id = m.contact_id
   WHERE m.direction = 'outbound' AND m.date_added > now() - interval '1 day'
     AND (m.body ILIKE '%window estimate%' OR m.body ILIKE '%in-home visit%' OR m.body ILIKE '%quick reminder%')
   ORDER BY m.date_added DESC LIMIT 100
) s;
```

(Column names follow the HL mirror; adjust if `hl_list_tables` shows different ones.)

## Not covered here

The Confirmation Call reminders (**A.CC-1**) and Measurement Verification reminders (**A.MV-1**) are other calendars,
and their sends look switched on. If the same Set-only rule should apply there, they need the same edit.
