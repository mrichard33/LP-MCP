/**
 * nepq-backbone — prompt text for the NEPQ turn plan (src/agentic/nepq-planner.js).
 *
 * Copy only: strings and one pure string-returning function, no logic beyond
 * choosing the line for the planned move. Rendered as the LAST section of the
 * user prompt, and only when NEPQ_BACKBONE_MODE=live — mode off/shadow leaves
 * every snapshot byte-identical (scripts/test-response-prompt-snapshot.js).
 *
 * 2026-10-02 (Mark): NEPQ is the backbone, shortened for text. This block is
 * binding and outranks the older formulas still in the system prompt
 * ("Acknowledge → Reframe → Micro-offer", "every reply needs an offer", the
 * second "need to think" play); the code guard enforceNepqPlan backs it up.
 */

export const NEPQ_PLAN_HEADER = '═══════ NEPQ TURN PLAN (binding: overrides any earlier formula, offer mandate or objection play) ═══════';

export const NEPQ_ALWAYS = [
  'Never in this reply: a price, a range, a savings figure, a monthly payment or any financing figure; pressure or fake urgency; a stat that is not in the KB PACK; more than one question.',
  'Write it in their words. One short question at most.',
];

const MOVE_TEXT = {
  probe: (p) => `This turn's move: ONE short question about what they just told you, in their own words${p.echo?.word ? ` (an echo like "${cap(p.echo.word)}?" is fine)` : ''}. No booking ask, no pitch, no "why now" question if one was already asked.`,
  // 2026-10-02 simulation: "(hurricane season makes it natural)" produced "with
  // us at the peak of hurricane season", pressure Mark ruled out.
  consequence: (p) => `This turn's move: ONE gentle "what happens if you wait?" question about ${p.echo?.phrase || 'the problem they mentioned'}. No deadlines, no season or storm talk, no danger talk, no pressure.`,
  bridge: (p) => `This turn's move: the bridge, in their words: "Based on what you told me, this could work for you${p.echo?.phrase ? `, since you mentioned ${p.echo.phrase}` : ''}. The next step would be ${p.next_step_label}. Would that help?" Nothing else.`,
  answer: (p) => (p.price_note
    ? 'This turn\'s move: answer what they asked in one or two short sentences, in their words. On price: we can\'t give a fair price on the spot because every opening gets measured and the glass and frames are matched to their home, so a number now would be a guess (never a number or range). Then say a team member will call to set up a quick visit to measure.'
    : p.quote_followup
    ? 'This turn\'s move: they answered why they\'re looking. Echo it back in ONE short sentence in their words, say a team member will call to set up a quick visit to measure, and ask for the best way to reach them if we do not have it.'
    : p.criteria_reply
    ? `This turn's move: they told you what they will decide on. Speak to what they named in one or two sentences, using only the KB PACK (for price: exact pricing comes from the visit; never a number). Then: "The next step would be ${p.next_step_label}. Would that help?"`
    : `This turn's move: answer their question plainly in your first sentence. Then at most ONE question about what they told you.${p.booking?.allowed ? '' : ' No booking ask this turn.'}`),
  offer_slots: (p) => (p.offer_line
    ? (p.price_note
      ? `This turn's move: answer what they asked in one or two short sentences, in their words. On price: we can't give a fair price on the spot because every opening gets measured and the glass and frames are matched to their home, so a number now would be a guess (never a number or range). Then send exactly: "${p.offer_line}" Nothing after it.`
      : p.quote_followup
      ? `This turn's move: they answered why they're looking. Echo it back in ONE short sentence in their words (no question), then send exactly: "${p.offer_line}" Nothing after it.`
      : `This turn's move: answer their question in ONE sentence, then send exactly: "${p.offer_line}" Nothing after it.`)
    : 'This turn\'s move: offer exactly two real times from CALENDAR AVAILABILITY and ask which works better. Never invent a time.'),
  confirm: () => 'This turn\'s move: they picked a time. If you book it, confirm it as: "You\'re set for [day] at [time], [first name]. Our team will call to go over the details." Never name a rep. Never say "see you then".',
};

function cap(w) { return String(w || '').charAt(0).toUpperCase() + String(w || '').slice(1); }

/** The binding block for one plan. Pure. */
export function renderPlanBlock(plan) {
  if (!plan) return [];
  const lines = [`\n${NEPQ_PLAN_HEADER}`];
  if (plan.fixed_line) {
    lines.push(`This turn's move: ${plan.required_move.replace(/_/g, ' ')}. Send exactly this, nothing before or after it (a sign-off is fine): "${plan.fixed_line}"`);
  } else if (MOVE_TEXT[plan.required_move]) {
    lines.push(MOVE_TEXT[plan.required_move](plan));
  }
  lines.push(...NEPQ_ALWAYS);
  return lines;
}
