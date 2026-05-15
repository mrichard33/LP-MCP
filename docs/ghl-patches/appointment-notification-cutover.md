# GHL Patch List — Appointment Notification Cutover

**Effective:** 2026-05-15
**Owner:** Mark Richard
**Scope:** Workflow `5004d175-56d8-4973-a39d-554632d6e2f2` (Window
Estimate appointment status). Apply patches in the GHL UI by hand —
nothing in this file is auto-applied.

This document describes the GHL-side patches required to cut the
Cancelled and Rescheduled appointment paths over from the legacy
generic notification to the new enriched email + SMS notification
served by `POST /api/agentic/notifications/appointment` in LP-MCP.

Email + SMS delivery still happens via the workflow's existing
`internal_notification` steps. The LP-MCP endpoint only writes the
two rendered bodies and the gate field onto the contact; GHL picks
those up via merge tags. **The existing GroupMe Lead Intelligence
Group notifications are untouched** by this build.

---

## 1. Preflight

### 1a. Confirm the 4 custom fields exist on Contact

These were created in advance. Re-confirm in
**Settings → Custom Fields → Contact**:

| Display name             | Type                       | Field ID                       |
|--------------------------|----------------------------|--------------------------------|
| Team Notification Body   | Multi-line text            | `6QiD72PwJ19c6cOYn9CJ`         |
| Team Notification SMS    | Single-line text           | `hui6Hf1qCcSaMo8CdQ2h`         |
| Team Notification ID     | Single-line text           | `CiX3gdl6ZwMsR4oNnfvW`         |
| Team Notification Ready  | Single-option (Yes / No)   | `MEOZht487Smca64vM7rt`         |

### 1b. Set the env vars on Railway (LP-MCP service)

```
GHL_FIELD_TEAM_NOTIFICATION_BODY=6QiD72PwJ19c6cOYn9CJ
GHL_FIELD_TEAM_NOTIFICATION_SMS=hui6Hf1qCcSaMo8CdQ2h
GHL_FIELD_TEAM_NOTIFICATION_ID=CiX3gdl6ZwMsR4oNnfvW
GHL_FIELD_TEAM_NOTIFICATION_READY=MEOZht487Smca64vM7rt

ENABLE_ENHANCED_APPT_NOTIFICATIONS=false   # flip to true on cutover
```

### 1c. Run the migration

In Supabase SQL Editor (or via `supabase_run_query`), execute
`sql/migrations/2026-05-15_lp_agentic_notifications.sql`. This
creates `lp_agentic_notifications`.

### 1d. Smoke the disabled endpoint

With `ENABLE_ENHANCED_APPT_NOTIFICATIONS=false`, a POST to
`/api/agentic/notifications/appointment` should return HTTP 503
with `{ "ok": false, "error": "feature_disabled" }`. That confirms
the safety net is in place: until the flag flips, the GHL workflow's
30-min wait will time out and the fallback branch fires the legacy
notification.

---

## 2. Cancelled path

**Workflow:** `5004d175-56d8-4973-a39d-554632d6e2f2`
**Existing webhook step:** `2846360b-4452-4b99-8377-8aa4dcb0a2c3`

### 2a. Update the Layer 3 webhook step

| Setting | New value |
|---------|-----------|
| Method  | `POST` |
| URL     | `https://lp-mcp-production.up.railway.app/api/agentic/notifications/appointment` |
| Headers | `Authorization: Bearer {{custom_values.message_engine_token}}` |
|         | `Content-Type: application/x-www-form-urlencoded` |

Replace customData with the 20-key contract below. **Critical
per-workflow values are pre-filled for this path.**

