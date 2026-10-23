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
 * 2026-10-22 (Mark): the email is now written and signed as the Reece Team;
 * the call invite still names the rehash rep (F0_EMAIL_VOICE, below).
 *
 * One rule, one home: the position, the mode, the hold cap and the output
 * shape live here; the copy checks are checkF0Copy formula 'email'
 * (f0-copy-checks.js); the orchestrator and the preview only call these.
 *
 *   - The workflow sends the email as position 1 and the texts as 2-6 since
 *     2026-10-21 (GHL saves a 0 as blank); f0InternalPosition maps them back,
 *     so everything below still reads the email as 0.
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
 *     suppressed no_recording. The model never writes a generic email.
 *   - Every lead gets an email (the user, 2026-10-23). When no AI email will go
 *     out and nothing says the lead should get none (no recording, the email
 *     off or its prompt inactive, a failed generation or copy check), the
 *     contact gets the tag f0-email-fallback and the workflow sends its static
 *     Reece Team email (docs/f0-v2-static-emails.md). This replaces "a quiet
 *     exit, never a fixed email" for this one email; a failed TEXT is still
 *     skipped. emailFallbackTag is the one list; the orchestrator adds the tag.
 */
import { siroModes } from './config.js';
import { restoreQuestionMark } from '../agentic/human-voice.js';

export const F0_EMAIL_POSITION = 0;
// 2026-10-23 (the user): two more emails between the texts, written from the
// visit like the first one, with the static email as the fallback. GHL sends
// them as 7 (day 4) and 8 (day 11); inside LP-MCP they are 6 and 7, after the
// texts' 1-5. Their prompt rows carry sequence_position 6 / 7.
export const F0_FOLLOWUP_EMAIL_POSITIONS = Object.freeze({ 7: 6, 8: 7 });
export const F0_EMAIL_POSITIONS = Object.freeze([F0_EMAIL_POSITION, ...Object.values(F0_FOLLOWUP_EMAIL_POSITIONS)]);
export const F0_EMAIL_CHANNEL = 'email';
export const F0_EMAIL_FALLBACK_TAG = 'f0-email-fallback';

// The outcomes that send the static email: no AI email will go out and no
// rule says this lead should get none. Everything else (sold, a newer lead,
// rebooked, rehash ended, a team-note DQ, the two-no stop, a person texting the
// lead, a recent reply, DNC / stop-bot, rehash_owned, wrong_active_workflow,
// a hold) sends nothing, as before.
export const F0_EMAIL_FALLBACK_REASONS = new Set([
  'no_recording',
  'f0_v2_off', 'f0_email_off', 'email_prompt_inactive', 'no_prompt_match',
  'generation_error', 'retry_error', 'safety_failed_after_retry', 'writeback_error',
  'context_build_failed',
]);
export const F0_EMAIL_HOLD_CAP_DEFAULT = '08:30';
export const F0_EMAIL_SUBJECT_MAX = 60;
export const F0_EMAIL_PREHEADER_MAX = 90;
export const F0_EMAIL_BODY_WORDS = Object.freeze({ min: 120, max: 180 });

const HOUR_MS = 3_600_000;
const ET = 'America/New_York';

/** The request is one of F.0's emails (internal 0, 6 or 7). Pure. */
export function isF0EmailRequest(req) {
  return req?.workflow_code === 'F.0'
    && F0_EMAIL_POSITIONS.includes(Number(req?.sequence_position))
    && req?.channel === F0_EMAIL_CHANNEL
    && req?.sequence_position !== '' && req?.sequence_position != null;
}

/** The request is a follow-up email (day 4 or day 11), not the evening one. Pure. */
export function isF0FollowupEmail(req) {
  return isF0EmailRequest(req) && Number(req.sequence_position) !== F0_EMAIL_POSITION;
}

/** The fallback tag for an email outcome, or null when no email should go. Pure. */
export function emailFallbackTag(reason) {
  return F0_EMAIL_FALLBACK_REASONS.has(String(reason || '')) ? F0_EMAIL_FALLBACK_TAG : null;
}

/** May this caller ask for position 0? Only F.0 by email. Pure. */
export function allowsPositionZero({ workflow_code, channel } = {}) {
  return workflow_code === 'F.0' && channel === F0_EMAIL_CHANNEL;
}

