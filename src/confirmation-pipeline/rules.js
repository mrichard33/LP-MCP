/**
 * Confirmation Pipeline rules — src/confirmation-pipeline/rules.js
 *
 * 2026-10-16 handoff "4. Confirmation Pipeline". Pure: no I/O, no clock read
 * (callers pass `now`), so every rule below is unit-tested without GHL or
 * Supabase (scripts/test-confirmation-pipeline.js). The handler
 * (src/actions/handlers/confirmation-pipeline-sync.js), the 15-minute clock
 * and the 00:05 ET sweep all decide through this one module.
 *
 * Every LP appointment gets ONE card in GHL "4. Confirmation Pipeline"
 * (ThrBNpyzJhAON4WFC855). The stage order, evaluated top to bottom:
 *   1. the appointment passed more than CONF_CLOSE_AFTER_HOURS ago, or its
 *      date is before today (ET)      → close (status by the stage it is in)
 *   2. CXL                            → close abandoned
 *   3. ND                             → disqualified
 *   4. Cnf                            → confirmed
 *   5. Verif                          → issue (wins over the 24h rule)
 *   6. Set, under CONF_CONFIRM_NOW_HOURS away → confirm_now
 *   7. Set                            → new
 * `Issue` is NOT mapped: in Reece's process it means the lead was issued to a
 * rep, not that something is wrong with it. An unmapped disposition holds the
 * card where it is until the appointment passes.
 *
 * Locked stages (confirmed, disqualified): automation never moves a card out,
 * except ND (Confirmed → Disqualified), a Set at a DIFFERENT appointment time
 * (a reschedule re-opens the card and re-evaluates from rule 6/7), and the
 * close, which always applies.
 *
 * A person moving a card is detected by the live stage differing from the one
 * we stored. A hand move into a locked stage stays; any other hand move gives
 * way only to an LP change NEWER than the hand move, never to the clock.
 */

import { lpWallClockToGhlStartTime } from '../appointment-dates.js';

// The IDs were checked against list_pipelines(forceLive) on 2026-10-16. The
// stages were renamed, so they do not follow the old stage names. Env wins so a
// stage can be re-pointed without a deploy of new code.
export const DEFAULT_PIPELINE_ID = 'ThrBNpyzJhAON4WFC855';
export const DEFAULT_STAGE_IDS = Object.freeze({
  new: '0687ed5d-3c20-43b2-9de3-d33e2365e129',
  issue: '349e0543-b0c8-4ba8-a366-652b9bd0ce2b',
  confirm_now: '797d6afe-61d7-4830-b08c-6de5e33daf78',
  confirmed: '206d80b9-0071-4133-bff2-f5048f6ab783',
  disqualified: 'cf3ea676-5cef-4ad8-8a11-a544e506abe2',
});

export const STAGE_KEYS = Object.freeze(['new', 'issue', 'confirm_now', 'confirmed', 'disqualified']);
export const LOCKED_STAGES = Object.freeze(new Set(['confirmed', 'disqualified']));
export const MAPPED_DISPOSITIONS = Object.freeze(new Set(['Set', 'Verif', 'Cnf', 'ND', 'CXL']));

const CANVASS_SOURCES = new Set(['canvass', 'canvass sticky']);

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * The pipeline's configuration. CONF_PIPE_DRY_RUN is TRUE unless it says
 * exactly "false": a missing variable must never turn on GHL writes.
 */
export function readConfig(env = process.env) {
  return {
    pipelineId: String(env.CONF_PIPELINE_ID || DEFAULT_PIPELINE_ID).trim(),
    stages: {
      new: String(env.CONF_STAGE_NEW || DEFAULT_STAGE_IDS.new).trim(),
      issue: String(env.CONF_STAGE_ISSUE || DEFAULT_STAGE_IDS.issue).trim(),
      confirm_now: String(env.CONF_STAGE_CONFIRM_NOW || DEFAULT_STAGE_IDS.confirm_now).trim(),
      confirmed: String(env.CONF_STAGE_CONFIRMED || DEFAULT_STAGE_IDS.confirmed).trim(),
      disqualified: String(env.CONF_STAGE_DISQUALIFIED || DEFAULT_STAGE_IDS.disqualified).trim(),
    },
    confirmNowHours: num(env.CONF_CONFIRM_NOW_HOURS, 24),
    alertHours: num(env.CONF_ALERT_HOURS, 4),
    closeAfterHours: num(env.CONF_CLOSE_AFTER_HOURS, 2),
    tz: String(env.CONF_TZ || 'America/New_York').trim(),
    slackChannel: String(env.CONF_SLACK_CHANNEL || '').trim(),
    dryRun: String(env.CONF_PIPE_DRY_RUN ?? 'true').trim().toLowerCase() !== 'false',
  };
}

