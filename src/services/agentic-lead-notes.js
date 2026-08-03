/**
 * Agentic Lead Notes — src/services/agentic-lead-notes.js
 *
 * v1.0 (2026-08-03). Deterministic call-center brief for the LP `notes` field.
 *
 * WHY: notes on workflow 8e30ff37 come from {{contact.contact_summary}}
 * (Iv7r6m0LNCmCeDYt8U8L), written by a ChatGPT node whose prompt reads a field
 * vocabulary that only partly overlaps what the agentic system writes — it asks
 * for primary_pain, objection_type, memory_summary, conversation_context,
 * nepq_stage, interest_level. The agentic path writes AI Short Summary, Chat
 * Transcript, Pain Point, Pain Driver, Emotional Arc, Trust Level Score. The
 * prompt never references the Chat Transcript at all, and that is the richest
 * artifact the agentic system produces.
 *
 * Reference: L0q6ASoZKJ1hXWv1b0C3 (Cynthia De Leon) — 7 windows, no sliders,
 * maybe a door, explicit price concern, 13-turn transcript.
 *
 * WHY BY FIELD ID, NOT SLUG: the GHL merge-token vocabulary is exactly what
 * broke. IDs are stable across renames. Every ID below was read live off the
 * reference contact on 2026-08-03 and cross-checked against the name table in
 * src/ghl-field-decoder.js.
 *
 * MIRRORS: src/canvassing-intake.js buildCanvassingNotes() — same
 * deterministic-template discipline, different source fields. `notes` is an
 * established addlead field (src/canvassing-intake.js buildAddleadBody).
 *
 * SCOPE: internal operations artifact for setters and reps. A factual echo of
 * captured fields. NOT customer-facing copy, NOT a script, NOT persuasive.
 * Do not run it through the customer-facing copy framework and do not let it
 * drift that way.
 *
 * TWO CORRECTIONS FOUND AGAINST LIVE DATA (2026-08-03), both deliberate:
 *   1. AI Short Summary is preferred OVER "AI Contact Summary (alt)". On the
 *      reference contact the alt reads "...the agent stating they did not have
 *      enough information to help Cynthia" while the Short Summary carries the
 *      7 windows, the maybe-door, and the warranty/promotion questions. The
 *      decoder also records the alt as a variant of Iv7r6m0 (the ChatGPT-node
 *      output), not of the Short Summary.
 *   2. Window Count (h9FJTUbmUHIuD6JKmpXv) is read as a first-class field.
 *      Job size is the single most useful fact for a setter and must not
 *      depend on whether an LLM happened to mention it in prose.
 */

const F = {
  HEADER:            null,                  // synthesized, not a GHL field
  AI_SUMMARY:        'dDFaBRpRn2aHVZTboUeB', // AI Short Summary
  AI_SUMMARY_ALT:    'hveTpGaEGu37Rq4skTgx', // AI Contact Summary (alt)
  CONTACT_SUMMARY:   'Iv7r6m0LNCmCeDYt8U8L', // ChatGPT-node output
  CHAT_TRANSCRIPT:   'RF710H9k39oLl9TsQIy4',
  PAIN_POINT:        'yU8H6nzSs0A6RaGfvARI',
  PAIN_CATEGORY:     'gWxwXv69jWTRg4RN3D91',
  PAIN_DRIVER:       'X2t7jeEnsJC6LQPCq4Ij',
  EMOTIONAL_ARC:     'd813yiRjmSLjRzSKRB7a',
  TRUST_SCORE:       'zrghbp0ZLrOyTWc9x6Ai',
  OBJECTION:         'ATvhIO4G5UvI93nRDsnY',
  CHATBOT_EXIT:      'KsMdYWa9GmtLinA05jZW',
  PREFERRED_CONTACT: 'jv6c5Lie982duxVX5TNv',
  LANGUAGE:          '3vQsf4lNxL0LrDpgHY9Q',
  PRODUCT_INTEREST:  'yjW7vPy2PYaircO0Amqn', // renders "Impact Windows"
  WINDOW_COUNT:      'h9FJTUbmUHIuD6JKmpXv',
  MARKET_CODE:       'z0MV6mXi0w9WwdCOFThh',
  COUNTY:            'YYFHLeRfdBce2JdMMfR1',
  SOURCE_DETAIL:     'VJ8JhmawlFD7nL4RU1Qz',
  SOURCE_WIDGET:     's5bn6zjp99xopAQ5XzfZ',
  P1_STAGE:          '2lrRmCPQG6eXnfw7s91J',
};

/**
 * EXCLUDED — MP4kHjcOvwYvPSr2QmPi ("Last Sentiment") is polluted: it stores the
 * raw last inbound message, not a sentiment. On the reference contact it read
 * "6925 Summer Harbor Lane, Riverview, Florida 33578", then "Yes", then "ok".
 * Including it puts garbage in front of a setter. Do not re-add until that
 * writer is fixed.
 */
const EXCLUDED_FIELDS = ['MP4kHjcOvwYvPSr2QmPi'];

