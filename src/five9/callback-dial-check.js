/**
 * Did Five9 actually CALL the lead? — src/five9/callback-dial-check.js
 *
 * 2026-10-03 (review of Part 14, "no GHL instant ring"). The verify sweep
 * (src/jobs/lp-requeue-verify.js) used to stop at "the record reached the
 * Callback Request list". Reaching the list is not a call. Of the 18 callback
 * pushes in the 30 days to 2026-10-03, matched against Five9's own disposition
 * feed (five9.disposition_set):
 *   - 6 got a Callback Request call: 3 within a minute, the others at 2 min,
 *     5.5 min and 11.5 hours (filed after the 8 PM stop);
 *   - 12 never got one within 3 days. 4 were on Five9's DNC list (now refused
 *     before the push, callback-push.js); the rest include business-hours
 *     pushes on 10/1 and 10/2 that simply never dialed.
 * The campaign is PREVIEW mode: an agent with the skill has to be free and take
 * it, and its profile filter waits 7 hours after any earlier call to the number.
 * So the sweep now waits for a real call and, when none comes, tells
 * #contact-center to call the lead by hand.
 *
 * Pure and dependency-free: the job owns the reads and the post.
 */

/** Minutes after the dial window opens before "not called yet" is raised. */
export const DIAL_GRACE_MS = 15 * 60 * 1000;
/** The Callback Request profile dials 8:00–20:00 (Five9 dialing schedule). */
export const DIAL_START_MIN = 8 * 60;
/** Filed this close to the 8 PM stop, it waits for the morning. */
export const DIAL_LAST_START_MIN = 19 * 60 + 45;
/** The Callback Request profile filter: last call 7h+ ago OR never called (2026-09-30). */
export const PROFILE_GAP_MS = 7 * 60 * 60 * 1000;

function etMinuteOfDay(ms) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const h = Number(parts.find(p => p.type === 'hour')?.value || 0);
  const m = Number(parts.find(p => p.type === 'minute')?.value || 0);
  return h * 60 + m;
}

/**
 * When Five9 could first dial a record filed at `filedMs`: now, if inside the
 * window, else the next 8:00 ET. Minute arithmetic on ET wall clock, so a DST
 * change overnight can move the morning answer by an hour, two nights a year;
 * the cost is one alert an hour early or late. Pure.
 */
export function dialWindowStartMs(filedMs) {
  const m = etMinuteOfDay(filedMs);
  const floor = filedMs - (filedMs % 60000);
  if (m < DIAL_START_MIN) return floor + (DIAL_START_MIN - m) * 60000;
  if (m >= DIAL_LAST_START_MIN) return floor + (24 * 60 - m + DIAL_START_MIN) * 60000;
  return filedMs;
}

/**
 * @param {{ filedMs: number, nowMs: number, calls: Array<{ atMs: number }> | null }} a
 *   calls — Five9 calls to/from the number at or after filing; null = could not read
 * @returns {'dialed'|'wait'|'not_dialed'|null} null = could not tell (touch nothing)
 */
export function dialCheckVerdict({ filedMs, nowMs, calls }) {
  if (!Array.isArray(calls)) return null;
  if (calls.some(c => Number.isFinite(c?.atMs) && c.atMs >= filedMs - 60000)) return 'dialed';
  return nowMs < dialWindowStartMs(filedMs) + DIAL_GRACE_MS ? 'wait' : 'not_dialed';
}

function fmtPhone(n) {
  const d = String(n || '').replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (n || 'unknown');
}

function fmtEt(ms) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(ms)) + ' ET';
}

/**
 * The #contact-center card for a promised call Five9 has not made. Pure.
 * @param {{ name, phone, contactId, filedMs, nowMs, priorCalls: Array<{atMs, campaign}>, locationId }} a
 *   priorCalls — Five9 calls to the number in the 24h BEFORE filing
 */
export function formatNotDialedCard({ name, phone, contactId, filedMs, nowMs, priorCalls = [], locationId }) {
  const waited = Math.max(1, Math.round((nowMs - dialWindowStartMs(filedMs)) / 60000));
  const last = [...priorCalls].sort((a, b) => b.atMs - a.atMs)[0] || null;
  const lines = [
    '⏰ PROMISED CALL NOT MADE YET',
    `Contact: ${name || 'name not on file'}`,
    `Phone: ${fmtPhone(phone)}`,
    `They asked for a call at ${fmtEt(filedMs)}. It is on the Five9 Callback Request list, but Five9 has not called them in ${waited} min.`,
  ];
  if (last && filedMs - last.atMs < PROFILE_GAP_MS) {
    lines.push(`Why it may be waiting: Five9 called this number ${Math.round((filedMs - last.atMs) / 60000)} min before they asked${last.campaign ? ` (${last.campaign})` : ''}, and the Callback Request campaign waits 7 hours after a call.`);
  }
  if (priorCalls.length) lines.push(`Five9 calls to this number in the 24 hours before they asked: ${priorCalls.length}.`);
  lines.push('→ Please call them now.');
  if (contactId) lines.push(`GHL: https://app.gohighlevel.com/v2/location/${locationId || 'SsBG7j5KQAIP1SFP2Sca'}/contacts/detail/${contactId}`);
  return lines.join('\n');
}
