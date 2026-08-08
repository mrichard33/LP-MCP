# Claude Code Handoff — Agentic System & Supabase, remaining work

**Prepared:** 2026-08-08, after PRs #648 / #649 / #650
**Databases audited live:** LP (`rcjcgjlqzepicbwhnnjl`), HL (`jtlngmcrtqncimtjjzlz`)
**Every number below was measured, not estimated.** Where something is inferred rather than proven, it says so.

---

## Verified state before starting

The database work is done and holding. Do not redo it.

| | Before | Now |
|---|---:|---:|
| LP projected DB hours/day | 3.75 | **1.18** |
| LP cache hit rate | 67% lifetime | **88–92%** since reset |
| `lp_call_logs` reconciliation | 2,924 ms · 78,649 blocks | 4.5 ms · 16 blocks |
| `lp_notes` push drain | 11,658 ms | 0.217 ms |
| `lp_leads` phone lookup | 281 ms | 1.3 ms |
| HL database size | 8,184 MB | 7,952 MB |
| Invalid indexes | — | **0** |

Agentic layer is otherwise healthy: 0 unprocessed events, 0 stuck pending actions, 2 failed actions in 24h against 3,618 created, circuit breaker closed.

**Read `sql/057` first**, specifically the retraction section. A claim about `NOT (col IS NULL)` not matching partial indexes was propagated through PR #648's commit messages and is **false**. Do not act on it.

---

# P0 — Approval queue silently orphans actions after 72 hours

**This is the highest-value item in this document. It is a live customer-impact bug, not an optimisation.**

### Evidence

```
pending_approval total:                 132
  ├─ older than 24h:                    108
  ├─ older than 7 days:                  80
  └─ older than 72h (orphaned):         102
oldest:                          2026-07-21   (18 days)
distinct contacts affected:              21
```

130 of the 132 come from two rules: `DNC_LIFT_ON_REENGAGEMENT_FIVE9` and `DNC_LIFT_ON_REENGAGEMENT_LP`.

These rules are **not** broken and are **not** normally stuck — across all time they show 767 actions, **598 completed**, 31 rejected. A 78% completion rate. The 130 stuck ones are an anomaly, not the design.

### Root cause

`src/approval-escalation-sweep.js`, line ~43:

```js
const SWEEP_LOOKBACK_HOURS = 72;
```

Used as a **floor** on the only fetch in the sweep:

```js
.eq('status', 'pending_approval')
.gte('created_at', lookbackStart)     // now - 72h   ← the bug
.lte('created_at', escalateBefore)    // now - 30min
```

All three phases operate on that one result set. Once an action passes 72 hours old it leaves the window permanently and becomes invisible to:

- **Phase 1** — GroupMe escalation
- **Phase 2** — auto-execute safe types at 60 min
- **Phase 3** — auto-reject stale `send_message` at 4h

There is no other process that touches `pending_approval`. These actions are stranded forever.

### Compounding factor

Phase 3 only auto-rejects `action_type === 'send_message'`. The stuck actions are `resolve_objection_state` (51), `set_dnd` (48), `set_stage` (31) — none of which are in `SAFE_ACTION_TYPES` either. So they can *only* ever be resolved by a human, and the single GroupMe escalation they each got (all 132 carry `_escalated_at`; zero are un-escalated) was the only notification that will ever be sent. One ping, 18 days ago, then silence.

### Business impact

21 real contacts re-engaged — booked or confirmed an appointment via Five9 or LP after previously being marked DNC — and the action to lift their suppression was never completed. They remain suppressed. This is over-suppression, so it is safe on the compliance side, but it means the system is refusing to contact people who actively asked to be contacted.

### What to change

1. **Remove the lookback floor from the fetch.** It exists to bound the query, but `pending_approval` is a small, self-draining set (132 rows at its worst) — an unbounded fetch on an indexed status column is cheap. If a bound is wanted, use `.limit(500)` with `.order('created_at')`, not a time floor. A bound that silently drops work is worse than no bound.

2. **Give every action type a terminal disposition.** Right now only `send_message` can time out. Add a final backstop — suggest 7 days — that auto-rejects *any* remaining `pending_approval` action with a clear `rejection_reason`, so the queue cannot grow without limit. DNC-lift specifically should probably escalate harder rather than reject, since rejecting leaves the contact suppressed; discuss with Mark before choosing reject vs. escalate for that family.

3. **Re-escalate on a cadence instead of once.** `_escalated_at` is stamped once and then permanently suppresses re-notification. Change to re-escalate if `_escalated_at` is older than, say, 24h, so a genuinely stuck item keeps surfacing.

4. **Add a queue-age alarm.** Every existing alarm watches depth or failure rate. Nothing watches *age*, which is exactly why this ran 18 days unnoticed. Alert when the oldest `pending_approval` exceeds 24h.

