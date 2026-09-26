/**
 * NEPQ Conversation Layer — src/agentic/nepq-layer.js
 *
 * Renders the questioning discipline block for agentic SMS/chat replies.
 *
 * WHY: the responder could answer questions but not ADVANCE a conversation.
 * It reassured, confirmed, and acknowledged. It rarely asked the one question
 * that moves a homeowner from "looking" to "let's get it measured," and on
 * 2026-08-28 (Myron Thorner) it ran generic reassurance at the commitment
 * stage, where reassurance is exactly the wrong instrument.
 *
 * FRAMING: NEPQ (Jeremy Miner / 7th Level) refines the Chatbot channel inside
 * the Antifragile Sales System. It does not replace the 5-stage buyer journey
 * — it is the discipline for how the questions inside a turn are asked. All
 * copy here is original Reece work written to the methodology; no source
 * material is reproduced.
 *
 * HARD GATE: NEPQ discovery is OFF for booked contacts. See stageBlock().
 *
 * v1.2 (2026-09-11, Alfredo Fontan — GHL VKMKhd8JQ4wsp3zMn8Lt)
 * ────────────────────────────────────────────────────────────
 * The layer was tactically blind in two ways at once, and outbound
 * yFkfGW3AOmm9M8Myk7W8 is both of them in one message:
 *
 *   "Fair point, Alfredo — close is close. To get the visit scheduled
 *    correctly, will it just be you home, or is there someone else who'd
 *    want to be there?"
 *
 *   1. SUGGESTED QUESTIONS HE HAD ALREADY ANSWERED. He was stage 3, so the
 *      layer offered the stage-3 discovery play — including "Have you had
 *      anyone out to look at them before? How did that go?" — to a man who
 *      had just told us he had sat through several presentations and nearly
 *      signed with someone else. Stage blocks now SUBTRACT: any example
 *      question whose underlying fact is closed is removed before render.
 *
 *   2. NO OBJECTION PLAY EXISTED. He pushed back on price and the layer had
 *      nothing to say about it, so the model fell back on the thing models
 *      fall back on — conceding the objection and changing the subject.
 *      objectionBlock() is new and it is the piece that did not exist.
 *
 * Also: the layer read buyer_stage only. Trust is now read alongside it,
 * because a discovery play at low trust is the wrong instrument regardless of
 * which stage the buyer is in.
 *
 * v1.3 (2026-09-23, Mark's canon + NEPQ rulings)
 * ──────────────────────────────────────────────
 *   1. The hard-ban list was too wide. "I hear you" / "That makes sense" /
 *      "Totally fair" are not the defect — agreeing and then CHANGING THE
 *      SUBJECT is. They are now banned only before a pivot, and a short
 *      neutral disarm ("That's not a problem." / "Fair enough.") is allowed
 *      when the same message asks about THEIR objection. findConcessionPivots
 *      in src/response-generator.js enforces the same line — keep them in step.
 *   2. The price shape asked the lead for a target number ("where does it
 *      need to land?"). That hands pricing to the chat. It now clarifies
 *      instead, and pricing stays with the specialist.
 *   3. The Stage-4 transition offered the in-home measure by default, which
 *      contradicted the PROTECTION PROFILE REVIEW booking gate. The Review is
 *      the default; the in-home version is for the three owner exceptions only.
 *   4. The commitment gate allows exactly one question: THE REVEAL.
 *
 * v1.4 (2026-09-26, discovery discipline — fourteen days of live replies)
 * ─────────────────────────────────────────────────────────────────────
 * Everything below was already written in this file and was still not
 * happening. The reason is ORDER: this block renders at roughly position 18
 * of 51 in buildResponsePrompt; the in-home booking gate and the closing
 * PRIORITY ORDER render ~500 lines later, and the priority's "(5) DEFAULT"
 * was a two-slot booking ask. The last instruction wins. So v1.4 makes the
 * discipline DATA (src/agentic/discovery-discipline.js), renders it here as
 * a DISCOVERY DISCIPLINE section, has the priority order defer to it, and
 * backs every rule with a code guard in response-generator.js:
 *
 *   Fix 1  ANSWER, THEN DISCOVER. A booking/time/call ask is allowed only
 *          when the lead asked about scheduling or next steps, or at most
 *          once every three bot turns. Otherwise: answer, then ONE discovery
 *          question in their words, or none. Enforced by findBookingAsks.
 *   Fix 2  PROBE FIRST. A problem named in their words ("don't like the
 *          colour and design") gets echoed back as one question before any
 *          transition or booking ask. A stated deadline skips the probe.
 *   Fix 3  DECISION-MAKERS. Ask once ("Is this your call, or is anyone else
 *          weighing in on it?"); a sole owner is booked and never hears about
 *          another person again; a named-but-absent spouse gets ONE NEPQ
 *          question ("How does Paloma feel…"), then a human sorts the visit
 *          out. Never "whoever else", "both of you" or "anyone else deciding"
 *          for a person nobody named. Enforced by findPhantomDecisionMaker.
 *   Fix 4  TONE. "Good question" / "Great question" join the banned openers;
 *          exclamation marks are stripped in code.
 *   Fix 5  THE OPENER. A GHL workflow already asked "What are you hoping to
 *          get done…" seconds earlier (Sonya, Felix, Ronald); the bot must not
 *          ask it again. Enforced by findRepeatedOpener.
 *   Fix 6  INSURANCE. One approved shape, carrier decides the number. Enforced
 *          by findInsuranceOutcomeClaims.
 *
 * buildNepqBlock takes a third argument, the discipline object. Absent, the
 * section renders as "(not computed)" — visible in a Bot Review replay rather
 * than silently missing, the ESTABLISHED precedent.
 */

