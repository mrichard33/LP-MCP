# Changelog

Notable behavioral changes to the LP MCP server. Newest first.

Rule-layer (`agent_rules`) changes ship through the database, not through this
repo — they are recorded in `sql/seeds/` on the date they were applied live.

## 2026-10-23

F.0 v2: every unsold demo gets an email (the user).

- **A static Reece Team email goes out when the AI email can't.** No Siro
  recording, the AI email turned off, or a failed draft now tags the contact
  `f0-email-fallback`, and the workflow sends the static email instead of
  nothing. A real stop (sold, a newer lead, rebooked, a DQ, an opt-out, a reply)
  still sends nothing, and a failed text is still skipped. `src/siro/f0-email.js`.
- **Two static emails between the texts**, day 4 and day 11, from the old F.0
  emails, reworded as the Reece Team (`docs/f0-v2-static-emails.md`; a GHL build).
- **No approval step**: F.0 v2 goes live without a shadow week.

Rehash Call booking fixes (Mark, from the Kim Turko review). Each has its own
switch, so any one can be undone alone.

- **After a Rehash Call is booked, the bot only answers direct questions.** Kim
  booked a call, then got the email ask and, after replying with just her email,
  "Where are you at with it?". Now, once John owns the lead: nothing proactive
  (no email ask, no nudge); a direct question ("What does the warranty cover?")
  gets a 1-2 sentence answer with no question back, no times and nothing booked;
  "can we move it to 2?" gets "Got it, I'll let John know." and a card in
  #contact-rehash; anything else gets no reply. John's 15-minute pause still
  applies. Needs `REHASH_OWNED_MODE=live` and `REHASH_OWNED_ANSWER_MODE=live`
  (default shadow). `src/agentic/rehash-owned-answer.js`.
- **No post-booking email ask after a Rehash Call.**
- **The title is "Reece Best-Offer Call: {First Last}".** Kim's read
  "Kim Turko - Rehash Call - Kim Turko". The calendar itself is still called
  "Rehash Call". `REHASH_CALL_TITLE_MODE` (default on).
- **A Rehash Call is created Confirmed.** Every other calendar is still created
  New. `REHASH_CALL_AUTO_CONFIRM` (default on).
- **Every Rehash Call gets an internal note for the rep.** It starts
  "Booked by Reece Chatbot" (GHL's API cannot set Booked By), then the call
  time, the rep on the visit, the demo date and a short summary of the
  conversation, under 700 characters. It is an appointment note, never the
  description the lead can see. `REHASH_CALL_NOTES_MODE` (default live).
- **The Rehash Call calendar description** can be set with
  `node scripts/set-rehash-calendar-description.js --apply` (dry run without
  `--apply`), or pasted by hand in GHL.

## 2026-10-22

- **A landlord is never turned away.** "I need new windows on a house I rent
  out to tenants" got three different "homeowners only" replies in the website
  chat. The old knowledge-base text behind them (a renter script that counted
  "landlord" as a renter, and an "investment property" decline) now says an
  owner who rents the home out is a normal lead, and the bot is told plainly
  that this person owns the home.
- **A rehash call time on a named day is never booked on another day.** "10am
  tomorrow" with tomorrow's 10:00 taken booked today's 10:00 (Jim Anderson,
  2026-10-21, on the live build). Now the bot offers the openings that day and
  names the day: "10 AM tomorrow isn't open, but I have tomorrow at 11:00 AM ET.
  Does that work?".
- **F.0 never greets anyone by a single letter.** A lead whose first name in GHL
  is just an initial ("a") got an email that opened "Hi A,". Now a lone initial
  counts as no name: the name on the LP lead is used ("AJ"), and when there is
  none the email or text simply opens without a name.

## 2026-10-21

- **John owns a rehash lead once a call or a visit is set.** A rehash or post-demo
  contact with an upcoming Rehash Call, an LP lead at Cnf / Issue / Reset with a
  visit today or later, or the `rehash-owned` tag gets no bot message: no reply,
  no F.0 touch, no #contact-rehash card, and the bot's promised call is closed.
  `REHASH_OWNED_MODE` (default shadow). `src/agentic/rehash-owned.js`.
