/**
 * context-frame — prompt text for src/response-generator.js.
 *
 * The USER prompt's data frame: the labelled scaffolding the orchestrator
 * assembles around live context (date and clock, classification, lead and CRM
 * fields, engagement, conversation history, the KB pack and availability
 * wrappers, the canonical booking link, and the output contract).
 *
 * Distinct from system-core: those sections are the standing rules and change
 * rarely; these lines change whenever the shape of the context changes, which
 * is often. Keeping them apart is the point of the split — the file that churns
 * is not the file that is locked.
 *
 * Copy only. No logic, no conditionals, no env reads. Byte-identical to what
 * lived inline before the 2026-09 split; scripts/test-response-prompt-snapshot.js
 * proves it, and any edit here needs a deliberate re-baseline.
 */

// The output contract parseJsonFromResponse depends on. Bare JSON object, no preamble, companion_action only when a priority criterion matched.
// Was response-generator.js:1475.
export const OUTPUT_CONTRACT = [
  `Return ONLY the JSON object — first character must be {, last must be }, no preamble. Include companion_action only when the appropriate priority criteria match; otherwise omit the field or set it to null.`,
];

// Closes the editorial feedback block.
// Was response-generator.js:1410.
export const EDITORIAL_FEEDBACK_FOOTER = [
  `═══════ END EDITORIAL FEEDBACK ═══════`,
];

// One reviewed case. The remaining lines of a case are conditional on which fields the edit row carries, so they are separate exports below.
// Was response-generator.js:1404.
export const editCaseLines = (caseNumber) => [
  `\nCASE ${caseNumber}:`,
];

// v2.7.4 in-context learning: real corrections human reviewers made to past responses for this intent class. Lessons, not templates.
// Was response-generator.js:1401-1402.
export const recentEditsHeader = (intentClass) => [
  `\n═══════ RECENT EDITORIAL FEEDBACK (lessons learned from prior reviews) ═══════`,
  `These are real corrections human reviewers made to past responses for similar inbound types (intent class: ${intentClass}). Apply the LESSONS — don't copy verbatim.`,
];

// No link resolved for this reply, so no URL and no merge tag may appear at all.
// Was response-generator.js:1395-1397.
export const NO_BOOKING_LINK_AUTHORIZED = [
  `\n═══════ NO BOOKING LINK AUTHORIZED ═══════`,
  `No booking link is available for this response. Do NOT include any URL or merge tag in your message.`,
  `═══════ END NO BOOKING LINK AUTHORIZED ═══════`,
];

// Closes the canonical booking link block.
// Was response-generator.js:1393.
export const CANONICAL_BOOKING_LINK_FOOTER = [
  `═══════ END CANONICAL BOOKING LINK ═══════`,
];

// A plain URL rather than a merge tag: paste it exactly, invent nothing.
// Was response-generator.js:1391.
export const BOOKING_LINK_PLAIN_URL = [
  `If you include a booking link: paste this exact string. No markdown. No modifications. No invented domains.`,
];

// Merge-tag mechanics plus the three exceptions that suppress the link entirely: a closing acknowledgment (v2.7.5), an auto-book confirmation (v2.7.7), and any state of the cancellation flow (v2.7.8).
// Was response-generator.js:1385-1389.
export const BOOKING_LINK_MERGE_TAG_RULES = [
  `This is a GHL TRIGGER LINK MERGE TAG. The double-braces are correct GHL syntax — render expected.`,
  `Per ASK-FIRST PROTOCOL: include this link ONLY when (a) the lead asked for the link or said "I'll pick", (b) the lead rejected proposed times and asked for alternatives via self-serve, or (c) CALENDAR AVAILABILITY is empty/missing.`,
  `v2.7.5 EXCEPTION: closing acknowledgments do NOT include the link.`,
  `v2.7.7 EXCEPTION (auto-book): hard confirmations of held times do NOT include the link — emit companion_action of type book_appointment instead. Status: "confirmed" if Q1+Q2+Q3 all pass (Q3 = "Yes" OR "Solo Owner"); "new" otherwise (DEFAULT).`,
  `v2.7.8 EXCEPTION (cancellation flow): when the lead is in any state of the CANCELLATION FLOW state machine, do NOT include the booking link. Use the appropriate state-machine response per the system prompt.`,
];

