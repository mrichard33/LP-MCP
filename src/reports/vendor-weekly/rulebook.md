# Vendor Weekly Review — Rulebook v1

Read by `src/reports/vendor-weekly/compose.js` at run time and enforced by `validators.js`.
Change only by PR. The git blob sha of this file is written to `vendor_weekly_runs.rulebook_version`.

Two documents are produced per vendor per run. **The vendor sheet** is sent to the vendor. **The internal sheet** is for Mark only. Anything derived, inferred, speculative or about other vendors belongs on the internal sheet and never on the vendor sheet.

---

## 1. Numbers

1. **Claude never computes a number.** Every figure in either sheet comes from `fact_pack` verbatim (rounding permitted to the precision shown in the fact pack). The provenance validator fails the run if a numeric token in the output has no fact-pack origin.
2. **Same-age cohorts, always.** Current period = month-to-date through the Tuesday before the run (day *N*). Baseline = days 1–*N* of the prior month, counting leads created on or before day *N* in both. Never a partial month against a full one. State the rule in the footnote every week.
3. **Early-month rule.** If *N* < 5, the lede comparison is trailing 14 days vs the prior 14 (`comparison_rule = 'trailing_14'`); month-to-date is still shown but labelled thin.
4. **Post-change windows.** Any dated change from a vendor email or meeting (a pause, a price change, a score filter) gets its own before/after split at the stated date, by market, per day. Peaks and ceilings are reported ("hit 5 and 7 in a day before; has not exceeded 3 since"), not just averages.
5. **Immature cohorts.** Set rate, issued %, cost per set, tier mix, volume pacing and dials per lead are conclusive within days. Demos, sales, sit rate, ROAS and net cost of marketing for the current cohort are marked *still maturing* and never used to draw a conclusion.
6. **Two sources disagree → show both, make reconciliation an ask.** Known standing disagreements: `lp_leads` raw count vs `lp_source_cost_history.num_raw` (report 136); report 136 sold/demo (lead-created basis) vs report 137 close/demo (appointment-date basis); the vendor's own stated set rate vs LP's. Never pick one silently.
7. **The vendor's stated rate is a reconciliation target, not a fact.** If the vendor reports a set rate, compute the delivered count it implies against LP's set count and report the gap as *derived* — internal sheet only, vendor sheet asks for their count.

## 2. Cost

8. **Report 136 Mktg Sub-Source Cost Analysis 2 carries no Reece cost data** (`mcost_cents = 0` since 2026-08-10; see sql/109). Every cost figure is provisional until a `vendor_actuals` row exists for the period. Mark provisional figures with † and footnote the basis. "Actual spend + delivered count" is a standing due-today ask while no actuals row exists.
9. **Provisional basis** = most recent `vendor_actuals` row for the vendor (any period) → spend ÷ delivered leads → applied to the current LP lead count. If no actuals row has ever existed, use the last figure stated in a Notion transcript, cite the meeting date, and mark it "stated by vendor, unverified".
10. **Cost per issued lead** is the agreed leading indicator for MyHomePros (target ≤ $500, agreed Sep 2, 2026). It is the first cost figure on the sheet.

## 3. Effort and reachability

11. **`lp_leads.call_count` under-reports and is never cited.** Dial evidence comes from `lp_lead_disposition_history.num_dials` (report 135, the authoritative per-lead dial column) and from the dialer (Outbound IQ / Five9) when supplied in the fact pack.
12. **Never write "never called" from `call_count`.** "Never dialed" may be stated only from `num_dials = 0` in report 135, with the count and the share.
13. **The control group is mandatory.** Same-age set rate for every other active paid source plus in-house canvass, and the company dialer contact rate for the same windows. If the vendor moved with everyone else, say so plainly — do not manufacture a case. If the others held or rose while the vendor fell, that leads Section 2.
14. **One dialer spot-check** is cited on the vendor sheet, identified by **Prospect ID only** — never phone, never Lead ID (the LP front end looks up by Prospect ID). Choose the lead with the highest `num_dials` among those the vendor might assume were uncalled.

## 4. Commitments and statuses