const MAX_NOTES_CHARS = Number(process.env.LP_NOTES_MAX_CHARS || 3500);
const WEAK_NOTES_CHARS = Number(process.env.LP_NOTES_WEAK_THRESHOLD || 120);

// LP renders notes as one run of text, and the ChatGPT node this replaces
// already produced that shape ("LEAD: ... | WANTS: ... | HEADS UP: ...").
const SEP = ' | ';
const HEADER_LABEL = 'AGENTIC LEAD';
const TRANSCRIPT_LABEL = 'CONVERSATION';
// Below this there is no room for a useful number of turns, so the transcript
// is dropped entirely rather than reduced to a trim marker plus one fragment.
const MIN_TRANSCRIPT_ROOM = 150;

const isBlank = (v) => v == null || String(v).trim() === '';
const UNRESOLVED_TOKEN_RE = /\{\{.*?\}\}/;

/** Blank, and unresolved merge tokens, both read as absent — a renamed GHL
 *  field degrades to an omitted line, never a literal "{{contact.x}}".
 *  Value-key handling mirrors readCustomField in
 *  src/actions/handlers/objection-state.js; numeric values (Trust Level Score,
 *  Window Count) survive as their string form. */
export function readField(contact, fieldId) {
  if (!fieldId || EXCLUDED_FIELDS.includes(fieldId)) return null;
  const cf = contact?.customFields || contact?.customField || [];
  if (!Array.isArray(cf)) return null;
  const hit = cf.find((f) => f && f.id === fieldId);
  const v = hit?.value ?? hit?.field_value ?? hit?.fieldValue;
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '' || UNRESOLVED_TOKEN_RE.test(s)) return null;
  return s;
}

/** A brief under WEAK_NOTES_CHARS, or one that is only a merge token, is not
 *  worth sending. Callers replace it. */
export function isWeakNotes(v) {
  if (isBlank(v)) return true;
  const s = String(v).trim();
  if (UNRESOLVED_TOKEN_RE.test(s)) return true;
  return s.length < WEAK_NOTES_CHARS;
}

/** Split the " / "-joined transcript into numbered turns. Trims from the FRONT
 *  (a setter needs the most recent turns) but prints chronologically. */
export function formatTranscript(raw, maxChars) {
  if (isBlank(raw)) return '';
  const turns = String(raw).split(' / ').map((t) => t.trim()).filter(Boolean);
  if (!turns.length) return '';
  const lines = [];
  let used = 0;
  let dropped = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const line = `${i + 1}. ${turns[i]}`;
    if (used + line.length + 1 > maxChars) { dropped = i + 1; break; }
    lines.unshift(line);
    used += line.length + 1;
  }
  if (!lines.length) return '';
  if (dropped > 0) lines.unshift(`[${dropped} earlier turn(s) trimmed]`);
  return lines.join(' ');
}

const renderSection = (s) => (s.label ? `${s.label}: ${s.body}` : s.body);

/** Collapse to a single run of text and enforce the hard ceiling. */
function clamp(text, maxChars) {
  const out = String(text).replace(/\s*\n+\s*/g, ' ').trim();
  return out.length > maxChars ? `${out.slice(0, Math.max(0, maxChars - 3))}...` : out;
}

/**
 * The labelled body of the brief, minus the transcript. Shared by the full
 * build and the augment path so the two can never drift apart.
 * Returns [{ label, body }] with empty sections already dropped.
 */
function buildSections(contact, opts = {}) {
  const hasAppointment = opts.hasAppointment === true;
  const g = (id) => readField(contact, id);
  const out = [];
  const push = (label, body) => { if (!isBlank(body)) out.push({ label, body }); };

  push(HEADER_LABEL, hasAppointment
    ? 'appointment attached.'
    : 'NO APPOINTMENT. Call to book.');

  push('SUMMARY', g(F.AI_SUMMARY) || g(F.AI_SUMMARY_ALT));

  const market = g(F.MARKET_CODE);
  const county = g(F.COUNTY);
  const windows = g(F.WINDOW_COUNT);
  push('WANTS', [
    g(F.PRODUCT_INTEREST),
    windows ? `${windows} windows` : null,
    market && county ? `${market} / ${county}` : market,
  ].filter(Boolean).join(' — '));

  // Deduped: PAIN_POINT and PAIN_CATEGORY are frequently the same value.
  const pain = [g(F.PAIN_POINT), g(F.PAIN_CATEGORY), g(F.PAIN_DRIVER)]
    .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' / ');
  const language = g(F.LANGUAGE);

  push('HEADS UP', [
    language && language.toLowerCase().startsWith('span') ? 'SPANISH SPEAKER.' : null,
    g(F.OBJECTION) ? `Objection ${g(F.OBJECTION)}` : null,
    pain ? `Pain ${pain}` : null,
    g(F.TRUST_SCORE) ? `Trust ${g(F.TRUST_SCORE)}/10` : null,
    g(F.EMOTIONAL_ARC) ? `Arc ${g(F.EMOTIONAL_ARC)}` : null,
  ].filter(Boolean).join('; '));

  push('REACH', [
    g(F.PREFERRED_CONTACT) ? `prefers ${g(F.PREFERRED_CONTACT)}` : null,
    language,
    g(F.SOURCE_DETAIL) && g(F.SOURCE_WIDGET)
      ? `via ${g(F.SOURCE_DETAIL)} / ${g(F.SOURCE_WIDGET)}`
      : g(F.SOURCE_DETAIL) ? `via ${g(F.SOURCE_DETAIL)}` : null,
    g(F.CHATBOT_EXIT) ? `bot exit ${g(F.CHATBOT_EXIT)}` : null,
    g(F.P1_STAGE),
  ].filter(Boolean).join(', '));

  return out;
}