/**
 * Tonality translated to text. NEPQ tonality is a voice concept (curious,
 * concerned, confused). In SMS it survives as restraint: no enthusiasm
 * punctuation, no stacked questions, no rebuttals.
 */
const TONALITY = `
TONE (binding):
- Neutral and curious. Never enthusiastic. No exclamation points.
- Banned openers: "Great!", "Perfect!", "Awesome!", "Absolutely!", "Happy to help!", "Good question", "Great question"
- Never praise the question. Start with the answer, or with their words.
- ONE question per message. ONE question mark. Never two.
- Never rebut. When they push back, ask a question back instead of explaining.
- Short. Under 160 characters is the target, 320 is the ceiling.
- Use their words, not ours. If they said "drafty," write "drafty," not
  "thermal inefficiency."
- Silence is allowed. If the right move is a one-line acknowledgment with no
  question, send that.
- Never ask a question listed as closed in ESTABLISHED. If you are about to
  ask something, check that list first.`;

const CLARIFY_AND_PROBE = `
WHEN THEY ARE VAGUE (do this instead of moving on):
- Clarify: "How do you mean?" / "What do you mean by that?" / "Say more?"
- Probe: repeat their own last three or four words back as a question.
  Them: "They're just old." You: "Old how?"
- Never fill their silence with a pitch. Ask, then stop.
- Never ask two things at once to save a turn. It reads as a form.`;

/**
 * Consequence questions are the sharpest instrument in NEPQ and the easiest
 * to get wrong in a regulated trade. These caps are non-negotiable.
 */
const CONSEQUENCE_GUARDRAILS = `
CONSEQUENCE QUESTIONS — STRICT CAPS:
- Maximum ONE consequence question per conversation, ever. Never stacked.
- Only after they have named a problem in their own words. Never before.
- Frame it around cost, comfort, hassle, or another season of the same thing.
- NEVER about physical danger to them or their family.
- NEVER name an insurance carrier.
- NEVER predict a claim outcome, a premium change, or a denial. If insurance
  comes up, the ONLY shape is: "Impact windows can qualify for wind-mitigation
  credits, and we give you the documentation your insurance company asks for.
  Your insurance company decides the final number."
- NEVER promise or imply a price reduction, a discount, or that prices rise.
- NEVER invent a deadline, a countdown, or a limited-time anything.
- If they answer flatly or brush it off, drop it and move to the visit offer.
  Do not press. Pressing is the old model.`;

