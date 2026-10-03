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

**Only an opt-out silences the bot (Mark, 2026-09-24).** A classifier handoff tags the contact and,
where a person must act, pages one — and the bot still replies, unless `handoffReplyPolicy`
(`src/agentic/handoff-policy.js`) says `silent` (STOP, WRONG_NUMBER) or `workflow` (a GHL workflow
answers the tag). A new handoff class replies by default. Do not add a silent class without Mark's
ruling, and never add `stop-bot` to a rule whose trigger is not an opt-out.

**Post-demo F.0 leads talk to the rehash rep (Mark, 2026-10-01).** A contact tagged `active-f.0` (or texting
727-800-4578) gets SMS replies written AS the rep in the GHL custom value `rehash_rep_name`, read by
`src/services/ghl-custom-values.js` and written in as a literal (never the merge tag). The one goal is a
phone call with that rep; the offer is hinted at, never named (`stripOfferTalk`). Layer3 script directives
are dropped for these replies because every one is pre-demo copy. A "yes" to the call posts one card a day
to #contact-rehash (`SLACK_CHANNEL_REHASH`, default C0C5YMHNYJH) via `src/notifications/rehash-call.js`.
No resolved name → the reply signs "Reece Team"; never guess a name. See `src/agentic/rehash.js`.

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

**Every LP sale gets a P2 card, even when LP's webhook does not arrive (2026-10-03).** A P2 (Client
Lifecycle) card is built only by LP's outbound webhook → GHL I.LP-IN (adds `deal-won`) → C.0-IN (P1 Sale
Recorded + P2 Contract Signed, valued from LP Gross Sale Amount). LP's webhook all but stopped on 2026-09-24,
so 41 sales (~$1.1M) never reached P2 and the GHL Pipeline Value tile fell. `src/p2-sale-backstop.js`
(job `sale-p2-backstop`, every 15 min, `SALE_P2_BACKSTOP_MODE` off|shadow|live, default shadow) checks every
LP job with a contract in the last 45 days. If the contact has no P2 card in ANY status, read live from GHL
after a 30-minute grace:
- a live sale gets `deal-won`, so C.0-IN does the rest;
- a sale that already has `deal-won`, or a do-not-contact sale, gets the card directly through
  `executeMoveOpportunity`;
- a cancelled or credit-declined sale is created Lost and goes to L.6;
- a sale with no price yet is named once in the 08:00 digest.

The on-demand run is the MCP tool `sale_p2_backstop_run` (dry run by default). Do not revive the `deal-won`
half of `checkLeadTriggers`: its filter never matched, and a "fixed" one would onboard every historical
sale.

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

**Ops alerts post only new items, mostly once a morning (Mark, 2026-10-02).** `src/jobs/ops-morning-digest.js`
posts ONE 08:00 ET card to #ops-alerts: P2 Won/Lost (24h), new appt-parity gaps, and the morning checks
(f0-integrity-audit, lead-leak, link-leak, p2-unresolvable), which now run inside it and no longer post their own
card unless they FAIL. "Already posted" lives in ONE store, `audit_posted_items` via `src/alert-posted.js` —
do not build another. Drift posts one card per contact, ever (`permanent`); intake journal waits 60 min; the
uncalled-leads card names only leads not posted in 7 days; outages post on state change only (`remindMs: 0`).
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

**Both bots sound like a person: rules in the prompt AND a pass after it (2026-10-02).** The SMS prompt
banned em dashes for months and they shipped anyway, with "Got it. Great question." openers and "Just to
understand… —" lead-ins. `HUMAN_VOICE_RULES` (`src/prompts/response-generator/banned.js`) tells the
model; `humanizeReply` (`src/agentic/human-voice.js`) cleans what slips through, in the SMS generator
and the live-chat guards. It only deletes or swaps punctuation and stock phrases, keeps a "— Name"
sign-off, and leaves any sentence quoting a LOCKED KB line (found in the prompt) verbatim. Look for
`[HumanVoice]` log lines.

**NEPQ is enforced in code, not only in the prompt (Mark, 2026-10-02).** `src/agentic/nepq-planner.js`
plans ONE move per turn for both bots (`planNepqTurn`): a person takes over on a complaint, a price asked
again after the price play, two no's, or a repeated objection (`src/agentic/nepq-handoff.js`: `hdl:callback-sales`
+ `nepq:handoff:<reason>`, a rep note, an event, and a card in **#contact-center** (`SLACK_CHANNEL_SERVICE`), plus
**#dispatch** for a complaint or an unbookable pick, via `postToSlack`; a failed post is an #ops-alerts line); the objection plays, the
think-it-over Calendar Commitment (two REAL slots, exempt from the booking-ask cap), "what day works best",
the Reveal and the confirm line ("You're all set for [day] at [time], [name]. Our team will reach out to
confirm the details." — said only when the booking landed in that turn, never a rep name, never "see you
then") are Mark's wording — since Part 7 a reference the model rewrites for the lead (meaning kept, see below). A vague live-chat opener ("hi", "I need new windows") gets the Status Frame
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
**Only SALES callbacks go to Five9 + #contact-center (Mark, 2026-10-03).** "Anything related to service should let the lead
know a team member will reach out and send to the Slack service channel." `isServiceCallback` (the lead's words are about an
install, an order, a repair or a warranty, or a known customer, `isCustomerP2`, asks without naming new work) turns a call
request into the `service` hand-off: the line says "a team member will reach out" (`LINES.handoff.service_callback`), the tag
is `hdl:callback-service` (I.HDL-2), and the card goes to the contact's market `#service-<market>` channel
(`serviceChannelsFor` → `resolveSlackChannels('service')`, falling back to #contact-center). Never Five9: `fileBotCallback`
with `kind: 'service'` skips the requeue. Both bots' hand-offs use one production deps object, `nepqHandoffDeps`.

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

**Retiring a FAQ without a replacement leaves a hole the search fills with the nearest thing.**
Retiring `#14` (roofing) during the golden ingest left no roofing answer at all, and a live lead
walked into it — the three FAQs retrieval offered were all irrelevant (top 0.405) and only the
model's own knowledge saved the reply. When a topic is retired because the answer CHANGED, the new
answer still has to exist (`LIB-P12`).

## Supabase

**Two separate instances — LP and HL.** No cross-joins; fetch from one and filter against the other.

- Reads: wrap in `json_agg(row_to_json(s))`.
- Writes: assert the row count (`WITH u AS (... RETURNING 1) SELECT count(*) FROM u`). Note the MCP
  query tool reports `rows_affected: "n/a"`, so verify with a follow-up count.
- DDL goes through the Supabase dashboard.
- Deleting from `system_events` can trip `agent_actions_event_id_fkey`. Guard with
  `AND NOT EXISTS (SELECT 1 FROM agent_actions a WHERE a.event_id = e.id)` and delete in batches — a
  single large statement is atomic, so one FK violation rolls the whole thing back.

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
label. Never tell a visitor Reece serves only Florida. Coverage questions are zip-first
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

## Writing code here

Existing modules carry dated comments explaining *why* a thing is the way it is, usually naming the
incident that caused it. Match that: when you encode a non-obvious decision, say what it is defending
against. The comments are how the next session learns what a live pull cannot tell it.

Use a `deps` seam for anything that reaches the network or the database (`deps.fetch`,
`deps.supabase`, `deps.emitEvent`), so behaviour stays testable without a live service.