/** The transcript is always last, so it is the first thing trimmed when room
 *  runs out. Returns '' when there is no room or no transcript. */
function transcriptSection(contact, usedChars, maxChars) {
  const room = maxChars - usedChars - `${TRANSCRIPT_LABEL}: `.length - SEP.length;
  if (room <= MIN_TRANSCRIPT_ROOM) return '';
  const t = formatTranscript(readField(contact, F.CHAT_TRANSCRIPT), room);
  return t ? `${TRANSCRIPT_LABEL}: ${t}` : '';
}

/**
 * Build the LP notes payload. PURE — contact object in, string out.
 *
 * Format follows the existing house style for this field: a single pipe-
 * separated block with ALL-CAPS section labels and no newlines. Reps scan it
 * in seconds.
 *
 * OPENER is deliberately NOT generated. Writing a line for a rep to say out
 * loud is customer-facing copy and belongs to the copy framework, not to a
 * field-echo utility. The rep opens from SUMMARY.
 *
 * @param {object} contact GHL contact (with customFields[])
 * @param {object} opts    { hasAppointment:boolean, maxChars:number }
 */
export function buildAgenticLeadNotes(contact, opts = {}) {
  const maxChars = Number(opts.maxChars || MAX_NOTES_CHARS);
  const parts = buildSections(contact, opts).map(renderSection);
  const transcript = transcriptSection(contact, parts.join(SEP).length, maxChars);
  if (transcript) parts.push(transcript);
  return clamp(parts.join(SEP), maxChars);
}

/**
 * Append to an existing brief instead of replacing it. Adds only the sections
 * the incoming text does not already carry, so a healthy ChatGPT-node output
 * (which has LEAD/WANTS/OPENER/HEADS UP but never the transcript) keeps
 * everything it had and gains what it lacked.
 *
 * The header is PREPENDED when missing — "NO APPOINTMENT. Call to book." is
 * the most actionable line in the brief and belongs at the top, not buried.
 *
 * Returns null when there is nothing to add, so callers can forward unchanged.
 */
export function buildAugmentedNotes(existing, contact, opts = {}) {
  if (isBlank(existing)) return null;
  const maxChars = Number(opts.maxChars || MAX_NOTES_CHARS);
  const base = String(existing).trim();
  const hasLabel = (label) =>
    new RegExp(`(^|\\|)\\s*${label.replace(/\s+/g, '\\s+')}\\s*:`, 'i').test(base);

  const missing = buildSections(contact, opts).filter((s) => !hasLabel(s.label));
  const header = missing.find((s) => s.label === HEADER_LABEL);
  const appended = missing.filter((s) => s.label !== HEADER_LABEL).map(renderSection);

  const lead = header ? [renderSection(header)] : [];
  let parts = [...lead, base, ...appended];

  if (!hasLabel(TRANSCRIPT_LABEL)) {
    const transcript = transcriptSection(contact, parts.join(SEP).length, maxChars);
    if (transcript) {
      appended.push(transcript);
      parts = [...lead, base, ...appended];
    }
  }

  if (!lead.length && !appended.length) return null;
  return clamp(parts.join(SEP), maxChars);
}

/**
 * Fetch the contact and build its notes. Returns null on ANY failure — callers
 * treat null as "forward unchanged". Never throws.
 *
 * Pass opts.augmentFrom to keep an existing brief and only add what it lacks;
 * omit it to build the brief from scratch.
 *
 * getContact is injectable so tests need no network (house DI pattern).
 * getGHLContact itself never throws and returns null on 404, timeout, or the
 * latched GHL kill switch — all of which land on the same forward-unchanged
 * path here.
 */
export async function fetchAndBuildAgenticNotes(contactId, opts = {}, deps = {}) {
  if (isBlank(contactId)) return null;
  try {
    const { getContact } = deps;
    const fetchFn = getContact || (await import('../ghl.js')).getGHLContact;
    const contact = await fetchFn(contactId);
    if (!contact) return null;
    const notes = isBlank(opts.augmentFrom)
      ? buildAgenticLeadNotes(contact, opts)
      : buildAugmentedNotes(opts.augmentFrom, contact, opts);
    return isBlank(notes) ? null : notes;
  } catch (err) {
    console.warn(`[AGENTIC-NOTES] build failed for ${contactId} (forwarding unchanged): ${err.message}`);
    return null;
  }
}

export const _internal = {
  F, EXCLUDED_FIELDS, MAX_NOTES_CHARS, WEAK_NOTES_CHARS, SEP, HEADER_LABEL, buildSections,
};