export function stageKeyForId(cfg, stageId) {
  if (!stageId) return null;
  for (const k of STAGE_KEYS) if (cfg.stages[k] === stageId) return k;
  return null;
}

/** YYYY-MM-DD of `now` in the given zone. */
export function ymdInZone(now, tz = 'America/New_York') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/**
 * An lp_leads.appointment_date read as LP means it. LP stores the ET wall clock
 * labelled UTC (src/ghl-field-map.js), so the digits ARE the Eastern time.
 * Exact midnight is LP's "date known, time not set": `hasTime` is false, the
 * close then goes by the date alone, no 4h alert fires, and the 24h rule uses
 * noon of that day as a nominal time.
 *
 * Returns null for a missing or unreadable value.
 */
export function readAppointment(appointmentDate) {
  if (!appointmentDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(appointmentDate));
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00'] = m;
  const ymd = `${y}-${mo}-${d}`;
  const hasTime = !(h === '00' && mi === '00');
  const iso = lpWallClockToGhlStartTime(`${ymd}T${hasTime ? `${h}:${mi}` : '12:00'}:00`);
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  return { ymd, hasTime, at, hour: Number(h), minute: Number(mi), month: Number(mo), day: Number(d), year: Number(y) };
}

/** "M/D/YYYY h:mm AM" — the same text the GHL Current Appointment Date/Time fields hold. */
export function formatAppointment(appt) {
  if (!appt) return '';
  const date = `${appt.month}/${appt.day}/${appt.year}`;
  if (!appt.hasTime) return date;
  const ampm = appt.hour >= 12 ? 'PM' : 'AM';
  const h12 = appt.hour % 12 || 12;
  return `${date} ${h12}:${String(appt.minute).padStart(2, '0')} ${ampm}`;
}

/** "{Contact Name} — {Current Appointment Date} {Current Appointment Time}". */
export function cardName(contactName, appt) {
  const who = String(contactName || '').trim() || 'Unknown';
  const when = formatAppointment(appt);
  return when ? `${who} — ${when}` : who;
}

/**
 * Canvass leads belong to "5. Canvass Confirmation Pipeline", which is
 * GHL-native: never touched here. The repo reads canvass several ways
 * (CLAUDE.md, s52-entry-gate.js, lp-link-match.js, payroll/rules.js); any one
 * of them is enough to keep a canvass lead off this board.
 */
export function isCanvassLead(lead, contactTags = []) {
  if (CANVASS_SOURCES.has(String(lead?.lead_source || '').trim().toLowerCase())) return true;
  if (String(lead?.ghl_entry_tag || '').trim().toLowerCase() === 'entry:canvassing') return true;
  if (String(lead?.ghl_intent_bucket || '').trim().toLowerCase() === 'canvassing') return true;
  const tags = (contactTags || []).map((t) => String(t).toLowerCase());
  return tags.includes('active-entry:canvassing');
}

/** The close status for the stage a card is in when it closes. */
export function closeStatusFor(stageKey) {
  if (stageKey === 'confirmed') return 'won';
  if (stageKey === 'disqualified') return 'lost';
  return 'abandoned';
}

/** True when the appointment is past rule 1's line. */
export function appointmentPassed(appt, now, cfg) {
  if (!appt) return false;
  if (appt.ymd < ymdInZone(now, cfg.tz)) return true;
  if (!appt.hasTime) return false;
  return now.getTime() > appt.at.getTime() + cfg.closeAfterHours * 3600_000;
}

/**
 * The stage-logic order. Returns one of
 *   { kind: 'close', status: null | 'abandoned', reason }   status null = by stage
 *   { kind: 'stage', stage, reason }
 *   { kind: 'hold',  reason }    unmapped disposition: leave the card where it is
 *   { kind: 'skip',  reason }    reserved (no caller returns it today)
 */
