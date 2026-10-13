# LP-MCP — working notes for Claude

LP-MCP is the Lead Perfection integration and the home of the agentic Decision Engine for the Reece
Antifragile Sales System. It talks to LP, GoHighLevel (GHL), Five9 and Supabase, and it sends
operator alerts.

This file records the conventions that are already load-bearing here and are easy to violate by
accident — the ones that cost an incident when they were missed. It is not a tour of the codebase.

## Notifications: we are migrating off GroupMe to Slack

**Never add a GroupMe-only notification path.** Route through an existing logical channel and let the
mirror do the rest:

- `sendGroupMeMessage(text, { channel })` in `src/groupme.js` calls `mirrorToSlack` on every send, so
  one call reaches both. Channels are `main`, `canvass`, `sales`, `ops` (and `unknown` → `main`).
- **A market-scoped channel needs the market CODE, not the name.** `canvass` and `sales` resolve
  `<prefix>-<slug>` through `slack_market_slugs`, which is keyed on the code (`FTMYR`), while the
  card prints the display name (`Ft. Myers / SW Florida`). Passing the name resolves nothing and the
  card lands in the rollup only. `resolveMarketCode()` in `src/actions/enrichment.js` returns the
  code; `resolveMarket()` returns the name.
- **Operational alarms go to Slack only (Mark, 2026-09-29; supersedes decision #2188).** Send them
  through `reportAlertCondition` (its default sender) or `sendAlertMessage(text, { channel: 'ops' })`
  in `src/alert-state.js` — never `sendGroupMeMessage`. `'ops'`, a blank channel and anything unknown
  post to `SLACK_CHANNEL_OPS` (#ops-alerts). `ALERT_SEND_TARGET=groupme|both` is the rollback switch;
  an unset Slack channel is `sent:false` and a log line, never a GroupMe fallback. Precedent:
  `src/jobs/lp-report-watchdog.js`, `src/jobs/capacity-sweep.js`, `src/routes/capacityRanker.js`.
- The mirror is **fail-silent by design** (`src/slack.js`): a bad token, a missing channel or
  `SLACK_MIRROR_ENABLED` unset logs and returns. That means a misconfigured Slack channel looks
  exactly like a quiet night. After shipping anything that alerts, confirm a card actually lands —
  do not infer it from silence.

Because the mirror sits below the card builders, there is no second copy of any message format.
Build the card once.

**When Slack is the PRIMARY destination, not a mirror, use `postToSlack(text, channelId)`** in
`src/slack.js` — it returns `{ ok, ts, channel, error }`. `mirrorToSlack` fans out to several channels
and reduces the result to a count, so it cannot tell you the message `ts` or that a specific post
failed; it now delegates to `postToSlack` so there is still exactly one `chat.postMessage` call in the
repo. Precedent: `src/notifications/slack-sale.js`, whose row has to store the `ts`, and which is
Slack-only because GroupMe keeps firing for the same event from inside the GHL workflow. Unlike the
mirror, `postToSlack` ignores `SLACK_MIRROR_ENABLED` — a destination of record must not depend on a
migration switch. Pass `{ threadTs }` to reply under a message instead of posting a new one.

**`POST /webhook/slack/interactions` is the front door for the WHOLE workspace, not just us.** A Slack
app has exactly one Interactivity Request URL, and n8n's `OPS.SLK-E Approval Buttons` (team
onboarding, `approve_member` / `deny_member`) owned it first. `src/slack-approvals.js` therefore
verifies the signature, handles our two `approval_*` buttons, and relays everything else to
`SLACK_INTERACTIONS_FORWARD_URL` as the exact bytes Slack sent. Three things that look optional and
are not: forwarding must NOT be gated on `SLACK_APPROVALS_ENABLED` (a flag flip would break someone
else's production flow), our own buttons must never be forwarded even with the flag off (n8n reads
any `action_id` that is not `deny_member` as an approval), and the relay copies only the two
`X-Slack-*` signing headers — never `Authorization`. Unset `SLACK_SIGNING_SECRET` refuses
everything, forwards included, so set the secret BEFORE repointing Slack.
The DNC-lift buttons (`dnc_lift_*`, 2026-09-28) are relayed ONLY to `SLACK_DNC_LIFT_FORWARD_URL` (n8n
OPS.DNC-LIFT) and dropped when it is unset — never to the onboarding forward.
The payroll card's `payroll_approve` button (2026-09-26) is ours too: any `payroll_*` click is
handled or dropped, never forwarded, and it is gated on `PAYROLL_ENGINE_MODE=live`, not on
`SLACK_APPROVALS_ENABLED`. It authorises by active `lf_report_approvers` EMAIL (Slack `users.info`,
bot scope `users:read.email`), not `SLACK_APPROVER_IDS`.

**GroupMe cannot decide an approval (security review, 2026-10-03).** The GroupMe bot callback is
unsigned, so `/webhook/groupme` ignores `yes/no/approve/reject/deny <id>` and `Edit <id>` (logged, never
answered) and the card footer sends people to Slack. Slack's signed buttons are the only approval path.
`/groupme/send` and `/groupme/pending` need the operator token. Do not re-add a text-command approval
on any unsigned channel. The 60-minute auto-run also never removes a `PROTECTED_TAGS` / `dnc*` /
`suppress:*` tag and never closes an opportunity won/lost (`needsAHuman` in `approval-escalation-sweep.js`).

**Approval cards speak plain English; the rule code lives only in the `ref:` line.** A card that
printed `P2_JOB_TERMINAL_WON` and `update_opportunity` could not be decided from (#486315). The body
is built once, purely, in `src/approval-card.js` (What happened / If you approve / If you reject /
Contact) and feeds both GroupMe and the Slack button card through `renderApprovalCard` in
`src/groupme.js`. New action or event type? Add its sentence to `describeApprove` / `describeEvent`
— the fallback works, but it reads like a config dump. Never write a pronoun for the contact; the
card uses their first name. Dry-run any card with `node scripts/render-approval-card.js <action id>`.
The 30-minute reminder (`buildTimeoutReminder` in `src/approval-escalation-sweep.js`) is the same
card with a `⏰ Still waiting` header plus an "If nobody decides" line — keep that line in step with
the sweep's own phases, because ignoring a reminder is not neutral: safe actions auto-run at 60 min.
A Slack card that posts logs `[Slack] approval card #<ref> posted`; look for that line, not silence.

**A celebration and a stat line are two different jobs — do not let one become the other.** The
sale-announcement post carried the rep's month-to-date total inside the message for one day, and the
model turned it into a ledger entry: *"Craig Barela closes another one — $1,500 today, $36,300 on the
month."* None of the ten examples in `sale-announcement-rulebook.md` cite a month total; every one is
the sale alone. `buildFactsBlock` now hands the model only what a person would cheer (a rank climb, a
personal record, a 3+ day streak, a top-3 standing) and the numbers go out as a threaded reply from
`formatStatsLine`. The reply is best-effort: one attempt, no retry, no ops alert, and it may never
change a row that already reads `posted` — a sale that reached the board is not a dropped sale.

**A rank climb is only celebratory if it LANDS well.** Live row 4 produced a real climb of 50 → 41
out of a field of 50 — out of dead last. Any message using it states where the rep started, which is
exactly what the rulebook's comparison rule forbids. `isCelebratableClimb` requires the destination to
be in the top third of the field (floor of 3), and suppresses the climb outright when the field size
is unknown. Do not relax that to "any improvement".

**Info emails the bot promised go out through ONE switch, `INFO_EMAIL_WEBHOOK_URL`.** Unset, they
send through the Conversations API. Set, one POST carries `subject`, `preheader` and `body_html` to a
GHL Inbound Webhook workflow. Every email needs all three (Mark, 2026-09-24). Point the URL only at a
workflow that sends those fields unchanged. A workflow with a ChatGPT step rewriting the text (as
U.SEND-AI and I.AI-MAIL do today) skips every check in `src/actions/handlers/info-email.js`.

**A guide goes out with a saved first name (Mark, 2026-10-03).** U.GUIDE emails the guide with `{{contact.first_name}}`
and sent "Hi ," when nothing had saved one. `ensureGuideName` (`src/agentic/guide-name.js`) runs before any
`send-<type>-guide` tag (the layer3 dispatch and an accepted `guide_disposition`): a name on the contact → send; a name in
the thread (a bare reply to our name ask, "my name is X") → the fill-if-empty GHL write is AWAITED, then send; none →
the tag is held as `guide-pending-name:<type>` and the reply asks only "What's your first name, so I can put it on the
guide?". The next reply releases it, with the name if given; after one ask the guide goes anyway
(`guide_sent_without_name`). The SMS identity pass now takes a one-word reply to our name ask as the first name.
U.GUIDE also fires on S2.2's `hurricane-guide-queue`, which this gate cannot hold: its fallback greeting is Mark's to set in GHL.

**One send gate decides who we may message (2026-10-07).** `mayMessage({ tags, channel, purpose })` in
`src/services/may-message.js` is the one answer, pure: CONSENT_STOP (the DNC family + stop-bot) blocks every purpose
(a phone-only opt-out spares email; dnc-email blocks only email), HARD_DQ (out-of-area, dq-out-of-area, hard-disqualified,
suppress-outbound) blocks `reply` and `outreach`, OPERATIONAL_HOLD (quarantined, cooling-active, cannot-afford, canvassing)
blocks `outreach` only, and pause-workflow / suppress-automation / pause-bot never block (pause-workflow is a GHL drip
signal). Every sender calls it through `applySendGate` (`src/services/send-gate-report.js`): the send flow and its live
re-check, the send handler, the live chat, info emails, nurture, lead selection and `add_to_workflow` (purpose `mutation`).
`SEND_GATE_MODE` shadow (default) keeps each route's old answer and records `send_gate.would_block` / `would_allow`; live
lets the gate decide (a legacy block on a tag the gate does not know still stands). Do not add a sixth list: add the tag
to a class. In live, a completed add_tag of out-of-area / dq-out-of-area / hard-disqualified queues ONE `dq_hard_stop`
(`src/services/dq-hard-stop.js`, 60s later): stop-bot on, agentic-active off, remove_from_workflow for every active
S5.x / S4.5 / W-series workflow (codes the HL registry cannot resolve go through Remove All Marketing).

**A live conversation pauses the GHL drips; 24 quiet hours resume them (the user, 2026-10-08).** `pause-workflow`
holds a contact at the "Pause Workflow Active?" wait gate in E.2–E.7, F.0, O.0, S1.2, S2.1, S2.2, S2.5, S3.1 and S4.1;
removing it resumes at that step, and GHL's 30-day gate timeout exits a contact still parked. It is added on the
lead's own text (`behavioral-emitter.js`, before the trivial filter) and on any outbound text no workflow, bulk action
or campaign sent (HL-MCP's `contact.outbound_message`; GHL marks the bot's sends `source: app` like a rep's, and either
way the conversation is live). `src/pause-workflow-sweep.js` (job `pause-workflow-sweep`, every 5 min) releases a pause
WE added (rule `CONVERSATION_PAUSE`) after `PAUSE_QUIET_HOURS` (24) with no text either way and no open promised call,
and any of ours at 28 days, before GHL's timeout. Never a contact the bot must not talk to (stop-bot, a DNC, a hard DQ:
they stay parked) and never a pause a GHL workflow set. Rules in `src/agentic/conversation-pause.js`, reads in
`src/services/conversation-pause-io.js`, chunked per contact: the old sweep read every add_tag in one query, got
PostgREST's newest 1,000 rows and never released anyone. `CONVERSATION_PAUSE_MODE` off|shadow|live, default shadow;
`POST /n8n/pause-workflow/sweep {"dryRun":true}` reports who live would release. S1.0, S1.1, S1.3, S1.6 and S4.5 have
no gate yet, and S5.2 exits on the tag; those are GHL edits, not code.

**Drip tags cannot go stale (the user, 2026-10-08).** `active-<code>` tags are added only by GHL workflows (our code
only removes them; the n8n ports of the drips are inactive). Rule R7 in the daily tag sweep
(`src/tag-hygiene/rules.js`, `src/jobs/tag-hygiene-sweep.js`) removes a drip tag that no PUBLISHED workflow adds any
more (`buildRetiredDripTagsSql` over the HL mirror's `workflow_actions`; old W-names such as `active-w03`,
`active-w5.2`, `active-w11.2`). A read that fails, or finds fewer than `MIN_LIVE_DRIP_TAGS` live tags, skips R7.
`TAG_SWEEP_APPLY_RULES` (default `R7`) lets a rule write while `TAG_SWEEP_MODE` stays `report` for R1–R6; `none` turns
it off. `POST /admin/tag-hygiene/run?dryRun=true` writes nothing. Current tags left behind by a pause gate's 30-day
timeout are a GHL fix, not a guess in code: `docs/ghl-drip-tag-timeout-fixes.md`.

**Only an opt-out silences the bot (Mark, 2026-09-24).** A classifier handoff tags the contact and,
where a person must act, pages one — and the bot still replies, unless `handoffReplyPolicy`
(`src/agentic/handoff-policy.js`) says `silent` (STOP, WRONG_NUMBER; a STOP that is only a door complaint is
cleared, `classificationAfterKnock`). A new handoff class replies by default. Do not add a silent class without Mark's
ruling, and never add `stop-bot` to a rule whose trigger is not an opt-out. Mark's ruling of 2026-10-06 is the one
exception: a lead the system DISQUALIFIED gets no bot message and gets stop-bot (the one send gate, above). A team
note in LP that says we cannot run the lead is such a disqualification (2026-10-07, below).

**`stop-bot` turns the bot off; it is NOT a DNC (the user, 2026-10-07).** "This tag is intended to stop all bot
communication." It is its own send-gate class (`BOT_STOP` in `may-message.js`: every purpose, every channel, reason
`bot_stop`), it is not in `DNC_FAMILY_TAGS` (no DNC-lift card), not in the inbound caller's `DNC_TAGS` (a stop-bot
caller is still captured and dialed), and rules 368/369/387/388 no longer fire on it alone
(`sql/seeds/2026-10-07_stop_bot_not_dnc.sql`). Never write a consent row, a Five9/LP DNC or a DNC-lift card
because of stop-bot. Rule 14 still adds stop-bot on an LP DNC (it must: stop-bot is what the mutation gate, the
analyzer skip and the ownership stamp read), so **a DNC lift removes only a stop-bot a DNC put there (2026-10-08)**:
`filterLiftRemoval` (`src/consent/stop-bot-origin.js`, called in `executeRemoveTag`) keeps stop-bot when the contact
carries a `bot-off:<reason>` tag (`bot-off:dq`, `bot-off:lp-note` from `dq_hard_stop`, `bot-off:review` from Bot
Review), when our newest record of a stop-bot add is not a DNC rule (`DNC_STOP_BOT_RULES`), when there is no record
(a person added it in GHL), or when the read fails. The rest of the lift goes ahead; the log is `stop_bot_kept_on_lift`.
A new non-DNC stop adds its own `bot-off:` tag next to stop-bot.

**No confirmed time without a booking (Nicholas Ferraioli, 2026-10-07).** The bot told a lead "Thursday … 10:00
AM ET works.", "… is holding for you." and "You're all set" and booked nothing: a stale `booking:active` tag made
his LP-cancelled visit read as on file, and the mid-pipeline guard trusted a `book_appointment` companion that the
NEPQ plan dropped later. Now:
- `checkBookingTruth` (`src/agentic/booking-claim.js`) is the LAST check on every AI-written send (send handler,
  after the inline booking; live chat before `deliver`), every NEPQ mode and channel. A time claim stands only with
  this turn's real appointment id (`bookingResult`) or the appointment still on the calendar at that day and time
  (`appointmentOnFile`: GHL first, then LP not CXL/CCC; `booking:active` alone is never an appointment). Otherwise
  the reply becomes "Thanks, {name}. A team member will call you shortly to confirm a time that works." (no day, no
  time; "as soon as we open" out of hours), logs `booking_claim_blocked` and emits `agentic.booking_claim_blocked`.
  The simulator mirrors it (`applyBookingTruth`). Add a new confirm wording to `CLAIM_PATTERNS`, never a second guard.
- A blocked claim, a callback route (`callback_request`, `busy_callback`, `frustrated_fast_track`,
  `escalate_to_rep`) or a `phone_call` ask that booked nothing files the Five9 Callback Request through
  `fileBotCallback` (`schedulingCallbackDecision`), unless a real future appointment exists.
- `context-builder.js`: an LP CXL/CCC outranks `booking:active` (that tag only overrides the `appt-cancelled` tag).
- Both prompts render the same `LEAD FACTS` block (`src/agentic/lead-facts.js`): the appointment's real status and
  cancel note, every LP note in full, the property ZIP on file (LP first). `enforceCancelledVisit`
  (`src/agentic/cancelled-visit.js`) replaces "before your visit" after a cancel; a later typed ZIP is a correction
  ("33756" then "Sorry 33711" → 33711), and the property ZIP wins when it was typed.
