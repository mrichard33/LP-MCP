/**
 * The rep's internal note on a Rehash Call — src/appointments/rehash-call-note.js
 * (Mark, 2026-10-23; Kim Turko review)
 *
 * Pure. Kim Turko's Rehash Call carried no note, and John got only a thin
 * contact note. GHL's API cannot set "Booked By" (her appointment read
 * createdBy {source: third_party, userId: null}), so the note's first line says
 * who booked it. The rest is a short, facts-only summary of the conversation.
 *
 * Code writes the lines it knows (who booked it, the call time, the rep on the
 * visit, the demo date, the goal); the model fills only what it read in the
 * thread (homeowners, project, what they asked, concerns, what the bot said),
 * and an empty field is a line left out, never a guess. The note is INTERNAL:
 * an appointment note, never the description, which reaches the lead.
 */

export const REHASH_CALL_NOTE_MAX = 700;
export const BOOKED_BY_LINE = 'Booked by Reece Chatbot';
export const GOAL_LINE = 'Goal of call: get best price, then set manager visit';
const MODEL_FIELDS = Object.freeze(['homeowners', 'project', 'asked', 'concerns', 'bot_said']);
const LABELS = Object.freeze({
  homeowners: 'Homeowners', project: 'Project', asked: 'Asked', concerns: 'Concerns/objections', bot_said: 'Bot said',
});
// When the note is too long, these give way first (last listed goes first).
const TRIM_ORDER = Object.freeze(['bot_said', 'asked', 'concerns', 'project', 'homeowners']);

const clean = (v, max = 200) => {
  const s = String(v ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || /^(?:unknown|n\/?a|none|not stated|not mentioned|-)\.?$/i.test(s)) return '';
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

/** "Thu, Oct 23, 2:00 PM ET" from an ISO time, or null. */
export function callTimeLabel(iso, timeZone = 'America/New_York') {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(d);
  return `${day}, ${time} ET`;
}

/** "Oct 7" from a date (lp_leads.demo_date is the ET wall clock), or null. */
export function demoDateLabel(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(d);
}

/** LP's "Last, First" to "First Last". */
export function repDisplayName(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = s.match(/^([^,]+),\s*(.+)$/);
  return m ? `${m[2].trim()} ${m[1].trim()}` : s;
}

/**
 * The note text. Pure.
 * @param {{ startTime?: string, repOnVisit?: string|null, demoDate?: string|null, fields?: object }} a
 */
export function buildRehashCallNote({ startTime = null, repOnVisit = null, demoDate = null, fields = {} } = {}) {
  const callBits = [
    callTimeLabel(startTime) ? `Call: ${callTimeLabel(startTime)}` : null,
    repDisplayName(repOnVisit) ? `Rep on visit: ${repDisplayName(repOnVisit)}` : null,
    demoDateLabel(demoDate) ? `Demo: ${demoDateLabel(demoDate)}` : null,
  ].filter(Boolean);
  const vals = {};
  for (const k of MODEL_FIELDS) vals[k] = clean(fields?.[k]);
  const render = () => [
    BOOKED_BY_LINE,
    callBits.length ? callBits.join(' · ') : null,
    ...MODEL_FIELDS.map((k) => (vals[k] ? `${LABELS[k]}: ${vals[k]}` : null)),
    GOAL_LINE,
  ].filter(Boolean).join('\n');
  let text = render();
  // Over the cap: shorten the model's lines, then drop them, least important first.
  for (const k of TRIM_ORDER) {
    if (text.length <= REHASH_CALL_NOTE_MAX) break;
    if (vals[k].length > 80) { vals[k] = clean(vals[k], 80); text = render(); }
  }
  for (const k of TRIM_ORDER) {
    if (text.length <= REHASH_CALL_NOTE_MAX) break;
    vals[k] = ''; text = render();
  }
  return text.slice(0, REHASH_CALL_NOTE_MAX);
}

export const NOTE_SYSTEM = [
  'You summarize a text conversation between a homeowner and the Reece Windows & Doors chatbot for the sales rep who will call them.',
  'Facts only, from the conversation and the visit notes below. Never guess. Leave a field "" when the conversation does not say it.',
  'Each field is one short phrase, under 120 characters, no full sentences needed.',
  'Fields:',
  '- homeowners: the names of the homeowners or decision makers, if stated',
  '- project: what they want done (windows, doors, how many), if stated',
  '- asked: the questions the homeowner asked, short',
  '- concerns: their concerns or objections (price, comparing other companies, timing, spouse)',
  '- bot_said: any claim or offer the chatbot made (e.g. "may be able to beat other quote")',
  'Return JSON only: {"homeowners":"","project":"","asked":"","concerns":"","bot_said":""}',
].join('\n');

/** The model's user prompt. Pure. */
export function notePrompt({ thread = [], contactName = null, tags = [], visit = null } = {}) {
  const turns = (thread || []).slice(-30).map((m) => {
    const who = m?.direction === 'inbound' ? 'Homeowner' : 'Bot';
    return `${who}: ${String(m?.text || '').replace(/\s+/g, ' ').trim().slice(0, 400)}`;
  }).filter((l) => !/:\s*$/.test(l));
  const lines = [`CONTACT NAME: ${contactName || 'unknown'}`];
  const signal = (tags || []).filter((t) => /competitor|objection|price|concern|spouse|decision/i.test(String(t))).slice(0, 10);
  if (signal.length) lines.push(`TAGS: ${signal.join(', ')}`);
  if (visit) {
    if (visit.summary_lines?.length) lines.push(`VISIT NOTES: ${visit.summary_lines.slice(0, 4).join(' ').slice(0, 600)}`);
    if (visit.objections?.length) lines.push(`OBJECTIONS AT THE VISIT: ${visit.objections.map((o) => o.said).slice(0, 3).join(' | ').slice(0, 400)}`);
  }
  lines.push('', 'THE CONVERSATION (oldest first):', ...(turns.length ? turns : ['(no messages could be read)']));
  return lines.join('\n');
}

/** The model's JSON, held to the five fields. Pure. */
export function readNoteFields(data) {
  const out = {};
  for (const k of MODEL_FIELDS) out[k] = clean(data?.[k]);
  return out;
}

/** The contact-note fallback: the same note, named for its appointment. Pure. */
export function contactNoteFallback(note, { appointmentId = null, startTime = null } = {}) {
  const when = callTimeLabel(startTime);
  return `Rehash Call ${when || ''}${appointmentId ? ` (appointment ${appointmentId})` : ''}`.replace(/\s+/g, ' ').trim() + `\n${note}`;
}
