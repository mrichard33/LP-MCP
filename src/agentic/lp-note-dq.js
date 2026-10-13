/**
 * lp-note-dq — src/agentic/lp-note-dq.js
 *
 * 2026-10-07 (Nicholas Ferraioli, GHL I5x7zltORikAxdEJ6nyD, LP lead 581863).
 * Kaley cancelled his visit at 9:29 AM with the LP note "CXL: This CX does
 * not appear to own the home as of now, it looks like its a program to help
 * veterans with affordable housing. This is not something we can run." The
 * analyzer saw the note; the bot still offered, held and confirmed a new time
 * that afternoon. A person had already decided we cannot run this lead.
 *
 * One list of what such a note says (LP_NOTE_DQ_SIGNALS), one pure reader
 * (detectNoteDq). The caller decides what to do: no booking, one no-promise
 * hand-off, a Five9 callback, a person paged, and the bot off (dq_hard_stop).
 * Add a phrase here, never a string check somewhere else.
 *
 * Pure and dependency-free.
 */

// Each signal is { id, rx }. Written to read a person's note, not a lead's
// text: "not the owner", not "owner". A negated form ("does own", "is the
// owner") never matches.
export const LP_NOTE_DQ_SIGNALS = Object.freeze([
  { id: 'not_owner', rx: /\b(?:(?:does|do|did)\s*n[o']?t\s+(?:appear\s+to\s+|seem\s+to\s+)?own|not\s+(?:the\s+)?(?:home\s+|property\s+)?owner|no\s+longer\s+owns?|is\s*n[o']?t\s+the\s+(?:home\s+|property\s+)?owner)\b/i },
  // "renter" / "is renting", never a bare "tenant": owners renting the home
  // out mention their tenants ("Mr has a tenant in the property"), 2026-10-07 dry run.
  { id: 'renter', rx: /\b(?:renter|(?:is|are)\s+(?:currently\s+|just\s+)?renting(?!\s+(?:it|the\s+\w+)\s+out)|rents\s+the\s+(?:home|house|property|unit|condo)|tenant,?\s+not\s+(?:the\s+)?owner)\b/i },
  { id: 'housing_program', rx: /\b(?:affordable\s+housing|housing\s+(?:program|assistance|authority)|section\s*8|\bhud\b|habitat\s+for\s+humanity|(?:veterans?|va)\s+(?:housing|program))\b/i },
  { id: 'cannot_run', rx: /\b(?:not\s+something\s+we\s+can\s+run|can\s*(?:no|')?t\s+(?:be\s+)?run\b|cannot\s+(?:be\s+)?run\b|unable\s+to\s+run|do\s*n[o']?t\s+run\s+(?:these|this|that)|not\s+(?:a\s+)?(?:runnable|qualified\s+lead)|disqualif(?:y|ied))\b/i },
  { id: 'out_of_area', rx: /\b(?:out\s+of\s+(?:the\s+)?(?:service\s+)?area|outside\s+(?:of\s+)?(?:our\s+)?(?:the\s+)?service\s+area|we\s+do\s*n[o']?t\s+service)\b/i },
  // 2026-10-13: a person's note that the job is under our minimum is their
  // decision ("below minimum 2 w not open to the entire home"). A note that
  // only DESCRIBES a rental or a commercial property is not: 60 days of LP
  // notes read "Spoke with David, who owns a rental property ... estimate for
  // three windows" and "we cant look at the commercial property but we can look
  // at the rez" on leads the team booked. As a DQ signal those words would
  // switch the bot off for live appointments (dq_hard_stop), so the rental and
  // commercial rules stay in what the LEAD says (job-scope.js), never here.
  { id: 'below_minimum', rx: /\b(?:below|under)\s+(?:the\s+|our\s+)?minimum\b/i },
  { id: 'mobile_home', rx: /\b(?:mobile\s+home|manufactured\s+home|trailer\s+home|double[\s-]?wide|single[\s-]?wide)\b/i },
]);

function noteText(n) {
  return String((n && (n.text ?? n.note_body ?? n.body)) || '').trim();
}

// 2026-10-07 dry run over 30 days of notes: lp_notes also holds chat
// transcripts ("Role.ASSISTANT: Is this a single family home, mobile home, or
// condo?" matched 320 leads), AI call summaries and Hatch message copies. A
// DQ is a PERSON's decision, so only a note a person wrote counts, and a
// question never does.
const MACHINE_NOTE_RX = /^\s*(?:role\.(?:user|assistant|system)\s*:|siro\b|hatch\s*-|\[agent|\[ai\b|ai\s+(?:summary|notes?|brief)\b|bot\s+exit\b|agentic\b)/i;
export function isPersonNote(text) {
  return !!String(text || '').trim() && !MACHINE_NOTE_RX.test(String(text));
}
function statements(text) {
  return String(text || '').split(/(?<=[.!?])\s+|\n+/).map(x => x.trim()).filter(x => x && !x.endsWith('?'));
}

/**
 * The first note (newest first, as the context builder returns them) that
 * says the lead cannot be run. Pure.
 * @param {Array<{text?: string, note_body?: string, entered_by?: string, date?: string}>} notes
 * @returns {{dq: boolean, signal: string|null, note: object|null, text: string|null}}
 */
/** The signals that are the job requirements: a lead past its demo already
 *  meets them (the user, 2026-10-13; post-demo-lead.js). */
export const REQUIREMENT_SIGNALS = Object.freeze(['renter', 'below_minimum']);

export function detectNoteDq(notes, { skip = [] } = {}) {
  const skipped = new Set(skip || []);
  for (const n of Array.isArray(notes) ? notes : []) {
    const text = noteText(n);
    if (!isPersonNote(text)) continue;
    const said = statements(text);
    for (const s of LP_NOTE_DQ_SIGNALS) {
      if (skipped.has(s.id)) continue;
      if (!said.some(x => s.rx.test(x))) continue;
      return { dq: true, signal: s.id, note: n, text };
    }
  }
  return { dq: false, signal: null, note: null, text: null };
}

/** LP_NOTE_DQ_MODE: off | shadow | live (default live, handoff 2026-10-07). */
export function lpNoteDqMode(env = process.env) {
  const v = String(env.LP_NOTE_DQ_MODE || '').trim().toLowerCase();
  return v === 'off' || v === 'shadow' ? v : 'live';
}

/**
 * The context package on the #contact-center card (handoff §4): the note,
 * the appointment status, the last 5 messages, what the bot told them, and
 * the recommended next step. Pure.
 * @param {{noteDq: {signal, text}, facts?: object|null, conversation?: Array, sent?: string|null}} args
 */
export function noteDqPackage({ noteDq, facts = null, conversation = [], sent = null } = {}) {
  const a = facts?.appointment || {};
  const appt = a.status === 'cancelled' ? `CANCELLED${a.date ? ` (was ${a.date})` : ''}${a.lp_disposition ? `, LP ${a.lp_disposition}` : ''}`
    : a.status === 'set' ? `set${a.date ? ` for ${a.date}` : ''}` : 'none on file';
  const last = (Array.isArray(conversation) ? conversation : []).slice(-5).map(m => {
    const who = String(m?.direction || '').toLowerCase() === 'outbound' ? 'Us' : 'Lead';
    return `  ${who}: ${String(m?.text ?? m?.body ?? '').replace(/\s+/g, ' ').slice(0, 160)}`;
  });
  return [
    `Team note (${noteDq?.signal || 'dq'}): "${String(noteDq?.text || '').slice(0, 400)}"`,
    `Appointment: ${appt}`,
    ...(facts?.property?.zip ? [`Property on file: ${[facts.property.address, facts.property.city].filter(Boolean).join(', ')} ${facts.property.zip}`.trim()] : []),
    'Last messages:',
    ...(last.length ? last : ['  (none read)']),
    `Bot told them: ${sent ? `"${String(sent).slice(0, 200)}"` : 'nothing new (hand-off already sent)'}`,
    'Next step: call them, explain why the visit cannot go ahead (or confirm it can), and log the outcome in LP.',
  ].join('\n');
}
