// ─── Rehash stage — src/agentic/rehash-state.js ──────────────────────────────
//
// WHY (the user, 2026-10-09)
//   Monica (LP lead 581695, OPPFDN after her 10/7 demo) texted the bot on 10/8
//   and was treated as a new sales lead: a Five9 sales callback, a moved
//   appointment, an LP re-set. Her demo was outside F.0's 14-day entry window
//   (rule 393), so nothing knew she was post-demo. The user's rulings:
//     - a lead whose demo ended OPPFDN is in REHASH, marked by a tag;
//     - rehash leads are handled by the rehash team (John Manieri and others),
//       by phone, never by a new LP appointment and never by Five9's sales
//       callback list;
//     - "if a prospect has an OPPFDN status, there may be another lead that
//       comes in later": a NEWER LP lead ends rehash for that person;
//     - rehash ends 30 days after the demo, or sooner when our system already
//       took the lead out (F.0 exit, a sale, NoRehash): the rehash rep stops
//       owning the contact and the tag comes off.
//
// The tags (one place, so every reader agrees):
//   rehash                     in the stage now
//   rehash-lead:<lds_id>       which LP lead put them there
//   rehash-since:<YYYY-MM-DD>  the demo date (the 30-day clock)
//   rehash-done:<lds_id>       the stage ended for that lead (kept as history;
//                              a LATER lead that demos OPPFDN can enter again)
//
// PURE. Reads arrive as data (src/jobs/rehash-tag-sweep.js does the I/O).

import { F0_ACTIVE_TAG } from './rehash.js';
import { REHASH_REP_USER_ID_DEFAULT } from '../config/rehash-assignee.js';

/**
 * GHL user ids of the rehash team (REHASH_TEAM_USER_IDS, comma-separated).
 * Default: John Manieri, the Rehash rep (src/config/rehash-assignee.js).
 */
export function rehashTeamUserIds(env = process.env) {
  const ids = String(env.REHASH_TEAM_USER_IDS || REHASH_REP_USER_ID_DEFAULT)
    .split(',').map((s) => s.trim()).filter(Boolean);
  return new Set(ids);
}

export const REHASH_TAG = 'rehash';
export const REHASH_DONE_PREFIX = 'rehash-done:';
export const REHASH_LEAD_PREFIX = 'rehash-lead:';
export const REHASH_SINCE_PREFIX = 'rehash-since:';
export const REHASH_DISPOSITION = 'OPPFDN';
export const REHASH_DAYS_DEFAULT = 30;
const DAY_MS = 86_400_000;

const lower = (t) => String(t ?? '').trim().toLowerCase();
const tagList = (tags) => (Array.isArray(tags) ? tags.map(lower) : []);

export const MODES = Object.freeze(['off', 'shadow', 'live']);
/** REHASH_ROUTING_MODE off|shadow|live, default shadow; a typo is shadow. */
export function rehashRoutingMode(env = process.env) {
  const raw = String(env.REHASH_ROUTING_MODE ?? '').trim().toLowerCase();
  return MODES.includes(raw) ? raw : 'shadow';
}

export function rehashDays(env = process.env) {
  const n = Number(env.REHASH_DAYS);
  return Number.isFinite(n) && n > 0 ? n : REHASH_DAYS_DEFAULT;
}

/** The tag values the contact carries. Pure. */
export function readRehashTags(tags) {
  const t = tagList(tags);
  const lead = t.find((x) => x.startsWith(REHASH_LEAD_PREFIX));
  const since = t.find((x) => x.startsWith(REHASH_SINCE_PREFIX));
  return {
    tagged: t.includes(REHASH_TAG),
    f0: t.includes(F0_ACTIVE_TAG),
    done: new Set(t.filter((x) => x.startsWith(REHASH_DONE_PREFIX)).map((x) => x.slice(REHASH_DONE_PREFIX.length))),
    ldsId: lead ? lead.slice(REHASH_LEAD_PREFIX.length) : null,
    since: since ? since.slice(REHASH_SINCE_PREFIX.length) : null,
    all: t.filter((x) => x === REHASH_TAG || x.startsWith(REHASH_LEAD_PREFIX) || x.startsWith(REHASH_SINCE_PREFIX)),
  };
}