/**
 * Render a stage's example questions, MINUS any whose underlying fact this
 * conversation has already closed.
 *
 * Each example is tagged with the established-facts key it would be asking
 * for. An untagged example (`key: null`) is a question about how they FEEL or
 * what they WANT, which no CRM field can close and which is never subtracted.
 *
 * @param {{key: string|null, text: string}[]} examples
 * @param {string[]} closed  established.closed_questions
 * @returns {{lines: string, empty: boolean}}
 */
function renderExamples(examples, closed) {
  const kept = examples.filter(e => !e.key || !closed.includes(e.key));
  if (!kept.length) return { lines: '', empty: true };
  return { lines: kept.map(e => `- "${e.text}"`).join('\n'), empty: false };
}

// What to say when subtraction has emptied a stage of its questions. Discovery
// for this stage is genuinely finished, and the failure mode at that point is
// inventing a new question to fill the turn.
const DISCOVERY_COMPLETE = `
DISCOVERY FOR THIS STAGE IS COMPLETE. They have already answered everything
this stage asks. Do NOT invent a new question to fill the turn — asking
something else merely to be asking is the same defect as re-asking.
The move is the TRANSITION: reflect what they already told you, in their own
words, and offer the next step. One offer, one question mark.`;

/**
 * Stage-specific play. This is where the commitment gate lives.
 * @param {object} ctx          buildLeadContext() output
 * @param {object} established  buildEstablishedFacts() output
 */