- **A team note that says we cannot run the lead stops the bot.** `LP_NOTE_DQ_SIGNALS` (`src/agentic/lp-note-dq.js`,
  one list: not the owner, renter, a housing program, "not something we can run", out of area, mobile home). The
  reply writer books nothing and sends the no-promise hand-off once; the send handler files the Five9 callback,
  posts a ⛔ card to #contact-center with the note, the appointment, the last 5 messages and what the bot said
  (`routeNepqHandoff` reason `lp_note_dq`), and queues `dq_hard_stop` (stop-bot, out of S5.x/S4.5/W). S5.2 entry
  is refused on such a note and for a lead who texted in the last 2 hours (`s52-entry-gate.js`).
  `LP_NOTE_DQ_MODE` off|shadow|live, default live.

**Post-demo F.0 leads talk to the rehash rep (Mark, 2026-10-01).** A contact tagged `active-f.0` (or texting
727-800-4578) gets SMS replies written AS the rep in the GHL custom value `rehash_rep_name`, read by
`src/services/ghl-custom-values.js` and written in as a literal (never the merge tag). The one goal is a
phone call with that rep; the offer is hinted at, never named (`stripOfferTalk`). Layer3 script directives
are dropped for these replies because every one is pre-demo copy. A "yes" to the call posts one card a day
to #contact-rehash (`SLACK_CHANNEL_REHASH`, default C0C5YMHNYJH) via `src/notifications/rehash-call.js`.
No resolved name → the reply signs "Reece Team"; never guess a name. See `src/agentic/rehash.js`.

**A rehash lead is on the post-demo NEPQ track, never the new-lead stages (handoff, 2026-10-11).** `buildNepqBlock`
renders `src/agentic/rehash-nepq.js` instead of the stage play, objection plays, booking discipline and visit disclosure
for `opts.rehash.active` (fixture 40 had "What got you looking at the windows" above the ban on windows questions):
proposal → where they are → what holds them back → what would make it work → the bridge → the call, one per turn,
objections asked back, two no's stop (`post_demo_stop`). "The best deal possible" is the ONE allowed hint, once per
conversation (`stripOfferTalk({ hintUsed })`); everything else in `OFFER_TALK_RX` is still stripped. A booked Rehash
Call confirms "You're all set for [day] at [time]. [first name] will give you a call then." (`rehashRepFirstName`,
`REHASH_TEAM_USER_NAMES`; keep "all set": `BOOKED_LINE_RX` and the promised-callback exemptions read it) and posts a
"REHASH CALL BOOKED" card. A post-demo call-time ask is not a visit booking ask (`callTimeAsk` in `enforceNepqPlan`).

**After an unsold demo the sales rep no longer owns the lead; the rehash team does (the user, 2026-10-11).** "We should
not continue to say the sales rep will follow up." `isUnsoldPostDemo` (`src/agentic/post-demo-owner.js`: past the
appointment or rehash, and not sold: LP closed-won / Sale / a P2 customer) switches the reply writer's close to
`POST_APPOINTMENT_CLOSE_FOLLOW_UP_TEAM`, relabels the CRM "Sales Rep" line as the rep at the visit who no longer owns it,
names "our follow-up team" (or the rehash rep the line speaks as) as the owner on an escalation acknowledgment, and
`replaceSalesRepFollowUp` renames "your rep / Beverly will call / follow up / be in touch" to our follow-up team after the
model. A SOLD lead keeps its rep (fixture 41). The customer never hears the word "rehash".

**A post-demo lead is in REHASH: the rehash team calls it, LP is never touched (the user, 2026-10-09).** Monica (LP
lead 581695, OPPFDN after her 10/7 demo, outside F.0's 14-day window) got a Five9 sales callback, a moved appointment
and an LP re-set. Now:
- **LP lock:** `postDemoLock` (`src/lp-post-demo-lock.js`) runs right before both LP SetAppointment calls
  (`executeSetLPAppointment`, `syncAppointmentToLP`). It reads the caller's disposition, `lp_leads`, then LP live, and
  any `isDemoDisposition` answer (Sale, OPPFDN, NoRehash, FDNS, SW, PM) refuses. A lead neither source knows is a new
  lead; both reads failing refuses. "We should never modify a lead marked OPP FDN."
- **The stage:** `src/agentic/rehash-state.js`. The current lead OPPFDN with a demo in the last `REHASH_DAYS` (30) → tags
  `rehash` + `rehash-lead:<lds>` + `rehash-since:<demo date>`. It ends on a NEWER lead, when the lead leaves OPPFDN, or at
  30 days: the tags come off, `rehash-done:<lds>` stays, and a GHL owner in `REHASH_TEAM_USER_IDS` (default John Manieri)
  is cleared by `release_rehash_owner` (read back). Job `rehash-tag-sweep` (15 min) writes through agent_actions rows
  (rule `REHASH_TAG_SWEEP`). `isRehashContact` counts `rehash` like `active-f.0`.
- **Calls, not visits:** a rehash call request (`lp_callback_requeue`, so `fileBotCallback` and `HOT_CALL_IMMEDIATE` too)
  skips Five9 and posts one #contact-rehash card a day (`skipped_rehash_lead`); no #contact-center card. A
  `book_appointment` for a rehash lead goes only on Rehash Call: a Confirmation Call is moved there at the same time, a visit
  is refused (`skipped_rehash_visit`), and with no `REHASH_CALENDAR_ID` nothing is booked and #contact-rehash is told
  (`skipped_rehash_no_calendar`). A lead not in rehash is never booked on Rehash Call (`skipped_not_rehash`).
  A Confirmation Call for a contact GHL has at `stage:post-appointment` goes the same way (moved to Rehash Call;
  the user, 2026-10-09): that tag is read ONLY for this, since GHL workflows own it (F.0 adds it, S1.1/S1.3/S4.5/A.WE
  remove it); it never puts a contact in rehash, refuses a visit or touches Five9 (`hasPostAppointmentStage`).
- `REHASH_ROUTING_MODE` off|shadow|live, default shadow (`rehash.would_*` events only). The LP lock is not behind it.

**A post-demo lead is planned as post-demo, never as a new lead (Mark, 2026-10-09).** Five rehash threads got a stock
discovery question after "Thank you I will.", two slot offers to "Follow up in November please.", a question after "Enjoy
your week." and "Congratulations" to a lead who signed elsewhere: `planNepqTurn` never knew, and `enforceNepqPlan` step 7
appended `DISCOVERY_QUESTIONS`. Now `planNepqTurn({ postDemo, rehashRep })` (rehash, or `derivePostAppointment`) plans,
after the hand-offs: `competitor_signed` (`PURCHASED_ELSEWHERE_RX`, `src/agentic/purchased-elsewhere.js`, the same text as
rules 173/356, which own the routing: change them together), `defer` (`detectDeferral` in `src/agentic/post-demo-turn.js`:
confirm the date, no question, no time), a pending deferral (no times until it is due), `post_demo_ack` (at most one
`POST_DEMO_QUESTIONS` question) or `post_demo`; booking is off and the rep call stays allowed. The enforcer drops the
pre-demo questions on a post-demo plan and never appends a question after a sign-off line (`isSignOffLine`). A confirmed
date is filed after the send (`src/services/post-demo-followup-io.js`: GHL task for the first `REHASH_TEAM_USER_IDS` id,
`followup-requested`, a note; once per date). `POST_DEMO_PLANNER_MODE` off|shadow|live, default shadow (`[PostDemo] shadow`).

**LP's SetAppointment says Result 0 for success, 1 for a refusal (2026-10-12).** The opposite of UpdateDNCStatus.
All 87 stored replies: 48 × `0 "Appointment set successfully."`; 39 × `1` ("record has future appt date…", "market is
OOA.", "dispo is Issue, DNC or Sale.", "lds_id does not exist."). `inspectAppointmentResponse`
(`src/lp-appointment-guards.js`) had it backwards, so `LP_APPT_GUARD_MODE=enforce` would have refused every booking.
Every refusal is an `lp.appointment_refused` event (shadow and enforce). In enforce, `executeSetLPAppointment` and
`syncAppointmentToLP` RETURN `lp_appointment_refused` (`refusedAppointmentAnswer`) rather than throw, because a thrown
refusal was re-sent by the executor, the parity watchdog, inbound-checkout-watch and the post-issue retry. The sync also
holds a refused lead + date + time for 24h (`refused:<dedupKey>` mark, `lp_refusal_recent`). Replay test:
`scripts/test-lp-appt-guard-replay.js`. Add a new LP reply there when one appears.

**A held appointment asks a person to import its LP row (2026-10-05).** When LP already has an unimported
inbound row for a contact, `syncAppointmentToLP` holds the appointment (`lp-appt-deferred`) rather than add a
duplicate lead, and the parity watchdog re-drives it every 30 min. LP has no API that imports a row, so once a
visit within 24h waits on a row 30+ min old (or the row passes `LP_INBOUND_DEFER_MAX_AGE_MIN`), ONE card per row
goes to #contact-center (`SLACK_CHANNEL_SERVICE`) — but only after the team has been open
`LP_HELD_IMPORT_ALERT_OPEN_MIN` (60) minutes and the row is still not imported (`openMinutesSince`; the user: no
card the moment we open, staff work the overnight queue first). Audit `lp_inbound_held`, one card per row.

**A confirmation call is never an LP appointment (the user, 2026-10-09).** "We should never create a calendar event in
Lead Perfection for a confirmation call." A GHL-only calendar (`GHL_ONLY_CALENDAR_KEYS`: Confirmation Call
`gFWoSQrlKIdfRbAPV842`) lives only in GHL; LP holds the estimate visit. On 2026-10-08 the parity watchdog wrote a
Confirmation Call onto LP lead 581695 (OPPFDN → Set) and the reconciler minted a Window Estimate at the same slot (#1218).
Every path that can put an appointment in LP refuses one: by calendar id where it has one (`syncAppointmentToLP`,
`executeSetLPAppointment`, the watchdog's `bucketGhlBook`), and by time where it has only a date and a time copied
from GHL's `last_appointment_start_date/time`, which ANY calendar fills (`checkConfirmationCallSlot` in
`src/services/confirmation-call-slot.js`: the addlead proxy, which every live I.LP-OUT send goes through, create_lp_lead
for new, reused and issued-inquiry leads, set_lp_appointment and the sync with no calendar named). The lead still goes
to LP, without the appointment. A failed GHL read fails open. The reconciler never creates a Window Estimate over an
active GHL-only appointment at the same time. A new LP write that carries a date and time goes through the same check.
**Rehash calls have their own calendar; pre-demo Confirmation Calls name nobody (the user, 2026-10-09).** #1223 sent
every Confirmation Call to the contact's owner or John Manieri, but pre-demo leads use that calendar too, so the rehash
team would get pre-demo calls. Now a rehash call goes on "Rehash Call" (a GHL Round Robin of the rehash reps,
`REHASH_CALENDAR_ID`, GHL-only like Confirmation Call, so no LP path takes it): the named assignee, else the contact's
owner when that owner is on the rehash team (`REHASH_TEAM_USER_IDS`), else the Rehash rep (John Manieri
`TYcZ9DcNkuPCFYsFxRFV`, `CONFIRMATION_CALL_ASSIGNED_USER_ID`). A Confirmation Call names only an assignee the booking
named (`callAssigneeFor`, `src/config/rehash-assignee.js`).
**A rehash call is offered only at times the Rehash Call calendar shows open (the user, 2026-10-09).** Calendar
`ncDzLgzbfKJRfhmtlWtB` (`REHASH_CALENDAR_ID`). `readRehashCallSlots` (`src/agentic/rehash-slots.js`) reads it for the rep
the booking will name (`callAssigneeFor`; `fetchFreeSlots({ userId })`), team hours, 30+ minutes out. In the post-demo
planner a yes to the call, a call request or a schedule ask gets two of those times (`rehash_offer`); a pick or a typed
open time is booked from the plan (`rehash_confirm` → `rehashCallBooking`, never the model's words), re-checked for the
same rep right before booking (`recheckSlot({ userId })`), and LP is never touched (GHL-only calendar). No calendar, no
open times or a failed read: the old reply and the #contact-rehash card, which is now skipped when times were offered or
the call booked. A follow-up date still wins ("Call me in November" → `defer`). `REHASH_CALL_SLOTS_MODE` off|shadow|live,
default shadow (`[RehashSlots] shadow … would offer/book`); live also needs `POST_DEMO_PLANNER_MODE=live`.
**A rehash lead is rehash by its LP lead, and never promised a call "right now" (Monica, 2026-10-09).** "I never got a
call" (John, the rehash rep, out until Monday) got "We're having someone call you back right now.": the reply writer knew
rehash only by the `rehash` / `active-f.0` tag, which the shadow sweep never adds, so John's calendar was never read, and
"we're having someone call you" did not read as a promise at all (`FROM_US_RX`). Now an OPPFDN lead in the 30-day window
is rehash in the reply writer too (`isInRehash` over `rehashLeadFromContext(context.lp)`, log `[Rehash] … in rehash by LP
lead`; not when `REHASH_ROUTING_MODE=off`), and `enforceRehashCallTiming` (`team-hours.js`) turns any immediate call
promise to a rehash lead into the DAY of the rep's first Rehash Call opening ("on Monday"), or "soon" with none read.
`checkReply` fails it as `call_promised_now_to_rehash_lead` (`ctx.rehash`).
**An issued LP lead never takes another appointment (call-center manual pp. 22–24, 2026-10-09).** `postIssueGate`
(`src/lp-post-issue-rebook.js`, rules in `src/lp-post-issue.js`) runs before both LP SetAppointment calls. Post-issue =
LP's issued flag on any appointment row (or `everissued`), else a `POST_ISSUE_DISPOSITIONS` disposition (CCC and Reset
included: 933/938 and 126/126 of those with history were issued). Live: a newer non-issued lead on the prospect takes the
appointment; a waiting inquiry for the phone is left to inbound-checkout-watch; otherwise a NEW lead goes straight to LP's
`addLead` from LP's own prospect record, never through 8e30ff37 (Mark: limit the leads a person must enter). Promoter
matched exactly once in LP's promoter list (`GetLeadsSourceSubPromoter p`) or sent blank (Mark's ruling), never 830/5574;
Sub-Source from the lead, else `lp_source_catalog` by name, else the issued lead's inbound row. A failed read or send is
retried by `post-issue-rebook-retry`; #contact-center hears after 3 tries or 2 hours, or at once when no Sub-Source or no
name/phone exists. The same date+time already on the issued lead is a re-sync, not a rebook; the parity watchdog never
creates a lead. `LP_POST_ISSUE_NEW_LEAD_MODE` off|shadow|live, default shadow (`lp.post_issue_rebook` events).
**Only the automatic repair needs an open lead (the user, 2026-10-09).** `terminalDispositionDecision` refuses a
post-demo or sold lead (`isDemoDisposition`: Sale, OPPFDN, NoRehash, FDNS, SW, PM) for every caller; with
`requireBookable` (the parity watchdog only) it also refuses any non-bookable lead. A person or GHL booking re-sets a
CXL / no-show lead (`rebook_closed_lead`): refusing that left LP blind to a real rebooked visit.

**Every imported LP lead reaches a Five9 list (2026-10-05).** LP pushes a row to LP_ASAP only at its own
auto-import; a row a person imports later, or one auto-imported overnight, waits for LP's 6 AM load (Sunday's 4
hand-imported rows sat in Five9 on no list; 0 of 14 overnight rows were called at 8 AM). `src/jobs/new-lead-dial-backstop.js`
(rules in `src/new-lead-dial-backstop.js`, every 5 min 24/7, `NEW_LEAD_DIAL_BACKSTOP_MODE` off|shadow|live,
default shadow) pushes every imported, never-called lead from the last 72h to the user's lists (ruling 2026-10-06):
visit today or tomorrow → "Conf - Next Day", 2+ days → "Conf - 2nd Day"; a requested callback is left to the callback
path; otherwise, while the Five9 record is ≤ 14h old (`NEW_LEAD_BACKSTOP_DIAL_ASAP_MAX_AGE_H`), a DIAL ASAP list:
"Reece Chatbot" for the Reece ChatBot source, "Direct Lead Entry" for the rest; older → "Callback Request" (AddToList
keeps Five9's create time, which DIAL ASAP's filter reads). Never LP_ASAP (`executeAddRecordsToList` refuses it) and
never "After DIAL ASAP" (Five9's own connector fills it). **LP's inbound read pages by blocks of ids, so a page can come
back short mid-stream: only an EMPTY page ends it** (a 199-row page 3 hid ~300 leads on 2026-10-05/06). lp_leads in
the window is a second source. Unimported rows are the held-row card's job, never pushed; sold phones, dead or worked
dispositions (read from `lp_leads`, which overrides the inbound row), Five9 attempts on this lead and Five9 DNC numbers
are skipped; a failed Five9 read waits (fail closed); a lead on LP_ASAP gets 30 dial minutes first. Once per row per
list and per phone per day (`lp_appointment_sync_marks`, claimed before the push). Every decision is in
`job_runs.detail.by_reason`. A push posts NOTHING (Mark, 2026-10-07: the system fixed it, nobody acts; the per-pass and
8 AM "put on a Five9 list" cards are gone, the push stays an `agent_actions` row with its `card_line`); live names in
#ops, once, any lead 30+ dial minutes old with no call, push or reason.
`findContactInOtherLists` is NOT used here: it has never worked in production (bare-array criteria) and
`f9_last_list` keeps the last list ever, so a naive fix would block most callbacks.
**Missed paid callers are judged by their whole call history (2026-10-12).** `src/jobs/missed-caller-recovery.js`
(`MISSED_CALLER_RECOVERY_MODE`, default shadow) no longer uses `findContactInOtherLists` either: all 264 would_push rows
read "cross-list check unreadable — failed open". `judgeHistory` reads every Five9 disposition for the number, any
campaign, in and out, 30 days (`buildHistorySql`, ~3s a pass), and skips a service customer (`Service Call`, or a
dispatch/service line), anyone we already spoke to (a disposition outside `NO_CONTACT_DISPOSITIONS`, unknown ones
included, or a 2-minute "No Disposition") and anyone we already called back after their last call. A failed read
fails closed, like DNC. The blank screen pop (number1 only, no LP CustID) is still a ruling for Mark before live.

**An inquiry waiting in LP's inbound queue is watched, not assumed (2026-10-06).** Every lead we send LP is an inquiry
(in1) until somebody checks it out into a lead (lds); ~49% wait for a person, 4–15h overnight. `create_lp_lead` no
longer returns `already_in_lp` for an in1 with no lds (`src/actions/handlers/lp-lead-inbound-only.js`: issued → write the
lds and set the appointment on it; waiting → `pending_lp_checkout`; never addLead). `src/jobs/inbound-checkout-watch.js`
(`INBOUND_CHECKOUT_WATCH_MODE` off|shadow|live, default shadow) mirrors the queue into `lp_inbound_queue` (sql/149, fails
soft until applied), cards #contact-center 08:00–19:45 ET for inquiries waiting past their line (Mark, 2026-10-07; staff
check out at a median 11 min, p90 42): visit today/tomorrow 30 min, visit 2+ days out 60 (`INBOUND_WATCH_APPT_FAR_MIN`),
GHL sender 60, other 60, and #ops past 90 OPEN office minutes (2026-10-12, `officeMinutesBetween`: the clock stops
at 19:45 ET and restarts at 08:00, so neither an overnight row nor one that arrived just before close hits #ops at 8 AM). The 8 AM card lists only rows already past their line. An in1 the held-row
"import this lead" card named is not carded again, and vice versa (`INBOUND_WAIT_AUDIT` / `HELD_IMPORT_AUDIT`). It
finishes the GHL side of issued inquiries. LP's GetInboundLeadInfo `enddate` is
EXCLUSIVE: a range ending today returns none of today's rows (issue #490).
**Booked leads come off the setter lists, onto Confirmation (decision #2669).** `src/jobs/booked-dial-routing.js`
(`BOOKED_DIAL_ROUTING_MODE`, default shadow) runs after each watch pass: visit today/tomorrow → "Conf - Next Day", two
days → "Conf - 2nd Day", later → held. ADD FIRST, REMOVE SECOND: the removal from LP_ASAP / Reece Chatbot / Direct Lead
Entry / After DIAL ASAP is queued only once a Confirmation add for that phone COMPLETED (any rule) or Five9 already has it
there (an unissued inquiry waits). Mark's exceptions (2026-10-06 follow-up): a Cnf or Issue lead (Verif counts as Set) and a visit 3+ days out come off
right away (the 3+ day one is added two days before). A failed add is retried ONCE, then #contact-center is told (once per
visit). A visit that moved from "2nd Day" to "Next Day" comes off "Conf - 2nd Day" once the Next Day add completed. While
`BOOKED_DIAL_ROUTING_MODE=live` (and only then) the new-lead backstop pushes NO booked visit (2026-10-08: both jobs had added the same lead to the same Conf list). The
removal is `five9_delete_record_from_list` with `list_names` and `approval_expires_at` = the visit (the executor skips it
after that). It runs WITHOUT approval by Mark's standing exception to #1057 (2026-10-06: "If we're adding to one list, we
should be able to automatically remove it from the other list"), keyed on rule `BOOKED_DIAL_ROUTING` only — any other
list removal still needs approval. `BOOKED_ROUTING_AUTO_REMOVE=false` is the rollback to approval cards. Every decision is
in `booked_dial_routing_log`.

