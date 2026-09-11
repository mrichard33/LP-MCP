/**
 * Five9 Dial Window — src/dial-window.js
 *
 * The one place that answers "is the dialer open right now?".
 *
 * WHY THIS EXISTS
 * ───────────────
 * The Layer 3 `callback_request` prompt told the model: "If they want it NOW
 * and it is business hours, promise a call in the next few minutes." Nothing
 * ever computed business hours. The model inferred them — and the repo gave it
 * six different answers to infer from: agentic-callback-message.js says
 * 08:00-17:00 Mon-Fri, five9-silence-watchdog.js says 09:00-18:00 Mon-Sat,
 * quiet-hours.js says 08:00-21:00 daily, reschedule-options.js and
 * lp-ghl-appointment-reconciler.js carry per-weekday appointment grids, and the
 * knowledge base (sql/013_kb_seed_structured.sql:223) states "Mon-Fri 9am-8pm,
 * Sat 9am-5pm, Sun 9am-3pm" straight into the model's context.
 *
 * So the bot could promise an immediate call at 8:30 PM while believing the
 * office closed at 5, or refuse one at 8:15 AM. That is the Robert Pederson
 * failure (2026-09-04): a promise of a call that the dialer could not keep.
 *
 * THIS MODULE IS NOT A SEVENTH DEFINITION OF "BUSINESS HOURS". It answers one
 * narrower question — whether Five9 will actually place an outbound call — and
 * the only correct source for that is the Five9 dialing schedule. Verified live
 * 2026-09-04 via five9_get_campaign_profiles: all 14 profiles, the "Callback
 * Request" profile included, dial Primary/Alt1/Alt2 08:00-21:00, every day.
 *
 * Do NOT widen this to cover office hours, appointment validity, or SMS quiet
 * hours. Those are different questions with different right answers, and
 * collapsing them is how the six definitions above came to disagree. SMS
 * sendability stays with src/services/quiet-hours.js.
 *
 * WHY THE HOURS ARE ENV-TUNABLE AND READ PER CALL
 * ────────────────────────────────────────────────
 * If Mark changes the Five9 dialing schedule in the admin UI, this must be able
 * to follow within minutes, not within a deploy. Same reasoning as
 * isQuietHoursBypassed() in src/services/quiet-hours.js. The defaults are the
 * live Five9 values, so an unset env is already correct.
 *
 * THIS IS THE DIAL SCHEDULE, NOT AGENT AVAILABILITY — DECIDED, NOT OVERLOOKED
 * ──────────────────────────────────────────────────────────────────────────
 * The Callback Request campaign runs in PREVIEW mode. PREVIEW does not
 * auto-dial: Five9 presents the record to a logged-in agent, who places the
 * call. So the binding constraint on a callback actually happening is AN AGENT
 * BEING LOGGED IN, which is not what this module measures.
 *
 * Observed live 2026-09-04: a correctly-built record sat in the Callback
 * Request list without dialing at 18:49 ET — inside the 08:00-21:00 window,
 * profile filter cleared, callNowMode=ANY applied — because
 * five9_supervisor_statistics(AgentState) returned zero rows. Friday evening,
 * empty floor. Nothing was broken; there was simply nobody to hand it to.
 *
 * On 2026-09-04 Mark ruled to accept the gap: keep PREVIEW, do NOT gate the
 * promise on live agent availability, keep the promise window on the dial
 * schedule as it is — and reopen it with him rather than "fixing" it here.
 *
 * REOPENED AND REVERSED — MARK, 2026-09-11
 * ────────────────────────────────────────
 * This IS that reopening, and it replaces the paragraph above. The accepted
 * consequence turned out to be the wrong trade: between the floor going home
 * and 21:00, and all day on a Sunday evening, the bot was promising "someone
 * will ring you in the next few minutes" against an empty room. Mark's ruling:
 * WHEN THE OFFICE IS CLOSED, THE BOT MUST NOT SUGGEST ANYONE WILL CALL
 * IMMEDIATELY.
 *
 * The fix is NOT to narrow this module. This still answers only "is Five9
 * dialing?", and its 08:00-21:00-every-day answer is still the correct one for
 * that question. Staffed hours are a SECOND fact, owned by src/staffed-hours.js
 * (Mon-Fri 8:00 AM-8:00 PM, Sat 9:00 AM-8:00 PM, Sun 9:00 AM-5:00 PM ET,
 * confirmed by Mark 2026-09-11). canPromiseImmediateCall() below is the only
 * place the two are combined — an immediate-callback promise needs both, and
 * neither module has been widened to answer the other's question.
 *
 * The alternative still declined: reading AgentState per reply, which would put
 * a live Five9 call in the reply path that then has to fail toward the safer
 * copy anyway.
 */