function stageBlock(ctx, established) {
  const booked = ctx?.lp?.appointment_set === true;
  const phase = ctx?.lp?.appointment_phase || null;
  const stage = Number(ctx?.intelligence?.buyer_stage) || null;
  const closed = established?.closed_questions || [];
  const trust = Number(ctx?.lead?.trust_level_score) || null;

  // ── COMMITMENT GATE ───────────────────────────────────────────────────
  // A booked homeowner is a customer, not a prospect. Discovery here reads
  // as the company having forgotten who they are. Myron Thorner, 2026-08-28.
  if (booked) {
    const live = phase === 'in_window' || phase === 'past';
    return `
STAGE: COMMITMENT — this homeowner is already booked.

NEPQ DISCOVERY IS OFF. Do not ask situation, problem, solution, consequence,
or qualifying questions. Do not re-pitch the visit. Do not re-establish need.
They already said yes.

Your only jobs, in order:
1. Answer the logistics question they actually asked, plainly.
2. Reduce their uncertainty about what happens next.
3. When anything is unclear, uncertain, or late — offer to get a person on
   the phone. Do not offer more information. Offer a human.
The one question allowed here is THE REVEAL, once per booking, when their
first reply after booking is a simple thanks or ok: "Before the visit, what's
the main thing you want to go over, so our specialist comes ready?"
${live ? `
THE APPOINTMENT WINDOW IS LIVE OR PASSED. Reassurance is the wrong move and
will read as the company not knowing what is going on. Say plainly that you
are getting someone on the phone, and do it. Do not speculate about where the
rep is. Do not invent a reason for a delay. One sentence, then the offer.` : ''}`;
  }

  // ── TRUST FLOOR (2026-09-11) ──────────────────────────────────────────
  // Read BEFORE the stage play. Trust and buyer stage are different axes, and
  // the layer previously read only the second: a homeowner can be stage 3 or 4
  // on the product and still not trust the company enough to answer a
  // discovery question honestly. At trust 1-2 a discovery play reads as an
  // interrogation and a booking push reads as a close.
  //
  // Scored 1-5 by src/context-builder.js; null means unknown and is NOT
  // treated as low.
  if (trust !== null && trust <= 2) {
    return `
STAGE: REPAIR — trust is ${trust}/5. This outranks the buyer stage.

Something in this relationship is not working, and no amount of discovery
fixes that. Do NOT run a discovery sequence. Do NOT push for the booking.
Do NOT restate credentials at them — a company defending itself reads as a
company with something to defend.

Your job this turn, in order:
1. Say the one true thing that acknowledges where they actually are. Once.
2. Ask ONE question about THEIR position — what they want to happen, or what
   would need to be different. Not about their windows.
3. If they have raised the same concern twice, stop asking and offer a person.

Give before you ask. If the honest move is an answer with no question
attached, send that and stop.`;
  }

  // ── ENGAGEMENT ────────────────────────────────────────────────────────
  if (stage === null || stage <= 1) {
    const ex = renderExamples([
      { key: null, text: 'What got you looking at the windows now, out of curiosity?' },
      { key: null, text: "What's going on with them that made you reach out?" },
    ], closed);
    return `
STAGE: CONNECTION — they are not yet convinced this is a real problem.

Take the focus off us and put it on them. No pitch, no company history, no
credentials. One open question about what prompted them to look.${ex.empty ? DISCOVERY_COMPLETE : `
Reece examples (adapt, do not recite):
${ex.lines}`}
Do NOT ask about budget, timing, or decision-makers yet. They don't know
their own answer to those questions this early.`;
  }

  if (stage === 2) {
    const ex = renderExamples([
      { key: null, text: 'How long have they been doing that?' },
      { key: null, text: "What's that been like through the summer?" },
      { key: null, text: 'Which room is the worst one?' },
      { key: 'window_count', text: 'How many openings are we talking about?' },
    ], closed);
    return `
STAGE: SITUATION → PROBLEM AWARENESS.

Situation first — establish what they actually have. Age of the windows, what
they're made of, whether anything is already impact-rated. One at a time.
Then open the emotional door. The goal is for THEM to say what it costs them,
not for us to tell them.${ex.empty ? DISCOVERY_COMPLETE : `
Reece examples (adapt, do not recite):
${ex.lines}`}
Never answer the problem for them. Ask, then stop.`;
  }

  if (stage === 3) {
    // The PAST half is tagged prior_quotes. On 2026-09-11 this is the half
    // that fired at a lead who had already told us he had sat through several
    // presentations and almost signed with someone else.
    const past = renderExamples([
      { key: 'prior_quotes', text: 'Have you had anyone out to look at them before?' },
      { key: 'prior_quotes', text: 'How did that go?' },
    ], closed);
    const future = renderExamples([
      { key: null, text: 'If they were sorted, what would that change day to day?' },
      // Hand-wrapped, as the rest of this file's copy is — the prompt is read
      // by people in Bot Review as often as it is read by the model.
      { key: null, text: 'Besides the noise and the cooling bill, what else would need to be right\n  for you to feel good about it?' },
    ], closed);

    if (past.empty && future.empty) return `\nSTAGE: SOLUTION AWARENESS.${DISCOVERY_COMPLETE}`;

    return `
STAGE: SOLUTION AWARENESS.
${past.empty || future.empty ? '' : '\nTwo halves, in order.'}${past.empty ? `
PAST: ALREADY COVERED. They have told you what they have already tried and how
it went — it is in ESTABLISHED above. Reference it; do not ask it again.` : `
PAST: what have they already tried, and how did it work out? This surfaces
how long they've lived with it without them feeling accused.
${past.lines}`}
${future.empty ? '' : `
FUTURE: what does handled actually look like to them?
${future.lines}`}
Positioning against other companies may begin here — never before.`;
  }

  // Stage 4 — negotiating, not yet committed.
  const qualifying = renderExamples([
    { key: 'timeline', text: 'How important is it to get this handled this year?' },
    { key: 'decision_makers', text: 'Is this your call, or is anyone else weighing in on it?' },
  ], closed);

  return `
STAGE: CONSEQUENCE → QUALIFYING → TRANSITION.

They have decided something needs to happen. They have not committed to us.
Do NOT re-educate. Do NOT restate benefits they already accepted.

Consequence (once, capped — see the caps above), only if they have named a
problem themselves:
- "What happens if you leave them another season?"
${qualifying.empty ? `
QUALIFYING IS DONE. Everything this stage would ask is already answered — see
ESTABLISHED above. Go straight to the transition.` : `
Qualifying — confirm it matters, and who is in the room:
${qualifying.lines}`}
Transition — reflect their own words, then offer the next step. DEFAULT:
"Based on what you said about [their words], the next step is a quick
15-minute Protection Profile Review. Would that help?"
ONLY for a price shopper, a booking with every decision maker, or a BOOKING
CONTEXT that resolves to an in-home calendar, offer the visit instead:
"Based on what you said about [their words], the next step is having our
specialist measure and leave you written pricing. Would that help?"
Confident and direct. Not pushy. One offer, one question mark.`;
}