export function targetFor({ disposition, appt, now, cfg }) {
  const code = String(disposition || '').trim();
  // No appointment on the lead any more (LP cleared it): an open card closes
  // abandoned (the user, 2026-10-16: only cards for appointments still
  // scheduled). decideMove never CREATES from a close, so this never makes one.
  if (!appt) return { kind: 'close', status: 'abandoned', reason: code === 'CXL' ? 'cxl' : 'no_appointment' };
  if (appointmentPassed(appt, now, cfg)) return { kind: 'close', status: code === 'CXL' ? 'abandoned' : null, reason: 'appointment_passed' };
  if (code === 'CXL') return { kind: 'close', status: 'abandoned', reason: 'cxl' };
  if (code === 'ND') return { kind: 'stage', stage: 'disqualified', reason: 'nd' };
  if (code === 'Cnf') return { kind: 'stage', stage: 'confirmed', reason: 'cnf' };
  if (code === 'Verif') return { kind: 'stage', stage: 'issue', reason: 'verif' };
  if (code === 'Set') {
    const hoursAway = (appt.at.getTime() - now.getTime()) / 3600_000;
    if (hoursAway < cfg.confirmNowHours) return { kind: 'stage', stage: 'confirm_now', reason: 'set_under_24h' };
    return { kind: 'stage', stage: 'new', reason: 'set' };
  }
  return { kind: 'hold', reason: `unmapped_disposition:${code || 'none'}` };
}

