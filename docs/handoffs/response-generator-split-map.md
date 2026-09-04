# response-generator.js — prompt-text split map

Review artifact for `refactor/response-generator-prompt-split` (Handoff_ResponseGenerator_Split_v1).
Produced **before** any source change, against `src/response-generator.js` at
`origin/main` (2f2b301). Line numbers below are pre-split.

- File size at map time: **231,414 bytes / 3,619 lines**
- String + template literals over ~120 chars: **110**
- Total bytes in those literals: **91,183**
- `SYSTEM_PROMPT` alone: **63,434 bytes** (one static template literal, 47 sections, zero `${}`, zero backslash escapes)
- Prompt literals inside `buildResponsePrompt`: **34,910 bytes**

## Target modules

```
src/prompts/response-generator/
  index.js         barrel; response-generator.js imports only from here
  system-core.js   always-on SYSTEM_PROMPT sections + the assembled SYSTEM_PROMPT
  playbooks.js     per-action / per-state blocks (both prompts)
  framing.js       customer-facing framing per sender / channel / calendar
  examples.js      worked GOOD/BAD examples
  banned.js        prohibition and anti-pattern text (prompt-side only)
  context-frame.js the user-prompt data scaffolding (date/time, CRM, engagement, output contract)
```

`context-frame.js` is the one addition to the handoff's file list. The handoff's five
modules cover the SYSTEM_PROMPT well, but roughly a third of the user-prompt text is
neither playbook nor framing nor prohibition: it is the labelled data frame the
orchestrator assembles around the live context (`LEAD:`, `PIPELINE:`, `TIME NOW:`,
`CONVERSATION HISTORY:`, the estimate block, the output contract). Folding it into
`system-core.js` would mix system-prompt copy with user-prompt copy in one file; it is
~450 lines, well over the handoff's ~40-line fold threshold. Everything else follows the
handoff exactly.

## Size expectation — read before Step 3

The handoff's ≤ 95 KB target is **not reachable by moving prompt text alone**. The
arithmetic, from the measurements above:

| | bytes |
| --- | --- |
| File today | 231,414 |
| − `SYSTEM_PROMPT` | −63,434 |
| − prompt literals in `buildResponsePrompt` | −34,910 |
| − "why this block exists" comments moving with their blocks | ≈ −11,000 |
| + `P.name(args)` call sites replacing them | ≈ +9,000 |
| **Projected** | **≈ 131,000** |

What is left is not prompt text: ~47 KB of comments outside `buildResponsePrompt`
(including a 12.7 KB version-history header), ~62 KB of orchestration code, and
`generateResponse` at 30 KB. Getting under 95 KB from there means deleting the changelog
header or splitting the orchestration — both explicitly out of scope in this handoff.
Step 3 will report the real number; the split is judged by the snapshot test, not the
byte count.

## Exports (all keep name, signature, and module — none are edited)

| Line | Export |
| --- | --- |
| 1129 | `function formatRepFirstName(raw)` |
| 1173 | `function isRandyName(name)` |
| 1178 | `function resolveReplySenderName()` |
| 1221 | `function last10Digits(raw)` |
| 1233 | `function resolveSmsSenderIdentity(fromNumber)` |
| 1275 | `function threadCarriesSignOff(conversation, signature)` |
| 1298 | `function getReplySenderAllowlist()` |
| 1320 | `function normalizeThreadSender(threadSender)` |
| 1345 | `function resolveEmailSender(threadSender)` |
| 1383 | `function resolveOwningRepName(context)` |
| 1441 | `function derivePostAppointment(context, snapshot = null)` |
| 1456 | `function detectContextDrift(context, snapshot)` |
| 1625 | `function buildResponsePrompt(context, channel, triggerMessage, kbPack, classification, fastTrack, trafficTemp, availability, opts = {})` |
| 2704 | `function findUnresolvedTokens(message)` |
| 2749 | `function findTimelinePromises(message)` |
| 2796 | `function assertAcknowledgmentBody(body, opts = {})` |
| 2832 | `function stripDanglingLinkReferences(message)` |
| 2952 | `const CONF_FLOW_MERGE_KEYS` |
| 2969 | `async function buildConfFlowContext(contactId, context, { now, fetchContact })` |
| 3019 | `function applyConfFlowMergeKeys(text, confFlowContext)` |
| 3032 | `async function generateResponse(contactId, channel, triggerMessage, opts = {})` |

