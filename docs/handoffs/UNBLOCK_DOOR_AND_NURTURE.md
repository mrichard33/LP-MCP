# Claude Code Handoff — Unblock the door, feed the nurture layer, restore objection routing

**Prepared:** 2026-08-08
**Supersedes the open question in PR #653.** That handoff blocked on a ruling about `suppress-automation`. The ruling is made below, with the evidence that decided it.

Three items, strictly ordered. **Item 1 must ship and be verified before Item 2**, because Item 2 routes leads through the door Item 1 opens.

---

## Ruling on `suppress-automation`: it must stop blocking mutations

### What the tag actually means

95% of all applications come from a single rule:

| Rule | Applications | First | Last |
|---|---:|---|---|
| `AUTOMATION_SUPPRESS_ON_BOOKING` | **4,591** | 2026-04-12 | 2026-08-08 |
| `LP_DISP_DNC` | 243 | 2026-04-15 | 2026-06-25 |
| `MANUAL_TEST_CLEANUP` | 3 | — | — |

`AUTOMATION_SUPPRESS_ON_BOOKING` fires when a lead **books an appointment**. It is the 48-hour post-booking marketing pause referenced in `suppression-check.js`. It is a courtesy pause on a *converting* lead — not a disqualification, not a compliance signal.

Confirmed against the contact population: of 3,729 contacts carrying it, **zero are customers**, only 176 are `hard-disqualified`, and only 273 are consent-blocked. **3,137 are cleanly reachable** with no compliance reason of any kind.

### It is a closed loop

| | |
|---|---:|
| Ever applied (completed) | 4,720 |
| Ever removed (completed) | 1,459 |
| **Removal attempts BLOCKED** | **963** |
| Currently carrying | 3,729 |
| …of which also `agentic-active` | **3,052** |

`isMutationGateExempt` exempts `add_tag` of an audit tag but **has no `remove_tag` exemption** — the code says so explicitly. So `suppress-automation` blocks its own removal. A 48-hour pause has become permanent for 3,729 contacts, and the bot is nominally in charge of 3,052 of them while every mutation against them is silently dropped.

### The codebase already ruled three times

- `suppression-check.js:33` — removed from `SUPPRESS_TAGS` on 2026-05-14, called a *"legacy GHL workflow throttle"*; header notes re-gating on it *"was silently dropping valid sends."*
- `send-message-handler.js` v3.12 — *"Drop suppress-automation gating: that flag was for legacy GHL"*
- `suppression-guard.js:38` — *"pause-bot and suppress-automation are deliberately NOT in this list… must never be treated as such."*

Against one dissent: `MUTATION_SUPPRESS_TAGS`, added 2026-07-03 to fix a *"pipeline-integrity breach."* Mark's v4.3 operating instructions side with the three.

### The ruling, and what it is NOT

**Remove `suppress-automation` from `MUTATION_SUPPRESS_TAGS`. Keep `stop-bot`.**

`stop-bot` is a lead-initiated kill switch and stays exactly as it is — whatever the 2026-07-03 breach was, the gate still covers it for the tag that matters.

**This is not "delete the booking pause."** Pausing marketing on someone who just booked is correct: a Seinfeld email two hours after booking is a bad experience and off-framework. The defect is **scope** — a marketing pause was wired to block *every* mutation (stage moves, tag hygiene, opportunity updates, appointment sync) instead of *nurture enrollment*. The pause gets re-expressed correctly in Item 2.

---

# ITEM 1 — Unblock the door

### 1a. Narrow the mutation gate

`src/services/suppression-check.js`:

```js
// BEFORE
const MUTATION_SUPPRESS_TAGS = ['suppress-automation', 'stop-bot'];

// AFTER
// 2026-08-08 — `suppress-automation` removed. It is applied by
// AUTOMATION_SUPPRESS_ON_BOOKING as a 48h post-booking marketing pause
// (4,591 of 4,837 applications), NOT a disqualification: of 3,729 carriers,
// zero are customers and 3,137 have no compliance tag of any kind.
//
// As a mutation blocker it was self-sealing — remove_tag has no audit
// exemption, so the tag blocked its own removal (963 blocked removals
// against 1,459 successful ones). A 48-hour pause became permanent for
// 3,729 contacts, 3,052 of whom carry agentic-active.
//
// Three other call sites already treat this tag as a non-blocker
// (SUPPRESS_TAGS 2026-05-14, send-message-handler v3.12, suppression-guard).
// The booking pause it represents is re-expressed as a nurture-enrollment
// gate in Item 2 — scoped to marketing, which is what it was always for.
//
// stop-bot stays. It is lead-initiated and universal.
const MUTATION_SUPPRESS_TAGS = ['stop-bot'];
```

Update `scripts/test-suppression-and-tag-hygiene.js` — it asserts `matchMutationSuppression(['suppress-automation'])` returns the tag. Invert that assertion and add one proving `stop-bot` still matches.

### 1b. Give `remove_tag` an audit exemption

Without this the 3,729 backlog cannot self-clear and the loop can re-form.

In `isMutationGateExempt`, mirror the existing `add_tag` exemption:

```js
if ((action.action_type === 'add_tag' || action.action_type === 'remove_tag')
    && isSuppressionAuditTag(action.action_payload?.tag)) return true;
```

`SUPPRESSION_AUDIT_TAG_RE` already matches `suppress-`, so this covers it. Reason: removing a suppression tag is how suppression *ends*; a gate that blocks its own release is a trap, which is exactly what the 963 blocked removals show.

### 1c. Backfill the stuck 3,729

Once 1a and 1b are deployed, clear the tag from contacts whose booking pause has long expired. **Do not blanket-clear.** Exclude anyone with a live compliance or DQ signal:

```sql
SELECT ghl_contact_id FROM contact_tag_snapshot
WHERE 'suppress-automation' = ANY(tags)
  AND NOT ('stop-bot' = ANY(tags))
  AND NOT ('dnc' = ANY(tags)) AND NOT ('do-not-contact' = ANY(tags))
  AND NOT ('dnc-sms' = ANY(tags)) AND NOT ('stage:dnc' = ANY(tags))
  AND NOT ('unsubscribed' = ANY(tags))
  AND NOT ('hard-disqualified' = ANY(tags));
```

Expect ~3,137. Run it in **batches of 200** with a pause between, and watch the GHL rate limiter — the June token-starvation incident came from exactly this kind of bulk tag operation. Do not run it inside the executor; use a script with the limiter in front.

### 1d. Make the pause actually expire

`AUTOMATION_SUPPRESS_ON_BOOKING` has no TTL. Add a sweep (or a `pg_cron` job once installed) that removes `suppress-automation` from any contact whose booking is more than 48 hours old. Without this the population rebuilds at ~4,600/year.

### Verification — do not proceed to Item 2 until all four pass

```sql
-- 1. suppressed actions should collapse
SELECT status, count(*) FROM agent_actions
WHERE created_at > now() - interval '2 hours' GROUP BY status;
-- expect 'skipped'/'suppressed' share to drop sharply vs the ~42% baseline

-- 2. enrollment into S5.2 should start passing
SELECT status, count(*) FROM agent_actions
WHERE action_type='add_to_workflow' AND created_at > now() - interval '2 hours'
GROUP BY status;
-- baseline was 60.8% blocked

-- 3. stop-bot must STILL block
SELECT count(*) FROM agent_actions a
JOIN contact_tag_snapshot t ON t.ghl_contact_id = a.target_id
WHERE a.created_at > now() - interval '2 hours'
  AND 'stop-bot' = ANY(t.tags) AND a.status = 'completed'
  AND a.action_type NOT IN ('add_tag','remove_tag');
-- expect 0 (excluding bypass_suppression lifts)

-- 4. backlog clearing
SELECT count(*) FROM contact_tag_snapshot WHERE 'suppress-automation' = ANY(tags);
```

⚠️ **Expect action volume and GHL API calls to RISE.** That is the intended outcome — ~25,500 mutations a month that were being dropped will now execute. Watch `getRateLimiterStats` for the first 24 hours. If the limiter queue deepens, throttle the 1c backfill first, not the live path.

