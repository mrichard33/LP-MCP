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
