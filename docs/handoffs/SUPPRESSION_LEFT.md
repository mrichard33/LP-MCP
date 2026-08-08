# Claude Code Handoff — Move the suppression check left

**Prepared:** 2026-08-08
**Last revised:** 2026-08-08 — the fork in §2 has been RULED. Status updated from BLOCKED to actionable.

> ## ✅ THE RULING IS MADE — §2 IS RESOLVED, DO NOT WAIT ON IT
>
> This document originally blocked on a question: *is `suppress-automation` supposed to block mutations?* **Mark ruled: it is not.** Option (A). It is removed from `MUTATION_SUPPRESS_TAGS`; `stop-bot` stays.
>
> The deciding evidence — 95% of applications come from `AUTOMATION_SUPPRESS_ON_BOOKING`, a 48h post-booking marketing pause, and the tag blocked its own removal (963 blocked removals) — is recorded in **`ITEM1_UNBLOCK_DOOR_FINAL.md`**, which is the implementation spec for that half of the work.
>
> **What remains live in THIS document:**
> - **§3** — the `stop-bot` move-left work across seven rules. Unaffected by the ruling, still worth doing, not covered elsewhere.
> - **§4** — the `HARD_DISQUALIFIED_CLOSEOUT` bug. Still open. Note that its second candidate fix has since been superseded; see the ⚠️ in §4.
> - **§1** — how the gate works. Still accurate.
>
> §2 and §5 are kept as the reasoning record. Do not act on §5's numbers without reading the note at the top of it.

---

## Read this first — the estimate that prompted this work was wrong

I told Mark this change would remove "~35–40% of all action volume." **That number does not survive verification.** Correcting it before anyone builds against it.

The reasoning was: 34,487 actions per 30 days end in `mutation suppressed`, they're created and then discarded, so suppress them earlier and the volume disappears. The first two clauses are true. The conclusion is not, because it assumed every suppressed action *should* have been suppressed.

Actual breakdown of the 34,487, by what blocked them:

| Blocked by | Actions | Share |
|---|---:|---:|
| `suppress-automation` **only** | 25,527 | **74.0%** |
| `stop-bot` present | 8,538 | 24.8% |
| Neither — tag removed since | 424 | 1.2% |

Only the `stop-bot` slice is unambiguously "should never have fired." That is **8,538 actions/month, about 7.7% of the 111,320 total** — a real win, but a fifth of what I said.

---

## §1 — How the gate actually works

`src/services/suppression-check.js`. The `mutation suppressed` outcome comes from `checkMutationSuppression`, which matched exactly two tags:

```js
const MUTATION_SUPPRESS_TAGS = ['suppress-automation', 'stop-bot'];
// post-ruling this becomes ['stop-bot'] — see ITEM1_UNBLOCK_DOOR_FINAL.md §1a
```

The gate itself lives in the action executor (`src/actions/index.js`) and blocks **all mutating action types** — `move_opportunity`, workflow add/remove, `set_stage`, custom fields, and non-audit tags.

**Two exemptions already exist** and both matter enormously for this work (`isMutationGateExempt`):

1. **`add_tag` of a suppression/audit tag is exempt.** Matched by `SUPPRESSION_AUDIT_TAG_RE` — `dnc*`, `do-not-contact`, `stop-bot`, `suppress*`, `hard-disqualified`, `quarantined`, `audit-`, `compliance-`, `loss-reason:`. This is how suppression gets recorded on a contact in the first place.
2. **`action_payload.bypass_suppression === true` is exempt.** Used by `DNC_LIFT_ON_REENGAGEMENT` so the lift can *remove* the suppression stack from a `stop-bot` contact. Without it the DNC blocks its own removal.

⚠️ **There is no `remove_tag` audit exemption.** This is the source of the bug in §4. A **narrow** one is added in `ITEM1_UNBLOCK_DOOR_FINAL.md` §1c — narrow because a broad one would let any rule strip a consent tag.

---

## §2 — The fork *(RESOLVED — retained as the reasoning record)*

**Was `suppress-automation` supposed to block mutations?** The codebase contradicted itself, and 25,527 actions a month hung on the answer.

**Evidence it should NOT block:**

- Deliberately **removed** from `SUPPRESS_TAGS` on 2026-05-14, described in the file header as a *"legacy GHL workflow throttle."* The stated reason: `agentic-active` became the canonical "agentic is in charge" signal, and re-gating on the legacy tags "was silently dropping valid sends."
- Mark's v4.3 operating instructions: *"Never reintroduce `pause-bot`/`suppress-automation` as blockers."*
- 1,780 of 2,195 affected contacts (81%) carry it **without** `stop-bot`. Not leads who asked us to stop.

**Evidence it SHOULD block:**

- The mutation gate was added deliberately on 2026-07-03 — *after* the May removal — and the header calls the thing it fixed a *"pipeline-integrity breach."*

