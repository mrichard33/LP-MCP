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
// Where the stage lives (2026-10-14, Mark: "GHL tags must be plain, reusable
// labels. Never put dates, IDs, or other unique values in a tag."):
//   GHL tag `rehash`           in the stage now (the ONLY rehash tag we write)
//   Supabase `rehash_stage`    one row per (contact, LP lead):
//     ended_at NULL            the stage is open: which lead put them there
//                              (lp_lead_id) and the demo date (demo_date, the
//                              30-day clock)
//     ended_at set             the stage ended for that lead (history; a LATER
//                              lead that demos OPPFDN can enter again)
// Until 2026-10-14 the lead, the date and the history were the tags
// rehash-lead:<lds>, rehash-since:<date> and rehash-done:<lds>: 646 contacts
// carried one-off tag values nobody else read. scripts/rehash-tag-cleanup.js
// moved them into rehash_stage and took them off.
//
// PURE. Reads arrive as data (src/jobs/rehash-tag-sweep.js does the I/O:
// the GHL tags, the LP leads and the contact's rehash_stage rows).

import { F0_ACTIVE_TAG } from './rehash.js';
import { REHASH_REP_USER_ID_DEFAULT } from '../config/rehash-assignee.js';
import { lpSold } from './post-demo-owner.js';

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

/** The rehash tags the contact carries. Pure. */
export function readRehashTags(tags) {
  const t = tagList(tags);
  return { tagged: t.includes(REHASH_TAG), f0: t.includes(F0_ACTIVE_TAG) };
}

const EMPTY_STAGE = Object.freeze({ open: null, doneLeadIds: new Set() });

/**
 * One contact's rehash_stage rows → { open, doneLeadIds }. Pure.
 *   open         the active row ({ lp_lead_id, demo_date }), newest first when
 *                there are several (there should be one), or null
 *   doneLeadIds  LP lead ids whose stage ended (a finished stage never restarts)
 */
export function stageFromRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const active = list.filter((r) => r && !r.ended_at && r.lp_lead_id != null)
    .sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')));
  const doneLeadIds = new Set(list.filter((r) => r && r.ended_at && r.lp_lead_id != null).map((r) => String(r.lp_lead_id)));
  const o = active[0];
  return {
    open: o ? { lp_lead_id: String(o.lp_lead_id), demo_date: o.demo_date ? String(o.demo_date).slice(0, 10) : null } : null,
    doneLeadIds,
  };
}

