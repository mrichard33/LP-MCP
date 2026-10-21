/**
 * F.0 v2 position 0: the post-demo email — src/siro/f0-email.js (Mark, 2026-10-21)
 *
 * Pure. The evening of an unsold demo, F.0 v2 sends ONE email before the
 * Four-Step texts, written from the Siro recording as the rehash rep, through
 * the same /api/agentic/nurture/generate call (workflow_code 'F.0',
 * sequence_position 0, channel 'email'). It replaces the old static F.0 email
 * ("What we saw at your home, <name>"): nothing of that copy carries over but
 * its job (thank them for the visit, reflect what was found, set up the call).
 *
 * One rule, one home: the position, the mode, the hold cap and the output
 * shape live here; the copy checks are checkF0Copy formula 'email'
 * (f0-copy-checks.js); the orchestrator and the preview only call these.
 *
 *   - Position 0 is valid for F.0 + email only. Any other workflow or channel
 *     asking for 0 is refused (unsupported_position). Before this a 0 silently
 *     became the contact field's position or 1.
 *   - F0_EMAIL_MODE off | shadow | live, default shadow. It decides the email
 *     alone (the user, 2026-10-21: SMS and email go live independently):
 *     F0_V2_MODE=off and the global NURTURE_SHADOW_MODE still stop it, but the
 *     F.0 entry in NURTURE_SHADOW_WORKFLOWS governs the texts only.
 *   - No recording, no email. The awaiting_siro hold (f0-interrupts.js) is
 *     reused with a cap of F0_EMAIL_HOLD_CAP_ET (default 08:30 ET the day after
 *     the demo) instead of 24h; past the cap with no recording the touch is
 *     suppressed no_recording and the workflow sends its fixed fallback
 *     template (tag f0-no-recording). The model never writes a generic email.
 */
import { siroModes } from './config.js';

export const F0_EMAIL_POSITION = 0;
export const F0_EMAIL_CHANNEL = 'email';
export const F0_NO_RECORDING_TAG = 'f0-no-recording';
export const F0_EMAIL_HOLD_CAP_DEFAULT = '08:30';
export const F0_EMAIL_SUBJECT_MAX = 60;
export const F0_EMAIL_PREHEADER_MAX = 90;
export const F0_EMAIL_BODY_WORDS = Object.freeze({ min: 120, max: 180 });

const HOUR_MS = 3_600_000;
const ET = 'America/New_York';

/** The request is the F.0 position-0 email. Pure. */
export function isF0EmailRequest(req) {
  return req?.workflow_code === 'F.0'
    && Number(req?.sequence_position) === F0_EMAIL_POSITION
    && req?.channel === F0_EMAIL_CHANNEL
    && req?.sequence_position !== '' && req?.sequence_position != null;
}

/** May this caller ask for position 0? Only F.0 by email. Pure. */
export function allowsPositionZero({ workflow_code, channel } = {}) {
  return workflow_code === 'F.0' && channel === F0_EMAIL_CHANNEL;
}

/** The payload asked for position 0 explicitly ("0" or 0). Pure. */
export function asksPositionZero(raw) {
  if (raw === null || raw === undefined || raw === '') return false;
  const n = Number(raw);
  return Number.isFinite(n) && Math.floor(n) === 0;
}

/** F0_EMAIL_MODE off|shadow|live, default shadow (a typo is shadow). */
export function f0EmailMode(env = process.env) {
  return siroModes(env).f0Email;
}

/**
 * Shadow or live for the EMAIL (answer 2, the user 2026-10-21): live only when
 * F0_EMAIL_MODE=live and the global NURTURE_SHADOW_MODE is not on. Pure.
 */
export function f0EmailShadow(env = process.env, globalShadow = false) {
  if (globalShadow) return true;
  return f0EmailMode(env) !== 'live';
}

function etParts(ms) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute) };
}

/** UTC ms of an Eastern wall-clock time (DST-correct to the minute). Pure. */
function etWallToMs(y, m, d, h, min) {
  let guess = Date.UTC(y, m - 1, d, h, min);
  for (let i = 0; i < 2; i++) {
    const p = etParts(guess);
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    guess += Date.UTC(y, m - 1, d, h, min) - shown;
  }
  return guess;
}

