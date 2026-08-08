# ADDENDUM to ITEM1_UNBLOCK_DOOR_FINAL.md — §1b canvassing gate, corrected

**Prepared:** 2026-08-08
**Read this instead of §1b in `ITEM1_UNBLOCK_DOOR_FINAL.md`.** Everything else in that document stands unchanged.

---

## Mark's rule

> "I only want to market a canvassing lead after it re-enters our system with a new `active-entry:*` tag and no longer the tag `active-entry:canvassing`."

This is the right rule and it matches the system's own invariant: `active-entry:*` is the **current** source and is swapped on re-entry, while `entry:*` is permanent attribution. A canvassing lead who later fills out the calculator becomes `active-entry:estimate-calculator` / `entry:canvassing`, and at that point they have self-identified through a new channel. Marketing them is appropriate. Marketing them while a canvasser is still working the door is not.

**It also settles the open question from §1b.** `canvass-marketing-complete` is **not** a graduation signal — all 195 contacts carrying it still carry `active-entry:canvassing`. Ignore it for gating purposes, exactly as Mark's rule does.

---

## ⚠️ The gate must be POSITIVE, not negative

This is the correction. `not_has_any_tag: ["active-entry:canvassing"]` **is not safe** and would violate the intent of the rule.

Measured population:

| Cohort | Contacts | Marketable under Mark's rule? |
|---|---:|---|
| `active-entry:canvassing` present | 6,065 | ❌ No |
| `entry:canvassing`, new `active-entry:*` present | **295** | ✅ Yes — genuine re-entry |
| `entry:canvassing`, **no `active-entry:*` at all** | **193** | ❌ **No — did not re-enter** |

Those 193 contacts had `active-entry:canvassing` stripped and never replaced. They are canvassing leads with a **missing** tag, not leads who came back through a new channel. A negative gate reads "canvassing tag absent" as "re-entered" and would market to all 193 — the precise outcome the rule exists to prevent.

### The correct gate

Require a new `active-entry:*` to be **present**, not merely require the canvassing one to be absent:

```json
{
  "not_has_any_tag": ["active-entry:canvassing"],
  "has_any_tag": [
    "active-entry:estimate-calculator",
    "active-entry:high-intent-digital",
    "active-entry:referral",
    "active-entry:chatbot",
    "active-entry:other"
  ]
}
```

Both clauses are required. The first excludes active canvassing; the second proves a real re-entry happened rather than a tag going missing.

**Before writing this, enumerate the live values** — do not trust the list above to be complete:

```sql
SELECT t AS active_entry, count(*) FROM contact_tag_snapshot, unnest(tags) t
WHERE t LIKE 'active-entry:%' GROUP BY t ORDER BY 2 DESC;
```

If a new entry bucket ships later and is not added here, those leads are silently excluded from marketing. That failure mode is quiet, so leave a comment on the rule saying the list must be maintained alongside the E.x entry bridges.

### Placement

Unchanged from §1b: the universal floor goes in `SUPPRESS_TAGS` (default mode), **not** `REPLY_BLOCKING_TAGS`, so a canvassed homeowner who texts us still gets an answer. The rule-level gate above is defence in depth on nurture-enrollment rules.

Note that `SUPPRESS_TAGS` is a flat list and cannot express the two-clause condition. So:

- **`SUPPRESS_TAGS`** keeps the simple `'active-entry:canvassing'` entry — that correctly blocks the 6,065 active canvassing leads, which is the large majority of the risk.
- **The 193 no-tag contacts are not covered by that floor.** They are caught by the rule-level `has_any_tag` clause. Every nurture-enrollment rule must carry it. If a nurture path is added later without it, those 193 leak.

A cleaner long-term fix is §A2 below — repair the invariant so the 193 stop existing.

---

## §A1 — `active-entry:other` is doing most of the work. Confirm it before shipping.

Of the 295 genuine re-entries:

| New `active-entry:*` | Contacts |
|---|---:|
| `active-entry:other` | **243** |
| `active-entry:referral` | 28 |
| `active-entry:high-intent-digital` | 10 |
| `active-entry:estimate-calculator` | 9 |
| `active-entry:chatbot` | 5 |

**82% of re-entries land in `other`.** Before treating that as a marketing trigger, confirm what writes it. Two very different possibilities:

- It is a genuine catch-all entry bridge (E.x) for a real, low-volume source → marketing is appropriate.
- It is the router's **fallback** when it cannot classify a source → then `active-entry:other` means "we don't know," not "they re-entered," and marketing 243 canvassing leads on that basis is not what Mark asked for.

This matters: `active-entry:other` is 3,494 contacts system-wide, the second-largest bucket. Combined with **544 unmapped LP sources**, a classification fallback is plausible.

**If `other` turns out to be a fallback, drop it from the `has_any_tag` list.** The marketable cohort then becomes 52 contacts rather than 295 — small, but correct, and it stays correct as the properly-classified buckets grow.

Ask Mark. Do not decide this one in code.

---

## §A2 — Invariant breach: 1,209 contacts have no `active-entry:*` at all

The stated invariant is **one `active-entry:*` tag per contact at all times**. Measured:

| | Contacts |
|---|---:|
| More than one `active-entry:*` | **0** ✅ |
| Exactly one | 10,914 |
| **Zero** | **1,209** ❌ |

Breakdown of the 1,209:

| | Contacts |
|---|---:|
| No `entry:*` either — never routed | 747 |
| Has some other `entry:*` | 269 |
| Has `entry:canvassing` | **193** |

The "exactly one" half of the invariant holds perfectly, which is good news — it means the gate above is unambiguous for the 10,914 contacts that have a tag. But 10% of the snapshot is unrouteable by any `active-entry:*`-based rule, and **all routing checks `active-entry:*`**. These contacts are invisible to the routing layer.

This is out of scope for Item 1 and should not delay it. Log it as its own investigation:

1. What strips `active-entry:*` without replacing it? Look for `remove_tag` actions on `active-entry:*` with no paired `add_tag`.
2. Are the 747 with no `entry:*` either simply pre-dating the entry-tag system? Check their `created_at`.
3. A repair sweep could re-derive `active-entry:*` from `entry:*` where the latter exists — 462 of the 1,209 have one. That would shrink the leak surface for the gate above from 193 to 0.

---

## Verification — replaces check #4 in the parent document

```sql
-- THE CANVASSING GUARANTEE. Any row here is stop-the-line.
-- Blocks both active canvassing AND canvassing leads whose active-entry
-- tag went missing (the 193). Direct replies are exempt by design —
-- inspect any row before treating it as a failure.
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
```

Note this checks `entry:canvassing` (permanent attribution), not `active-entry:canvassing`. That is deliberate — it catches the 193 missing-tag contacts that a check on the active tag alone would miss.

Positive control — confirm genuine re-entries are NOT being blocked:

```sql
SELECT count(*) FROM contact_tag_snapshot t
WHERE 'entry:canvassing' = ANY(t.tags)
  AND EXISTS (SELECT 1 FROM unnest(t.tags) x
              WHERE x LIKE 'active-entry:%' AND x <> 'active-entry:canvassing');
-- expect ~295 (or ~52 if active-entry:other is excluded per §A1)
```

Both checks must pass. The first proves nothing leaks; the second proves the gate is not simply blocking everyone.
