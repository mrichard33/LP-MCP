# GHL build guide: pause the drips during a live conversation (2026-10-08)

**What this does.** When a lead is texting, or someone on the team just texted them, the system adds the tag
`pause-workflow`. Every drip with a "Pause Workflow Active?" gate stops at that step. After 24 hours with no texts
either way, the system removes the tag and the drip picks up at the same step. Nothing here changes a message.

**Already working (no change):** E.2–E.7, F.0, O.0, S1.2, S2.1, S2.2, S2.5, S3.1, S4.1.

## 1. Add the gate to S1.0, S1.1, S1.3, S1.6 and S4.5

Do this in each workflow, before **every** SMS or email step (copy one from S2.1 if easier):

1. Click **+** above the send step → **Wait**.
2. Wait type: **Condition**. Name it `Pause Workflow Active?`.
3. Condition: **Contact Tag** → **Does not include** → `pause-workflow`.
4. Timeout: **30 days**. On timeout: **End this workflow** (same as the existing gates).
5. Save, then **Publish**.

## 2. S5.2 v2: wait instead of exit

S5.2 v2 now treats `pause-workflow` as a reason to **exit**. Change it to wait like the others:

1. Open the If/Else near the top that checks for `pause-workflow` (along with the other exit tags).
2. Remove `pause-workflow` from that branch's conditions. Leave every other exit tag as it is.
3. Before each SMS or email step, add the same `Pause Workflow Active?` wait as in step 1.
4. Save, then **Publish**.

## How to check it worked

Pick a test contact that is in one of these workflows. Add `pause-workflow` by hand: the contact should stop at
the next gate (Execution Log shows "Waiting"). Remove the tag: it should move on to the next message.
