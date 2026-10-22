# One-Leg → RFED (Ross Erstling): rulings and what is built

Mark, 2026-10-22. This replaces the earlier plan for an automatic "day 3" hand-off of 1-Leg leads to Ross.

## Rulings

1. **No automatic hand-off to Ross.** We are not automating leads going to Ross right now.
2. **GHL S5.2 "I. 1 Leg" no longer hands leads to Ross.** Mark turned off the step that added `phone-team`.
3. **The only trigger for Ross:** a NEW LP lead on the RFED market. The partner owner sync then makes Ross the GHL
   owner and adds `phone-team`, which fires U.RFED's messages and the Five9 removal.
4. **Bot:** the phone presentation runs only for contacts tagged `phone-team`. A 1-Leg state alone gets the normal offer.
5. **Promoter rule (replaces the 2026-10-21 "Promoter blank for canvass"):** an RFED lead copies Source, Sub-Source
   AND Promoter from the original lead, canvass included. Promoter is blank only when the original had none.

## Not approved (parked)

These were in the earlier plan. Do not build them without a new ruling from Mark:

- `src/one-leg/day3.js` (the day-3 decision)
- job `one-leg-day3`
- table `one_leg_handoffs`
- switch `ONE_LEG_RFED_MODE`

## What is built

| Piece | Where | What it does |
|---|---|---|
| Five9 removal | `src/partners/five9-removal.js`, job `partner-five9-sweep` | A partner-owned contact comes off every Reece outbound list, again after each 6 AM LP load. `PARTNER_FIVE9_REMOVAL_MODE` off / log / enforce. |
| Phone presentation | `src/agentic/one-leg-presentation.js`, `executeBookAppointment` | `phone-team` contacts only. |
| RFED batch (Mark's 50) | `src/partners/rfed-batch.js`, `src/partners/rfed-batch-run.js`, `scripts/rfed-1leg-batch.js`, `POST /n8n/admin/partner-owner/rfed-batch` | plan (dry-run table), record (approved rows → `partner_rfed_batch`), verify. Never writes LP, GHL or Five9. |
| Integrity guard | `src/partners/rfed-integrity.js`, inside `partner-five9-sweep` | Ross owns it in GHL ⇒ newest LP lead is RFED with the original's Source / Sub-Source / Promoter. A card, never a fix. `PARTNER_RFED_INTEGRITY_MODE` off / log / alert. |

## Why the 50 RFED leads are created in LP, not by our code

- Every LP create path we have (`addLead`, `/api/Leads/LeadAdd`, `/api/Leads/AddLead`) puts an inquiry in LP's
  inbound queue. A person has to import it.
- In the 21 days to 2026-10-22, LP's auto-import took **0 of 974** inquiries whose phone was already in LP. All 50 of
  these customers are already in LP, so all 50 would wait for a person.
- LP picks the branch from the zip. No inquiry landed on RFED in those 21 days. The RFED leads created since 10/01 came
  in on ORL or BOCA and a person moved them to RFED in LP.

So the leads are created directly on each prospect in LP: LP support (from the sheet the `plan` step returns), or one
person from the same sheet. We also asked LP whether an API exists that creates a lead on an existing prospect with a
branch; if it does, the batch can run through it with the same rules.

## The batch, step by step

1. `plan` → the dry-run table: original lead, prospect, market, Source, Sub-Source (srs_id), Promoter (pro_id), and
   ready / skip / blocked. A lead that changed since 2026-10-22 is skipped: a sale, any DNC, a new live appointment,
   a newer lead, a waiting inquiry, or no longer 1Leg. A read that fails blocks. A promoter the original had but that
   does not match exactly one LP promoter id blocks the row; it is never sent blank.
2. Mark approves the table.
3. `record` the approved ids, 10 at a time (`batch_no`).
4. LP support (or a person) creates the 10 RFED leads: same prospect, product Roof, the copied fields. The original
   1-Leg lead stays untouched.
5. `verify` the batch: the RFED lead in LP with the same fields → Ross the owner → `phone-team` → a Five9 removal row.
   Stop on the first batch with a failure.

## GHL S5.2 v2 "I. 1 Leg": what to check

The June 2026 export of S5.2 v2 (`GHL-Workflows/S5.2-appointment-rescue-policy-executor-v2.json`) shows, in the
1 Leg branch, an **assign-user step "Assign to Mark from Reece"** (user `gPyvoLiFTEPRN6pkz8kC`,
`only_unassigned_contact = false`) on day 4. It changes the contact owner. Confirm in GHL whether it is still live.
If an owner is ever set to a partner without an RFED lead, the integrity guard reports it.
