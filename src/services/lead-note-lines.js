/**
 * Shared LP lead-note assembly — src/services/lead-note-lines.js
 *
 * One home for the `notes` block that intake handlers hand to LP addLead.
 * Extracted 2026-08-07 when the affiliate intake route
 * (src/affiliate-lead-handler.js) needed the same block as the canvassing
 * route: copy-pasting it would mean making the next notes fix twice, and one
 * copy would drift. Drift is exactly how the project counts got lost — the
 * legacy path (src/canvassing-intake.js buildCanvassingNotes) always sent
 * them, the v2 rewrite dropped them, and nobody noticed until 2026-08-07.
 *
 * Contract: project counts LEAD the block, then whatever trailing sections the
 * caller supplies. Job size is the single most useful fact for the setter
 * working the lead and the rep dispatched to the home, so it must never sit
 * below free text.
 *
 * Blank values are OMITTED rather than printed empty. The legacy template
 * emits a fixed 7-line block that renders "Door Count:" with nothing after it
 * on a partially filled form, which reads to a setter as "asked, answered
 * zero" instead of "not captured". Same labels, different blank handling —
 * deliberate.
 *
 * Pure: no imports, no I/O.
 */

/**
 * Build the LP `notes` string.
 *
 * @param {object} [counts] — the three project-count fields, taken straight
 *   off a normalized intake payload (extra keys are ignored, so callers can
 *   pass the whole payload).
 * @param {string} [counts.window_count]
 * @param {string} [counts.door_count]
 * @param {string} [counts.slider_count]
 * @param {Array<string|false|null|undefined>} [trailingLines] — already
 *   formatted lines appended after the counts, in order. Falsy entries are
 *   dropped, so callers can pass `cond && \`Label: ${value}\`` inline.
 * @returns {string} newline-joined block; '' when everything is blank.
 */
export function buildLeadNoteLines(counts = {}, trailingLines = []) {
  const { window_count, door_count, slider_count } = counts || {};

  const projectLines = [
    window_count && `Window Count: ${window_count}`,
    door_count && `Door Count: ${door_count}`,
    slider_count && `Slider Count: ${slider_count}`,
  ].filter(Boolean);

  return [...projectLines, ...(trailingLines || [])].filter(Boolean).join('\n');
}

export default { buildLeadNoteLines };