function parseCap(cap) {
  const m = String(cap || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  const h = m ? Number(m[1]) : NaN;
  const min = m ? Number(m[2]) : NaN;
  if (!(h >= 0 && h <= 23 && min >= 0 && min <= 59)) return { h: 8, min: 30 };
  return { h, min };
}

/**
 * When the wait for the recording ends: the cap time (ET) on the day after the
 * demo's Eastern date. A demo at 6 PM on the 20th waits until 08:30 on the
 * 21st. Pure.
 * @returns {number|null} UTC ms, null when the demo time is unknown
 */
export function emailHoldCapMs({ demoAtMs, capEt = F0_EMAIL_HOLD_CAP_DEFAULT } = {}) {
  if (!Number.isFinite(demoAtMs)) return null;
  const d = etParts(demoAtMs);
  const next = new Date(Date.UTC(d.y, d.m - 1, d.d + 1));
  const { h, min } = parseCap(capEt);
  return etWallToMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), h, min);
}

/**
 * The awaiting_siro window for the email (postDemoInterrupt's waitMaxH /
 * waitHoldH): hours from the demo to the cap, and the next hold = the 2h step
 * or the time left, whichever is smaller (at least 1h; GHL's wait is in whole
 * hours). Pure.
 */
export function emailHoldWindow({ demoAtMs, nowMs = Date.now(), capEt = F0_EMAIL_HOLD_CAP_DEFAULT, stepH = 2 } = {}) {
  const capMs = emailHoldCapMs({ demoAtMs, capEt });
  if (capMs == null) return { capMs: null, waitMaxH: 0, waitHoldH: stepH, pastCap: true };
  const leftH = (capMs - nowMs) / HOUR_MS;
  return {
    capMs,
    waitMaxH: Math.max(0, (capMs - demoAtMs) / HOUR_MS),
    waitHoldH: Math.max(1, Math.min(stepH, Math.ceil(leftH))),
    pastCap: nowMs >= capMs,
  };
}

/**
 * What position 0 does once the post-demo interrupts ran. Pure.
 *   pd      postDemoInterrupt() with the email window
 *   facts   the visit facts (null: no recording)
 * @returns {{ hold?, reason?, suppress?, tag? } | null}  null = generate
 */
export function emailGate({ pd, facts }) {
  if (pd?.suppress || pd?.hold) return pd;
  if (!facts) return { suppress: 'no_recording', terminal: true, tag: F0_NO_RECORDING_TAG };
  return null;
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Plain text with blank lines → <p> paragraphs (single newlines kept as <br>). Pure. */
export function paragraphsToHtml(text) {
  return String(text || '').replace(/\r\n?/g, '\n').split(/\n\s*\n+/)
    .map(p => p.trim()).filter(Boolean)
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
}

/**
 * The model's email, validated and shaped for the S4.5 writeback. The model
 * answers { subject, preheader, body, ps, slots }; the writeback reads
 * { subject, preheader, body_html, ps_text }. The plain body rides along for
 * the copy checks. A shape that is not that is a failed check (one re-write,
 * then suppressed_low_conf). Pure.
 */
export function f0EmailOutput(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const body = str(o.body) || str(o.text);
  const slots = o.slots && typeof o.slots === 'object' && !Array.isArray(o.slots) ? o.slots : null;
  const invalid = !body ? 'missing_body' : !str(o.subject) ? 'missing_subject' : !str(o.preheader) ? 'missing_preheader' : !slots ? 'missing_slots' : null;
  const cleanSlots = {};
  for (const k of ['hesitation', 'affirm', 'reframe', 'if_i_could']) {
    const v = slots?.[k];
    cleanSlots[k] = typeof v === 'string' && v.trim() ? v.trim() : null;
  }
  return {
    subject: str(o.subject),
    preheader: str(o.preheader),
    body_html: paragraphsToHtml(body),
    ps_text: str(o.ps),
    next_wait_hours: 0,
    email_plain_body: body,
    four_step_slots: slots ? cleanSlots : null,
    ...(invalid ? { email_invalid: invalid } : {}),
  };
}
