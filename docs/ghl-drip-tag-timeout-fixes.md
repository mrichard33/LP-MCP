# GHL fix list: drip tags left behind when a pause gate times out (2026-10-08)

**Why.** Every "Pause Workflow Active?" gate waits up to 30 days, then takes its timeout path. That path is meant
to remove the drip's own `active-…` tag and take the contact out of the workflow. In five workflows it does not,
so the contact leaves the drip but keeps the tag. The system then reads them as "still in the drip" (52 of the 94
paused leads on 2026-10-08 were this case).

The code now clears tags that no live workflow adds (old W-names like `active-w03`). It cannot safely guess
about current tags, so these five need the fix in GHL.

| Workflow | What the timeout path does now | Fix |
|---|---|---|
| E.3 Chatbot Qualifier Bridge | removes `active-w03` (old name) | add `active-e.3` to the Remove Tag step on every gate's timeout path |
| E.7 High-Intent Digital Bridge | removes the contact from the workflow FIRST, then the tag (the tag step never runs) | swap the two steps: Remove Tag, then Remove From Workflow |
| E.4 Canvassing & In-Person Bridge | same order problem, and it removes `active-w04` | swap the steps and add `active-e.4` |
| F.0 Post-Appointment Follow-Up | removes `active-f.0` only, but F.0 also adds `active-w8.0` | add `active-w8.0` to the Remove Tag step |
| O.0 Objection Handler | 34 of 40 timeouts jump elsewhere; the others remove the stage tag but not `active-w9.0` | make sure the shared exit removes `active-w9.0` |

**Check after the edit.** Pick a test contact in the workflow, add `pause-workflow`, and in the Execution Log
use "Skip wait" on the gate's timeout. The contact should leave the workflow without the drip's tag.