function normStage(stage) {
  if (!stage) return EMPTY_STAGE;
  return {
    open: stage.open && stage.open.lp_lead_id != null ? { ...stage.open, lp_lead_id: String(stage.open.lp_lead_id) } : null,
    doneLeadIds: stage.doneLeadIds instanceof Set ? new Set([...stage.doneLeadIds].map(String)) : new Set(),
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
 *   stage        optional { open, doneLeadIds } (stageFromRows); a lead whose
 *                stage already ended is not in rehash again
 */
export function isInRehash({ tags = [], currentLead = null, stage = null, nowMs = Date.now(), env = process.env } = {}) {
  // 2026-10-14 (John Manieri: "Koger is already sold and set"): a SOLD current
  // lead is a customer, not a rehash lead, even while F.0's `active-f.0` tag
  // (GHL's to remove) or our `rehash` tag (the sweep's) is still on. Checked
  // before the tags, so a sold customer gets no rehash reply and no rehash card.
  if (lpSold(currentLead)) return false;
  const t = readRehashTags(tags);
  if (t.f0 || t.tagged) return true;
  if (!currentLead) return false;
  if (normStage(stage).doneLeadIds.has(String(currentLead.lp_lead_id))) return false;
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
 * The reply context's LP lead (context-builder's `context.lp`) in the shape
 * isInRehash reads, or null when no LP lead matched. Pure.
 *
 * 2026-10-09 (Monica, LP lead 581695): the reply writer knew a contact was in
 * rehash only by the `rehash` / `active-f.0` tag, and the sweep that adds
 * `rehash` is still in shadow. Her OPPFDN lead was plainly in the window, yet
 * "I never got a call" got "We're having someone call you back right now."
 * while the rehash rep was out until Monday: John's Rehash Call calendar was
 * never read. The 30-day clock runs from the demo, so demo_date wins over a
 * later appointment date (the watchdog had re-set hers to the call time).
 */
export function rehashLeadFromContext(lp) {
  if (!lp || lp.matched === false || lp.lead_id == null) return null;
  return {
    lp_lead_id: lp.lead_id,
    disposition_code: lp.disposition ?? null,
    closed_won: lp.closed_won === true,
    appointment_date: lp.demo_date || lp.appointment_date || lp.last_appointment_date || null,
  };
}

/**
 * What the sweep should do for one contact. Pure.
 * @param {object} a
 * @param {string[]} a.tags          live GHL tags
 * @param {object|null} a.currentLead  pickCurrentLead() row, null = no lead
 * @param {string|null} a.owner      GHL assignedTo
 * @param {Set<string>} a.rehashTeam GHL user ids of the rehash team
 * @param {{open: {lp_lead_id: string, demo_date: string|null}|null, doneLeadIds: Set<string>}} a.stage
 *        the contact's rehash_stage rows (stageFromRows)
 * @returns {{ action: 'tag'|'release'|'none', reason: string, add?: string[], remove?: string[],
 *             unassign?: boolean, stageStart?: {lp_lead_id: string, demo_date: string},
 *             stageEnd?: {lp_lead_id: string, reason: string} }}
 *   tag      add `rehash`; stageStart = the rehash_stage row to open (absent
 *            on a self-heal: the row is already open, only the tag was missing)
 *   release  remove `rehash` (when it is on); stageEnd = the row to close
 */
export function decideRehash({ tags = [], currentLead = null, owner = null, rehashTeam = new Set(), stage = null, nowMs = Date.now(), env = process.env } = {}) {
  const t = readRehashTags(tags);
  const { open, doneLeadIds } = normStage(stage);
  const disp = String(currentLead?.disposition_code ?? '').trim();
  const lds = currentLead?.lp_lead_id != null ? String(currentLead.lp_lead_id) : null;
  const d = demoDate(currentLead);
  const ageDays = d ? (nowMs - Date.parse(`${d}T12:00:00Z`)) / DAY_MS : null;
  const limit = rehashDays(env);

  const release = (reason) => ({
    action: 'release',
    reason,
    remove: t.tagged ? [REHASH_TAG] : [],
    add: [],
    unassign: Boolean(owner && rehashTeam.has(String(owner))),
    stageEnd: { lp_lead_id: open?.lp_lead_id || lds || 'unknown', reason },
  });

  if (open) {
    // A newer lead for the same person ends rehash (the user, 2026-10-09).
    if (lds && lds !== open.lp_lead_id) return release('newer_lead');
    // Our system already took the lead out: a sale, NoRehash, a re-set visit.
    if (disp && disp !== REHASH_DISPOSITION) return release(`disposition_${disp}`);
    const since = open.demo_date ? (nowMs - Date.parse(`${open.demo_date}T12:00:00Z`)) / DAY_MS : ageDays;
    if (since != null && since >= limit) return release('30_days');
    // The stage is open but GHL lost the tag (a person, a workflow): put it back.
    if (!t.tagged) return { action: 'tag', reason: 'self_heal', add: [REHASH_TAG], remove: [] };
    return { action: 'none', reason: 'in_rehash' };
  }

  if (t.tagged) {
    // The tag with no open row: put on by a person or a workflow, or before
    // rehash_stage existed. The lead decides, as it would for a new entry.
    if (disp && disp !== REHASH_DISPOSITION) return release(`disposition_${disp}`);
    if (ageDays != null && ageDays >= limit) return release('30_days');
    if (disp !== REHASH_DISPOSITION || !lds || ageDays == null) return { action: 'none', reason: 'in_rehash' };
    if (doneLeadIds.has(lds)) return release('already_completed');
    return { action: 'tag', reason: 'adopt_tagged', add: [], remove: [], stageStart: { lp_lead_id: lds, demo_date: d } };
  }

  if (disp !== REHASH_DISPOSITION || !lds) return { action: 'none', reason: 'not_oppfdn' };
  if (ageDays == null) return { action: 'none', reason: 'no_demo_date' };
  if (ageDays >= limit) return { action: 'none', reason: 'demo_older_than_window' };
  // A finished stage never restarts for the same lead.
  if (doneLeadIds.has(lds)) return { action: 'none', reason: 'already_completed' };
  return {
    action: 'tag',
    reason: 'oppfdn_demo',
    add: [REHASH_TAG],
    remove: [],
    stageStart: { lp_lead_id: lds, demo_date: d },
  };
}