| key                  | value (merge tag or literal)                  |
|----------------------|-----------------------------------------------|
| contact_id           | `{{contact.id}}`                              |
| contact_name         | `{{contact.name}}`                            |
| contact_first_name   | `{{contact.first_name}}`                      |
| contact_last_name    | `{{contact.last_name}}`                       |
| contact_phone        | `{{contact.phone}}`                           |
| contact_email        | `{{contact.email}}`                           |
| status               | `cancelled`                                   |
| calendar_id          | `aJj14ONxh1oFyDcQ706O`                        |
| appointment_title    | `Window Estimate`                             |
| start_time           | `{{contact.last_appointment_start_time}}`     |
| start_date           | `{{contact.last_appointment_start_date}}`     |
| previous_start_time  | (leave blank — Cancelled doesn't need it)     |
| previous_start_date  | (leave blank)                                 |
| lp_source            | `{{contact.lp_source}}`                       |
| lp_subsource         | `{{contact.lp_subsource}}`                    |
| assigned_user        | `{{contact.assigned_to}}`                     |
| city                 | `{{contact.city}}`                            |
| postal_code          | `{{contact.postal_code}}`                     |
| lifecycle_stage      | `{{contact.lifecycle_stage}}`                 |
| trust_state          | `{{contact.trust_state}}`                     |

### 2b. Insert a wait-for-condition step immediately after the webhook

Clone the structure of step #18 of workflow
`f99fba97-6d2f-4fd6-966c-b5e5e36f8938` (the S4.5 wait pattern).

| Setting              | Value |
|----------------------|-------|
| Type                 | Wait — Multi-path |
| Condition            | `contact.team_notification_ready == "Yes"` |
| Timeout              | 30 minutes |

### 2c. Wait-success branch — update the existing internal_notification bodies

Locate the existing `internal_notification` steps. Update only the
body field on each; **leave recipients (Dispatch / Edwin / Trudy /
Jazmine) unchanged**.

| Step ID                                | Channel | New body merge tag                          |
|----------------------------------------|---------|---------------------------------------------|
| `7d33778c-7a06-48b8-9032-c7b082f8f6d1` | Email   | `{{contact.team_notification_body}}`        |
| `91639457-ce66-4707-946f-523d19c91061` | SMS     | `{{contact.team_notification_sms}}`         |

### 2d. After the SMS step, insert a cleanup step

Type: `update_contact_field`. Set the 4 fields back to empty / No so
the next cycle starts clean:

| Field                       | Value |
|-----------------------------|-------|
| `team_notification_body`    | `""`  |
| `team_notification_sms`     | `""`  |
| `team_notification_id`      | `""`  |
| `team_notification_ready`   | `No`  |

### 2e. Wait-timeout branch — fallback

On the timeout side of the wait, route to the same two
`internal_notification` steps but leave them with the **current
generic fallback content** they already have (do not edit those
bodies — they are the safety net). Add a tag step that applies
`notif-fallback-fired` to the contact for audit.

---

## 3. Rescheduled path

**Existing webhook step:** `2714e1b5-c16d-40b9-ace5-b67ce607b4db`

Same 5-step structure as the Cancelled path with three differences:

1. customData `status=rescheduled` and the two extra keys are
   populated:

   | key                  | value |
   |----------------------|-------|
   | status               | `rescheduled` |
   | previous_start_time  | `{{contact.previous_appointment_time}}` |
   | previous_start_date  | `{{contact.previous_appointment_date}}` |

   (All other keys identical to the Cancelled customData table.)

2. The internal_notification step IDs on the wait-success branch are
   different:

   | Step ID                                | Channel | New body merge tag                    |
   |----------------------------------------|---------|---------------------------------------|
   | `8bca9835-fcd8-4f20-a586-951629ae06e8` | Email   | `{{contact.team_notification_body}}`  |
   | `7a66f7d7-15a9-4962-ab76-0e80081149af` | SMS     | `{{contact.team_notification_sms}}`   |

3. The wait + cleanup + fallback steps follow the same pattern as
   Cancelled (sections 2b–2e).

---

## 4. Calendar-agnostic reuse pattern (future workflows)

To add a new appointment workflow on another calendar (roofing
estimate, in-home consult, etc.):

1. Clone the webhook + wait + cleanup + fallback pattern from this
   doc into the new workflow.
2. In customData, change only:
   - `calendar_id` to the new calendar's GHL ID
   - `appointment_title` to the human-readable name shown in the
     bodies (e.g. `Roof Estimate`, `In-Home Consult`)
   - `status` if the trigger is different
3. Point the email/SMS internal_notification step bodies at the same
   merge fields (`{{contact.team_notification_body}}` and
   `{{contact.team_notification_sms}}`).
4. **Zero code changes required in LP-MCP.**

To enable a new status (e.g. Booked, Confirmed): one-line append to
`ENABLED_NOTIFICATION_STATUSES` in
`src/notifications/appointment-notifications.js`, redeploy, then
extend this patch list with the new workflow step IDs.

---

## 5. Cutover sequence

Do the steps in this order. Each step has a clean rollback if the
next one fails.

1. **Deploy LP-MCP** with `ENABLE_ENHANCED_APPT_NOTIFICATIONS=false`
   and the 4 `GHL_FIELD_TEAM_NOTIFICATION_*` env vars set. Verify the
   endpoint returns 503 (safety net active).
2. **Run the SQL migration** in Supabase. Confirm
   `lp_agentic_notifications` exists.
3. **Apply patches to the Cancelled path** in the GHL UI (sections
   2a–2e). Save the workflow but leave the env flag off.
4. **Flip the flag** `ENABLE_ENHANCED_APPT_NOTIFICATIONS=true` on
   Railway.
5. **Trigger a test cancellation** on a non-production test contact.
   Verify:
   - The endpoint returns 200 with a `notification_id`.
   - GHL contact shows `team_notification_body`,
     `team_notification_sms`, `team_notification_id` populated and
     `team_notification_ready = "Yes"`.
   - An email arrives to Dispatch / Edwin / Trudy / Jazmine with
     the enriched body. An SMS arrives similarly.
   - After the GHL workflow runs the cleanup step, all 4 fields
     are reset.
   - `lp_agentic_notifications` has one row with `error = null` and
     `ghl_writeback_at` populated.
6. **Repeat steps 3 + 5 for the Rescheduled path** (section 3).
7. **Sign off.** Build complete.

### Rollback

If anything looks wrong at step 5 or 6:

- Set `ENABLE_ENHANCED_APPT_NOTIFICATIONS=false`.
- The endpoint will return 503; the GHL workflow's wait will time
  out at 30 min and the fallback branch fires the legacy
  notification. Reps still get notified — just with the generic
  body instead of the enriched one.
- Investigate via `lp_agentic_notifications` (look for rows with
  `error IS NOT NULL`) and Railway logs.

---

## 6. Verification matrix (live checks)

These are manual smoke tests against the deployed endpoint with the
flag on. Run them once after cutover.

| Check                                        | How                                                                                     | Pass criteria                                                                                                  |
|----------------------------------------------|-----------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------|
| Calendar-agnostic title                      | curl the endpoint with `appointment_title=Roof Estimate`                                | Both `team_notification_body` and `team_notification_sms` on the test contact contain "Roof Estimate" and neither contains "Window Estimate" |
| Live per-contact data                        | Edit a custom field on the test contact in GHL UI, fire the endpoint again              | Regenerated body reflects the edit immediately (no Supabase-sync wait)                                          |
| Aggregate close-rate intel                   | Inspect the email body                                                                  | "Source intel: N closed of M (X% close rate, last 90d)" line appears when `lp_source`/`lp_subsource` provided   |
| Empty source graceful                        | curl with `lp_source=""` and `lp_subsource=""`                                          | Email shows `Source: not on file`; `data_gaps` contains `source_intel_unavailable:empty_lp_source`              |
| SMS cap                                      | Inspect `team_notification_sms` after generation                                        | ≤300 chars                                                                                                      |
| Failure → fallback                           | Set `GHL_FIELD_TEAM_NOTIFICATION_SMS` to a bogus ID, fire endpoint                      | Endpoint returns 5xx; `team_notification_ready` stays `No`; after 30 min, GHL fallback branch fires and `notif-fallback-fired` tag is applied. Restore env. |
| Audit log on success path                    | Query `lp_agentic_notifications` after a successful run                                 | One row with `email_body`, `sms_body`, `ghl_writeback_at` populated and `error = null`                          |
| Audit log on failure path                    | Same after the bogus-id test above                                                      | One row with `error LIKE '%ghl_writeback%'` and `ghl_writeback_at IS NULL`                                      |
