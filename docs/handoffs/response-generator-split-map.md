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

---

# FINAL LAYOUT (Step 4, post-split)

Everything above is the PRE-split map and its line numbers are historical — kept
as the review artifact it was written to be. Below is where the text actually
landed. `src/response-generator.js` now contains ZERO inline prompt literals.

| File | Bytes | Exports |
| --- | --- | --- |
| `src/prompts/response-generator/system-core.js` | 27,260 | 5 |
| `src/prompts/response-generator/banned.js` | 7,502 | 5 |
| `src/prompts/response-generator/examples.js` | 7,408 | 1 |
| `src/prompts/response-generator/framing.js` | 16,921 | 24 |
| `src/prompts/response-generator/playbooks.js` | 50,073 | 28 |
| `src/prompts/response-generator/context-frame.js` | 26,157 | 89 |
| `src/prompts/response-generator/index.js` | 1,654 | barrel |
| **`src/response-generator.js`** | **136,675** | orchestration only |

`src/response-generator.js`: **231,414 → 136,675 bytes** (94,739 moved out, 41% smaller).

### `system-core.js` — 5 exports

| Export | Line | Was (pre-split) |
| --- | --- | --- |
| `SYSTEM_IDENTITY_AND_VOICE` | 15 | 326-395 |
| `SYSTEM_QUALIFICATION_AND_COMPLIANCE` | 89 | 399-452 |
| `SYSTEM_TRUST_AND_BOOKING_MODEL` | 147 | 474-553 |
| `SYSTEM_BREADCRUMBING` | 231 | 600-606 |
| `SYSTEM_CHANNEL_AND_RESPONSE_FORMAT` | 242 | 1074-1100 |

### `banned.js` — 5 exports

| Export | Line | Was (pre-split) |
| --- | --- | --- |
| `BRAND_LANGUAGE_RULE` | 15 | 607-610 |
| `ANTI_PATTERNS` | 23 | 989-1018 |
| `HARD_PROHIBITIONS` | 57 | 1043-1073 |
| `CONVERSATION_HARD_RULES` | 92 | 1852-1853 |
| `dispatchPhoneRule` | 99 | 1668-1669 |

### `examples.js` — 1 exports

| Export | Line | Was (pre-split) |
| --- | --- | --- |
| `EXAMPLES_AUTOBOOK_AND_CANCELLATION` | 15 | 846-988 |

### `framing.js` — 24 exports

| Export | Line | Was (pre-split) |
| --- | --- | --- |
| `RANDY_ATTRACTIVE_CHARACTER` | 15 | 396-398 |
| `EMAIL_OPENER_THREAD_AWARENESS` | 22 | 453-473 |
| `signOffFooter` | 47 | 1234-1236 |
| `signOffNotYetSigned` | 55 | 1231-1232 |
| `signOffAlreadySigned` | 62 | 1229 |
| `signOffRuleHeader` | 68 | 1227 |
| `directLineIdentity` | 74 | 1219-1220 |
| `LINE_IDENTITY_HEADER` | 81 | 1213 |
| `authorship` | 87 | 1199-1203 |
| `sharedLineIdentity` | 97 | 1211-1213 |
| `APPOINTMENT_LANGUAGE_FOOTER` | 105 | 1776-1777 |
| `callPurposeLines` | 112 | 1773-1774 |
| `appointmentLanguage` | 119 | 1760-1762 |
| `CALL_PURPOSE_COPY` | 129 | 1766-1769 |
| `serviceAreaCityTentative` | 138 | 1479 |
| `serviceAreaOutside` | 144 | 1473 |
| `serviceAreaVerified` | 150 | 1471 |
| `EMAIL_OPENER_REP_WRITTEN` | 156 | 1330 |
| `emailOpenerInherited` | 162 | 1328 |
| `EMAIL_OPENER_COMPANY_VOICE` | 168 | 1322 |
| `emailBridgeCompanyVoice` | 174 | 1317 |
| `emailBridgeFromBroadcast` | 180 | 1313 |
| `emailBridgeSuppressedByEscalation` | 186 | 1308 |
| `EMAIL_THREAD_CONTEXT_HEADER` | 192 | 1306 |