### One-time remediation — needs Mark's ruling first

The 132 existing actions need a decision, and **Claude Code should not decide this**. Ask Mark which of:

- **(a)** Approve and execute the 130 DNC-lifts — correct if those 21 contacts genuinely re-engaged.
- **(b)** Reject them and let the rules re-fire naturally on the next re-engagement.
- **(c)** Review the 21 contacts individually first.

Recommend (c) then (a) for anything that checks out. Pull the contact list with:

```sql
SELECT DISTINCT target_id, min(created_at)::date AS since, count(*) AS actions
FROM agent_actions
WHERE status = 'pending_approval' AND rule_applied LIKE 'DNC_LIFT%'
GROUP BY target_id ORDER BY since;
```

### Verification

```sql
-- after the fix + a sweep cycle, expect 0
SELECT count(*) FROM agent_actions
WHERE status = 'pending_approval' AND created_at < now() - interval '72 hours';
```

Then confirm the sweep log reports non-zero `checked` on a cycle where old items exist.

---

# P1 — `conditions` is evaluated, and the Map says it isn't

### The mechanism, verified in source

`src/decision-engine.js:1430`:

```js
const conds = { ...(rule.conditions || {}), ...(rule.context_conditions || {}) };
```

Both columns are merged and evaluated. On a key collision, **`context_conditions` silently wins**.

### Why this is a problem

The **Master System Map states: "Only `context_conditions` is evaluated (when `rule_type='contextual'`); the `conditions` column is documentation-only."**

That is wrong, and it is wrong in the dangerous direction — someone trusting the Map would believe they can edit `conditions` freely, or would misread a rule's real gating. 17 enabled rules currently have non-annotation keys in `conditions`.

### The live collision

`RECONCILE_LP_DNC_ON_LINK` has `has_any_tag` **and** `not_has_tag` present in *both* columns. The `context_conditions` versions win; the `conditions` versions are dead text that reads as if it were active gating. This rule has fired 397 times, most recently today, and it governs **DNC suppression re-assertion** — a compliance-adjacent path where the gap between what the rule appears to do and what it does is exactly the wrong place to have ambiguity.

### What to change

1. **Correct the Master System Map** (§ source-of-truth routing table). State plainly: both columns are merged, `context_conditions` wins on collision. This is a documentation fix but it is the most important part of this item.
2. **Resolve `RECONCILE_LP_DNC_ON_LINK`.** Decide which version of `has_any_tag` / `not_has_tag` is intended, keep exactly one, and null out the other. Reload the Decision Engine afterward and assert the `rules_loaded` delta.
3. **Add a guard query to the sweep / audit tooling** so a collision can never go unnoticed again:

```sql
SELECT rule_key,
       (SELECT array_agg(k) FROM jsonb_object_keys(conditions) k WHERE context_conditions ? k) AS colliding
FROM agent_rules
WHERE conditions IS NOT NULL AND context_conditions IS NOT NULL AND enabled
  AND EXISTS (SELECT 1 FROM jsonb_object_keys(conditions) k WHERE context_conditions ? k);
-- expect zero rows
```

4. **Longer term**, migrate the 17 rules' real keys into `context_conditions` and reduce `conditions` to annotations only — which is what the convention always intended. Do this rule by rule with a reload and a firing check between each, not as a bulk update.

---

# P2 — Five enabled rules have never fired

Joined `agent_actions.rule_applied` against `agent_rules.rule_key`. The join is sound — other rules match cleanly by the same key (`EMAIL_ENRICH_FROM_LP` shows 1,591). A zero here means the rule has genuinely never produced an action.

| Rule | Actions ever |
|---|---:|
| `REPLY_INTENT_BUYING_SIGNAL` | 0 |
| `TRUST_BREAK_ACCURACY` | 0 |
| `PRICE_OBJECTION_RECLASSIFY` | 0 |
| `BEHAVIORAL_DIY_OBJECTION` | 0 |
| `TRUST_REBUILD_HOLD_COMPLETE_TO_S1_1` | 0 |

`REPLY_INTENT_BUYING_SIGNAL` — "Buying Signal Detected (Immediate Momentum Capture)" — is the one to look at first. A never-firing buying-signal rule is a direct revenue miss if the intent was for it to fire.

Also worth a look, enabled but stale: `BEHAVIORAL_SPOUSE_OBJECTION` (last 2026-06-03), `COLD_LEAD_ZERO_DATA` (2026-06-10), `APPT_FRICTION_NO_APPT_TO_HOLD_REENGAGE` (2026-06-30), `EMAIL_ENRICH_FROM_LP` (2026-07-03).

**Approach:** for each, check whether the `event_pattern` matches any event type actually being emitted:

```sql
SELECT DISTINCT event_type, count(*), max(created_at)::date
FROM system_events WHERE created_at > now() - interval '30 days'
GROUP BY event_type ORDER BY 2 DESC;
```

Then compare against the rule's `event_pattern`. Most likely causes, in order of likelihood: the event type was renamed and the pattern was never updated; the `context_conditions` are unsatisfiable; or the rule is genuinely for a rare case. **Do not assume it's a bug** — confirm against emitted events before changing anything. Some of these may be correct and simply waiting for a rare condition.

---

# P3 — Remaining database items

### Sync-engine insert cost (worth measuring, may not be worth fixing)

Now that the read path is fixed, the batch inserts are the largest genuine consumer:

```
lp_activities INSERT   122 calls · 91.9 ms mean · 19,550 blocks read
lp_call_logs  INSERT    52 calls · 195.6 ms mean · 18,894 blocks read
```

Blocks *read* during an INSERT is index-maintenance and unique-constraint probing. `lp_call_logs` carries 5 indexes and a `raw_lp_data` JSONB column that TOASTs. Before changing anything, check whether `raw_lp_data` is actually consumed anywhere — if it is only ever written, dropping it or moving it to a side table would be a large win on the hottest write path in the system. **Measure first; do not drop a column on suspicion.**

### Retention — needs Mark's ruling, do not delete unilaterally

| Table | Size | Reads, lifetime |
|---|---:|---|
| `system_events_filtered` (LP) | 315 MB | 68 index scans, 9 seq scans |
| `lead_events` (HL) | 7,627 MB | **96% of the entire HL database** |
| `lp_activities` (LP) | 1,279 MB | actively used |
| `five9_events_raw` (LP) | 412 MB | actively used |

`lead_events` is the reason HL sits near the 8 GB Pro allowance. `system_events_filtered` is effectively write-only. Both are strong retention candidates, but how much audit history the business must keep is not an engineering decision. Get windows from Mark, then implement as a scheduled partition-drop or dated delete — not an ad-hoc `DELETE`.

### Compute

LP is on Small (512 MB `shared_buffers`, 1.5 GB `effective_cache_size`, 90 connections) against a 6.1 GB database. **Do not size up yet.** The old 67% cache-hit figure was measured while `lp_call_logs` was flushing the whole buffer pool every ten minutes, so it never reflected the real working set. Re-read after 24–48 hours of clean data:

```sql
SELECT round((100.0*sum(shared_blks_hit)/NULLIF(sum(shared_blks_hit)+sum(shared_blks_read),0))::numeric,2)
FROM pg_stat_statements;
```

Sustained above ~95% means Small is right. Below ~85% with the read path already fixed is the signal for Medium.

### Already handed off separately

`docs/handoffs/HL_workflow_sync_write_amplification.md` — HL workflow sync writes ~122M rows to maintain ~33K. Four exact edits, file is 38.7 KB so it needs Claude Code. Not urgent; HL is at 99.9% cache hit.

### Explicitly not done, and why

~125 unused indexes remain, all under 1 MB. Dropping them saves negligible write cost against real risk of breaking a rare query. Only the two large, provably redundant ones were removed (58 MB dead index on LP, 244 MB exact-duplicate on HL). **Leave the rest alone** unless a specific one is shown to be both large and dead.

---

# P4 — Standing backlogs (context, not tasks)

Long-known, unchanged by today's work, listed so they are not mistaken for new regressions:

```
unmapped LP sources            544
unfired milestone triggers  23,576
day-15 untriggered leads   192,904
unresolved sync errors          36
failed syncs / 24h              30  (of 519 — 5.8%)
```

The 30 failed syncs per 24h are largely the known LP API upstream timeout (`Execution Timeout Expired` on the prospect fetch), which retries and succeeds. Confirmed in the deploy logs post-#649. Not caused by any change made today.

---

# Working rules for whoever picks this up

1. **MCP is reality.** Every claim in this document was measured against the live database today. If a query disagrees with this document, the query wins and this document is stale.
2. **`node --check` is not verification.** It is a parse. It cannot catch a dropped `const` — that is how LP MCP went down for 52 minutes on 2026-08-08. `test/executor-heartbeat.smoke.test.js` is the pattern: load the module, call every export, exercise deferred callbacks. For `.ts`, `tsc --noEmit` does catch this class.
3. **Feature branch off `main`, PR, Mark merges.** Never commit to `main`.
4. **Reload the Decision Engine after any `agent_rules` change** — `POST .../n8n/decision-engine/reload-rules` — and assert the `rules_loaded` delta.
5. **Prefer targeted edits over whole-file rewrites**, especially above ~30 KB.
6. **Do not delete customer or audit data** without an explicit ruling from Mark.
