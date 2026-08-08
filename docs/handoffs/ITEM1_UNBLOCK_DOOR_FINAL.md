# Claude Code Handoff — Item 1 (FINAL): Unblock the door, canvassing-safe

**Prepared:** 2026-08-08
**Approved by Mark:** proceed with unblocking, with two additions — protect `active-entry:canvassing` leads from sends, and fix the `remove_tag` exemption.
**This supersedes Item 1 of PR #654.** Two things in that version were wrong or incomplete. Both are corrected below and called out explicitly.

---

## Corrections to PR #654

### Correction 1 — the `remove_tag` exemption I specced was a compliance hole

PR #654 said to widen the existing exemption like this:

```js
// ❌ DO NOT DO THIS — from PR #654
if ((action.action_type === 'add_tag' || action.action_type === 'remove_tag')
    && isSuppressionAuditTag(action.action_payload?.tag)) return true;
```

`SUPPRESSION_AUDIT_TAG_RE` is:

```js
/^(dnc|dnc-|do-not-contact|stop-bot|suppress[-:]|hard-disqualified|quarantined|audit-|compliance-|loss-reason:)/i
```

It matches `dnc`, `do-not-contact` and `stop-bot`. Exempting `remove_tag` against it would let **any** rule strip a consent tag off a contact with no explicit opt-in.

**The add/remove asymmetry is deliberate and correct.** Adding a suppression tag is always safe — it makes the system quieter. Removing one is not symmetric: it makes the system louder against someone who may have legally opted out. That is precisely why `DNC_LIFT_ON_REENGAGEMENT` has to declare `bypass_suppression: true` — the opt-in is the audit trail.

The corrected fix is a **separate, narrow allow-list** covering operational suppressors only. See §1c.

### Correction 2 — the backfill cohort was wrong

PR #654 sized it at ~3,137. **1,956 of the 3,729 carriers (52%) are `active-entry:canvassing`.** With canvassing excluded the real cohort is **1,525**.

---

## Measured state

| | |
|---|---:|
| Carrying `suppress-automation` | 3,729 |
| …also `agentic-active` | 3,052 |
| …**also `active-entry:canvassing`** | **1,956 (52%)** |
| …clean of compliance/DQ tags | 3,137 |
| **Final backfill cohort (canvassing excluded)** | **1,525** |
| `active-entry:canvassing` total | 6,064 |
| …also `agentic-active` | 3,854 |
| …with `canvass-marketing-complete` | 195 |

Canvassing is the largest entry bucket in the system — 6,064 contacts, roughly half the snapshot population. Only 195 have completed the canvassing marketing cycle. Releasing automated marketing onto the other ~5,870 mid-cycle would collide with the canvassers working those doors.

---

# §1a — Narrow the mutation gate

`src/services/suppression-check.js`:

```js
// BEFORE
const MUTATION_SUPPRESS_TAGS = ['suppress-automation', 'stop-bot'];

// AFTER
// 2026-08-08 — `suppress-automation` removed from the mutation gate.
//
// WHAT THE TAG ACTUALLY MEANS: 4,591 of 4,837 applications (95%) come from
// AUTOMATION_SUPPRESS_ON_BOOKING — a 48h post-booking marketing pause on a
// CONVERTING lead. Not a disqualification. Of 3,729 carriers, zero are
// customers and 3,137 carry no compliance tag of any kind.
//
// WHY IT HAD TO GO: it was self-sealing. remove_tag had no audit exemption,
// so the tag blocked its own removal — 963 blocked removals against 1,459
// successful ones. A 48-hour pause became permanent on 3,729 contacts,
// 3,052 of whom carry agentic-active, with every mutation against them
// silently dropped.
//
// Three other call sites already treat this tag as a non-blocker
// (SUPPRESS_TAGS 2026-05-14; send-message-handler v3.12; suppression-guard).
//
// THE PAUSE ITSELF IS STILL CORRECT and is preserved — re-scoped to outbound
// in §1b rather than blocking all mutations. Pausing MARKETING on someone who
// just booked is right. Blocking their stage moves, tag hygiene, opportunity
// updates and appointment sync was not.
//
// stop-bot stays. Lead-initiated, universal.
const MUTATION_SUPPRESS_TAGS = ['stop-bot'];
```

Update `scripts/test-suppression-and-tag-hygiene.js` — it currently asserts `matchMutationSuppression(['suppress-automation'])` returns the tag. Invert it, and add a case proving `stop-bot` still matches.

---

# §1b — Protect canvassing leads from outbound

Mark's requirement: do not send to active canvassing leads.

⚠️ **The exclusion cannot live in the backfill.** §1a is a global code change — once `suppress-automation` stops gating mutations, it stops gating them for canvassing contacts too, whether or not we clear their tag. Leaving the tag on them protects nothing. **The protection has to sit on the send path.**

### The universal floor

Add to `SUPPRESS_TAGS` in `src/services/suppression-check.js`:

```js
  // 2026-08-08 — canvassing leads are worked door-to-door by a human
  // canvasser. Automated marketing on top of an active canvassing cycle
  // competes with the person standing on the doorstep. 6,064 contacts carry
  // this; only 195 have canvass-marketing-complete, so the large majority are
  // mid-cycle.
  //
  // Deliberately placed in SUPPRESS_TAGS (the default mode) and NOT in
  // REPLY_BLOCKING_TAGS: if a canvassed homeowner texts us back, the bot
  // should still answer. This blocks proactive outbound and nurture, not a
  // direct reply — matching the 2026-07-07 always-respond policy.
  'active-entry:canvassing',
```

This gives exactly the semantics asked for. `checkSuppression(id, { mode: 'default' })` blocks proactive sends. `mode: 'agentic_reply'` on an `agentic-active` contact still lets a direct reply through, because `active-entry:canvassing` is not in `REPLY_BLOCKING_SET`.

### Defence in depth at the rule layer

Mirroring the existing pattern (`AGENTIC_RESPOND_POST_CHATBOT` carries a rule-level `not_has_any_tag` backstop over the universal floor), add to the `context_conditions` of every nurture-enrollment rule — including the S4.5 rule when Item 2 ships:

```json
{ "not_has_any_tag": ["active-entry:canvassing", "suppress-automation"] }
```

**This is also where the booking pause belongs.** §1a removes `suppress-automation` as a universal mutation blocker; this line restores it in its correct scope — gating nurture enrollment, which is what it was always for.

### Open question for Mark — do NOT decide unilaterally

`canvass-marketing-complete` exists on 195 contacts, which implies a graduation path out of the canvassing cycle. If that tag is the intended "safe to market to now" signal, the gate should be `active-entry:canvassing AND NOT canvass-marketing-complete` rather than a blanket block, and those 195 should flow. Confirm the intent before choosing. The blanket block is the safe default until then.

---

# §1c — The `remove_tag` exemption, done narrowly

Without this the gate can re-form: a `stop-bot` contact's operational suppressors can never be lifted, which is the trap that produced 963 blocked removals.

**Do not** widen `isSuppressionAuditTag`. Add a separate predicate:

```js
/**
 * 2026-08-08 — remove_tag exemption, deliberately NARROWER than the add_tag one.
 *
 * Adding a suppression tag is always safe: it makes the system quieter.
 * Removing one is NOT symmetric — it makes the system louder against someone
 * who may have legally opted out. So this list covers OPERATIONAL suppressors
 * only, the ones that represent a temporary internal pause.
 *
 * Consent and lead-initiated tags are deliberately ABSENT and must stay that
 * way: dnc, dnc-sms, dnc-related, do-not-contact, stage:dnc, unsubscribed,
 * stop-bot, hard-disqualified, loss-reason:*. Removing any of those still
 * requires an explicit action_payload.bypass_suppression = true, which is the
 * audit trail — that is how DNC_LIFT_ON_REENGAGEMENT does it and it should
 * stay the only way.
 *
 * Exact-match, not prefix. A prefix rule on 'suppress' would also catch
 * future consent-adjacent tags by accident.
 */
const REMOVABLE_OPERATIONAL_SUPPRESSION_TAGS = new Set([
  'suppress-automation',
  'suppress-outbound',
  'pause-bot',
  'cooling-active',
  'quarantined',
  'canvass-hold',
]);

export function isRemovableOperationalSuppressionTag(tag) {
  return REMOVABLE_OPERATIONAL_SUPPRESSION_TAGS.has(String(tag || '').trim().toLowerCase());
}
```

Then in `isMutationGateExempt`:

```js
export function isMutationGateExempt(action) {
  if (!action) return false;
  if (action.action_payload?.bypass_suppression === true) return true;
  if (action.action_type === 'add_tag' && isSuppressionAuditTag(action.action_payload?.tag)) return true;
  // 2026-08-08 — operational suppressors must be liftable, or the gate traps
  // its own release. Consent tags are NOT covered here; see the note above.
  if (action.action_type === 'remove_tag'
      && isRemovableOperationalSuppressionTag(action.action_payload?.tag)) return true;
  return false;
}
```

Add unit tests asserting both directions:

```js
// must be exempt
isMutationGateExempt({ action_type:'remove_tag', action_payload:{ tag:'suppress-automation' }}) === true
// must NOT be exempt — the compliance guarantee
isMutationGateExempt({ action_type:'remove_tag', action_payload:{ tag:'dnc' }}) === false
isMutationGateExempt({ action_type:'remove_tag', action_payload:{ tag:'stop-bot' }}) === false
isMutationGateExempt({ action_type:'remove_tag', action_payload:{ tag:'do-not-contact' }}) === false
```

The negative assertions matter more than the positive one. They are the regression guard on the compliance boundary.

---

# §1d — Backfill: 1,525 contacts, canvassing excluded