import { isWithinStaffedHours, nextStaffedOpening, staffedHoursHuman } from './staffed-hours.js';

const TZ = 'America/New_York';

const DEFAULT_START_HOUR = 8;   // Five9 dialingSchedules[].startTime.hours
const DEFAULT_END_HOUR = 21;    // Five9 dialingSchedules[].stopTime.hours

/**
 * Read an hour-of-day env var, falling back when unset or not a whole hour in
 * 0-24. A malformed value must not silently open the dialer at midnight, so an
 * out-of-range value is discarded rather than clamped.
 */
function hourFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 24) return fallback;
  return n;
}

/** The configured dial window, read fresh. */
export function dialWindowBounds() {
  return {
    startHour: hourFromEnv('FIVE9_DIAL_WINDOW_START_HOUR_ET', DEFAULT_START_HOUR),
    endHour: hourFromEnv('FIVE9_DIAL_WINDOW_END_HOUR_ET', DEFAULT_END_HOUR),
    timeZone: TZ,
  };
}

/**
 * The ET hour (0-23) and minute at an instant, DST-correct.
 *
 * formatToParts with hourCycle 'h23' rather than getHours() — the server runs
 * UTC, so getHours() would answer a different question entirely.
 */
export function etHourMinute(atMs = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(atMs));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  return { hour, minute };
}

/**
 * Is Five9 dialing right now?
 *
 * Half-open on the top: 20:59 ET is inside a 08:00-21:00 window and 21:00 is
 * not, matching the Five9 stopTime. Every day of the week — the Five9 schedule
 * carries no weekday restriction, so neither does this.
 *
 * @param {number} [atMs]  epoch ms; defaults to now
 * @returns {boolean}
 */
export function isWithinDialWindow(atMs = Date.now()) {
  const { startHour, endHour } = dialWindowBounds();
  const { hour } = etHourMinute(atMs);
  if (!Number.isFinite(hour)) return false;
  return hour >= startHour && hour < endHour;
}

/**
 * Can the bot promise a call in the next few minutes right now?
 *
 * BOTH facts have to hold: Five9 has to be dialing AND somebody has to be there
 * to take the record. Mark's 2026-09-11 ruling, and the only place the two
 * schedules are combined — see the header.
 *
 * @param {number} [atMs]  epoch ms; defaults to now
 * @returns {boolean}
 */
export function canPromiseImmediateCall(atMs = Date.now()) {
  return isWithinDialWindow(atMs) && isWithinStaffedHours(atMs);
}

/**
 * One line of fact for the reply prompt. Deliberately states the boundary as
 * well as the verdict: told only "the phone room is closed", a model will
 * invent a reopening time, and an invented one contradicts the SMS the
 * customer gets.
 *
 * Built on canPromiseImmediateCall, not on isWithinDialWindow — the line
 * describes whether a promise is safe, and that is the combined question. The
 * hours it quotes are rendered from the live schedule so the copy can never
 * drift from the code enforcing it.
 *
 * @param {number} [atMs]
 * @returns {string}
 */
export function dialWindowPromptLine(atMs = Date.now()) {
  const staffed = staffedHoursHuman();
  if (canPromiseImmediateCall(atMs)) {
    return `PHONE ROOM: OPEN right now (staffed ${staffed}). An immediate callback CAN be promised.`;
  }
  const next = nextStaffedOpening(atMs);
  const when = next.human ? `The next call can go out ${next.human} ET. ` : '';
  return `PHONE ROOM: CLOSED right now. ${when}An immediate callback CANNOT be promised.`;
}
