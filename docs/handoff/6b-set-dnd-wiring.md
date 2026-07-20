# Handoff — wire `set_dnd` into the action dispatcher (Fix 6b)

**Why this is a handoff and not a commit:** `src/actions/index.js` is **52 KB**, over the direct-edit threshold. The change itself is two lines; blind-rewriting a 52 KB file to add them is the risk, not the edit.

## What already landed on this branch

- `src/actions/handlers/dnd.js` — `executeSetDND`, complete and tested-by-inspection. Inert until wired.

## The wiring

`src/actions/index.js` — the import block sits around **line 150** (confirmed: `executeUpdateLPDNCStatus` is imported there).

**1. Add the import**, next to the existing `lp-dnc.js` import so the GHL-side and LP-side DNC handlers stay visually adjacent:

```js
import { executeSetDND } from './handlers/dnd.js';
```

**2. Add the dispatch case**, matching the surrounding style (switch case or handler-map entry — follow whichever the file already uses; do not introduce a second pattern):

```js
case 'set_dnd':
  return await executeSetDND(action);
```

**3. If `src/actions/constants.js` carries an action-type allowlist or priority-lane map, add `set_dnd` there too.** It is a state-update action, so it belongs in the same lane as `add_tag` / `move_opportunity` (**priority 50**), not the send lane.

> ⚠️ Lane 50 is the lane with the known backlog (open issue #74 — state updates stalling 10+ min while lanes 10 and 20 drain fine). That is acceptable for DND: it is a suppression write, not a send, and it is idempotent. But if #74 recurs, a DND write sitting in a stalled queue means the channel stays open in the interim. Worth a follow-up: consider promoting `set_dnd` to lane 20, since a suppression write is closer in urgency to a send than to a tag.

## After wiring — the agent_rules change

Add a `set_dnd` action to `LP_DISP_DNC` (rule **#14**) and strip the stale manual dependency from its notes.

```sql
-- Append the set_dnd action to LP_DISP_DNC's action_template.
UPDATE agent_rules
SET action_template = action_template || '[{
      "params": {"channels": ["Email","SMS","Call","WhatsApp","GMB","FB"],
                 "status": "active",
                 "reason": "LP disposition DNC"},
      "action_type": "set_dnd",
      "target_entity": "contact",
      "target_system": "ghl"
    }]'::jsonb
WHERE id = 14;
```

Then remove the sentence *"DND not settable via action executor — flagged in GroupMe notification for manual action."* from the notes and replace it with a pointer to this handler. **Do not leave the old sentence in place** — a stale "this is handled manually" note is precisely what let the gap survive nine months.

Reload afterwards: `POST https://lp-mcp-production.up.railway.app/n8n/decision-engine/reload-rules`, then canary on `0kk3xz6XatILy8jajymX`.

## Verification

1. Canary `0kk3xz6XatILy8jajymX` → emit `lp.disposition_changed` with `disposition_code: DNC` → assert an `agent_actions` row with `action_type='set_dnd'` reaches `completed`.
2. `get_contact` with `forceLive=true` → assert `dndSettings.Email.status === 'active'`. **This is the specific assertion that was failing in production** — every DNC contact sampled had an SMS entry and no Email object at all.
3. Re-run the audit query — outbound messages to DNC-tagged contacts in the trailing 30 days. Baseline **34 messages / 10 contacts**, latest 2026-07-18. Expect the count to stop growing immediately; existing in-flight sends may still land until Fix 0b (issue #51) provides the send-time gate.
4. Clean up the canary's `dndSettings` and `lp-dnd:set` tag afterwards.

## Sweep: rules carrying "flagged for manual action" notes

Mark asked for the full inventory of this pattern, on the grounds that it fails silently by construction. Five enabled rules mention manual steps; they are **not** all the same thing.

| Rule | Classification | Note |
|---|---|---|
| **#14 `LP_DISP_DNC`** | 🔴 **The pattern — being fixed here** | *"DND not settable via action executor — flagged in GroupMe notification for manual action."* GroupMe went approval-only 2026-04-15, one day after the note was written. The manual step never fired. |
| **#324 `HOT_CALL_IMMEDIATE`** | 🟠 **Same family — live manual dependency** | *"Five9 verification with Bobby = Mark's manual list."* A runtime dependency on a human-maintained list, with no telemetry proving it is being maintained. Same silent-failure shape as #14. **Recommend: verify the list is live, or automate the verification step.** |
| **#233 `LP_DISP_OPPFDN_TO_FINANCING`** | 🟠 **Silent no-op, self-documented** | *"Currently NO contact has any financing-related tag in production (0/all), so this rule will silently no-op until Layer 3 financing detection is implemented OR reps start manually tagging."* Honest, but an enabled rule that has never fired is indistinguishable from a broken one. **Recommend: disable until Layer 3 financing detection ships, or add a telemetry counter.** |
| #149 `W4_5_COMPLETED_ROUTE_TO_W11_0` | 🟡 Needs a look | *"...0 manually after step #100."* Truncated context; reads like a historical migration note rather than a runtime dependency, but not confirmed. |
| #216 `LAYER3_APPLY_BUYER_STAGE_1` | 🟢 Benign | *"avoids manually enumerating 4 specific bj:stage-* tags"* — design rationale for prefix-remove, no runtime dependency. |

**Standing recommendation:** a rule note asserting a step happens manually is an unverifiable claim about the world outside the system. #14 shows the failure mode — the claim quietly stopped being true and nothing detected it for nine months. Either automate the step or attach telemetry that proves it is still happening; a note is neither.
