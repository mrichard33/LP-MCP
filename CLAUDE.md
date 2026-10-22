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

**A customer phone on a card is 10 digits, nothing else (the user, 2026-10-13).** "List the number with numbers only
##########": `3525550188`, the FULL number (the old last-four `…0188` cards included), no +1, dashes, dots, spaces or
parentheses. Card builders use `slackPhone` (`src/format-helpers.js`); `normalizeSlackPhones` / `normalizeSlackBlocks`
(`src/slack-phone-format.js`) is the safety net in `postToSlack`, `updateSlackMessage`, the approval `respond()` and the
GroupMe send (only a phone SHAPE with a separator or a +1 is rewritten, and only block `text`, never a button `value`).
Customer-facing texts and chat replies keep `(352) 555-0188`.

**A Slack card names the LP Prospect, never the LP lead id (the user, 2026-10-16).** "It must always include the
Prospect ID, never the actual lead ID." Print `prospectLabel(prospectId)` (`src/format-helpers.js`): `Prospect 462947`,
or `Prospect: unknown` when none is known (the card still posts; the lead id is never the fallback). Only a lead id in
hand → read `lp_leads.lp_prospect_id` (`prospectIdForLead` in `src/actions/resolvers.js`). Several leads on one prospect
are told apart by disposition, source and date. `normalizeSlackText` (`src/slack-phone-format.js`, phones then
`stripSlackLeadIds`) is the net at the same send points as the phone format: a "lead 581695" / `LDS581695` that slips
into a card (approval reasoning, an error, model output) loses its number. LP inbound inquiry numbers (`in1`, "inbound
#430305") stay: an inquiry has no prospect yet. Machine values stay too (dedupe keys, Five9 `LPRecKey`, `card_line`,
action payloads), as do GHL and LP notes. `scripts/test-no-lead-id-on-cards.js` scans `src/` for a template that prints
a lead id; a line that is not Slack text carries `lead-id-ok: <why>`.
**The prospect is a link to its LP lead page (the user, 2026-10-16).** `slackMessageText` / `slackMessageBlocks`
(`src/slack-phone-format.js`, used by `postToSlack`, `updateSlackMessage` and the approval `respond()`) turn every
"Prospect 463174" into `<https://br27a.leadperfection.com/leaddetail.html?custid=463174|Prospect 463174>`
(`LP_PROSPECT_URL_BASE` overrides the page). So a card prints the prospect with `prospectLabel` and never builds the
URL itself. Only `mrkdwn` text is linked (a plain_text header or a button would print the markup), never inside an
existing `<…>` or code, and never on GroupMe, whose send keeps the plain `normalizeSlackText`.
**The GHL contact id is a link to its GHL contact (the user, 2026-10-19).** The same pass (`linkSlackContacts`, run by
`slackMessageText` / `slackMessageBlocks` after the prospect link) turns "Contact ID: gxMVJgLkjFCVxTTLnn8A" (also
"Contact:", "contact", "GHL:", "(GHL …)") into `<https://app.gohighlevel.com/v2/location/<GHL_LOCATION_ID>/contacts/detail/<id>|Contact ID: …>`.
Only a GHL id shape is linked (20 letters/digits with a capital), never inside a link, a bare URL or code, never on
GroupMe. A card prints the label and the id; it never builds the URL itself.

