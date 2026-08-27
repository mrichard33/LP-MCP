# Claude Code Handoff — LP appointment pre-flight & intake address gate

**Date:** 2026-08-27
**Branch:** `fix/lp-address-blankish-and-appt-preflight`
**Incident:** contact `q5GehRye7DNkN6jlmjl3` (Myron Thorner), LP lead `570351`, prospect `454810`

> **REVISED 2026-08-27 after review.** An earlier draft of this handoff said to
> refuse `addLead` outright when no address is present. **That is wrong and must
> not be implemented.** Reece needs the lead in LP immediately on name + phone so
> the call floor can dial it. The gate belongs on the **appointment**, not on lead
> creation. Task 1a below reflects the corrected design.

---

## Background — what actually happened

A chatbot lead reached LP's inbound queue with `address1` = the literal string `"undefined"`. Not missing. Present, and garbage.

LP resolves a lead's market (`brn_id`) from the address — specifically the **zip** — **at lead-creation time**. With no usable zip, LP stamped `brn_id = ""`. Nine hours later the agentic layer booked a Friday 6:00 PM estimate and called `SetAppointment`. LP answered:

```json
{ "Result": 1, "Message": "market is OOA.  " }
```

`setAppointment()` in `lp-client.js` only inspects `result.error`, which LP does not populate on this endpoint. `Result: 1` was read as success. The message was discarded. The contact was tagged `lp-appt-synced`. The appointment never reached any rep's schedule — confirmed via `GetSalesSchedule`: zero St. Pete appointments that day.

Three things then prevented recovery:

1. The dedup marker in `lp_appointment_sync_marks` is written **on dispatch**, 26 seconds after the webhook — not after a confirmed LP write. Every retry returned `duplicate_sync_suppressed`. The failure was self-locking.
2. The address-backfill job's blankness guard read `"undefined"` as a populated address and skipped the repair. Its sweep query used `.is('address', null)`, so poisoned rows were never even candidates. **Fixed on this branch.**
3. `UpdateProspectInfo` repairs the **prospect** record but cannot backfill a **lead's** market. Verified live: after a successful, read-back-confirmed prospect repair, `SetAppointment` *still* returned `market is OOA`. Lead 570351 is permanently unbookable.

Both LP appointment endpoints carry the same restriction, per LP's own docs:

> "The lead can not be Out Of Area and must be dispo'd as Data."

That applies to `SetAppointment` **and** `SetAppointmentSalesRep`. Naming a rep explicitly does not bypass it. There is no LP endpoint that sets a lead's market after creation.

**The load-bearing lesson:** a lead's market is decided at birth, from the zip, and can never be changed. Everything after that is damage control.

---

## The corrected model

Two separate concerns that were previously conflated:

| Concern | Needs | Rule |
|---|---|---|
| **Dialing** the lead | name + phone | Send to LP immediately. Never block this. |
| **Booking** an appointment | a lead with a real `brn_id` | Requires a usable **zip** at lead-creation time. |

A call-only lead with no zip is a legitimate, useful record — the floor works it. It is simply not bookable, and the system must know that rather than discovering it at `SetAppointment` time.

---

## Already done on this branch (no action needed)

| File | Change |
|---|---|
| `src/lp-address-validity.js` | **NEW.** `isBlankAddress`, `hasRealValue`, `normalizeAddressField`, `hasUsableLpAddress`, `missingAddressFields`, `assertAddressableForLp`, `BLANKISH_SQL_OR` |
| `src/lp-appointment-guards.js` | **NEW.** `inspectAppointmentResponse`, `assertAppointmentAccepted`, `assertLeadCanTakeAppointment` |
| `src/jobs/lp-address-backfill.js` | Uses the normaliser; sweep now sees poisoned rows |
| `scripts/test-lp-address-validity.js` | **NEW.** Regression tests |

Both new modules are **pure and fully unwired**. Your job is the wiring.

---

## Task 1 — `src/lp-client.js` (51 KB)

### 1a. Scrub placeholder tokens — do NOT refuse the lead

The lead must still reach LP on name + phone. What must never reach LP is the
literal string `"undefined"` in an address field. Strip it; send the lead anyway.

Near the top of the file:

```js
import { isBlankAddress, hasUsableLpAddress } from './lp-address-validity.js';

const ADDRESS_KEYS = new Set(['address1', 'address2', 'city', 'state', 'zip']);
```

In `addLead()`, harden the existing blank-stripping loop — it currently drops `''`
but happily forwards `"undefined"`:

```js
  const cleanFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s === '') continue;
    // 2026-08-27 — never let a placeholder token reach LP in an address field.
    // Blank is honest; "undefined" is corruption that LP stores verbatim.
    if (ADDRESS_KEYS.has(k) && isBlankAddress(s)) continue;
    cleanFields[k] = String(v);
  }
```

Then annotate the outcome so callers know what they created, WITHOUT blocking it:

```js
  // Not an error — a call-only lead is a valid product. But the caller needs to
  // know it can never accept an appointment, so nothing downstream tries.
  const bookable = hasUsableLpAddress(cleanFields);
  if (!bookable) {
    console.warn(`[LP] addLead: no usable zip for ${cleanFields.firstname || '?'} ` +
      `${cleanFields.phone || cleanFields.phone1 || ''} — LP will create this lead ` +
      `with a blank brn_id. It is DIALABLE but NOT BOOKABLE.`);
  }
```

and include `_bookable: bookable` on the returned object from both
`_addLeadLegacyFirst` and `_addLeadRestFirst`.

**Note:** the existing `required` array already lists `address1`, `city`, `state`,
`zip`. That is now too strict for the call-only path — reduce the hard requirement
to `['firstname', 'phone', 'srs_id']` and let the `_bookable` flag carry the rest.
Verify no existing caller depends on the throw before changing this.

### 1b. Read the `SetAppointment` response body

```js
import { assertAppointmentAccepted } from './lp-appointment-guards.js';
```

In `setAppointment()`, **replace**:

```js
  // Check for LP error response
  if (result?.error) {
    throw new Error(`LP SetAppointment error: ${result.error} (message: ${result.message || 'none'})`);
  }
```

with:

```js
  // Keep the legacy check — LP is inconsistent across endpoints.
  if (result?.error) {
    throw new Error(`LP SetAppointment error: ${result.error} (message: ${result.message || 'none'})`);
  }

  // 2026-08-27 — LP signals refusal in the BODY, not in `error`. The live
  // failure was {Result: 1, Message: "market is OOA."} being read as success.
  // Throws with .code = 'LP_APPT_REFUSED'.
  assertAppointmentAccepted(result, { ldsId, apptDate, apptTime });
```

**Do not** weaken this to a warning. A refused appointment that returns normally is exactly the bug.

---

## Task 2 — `src/lp-appointment-sync.js` (large)

### 2a. Pre-flight before `SetAppointment`

Before the `lpSetAppointment` call, once `ldsId` and `prospectId` are resolved:

1. Read the lead live (`getLeadByLdsId`).
2. If the prospect address is blank-ish (`isBlankAddress`), call
   `backfillProspectAddressForContact(contactId)` **first** and only continue once
   it reads back clean. This is the repair-then-book ordering Mark asked for.
3. Call `assertLeadCanTakeAppointment(lead)`.
   - On `LP_LEAD_NO_MARKET`: do **not** call `SetAppointment` — it cannot succeed.
     Go to 2c.
4. Then call `lpSetAppointment`.

### 2b. Write the marker only after LP confirms

Around lines ~1219–1250 the marker upsert into `lp_appointment_sync_marks` happens
synchronously on dispatch. Move it so it runs **only after**
`assertAppointmentAccepted` has passed. Same for the `lp-appt-synced` tag — it must
never be applied on a refusal.

This is what made the incident unrecoverable without hand-deleting Supabase rows.

### 2c. Re-add path for unbookable leads (the real fix)

When the lead has no market but the contact NOW has a usable address, the appointment
cannot be rescued on that lead — but it can be honoured on a new one. LP dedupes the
new lead onto the same prospect, so no duplicate customer is created.

1. Repair the prospect address first (2a step 2), so the new lead attaches to a clean record.
2. Enroll the contact in GHL workflow `8e30ff37` (`I.LP-OUT LP Send Lead`) with the
   appointment attached — the same path that produced inbound row `418589` for Myron,
   which correctly carried `brn_id: "STPET"`.
3. Emit a **priority** notification either way: a human must kill the old call-only
   lead so the floor is not working a dead record.

Guard this with its own dedup marker — it creates an LP lead, and must not fire twice.

### 2d. Notify on `LP_LEAD_NO_MARKET`

Route through the existing notification classifier as **priority**. The customer has a
confirmed appointment in GHL and, until 2c completes, no rep is coming.

---

## Task 3 — verification

```bash
node scripts/test-lp-address-validity.js     # must be all green
```

Post-deploy, against production:

```
GET /n8n/lp-address-backfill/dry-run-count
```

**The candidate count is expected to RISE.** Those are the previously-invisible
`"undefined"` prospects. That is the fix working, not new breakage. Then run the sweep
and watch for `was undefined` in the repair logs.

---

## Out of scope — but please open issues

**1. Where does `"undefined"` come from?** Inbound row `418375` carried
`sender: "GHL-Chatbot"`, which matches the payload template in GHL workflow
`8e30ff37` (`"sender": "GHL-{{contact.source}}"`, contact source `Chatbot`). So
`{{contact.address1}}` rendered as the literal `undefined` inside that workflow's
JSON `rawData` body when the field was empty. Task 1a stops it reaching LP, but the
rendering bug is upstream and still needs fixing in the GHL workflow itself.

**2. The addlead `notes` blob is too long.** Myron's carried the full chat transcript
plus his gate-access directions in one ~2,000-character string. Notes sent via
`addlead` land on the **lead**; notes sent later via `AddNotes` with `rectype: 'cst'`
land on the **prospect** — two different places in the LP UI, which is why the rep-
critical detail (guard gate, GPS instructions) ends up buried where nobody looks.
Split these: short actionable note on the lead, access directions in their own short
prospect note.