**Resolved to (A): it is legacy and must not gate mutations.** The decisive evidence came from asking what actually applies the tag: 4,591 of 4,837 applications (95%) come from `AUTOMATION_SUPPRESS_ON_BOOKING` — a 48-hour post-booking marketing pause on a *converting* lead, not a disqualification. Of 3,729 carriers, zero are customers. And it was self-sealing: 963 removal attempts blocked against 1,459 successful, because `remove_tag` has no exemption. A 48-hour pause had become permanent.

`stop-bot` remains in the gate, which preserves whatever the 2026-07-03 breach was protecting for the tag that actually matters.

Consequence, and it is the opposite of an optimisation: **~25,500 mutations a month that were being dropped will now execute.** Action volume and GHL API load go UP. Full spec and rollout in `ITEM1_UNBLOCK_DOOR_FINAL.md`.

---

## §3 — The `stop-bot` work — LIVE, unaffected by the ruling

The `stop-bot` slice — **8,538 actions/month** — needed no ruling and still needs doing. `stop-bot` is a lead-initiated kill switch. Rules that route, enrol, or re-tag a contact who explicitly told us to stop should not fire at all.

### Target rules, measured over 30 days

| Rule | Suppressed | Total | Wasted |
|---|---:|---:|---:|
| `LP_DISP_CANCEL_COLD_TO_S5_2` | 8,428 | 19,775 | 42.6% |
| `GHL_APPT_CANCELLED_REBOOK_COLD` | 4,095 | 10,545 | 38.8% |
| `HARD_DISQUALIFIED_CLOSEOUT` | 4,843 | 5,738 | **84.4%** ⚠️ see §4 |
| `GHL_APPT_STAGE_ADVANCE` | 3,048 | 5,912 | 51.6% |
| `LP_DISP_CNF` | 1,273 | 2,780 | 45.8% |
| `LP_DISP_OPPFDN` | 1,054 | 3,540 | 29.8% |
| `STATE_ENROLLMENT` | 604 | 954 | 63.3% |

*(Those totals were measured pre-ruling and include the `suppress-automation` share. After Item 1 ships, re-measure before deciding a rule is worth gating — the `stop-bot`-only portion is what this section addresses.)*

### The change, per rule

Add to `context_conditions`:

```json
{ "not_has_any_tag": ["stop-bot"] }
```

`not_has_any_tag` is already implemented and in production use — `TRUST_REBUILD_HOLD_COMPLETE_TO_S1_1` and `OBJECTION_ROUTE_POST_DEMO` both use it. No code change, no deploy. `agent_rules` edit plus a Decision Engine reload.

### Rules that must be EXCLUDED from this treatment

Before touching any rule, check what its `action_template` actually does. **Do not add the gate to a rule whose actions are exempt today**, or you will break the exemption by preventing the rule from firing at all:

- Any rule whose action is `add_tag` of a suppression/audit tag (matches `SUPPRESSION_AUDIT_TAG_RE`). These are *supposed* to land on suppressed contacts.
- Any rule setting `bypass_suppression: true` — both `DNC_LIFT_ON_REENGAGEMENT_*` rules. Gating these on `not_has_any_tag: ['stop-bot']` would permanently strand every DNC contact, because the lift exists precisely to run on a `stop-bot` contact and remove the stack. **This is the single most dangerous mistake available in this work.**

### Method — one rule at a time

1. Read the rule's `action_template`. Confirm no action is exempt per the list above.
2. Add `not_has_any_tag: ["stop-bot"]` to `context_conditions`, preserving existing keys. Use `jsonb` merge, not overwrite:
   ```sql
   UPDATE agent_rules
   SET context_conditions = coalesce(context_conditions,'{}'::jsonb)
                            || '{"not_has_any_tag": ["stop-bot"]}'::jsonb
   WHERE rule_key = '<RULE>';
   ```
   ⚠️ If the rule **already has** `not_has_any_tag`, this overwrites it. Read first, union the arrays, then write. This applies doubly after Item 1, which adds `active-entry:canvassing` and `suppress-automation` to nurture-enrollment rules.
3. Reload: `POST .../n8n/decision-engine/reload-rules`. Assert the `rules_loaded` delta.
4. Wait one full cycle. Confirm suppressed count for that rule drops and **total non-suppressed output is unchanged**:
   ```sql
   SELECT status, count(*) FROM agent_actions
   WHERE rule_applied = '<RULE>' AND created_at > now() - interval '2 hours'
   GROUP BY status;
   ```
   Completed count must hold steady. If completed drops, the gate is too broad — revert that rule immediately.
5. Only then move to the next rule.

Do not batch these. Seven rules, seven verified steps.

### Also check the `conditions`/`context_conditions` collision trap