// The one link that may ever appear in a reply, given verbatim.
// Was response-generator.js:1380-1382.
export const canonicalBookingLinkHeader = (canonicalUrl) => [
  `\n═══════ CANONICAL BOOKING LINK — COPY VERBATIM IF YOU INCLUDE A LINK ═══════`,
  `The ONLY booking link you may include is this one, exactly as written:`,
  `  ${canonicalUrl}`,
];

// Closes the availability block.
// Was response-generator.js:1372.
export const CALENDAR_AVAILABILITY_FOOTER = [
  `═══════ END CALENDAR AVAILABILITY ═══════`,
];

// Opens the availability block. The preferred-time and offer-window blocks that follow are built elsewhere and passed in.
// Was response-generator.js:1365.
export const CALENDAR_AVAILABILITY_HEADER = [
  `\n═══════ CALENDAR AVAILABILITY ═══════`,
];

// Closes the KB pack.
// Was response-generator.js:1358.
export const KB_PACK_FOOTER = [
  `═══════ END KB PACK ═══════`,
];

// Opens the KB pack, the primary source the reply adapts rather than invents around.
// Was response-generator.js:1356.
export const KB_PACK_HEADER = [
  `\n═══════ KB PACK (PRIMARY SOURCE — adapt tone, do not invent) ═══════`,
];

// Cancel and reschedule companions may only use appointment_id values from this block.
// Was response-generator.js:1348-1349.
export const EXISTING_APPOINTMENTS_FOOTER = [
  `When emitting cancel_appointment or reschedule_appointment companions, use ONLY appointment_id values from this block.`,
  `═══════ END EXISTING APPOINTMENTS ═══════`,
];

// v2.7.8. Present only when the fetch returned appointments — the model is told elsewhere that an absent block means none on file.
// Was response-generator.js:1346.
export const EXISTING_APPOINTMENTS_HEADER = [
  `\n═══════ EXISTING APPOINTMENTS (active — upcoming, plus any that ended in the last 24h) — AUTHORITATIVE for cancel/reschedule ═══════`,
];

// One field of one reviewed edit row. The row-level conditionals stay in the
// orchestrator, so each field is its own export.
// Was response-generator.js:1395.
export const editCaseInbound = (text) => [
  `  Inbound was similar to: "${text}"`,
];

// One field of one reviewed edit row. The row-level conditionals stay in the
// orchestrator, so each field is its own export.
// Was response-generator.js:1396.
export const editCaseDraft = (text) => [
  `  AI initially drafted: "${text}"`,
];

// One field of one reviewed edit row. The row-level conditionals stay in the
// orchestrator, so each field is its own export.
// Was response-generator.js:1397.
export const editCaseCorrection = (text) => [
  `  Reviewer correction: "${text}"`,
];

// One field of one reviewed edit row. The row-level conditionals stay in the
// orchestrator, so each field is its own export.
// Was response-generator.js:1398.
export const editCaseFinal = (text) => [
  `  Final accepted version: "${text}"`,
];

// One turn of the conversation history. Truncation stays at the call site.
// Was response-generator.js:1330.
export const conversationHistoryEntry = (direction, text) => [
  `[${direction}] ${text}`,
];

// Opens the last ten turns, oldest first.
// Was response-generator.js:1328.
export const CONVERSATION_HISTORY_HEADER = [
  `\nCONVERSATION HISTORY (most recent last):`,
];

// Completed and sent workflow tags, capped at eight.
// Was response-generator.js:1325.
export const completedWorkflows = (tags) => [
  `Completed: ${tags}`,
];

// Which active-w* workflows the contact is enrolled in right now.
// Was response-generator.js:1324.
export const activeWorkflows = (tags) => [
  `Active Workflows: ${tags}`,
];

