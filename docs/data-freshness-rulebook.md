# Data Freshness Rulebook

Supabase is the always-current MIRROR. LP is the system of record. This
document is the rulebook the code in `src/services/freshness.js` enforces.

## 1. What can go stale

A table is a MIRROR when its rows shadow a record that can CHANGE upstream.
Only mirrors get `verified_at` / `verified_from`, and only mirrors count
toward the freshness percentage.

**Mirrors:** `lp_leads`, `lp_prospects`, `lp_notes`, `lp_jobs`,
`lp_job_milestones`, HL `contacts`.

**Not mirrors, and why:**
- *Event logs* — `lp_activities`, `lp_call_logs`, `five9_events_raw`,
  `lp_lead_disposition_history`. A call that happened last Tuesday does not
  become wrong.
- *Derived aggregates* — `lp_source_scorecard_daily`, `lp_appt_fill_hourly`,
  `lp_capacity_slots`. When these are wrong the fix is rerunning the
  derivation, never re-pulling LP.
- *Deliberate snapshots* — `five9_config_snapshots`,
  `lp_link_propagate_undo_*`. Being frozen is the point.

Stamping a non-mirror would dilute the freshness number with 4.6M rows that
cannot be wrong, which makes the number useless.

## 2. Timestamps mean different things

- `synced_at` — the last time we WROTE this row. Moves only on a write.
- `verified_at` — the last time we COMPARED this row against the live upstream
  record, whether or not anything changed.
- `updated_at_lp` / `last_changed` — LP's own idea of when the record changed.
  **Not trustworthy as a staleness signal.** LP does not bump it for every
  edit; that is the defect behind PR #971 and behind the lp_prospects fix.

A row that is correct and untouched for a year has an old `synced_at` and a
fresh `verified_at`. That distinction is the entire reason `verified_at`
exists.

`lp_leads` spells it `lp_verified_at` (sql/120) and every other mirror spells
it `verified_at` (sql/121). Renaming a live column is not additive and would
break every reader, so the two names coexist and `v_supabase_freshness`
reconciles them.

## 3. Field-level precedence

When two systems hold an opinion about the same field, the owner wins.
Without a stated owner, the two writers overwrite each other forever.

**LP wins** — the sales process itself: disposition, appointment set /
date / confirmed / verified, demo completed, closed won, job status, job
value, rep name, setter name.

**GHL wins** — the conversation layer and consent: tags, DNC, consent state,
engagement, last inbound.

**Everything else** — newest verified value wins, compared on `verified_at`.

Enforced by `FIELD_PRECEDENCE` and `mayOverwrite()` in
`src/services/freshness.js`. Change them together, or the doc becomes a lie.

## 4. Findings must carry a write

**Standing rule.** Any sweep, diagnostic, audit or Cowork finding that reports
"Supabase says X, live says Y" is INCOMPLETE until it has also either written
the correction or queued it.

Detection that ends at "noted" is how the 2026-07-28 setter rename sat stale
for four weeks: `lp-name-drift-check.js` was built alert-only and, by its own
header, deliberately does not write. That was the right call for THAT job —
merging two name variants needs a human ruling — but it is the exception, and
the exception has to be argued each time, not assumed.

When writing any new sweep:
- If the correct value is unambiguous (LP returned it for this row), write it.
- If it needs a ruling (merging records, picking between variants), queue it
  in `claude_pending_items` as `decision_needed` and say so in the alert.
- Never leave a third option where the finding is logged and nothing happens.

## 5. The number to watch

```sql
SELECT * FROM v_supabase_freshness;
```

`pct_verified_7d` per mirror table. If it does not climb after a change ships,
something is bypassing the writers — that is the signal, not the sweep counts.

**Read two of these rows differently.** `lp_leads` and `lp_prospects` stamp on
BOTH paths — the write and the matched skip — so their number is a true
verify-rate. `lp_jobs` and `lp_job_milestones` stamp on the write path only,
because their v7.5 skip (`rowIsUnchanged`) returns before any write, and adding
a stamp there would reintroduce the ~2,111-writes-per-pass this repo spent real
effort removing. Their number is therefore a floor: it counts rows that
CHANGED, not rows that were checked. `lp_notes` is the same until
`LP_NOTE_EDIT_MODE` is on.

That is a deliberate trade, not an oversight. If a true verify-rate is ever
needed for jobs or milestones, the cheap way is one rate-limited bulk UPDATE
over the ids the pass compared — the pattern HL-MCP uses for `contacts` — not a
per-row stamp inside the skip.