15. **Sources of commitments**, in precedence: (a) `vendor_weekly_decisions` rows not closed; (b) Notion Meeting Action Items for the vendor; (c) action items in the most recent Notion meeting summary; (d) explicit commitments in vendor emails. Dedupe by `(vendor_id, item)` — same item, one row, status updated.
16. **Status vocabulary is fixed:** DONE · ACTIONED · OPEN · LATE (n days) · WORSENED · DISPUTED. Reece-owned items use OURS · DONE / OURS · OPEN.
17. **Reconcile against the vendor's own writing before assigning any status.** A commitment may not be marked OPEN, LATE or DISPUTED if its subject appears in a vendor email inside the window unless that email is cited in the status. The email-reconciliation validator fails the run otherwise. A vendor who documents an action gets ACTIONED even when the action was wrong; the disagreement is stated as direction, not as a miss.
18. **Do not demand an explanation the vendor has already given in writing.** Quote the action they described; argue whether it was the right action.
19. **Rule-verifiable statuses** (`status_basis = 'rule'`): market pause → zero leads in the market since the stated date; volume restore → per-day count ≥ target; a report or file delivered → matching attachment in the Gmail pull. Everything else is `status_basis = 'llm'` and the internal sheet lists it under "statuses assigned by inference — verify".
20. **Reece's own open items are always listed**, on both sheets. A scorecard that only lists the vendor's misses reads as a weapon and stops being usable.
21. **Concede first.** If Reece changed anything that moves a metric (confirmation standard, phone-room move, staffing), it goes in the lede before the control group, and the affected metric carries ‡ (changed-definition).
22. **Credit what was executed**, by name and date, before any push. Verified pauses and same-day recap emails are credited explicitly.

## 5. What goes where

23. **Other vendors are anonymized on the vendor sheet** — "Paid internet vendor A/B/C", with in-house canvass named. They are named on the internal sheet. The vendor sheet carries the footnote: "Comparison sources are anonymized by design. Reece does not share one vendor's performance figures with another, in either direction."
24. **Report names travel with report numbers, every time:** 133 Jobs By Status · 134 Jobs by Milestone Date · 135 Lead Disposition Detail 2 · 136 Mktg Sub-Source Cost Analysis 2 · 137 Sales Efficiency By Mode. A bare number is a canon-validator failure.
25. **137 Sales Efficiency By Mode is never sent to any vendor** and never appears in `reports_safe_to_send`. Its sub-source run prints every source Reece runs.
26. **Vendor canon** comes from `vendor_config`: `display_name` is the only name used for the vendor; `canon.forbid` strings are validator failures on the vendor sheet (MyHomePros: `Tony`, `Suited Connector`, `Sweeted Connector`). The contact's real email address is permitted because it is the delivery address.
27. **No lead PII on the vendor sheet**: no phone numbers, no email addresses other than the vendor contact's, no Lead IDs, no homeowner names.
28. **Derived, inferred and hypothesised material** — implied delivered counts, area-code observations, anything with "likely" or "suggests" — lives on the internal sheet under "What you may not claim out loud".

## 6. Structure and voice

29. **Verdict vocabulary is fixed:** *good / acceptable / unacceptable* on two axes, execution and reporting, in one sentence, bold, first.
30. **Lede order:** verdict → the single strongest finding → the concession → the control-group result → credit given. Three to five sentences.
31. **Four tiles**, chosen from the fixed candidate list in the fact pack. Never a free-text tile. Bad numbers red, good numbers navy-bold.
32. **Section order is locked** (see template). Sections that the data does not support are omitted whole, never padded.
33. **Every decisions row has a deliverable, a named person for Decision and for Execution, and a date.** Carried-forward rows show the original due date. Vendor-facing dates carry a time in ET when they are same-week.
34. **Consequence paragraph** names a date, states what Reece does if the deliverables don't arrive, names the next review date, and ends with the two scorecard metrics from `vendor_config.targets`.
35. **One page for the vendor sheet.** The renderer shrinks type in 0.2pt steps from 8.0pt to a floor of 7.2pt; below the floor the run fails rather than ships two pages.
36. **Voice:** direct, specific, no hedging words on measured facts, no accusation on derived ones. Em dashes spaced and sparing. Never "genuinely", "honestly", "straightforward".
37. **Brand colours:** navy `#1F3A5F`, red `#B3261E`, tile fill `#F5F7FA`, borders `#C8C8C8`, red callout `#FBEDEC`, navy callout `#F5F7FA`. Helvetica/Arial.

## 7. Speaking points (internal sheet only)

38. Fixed order: open with the number → reconciliation → credit → concession → control group → the real problem → the hard push → on the record → consequence.
39. The opener is one measured number, stated before any framing, followed by the instruction *stop talking*.
40. Every line the vendor has actually said (transcript or email) that will be used as pushback gets a scripted reply in the "Holding the line" table.
41. The spoken script never names other vendors if the vendor sheet anonymizes them.

## 8. Run health (internal sheet, last section)

42. List every source with its `fetched_at`, which were missing, every validator result, the rulebook sha, the model string, and the question: "Which of this week's manual edits should become a rule?"