// Opens, clicks, replies and VSL state — the engagement signal behind traffic temperature.
// Was response-generator.js:1319.
export const engagement = (opens, clicks, replies, vsl) => [
  `\nENGAGEMENT: opens=${opens} | clicks=${clicks} | replies=${replies} | VSL=${vsl}`,
];

// The earlier analysis pass's own reasoning.
// Was response-generator.js:1316.
export const priorReasoning = (reasoning) => [
  `Prior reasoning: ${reasoning}`,
];

// Story arc recommended by the earlier analysis pass.
// Was response-generator.js:1315.
export const recommendedArc = (arc) => [
  `Recommended Arc: ${arc}`,
];

// Action recommended by the earlier analysis pass.
// Was response-generator.js:1314.
export const recommendedAction = (action) => [
  `Recommended Action: ${action}`,
];

// Emotional state read by the earlier analysis pass.
// Was response-generator.js:1313.
export const emotionalState = (state) => [
  `Emotional State: ${state}`,
];

// Objection type and confidence from the earlier analysis pass.
// Was response-generator.js:1311.
export const priorObjection = (objectionType, confidence) => [
  `Objection: ${objectionType} (conf: ${confidence})`,
];

// Buyer stage and confidence from the earlier analysis pass.
// Was response-generator.js:1309.
export const priorBuyerStage = (stage, confidence) => [
  `Buyer Stage: ${stage} (conf: ${confidence})`,
];

// Opens what an earlier analysis pass concluded about this contact.
// Was response-generator.js:1308.
export const PRIOR_AI_ANALYSIS_HEADER = [
  `\nPRIOR AI ANALYSIS:`,
];

// The message being answered, quoted.
// Was response-generator.js:1444.
export const inboundMessage = (triggerMessage) => [
  `"${triggerMessage}"`,
];

// Marks the inbound the reply must answer.
// Was response-generator.js:1443.
export const INBOUND_MESSAGE_HEADER = [
  `\nTHE INBOUND MESSAGE TO RESPOND TO:`,
];

// The last three call attempts and their results.
// Was response-generator.js:1291.
export const lpRecentCalls = (calls) => [
  `Recent Calls: ${calls}`,
];

// One LP rep note, attributed. Truncation stays at the call site.
// Was response-generator.js:1285.
export const lpNote = (by, noteText) => [
  `  [${by}] ${noteText}`,
];

// Opens the rep notes, framed as the most reliable intelligence on this contact.
// Was response-generator.js:1281.
export const LP_NOTES_HEADER = [
  `\nLP Rep Notes (most reliable intelligence):`,
];

// LP is stale on an ACTIVE disposition, so the status shown may have moved.
// Was response-generator.js:1277.
export const lpDataStale = (ageMinutes) => [
  `⚠️ LP data is ${ageMinutes}min stale on an ACTIVE disposition — treat status as approximate.`,
];

// Why the deal was lost, when LP records one.
// Was response-generator.js:1274.
export const lpLostReason = (lostReason) => [
  `LOST REASON: ${lostReason}`,
];

// Closed-won and the job value.
// Was response-generator.js:1273.
export const lpClosedWon = (jobValue) => [
  `CLOSED WON — $${jobValue}`,
];

// Demo state and appointment status on one line; the appointment phrasing is built above.
// Was response-generator.js:1272.
export const lpDemoAndAppointment = (demo, apptStatus) => [
  `Demo: ${demo} | Appointment: ${apptStatus}`,
];

// 2026-07-29 — labelled explicitly. The field rep is someone the customer has MET; left unlabelled beside "Ground Truth", the model signed as her and opened "Beverly here". She does not write these emails and must never appear to.
// Was response-generator.js:1258.
export const lpSalesRep = (repName) => [
  `Sales Rep (the FIELD rep who owns this deal — NOT the author of your reply): ${repName}`,
];

// LP disposition code, with its human label when there is one.
// Was response-generator.js:1252.
export const lpDisposition = (disposition, dispositionLabel) => [
  `Disposition: ${disposition}${dispositionLabel ? ' (' + dispositionLabel + ')' : ''}`,
];

// Opens LP, the ground-truth CRM.
// Was response-generator.js:1251.
export const LP_CRM_HEADER = [
  `\nLP CRM (Ground Truth):`,
];

