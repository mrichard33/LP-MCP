# Claude Code Handoff — LP appointment pre-flight & intake address gate

**Date:** 2026-08-27
**Branch:** `fix/lp-address-blankish-and-appt-preflight`
**Incident:** contact `q5GehRye7DNkN6jlmjl3` (Myron Thorner), LP lead `570351`, prospect `454810`

---

## Background — what actually happened

A chatbot lead reached LP's inbound queue with `address1` = the literal string `"undefined"`. Not missing. Present, and garbage.

Because LP resolves a lead's market (`brn_id`) from the address **at lead-creation time**, LP could not place the lead in a market. It stamped `brn_id = ""`. Nine hours later the agentic layer booked a Friday 6:00 PM estimate and called `SetAppointment`. LP answered:

```json
{ "Result": 1, "Message": "market is OOA.  " }
```

`setAppointment()` in `lp-client.js` only inspects `result.error`, which LP does not populate on this endpoint. `Result: 1` was read as success. The message was discarded. The contact was tagged `lp-appt-synced`. The appointment never reached any rep's schedule — confirmed via `GetSalesSchedule`: zero St. Pete appointments that day.

Three things then prevented recovery:

1. The dedup marker in `lp_appointment_sync_marks` is written **on dispatch**, 26 seconds after the webhook — not after a confirmed LP write. Every retry returned `duplicate_sync_suppressed`. The failure was self-locking.
2. The address-backfill job's blankness guard read `"undefined"` as a populated address and skipped the repair. Its sweep query used `.is('address', null)`, so poisoned rows were never even candidates. **Fixed on this branch.**
3. `UpdateProspectInfo` repairs the **prospect** record but cannot backfill a **lead's** market. Verified live: after a successful, read-back-confirmed prospect repair, `SetAppointment` *still* returned `market is OOA`. Lead 570351 is permanently unbookable.

**The load-bearing lesson:** repairing the address afterwards is damage control. A lead born without a resolvable address can never be rescued. The only real cure is refusing to create it.

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

### 1a. Gate `addLead()` on a resolvable address

Add the import at the top:

```js
import { assertAddressableForLp } from './lp-address-validity.js';
```

In `addLead()`, immediately **after** the existing `missing.length` required-field check and **before** the `apptdate`/`appttime` pairing check:

```js
  // 2026-08-27 — a lead created without a resolvable address gets a blank
  // brn_id and can NEVER accept an appointment. Nothing downstream can repair
  // that. Refuse at the door.
  assertAddressableForLp(fields, 'addLead');
```

The existing `required` check already covers *missing* fields. This one covers *present but poisoned* — the actual failure mode.

Also harden the blank-stripping loop just below it, which currently drops `''` but happily forwards `"undefined"`:

```js
  const cleanFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s === '') continue;
    // Never let a placeholder token reach LP in an address field.
    if (ADDRESS_KEYS.has(k) && isBlankAddress(s)) continue;
    cleanFields[k] = String(v);
  }
```

with, near the top of the file:

```js
const ADDRESS_KEYS = new Set(['address1', 'address2', 'city', 'state', 'zip']);
```

and adding `isBlankAddress` to the import.

### 1b. Read the `SetAppointment` response body

Add:

```js
import { assertAppointmentAccepted } from './lp-appointment-guards.js';
```

In `setAppointment()`, **replace** this block:

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

### 2a. Address pre-flight before `SetAppointment`

This is the change Mark asked for directly: **repair the address first, then set the appointment.**

Before the `lpSetAppointment` call, once `ldsId` and `prospectId` are resolved:

1. Read the lead live (`getLeadByLdsId`).
2. Call `assertLeadCanTakeAppointment(lead)` from `src/lp-appointment-guards.js`.
   - On `LP_LEAD_NO_MARKET`, do **not** attempt `SetAppointment`. It cannot succeed.
3. If the prospect address is blank-ish (`isBlankAddress`), call `backfillProspectAddressForContact(contactId)` from `src/jobs/lp-address-backfill.js` **first**, and only proceed once it read back clean.
4. Then call `lpSetAppointment`.

Ordering matters: repair, verify, then set. Never set-then-hope.

### 2b. Write the marker only after LP confirms

Around lines ~1219–1250, the marker upsert into `lp_appointment_sync_marks` happens synchronously on dispatch. Move it so it runs **only after** `assertAppointmentAccepted` has passed.

Same for the `lp-appt-synced` tag — it must not be applied on a refusal.

This is what made the incident unrecoverable without manually deleting marker rows from Supabase.

### 2c. Notify on `LP_LEAD_NO_MARKET`

A lead in this state needs a human. Route it through the existing notification classifier as **priority** — the customer has a confirmed appointment in GHL and no rep is coming.

---

## Task 3 — verification

```bash
node scripts/test-lp-address-validity.js     # must be all green
```

Post-deploy, against production:

```
GET /n8n/lp-address-backfill/dry-run-count
```

**The candidate count is expected to RISE.** Those are the previously-invisible `"undefined"` prospects. That is the fix working, not new breakage. Then run the sweep and watch for `was undefined` in the repair logs.

---

## Out of scope — but please open an issue

**Where does `"undefined"` come from?** Inbound row `418375` carried `sender: "GHL-Chatbot"` and `address1: "undefined"` — a `String(undefined)` interpolation in the chatbot intake body, upstream of everything here. The gate in Task 1a stops it reaching LP, but the leak itself still needs finding, most likely in the chatbot → GHL → addlead path (n8n or the Revin integration).

Fixing the gate without fixing the leak means we start *rejecting* these leads instead of *corrupting* them. Better, but still a lost lead.