**A live chat gets one Slack card per lead, and one summary per chat (Mark, 2026-10-15).** One chat
(jhVZZUtXp3jDrBsXOZcK) posted six "LARGE JOB SIGNAL" cards in six minutes: the model's `large_job_signal` reads the
whole thread, and the event under it was deduped but the Slack post was not. The large-job and Spanish cards in
`src/live-chat/fast-lane.js` now post only when their `emitEvent` returns a NEW row (the idempotency key is per
contact, so restarts and replicas cannot repeat it), and the fallback card posts once per chat (`alert-posted.js`,
audit `livechat_fallback`, a sliding hour). `LIVE_CHAT_LARGE_JOB_ALERT_MODE` once (default) | summary | off; the
action row keeps `large_job` every turn. `LIVE_CHAT_SUMMARY_MODE` off (default) | shadow | live: job
`src/jobs/live-chat-summary.js` (every minute; pass in `src/services/live-chat-summary-io.js`, card in
`src/live-chat/chat-summary.js`) claims each chat quiet for `LIVE_CHAT_SUMMARY_QUIET_MIN` (15) by INSERTING its
`live_chat_summaries` row first (UNIQUE contact + session start), then posts one card to **#reece-chatbot**
(`LIVE_CHAT_SUMMARY_CHANNEL`, else `SLACK_CHANNEL_DISPATCH`, C0C9AGEM2N8; never #ops-alerts, which is for system alerts,
Mark 2026-10-16); a lead who comes back gets a thread reply under their first card, in that card's channel. "Needs a
person" appears only when no other card already asked (any visitor who does not speak English, a last-turn timeout, a
large job not booked). A visitor is non-English on the Spanish hand-off (`language_handoff`) OR the model's
`escalation_category: 'language'` (`chatLanguage`; "unknown" when nothing names it): one "no English" got no flag. A chat
with nothing to act on (no outcome, flag, person line, openings, zip or market, and no real name or phone: "Guest
Visitor …" is not a name) gets no card (`worthPosting`); its row is kept with `payload.skipped = 'nothing_to_act_on'`
and is never retried (4 of the first 10 shadow chats). Never add a per-message live-chat card: put it on the summary.

**A Spanish chat visitor is named before anyone is told (the user, 2026-10-19).** "Guest Visitor ugurs" left a phone,
got "a Spanish-speaking team member will follow up" and no name was ever asked, so the addlead proxy held the LP lead
(`name-placeholder`) and the summary card named nobody. `planLanguageHandoff` (`src/live-chat/chat-rules.js`) now asks
the first name, then the phone, one per message (a phone on file is read back in the name ask), and the name rides the
chat's capture, which clears the placeholder and re-sends the held LP lead. Once a phone is known (live mode only), the
number goes to the Five9 list named by `SPANISH_FIVE9_LIST` (`src/live-chat/spanish-list.js`, rule
`LIVE_CHAT_SPANISH_LIST`; unset = off; live: `Spanish`). **It is a callback push (the user, 2026-10-19):** the Spanish
campaign runs profile "Callback Request V3", which dials on `callback_requested_at`, so the first push does what
lp-requeue does: Five9 DNC first (a hit asks for one lift review, never pushes), the re-arm (`rearmableLists` now holds
the callback list AND the Spanish list, never LP_ASAP), `callback_requested_at` on the Eastern clock, call-now, and
`checkCallbackRearm` alerts #contact-center when the list did not grow. A name arriving later is a name-only update
(`kind: 'name_update'`: no re-arm, no call-now, no new request time). Never a record without the request time: V3 skips it.

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

**A copy of the warranty asked for goes out in the same reply (Jeff Clark, 2026-10-15).** "Please include a copy of
your warranty as well" had nothing that could answer it. `isWarrantyRequest` (`src/agentic/warranty-request.js`; a
"warranty claim / repair", "under warranty" stays the service hand-off) plans the `warranty` move (before `SERVICE_RX`,
every stage, rehash too; not a hand-off, nothing filed), the SMS writer and the live chat add a prompt line, and
`enforceWarrantyReply` is a last pass: the reply says the warranty is here, never "later", and never states the 30-Day
Price Guarantee (LIB-X05). The files are `WARRANTY_PDF_URLS` (GHL Media Library, comma-separated; unset = off). Code adds
them, never the model: the LINKS on SMS and live chat (the user: a 3 MB scanned PDF by MMS is blocked or mangled), both
PDFs as Conversations API `attachments` on email. The PDFs go as they are, guarantee page included (the user's ruling).
A fulfilled request skips the analyzer's callback route; a call asked for still files. `execution_result.warranty_sent`;
checkReply `warranty_claim_without_file`.

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

**GHL tags are plain, reusable labels: never a date, an id or any other one-off value (Mark, 2026-10-14).** A lead id,
a date or a history belongs in Supabase (precedent: `rehash_stage`, above). The executor fails any `add_tag` row whose tag
holds `YYYY-MM-DD` or ends in `:<digits>` (`uniqueValueTagReason` in `src/actions/handlers/tags.js`, status `failed`,
`unique_value_tag_blocked`, before any GHL call); `executeAddTag` refuses the same for direct callers. On 2026-10-14 only
the three old rehash shapes matched in 60 days of add_tag rows. A namespaced label (`bot-off:dq`, `nepq:handoff:price`)
is fine; a value per contact is not.

**Drip tags cannot go stale (the user, 2026-10-08).** `active-<code>` tags are added only by GHL workflows (our code
only removes them; the n8n ports of the drips are inactive). Rule R7 in the daily tag sweep
(`src/tag-hygiene/rules.js`, `src/jobs/tag-hygiene-sweep.js`) removes a drip tag that no PUBLISHED workflow adds any
more (`buildRetiredDripTagsSql` over the HL mirror's `workflow_actions`; old W-names such as `active-w03`,
`active-w5.2`, `active-w11.2`). A read that fails, or finds fewer than `MIN_LIVE_DRIP_TAGS` live tags, skips R7.
`TAG_SWEEP_APPLY_RULES` (default `R7`) lets a rule write while `TAG_SWEEP_MODE` stays `report` for R1–R6; `none` turns
it off. `POST /admin/tag-hygiene/run?dryRun=true` writes nothing. Current tags left behind by a pause gate's 30-day
timeout are a GHL fix, not a guess in code: `docs/ghl-drip-tag-timeout-fixes.md`.

**A post-demo lead who asks for room gets room (Jose Perez, 2026-10-14).** He shared a hard few days and asked for
more time; his "Appreciate it, thank you again" then got the rehash track's "What would you need to see to feel good
moving forward?" (`post_demo_question_added`). `askedForSpace` (`src/agentic/post-demo-turn.js`: more/some time, "not a
good time", a hardship; never a bare "need to think about it", which the track asks back, and never a question) plans
`post_demo_space`: one warm line, no question, no time, no call pitch, for that message and for a thank-you within 48h
after it. Rule 330 no longer clears a `follow-up:*` promise on a bare thank-you.

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
- **A model `book_appointment` on SMS stands only when code fixed the time (2026-10-13, live-mode gate).** "Yes, book
  it" to two offered times booked a visit nobody picked and said "You're all set" before asking which. With NEPQ live,
  `bookingBackedByCode` (`src/agentic/sms-booking-turn.js`: booking facts that book, a pick against our own offer, a held
  time being collected, a Rehash Call pick) runs before the booking-claim guard; anything else drops the companion
  (`unpinned_booking_dropped`), so the claim is rewritten to the two real times.
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

**A rehash contact's bot message shows as the AI user (Jeff Clark, 2026-10-15).** GHL credits a message with no
`userId` to the contact's assigned user, so the bot's texts to a rehash lead read as John Manieri's own. `sendAsUserFor`
(`src/agentic/ai-sender.js`: the `rehash` / `active-f.0` tag, the rehash line or the writer's `rehash.active`) puts
`AI_SENDER_USER_ID` (3K6HtoPyBLWeQrrnSnCD; unset = off) on the Conversations API body for SMS, live chat and email.
`fromNumber` and the email From never change: email gets it only with an explicit `emailFrom`. `assignedTo` is never
written for this. `execution_result.sent_as_user_id`; send-delivery-verify reads it back and emits
`agentic.ai_sender_ignored` if GHL kept another user. Only then build the assign → send → restore fallback.

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
- **The stage:** `src/agentic/rehash-state.js`. The current lead OPPFDN with a demo in the last `REHASH_DAYS` (30) → the
  plain tag `rehash` plus an open `rehash_stage` row (contact, `lp_lead_id`, `demo_date` = the 30-day clock). It ends on a
  NEWER lead, when the lead leaves OPPFDN, or at 30 days: `rehash` comes off, the row gets `ended_at` + `end_reason` (a
  finished lead never re-enters), and a GHL owner in `REHASH_TEAM_USER_IDS` (default John Manieri) is cleared by
  `release_rehash_owner` (read back). An open row whose tag went missing gets it back (`self_heal`); a `rehash` tag with no
  row is adopted or released by the lead. Job `rehash-tag-sweep` (15 min) queues the tag rows (rule `REHASH_TAG_SWEEP`) and
  writes `rehash_stage` only after that insert succeeded; a failed `rehash_stage` read decides nothing. `isRehashContact`
  counts `rehash` like `active-f.0`. Until 2026-10-14 the lead, date and history were the tags `rehash-lead:<lds>`,
  `rehash-since:<date>`, `rehash-done:<lds>` (646 contacts); `scripts/rehash-tag-cleanup.js` (MCP `rehash_tag_cleanup_run`,
  dry run default) backfilled them into `rehash_stage` and queued their removal (rule `REHASH_TAG_CLEANUP`).
- **Calls, not visits:** a rehash call request (`lp_callback_requeue`, so `fileBotCallback` and `HOT_CALL_IMMEDIATE` too)
  skips Five9 and posts one #contact-rehash card a day (`skipped_rehash_lead`); no #contact-center card. A
  `book_appointment` for a rehash lead goes only on Rehash Call: a Confirmation Call is moved there at the same time, a visit
  is refused (`skipped_rehash_visit`), and with no `REHASH_CALENDAR_ID` nothing is booked and #contact-rehash is told
  (`skipped_rehash_no_calendar`). A lead not in rehash is never booked on Rehash Call (`skipped_not_rehash`).
  A Confirmation Call for a contact GHL has at `stage:post-appointment` goes the same way (moved to Rehash Call;
  the user, 2026-10-09): that tag is read ONLY for this, since GHL workflows own it (F.0 adds it, S1.1/S1.3/S4.5/A.WE
  remove it); it never puts a contact in rehash, refuses a visit or touches Five9 (`hasPostAppointmentStage`).
- `REHASH_ROUTING_MODE` off|shadow|live, default shadow (`rehash.would_*` events only). The LP lock is not behind it.
- **A post-demo objection gets one ask-back, one bridge, then a person; two no's stop the selling (Shawn Eastman,
2026-10-15).** "We like your product the best, but … twice the cost of our other estimates" got three rebuttals ("cheaper
bids usually cut something … folks end up replacing in five years"), more selling after "Not at this time. Thanks", and
"This is obviously an AI bot. Stop texting". `planPostDemo` returned before every objection rule and the only stop was the
track's two no's IN A ROW. Now, after `competitor_signed` and `defer`:
- **Stop:** two no's in the session (`isPostDemoNo`: a soft no like "not at this time" / "we're good" counts only as the
  answer to our offer or track question, or to a question of ours about the visit, the proposal or what changed,
  `POST_DEMO_QUESTION_RX`: the model words its own "What changed since the visit?", bot gate 2026-10-17) or the track's `stop` → `post_demo_stop` with `plan.handoff` `rehash_stop`. It is
  STICKY: after our "I'm here if anything changes." every turn stays stopped until the lead asks a question, a time or a
  call. The bot still answers; no stop-bot.
- **Ladder**, rehash line only (a post-demo lead off it may be SOLD) (`postDemoObjection`; any objection counts,
  price first): attempt 1 → `rehash_objection`, the ask-back
  (`POST_DEMO_ASK_BACK`, a reference move); 2 → the bridge with two real Rehash Call times (`rehash_offer`, "best deal"
  once) or "Would that help?" without times; 3+ → `rehash_repeat_objection` ("I'll have {rep} take a look at it and reach
  out", no offer). Both hand-offs are `NO_DIAL_REASONS` and post to #contact-rehash only (`REHASH_REASONS`).
- **Guard:** `enforceNepqPlan` drops `POST_DEMO_REBUTTAL_RX` sentences and, off a hand-off / `rehash_offer` /
  `rehash_confirm` step, `UNPROMISED_FOLLOW_UP_RX` ("someone from our team will reach out"); the plan's own line is never
  dropped and an empty body is never the rebuttal. checkReply: `post_demo_rebuttal`, `post_demo_unbacked_follow_up`,
  `question_after_post_demo_stop` (`ctx.postDemoStep`). Rule 234 `LAYER3_PRICE_ANXIETY` skips post-demo tags (the same
  incident enrolled S5.2 v2 calculator_downsell beside O.0).

**The rehash card follows what the lead said (John Manieri, 2026-10-14).** All 14 "said yes to a call" cards of
  10-10..10-14 came from `lp-requeue.js`'s rehash branch, which posted with a hard-coded `agreed: true`; 0 of the 14 had
  agreed to a call (most wanted the quote emailed). `routeRehashReply` (`src/notifications/rehash-call.js`) classifies the
  lead's words (`classifyRehashReply`, `src/agentic/rehash-intent.js`, pure): a call request → the call card; a quote ask →
  📄 QUOTE REQUEST; a complaint → ⚠️ POST-DEMO CONCERN; thanks / still thinking → no card, one
  `agentic.f0_rehash_reply_digest` event, listed by `rehash-reply-digest` (weekdays 08:45 ET, Monday covers Fri-Sun).
  A bare "yes" is a call only after our call offer. The model's own `rehash_call.agreed` (send handler) stays the real
  yes. A SOLD current lead (`lpSold`) is never in rehash, whatever `active-f.0` says. `REHASH_INTENT_ROUTING=off` is the
  rollback.

**A post-demo lead's sign-off ends the turn: no question (live threads 2026-10-15..17).** "Not ready", "Will do.
Thanks!", "I'll get back with you", "Not at this time. Thanks", "I have your number saved" each got the track's next
question (Billy: "Now you're harassing me"). `isLeadCloser` (`src/agentic/post-demo-turn.js`; never with a "?", and a
bare "Thanks!" / "Thank you I will." stays a thank-you) plans `post_demo_close`, and a first no (`door_open`) plans
`post_demo` with `no_question`, as does the stop. `no_question` turns off the guard's appended stage question and bridge
ask and drops any "?" sentence (`closer_no_question`, else `ack_line`); checkReply `question_after_closer`. A closer counts
in `isRehashNo` but is the `closer` stage BEFORE the two-no's stop, so two pleasantries never file a `rehash_stop` card; a
yes to our bridge is still the call. A stage the lead already answered (`answeredRx`) is never asked. The same text
arriving as two events (Shawn: `\n\n` vs a real newline, two refs) gets one reply: `findAnsweredDuplicateInbound`
(`src/agentic/burst-yield.js`, `normalizeText`, 15 min) skips the second as `duplicate_inbound_text`, which the reply SLA
watchdog treats as held. A `concern-expressed:` / `pre-demo-concern:` tag we write is one plain label (`cleanReasonTag`);
the O.V copy is a GHL edit (`docs/ghl-concern-tag-split.md`). GHL's naive appointment time is Eastern wall clock in
`booking-claim.js` (Melissa's correct time read 4h early), and a booked lead's phone/email-only reply restates the time
on file, never "confirm a time" (`isContactDetailsOnly`, `bookedDetailsLine`).

**After the demo the home is never turned away, and "Neither" to call times is not a no (Sam, 2026-10-19).**
IMWge24jxc0xO0ppy7OR asked about "a list of high-rises" his rep Chris had promised and got "we only work on buildings two
stories or lower"; "Neither" to two Rehash Call times got "Did you get a chance to look over the proposal?" and counted as
a no; he texted STOP. Extending the 2026-10-13 ruling (the user): `enforcePropertyScope(text, { pastDemo })` drops any
home-type or height sentence instead of the lead-side "no" (`POST_DEMO_SCOPE_LINE` if nothing is left; checkReply skips
`property_scope_lead_side` on `ctx.postDemoLead`), `planPostDemo` hands the question to the team (`rehash_scope_question`,
`REHASH_REASONS` + `NO_DIAL_REASONS`), a mobile-home LP note is a `REQUIREMENT_SIGNALS` entry, and the height DQ rules
carry `lp_had_demo: false` (`sql/seeds/2026-10-19_dq_above_2nd_floor_not_post_demo.sql`). `planRehashCall`: "Neither" /
a bare no to our times asks once "When is a good day and time for a call?" (`rehash_ask_time`; `isPostDemoNo` does not
count it, a no to that ask does), and a day or part of day gets two Rehash Call openings, never the pair just refused.

**A rehash lead's named call time is booked, and the pair on the table stays the pair (the user, 2026-10-21;
`REHASH_BOOKING_FIX_ENABLED`, unset = on, `false` = off).** kS2AJk85fv7Lfyl3iZcm answered our "9:30 AM or 10:30 AM" with
"9:30": nothing read it, nothing was booked, the model said "I'll call you at 9:30 … Would a quick call help?". Komal
(YgAD0NmDXBbyHDF82Ban) got a NEW pair after "930am", "Thursday at 6pm" and "Thursday at 2pm" (the prompt also showed the
knowledge pack's visit calendar, whose times the rep's calendar did not have) and opted out. Now, in `planRehashCall`:
`readRehashTime` (`src/agentic/rehash-time.js`: "9:30", "930am", "9.30", "at 2", "Thursday at 2pm"; the LAST time named
wins) picks from our open offer (`rehashOpenOffer`: any of our last four messages naming real openings) or books the exact
opening on the named day (`rehashTimeSlots`), else offers the two closest that day (`LINES.not_open`); a call ask, a yes or
"so many different times" re-offers the open pair (`stableOffer`); the confirm is "You're all set for {day} at {time}.
{Rep} will call you at this number then." (no question); a buying signal ("ready to move", "final costs",
`isRehashReady`) gets the call before any objection; a firm decline ("not needed at this time", "not doing windows",
`REHASH_FIRM_NO_RX`) is a first no (door_open). `enforceNepqPlan` drops a clock time that is not a Rehash Call opening and
asks nothing after a stated call time; the prompt gets no `availability` on a rehash turn; "I'll call you at <time>" is a
booking claim with `{ rehash: true }` only (`REHASH_CALL_CLAIM_PATTERNS`, booking-claim.js). checkReply
`question_after_post_demo_firm_no`. `bot_outcomes.booked_at` needed no change: it reads the HL appointment mirror. Gate:
`rehash_booking_fix` on|off, scenarios `rehash_bare_time_pick`, `rehash_named_time`, `rehash_ready_to_move`,
`rehash_firm_no`. The pre-demo bot never reads the switch (`scripts/test-rehash-predemo-unchanged.js`). A day named
with no clock time ("call me tomorrow", "Thursday afternoon") on a call ask, a yes or an open offer gets two openings
that day (`rehashDaySlots`; the open pair when it is already that day; none → "I don't have anything open …" and the
next two); after our "When is a good day and time?" the older preference branch answers (it leaves out refused times).

**The reason for a rehash call is a better price (the user, 2026-10-21; `REHASH_BETTER_PRICE_FRAMING_ENABLED`, unset =
on, `false` = the copy before, byte for byte).** "I may be able to do something for you, it's just easier on a quick
call" gave no reason, and "a couple more quotes" got "How do they compare, out of curiosity?" (Paul, Laura). Every call
invitation now says we may be able to get them a better price, in "if I could, would you?" form. The one copy home is
`rehash-nepq.js` (`betterPriceReason` before two real times, `betterPriceInvite` without; kinds generic / compare / price
/ think / itemized; `hasBetterPrice` reads it back). The ladder: price, other quotes and thinking it over get the
better-price line with the open pair at attempts 1-2 (no ask-back), a third is still `rehash_repeat_objection`; a spouse
keeps its ask-back; an itemized estimate ask (`isItemizedAsk`) gets "{rep} can walk through each window and door line by
line on a quick call, and look at getting you a better price". A call ask or yes gets the reason before the times unless
one of our last three messages said it. The model's version must keep it (`reference_markers`). In this mode the
better-price line SUPERSEDES "the best deal possible, once" (2026-10-11) and the ask-backs of 2026-10-15 for price /
competitor / think. Still never an amount, %, discount or promise (`stripOfferTalk` is unchanged; its fallback line is
the better-price question). Gate: `rehash_better_price` on|off, scenarios `rehash_other_quotes`, `rehash_call_reason`.
Tests that hold the old copy pin the switch off (`test-rehash-nepq.js`, `-objection-ladder`, `-call-slots`, `-deal-hint`).

**The bot gate's last failures (2026-10-20).** Three real bugs, one scorer gap:
- **A burst is one inbound.** The reply buffer joins a burst with newlines as the trigger, and `normalizeThread` /
  rehash `normalize()` appended it after the texts already in the thread, so "Still got a couple more quotes to come in
  / Sounds good" counted the shopping objection twice and planned `repeat_objection` (a Five9 callback) on the first
  reply. `appendTrigger` (`src/agentic/burst-trigger.js`) replaces the trailing run with the one trigger (a real newline
  or I.L3-IN's two-character `\n`). Quotes or estimates still to come in are a sign-off (`DEFER_RXS`).
- **The visit's hesitation is asked back by name.** With Siro's PRESENTATION showing price, "We are still thinking it
  over" got the generic "What's holding you back?". `visitHesitationOf` (`presentation-facts.js`) passes
  `visitHesitation` to the planner, and a post-demo "still deciding" (the situation stage's own read-back) plans ONE
  `POST_DEMO_VISIT_ASK` ("Are you still weighing the budget?", no figure); it is the ladder's ask-back, so the next
  objection gets the bridge. With `REHASH_BETTER_PRICE_FRAMING_ENABLED` on (the default, newer), a price or
  other-quotes hesitation from the visit takes the better-price line instead, exactly as a named one does (`ladderObj`);
  a spouse keeps the ask-back.
- **The live chat's reschedule path runs in every mode** (`stageLive: true` for `planCancelTurn`): an unclear answer to
  "a different day instead of cancelling?" gets one move-or-cancel question, never a cancel card, and "neither of those"
  to the re-offered times goes to a person rather than the same two times again.
- **Scorer:** the cancel identity ask is allowed by the turn's own flow step (`ask_identity`), not the scenario's name
  (`SCORING_VERSION` 2026-10-21.3). `two_texts_one_reply_sms` still counts the shadow turn lock's would-be second send
  until `TURN_LOCK_MODE` is live (a person's flip after the 48-hour check).

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

**The LP→GHL sync books from LP live, never from a stale row or a year-typo date (2026-10-15).** Five GHL visits were
booked from `lp_leads` rows LP no longer stood behind: rows synced before 2026-07-08 hold real UTC, not the ET wall clock
`lpWallClockToGhlStartTime` assumes (lead 475840: LP 10:00 AM, row 15:00Z → a 3:00 PM visit), and 2025 leads carried
visits about a year after LP last touched them (likely year typos; the contact backstop pulled them in). Every caller of
`reconcileLpAppointmentToGhl` (the `sync_lp_appointment_to_ghl` handler, the contact backstop, the admin backfill) now
calls `readLiveForSync` (`src/services/lp-live-appointment.js`) for a Set/Cnf/Issue (Verif is a hold since 2026-10-16) and passes the result in as `live`
(the reconciler stays supabase-free): LP's live time wins and the row is rewritten to it; with LP unreadable the row books
only when `synced_at >= 2026-07-08`, else `stale_mirror_unverified`. A visit more than `LP_GHL_SYNC_MAX_FORWARD_DAYS`
(120) past the lead's last LP activity is `implausible_future_appointment` and posts ONE #ops-alerts card per lead + date
(`notifyImplausibleAppointment`, claimed in `lp_sync_failure_notices`). A cancel never reads LP and is never gated. A new
caller of the reconciler passes `live` too. `parseLpApptWallClock` now lives in `src/actions/date-parsers.js`. One-time
re-read of the old rows: `POST /admin/refresh-stale-lp-appointments` / `scripts/refresh-stale-lp-appointments.js` (dry
run default; lp_leads only, never GHL).

**Verif is a hold, ND and No Demo are disqualified, and the watchdog heals appointments (Mark, 2026-10-16, handoff v3.4).**
One place for the classes: `src/lp-disposition-classes.js` (live = Set / Cnf / Issue, hold = Verif, disqualified = ND /
No Demo; GHL status Set → new, Cnf / Issue → confirmed, never Set → confirmed on the code alone; LP's confirmed checkbox is
the one exception, below).
- **Verif = "there is an issue with the lead" and starts NOTHING.** This reverses the 2026-07-09 reconciler rule ("Verif
  = a live Window Estimate, exactly like Set") and the 2026-10-06 "Verif counts as Set". The reconciler returns
  `verif_hold`; no live read, no authority seat (rank 0); no Confirmation-list add (it still comes off the setter lists,
  `REMOVE_ONLY_DSP`); no DNC lift (rule 339 is Set / Cnf only) while a DNC is still pushed to LP (rule 292); rules 338
  `LP_APPT_GHL_SYNC_VERIF` and 30 `LP_DISP_VERIF` are disabled. Where Verif SUPPRESSES (S5.2 gate, leak alerts, dial
  backstops) it stays suppressed. A GHL appointment that already exists for a Verif lead is left as it is.
- **Issue = a live appointment** (issued to a rep): classifyDisposition → confirm, authority rank with Cnf.
- **ND and No Demo = disqualified, an end state.** Rule `LP_DISP_DISQUALIFIED` (replaces `LP_DISP_NO_DEMO`'s rebook
  route) queues `disqualified_cleanup` (`src/actions/handlers/disqualified-cleanup.js`): every open estimate →
  `mark_invalid`, out of S5.x / S4.5 / W-series, tag `lp-disqualified`, P3 Hard Disqualified, one Five9 removal over every
  outbound list. **The removal runs without a click (the user, 2026-10-19: "the updates are occurring correctly each
  time")**, keyed on the rule like BOOKED_ROUTING_AUTO_REMOVE; `DISQUALIFIED_FIVE9_AUTO_REMOVE=false` is the rollback to
  approval cards. Where the card posted, ONE no-button notice says the LP disposition and that the number is off every
  dialing list (`src/notifications/disqualified-removed.js`, approvals channel; only after a real removal, never a dry run
  or an approved card; a failed post is an #ops-alerts line). **The lists come from Five9's live inventory, never a fixed
  set (the user, 2026-10-20):** a hard-coded "Data - Hot" faulted every removal for four days after that list was split
  by market. `disqualifiedTargetLists` takes every list but Sale / Rehash / Inbound Queue (a failed or empty read throws,
  the executor retries), queued as rows of 10 (`MAX_DELETE_LISTS_PER_ACTION`) in one `group`, each with
  `skip_missing_lists` (`missingListsToSkip`: a renamed list is `list_missing`, not a fault); the last chunk to finish posts
  the one notice. The 08:00 digest names a FAILED removal once, whatever the mode. Five9 refuses more than 160 single
  uploads a minute account-wide ("60 seconds limit (160)"): every `deleteRecordFromList` refusal of that kind defers the
  row 65s (`rateLimitDeferral`, up to `RATE_LIMIT_MAX_WAITS`), never fails it (the 36-lead backlog failed 25 rows on it). The S5.2 gate and rule 171 (`lp_disposition_not_in`) refuse them up front.
- **`invalid` is the no-notification kill status** (`src/appointments/mark-invalid.js`): status `invalid` (never
  `cancelled`, which fires cancel / rebook), then A.WE-1 removed, then the reminder tags off. The watchdog treats an
  `invalid` row at LP's slot as SETTLED: never restored, never re-created over, never flagged.
- **Same-slot duplicate leads (Badley).** A CXL on a lead whose sibling holds the SAME ET date and time in a live
  disposition is ignored when LP live confirms the sibling (`src/same-slot-sibling.js`): no cancel, no S5.2, the seat
  untouched, the LP Lead ID fields moved to the sibling; the field sync does the same. Every other CXL cancels as before
  (the canaries). Duplicates within 7 days are named once a day in the 08:00 digest.
- **The parity watchdog is the ONE auto-heal owner; no other sweep.** "GHL must match LP" replaces decision 541 ("Class B
  escalate only"): Class B creates through `src/services/mirror-on-link.js` (reconciler + LP live, never within 60
  minutes, canvass without notifications), which the LP contact backstop uses too; a guard refusal is never "add it to
  GHL". Class D restores a duplicate's same-slot cancel. Fix 8 (`src/appointments/estimate-drift.js`) corrects
  sync-created estimates that drifted from LP behind `ESTIMATE_DRIFT_FIX_MODE` (off | shadow | live, default shadow; cap
  25). GHL keeps no "last updated by", so "nobody edited it" means it still starts where our create put it. It never
  moves a visit to a time already past or under 60 minutes away (`lp_time_past`), and never against an endpoint booking
  made after the LP lead last changed (`lp_unchanged_since_booking`): Affeld (2026-10-17), live mode, moved a Sun 10/18
  canvass visit to 9/28 off a 2016 lead while the lead holding 10/18 had not synced.
- **A bad LP date or hour is ONE card**, "LP date/time looks wrong — confirmation team must fix in LP"
  (`notifyLpLooksWrong`, Slack, one per lead + date in `lp_sync_failure_notices`), replacing the GroupMe impossible-hour
  card.
- **The delegated booking endpoint (I.LP-IN) reads LP live first** (`src/appointments/booking-endpoint-guard.js`) and
  skips Verif, ND / No Demo, year-typo dates and impossible hours. I.LP-IN branches on `response.outcome`, NOT on the
  HTTP code (verified in the HL mirror): any outcome but created / updated / noop_already_exists makes GHL book around
  every guard. So a skip answers `noop_already_exists` + `{ ok: true, booked: false, skipped: true, reason }`; only a real
  failure answers `error`. Never return another outcome for a deliberate skip.

**GHL estimates follow LP after every LP change, and the watchdog never writes a stale GHL time back (Roberta Ritchie,
2026-10-16).** LP moved her lead 583833 from 10/17 10 AM to 10/16 2 PM and issued it in one edit; no rule routed an Issue,
Class C only emitted an event, Fix 8 sat in shadow, and Class A then wrote GHL's stale 10/17 10 AM onto her OLDER lead
579742 (Data → Set). Now:
- **LP's confirmed checkbox counts** (the user's ruling, an exception to "never Set → confirmed"): `classifyDisposition(code,
  { confirmed })` / `lpConfirmedFlag` (live first, then `lp_leads.appointment_confirmed`); sync-leads emits
  `lp.appointment_confirmed` when it flips on a Set lead (rule `LP_APPT_GHL_SYNC_CONFIRMED`). Issue syncs
  (`LP_APPT_GHL_SYNC_ISSUE`) and its date moves emit `lp.appointment_rescheduled`. The newest-lead guard reads ONE set
  (`NEWEST_LEAD_GUARDED_EVENTS`) and the `lp_lead_id` column first (field sync's `entity_id` is the contact).
- **Class A refuses an LP-origin appointment** (`src/appointments/lp-origin-guard.js`, `lp_origin_drift`): one our sync
  created, or a contact whose LP visit was in the last 72h, or whose newest lead is post-demo within 30 days. A failed
  read writes nothing to LP. Class B skips a row a NEWER lead supersedes (`ghl_create_superseded`), and `postDemoLock`
  refuses an older lead when a newer one on the prospect is Issue or post-demo (`newer_lead`).
- **Class C heals** through the mirror path (`confirm_healed`); the event stays for audit (`confirm_emitted` = not healed).
- **Class F closes the visit** (`src/appointments/post-appointment-close.js`, also rule `LP_APPT_GHL_CLOSE` →
  `close_past_lp_appointment`): once LP's visit time passed, demo → `showed` at LP's time + P1 → Appointment Completed
  (queued `move_opportunity`, forward-only), NoHome → `noshow`, CXL / CCC / NG → `cancelled`, one PUT with `toNotify:
  false`; a FUTURE GHL row against a cancel stays Class E's. `POST_APPT_CLOSE_MODE` off|shadow|live, default shadow
  (`appt.close_would_apply`): read the HL mirror's appointment-status triggers before live. Writes share PARITY_MAX_WRITES.
- **Confirmation coverage:** the clock gives a card to up to 25 linked leads a pass with a visit in the next 14 days and no
  `confirmation_opportunities` row (`readUncoveredLeads`); `CONF_PIPE_RESCHEDULED` / `CONF_PIPE_CONFIRMED` re-read the card.
Seeds: `sql/seeds/2026-10-16_parity_self_heal.sql`. Tests: `scripts/test-parity-roberta.js`.
- **Follow-up (2026-10-18).** A person cancelling the leftover GHL estimate after a demo is not a customer cancel: rules
  107 / 171 carry `not_stale_post_demo_cancel` (`src/appointments/stale-post-demo-cancel.js`: newest lead post-demo
  within 30 days, the cancelled start after its visit, no live lead at that slot; a failed read fails closed;
  `sql/seeds/2026-10-18_stale_post_demo_cancel.sql`). Roberta's Reactivation was undone by hand. A same-slot sibling is
  searched by contact, prospect AND phone (`readSlotSiblings`, `src/same-slot-sibling-io.js`: Badley's live lead sat on
  another prospect with no contact id), and the admin backfill runs the same check before any cancel
  (`cancel_ignored_same_slot_sibling`; a dry run writes nothing). Class F remembers a `wait` (2h) and a shadow `close`
  (6h) per appointment + lead + stored disposition (`settledKey`), so settled rows stop eating `READ_CAP`.
  An appointment our sync created is an LP booking, not GHL attribution: rule 87 `GHL_ATTR_APPT_BOOKED_VIA_GHL` carries
  `not_sync_created_appointment` (2,289 of 2,302 handoffs in 30 days were ours; its opportunity-field write never
  stored anything), and MCP `ghl_attribution_cleanup_run` removed the `ghl-attributed` tags it alone had added. MCP
  `post_ops_alert` posts an operator's message to #ops-alerts through `sendAlertMessage` (dry run by default).

**Every LP appointment has ONE card in "4. Confirmation Pipeline", and only LP MCP moves it (handoff, 2026-10-16).**
Pipeline `ThrBNpyzJhAON4WFC855`; no GHL workflow may trigger on it. Rules `CONF_PIPE_SET/VERIF/CNF/ND/CXL` queue
`sync_confirmation_opportunity` (`src/actions/handlers/confirmation-pipeline-sync.js`), which re-reads the contact's
NEWEST lp_leads row. The decisions live in `src/confirmation-pipeline/rules.js`: past (appointment + 2h, or a date before
today ET) → close (Confirmed won, Disqualified lost, else abandoned), CXL → abandoned, ND / No Demo → Disqualified (`isDisqualifiedDisposition`), Cnf →
Confirmed, Verif → Issue Detected (wins over the 24h rule; moving the card is the ONLY thing Verif starts, in line with the hold above), Set under 24h → Confirm Now, Set → New. `Issue` (issued to a
rep) is not mapped. Confirmed and Disqualified are locked: only ND, a Set at a new time and the close get out. A live
stage that differs from the stored one is a person's move: kept against the clock, and given way only to a NEWER LP
change. GHL allows one card per contact per pipeline, so a returning homeowner's new lead re-points the contact's card
(the user, 2026-10-16). Jobs: `confirmation-pipeline-clock` (15 min: 24h move, close, one 4h alert to
`CONF_SLACK_CHANNEL`) and `confirmation-pipeline-sweep` (00:05 ET: every open card in GHL dated before today, or with no readable date, is
closed; a failed contact read closes nothing). The board holds only appointments still scheduled (the user,
2026-10-16): a lead whose appointment LP cleared closes its card abandoned, unless the card's own lead still holds an
upcoming visit (a new inquiry with no appointment does not close it). `CONF_PIPE_DRY_RUN` is TRUE unless set to `false`: log only
(`confirmation_opportunity_log`), rows marked `dry_run`. Go-live: `POST /admin/confirmation-pipeline/backfill` and
`/sweep`. Every GHL search there carries `pipeline_id`; never touch "5. Canvass Confirmation Pipeline" or a calendar
appointment from it. The bot's `fetchOpportunity` ignores both confirmation boards (not "P1 only": `isCustomerP2` reads
P2 there), and `move_opportunity`'s duplicate-400 recovery no longer PUTs onto a card in another pipeline.

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
**The rehash rep is the follower on the lead (the user, 2026-10-15).** GHL's rehash workflow now adds the rep as a
FOLLOWER (the owner stays the Reece team user) and removes them after 30 days itself. `rehashRepFor` (`rehash-assignee.js`):
a follower (one on `REHASH_TEAM_USER_IDS` first) → the "Assigned To (User ID)" field (`7YkTgCb9IXsoQWDsP50E`; the live
rehash contact had no `followers` in the API but this field set) → null, and the caller keeps John Manieri as the
default. It picks the Rehash Call assignee, the calendar read (`readRehashCallSlots`, first name from GHL's user record
when `REHASH_TEAM_USER_NAMES` has none) and the post-demo follow-up task. `release_rehash_owner` now normally does nothing.
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
**The push is keyed number1 + LPRecKey (2026-10-15).** Keyed on number1 alone, an add for a returning homeowner
updated their OLD Five9 record, which profile DIAL ASAP V2 screens out (> 72h): 7 of 147 pushes in a week sat on
Direct Lead Entry and were never dialed (`backstopKeyFields`, the same keys `after-asap-retry` uses).
`findContactInOtherLists` is NOT used here: it has never worked in production (bare-array criteria) and
`f9_last_list` keeps the last list ever, so a naive fix would block most callbacks.
**Every cancelled lead goes to Five9 "Resets-Hot" (the user, 2026-10-15).** Nothing of ours put cancelled leads there:
of 274 leads cancelled 10-01..10-14, 103 were never called again. Job `cancel-reset-routing` (15 min,
`CANCEL_RESET_ROUTING_MODE` off|shadow|live, default live by that ruling; rules in `src/cancel-reset-routing.js`) adds a
phone whose NEWEST lead is CXL or CCC, cancelled 30 min..14 days ago, that no Reset campaign has dialed since, once per
cancel. Never sold, Five9 DNC or opted out; a failed DNC or consent read waits. Keyed on number1 ALONE, the opposite of
the new-lead backstop: profile "Resets V2" dials records created 25+ hours ago, so the phone's existing record is the
one to add.
**Every Five9 dial is stored, one row per call leg (the user, 2026-10-15, Call Journey handoff).** One row per leg with
its list, skill, attempt count and LPRecKey, transfer legs included (`five9_events_raw` has one disposition per call). Job
`five9-call-journey-sync` (`src/jobs/five9-call-journey-sync.js`, rules in `src/five9/call-journey.js`, every 15 min,
`FIVE9_JOURNEY_SYNC_MODE` off|shadow|live, default shadow) runs the saved report "Shared Reports / Call Journey" into
`five9_call_journey` (`leg_key` = call id | time | type | dnis, unique: a NULL dnis would slip past a four-column UNIQUE)
and logs every pull in `five9_call_journey_runs`. The report's zone is the setting `FIVE9_JOURNEY_REPORT_TZ` (default
Pacific, as built: call 300000010540092 printed 09:10:20; the webhook has it at 16:10:20 UTC), used for the window and the
TIMESTAMP cells. Every pull checks it against `five9_events_raw.call_start_at` for up to 20 of its calls
(`zoneOffsetVerdict`): a median over 30 minutes off fails the run before anything is stored; no match or a failed read
skips the check. Switching the report to Eastern in Five9 means setting the variable to `America/New_York` right after.
Columns are read BY NAME (a missing one fails the run), a row with no time is a counted reject and an
#ops alert, and a window at 50,000 rows is halved. `v_lead_call_journey` orders each lead's legs; **the 3-in-24 cap counts
DIALER calls only (the user, 2026-10-16)**: `calls_last_24h` is Outbound + Preview, `all_calls_last_24h` adds Manual, and
`cap_violation` is `dialer` or `manual` (a Manual call that was a 4th+ call of any kind). Every time a person reads is
Eastern (`call_ts_et`, `call_date_et`). `v_call_journey_cap_daily` rolls both up per Eastern day with the cross-campaign
clashes (two campaigns dialing one lead within 4h, DIAL ASAP → After DIAL ASAP excluded as the designed hand-off), and the
08:00 digest lists yesterday's (`callCapLines`). Baseline 10-08..10-15: 107 dialer and 395 manual violations; nearly every
dialer one was two campaigns on the lead, Data - Hot and After DIAL ASAP both opening at a record age of 25h. The fix is
in Five9 (one owner per lead by age: Simpletext 0-12h, DIAL ASAP / After DIAL ASAP to 72h, Data - Hot after), not code. A lead is its LPRecKey only when that is `LDS<n>` /
`INQ<n>`; anything else is the phone (`INQ-1` sits on the "Data -Old more than 180" records of 499 different phones). `POST /admin/five9-journey/backfill?days=N` (live only).
Five9 refuses more than 16 runReport calls a minute ACCOUNT-WIDE (the first 7-day backfill fired 28 windows in 20s; 15
were refused): windows are paced `FIVE9_JOURNEY_PACE_MS` (6s) apart and a refused one waits 65s and retries once.
Read-only against Five9; never the CI "Call Log" (`src/ci/*`, `ci_calls`), never LP call logs: Five9 is the only call source.
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
there (an unissued inquiry waits). Mark's exceptions (2026-10-06 follow-up): a Cnf or Issue lead (and, since 2026-10-16, a Verif lead: a hold, no Conf add) and a visit 3+ days out come off
right away (the 3+ day one is added two days before). A failed add is retried ONCE, then #contact-center is told (once per
visit). A visit that moved from "2nd Day" to "Next Day" comes off "Conf - 2nd Day" once the Next Day add completed. While
`BOOKED_DIAL_ROUTING_MODE=live` (and only then) the new-lead backstop pushes NO booked visit (2026-10-08: both jobs had added the same lead to the same Conf list). The
removal is `five9_delete_record_from_list` with `list_names` and `approval_expires_at` = the visit (the executor skips it
after that). It runs WITHOUT approval by Mark's standing exception to #1057 (2026-10-06: "If we're adding to one list, we
should be able to automatically remove it from the other list"), keyed on rule `BOOKED_DIAL_ROUTING` only — any other
list removal still needs approval. `BOOKED_ROUTING_AUTO_REMOVE=false` is the rollback to approval cards. Every decision is
in `booked_dial_routing_log`.
**Every upcoming visit is routed, not only new leads (the user, 2026-10-13: "we are going to start using the dialer
again").** Of 80 Set/Verif visits for today..+2 on 2026-10-13, 36 had no Conf add: 25 were on leads older than the 72h
window (a rebook, a re-set, a bot booking on an existing lead, or a visit booked 4+ days ahead), 9 sat on `lookup_cap`
every pass, 2 lost their phone to a newer form row with no visit. Now the job also reads every lead with a visit
today..+2 (`readLeadsByAppointment`), spends the Five9 lookups on adds first, soonest visit first (`lookupPriority`),
and a row holding a visit wins its phone (`onePerPhone`). A killed inbound row never wins a phone, and a row LP checked
out into a lead beats an inbound-only one (583074 lost its Thursday visit to in1 430305, a self-book killed "Duplicate").
**One Confirmation add per visit (the user, 2026-10-13: "It should only be sent once.").** In the week before, 42
visits went on "Conf - 2nd Day" two days out and on "Conf - Next Day" again the next day (the 2026-10-06 move).
`confListForVisit` now keeps a visit on whichever Conf list it was already added to (done or in flight) for the SAME
visit date (the add row's `appointment.date`); only a rebooked visit (a new date) gets a new add. LP moves a "2nd Day"
visit to "Next Day" on its own the following day (the user: "Lead Perfection should automatically update this the
following day"), so the job never re-adds it. A visit already on both lists still comes off "2nd Day" (`confMoveDue`).
The new-lead backstop's double adds stopped on 2026-10-08.

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

**Vendor lead reports read live data; LP report 135 is only a cross-check (handoff, 2026-10-15).** n8n "06 VDR" sent
nothing from 2026-10-13: every send waited on the 135 (Lead Disposition Detail 2) email. Now each due vendor gets
`GET /vdr/report.xlsx?vendor_id=&as_of=` (`src/vdr/`), built from `rpc/vdr_vendor_report` (lp_leads +
lp_lead_market_assignments + Five9 only, never `call_count`): Summary (every number a COUNTIF/COUNTIFS/SUMIFS formula
over the Leads tab), Leads (one row per lead, never an LP lead id, rep or setter) and Definitions. The window is whole
ET days, as_of's date minus lookback through as_of's date (that reproduces the approved prototype; a timestamp cut does
not). n8n blocks a send when `X-VDR-Lead-Synced-At` is 6h+ old and lists a 135 gap over 2% (`X-VDR-Feed-Leads`) in
Mark's summary, never blocking on it. The file is lead PII, so the route NEVER uses the soft-launch check (production
runs `AUTH_SOFT_LAUNCH=true`, and a token-less request got the whole file on 2026-10-15): `vdrAuthenticate` takes the
operator token or a key the database proves is the LP service-role key (n8n's "LP Supabase" credential). exceljs drops a cached formula result of 0; Excel recalculates on open.
**Every vendor sees Net Sales, RTP and Pending RTP (the user, 2026-10-19).** Net = Gross − Cancelled (job status
Cancelled, Cancelled By Mgt or Dead Deal) − Financing Denied (Credit Decline); RTP = a sold job with an RTP milestone,
not cancelled or declined; Pending RTP = Net − RTP. All on the lead's own sale amount (`gross_sale`), from the lead's
deciding job (`vdr_vendor_leads`, migration `20261019150000`: placeholder twins dropped, `lp_jobs.job_status` then 133).
A rev-share vendor's RTP tile reads "RTP (your payout basis)" and its Payable Jobs CSV column is "RTP Amount (payout
basis)". The report's RTP is by lead entry window, the pay list by release week: they never match line for line.

## Siro: the in-home visit, recorded (Siro PR 1, 2026-10-16)

`src/siro/` is the ONLY code that talks to Siro (`client.js`: two base URLs, two header styles, one credential;
client credentials preferred, `SIRO_API` legacy). Every recording goes through ONE path, `processRecording`
(`src/siro/ingest.js`), whoever found it: the webhook (`POST /webhook/siro`), the 10-minute poll
(`siro-recording-sync`) or the on-demand ensure. It normalizes (moments in the ci-moments shape, PII scrubbed, no
transcript), matches the LP lead (`resolve-lead.js`: opportunity → account → phone ±3 days → none; never the engagement id, which is
LP's APPOINTMENT id and hit an unrelated old lead on all 54 recordings it matched) and
upserts `siro_recordings`. Live only: one `siro.recording_processed` event (key `siro:<id>`) and ONE GHL demo note
(`SIRO_DEMO_NOTE`, claimed on `ghl_note_action_id` before the insert). Siro's own LP integration writes the LP note;
we never add one.
- **We keep the useful parts, not the record (the user, 2026-10-16).** `raw` is a small whitelist (`rawWhitelist`:
  ids, times, result, duration, the follow-up's type / score / status / rep / team): never GPS, emails, phones, prices,
  Siro's drafted email/text or its `thinking`. The summary is read BY SECTION (Need & Motivation → what they want,
  Objections → hesitations, Next Steps → the next step, Sentiment → how they felt). `insights` holds Siro's follow-up
  fields (main objection, why they held off, follow-up timing, scope). **Prices are kept, never stripped** (the user,
  2026-10-16: "I do not want to strip money"): the quotes sit in `pricing` and in Siro's own text, go to GHL in the demo
  note, and the PRESENTATION block shows them to the bot ("Quoted at the visit … never to be stated in a reply"). The
  reply guard (`enforcePresentationGuard`, `checkReply presentation_quoted_price`) is what keeps a price out of a text.
  Siro's concession advice ("offer the additional $2,000 to $5,000 discount", "a manager-approved discount") is NOT a
  fact: `dropDiscountTalk` (`presentation-facts.js`) removes that clause or sentence from everything the bot reads, so
  the bot never offers a concession (the rehash track's one hint is "the best deal possible"). Siro HTML, a bare "Yes."
  bullet opener and "N/A" quotes are cleaned at normalize and again on read.
  Demo notes are for NEW visits only: a recording
  older than `SIRO_DEMO_NOTE_MAX_AGE_H` (48) is `too_old`. `siro_sync_run { reprocess: true }` re-normalizes stored rows
  (no event, no note, watermark untouched); every sync pass fills a missing GHL contact id from `lp_leads`.
- **The webhook fails closed.** Every request needs a valid svix signature (`SIRO_WEBHOOK_SECRET`, raw body; the
  parser is mounted before `express.json`; `svix-*` or `webhook-*` header names). Unset, missing or wrong → 401, in
  every mode. Never log the secret. The extra `x-reece-webhook-key` header was removed by the user's ruling
  (2026-10-16): do not add it back without one.
- **The reply path reads Supabase, never Siro live.** A post-demo / rehash lead gets the PRESENTATION block in LEAD
  FACTS (`SIRO_CONTEXT_MODE`, `src/siro/context-read.js`), and Siro's own LP note is dropped from the notes then.
  The block is data, not instructions: `enforcePresentationGuard` drops a dollar figure or "your rep said" sentence,
  and `checkReply` fails `presentation_quoted_price` / `presentation_rep_quoted`.
- **F.0 v2 is the S4.5 mechanism with `workflow_code: F.0`** (`docs/f0-v2-workflow-spec.md`, a GHL build for Mark).
  The nurture orchestrator writes each text from the visit as the rehash rep; `postDemoInterrupt` (sold, not post-demo,
  rehash ended, newer lead, rebooked, team-note DQ, the two-no stop, a reply since the last touch) and the wait for
  Siro (hold 2h, up to 24h after the demo) run before any model call; `checkF0Copy` after it (one re-write, then
  `suppressed_low_conf`, never a fixed text). `NURTURE_SHADOW_WORKFLOWS` (default `F.0`) and `F0_V2_MODE=shadow`
  keep F.0 on drafts + a #contact-rehash approval card. Prompt rows: `sql/seeds/2026-10-16_f0_v2_prompts.sql`.
- Modes (all in `src/mode-registry.js`): `SIRO_WEBHOOK_MODE`, `SIRO_SYNC_MODE`, `SIRO_CONTEXT_MODE`,
  `SIRO_DEMO_NOTE_MODE`, `F0_V2_MODE` default shadow; `SIRO_ENSURE_MODE`, `SIRO_SCORECARD_SYNC_MODE` default off.
  Tools: the seven `siro_*` in `src/tools/siro-tools.js`; `siro_lead_presentation` with `preview_f0_position` is the
  dry run before any flip.

## Handoff v2: Siro's suggested text, a deal hint every reply, a person's text pauses the bot, F.0 Four-Step (Mark, 2026-10-19)

Seven rulings. Each change is behind its own flag in `src/mode-registry.js`; the defaults change nothing a customer sees.
- **1. The Siro webhook works; no change.** The poll stores a recording when recording starts and the webhook updates it
  when Siro finishes, so `source` stays "poll".
- **2. Siro's drafted follow-up TEXT is a reference, never sent as written (`SIRO_FOLLOWUP_TEXT_MODE` off|shadow|live,
  default shadow).** `followupTextFrom` (`src/siro/normalize.js`) reads the `FollowupTextHeader` context entry only (never
  the email draft, never the thinking) into `siro_recordings.followup_text`: HTML out, `scrubPii`, `dropDiscountTalk`,
  `dropMoneyTalk`, `dropSensitiveDetail`, cap 400. `raw.followup.contextHeaders` keeps the header NAMES (never values).
  Live adds one line to the PRESENTATION block and the F.0 context ("reference for topic and tone only; write your own;
  never send it as written"). A reply that is 60%+ the draft's content words fails `siro_draft_copied` (checkReply,
  `checkF0Copy`): one re-write, then the existing path.
- **3 and 4. Every rehash reply hints at a better deal, never naming it (`REHASH_DEAL_HINT_MODE` once|every, default
  once).** This SUPERSEDES "the best deal possible, once per conversation" (2026-10-11) in `every` mode only; `once` is
  today's copy, byte for byte (the prompt snapshots did not move). `src/agentic/rehash-nepq.js` is the one place:
  `REHASH_HINT_LINES` (6, Reece Team voice, no amount, %, discount, promotion, financing term or deadline),
  `rehashHintFor` (never on `NO_HINT_STEPS`: post_demo_stop, post_demo_close / closer, post_demo_space, sign_off,
  competitor_signed, defer, rehash_confirm, an opt-out, and a first no `door_open`), a fresh opener each time
  (`pickRehashHint`), and the bridge "If I could make this work better for you, would you be open to a quick call with
  {rep}?" (`rehashIfICouldBridge`; `REHASH_BRIDGE_RX` still reads it). `enforceNepqPlan` adds the plan's `hint_line` before
  the closing question when the draft has none (`rehash_hint_added`); `stripOfferTalk` no longer counts the hint as used.
  No new `_RX`: the hint lines are read back as strings (`hasRehashHint`).
- **5. A person's manual text pauses the bot (`HUMAN_TAKEOVER_MODE` off|shadow|live, default shadow).** Option B: a bot
  reply queued or drafted before it is dropped, nothing proactive goes out until the lead's next inbound, that inbound is
  answered normally, and never stop-bot, a tag or a consent row. Manual = outbound, not workflow / bulk_actions /
  campaign, not our message id, not our text (`isOurText`), not `AI_SENDER_USER_ID` (`src/agentic/human-takeover.js`).
  The read (`src/services/human-takeover-io.js`) is HL-MCP's `contact.outbound_message` events: preflight 2026-10-20, 189
  in 7 days, all `source: app` with a `messageId` and a `userId` and no body, median 3.0s / p90 4.4s after the send; 162
  matched our sends by id, the rest were people (John Manieri 23). An event we cannot match by id has its body read once
  from GHL. Unknown (a failed read, one of our sends still in flight) is never "manual": the bot sends. The check is the
  last one before a send: the SMS handler after the burst checks (skip `human_replied`), live chat `deliver`, and the
  nurture orchestrator (`suppressed_interrupt` `human_replied`, not terminal). Shadow sends and marks
  `input_snapshot.human_takeover_shadow_would_skip`. `human_replied` is an answered turn (`ANSWERED_OUTCOMES`: rules 228 /
  373 lose the turn) and a held reply for the SLA watchdog (rules 371–374 never re-answer it).
- **6. F.0 v2 texts use the Four-Step formula (`F0_FORMULA_MODE` v1|four_step, default v1).** "[FIRST NAME], [their
  hesitation]. [why that's fair]. [what they told us they wanted]. If I could [make it work better for you], would you
  be open to a quick call with [REHASH REP]?" Replies to the lead stay on the NEPQ rehash track (2026-10-16). The model
  fills four slots from `<visit_facts>` first (`src/siro/f0-four-step.js`: no price, no financing, no sensitive detail;
  the variant is Siro's MAIN objection, `fourStepObjectionType`: v1 picked "price" for 8 of 10 preview leads, Mr.
  Jackson's "decision maker not present" included) and returns `{ slots, text }`; `checkF0Copy` formula 'four_step'
  checks the first name first, "If I could" and the call question naming the rep at P1–P4, no question at P5, each slot
  in the text, hesitation and reframe grounded in the visit (2+ shared content words), and `rep_quoted`. One re-write,
  then `suppressed_low_conf`. Prompts are version-2 rows (`sql/seeds/2026-10-19_f0_v2_four_step_prompts.sql`, built by
  `scripts/build-f0-four-step-seed.mjs`), seeded INACTIVE; `nurture-prompt-selector.js` reads version 2 only in four_step
  and version 1 otherwise (`f0FormulaAllows`). Go-live: activate the v2 rows (the UPDATE in the seed's header), then flip
  the mode. `siro_lead_presentation { preview_f0_position, formula: 'four_step' }` previews them while inactive.
- **7. No sensitive detail from Siro in any text.** `dropSensitiveDetail` (`src/siro/text-guards.js`, re-exported by
  presentation-facts.js) drops the clause about a death or loss, an illness or the hospital, divorce, a lost job, debt or
  "can't afford", or age, at render time in every bot-facing PRESENTATION line and in `<visit_facts>` (the GHL demo note,
  for the team, keeps it). `checkF0Copy` fails `sensitive_detail` in both formulas. Mr. Jackson's late wife stays out;
  "family visiting for Christmas" may stay.
The gate can try every mode before Railway: `run_bot_eval` / `simulate_bot_conversation` take `siro_context_mode`,
`siro_followup_text_mode`, `rehash_deal_hint_mode`, `human_takeover_mode` (`src/simulator/sim-overrides.js`; a run is
compared only with one that forced the same modes). Scenarios `rehash_if_i_could`, `rehash_hint_every_turn`,
`rehash_hint_not_after_no`, `human_takeover_skip_one` (a `{ manual }` turn) check only when their mode is on. Rollback,
one variable each: `SIRO_FOLLOWUP_TEXT_MODE=off`, `REHASH_DEAL_HINT_MODE=once`, `HUMAN_TAKEOVER_MODE=off`,
`SIRO_CONTEXT_MODE=shadow`, `F0_FORMULA_MODE=v1`.

## F.0 v2 position 0: the post-demo email (Mark, 2026-10-21)

The evening of an unsold demo, F.0 v2 sends ONE email written from the Siro recording as the rehash rep, before the
texts, through the same `/api/agentic/nurture/generate` call (`workflow_code F.0`, `channel email`, internal position 0,
which the workflow sends as 1 since 2026-10-21, below). It replaces the old static F.0 email ("What we saw at your home"); only its job carries over. One rule, one
home: `src/siro/f0-email.js` (position, mode, hold cap, output shape); the copy checks are `checkF0Copy` formula `email`.
- **Position 0 is F.0 by email only.** The route answers any other caller `200 { error: 'unsupported_position' }`
  (never a 4xx: the user, 2026-10-21, GHL treats a non-200 as a failed step); the resolver takes 0 only when the
  route allows it (`coerceSeqPos({ allowZero })`; before, a 0 silently became the field value or 1).
- **No recording, no email.** The `awaiting_siro` hold is reused with a cap of `F0_EMAIL_HOLD_CAP_ET` (default 08:30 ET
  the day after the demo's ET date, 2h steps, the last one shorter); past it `emailGate` suppresses `no_recording`,
  clears the drafts and adds the tag `f0-no-recording` once, and the workflow sends its fixed fallback template. The
  model is never called without a recording, `force_send` included. Every other suppression is as for the texts.
- **The email**: the model fills the four Four-Step slots from `<visit_facts>` (which, for the email, also carries
  `visited_by`, the sales rep who came out, and is built whatever `F0_FORMULA_MODE` says) and returns
  `{ subject, preheader, body, ps, slots }`; `f0EmailOutput` turns the plain body into escaped `<p>` paragraphs for
  `ai_email_body_draft` (S4.5's shape) and keeps the plain body for the checks. ONE prompt row,
  `F.0-P0-email-V1` (`sql/seeds/2026-10-21_f0_v2_email_prompt.sql`, built by `scripts/build-f0-four-step-seed.mjs`,
  seeded INACTIVE; `f0FormulaAllows` lets email rows through both formulas). An inactive row is a quiet
  `email_prompt_inactive`, never the GroupMe no-prompt card.
- **Checks (formula `email`)**: the first name first, "If I could" and the call invite naming the rehash rep as the
  ONE question of the whole email (subject, preheader, body, P.S.), hesitation and reframe slots required and grounded,
  subject ≤ 60, preheader ≤ 90 and not the first sentence, body 120–180 words; never money, offer talk or the word
  "deal" (not even the hint), an exclamation, "founder", "your rep", the sales rep named twice or following up, a
  footer / address / unsubscribe line, a sensitive detail, a quote of the rep or Siro's draft copied. No signature (the
  template signs) and the thank-you opener is allowed. One re-write, then `suppressed_low_conf`: a quiet exit to
  position 1, never a fixed email.
- **The greeting name is cleaned, never the raw field (2026-10-22).** The live preview opened "Hi A," because GHL's
  first name was "a" (LP: "AJ / Anita") and any non-empty GHL name won. `greetingName` (`f0-context.js`): a couple's first
  person, a first word under two letters is no name (then LP's lead, then none), two or three typed capitals stay ("AJ");
  `applyGreetingName` puts the result (even '') in `{{lead.first_name}}` for the email and Four-Step texts, in the
  orchestrator and the preview alike. A misspelled GHL name ("gorge") is a data fix in GHL, not a guess in code.
- **The rehash rep is the follower, for every F.0 touch**: `resolveRehashRepFirst` (`f0-context.js`): `rehashRepFor`
  (2026-10-15) → `REHASH_TEAM_USER_NAMES` / the GHL user, else the `rehash_rep_name` custom value, else "Reece Team".
- **`F0_EMAIL_MODE` off|shadow|live, default shadow, decides the email ALONE** (the user, 2026-10-21: the email and the
  texts go live independently): `F0_V2_MODE=off` and the global `NURTURE_SHADOW_MODE` still stop it, but the `F.0`
  entry in `NURTURE_SHADOW_WORKFLOWS` governs the texts only. Shadow: drafts + an email card in #contact-rehash (all
  four parts; approve with **AI Msg Send Ready = Yes**). Rollback: `F0_EMAIL_MODE=off`.
- **Active-workflow guard, every nurture workflow** (`src/nurture/workflow-guard.js`): with `NURTURE_WORKFLOW_IDS`
  ("F.0:<id>,S4.5:f99fba97-6d2f-4fd6-966c-b5e5e36f8938"; the S4.5 id the field holds in the HL mirror, the handoff's
  "…8e7f2ff2e2bd" was a typo) a code with an entry is checked against the contact's Active Marketing Workflow ID
  (`VFSNtEqSUh5yX7RyktBj`, `context.lead.active_marketing_workflow_id`: '' empty, null unreadable) right after the
  context build, before the audit row: a mismatch, an empty field or an unreadable contact answers
  `200 { error: 'wrong_active_workflow' }` and writes nothing; a code with no entry is not checked.
- **A reply threads**: GHL keeps every email of a contact in one conversation, template sends included (15 of 15 S4.5
  contacts, 2026-10-21), and `inboundReplyEmailId` answers with the lead's reply id. No change was needed.
- GHL build and Railway steps: `docs/f0-v2-workflow-spec.md` ("Position 1"). Preview:
  `siro_lead_presentation { preview_f0_position: 1 }` (reads the inactive row, reports a hold or
  `no_recording` without a model call). Tests: `scripts/test-f0-email.js`, `scripts/test-nurture-workflow-guard.js`.
- **The workflow numbers from 1: email = 1, texts = 2-6 (the user, 2026-10-21).** GHL saves a numeric field set to 0 as
  blank: the first test's "Update Pre-send Fields" set 0 and the generate call got an empty position, so the email ran
  as text 1. `f0InternalPosition` (`f0-email.js`) maps the GHL number ONCE, in the generate route, before anything
  else reads it: email 1 → 0, sms 2..6 → 1..5, a legacy email 0 → 0 (`[F0] legacy position 0`), anything else
  `200 { error: 'unsupported_position' }`. Inside LP-MCP the email is still 0 and the texts 1-5 (prompt rows,
  `FOUR_STEP_WAIT_HOURS`, the P1-P5 rules, P5 terminal); the route sets `request.ghl_position`.
  `agentic_messages.sequence_position` stores the GHL number, `generated_meta.internal_position` the inside one; S4.5 and
  every other workflow keep their own numbering. The preview takes the GHL number (`numbering: 'internal'` keeps the old
  0-5 for one release). hold-complete passes the number through and the engagement route keys on the generation id.
- **F.0 can be tested on a test contact (the user, 2026-10-21).** The first test linked Mark Test to Mr. Jackson's visit by
  hand (a cloned `siro_recordings` row and a hand-made `rehash_stage` row); the rehash sweep closed the stage because Mark
  Test's own LP lead is 'Data', and every call after it was `rehash_ended`. `F0_TEST_LINKS` ("testContactId:realLpLeadId,…",
  empty = off; registered in the mode registry) + the tag `aios-test` (`testLinkFor`, `src/siro/f0-test-link.js`; both
  required, never throws): `loadF0Context` reads the linked lead's Siro rows only (no ensure, no rehash_stage, no
  lp_leads), the demo is always now − 2h, the interrupts read unsold post-demo in rehash with no newer lead, appointment
  or note DQ, sold only by the test contact's own `deal-won`, the first name is the test contact's; `siroForContext`
  reads the same visit on the reply path; the rehash sweep skips every listed contact (`testLinkedContactIds`);
  `isShadowTurn` makes it LIVE for F.0 whatever the F.0 shadow settings (`F0_V2_MODE=off`, `F0_EMAIL_MODE=off` and the
  global `NURTURE_SHADOW_MODE` still stop it); its cards start "TEST —" and its rows carry `generated_meta.test_link`.
  Nothing is ever written to, sent to, tagged on or carded for the linked lead. Never hand-make a `siro_recordings` or
  `rehash_stage` row for a test again. Tests: `scripts/test-f0-positions.js`, `scripts/test-f0-test-link.js`.

## Rehash pause + ownership (2026-10-21)

Jim Anderson (5Cp5CiWtQ2zSRlxb2XPL, LP prospect 464257): John Manieri texted him by hand from 8:40 ET while the bot
booked a Rehash Call for the wrong day (8:49), answered John's texts (8:53), asked "How do they stack up?" (8:55) and
queued a send after John set DND; every bot text was credited in GHL to John. Mark's rulings (with John and Brandon):
- **John owns the lead once a call or a visit is set (`REHASH_OWNED_MODE` off|shadow|live, default shadow).**
  `rehashOwned` (`src/agentic/rehash-owned.js`, pure): a) the `rehash-owned` tag (GHL U.RCB adds it on a Rehash Call
  booking and John adds it as his stop button; code never removes it), b) an upcoming, not-cancelled appointment on
  `REHASH_CALENDAR_ID`, c) the NEWEST lead (`fetchCurrentLead`, not `context.lp`) Cnf / Issue / Reset dated today or
  later ET. Unknown is never owned. Live: the send handler skips `rehash_owned` right after the turn claim (before any
  model call), the live chat's `deliver` too, F.0 v2's `postDemoInterrupt` ends `rehash_owned` (terminal),
  `routeRehashReply` posts no card, and the promised-callback sweep closes the bot's promise. `rehash_owned` is in
  `ANSWERED_OUTCOMES` and the SLA watchdog's held reasons. Events `rehash.owned_skip` / `rehash.owned_would_skip`.
- **A rehash-team manual text or email pauses the bot 15 minutes (`REHASH_PAUSE_MODE` off|shadow|live, default
  shadow).** `pauseDecision` (`src/agentic/rehash-pause.js`, pure) over `manualOutbounds` (`human-takeover-io.js`, every
  manual message with its user, since min(our last send, now − 15 min)), only `REHASH_TEAM_USER_IDS`: the reply is
  DEFERRED (`rehash_paused`, `retry_at` = max(last team message, inbound) + `REHASH_PAUSE_MINUTES`; the pause rides on
  `action_payload.rehash_pause`); a newer team message re-holds (`REHASH_PAUSE_MAX_RESTARTS` 12, then
  `rehash_handed_off`, silent); ownership wins on every pass; when it fires, `conversationComplete`
  (`src/agentic/conversation-complete.js`: deterministic first, one `conversation_complete` model call only when the
  words decide nothing, low confidence → OPEN, flag `completion_ambiguous`) → `conversation_complete` (no send) or the
  normal reply. A proactive send while paused is dropped. The watchdog treats `deferred: rehash_paused` as in flight
  until its retry. Once the pause is live it replaces `HUMAN_TAKEOVER_MODE` on a rehash contact (in its shadow day that contact keeps option B); every pre-demo contact keeps option B.
  Events `rehash.pause_started` / `_restarted` / `_fired` / `_would_hold`. The reads and the verdict are ONE function,
  `runRehashGate` (`src/services/rehash-gate-io.js`).
- **Scope:** the reply writer's rehash test OR any contact tagged past its demo (`isPostDemoLead` tags), never a sold
  lead. Jim's newest lead was already Issue / Cnf, so "OPPFDN in the window" read false; his `rehash` / `active-f.0`
  tags (on the 8:49 reply's snapshot) are what put him in.
- **Bot messages show as the bot.** `REHASH_VOICE_MODE` rep (default, the 2026-10-01 voice) | team: the reply writer
  keeps the rep as `callRepName` (third person, "John will call you"), signs "— Reece Team" and `enforceTeamVoice({
  forbidNames })` rewrites "I'm John" / "— John". GHL's attribution is still open: on 2026-10-21 GHL kept the AI
  user on 97 rehash sends and credited 18 to a person, always the same person per contact (Jim → his follower John,
  Eulalio → the "Assigned To (User ID)" field), never the assigned user; a controlled send (`userId` set, from each
  number) needs a tool that sets both and is the next step. Each `agentic.ai_sender_ignored` now posts one #ops-alerts
  line per contact per Eastern day (`send-delivery-verify.js`, audit `ai_sender_ignored`).
- **No comparison question on the rehash track** (ruling 4). With `REHASH_BETTER_PRICE_FRAMING_ENABLED` on the ladder
  already gives the better-price invite; `enforceNepqPlan` now drops any comparison question (`isComparisonQuestion`,
  `REHASH_COMPARISON_RX` in `rehash-nepq.js`) and puts `betterPriceInvite('compare')` in its place; checkReply
  `rehash_comparison_question`. checkReply now reads "I'll call you at <time>" as a claim on the rehash line
  (`rehash: ctx.rehash`).
- **A time on a named day is never booked on another day (2026-10-22).** Jim's 8:49 booking came from the live build
  (1434733): tomorrow's 10:00 was taken, `rehashTimeSlots` found one opening that day, and the day-blind typed-clock pick
  under it booked TODAY at 10:00. Now a named day turns that pick off (`dayBlindTimeOff` in `planNepqTurn`), one opening
  that day is offered alone ("10 AM tomorrow isn't open, but I have tomorrow at 11:00 AM ET. Does that work?"), and the
  not-open line names the day. Tests: `scripts/test-rehash-booking-fix.js` (both Jim tests).
- **Rules:** the 13 post-demo objection rules are split: `<KEY>` keeps tags + notification, `<KEY>_ROUTE` carries the
  workflow moves (plus F.0 v2's removal) with `not_has_any_tag ["rehash","active-f.0","rehash-owned"]`
  (`sql/seeds/2026-10-21_rehash_no_o0_routing.sql`). LOOP_ESCALATION_UNCLEAR enrolls in nothing, so it is unchanged.
- Gate: `simulate_bot_conversation` / `run_bot_eval` take `rehash_owned_mode`, `rehash_pause_mode`, `rehash_voice_mode`;
  scenarios `rehash_paused_after_manual`, `rehash_pause_open_question`, `rehash_owned_after_booking` (a `{ manual, team }`
  turn), `rehash_price_compare_any_attempt`. Rollback, one variable each: `REHASH_PAUSE_MODE=off`, `REHASH_OWNED_MODE=off`,
  `REHASH_VOICE_MODE=rep`.

## Revin: every text it sends or receives, one thread per contact (2026-10-19)

Until now all we kept of Revin AI's texting was its ~160-character LP summary note (`note_origin = 'lp_revin'`, still
synced and pushed to GHL as before). `POST /webhooks/revin` (`src/revin/webhook.js`) now stores every Revin event.
- **Fail closed, never soft-launch.** `X-Revin-Secret` must equal `REVIN_WEBHOOK_SECRET` (`safeEqual`); an unset secret
  refuses everything. Not `checkRequestSecret`: production's `AUTH_SOFT_LAUNCH` would let a token-less body in.
- **Store, answer, then process.** The raw bytes go to `revin_events_raw` (256 KB, `payload_hash` UNIQUE, so a retry is
  one row) with the secret header removed; 200 goes out; `src/revin/process.js` runs in `trackBackground`. A body we
  cannot parse is stored and answered 200; only a failed store is a 5xx.
- **Unknown shapes are expected.** Revin publishes no spec: `FIELD_MAP` / `EVENT_MAP` at the top of
  `src/revin/normalize.js` are the one place to adjust, and every pass logs `unmapped keys`. An unknown event is stored
  as `event_type 'unknown'`, never dropped. `contact_messages.dedupe_key` is `x:<message id>` or a hash, UNIQUE with source.
- **Read-only matching.** LP lead id → `resolveContactIdForLead`; phone → the HL mirror, lp_leads, then (first pass only)
  `resolveOrCreateContact({ create: false })`. Never creates a contact or a lead, never messages anyone. Job
  `revin-relink` (15 min) retries cut-off rows, attaches unmatched ones (no GHL token), follows contact merges and alerts
  #ops-alerts (an `error` row in the hour, or 25+ `unmatched`).
- **A Revin call event is `channel 'call_event'`, context only.** Five9 stays the only call source; never count these.
- **The bot reads Revin only with `BOT_INCLUDE_REVIN_THREAD=true` (default off; Mark flips it).** Both history loaders
  merge `readRevinTurns` (`src/revin/thread-read.js`: 20 turns / 14 days from `contact_thread_v`, cleaned and screened as
  surface `revin_thread`) through `mergeRevinTurns`, labelled "Revin (automated texting)"; off returns the same array. No
  prompt copy changed. Before the flip: `run_bot_eval` with `include_revin_thread` true vs false (a simulated lead gets a
  short Revin exchange from two days before), compared with the last gate run.
- `contact_thread_v` is the whole thread: `contact_messages` + `bot_message_context` (both sides) + sent
  `agentic_messages`, read in place.

## Call Intelligence audio comes from Five9 when the archive is down (2026-10-20)

ETG's SFTP archive (nas1.etgts.com:2282) has reset every connection since 2026-09-28. `CI_RECORDING_SOURCE=five9_api`
switches the fetch stage to `src/ci/five9-recordings.js`. That module runs the saved report `CI Call Recordings` once per
date per tick, and downloads through the Five9 REST API (`src/ci/five9-rest.js`). This domain has NO "Call Recording"
data source, so the report is built on **Call Log**: CALL ID, SESSION ID, RECORDINGS, CAMPAIGN, CALL TYPE, AGENT, AGENT ID,
ANI, DNIS, TIMESTAMP. There is no RECORDING ID field, so the SESSION ID is the download key (a RECORDING ID column wins
if a report ever has one), and a row with an empty RECORDINGS cell was never recorded and is skipped (`not_recorded`). Anything else, unset included, is `sftp`. The SFTP adapter stays as the fallback.
`createRecordingAdapter` is the one place either is built.
- **Never write to Five9 from it.** It only lists and downloads. Never change the VCC recordings server or a campaign's
  FTP setting: in Five9 a campaign FTP REPLACES the domain one and would cut GoCloud off.
- The join links on `ci_calls.five9_call_id` exactly first (`match_method 'five9_call_id'`), then the campaign + time join.
- Stored audio is always a RIFF WAV: a WAV passes through as is, and anything else goes through ffmpeg to mono 8 kHz PCM.
- Calls older than `CI_FIVE9_BACKLOG_DAYS` (30 at most) are `skipped / recording_past_five9_retention`.
- `CI_FIVE9_MAX_DOWNLOADS_PER_TICK` paces the downloads.
- An auth, permission or report failure is a source outage (`err.ciSourceOutage`): the call keeps its attempts and the
  archive breaker pauses fetching. The REST login has its own lockout breaker.
- Transcription stays on the free engine (`CI_TRANSCRIBE_ENGINE=speech`).
- Before turning it on: `GET /ci/five9-recording-probe` (read-only, returns no audio) shows which download path works
  (`CI_FIVE9_RECORDING_AGENT`, `CI_FIVE9_DOWNLOAD_PARAM`). After: `POST /ci/five9-backlog/requeue {"dry_run":false}`
  puts the SFTP-outage `failed` calls Five9 still holds back to `discovered`.

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
  `five9_remove_numbers_from_dnc_approved` (Slack, `SLACK_DNC_LIFT`; and since 2026-10-18 `AUTO_DNC_LIFT`, below). The
  approved op refuses any `approved_by` that is not a Slack user id (for `AUTO_DNC_LIFT`: anything but the one system
  approver, and only while `DNC_LIFT_APPROVAL_MODE=auto`), which is what keeps GroupMe and auto-escalation
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
- **DNC lifts run without a click, except canvassing leads (Mark, 2026-10-18).** `DNC_LIFT_APPROVAL_MODE` manual (default:
  the card, unchanged) | auto. In auto, `request_dnc_lift_review` runs the SAME `buildLiftBatch({ auto: true })` (rule
  `AUTO_DNC_LIFT`, source `auto_lift`, tag `recovery:dnc-lifted-auto`, event `consent.dnc_lifted_auto`) in the
  background (`src/consent/dnc-auto-lift-run.js`) and posts ONE notice with no buttons to #dnc-lift-approval; a failed
  step is in the notice and one #ops-alerts line. The card still posts, with the reason on its "Blocked by:" line, for a
  canvassing contact (`isCanvassingContact`: canvass tags, an LP "Canvass" source, a `canvassing_intake_marks` row), a
  check that could not be read (counts as canvassing), the new lead dispositioned DNC, or an opt-out after it arrived
  (`decideAutoLift`, `src/consent/dnc-auto-lift.js`). The Five9 op takes the system approver only for `AUTO_DNC_LIFT` and
  only while the mode is still auto at execution. Inbound capture: `INBOUND_CAPTURE_DNC_LIFT=on` (live only) lifts a DNC
  caller who would be captured, parks the row `dnc_pending_lift`, and enrolls only once a fresh Five9 + GHL read says the
  lift finished (`pendingLiftStep`).
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
**Every inbound SMS and email is checked the same way (Jeff Clark, 2026-10-15).** I.L3-IN's POST to `/webhook/ghl/reply`
never arrived for his 15:04 text (22 of 187 inbound messages in 3 days, "We have decided to go with your quote" among
them), and HL-MCP's `contact.replied` copy is read by no rule, so "processed" there means nothing. Job
`missed-inbound-sweep` (`src/jobs/missed-inbound-sweep.js`, rules in `src/agentic/missed-inbound.js`, every 60s, not in
job-registry) compares the HL mirror's `messages` (types 2/3) with our `ghl.reply_received` / `reply_channel_excluded`
and runs a missed one, 90s+ old, through `processInboundReply` (the webhook's own pipeline, every gate), claimed once
(`inbound_sweep_<id>`). No Slack; `agentic.missed_inbound_redriven`. `MISSED_INBOUND_SWEEP_MODE` off|shadow|live,
default live (the user). **An answered text is never re-driven (Shawn Eastman, 2026-10-15).** I.L3-IN relays a newline
as the two characters `\n` and the mirror keeps the real one, so every multi-line text missed its own event and got a
second answer ~10 min later (2 of 2 re-drives that day). `normalizeText` reads the escapes and NBSP as spaces, and a
message the bot queued or sent a `send_message` for (LP `agent_actions`, within `ANSWERED_AFTER_MS`, 15 min) is answered
whatever its text looks like. The mirror cannot tell a bot send from a workflow drip, so never read its outbound rows for this.

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

**A caller is captured 15 minutes after the call, and matched to their lead first (the user, 2026-10-19).** The end of
a call (Five9's disposition webhook) starts a timer per caller (`scheduleCaptureForCall`, `src/jobs/inbound-caller-capture.js`);
16 minutes later a FRESH pass runs for that caller, and a fresh pass every 5 minutes, 24/7, catches a timer a deploy lost.
A fresh pass skips calls a pass already stored before any GHL or LP read; the hourly full pass (08:00-20:00 ET) still
re-checks stored ones. The 15 minutes (`INBOUND_CAPTURE_WAIT_MIN`) are the agent's turn: 202 of 222 inbound callers
agents entered in 30 days were in LP within 5 minutes of the call ending, 207 within 15. `INBOUND_CAPTURE_INSTANT=off`
restores hourly only. The view `v_new_callers_no_lp_30d` is no longer read (~20s a pass, and it drops any phone with an
LP lead EVER): `buildCallersSql` has its filters, drops only a caller with a lead from the 15 days before the call, and
`src/inbound-capture-match.js` decides the rest (option B): an LP inquiry still waiting to be checked out, or a lead
from the last 15 days, is the caller's lead (`already_in_lp`, nothing created); only older leads make a returning
caller, captured as a NEW lead, unless LP changed an older lead from an hour before the call on (the agent
worked it for this call: 9419281328's visit went on their 2023 lead, 2026-10-19; `lastChangedOn` / `updated_at_lp`,
Eastern wall clock, `lpTimeMs`). It reads lp_leads (by phone, alt phone, the contact's LP Lead ID), `lp_inbound_queue`,
then LP live by phone (`findExistingLpLead`, exported from lp-lead.js) when those settled nothing: lp_leads holds 16% of
February's and 5% of April's leads. A failed read is `unverified`, never "no lead". 8e30ff37 skips any contact whose LP
Lead ID is filled ("Already Sent to LP?"), so a returning caller's old id is cleared, read back and noted on the contact
right before the enrollment (`clearOldLeadId`); one that will not clear is not sent.

**A chat lead reaches LP as Reece ChatBot, and a returning lead who chats gets a new one (the user, 2026-10-19).**
"Any lead … created by the Chat Widget … sent to lead perfection with the Reece Chatbot as the source. Any lead … over
15 days old and engages with the chatbot then should be sent back … with the Reece Chatbot as the new source." New chat
contacts: rule 386 pins `srs_id 830 / pro_id 5574` (`sql/seeds/2026-10-19_chat_lead_reece_chatbot_source.sql`) and the
chat-lead intake sweep stamps them (read back) before enrolling. Returning leads: job `chat-return-lead`
(`src/jobs/chat-return-lead-sweep.js`, rules in `src/chat-return-lead.js`, every 15 min, `CHAT_RETURN_LP_MODE`
off|shadow|live, default live by that ruling) takes a quiet (60 min) conversation with the chatbot on a contact added 15+
days before it: a `LIVE_CHAT_FAST_LANE` turn, or an SMS bot reply to the lead's own text (the user, same day: "I want the
chatbot replies and the text message replies to the bot to be counted"; a completed SMS `send_message` whose event is
`ai.analysis_completed` / `agentic.reply_unanswered`, never a `DQ_*` reply or POST_BOOKING_EMAIL_ASK), runs the inbound capture's lead match (`readLeadMatch`: a lead from the last 15 days, an open inquiry or
an older lead worked for this chat is theirs, nothing made), then stamps 830 / 5574 OVER the old source (read back),
clears the old LP Lead ID (`clearOldLeadId`, read back, a note) and enrolls 8e30ff37. Never a sold customer, a live
visit (Set/Cnf/Issue today or later), a rehash lead (`rehash` / `active-f.0`, a demo in 30 days) or an opt-out tag;
once per contact per 15 days (`chat-return:<id>`), each chat decided once (`chat-return-seen:`). No card.

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

**A P2 card is Won only once the job is installed AND paid (the user, 2026-10-20).** "The only time an opportunity in
pipeline 2 should be considered won is if the project is installed." Rule 366 `P2_JOB_TERMINAL_WON` closed cards Won on
the job status alone (Paid In Full, PIF Survey Ready, PIF NO Survey, Assumed Complete) and left the stage: 106 Won cards
sat before "7. Install Completed". `isWonJob` (`src/lp-job-terminal.js`: a collected status AND `isInstalled`, a passed
Install End (F) or Completion (C) date, `job_stage` 'complete' or a passed `install_completed_date`; `install_completed`
is never written) is the one test, used by `decidingJob` (so the sale backstop's `create_won` and the create guard), the
reconciler, and the executor guard `decideP2Win` (`src/p2-won-guard.js`), which every P2 `update_opportunity` won runs
through: it refuses (`skipped`, `won_before_install` / `won_job_not_collected` / `won_no_lp_job` / `won_jobs_unreadable`,
fail closed), closes only the OPEN card, and moves it forward to Install Completed. Installed & Unpaid stays open until
paid. A job paid before its install is won when the install lands: the F/C/I/B milestone rules carry a win step
AFTER their move (`sql/seeds/2026-10-20_p2_won_requires_install.sql`), so the card enters Install Completed open
and GHL C.2 (stage 7 AND status open) still starts; a separate win rule would race the move. Backlog:
`scripts/repair-p2-won-before-install.js` (dry run default). GHL's C.4 Review Solicitation fires 14 days after a card
reaches Install Completed with no status condition, so moving long-installed customers there can send a review ask.

**Every P2 card sits where LP says the customer is, and drift is healed (the user, 2026-10-20: "zero deviation from the
source or what is in LP").** The 2026-10-20 audit found 325 of 3,270 cards out of step: cards moved only on events and
only forward, so a lost, suppressed or mis-ranked event (H over R, fixed in `src/milestone-order.js`) was never retried.
Job `p2-parity-sweep` (`src/jobs/p2-parity-sweep.js`, every 30 min; rules `src/p2-parity/rules.js` pure, I/O
`src/p2-parity/sweep.js`) compares every card with LP: the tracked job's status (lost → lost with its reason and L.6;
`isWonJob` → won at Install Completed or later; else open), the furthest PASSED milestone from BOTH `raw_lp_data` and
`lp_job_milestones` (each misses rows), mapped by the live `P2_MILESTONE_*` rules (`src/p2-milestone-map.js`), and the
job's value. Rulings: a card ahead of LP moves BACK; a repeat buyer's one card follows the NEWER live job (re-stamped,
reopened; never a placeholder or near-duplicate). A card whose tracked live job looks like a copy of a paid job (`looksLikeDuplicateOfPaidJob`) is a report (`possible_duplicate_of_paid_job`), never a write: the first live pass reopened Brandon Carter's installed, paid Won card onto such a copy. Every bulk read is paged (`selectAllIn`, `src/supabase-page.js`): unpaged, PostgREST's 1,000-row cap dropped a different set of milestones each pass and ~15 cards flipped between stages 7 and 8 every 30 minutes on the first live day. Every difference is re-read live from GHL first; a card changed in the
last 30 min waits; anything unreadable writes nothing; `P2_PARITY_MAX_WRITES` (50) a pass, status first.
`P2_PARITY_MODE` off|shadow|live, **default live** (the user, 2026-10-20: "go live right away because no messages are
firing"; `p2.parity` done / failed / would_change events). Every P2 loss (the sweep's, and rule 365's through
`executeUpdateOpportunity`) also takes the customer out of C.0–C.5 (`src/p2-parity/customer-workflows.js`): GHL L.6's
removal list has none of them, and GHL's API can remove a contact from a workflow but cannot edit one. The repair tag
`p2-stage-heal` (moves into stages 4–8 of an open card) is OFF until `P2_HEAL_TAG=on`: turn it on only once GHL
C.1/C.2/C.4 have the first step that consumes it, or the tags sit and swallow each customer's next real update. The GHL
edits only a person can make are `docs/ghl-p2-customer-workflow-fixes.md` (C.0-IN's backward reset first; until then the
sweep reverts it within 30 minutes). No LP job is a report, never a write (`scripts/repair-p2-missing-lp-jobs.js`).

**A partner's LP leads are owned by the partner in GHL (Mark, 2026-10-19).** A NEW lead in an outside sales partner's
LP branch (Ross Erstling → RFED, any rep) gets the partner's GHL user as the contact owner AND on every open opportunity;
when it leaves the branch the owner returns to `PARTNER_DEFAULT_OWNER_ID` (the Reece team user). LP → GHL only, never a
write to LP, never a messaging, tag or workflow change. The mapping is data (`partner_owner_map`: branch + optional rep;
an exact branch + rep row beats the branch-only row; migration `20261020200000_partner_owner_sync.sql`). The decision is
`syncPartnerOwner` (`src/partners/owner-sync.js`), called by `processProspect` after every lead write (a branch or rep
change now always writes the row) and by job `partner-fast-poll` (every `PARTNER_POLL_MS`, 90 s: LP changes since its own
cursor, filtered locally to partner branches, plus retries of `failed` / `no_ghl_contact`). Rules: the contact's NEWEST-CREATED
lead decides (`newestLead`, never `pickCurrentLead`, whose Data shadow let an older BOCA ND lead outrank the RFED test
lead 583364; the user, 2026-10-20); a lead counts when created after `PARTNER_GO_LIVE_AT`, moved into the branch, CHANGED
by LP after go-live (the user, 2026-10-20: "If we assign it RFED, it should go to Ross"; the branch decides, never the
zip), or already aimed at a partner (RFED leads LP has not touched since go-live stay as they are); with no match the owner changes
only for a contact THIS code assigned (an open `partner_owner_assignments` row, written before the GHL write, released
on the return) whose owner is still that partner, and returns it to the Reece team user 3K6HtoPyBLWeQrrnSnCD (handoff v3,
2026-10-20); an internal owner is never touched; a dispositioned lead that stays in the branch keeps the partner.
**A partner GHL put on the contact is never ours to move (handoff v3):** GHL S5.2 Appointment Rescue v2, branch "I. 1
Leg", assigned 1 Leg leads to Ross itself (Mark turned that tag step off on 2026-10-22; below). With no open assignment for that partner, a return or a reassign is logged
`skipped_not_ours` and nothing is written; a matching lead already owned by that partner is a `noop` and creates no
assignment. Every write is read back (a kept owner is `failed`), noted on the contact, logged in
`partner_owner_log`, and posts ONE card per lead + reason + owner to `PARTNER_ALERT_SLACK_CHANNEL` (`alert-posted`, unset
= log only). A partner is an OWNER, never a follower: GHL's "Only Assigned Data" keys on the owner. An open card in a pipeline the partner's GHL user cannot see (GHL 400 "does not have permission to access this pipeline"; Ross has no "3. Recycle, Lost, Deferred …") keeps its owner and is logged as `opportunities_skipped_no_pipeline_access`, never a failure (the user, 2026-10-20). Off with
`PARTNER_SYNC_ENABLED=false` or `PARTNER_GO_LIVE_AT` unset. `POST /n8n/admin/partner-owner/run {lp_lead_id, dry_run}`
(strict operator token, no soft launch) and `GET /n8n/admin/partner-owner/status`. Side effect: GHL credits a bot message
with no `userId` to the contact owner, so bot texts to a partner lead show as the partner in GHL.
**The partner's GHL tag is what tells the partner (the user, 2026-10-21).** "When a lead has the tag applied phone-team
this is what triggers the lead being assigned to Ross and a notification sent to Ross." `partner_owner_map.ghl_tag`
(Ross / RFED: `phone-team`, migration `20261021120000_partner_owner_tag.sql`) is added, read back, right after the sync
makes the partner the owner, and on a `noop` whose contact lacks it; GHL "U.RFED Lead Assigned to Phone Team" fires on
it. A failed tag keeps the owner and is retried next pass (the memo needs `detail.tag.present`). The return removes it
only for a contact WE assigned. The customer gets ONE SMS and ONE email, both GHL's (S5.2 / U.RFED): `phone-team` is
in the send gate's OPERATIONAL_HOLD and the legacy SUPPRESS_TAGS (outreach only; the bot still answers every reply),
and `executeAddToWorkflow` refuses any code enrollment but S5.2 for it (`skipped_phone_team`;
`PHONE_TEAM_HOLD_ENABLED=false` is the rollback). The bot tries to book the call: since 2026-10-22 ONLY a `phone-team`
contact gets the phone presentation (same calendar, same hold, same both-decision-makers question; a 1 Leg state alone no
longer does), and the booking guard reads the tag live. Gate scenario `phone_team_books_call`.

**A partner-owned lead leaves every Reece Five9 list, and GHL's hand-off is seen (handoff, 2026-10-22).** Micaella
dialed Ross's 1 Leg leads after GHL had handed them over. `ensurePartnerFive9Removal` (`src/partners/five9-removal.js`)
takes every phone on a partner's contact (GHL phone + additional phones + lp_leads phone / phone_alt) off every list
in Five9's LIVE inventory but Sale / Rehash / Inbound Queue (`disqualifiedTargetLists`), as unarmed
`five9_delete_record_from_list` rows (rule `PARTNER_FIVE9_REMOVAL`, number1, 10 lists a row, `skip_missing_lists`).
**The partner's GHL tag is the trigger (the user, 2026-10-22: "When a lead gets tagged phone team then it should be
removed from all Five9 dialing list").** The tag processor (`processTagUpdate`, `src/ghl-tag-handler.js`) hands every
diff to `partnerTagTrigger` in the background: `phone-team` added → the removal, removed → the release. A partner OWNER
still qualifies as a backup (`partnerFor`: owner first, then tag): the three known Ross 1 Leg contacts were Ross's with no
`phone-team` on 2026-10-22, and adding the tag ourselves would fire U.RFED's customer SMS and email. A release needs both
gone, read live. The owner sync calls it on assigned / reassigned / noop / skipped_not_ours, and job `partner-five9-sweep` (30 min) on every
contact that may be partner-owned (open assignments, partner_owner_log, our removals, `contact_tag_snapshot` with the
partner tag, HL-mirror `phone-team` and `sent:s5.2-1leg-*` tags), read live (GHL tag webhooks can be lost): a 1 Leg lead sits on its ORIGINAL market's lead, which the sync never sees. LP's own
Five9 export refills the lists at 6 AM ET (nothing in LP-MCP or n8n loads them, so code cannot filter it): the removal
is claimed once per "removal day" (ET date of now − 6h20m) per mode in `partner_five9_removals`, so the first pass after
each load removes again. Never the Five9 DNC (it collides with the DNC Lift); a return (`returned`, or the sweep finding
the owner back with Reece) writes a release row, marks queued rows skipped, and LP's next load restores the lists. The
sweep reads back enforce groups (`detail.five9.removed_from`) and posts ONE ⚠️ card per failed group or failed
inventory read. A partner GHL put there (rule 3b) is still never moved, but posts ONE "🤝 PARTNER LEAD ASSIGNED →
<partner> (set by GHL)" card per lead (reason `assigned_by_ghl`, same key as the sync's cards). `PARTNER_FIVE9_REMOVAL_MODE`
off | log (default: records `mode='log'` rows only) | enforce; the executor runs the rows unarmed only while it is still
enforce. `POST /n8n/admin/partner-owner/five9-sweep {dry_run}` lists every partner-owned contact and the lists it would
leave (dry run default). The real fix is LP excluding partner-owned leads from its export (ask LP).
**One-Leg → RFED: a NEW RFED lead in LP is the only way a lead reaches Ross (Mark, 2026-10-22).** No automatic day-3
hand-off (`src/one-leg/day3.js`, job `one-leg-day3`, `one_leg_handoffs`, `ONE_LEG_RFED_MODE` were NOT approved; see
`docs/ghl-one-leg-day3.md`). Mark turned off S5.2 "I. 1 Leg"'s `phone-team` step (verified live 2026-10-22: disabled, and no
step in that branch assigns an owner). The one trigger stays: a new LP lead on
RFED → the partner sync makes Ross the owner and adds `phone-team` → U.RFED + the Five9 removal. **The promoter rule
(replaces the 2026-10-21 "Promoter blank for canvass"):** an RFED lead copies Source, Sub-Source AND Promoter from the
original lead, canvass included; Promoter is blank only when the original had none; a promoter name that does not match
exactly one LP promoter id BLOCKS the row, never sends it blank. **LP's API cannot do it:** every create path (addLead,
`/api/Leads/LeadAdd`, `/api/Leads/AddLead`) lands in the inbound queue, LP picks the branch from the zip (no inquiry landed
on RFED in 21 days; the RFED leads since 10/01 were moved there by hand), and LP's auto-import took 0 of 974 inquiries
whose phone was already in LP. So Mark's 50 (`MARK_50`, `src/partners/rfed-batch.js`, pure) are created in LP directly
(LP support or a person, from the sheet), and the original 1-Leg lead stays as it is. `src/partners/rfed-batch-run.js`
(`POST /n8n/admin/partner-owner/rfed-batch`, CLI `scripts/rfed-1leg-batch.js`): `plan` (read-only; skips a sale, a DNC
of any kind, a new live appointment, a newer lead, a waiting inquiry or a lead no longer 1Leg; an unreadable read
blocks; `sheet: true` returns the LP lines to the caller only), `record` (approved ids → `partner_rfed_batch`), `verify`
(the RFED lead with the same fields, Ross the owner, `phone-team`, a `partner_five9_removals` row). It never writes LP,
GHL or Five9. **The guard: Ross owns it in GHL ⇒ it must be RFED in LP.** `src/partners/rfed-integrity.js`, run in the
partner Five9 sweep's loop after its live read (no extra GHL reads): a contact whose live OWNER is a partner (a tag alone
is not) must have its newest LP lead (`newestLead`) on the partner's branch, with the Source / Sub-Source / Promoter of the
lead it came from (the `partner_rfed_batch` origin, else the newest 1Leg lead on the prospect within 180 days; none →
branch only, since a lead LP moved to RFED is its own original). A failed read or no LP lead is "could not tell": no card.
ONE card per contact + mismatch set to `PARTNER_ALERT_SLACK_CHANNEL` (audit `partner_rfed_integrity`, permanent), never
a fix. `PARTNER_RFED_INTEGRITY_MODE` off | log (default: `job_runs.detail.integrity` / `integrity_hits`) | alert; the
scheduled pass needs `PARTNER_FIVE9_REMOVAL_MODE` on, and `POST /n8n/admin/partner-owner/rfed-integrity {dry_run}` runs it
alone. A chat session has no operator token, so the same runs are MCP tools: `partner_five9_sweep_run`,
`partner_rfed_integrity_run`, `rfed_batch_run` (`src/tools/partner-tools.js`, dry run / read-only by default).
**A phone-team contact is offered a phone presentation, both decision makers on the call (Mark, handoff v3, 2026-10-20;
phone-team ONLY since 2026-10-22).** Only a contact tagged `phone-team` gets it (an open `APPOINTMENT_DISRUPTION.one_leg`
state alone no longer does: a 1 Leg lead reaches Ross through a new RFED lead, above):
`phonePresentationActive` (`src/agentic/one-leg-presentation.js`; SMS, not post-demo, not rehash) passes the real
openings of `PHONE_PRESENTATION_CALENDAR_ID` to `planNepqTurn({ phonePresentation })`. Two times (`pp_offer`), a pick is
HELD while the lead is asked "will both of you be on the call?" (`pp_hold_dm`), only a yes books it (`pp_confirm` →
`phonePresentationBooking`, `phone_presentation: true`, `decision_makers_present: true`), "just me" asks for a time that
works for both (`pp_dm_no`); any plan that would still offer VISIT times offers these instead, or none
(`phonePresentationOffer`). The price is gone over on the call, never a number in a text. The calendar is GHL-only
(`isGhlOnlyCalendarId`: a 1Leg lead is post-issue, so an LP SetAppointment would mint a new lead), `executeBookAppointment`
refuses it for any contact without a live-read `phone-team` tag (`skipped_not_one_leg`, reason `not_phone_team`, fail
closed) and leaves its assignee to the calendar. Every other contact, a 1 Leg lead with no tag and a "my wife isn't home"
new lead included, keeps the normal offer (scenario `one_leg_phone_presentation` checks it). GHL S5.2 "I. 1 Leg" still
owns every 1 Leg message and its timing: this is a reply branch only, never a sender. Live chat does
not take it (its fast lane has no objection state). `ONE_LEG_PRESENTATION_MODE` off|live, default live, inert until the
calendar id is set. `recovery_cadence` on `objection_state_policies` is informational (nothing in src/ reads it); the
one_leg row reads days 0/3/5/8 (sms, sms, email, sms) to match the workflow, and `recovery_touch_count` stays as it is
because the S5.2 enrollment payload carries it.

**Marketing cost is a ledger, not an LP field (Mark + Brad Codman, 2026-10-12; `supabase/migrations/20261012222106_158_marketing_cost_ledger.sql`).** Report 136 and LP cost entry
are retired: nobody types a cost into LP again, and no code reads `mcost_cents` for a cost. The money lives in
`marketing_expenses` (invoice lines, Lead Gurus feed days, commission rules) and is split per month and market in
`marketing_expense_allocations` by GROSS ISSUED LEADS (D1: `ever_issued` by `created_at_lp`, `mkt_issued_counts`); Net /
Working / Gross $ come from report 133 (`mkt_sales_dollars`, D8). The allocator is ONE pure module,
`src/marketing/allocation.js` (direct / proportional / equal / hold, cents reconciled or it throws); the rows are written by
`allocation-io.js` and re-run nightly (`marketing-cost-nightly`, 02:30 ET, current + prior month). Commissions are also
recomputed the moment a report 133 snapshot lands (`recomputeAfterSalesSnapshot`, `lp-csv-ingest.js`; the user,
2026-10-19): the 02:30 run read the day-old snapshot (Fort Myers Canvass at 15% × $322,390 against the day's $276,190).
A campaign with no sub-source reads "Unknown" in the XLSX and on the dashboard, never "(none)" (`campaignLabel`). **Commission rules (the user, 2026-10-19):** Canvass 15% of net is an ESTIMATE until canvasser payroll reports are
uploaded (rule basis `net_sales_estimate` → rows `provisional` + flags `{estimate}`, `isEstimateRule`), MVP Marketing and
LeadPilotData 15%, Previous Customer / Referral 1%; all are lead-source cost. Net = jobs released to production (RTP) or
completed, so a commission on net is a commission on RTP'd dollars. Seed: `sql/seeds/2026-10-19_commission_rules_leadpilot_canvass_estimate.sql`. The dashboard and
Brad's XLSX (`marketing-cost-report`, formulas never typed values) read `v_market_subsource_cost`.
- **No routing or account number is ever saved (the user, 2026-10-19).** "We do not save any of the Lightfire Routing
  and Account numbers. Or any routing or account numbers." `redactBankDetails` (`src/security/bank-redact.js`, pure)
  runs once in `ingestInvoice` right after extraction, before the text is stored, triaged, screened or sent to the
  model (a retry's stored text too), and again over the email-body `.txt` copy, the subject, the model's analysis
  (`redactBankDeep`), ledger descriptions and error lines. Labelled values (routing / ABA / RTN / transit, account /
  acct / A/C, checking / savings / DDA, IBAN), the rows under such a header, and an ABA-checksum 9-digit run near a bank word become
  `[routing number removed]` / `[account number removed]`; no last four. Already-saved numbers: MCP
  `invoice_bank_redact_run` (counts only, dry run default; `scripts/redact-saved-bank-numbers.js`). Original PDFs and
  photos are KEPT but open for dashboard admins only (the user's ruling); the Slack card carries no file link. A new
  place that stores invoice text runs the same function.
- **The invoice decision routes fail closed; the email intake does not (security review, 2026-10-19).**
  `LP_REPORT_INGEST_SECRET` was unset, so `/n8n/admin/marketing-invoices/*` (`/decide`, `/dispute`, `/refresh-cards`)
  and `/marketing-expenses/*` took anyone's request. They pass `FAIL_CLOSED` to `refuseIngest` (503 with no secret,
  whatever `AUTH_ENFORCE_MODE` says); the Slack buttons are signed separately and keep working. The ingest route and the
  scheduled report / nightly triggers keep the old posture (open while unset, enforced once set) so emailed invoices and
  the OPS.MCRP report never stop on a deploy (the user: "people can still email the invoice"); an invoice that arrives
  with no secret configured is flagged `arrived_without_intake_password` and never auto-approved.
  A vendor only the model matched (`vendor_matched_by_ai_only`) or a revision of an approved invoice number
  (`replaces_approved_invoice`) is never auto-approved, and a commission invoice looks up at most 20 lines in LP live.
- **An invoice file never reaches a paid model (D9).** n8n `I.MCIN` POSTs the attachment to
  `/n8n/admin/marketing-invoice-ingest`; `src/marketing/extract-client.js` gets the TEXT for free from reece-speech-api
  `/v1/extract` (pdfplumber + Tesseract) or in-process for CSV/XLSX/body text; only that text goes to
  `mkt_invoice_analysis` (rules first, model second, rules win on total and invoice #, `analysis-schema.js` is strict).
  The text is untrusted: cleaned, screened (`guardrail_decisions` surface `invoice_text`), and nothing in it can run
  anything — the only outputs are ledger rows and a Slack card.
  **The ingest route has its own 40 MB body parser, mounted BEFORE the global `express.json()` (2026-10-19).** A PDF
  arrives base64 in JSON; the global 100 kB default answered 413 to all six LightFire invoices (~390 KB each) before
  the route's own parser ever ran (`invoiceBodyParser` / `INVOICE_INGEST_PATH`, `scripts/test-marketing-invoice-body-limit.js`).
- **LightFire is call-center cost, and each charge goes to the office of its leads (the user, 2026-10-19).** "If there
  were 10 demos at $250 each set in Fort Lauderdale, then those should all be assigned to Fort Lauderdale. The same
  applies to the 1.5% sales." Never split evenly. Vendor "LightFire Partners"
  (`sql/seeds/2026-10-19_lightfire_call_center_vendor.sql`) is Call Center; `callCenterLineKind` reads each line's
  kind from its description ("Demos - AGED", "Sales 1.5%", "Canvas") and `callCenterWorkByMarketFor` weights it by the
  events payroll pays LightFire for in the line's own days (`buildLightFireEvents`, "- LF" agents): aged-lead demos
  set (count), net dollars RTP'd on new leads set (report 134; the job's market, else the lead's), canvass appointments
  confirmed (count). August check: canvass 194 of 194, demos 9-13 of the 12-17 billed a week, sales $179,513 vs $169,254;
  the shares come from our records, the amount from the invoice. Still "Call Center"; nothing found yet → REECE_HOLD
  with a note, re-run nightly, never a hold recommendation; a call-center line naming none of the three stays even.
  Read from the description, so an Edit to "call center cost" keeps it. A $0 line beside billed lines is dropped at
  build (`buildExpenseRows`): kept, it blocked Approve on a multi-line invoice Edit could not fix.
- **Accept as received, dispute what was billed but not found (the user, 2026-10-19: 12 demos billed, 9 found).** A
  call-center line billed for MORE than we found (`callCenterGap`: found × the pay_rules unit price, a gap of half a unit
  or a dollar of sales) splits the found part by office and parks the rest on market `DISPUTED` (rule 'hold': the rule
  CHECK allows no other; never REECE_HOLD, never a hold recommendation) with "billed 12 aged-lead demos, found 9: 3 not
  found ($750.00)". Finding more just splits. Such an invoice is never auto-approved (flag `billed_more_than_found`).
  It is settled three ways: a revised invoice with the same number replaces the approved original on approval
  (`replaceEarlierInvoice`: old lines `superseded`, allocations gone, `analysis.replaced_by`); **Confirm charge**
  (`mktinv_dispute_accept`, flag `dispute_accepted`, the whole line split by office); **Credit received**
  (`mktinv_dispute_credit`, the line's amount drops by the disputed part, flag `dispute_credited`, `analysis.credits`).
  The nightly re-run shrinks a dispute on its own when the missing leads sync.
  **The dashboard's invoice view settles it too (the user, 2026-10-19: "update the credit received, confirm the
  charge, or reopen a disputed amount").** `settleDispute` (`review-actions.js`) is the one routine for the Slack buttons
  and `POST /n8n/admin/marketing-invoices/dispute {document_id, action: accept|credit|reopen, amount?, by}`
  (`settleDisputeFromDashboard`, admin-only on the dashboard): a credit may be part of the disputed amount (the rest stays
  Disputed), and a dashboard credit first undoes any earlier confirm or credit (`reset`), so it can be changed; a
  reopen puts the line back to what was billed. `analysis.credits` holds the credits in force (`was` = billed),
  `analysis.dispute_log` every action; a confirm keeps a credit already received. The Slack card is redrawn and gets the same thread reply.
  **The invoice view also approves, rejects, reopens and edits (the user, 2026-10-19: "View and Edit … doesn't allow any
  edits").** `POST /n8n/admin/marketing-invoices/decide {document_id, action: approve|reject|reopen|edit, edit?, by}`
  (`decideFromDashboard`) runs `handleMarketingInvoiceInteraction` itself, as approver `DASHBOARD` (the dashboard lets only
  its admins, Mark and Brad, click), with `parsed.edit` = the fields `parseEditSubmission` returns. A Slack reply that
  would have replaced the card redraws the card instead; an ephemeral one (a blocker) is the answer the dashboard shows. Sales weights are WHOLE dollars, and the
  card prints every basis in words (`basisText`: "$41,827 of $179,513 in sales", "3 of 9 aged-lead demos", "12 of 40
  issued leads"), never "4182700/17951276 issued".
- **A commission invoice line is one sale: it goes to that sale's office and month, and replaces the estimate (the
  user, 2026-10-19).** LeadPilot INV-000088 ("David Shadlick $68,000 … Sold on 09/14/2025") landed on Fort Lauderdale
  from LeadPilot's own letterhead (West Palm Beach); the sale was David Shadick's (Prospect 449431), an Orlando lead,
  contract 8/26/2026. "If the lead wasn't created in Fort Lauderdale, it shouldn't use Lead Pilot's office address. We
  need to locate that lead in Lead Perfection if it isn't in our database." For a vendor with `default_cost_type`
  'calculated', `matchCommissionInvoiceRows` (`src/marketing/commission-invoice.js`) finds each line's sale: the
  vendor's sub-source + the sale amount (printed, else line ÷ the rule's rate), confirmed by `nameMatches` (one typo
  allowed; a same-price stranger is refused), in lp_jobs / lp_leads, then LP live (`GetCustomers3` on the surname's first
  four letters, at most 5 `GetLead`s). Found → the lead's market and the CONTRACT month (report 133's month), with
  "LP: Prospect N, name, office, sold date" on the line; not found → the vendor's own markets and flag `sale_not_found`.
  The vendor's printed city is never a market for these lines. `buildCommissionRows` subtracts approved invoice lines on
  ONE market in that month (`invoicedByCell`, "less $X invoiced", never below 0), and approving such lines recomputes
  their months at once (`refreshEstimatesFor`; the nightly reaches only the current and prior month).
- **A Slack card is a picture taken when it was posted; redraw them after a rule change (the user, 2026-10-19: "All
  of the Slack items need to be updated").** Six LightFire cards went up before the office split went live and kept
  "4182700/17951276 issued" with no office. `POST /n8n/admin/marketing-invoices/refresh-cards` (`{ ids? | since?,
  dryRun? }`, `refreshReviewCards` in `review-actions.js`) redraws every card in place as a new one would be (open →
  fresh preview, decided → its allocations and decision, `decisionFor`); it posts nothing and writes no ledger row.
- **Only Mark or Brad decides (D6).** The card in `SLACK_MKT_INVOICE_CHANNEL_ID` carries `mktinv_approve` /
  `mktinv_edit` / `mktinv_reject`; `isMarketingInvoiceAction` in `src/slack-approvals-core.js` catches those clicks AND
  the Edit modal's `view_submission` so they are never relayed to onboarding (which would read them as a member
  approval). Approvers are `MKT_INVOICE_APPROVER_SLACK_IDS` (empty = nobody). Auto-approve only with zero flags and
  ≥ `MKT_AUTO_APPROVE_MIN_PRIOR` (2) prior person approvals of that vendor.
- **No markets picked means "by source" (the user, 2026-10-13: "we should be able to determine the markets based on
  the gross issued leads for that source").** A line with `eligible_markets='{}'` and a sub-source is split over every
  market where that sub-source had gross issued leads in the slice's month (`splitsBySource` / `marketsFromIssued` in
  `allocation.js`); Edit can still pin markets. A month with none yet (JMJ / Vis PPC, October 2026) goes to `REECE_HOLD`
  with a note in `recommendation_reason`, and the nightly re-run (current + prior month) splits it once leads issue;
  `recommendHolds` leaves those alone. Only a line with neither markets nor a sub-source is blocked. The issued basis
  for every slice is its WHOLE calendar month (D1), not just the days it covers: an invoice with no printed period
  sits on its invoice date, and one day of issued leads is almost always zero.
- **Vendors are data, not code.** JMJ Digital Marketing → Vis PPC (the user, 2026-10-13) was added straight to
  `marketing_vendors`; it bills from a gmail.com mailbox, so it matches by its printed name (the longest alias wins, so
  "JMJ Digital Marketing" beats a line item's "Google Ads").
- **Software that serves no one office is split EVENLY over all six offices (the user, 2026-10-13: Hatch).** A line
  whose `eligible_markets` holds `ALL_OFFICES` is allocated `equal` over `OFFICE_MARKETS` whatever the issued leads say,
  needs no sub-source (its rows carry the typed one, else `Company-wide`), and is never blocked on one. A vendor with
  `eligible_markets = '{ALL_OFFICES}'` makes every invoice of theirs split that way. Houston and Winston-Salem have no
  office, so they are not in the six. **Two named kinds (the user, 2026-10-14): call center and software**
  (`COST_CATEGORIES`): Edit's "What is this cost?" sets `ALL_OFFICES` and writes the label ("Call Center" /
  "Software") as the line's sub-source, so the report shows each as its own row; a vendor carrying one keeps it on every
  line whatever the model guessed (`buildExpenseRows`), and switching back to a lead source drops the label
  (`subSourcesForSplit`).
- **The Edit form can add what is missing (the user, 2026-10-13).** "New vendor" creates the vendor on Save (or uses
  the one with that name or alias), "How to split" is by the sub-source's issued leads / evenly across all offices /
  only the markets picked, and "Remember" writes the sub-source and split onto the vendor for its next invoices. Picking
  a vendor with the form's sub-source and split left blank takes the vendor's own.
- **One invoice, one document (the user, 2026-10-13: "prevent and eliminate duplicates").** A body's sha is taken
  after Outlook's per-send noise is stripped (`bodyShaText`: `[cid:…]`, safe-links), and after analysis
  `findDuplicateInvoice` drops a document whose invoice number AND total match an existing one (unless both vendors are
  known and differ; a rejected one never counts), remembered as `duplicate_invoice` in `marketing_invoice_skips`.
- **A newer version asks before it replaces (the user, 2026-10-22).** The same vendor and invoice number with a
  DIFFERENT total is a newer version (`findEarlierVersion`, never a rejected or already-replaced one): its card leads
  with "Newer version of invoice #N … original $X, this one $Y (±$Z). Should this version replace the original?",
  the button reads **Approve & replace**, flag `newer_version_of_invoice` (never auto-approved), and the original's
  card gets one thread reply (`newerVersionThreadNote`). Approving it supersedes the original's lines whether they were
  approved or still in review (`replaceEarlierInvoice`), redraws the original card as ♻️ replaced (no buttons) and
  replies in its thread; Reject keeps the original. The same total is still a copy (above) and never asks.
- **Nothing sits on the Failed list (the user, 2026-10-13).** A failure a retry cannot fix removes the document and its
  rows (`removeDocument`) and posts one line naming the file and the error; a service outage keeps the row for n8n's
  retry, and `purgeStaleFailedDocuments` (nightly) removes one still failed a day later, with one line.
- **Every email format the inbox gets is read, or named (the user, 2026-10-13: "reliably extract information and data
  from emails in various formats").** `extract-client.js` reads PDF and images (the service), CSV, XLSX, Word `.docx`,
  HTML (`htmlToText`: tables as " | ", entities decoded, link targets kept), a forwarded `.eml` with every attachment
  inside it (`emlToText`, inline/small images skipped), and the email body from the plain AND the HTML part
  (`cleanEmailBody`: the one naming an amount wins). Old `.xls` / `.doc` / `.msg` come back `unsupported` and the review
  channel is told to resend as PDF; a body that only LINKS the file (OneDrive, SharePoint, Drive) gets the same kind of
  note (`linked_file`), never a $0 card. The rules read receipts too ("Receipt #", "Amount paid", "Date paid", ordinals,
  "Oct 1 – Nov 1, 2026" with one year, "Amount Due | $X" table rows, QuickBooks' "amount due on invoice 1883 is $X").
  `scripts/test-marketing-invoice-formats.js` holds one sample per format: a new format seen live goes there first.
- **Held Lead Gurus days are placed by code (the user, 2026-10-19; supersedes D4's "never spread by code" for the
  feed).** "Why do we have all these …? This needs to be fixed.": August alone listed 30 one-day "Unknown" items (some
  $0.01) for a person to place, and none had a suggestion (`recommendHolds` only ever ran for the current and prior
  month). `assignHeldFeedSpend` (`src/marketing/holds.js`; nightly, before the re-split; backfill
  `POST /n8n/admin/marketing-expenses/assign-held {from,to}`) puts each held feed day (Unknown / Out Of Area territory
  or the day gap) on the offices of THAT day's held leads (`matchHeldLeads`: email, phone → LP branch, else the lead's
  `lp_lead_market_assignments` market, else zip → service area), split by their Lead Gurus issued leads; no match →
  `eligible_markets '{}'`, the by-source split. Flag `auto_assigned`; `syncFeedExpenses` keeps a placed day's offices
  when the feed re-pulls it. Everything else still on `REECE_HOLD` gets a RECOMMENDATION a person applies. A day gap is held only once the day is over and only from $5
  (`GAP_MIN_CENTS`, `buildFeedRows` in `leadgurus-feed.js`, 2026-10-19): a mid-day pull held $62.65 that the next pull
  zeroed, and a $0.02 rounding gap got an "Apply recommendation" button. The user kept the button (2026-10-19). The feed is provisional until the invoice supersedes it
  (`trueUpInvoice`, variance > `MKT_FEED_VARIANCE_PCT` posts a line).
- Mode switches: `MKT_INVOICE_ANALYZER` rules|rules+llm, `MKT_COST_NIGHTLY_ENABLED`. Dry runs: the tests
  (`scripts/test-marketing-*.js`) and `GET /n8n/admin/marketing-expenses/status` (reconciliation = 0 failing rows).
- **A logo is not an invoice, and a missing fact is a flag, never a 500 (the first real email, 2026-10-13).** Mark's
  forward of the JMJ Digital Marketing invoice carried the PDF plus two inline images; each image became a document, was
  OCR'd ("qb"), reached the model and became a row with `amount NULL`, which `marketing_expenses` refuses; the PDF failed
  the same way on `period_start NULL` (no service period printed). Three 500s, n8n retried each twice, no card, no
  analysis saved. Now `triageExtraction` (`src/marketing/invoice-triage.js`, pure) runs right after extraction and BEFORE
  storage or the model: under 40 characters with no money figure and no invoice word is `not_an_invoice`, remembered by
  sha in `marketing_invoice_skips` (never a document; the next email answers `duplicate + skipped` with no OCR). A CSV,
  XLSX is never triaged out; an email body needs an amount (2026-10-13, below). `fillRowDefaults` makes every row insertable: a missing period becomes the
  invoice date (else the day received) and the card says "assumed from the invoice date"; a missing total becomes `$0`,
  which blocks Approve until Edit. The flags (`missing_period` / `missing_total`) still block auto-approve. The analysis
  is saved before the rows are written. A deterministic failure answers **200 + `success:false`** (n8n reports it once);
  only a service outage (extract 5xx/429, storage, a connection: `isTransientError`) is a 5xx that n8n retries, and the
  retry reuses the stored text. A forward from our own domain never identifies or teaches a vendor (`INTERNAL_MAIL_DOMAINS`);
  the e-mail address printed in the invoice text is tried instead (never a public mailbox). The n8n Code node drops
  inline parts (Content-Disposition inline / Content-ID / mailparser `related`), images under 50 KB and a second copy of
  the same file in one email, and sends the body text when no pdf/csv/xlsx is left. `scripts/lib/fake-supabase.js` now
  enforces the NOT NULL columns that bit, so this class of bug fails offline.

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

**Self-healing live-ops alarms wait 10 minutes (2026-10-14, Mark).** The GHL limiter, agentic-silence and
capacity-ranker watchdogs pass `sustainMs: FLAP_SUSTAIN_MS` (env `ALERT_FLAP_SUSTAIN_MS`, default 10 min) to
`reportAlertCondition`: the row opens at once, the card posts only if still bad after the window, and a flap that
clears first posts nothing either way. On 10-13 all six of those cards recovered in 1-9 minutes.

**No-contact leads the After DIAL ASAP connector missed are re-queued (2026-10-14).** `src/jobs/after-asap-retry.js`
(`AFTER_ASAP_RETRY_MODE`, default shadow): the connector keys on number1, so a repeat lead's add lands on an old
record that profile "After DIAL ASAP V2" screens out (created > 72h). The job adds the NEW record, keyed number1 +
LPRecKey (`key_fields` on `five9_add_records_to_list`). Never past 3 calls in 24h, DNC, booked or closed-out leads.

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
**#reece-chatbot** (`SLACK_CHANNEL_DISPATCH`, default C0C9AGEM2N8 since 2026-10-14; #dispatch was deleted) through `postToSlack`, and a person changes
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

**A goodbye ends the turn; price is questions first; the decision makers before the first times (Erica Hilts,
2026-10-13).** Her "… Have a good day." read as a third price ask and got a promised call (a Five9 Callback Request);
"I can call back when I have more time. Ty" got "I'll check back next week. Enjoy." plus the same two visit times a
third time; she texted STOP. Now:
- `isLeadSignOff` (`src/agentic/sign-off.js`: a deferral anywhere, or a message ending on a goodbye; never with a "?"
  or a time) plans `sign_off` (`LINES.sign_off`) before every price, objection and offer step: no question, no time,
  nothing filed, no promise recorded (`shouldRecordPromise`), and no "I'll check back" when THEY said they would reach
  out (`leadWillReachOut`). `enforceSignOff` is the last pass on both bots in every mode; `appendReferenceAsk` never
  glues an ask after a sign-off line (a bare "Enjoy." counts). checkReply: `times_after_sign_off`, `repeat_slot_offer`.
  A lead who says THEY will call is never a call request, even when the classifier says CALLBACK (post-merge sim: "I
  can call back…" got "We'll have someone … give you a call" and a Five9 filing): `askedForCall`, the classifier
  fallback (`callback_requested`) and the send handler's scheduling route all skip it, and both guards drop our call
  promise. The first price ask must end on its scoping question (`PRICE_SCOPE_MARKERS`), never a calendar ask.
- Our hand-off or goodbye closes an open offer (`OFFER_CLOSED_RX` in `lastOfferOut`), the same two times never go out
  three times in a row, and a layer3 script saying "NO times" reaches the planner (`directiveNoTimes`).
- **Price (the owner's ruling, supersedes Mark's 2026-10-02 quote → times → a person):** 1st ask `LINES.price_scope`
  (what drives the price + the count question, or style and size when the count is known), 2nd `price_visit_offer`
  (the free measure as a yes/no question, no times; BRIDGE_RX reads it, so a yes gets the times), 3rd
  `price_call_offer` (a call OFFERED as a question; Five9 only after a yes, `CALL_OFFER_RX`), after that `price_rest`.
  There is no `price_insist` hand-off any more.
- **Decision makers (the owner's ruling, supersedes "after the hold"):** `openingsGate` asks, before the FIRST time
  offer and once each, the count and then "Is anyone else part of the decision?"; any answer resumes the set-aside
  plan (`resumeBeforeGate`) and rides as `plan.dm_known`, so the collect never asks again. A "No" to it is not a no.
  Not for a lead past its demo; stage-live mode keeps `gateForStage`.
- An opt-out (the send gate's consent class) cancels an open `promised_callbacks` row (`lead_opted_out`, no card) and
  refuses the Five9 push (`requeue_blocked_opt_out`, no DNC-lift review). stop-bot alone is not an opt-out.

**Earn the ask (Mark, 2026-10-03).** The bridge to the free visit needs the problem in the lead's own words AND an
answer to one "why it matters / what if you wait" question, or the lead volunteering it ("getting worse", "the bills",
"before the next storm") — `discoveryEarned` in `nepq-planner.js`. "What's got you looking?" and "how long?" ask for the
problem, not its weight. Not earned at the old cap (2 chat / 3 SMS): keep discovering (`probe_for` problem / why it
matters, or the consequence question); two vague answers or `cap + 2` questions bridge anyway. The shortcuts are
unchanged (Mark: "keep how we had"): quote/price (one question, then times), a schedule or come-out ask (the user,
2026-10-16: "Yes I'd like the free visit" / "I want the free estimate" count, `SCHEDULE_ASK_RX`), a typed day
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
  `callback_requested_at` (`yyyy-MM-dd HH:mm:ss.SSS` on the EASTERN wall clock, `formatFive9WriteDateTime`: Five9 reads a
  written value as Eastern and reports it in UTC, so a UTC write was stored 4 hours late, 2026-10-15). Profile "Callback
  Request V3" (live on the Callback Request campaign since 2026-10-15) dials on it: requested in the last 48 hours.
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
status `new` (the handler forces it). **Ask about decision makers ONCE, then book** (supersedes 2026-09-18; since
2026-10-13 asked before the first times, above):
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

**The bot books an in-home time only where the market's LP capacity is open (Mark, 2026-10-15).** GHL appointments
carry no market and Mark ruled out per-market calendars, so `src/knowledge/market-capacity-gate.js` decides: open =
rep slots (`lp_capacity_slots` joined to `lp_branch_market_map`; the table has NO market column) − `has_appt` − bot
bookings not yet in LP (a completed `book_appointment` stamped `capacity_market`, no LP sync mark since). A date past
`v_capacity_submission_horizon` is `unfiled` (closed); a band overlapping an active `market_meeting_blocks` row is
`meeting`. Bands are `bandOfEtTime` (18:00, 18:30 and 19:00 are all Evening). Only BOT reads pass `marketCode` to
`fetchFreeSlots` (SMS slot read and `recheckSlot`, live chat `cachedFreeSlots` / `bookSlot`); the LP→GHL sync,
call-center bookings and manual moves never do, and must not. The market is `context.market.market_code` (the short
zip code, SAR / BOCA / LAKE); HOU and WSNC map to nothing and are not gated (`capacity_gate_skipped:not_in_universe`).
A failed capacity read opens the gate (logged). When the gate empties the offer window the bot offers the two earliest
times the market can take in 14 days and NEVER the booking link (the widget books past the gate); with none, the team
reaches out and #contact-center gets one card a day (`postNoCapacityCard`). Job `capacity-unfiled-alert` tells the
market's `sales-<slug>` channel once a day about unfiled days in the next `UNFILED_ALERT_DAYS_AHEAD`.
`CAPACITY_GATE_ENABLED=false` restores the old reads exactly, the 6:30 / 7:00 handling included.
**A 6:30 / 7:00 ask books 6:00 PM, and LP gets a note (Mark, 2026-10-15; the user: AI-worded, same meaning).**
`src/agentic/evening-request.js`: "6:30", "7pm", "at 7", "after 6" on a day they name (or the day we offered) pins
6:00 PM that day when it is open through the gate; the booking facts' reference is "I'm putting you for 6:00, with a
note that you would like the appointment for {time}. Our team will be reaching out to confirm the details and make
that adjustment for you." (`checkEveningReply`; keep "confirm the details": `NOT_A_CALLBACK_RX` reads it, so no
Five9 callback is filed). Once the booking LANDS (`recordEveningRequest`): a GHL note, the Requested Appointment Time
field (`7lpRWFDM8DZbLd3viHEG`) OVERWRITTEN (`overwriteRequestedTime`, never the fill-if-empty path, which the
generator skips that turn), one `appt_time_change_requests` row and one #contact-center card. No tag, no GHL task.
The row becomes ONE IMPORTANT LP prospect note (`writeLpNote`) from `syncAppointmentToLP`'s success path
(fire-and-forget) or job `time-change-lp-note-sweep` (15 min; a cancel or move off 6:00 supersedes it; one card after
`LP_NOTE_ALERT_AFTER_MINUTES`; failed after 24h). The row is claimed before the write, so the hook and the sweep never
both write it.

**An evening the lead asked for stays evening through "book it" (bot gate, 2026-10-20).** `book_it_evening_spouse`
failed on both bots: live chat answered "Yes, book it" with the two SOONEST openings (6 PM and 10 AM), and SMS read our
own "…6:00 PM ET. Which works better?" as the lead accepting Tuesday (`ACCEPTANCE_RE`'s bare "works"), kept one slot and
asked the day. Now `extractPreferredTime` reads only an outbound STATEMENT (question sentences and an "X or Y" offer never
accept a time), a yes or a schedule ask to an open offer re-offers the times on the table (`openPair` in step 5; step 4b
defers to it), and a fresh pair follows the part of day the lead stated (`standingPreference`: newest first, ended by
"neither", a typed clock time is the 6:00 path's).

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
**A quote or price ask (Mark, 2026-10-02; superseded 2026-10-13, see "A goodbye ends the turn"):** first one short line and the NEPQ connection question, no times
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

**The Melissa trace: a chat booking hears the time, keeps the real name and the whole address (2026-10-16).** GHL
6U6uceZGMQRz8XEQc9Lk, LP lead 584060: "sunday at 2" was not heard four times, the P1 opportunity read "Melissa Visitor
Anlxy", the visit went to a round-robin user, LP showed "No, Setter", the unit "14A" and the city were lost, and the email
ask went by SMS. Now:
- **Time.** `pickSlot` (`cancel-flow.js`) keeps only the offered slots that match EVERY part the lead named (day AND
  time); a bare hour after "at" / a weekday / "o'clock" reads 1-7 PM, 8-11 AM (`mentionedMinutes`); a whole-message "2"
  is still "the second one". The planner's `offeredNow` reads by meaning (`slotMentionIndex`), a pick ending in "?" is not
  a question (`pickTextForQuestion`), a question beside a pick is answered in one line before the hold (`side_question`,
  `sideQuestionOf`, both bots' facts block), and a day the lead named is never asked again (`namedDayInThread`). The
  timeout line no longer says "grab the right person" (`LIVE_CHAT_FALLBACK_MESSAGE`); `execution_result.timing.steps`
  times each step from arrival (`markStep`), and a deadline logs them.
- **Name.** "Visitor xxxx" is never a surname and a bare "Guest" never a first name (`isPlaceholderSurname`,
  `isPlaceholderName`, `cleanDisplayName` in `identity-extraction.js`). The surname is cleared with an explicit null
  (`updateGHLContactStandardFields(…, { clear })`: GHL ignores ''), read back, retried once, then
  `identity.placeholder_clear_failed`. Titles never carry it; the chat name rides on the booking (`contact_name`). A real
  name renames open "Visitor" opportunities (`update_opportunity`, rule `PLACEHOLDER_NAME_REPAIR`) and re-sends an LP lead
  held for a name (`placeholder-name-followups.js`). The addlead proxy drops the surname and holds a placeholder first
  name (`addlead-name.js`, tag `name-placeholder`). GHL's A.WE names the P1 opportunity from `{{contact.name}}`, so the
  name is saved BEFORE the booking.
- **Owner.** Every non-rehash bot booking (`source` `live_chat` / `sms_bot`) is assigned `BOT_BOOKING_USER_ID`
  (default 3K6HtoPyBLWeQrrnSnCD, Reece Team); a GHL refusal of the user books without it (`bot_assignee_refused`).
- **Setter (interim).** When LP already holds the same appointment and the setter is blank / "No, Setter" on a Set lead,
  ONE SetAppointment with set_by 5686, never retried (`src/lp-setter-stamp.js`, `lp.setter_stamped` /
  `lp.setter_stamp_refused`). The permanent fix is the setter key on 8e30ff37's addlead body (`LP_ADDLEAD_SETTER_FIELD`
  once LP names the key; never guess it).
- **Address.** `ADDRESS_RE` keeps a unit ("Apt 3", or a bare "14A" with a digit) as `address_line2` and reads a city with
  no comma; the chat capture fills city and state from the zip (a near-miss city is corrected; HOU → TX, WSNC → NC). GHL
  has one street line, so the unit rides on address1 (`streetWithUnit`) and reaches LP from there.
- **Email ask.** A chat booking asks for the email in the chat (`scheduleChatEmailAsk`, `src/live-chat/email-ask.js`,
  20s after the booking); the send pipeline never answers in the chat.
Tests: `scripts/test-melissa-trace.js`; eval scenarios `same_day_pick_at_two`, `pick_with_question_mark`,
`pick_plus_question`, `placeholder_name_then_melissa`, `bare_unit_address` (a turn may be a function of the bot's reply).

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
hours (`nowMs`). **The opening is a morning, never a clock time (the user, 2026-10-18: "our dialer is not set up to send a
call at the exact time").** `nextTeamOpenLabel` says "this morning" / "tomorrow morning" / "Monday morning", after hours a
promised call naming a day and an hour ("tomorrow at 9 AM ET") becomes that label, and a time the lead asks for is passed
on, not promised (`LINES.callback_at`: "I've let them know 5pm today works best for you"; the card prints their words). Look for `[TeamVoice]` log lines.

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
**Fixes from the first full live-mode gate (2026-10-13).** Three money asks (a quote counts) after the price play hand off
to a person even when the model reworded our first quote line (`moneyAsks`); the gate drops the price play's contact
ask (one question); "let me think about it" while qualifying is open gets `LINES.think_no_times`, never the ownership
question; the model's "what would actually decide it for you?" reads as the decide question (`DECIDE_Q_RX`), so the
criteria reply reaches the visit; and `asksForKnown` never deletes an address ask as a zip re-ask (the SMS hold that
said "I'm holding … for you." and stopped).

**A renter gets no visit; one out-of-area decline; quote ≠ price (handoff PR 3, 2026-10-12).** A renter was offered
times twice (batch 3 T3). `enforceNonOwner` (`src/agentic/non-owner.js`, the last pass in both bots beside
`enforcePropertyScope`, ACTIVE in every mode) turns a reply to a lead who says they rent into `NON_OWNER_LINE` (the
homeowner needs to be part of the visit; the owner is welcome to reach out), drops the time offer when they said it
earlier, drops the `book_appointment` companion, and the live chat never books one (`isNonOwner`). A landlord ("we rent
it out") owns the home (`homeowner.js`) and is a lead (2026-10-20, below); a TENANT gets `TENANT_LINE` (`nonOwnerLine`:
we only work with homeowners, the owner is welcome to reach out); a property manager or a grown child keeps `NON_OWNER_LINE`. Zip 10001 was declined on SMS and "good chance we can help" in live chat: both
bots now give `outOfAreaLine` (service-area-turn.js; the SMS SERVICE_AREA_EXIT text and the `serviceAreaOutside` prompt
too, which no longer offers a team callback), and live chat checks a zip typed outside a coverage question
(`zipInText`). With `LEAD_STAGE_MODE=live` (`planNepqTurn({ stageLive })`): a plain quote request is NEPQ's info request
(`LINES.info_request`, once), not the price play (`isPriceAsk({ quoteIsPrice: false })`; an insist or a price word still
is), and "we went with another company" gets `LINES.competitor` (the disarm, then how they would decide; no consequence
move after it; a second time → `repeat_objection`). `CLAIMS_RX` strips claims that another company's work is not "up to
code".

**Owners yes, renters no (the user, 2026-10-20; supersedes the rental and investment half of the next section).** "We do
not need to turn investment properties away. However, we only work with owners not the renters." An owner who rents the
home out, runs an Airbnb, owns an investment home or flips is a lead: `job-scope.js` no longer reads rentals or
investments (`RENTAL_LINE`, `INVESTMENT_LINE`, the `rental` / `investment` blocks and `rental_property` in the analyzer
are gone; the claim it corrects is now "we work with renters"). A TENANT is turned away by `non-owner.js` with
`TENANT_LINE`, gets the one ND card (`scopeDqKind` → `renter`: `saysRenter` AND `TENANT_RX`, never a property manager or a
grown child), and `homeowner.js` reads "my rent", "help with my rent" and "rent is $N" (dq_renter_refire: "help with my
rent my rent is $589" read as nothing). A renter or a commercial block plans `not_owner` / `not_eligible` with
`no_question` on EVERY turn (`openingsGate`, and `gateForStage` before its time-offer check), so `discovery_question_added`
never glues a question after the no. Data: `sql/seeds/2026-10-20_owners_of_rentals_welcome.sql` (LIB-P16, the scope proof
points, the RENTER handler's keywords, which matched a landlord's "rent" / "landlord"). Gate scenarios `landlord_lead` and
`investment_owner` replace `landlord`. **The model's own turn-away of an owner is corrected in code (2026-10-22).** The
live chat told `landlord_lead` "We work with homeowners on their primary residences … it wouldn't be the right fit for
us"; no prompt said it. `fixClaims` rule `owner_rental_declined` (`job-scope.js`: "primary residence", "a home you live
in", or a rental word with a turn-away in one sentence) becomes "We work with homeowners, and that includes homes you rent
out."; it is skipped when the lead rents (`homeownerFromThread` 'no'), so `TENANT_LINE` stands. Once that was live the chat
said "you'd need to have the owner reach out to us … if you own another home": rule `owner_redirected` ("have the
owner", "own another home", "their own properties") runs only when the lead said they own it (`homeownerFromThread`
'yes'), so `NON_OWNER_LINE` to a real non-owner stands. The scorer's `owner_declined` reads both (`SCORING_VERSION`
2026-10-22.3). **The cause was old `kb_embeddings` text (2026-10-22).** Each wording was a copy of a vector excerpt the
2026-10-20 seed never touched (3275 renter script with "landlord" as a trigger, 3276 HDL-DQ-INVESTMENT-01, 3254/3255
"primary residence"); `sql/seeds/2026-10-22_kb_embeddings_owners_of_rentals.sql` rewrote them, and `owner_redirected`
also reads "our estimates are for homeowners" / "if you own a home in the future" / "check with the owner". The model
still read the renter excerpt as being about this lead, so ownership is code's: `ownsRentalFromThread` (`homeowner.js`)
sets `plan.rental_owner` in `planNepqTurn`, and `renderPlanBlock` states "they OWN this home and rent it out" (v2.16.1).
A rule about who we serve is changed in `kb_embeddings` too, not only in `kb_faqs` / `kb_proof_points` /
`kb_intent_handlers`.

**No rentals, no commercial, a three-opening minimum, impact only (the user, 2026-10-13; rentals and investments
superseded 2026-10-20, above).** A landlord was booked like
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
`openingsKnown`), and the prompt's ASK FOR WINDOW COUNT. A bare "1" in reply to it is read as the count (`openingsAt`). It is ON IN EVERY MODE (the user, 2026-10-13: "leave the
question on"): without a stored stage `openingsGate` (`nepq-planner.js`) turns the FIRST time offer into the count
question once (never after times were offered), and the answer replans the conversation as it stood before the
question, so "about 10" gets the times the "yes" had earned; a job-scope block or check is `not_eligible` in every mode
(no wasted SMS redraft before the minimum check). A lead past its demo is never asked it (`postDemoLead`, below). The
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
**A lead past its demo already meets these requirements (the user, 2026-10-13).** `isPostDemoLead`
(`src/agentic/post-demo-lead.js`: a demo disposition (`isDemoDisposition`) or closed won, or `lp-demo-completed` /
`stage:post-appointment` / `rehash` / `active-f.0`; never `lp.demo_completed`, which LP sets for NOC) turns off, in both
bots and whatever `POST_DEMO_PLANNER_MODE` says: the lead-side job-scope and tenant declines (our own false claims are
still corrected), the qualifying gate and the count question (`postDemoLead` → `gateForStage` / `openingsGate`), the live chat's job-scope booking refusal, the
set-ND card, and an LP-note DQ whose signal is only renter or below minimum (`REQUIREMENT_SIGNALS`). `checkReply` skips the lead-side check on `ctx.postDemoLead`.
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
**The lead-state sweep reads a light context (2026-10-14).** After the cuts above, `src:context-builder.js` was the top caller
(29,608 a day, 1,400-1,900 an hour overnight): the sweep (`LEAD_STATE_SWEEP_ENABLED`) re-classifies ~350 contacts an hour,
each with a FULL build. The classifier never reads the conversation, GHL notes or calls, so it builds with
`forStateClassifier: true` (`contextParts`: ~5 GHL calls → 2), and a partial build is never cached (the analyzer reads the
cache). The sweep and the note-change analyzer are labelled `job:lead-state-sweep` / `job:note-change-analyzer`. The
`CONTEXT_CALLS_SOURCE=shadow` Five9 read now runs in the background: it timed out at 6s on every build (a suffix
`like` on `five9_events_raw`) and every context waited for it. It needs an index before `five9` mode can go live.

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

**The Five9 market dial order is confirmed ÷ requested, lowest first (the user, 2026-10-15).** `rankMarkets`
(`src/capacity/rankMarkets.js`) reads only the Appointment Capacity board's `confirmed` and `requested`. Set / hopper
appointments and appointments still needed do not rank (both are reported only); an EXACT tie (compared by
cross-multiplying, never the rounded %) breaks on the 90-day set-to-sale multiplier, then market code. The open-slot
score, the half-weight hopper (`RANKER_HOPPER_WEIGHT`, now unread) and the starvation guard are gone. A swap is
material when the fill gap is over `CAPACITY_RANKER_SWAP_MARGIN_PCT` points (default 0, so a tiebreak-only swap never
writes); the old slot-unit `CAPACITY_RANKER_SWAP_MARGIN` is not read. Log rows say `scoring_basis: confirmed_fill_pct`.

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

**A commercial or renter lead is set to ND by a person (the user, 2026-10-13; a renter, not a rental, since 2026-10-20).** LP's API cannot change a disposition
(no endpoint writes one). When the lead's own newest message makes `jobScopeFromThread` (`src/agentic/job-scope.js`)
block as `commercial` or `rental` (`scopeDqKind`, `src/agentic/scope-dq.js`), the SMS send handler and the live chat
(after the send) add a note on the LP PROSPECT (`rectype: 'cst'`; `ils` silently no-ops) and post ONE
`⛔ SET THIS LEAD TO ND IN LP` card to #contact-center (`routeNepqHandoff` reason `scope_dq`, in `NO_DIAL_REASONS`: no
Five9 call, no `callback:requested`, and the turn's callback decision is skipped), once per contact per kind ever (audit
`scope_dq`, permanent). Below the minimum is not included (not asked). `SCOPE_DQ_MODE` off|shadow|live, default live.
Production deps: `src/services/scope-dq-io.js`.

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
A run takes 20–30 minutes and about 260 real model turns (every scenario twice since Phase 1). A new scenario rule must come from a
ruling already in this file, so a failure means a regression, not a matter of taste.
**The AIOS test runs are named scenarios (handoff PR 7, 2026-10-12).** easy_yes, book_it_evening_spouse, renter,
competitor, stop_sms, stop_chat, trick_prompt, reschedule_unclear, out_of_area_chat, houston_tz. A scenario with
`autoAnswer` lets the persona answer the bot's address / ownership / zip / decision-maker / name / phone question
(`autoAnswerFor`), so a booking scenario can book. Every conversation also gets `stageFlowFailures`: yes_without_booking,
slots_offered_to_non_owner, stage_regressed, and, only when the run's `lead_stage_mode` is live, slots_without_qualifying
and bridge_repeated (today's designed behavior in shadow). A texted STOP answered with silence is not `no_reply`. The
scenario checks carry `SCORING_VERSION`: a run scored with new checks is a new baseline, not "worse".
**Phase 0: freeze and measure (architecture review 2026-10-17).** A scenario may carry `expect: { [turn]: {
question_allowed, move, step, no_clock } }`, checked on every turn (`turnExpectationFailures`: a guard that appends a
question to a turn that must ask nothing fails `guard_question_appended`), and names its `family`; the scorecard prints
`pass_rate_by_family` and a family whose rate falls reads WORSE. A prompt copy change needs a `RESPONSE_GENERATOR_VERSION`
bump (the snapshot test compares it with `__snapshots__/VERSION`). `scripts/test-guard-polarity.js` holds one must-change
and one must-pass input per reply guard; `scripts/test-regex-budget.js` caps the `_RX =` count in `src/agentic`
(`scripts/fixtures/regex-budget.json`; raising it needs a reason naming a scenario key). By hand, not in the gate:
`scripts/replay-bot-eval.js` (live incidents, ids only in the fixture; the text is read from bot_message_context) and
`scripts/report-stage-agreement.js` (shadow stage vs buyer_stage). Phase 0 baseline (2026-10-18, build 17aabde, scoring
2026-10-18.2): the 2026-10-18 12:55Z gate events (`agentic.bot_eval_run`, v2.8.0+17aabde): system_events 4385611, 64/72; confirmed by `sim_mvdsv66o_grvs`, 66/72, not worse. Two runs on one build; see Phase 1 item 3.
rehash_not_at_this_time and rehash_book_call flip between runs on the same build. The full w42 replay still needs a
machine with the keys (planner-only: 10/14). A gate job lives in memory: a deploy during the run loses it, so start one
only while nothing is about to merge.

**Phase 1: one owner per inbound, a gate that runs twice (2026-10-18, v2.9.0).** Four rules can answer one SMS (106,
161, 228, 373) and a rule-written send can re-fire with no new inbound (Teresa's two DQ replies, Shawn's and Paul's two
replies to one text). Every reply path CLAIMS the inbound in `bot_turn_locks` before any context build or model call
(`src/agentic/turn-lock.js` pure, `turn-lock-io.js` I/O): the SMS send path once, in `claimReplyTurn`
(`src/send-message-handler.js`, after the quiet-hours and email-delay holds), and the live-chat lane per inbound message
id. The key is the GHL message id, else the sha256 of the text read by the ONE normaliser (`src/agentic/turn-key.js`,
which `missed-inbound.js` re-exports); a re-fire with no text claims the LAST inbound. A failed claim is a skip row
(`turn_owned_by:<rule>` or `already_answered`) and no model call. An owner that stands down without a reply releases
the turn for the next path (a stand-down is only safe if something else answers); a claim 10 minutes old and never
released is taken over and logged. A bot-initiated send (a hold return, a nurture step) claims nothing
(`turnClaimScope`); POST_BOOKING_EMAIL_ASK claims a turn of its own. The watchdogs 228 and 373 claim like everyone
else and, live, wait until the inbound is 180 s old and lose to any reply sent after it (`watchdog_recovered` when they
win). `TURN_LOCK_MODE` shadow (default) records the would-skip on the row (`input_snapshot.turn_lock_shadow_would_skip`)
and proceeds; live skips. The 48-hour check before live: every flagged row is a duplicate or a watchdog that lost.
The gate runs every scenario twice (`run_bot_eval` `runs`, default 2): a key passes only if it passes in every run,
mixed is `flaky` (listed, never WORSE), and the comparison and family rates use stable results only. The second no
after our close is read from the previous SENT reply's `bot_message_context.plan_step` (`post_demo_close`,
`door_open`, `post_demo_stop`), never our wording; every reply row writes `plan_step` and `question_allowed`. The
version rule covers planner copy too: `scripts/test-planner-copy-snapshot.js` snapshots LINES / fixed lines and the
rehash track's copy, and a change without a `RESPONSE_GENERATOR_VERSION` bump fails.

## Writing code here

Existing modules carry dated comments explaining *why* a thing is the way it is, usually naming the
incident that caused it. Match that: when you encode a non-obvious decision, say what it is defending
against. The comments are how the next session learns what a live pull cannot tell it.

Use a `deps` seam for anything that reaches the network or the database (`deps.fetch`,
`deps.supabase`, `deps.emitEvent`), so behaviour stays testable without a live service.
