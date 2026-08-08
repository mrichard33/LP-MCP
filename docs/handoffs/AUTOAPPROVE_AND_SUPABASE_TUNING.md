# Claude Code Handoff — Auto-approve, dead rules, and Supabase platform tuning

**Prepared:** 2026-08-08
**Requested by Mark:** remove the approval requirement entirely (there is no front-end UI to approve with), auto-unsuppress DNC on re-engagement, fix the five never-firing rules, and audit which Supabase platform features we should be using.
**Everything below was measured live today.** Where something is inference rather than proof, it says so.

---

## Order of work

1. **§1 Auto-approve** — highest value, unblocks 21 real leads
2. **§2 Dead rules** — three are a config-only fix, no deploy
3. **§3 pg_cron** — unlocks maintenance the platform currently can't do
4. **§4** everything else, in the order listed

Do §1 and §2 first. They are independent of each other and of §3+.

---

# §1 — Remove approval gating

## What Mark asked for, and the one adjustment

Mark's requirement: nothing should ever wait for a human, because there is no UI to approve with. That is correct as a goal — the approval queue today is a dead-letter box, not a control.

**One adjustment.** Do *not* implement this as a global `AUTO_APPROVE_ALL=true` flag. Two reasons:

1. It would also auto-fire `send_message` — the only action a customer directly sees, and the only one that is irreversible if wrong. Today's queue happens to contain no `send_message`, but the flag would apply to every future rule too.
2. DNC lifting is the compliance-sensitive path. Auto-lifting on *genuine re-engagement* is defensible — the consumer initiated contact by booking or confirming an appointment. Auto-lifting on *anything* is not. The distinction has to survive in the code, not just in someone's memory.

So: **narrow auto-approve keyed to action type, notify-don't-gate, full audit trail, small explicit deny-list.** Same outcome for Mark — nothing to approve — without a switch that can't be reasoned about in six months.

## 1a. Fix the orphaning bug first

`src/approval-escalation-sweep.js` line ~43:

```js
const SWEEP_LOOKBACK_HOURS = 72;
```

Used as a **floor** on the only fetch the sweep makes:

```js
.eq('status', 'pending_approval')
.gte('created_at', lookbackStart)     // now - 72h   ← the bug
.lte('created_at', escalateBefore)
```

All three phases read that one result set. Past 72 hours an action leaves the window permanently and no phase sees it again. Nothing else touches `pending_approval`.

Measured: **132 pending_approval, 102 past the floor, oldest 2026-07-21 (18 days).**

**Fix:** delete the `.gte(lookbackStart)` line. If a bound is wanted use `.limit(500)` with `.order('created_at')` — a bound that drops work silently is worse than no bound. `pending_approval` is small and `status` is indexed.

Do this even though §1b will mostly drain the queue — otherwise the same trap catches whatever §1b's deny-list leaves behind.

## 1b. Auto-approve at the point of creation

Better than post-hoc sweeping: don't create the action as `pending_approval` in the first place when it's on the auto-approve list.

Find where `requires_approval` is set from the rule's `action_template` (in `src/decision-engine.js`, around where actions are queued). Add a resolver:

```js
// 2026-08-08 — Mark has no approval UI, so pending_approval is a dead-letter
// state, not a control. Rather than a blanket AUTO_APPROVE_ALL flag, actions
// are auto-approved by type. The deny-list is what stays gated, and it is
// deliberately short: send_message is the only thing a customer directly sees
// and the only irreversible one.
//
// Anything auto-approved still emits a system_event and a GroupMe notice —
// notify, don't gate. Mark sees what happened; he just isn't a bottleneck.
const APPROVAL_DENY_LIST = new Set(
  (process.env.APPROVAL_REQUIRED_ACTION_TYPES || 'send_message')
    .split(',').map(s => s.trim()).filter(Boolean)
);

function resolveRequiresApproval(rule, action) {
  if (process.env.APPROVAL_GATING_DISABLED === 'true') return false;
  if (!rule.requires_approval) return false;
  return APPROVAL_DENY_LIST.has(action.action_type);
}
```