`RECONCILE_LP_DNC_ON_LINK` already has `has_any_tag` and `not_has_tag` in **both** columns. The engine merges `{...conditions, ...context_conditions}` (`decision-engine.js:1430`) and `context_conditions` wins. If a target rule has anything in `conditions`, resolve that first or the edit will not behave as read. Guard query:

```sql
SELECT rule_key,
       (SELECT array_agg(k) FROM jsonb_object_keys(conditions) k WHERE context_conditions ? k) AS colliding
FROM agent_rules
WHERE conditions IS NOT NULL AND context_conditions IS NOT NULL AND enabled
  AND EXISTS (SELECT 1 FROM jsonb_object_keys(conditions) k WHERE context_conditions ? k);
```

---

## §4 — A probable correctness bug found on the way — STILL OPEN

`HARD_DISQUALIFIED_CLOSEOUT` is **84.4% suppressed** — 4,843 of 5,738 actions. Of those, 3,703 are `remove_tag` and 1,140 are `remove_from_workflow`.

This rule's job is to close out a hard-disqualified contact: strip their workflow tags, pull them out of sequences. But `hard-disqualified` contacts also carry the suppression stack, **and there is no `remove_tag` audit exemption** — only an `add_tag` one. So the closeout is blocked from doing the exact cleanup it exists to perform, on exactly the contacts that need it.

**Do not "fix" this by moving it left.** Adding `not_has_any_tag` would cement the bug — the rule would stop firing instead of being blocked, and the contacts stay dirty either way. Symptom silenced, problem preserved.

⚠️ **Candidate fixes — the second one has changed since this was written:**

- **Preferred:** set `bypass_suppression: true` on the closeout's `remove_tag` / `remove_from_workflow` actions, same mechanism `DNC_LIFT` uses. Narrow, uses existing machinery.
- ~~Add a `remove_tag` audit exemption mirroring the `add_tag` one.~~ **Do not do this as originally written.** A broad exemption over `SUPPRESSION_AUDIT_TAG_RE` would let any rule strip `dnc`, `do-not-contact` or `stop-bot`. `ITEM1_UNBLOCK_DOOR_FINAL.md` §1c ships a **narrow** operational-only allow-list instead — and note `hard-disqualified` is deliberately **not** on it, so that list does not resolve this bug. The `bypass_suppression` route remains the right fix here.

**Verify the symptom before fixing.** If closeout has been blocked for months, those contacts should still carry the workflow tags it tried to strip:

```sql
SELECT count(*) FROM contact_tag_snapshot
WHERE 'hard-disqualified' = ANY(tags)
  AND EXISTS (SELECT 1 FROM unnest(tags) x WHERE x LIKE 'active-%' OR x LIKE 'stage:%');
```

A high count confirms it. A near-zero count means something else is cleaning them up and this is genuinely just waste.

---

## §5 — Expected outcome *(superseded by the ruling — read the note)*

> ⚠️ Written before the fork was resolved. The ruling went to **(A)**, so the branch below that predicted a ~30% *reduction* does not apply. Retained to show what was weighed.

If §2 had resolved to **(B) intentional** and all of §3 landed:

- ~8,500 actions/month removed with certainty (`stop-bot` slice)
- up to ~25,500 more if the `suppress-automation` gate were also moved left
- best case ~34,000 of 111,320, roughly **30%** of action volume

**§2 resolved to (A), so action volume goes UP, not down** — ~25,500 mutations that should have run will start running. Correct outcome, opposite direction. The `stop-bot` work in §3 still removes ~8,500/month and remains a genuine reduction.

---

## Related documents

| Document | Covers |
|---|---|
| `ITEM1_UNBLOCK_DOOR_FINAL.md` | **The `suppress-automation` ruling, implemented** — gate change, canvassing gate, narrow `remove_tag` exemption, backfill, TTL |
| `ITEM1_ADDENDUM_canvassing_gate.md` | `active-entry:other` question; `active-entry:*` invariant breach |
| `UNBLOCK_DOOR_AND_NURTURE.md` | Item 2 (feed S4.5) and Item 3 (restore objection routing) |

---

## Working rules

1. **MCP is reality.** Every figure here was measured on 2026-08-08. If a query disagrees, the query wins.
2. **Re-measure after Item 1 ships.** The §3 totals include the `suppress-automation` share and will shift.
3. **One rule at a time, verify between each.** Completed-action count must hold steady; only the suppressed count should fall.
4. **Never gate a rule that sets `bypass_suppression: true`.** That strands DNC contacts permanently.
5. **Reload the Decision Engine after every `agent_rules` change** and assert the `rules_loaded` delta.
6. Feature branch off `main`, PR, Mark merges. Never commit to `main`.
7. `node --check` is a parse, not verification — see `test/executor-heartbeat.smoke.test.js` for the pattern.
