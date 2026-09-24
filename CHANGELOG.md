# Changelog

Notable behavioral changes to the LP MCP server. Newest first.

Rule-layer (`agent_rules`) changes ship through the database, not through this
repo — they are recorded in `sql/seeds/` on the date they were applied live.

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
