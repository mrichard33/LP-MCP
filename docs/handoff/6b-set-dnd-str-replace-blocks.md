# `set_dnd` dispatcher wiring — exact `str_replace` blocks

**Target:** `src/actions/index.js`
**Verified against:** sha `d24f9ffc2bf0f65564544153e79be7c835101677` — 1014 lines, 52,141 bytes
**Anchors confirmed:** import line 150 · `ACTION_HANDLERS` opens line 337 · `update_lp_dnc_status` entry line 356

Each `old_string` was checked for uniqueness in the file. Apply in order.

The handler itself (`src/actions/handlers/dnd.js`) is already on `main` via PR #542. These blocks are the only thing standing between it and being live.

---

## Block 1 — import

Placed directly under the `lp-dnc.js` import so the LP-side and GHL-side DNC handlers stay adjacent. That adjacency is the point: the entire bug was that one existed without the other.

**old_string**
```
import { executeUpdateLPDNCStatus } from './handlers/lp-dnc.js';
```

**new_string**
```
import { executeUpdateLPDNCStatus } from './handlers/lp-dnc.js';
import { executeSetDND } from './handlers/dnd.js';
```

---

## Block 2 — `ACTION_HANDLERS` registration

**old_string**
```
  update_lp_dnc_status: executeUpdateLPDNCStatus, // 2026-05-01 — agentic DNC push (Charles Poulos recovery)
```

**new_string**
```
  update_lp_dnc_status: executeUpdateLPDNCStatus, // 2026-05-01 — agentic DNC push (Charles Poulos recovery)
  set_dnd: executeSetDND,                        // 2026-07-20 — GHL-side channel suppression (Fix 6b). Twin of update_lp_dnc_status: that one tells LP to stop, this one tells GHL. Only the second actually closes the sending channel.
```

> Do **not** add `set_dnd` to `CONTEXT_AWARE_HANDLERS` (line 375). It operates purely on `action.target_id` and `action_payload` and needs no event context.

---

## Block 3 — header action-type count

The file header enumerates supported action types and states a count. Leaving it stale is how the next reader gets misled.

**old_string**
```
 * Supported action types (27):
```

**new_string**
```
 * Supported action types (28):
```

> Also append `set_dnd` to the enumerated list that follows in that header comment, after `update_lp_dnc_status`. The list wraps across several lines — preserve its existing wrapping.

---

## Correction to the earlier handoff note

That note speculated a lane map might live in `src/actions/constants.js`. **It does not.** `constants.js` is pure data — location ID, pipeline IDs, `STAGE_MAP`, `CALENDAR_MAP`, `REMOVE_ALL_MARKETING_WF`, `MONTH_MAP` — with no action-type registry. Lanes are set per `agent_actions` row via `priority`. **No constants change is needed.**

**Recommendation: set the `set_dnd` action's priority to 20, not 50.** Lane 50 is the lane with the known stall (issue #74 — state updates backing up 10+ min while lanes 10 and 20 drain fine). A DND write sitting in a stalled queue means the email channel stays open for the duration, which is precisely the failure being fixed. `set_dnd` is a suppression write; its urgency is closer to a send than to a tag.

---

## Post-wiring: the `LP_DISP_DNC` change

```sql
UPDATE agent_rules
SET action_template = action_template || '[{
      "params": {"channels": ["Email","SMS","Call","WhatsApp","GMB","FB"],
                 "status": "active",
                 "reason": "LP disposition DNC"},
      "action_type": "set_dnd",
      "target_entity": "contact",
      "target_system": "ghl",
      "priority": 20
    }]'::jsonb
WHERE id = 14;
```

Then strip *"DND not settable via action executor — flagged in GroupMe notification for manual action."* from the notes and point at `src/actions/handlers/dnd.js` instead. **Do not leave the old sentence in place** — a stale "handled manually" note is exactly what let this survive nine months.

Reload: `POST https://lp-mcp-production.up.railway.app/n8n/decision-engine/reload-rules`

---

## Canary — and a timing trap

Canary contact `0kk3xz6XatILy8jajymX`.

1. Emit `lp.disposition_changed` with `disposition_code: DNC`.
2. Wait for the sweep, then assert an `agent_actions` row `action_type='set_dnd'` reached `completed`.
3. `get_contact` `forceLive=true` → assert **`dndSettings.Email.status === 'active'`**. That is the exact assertion failing in production today.
4. Clean up: set the channels back to `inactive`, remove `lp-dnd:set`.

> ⚠️ **Sweep-timing trap — hit during the Fix 0a canary.** Rules evaluate contact tag state at *processing* time, not emit time, and the sweep runs roughly every 60s. A tag added ~20s after emitting caused an earlier event to be evaluated against the *later* state, so both canary legs returned identical results and the clean leg looked like a failure. It was not; it was contaminated by its own setup.
>
> **Let each leg fully process before touching any tag.** Confirm `system_events.processed = true` for the current leg before setting up the next one. On the retry with proper separation, the guard behaved correctly in both directions.