One export is **added** in Step 1: `getResponseSystemPrompt()`, a pure pass-through
returning `SYSTEM_PROMPT`. `buildResponsePrompt` already returns byte-for-byte what
`callLLM` receives as `user` (`callClaude(userPrompt)` passes it straight through), but
the `system` string is a module-private const, so the snapshot test cannot see it
without a seam. The seam has no logic: `return SYSTEM_PROMPT;`.

## Module-level `process.env` reads (must stay in response-generator.js)

`scripts/test-agentic-reply-sender.js` re-imports the module with a `?sender=` query
string to force re-evaluation of load-time env. Every read below stays at module scope in
`response-generator.js`; none moves into a prompt module.

| Line | Read |
| --- | --- |
| 285 | `RESPONSE_GENERATOR_MAX_TOKENS` → `MAX_TOKENS` |
| 286 | `REECE_TIMEZONE` → `PROMPT_TIMEZONE` |
| 289 | `RESPONSE_GENERATOR_EDITS_LIMIT` → `RECENT_EDITS_LIMIT` |
| 295 | `RESPONSE_GEN_SB_TIMEOUT_MS` → `RESPONSE_GEN_SB_TIMEOUT_MS` |
| 304–307 | `REECE_DOMAIN_ALLOWLIST` → `REECE_DOMAIN_ALLOWLIST` |