// Closes the authoritative estimate block.
// Was response-generator.js:1247.
export const ESTIMATE_FOOTER = [
  `═══════ END CUSTOMER'S ACTUAL ESTIMATE ═══════`,
];

// Names itself as the single carve-out from HARD PROHIBITIONS. The default is still not to quote unless the lead's question calls for it.
// Was response-generator.js:1246.
export const ESTIMATE_PROHIBITION_CARVE_OUT = [
  `Per HARD PROHIBITIONS: never quote prices/estimates EXCEPT figures in this block. This block is the ONLY authoritative source. Default behavior remains: do not quote unless directly relevant to the lead's question.`,
];

// Only the figures in this block may be quoted — never a number from rep notes, conversation history, the model's own arithmetic, or training priors.
// Was response-generator.js:1245.
export const ESTIMATE_RULES = [
  `If you reference a dollar figure or window count in your reply, use ONLY the numbers in this block. NEVER quote a number from rep notes, prior conversation history, your own calculations, or training-data priors.`,
];

// Window count from the GHL estimate record.
// Was response-generator.js:1243.
export const estimateWindowCount = (windowCount) => [
  `Window Count: ${windowCount}`,
];

// The estimate total, already currency-formatted by the orchestrator.
// Was response-generator.js:1240.
export const estimateTotal = (formattedTotal) => [
  `Estimate Total (from Window Estimate Calculator): ${formattedTotal}`,
];

// v2.7.10. Injected ABOVE the LP section so the real figure establishes authority before any rep note — free-text notes had the model quoting stale ballparks (a $36,000 hallucination on 7jl9cVfry8OyQF6oI2V5, 2026-05-05).
// Was response-generator.js:1233.
export const ESTIMATE_HEADER = [
  `\n═══════ CUSTOMER'S ACTUAL ESTIMATE (AUTHORITATIVE — overrides any figure in rep notes / conversation history) ═══════`,
];

// Pipeline, stage, status and time in stage.
// Was response-generator.js:1218.
export const pipeline = (pipeStr, stageStr, status, daysInStage) => [
  `\nPIPELINE: ${pipeStr} | Stage: ${stageStr} | Status: ${status} | Days in stage: ${daysInStage}`,
];

// 2026-07-06 (Bot 2/3/4 consolidation). The band decides whether the reply gives before it asks: LOW is value-first with no booking CTA, NEUTRAL allows a soft ask, HIGH allows a direct one.
// Was response-generator.js:1173.
export const trustLevelScore = (t) => [
  `TRUST LEVEL SCORE: ${t}/5 (${t <= 2 ? 'LOW — value-first: give (a guide, an answer) before asking; no booking CTA as the primary ask' : t === 3 ? 'NEUTRAL — free estimate framing, soft booking ask allowed' : 'HIGH — direct booking ask appropriate'}).`,
];

// Closes the known-contact profile.
// Was response-generator.js:1130.
export const KNOWN_CONTACT_PROFILE_FOOTER = [
  `═══════ END KNOWN CONTACT PROFILE ═══════`,
];

// R5 — never re-ask a known field. Only a field marked NOT KNOWN may be asked for, one at a time, and only when the booking gate calls for it.
// Was response-generator.js:1129.
export const KNOWN_CONTACT_PROFILE_RULE = [
  `NON-NEGOTIABLE RULE: Never ask the customer for information already present in this profile — it is on file. Only a field marked NOT KNOWN may ever be asked for, one at a time, and only when the booking-gate rules below call for it.`,
];

// Decision-maker state: confirmed, answered but pending, or never asked. Only the last permits asking.
// Was response-generator.js:1128.
export const knownDecisionMakers = (dmConfirmed, dmAnswered) => [
  `Decision-maker presence: ${dmConfirmed ? 'CONFIRMED (all decision-makers attending)' : dmAnswered ? 'ANSWERED BUT PENDING/NEGATIVE (do not re-ask this turn unless they volunteer an update)' : 'NEVER ASKED'}`,
];