`APPROVAL_REQUIRED_ACTION_TYPES` as an env var means Mark can add a type back under gating without a deploy.

Set `approved_by = 'auto_approved_by_policy'` and `approved_at = now()` on anything that skips the gate, so the audit trail distinguishes it from a human approval and from `auto_escalation_60min`.

**Leave `agent_rules.requires_approval` alone.** It still records intent — "this rule is sensitive" — and it drives whether a GroupMe notice fires. Overwriting the column would destroy that signal.

## 1c. DNC lift on re-engagement — the specific ask

`DNC_LIFT_ON_REENGAGEMENT_FIVE9` and `DNC_LIFT_ON_REENGAGEMENT_LP` produce `resolve_objection_state`, `set_dnd`, `set_stage`. None are on the deny-list, so §1b auto-approves them.

Before shipping, confirm the rules' gating is tight enough to carry that weight. Read both rules' `context_conditions` and verify the trigger really is an inbound, consumer-initiated event — `event_subtype_in` should be appointment set / confirmed / verified, not merely "contact record touched". These rules already run at a 78% approval rate (767 all-time, 598 completed), so the gating is probably sound, but **verify it rather than assume** — this is the one path where a wrong auto-approve has legal consequence.

Send a GroupMe notice on every auto-approved DNC lift. Mark should still *see* each one; he just shouldn't have to click.

## 1d. The 132 already stuck — Mark must rule

Do **not** bulk-approve these silently. Once §1b ships, new ones flow automatically; the backlog is a separate decision. Give Mark this list and ask:

```sql
SELECT target_id,
       min(created_at)::date AS stuck_since,
       count(*) AS actions,
       string_agg(DISTINCT action_type, ', ') AS types
FROM agent_actions
WHERE status = 'pending_approval' AND rule_applied LIKE 'DNC_LIFT%'
GROUP BY target_id ORDER BY stuck_since;
```

21 contacts. Recommend spot-checking a handful against LP for a real appointment before releasing the rest.

## 1e. Backstop + alarm

- Any `pending_approval` older than 7 days → auto-reject with a clear `rejection_reason`, so the queue can never grow unbounded again.
- Alert when the **oldest** `pending_approval` exceeds 24h. Every current alarm watches depth or failure rate; nothing watches age, which is exactly why this ran 18 days unseen.
- Re-escalate if `_escalated_at` is older than 24h instead of stamping once forever.

## Verification

```sql
-- after deploy, expect 0 new pending_approval outside the deny-list
SELECT action_type, count(*) FROM agent_actions
WHERE status='pending_approval' AND created_at > now() - interval '1 hour'
GROUP BY 1;
```

---

# §2 — The five rules that have never fired

**Root cause found: the event vocabulary drifted.** Three rules match on `event_subtype` values that no emitter produces.

Measured over 30 days:

| event_type | subtypes actually emitted |
|---|---|
| `ai.analysis_completed` | `stage_1` … `stage_5` |
| `ghl.reply_received` | `pending_analysis`, `dnc` |
| `agentic.hold_completed` | *(none emitted at all)* |

| Rule | `event_pattern` subtype | Emitted? | Diagnosis |
|---|---|---|---|
| `TRUST_BREAK_ACCURACY` | `objection_detected` | ❌ | dead — pattern mismatch |
| `PRICE_OBJECTION_RECLASSIFY` | `objection_detected` | ❌ | dead — pattern mismatch |
| `REPLY_INTENT_BUYING_SIGNAL` | `positive` | ❌ | dead — pattern mismatch |
| `TRUST_REBUILD_HOLD_COMPLETE_TO_S1_1` | `trust_rebuild_reengage_complete` | ❌ | no upstream events |
| `BEHAVIORAL_DIY_OBJECTION` | *(no subtype)* | ✅ | **matches — different cause** |

## The good news

The analyzer already emits everything these rules need, just under a different subtype. A live `ai.analysis_completed` payload contains:

```
objection_type: "price"      engagement_quality: "meaningful"
buying_signals               objection_confidence
buyer_stage: "4"             recommended_action
emotional_state              fast_track_eligible
```

So **three of the five are a config-only fix** — `agent_rules` edit plus a Decision Engine reload. No deploy.

Use operators already proven to work in production: `objection_type_eq` and `engagement_quality_eq` both fire correctly in `BEHAVIORAL_DIY_OBJECTION`'s `context_conditions`.

**Pattern for each:** drop the wrong `event_subtype` from `event_pattern`, move the real gating into `context_conditions` using payload-backed operators.

⚠️ **Before writing them, confirm which operators the engine actually implements.** `TRUST_BREAK_ACCURACY` and `PRICE_OBJECTION_RECLASSIFY` currently use `all_of` with named string tokens (`"objection_type_is_price"`, `"spec_mismatch_or_angry_sentiment"`), and `REPLY_INTENT_BUYING_SIGNAL` uses `any_of` with `"reply_contains_yes"` etc. **I did not verify that `all_of`/`any_of` or any of those tokens are implemented.** Unknown operators fail closed, so they may be a second, independent reason these never fired. Grep the condition evaluator in `src/decision-engine.js` for the supported operator list and rewrite to match it. Do not assume the tokens work just because they're in the database.

## The other two

- **`TRUST_REBUILD_HOLD_COMPLETE_TO_S1_1`** — waits on `agentic.hold_completed`. Its upstream, `APPT_FRICTION_NO_APPT_TO_HOLD_REENGAGE`, last fired 2026-06-30. Fix the upstream first; this rule may be fine and simply starved. Its `conditions` holds a `summary` key, which is not in the allowed annotation set (`description`/`notes`/`_comment`/`_doc`) — move that text to `notes` so it can't be evaluated as an operator.
- **`BEHAVIORAL_DIY_OBJECTION`** — genuinely matches events. Its `context_conditions` require a post-demo tag **AND** `objection_type = diy` **AND** `engagement_quality = meaningful`. That is a narrow AND and may simply be rare. **Check frequency before changing anything:**

```sql
SELECT count(*) FROM system_events
WHERE event_type = 'ai.analysis_completed'
  AND payload->>'objection_type' = 'diy'
  AND payload->>'engagement_quality' = 'meaningful'
  AND created_at > now() - interval '90 days';
```

If that returns 0, the rule is correct and waiting. Leave it.

**Reload after every change** — `POST .../n8n/decision-engine/reload-rules` — and assert the `rules_loaded` delta. Change one rule at a time and confirm firing before the next.

---

# §3 — Supabase platform features

Answering Mark's list directly, including where the answer is "no".

## Extensions

Installed: `pg_stat_statements`, `pg_trgm`, `pgcrypto`, `plpgsql`, `supabase_vault`, `uuid-ossp`, `vector`.

### Install: `pg_cron` — highest value

Nothing else on this list comes close. It unblocks maintenance the platform currently **cannot** do: `VACUUM` and `CREATE INDEX CONCURRENTLY` cannot run through any MCP path because every one wraps statements in a transaction. That is why `sql/058` had to build indexes non-concurrently under a lock timeout, and why bloat is only manageable via autovacuum thresholds.

With `pg_cron`, schedule inside the database:

```sql
SELECT cron.schedule('vacuum-churn-tables', '0 4 * * *',
  $$VACUUM (ANALYZE) lp_call_logs, lp_activities, five9_events_raw, lp_prospects$$);

SELECT cron.schedule('refresh-agmsg-perf', '15 * * * *',
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY mv_agentic_message_performance$$);
```

It also becomes the right home for retention (§4) once Mark rules on windows. Start with the two jobs above; don't move existing Node schedulers into cron — the executor and Decision Engine heartbeats need application context.

### Install temporarily: `index_advisor` + `hypopg`

Directly answers Mark's indexes question. `hypopg` creates *hypothetical* indexes so you can test whether one would help **without building it** — exactly the tool for the residual questions left by `sql/057`/`058`. Run it against the current top `pg_stat_statements` entries, act on anything with a large predicted improvement, then uninstall both. They are a diagnostic, not a runtime dependency.