### `playbooks.js` — 28 exports

| Export | Line | Was (pre-split) |
| --- | --- | --- |
| `OBJECTION_PPR_AND_CONFIRMATION_SPEC` | 15 | 554-599 |
| `CLOSING_AUTOBOOK_AND_CANCELLATION` | 65 | 611-845 |
| `GUIDE_OFFER_BOOKING_FAILURE_EXIT` | 304 | 1019-1042 |
| `scriptDirective` | 332 | 1127-1131 |
| `humanCorrection` | 342 | 1112-1117 |
| `canvassConfFlow` | 353 | 1102-1108 |
| `FAST_TRACK_SUPPRESSED_POST_APPOINTMENT` | 365 | 1095 |
| `FAST_TRACK_ACTIVE` | 371 | 1093 |
| `POST_APPOINTMENT_CLOSE` | 377 | 1088-1089 |
| `POST_APPOINTMENT_FUTURE_APPT_EXCEPTION` | 384 | 1086 |
| `postAppointmentBan` | 390 | 1077-1084 |
| `acknowledgmentOnlyConduct` | 403 | 1050-1057 |
| `GUIDE_OFFER_ELIGIBLE` | 416 | 1214 |
| `GUIDE_OFFER_OUTSTANDING` | 422 | 1212 |
| `guideOfferResolved` | 428 | 1210 |
| `NAMED_STORM_POSTURE` | 434 | 1184 |
| `objectionState` | 440 | 1178-1181 |
| `PRIORITY_ORDER_TAIL` | 449 | 1495-1498 |
| `PRIORITY_PREREQS_NOT_SATISFIED` | 458 | 1493 |
| `priorityCancelledAppointment` | 464 | 1490 |
| `priorityPastAppointment` | 470 | 1486 |
| `priorityOrderHead` | 476 | 1481-1483 |
| `phoneBooking` | 484 | 1467-1469 |
| `IN_HOME_GATE_UPGRADE_PATH` | 492 | 1461-1465 |
| `inHomeGateEmailKnown` | 502 | 1459 |
| `IN_HOME_GATE_EMAIL_ASK` | 508 | 1457 |
| `inHomeGateSatisfied` | 514 | 1452-1455 |
| `inHomePrerequisitesNotSatisfied` | 523 | 1440-1450 |

### `context-frame.js` — 89 exports