// Property address on file, or NOT KNOWN.
// Was response-generator.js:1127.
export const knownAddress = (address) => [
  `Property address: ${address || 'NOT KNOWN'}`,
];

// Email on file, or NOT KNOWN.
// Was response-generator.js:1126.
//
// 2026-09-11 (Alfredo Fontan incident, agent_actions 447887 / 447988): this
// line printed a bare `Email: <address>` with no owner stated. Asked "do you
// have an email to send this to you", the model read the only address in its
// context and answered "you can send them to alfredo.fontan@gmail.com" — the
// lead's own inbox. The label now names whose address it is and bans the
// misuse in the same breath.
export const knownEmail = (email) => [
  `Email (the CUSTOMER'S OWN address. Never tell them to send anything to it): ${email || 'NOT KNOWN'}`,
];

// 2026-09-11 — the company inbox. Always present, so the model never has to
// infer a destination address from whatever happens to be in context.
export const companyInbox = (inbox) => [
  `COMPANY INBOX: ${inbox}. This is the ONLY email address a customer may send us files, photos, measurements, or documents. When a customer asks where to email something, give this address. NEVER tell a customer to send anything to their own email address, and never invent any other address.`,
];

// Phone on file, or NOT KNOWN.
// Was response-generator.js:1125.
export const knownPhone = (phone) => [
  `Phone: ${phone || 'NOT KNOWN'}`,
];

// Name on file, or NOT KNOWN.
// Was response-generator.js:1124.
export const knownName = (name) => [
  `Name: ${name || 'NOT KNOWN'}`,
];

// v1.1. Hydrated from the GHL record plus everything extracted from this conversation.
// Was response-generator.js:1123.
export const KNOWN_CONTACT_PROFILE_HEADER = [
  `\n═══════ KNOWN CONTACT PROFILE (CRM record + this conversation) ═══════`,
];

// Entry source, lead score and date added.
// Was response-generator.js:1115.
export const leadEntry = (entrySource, leadScore, dateAdded) => [
  `Entry: ${entrySource} | Lead Score: ${leadScore} | Date Added: ${dateAdded}`,
];

// Who this reply is to.
// Was response-generator.js:1114.
export const leadName = (name) => [
  `\nLEAD: ${name}`,
];

// Calibrates hook intensity per the Traffic Secrets section of the system prompt.
// Was response-generator.js:973.
export const trafficTemperature = (temp) => [
  `\nTRAFFIC TEMPERATURE: ${temp} — calibrate hook intensity per Traffic Secrets section.`,
];

// Why the classifier landed where it did.
// Was response-generator.js:971.
export const classifierReasoning = (reasoning) => [
  `Classifier reasoning: ${reasoning}`,
];

// Intent class, confidence and which classifier produced it.
// Was response-generator.js:970.
export const classification = (intentClass, confidence, method) => [
  `\nCLASSIFICATION: ${intentClass} (${confidence} confidence, ${method})`,
];

// 2026-08 — never propose or confirm a date already past. Every appointment and proposed slot is compared against TODAY before being called upcoming.
// Was response-generator.js:929.
export const todayIs = (today) => [
  `TODAY IS: ${today}. NEVER propose or confirm a date that has already passed. Compare every appointment and proposed slot against TODAY before calling it upcoming.`,
];

// Opens the date frame, naming the timezone the whole prompt works in.
// Was response-generator.js:928.
export const currentDateHeader = (promptTimezone) => [
  `\n═══════ CURRENT DATE — Florida / ${promptTimezone} ═══════`,
];

// How an appointment date is qualified in the LP line. The past wording carries
// the instruction (do NOT treat as upcoming; offer to reschedule), so it is copy,
// not formatting. The day-delta branch stays in the orchestrator.
// Was response-generator.js:1266-1268.
export const appointmentWhenPast = (n) => ` — ${n} day${n === 1 ? '' : 's'} in the PAST (already passed — do NOT treat as upcoming; offer to reschedule)`;
export const APPOINTMENT_WHEN_TODAY = ' — TODAY';
export const appointmentWhenUpcoming = (n) => ` — in ${n} day${n === 1 ? '' : 's'} (upcoming)`;