### Consider: `pg_net`

Async HTTP from inside Postgres. Would let a trigger fire a webhook directly rather than waiting for a poll cycle — relevant to "the bot responds faster." **But** it moves control flow out of the application and into the database, where it is much harder to debug, and it bypasses the GHL rate limiter that exists for good reason (see the 2026-06-05 token-starvation incident). **Recommend not now.** Revisit only if latency is measured and traced to poll interval, not assumed.

### Do not install

- **`pgmq`** — a real queue would be architecturally cleaner than polling `agent_actions`, but replacing the action queue touches the executor, the heartbeat, idempotency and the reaper simultaneously. Enormous change, no current pain: 0 stuck pending actions, 2 failures in 24h against 3,618 created. Not now.
- **`postgis`, `pgroonga`, `plv8`, `pg_graphql`, `pg_hashids`, `pgsodium`, `pgtap`, `pgaudit`** — no current use case. `pgaudit` becomes interesting only if a compliance requirement appears.

## Indexes

Largely done today. Ongoing discipline, not a project:

- **Zero invalid indexes** currently — keep it that way; check after any `CONCURRENTLY` build.
- **~125 unused indexes remain, all under 1 MB.** Deliberately left. Dropping them saves negligible write cost against real risk of breaking a rare query. Only remove one if it is shown to be both large and dead — as with the 58 MB `idx_sef_filter_reason` and the 244 MB duplicate on HL.
- Re-read the top of `pg_stat_statements` weekly. Cheap, and it is what surfaced the buffer-pool eviction that four rounds of work had missed.

## Enumerated types — recommend **against**

Currently zero enums; status-like columns are `TEXT`. Mark asked whether to adopt them. **Don't.**

The gain is marginal — a few bytes per row and slightly faster equality. The cost is real: adding a value requires `ALTER TYPE`, values cannot be removed, and every enum change is a migration. `agent_actions.status`, `event_type` and `action_type` all evolve regularly in this system; enums would turn routine additions into schema migrations for no measurable performance benefit.

`TEXT` plus a `CHECK` constraint gives the same validation with none of the rigidity. This is a case where using the feature would make the system worse.

## Triggers

26 user triggers. One finding worth acting on: **`agent_actions` fires three separate triggers on a table taking 1,128,601 writes.**

```
agent_actions_enrich              → agent_actions_enrich_on_insert
trg_agent_actions_default_priority → agent_actions_default_priority
trg_agent_actions_updated          → update_agent_actions_timestamp
```

`system_events` similarly carries `trg_system_events_default_priority_lane` on 1,533,966 writes.

The two `BEFORE INSERT` triggers on `agent_actions` (enrich + default_priority) do related work and can merge into one function — roughly a third off per-row trigger overhead on the hottest write path in the agentic layer. Keep the `updated_at` trigger separate; it is `BEFORE UPDATE` and has different semantics.

**Measure first.** Time an insert batch before and after; if the delta is under a few percent, don't bother. Merging triggers is the kind of change that is easy to get subtly wrong for a small win.

## Functions

172 in `public`. Two notes:

- `get_close_rate_by_source()` measured **787 ms** per call. Reporting RPC, low frequency, so it is not urgent — but if the dashboard calls it per page load it is worth an `EXPLAIN`.
- Only **one materialized view** exists (`mv_agentic_message_performance`) and both its indexes show zero scans. Either it is not being queried, or consumers hit the underlying tables instead. Worth ten minutes to find out — a matview nobody reads is pure refresh cost.

## Policies and roles — no change recommended

**124 of 147 tables have RLS enabled with zero policies.** That looks alarming and isn't. RLS with no policy is **deny-all** for `anon` and `authenticated`; `service_role` bypasses RLS entirely. Since LP MCP connects with the service-role key, everything works and nothing is exposed. It fails closed, which is the correct posture for a service-role-only backend.