**The LP note is a 2–3 sentence rep brief (the user, 2026-10-05).** Prospect 462947 reached LP with 1,400
characters: the address three times, "tomorrow" for the visit, a script with a blank ("this is [YOUR NAME]"), internal
terms ("bot exit agentic, P1 Stage 6") and only the customer's half of the chat; the real job ("New addition") sat in
that chat log. `src/services/rep-brief.js` builds the replacement. Sentence 1 is CODE: the visit day and time as LP
receives them (`adate`/`atime`) and the address, or "NO APPOINTMENT. Call to book." Sentences 2–3 are the MODEL
(`fn: 'rep_brief'`), written from both sides of the chat: what they want, and the one thing the rep should know.
`checkRepBrief` refuses a relative day, any date or time, a script, a label, a phone, email or address, internal terms
and a gendered pronoun; one re-write, then fixed sentences (`fallbackBrief`). It replaces only an AI note
(`replaceableNotes`): a person's or a form's note is never touched. `LP_REP_BRIEF_MODE` off|shadow|live, default shadow
(`[LP-PROXY] 🕶️ REP BRIEF SHADOW` logs it after the forward). Live runs in the addlead proxy, capped at
`LP_REP_BRIEF_TIMEOUT_MS` (20s, inside GHL's 60s), and in `create_lp_lead`. Dry run:
`node scripts/render-rep-brief.js <contact id>`. Never add a chat log, an opener or a relative day back to it.

## Consent (2026-09-28)

`contact_consent` / `consent_events` (sql/136–139) are the record of who may be contacted and why not.
Write them only through `record_consent_change` (the action) or `recordConsentChange()`
(`src/consent/consent-store.js`) — the database function does the upsert and the audit row in one
transaction. `CONSENT_MODEL_MODE` is `shadow`: nothing gates a send on these tables yet.

- **`phone` means texts AND automated calls.** Never add an `sms` or `call` channel; the pair splits
  only behind `CONSENT_SPLIT_SMS_CALL` after counsel signs off, and that path is not built.
- **A texted STOP (`sms_carrier_stop`) is never cleared by a person.** A Slack lift restores calls,
  LP and Five9 and leaves SMS/RCS DND and `dnc-sms` in place. `detectCarrierStop` treats an
  unreadable contact as a STOP. A STOP is `suppress:dnc-reply`, consent `sms_carrier_stop` or GHL's
  `permanent` SMS DND — **not** the `dnc-sms` tag alone (2026-09-29): staff add that tag to block
  calls + texts, and the lift must restore texts for them (the user's ruling). Every other lift
  restores calls, texts and email, and records `email/granted` too.
- **Five9 DNC removal has exactly two callers**, both welded: the re-entry lift and
  `five9_remove_numbers_from_dnc_approved` (Slack, `SLACK_DNC_LIFT`). The approved op refuses any
  `approved_by` that is not a Slack user id, which is what keeps GroupMe and auto-escalation
  approvals out. Do not add a carve-out for it in `resolveRequiresApproval`.
- **LP clears DNC with a single-space `newDncStatus`** (LP's API docs: "Passing a blank value will
  remove the existing selection and reset the status"). On 2026-09-29 LP rejected both `N` (the old
  guess) and `''` (an empty form field reads as missing) with "Invalid DNC value". If `' '` is ever
  rejected too, ask LP support — do not try more values on a live record. LP holds ONE internal DNC value
  per prospect (`GetLead` → `intdnc`, e.g. "Do Not Text"): a C then a T leaves only T. So a
  calls + texts opt-out sends **C (Do Not Call) only** (the user's ruling, 2026-09-29) — never add a T
  step after it.
- `POST /slack/dnc-lift/decision` is idempotent on `request_id` through `dnc_lift_requests`
  (sql/140) and refuses (503) without it.
- **The lift result is posted by the server, not by n8n's wait (2026-10-02).** 41 approvals in two
  minutes took 2–2.5 min each and outran n8n's 120s timeout, leaving 40 cards on "⏳ Lifting" with the
  work done. n8n now sends `async: true` + `channel` + `card_blocks`; the route answers 202, runs the
  batch three at a time, and `src/consent/dnc-lift-report.js` updates the card and posts the thread. A
  step still retrying reads "retrying" and gets one follow-up when it settles (the sweep, every 5 min,
  also corrects the request's status). It reports only rows with `report_mode='server'`, so an
  old-flow click is never posted twice.
- **LP's clear is still broken, so the lift card says so (2026-10-02).** `%20` was rejected too on
  2026-10-01. Until `LP_DNC_CLEAR_WORKING=true` (set only after a clear is verified with a GetLead
  read-back), the review payload and the approve response carry `lp_manual_clear_required` and
  `lp_prospect_id`, and n8n tells the approver to clear LP by hand. A clear skipped for want of a
  prospect id counts as NOT cleared (`lpClearOutcome` in `dnc-lift-decision.js`).
- **The lift does not call LP at all until its clear works, and the thread gets ONE reply (2026-10-09).** LP still
  answered "Invalid DNC value" to every clear, and the step's three retries made the report post a second thread reply
  ("*Update:* every step has now finished") on every lift. `buildLiftBatch` now queues `update_lp_dnc_status` only when
  `LP_DNC_CLEAR_WORKING=true`; the thread still prints the manual LP line. A follow-up EDITS the stored reply
  (`batch_result.slack_reply_ts`), never posts a second one, and a repeat async click gets a 202 replay so n8n prints
  nothing. Five9's read-back now fails the step when a number is still on DNC (`assertDncRemoved`); it used to read ✅.
- **A card with no consent history shows the old Five9 block instead (2026-10-02).** `legacy_block`
  (last Five9 DNC result, last call, LP disposition) is built when `consent_events` is empty, every
  lookup best-effort. A Five9-only block is then seeded ONCE as `phone/revoked`, source
  `five9_legacy`. That row is old history, not a fresh opt-out: the re-entry sweep's
  "opted out after arrival" check excludes it, and anything new that reads consent_events for
  recency must too.
- **A tag blocks only its own channel (2026-09-29).** `dnc-sms` / `dnc-voice` → calls + texts
  (`TAG_DNC_SMS_OPTOUT` / `TAG_DNC_VOICE_OPTOUT`), `dnc-email` → email (`TAG_DNC_EMAIL_OPTOUT`), consent
  source `ghl_tag`. Plain `dnc` blocks nothing: rule 241 `TAG_DNC_TO_HARDLOSS` only moves the objection
  state. `TAG_DNC_MANUAL_OPTOUT` made it a full opt-out for 15 minutes and was disabled by the user's
  ruling — do not re-enable it. The sms/voice rules are guarded on `suppress:dnc-reply` /
  `suppress:dnc-voice` so an automatic opt-out is not run twice, and all three on `has_tag` of their
  own tag (read live): a stale GHL webhook snapshot reports a tag "added" right after a lift removed
  it, and on 2026-09-30 that re-blocked a customer with a confirmed appointment.
- **A new lead for a blocked number asks for review on its own (2026-10-01).** The
  `dnc-reentry-sweep` job (`src/jobs/dnc-reentry-sweep.js`, rules in `src/consent/dnc-reentry.js`)
  checks every new LP lead ONCE, whatever the vendor, and queues `request_dnc_lift_review`
  (`DNC_REENTRY_SWEEP`) when the number is blocked. Nobody adds `dnc-lift:request` by hand.
  **"Blocked" includes Five9's DNC list** — in one week 68 of 73 blocked returning leads had no
  DNC tag and no consent row (their block predates the consent model), so a tag/consent-only check
  called them all "not blocked" and no card ever posted. The review handler counts consent and
  Five9 too. **Never ask to lift a fresh opt-out:** a lead whose own disposition is DNC, or that
  saw a consent opt-out or a Five9 "Do Not Call"/"DNC" disposition after it arrived, is settled
  without a card (agents' Five9 dispositions write nothing to our consent tables). LP times are
  Eastern wall clock — compare `arrived_at`, not raw `created_at_lp`. `DNC_REENTRY_SWEEP_MODE`
  off|shadow|live, default live (it only asks). `POST /webhook/ap/dnc-reentry` (n8n I.AP's
  "link" branch) and E.0's `reentry` event still ask too; the endpoint asks, it never lifts.

**GHL webhooks do not retry, and a lost one leaves no trace here (2026-09-28).** Four canvass leads
never reached LP on 2026-09-24: GHL's step logged "Response timed out … 60 seconds", yet Railway's
edge, `intake_journal` and our logs have no record of the calls. A GHL→LP-MCP intake therefore needs a
sweep that looks from the GHL side (the HL mirror) for contacts that should have arrived and did not.
Precedents: `src/jobs/canvass-lead-backstop.js` (re-drives through the webhook's own pipeline),
`src/jobs/chat-lead-intake-sweep.js` and `src/jobs/live-chat-missed-reply-sweep.js` (2026-10-01: a visitor
who types a phone number that already has a contact is MERGED by GHL, and that message's I.LVI webhook
never fires). Keep any I/O before a webhook's response capped — the
`findRecentCanvassMark` pre-check is held to 3s for that reason.

**A linked contact gets its name from LP, fill-empty-only (2026-10-11).** a9eG41qtxCqMEXxbbD2l reached a demo with no
name while LP lead 581424 said Andrew Marcus: the backstop wrote names only on create, and `/n8n/enrich-lead` read them
and never wrote them. `buildIdentityFill` (`src/services/lp-identity-fill.js`) is the one rule: first/last name, email
and the address block are written only where GHL is empty (a phone number or "Guest Visitor …" counts as no name), a
real value is never replaced, couples ("Michelle/Jason") keep the first person, an email another contact holds is
dropped, and the body never carries `tags`. It runs on the backstop link PUT, on enrichment's `ghl_update_body` (top
level), and in job `lp-identity-fill-sweep` (30 min, `LP_IDENTITY_FILL_MODE` off|shadow|live, default live), which
reads the HL mirror for nameless contacts and needs a VERIFIED link (LP id on the contact, or the phone). One-time run:
`scripts/backfill-lp-contact-names.js` or `POST /admin/lp-identity-fill` (dry run default). Most nameless `lp-linked`
contacts have no name in LP either (1,107 of 1,154 on 2026-10-11); that is not a bug here.

**Inbound capture turns only a sales call into an LP lead (2026-10-12).** `INBOUND_CAPTURE_MODE` (default shadow)
labelled 2+ minute callers with no LP lead and never read what the call said: of 128 shadow candidates, 35 had refused
(Not Interested, Cant Do Project, Below Minimum, Kicked) and 43 rang "Main Number" (service and existing customers). The
`not_a_lead` label (`notALeadReason`, `src/inbound-caller-classify.js`) now comes right after `dnc` and before any GHL
read: the disposition must be on `LEAD_DISPOSITIONS` (an ALLOW list: an unknown disposition is not a lead), and Main
Number counts only for an appointment set. The caller's NEWEST call decides for every row of that caller. 50 remain,
40 of them a 2+ minute "Hung Up", which ARE leads (the user, 2026-10-12).
**A captured lead's LP source comes from the NUMBER CALLED (the user, 2026-10-12).** Unfixed, every capture would have
reached LP as the chatbot (830 / 5574): `enrollLpLeadCreation` backfills blank LP Source ID / Pro ID, and 8e30ff37 sends
only those two fields. `src/inbound-capture-source.js` maps each tracking number (Five9 dnis, read from
five9_events_raw by caller and call time, matched within 1s because a JS Date drops Five9's microseconds) to its
Sub-Source; "Main Number" (hundreds of local numbers) is Reece Call In (91). The Promoter is "Integration, GoHighLevel"
(5686) on every lead this system creates from a call. `captureCaller` overwrites the contact's two fields (the number
called wins over an older source), reads them back, and does not enroll if they did not stick. A number not in the
table is `unmapped_number`: listed, never sent. Add a new tracking number to the table; never widen the chatbot backfill.

**Every LP sale gets a P2 card, even when LP's webhook does not arrive (2026-10-03).** A P2 (Client
Lifecycle) card is built only by LP's outbound webhook → GHL I.LP-IN (adds `deal-won`) → C.0-IN (P1 Sale
Recorded + P2 Contract Signed, valued from LP Gross Sale Amount). LP's webhook all but stopped on 2026-09-24,
so 41 sales (~$1.1M) never reached P2 and the GHL Pipeline Value tile fell. `src/p2-sale-backstop.js`
(job `sale-p2-backstop`, every 15 min, `SALE_P2_BACKSTOP_MODE` off|shadow|live, default shadow) checks every
LP job with a contract in the last 45 days. If the contact has no P2 card in ANY status, read live from GHL
after a 30-minute grace:
- a live sale gets `deal-won`, so C.0-IN does the rest;
- a sale that already has `deal-won`, or a do-not-contact sale, gets the card directly through
  a plain create (never `executeMoveOpportunity`: its duplicate recovery PUTs onto whatever card GHL collided with);
- a cancelled or credit-declined sale is created Lost and goes to L.6;
- a sale with no price yet is named once in the 08:00 digest.
- **a repeat customer counts too (2026-10-03):** a card "covers" a job only if it is open, stamped with that LP Job ID,
  or unstamped and made on/after the contract (`p2CoversJob`). A live job whose only cards are an older job's is
  LISTED in the digest (`repeat_customer_one_card_limit`), never written: this GHL account allows one P2 card per contact,
  and on 2026-10-03 the "duplicate" recovery reopened four Won cards. Never `deal-won` either (C.0-IN would pick the
  old card). A no-payment job that a paid job
  replaced (written later, or within 10% in value within 60 days) is listed for review, never added
  (`looksLikeDuplicateOfPaidJob`). A terminal job on a contact that already has a card never gets a second one.

**A sale with no GHL contact gets one (2026-10-04).** 35 in-progress sales (~$900k) had no GHL contact, so the
backstop above skipped them silently. `src/services/lp-sale-contact-backstop.js` (job `sale-contact-backstop`, every
15 min, `SALE_CONTACT_BACKSTOP_MODE` off|shadow|live, default shadow; MCP tool `sale_contact_backstop_run`) finds or
creates the contact for every non-cancelled sale in the window whose lead has none, through `resolveOrCreateContact`,
and links the lead (`ghl_link_source='sale_backstop'`). It is a CUSTOMER contact: source tags + `lp-sale-backstop`,
never `lp-backstop-created` (INTAKE_ROUTE_BACKSTOP_E0 routes those to the new-lead router) or `stage:new-lead`, no
disposition emit, and no email another contact already holds. The P2 card then comes from the backstop above, which
waits 10 minutes on such a contact (`newContactSettling`) and, for a sale older than 90 days, back-dates "Date
Created" and "LP Entry Date" to the LP entry date first (`quietStampNeeded`): GHL's I.AC sets "Date Created" to
today on every new contact, and C.0 Customer Onboarding only exits as "Stale Lead" when both are 90+ days old (user
ruling: the old sales go in without onboarding). `matchToGHL` refuses an email-only match whose contact has a
different phone (`emailMatchConflicts`): a canvasser's placeholder email had put LP lead 474939's sale on another
homeowner's contact.

The on-demand run is the MCP tool `sale_p2_backstop_run` (dry run by default; `only` limits a backfill to some write
kinds, so a wide `since` can fill live jobs without minting Won/Lost cards for sales finished before P2 existed). Do not revive the `deal-won`
half of `checkLeadTriggers`: its filter never matched, and a "fixed" one would onboard every historical
sale.

**Marketing cost is a ledger, not an LP field (Mark + Brad Codman, 2026-10-12; `supabase/migrations/20261012222106_158_marketing_cost_ledger.sql`).** Report 136 and LP cost entry
are retired: nobody types a cost into LP again, and no code reads `mcost_cents` for a cost. The money lives in
`marketing_expenses` (invoice lines, Lead Gurus feed days, commission rules) and is split per month and market in
`marketing_expense_allocations` by GROSS ISSUED LEADS (D1: `ever_issued` by `created_at_lp`, `mkt_issued_counts`); Net /
Working / Gross $ come from report 133 (`mkt_sales_dollars`, D8). The allocator is ONE pure module,
`src/marketing/allocation.js` (direct / proportional / equal / hold, cents reconciled or it throws); the rows are written by
`allocation-io.js` and re-run nightly (`marketing-cost-nightly`, 02:30 ET, current + prior month). The dashboard and
Brad's XLSX (`marketing-cost-report`, formulas never typed values) read `v_market_subsource_cost`.
- **An invoice file never reaches a paid model (D9).** n8n `I.MCIN` POSTs the attachment to
  `/n8n/admin/marketing-invoice-ingest`; `src/marketing/extract-client.js` gets the TEXT for free from reece-speech-api
  `/v1/extract` (pdfplumber + Tesseract) or in-process for CSV/XLSX/body text; only that text goes to
  `mkt_invoice_analysis` (rules first, model second, rules win on total and invoice #, `analysis-schema.js` is strict).
  The text is untrusted: cleaned, screened (`guardrail_decisions` surface `invoice_text`), and nothing in it can run
  anything — the only outputs are ledger rows and a Slack card.
- **Only Mark or Brad decides (D6).** The card in `SLACK_MKT_INVOICE_CHANNEL_ID` carries `mktinv_approve` /
  `mktinv_edit` / `mktinv_reject`; `isMarketingInvoiceAction` in `src/slack-approvals-core.js` catches those clicks AND
  the Edit modal's `view_submission` so they are never relayed to onboarding (which would read them as a member
  approval). Approvers are `MKT_INVOICE_APPROVER_SLACK_IDS` (empty = nobody). Auto-approve only with zero flags and
  ≥ `MKT_AUTO_APPROVE_MIN_PRIOR` (2) prior person approvals of that vendor; a vendor with `eligible_markets='{}'`
  cannot be approved until someone fills them in through Edit.
- **REECE_HOLD money is never spread by code (D4).** Lead Gurus "Unknown" / "Out Of Area" and the daily territory gap
  (09-22: $4,763.59) sit on `REECE_HOLD`; `src/marketing/holds.js` writes a RECOMMENDATION (matched LP lead → branch,
  else zip → service area) and a person applies it. The feed is provisional until the invoice supersedes it
  (`trueUpInvoice`, variance > `MKT_FEED_VARIANCE_PCT` posts a line).
- Mode switches: `MKT_INVOICE_ANALYZER` rules|rules+llm, `MKT_COST_NIGHTLY_ENABLED`. Dry runs: the tests
  (`scripts/test-marketing-*.js`) and `GET /n8n/admin/marketing-expenses/status` (reconciliation = 0 failing rows).

## Alerting

Alert modules are **pure and dependency-free** so they unit-test without importing supabase, GroupMe
or Slack: `agentic-silence-alerts.js`, `executor-queue-alerts.js`, `limiter-health-alerts.js`,
`rule-fail-closed-alerts.js`. Each exports a `shouldAlert*` decision and a `format*` body. The
heartbeat that calls them owns the query, the state and the throttle.

Delivery goes through `reportAlertCondition` in `src/alert-state.js`, which is **edge-triggered** —
one card per incident plus an optional reminder, not one per heartbeat tick. It takes a three-way
`active`:

| `active` | meaning |
|---|---|
| `true` | condition is bad — fire |
| `false` | condition is confirmed good — clear |
| `null` | **could not tell** — touch nothing |

The `null` case is the one people get wrong. A read that failed must neither page nor clear: clearing
on "I could not tell" announces a recovery nobody earned. This is why the `shouldAlert*` helpers
return a `verdict` (`alert` / `healthy` / `insufficient_evidence`) rather than just a boolean — the
boolean cannot distinguish "healthy" from "too quiet to conclude".

**#contact-center gets only what a person must act on, after the system had its chance (Mark, 2026-10-07).** Never
post "we fixed it" or an FYI there; never repeat an item (dedupe through `src/alert-posted.js`); fire a card only once
the self-healing retry or sweep has had its cycle; batch a pass's exceptions into one card; a system-down alert only on
down and on recovery. Hand-off cards (`routeNepqHandoff`) post once per contact per reason per day.

**Ops alerts post only new items, mostly once a morning (Mark, 2026-10-02).** `src/jobs/ops-morning-digest.js`
posts ONE 08:00 ET card to #ops-alerts: P2 Won/Lost (24h), new appt-parity gaps, and the morning checks
(f0-integrity-audit, lead-leak, link-leak, p2-unresolvable), which now run inside it and no longer post their own
card unless they FAIL. The nightly tag sweep (03:00) and the inbound-caller summary (07:15) post nothing either
(2026-10-07): the digest reads their `job_runs` rows and lists a count only when it rose, or the run if it did not finish. "Already posted" lives in ONE store, `audit_posted_items` via `src/alert-posted.js` —
do not build another. Drift posts one card per contact, ever (`permanent`); intake journal waits 60 min; the
uncalled-leads card names only leads not posted in 7 days, and waits for the new-lead dial backstop first (2026-10-07,
`src/uncalled-backstop-hold.js`: a lead it pushed under 30 dial minutes ago, is still waiting on, or already named in
#ops is held; a backstop not live or not running holds nothing); outages post on state change only (`remindMs: 0`).
`ALERT_DIGEST_ENABLED=false` restores the per-alert cards (drift stays once-per-contact). Info-only rule cards
are listed in `src/alert-noise.js`; a new informational card belongs in the digest, not its own post.

**The reply SLA backstop is 3 minutes (2026-10-03).** `src/jobs/reply-sla-watchdog.js` (live) emits
`agentic.reply_unanswered` for a text with no completed reply after `REPLY_SLA_MINUTES` (default 3, was 10), and
rules 371–374 re-analyse, recover, alert. A reply still being written (a send row pending/approved/executing,
younger than the send path's budget) is `in_flight` and is waited for, so a slow reply is never answered twice.
A skipped send is not an answer.

**A job that never throws must still be able to fail.** `runJob` in `src/job-runner.js`
records one row per scheduled pass, and it classifies from the RETURN VALUE, not just from a
thrown error — `runMemoryNightly` and friends catch everything internally and report failure as
`{ ok: false }`. `interrupted` (a deploy killed the pass) is never `failed`, and a job that
could not tell is `unknown`. Roster in `src/job-registry.js`; see `docs/job-runs.md`.

**Every `*_MODE` flag is in `src/mode-registry.js` (Fix 2, 2026-10-12).** 92 flags, about half defaulting to shadow, and
nothing showed which were waiting, since when, or on whose ruling. Each entry gives the default, which values mean
live/shadow/off, the first commit that read it (`since`), the `decider`, where shadow results land (`evidence`: event
types, a table, or a job's `job_runs.detail`; empty means logs only) and the go-live test from a ruling, or
`NEEDS_RULING`. Never invent a go-live test. `registerModes()` (`src/mode-registry-sync.js`) upserts each flag's CURRENT
value into `feature_modes` at boot, and that table's trigger writes `feature_mode_changes` when a value changes. That is
the flip record: a flip is still a Railway variable a person sets. `scripts/test-mode-registry.js` scans `src/` for
`env.X_MODE` / `env?.X_MODE` and fails on a flag with no entry or an entry with no flag. The dashboard's `/modes` page
reads the table, and the 08:00 ops digest adds one "Shadow-mode review" section on Mondays (14+ days in shadow).

**A deploy must never cut a customer reply off (2026-10-01, Dan H.).** Every Railway deploy SIGTERMs
the old container, and `src/graceful-shutdown.js` waits only for what it can see. The reply fast path starts
`executeActionById` without awaiting it, so the drain logged "Drained cleanly after 0ms" twice in 13 minutes
with Dan's reply half-written. Every action run now goes through `trackAction` (wrapped once, in
`executeSingleAction`), pending reply buffers fire on shutdown (`flushReplyBuffersNow`), and the reaper
retries a stuck `send_message` after its own watchdog + 60s (`reaperAgeMsFor`), not 10 minutes. New
fire-and-forget work that matters to a customer goes through `trackBackground`/`trackAction` too.

**Only the live-chat fast lane answers in the website chat (Mark, 2026-10-01).** `decideReplyChannel`
never returns `livechat` for the normal pipeline: a chat-widget origin goes out by SMS, or (no phone) is
not sent and #ops-alerts is told. GHL's "Chat Widget" (type 5, `TYPE_WEBCHAT`) reads as livechat there.

**A live-chat cancel request is a fixed flow in code, worded by the model (Mark, 2026-10-02; Part 8).**
Code makes every decision; since Part 8 the model words each reply from the flow's line (the reference and
backup), and each step is read back by meaning (`ID_ASK_RX`, `OFFER_RX`, `SLOTS_RX`, `DONE_RX`, `MOVED_RX`, …), so
the model's version must keep its step's phrase (`CANCEL_MARKERS`, checked like every Part 7 reference). A reply
after a cancel or a move always goes out (`mustDeliver`), the timeout backup included.
`src/live-chat/cancel-flow.js`: ask for the name and phone the appointment is under, match them (phone
AND name — never phone alone), offer another day once, then cancel in GHL through `cancel_appointment`
and say "Done" only after GHL confirms. "Yes, another day" offers two real open slots from the
appointment's own calendar (contact's zone) and MOVES THE SAME GHL appointment to the pick
(`moveAppointmentInPlace`, one PUT — never a new object, Mark 2026-10-02); "You're now set for" only
after GHL confirms. The row carries `lp_sync: 'dispatch'`, and `/webhook/ghl/set-lp-appointment` holds
the automatic LP sync for 30 minutes on it (`src/services/lp-sync-hold.js`, fails open): A.WE's LP
Appointment Sync would otherwise re-set LP, and enrol lead creation (a NEW LP lead) when it cannot
resolve the lead. Same-calendar reschedules from the SMS bot move in place too. Every outcome posts to
**#dispatch** (`SLACK_CHANNEL_DISPATCH`, default C0C19GRS8FJ) through `postToSlack`, and a person changes
LP from that card; a failed post is an #ops-alerts line. Anything
unmatched goes to the team; the bot never
says "no appointment on file" to a guest it never identified. A "no" (`isDecline`, or the model's
`recommended_action: suppress`) gets a close with no pitch, and a reply overtaken by a newer message
from the same visitor is not sent (`superseded_by_newer_message`).

**A live-chat reschedule never falls into a cancel or into discovery (handoff PR 5, 2026-10-12, LEAD_STAGE_MODE=live).**
The simulator's `reschedule_not_moved`: an unrelated reply got "I've passed your cancellation", and "the first one" after
the model's own "Which works better?" fell out of the flow into new-lead discovery. Live (`planCancelTurn({ stageLive })`):
an unclear answer to the offer gets ONE `CLARIFY_LINE` (move or cancel?), a second unclear one goes to a person to set
the time (`RESCHEDULE_HANDOFF_LINE`, a RESCHEDULE card, nothing cancelled); "no, a different day" is a move
(`classifyOfferAnswer`); any offer of ours naming a time is the slot offer (`SLOTS_LIVE_RX`), an unclear pick gets the
same two times once more, and the RESCHEDULED card says any earlier cancel request is withdrawn. The stage records
`reschedule:offered` / `reschedule:moved` (`rescheduleStepFor`) and returns to booked.

**SMS speed and format (handoff PR 6, 2026-10-12, active).** SMS turns took 11-43s (live chat 7-13s), driven by
redrafts. One redraft at most, and none once the turn is past `SMS_REDRAFT_BUDGET_MS` (15s) from the first attempt
(`mayRedraft`): the guarded first draft ships. A guard's re-write no longer waits the 1.5s transient-error backoff. Over
320 characters after the redraft (or in length shadow), whole middle sentences are dropped (`trimSmsToCap`), never a
cut sentence. `src/agentic/sms-format.js`: a fragment opener goes, a stale "our call time passed" nobody raised goes
(unless the call was in the last 24h), the sign-off is exactly once at the end on the reply that signs the thread
(`normalizeSignature`), a reply nearly identical to our last one is re-written once, and no promised call is recorded
after an opt-out or a close (`shouldRecordPromise`). Live chat's Spanish hand-off confirms a number on file
(`SPANISH_CONFIRM_LINE`) instead of asking for one.

**Both bots sound like a person: rules in the prompt AND a pass after it (2026-10-02).** The SMS prompt
banned em dashes for months and they shipped anyway, with "Got it. Great question." openers and "Just to
understand… —" lead-ins. `HUMAN_VOICE_RULES` (`src/prompts/response-generator/banned.js`) tells the
model; `humanizeReply` (`src/agentic/human-voice.js`) cleans what slips through, in the SMS generator
and the live-chat guards. It only deletes or swaps punctuation and stock phrases and keeps a "— Name"
sign-off. Look for `[HumanVoice]` log lines. **No em dash survives, a quoted LOCKED line included (the
user, 2026-10-06).** The old exception kept any dash found in the prompt, so an old KB price script
("Every home is different — …") shipped with its dashes and failed the gate. The locked lines (belief
stack, category truth, the AI disclosure) lost their dashes at the source
(`sql/seeds/2026-10-06_no_dashes_locked_lines.sql`); never add a dash back to a locked line or a fixed line.
It runs first AND once more as the last pass before a send (`final_pass`): a sentence a later guard drops
can leave two openers side by side ("Got it. That makes sense.", bot gate 2026-10-06).

**NEPQ is enforced in code, not only in the prompt (Mark, 2026-10-02).** `src/agentic/nepq-planner.js`
plans ONE move per turn for both bots (`planNepqTurn`): a person takes over on a complaint, a price asked
again after the price play, two no's, or a repeated objection (`src/agentic/nepq-handoff.js`: `callback:requested`
+ `nepq:handoff:<reason>`, a rep note, an event, and a card in **#contact-center** (`SLACK_CHANNEL_SERVICE`), plus
**#dispatch** for a complaint or an unbookable pick, via `postToSlack`; a failed post is an #ops-alerts line); the objection plays, the
think-it-over Calendar Commitment (two REAL slots, exempt from the booking-ask cap), "what day works best",
the Reveal and the confirm line ("You're all set, [name]. Someone from our team will give you a call to confirm
the details. You're on the calendar for [day] at [time]." — the user, 2026-10-06; the AI words it, keeping its
facts, never asked to send it verbatim (the user's ruling, 2026-10-06, after AI OS batch 1); said only when the booking
landed in that turn, never a rep name, never "see you then"; the call is the phone room's confirmation, so the
line is never a Five9 Callback Request (`NOT_A_CALLBACK_RX`) nor dropped as an offer (`isBookingConfirmCall`), and
`BOOKED_LINE_RX` reads both the old "all set for" and the new "on the calendar for" back as booked) are Mark's wording — since Part 7 a reference the model rewrites for the lead (meaning kept, see below). A vague live-chat opener ("hi", "I need new windows") gets the Status Frame
once (`LINES.status_frame`), and a variant never repeats a closing question already asked (`pickFresh`). Discovery is short (2 questions
in live chat, 3 on SMS, then the bridge). `renderPlanBlock` is the LAST prompt section and `enforceNepqPlan`
strips money/financing figures (the customer's own estimate excepted), fake urgency, unallowed booking asks,
re-asks for a name/phone/email/zip we have, and extra questions. `NEPQ_BACKBONE_MODE` off|shadow|live
(default off; shadow records `nepq_plan` / `would_send` only). Live chat books a picked slot through an
awaited `book_appointment` row and confirms only on `appointment_booked`; GHL still refusing is the one case
handed to a person.

**Earn the ask (Mark, 2026-10-03).** The bridge to the free visit needs the problem in the lead's own words AND an
answer to one "why it matters / what if you wait" question, or the lead volunteering it ("getting worse", "the bills",
"before the next storm") — `discoveryEarned` in `nepq-planner.js`. "What's got you looking?" and "how long?" ask for the
problem, not its weight. Not earned at the old cap (2 chat / 3 SMS): keep discovering (`probe_for` problem / why it
matters, or the consequence question); two vague answers or `cap + 2` questions bridge anyway. The shortcuts are
unchanged (Mark: "keep how we had"): quote/price (one question, then times), a schedule or come-out ask, a typed day
and time, the objection plays. With no plan (planner error, coverage turn) a booking ask goes unless the thread already
earned it (`bookingOpenInThread`). A probe or consequence turn always ends on a question: when the draft (or a guard)
lost it, `enforceNepqPlan` appends a fresh one (`discoveryQuestion`, logged `discovery_question_added`), unless the reply
carries a link, a confirmation or an allowed booking ask ("Oh my wife filled out some form" got "That makes sense.", 2026-10-03).

**A promised call is filed for real; no call the lead did not ask for (Mark, 2026-10-03).** "When someone needs a
callback, our system should be pushing it to the Five9 callback list, along with a notification in the contact center
Slack group." `fileBotCallback` (`src/agentic/bot-callback.js`, production deps `src/services/bot-callback-io.js`) runs an
`lp_callback_requeue` row (rule `BOT_CALLBACK`: its dedup, LP-lead creation and the Five9 Callback Request push) AND the
NEPQ hand-off card in #contact-center, which names the Five9 result; once per contact per day (`agentic.bot_callback`).
Both bots file on the planner's `callback_request` (`CALLBACK_RX`, now also "can someone call me" / "I'd rather talk on the
phone", or a yes to our own call offer, `CALL_OFFER_RX`) and on any sent reply that promises we will call
(`promisedCallback` in `team-hours.js`, logged `call_promise_backed`). Live chat with no number asks for it and files on
the turn it arrives (`callback_phone_arrived`). The other side: `dropUnaskedCallOffer` strips a call offer unless the lead
asked for a call or turned the visit down (`leadWantsCall`), with or without a plan, and the plan block says so
(`NEPQ_NO_CALL_OFFER`). A coverage turn is planned too unless its reply is the whole script (`coverageOwnsReply`: the zip
ask, the out-of-area close), and more detail right after the bridge gets the visit question once more (`bridge_followup`),
not a bare `answer` (the shutters thread and the drafty chat, 2026-10-03).
**A promised call is an owned task, and never promised twice (2026-10-07).** McKoy (rRPO34Ooq0QmtSfXyqSw) was told
"I'll have Brian call you" on 10-01 and again on 10-02; nobody called; "Stop text" on 10-04. `promisedCallback` saw
neither (a "?" at the end, a name instead of "we"), so `readCallPromise` (`src/agentic/promised-callbacks.js`) reads
both. Every sent reply that promises a call (both bots, never a service hand-off) is a `promised_callbacks` row (sql/150,
one open per contact), due the next business day at 12:00 ET. `src/jobs/promised-callback-sweep.js` (15 min, team hours)
marks it KEPT on a Five9 call to the phone (`five9_events_raw`, the only source for a call) or a rep's GHL text (an
outbound message after the promise that no workflow sent and that is not ours by id OR by text, `isOurText`: GHL marks
the bot's sends `source: app` too, and a bot email can reach GHL under another id, 2026-10-09), or
EXPIRED past due: one #contact-center card and `needs-rep-review`, never a text to the lead. While a row is open, a reply
that promises again becomes "{Rep} still owes you that call. I've flagged it again." (the handoff's line, pending Mark's
approval; "Our team" when no name) and the re-flag posts once a day. A promise needs a doer on our side next to "will"
(2026-10-09): "We'll leave it there, reach out whenever…" is an invitation, not a promise. The simulator never records
one (`sim-` contacts are refused and the simulator swaps the deps). `PROMISED_CALLBACK_MODE` off|shadow|live, default
shadow (rows written, no Slack, no tag, reply unchanged).

**Only SALES callbacks go to Five9 + #contact-center (Mark, 2026-10-03).** "Anything related to service should let the lead
know a team member will reach out and send to the Slack service channel." `isServiceCallback` (the lead's words are about an
install, an order, a repair or a warranty, or a known customer, `isCustomerP2`, asks without naming new work) turns a call
request into the `service` hand-off: the line says "a team member will reach out" (`LINES.handoff.service_callback`), the tag
is only `nepq:handoff:service` (no hdl:* tag: `hdl:callback-service` fires I.HDL-2's own text and call bridge), and the card
goes to the contact's market `#service-<market>` channel
(`serviceChannelsFor` → `resolveSlackChannels('service')`, falling back to #contact-center). Never Five9: `fileBotCallback`
with `kind: 'service'` skips the requeue. Both bots' hand-offs use one production deps object, `nepqHandoffDeps`. The
classifier's CALLBACK (most texted "can someone call me?") files the same way: sales → Five9 + #contact-center,
service → #service.
**No GHL instant ring; Five9 makes every bot callback (Mark, 2026-10-03).** "The GHL instant call center ring should not
happen… the number always shows as a GHL number and then it forwards to our dialer." `hdl:callback-sales` started I.HDL-1 →
B.HC-L's GHL call bridge and `hdl:callback-service` I.HDL-2's; no bot path adds either any more (only the trace tag
`callback:requested`, `CALLBACK_MARKER_TAG`), and `scripts/test-part14-no-ghl-ring.js` fails if one does. A classified call
request is answered by the bot (`handoffReplyPolicy`: only STOP / WRONG_NUMBER are silent; the customer-status probe is no
longer sent), the planner gets `callbackRequested`, and after the send every hand-off a person follows up on files to
Five9's call-now Callback Request list under its own reason (`callbackDecision` → `fileBotCallback`, card per reason per
day); the decision-maker hand-off keeps its own card (`card: false`); service goes to #service only.
**On the Five9 list is not a call (review of Part 14, 2026-10-03).** Of 18 callback pushes in 30 days, 6 got a Callback
Request call (3 within a minute) and 12 never did: 4 were on Five9's DNC list (Five9 takes the record and never dials it,
silently) and the campaign is PREVIEW mode with a 7-hour gap filter after any earlier call. So:
- `pushCallbackToFive9` checks Five9's DNC list first (`checkCallbackDnc`, fails open) and, on a hit, pushes nothing and
  queues `request_dnc_lift_review` (trigger `callback_request`): a lift is a person's call, never ours. The card says so.
- the verify sweep (`src/jobs/lp-requeue-verify.js`) holds a push with a `number1` open until `five9.disposition_set`
  shows a call to that number, and 15 min into the 8–8 ET dial window with none posts **⏰ PROMISED CALL NOT MADE YET**
  to #contact-center (`src/five9/callback-dial-check.js`, naming an earlier call that explains the 7-hour wait).
  `LP_REQUEUE_DIAL_CHECK=false` restores "pushed = done".
- **a repeat request is re-armed, and every push is stamped (2026-10-09).** A second push for a number already on
  "Callback Request" was an in-place update (UPDATE_FIRST): never call-now, and profile V2's 48h rule reads the
  ORIGINAL create time (David Strehlow, list 63 → 63). `pushCallbackToFive9` now runs `rearmCallbackEntry`
  (`src/five9/callback-rearm.js`) first: an unarmed `five9_delete_record_from_list` (rule `LP_CALLBACK_REARM_FIVE9`,
  the callback list ONLY, `isCallbackRearmDelete`), run inline and awaited; one that did not finish is cancelled
  before the add is queued. After the add, `checkCallbackRearm` (in the Five9 write handler) posts
  "PROMISED CALL AT RISK" to #contact-center at once when the list did not grow. Every record carries
  `callback_requested_at` (UTC, `yyyy-MM-dd HH:mm:ss.SSS`), which rule 3 moves onto once the pushes are verified.
- two no's and a canvasser complaint are reviewed, never dialed (`NO_DIAL_REASONS` in `bot-callback.js`): the two-no's
  line promises no contact, and "stop knocking on my door" (`isKnockComplaint`) gets the do-not-knock flow: the address,
  a name if none, then a **🚪 DO NOT KNOCK** card to the market's #canvass channel and the rollup. No sales call.
- **"Stop knocking" is not a text opt-out (Mark, 2026-10-03).** `isDNCSignal` read any "stop" as one, so "Please stop
  knocking on my door" filed a DNC event on SMS and silenced the live chat. A door complaint that names no texts, calls,
  email or contact (`isKnockNotOptOut`, `src/agentic/do-not-knock.js`) now passes `isDNCSignal`, and the classifier's STOP
  on it is cleared (`classificationAfterKnock`). A bare STOP or "stop texting me" still opts out. Mid-flow, the address
  sent to our do-not-knock ask was classified STOP from the thread and got silence: when our last message asked for the
  do-not-knock details, a reply is an opt-out only if it says so itself (`lastOutbound`).
  The flow reads its own steps by meaning (`isDnkAddressAsk`, `DNK_NAME_ASK_RX`, `isDnkClose`): the model's name ask
  ("added to our do-not-knock list. What name should I put with that address?") once read as the address ask on chat
  (the name asked twice) and as the close on SMS (back to discovery).
- A model reply may not turn a reference's "a team member will reach out" into a promised call
  (`checkAgainstReference` → `promises_a_call`): the SMS service hand-off said "we'll have someone call you … shortly" at night.

**Book in the conversation, unconfirmed, on the right calendar (Mark, 2026-10-02).** Every bot booking is
status `new` (the handler forces it). **Ask about decision makers ONCE, then book** (supersedes 2026-09-18):
the text bot booked 12 visits 08-03..09-07 and none after the 09-18 "all decision makers attend" block, and
a lead who asked for "tomorrow" three times gave up. `decision_maker_unresolved` is no longer reported; only
"my wife can't make that time" moves the time. **Every booking carries the visit address** (`payload.address` →
the GHL appointment's `address`): an address the visitor did not type in this chat (a merged or older contact's)
is read back once ("Is the visit at 12 Main St, Ocala?", `addressConfirmState`), a "no" asks for it, and a spouse
named in THIS chat is asked about once whatever an old record says (`mentionedPartner` / `dmAnswerFromThread`), the
answer riding on the booking as `decision_makers_present`. A visit goes on `inHomeCalendarFor(tags)`: Measurement Verification for a
calculator lead (`active-entry:estimate-calculator` / `active-entry:calculator`), Window Estimate for everyone
else; with NEPQ live the SMS bot books a visit too, and the 15-minute call (PPR) is only the backup when the lead
asks for a call or turns the visit down (`prefersCall`). A yes to the bridge, even "yeah, how long does it take?",
or "can you set up a time?" gets two real times. A pick is HELD ("Great, I'm holding [day] at [time] for you.",
read back by `heldSlot` in `src/agentic/booking-collect.js`) while the in-home gate's missing items are asked one
per message (name, phone on chat, street address with zip, "will anyone else be part of the decision?"); the
answer is passed as `qualifying_data.decision_makers_present`, and a spouse who cannot make it gets two other
times. **Visits start at 10 AM, 2 PM or 6 PM only (Mark, 2026-10-03)**: the GHL calendars also show 6:30 and 7 PM, so every
in-home calendar read (Window Estimate, Measurement Verification, Home Protection Assessment) keeps only those start
times, on the hour, in the office zone (`allowedStartHours` / `IN_HOME_START_HOURS` in `calendar-availability.js`,
applied in `parseSlots`). Call slots (PPR) floor at 30 minutes, only inside team hours, two times an hour apart the same day
(`selectOfferableSlots({ call: true })`): a call back can happen any time the team is in.
**A visit booked after hours starts at 2 PM on the next open day (the user, 2026-10-06).** LP lead 581084 booked
Sunday 7:36 PM for Monday; LP already had his web row, so the visit waited on a person to import it (9:58 AM) and no
Conf list could call him first. While the team is closed, `parseSlots` drops in-home slots on the next open day before
`AFTER_HOURS_VISIT_EARLIEST_HOUR` (default 14, 0 = off; `visitTooEarlyAfterHours` in `team-hours.js`). Calls (PPR) and
later days are untouched. The lead always goes to LP first; Five9 Conf lists are filled from LP by the new-lead dial backstop.

**No line twice, one reply per burst (Mark, 2026-10-02).** Lines that recur in a thread come in variants
(`bridgeLine`, `LINES.offer_slots(slots, n)`, `ALT_LINES`); `pickFresh` never picks one whose opening words were
already sent, and `enforceNepqPlan` drops a sentence already sent word for word. Every offer variant keeps
"I have … or …?" because `SLOT_OFFER_RX`, `offeredSlots` and `heldSlot` read it. Rapid-fire messages get ONE
reply: live chat waits `LIVE_CHAT_QUIET_MS` (default 3000) after each message (after the action row, so the
message stays in `recentTurns`) and the newest answers all; SMS drops a draft right before sending when
`system_events` holds a newer real `ghl.reply_received` past the batch's last one (`src/agentic/burst-yield.js`;
never for a `trivial` event, a bare "ok"/"thanks", or a retry of a batch message). Both log
`superseded_by_newer_message`.

**Post-merge fixes (2026-10-02, Mark's 4:16 PM chat and the simulator).** The chat's calendar read is
started at the top of the turn and cached for a minute (`cachedFreeSlots`, `src/live-chat/index.js`):
twice it timed out under the 2.5s cap, so a "Yes" to the bridge got a name/phone ask and then the bridge
again. Once the bridge was asked, a no-times fallback asks the DAY (`nextStepLine`, `LINES.ask_day`),
never "Would that help?" twice. Collect reads name/phone/address from the WHOLE chat thread, and a bare
reply to our "first name?" is the name (`nameFromReply`); a guest was asked for it five times. A phone
with too few or too many digits, or an email that cannot be right, gets ONE friendly re-check
(`src/agentic/contact-check.js`), then the next answer is taken as it is. On SMS the hold line and the
booking time come from the real slot the lead picked (`offeredSlots` / `pickSlot`), never the model's
words, a spouse who cannot make the held time gets two other times, and the calendar is read whenever
the bridge, an offer or a hold is in the last four messages.

The simulator run (2026-10-02) added: `src/agentic/booking-claim.js` rewrites any
"you're all set / booked / on the schedule" a model reply makes without a booking (live chat always; SMS
when NEPQ is live), `restoreQuestionMark` puts back a "?" the model wrote as "." (every one-question check
counts "?"), and a day + time the lead types with no offer on the table gets two real times near it.
**A quote or price ask (Mark, 2026-10-02):** first one short line and the NEPQ connection question, no times
(`LINES.quote_first`); asked again, "every home is different" + two real times; a third time a person; "you just said that" ends the
questions with the times. Live chat often gets NO conversation id (GHL's I.LVI sends none and a new chat is
not searchable yet: 44 of 68 turns in two days), so the thread falls back to our own `agent_actions` rows
(`recentTurns`, last 6h); never assume `conversation_recent` came from GHL.

**Part 6: the text bot books, AI writes and code decides, one ask per message (Mark, 2026-10-02).**
- **Booking turns:** `smsBookingTurn` (`src/agentic/sms-booking-turn.js`) works out the FACTS of an SMS booking turn: the real slot (a pick against our offer, or the held time), the ONE next ask (name → phone → street address with zip → a read-back of an address on file → decision maker), or "book now". The facts go into the plan block (`FACTS_TEXT` in `nepq-backbone.js`). The model writes the reply. `enforceBookingFacts` then checks it: the right time and no other, the ask in the plan's exact words at the end, and the hold sentence naming the slot as offered (`heldSlot` reads it back). The companion `book_appointment` always comes from the facts. A draft that fails ships the deterministic `fallback`. Look for `[NEPQ] … SMS booking <kind>: AI-written | fixed line (…)`. Fixed moves (hand-offs, objection plays, offers) still skip the model.
- **One ask per message, both bots:** `enforceOneAsk` (`src/agentic/one-ask.js`), run in `enforceNepqPlan` and on every live-chat draft. A statement that asks counts ("I'll need your first name and a phone number"). The order is day/time → name → phone → address → decision maker → email, and a day comes before any detail. Filler in the middle goes. Approved lines are never trimmed (`protect`). The log is `multi_ask_trimmed`. `contactAskLine` asks for the name alone when both are missing.
- **Day preference = filter, not a pick:** `src/agentic/day-preference.js`. "Usually Wednesdays", "weekends", "mornings" and "after 5" get two real matching openings (the next matching day first). With none in 14 days, the bot says so and offers the nearest two. Slot reads take 120 openings (`maxSlots`), not GHL's 12 (about four days).
- **No false scheduling claims:** "blocked / reserved / held for you" is a claim too (`HOLD_PATTERNS`). It stands only when code held the slot this turn (`held`). Otherwise it is rewritten on the first draft to the real times or the day ask. The log is `false_schedule_claim_fixed`.
- **Fewer passes:** the send handler makes ONE `prepared` object per action (`preparedMemo` in `response-generator.js`). Every attempt and the quality regeneration reuse the context, classification, KB pack, calendar, appointments, identity and edits, so a re-write is one model call. The quality regeneration re-reads context, appointments and identity, because the conversation moved on. Guards with a deterministic fix apply it to the FIRST draft: booking claim, repetition, concession pivot, undelivered promise, estimate promise, service area, carrier-risk sentence, discipline, an immediate-call promise (`softenCallTiming`) and a timeline promise. Two or more fixes on one draft get ONE writer-only re-write (`decidePatchBudget`).
- **Claim before analyse:** a `pending_analysis` event claims its message (`routePendingReply` in `decision-engine.js`) and is not re-analysed when the buffer or the poller already did. A failed analysis releases the claim (`claim_released_on_failure`).
- **Slot re-check before booking:** the picked time is read again from GHL right before `book_appointment` (`src/agentic/slot-recheck.js`: no notice floor, no count cap). If it was taken: no booking, and the reply offers the two nearest open times (`slot_taken_before_book`). If the read cannot tell, the booking goes ahead.
- **Burst wait:** the SMS reply buffer waits 15s (`REPLY_DEBOUNCE_MS`), not 35s.
- **Replay polish (2026-10-03, after #1149):** a question behind a lead-in ("Just so I know …, what was on her mind.") gets its "?" back (`asksInLaterClause` in `human-voice.js`), and the coverage sentence drops the draft's own bare "No problem." so it is never said twice (`guardCoverageDraft`).
- **A yield needs a real boundary (2026-10-03, Mark: "the bot needs to always respond").** "Well we have hurricane shutters now." got no reply: `findNewerInbound` read a null `last_inbound_event_id` as `Number(null) === 0` and gave the reply away to the lead's OLDER "Huh?". The boundary is now only a positive id or a real timestamp (falling back to `inbound_event_id`), a reply never yields to its own message or anything before it, and every analysis path carries the boundary (`inboundFromReplyEvent`: `routePendingReply`, the pending-replies poller, `reanalyze_reply`). With no boundary, the reply is sent.

**Part 7: no static messages; every reply is AI-written with the whole lead in view (Mark, 2026-10-02).**
Mark: "I don't think we need any static messages sent by the bot. Each message should be custom."
- **Fixed lines are references and backups, never the first choice.** The planner still decides the move. Its line (`LINES`, `bridgeLine`, the live chat's hold, collect, confirm and hand-off lines, the contact re-check) goes into the plan block as a REFERENCE (`renderPlanBlock`), and the model writes its own version for that lead.
- **Code checks the model's version against the reference** (`checkAgainstReference` in `nepq-planner.js`; `enforceBookingFacts` for booking turns). It checks:
  - the real times, written exactly as offered
  - no other clock time
  - the closing question, or no question
  - the promise of a person
  - the phrases the next turn reads back (`MARKERS`: status frame, Reveal, day ask, "every home is different", "the next step", the re-check, spouse, decide, chase)
- **Failing the check:** one re-write (SMS: thrown with `referenceRetryNote` / `bookingFactsNote`; live chat: the regen inside `redraftFits`). If that also fails, the reference ships (`backup_line`, `nepq_backup_line`).
- **No more skipping the model.** The SMS `nepqDirect` path is gone. Live chat's `runNepqFixedMove` still decides and books, then returns `{ reply, facts | slots }` and the lane goes on to the model.
- **A live chat that times out sends the move's backup line, not the holding line** (`fallback({ backupReply })`).
- **Wording:** Mark's wordings keep their MEANING, not their exact words.
- **Still fixed, as backups only:** the generation-failure fallback (`buildAiFallback`, `LIVE_CHAT_FALLBACK_MESSAGE` when nothing was decided), the booking hold/prerequisite lines after a failed inline booking, the slot-taken line and the out-of-area exit. Part 8 made the cancel flow and the Spanish hand-off model-written too: the Spanish reply must be Spanish and say our team will reach out (`SPANISH_REPLY_MARKER`), and "after our hand-off" is read by `SPANISH_TEAM_RX`. A plan may carry its own read-back phrases (`reference_markers`) and allow one two-item ask (`allow_multi_ask`, the cancel identity ask only).
- **Replay fixes (2026-10-02, after #1139 went live):**
  - A real time counts however it is written: "Sun, Oct 4 at 10:00 AM" or "Sunday at 10 AM" (`slotMentionIndex` in `cancel-flow.js`, used by `offeredSlots` and the reference check). Before this, an exact-label check failed the model's natural wording and cost a 15–35s SMS re-write.
  - A typed time that is one of our two real openings is the pick, whatever we asked last ("Fine lets book for 2 PM"). "After 2" or "around 2" is a preference, not a pick.
  - Once times are offered, the bot never returns to the bridge, even past the discovery cap.
  - With NEPQ live, the SMS calendar is read every turn. The prompt shows the times only when the plan allows a booking ask (`slotsForPlannerOnly`).
  - The live chat resolves a pick against every opening (`slots.all`), not just the next two.
- **Replay fixes (2026-10-03, after #1140 went live):**
  - `slotMentionIndex` reads every clock time with the day it belongs to (`clockMentions`): "6 or 7 PM tomorrow", "tomorrow at 6 or 7", "6 PM tomorrow or 10 AM on Sunday".
  - A typed time that is none of the offered times gets the real openings nearest it, never a pick. With 2 PM open on other days the line is "For 2 PM, I have …". With no 2 PM at all it is "2 PM isn't open, but I have …". A typed day AND time that is open ("Sunday at 2 PM") is the pick. Both need the whole calendar (`allSlots`).
  - A short message that is only a day ("Usually on Wednesdays") gets two real times that day, whatever we asked last.
  - A detail sent instead of a pick goes back to the times. After three offers with no pick, the bot asks the day.
  - A typed time is checked against the times OFFERED in the thread (`offeredInThread`), never against the two the live chat loads near it. A re-ask names the same two times we just offered.
  - When the plan asks for a time, the repeat-ask guard treats the time as open (`planAsksForTime`). Before this, a typed "2 PM" that was not open closed the time question, and three planned re-asks were refused and never sent.
  - The cancel flow answers only inside a flow that a cancel request started (`inFlow` in `planCancelTurn`). Before this, a booking offer ending "Which one works better?" read as the flow's slot offer, and "She should be able to make it" posted a reschedule card to #dispatch.
  - A draft that only acknowledges ("Good to hear she can make it.") keeps its words, and the reference's ask goes after it (`appendReferenceAsk`, logged `reference_ask_appended`). This happens only when the draft asks nothing and names no clock time, and the result must pass the check. Before this, each such SMS turn cost a 10–35s re-write that often missed too.
  - An SMS visit keeps its in-home gate on every booking turn, whatever that turn's KB pack says (`nepqVisitFirst`). A gate that could not be read asks for the address (`smsGateMissing`). Before this, a bare "9543792151" built no booking context, so the gate was skipped and the visit booked with no address.
  - Our own "You're all set for…" counts as booked until a later cancel (`bookedInThread`). Before this, the appointment had not reached the read yet, and the next texts offered times again.
  - A GHL free-slots read that fails for a passing reason (timeout, 429, 5xx) uses the last good read of the same calendar from the last 10 minutes, or else retries once (`fetchFreeSlots`). The slot re-check before booking protects against a stale list. If there are still no times, a stated day ("Wednesdays") gets "What time of day is best for you?", never the bridge. The answer is combined with the day on the next turn. Before this, one 10s GHL timeout on "Usually on Wednesdays" sent the bridge and lost the booking.
  - An open offer makes the live chat load the calendar before it plans (`offer_slots_pending` → `wantsSlots`). Before this, "Mark" after the 2 PM offer got a vague answer with no times, because the chat's first planning pass has no calendar.
  - The SMS booking turn reads a name typed in the thread (`nameFromThread`, a bare reply to our "first name?"), as the live chat's collect does. Before this, the gate still read the name as missing and asked "Who should I put the visit under?" instead of booking.
  - A typed clock time with no offer on the table also makes the live chat load the calendar (`offer_slots_pending`). Our "street address … zip?" ask is not a coverage zip ask (`lastOutboundAskedZip`). The decision-maker ask is read back by meaning (`DM_ASK_RX` in `dmAnswerFromThread`), because the model words it. Before this, "book for 2 PM" got "what day?"; the address reply ran as a coverage turn and skipped the booking plan; and "Just me" to an AI-worded ask counted as no answer, so the visit never booked.
  - Hurricane and storm language is allowed (Mark, 2026-10-03: core to what we sell). Only the false urgency claims in `CLAIMS_RX` ("peak of hurricane season", "storm season has us slammed") are stripped.
  - `enforceCallTiming` rewrites only a call WE promise (`FROM_US_RX`): "What made you reach out today?" had become "…reach out tomorrow at 9 AM ET?".
  - A failed reference check logs the draft (`| draft="…"`), so the next slow turn can be read from the logs.
- **Lead knowledge:**
  - The SMS context reads 30 messages across every channel (was 10) and shows 30 turns.
  - `HISTORY WITH REECE` (`lpRelationship`) says when the lead is a past or returning customer.
  - The live chat starts the full lead context and the appointments when the message lands, so the quiet wait hides the read. Defaults: `LIVE_CHAT_CONTEXT_CAP_MS` 5000 and `LIVE_CHAT_HARD_TIMEOUT_MS` 15000 (Mark: 5–8s replies are fine).
  - The live chat passes `upcomingAppointments` to the prompt.
  - `normalizeThread` labels each turn by its own channel, because texts and emails sit in the same GHL conversation.

**A live-chat turn answers exactly once (2026-10-02, vnazu).** `raceWithBudget` abandons work, it does not
stop it: the reply and the holding line share one `newTurnClaim()`, a second draft starts only when
`redraftFits`, and a reply that claimed the turn is waited for instead of sending the fallback on top.
Live chat writes GHL fields through `src/live-chat/identity-capture.js` — the SMS path's fill-if-empty
`promoteIdentityToGHL`, never an overwrite, never onto a merged-away contact.

**Both bots are "the Reece Team" and promise same-day calls only in team hours (Mark, 2026-10-02).** No
text or chat reply gives a personal name, on Mark's number too (`resolveSmsSenderIdentity` signs "— Reece Team"; only
the rehash rep's line keeps a name, and emails keep their sender). Randy's FATHER founded Reece in 1972; Randy did
not. `enforceTeamVoice` (`src/agentic/team-voice.js`) corrects both after the model, and `enforceCallTiming`
(`src/agentic/team-hours.js`) turns a promised call "today" / "right now" / "in the next few minutes" into the next
opening outside 9–8 weekdays, 9–5 Saturday, 9–3 Sunday (ET). The planner's hand-off and callback lines use the same
hours (`nowMs`). Look for `[TeamVoice]` log lines.

**A conversation has ONE stored stage (Lead Conversation Stage, 2026-10-12).** Three test batches (~35 chats) booked
nothing: `planNepqTurn` re-guessed the stage from the thread every turn, and `stageBlock` read the analyzer's
`buyer_stage` and said something else. `src/agentic/lead-stage.js` (pure) is the one answer: the NEPQ track
connection → situation → problem → consequence → qualifying → transition → commitment_offered → slot_held → booked,
side states `objection:<type>`, `reschedule:<step>`, handoff, opted_out, disqualified_non_owner / _out_of_area, and the
rehash track as `rehash:<stage>`. `buyer_stage` stays a separate axis (tone only). `booked` comes ONLY from the real
booking event (`recordBookedStage` beside both `ghl.appointment_booked` emits), never from the reply's words; the track
never moves backward without an objection or a reschedule. `src/services/lead-stage-io.js` stores it
(`lead_conversation_stage` + `_events`, codes and our own time labels only, never customer text) after every sent turn
(SMS send handler, live chat `deliver`, a STOP short-circuit as opted_out), and mirrors the label to the GHL "NEPQ
Stage" dropdown (`contact.nepq_stage`, 16 labels in `STAGE_GHL_LABEL`) only when it changes and only a label the live
dropdown carries. "Stage Last Engaged" is another field: never touch it. The simulator keeps the stage in memory and
prints `stage: a → b (reason)` per turn. `LEAD_STAGE_MODE` off|shadow|live, default shadow (record only);
`GET /admin/lead-stage/:contactId` (x-admin-token) shows it.
**With `LEAD_STAGE_MODE=live` the planner and the prompt read the stage (the user, 2026-10-12).** `planNepqTurn({ stage })`
(passed only when live; null is byte-for-byte the old plan): a yes to ANY offer of ours, a schedule ask or an address
moves forward whatever our last message was; past the bridge (or at qualifying / offered / held, or back from an
objection play) anything that is not a no goes to times; the bridge is sent ONCE; a pick resolves only against the
newest offer (`latest_offered_slots`); a stated day or part of day is honored or said to be unavailable;
"you just said that" changes the move. **The qualifying gate** (`gateForStage`, `QUALIFY_LINES`): no visit time until the
lead owns the home, the zip is known and every decision maker is the lead alone or named AND able to be there, one item
per message (owner → zip → decision makers), an item asked twice is not asked a third time. In live mode this
supersedes "NEVER probe for disqualifiers" (the plan block allows the ownership question) and "ask about decision makers
ONCE, after the hold" (asked before the times; a settled answer rides as `plan.dm_known` and the collect never asks
again). `stageBlock` renders from the stored stage (`playForConversationStage`), buyer_stage is tone only, and the
transition default is the free home visit. The simulator and `run_bot_eval` take `lead_stage_mode` (shadow|live) to try
it before Railway is switched.

**A renter gets no visit; one out-of-area decline; quote ≠ price (handoff PR 3, 2026-10-12).** A renter was offered
times twice (batch 3 T3). `enforceNonOwner` (`src/agentic/non-owner.js`, the last pass in both bots beside
`enforcePropertyScope`, ACTIVE in every mode) turns a reply to a lead who says they rent into `NON_OWNER_LINE` (the
homeowner needs to be part of the visit; the owner is welcome to reach out), drops the time offer when they said it
earlier, drops the `book_appointment` companion, and the live chat never books one (`isNonOwner`). A landlord ("we rent
it out") owns the home (`homeowner.js`), but a rental is declined by `job-scope.js` (2026-10-13, below), and a TENANT
now gets `RENTAL_LINE` (`nonOwnerLine`); only a non-tenant non-owner keeps `NON_OWNER_LINE`. Zip 10001 was declined on SMS and "good chance we can help" in live chat: both
bots now give `outOfAreaLine` (service-area-turn.js; the SMS SERVICE_AREA_EXIT text and the `serviceAreaOutside` prompt
too, which no longer offers a team callback), and live chat checks a zip typed outside a coverage question
(`zipInText`). With `LEAD_STAGE_MODE=live` (`planNepqTurn({ stageLive })`): a plain quote request is NEPQ's info request
(`LINES.info_request`, once), not the price play (`isPriceAsk({ quoteIsPrice: false })`; an insist or a price word still
is), and "we went with another company" gets `LINES.competitor` (the disarm, then how they would decide; no consequence
move after it; a second time → `repeat_objection`). `CLAIMS_RX` strips claims that another company's work is not "up to
code".

**No rentals, no commercial, a three-opening minimum, impact only (the user, 2026-10-13).** A landlord was booked like
any owner, the prompt said "Investment properties are NOT a disqualifier", commercial work was "route to the team" (live
chat pitched it as a LARGE JOB), no code knew a minimum, and two FAQs said "not every window in our line is
impact-rated". `src/agentic/job-scope.js` (pure, both bots, EVERY mode, run right before `enforceNonOwner`) reads the
thread: a RENTAL (tenant, landlord, Airbnb/VRBO, property manager) or an INVESTMENT property (a flip, or "an investment
property" with nothing more; `INVESTMENT_LINE`; an owner's un-rented second home is a lead, the user, 2026-10-13)
or COMMERCIAL property (business, office/apartment building, church, HOA or condo association for the building; a single
condo owner is a homeowner) said now → the whole reply is `RENTAL_LINE` / `COMMERCIAL_LINE`, said earlier → the time
offer goes. The MINIMUM is three windows or doors in any mix, or one sliding glass door alone: a stated count under it
(not a symptom: "my window is foggy" is never checked) gets ONE friendly check, never the rule first (`MINIMUM_CHECK_LINE`,
the user's wording: "Of course, I can help with that. Are all the other windows in your home already hurricane
impact?"; "Does your home only have 1 window?" reads the same). A yes or "just this one" → `BELOW_MINIMUM_LINE`, which
states the minimum; "no, the others are old" or anything else is the normal flow, and an unknown count never blocks. The
count is asked ONCE before any time, in the user's wording ("How many windows and doors are you looking to get a quote
on?" / "… to have us come measure?"): the qualifying gate's `openings` item (owner → zip → openings → decision makers,
`openingsKnown`), and the prompt's ASK FOR WINDOW COUNT. A bare "1" in reply to it is read as the count (`openingsAt`). The
count the lead states is SAVED to the GHL fields Window Count (`h9FJTUbmUHIuD6JKmpXv`) and Door Count
(`j7l1KWmDgoJqy7SINjQs`; a slider is a door), read by code from their newest message (`openingsToSave`), as one
`update_custom_fields` row (rule `OPENINGS_COUNT_PERSIST`) after the send on both bots; a count already on the contact
(`context.estimate.window_count` / `door_count`) skips the question (`knownOpenings`). A draft saying we do commercial or rental work, or
that some windows are not impact, has that sentence replaced. Any block drops `book_appointment`, the live chat refuses
the booking (`refused_job_scope:*`), `gateForStage` returns `not_eligible`, `checkReply` fails `job_scope`, the analyzer
has `dq_detected` rental_property / commercial / below_minimum, and an LP note saying below minimum is an LP-note DQ. An
LP note that only DESCRIBES a rental or a commercial property is NOT (the team books those: "owns a rental property …
estimate for three windows"); as a DQ it would stop-bot live appointments, so those rules read only the lead's words. FAQs LIB-P03/P15 (impact only), LIB-P16/17/18: `sql/seeds/2026-10-13_scope_rules_impact_only.sql`.
Reminders for Set/Verif only (Cnf and Issue get none) are GHL edits in A.WE-1: `docs/ghl-we-reminders-set-only.md`.
The live chat also never books in a chat that raised a manufactured home or a 3+ story building (`leadRaisesScope`).
#1274 (the same rules built a second way, never told the minimum) was closed by the user's ruling. Also fixed: the SMS scope guard compared `scope.reason === 'lead_asked'`, which never matched `'<rule>:lead_asked'`, so a
declined manufactured home or tall building kept its booking.

**Every GHL request is credited to the code that made it (2026-10-12).** LP-MCP made ~127,000 GHL requests in 24h
(~63% of GHL's 200k/day cap, peaks 268/min at 5 AM) and the rehash sweep failed 1 pass in 4 on 429s, with no way to
say who made the calls. `src/ghl-caller.js` carries a label in AsyncLocalStorage, set where work starts: `job:<id>`
(runJob, plus the capacity lead loop, the LP incremental sync and the field sync), `action:<type>` (the executor),
`engine:<event_type>` (the decision engine) and `http:<METHOD> <path>` (Express). With no label, the first
non-plumbing source file on the stack is used (`src:<file>`). `acquireToken` counts requests and `report429` counts
429s per label: `/n8n/rate-limiter/stats` → `byCaller`, a `[GhlCallers]` log line every 15 min and one
`ghl.request_budget_by_caller` event. Measures only. New GHL code needs nothing; the coverage scan
(`scripts/test-ghl-rate-limiter-coverage.js`) now also catches `doFetch(` / `fetchImpl(` / `fetchFn(` call sites.
**Do not re-ask GHL what we already know (2026-10-13).** The first day of counts: capacity-lead-loop 60,253, P2
backstop 9,152 (28 of 65 429s), rehash sweep 4,500. Now the capacity sweep calls `processProspect(p, { reuseStoredLink })`:
a prospect whose leads all carry one stored, classified link skips `matchToGHL` (`storedLinkToReuse`; unlinked,
`legacy_unverified` or a differing lognumber/User1 runs the full match) and an active-entry add the tag snapshot already
shows. The P2 backstop remembers a settled `skip`/`report` for 6h per deciding job (`createSettledMemo`), never a write,
a wait or an unreadable read. The rehash sweep decides from `contact_tag_snapshot` and reads GHL live only to act, for a
contact not in the snapshot, or once a day per contact (`canSkipLiveRead`); every write is still decided from a live read.

**Static system prompts are cached** (`callLLM({ cacheSystem: true })`: reply writer, analyzer, live chat).
Only for a system prompt that is byte-identical across calls — a varying one pays the write premium every
time. Look for `[LLMClient:<fn>] cache read=` lines. `LIVE_CHAT_SHADOW_MODEL` runs a second model beside the
live chat (never sent; `agentic.live_chat_shadow_model` events) for the model comparison.

**Connection probes are read-only and never post.** `GET /health/integrations`
(`src/integrations-health.js`) answers "can we reach LP / Five9 / Slack / GroupMe right now?"
for the dashboard. A probe that cannot tell reports `unknown`, never `connected`; a GroupMe bot
id alone is `unknown` because posting is the only way to exercise a bot.

**Text from outside is stripped before it reaches a model.** Every tool registered
through `registerAllTools` has its text output passed through `stripUnicodeTags`
(`src/text-sanitize.js`). Unicode TAG characters are invisible to every human who
reviews a message and fully visible to a model, so anyone who can text the business
could otherwise smuggle instructions into an agent's context. The wrapper sits at
registration because that is the one place that covers all 126 tools and the next
one added.

**Every inbound text is screened and the decision recorded (2026-10-07, IT review).** After
`cleanInboundForModel`, `src/security/injection-guard.js` classifies the text: a no-I/O heuristic first, then
an optional LLM Guard sidecar (`INJECTION_CLASSIFIER_URL`, 1.5s cap, fails open). Every check writes one
`guardrail_decisions` row (sql/152) with a hash, never the text. Surfaces: `sms_inbound` (analyzer), `live_chat`
(fast lane), `ci_transcript` (call analysis, which also now runs the sanitizer). `INJECTION_GUARD_MODE` off|shadow|live,
default shadow; live blocks only surfaces in `INJECTION_GUARD_BLOCK_SURFACES` (default `ci_transcript` → the call goes
to review). Never add a customer chat surface to that list without Mark's ruling and a `run_bot_eval`. Hot paths call
`guardInBackground` and never wait. The attack + benign corpus is `scripts/fixtures/redteam-corpus.js`: a new attack
seen live goes in ATTACKS, a misflagged customer message in BENIGN. Live red-team runs: `redteam/README.md`.

**UNREADABLE is not down (dialer watchdog and heal, 2026-09-28).** A Five9 status read that fails is
retried (`readCampaignState` in `src/routes/capacityRanker.js`, 3 reads over ~6s) and its reason is
logged. Still unreadable, the watchdog pages with honest wording ("may not be dialing"), because a real
outage has shown up first as UNREADABLE — but heal files it under `unreadable`, never `failed`. It
writes no `restart_failures` and posts no "STILL not RUNNING" card. One blip used to produce three false
"HEAL FAILED" cards in an afternoon, each heal row becoming the next heal's source.

**Classify before you threshold.** An alarm that fires on the healthy case gets muted, and a muted
alarm is how a 47-hour outage and a 71-day blind spot both went unnoticed. Exclude the legitimately-
quiet cases explicitly (see the eligible-replies split in `agentic-silence-alerts.js` and the
three-class split in `rule-fail-closed-alerts.js`) rather than raising the threshold until it stops
crying wolf.

## LLM budgets: a constant written for the old model is the recurring bug

This has now bitten three times in two days, each time wearing a different error
message, each time the same root cause: **a number chosen for a model that no longer runs here.**

- 2026-09-18 — `max_tokens: 500` was spent entirely on thinking, so the API returned
  `blocks=[thinking]` and no text. 29 failures.
- 2026-09-19 — the 30s `LLM_TIMEOUT_MS` was written for a family that answered immediately.
  `The operation was aborted due to timeout`, on the first analysis after the fix above.

Both are now enforced **once, in `src/llm-client.js`**, keyed off the same
`modelUsesThinkingBudget()` predicate: `resolveMaxTokens()` floors the token budget,
`resolveTimeout()` floors the clock. Do not re-solve either at a call site — a per-call-site
number falls behind the next family exactly the way the temperature list did. A caller asking
for more still gets more; the floors only ever raise.

**Nested timeouts must COMPOSE, and the outer one must be derived, not guessed.** The analyze
path carried three independent literals that did not add up — a 45s caller abort over a 40s
context ceiling plus a 30s model call. A slow-but-healthy analysis could be killed by its own
caller while every number looked defensible alone, and raising the model floor widened that gap
silently. Enclosing deadlines now derive:

| deadline | derived from | file |
|---|---|---|
| `POST /n8n/analyze-message` abort | `analyzeBudgetMs()` | `src/behavioral-emitter.js` |
| analyze budget | `ANALYZE_TIMEOUT_MS` + `llmBudgetMs('message_analyzer')` | `src/message-analyzer.js` |
| `send_message` watchdog | `sendMessageBudgetMs()` in the `Math.max` | `src/actions/index.js` |

If you add a timeout around anything that calls an LLM, add `llmBudgetMs(fn)` into it rather
than picking a number. `scripts/test-llm-timeout-budget.js` fails if the chain stops composing —
that test is the guard, so do not weaken it to make a new literal fit.

## The Decision Engine

Rules live in the `agent_rules` Supabase table — **database config, not code**, so a rule change
ships without a PR but takes effect only after an engine reload. `src/decision-engine.js` evaluates
the merge `{ ...conditions, ...context_conditions }`; put all new-rule logic in `context_conditions`
and leave `conditions` NULL.

**Fail-closed doctrine (2026-07-03).** Any condition referencing data the engine cannot read
evaluates FALSE and suppresses the rule — including the `not_*` negatives, which used to fail open.
Missing data is never a wildcard pass.

Two traps inside that:

1. **An unknown condition operator short-circuits silently.** No error, no log, the rule simply never
   fires. Before using a verb, confirm it exists in the `evaluateContextConditions` switch.
   `EMAIL_ENRICH_FROM_LP` was dead this way for 1,970 evaluations before anyone noticed.
2. **"Not applicable" is not "unreadable."** An event with no `ghl_contact_id` has nothing to read;
   that suppresses the rule but is not a failure and must not be reported as one. Conflating the two
   filed 432,474 non-events and buried 829 real ones. See `notApplicableNoContact` vs
   `failClosedContactRead`.

Condition evaluation is a pure conjunction, and `evaluateContextConditions` sorts I/O-backed
operators (`IO_BACKED_CONDITION_KEYS`) last so a cheap gate can reject an event before any contact
read. Adding a new I/O-backed operator? Add it to that set — membership is opt-in, so a missed entry
costs the optimisation, never correctness.

Before claiming a rule never fires, check `agent_actions.rule_applied`. One flagged as dead had fired
47 times.

**A workflow route that "completed" may have moved nobody (F-L, 2026-10-12).** GHL answers 200 to an inbound
webhook whose trigger sits on a draft workflow or is switched off, so rule 164 logged 64 completed adds to the draft
S3.1 v1 and enrolled no one; the old audit read `params.workflow_id` only and never resolved `params.webhook_url`.
`src/rule-target-resolve.js` (pure) checks every enabled rule's `add_to_workflow` / `remove_from_workflow` by both
paths, resolving a `/webhook-trigger/<id>` through the HL mirror's `workflow_triggers` (`raw_json.id`, `active`;
triggers are NOT in `workflows.raw_json`, which is why the handoff called S4.1's live trigger "owned by nothing"),
and every `ghl.workflow_completed` rule's `payload.workflow_id`. Job `rule-target-check` (02:10 ET,
`RULE_TARGET_CHECK_ENABLED`, default on) writes `rule_target_checks`; a HIGH finding (an add, or a completion
trigger, that goes nowhere) is one line in the 08:00 digest, once; a remove from a draft is LOW and never posts. A
mirror unreadable or older than 26h is "could not run", never zero findings. On demand: MCP `check_rule_targets`.
New rule targeting a workflow? Run that tool after the rule is live.

**A stand-down is only safe if something else answers.** Rule 106 (`AGENTIC_RESPOND_POST_CHATBOT`)
skips every intent in its `recommended_action_nin` because a `layer3_action_dispatch` row owns that
reply — but the dispatcher drops a row under its `min_confidence`, and for months that meant nobody
answered (Mark Test, 2026-09-25: "Yeah sure" to the bot's own guide offer, guide_send 0.6 < 0.65).
`runLayer3LowConfidenceFallback` (`src/decision-engine.js`) now queues rule 106's own template under
`rule_applied = 'LAYER3_LOWCONF_FALLBACK'` whenever that happens, reading the nin list live. Adding an
intent to the nin list is therefore safe; removing the fallback is not. Audit:
`sql/verify/2026-09-25_layer3_silence_audit.sql`.

**Every cancel / no-show S5.2 entry passes ONE gate (Mark, 2026-10-02).** `src/s52-entry-gate.js` runs at
the top of `executeAddToWorkflow` for either S5.2 workflow when the row's `state_code` is
`APPOINTMENT_DISRUPTION.*` or `APPOINTMENT_FRICTION.ghost_after_booking` (pre-demo friction states need a live
appointment and pass untouched). It refuses an ACTIVE canvassing entry (`active-entry:canvassing` only — older
`entry:canvassing` / `source:canvass` markers do not block, user 2026-10-02), a demo on ANY lead, a live appointment on any lead
(Set/Cnf/Verif/Issue dated today or later ET), current-lead Issue and current-lead No Demo/ND/NOC, reading LP
LIVE (every prospect by lead, prospect id and phone) merged with `lp_leads`. A failed read blocks. A block is a
`skipped` row plus `s52.entry_blocked` (no Slack). Do not add a per-rule S5.2 guard instead of using it.
A cancel rule (271/171/107) suppressed by `not_reschedule_inflight` gets ONE `s52_cancel_recheck` 30 minutes
later (`src/s52-cancel-recheck.js`) — unless a sibling cancel rule already routed it. The same re-check runs when
271 is dropped by the `LP_DISP_%` 30-minute group dedup because LP_DISP_SET fired just before (a cancel minutes
after booking — Antonino Paone and Mike Plant, 2026-10-02).

## The FAQ corpus (`kb_faqs`)

Database content, like `agent_rules` — a change ships without a PR, but the embedding sweep runs
every 6 hours, so force it with `POST /n8n/kb/reembed {"faqs":true}` and confirm with
`GET /n8n/kb/faq-probe?q=...` (read `would_match`, not `matched`). Record every change in
`sql/seeds/` so it is reproducible. `KB_FAQ_SEMANTIC_MODE` is `live`; rollback is one env var
(`shadow`).

**The LEADING phrase in `question_pattern` dominates the vector.** `buildFaqEmbedText`
(`src/knowledge/tier1-semantic-core.js:27`) embeds `question_pattern` + the first 240 characters of
the answer, so a row must lead with the phrasing customers actually type, not the tidiest one. This
has now been fixed four times: LIB-P04 led with "Why vinyl instead of aluminum?" and lost
"Do you sell aluminum windows?" to a doors FAQ; LIB-P10 led with the compound "Do you do shutters or
garage doors?" and lost a pure garage-door question to LIB-P09's *"yes, we do doors"* by 0.015. Lead
with the customer's words, then re-probe the neighbours — reordering moves the whole vector.

**Omitting an item from a list of what we offer reads as a DENIAL.** Single-hung was left out of
KB-02 on 2026-09-25 because Mark had not ruled on it, on the theory that a list which never says
"no single-hung" cannot state something false. That theory was wrong: a lead who asks
"do you have single hung?" and gets back a list of seven other styles has been told no. **We DO offer
single-hung** (Mark, 2026-09-26) and KB-02 now leads with it. The same trap applies to any
"we offer X, Y, Z" answer — an absent item is an implied no, so an unruled item needs a ruling, not
silence. Note that `reece-product-knowledge`, the skill KB-02 was written from, still never mentions
single-hung; that skill is synced and Mark's to edit, so it is not the place to look this up.

**Homes we cannot work on: manufactured/mobile homes, and buildings over two stories (2026-10-05).** The live
chat told a visitor "Yes, we work on manufactured homes" and answered "Do you service a 9 story condominium?" with
"Yes … Is this for all nine floors?". Neither limit was in the reply writer's view (`kb_proof_points` is not, and the
live chat never runs `DQ_ABOVE_2ND_FLOOR_INTERIM`). Both are now in the shared system prompt, FAQs `LIB-P13` /
`LIB-P14`, and `enforcePropertyScope` (`src/agentic/property-scope.js`), the last pass in both bots: a lead who raises
one gets the "no" as the whole reply, and any "we do" sentence is replaced. The building counts, not the unit. Modular
homes are not ruled on and are deliberately not covered; "tower" alone and "4 floor-to-ceiling windows" do not count.

**Retiring a FAQ without a replacement leaves a hole the search fills with the nearest thing.**
Retiring `#14` (roofing) during the golden ingest left no roofing answer at all, and a live lead
walked into it — the three FAQs retrieval offered were all irrelevant (top 0.405) and only the
model's own knowledge saved the reply. When a topic is retired because the answer CHANGED, the new
answer still has to exist (`LIB-P12`).

**Past-win examples are cleaned before a model sees them (2026-10-12).** `KB_EXEMPLAR_MODE` (shadow) served 5,670
examples in 14 days: 24% were GHL's raw live-chat HTML, about a quarter named another lead's day and time, 222 promised
a call "right now" (the Monica reply) and 24 were workflow drips. `prepareExemplar` (`src/knowledge/exemplars-core.js`)
is the one cleaning pass, at write time, in place for older rows (`clean_version`), and again at serve time: HTML out;
the contact's name, a greeting name, streets, days and times replaced by `[name]` / `[address]` / `[day]` / `[time]`;
call immediacy softened (`softenCallTiming`) and the voice humanized; a drip, a too-short reply or one that fails
`checkReply` is stored inactive with an `excluded_reason`. Bump `EXEMPLAR_CLEAN_VERSION` when the pass changes. The gate
can try the mode without Railway: `run_bot_eval` / `simulate_bot_conversation` take `kb_exemplar_mode`
(`src/simulator/sim-overrides.js`, AsyncLocalStorage; a sim's audit rows log mode `sim_<mode>`).

## Supabase

**Two separate instances — LP and HL.** No cross-joins; fetch from one and filter against the other.

- Reads: wrap in `json_agg(row_to_json(s))`.
- Writes: assert the row count (`WITH u AS (... RETURNING 1) SELECT count(*) FROM u`). Note the MCP
  query tool reports `rows_affected: "n/a"`, so verify with a follow-up count.
- **Schema changes are migrations, applied by CI (Fix 1, 2026-10-12).** Before this, 157 numbered `sql/` files
  were pasted into the SQL editor by hand and the database's own migration table knew about 8 of them; five
  repos wrote tables into the LP project with no shared record. Now a schema change is ONE file
  `supabase/migrations/<YYYYMMDDHHMMSS>_<snake_case>.sql`. `.github/workflows/db-migrate.yml` checks it on
  the PR (`scripts/check-migrations.js`, then the repo ledger against the database's, then schema drift once
  the baseline dump exists) and applies it on merge with `supabase db push`. `sql/NNN_*.sql` is FROZEN at 157
  and CI fails on a 158; `sql/seeds/` (agent_rules, kb_faqs data) is unchanged. The first real file must be
  the `*_baseline_dump.sql` the workflow's `action=baseline` run produces; until it exists, only commented
  stubs may live in the folder (the drift check replays the folder into an empty shadow database). A
  DROP / TRUNCATE / DELETE / column-type change carries `-- destructive: approved by <name> <YYYY-MM-DD>`.
  Never paste DDL into the dashboard again. The boot-time mirrors (`src/admin/startup-mirrors.js`) now
  only CHECK and page; `STARTUP_SCHEMA_APPLY=true` is the rollback. The other repos (Reece-Dashboard,
  n8n, window-calculator, the AI OS loads) add their LP-project DDL HERE, not in their own folders. Full
  doctrine: `sql/README.md`. This supersedes rule 7 of the `reece-code-shipping` skill ("DDL executes in
  the Supabase dashboard only; mirror in runMigrations()"), which is Mark's to edit.
- Deleting from `system_events` can trip `agent_actions_event_id_fkey`. Guard with
  `AND NOT EXISTS (SELECT 1 FROM agent_actions a WHERE a.event_id = e.id)` and delete in batches — a
  single large statement is atomic, so one FK violation rolls the whole thing back.

**The MCP SQL tool is splitting into a read tool and an audited write tool (2026-10-07, IT/GoCloud
review).** `run_sql` is SECURITY DEFINER, so `supabase_run_query` could write anything as postgres.
- `SQL_TOOL_MODE` readwrite (default, today) | shadow | readonly. Readonly lets `supabase_run_query` and
  `hl_query` run ONE `SELECT` / `WITH…SELECT` / `EXPLAIN` only. `src/security/sql-guard.js` tokenizes
  (strings, `$$`, comments, quoted identifiers are skipped). It refuses chained statements,
  data-modifying CTEs, `SELECT … INTO`, `FOR UPDATE/SHARE`, `run_sql(…)`, `set_config`, `dblink`, `lo_*`,
  `net.*`, `vault.*` and every `pg_*` function outside a short read list. Quote a column named `update`.
- Writes go through `supabase_write_query` (only when `SQL_WRITE_TOOL_ENABLED=true`). It needs `reason` +
  `confirm: true`, and `confirm_destructive` for DROP/TRUNCATE anywhere (incl. `ALTER … DROP COLUMN`).
  Every call writes a `tool_audit_log` row first. Row-count assertions work as before.
- The guard cannot see a user-defined function that writes. `SQL_READONLY_RPC=run_sql_readonly` (after
  `sql/154`) makes the database refuse those too, because the transaction is read-only.
- `tool_audit_log` (`sql/153`) is append-only by trigger. Never add an UPDATE/DELETE path to it.
  `INFRA_TOOLS_MODE` (open | shadow | operator) gates `set_railway_env_var`, `redeploy_railway_service`,
  `rollback_railway_deployment` and `http_request` per call on the operator token (`src/security/infra-guard.js`).
  `HTTP_EGRESS_MODE` (off | shadow default | enforce) with `HTTP_EGRESS_ALLOWLIST` is default-deny egress.
- Rollout: shadow → read the would_deny rows → `SQL_WRITE_TOOL_ENABLED=true` → readonly. Set the variables
  in one batch.

**Boot-time schema mirrors check before they touch anything (2026-09-26).** The blocks live in
`src/admin/startup-mirrors.js` and `src/admin/startup-schema.js` runs them: one catalog read, then DDL
only for a block with something missing. A no-op `ADD COLUMN IF NOT EXISTS` still takes ACCESS
EXCLUSIVE on the table (8s lock_timeout on hot tables) and every DDL statement reloads PostgREST's
schema cache, so running them blindly each boot produced lock-timeout and PGRST002 "FAILED" lines for
schema that was present. A new block must declare every table, added column, view (plus its columns)
and index it creates — `scripts/test-startup-schema.js` fails otherwise. A mirror guarantees an object
EXISTS; a view body change that adds no column is not re-applied, so apply that sql/ file from the
dashboard. Blocks that define functions (`expects: null`) still run every boot. Set Railway variables
in one batch: each single set is a redeploy, and overlapping boots contend for the same locks.

**`lp_leads.close_date` is not all one thing — read `close_date_source` first.** Until 2026-09-16 the
column was NULL on all 24,834 `closed_won` rows, because nothing ever wrote it; `get_rep_performance`
still buckets by `appointment_date` for that reason. `sql/118` backfilled it and
`POST /notifications/sale-announcement` now writes it per sale, so three cases coexist:

| `close_date_source` | means |
|---|---|
| `appointment_proxy` | backfilled from `appointment_date` — the right MONTH, not the right DAY |
| `sale_announcement` | written when the sale was announced — trustworthy to the day |
| `lp` | reserved; nothing writes it until LP exposes a real close date |
| NULL | a won lead with no `appointment_date` either. Undated, honestly |

Anything that turns on the exact day must filter on the source. `sync-leads.js` never includes
`close_date` in its upsert row, so `ON CONFLICT DO UPDATE` leaves it alone and a written value
survives every sync — that is why the backfill is durable, and why adding `close_date` to that row
object would silently erase all of this.

**`tag_hygiene_log` is the L.6 idempotency record, not just a log.** A P2 loss closed by
`P2_JOB_TERMINAL_LOST` now posts to L.6 (`src/loss-routing/l6.js`), and so does
`scripts/backfill-loss-routing.js --mode=p2`. A post is refused when that table already holds a
`posted_l6` row with `mode='apply'` for the opportunity, when the live contact already has a `p3:*`
tag, or when the table cannot be read — a double post routes a contact twice. Dry runs log under
`mode='report'` and never count. The daily tag sweep (`src/jobs/tag-hygiene-sweep.js`) logs there
too, and never removes a tag in `PROTECTED_TAGS` (`src/tag-hygiene/rules.js`), whatever rule matched.

**A contact's newest LP job is often a placeholder copy, not the job.** LP keeps a do-nothing
duplicate of many sales: contract `NEW`, status `New`, no payment, no milestone, the same value as the
real job, and usually a higher id. "Newest job wins" picked it for 5 of 11 LP Job ID stamps checked on
2026-09-23. Anything that chooses ONE job must first run `dropShadowJobs()`
(`src/p2-opportunity-context.js`). `decidingJob`, the stamping backfill and the P2 reconciler already
do. It only drops a job with no progress when a same-value twin has progress, so a returning
customer's new job at a different price still wins.

**`lp_leads` / `lp_jobs` have holes, and a missing lead silently takes its jobs with it.**
`lp_jobs.lp_lead_id` references `lp_leads`, so a job whose lead never synced fails the FK on every
write. Only about 40% of LP lead ids 530k–542k (April–May 2026) are present. The live parent-heal
(`LP_JOB_PARENT_HEAL_MODE`) only sees jobs whose status changes, so old jobs never heal.
`scripts/repair-p2-missing-lp-jobs.js` recovers them per P2 opportunity. "No LP job" on a P2
opportunity is a copy gap far more often than a job LP never created.

**The holes are biased toward UNSOLD leads, so never take a rate from `lp_leads` before late July 2026
(2026-10-08).** Sold leads are pulled in by the job sync; unsold ones are not. `lp_leads` holds 3,149
February leads against LP's 12,444, and February's sales-per-lead read .097 from it against LP's real
.026. Coverage passes ~95% only from late July. For an older month use LP report 136 per sub-source
(`lp_source_cost_history`, by lead entry month; it ties to report 135's lead count), as
`tallySourceCost` in `src/batting-average.js` does for the LightFire scorecard
(`node scripts/lightfire-scorecard.js`).

**137 By Setter comes in two shapes, both into `lp_sales_efficiency_setter_history` (2026-10-08).** The emailed
data export (the same header as By Market, told apart by `xGrouper`) and the PRINTED page LP's viewer saves as
.xls, read by column and checked against its own printed Total (`parseSalesEfficiencySetterLayout`; the
CSV route recognises it by title). Jan–Sep 2026 came in as .xls: `scripts/lp-137-setter-layout-backfill.js`
(dry run first, `--load` to write). It is MONTHLY, so the report watchdog uses `cadence: 'monthly'` for it.

**Six markets, not seven — Lakeland is Orlando (2026-09-28, `sql/135_lake_orl_merge.sql`).** LP still
prints branch `LAKE`, and it stays raw wherever a raw branch is stored (`branch_code_raw`,
`lp_branch_id`, `rep_home_market`), exactly like BOCA/MIAMI for Fort Lauderdale. The fold happens in
`lp_branch_market_map` (data) and `MARKET_ALIASES` in `src/slack.js` (Slack routing and the office
leaderboard). Never write `LAKE_MKT` again, and never re-apply `sql/037` or `sql/017` by hand — both
re-seed the pre-merge Lakeland rows.

**Houston (HOU) and Winston-Salem (WSNC) are service markets too (2026-10-01, sql/141).** Their zips
are TEMPORARY defaults generated from Census county data; `scripts/import-service-zips.js` swaps in
Mark's real lists. Both use the general phone until their own is known. Houston is the one market on
**Central time**: `src/config/market-timezones.js` maps the market, `src/services/contact-timezone.js`
resolves a contact's zone from their zip, and customer-facing times (slots, appointment text, the
prompt's TIME NOW, that contact's quiet hours) follow it. Office/dialer hours stay ET with an "ET"
label. **A zip the lead TYPES decides the zone, not only the record's (handoff PR 4, 2026-10-12).** A
Katy lead typed 77494 and was offered "10:00 AM ET": `typedZipFromThread` / `zoneForContact`
(`src/services/contact-timezone.js`) set `context.market` before the SMS slot read and pass `zip` to live chat's
`offerBookingSlots`, so the times are read and labelled CT. The allowed visit start hours (10, 2, 6) stay checked in the
office zone the GHL calendars are laid out in. Never tell a visitor Reece serves only Florida. Coverage questions are zip-first
(`src/agentic/service-area-turn.js`, both reply paths): ask for the zip, then answer in the first
sentence. Not yet wired for the new markets: `lp_branch_market_map`, `slack_market_slugs`.

**Rep names do not match across the LP/GHL boundary.** LP stores `"Last, First"` (`O'Connor, Tim`);
GHL's Rep Display Name (`yxOTDIT7Um0JxkOPUbPo`) holds `"First Last"` (`Tim O'Connor`). An exact
compare finds ZERO rows for every rep on the floor and fails silently — a metric that reads "no sales"
rather than an error. Use `repNameKey()` in `src/notifications/sale-facts.js` to compare, and
`formatRepFirstName()` in `src/response-generator.js` when a customer will read the name.

**Five9 → LP lead: the key is `'LDS' || lp_lead_id`, phone is the fallback (measured 2026-09-28).**
Five9 events carry `lp_rec_key` as `LDS<n>` or `INQ<n>`. Over 30 days, counting a match only when the
phone on both sides agrees: LDS → `lp_leads.lp_lead_id` agreed on 7,468 of 7,561 (98.8%). INQ →
`lp_lead_id` or `lp_prospect_id` agreed 0 times — but INQ is not noise, it is LP's INBOUND id
(`in1_id`, GHL field `3YMxheIlPyhACB8zyc3W`): INQ → that field agreed on 25,962 of 26,392 (98.4%).
No LP table carries `in1_id`, so INQ would need a hop through the HL mirror; the phone fallback
already credits those calls. Never join INQ to a lead or prospect id — the ranges overlap
numerically, so it "matches" and marks unrelated leads as called. See `leadKey` in
`src/lead-leak-classify.js`.

## Tests and CI

`npm test` is `node --test scripts/test-*.js`. New suites go in `scripts/` under that name pattern.

CI (`.github/workflows/ci.yml`) has two jobs: `syntax` (`node --check` over `src/**/*.js`, no install)
and `tests` (`npm ci` + `npm test`), and `tests` **blocks**.

If the suite goes red, fix the code or the test. Do not skip, quarantine, or restore
`continue-on-error` — a suppressed test is worse than an ungated one, because it reads as green.

**Every finished bot reply is held to one set of hard checks (2026-10-05).** `checkReply` in
`src/eval/reply-invariants.js` checks for: a merge tag sent, a personal name or the founder slip,
property scope, money, pressure, Florida-only, more than one ask, an unbacked booking claim, a call
promised out of hours, and an unasked call offer. It reuses the guards (a finished reply must be a
fixed point of each one), so a rule lives in its guard, not here. Context it cannot know is
SKIPPED, never guessed.
- `scripts/test-golden-replay.js` replays each known incident's real bad draft through the live-chat
  lane, with NEPQ live and off. **When a bad reply reaches a customer, add its draft there.**
- `node scripts/eval-replay.js --days 7 --by version` scores the replies actually sent, read-only,
  from `bot_message_context`. Customer conversations stay in the database and are never committed
  (the user's ruling, 2026-10-05).

**Run the bot gate before and after any prompt or model change (2026-10-06).** The MCP tool `run_bot_eval`
(or `POST /admin/bot-eval`, closed unless `ADMIN_API_TOKEN` is set) runs every simulator scenario
through the REAL bots on Railway, with nothing sent or written. It scores each conversation with
`checkReply` plus the scenario's own rule (`SCENARIO_EXPECTATIONS` in `src/simulator/sim-scoring.js`:
no pitch after a no, never "done" without the cancel, one reply to a burst, …). It compares the
result with the last gate run and saves it as a `agentic.bot_eval_run` system event (codes and
turns only, never customer text). **Ship only if the scorecard does not read WORSE THAN LAST RUN.**
A run takes 10–15 minutes and about 130 real model turns. A new scenario rule must come from a
ruling already in this file, so a failure means a regression, not a matter of taste.
**The AIOS test runs are named scenarios (handoff PR 7, 2026-10-12).** easy_yes, book_it_evening_spouse, renter,
competitor, stop_sms, stop_chat, trick_prompt, reschedule_unclear, out_of_area_chat, houston_tz. A scenario with
`autoAnswer` lets the persona answer the bot's address / ownership / zip / decision-maker / name / phone question
(`autoAnswerFor`), so a booking scenario can book. Every conversation also gets `stageFlowFailures`: yes_without_booking,
slots_offered_to_non_owner, stage_regressed, and, only when the run's `lead_stage_mode` is live, slots_without_qualifying
and bridge_repeated (today's designed behavior in shadow). A texted STOP answered with silence is not `no_reply`. The
scenario checks carry `SCORING_VERSION`: a run scored with new checks is a new baseline, not "worse".

## Writing code here

Existing modules carry dated comments explaining *why* a thing is the way it is, usually naming the
incident that caused it. Match that: when you encode a non-obvious decision, say what it is defending
against. The comments are how the next session learns what a live pull cannot tell it.

Use a `deps` seam for anything that reaches the network or the database (`deps.fetch`,
`deps.supabase`, `deps.emitEvent`), so behaviour stays testable without a live service.