Read lazily inside functions (unchanged, listed for the snapshot test's env freeze):
`AGENTIC_REPLY_SENDER_NAME` (1157), `AGENTIC_SMS_NUMBER_MARK` (1239),
`AGENTIC_SMS_NUMBER_TEAM` (1250), `AGENTIC_REPLY_SENDER_ALLOWLIST` (1299),
`NAMED_STORM_MODE` (1968), `CANVASS_PREFERRED_TIME_FIELD_ID` (2984).

## Consumers (not edited)

`src/send-message-handler.js`, `src/groupme.js`, `src/actions/approval-path.js` (dynamic
import), `scripts/test-responder-context.js`, `scripts/test-sms-sender-identity.js`,
`scripts/test-appointment-phase.js`, `scripts/test-agentic-reply-sender.js` (plain +
`?sender=` re-import), `scripts/dryrun-escalation-ack.js`.

## Every literal over ~120 chars

| Lines | Chars | Kind | Label | Interpolates | Target |
| --- | --- | --- | --- | --- | --- |
| 306 | 154 | static | Default allowlist of Reece link domains | — | stays (code-side URL validator config) |
| 326–1100 | 63434 | static | SYSTEM_PROMPT — one template literal, 47 sections | — | split by section, see table below |
| 1639 | 266 | interpolated | Author is the in-office rep | `authorName \|\| 'the Reece office team'`<br>`authorName ? \`${authorName} is the ONLY name you may sign or self-identify with.\` : 'Write in company voice (we / our team) and do not self-identify by name.'` | framing |
| 1640 | 389 | static | Other named people stay third person | — | framing |
| 1641 | 128 | static | Never write a merge-tag name | — | framing |
| 1654 | 156 | interpolated | This reply leaves the shared line | `ident.matched ? '' : ' (the sending number could not be confirmed, so treat it as the shared line)'` | framing |
| 1655 | 396 | interpolated | Give name plus shared-line caveat both | `ident.nameIfAsked` | framing |
| 1656 | 125 | static | Never volunteer the shared-line explanation unasked | — | framing |
| 1659 | 199 | interpolated | Direct line answers with that name | `ident.signature` | framing |
| 1668 | 228 | interpolated | Thread already signed, do not resign | `ident.signature` | framing |
| 1670 | 230 | interpolated | Unsigned thread signs once when substantive | `ident.signature` | framing |
| 1671 | 226 | static | Short acknowledgments stay unsigned entirely | — | framing |
| 1678 | 143 | static | SMS length, question, and link constraints | — | context-frame |
| 1683 | 181 | interpolated | Today is date, never propose past | `formatTodayForPrompt()` | context-frame |
| 1713 | 173 | interpolated | Appointment imminent, rep is en route | `at`<br>`mins` | context-frame |
| 1714 | 261 | interpolated | Appointment window open right now | `at`<br>`Math.abs(mins)`<br>`at` | context-frame |
| 1715 | 260 | interpolated | Appointment passed, window has closed | `at`<br>`Math.abs(mins)` | context-frame |
| 1717 | 214 | interpolated | Appointment on record, time not confirmed | `context.lp.appointment_date \|\| 'an upcoming date'` | context-frame |
| 1718 | 288 | interpolated | Past appointment, exact time not confirmed | `context.lp.appointment_date \|\| 'an earlier date'` | context-frame |
| 1719 | 153 | static | Appointment today, exact time not confirmed | — | context-frame |
| 1724 | 154 | interpolated | Classification, confidence, and classifier method line | `classification.intent_class`<br>`classification.confidence?.toFixed(2) \|\| 'n/a'`<br>`classification.classification_method` | context-frame |
| 1757 | 274 | interpolated | Broadcast reply escalated, no handoff bridge | `bridgeName` | framing |
| 1762 | 566 | interpolated | Randy broadcast bridge, exact opener wording | `bridgeName`<br>`senderName`<br>`senderName`<br>`bridgeName`<br>`senderName`<br>`bridgeName` | framing |
| 1766 | 362 | interpolated | Signed broadcast, bridge in company voice | `bridgeName`<br>`bridgeName`<br>`bridgeName` | framing |
| 1771 | 367 | static | Company-signed broadcast, no personal name | — | framing |
| 1777 | 338 | interpolated | Same sender continuing their own thread | `senderName`<br>`senderName`<br>`senderName` | framing |
| 1779 | 274 | static | Rep-written thread, open without bridge | — | framing |
| 1805 | 314 | interpolated | Analyzer routed this to a human | `opts.escalationCategory ? \`, category ${opts.escalationCategory}\` : ''` | playbooks |
| 1806 | 162 | interpolated | You may confirm and name owner | `owner ? \`; name the person who now owns it (${owner})\` : ''` | playbooks |
| 1807 | 270 | static | You must not propose or ask | — | playbooks |
| 1808 | 423 | static | Never commit to any response timeline | — | playbooks |
| 1810 | 149 | static | Acknowledgment overrides fast-track and stage conduct | — | playbooks |
| 1832 | 207 | interpolated | Contact is past their appointment, evidence | `postAppt.reasons.join(', ')` | playbooks |
| 1833 | 159 | static | Prohibited items override every booking instruction | — | playbooks |
| 1835 | 131 | static | Banned return-visit words and ideas | — | playbooks |
| 1836 | 162 | static | Never re-ask decision-makers after the visit | — | playbooks |
| 1838 | 271 | static | Never imply anyone is coming back | — | playbooks |
| 1840 | 208 | static | Exception: a genuine future appointment exists | — | playbooks |
| 1842 | 233 | static | What to do instead, under-promise | — | playbooks |
| 1847 | 193 | static | Fast track hyperactive buyer, skip education | — | playbooks |
| 1849 | 202 | static | Fast track booking push is suppressed | — | playbooks |
| 1860 | 192 | interpolated | Pre-computed canvass reschedule options A/B | `cfc.option_a`<br>`cfc.option_b` | playbooks |
| 1861 | 446 | interpolated | Alternative-of-choice close with exactly two | `cfc.option_a`<br>`cfc.option_b` | playbooks |
| 1882 | 366 | static | Approved script is the reply backbone | — | playbooks |
| 1883 | 384 | static | Re-delivery rule, never resend the script | — | playbooks |
| 1899 | 145 | interpolated | Entry source, lead score, date added | `context.lead.entry_source \|\| 'unknown'`<br>`context.lead.lead_score`<br>`context.lead.date_added \|\| 'unknown'` | context-frame |
| 1912 | 220 | interpolated | Decision-maker presence state on file | `dmState === true ? 'CONFIRMED (all decision-makers attending)' : dmState === false ? 'ANSWERED BUT PENDING/NEGATIVE (do not re-ask this turn unless they volunteer an update)' : 'NEVER ASKED'` | context-frame |
| 1913 | 234 | static | Never ask for information already known | — | context-frame |
| 1920 | 445 | interpolated | Zip verified inside the service area | `opts.serviceArea.zip`<br>`opts.serviceArea.city ? \` (${opts.serviceArea.city})\` : ''`<br>`opts.serviceArea.city \|\| 'your area'` | framing |
| 1922 | 551 | interpolated | Zip outside service area, polite exit | `opts.serviceArea.zip` | framing |
| 1928 | 479 | interpolated | Tentative city match, confirm by zip | `opts.serviceAreaTentative.city`<br>`opts.serviceAreaTentative.city`<br>`opts.serviceAreaTentative.city` | framing |
| 1941 | 414 | static | Only the dispatch phone number, ever | — | banned |
| 1958 | 252 | interpolated | Trust level score and its band | `t`<br>`t <= 2 ? 'LOW — value-first: give (a guide, an answer) before asking; no booking CTA as the primary ask' : t === 3 ? 'NEUTRAL — free estimate framing, soft booking ask allowed' : 'HIGH — direct booking ask appropriate'` | context-frame |
| 1964 | 172 | interpolated | Open objection state, entered, attempt count | `os.state_code`<br>`os.parent_state ? \` (parent: ${os.parent_state})\` : ''`<br>`os.entered_at \|\| 'unknown'`<br>`os.attempt_number ?? 0` | playbooks |
| 1965 | 263 | interpolated | Objection turn one listens, turn two | `turn` | playbooks |
| 1969 | 305 | static | Named-storm posture, empathy over persuasion | — | playbooks |
| 1997 | 214 | static | Guide offer outstanding, never re-offer it | — | playbooks |
| 2006 | 133 | interpolated | Pipeline, stage, status, days in stage | `pipeStr`<br>`stageStr`<br>`context.pipeline.status`<br>`context.pipeline.days_in_stage` | context-frame |
| 2021 | 121 | static | Authoritative customer estimate block header | — | context-frame |
| 2033 | 214 | static | Use only figures from this block | — | context-frame |
| 2034 | 216 | static | Estimate block is the only source | — | context-frame |
| 2040 | 130 | interpolated | LP disposition code and its label | `context.lp.disposition \|\| 'none'`<br>`context.lp.disposition_label ? ' (' + context.lp.disposition_label + ')' : ''` | context-frame |
| 2092 | 627 | static | How to use the contact notes | — | context-frame |
| 2107 | 235 | interpolated | Engagement opens, clicks, replies, VSL watched | `context.engagement?.emails_opened \|\| 0`<br>`context.engagement?.links_clicked \|\| 0`<br>`context.engagement?.replies_count \|\| 0`<br>`context.engagement?.vsl_watched ? 'watched' : 'not watched'` | context-frame |
| 2124 | 260 | static | Anti-repetition hard rule on outbound history | — | banned |
| 2125 | 379 | static | Answered-question hard rule, act on answers | — | banned |
| 2175 | 233 | static | Ask-first protocol governs including the link | — | context-frame |
| 2177 | 244 | static | Auto-book confirmations carry no booking link | — | context-frame |
| 2178 | 208 | static | Cancellation flow carries no booking link | — | context-frame |
| 2191 | 182 | interpolated | Reviewer corrections are lessons, not templates | `classification.intent_class` | context-frame |
| 2219 | 215 | static | Call purpose: go over pricing questions | — | framing |
| 2220 | 141 | static | Call purpose: answer their general questions | — | framing |
| 2221 | 163 | static | Call purpose: confirm details before visit | — | framing |
| 2222 | 139 | static | Call purpose: the lead requested callback | — | framing |
| 2224 | 226 | interpolated | Call purpose line with neutral fallback | `purposeCopy \|\| 'unknown — use neutral copy ("…will give you a call [day] at [time] ET") and call it "your call". NEVER say "to confirm a few details" unless the purpose actually is a pre-visit confirmation.'` | framing |
| 2224 | 192 | static | Call purpose line with neutral fallback | — | framing |
| 2225 | 145 | static | Every rendered call time states ET | — | framing |
| 2227 | 236 | static | Mirror rule beats the purpose map | — | framing |
| 2239 | 158 | interpolated | In-home visit missing required information list | `bcg.resolved_calendar_name`<br>`idGate.missing.join(', ')` | playbooks |
| 2244 | 187 | interpolated | Ask for one missing item only | `askText` | playbooks |
| 2246 | 493 | static | Already-answered check before the decision-maker question | — | playbooks |
| 2247 | 142 | static | If lead pushes, explain then ask | — | playbooks |
| 2251 | 282 | interpolated | Prerequisites satisfied, propose times and book | `bcg.resolved_calendar_name`<br>`bcg.booking_duration_minutes` | playbooks |
| 2252 | 211 | interpolated | Decision-makers and address currently on file | `bcg.dm_present_value \|\| (idGate ? String(idGate.decision_maker_confirmed) : 'not yet captured')`<br>`bcg.address_on_file \|\| (idGate?.known?.address \|\| '(none on file)')` | playbooks |
| 2253 | 309 | static | Hard confirmation status is set server-side | — | playbooks |
| 2255 | 251 | static | Ask for email once, this turn | — | playbooks |
| 2257 | 161 | interpolated | Email already on file or asked | `idGate?.known?.email ? \`already on file (${idGate.known.email}) — NEVER ask for it.\` : 'already asked once — do NOT ask again; proceed without it.'` | playbooks |
| 2259 | 160 | static | Upgrade path for an existing new appointment | — | playbooks |
| 2260 | 406 | static | Yes or Solo Owner upgrades to confirmed | — | playbooks |
| 2261 | 134 | static | No or Uncertain keeps it new | — | playbooks |
| 2262 | 171 | static | Never book when an appointment exists | — | playbooks |
| 2266 | 392 | interpolated | Phone booking has no in-home gate | `bcg.resolved_calendar_name`<br>`bcg.booking_duration_minutes` | playbooks |
| 2280 | 493 | static | Priority one, the cancellation flow machine | — | playbooks |
| 2281 | 430 | static | Priority 1.5, in-home confirmation upgrade | — | playbooks |
| 2284 | 456 | interpolated | Priority 1.6, past appointment governs turn | `context.lp.appointment_date`<br>`n`<br>`n === 1 ? '' : 's'` | playbooks |
| 2288 | 273 | interpolated | Priority 1.65, appointment was cancelled | `when` | playbooks |
| 2291 | 245 | static | Priority 1.7, prerequisites are not satisfied | — | playbooks |
| 2293 | 1188 | static | Priority two, auto-book on hard confirmation | — | playbooks |
| 2294 | 201 | static | Priority three, closing acknowledgment then stop | — | playbooks |
| 2296 | 190 | static | Priority five, default booking ask-first protocol | — | playbooks |
| 2297 | 207 | static | Return only the JSON object, unwrapped | — | context-frame |
| 2400 | 144 | interpolated | Truncated JSON recovery warning log line | `clean.length - jsonStart` | stays (console warning, not prompt text) |
| 2410 | 128 | interpolated | JSON recovered from preamble warning log | `preambleLen`<br>`preview`<br>`preambleLen > 80 ? '...' : ''` | stays (console warning, not prompt text) |
| 2450 | 123 | interpolated | Rejected decision_makers_present value warning log | `v` | stays (console warning, not prompt text) |
| 2910 | 171 | interpolated | URL sanitizer mutations applied warning log | `mutations.join(', ')`<br>`channel`<br>`canonicalIsMergeTag ? 'merge_tag' : (canonicalUrl ? 'url' : 'none')` | stays (console warning, not prompt text) |
| 3055 | 145 | interpolated | Context drift warning log line | `contactId`<br>`drift.snapshot_stage`<br>`drift.live_stage` | stays (console warning, not prompt text) |
| 3101 | 162 | interpolated | Short-circuit classification warning log line | `contactId`<br>`classification.intent_class`<br>`classification.ghl_handoff_tag`<br>`classification.classification_method` | stays (console warning, not prompt text) |
| 3186 | 130 | interpolated | Booking calendar resolution failed warning log | `contactId`<br>`err.message` | stays (console warning, not prompt text) |
| 3197 | 129 | interpolated | Calendar availability fetch threw warning log | `contactId`<br>`calendarId`<br>`err.message` | stays (console warning, not prompt text) |
| 3296 | 167 | interpolated | Out-of-area exit message sent literally | `oaFirstName ? \`, ${oaFirstName}\` : ''` | stays (dispatched copy, never reaches the prompt) |

### SYSTEM_PROMPT section split (lines 326–1100)

| Lines | Chars | Label | Target |
| --- | --- | --- | --- |
| 326–395 | 8245 | Identity, framework, voice, AI disclosure | system-core |
| 396–398 | 545 | Attractive character Randy Reece, email only | framing |
| 399–452 | 9177 | Qualification cap through universal fallback rules | system-core |
| 453–473 | 1387 | Email reply opener, thread sender awareness | framing |
| 474–553 | 5714 | Trust model through booking escape hatch | system-core |
| 554–599 | 8067 | Objection handling, PPR gate, confirmation spec | playbooks |
| 600–606 | 390 | Breadcrumbing, one small next step | system-core |
| 607–610 | 305 | Brand-language rule, forbidden product words | banned |
| 611–845 | 15574 | Closing acks, auto-book, cancellation state machine | playbooks |
| 846–988 | 6574 | Worked examples, auto-book and cancellation | examples |
| 989–1018 | 1840 | Anti-patterns, the never-write list | banned |
| 1019–1042 | 1958 | Guide offer, booking failure exit | playbooks |
| 1043–1073 | 2386 | Hard prohibitions, zero exception list | banned |
| 1074–1100 | 1296 | Channel constraints and response format contract | system-core |

## Not moved, and why

- **306** `REECE_DOMAIN_ALLOWLIST` default — consumed by `urlHostAllowed()`, a code-side
  validator. Handoff: "If a banned list is consumed by code, it stays in code."
- **2400, 2410, 2450, 2910, 3055, 3101, 3186, 3197** — `console.warn` operator strings.
  Not prompt text.
- **3296** `oaMessage` — the out-of-area exit line, dispatched literally by the
  `SERVICE_AREA_EXIT` rule. It never reaches the LLM prompt, so the snapshot test cannot
  guard it; moving it would be an unguarded copy move.

## The guard

Any future change to prompt copy must be made in `src/prompts/response-generator/` and
land with a deliberate snapshot update:

```
UPDATE_SNAPSHOTS=1 node --test scripts/test-response-prompt-snapshot.js   # regenerate
node --test scripts/test-response-prompt-snapshot.js                      # must be green
```

The diff of `scripts/fixtures/response-prompt/__snapshots__/*.txt` **is** the copy change
and is what gets reviewed.
