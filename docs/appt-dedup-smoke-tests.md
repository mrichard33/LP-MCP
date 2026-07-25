# Appointment / Enrollment Dedup — Smoke Tests

Hand-curated scenarios to exercise the appointment-event dedup
(`src/services/appt-event-dedup.js`, wired into `handleAppointment`) and the
cross-rule enrollment guard (`src/services/enrollment-dedup.js`, wired into the
action executor) against a live Railway deploy before trusting them in prod.

The appointment tests `POST` the GHL appointment webhook and verify the
resulting `system_events` rows. The enrollment guard is verified by observation
(it fires inside the executor, not on an endpoint).

## Prerequisites

- `fix/appt-event-dedup` merged and deployed to Railway.
- `APPT_DEDUP_WINDOW_MINUTES` (default `60`) and `WORKFLOW_REENROLL_WINDOW_HOURS`
  (default `6`) set (or left at defaults) on Railway.
- `GHL_WEBHOOK_SECRET` known (sent as `x-webhook-secret`); omit the header if the
  deploy has no secret configured.
- A disposable test contact ID `TEST_CONTACT_ID` provided by Mark.
- Supabase (LP) read access for the verification queries.

## Common request shape

```bash
curl -X POST https://<railway-host>/webhook/ghl/appointment \
  -H "x-webhook-secret: $GHL_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "contactId": "TEST_CONTACT_ID",
    "calendarId": "aJj14ONxh1oFyDcQ706O",
    "status": "new",
    "startDate": "2026-08-05",
    "startTime": "2026-08-05T13:30:00-04:00"
  }'
```

`status` drives the emitted `event_type`: `new` → `ghl.appointment_booked`,
`cancelled` → `ghl.appointment_cancelled`, `confirmed` →
`ghl.appointment_confirmed`, `rescheduled` → `ghl.appointment_rescheduled`,
`no_show` → `ghl.appointment_no_show`.

## Verification query

```sql
SELECT id, event_type, idempotency_key, created_at
FROM system_events
WHERE entity_id = 'TEST_CONTACT_ID'
  AND idempotency_key LIKE 'ghl_appt_TEST_CONTACT_ID_%'
ORDER BY created_at DESC
LIMIT 10;
```

The `idempotency_key` is `ghl_appt_<contact>_<slotKey>_<status>_<epochMs>` — the
`slotKey` is `slot:<calendar>:<date>:<time>` (or `id:<appointmentId>` once GHL
sends the id). It carries no status in the *lookup* prefix; status is retained in
the stored key for forensics.

---

## Test 1 — Duplicate booking inside the window dedupes

**Setup.** Fresh `TEST_CONTACT_ID`, no prior appointment events.

**Request.** Send the common `new` request **twice**, ~90 s apart (straddle a
`:30` clock boundary to prove the old fixed-bucket failure is gone).

**Expected.**
- Both HTTP 200. First response `{"status":"accepted","event_type":"ghl.appointment_booked"}`; second `{"status":"deduped","event_type":"ghl.appointment_booked"}`.
- The verification query shows **exactly one** `ghl.appointment_booked` row for the slot.
- Railway logs show `Appointment ghl.appointment_booked DEDUPED ... skipping emit + side effects` for the second call.

## Test 2 — Rebook after cancel EMITS (the regression guard)

**Setup.** Continue from Test 1 (one live booking for the slot).

**Request.** Send `status:"cancelled"` for the same slot, then ~60 s later send
`status:"new"` for the same slot again (book → cancel → rebook, canary
`YHSGdUigcsLWrToPpFAc`).

**Expected.**
- All three HTTP 200 and **not** deduped: `system_events` shows
  `booked`, then `cancelled`, then a second `booked` for the slot.
- A status-bearing key would have swallowed the rebook — this test fails if only
  one `booked` row exists after the sequence.

## Test 3 — Duplicate cancellation dedupes

**Request.** Send `status:"cancelled"` for the same slot **twice**, within the
window.

**Expected.** First emits `ghl.appointment_cancelled`; second returns
`{"status":"deduped",...}`. Exactly one new `cancelled` row.

## Test 4 — Fail-open

**Setup.** Temporarily point the deploy's Supabase at an unreachable host (or
observe during a real Supabase blip).

**Request.** Send any duplicate pair.

**Expected.** Both emit (dedup fails OPEN) and Railway logs show
`[apptEventDedup] lookup failed ... fail-open, emitting`. A lost booking is worse
than a duplicate event.

## Test 5 — Cross-rule enrollment guard (observational)

**Setup.** Drive `TEST_CONTACT_ID` through a cancellation that both the LP
disposition path and the GHL cancel webhook see (or enqueue two
`add_to_workflow` actions into the S5.2 workflow within
`WORKFLOW_REENROLL_WINDOW_HOURS`).

**Verify.**

```sql
SELECT id, status, rule_applied, execution_result, created_at
FROM agent_actions
WHERE target_id = 'TEST_CONTACT_ID'
  AND action_type = 'add_to_workflow'
ORDER BY created_at DESC
LIMIT 5;
```

**Expected.** The first enrollment is `completed` with a real GHL enroll; the
second is `completed` with
`execution_result = {"action":"deduped","skipped":true,"reason":"duplicate_enrollment_window","prior_action_id":<first>,...}`
and **no** second GHL enroll call. Railway logs show
`add_to_workflow deduped (action <id> ... prior=<first>)`.

---

## 48-hour watch

After deploy, confirm zero same-slot duplicates emitted:

```sql
SELECT entity_id,
       split_part(idempotency_key, '_' || split_part(idempotency_key, '_', array_length(string_to_array(idempotency_key,'_'),1)), 1) AS slot_key,
       event_type, count(*)
FROM system_events
WHERE event_type LIKE 'ghl.appointment_%'
  AND created_at > now() - interval '48 hours'
GROUP BY 1, 2, 3
HAVING count(*) > 1;
```

Expect zero rows where a single (slot, event_type) emitted more than once inside
the window. Investigate any that appear (legitimate re-books across a boundary
show as *different* event_types and are fine).
