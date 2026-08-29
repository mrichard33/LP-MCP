# GHL contact-link backfill — tier analysis and sign-off record

Back-filling `ghl_contact_id` on stranded `lp_leads`, `lp_jobs` and
`lp_job_milestones`. Three tiers, ascending in risk, with a sign-off gate
between each. This document carries the measurements each gate needs.

**Status (2026-08-29): Tier A BUILT, MERGED AND RUN — see results below.
Tier B probed and recommended for CLOSURE, not construction: the premise it
rests on is false. Tier C not built; blocked on Mark's GHL UI changes.**

All figures measured against production LP Supabase on 2026-08-29. The live
15-minute sync moves them by tens of rows per hour; re-measure with
`node scripts/backfill-ghl-link-propagate.js --dry-run` before acting.

---

## Preflight — the three branches flagged for collision

| Branch | State | Relevant? |
|---|---|---|
| `claude/backfill-coverage-probe` (94b89c2) | **Open, unmerged, stale since 2026-07-13** | No conflict. It is a dry-run *diagnostic* on the RTP job backfill (`admin/lp-rtp-job-backfill.js`) that cross-references discovered contract ids against `lp_jobs`. It touches milestone **suppression counters**, not identity resolution. Nothing in it overlaps this work. |
| `claude/early-match-gate-1xaf6l` | **Merged** (PR #770, 2026-08-27) | Already in `main`. Despite the name it is Call-Intelligence matching — resolving a *call recording* to an LP record before transcription. Different problem, different tables (`ci_*`). Not identity matching for GHL links. |
| `claude/canvassing-leads-lp-block-2fr7pg` | **Merged** (PR #775, 2026-08-28) | Already in `main`. Stale idempotency marks blocking canvassing leads into LP. Unrelated. |

**Built on `main`** — d49d3ce for the Tier A PR, re-cut from 0ba6168 (which
carries both that merge and PR #778) for this one. Not on any of the three
flagged branches. No rebase or coordination needed.

The matching logic this project needs already exists and is **not** on any of
those branches — it is in `main`, in `src/services/link-corroboration.js`
(identity corroboration, verdict caching, conflict recording) plus
`sql/046_link_corroboration_identity_sync.sql`, which is where
`lp_link_verifications` (1,574 rows) and `lp_link_conflicts` (128 rows) come
from. **Tier B should extend that resolver, not write a second matcher.**

---

## The finding that changes the plan

The brief assumes Tier A "should resolve a large share of the 67,210 milestone
nulls". It resolves **22%**. Here is where the nulls actually live:

| Cohort | Milestone rows | Distinct leads |
|---|---:|---:|
| Parent lead **already linked** → Tier A resolves | **14,807** | 902 |
| Parent lead **also null** → needs Tier B/C | **51,977** | **3,238** |
| Total null | 66,882 | 4,140 |

And those 3,238 blocking leads are almost entirely **outside Tier B's 90-day
window**:

| Age of the blocking lead | Milestone rows |
|---|---:|
| Within 90 days (Tier B's scope) | **329** |
| 90 days – 1 year | 32,073 |
| Older than 1 year | 19,575 |

### Consequence: the completion criteria are unreachable as scoped

> "lp_job_milestones with null ghl_contact_id drops below 5,000 (from 67,210)."

Tier A (−14,807) plus Tier B at its specified 90-day scope (−329 at absolute
best) leaves **~51,700**, not under 5,000. The gap is not a matching-quality
problem; it is a scope problem. The milestone backlog is carried by **old jobs**,
and Tier B is scoped to **new leads**. The two barely intersect.

**CORRECTED 2026-08-29 — this section's original recommendation was wrong.**
It proposed widening Tier B to the 3,238 job-bearing leads on the reasoning that
"every row is a real customer with work in production, so phone/email match
rates should be well above the cold-lead average." That was an assumption, and
measuring it falsified it: those leads match at **3.3%**, not above average.
Widening the scope would not have helped. See "Tier B" below for the measurement
that replaced this guess.

I did check the cheaper alternative — propagating from a linked **sibling lead
under the same `lp_prospect_id`** (repeat inquiries from one household). It
recovers only **385** of the 51,977 rows, with 0 ambiguous. Not worth the extra
identity assumption. Rejected.

---

## Tier A — propagate links that already exist

**BUILT, MERGED (PR #777) AND RUN on 2026-08-29. Zero external calls.**

### Run record

Executed through the same `run_sql` RPC the runner calls
(`src/admin/supabase-admin.js` → `runSQL`), using the statements verbatim from
`sql/075_ghl_link_propagate.sql`. Undo snapshots
`lp_link_propagate_undo_jobs_20260829` (830 rows) and
`lp_link_propagate_undo_ms_20260829` (13,489 rows) were captured first.

| | before | after |
|---|---:|---:|
| `lp_job_milestones` null link | 65,465 | **51,944** |
| `lp_jobs` null link | 4,068 | **3,236** |
| targeted cohort (milestones) | 13,521 | **0** |
| targeted cohort (jobs) | 832 | **0** |
| **`armed` milestone fires** | **12,321** | **12,321** |
| `lp_leads` rows / linked | 235,955 / 18,897 | 235,955 / 18,897 |
| `lp_link_conflicts` | 129 | 129 |

Every invariant held. `armed` came back **exactly** unchanged — the safety case
was not merely argued, it was measured: propagating 13,521 links altered the
fire set by zero rows. `lp_leads` and `lp_link_conflicts` untouched, as intended.
The one job whose link disagrees with its parent lead is still there, still
untouched.

- `sql/075_ghl_link_propagate.sql` — the two `UPDATE`s, source of truth
- `scripts/backfill-ghl-link-propagate.js` — runner: measurement, undo
  snapshot, post-run invariant
- `scripts/test-ghl-link-propagate.js` — regression guard on the safety case

Scope: **14,807 milestone rows + 918 job rows across 902 leads.**

### Why it cannot fire a tag

This is the whole safety case, and it is a property of the code rather than a
judgement call. `processMilestoneTriggers` (`src/milestones.js`):

1. Its `SELECT` filters on `act_date` and `ghl_tag_fired` **only** —
   `ghl_contact_id` is not in the predicate, so which rows are *considered*
   does not depend on the column being backfilled.
2. It resolves the destination at line 147 as
   `milestone.ghl_contact_id || leadData.ghl_contact_id` — the "Bug 10"
   fallback, which already reads the link straight off `lp_leads`.

So every row Tier A touches is **already resolvable today**. 5,376 of the
14,807 are armed (achieved `act_date`, unfired, tag-mapped) at this moment,
with or without the backfill. Tier A changes *where the id is read from*, never
*whether a tag fires*. The fire set is identical before and after.

`scripts/test-ghl-link-propagate.js` guards both properties so a future edit to
the sweeper cannot silently invalidate this. The runner also prints
`armed_before` / `armed_after` so the claim is checked at run time, not just
asserted here.

There is direct evidence for this in the live data. Over roughly 40 minutes of
measuring on 2026-08-29 the targeted cohort shrank on its own — 14,807 →
14,512 → 14,143 — with no backfill running. That is the sweeper resolving these
rows through the line-147 fallback, firing them, and writing the id down as it
goes (`src/milestones.js` lines 157–161 do exactly this on a successful fire).
Production is already performing Tier A's write, one row at a time, as a side
effect of the fires it is already doing. Tier A does the same write in bulk for
rows the sweeper has not reached yet, and stops there — it does not fire.

### Verification after running

The brief asks that the drop match the join. The runner asserts something
stronger and drift-proof: that the **targeted cohort is empty** afterwards
(`ghl_contact_id IS NULL` AND parent lead linked → 0 rows). A raw delta
comparison would fail spuriously because the live sync inserts new null rows
mid-run; the runner reports that drift separately.

### Not wired into `runMigrations()`

Deliberately. Every other `sql/0NN` file is additive DDL and is mirrored into
`runMigrations()` so a deploy self-heals. This one is a *data* backfill:
mirroring it would make every process restart silently propagate whatever links
Tier B promoted since the last boot — exactly the un-gated propagation the tier
separation exists to prevent. A test asserts it stays unmirrored.

### One thing left alone

Exactly **one** `lp_jobs` row carries a link that disagrees with its parent
lead. Tier A only writes NULLs, so it is untouched. Reconciling it is a triage
decision, not a backfill's call. The runner reports the count.

---

## Tier B — match stranded leads to existing GHL contacts

**Probed, not built. Recommendation: close it out. The premise is false.**

Tier B assumes stranded LP leads have GHL contacts we failed to link. Measured
against the HL contacts mirror, normalising both sides to the last 10 phone
digits, with a control group:

| Cohort | Probed | Found in GHL | Rate |
|---|---:|---:|---:|
| **Control** — leads that ARE linked | 240 | 230 | **95.8%** |
| Stranded, job-bearing — full-cohort pass | 1,597 | 53 | **3.3%** |
| Stranded, job-bearing — earlier sample | 273 | 8 | 2.9% |
| Stranded, created in last 90 days | 260 | 3 | **1.2%** |

The control proves the method and the mirror are sound; the stranded cohorts
genuinely have no GHL counterpart. **Zero ambiguous matches across all 2,130
leads probed** — so Tier B would add no `lp_link_conflicts` rows at all.

### Why: LP and GHL were never the same population

- GHL holds **18,229** contacts.
- LP holds **235,955** leads; 18,897 rows carry a link, resolving to **12,246
  distinct** contacts.
- So the mirror holds ~6,000 contacts *not* linked to any LP lead — it is a real
  mirror of GHL, not a mirror of the linked set, and the probe is not circular.
  Tier B had ~6,000 genuine candidates to match into and hit 11.

LP is the full historical lead universe; GHL is the actively-marketed subset.
The 217,000 LP leads with no `ghl_contact_id` are overwhelmingly **not** a
linking defect — there is nothing on the GHL side to link them to.

At 3.3%, Tier B would recover ~107 of the 3,247 job-bearing leads, worth roughly
1,700 of the 51,944 remaining milestone nulls. The completion criteria
(<5,000 milestones, <500 recent orphans) are therefore unreachable by matching
at any scope — only mass contact **creation** moves them, which is Tier C at
3× to 10× its briefed volume.

### What was built instead

`scripts/probe-ghl-link-candidates.js` — a read-only reconciliation report
(writing is opt-in via `--write`, following `audit-orphan-ghl-links.js` rather
than the `backfill-*` convention, because it informs a go/no-go). It reuses
`corroborateIdentity` / `normalizeEmail` from
`src/services/link-corroboration.js` rather than adding a second matcher, and
batches indexed `.in()` lookups against the mirror. It never writes `lp_leads`.

`scripts/test-ghl-link-probe.js` pins the matching rules, including that
many-LP-leads-to-one-GHL-contact is normal and not a conflict.

### Decision 2: the promotion step is NOT low-risk, and the brief has this backwards

The brief places the flood risk in Tier C and calls Tier B "read-only until the
promotion step", implying promotion is cheap. It is the opposite, and for the
same line 147 that makes Tier A safe.

Writing a link onto `lp_leads` makes the sweeper's fallback resolve for leads
where it previously returned nothing. Promoting the job-bearing cohort would
**newly arm ~15,063 historical milestone tag fires** — each one a GHL tag plus
an `lp.milestone_completed` event into the Decision Engine, for installs that
finished months or years ago.

For comparison, Tier C's ~1,100 new contacts are *recent* leads carrying few or
no milestones. **Tier B's promotion is the larger blast radius of the two.**

This does not block Tier B. It means the promotion step needs the same
treatment Tier C gets: a decision about what should fire, and a throttle. The
mechanism already exists and is proven — `syncJobAndMilestones` supports
`suppressSideEffects`, which pre-marks first-time completions
`ghl_tag_fired = true` + `tag_suppressed_backfill` so the sweeper can never
match them (PR #527, `src/sync-children.js`). **Recommendation: pre-mark
historical milestones as suppressed at promotion time, and let only milestones
newer than an agreed cutoff fire.** Mark picks the cutoff.

Related, and worth knowing before setting that cutoff: the sweeper's `SELECT`
has no `.limit()` and no `ORDER BY`, so PostgREST caps it at ~1,000 arbitrary
rows per pass. The armed pool (12,271 rows right now) drains slowly and in no
particular order. That is a pre-existing defect, not one this project
introduces, but it means "it will fire eventually, in unpredictable order"
rather than "it fires all at once".

### To close Tier B out

1. Run the full credentialed pass (needs `SUPABASE_URL` + `HL_SUPABASE_URL`):
   `node scripts/probe-ghl-link-candidates.js --cohort=both`, then `--write` to
   record verdicts once the rate is confirmed.
2. Review the handful of `pass` verdicts in `lp_link_verifications` — far fewer
   than the 50 the brief anticipated, because there are not 50 to review.
3. Promote only those, and only with the suppression decision below applied.

Many-LP-leads-to-one-GHL-contact stays **normal** (3,872 contacts already map to
more than one lead; 3,785 share a phone). The resolver keys verdicts on
`(lp_lead_id, ghl_contact_id)`, so one contact serving many leads is not a
conflict — only *one lead with several candidate contacts* is. A test pins this.
Do not "fix" it.

---

## Tier C — create GHL contacts for the genuinely missing

**Not built. Prerequisite complete: the trigger enumeration below.**

Scope stays as briefed: **only 2026-08-13 → 2026-08-19**, ~1,100 leads, 50/min.

### Every published workflow with an active "contact created" trigger

Enumerated from the HL workflow mirror, 2026-08-29. Five, not three — the
GHL admin list only shows a workflow's *primary* trigger type, and two of these
carry `contact_created` as a secondary trigger.

**Unconditional — fires on every contact created. MUST be suppressed.**

| Workflow | GHL id | What it does to a Tier C contact |
|---|---|---|
| **I.AC All Contacts Created** | `fba00be6-88c9-423b-8db7-ccaa53705180` | 43 actions. Webhook **"Send Data to Agentic System"**; **"Add to Workflow: Zip Code Provided"**; "Add to Workflow I.NDB Notion Database Create / Update"; two AI extraction steps; and — on the no-email branch — **"Add Tag: contact:delete"**. |
| **I.C-NN Contact Normalizer** | `7413fff9-b1b1-48c5-bb23-b65385db6f09` | 15 actions. Webhook "Trigger Contact Created n8n"; drip 100 per 15 min; and on timeout **"Add Tags: no-contact-method, contact:delete"**. |

Left unsuppressed, Tier C would push ~1,100 aged leads into the agentic
system and Notion, run ~2,200 AI extraction steps, and risk tagging some of
them `contact:delete`.

**Conditional — safe *provided* Tier C sets none of these.**

| Workflow | Gate | Tier C must not… |
|---|---|---|
| I.CT Chatbot Contact Created Timeout | tag `chatbot` | apply the `chatbot` tag |
| I.HRQ HRR Lead Qualification | `contact.type == lead` **and** tag ∈ `entry:risk-report`, `source: risk-report`, `trigger-risk-report` | apply any risk-report tag |
| I.CC Canvassing Contact Created V1 | custom field **SalesRabbit ID** (`W76lpvv8JasHz2gv9E6T`) has a value | populate SalesRabbit ID |

Three other workflows match a text search for `contact_created` in their raw
JSON — A.CC-1, A.MV-1, A.WE-1 — but have **no** `contact_created` trigger
(confirmed: zero `$.**.type == "contact_created"` matches). They are
appointment-triggered. No action needed.

**Also worth a decision:** 39 published workflows trigger on `contact_tag` and
19 on `contact_changed`. If Tier C applies *any* tag to the new contacts, or if
Tier A/B then let milestone tags fire onto them, those become a second
enrollment path that suppressing the five above does not cover.

### Patch instructions for Mark (GHL UI — do not let this be automated)

For the run window only:

1. **I.AC All Contacts Created** — add a first-step condition that exits when
   the contact carries the backfill marker tag (see 3), or set the trigger
   inactive for the duration of the run. Preferred: the condition, so ordinary
   live intake keeps working while Tier C runs.
2. **I.C-NN Contact Normalizer** — same treatment on its "Contact Created"
   trigger.
3. Tier C should stamp every contact it creates with a distinctive marker tag
   (proposal: `backfill:lp-historic`) **at creation**, in the same API call, so
   the guard in 1 and 2 can key off it and so the cohort stays identifiable
   afterwards. A tag applied in a second call is too late — the trigger has
   already fired.
4. Re-enable both after the run and confirm live intake still enrolls.

Marker-tag caveat: adding a tag at creation is itself a `contact_tag` event.
Confirm no published `contact_tag` workflow uses a wildcard or
`contains-any` match that `backfill:lp-historic` would satisfy before
choosing the final tag name.

---

## Dependency: Project 2

**Appears to have landed** while this work was in flight: PR #778
(`claude/ghl-tag-webhook-durability-0st9dn`, merged into `main` as `0ba6168`)
fixes per-contact ordering in the GHL tag inbox worker — a failed row no longer
lets a later row for the same contact advance the snapshot past it and emit the
difference as tag *removals*. That is the tag-event durability defect Project 3
was told to wait for. **Mark should confirm it is the whole of Project 2** before
Tier C runs.

It was never a gate on Tier A: Tier A changed no firing behavior at all, so
there were no tag events for the defect to lose.

---

## Post-deploy verification (48 hours after each tier)

```sql
SELECT count(*) FROM lp_job_milestones WHERE ghl_contact_id IS NULL;
SELECT count(*) FROM lp_leads
 WHERE ghl_contact_id IS NULL AND created_at_lp > now() - interval '90 days';
SELECT count(*) FROM lp_link_conflicts WHERE detected_at > now() - interval '48 hours';
```

Tier A actual (2026-08-29): milestones **51,944** (from 65,465), jobs **3,236**
(from 4,068), leads and conflicts **unchanged**, `armed` unchanged at 12,321.
A later change in `lp_leads` or `lp_link_conflicts` means something other than
Tier A ran.

The milestone figure keeps falling on its own between runs — that is the
sweeper stamping ids down as it fires, not measurement drift. Compare against
the number the runner prints, not against this document.
