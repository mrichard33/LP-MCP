# F.0 v2 — post-demo sequence (GHL workflow spec, Mark builds it)

2026-10-16, Siro PR 1. GHL workflows are never edited from code; this is the spec.

F.0 v2 is the S4.5 v2 shell (`S4.5 Agentic Seinfeld Nurture (Shell)`, GHL id
`f99fba97-6d2f-4fd6-966c-b5e5e36f8938`) with `workflow_code: F.0`, SMS instead of
email, and F.0's own trigger, follower step and pause gate. LP-MCP writes every
text from the Siro recording of the visit, as the rehash rep; the workflow only
waits, gates and sends.

## Positions (the user, 2026-10-21)

GHL saves a numeric custom field set to 0 as BLANK, so the workflow numbers from 1.
On 2026-10-21 "Update Pre-send Fields" set the position to 0 and the generate call
got an empty position: the email was treated as text position 1. The workflow
sends the GHL number; LP-MCP maps it once (`f0InternalPosition`, `src/siro/f0-email.js`).

| What | `AI Msg Sequence Position` (GHL sends) | Inside LP-MCP | `channel` |
|---|---|---|---|
| The post-demo email | **1** | 0 | `email` |
| Text 1 … text 5 | **2, 3, 4, 5, 6** | 1 … 5 (6 is terminal) | `sms` |

Anything else for F.0 (a text at 1, the email at 2, a 7) answers
`{ error: 'unsupported_position' }`, HTTP 200. A bare 0 by email still works
(logged `[F0] legacy position 0`). `agentic_messages.sequence_position` stores the
GHL number; `generated_meta.internal_position` the inside one.

## Steps

1. **Trigger**: as F.0 today (P1 stage → "7. Appointment Completed", and the
   inbound agentic webhook). Keep F.0's entry steps: exit if `active-f.0`, add
   `active-f.0` + `agentic-active`, Active Bot = agentic, remove other marketing
   workflows, **Add to Workflow "Assign Rehash Team to Lead"** (the rep as
   follower), the rep display name, `stage:post-appointment`. Keep the won guard
   (→ C.0) and the objection pre-check only if you still want O.0 to run first.
2. **Init** ("SMS START – Set Position 2", renamed from "… Set Position 1"):
   `AI Msg Sequence Position` (`ai_msg_sequence_position`) = **2**. The workflow owns
   this field, as in S4.5; LP-MCP never writes it, and it is never 0.
3. **First wait**: until **09:30 ET the next calendar day** (ruling 2 below). A
   6 PM demo texts the next morning; Siro has processed the recording by then.
   On 2026-10-21 "Wait 1 Hour (Until 9:30 AM)" released at 8:50 PM: confirm its
   advanced window resumes only 9:30–9:45 AM; if it still releases early, replace
   it with "Wait until 9:30 AM next day".
4. **Reset Send Gate**: `AI SMS Send Ready` = No.
5. **Webhook POST** `https://lp-mcp-production.up.railway.app/api/agentic/nurture/generate`
   - header `Authorization: Bearer <MESSAGE_ENGINE_TOKEN>` (the same value S4.5 uses)
   - body / custom data: `contact_id = {{contact.id}}`, `workflow_code = F.0`,
     `sequence_position = {{contact.ai_msg_sequence_position}}` (2-6), `channel = sms`
