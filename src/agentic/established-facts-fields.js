/**
 * Established-facts field contract — src/agentic/established-facts-fields.js
 *
 * The one place that knows which established facts are writable, what values
 * they accept, and which GHL custom field each lands in.
 *
 * Shared by two consumers that must never disagree:
 *   - src/message-analyzer.js         emits `established_facts` on
 *                                     ai.analysis_completed
 *   - src/actions/handlers/established-facts.js
 *                                     writes them to the contact record
 *
 * PURE. No I/O, no deps — so the analyzer can import it without dragging in
 * Supabase or the GHL client.
 *
 * WHY (2026-09-11, Alfredo Fontan — GHL VKMKhd8JQ4wsp3zMn8Lt)
 * ──────────────────────────────────────────────────────────
 * At 19:37:37Z the analyzer concluded, in ai.analysis_completed event 3603318:
 * "He is the sole decision-maker." It said so in PROSE, in the `reasoning`
 * string, where nothing can act on it. The field GH1QGGOseMKmJAMqajiN stayed
 * empty until 21:25:22Z, when the RESPONDER's own QUALIFYING_DATA_PERSIST path
 * finally wrote it (agent_actions 448555) — 1h48m later, and one repeat-ask
 * too late (outbound yFkfGW3AOmm9M8Myk7W8 at 21:11:55Z).
 *
 * The analyzer already reaches these conclusions. This makes it emit them as
 * DATA, on the same event, at the moment it knows.
 */

/**
 * Field ids verified live against the GHL custom_fields table on contact
 * VKMKhd8JQ4wsp3zMn8Lt, 2026-09-11.
 *
 * `address_confirmed` and `answered_question_keys` are DELIBERATELY absent.
 * There is no address-confirmation custom field — that state is carried by the
 * tag `booking:address-confirmed` — and answered_question_keys is a list, not
 * a field. Both still ride on the event payload, where the responder and a Bot
 * Review replay can read them; neither is written to the contact record,
 * because inventing a field id is how a write lands somewhere nobody reads.
 */
export const ESTABLISHED_FACT_FIELDS = Object.freeze({
  decision_makers_present: {
    id: 'GH1QGGOseMKmJAMqajiN',
    label: 'Decision Makers Present',
    type: 'select',
    // The live select options, exactly. A value outside this set is dropped,
    // never coerced — GHL silently accepts an off-list string on a select and
    // every downstream reader then compares against something that can never
    // match.
    enum: Object.freeze(['Yes', 'No', 'Solo Owner', 'Uncertain']),
  },
  window_count: {
    id: 'h9FJTUbmUHIuD6JKmpXv',
    label: 'Window Count',
    type: 'number',
  },
  preferred_time: {
    id: '7lpRWFDM8DZbLd3viHEG',
    label: 'Preferred Estimate Time',
    type: 'text',
  },
});

/** Keys the analyzer may report as answered. Data only — nothing is written. */
export const ANSWERABLE_QUESTION_KEYS = Object.freeze([
  'decision_makers', 'window_count', 'address', 'preferred_time',
  'prior_quotes', 'email', 'timeline',
]);

/**
 * Reduce a raw `established_facts` object to the field writes it justifies.
 *
 * Drops, rather than coerces or guesses:
 *   - anything absent, null, empty, or the strings "null" / "unknown" / "n/a"
 *   - a select value outside the live option list
 *   - a window count that is not a positive integer within a sane range
 *
 * @param {object|null} raw  analysis.established_facts
 * @returns {{fields: {id: string, field_value: string}[], written: string[], dropped: {key: string, value: any, reason: string}[]}}
 */
export function normalizeEstablishedFacts(raw) {
  const fields = [];
  const written = [];
  const dropped = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { fields, written, dropped };
  }

  for (const [key, spec] of Object.entries(ESTABLISHED_FACT_FIELDS)) {
    const value = raw[key];

    if (value === null || value === undefined) continue;
    const str = String(value).trim();
    if (!str || ['null', 'undefined', 'unknown', 'n/a', 'none'].includes(str.toLowerCase())) {
      dropped.push({ key, value, reason: 'empty_or_placeholder' });
      continue;
    }

    if (spec.enum) {
      // Case-insensitive match, but the CANONICAL casing is what gets written:
      // "solo owner" from the model becomes "Solo Owner" on the record.
      const match = spec.enum.find(o => o.toLowerCase() === str.toLowerCase());
      if (!match) {
        dropped.push({ key, value, reason: `not_in_enum(${spec.enum.join('|')})` });
        continue;
      }
      fields.push({ id: spec.id, field_value: match });
      written.push(key);
      continue;
    }

    if (spec.type === 'number') {
      const n = Number(str);
      if (!Number.isInteger(n) || n <= 0 || n > 300) {
        dropped.push({ key, value, reason: 'not_a_plausible_count' });
        continue;
      }
      fields.push({ id: spec.id, field_value: String(n) });
      written.push(key);
      continue;
    }

    fields.push({ id: spec.id, field_value: str.slice(0, 500) });
    written.push(key);
  }

  return { fields, written, dropped };
}