// The appointment-phase line, by phase. Two maps because an LP row with no
// usable time-of-day degrades to day grain: the phase is real but the clock and
// the delta are both null, and "booked for null" would be worse than the defect
// this block exists to fix. Which map applies, and the lookup, stay in the
// orchestrator.
// Was response-generator.js:958-961 and 963-965.
export const appointmentPhaseLinesWithTime = (at, mins) => ({
  scheduled: `APPOINTMENT: booked for ${at}, still comfortably ahead. Normal pre-visit tone.`,
  imminent: `APPOINTMENT: ${at}, about ${mins} minutes from now. The rep is en route or about to be. Do not re-pitch, do not re-book, do not re-qualify. Logistics and reassurance only.`,
  in_window: `APPOINTMENT: ${at} — that time has PASSED and the visit window is open RIGHT NOW (${Math.abs(mins)} minutes in). Do NOT say the appointment is "coming up," "on track," or "ahead of ${at}." The correct move is to offer to get a person on the phone immediately.`,
  past: `APPOINTMENT: ${at} — that was ${Math.abs(mins)} minutes ago and the window has closed. Do NOT speak about it in the future tense. Acknowledge plainly that the time has passed, do not invent a reason for it, and offer to get a person on the phone immediately.`,
});
export const appointmentPhaseLinesDateOnly = (appointmentDate) => ({
  scheduled: `APPOINTMENT: on record for ${appointmentDate || 'an upcoming date'}, exact time not confirmed in our records. Do not state a specific time you cannot verify. Offer to have someone confirm it by phone.`,
  past: `APPOINTMENT: on record for ${appointmentDate || 'an earlier date'}, which has already passed; the exact time is not confirmed in our records. Do NOT speak about it in the future tense and do NOT state a time you cannot verify. Offer to get a person on the phone immediately.`,
  today_time_unknown: `APPOINTMENT: today, exact time not confirmed in our records. Do not state a specific time you cannot verify. Offer to have someone confirm it by phone.`,
});

// 2026-08-29, Myron Thorner (q5GehRye7DNkN6jlmjl3). The model previously got
// only the DATE and sent three consecutive replies citing clock times already
// past, including "the rep will be reaching out ahead of 6 PM" at 6:37 PM. The
// clock is stated alongside the date, ahead of every appointment block, and
// framed as binding.
// Was response-generator.js:940-944.
export const timeNowHardRule = (timeHuman, dateHuman) => [
  `TIME NOW: It is ${timeHuman} on ${dateHuman} (Eastern).\n` +
  `HARD RULE: every clock time you write must be LATER than ${timeHuman}. ` +
  `Before writing any time, compare it to the current time. Never offer a callback ` +
  `window, a deadline, or a "if you haven't heard by X" that has already passed. ` +
  `If there is no useful future time to offer, offer a phone call instead.`,
];

// 2026-09-04, Robert Pederson (zLDD7V1eosF8vldF5U7i). The callback_request
// prompt said "if it is business hours" and nothing ever computed them, so the
// model inferred the phone room's hours from whatever else was in context —
// including a knowledge-base row that states different hours than the dialer
// actually runs. It promised a call "within the next few minutes" to a customer
// the dialer was never going to reach. The window is now computed in
// src/dial-window.js from the live Five9 dialing schedule and stated here as
// fact, next to TIME NOW, so the model reads a verdict instead of guessing one.
//
// This governs whether a CALL can be promised. It says nothing about whether a
// TEXT may be sent — that is quiet hours, and it stays in
// src/services/quiet-hours.js.
export const dialWindowHardRule = (line) => [
  `${line}\n` +
  `HARD RULE: only promise an immediate or "next few minutes" callback when the ` +
  `phone room is OPEN above. When it is CLOSED, say the call goes out when we ` +
  `open and do not offer a calendar slot instead.`,
];

