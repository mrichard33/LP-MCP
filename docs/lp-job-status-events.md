# LP job status changes — `lp.job_status_changed`

**Added:** 2026-09-18
**Code:** `src/services/job-status-change.js` (pure), `src/sync-children.js` (emitter)
**Consumers:** `P2_JOB_TERMINAL_LOST`, `P2_JOB_TERMINAL_WON` (`agent_rules`)

## Why

LP job STATUS changes reached nothing.

Milestones have had an event since v7.1 — `lp.milestone_completed` fires ~1,200×/week and the
`P2_MILESTONE_*` rule family moves opportunities on it. Job status had no equivalent. A job going
`Awaiting Product` → `Cancelled` in LP emitted nothing at all: no `lp.job_status_changed` anywhere in
the repo, and no such `event_type` in `system_events`.

So a cancellation in LP never reached GHL and the P2 opportunity stayed open forever. Measured
2026-09-18: **241 of a 249-job sample of dead LP jobs were still open in P2.**

`scripts/reconcile-p2-stages.js` repairs that backlog once. This event is what stops it refilling.

## The event

| field | value |
|---|---|
| `event_type` | `lp.job_status_changed` |
| `event_subtype` | the NEW `job_status` |
| `source` | `lp_sync` |
| `entity_type` / `entity_id` | `job` / `lp_job_id` |
| `previous_state` / `new_state` | `{ job_status }` before and after |
| `idempotency_key` | `job_status_<id>_<old>_<new>_<YYYY-MM-DD>` |

```json
{
  "lp_job_id": "93400", "lp_lead_id": "418822", "ghl_contact_id": "PIDxmWzCs35NHgW85vOW",
  "old_status": "Awaiting Product", "new_status": "Cancelled",
  "job_value": 12000, "branch_code": "FTMYR"
}
```

`event_subtype` is the new status so a rule can gate on it with `event_subtype_in` without reading
the payload — the same shape `lp.disposition_changed` uses, and the reason the `P2_JOB_TERMINAL_*`
rules need no I/O-backed condition to decide.

`old_status` is carried because the stories differ. `Awaiting Product` → `Cancelled` is a job that
died mid-production; `New` → `Cancelled` is one that never started. Neither a rule nor a person
reading the table later can tell them apart from the new status alone.

## The emitter

`syncJobAndMilestones` in `src/sync-children.js`, immediately after the `lp_jobs` upsert succeeds.

**On an actual change only.** The job-changes sweep re-delivers the same jobs every pass. Emitting
per sync rather than per change would file ~160 no-op events a day, and an engine re-evaluating a
terminal rule on a status that did not move is one approval queue away from doing the same write
twice. The prior status costs nothing: `existingJob` is already read for the v7.5 skip gate and
`JOB_COMPARE_COLUMNS` already carries `job_status`. A real change always defeats that gate, so the
skip can never swallow one.

**Never on a job we have never seen.** `existing === null` is either a brand-new job or a failed read
— indistinguishable, since supabase-js resolves with `{ error }` and `data: null`. Both answer "no
event". A new job has no prior status to have moved from, and a failed read is the `active: null`
case from the alerting doctrine: could not tell, so touch nothing. Announcing a transition from a
status we failed to read would invent the `old_status` the event exists to carry.

**After the upsert, not before.** A failed parent write returns early and never reaches the emit.
Announcing a transition that did not persist would leave the next pass unable to detect it — the
stored status would still be the old one, so it would fire again — or make a rule act on a row that
does not say what the event says.

**Emitted even with no `ghl_contact_id`.** A status change is a true record whether or not the job's
lead is linked. The engine already handles the unlinked case: a GHL-targeted action on a contactless
event is recorded `skipped`, never executed (`src/decision-engine.js`). Gating the emitter on the
contact would lose the record instead. The contact id falls back
`ghlContactId || existingJob?.ghl_contact_id || null` — the job-changes sweep passes `null` for every
record — and `lp_lead_id` is always passed so `emitEvent`'s emit-time binding gets a final shot.

**Never fails the sync.** Wrapped in try/catch, logged and continued. LP is the source of truth for
the job either way, and `scripts/reconcile-p2-stages.js` is the backstop for anything dropped.

## It depends on an allowlist entry, and that is the failure mode to know

`emitEvent` runs every emit through `applyIntakeFilter` first, and `ALLOWED_EVENT_TYPES` in
`src/services/event-intake-filter.js` is **default-DROP**. Without the `'lp.job_status_changed'`
entry the emitter works perfectly, every event lands in `system_events_filtered` with reason
`event_type_not_in_allowlist`, and both rules are dead in total silence.

The emitter therefore classifies what `emitEvent` returned rather than assuming a non-throw means a
write — `emitEvent` returns `{ filtered: true }` or `null` without throwing, which is how 27
appointment-parity escalations reached nobody for months. A `dropped_at_intake` result logs at
**error** level and names the file to fix.

## Consumers

Both rules ship in `sql/seeds/2026-09-18_p2_job_status_terminal_rules.sql`, applied by hand after the
emitter deploys and a real event is confirmed to land.

| rule | fires on `event_subtype` | does |
|---|---|---|
| `P2_JOB_TERMINAL_LOST` | Cancelled · Cancelled By Mgt · Dead Deal · Sent To Attorney · Credit Decline | `update_opportunity` → P2 `lost` |
| `P2_JOB_TERMINAL_WON` | Paid In Full · PIF Survey Ready · PIF NO Survey · Assumed Complete | `update_opportunity` → P2 `won` |

Both `requires_approval: true`. Lost is irreversible; won moves reported revenue.

`Installed & Unpaid` is in neither: the work is done, the money is not collected, and counting it won
overstates revenue.

**The lost reason is not in the template — it cannot be.** The rule fires on five statuses that map
to four different reasons, and `action_template` is static config. The `update_opportunity` wrapper
in `src/actions/index.js` reads the source event's `event_subtype` and maps it through
`JOB_STATUS_LOST_REASON` in `src/lp-lost-reasons.js` — the same table
`scripts/reconcile-p2-stages.js` checks its `--lost-reason-id` pairing against, so a loss written by
the rule and one written by the repair pass carry the same reason. A status with no mapping fails the
action loudly rather than writing a reasonless loss.

## Reading it

```sql
SELECT json_agg(row_to_json(s)) FROM (
  SELECT event_type, event_subtype, created_at, payload
    FROM system_events
   WHERE event_type = 'lp.job_status_changed'
   ORDER BY created_at DESC LIMIT 10
) s;
```

Zero rows after a sync cycle, with jobs known to have changed status, means the allowlist entry is
missing. Check `system_events_filtered` before concluding the emitter is broken.