/**
 * The play when they push back. New in v1.2 — nothing in this layer previously
 * said anything about an objection, which is why on 2026-09-11 the model fell
 * back on the default move: agree with the objection, then change the subject.
 *
 * Rendered whenever an objection state is open.
 *
 * @param {object} ctx          buildLeadContext() output
 * @param {object} established  buildEstablishedFacts() output
 * @returns {string}            '' when no objection is open
 */
export function objectionBlock(ctx, established) {
  const code = ctx?.objection_state?.state_code || null;
  if (!code) return '';

  // Same family raised twice. The rules layer detects this across days
  // (OBJ_FAMILY_REPEAT_BUDGET / _SPOUSE / _TRUST / _TIMING, agent_rules
  // 319-322); this detects it inside the thread we are answering right now.
  const raised = established?.objections_raised || [];
  const counts = new Map();
  for (const o of raised) counts.set(o.type, (counts.get(o.type) || 0) + 1);
  const repeated = [...counts.entries()].filter(([, n]) => n >= 2).map(([t]) => t);

  if (repeated.length) {
    return `
OBJECTION — RAISED TWICE (${repeated.join(', ')}). STOP ASKING.

They have brought this up more than once. That means our previous answer did
not land, and asking another question now tells them we still are not
listening.

Say plainly that we have not answered it well yet. Do not re-explain, do not
re-frame, do not ask a discovery question. Offer to get a person on the phone
who can answer it properly, and stop. One or two sentences.

Do not apologize a second time for anything listed as already apologized for
in ESTABLISHED.`;
  }

  return `
OBJECTION IS OPEN (state: ${code}). THE PLAY IS TO ASK BACK.

Never concede. Never explain. Never rebut. When they push back, the move is a
question that hands the thinking back to them.

BANNED — this is the exact failure this block exists to stop: agreeing with
the objection and then changing the subject.
  Never open with: "Fair point"  ·  "You're right"  ·  "Absolutely"
  Never follow these with a question about anything else:
    "I understand that"  ·  "That makes sense"  ·  "Totally fair"  ·  "I hear you"
Agreeing with the objection and pivoting to a qualifying question is not
empathy. It concedes the argument and then asks them for a favour in the same
breath, and it reads as a script. It is a defect.

ALLOWED: a short neutral disarm ("That's not a problem." / "Fair enough.")
ONLY when the same message then asks about THEIR objection, in their words.
A disarm followed by a question about decision makers, the address, the
window count or a time is the banned pivot, whatever the opener.

THE SHAPE: reflect their own words back as a question that makes them weigh
their own position.

  They said:  "close is close"
  You reply:  "Close — how close does it need to be before you'd sign off
               on it?"

Notice what that does: it uses THEIR word, adds nothing, defends nothing, and
puts the decision back on their side of the table.

More shapes (adapt, never recite):
  "Too expensive" → "How do you mean?"
                or → "Is price the main thing for you, or making sure
                     [their problem, their words] actually gets fixed?"
  "Need to think" → "Fair enough. What's the part you're still turning over?"
  "Not right now" → "What would need to change for it to be the right time?"

HARD LIMITS on this block — the caps above still bind:
- ONE question. One question mark.
- Never invent a deadline, a countdown, or a limited-time anything.
- Never promise or imply a price reduction, a discount, or that prices rise.
- Never name an insurance carrier or predict a claim outcome.
- Never quote a figure that is not in the CUSTOMER'S ACTUAL ESTIMATE block.
- Never ask them for a target number, a budget figure, or where the price
  "needs to land". Pricing stays with the specialist.
- If they answer flatly or refuse to engage, drop it and offer a person.`;
}

/**
 * The facts, restated inside the questioning discipline. The ESTABLISHED block
 * in the user prompt says what is known; this says what that means for the
 * question you are about to ask.
 */
export function establishedBlock(established) {
  const closed = established?.closed_questions || [];
  if (!closed.length) return '';
  return `
ALREADY ANSWERED — these are closed: ${closed.join(', ')}.
Asking any of them again is a defect, not a clarification. The full wording of
what they said is in the ESTABLISHED block above. Use their answer; never
re-ask for it.`;
}