// Per-channel shape of the reply. SMS is hard-capped and single-question; email
// is a short structured message with a subject line.
// Was response-generator.js:924-925.
export const SMS_CONSTRAINTS = 'Constraints: under 160 chars ideal, 320 max. 1-3 sentences. ONE question max. Booking link = merge tag, bare (no markdown). At most ONE link.';
export const EMAIL_CONSTRAINTS = 'Constraints: 150-400 words. 2-4 short paragraphs. Subject line required. Merge tags as bare text (no markdown).';

// Which calendar the canonical link books, and whether it is a merge tag or a plain URL.
// Was response-generator.js:1364.
export const canonicalLinkCalendarNote = (kind, calendarName) => [
  `(That ${kind} is the ${calendarName} calendar.)`,
];

// 2026-07-07 owner requirement. The notes exist so the reply lands like it comes from someone who KNOWS this person — woven in sparingly, never quoted, never surfaced as surveillance. If a note conflicts with what the lead just said, the lead wins.
// Was response-generator.js:1288.
export const CONTACT_NOTES_GUIDANCE = [
  `HOW TO USE THESE NOTES: they exist so your reply lands like it comes from someone who KNOWS this person. Weave in what's relevant — their situation, spouse/family details, pets, stated preferences and constraints, prior commitments — naturally and sparingly (one personal touch beats three). NEVER mention that notes exist, never quote a note verbatim, never surface internal shorthand, rep commentary, scores, or anything that would feel like surveillance rather than attentiveness. If a note conflicts with what the lead just said, what the lead said wins. The goal is trust: show them they don't have to repeat themselves.`,
];

// One internal team note, most recent first.
// Was response-generator.js:1286.
export const contactNote = (when, text) => [
  `  [${when}] ${text}`,
];

// Opens the GHL contact-record notes, read before every generated reply.
// Was response-generator.js:1283.
export const CONTACT_NOTES_HEADER = [
  `\nCONTACT NOTES (internal team notes on this person — most recent first):`,
];

// Suppression tags currently on the contact.
// Was response-generator.js:1179.
export const suppressionTags = (tags) => [
  `Suppression Tags: ${tags}`,
];

// Objection tags already recorded against this contact.
// Was response-generator.js:1176.
export const knownObjections = (tags) => [
  `Known Objections: ${tags}`,
];

// Which entry point the contact is currently active in.
// Was response-generator.js:1173.
export const activeEntry = (tag) => [
  `Active Entry: ${tag}`,
];

// Buyer-journey tag on the contact.
// Was response-generator.js:1170.
export const buyerJourneyTag = (tag) => [
  `Buyer Journey: ${tag}`,
];

// Buyer tag on the contact.
// Was response-generator.js:1169.
export const buyerTag = (tag) => [
  `Buyer Tag: ${tag}`,
];

// Stage tag as of decision time.
// Was response-generator.js:1168.
export const stageTag = (tag) => [
  `Stage Tag: ${tag}`,
];

// 2026-07-29: the decision-time stage tag, not the live one — a sibling action in the same fan-out may have rewritten it since this send was queued.
// Was response-generator.js:1153.
export const funnelStageTag = (tag) => [
  `FUNNEL STAGE TAG: ${tag} — apply the matching FUNNEL STAGE CONDUCT.`,
];

// The buyer stage the orchestrator inferred, 1 to 5.
// Was response-generator.js:1144.
export const inferredBuyerStage = (stageNum) => [
  `Inferred Buyer Stage: ${stageNum}/5`,
];

// Closes the regeneration note.
// Was response-generator.js:1095.
export const REGENERATION_NOTE_FOOTER = [
  `═══════ END REGENERATION NOTE ═══════`,
];

// Quality Pass v1.0 Items 1b/1c. Set by the send handler when a first draft was discarded — a near-repeat of an earlier outbound, a newer inbound mid-generation, or a stale trigger.
// Was response-generator.js:1093.
export const REGENERATION_NOTE_HEADER = [
  `\n═══════ REGENERATION NOTE (HIGHEST PRIORITY — read before drafting) ═══════`,
];

// The channel this reply goes out on. First line of the user prompt.
// Was response-generator.js:884.
export const channelHeader = (channel) => [
  `CHANNEL: ${channel}`,
];
