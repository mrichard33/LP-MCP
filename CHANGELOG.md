# Changelog

Notable behavioral changes to the LP MCP server. Newest first.

Rule-layer (`agent_rules`) changes ship through the database, not through this
repo — they are recorded in `sql/seeds/` on the date they were applied live.

## 2026-09-09

Rescission rescue routes to O.0; objection-confirmed tag family normalized to
hyphen; cancel_appointment resolves live on invalid ids; LP→GHL cancel no longer
echoes a second S5.2 route.

- **`src/actions/handlers/rescission.js`** — writes
  `objection-confirmed-competitor` (hyphen), the tag O.0 step 20 actually
  branches on. The colon form it wrote before matched nothing. Header corrected:
  O.RR was never built; the rescue arc is the O.0 competitor branch
  (`fdf4ad82-33ab-4e73-b581-18d21d51ac42`) — PUBLISHED with an active trigger,
  read live as version 157 on 2026-09-09.
- **`src/ghl.js`** — new exported `normalizeTag()`, applied inside
  `applyGHLTag()` and in the `add_tag` handler
  (`src/actions/handlers/tags.js`). Any `objection-confirmed:<value>` is
  rewritten to `objection-confirmed-<value>` at the chokepoint, with a warn
  naming the producer. Covered by `scripts/test-tag-normalize.js`.
- **`src/actions/handlers/appointments.js`** — `executeCancelAppointment` no
  longer trusts a payload `appointment_id`. It verifies the id against the
  contact's live appointment list, falls back to `resolveActiveAppointmentId`
  when the id is not there, retries once after a 400/404, and on final failure
  applies `cancel:failed`, emits a critical `appointment.cancel_failed`, and
  opens a rep task before rethrowing. `executeRescheduleAppointment` resolves
  `old_appointment_id` live when it is absent. Covered by
  `scripts/test-cancel-appointment-resolution.js`.
- **`src/knowledge/contact-appointments.js`** — new
  `fetchRecentAndUpcomingAppointments(contactId, { pastHours = 24 })`. The
  EXISTING APPOINTMENTS prompt block now uses it, so an appointment that ended
  in the last day is still quotable. `fetchUpcomingAppointments` is unchanged
  and still future-only for the double-book guards.
- **`src/response-generator.js`** — a cancel/reschedule companion carrying an
  `appointment_id` that is not in the known list is no longer dropped: the id is
  stripped and logged, and the executor resolves the real appointment live.
- **`src/services/lp-ghl-appointment-reconciler.js`** — the LP→GHL cancel now
  marks the contact reschedule-in-flight before the PUT. Rule 271 already owns
  an LP-originated CXL; without the marker the mirrored cancel also fired rules
  171/107, producing a second task card and a second S5.2 route per
  cancellation (15–17 leads/day).
- **`sql/seeds/2026-09-09_rescission_o0_routing.sql`** — durable record of the
  rule changes applied live the same night, including new rule 356
  `RESCISSION_RESCUE_HUMAN_OWNED`. 280 rules enabled after reload.

Source: Wally Scott post-mortem (GHL `2LT4JDrObOgPlKnn3H0q`, LP 573728).