6. **Hold branch**: if **Next Wait Hours** (`MZkFWOFDzf8OKTy2O4od`, merge tag
   `{{contact.next_wait_hours}}`; LP-MCP's key `hold_dynamic_wait_hours`) has a
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
   (727-474-8052, the rehash line).
9. **Webhook POST** `https://lp-mcp-production.up.railway.app/api/agentic/messages/engagement`
   with `generation_id = {{contact.ai_msg_generation_id}}`, `event = sms_sent`
   (the engagement route; note the path is `/messages/engagement`, not `/nurture/engagement`).
10. **Pause gate** (existing "Pause Workflow Active?"): a reply parks the contact;
    the reply path owns the conversation (it reads the same Siro visit).
11. **Wait** `{{contact.ai_msg_next_wait_hours}}` hours. `0` → exit (position 6, the fifth text, is terminal).
    **Two static emails ride inside two of these waits** (the user, 2026-10-23; copy in
    `docs/f0-v2-static-emails.md`, same From Name and signature as 0f):
    - Position 3 (text 2 just sent, a 48h wait): wait 24h → the pause gate → contact
      has no `rehash-owned` tag → send **Static Email 3** → wait 24h. (Day 4.)
    - Position 5 (text 4 just sent, a 168h wait): wait 72h → the same checks → send
      **Static Email 4** → wait 96h. (Day 11.)
    Every other position waits as before. The exits below cover both emails, and a
    contact whose text was suppressed has already left at step 7, so a static email
    only reaches a lead still in the sequence.
    Schedule: email day 0 evening, text 1 day 1, text 2 day 3, Email 3 day 4, text 3
    day 5, text 4 day 8, Email 4 day 11, text 5 day 15.
12. **Update** `AI Msg Sequence Position` + 1, clear the previous message values,
    and **Fire Self for Next Cycle** (as S4.5).

**Exits anywhere** (goal / exit triggers): `deal-won`, `stop-bot`, any DNC tag
(`dnc`, `dnc-sms`, `dnc-voice`, `lp-dnc`, `p3:dnc`), `lp-disqualified`, the
`rehash` tag removed (the sweep ends rehash at a newer lead or 30 days), a booked
estimate (WE / MV / HPA booked or confirmed). LP-MCP also refuses every one of
these at generate time, so a missed exit costs one quiet 24h wait, never a text.

**Cutover**: pause the old F.0 (do not delete it) the day F.0 v2 goes live. None
of its generic SMS steps carry over.

## Position 1: the post-demo email (Mark, 2026-10-21)

The evening of the demo, before the first text, F.0 v2 sends ONE email written
from the Siro recording and signed as **the Reece Team** ("we", never "I"; Mark,
2026-10-22). Its call invite names the rehash rep from the GHL custom value
`rehash_rep_name` (today "John"), else the follower on the lead, else "our team".
It REPLACES the old static F.0 email
("What we saw at your home, <name>"): delete that step from the old copy, keep
nothing of its text. Build these steps between step 1 (entry) and step 2 (init):

0a. **"Update Pre-send Fields"**: `AI Msg Sequence Position` = **1** (was 0: GHL
    saves a 0 as blank). **Reset** `AI Msg Send Ready` = No. **Remove tag
    `f0-email-fallback`** (2026-10-23), so a later demo never inherits it.
0b. **Webhook POST** `/api/agentic/nurture/generate`, same header as step 5, body
    `contact_id = {{contact.id}}`, `workflow_code = F.0`, `sequence_position = 1`,
    `channel = email`. Position 1 by email is the email; anything else F.0 does not
    use gets `{ error: 'unsupported_position' }`, HTTP 200.
0c. **Hold branch**, as step 6: if **Next Wait Hours** has a value → clear
    it → wait that many hours → go back to 0a's reset and 0b. LP-MCP holds in 2h
    steps while the recording is not in yet, up to `F0_EMAIL_HOLD_CAP_ET` (08:30 ET
    the day after the demo).
0d. **If the contact has the tag `f0-email-fallback`** (the user, 2026-10-23: every
    unsold demo gets an email): send **Static Email 1** (`docs/f0-v2-static-emails.md`,
    same From Name and signature as 0f), **remove the tag**, then go to 0g. LP-MCP adds
    the tag when no AI email will go out and nothing says the lead should get none:
    no recording by 08:30, F0_EMAIL_MODE or F0_V2_MODE off, the email prompt not
    active, or a draft that failed (model error, copy checks, writeback). It never
    adds it for a real stop (sold, a newer lead, rebooked, a DQ, an opt-out, a reply).
    The tag replaces `f0-no-recording` (never built in GHL).
0e. **Wait for condition** `AI Msg Send Ready` = Yes, timeout to 09:15 ET the next
    day. Timeout with `AI Msg Generation ID` empty → a real stop: go to 0g quietly.
    Timeout with an id (a draft that never reached Yes) → send **Static Email 1**,
    then go to 0g.
0f. **Send email** with the branded template: subject `{{contact.ai_email_subject_draft}}`,
    preheader **AI Email Preview Draft** (`C8mSMxWqXGr1HvxrImyx`, merge tag `{{contact.ai_email_preview_draft}}`:
    the field key GHL gave it; `{{contact.ai_email_preheader_draft}}` never existed), body `{{contact.ai_email_body_draft}}`
    (HTML paragraphs), P.S. `{{contact.ai_email_ps_draft}}` (the Template A / B
    branch as S4.5: an empty P.S. means no P.S. block). **From Name: Reece Team**
    (was the rehash rep, John, until 2026-10-22); keep the From email as it is.
    **The template is the email's ONE signature (2026-10-23), in BOTH Template A and B:**
    replace the `{{custom_values.rehash_rep_name}}` line with the plain text
    `The Reece Team`, and keep `Reece Windows & Doors` under it. The body ends on the
    call question with no sign-off (checked in code), so the email reads
    "… a quick call with John?" then "The Reece Team / Reece Windows & Doors". Do not
    change the custom value `rehash_rep_name` itself: the call invite and the rehash
    reply bot read it. The template's footer reads only "Protecting families since 1972"
    (fix the trust band in the template; the model never writes a footer, an
    address or an unsubscribe line). Then **Webhook POST**
    `/api/agentic/messages/engagement` with `generation_id = {{contact.ai_msg_generation_id}}`,
    `event = email_sent`; opens and clicks post as S4.5's do.
0g. Go on to step 2 ("SMS START – Set Position 2") and the 09:30 ET wait (step 3).
    `AI Msg Next Wait Hours` is 0 for the email and is NOT read there.

A reply to the email lands in the same GHL conversation (GHL keeps one per
contact, the workflow's template sends included); the reply path answers in the
same thread (`emailMessageId` = the lead's reply) and the pause gate parks the
contact as for a text.

**Going live without approval (the user, 2026-10-23: "I do not want to have to
approve any messaging before it goes out").** Skip the shadow week below. Set, in one
batch: `F0_EMAIL_MODE=live`, `F0_V2_MODE=live`, `NURTURE_SHADOW_WORKFLOWS=none` (unset
or empty reads as `F.0`), `F0_FORMULA_MODE=four_step`,
`NURTURE_WORKFLOW_IDS=F.0:07559309-9f55-4adf-8eff-9e5e3e5c3979,S4.5:f99fba97-6d2f-4fd6-966c-b5e5e36f8938`.
The prompt rows (email V2, texts V3) must be active first. Pause the old F.0 the same
day. With the email off (`F0_EMAIL_MODE=off`), Static Email 1 goes to everyone.

**Railway, after the merge (no default changes anything):**
1. Activate the email prompt row (the UPDATE in the header of
   `sql/seeds/2026-10-21_f0_v2_email_prompt.sql`), then `F0_EMAIL_MODE=shadow`
   (explicit). Every email is then a draft + a #contact-rehash card; approve by
   setting **AI Msg Send Ready = Yes** (the texts' gate is AI SMS Send Ready).
2. `F0_EMAIL_HOLD_CAP_ET` unset (08:30).
3. `NURTURE_WORKFLOW_IDS=F.0:<the F.0 v2 workflow id>,S4.5:f99fba97-6d2f-4fd6-966c-b5e5e36f8938`
   once F.0 v2 exists: a generate call is then refused (`wrong_active_workflow`,
   nothing written) unless the contact's Active Marketing Workflow ID is the
   workflow asking. The workflow must set that field at entry.
4. After a week of approved emails: `F0_EMAIL_MODE=live`. The email and the texts
   go live independently. Rollback, one variable: `F0_EMAIL_MODE=off`.
5. (2026-10-22) Run `sql/seeds/2026-10-22_f0_v2_email_prompt_team_voice.sql` AFTER
   the deploy that reads `F0_EMAIL_VOICE` (default `team`: prompt
   `F.0-P0-email-V2`). Set the GHL custom value `rehash_rep_name` (today **John**).
   `F0_EMAIL_VOICE=rep` puts back the email written as the rehash rep (prompt V1,
   left active for that rollback) and its checks.
6. (2026-10-22) Run `sql/seeds/2026-10-22_f0_v2_four_step_varied_close.sql` after the
   same deploy: the texts word their call ask differently each time and never repeat
   an earlier close ("if I could … would you" is the idea, not the script).
7. (2026-10-23) Run `sql/seeds/2026-10-23_f0_v2_four_step_team_voice.sql` after the
   deploy that reads `F0_TEXT_VOICE` (default `team`). It adds the 35 Four-Step texts
   in the Reece Team voice ("we", never "I"; the call is with the rehash rep; the
   last text signs " - Reece Team"), seeded INACTIVE. When the texts go live, run the
   UPDATE in that seed's header (it activates the version-3 rows) together with
   `F0_FORMULA_MODE=four_step`. `F0_TEXT_VOICE=rep` puts back the texts written as the
   rehash rep (version 2).

## Testing on a test contact (the user, 2026-10-21)

`F0_TEST_LINKS` (Railway, empty = off) = `testContactId:realLpLeadId,…`, e.g.
`hZOcPk6XmMvWVvjZJ7mz:583780`. A listed contact that carries the tag **`aios-test`**
reads that real lead's Siro visit (read-only) and is treated as an unsold post-demo
lead in rehash: its demo is always two hours ago, so the email never waits for Siro.
It is LIVE for F.0 whatever `NURTURE_SHADOW_WORKFLOWS`, `F0_V2_MODE=shadow` or
`F0_EMAIL_MODE=shadow` say (`F0_V2_MODE=off` and `NURTURE_SHADOW_MODE` still stop it),
the rehash sweep never touches it, and its rows carry `generated_meta.test_link`. Its
name is its own, never the real lead's. Nothing is ever written to, sent to, tagged on
or carded for the real lead; any #contact-rehash card for it starts "TEST —".

For Mark Test: tag `aios-test`; remove it from S5.1 Decision Compression Reactivation
if the 2026-10-21 run enrolled it; remove `active-f.0` and `stage:post-appointment`;
keep LP Disposition = OPPFDN. Then fire the F.0 v2 webhook: the email about 2h later,
the first text at the next 9:30 AM from 727-474-8052, the rest on LP-MCP's spacing.

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
| `ai_msg_meta_json` | `2KB3bkyJ92DGExsFiIIJ` | includes `siro_recording_id`, `position` (inside) and `ghl_position` |
| `ai_msg_next_wait_hours` | `h6OyxuBTv7w7ieub1P9y` | 48 / 48 / 72 / 168 / 0 for positions 2-6 (the email: 0, not read) |
| `ai_msg_generation_id` | `sxmZVqEc1KCgpauUbTAt` | the generation id (empty after a suppression) |
| `ai_msg_confidence` | `vo7aZJT2J1ozVv3cux0T` | |
| `ai_sms_send_ready` | `kIOFapo85KNwpq95Qhl7` | Yes only when not in shadow |
| `ai_msg_send_ready` | `PMq1AzXFX3nudZgNFxbw` | Yes only when not in shadow |
| `hold_dynamic_wait_hours` (GHL label **Next Wait Hours**, `{{contact.next_wait_hours}}`) | `MZkFWOFDzf8OKTy2O4od` | only on a hold |
| `ai_email_subject_draft` / `ai_email_preheader_draft` (GHL label **AI Email Preview Draft**) / `ai_email_body_draft` / `ai_email_ps_draft` | `hmmFUscWqxH1On6WPCP3` / `C8mSMxWqXGr1HvxrImyx` / `WP3BnkdAsINf13CCYGbr` / `vrAbErigvAzLCU9jj7kT` | the email at position 1 (2026-10-21); blank at positions 2-6 |
| `ai_msg_sequence_position` | `apoe5TFnilPriJmIzvbo` | **workflow-owned, never 0; LP-MCP never writes it** |

## Rulings needed from Mark (defaults used until ruled)

1. Cadence: P1 next morning, then +48h / +48h / +72h / +168h (≈ day 1, 3, 5, 8, 15),
   P5 terminal. The waits are prompt-row values; GHL clamps none, LP-MCP clamps
   to 24..240h. Keep or change?
2. First touch: 09:30 ET the next day (default), or the same evening when the demo
   ends before 5 PM?
3. Sold demos: the GHL demo note only (default), or a thank-you text as the sales rep?
4. Cutover: pause old F.0 the day v2 goes live (default), or run both for a week
   with v2 behind approval?