/** 'YYYY-MM-DD' of the demo (the lead's appointment date; LP wall clock). Pure. */
export function demoDate(lead) {
  const raw = String(lead?.appointment_date ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
}

/**
 * Is this contact in rehash right now? Pure; the readers that must decide
 * fast (the callback gate, the reply writer) call this with what they hold.
 *   tags         the GHL contact's tags
 *   currentLead  pickCurrentLead() row (src/current-lead.js) or null
 */
export function isInRehash({ tags = [], currentLead = null, nowMs = Date.now(), env = process.env } = {}) {
  const t = readRehashTags(tags);
  if (t.f0 || t.tagged) return true;
  if (!currentLead) return false;
  if (t.done.has(String(currentLead.lp_lead_id))) return false;
  if (String(currentLead.disposition_code ?? '').trim() !== REHASH_DISPOSITION) return false;
  const d = demoDate(currentLead);
  if (!d) return false;
  return nowMs - Date.parse(`${d}T12:00:00Z`) < rehashDays(env) * DAY_MS;
}

/**
 * The GHL stage tag F.0 puts on a contact after the appointment. Pure.
 * The user, 2026-10-09: a post-demo lead never lands on the Confirmation Call
 * calendar, whether it carries the rehash tag or only this stage tag. It is
 * read ONLY for that block: GHL workflows own the tag (F.0 adds it; S1.1, S1.3,
 * S4.5 and A.WE take it off), so we never write it and it never puts a contact
 * in rehash, refuses a visit or touches Five9.
 */
export const POST_APPOINTMENT_STAGE_TAG = 'stage:post-appointment';
export function hasPostAppointmentStage(tags) {
  return tagList(tags).includes(POST_APPOINTMENT_STAGE_TAG);
}

/**
 * What the sweep should do for one contact. Pure.
 * @param {object} a
 * @param {string[]} a.tags          live GHL tags
 * @param {object|null} a.currentLead  pickCurrentLead() row, null = no lead
 * @param {string|null} a.owner      GHL assignedTo
 * @param {Set<string>} a.rehashTeam GHL user ids of the rehash team
 * @returns {{ action: 'tag'|'release'|'none', reason: string, add?: string[], remove?: string[], unassign?: boolean }}
 */
export function decideRehash({ tags = [], currentLead = null, owner = null, rehashTeam = new Set(), nowMs = Date.now(), env = process.env } = {}) {
  const t = readRehashTags(tags);
  const disp = String(currentLead?.disposition_code ?? '').trim();
  const lds = currentLead?.lp_lead_id != null ? String(currentLead.lp_lead_id) : null;
  const d = demoDate(currentLead);
  const ageDays = d ? (nowMs - Date.parse(`${d}T12:00:00Z`)) / DAY_MS : null;
  const limit = rehashDays(env);

  const release = (reason) => ({
    action: 'release',
    reason,
    remove: t.all,
    add: [`${REHASH_DONE_PREFIX}${t.ldsId || lds || 'unknown'}`],
    unassign: Boolean(owner && rehashTeam.has(String(owner))),
  });

  if (t.tagged) {
    // A newer lead for the same person ends rehash (the user, 2026-10-09).
    if (lds && t.ldsId && lds !== t.ldsId) return release('newer_lead');
    // Our system already took the lead out: a sale, NoRehash, a re-set visit.
    if (disp && disp !== REHASH_DISPOSITION) return release(`disposition_${disp}`);
    const since = t.since ? (nowMs - Date.parse(`${t.since}T12:00:00Z`)) / DAY_MS : ageDays;
    if (since != null && since >= limit) return release('30_days');
    return { action: 'none', reason: 'in_rehash' };
  }

  if (disp !== REHASH_DISPOSITION || !lds) return { action: 'none', reason: 'not_oppfdn' };
  if (ageDays == null) return { action: 'none', reason: 'no_demo_date' };
  if (ageDays >= limit) return { action: 'none', reason: 'demo_older_than_window' };
  // A finished stage never restarts for the same lead.
  if (t.done.has(lds)) return { action: 'none', reason: 'already_completed' };
  return {
    action: 'tag',
    reason: 'oppfdn_demo',
    add: [REHASH_TAG, `${REHASH_LEAD_PREFIX}${lds}`, `${REHASH_SINCE_PREFIX}${d}`],
    remove: [],
  };
}
