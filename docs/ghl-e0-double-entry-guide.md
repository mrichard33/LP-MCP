# Stop leads entering E.0 twice: GHL steps for Mark

*2026-09-25. Two edits in GHL, about 10 minutes. Nothing else changes.*

## What is happening

Every day, 3 to 5 leads go through **E.0 Master Router** a second time. This happens hours after their first
pass (7 to 28 hours, measured Sep 21–24), and it is always a lead who has **already moved on**: booked,
confirmed, or in a bridge. On the second pass E.0 routes them again, as if they were new. For example,
Blankenbicker was confirmed on Sep 20 and E.0 then sent him into E.2 Calculator Bridge twice that day.

**Where it comes from:** the **I.LP-IN LP Inbound Customer Journey Webhook** workflow. Each time LP sends an
update, it waits 2 minutes and then checks **one** tag before step **"Send to E.0 Webhook"**:

> **If "Not Active (Continue)"**: contact does **not** have tag `routing-active`

Later steps in I.LP-IN **remove** `routing-active` ("Remove Tag: routing-active", on the sale, cancelled
and other-lead paths). After that, the next LP status change sails through the check and the lead goes back
into E.0.

**It is not the new intake backstop.** Of the 90 intake leads it routed on Sep 24, none entered E.0 twice.
That rule now also skips any lead that is already routed.

The leads that came back into E.0 were carrying these tags (last 7 days, number of leads):

| Tag | Leads |
|---|---|
| `lp-lead-confirmed` | 23 |
| `lp-route:appt-confirmed` | 20 |
| `lp-route:stale-appt` | 17 |
| `stage:booked-main-appointment` | 14 |

## Edit 1: I.LP-IN, the check before "Send to E.0 Webhook"

1. Open **Automation → Workflows → I.LP-IN LP Inbound Customer Journey Webhook**.
2. Find the If/Else right after **"Wait 2 Minutes"**. Its first branch is **"Not Active (Continue)"**.
3. Click the branch. It has one condition: *Tags → Does not include → `routing-active`*.
4. Click **+ Add condition** (keep it **AND**), and add these, each as *Tags → Does not include*:
   - `active-e.0`
   - `active-e.5`
   - `active-e.7`
   - `active-w07`
   - `stage:entry-bridge`
   - `stage:booked-main-appointment`
   - `lp-route:appt-confirmed`
   - `lp-lead-confirmed`
5. **Save**, then **Publish**.

Result: a lead who is already routed, booked or confirmed skips "Send to E.0 Webhook". Everything else in
I.LP-IN (sale handling, cancellations, field updates) still runs, because those steps sit on other branches.

> **Your call:** if a confirmed or booked lead *should* be re-routed by E.0 on an LP change, for example
> to pick a new bridge, leave out the last three tags. Today that re-route is what sends confirmed leads
> back into E.2 Calculator Bridge.

## Edit 2: E.0 step 9 (the "Not Active (Continue)" check)

This is the safety net for every way into E.0 (I.LP-IN, the Buyer Activation opportunity trigger, the HRR
form, our backstop).

1. Open **E.0 Master Router** and click the first If/Else after "Find Contact" (step 9). Its branch is
   **"Not Active (Continue)"**, and today it holds five *Tags → Does not include* conditions joined by
   **AND**: `active-e.0`, `active-e.5`, `active-e.7`, `stage:entry-bridge`, `complaint-canvasser`
   (cached copy, v196).
2. Add these, each as *Tags → Does not include*, still **AND**:
   - `active-w07`
   - `stage:booked-main-appointment`
   - `lp-route:appt-confirmed`
   - `lp-lead-confirmed`
3. **Save**, then **Publish**.

## How to check it worked

The day after publishing, run this on the HL Supabase. It lists leads that entered E.0 twice in the last 24
hours, and it should return **no rows**:

```sql
with ev as (
  select contact_id, event_time, (raw_json->'tags') ? 'active-e.0' has0,
         lag((raw_json->'tags') ? 'active-e.0') over (partition by contact_id order by event_time) prev0
  from lead_events
  where raw_json ? 'tags' and event_time >= now() - interval '24 hours')
select contact_id, count(*) as entries
from ev where has0 and prev0 = false
group by contact_id having count(*) >= 2;
```

Before the fix this returned 3–5 rows a day.