| Export | Line | Was (pre-split) |
| --- | --- | --- |
| `OUTPUT_CONTRACT` | 21 | 1475 |
| `EDITORIAL_FEEDBACK_FOOTER` | 27 | 1410 |
| `editCaseLines` | 33 | 1404 |
| `recentEditsHeader` | 39 | 1401-1402 |
| `NO_BOOKING_LINK_AUTHORIZED` | 46 | 1395-1397 |
| `CANONICAL_BOOKING_LINK_FOOTER` | 54 | 1393 |
| `BOOKING_LINK_PLAIN_URL` | 60 | 1391 |
| `BOOKING_LINK_MERGE_TAG_RULES` | 66 | 1385-1389 |
| `canonicalBookingLinkHeader` | 76 | 1380-1382 |
| `CALENDAR_AVAILABILITY_FOOTER` | 84 | 1372 |
| `CALENDAR_AVAILABILITY_HEADER` | 90 | 1365 |
| `KB_PACK_FOOTER` | 96 | 1358 |
| `KB_PACK_HEADER` | 102 | 1356 |
| `EXISTING_APPOINTMENTS_FOOTER` | 108 | 1348-1349 |
| `EXISTING_APPOINTMENTS_HEADER` | 115 | 1346 |
| `editCaseInbound` | 122 | 1395 |
| `editCaseDraft` | 129 | 1396 |
| `editCaseCorrection` | 136 | 1397 |
| `editCaseFinal` | 143 | 1398 |
| `conversationHistoryEntry` | 149 | 1330 |
| `CONVERSATION_HISTORY_HEADER` | 155 | 1328 |
| `completedWorkflows` | 161 | 1325 |
| `activeWorkflows` | 167 | 1324 |
| `engagement` | 173 | 1319 |
| `priorReasoning` | 179 | 1316 |
| `recommendedArc` | 185 | 1315 |
| `recommendedAction` | 191 | 1314 |
| `emotionalState` | 197 | 1313 |
| `priorObjection` | 203 | 1311 |
| `priorBuyerStage` | 209 | 1309 |
| `PRIOR_AI_ANALYSIS_HEADER` | 215 | 1308 |
| `inboundMessage` | 221 | 1444 |
| `INBOUND_MESSAGE_HEADER` | 227 | 1443 |
| `lpRecentCalls` | 233 | 1291 |
| `lpNote` | 239 | 1285 |
| `LP_NOTES_HEADER` | 245 | 1281 |
| `lpDataStale` | 251 | 1277 |
| `lpLostReason` | 257 | 1274 |
| `lpClosedWon` | 263 | 1273 |
| `lpDemoAndAppointment` | 269 | 1272 |
| `lpSalesRep` | 275 | 1258 |
| `lpDisposition` | 281 | 1252 |
| `LP_CRM_HEADER` | 287 | 1251 |
| `ESTIMATE_FOOTER` | 293 | 1247 |
| `ESTIMATE_PROHIBITION_CARVE_OUT` | 299 | 1246 |
| `ESTIMATE_RULES` | 305 | 1245 |
| `estimateWindowCount` | 311 | 1243 |
| `estimateTotal` | 317 | 1240 |
| `ESTIMATE_HEADER` | 323 | 1233 |
| `pipeline` | 329 | 1218 |
| `trustLevelScore` | 335 | 1173 |
| `KNOWN_CONTACT_PROFILE_FOOTER` | 341 | 1130 |
| `KNOWN_CONTACT_PROFILE_RULE` | 347 | 1129 |
| `knownDecisionMakers` | 353 | 1128 |
| `knownAddress` | 359 | 1127 |
| `knownEmail` | 365 | 1126 |
| `knownPhone` | 371 | 1125 |
| `knownName` | 377 | 1124 |
| `KNOWN_CONTACT_PROFILE_HEADER` | 383 | 1123 |
| `leadEntry` | 389 | 1115 |
| `leadName` | 395 | 1114 |
| `trafficTemperature` | 401 | 973 |
| `classifierReasoning` | 407 | 971 |
| `classification` | 413 | 970 |
| `todayIs` | 419 | 929 |
| `currentDateHeader` | 425 | 928 |
| `appointmentWhenPast` | 433 | 1266-1268 |
| `APPOINTMENT_WHEN_TODAY` | 434 | 1266-1268 |
| `appointmentWhenUpcoming` | 435 | 1266-1268 |
| `appointmentPhaseLinesWithTime` | 443 | 958-961 and 963-965 |
| `appointmentPhaseLinesDateOnly` | 449 | — |
| `timeNowHardRule` | 461 | 940-944 |
| `SMS_CONSTRAINTS` | 472 | 924-925 |
| `EMAIL_CONSTRAINTS` | 473 | 924-925 |
| `canonicalLinkCalendarNote` | 477 | 1364 |
| `CONTACT_NOTES_GUIDANCE` | 483 | 1288 |
| `contactNote` | 489 | 1286 |
| `CONTACT_NOTES_HEADER` | 495 | 1283 |
| `suppressionTags` | 501 | 1179 |
| `knownObjections` | 507 | 1176 |
| `activeEntry` | 513 | 1173 |
| `buyerJourneyTag` | 519 | 1170 |
| `buyerTag` | 525 | 1169 |
| `stageTag` | 531 | 1168 |
| `funnelStageTag` | 537 | 1153 |
| `inferredBuyerStage` | 543 | 1144 |
| `REGENERATION_NOTE_FOOTER` | 549 | 1095 |
| `REGENERATION_NOTE_HEADER` | 555 | 1093 |
| `channelHeader` | 561 | 884 |