---

# ITEM 2 — Feed the Seinfeld layer (S4.5)

### Why

*DotCom Secrets* and *Traffic Secrets* are explicit that follow-up funnels expire: *"most good follow-up funnels are effective for 30 to 60 days. After that, people drop off the core list… and then they're moved on to our daily broadcast list."* The Seinfeld list is what catches people when a sequence ends.

`S4.5 Post-Engagement Seinfeld Nurture` (`f99fba97-6d2f-4fd6-966c-b5e5e36f8938`) is **built and published** — and received **58 enrollment attempts in 30 days** against 7,350 `agentic-active` contacts. Layer 3 exists and nothing routes into it. Every lead who completes or exits a sequence without converting goes permanently quiet.

For comparison, S5.2 took 2,510 attempts in the same window. This is not a capacity problem; it is a missing route.

### The rule to add

New `agent_rules` row. Trigger on sequence exit without conversion, enrol in S4.5.

```
rule_key:        SEINFELD_CATCH_ON_SEQUENCE_EXIT
rule_type:       contextual
event_pattern:   { "event_type": "agentic.sequence_exit" }   ← VERIFY, see below
action_template: add_to_workflow → f99fba97-6d2f-4fd6-966c-b5e5e36f8938
requires_approval: false
priority:        ~60 (below objection routing, above generic nurture)
```

`context_conditions`:

```json
{
  "not_has_any_tag": [
    "customer", "lp-sale", "stop-bot", "do-not-contact", "dnc", "dnc-sms",
    "stage:dnc", "unsubscribed", "hard-disqualified", "suppress-automation",
    "active-s4.5"
  ],
  "no_future_appointment": true
}
```

Two things to note in that list:

- **`suppress-automation` is here.** This is where the booking pause belongs — gating *nurture enrollment*, which is what it was always for. Item 1 removes it as a universal mutation blocker; this restores its real purpose in the correct scope.
- **`no_future_appointment`** is already implemented and in production use on `TRUST_REBUILD_HOLD_COMPLETE_TO_S1_1`. Do not Seinfeld someone with a booking on the calendar.
- **`active-s4.5`** prevents double-enrollment. Confirm the actual active-tag convention for S4.5 before using this literal.

### ⚠️ Verify the trigger event exists before writing the rule

I did **not** confirm that `agentic.sequence_exit` is emitted. The S1.x-E "Exit Conditions" workflows exist in the registry (`S1.1-E`, `S1.2-E`, `S1.3-E`, `S1.7-E`), which suggests exits are modelled, but I have not verified what event type they emit — or whether they emit one at all.

**This is the same class of defect that killed the three rules in Item 3.** Check first:

```sql
SELECT event_type, event_subtype, count(*), max(created_at)::date
FROM system_events WHERE created_at > now() - interval '30 days'
GROUP BY 1,2 ORDER BY 3 DESC;
```

If no exit event exists, the fallback trigger is a scheduled sweep over contacts who are `agentic-active`, carry no `active-*` sequence tag, and have had no outbound in N days. That is a different build — size it before committing.

### Verification

```sql
SELECT status, count(*) FROM agent_actions
WHERE action_type='add_to_workflow'
  AND action_payload->>'workflow_id' = 'f99fba97-6d2f-4fd6-966c-b5e5e36f8938'
  AND created_at > now() - interval '24 hours'
GROUP BY status;
```

Ramp deliberately. S4.5 is an **email** motion — Randy is the Attractive Character and brand law restricts him to email and video, never SMS. Going from 58 to several thousand enrollments in a day is a deliverability risk on a domain that has not carried that volume. **Cap the first week** (a few hundred), watch bounce and complaint rates, then lift.

---

# ITEM 3 — Restore the objection layer

### Why

`O.0 Objection Handler` received **16 enrollment attempts in 30 days**. The entire price / spouse / timing / trust / DIY apparatus, the W9.0 branches and the SA2 authority arcs, is being invoked sixteen times a month.

Meanwhile the analyzer emits rich framework signal on every analysis: `objection_type`, `objection_confidence`, `recommended_story_arc`, `emotional_state`, `engagement_quality`, `buyer_stage`, `buying_signals`. It is being produced and discarded.