/**
 * F.0's GHL numbering → LP-MCP's (the user, 2026-10-21). GHL saves a numeric
 * custom field set to 0 as BLANK: the 2026-10-21 test's "Update Pre-send
 * Fields" set AI Msg Sequence Position = 0 and the generate call got an empty
 * position, so the email was never treated as position 0 (agentic_messages
 * read channel email, sequence_position 1). The workflow now sends email = 1,
 * texts = 2..6; inside LP-MCP the email stays 0 and the texts 1..5, so the
 * prompt rows, FOUR_STEP_WAIT_HOURS, the P1-P5 copy rules and P5's terminal
 * step are unchanged. Applied ONCE, where the generate route parses an F.0
 * request. A bare 0 by email is the legacy number (logged by the caller).
 * Email 7 and 8 are the follow-up emails (2026-10-23) → 6 and 7.
 * Pure.
 * @returns {{ position: number, ghlPosition: number, legacy: boolean } | { error: 'unsupported_position' }}
 */
export function f0InternalPosition({ channel, sequence_position } = {}) {
  const raw = sequence_position;
  const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  const i = Number.isFinite(n) && Math.floor(n) === n ? n : NaN;
  if (channel === F0_EMAIL_CHANNEL && i === 1) return { position: F0_EMAIL_POSITION, ghlPosition: 1, legacy: false };
  if (channel === F0_EMAIL_CHANNEL && i === 0) return { position: F0_EMAIL_POSITION, ghlPosition: 0, legacy: true };
  if (channel === F0_EMAIL_CHANNEL && F0_FOLLOWUP_EMAIL_POSITIONS[i] != null) return { position: F0_FOLLOWUP_EMAIL_POSITIONS[i], ghlPosition: i, legacy: false };
  if (channel === 'sms' && i >= 2 && i <= 6) return { position: i - 1, ghlPosition: i, legacy: false };
  return { error: 'unsupported_position' };
}

/** The GHL number of an internal F.0 position (email 0 → 1, text n → n + 1). Pure. */
export function f0GhlPosition(internal) {
  const n = Number(internal);
  return Number.isFinite(n) ? n + 1 : null;
}

/** The payload asked for position 0 explicitly ("0" or 0). Pure. */
export function asksPositionZero(raw) {
  if (raw === null || raw === undefined || raw === '') return false;
  const n = Number(raw);
  return Number.isFinite(n) && Math.floor(n) === 0;
}

// 2026-10-22 (Mark): the email is written and signed as the Reece Team ("we",
// never "I") and invites a call with the rehash rep named by the GHL custom
// value rehash_rep_name; with no name, a call "with our team". The texts keep
// their voice. F0_EMAIL_VOICE=rep restores the 2026-10-21 email (written as
// John) and its checks.
// The signature is the GHL template's (2026-10-23); the name is kept so a
// sign-off the model writes into the body anyway is recognised and refused.
export const F0_TEAM_SIGNATURE = 'The Reece Team';
export const F0_TEAM_CALL_FALLBACK = 'our team';
export const F0_EMAIL_PROMPT_VERSION = Object.freeze({ team: 2, rep: 1 });

/** F0_EMAIL_VOICE team|rep, default team (a typo is team). */
export function f0EmailVoice(env = process.env) {
  return siroModes(env).f0EmailVoice;
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
  if (!facts) return { suppress: 'no_recording', terminal: true, tag: F0_EMAIL_FALLBACK_TAG };
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
/**
 * The closing question with its "?" back (the user, 2026-10-23). The day-11
 * preview ended "…a quick call with John to walk through it with both of you"
 * with no "?" and no period, failed question_count / no_call_question, and
 * would have gone out as the static email. Only the body's LAST sentence is
 * touched, and only when it reads as a question (restoreQuestionMark, the same
 * test the reply bots use); a closing statement stays as it is and the checks
 * still decide. Pure. Returns { text, changed }.
 */
export function closeQuestion(body) {
  const text = String(body ?? '').trim();
  if (!text || /[?!]$/.test(text)) return { text, changed: false };
  if (text.endsWith('.')) return restoreQuestionMark(text);
  const fixed = restoreQuestionMark(`${text}.`);
  return fixed.changed ? fixed : { text, changed: false };
}

export function f0EmailOutput(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const closed = closeQuestion(str(o.body) || str(o.text));
  const body = closed.text;
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
    ...(closed.changed ? { question_mark_restored: true } : {}),
    ...(invalid ? { email_invalid: invalid } : {}),
  };
}
