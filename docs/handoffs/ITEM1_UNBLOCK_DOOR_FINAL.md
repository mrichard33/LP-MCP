# Claude Code Handoff — Item 1 (FINAL): Unblock the door, canvassing-safe

**Prepared:** 2026-08-08
**Last revised:** 2026-08-08 — §1b rewritten with Mark's re-entry rule. This file is now self-contained.
**Approved by Mark:** proceed with unblocking, with two additions — do not market canvassing leads until they re-enter, and fix the `remove_tag` exemption.

**This is the authoritative Item 1 spec.** It supersedes Item 1 of `UNBLOCK_DOOR_AND_NURTURE.md`, which contained a compliance defect and has had that section removed.

`ITEM1_ADDENDUM_canvassing_gate.md` is a companion, not a correction — it holds two open findings (the `active-entry:other` question and the `active-entry:*` invariant breach). The gate spec itself now lives here in §1b.

---

## What was wrong in the earlier version

### 1 — the `remove_tag` exemption was a compliance hole

The earlier spec said to widen the existing exemption:

```js
// ❌ DO NOT DO THIS
if ((action.action_type === 'add_tag' || action.action_type === 'remove_tag')
    && isSuppressionAuditTag(action.action_payload?.tag)) return true;
```

`SUPPRESSION_AUDIT_TAG_RE` is:

```js
/^(dnc|dnc-|do-not-contact|stop-bot|suppress[-:]|hard-disqualified|quarantined|audit-|compliance-|loss-reason:)/i
```

It matches `dnc`, `do-not-contact` and `stop-bot`. Exempting `remove_tag` against it would let **any** rule strip a consent tag with no explicit opt-in.

**The add/remove asymmetry is deliberate.** Adding a suppression tag is always safe — it makes the system quieter. Removing one is not symmetric: it makes the system louder against someone who may have legally opted out. That is why `DNC_LIFT_ON_REENGAGEMENT` declares `bypass_suppression: true` — the opt-in *is* the audit trail. Corrected in §1c.

### 2 — the backfill cohort was wrong

Sized at ~3,137. **1,956 of the 3,729 carriers (52%) are `active-entry:canvassing`.** Real cohort: **1,525**.

### 3 — the canvassing gate was negative-only

`not_has_any_tag: ["active-entry:canvassing"]` is unsafe. Corrected in §1b.

---

## Measured state

| | |
|---|---:|
| Carrying `suppress-automation` | 3,729 |
| …also `agentic-active` | 3,052 |
| …**also `active-entry:canvassing`** | **1,956 (52%)** |
| …clean of compliance/DQ tags | 3,137 |
| **Final backfill cohort (canvassing excluded)** | **1,525** |
| `active-entry:canvassing` total | 6,065 |
| `entry:canvassing` total | 6,416 |
| …re-entered with a new `active-entry:*` | **295** |
| …**`entry:canvassing` with NO `active-entry:*` at all** | **193** |

Canvassing is the largest entry bucket in the system, roughly half the snapshot population.

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

# §1b — Canvassing: market only after genuine re-entry

### Mark's rule

> Market a canvassing lead only after it re-enters the system with a **new** `active-entry:*` tag and no longer carries `active-entry:canvassing`.

This matches the system's own invariant: `active-entry:*` is the **current** source and is swapped on re-entry; `entry:*` is permanent attribution. A canvassing lead who later fills out the calculator becomes `active-entry:estimate-calculator` / `entry:canvassing` — they have self-identified through a new channel and marketing is appropriate. While the canvasser is still working the door, it is not.

**`canvass-marketing-complete` is NOT a graduation signal.** All 195 contacts carrying it still carry `active-entry:canvassing`. Ignore it for gating.

### ⚠️ Where the protection must live

**Not in the backfill.** §1a is a global code change — once `suppress-automation` stops gating mutations it stops gating them for canvassing contacts too, tag or no tag. Leaving the tag on them protects nothing. The protection sits on the **send path**.

### The universal floor

Add to `SUPPRESS_TAGS` in `src/services/suppression-check.js`:

```js
  // 2026-08-08 — canvassing leads are worked door-to-door by a human
  // canvasser. Automated marketing on top of an active canvassing cycle
  // competes with the person standing on the doorstep. 6,065 contacts carry
  // this — the largest entry bucket in the system.
  //
  // Deliberately in SUPPRESS_TAGS (default mode) and NOT in
  // REPLY_BLOCKING_TAGS: if a canvassed homeowner texts us back, the bot
  // should still answer. This blocks proactive outbound and nurture, not a
  // direct reply — matching the 2026-07-07 always-respond policy.
  'active-entry:canvassing',
```

### The rule-level gate — MUST be two-clause

⚠️ **A negative gate alone is unsafe and would violate Mark's rule.**

| Cohort | Contacts | Marketable? |
|---|---:|---|
| `active-entry:canvassing` present | 6,065 | ❌ No |
| `entry:canvassing` + new `active-entry:*` | **295** | ✅ Yes — genuine re-entry |
| `entry:canvassing` + **no `active-entry:*` at all** | **193** | ❌ **No — did not re-enter** |

Those 193 had `active-entry:canvassing` stripped and never replaced. They are canvassing leads with a **missing** tag, not leads who came back through a new channel. `not_has_any_tag: ["active-entry:canvassing"]` reads that absence as re-entry and would market to all 193 — the exact outcome the rule prevents.

Require a new `active-entry:*` to be **present**:

```json
{
  "not_has_any_tag": ["active-entry:canvassing", "suppress-automation"],
  "has_any_tag": [
    "active-entry:estimate-calculator",
    "active-entry:high-intent-digital",
    "active-entry:referral",
    "active-entry:chatbot",
    "active-entry:other"
  ]
}
```

Both clauses required. The first excludes active canvassing; the second proves a real re-entry rather than a tag going missing.

`suppress-automation` sits in the negative clause deliberately — **this is where the booking pause belongs.** §1a removes it as a universal mutation blocker; this restores its real purpose, gating nurture enrollment.

Apply to every nurture-enrollment rule, including the S4.5 rule when Item 2 ships. This mirrors the existing pattern where `AGENTIC_RESPOND_POST_CHATBOT` carries a rule-level backstop over the universal floor.

**Enumerate the live values before writing** — do not trust the list above to be complete:

```sql
SELECT t AS active_entry, count(*) FROM contact_tag_snapshot, unnest(tags) t
WHERE t LIKE 'active-entry:%' GROUP BY t ORDER BY 2 DESC;
```

If a new entry bucket ships later and is not added here, those leads are silently excluded from marketing. Leave a comment on the rule saying the list must be maintained alongside the E.x entry bridges.

### ⚠️ Confirm `active-entry:other` with Mark before shipping

243 of the 295 re-entries (**82%**) land in `active-entry:other`. Before treating that as a marketing trigger, confirm what writes it:

- A genuine catch-all entry bridge for a real low-volume source → marketing is appropriate.
- The router's **fallback** when it cannot classify a source → then it means "we don't know," not "they re-entered," and marketing 243 canvassing leads on that basis is not what Mark asked for.

`active-entry:other` is 3,494 contacts system-wide, the second-largest bucket, and there are 544 unmapped LP sources — a fallback is plausible. **If it is a fallback, drop it from `has_any_tag`;** the marketable cohort becomes 52, which is small but correct and grows as classification improves.

### Coverage gap to be aware of

`SUPPRESS_TAGS` is a flat list and cannot express the two-clause condition. So the floor blocks the 6,065 active canvassing contacts — the large majority of the risk — while **the 193 missing-tag contacts are caught only by the rule-level `has_any_tag` clause.** Every nurture-enrollment rule must carry it. If a nurture path is added later without it, those 193 leak. See §A2 of the addendum for the durable fix.

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
- Watch `getRateLimiterStats()` between batches. The June 4/5 token-starvation incident came from exactly this shape of bulk tag operation and ran ~12 hours silently.
- Stop immediately if the limiter wait queue exceeds 15 (the existing `LIMITER_QUEUE_ALERT_THRESHOLD`).

Canvassing contacts keep their `suppress-automation` tag. That is now cosmetic for mutations; §1b is what actually protects them.

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

-- 4. THE CANVASSING GUARANTEE — run this FIRST, any row is stop-the-line.
-- Keys on entry:canvassing (permanent attribution), NOT active-entry:canvassing,
-- so it also catches the 193 contacts whose active-entry tag went missing.
-- Direct replies are exempt by design — inspect any row before calling it a
-- failure.
SELECT a.id, a.rule_applied, a.action_type, a.target_id
FROM agent_actions a
JOIN contact_tag_snapshot t ON t.ghl_contact_id = a.target_id
WHERE a.action_type IN ('send_message','add_to_workflow')
  AND a.status = 'completed'
  AND a.created_at > now() - interval '2 hours'
  AND 'entry:canvassing' = ANY(t.tags)
  AND NOT EXISTS (
    SELECT 1 FROM unnest(t.tags) x
    WHERE x LIKE 'active-entry:%' AND x <> 'active-entry:canvassing'
  );
-- expect 0

-- 5. POSITIVE CONTROL — genuine re-entries must NOT be blocked
SELECT count(*) FROM contact_tag_snapshot t
WHERE 'entry:canvassing' = ANY(t.tags)
  AND EXISTS (SELECT 1 FROM unnest(t.tags) x
              WHERE x LIKE 'active-entry:%' AND x <> 'active-entry:canvassing');
-- expect ~295 (or ~52 if active-entry:other is excluded)
```

Checks 4 and 5 must both pass. The first proves nothing leaks; the second proves the gate is not simply blocking everyone.

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

# Related documents

| Document | Covers |
|---|---|
| `ITEM1_ADDENDUM_canvassing_gate.md` | `active-entry:other` question; `active-entry:*` invariant breach (1,209 contacts) |
| `UNBLOCK_DOOR_AND_NURTURE.md` | Items 2 and 3, plus the `suppress-automation` reasoning record |
| `SUPPRESSION_LEFT.md` | `stop-bot` move-left work; `HARD_DISQUALIFIED_CLOSEOUT` bug |

---

# Working rules

1. §1a–§1c ship together. §1d only after they verify. §1e can follow.
2. **The negative tests in §1c are the compliance boundary.** Do not weaken them.
3. **The `has_any_tag` clause in §1b is not optional.** Without it, 193 contacts leak.
4. Never gate a rule that sets `bypass_suppression: true` — both `DNC_LIFT_ON_REENGAGEMENT_*` rules must keep firing on `stop-bot` contacts.
5. Reload the Decision Engine after any `agent_rules` change; assert the `rules_loaded` delta.
6. `node --check` is a parse, not verification — see `test/executor-heartbeat.smoke.test.js`.
7. Feature branch off `main`, PR, Mark merges. Never commit to `main`.