### Root cause: event vocabulary drift

Three rules match on `event_subtype` values that no emitter produces:

| Rule | Expects subtype | Actually emitted |
|---|---|---|
| `TRUST_BREAK_ACCURACY` | `objection_detected` | `stage_1`…`stage_5` |
| `PRICE_OBJECTION_RECLASSIFY` | `objection_detected` | `stage_1`…`stage_5` |
| `REPLY_INTENT_BUYING_SIGNAL` | `positive` | `pending_analysis`, `dnc` |

**Config-only fix.** Drop the wrong `event_subtype` from `event_pattern`; move the real gating into `context_conditions` using payload-backed operators. `objection_type_eq` and `engagement_quality_eq` are both proven in production on `BEHAVIORAL_DIY_OBJECTION`.

### ⚠️ Confirm the operator vocabulary first

These three rules currently use `all_of` / `any_of` with named string tokens (`"objection_type_is_price"`, `"reply_contains_yes"`). **I did not verify that `all_of`/`any_of` or those tokens are implemented.** Unknown operators fail closed, so they may be a second, independent reason these never fired.

Grep the condition evaluator in `src/decision-engine.js` for the supported operator list and rewrite to match. Do not assume a token works because it is in the database.

### The other two

- **`TRUST_REBUILD_HOLD_COMPLETE_TO_S1_1`** — waits on `agentic.hold_completed`, which is not emitted at all. Its upstream `APPT_FRICTION_NO_APPT_TO_HOLD_REENGAGE` last fired 2026-06-30. Fix upstream first; this rule may be fine and starved. Also move its `summary` key out of `conditions` into `notes` — `summary` is not an allowed annotation key and may be evaluated as an operator.
- **`BEHAVIORAL_DIY_OBJECTION`** — genuinely matches events; its `context_conditions` are a narrow AND. **Check frequency before changing anything:**

```sql
SELECT count(*) FROM system_events
WHERE event_type='ai.analysis_completed'
  AND payload->>'objection_type'='diy'
  AND payload->>'engagement_quality'='meaningful'
  AND created_at > now() - interval '90 days';
```

Zero means the rule is correct and waiting. Leave it alone.

### Also fix the live collision

`RECONCILE_LP_DNC_ON_LINK` has `has_any_tag` and `not_has_tag` in **both** `conditions` and `context_conditions`. The engine merges `{...conditions, ...context_conditions}` (`decision-engine.js:1430`) and `context_conditions` wins, so the `conditions` copies are dead text that reads as active gating — on a DNC rule that has fired 397 times. Resolve to one column, then reload.

---

# Context: S1.3 and the Avatar video

`S1.3 Stale Lead Revival` is **active and published**. Mark has been holding the Avatar production (HeyGen + ElevenLabs, Evotion Studios) for it.

Nothing in this handoff blocks that, and the sequencing is favourable: Items 1–3 fix *distribution*, and the Avatar improves *conversion* on traffic that reaches S1.3. Doing them in that order means the video launches into a funnel whose door is open rather than one dropping 60% of enrollments.

Worth knowing before the shoot: among contacts who currently receive any message, the reply rate is ~37%. The creative is working. This is a distribution problem sitting on top of working creative, which is why Items 1–3 come first.

---

# Working rules

1. **Item 1 fully verified before Item 2.** Item 2 routes leads through Item 1's door.
2. **Expect load to go UP after Item 1.** That is the correct outcome. Watch the rate limiter for 24h.
3. **Verify every trigger event exists before writing a rule.** Item 3 is entirely the cost of not doing this.
4. **Never gate a rule that sets `bypass_suppression: true`** — both `DNC_LIFT_ON_REENGAGEMENT_*` rules must keep firing on `stop-bot` contacts.
5. **Reload the Decision Engine after every `agent_rules` change** and assert the `rules_loaded` delta. One rule at a time.
6. `node --check` is a parse, not verification — see `test/executor-heartbeat.smoke.test.js`.
7. Feature branch off `main`, PR, Mark merges. Never commit to `main`.
