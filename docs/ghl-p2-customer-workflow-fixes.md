# P2 customer workflows: fixes before they reach customers (2026-10-20)

LP-MCP now keeps every P2 (Client Lifecycle) card where LP says the customer is:
- the milestone rules move cards
- `src/p2-won-guard.js` makes Won mean installed AND paid
- the parity sweep (`src/p2-parity/`, `P2_PARITY_MODE`) heals any card that drifts, backward too

The GHL workflows below must agree with that. These are GHL edits; HL-MCP has no workflow write tool.

**Today:**
- C.0, C.1, C.2, C.3, C.4 and C.5 are published, but their first step sends every contact without the `test-contact` tag to "Real Contact (Exit)". No customer has received a C-series message.
- C.0-IN and L.6 are live, with no test gate.

Make the edits in this order. Remove the test-contact gates only after steps 1–7.

## 1. C.0-IN Sale Made Entry — do this first (it fights LP today)

- **What is wrong:** "Opportunity Found → Update opportunity" sets P2 stage `fec39f2e` (Contract Signed), status `open` and `allowBackward: true`, verified in the HL mirror. Any `deal-won` re-add, or any change to "LP Gross Sale Amount" on a customer, drags their newest P2 card back to stage 1: mid-install, Won or Lost.
- **Fix:**
  - In that step, keep only **Monetary value** (`{{contact.lp_gross_sale_amount}}`), plus name and source if wanted. Remove Pipeline stage, Status and "Allow backward".
  - The "LP Gross Sale Amount Updated" trigger may stay, because the step now only updates the value.
  - The "Opportunity Not Found → Create" branch can stay: it creates at Contract Signed, open, which is right for a new sale.

## 2. L.6 P2 Loss Classification

- **What is wrong:** "Remove from Marketing Workflows" does not list C.0–C.5. A cancelled job would keep getting install, check-in and review messages.
- **Fix:** add C.0, C.1, C.2, C.3, C.4 and C.5 to that step.

## 3. C.1 Install Progress Updates

**What is wrong:**
- Stage 6 "Install Scheduled" is entered on LP's actual Install START date: the install day, not the day it was booked.
- The stage 6 branch says "Your install date is getting close" by email, then the next day by SMS "installation is being scheduled… We'll confirm the date soon".
- About 37% of cards go from stage 6 to stage 7 in the same pass.

**Fix:**
- **First step of the workflow, before the test-contact check:** if the contact has tag `p2-stage-heal` → remove that tag → End. The parity sweep adds this tag right before it repairs a card's stage, so a repair never texts a customer. The tag is only added for a move into stages 4–8, the stages a customer workflow starts on, so the workflow that starts consumes it.
- **Rewrite the stage 6 copy for install day** (for example "Your install crew is with you today…"). Or have a person tell us to move stage 6 to the booked date instead; that is an LP-MCP change.
- **Before sending the stage 6 messages,** check that the opportunity is still in stage 6. Skip if it is already at Install Completed.

## 4. C.2 Post-Install Check-In

**What is wrong:**
- The 1-day SMS says "after yesterday". Install End and Completion are entered up to several days late, and a repair can move a card weeks later.
- Re-entry is ON, so a card that re-enters stage 7 restarts the whole sequence.

**Fix:**
- The same first step as C.1: `p2-stage-heal` → remove → End.
- Change "after yesterday" to "after your install".
- Turn re-entry **off**.
- No other change is needed. The trigger requires status open, and LP-MCP's install milestone rules move the card to stage 7 while it is still open and only then close it Won (`sql/seeds/2026-10-20_p2_won_requires_install.sql`), so C.2 still starts.

## 5. C.4 Review Solicitation

**What is wrong:**
- **The trigger:** opportunity decay — 14 days in stage 7, with no status condition.
  - About 65% of cards move on to stage 8 (Inspection Passed) inside 14 days and never fire it.
  - Any opportunity edit (LP Job ID stamp, name or value update) resets the clock.
  - A repair that moves a long-installed customer into stage 7 would ask for a review months late.
- **ORL:** there is no Orlando branch (4,638 contacts), so Orlando customers get the St. Pete link.
- **No rating path:** a contact with no Review Link skips the 1–5 rating and goes straight to the review ask, and nothing handles the 1–5 reply.

**Fix:**
- Trigger on P2 stage changed to **8. Referral & Expansion**, with status open or won and no `p2-stage-heal` tag. Add the same first step as C.1.
- Add an ORL branch.
- Set the Review Link before the rating step.
- Build the reply path: a low rating adds `service-recovery`.

## 6. C.0 Customer Onboarding

**What is wrong:**
- The trigger (opportunity created at Contract Signed) has no status condition. The sale backstop creates Lost cards for cancelled sales, and those would get "you made the decision" onboarding.
- The stale check uses "== 90 days before", which may match only that exact day.
- `referral-trigger` (C.5) is added about 6 days after signing, before the install.

**Fix:**
- Add **status is open** to the trigger.
- Use a "more than 90 days ago" operator and test it on one old contact.
- Move `referral-trigger` out of C.0. C.2 already adds it after the install.

## 7. C.5 Referral Overlay

- **What is wrong:** it is started by C.0's `referral-trigger`, so the customer is asked before the install. Path B is labelled "(30+ days)" but is chosen at random.
- **Fix:** start it only from C.2 (after the install), and make Path B's condition real or rename it.

## 8. Then remove the test-contact gates

Do it one workflow at a time, in this order: C.0 → C.1 → C.2 → C.3 → C.4 → C.5. Watch the first real sends in GHL's execution log for each.

C.3 Expansion needs no change: it starts on `c.2-complete` and writes nothing to P2.