Run only after §1a–§1c are deployed and verified.

```sql
SELECT ghl_contact_id FROM contact_tag_snapshot
WHERE 'suppress-automation' = ANY(tags)
  -- lead-initiated / consent
  AND NOT ('stop-bot'         = ANY(tags))
  AND NOT ('dnc'              = ANY(tags))
  AND NOT ('dnc-sms'          = ANY(tags))
  AND NOT ('do-not-contact'   = ANY(tags))
  AND NOT ('stage:dnc'        = ANY(tags))
  AND NOT ('unsubscribed'     = ANY(tags))
  -- structural
  AND NOT ('hard-disqualified'= ANY(tags))
  -- Mark's requirement: leave canvassing alone
  AND NOT ('active-entry:canvassing' = ANY(tags));
```

Expected: **1,525**.

- Batches of **200**, with a pause between.
- Run from a script with the GHL rate limiter in front. **Not** through the executor.
- Watch `getRateLimiterStats()` between batches. The June 4/5 token-starvation incident came from exactly this shape of bulk tag operation, and it ran ~12 hours silently.
- Stop immediately if the limiter wait queue exceeds 15 (the existing `LIMITER_QUEUE_ALERT_THRESHOLD`).

Canvassing contacts keep their `suppress-automation` tag. That is now cosmetic for mutations, and §1b is what actually protects them. Revisit once the canvassing cycle question in §1b is answered.

---

# §1e — Give the pause a TTL

`AUTOMATION_SUPPRESS_ON_BOOKING` applies `suppress-automation` with no expiry. That is why 4,720 applications became a standing population of 3,729. Without a TTL it rebuilds at ~4,600/year.

Add a sweep — or a `pg_cron` job once installed — removing `suppress-automation` from any contact whose booking is more than 48 hours old. §1c is what makes that removal actually succeed.

---

# Verification — gate each step

**After §1a–§1c, before the backfill:**

```sql
-- 1. suppressed share should fall (baseline ~42% of all actions)
SELECT status, count(*) FROM agent_actions
WHERE created_at > now() - interval '2 hours' GROUP BY status;

-- 2. S5.2 enrollment should start passing (baseline 60.8% blocked)
SELECT status, count(*) FROM agent_actions
WHERE action_type='add_to_workflow' AND created_at > now() - interval '2 hours'
GROUP BY status;

-- 3. stop-bot must STILL block mutations
SELECT count(*) FROM agent_actions a
JOIN contact_tag_snapshot t ON t.ghl_contact_id = a.target_id
WHERE a.created_at > now() - interval '2 hours'
  AND 'stop-bot' = ANY(t.tags) AND a.status='completed'
  AND a.action_type NOT IN ('add_tag','remove_tag');
-- expect 0

-- 4. THE CANVASSING GUARANTEE — no outbound to active canvassing leads
SELECT count(*) FROM agent_actions a
JOIN contact_tag_snapshot t ON t.ghl_contact_id = a.target_id
WHERE a.action_type IN ('send_message','add_to_workflow')
  AND a.status='completed'
  AND 'active-entry:canvassing' = ANY(t.tags)
  AND a.created_at > now() - interval '2 hours';
-- expect 0, EXCEPT direct replies (mode='agentic_reply'), which are allowed
-- by design. Inspect any rows before treating them as failures.
```

Check #4 first and treat any unexpected row as a stop-the-line event.

**After the backfill:**

```sql
SELECT
  count(*) FILTER (WHERE 'suppress-automation'=ANY(tags)) AS still_carrying,
  count(*) FILTER (WHERE 'suppress-automation'=ANY(tags)
                     AND 'active-entry:canvassing'=ANY(tags)) AS canvassing_untouched
FROM contact_tag_snapshot;
-- still_carrying should fall ~3,729 -> ~2,204
-- canvassing_untouched should hold at ~1,956
```

---

# What to expect, honestly

**Action volume and GHL API calls will RISE.** That is the intended outcome — mutations that were being dropped will execute. This is the opposite direction from the database work in PRs #648–#650, so do not read it as a regression.

Watch the rate limiter for the first 24 hours. If it deepens, throttle the §1d backfill first — never the live path.

**Do not start Item 2 (feeding S4.5) until every check above passes**, including the canvassing guarantee. Item 2 routes leads through the door this item opens.

---

# Working rules

1. §1a–§1c ship together. §1d only after they verify. §1e can follow.
2. **The negative tests in §1c are the compliance boundary.** Do not weaken them.
3. Never gate a rule that sets `bypass_suppression: true` — both `DNC_LIFT_ON_REENGAGEMENT_*` rules must keep firing on `stop-bot` contacts.
4. Reload the Decision Engine after any `agent_rules` change; assert the `rules_loaded` delta.
5. `node --check` is a parse, not verification — see `test/executor-heartbeat.smoke.test.js`.
6. Feature branch off `main`, PR, Mark merges. Never commit to `main`.
