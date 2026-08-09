# Companion to ITEM1_UNBLOCK_DOOR_FINAL.md — open findings

**Prepared:** 2026-08-08
**Last revised:** 2026-08-08 — §A1 RULED by Mark. Gate spec moved into the parent document.

> **The canvassing gate spec now lives in `ITEM1_UNBLOCK_DOOR_FINAL.md` §1b**, which is self-contained. This file is no longer a correction to it — it holds three findings that came out of the same investigation and need their own work.
>
> | | |
> |---|---|
> | **§A1** | `active-entry:other` — **RULED: it is a fallback.** Drop it from the gate. Fixing it is real work; scoped below. |
> | **§A2** | `active-entry:*` invariant breach — 1,209 contacts have none |
> | **§A3** | `lp_unmapped_sources.lead_count` is a broken counter |

---

## §A1 — `active-entry:other` is a fallback. RULED.

**Mark's ruling: it is a fallback that needs fixing.** Two consequences, one immediate and one structural.

### Immediate — it comes out of the gate

Drop `active-entry:other` from the `has_any_tag` clause in `ITEM1_UNBLOCK_DOOR_FINAL.md` §1b. The clause becomes:

```json
{
  "not_has_any_tag": ["active-entry:canvassing", "suppress-automation"],
  "has_any_tag": [
    "active-entry:estimate-calculator",
    "active-entry:high-intent-digital",
    "active-entry:referral",
    "active-entry:chatbot"
  ]
}
```

Marketable canvassing re-entry cohort: **295 → 52.**

| New `active-entry:*` | Contacts | In gate? |
|---|---:|---|
| `active-entry:other` | 243 | ❌ **dropped — fallback** |
| `active-entry:referral` | 28 | ✅ |
| `active-entry:high-intent-digital` | 10 | ✅ |
| `active-entry:estimate-calculator` | 9 | ✅ |
| `active-entry:chatbot` | 5 | ✅ |

### The evidence that makes this more than a technicality

Joining the 3,494 `active-entry:other` contacts back to their LP lead source:

| LP `lead_source_detail` | Contacts on `other` |
|---|---:|
| Lead Gurus | 1,232 |
| *(no LP lead found)* | 697 |
| Modernize | 466 |
| MyHomePros | 293 |
| MVP Marketing | 218 |
| HomeBuddy | 71 |
| **Canvass Sticky** | **64** |
| Porch101 | 55 |
| Prolific Marketing | 39 |
| Simpletext | 33 |

**64 of them are `Canvass Sticky` — canvassing leads sitting in the fallback bucket.** Had `active-entry:other` stayed in the gate, those 64 would have been marketed as "re-entered." That is a direct breach of Mark's rule, produced entirely by the fallback. This is not a hypothetical risk; it is 64 contacts today.

Note also that ~80% of the 3,494 have a resolvable LP source. Only 697 are genuinely unknown.

### Structural — stop assigning the fallback

`active-entry:other` is 3,494 contacts, the second-largest entry bucket. **All routing checks `active-entry:*`**, so every one of those contacts routes to a generic path instead of the entry bridge that matches how they actually arrived. That degrades E.x bridge selection, story-arc choice, and source attribution simultaneously.

Three pieces of work, in order:

**1. Map the sources that matter.** `lp_unmapped_sources` holds 544 unmapped combinations, none reviewed. Map `lead_source_detail` → entry bucket for the sources carrying real current volume:

| `lead_source_detail` | Leads, last 90 days |
|---|---:|
| Modernize | 5,301 |
| Lead Gurus | 3,942 |
| Canvass | 3,922 |
| MyHomePros | 2,365 |
| Porch101 | 992 |
| Simpletext | 570 |
| Google PPC Windows | 452 |
| Contractor Appointment-West | 231 |

⚠️ **Prioritise by 90-day volume, not by `lp_unmapped_sources.lead_count`** — that column is broken, see §A3. Ranking by it would send you to map "Contractor Appointment Rev Share" first, which has produced **32 leads in 90 days**.

**2. Reclassify the existing 3,494.** ~2,800 have a resolvable LP source and can be re-derived. The 64 `Canvass Sticky` contacts should become `active-entry:canvassing`, which also removes them from the marketable cohort permanently rather than by gate exclusion. Run behind the rate limiter in batches, same discipline as the §1d backfill.

**3. Make the fallback loud.** A silent fallback is what let 3,494 contacts accumulate unnoticed. When the router cannot classify a source it should still assign `active-entry:other` — never fail the contact — but also emit a `system_event` so the unmapped source surfaces. Weekly, not per-lead; the point is visibility, not noise.

**Do not gate on `active-entry:other` anywhere else either.** Grep `agent_rules` for it before shipping:

```sql
SELECT rule_key FROM agent_rules
WHERE enabled AND (conditions::text ILIKE '%active-entry:other%'
                OR context_conditions::text ILIKE '%active-entry:other%');
```

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

The "exactly one" half holds perfectly, which is why the gate in §1b is unambiguous for the 10,914 that have a tag. But 10% of the snapshot is unrouteable by any `active-entry:*`-based rule, and all routing checks `active-entry:*`. These contacts are invisible to the routing layer.

Out of scope for Item 1; should not delay it. Its own investigation:

1. What strips `active-entry:*` without replacing it? Look for `remove_tag` actions on `active-entry:*` with no paired `add_tag`.
2. Are the 747 with no `entry:*` simply pre-dating the entry-tag system? Check their `created_at`.
3. A repair sweep could re-derive `active-entry:*` from `entry:*` where it exists — 462 of the 1,209 qualify. That would shrink the §1b leak surface from 193 to 0 and is the durable fix for it.

This shares a root cause with §A1: both are the routing layer losing track of where a lead came from. Worth doing them together.

---

## §A3 — `lp_unmapped_sources.lead_count` is a broken counter

It is incrementing per sync cycle rather than per distinct lead, so it overstates by roughly an order of magnitude and the error scales with how long a source has existed — which means it systematically over-ranks old, dead sources.

| `source_subdetail` | `lead_count` says | Actual `lp_leads` | Last 90 days |
|---|---:|---:|---:|
| Contractor Appointment Rev Share | 211,656 | 28,162 | **32** |
| MyHomePros | 131,397 | 5,974 | 2,365 |
| Porch101 | 90,854 | 6,216 | 992 |
| Canvass Sticky | 52,950 | 3,233 | 106 |

The top figure exceeds the entire `lp_leads` table (229,548 rows), which is the tell.

Also every row has `reviewed = false` — the review workflow the table implies has never been used.

**Impact:** anyone prioritising source-mapping work from this column maps dead sources first. Fix the increment to be per distinct `lp_lead_id`, or drop the column and compute volume from `lp_leads` on demand. Until then, treat the column as unusable and rank by the 90-day query in §A1.

---

## Verification — canvassing guarantee

Both checks live in `ITEM1_UNBLOCK_DOOR_FINAL.md` under "Verification" (checks 4 and 5). Two notes on why they are shaped the way they are:

**Check 4 keys on `entry:canvassing`, not `active-entry:canvassing`.** `entry:*` is permanent attribution, so it stays on a contact forever — that is precisely what makes it a reliable net. It catches the 193 whose `active-entry:canvassing` was stripped and never replaced; a check on the active tag alone cannot see them. The check does not over-fire on genuine re-entries, because its second clause requires the absence of *any* non-canvassing `active-entry:*` — a lead who really came back has one, and drops out of the result.

**Check 5 is the positive control**, and its expected value changes with this ruling: **~52, not ~295**, now that `active-entry:other` is excluded. If it returns ~295, the gate still has the fallback in it.