- **A rehash rep's manual text or email pauses the bot for 15 minutes.** The
  lead's next text is held; a newer message from the rep restarts the clock;
  when it runs out, the thread is read: if the lead closed it ("see you
  tomorrow"), nothing is sent; if something is still open ("what time
  again?"), the bot answers. `REHASH_PAUSE_MODE` (default shadow).
  `src/agentic/rehash-pause.js`, `src/agentic/conversation-complete.js`.
- **The rehash bot never asks a lead to compare quotes.** A "how do they stack
  up?" the model writes is replaced by the better-price call invite, and
  `checkReply` fails `rehash_comparison_question`.
- **Rehash replies can sign as the Reece Team.** `REHASH_VOICE_MODE=team` writes
  as the team and names the rep in the third person; default `rep` is unchanged.
- **GHL showing a bot text as a person is now an #ops-alerts line**, once per
  contact per day (`agentic.ai_sender_ignored`).
- **Rules:** the post-demo objection rules no longer move a rehash contact
  (`rehash`, `active-f.0`, `rehash-owned`) into O.0; their tags and notifications
  still fire (`sql/seeds/2026-10-21_rehash_no_o0_routing.sql`).

- **F.0 v2 gets a personal email the evening of the demo.** Position 0 of F.0 v2
  is now one email written from the Siro recording of the visit, as the rehash
  rep: it thanks them for having us out, names what they wanted and their main
  hesitation in their words, and ends on one question, "If I could …, would you
  be open to a quick call with John?". It replaces the old fixed F.0 email. No
  price, deal, discount, sensitive detail, footer or exclamation mark. With no
  recording by 08:30 the next morning, nothing is written and the workflow sends
  its fixed fallback (tag `f0-no-recording`). Behind `F0_EMAIL_MODE`, default
  shadow (drafts + an approval card in #contact-rehash), and its prompt row is
  seeded inactive, so nothing a customer sees changes until Mark switches it on.
- **F.0 v2 positions start at 1: the email is 1, the texts 2 to 6.** GHL saves
  a number field set to 0 as blank, so on the first test the email arrived with
  no position and was treated as a text. The workflow now sends 1 for the email;
  LP-MCP maps it once, and the saved row shows the workflow's number.
- **F.0 v2 can be tested end to end on a test contact.** `F0_TEST_LINKS` links a
  contact tagged `aios-test` to a real lead's recorded visit (read only). That
  contact is treated as an unsold post-demo lead, gets the email and texts live,
  and is never touched by the rehash sweep. Nothing is ever sent or written to
  the real lead. Empty = off.
- **A nurture workflow writes drafts only for contacts it actually holds.**
  With `NURTURE_WORKFLOW_IDS` set, a generate call from a workflow the contact
  is no longer in is refused and nothing is written.

## 2026-10-11

- **After an unsold demo, the bot never says the sales rep will follow up.**
  The lead belongs to the rehash team then. Replies say "our follow-up team"
  (or the rehash rep the line speaks as) instead of "your rep" or the visit
  rep's name, and the escalation acknowledgment names the follow-up team. A
  lead that bought keeps its sales rep.

- **Rehash leads get a post-demo conversation, not a new-lead one.** A lead who
  already had the in-home demo (tag `active-f.0` or `rehash`, or texting the
  rehash line) was handed the new-lead "What got you looking at the windows?"
  step right above the rule that bans windows questions. They now get their own
  track, one step per text: the proposal, where they are, what is holding them
  back, what would make it work, then the call. Objections are asked back
  ("Too expensive compared to what?", "How do they compare?"), never argued.
  Two no's in a row and the bot stops asking (`src/agentic/rehash-nepq.js`).
- **"The best deal possible" is the one hint allowed.** The bridge to the call
  is "I want to make sure you're getting the best deal possible. I may be able
  to do something for you, it's just easier on a quick call." It is said at
  most once per conversation. Any amount, percentage, discount, promo, special
  price or "a great deal" is still stripped.
- **A booked rehash call names who calls and posts its card.** "You're all set
  for [day] at [time]. John will give you a call then." (first person when the
  bot speaks as that rep; "someone from our team" when the name is unknown,
  never a guess; more names via `REHASH_TEAM_USER_NAMES`). The #contact-rehash
  card now also posts for a booked call, with the time and the team member.
- **Fix:** with no Rehash Call times read, the reply asking "What's a good time
  today or tomorrow for a quick call?" was cut down to "Good." as if it were a
  visit booking ask. It now goes out.
- **Fixes from the first live simulations.** "Thanks for checking in" got
  "Anytime. Talk soon." and no question; it now gets the proposal question.
  "The best deal possible" was used to answer "we got another quote" in place
  of "How do they compare?"; it is now held for the bridge. A bridge turn that
  asked nothing gets "Would a quick call help?". A "yes" two messages after the
  bridge now gets two real call times instead of a vague "John will call you".

## 2026-10-01

- **Blocked leads that come back now ask for a DNC lift on their own.** A new
  job, `dnc-reentry-sweep`, checks every new LP lead once (every vendor, not
  just ActiveProspect) and posts the Approve / Keep Blocked card in
  #dnc-lift-approval when the number is blocked. Nobody needs to add the
  `dnc-lift:request` tag. "Blocked" now includes Five9's DNC list: most
  returning leads were blocked only there, so the old check called them "not
  blocked" and no card ever posted. A lead that opted out after it arrived
  (its own DNC disposition, a STOP, or an agent's Five9 "Do Not Call") never
  gets a card. `DNC_REENTRY_SWEEP_MODE` = off | shadow | live (default live).

## 2026-09-29

- **Calls + texts opt-outs mark Lead Perfection "Do Not Call".** LP keeps one
  DNC value per record, and the rules sent Do Not Call then Do Not Text, so the
  record ended up "Do Not Text" and looked callable in LP. The five rules now
  send Do Not Call only (`sql/seeds/2026-09-29_lp_dnc_single_code.sql`).

- **Lead-leak clocks count business hours only.** Waiting time, time to first
  call and the "no retry" gap skip every closed hour: 8am–8pm ET Monday–Friday,
  9am–5pm ET Saturday–Sunday (`BUSINESS_HOURS` in `src/lead-speed.js`). Before,
  the clock started at the next opening but then ran through every night, and
  weekends used weekday hours. The hourly waiting check runs on the same hours.

- **Lead-leak cards: right label for leads on no dialing list, freshest leads
  first.** Five9 leaves "Number of attempts" blank on a contact nobody has
  dialled, and a blank was read as "unreadable" — so dozens of never-listed
  leads (mostly Simpletext) still read "Never dialled — Five9 has the number".
  Blank, `0` and `00000` now read as empty, and those leads read "In Five9 but
  not on any dialing list". A lead that IS on a Five9 list but has no call in
  our history gets its own priced reason, `on_list_not_dialed` ("On LP_ASAP in
  Five9 but no call recorded"). Whatever is still left as a routing failure is
  logged as `[LeadLeak] unmatched five9 record` with Five9's raw values.
  The cards and `GET /api/lp/lead-leak` `waiting[]` now list the newest leads
  first; groups are ordered by how many leads from the last 24 call-center
  hours they hold, each header shows the full count ("— 31 (showing 6)"), and
  the named lines are split so every group gets at least 3. The daily speed
  card names only the last 7 days and counts the rest in one line. The
  endpoint adds `waiting_by_reason`. What counts as a leak did not change.

- **An approved DNC lift now actually clears DNC in Lead Perfection.** The clear
  sent `N`, a guess LP rejects ("Invalid DNC value"), so every LP clear failed —
  Slack lifts and automatic re-entry lifts alike. LP's API docs say a blank value
  resets the status. An empty field was rejected the same way, so the clear now
  sends a single space.

- **Approving a DNC lift now restores texts too, unless the lead really texted
  STOP.** A `dnc-sms` tag on its own no longer counts as a texted STOP — staff
  add it to block calls + texts, and the card was wrongly warning "This lead
  texted STOP" and keeping texts off. A real STOP (a STOP reply, the consent
  record, or GHL's own STOP lock) still keeps texts off. The lift also records
  email as open again, since it already turned Email DND off.

- **Alerts post to Slack only.** `reportAlertCondition`'s default sender is now
  `sendAlertMessage` (`src/alert-state.js`), which posts straight to Slack —
  `channel: 'ops'`, a blank channel or an unknown one → `SLACK_CHANNEL_OPS`
  (#ops-alerts). The watchdogs that passed their own GroupMe sender (capacity
  ranker, five9 silence, data freshness, LP report, backstop, capacity sweep,
  appointment parity, payroll ops note, startup schema, live-chat ops) use it
  too. Rollback without a code change: `ALERT_SEND_TARGET=groupme` (old path)
  or `both`; anything else is `slack`. No GroupMe fallback when the Slack
  channel is unset — it logs `[AlertSend] no Slack channel` instead.
- **Lead-leak waiting card names a real reason per lead.** Inquiry-stage Five9
  calls (up to `LEAD_PRECREATE_CALL_HOURS`, default 48, before LP stamped the
  lead) now count as calls and stay out of the speed numbers. New reasons:
  `called_no_retry` (rung, still "Data", no call in `LEAD_RETRY_GAP_HOURS`
  call-center hours, default 4) and `not_on_dial_list` (in Five9, empty
  `f9_last_list`, 0 attempts). The hourly pass looks up only the leads it will
  name (`LEAD_UNCALLED_LOOKUP_CAP`, default 40), and the card is grouped by
  reason.
- **A channel opt-out tag now blocks its channel, and only that.** `dnc-sms` and
  `dnc-voice` block calls + texts (GHL DND, Five9, LP codes C + T); `dnc-email`
  blocks email only. Each records the change in the consent record (source
  `ghl_tag`). Before, the intake filter dropped these tags, so a person adding
  them — or GHL's own STOP handling adding `dnc-sms` — reached neither Five9 nor
  LP. Plain `dnc` still blocks nothing (rule 241 moves the funnel state). Seeds:
  `sql/seeds/2026-09-29_channel_dnc_tags.sql`; the short-lived full-opt-out rule
  is disabled in `sql/seeds/2026-09-29_manual_dnc_tag_optout.sql`.

## 2026-09-28

- **ActiveProspect re-entries now ask for a DNC-lift review.** n8n I.AP calls
  `POST /webhook/ap/dnc-reentry` when a delivered lead matches an existing
  contact; if that contact is on DNC, a card is posted to `#dnc-lift-approval`
  naming ActiveProspect and the vendor. Previously nothing saw these leads.

Consent Model v1 — one record of who may be contacted, on which channel, and
who changed it. Ships in **shadow**: nothing reads the new tables to gate a send.

- **`contact_consent` + `consent_events`** (sql/136–139). `record_consent_change`
  writes both in one transaction. Channels are `phone` (texts + automated calls,
  paired per FCC 24-24 para. 32), `email`, `all`. `CONSENT_SPLIT_SMS_CALL` is a
  hook only; the split is not built.
- **Slack-approved DNC lift.** A `dnc-lift:request` tag (or a re-entry the
  first-party auto-lift does not own) posts an Approve / Keep Blocked card to
  `#dnc-lift-approval` via n8n. `POST /slack/dnc-lift/decision` runs the lift
  and returns per-system results for the thread. A lead who texted STOP gets
  calls, LP and Five9 back; texts stay off.
- **`five9_remove_numbers_from_dnc_approved`** — the second narrow exception to
  add-only Five9 DNC. Human Slack approval through `approve_action` only.
- **Email unsubscribes are email-only** in the consent record.
- `update_lp_dnc_status` accepts `mode: 'clear'`; `emit_event` accepts
  `bypass_filter`.

## 2026-09-24

The bot promised emails it had no way to send, and went quiet on the lead who
asked where it was.

- **Only an opt-out silences the bot** (Mark). Every classifier handoff used to
  be silent; of the 11 live classes only STOP is an opt-out. Now
  (`src/agentic/handoff-policy.js`): STOP and WRONG_NUMBER stay silent; the
  two callback tags a GHL workflow answers stay with the workflow; everything
  else (ANGRY, FULFILLMENT_NOT_RECEIVED, WHO_IS_THIS, MOVED, RENTER, MOBILE)
  still tags the contact AND gets a reply written for that moment. Only ANGRY
  and FULFILLMENT_NOT_RECEIVED still page a person ("HUMAN FOLLOW-UP NEEDED").
- **"Not interested" gets one "what changed?"** (Mark) — then a warm close
  and never again (`src/agentic/not-interested.js` decides the turn from the
  thread). A stated reason is routed by the existing objection rules; "not
  interested" itself stays on the cooling track (rule 297, the 2026-06-17
  decline ruling). O.0 has no not-interested branch.
- **Info emails are signed "Reece Team"** (Mark). The prompt asks for it and
  `withReeceTeamSignOff` enforces it after the safety checks run on the
  model's own text, so a replaced last line can never hide a link or price.
- **Preview line on every bot email reply.** Normal email replies had none;
  the inbox showed the body's first words. The model now writes `preheader`,
  and `sendWithFallback` adds it (or the body's first sentence) as the hidden
  preview line right before the send, after every body guard, never twice.
- **Missed-reply opt-out rule narrowed** (DB, `sql/seeds/2026-09-24_optout_only_stops_bot.sql`,
  applied live) — "not interested" no longer applies stop-bot; it gets the
  recovery reply. The "signed with another company" rule already keeps the
  bot on (v4, 2026-09-09).

- **Incident** — GHL BazzY5Ihu2heR4osVlBF (Mark Test): "Want us to send a
  quick comparison…?" → "Sure" → "Sending that comparison to <email> now".
  Nothing was sent; the model's own reasoning called that reply "fulfilling
  the promise". The same week: Kenneth Sr (Hurricane Guide "to the email on
  file"), Alyce ("I'll get that over to you soon"). 3 of 3 real promises in
  7 days were never delivered. Open issue #220 (2026-07-26) was the same class.
- **`send_info_email`** (new action + companion) — when the lead accepts, the
  model writes the email in the same turn; `src/actions/handlers/info-email.js`
  delivers it through the Conversations API path agentic email replies use.
  Not a `send_message`: reply locks and supersession would drop it as a
  duplicate of the SMS that announced it. Gated by stop-bot/suppression and
  hard opt-outs; no email on file → operator event; a landed retry never
  resends.
- **Subject, preheader and body on every info email.** The model now writes
  a preheader too (a missing one is taken from the body's first sentence).
  The direct path adds it as the hidden preview line at the top of the HTML.
- **Webhook delivery** (`INFO_EMAIL_WEBHOOK_URL`; unset = direct) — one POST
  carries `subject`, `preheader` and `body_html` to a GHL Inbound Webhook
  workflow that sends them in the branded template. All four live email
  workflows were checked first; none takes all three from a webhook
  (U.SEND-AI and I.AI-MAIL are tag-triggered and have GPT write the text; S4.5
  is the nurture rotation; I.AG-IN has no preheader).
- **Undelivered-promise guard** (`src/agentic/send-promise.js`) — a reply that
  says something is sent/on its way without carrying `send_info_email` or an
  accepted guide regenerates once; if the retry still promises, it ships with
  a high-priority rep task (`UNDELIVERED_PROMISE_ALERT`).
- **Prompt** — new SEND INFO BY EMAIL section: only two things can reach an
  inbox (an email the bot writes, or the Hurricane Guide); never offer a
  brochure/comparison/PDF/link; an offer is a question.
- **`reanalyze_reply`** — the rule's unrendered `{{source_event_id}}` beat the
  event payload's real id, so the missed-reply re-analysis failed 4 of 4 times.
  Unrendered placeholders now count as absent.

## 2026-09-23

Chatbot canon + NEPQ alignment (Mark's 2026-09-23 rulings). Install time stays
"1 to 2 days".

- **Bot instructions** (`src/prompts/response-generator/*`) — Florida-wide
  service area; one approved brand line; no insurance-savings promises; no
  "no fine print"; factory-trained, Reece-certified crews; the 30-Day Price
  Guarantee is gone. One offer per message: the in-home time for both
  decision makers comes first, and the 15-minute call on speaker only on a
  later turn. Competitor objections get the NEPQ decider question instead of
  a "what to ask every company" list. New: THE REVEAL (one question after a
  booking) and a one-time two-slot hold on "let me think about it". The
  Protection Profile Review stays the default offer, with three named in-home
  exceptions. No exclamation marks, no exceptions.
- **`rep_note`** — new top-level reply field. The lead's answer to the
  decider, the Reveal, or the mistrust "what happened?" is queued as an
  `add_note` on the contact (`src/agentic/rep-note.js`, rule
  `REP_NOTE_CAPTURE`).
- **NEPQ layer v1.3** (`src/agentic/nepq-layer.js`) — never asks for a target
  number; a neutral disarm is allowed when the question stays on their
  objection; Stage-4 transition defaults to the Review. `findConcessionPivots`
  moved in step so it no longer regenerates that approved shape.
- **`POST /n8n/kb/reembed`** — re-embeds corrected `kb_embeddings` chunks in
  place and/or runs the FAQ sweep now. Behind the standard operator auth
  (moved to `src/auth.js`, unchanged); unauthenticated calls get 401.
- **`sql/124`** — library data fixes (FAQs, proof points, specs, objection
  scripts, story arcs, reece_* docs), old text backed up to `notes` /
  `metadata.prior_text`. Applied after merge.

## 2026-09-09

Rescission rescue routes to O.0; objection-confirmed tag family normalized to
hyphen; cancel_appointment resolves live on invalid ids; LP→GHL cancel no longer
echoes a second S5.2 route.

- **`src/actions/handlers/rescission.js`** — writes
  `objection-confirmed-competitor` (hyphen), the tag O.0 step 20 actually
  branches on. The colon form it wrote before matched nothing. Header corrected:
  O.RR was never built; the rescue arc is the O.0 competitor branch
  (`fdf4ad82-33ab-4e73-b581-18d21d51ac42`) — PUBLISHED with an active trigger,
  read live as version 157 on 2026-09-09.
- **`src/ghl.js`** — new exported `normalizeTag()`, applied inside
  `applyGHLTag()` and in the `add_tag` handler
  (`src/actions/handlers/tags.js`). Any `objection-confirmed:<value>` is
  rewritten to `objection-confirmed-<value>` at the chokepoint, with a warn
  naming the producer. Covered by `scripts/test-tag-normalize.js`.
- **`src/actions/handlers/appointments.js`** — `executeCancelAppointment` no
  longer trusts a payload `appointment_id`. It verifies the id against the
  contact's live appointment list, falls back to `resolveActiveAppointmentId`
  when the id is not there, retries once after a 400/404, and on final failure
  applies `cancel:failed`, emits a critical `appointment.cancel_failed`, and
  opens a rep task before rethrowing. `executeRescheduleAppointment` resolves
  `old_appointment_id` live when it is absent. Covered by
  `scripts/test-cancel-appointment-resolution.js`.
- **`src/knowledge/contact-appointments.js`** — new
  `fetchRecentAndUpcomingAppointments(contactId, { pastHours = 24 })`. The
  EXISTING APPOINTMENTS prompt block now uses it, so an appointment that ended
  in the last day is still quotable. `fetchUpcomingAppointments` is unchanged
  and still future-only for the double-book guards.
- **`src/response-generator.js`** — a cancel/reschedule companion carrying an
  `appointment_id` that is not in the known list is no longer dropped: the id is
  stripped and logged, and the executor resolves the real appointment live.
- **`src/services/lp-ghl-appointment-reconciler.js`** — the LP→GHL cancel now
  marks the contact reschedule-in-flight before the PUT. Rule 271 already owns
  an LP-originated CXL; without the marker the mirrored cancel also fired rules
  171/107, producing a second task card and a second S5.2 route per
  cancellation (15–17 leads/day).
- **`sql/seeds/2026-09-09_rescission_o0_routing.sql`** — durable record of the
  rule changes applied live the same night, including new rule 356
  `RESCISSION_RESCUE_HUMAN_OWNED`. 280 rules enabled after reload.

Source: Wally Scott post-mortem (GHL `2LT4JDrObOgPlKnn3H0q`, LP 573728).
