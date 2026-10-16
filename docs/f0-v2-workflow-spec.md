# F.0 v2 — post-demo sequence (GHL workflow spec, Mark builds it)

2026-10-16, Siro PR 1. GHL workflows are never edited from code; this is the spec.

F.0 v2 is the S4.5 v2 shell (`S4.5 Agentic Seinfeld Nurture (Shell)`, GHL id
`f99fba97-6d2f-4fd6-966c-b5e5e36f8938`) with `workflow_code: F.0`, SMS instead of
email, and F.0's own trigger, follower step and pause gate. LP-MCP writes every
text from the Siro recording of the visit, as the rehash rep; the workflow only
waits, gates and sends.

## Steps

1. **Trigger**: as F.0 today (P1 stage → "7. Appointment Completed", and the
   inbound agentic webhook). Keep F.0's entry steps: exit if `active-f.0`, add
   `active-f.0` + `agentic-active`, Active Bot = agentic, remove other marketing
   workflows, **Add to Workflow "Assign Rehash Team to Lead"** (the rep as
   follower), the rep display name, `stage:post-appointment`. Keep the won guard
   (→ C.0) and the objection pre-check only if you still want O.0 to run first.
2. **Init**: `AI Msg Sequence Position` (`ai_msg_sequence_position`) = 1 when empty.
   The workflow owns this field, as in S4.5; LP-MCP never writes it.
3. **First wait**: until **09:30 ET the next calendar day** (ruling 2 below). A
   6 PM demo texts the next morning; Siro has processed the recording by then.
4. **Reset Send Gate**: `AI SMS Send Ready` = No.
5. **Webhook POST** `https://lp-mcp-production.up.railway.app/api/agentic/nurture/generate`
   - header `Authorization: Bearer <MESSAGE_ENGINE_TOKEN>` (the same value S4.5 uses)
   - body / custom data: `contact_id = {{contact.id}}`, `workflow_code = F.0`,
     `sequence_position = {{contact.ai_msg_sequence_position}}`, `channel = sms`
6. **Hold branch**: if `Hold Dynamic Wait Hours` (`hold_dynamic_wait_hours`) has a
   value → clear it → wait that many hours → POST
   `/api/agentic/hold-complete` with `{ contact_id, return_to: "f0_v2", refire: false,
   sequence_position, workflow_code: "F.0" }` → **go to step 4**. The generate
   call writes this field only when it is waiting for the Siro recording
   (`awaiting_siro`, 2h, at most 24h after the demo) or when a recent reply holds
   it. hold-complete never calls generate itself (it records the event); the
   loop back to step 4 re-asks at the SAME position, because LP-MCP never moves
   the position.
7. **Wait for condition** `AI SMS Send Ready` = Yes, **timeout 24h**.
   - Timeout and `AI Msg Generation ID` is EMPTY → the generate call suppressed
     this touch (sold, rebooked, a newer lead, rehash ended, a team-note DQ, the
     two-no stop, F.0 v2 off). LP-MCP clears the drafts on every suppression, so an
     empty id means "nothing to send": **exit quietly**, no alert.
   - Timeout with an id present → the draft is waiting for approval longer than a
     day, or stuck: same as S4.5's stuck branch (internal notification to Mark,
     tag `f0-stuck`, exit).
8. **Send SMS** `{{contact.ai_sms_body_draft}}` from the same number F.0 uses today
   (727-800-4578, the rehash line).
9. **Webhook POST** `https://lp-mcp-production.up.railway.app/api/agentic/messages/engagement`
   with `generation_id = {{contact.ai_msg_generation_id}}`, `event = sms_sent`
   (the engagement route; note the path is `/messages/engagement`, not `/nurture/engagement`).
10. **Pause gate** (existing "Pause Workflow Active?"): a reply parks the contact;
    the reply path owns the conversation (it reads the same Siro visit).
11. **Wait** `{{contact.ai_msg_next_wait_hours}}` hours. `0` → exit (position 5 is terminal).
12. **Update** `AI Msg Sequence Position` + 1, clear the previous message values,
    and **Fire Self for Next Cycle** (as S4.5).

**Exits anywhere** (goal / exit triggers): `deal-won`, `stop-bot`, any DNC tag
(`dnc`, `dnc-sms`, `dnc-voice`, `lp-dnc`, `p3:dnc`), `lp-disqualified`, the
`rehash` tag removed (the sweep ends rehash at a newer lead or 30 days), a booked
estimate (WE / MV / HPA booked or confirmed). LP-MCP also refuses every one of
these at generate time, so a missed exit costs one quiet 24h wait, never a text.

**Cutover**: pause the old F.0 (do not delete it) the day F.0 v2 goes live. None
of its generic SMS steps carry over.

## Approval while in shadow

`NURTURE_SHADOW_WORKFLOWS` holds `F.0` (and `F0_V2_MODE=shadow` forces it): every
F.0 draft is written to the contact but the gate is left at No, and a card posts
to **#contact-rehash** with the draft, the prospect, the position, the prompt and
the Siro recording link. To approve one: set **AI SMS Send Ready = Yes** on the
contact in GHL; the workflow sends it at step 7. To skip: leave it (the 24h
timeout ends that touch). Remove `F.0` from the list after a week of approvals.

## Fields LP-MCP writes on the contact (`FIELD_IDS`, `src/nurture/nurture-writeback.js`)

Verify each exists on the contact before building:

| Key | GHL field id | Written |
|---|---|---|
| `ai_sms_body_draft` | `xr0EkxRCshI6tlm4dpvO` | the text |
| `ai_msg_meta_json` | `2KB3bkyJ92DGExsFiIIJ` | includes `siro_recording_id` and `position` |
| `ai_msg_next_wait_hours` | `h6OyxuBTv7w7ieub1P9y` | 48 / 48 / 72 / 168 / 0 |
| `ai_msg_generation_id` | `sxmZVqEc1KCgpauUbTAt` | the generation id (empty after a suppression) |
| `ai_msg_confidence` | `vo7aZJT2J1ozVv3cux0T` | |
| `ai_sms_send_ready` | `kIOFapo85KNwpq95Qhl7` | Yes only when not in shadow |
| `ai_msg_send_ready` | `PMq1AzXFX3nudZgNFxbw` | Yes only when not in shadow |
| `hold_dynamic_wait_hours` | `MZkFWOFDzf8OKTy2O4od` | only on a hold |
| `ai_email_subject_draft` / `ai_email_preheader_draft` / `ai_email_body_draft` / `ai_email_ps_draft` | `hmmFUscWqxH1On6WPCP3` / `C8mSMxWqXGr1HvxrImyx` / `WP3BnkdAsINf13CCYGbr` / `vrAbErigvAzLCU9jj7kT` | blank for F.0 |
| `ai_msg_sequence_position` | `apoe5TFnilPriJmIzvbo` | **workflow-owned; LP-MCP never writes it** |

## Rulings needed from Mark (defaults used until ruled)

1. Cadence: P1 next morning, then +48h / +48h / +72h / +168h (≈ day 1, 3, 5, 8, 15),
   P5 terminal. The waits are prompt-row values; GHL clamps none, LP-MCP clamps
   to 24..240h. Keep or change?
2. First touch: 09:30 ET the next day (default), or the same evening when the demo
   ends before 5 PM?
3. Sold demos: the GHL demo note only (default), or a thank-you text as the sales rep?
4. Cutover: pause old F.0 the day v2 goes live (default), or run both for a week
   with v2 behind approval?