function ms(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * What to do with one card. Pure.
 *
 * @param {object}  a
 * @param {object|null} a.row          stored confirmation_opportunities row (a dry-run row counts as none)
 * @param {object|null} a.live         { stageKey, status, lastStageChangeAt } of the live GHL card, or null
 * @param {object}  a.target           targetFor()
 * @param {string}  a.disposition      the lead's current LP disposition
 * @param {Date|null} a.apptAt         this lead's appointment instant
 * @param {string|null} a.lpChangedAt  when LP's disposition changed (event time), for the manual-move race
 * @param {boolean} a.timeBased        true from the clock: never overrides a hand move
 * @param {boolean} a.rebind           the row belongs to an older lead of this contact (repeat homeowner)
 * @param {Date}    a.now
 * @returns {{ op: 'create'|'move'|'close'|'reopen'|'noop'|'skip'|'blocked',
 *             toStage?: string, status?: string, reason: string,
 *             manualDetected: boolean, manualAt: number|null, reschedule: boolean }}
 */
export function decideMove({ row, live, target, disposition, apptAt, lpChangedAt, timeBased = false, rebind = false, now }) {
  const storedStage = row?.stage_key || null;
  const currentStage = live?.stageKey || storedStage;
  const liveOpen = live ? String(live.status || 'open') === 'open' : (row ? !row.closed_status : false);

  const manualDetected = !!(live && row && live.stageKey && storedStage && live.stageKey !== storedStage);
  const manualAt = manualDetected
    ? (ms(live.lastStageChangeAt) ?? now.getTime())
    : (row?.last_moved_by === 'manual' ? (ms(row.last_manual_move_at) ?? ms(row.updated_at)) : null);

  const storedAt = ms(row?.appointment_at);
  const newAt = apptAt ? apptAt.getTime() : null;
  // A repeat homeowner's new lead is a new appointment on the same card, so it
  // re-evaluates like a reschedule.
  const reschedule = !!(row && newAt != null && (rebind || (storedAt != null && storedAt !== newAt)));
  const base = { manualDetected, manualAt, reschedule };

  if (target.kind === 'skip') return { ...base, op: 'skip', reason: target.reason };

  if (target.kind === 'close') {
    if (!live && !row) return { ...base, op: 'skip', reason: 'past_or_cancelled_no_card' };
    if (!liveOpen) return { ...base, op: 'noop', reason: 'already_closed' };
    const status = target.status || closeStatusFor(currentStage);
    return { ...base, op: 'close', status, reason: target.reason };
  }

  if (target.kind === 'hold') {
    if (!live && !row) return { ...base, op: 'skip', reason: target.reason };
    return { ...base, op: 'noop', reason: target.reason };
  }

  const to = target.stage;
  if (!live && !row) return { ...base, op: 'create', toStage: to, reason: target.reason };
  if (!live && row && !row.ghl_opportunity_id) return { ...base, op: 'create', toStage: to, reason: target.reason };

  if (!liveOpen) {
    // A closed card opens again for a reschedule, a repeat homeowner's new lead,
    // or an LP change NEWER than the close (a CXL that LP re-Set). Never from
    // the clock, and never for an old change: a card a person closed stays closed.
    if (reschedule) return { ...base, op: 'reopen', toStage: to, reason: 'reschedule' };
    const lpAt = ms(lpChangedAt);
    const closedAt = ms(live?.lastStatusChangeAt) ?? ms(row?.closed_at);
    if (!timeBased && lpAt != null && (closedAt == null || lpAt > closedAt)) {
      return { ...base, op: 'reopen', toStage: to, reason: target.reason };
    }
    return { ...base, op: 'noop', reason: 'closed' };
  }

  // A reschedule (a Set at a new time) re-evaluates from rule 6/7 whatever the
  // lock or the hand move says.
  const rescheduleUnlock = reschedule && disposition === 'Set';
  if (currentStage === to) return { ...base, op: 'noop', reason: 'already_in_stage' };
  if (rescheduleUnlock) return { ...base, op: 'move', toStage: to, reason: 'reschedule' };

  const handMoved = manualAt != null;
  if (handMoved && timeBased) return { ...base, op: 'blocked', toStage: to, reason: 'manual_move_respected' };

  if (LOCKED_STAGES.has(currentStage)) {
    const ndException = to === 'disqualified' && disposition === 'ND';
    if (!ndException) return { ...base, op: 'blocked', toStage: to, reason: 'locked_stage' };
  }

  if (handMoved) {
    const lpAt = ms(lpChangedAt);
    if (lpAt == null || lpAt <= manualAt) return { ...base, op: 'blocked', toStage: to, reason: 'manual_move_newer_than_lp' };
  }
  return { ...base, op: 'move', toStage: to, reason: target.reason };
}

/** True when the 4h alert is due for an open card. */
export function alertDue({ row, appt, now, cfg }) {
  if (!row || row.closed_status || row.alerted_at) return false;
  if (LOCKED_STAGES.has(row.stage_key)) return false;
  if (!appt || !appt.hasTime) return false;
  const hoursAway = (appt.at.getTime() - now.getTime()) / 3600_000;
  return hoursAway > 0 && hoursAway < cfg.alertHours;
}

/**
 * The appointment date of a card the sweep found in GHL, best source first:
 * our row, the contact's Current Appointment Date field ("M/D/YYYY"), then the
 * "— M/D/YYYY" in the card name. Returns YYYY-MM-DD or null.
 */
export function parseMdY(text) {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(text || ''));
  if (!m) return null;
  const mo = Number(m[1]); const d = Number(m[2]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function sweepAppointmentYmd({ row, currentApptField, cardTitle, tz = 'America/New_York' }) {
  if (row?.appointment_at) {
    const t = new Date(row.appointment_at);
    if (!Number.isNaN(t.getTime())) return { ymd: ymdInZone(t, tz), source: 'stored' };
  }
  const f = parseMdY(currentApptField);
  if (f) return { ymd: f, source: 'current_appointment_field' };
  const n = parseMdY(cardTitle);
  if (n) return { ymd: n, source: 'card_name' };
  return { ymd: null, source: null };
}

/**
 * The clock's cheap pre-check, from Supabase alone: does this open card need
 * the handler (and its GHL reads) this pass? Without it a hand-moved or locked
 * card would cost a GHL read every 15 minutes forever, for a move the rules
 * would refuse anyway.
 */
export function clockNeedsWork({ row, lead, target, appt, cfg }) {
  if (!row || !lead) return false;
  if (row.dry_run && !cfg.dryRun) return true;                 // first live pass over a dry-run row
  if (String(lead.lp_lead_id) !== String(row.lp_lead_id)) return true; // repeat homeowner's new lead
  const storedAt = ms(row.appointment_at);
  if (appt && storedAt != null && storedAt !== appt.at.getTime()) return true; // reschedule
  if (target.kind === 'close') return true;
  if (target.kind !== 'stage') return false;
  if (target.stage === row.stage_key) return false;
  if (String(lead.disposition_code || '') !== String(row.last_lp_disposition || '')) return true; // an LP change the event missed
  if (row.last_moved_by === 'manual') return false;            // time never overrides a hand move
  if (LOCKED_STAGES.has(row.stage_key)) return false;
  return true;
}
