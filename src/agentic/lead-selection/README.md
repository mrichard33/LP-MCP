# Lead Selection Engine v1

Scores the already-classified book (`agentic_lead_states`) into a ranked, **segmented**
re-engagement candidate list (`agentic_reengagement_candidates`) and — only behind an env flag +
approval — enrolls the top of that list into **S1.3 Stale Lead Revival** (GHL workflow
`32fa691b-2422-4727-83c9-1174801974e9`).

Sibling of `../lead-state/enroll-existing-eligible.js`. Reuses the lead-state taxonomy, the 0.75
confidence floor, the Supabase client, and the `add_to_workflow` agent_action pattern. **No GHL writes
from code** — enrollment is an agent_action the executor performs. Ships **dark** (shadow) by default.

## Why S1.3 is REACTIVATION (not S4.5 nurture)
`SUPPRESSION_STATES` gates S4.5 *nurture* eligibility. `states.js`'s own doctrine routes post-demo
declines and confirmed losses **to** reactivation (S5.2 / L.*). So this engine **includes** the two
decline/loss states as primary targets (recency-gated), instead of excluding them. The hard-exclude
list is derived: `SUPPRESSION_STATES` minus the reactivation states, plus `UNCLASSIFIED`.

```
S1_3_REACTIVATION_STATES = [SUPPRESSED_POST_DEMO_DECLINE, SUPPRESSED_CONFIRMED_LOSS]
S1_3_HARD_EXCLUDE = SUPPRESSION_STATES.filter(not reactivation) + UNCLASSIFIED
  = ACTIVE_BOFU, APPT_BOOKED, IN_NARRATIVE_NURTURE, SUPPRESSED_ACTIVE_NARRATIVE,
    RECENT_REP_CONTACT, CUSTOMER_P2, SUPPRESSED_LEGAL, UNCLASSIFIED
```

## Run it
```bash
# Score pass — selects, scores, upserts the candidate table, returns the report.
curl -XPOST $HOST/admin/lead-selection/run -H 'content-type: application/json' \
  -d '{"mode":"score","limit":2000}'

# Read-back report of the candidate table (no re-scoring).
curl -XPOST $HOST/admin/lead-selection/report

# Enroll pass — SHADOW unless S1_REENGAGEMENT_ENABLED=true; dry_run forces shadow.
curl -XPOST $HOST/admin/lead-selection/run -H 'content-type: application/json' \
  -d '{"mode":"enroll","limit":25,"dry_run":true}'
```
`dry_run` governs **enrollment** side effects only (no agent_actions, no GHL). The score pass **always
upserts** the candidate table regardless of `dry_run` — it is internal analysis output, never an
external write — so `{"mode":"score","dry_run":true}` populates `agentic_reengagement_candidates`.

## Scoring (0–100 composite; each piece logged in `components`)
The classifier's `signal_snapshot` is a state fingerprint, not a feature vector, so the score is
re-based on columns that actually exist:

| Component | Source | Max pts |
|---|---|---|
| Source close-rate | `lp_leads.lead_source_detail` / `lead_source` (lookup, default 0.5) | 25 |
| Disposition value | `lp_leads.disposition_code` (OPPFDN>CXL>NIS>No Demo>CCC; cold `Set` own bucket) | 40 |
| Recency / dormancy | `daysDormant` (from `lp_notes` last note, fallback lp vintage) — mid-dormancy peak | 25 |
| Intent | strong-intent **states** (`S45_DORMANT_HIGH_INTENT`/`S45_REAWAKENED` …); `has_strong_intent` flag is absent | 10 |

`classification_confidence` is recorded in `components` for audit only — it is **not** a multiplier
(it is ~constant at 1.0 across the cohort, so multiplying adds nothing).

Source buckets (case-insensitive on the source string): **high (1.0)** Self-Generated / Previous
Customer / Customer Referral / Old Sub; **low (0.1)** Contractor Appointment Rev Share / Contractor
Appointment-West / Modernize / Porch101; **mid-low (0.35)** aggregators (Lead Gurus, MyHomePros, …);
**default (0.5)** everything else (Canvass, Internet, Website, …).