**Do not "fix" this by adding policies.** Adding permissive policies to tables that currently deny everything would *open* access that is presently closed. The only real hardening available is a dedicated **read-only role** for the dashboard and reporting instead of sharing the service-role key — worth doing when someone touches dashboard auth, not as a standalone task.

## Schema visualizer

A viewer, not a feature to enable. Useful for onboarding; nothing to implement. The architecture boards (Board A/B/C) are the real system documentation.

---

# §4 — Two things worth more than most of §3

## The vector knowledge base is built and unused

```
kb_embeddings                    3,289 rows, 68 MB
idx_kb_embeddings_vec scans          0   (lifetime)
kb_embeddings total reads          216   (lifetime)
```

`pgvector` 0.8.0 is installed, 3,289 embeddings are loaded, and **the vector index has never been used once.** Alongside it sit `kb_faqs`, `kb_objection_scripts`, `kb_proof_points`, `kb_intent_handlers` — all with unused indexes.

If the agentic bot is supposed to ground its replies in this knowledge base and isn't, that is a direct answer-quality gap and by far the biggest item in this document for "the bot responds better." Trace whether the response generator calls the match/search function at all. This may be a wiring gap rather than a performance issue — find out before optimising anything else in the response path.

## Retention — needs Mark's ruling, do not delete unilaterally

| Table | Size | Lifetime reads |
|---|---:|---|
| `system_events_filtered` (LP) | 315 MB | 68 index scans, 9 seq scans |
| `lead_events` (HL) | 7,627 MB | **96% of the entire HL database** |

`lead_events` is why HL sits near the 8 GB Pro allowance. `system_events_filtered` is effectively write-only. Both are strong retention candidates and both become one-line `pg_cron` jobs once §3 lands — **but how much audit history the business must keep is not an engineering decision.** Get windows from Mark first.

---

# §5 — Documentation correction

The **live Notion Master System Map is already correct** — it carries a note that the "only `context_conditions` is evaluated" claim was true until 2026-07-03 and no longer holds. No edit needed there.

The **stale copy is the exported PDF in project knowledge** (`Master_System_Map__Routing_Guide.pdf`), which still asserts `conditions` is documentation-only. Re-export it from Notion so the two agree. An earlier note in this repo said the Map itself was wrong; that was incorrect and is retracted here.

The underlying behaviour, verified at `src/decision-engine.js:1430`:

```js
const conds = { ...(rule.conditions || {}), ...(rule.context_conditions || {}) };
```

Both columns merge; **`context_conditions` wins on key collision.** One live collision exists — `RECONCILE_LP_DNC_ON_LINK` has `has_any_tag` and `not_has_tag` in both columns, so the `conditions` copies are dead text that reads as active gating on a DNC-suppression rule that has fired 397 times. Resolve to one column, then reload. Guard query:

```sql
SELECT rule_key,
       (SELECT array_agg(k) FROM jsonb_object_keys(conditions) k WHERE context_conditions ? k) AS colliding
FROM agent_rules
WHERE conditions IS NOT NULL AND context_conditions IS NOT NULL AND enabled
  AND EXISTS (SELECT 1 FROM jsonb_object_keys(conditions) k WHERE context_conditions ? k);
-- expect zero rows
```

---

# Working rules

1. **MCP is reality.** Every number here was measured today. If a query disagrees, the query wins.
2. **`node --check` is not verification.** It is a parse and cannot catch a dropped `const` — that took LP MCP down for 52 minutes on 2026-08-08. Use `test/executor-heartbeat.smoke.test.js` as the pattern: load the module, call every export, exercise deferred callbacks. For `.ts`, `tsc --noEmit` does catch this.
3. **Read `sql/057`'s retraction before trusting PR #648's commit messages.** A claim about `NOT (col IS NULL)` not matching partial indexes is in there and is **false**.
4. **Feature branch off `main`, PR, Mark merges.** Never commit to `main`.
5. **Reload the Decision Engine after any `agent_rules` change** and assert the `rules_loaded` delta.
6. **Do not delete customer or audit data** without an explicit ruling from Mark.