/**
 * v1.4 — the turn's discipline, rendered. This is the section the closing
 * PRIORITY ORDER now defers to, so it says plainly what THIS reply may ask.
 *
 * @param {object|null} d  buildDiscipline() output from discovery-discipline.js
 * @param {object|null} established
 * @returns {string}
 */
export function disciplineBlock(d, established = null) {
  if (!d) {
    return `
=== DISCOVERY DISCIPLINE (this turn) ===
(not computed — fall back to: answer what they said, ONE question at most, no booking ask unless they asked about scheduling)`;
  }
  const parts = ['\n=== DISCOVERY DISCIPLINE (this turn) ==='];

  // ── Fix 1 ──
  if (d.booking?.allowed) {
    parts.push(`BOOKING ASK: ALLOWED this turn (${d.booking.reason === 'lead_asked_about_scheduling'
      ? 'they asked about scheduling or next steps, or picked a time'
      : d.booking.reason.startsWith('recommended_action')
        ? 'the analyzer marked this a fast-track turn'
        : 'nothing blocks it'}). Answer first, then ONE offer, one question mark.`);
  } else {
    const why = d.booking?.reason === 'lead_asked_a_question'
      ? 'they asked you a question and did not ask about scheduling'
      : d.booking?.reason === 'booking_ask_in_last_3_turns'
        ? `you already asked for a time in the last three messages (${d.booking.recent_asks}) and it was not taken up`
        : d.booking?.reason === 'handoff_pending'
          ? 'a person from the team is already reaching out'
          : 'nothing in this turn calls for it';
    parts.push(`BOOKING ASK: NOT ALLOWED this turn — ${why}.
Answer plainly. Then EITHER one discovery question about THEIR situation in THEIR
words ("What made you start looking at this now?", "Which one is the worst?") OR
no question at all. Do not ask for a day, a time, a call, an address, or who will
be home. A booking ask may return on a later turn; it is not gone, it is waiting.`);
  }

  // ── Fix 2 ──
  const p = d.probe || {};
  if (p.problem_named && p.urgent) {
    parts.push(`URGENT TIMING STATED: "${p.problem_named}". They have a deadline, so skip the probe
and go straight to scheduling logistics — what has to happen, and when.`);
  } else if (p.problem_named && !p.probe_done) {
    parts.push(`PROBE FIRST. They named a problem in their own words: "${p.problem_named}".
Nothing has asked about it yet. This reply echoes THEIR words back as ONE question
("The ${p.family === 'colour and design' ? 'colour and design' : 'part you mentioned'} — what don't you like about it?",
"How long has that been going on?", "How is that affecting you day to day?").
No transition, no next step, no address, no booking, no decision-maker question.
Ask, then stop.`);
  } else if (p.problem_named && p.probe_done) {
    parts.push(`PROBE DONE. They named "${p.problem_named}" and it has been asked about. The
TRANSITION play is open when the rest of this section allows it: "Based on what you
said about [their words], the next step is…".`);
  }

  // ── Fix 3 ──
  const dm = d.decision_makers || {};
  const who = dm.name || (dm.relation ? `their ${dm.relation}` : 'the other person');
  switch (dm.status) {
    case 'sole':
      parts.push(`DECISION-MAKERS: SOLE. This customer alone decides and has said so. Book them as
the sole owner. NEVER write "both of you", "whoever else", "anyone else deciding", or
mention a spouse or partner. Do not ask the decision-maker question. It is closed.`);
      break;
    case 'named_present':
      parts.push(`DECISION-MAKERS: ${who} is part of this and is on board. Offer a time that works for
both of them (one offer, one question mark). Do not re-ask whether ${who} will be there.`);
      break;
    case 'named_absent':
      if ((dm.feel_ask_count || 0) === 0) {
        parts.push(`DECISION-MAKERS: ${who} was named, and the customer says ${who} does not need to
be there. We do not run single-leg visits, and we do not argue. Ask ONCE, NEPQ style,
using the name: "How does ${dm.name || who} feel about getting the windows done?"
Nothing else — no times, no both-of-you pitch, no reason why.`);
      } else {
        parts.push(`DECISION-MAKERS: you already asked how ${who} feels. Do not ask again. If they
now say ${who} is on board, offer a time for both; otherwise say a team member will call
to sort the visit out, and ask nothing.`);
      }
      break;
    case 'handoff':
      parts.push(`DECISION-MAKERS: HANDOFF. ${who} was named, the customer has twice said ${who} need
not be involved, and we do not run single-leg visits. Do NOT ask again and do NOT book.
Say a team member will call to sort the visit out. No question in this message.`);
      break;
    case 'asked':
      parts.push(`DECISION-MAKERS: you asked and they have not answered. Do not ask again this turn.
Answer what they said; the question stays open for a later turn.`);
      break;
    default:
      if (dm.ask_allowed) {
        parts.push(`DECISION-MAKERS: unknown, never asked, and this is a booking-relevant turn. If you
ask, ask exactly once and exactly this: "Is this your call, or is anyone else weighing
in on it?" Never assume a second person exists.`);
      } else {
        parts.push(`DECISION-MAKERS: unknown and NOT to be asked this turn (this reply answers something
else). Never write "both of you", "whoever else", or "anyone else deciding". Talk to the
one person in this conversation.`);
      }
  }

  // ── Fix 5 ──
  if (d.opener?.asked) {
    const when = d.opener.age_sec != null ? `${d.opener.age_sec} seconds ago` : 'moments ago';
    parts.push(`OPENER ALREADY ASKED ${when} by an automated message: "${d.opener.text}".
Do NOT ask it again in any wording. If their reply is just "Hi", "Yes" or "Ok", respond
briefly and wait — a short line with no question is a valid message — or ask ONE
different discovery question (which room, how long, what is the worst one).`);
  }

  return parts.join('\n');
}