## Segments (state first, then disposition) — `target_offer_rung = 'Protection Profile Review'` always
| Segment | Temperature | Trigger |
|---|---|---|
| `WARM_OBJECTION` | warm | `SUPPRESSED_POST_DEMO_DECLINE` / `S45_DEMO_STALL` / objection present / OPPFDN / FDNS |
| `COOLED_NOSHOW` | cool | disposition `Set`, never demo'd |
| `COLD_RECOVERABLE` | cool | CXL / NIS / No Demo with engagement history |
| `COLD_RECOVERABLE` | cold | `SUPPRESSED_CONFIRMED_LOSS` (very stale, flag on) |
| `COLD_NO_SIGNAL` | cold | `COLD_NO_SIGNAL` / no engagement history (lowest priority) |

Offer is **LOCKED** to "Protection Profile Review" (deliverable "Protection Profile"). Never
"Documented Home Protection Review" (retired). No insurance-carrier / claim-outcome language anywhere.

## Exclusion gate (every exclusion is written, `enrollable=false` + `exclusion_reason`)
`no_ghl_match` (no lp row) · `hard_disposition` (DNC/NoHome/BD) · `stop_bot` (stop-bot/dnc/unsubscribed
tag) · `prospect_denylist` · `low_confidence` (<0.75) · `decline_recency_unknown` /
`decline_too_fresh` (<90d) · `confirmed_loss_v2_deferred` / `loss_too_fresh` (<365d) · `s1_1_active`
(S1.1 enrollment action or `re-engagement-eligible` tag).

The **decline recency gate is load-bearing**: most classified post-demo declines have rep activity
within 90 days (appointment confirmations, call summaries, rep SMS). Without it the engine would
enroll actively-worked leads into an S1.3 SMS sequence.

## Enrollment route
S1.3 is a published `inbound_webhook` workflow but has **no** row in `ghl_workflow_webhooks` (no stored
webhook URL). The action carries `workflow_id` + `canonical_code` and **no** `webhook_url`, so the
executor uses **Route A** (`POST /contacts/{id}/workflow/{id}` via GHL API), which works for any
trigger type. Idempotency: `rule_applied='S1_3_REENGAGEMENT_ENROLLMENT'` skip-if-action + a 90-day
`workflow_history['S1.3'].cooldown_until`.

> Route A firing an `inbound_webhook` workflow is **unproven** — the seed test (flag on, tiny limit)
> must confirm the contact visibly enters S1.3 and receives message #1. If not, switch to the
> workflow's real inbound webhook URL (Route B).

## Env flags
| Var | Default | Effect |
|---|---|---|
| `S1_REENGAGEMENT_ENABLED` | `false` (shadow) | `true` → enroll pass actually enqueues agent_actions |
| `S1_REENGAGEMENT_REQUIRE_APPROVAL` | `true` | enqueued actions require human approval before the executor fires |
| `S1_3_INCLUDE_CONFIRMED_LOSS` | `false` (v2) | include `SUPPRESSED_CONFIRMED_LOSS` (≥365d) as candidates |
| `S1_3_STALE_DECLINE_DAYS` | `90` | post-demo decline dormancy floor |
| `S1_3_STALE_LOSS_DAYS` | `365` | confirmed-loss dormancy floor |
| `S1_3_COOLDOWN_DAYS` | `90` | re-enrollment cooldown |
| `S1_REENGAGEMENT_ENROLL_LIMIT` | `25` | default top-N per enroll run |
| `LEAD_SELECTION_LIMIT` | `2000` | default score-pass scan limit |

## Shadow → live
1. `mode:'score'` and review `/report` (segment + exclusion + recency tallies).
2. `mode:'enroll', dry_run:true` → confirm correct top-N would enqueue, zero duplicates.
3. Set `S1_REENGAGEMENT_ENABLED=true`, tiny `limit`, `S1_REENGAGEMENT_REQUIRE_APPROVAL=true` → seed
   10–25 and confirm a contact **visibly enters S1.3 + receives message #1**.
4. Only then scale.

## Wave 2 (out of scope)
This v1 governs the ~2.6k already-classified leads with GHL contacts — proof-of-correctness + the
reusable scoring brain. The real S1.3 volume is the ~77k no-GHL stale leads, selected pre-import from
`lp_leads`; that path must mirror this one at the disposition level (include stale
OPPFDN/CXL/Set/NIS/No Demo/CCC; exclude DNC/NoHome/customer/deal-won; recency-gate declines).
