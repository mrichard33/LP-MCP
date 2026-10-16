/**
 * follow-up-hold.js — how long a "follow up with me later" hold lasts, and the
 * context it carries to the check-in (the user, 2026-10-16). Pure: no I/O.
 *
 * WHY. The follow_up_scheduled dispatch row froze a lead for the analyzer's
 * BUCKET ("in November" → 1month = 720h from the moment of sending, not Nov 1;
 * "whenever" → 1week) and stored nothing about what the lead asked for, so the
 * check-in at the end (rule 331) had no idea what it was picking up. The user:
 * "we should be able to send that message here, along with the previous summary
 * or context, so we can pick up exactly where the conversation left off at the
 * requested follow-up time."
 *
 * Now the hold is timed to the date the lead named when there is one
 * (detectDeferral, the same reader the post-demo planner uses), a "whenever"
 * waits two weeks (the user's ruling, 2026-10-16), and the issue_hold row keeps
 * the lead's own words, the date asked for and the analyzer's one-line read of
 * the conversation. The GHL hold sees only hold_hours; the context stays on our
 * agent_actions row, which the check-in reads back when the hold ends.
 */

import { detectDeferral } from './post-demo-turn.js';

// "Whenever" / "later" / no timeframe: two weeks (the user, 2026-10-16).
export const WHENEVER_HOLD_HOURS = 336;
// Never shorter than an hour (a date "today" is not a follow-up) or longer than a year.
const MIN_HOLD_HOURS = 1;
const MAX_HOLD_HOURS = 24 * 365;
const H = 3_600_000;

// Mirrors INTERPOLATE_FILTERS.follow_up_hold_hours (src/actions/helpers.js).
const BUCKETS = Object.freeze({
  'tomorrow': { hours: 24, label: 'tomorrow' },
  'few-days': { hours: 72, label: 'in a few days' },
  '1week': { hours: 168, label: 'next week' },
  '2weeks': { hours: 336, label: 'in a couple of weeks' },
  '1month': { hours: 720, label: 'in about a month' },
  '2months': { hours: 1440, label: 'in a couple of months' },
  'after-holidays': { hours: 1080, label: 'after the holidays' },
  'seasonal': { hours: 2160, label: 'in a few months' },
});

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * @param {object} p
 * @param {string} p.messageText  the lead's message that asked for the follow-up
 * @param {string|null} p.bucket  the analyzer's follow_up_bucket
 * @param {number} [p.nowMs]
 * @param {string|null} [p.reasoning]  the analyzer's 1–2 sentence read of the turn
 * @returns {{ hold_hours: string, follow_up: object }}
 */
export function planFollowUpHold({ messageText = '', bucket = null, nowMs = Date.now(), reasoning = null } = {}) {
  const text = String(messageText || '');
  const b = typeof bucket === 'string' ? bucket.toLowerCase() : null;
  let hours;
  let label;
  let untilIso = null;
  let source;

  const dated = detectDeferral(text, nowMs);
  const untilMs = dated ? Date.parse(dated.untilIso) : NaN;
  if (dated && Number.isFinite(untilMs) && untilMs - nowMs >= MIN_HOLD_HOURS * H) {
    hours = Math.ceil((untilMs - nowMs) / H);
    label = dated.label;
    untilIso = dated.untilIso;
    source = 'date';
  } else if (!b || !BUCKETS[b] || (b === '1week' && !/\bweek\b/i.test(text))) {
    // The analyzer maps a vague deferral to 1week; a lead who never said
    // "week" was vague, and vague is two weeks now.
    hours = WHENEVER_HOLD_HOURS;
    label = 'in a couple of weeks';
    source = 'whenever';
  } else {
    hours = BUCKETS[b].hours;
    label = BUCKETS[b].label;
    source = 'bucket';
  }
  hours = Math.min(MAX_HOLD_HOURS, Math.max(MIN_HOLD_HOURS, hours));
  if (!untilIso) untilIso = new Date(nowMs + hours * H).toISOString();

  return {
    hold_hours: String(hours),
    follow_up: {
      requested_text: clip(text, 400) || null,
      label,
      until_iso: untilIso,
      source,
      bucket: b,
      summary: clip(reasoning, 400) || null,
      planned_at: new Date(nowMs).toISOString(),
    },
  };
}