/**
 * Build the NEPQ prompt block for a given lead context.
 * @param {object} ctx           the object returned by buildLeadContext()
 * @param {object} [established] the object returned by buildEstablishedFacts()
 * @param {object} [discipline]  the object returned by buildDiscipline() (v1.4)
 * @returns {string}             prompt text, or '' when the layer is disabled
 */
export function buildNepqBlock(ctx, established = null, discipline = null) {
  if (process.env.NEPQ_LAYER_MODE === 'off') return '';

  // ── THE COMMITMENT GATE STILL WINS (Myron Thorner, 2026-08-28) ────────
  // A booked homeowner is a customer, not a prospect. stageBlock() already
  // turns discovery off for them; the two v1.2 blocks are suppressed here for
  // the same reason. An ask-back play would tell a booked customer to push
  // back on their own appointment, and a closed-questions list is noise to
  // someone who has already said yes. Logistics and a human, nothing else.
  const booked = ctx?.lp?.appointment_set === true;

  return [
    '=== CONVERSATION DISCIPLINE (NEPQ) ===',
    stageBlock(ctx, established),
    booked ? '' : establishedBlock(established),
    booked ? '' : objectionBlock(ctx, established),
    // v1.4 — the turn's discipline. Rendered for unbooked contacts only: a
    // booked customer is on the commitment gate above, where discovery is off
    // and a booking ask has nothing to attach to.
    booked ? '' : disciplineBlock(discipline, established),
    TONALITY,
    CLARIFY_AND_PROBE,
    CONSEQUENCE_GUARDRAILS,
    `
POST-BOOKING DISCLOSURE (say this once, in the message that confirms a
booking, and never again): tell them someone from our team WILL call before
the visit to go over the details and finalize it.

State it as CERTAIN. Never "may", never "might", never "if we need anything
else". A booked slot is scheduled, not dispatched — nobody is sent to the
home until that call happens, so the call is a fact, not a possibility. Say
it as diligence, not as doubt about whether they have an appointment.

NEVER name a phone number, an area code, or say which line the call will
come from. We do not control which number places it, so any number we name
is a promise we cannot keep.

Example shape: "You're set for [day] at [time]. Someone from our team will
call before then to go over the details and finalize the visit."`,
    // Empty sections (a suppressed v1.2 block, a stage with nothing to add)
    // are dropped rather than joined as blank lines — the snapshot guard reads
    // this text byte for byte.
  ].filter(Boolean).join('\n');
}

export const NEPQ_LAYER_VERSION = '1.4';
