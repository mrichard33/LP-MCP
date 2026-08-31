/**
 * LP Job Field Mapper — src/lp-job-fields.js
 *
 * ONE question: given an LP job payload, what belongs in each `lp_jobs` column?
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/sync-children.js` is the only writer to `lp_jobs`. It stored the whole LP
 * payload in `raw_lp_data` but wrote just nine columns, so ten sat at 100% null
 * across all 5,889 rows — while every value needed was already in the database.
 * Two of those nulls were not omissions but misses: `updated_at_lp` read
 * `lastchangedon`, a key that appears on ZERO job payloads (the job-level key is
 * `lastchanged`; `lastchangedon` exists only INSIDE milestone objects).
 *
 * This module is pure so the backfill and the live sync call the SAME derivation.
 * Two implementations of this mapping — one in JS for the sync, one in SQL for the
 * backfill — is exactly how a column ends up holding confidently wrong data that
 * looks right.
 *
 * TWO PAYLOAD SHAPES
 * ------------------
 * `lp_jobs` is fed by two LP endpoints whose job objects share no timestamp:
 *   Shape A  /api/Customers/GetJobStatusChanges  ~3,580 rows
 *            only shape with stg_id, entrydate, dateentered, lastchanged, job_id
 *   Shape B  /api/Customers/GetLead → leads[].jobs[]  ~2,310 rows
 *            only shape with finco, finamount, fincrlimit, finmonths, jobcost, id
 * They are mutually exclusive and exhaustive. `milestones`, `userfields` and
 * `jobstatus` are on every row of both; `salesrepid` on ~94%.
 *
 * `raw_lp_data` is REPLACED on every upsert, so a row holds whichever shape touched
 * it last. That is why `created_at_lp` (from the Shape-A-only `entrydate`) is
 * populated on precisely the Shape A rows and nowhere else.
 *
 * TWO FIELD CLASSES — the reason this module returns a sparse object
 * -----------------------------------------------------------------
 * ALWAYS-WRITTEN fields derive from sources present in BOTH shapes, so a
 * recomputed null is real information and is emitted as null. They are
 * recalculated from scratch on every sync — never filled-once-and-left. A job
 * leaving 'Awaiting Loan Docs' must stop reporting financing_status 'pending', and
 * a fill-nulls-only mapper would freeze it there forever.
 *
 * SHAPE-SCOPED fields (`updated_at_lp`, `financing_company`) derive from keys only
 * one shape carries. They are OMITTED from the returned object when the payload in
 * hand cannot speak to them, so the other endpoint's sweep cannot blank a value it
 * simply never saw. Callers must spread the result rather than reading fixed keys.
 *
 * WHY mdt_id AND NOT datetype
 * ---------------------------
 * Milestones are keyed on `mdt_id`, LP's stable single-letter code (see MDT_TAG_MAP
 * in sync-children.js), not the `datetype` display string. `datetype` is unstable —
 * `X` alone covers both 'Inspection Ready' (5,332 rows) and 'Snap and Trim' (556).
 *
 * THE estdate TRAP
 * ----------------
 * `estdate` is populated on essentially EVERY milestone entry of every job;
 * `actdate` is not. Reading `estdate` would produce a ~100% populated
 * `install_date` in which every unscheduled job holds a forecast indistinguishable
 * from a booked date. Only `actdate` is ever read here. `actdate` is "" when unset,
 * never null and never absent — `getField` treats "" as absent, which is what keeps
 * an empty string from casting to epoch.
 */

import { getField } from './sync-utils.js';
import { lpDateToEastern } from './lp-dates.js';
import { classifyMilestoneDate } from './milestone-gate.js';

// LP milestone codes (mdt_id). Mirrors MDT_TAG_MAP in src/sync-children.js.
const MS_HOA_APPROVED   = 'H';
const MS_PERMIT_SUBMIT  = 'U';
const MS_PERMIT_ISSUED  = 'P';
const MS_ORDERED        = 'K';
const MS_RECEIVED_ALL   = 'G';
const MS_INSTALL_START  = 'S';
const MS_INSTALL_END    = 'F';
const MS_COMPLETION     = 'C';

// userfields[].fieldtitle values that evidence a permit. Compared trimmed and
// case-folded: LP ships 'Permit Expiration ' WITH A TRAILING SPACE, so an exact
// match silently returns nothing and the column stays null.
const PERMIT_FIELD_TITLES = new Set(['permit location', 'permit expiration']);

// job_status values that state a financing position. Consulted ONLY when the
// payload carries no finance evidence of its own — finance fields outrank status.
const FINANCING_STATUS_BY_JOB_STATUS = new Map([
  ['Credit Decline',              'declined'],
  ['Awaiting Credit Application', 'pending'],
  ['Awaiting Loan Docs',          'pending'],
  ['Awaiting Lender',             'pending'],
  ['RTP Await recission',         'pending'],
]);

function trimOrNull(value) {
  if (typeof value !== 'string') return value ?? null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Parse an LP timestamp string to a timestamptz-ready value, or null.
 *
 * lpDateToEastern tags LP's naive local strings as UTC, which is the convention
 * created_at_lp already stores — the new columns must match it or the two sets of
 * rows end up offset from each other. It does NOT reject a whitespace-only string
 * (it returns a bare '+00:00'), so the parse check below is load-bearing.
 */
function lpTimestamp(raw) {
  const trimmed = trimOrNull(raw);
  if (trimmed === null) return null;
  const tagged = lpDateToEastern(String(trimmed));
  if (!tagged || Number.isNaN(Date.parse(tagged))) return null;
  return tagged;
}

/**
 * Parse a milestone actdate, rejecting corruption but KEEPING future dates.
 *
 * A future act_date is real: LP is routinely used to record scheduled actuals, and
 * an install booked for next month is exactly the value install_date should hold.
 * classifyMilestoneDate separates that ('scheduled_not_yet_reached') from genuine
 * corruption — job 54908 carries a 'Received All Product' dated 2206-01-23 and job
 * 56270 an 'Inspection Passed' dated 2046-04-01. See src/milestone-gate.js.
 */
function plausibleActDate(raw, now) {
  const tagged = lpTimestamp(raw);
  if (tagged === null) return null;
  const { reason } = classifyMilestoneDate(tagged, now);
  if (reason === 'unparseable' || reason === 'corrupt_past' || reason === 'corrupt_future') {
    return null;
  }
  return tagged;
}

/** mdt_id -> plausible actdate, for milestones that have actually been stamped. */
function actualDatesByCode(job, now) {
  const milestones = getField(job, 'milestones', 'Milestones') || [];
  const byCode = new Map();
  for (const ms of milestones) {
    const code = trimOrNull(getField(ms, 'mdt_id', 'MDT_ID', 'MdtId'));
    if (code === null) continue;
    const actDate = plausibleActDate(getField(ms, 'actdate', 'ActDate', 'act_date'), now);
    if (actDate === null) continue;
    // Last occurrence wins, matching the milestone upsert in sync-children.js.
    byCode.set(code, actDate);
  }
  return byCode;
}

/** true when a permit userfield carries a value; null when nothing evidences one. */
function permitRequired(job) {
  const userfields = getField(job, 'userfields', 'UserFields', 'user_fields') || [];
  for (const uf of userfields) {
    const title = trimOrNull(getField(uf, 'fieldtitle', 'FieldTitle'));
    if (title === null) continue;
    if (!PERMIT_FIELD_TITLES.has(title.toLowerCase())) continue;
    if (trimOrNull(getField(uf, 'fieldvalue', 'FieldValue')) !== null) return true;
  }
  return null;
}

function toPositiveNumber(raw) {
  const parsed = parseFloat(trimOrNull(raw) ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The lifecycle bucket the schema declares at sql/schema.sql:68
 * (`permit | production | install | complete`), derived from which milestones have
 * actually been stamped AND ALREADY HAPPENED. NOT from stg_id: that field exists only
 * on Shape A and is "0" on 3,534 of 3,583 rows, so it carries no stage information.
 *
 * WHY THE DATE MUST HAVE PASSED
 * -----------------------------
 * LP is routinely used to record SCHEDULED actuals, so a job booked for next month
 * carries a real, future `Install End` actdate. install_completed_date must keep that
 * date — see milestone-gate.js, and it is deliberately unchanged below. But "the date
 * is real" and "the stage has been reached" are different claims. Ungated, 47 jobs
 * read a stage they had not reached (measured 2026-08-31), 46 of them job_status
 * 'Scheduled' — and one of them showed `complete` for an install still a week away.
 * job_stage is a reporting column; someone reads it without checking the dates under
 * it, and "Scheduled / complete" is simply wrong in English.
 *
 * All four tiers are gated, not just the two that had offenders. The rule "fall
 * through to the next-lowest stage the passed dates support" only reads consistently
 * if every tier answers the same question, and gating all four was measured to produce
 * IDENTICAL output to gating only complete/install across all 5,892 rows — no K, G, U,
 * P or H milestone currently carries a future actdate. Uniform is the simpler rule with
 * the same behaviour today, and it stays right if LP starts stamping scheduled actuals
 * on the earlier milestones too.
 */
function jobStage(act, now) {
  const cutoff = now.getTime();
  const passed = (code) => {
    const date = act.get(code);
    if (!date) return false;
    const t = Date.parse(date);
    return !Number.isNaN(t) && t <= cutoff;
  };
  if (passed(MS_COMPLETION) || passed(MS_INSTALL_END)) return 'complete';
  if (passed(MS_INSTALL_START)) return 'install';
  if (passed(MS_ORDERED) || passed(MS_RECEIVED_ALL)) return 'production';
  if (passed(MS_PERMIT_SUBMIT) || passed(MS_PERMIT_ISSUED) || passed(MS_HOA_APPROVED)) {
    return 'permit';
  }
  return null;
}

/**
 * Financing position. Precedence is fixed and one-way: the finance block decides
 * whenever it carries evidence, and job_status is a fallback, never an override —
 * a named finco beats a contradictory status.
 *
 * The persisted financing_company sits between the two because finco is
 * Shape-B-only: without it a Shape A sweep of a known-financed job would find no
 * finance evidence in hand and quietly downgrade the row to whatever its status
 * implied. Recomputed every sync either way, so it can never freeze at 'pending'.
 */
function financingStatus(job, jobStatus, existing) {
  const finco = trimOrNull(getField(job, 'finco', 'FinCo'));
  if (finco !== null || toPositiveNumber(getField(job, 'finamount', 'FinAmount')) !== null) {
    return 'financed';
  }
  if (trimOrNull(existing?.financing_company) !== null) return 'financed';
  return FINANCING_STATUS_BY_JOB_STATUS.get(jobStatus) ?? null;
}

/**
 * Map an LP job payload to its `lp_jobs` columns.
 *
 * Returns a SPARSE object: always-written keys are always present (null included),
 * shape-scoped keys are absent when this payload cannot speak to them. Spread it
 * into the upsert — do not read fixed keys off it.
 *
 * @param {object} job         LP job payload (either shape)
 * @param {object} [existing]  current lp_jobs row, for cross-shape continuity
 * @param {Date}   [now]       injectable clock, for tests
 */
export function mapJobFields(job, existing = {}, now = new Date()) {
  const act = actualDatesByCode(job, now);
  const jobStatus = getField(job, 'jobstatus', 'JobStatus', 'job_status');
  const repId = getField(job, 'salesrepid', 'SalesRepID');

  const fields = {
    // ─── Always written: sources present in BOTH shapes ───────────────
    rep_id:                 repId === null ? null : String(repId),
    job_stage:              jobStage(act, now),
    install_date:           act.get(MS_INSTALL_START) ?? null,
    // 'Install End', not 'Completion'. C has an actual date on 3,204 of 3,230 Paid
    // In Full jobs versus F's 2,127, but C is job completion — sign-off and final
    // payment — a later and different event. Buying coverage by redefining the
    // column is the same error as substituting estdate for actdate.
    install_completed_date: act.get(MS_INSTALL_END) ?? null,
    permit_status:          act.has(MS_PERMIT_ISSUED) ? 'issued'
                          : act.has(MS_PERMIT_SUBMIT) ? 'submitted'
                          : null,
    // One-directional evidence: an HOA Approved milestone proves HOA WAS required;
    // its absence proves nothing, so the negative case is null and never false.
    hoa_required:           act.has(MS_HOA_APPROVED) ? true : null,
    permit_required:        permitRequired(job),
    financing_status:       financingStatus(job, jobStatus, existing),
  };

  // ─── Shape-scoped: omitted when this payload cannot speak to them ───
  // Shape A only. The bug this replaces read 'lastchangedon', which is not a
  // job-level key on either shape — it appears only inside milestone objects.
  const updatedAtLp = lpTimestamp(getField(job, 'lastchanged', 'LastChanged'));
  if (updatedAtLp !== null) fields.updated_at_lp = updatedAtLp;

  // Shape B only.
  const financingCompany = trimOrNull(getField(job, 'finco', 'FinCo'));
  if (financingCompany !== null) fields.financing_company = financingCompany;

  return fields;
}

/**
 * Map a milestone object's change-tracking columns.
 *
 * The milestone mapper in sync-children.js reads 8 of the 10 keys LP sends, taking
 * enteredby/enteredon and silently dropping lastchangedby/lastchangedon — which is
 * why both columns are null across all 94,870 rows. LP populates the pair together
 * (57,671 non-empty each); the rest are milestone slots LP has never touched.
 *
 * UNLIKE mapJobFields this returns BOTH keys always, null included, for two
 * reasons. Milestones are not shape-scoped — the array is present with identical
 * content on every row of both payload shapes — so a null here is real information
 * rather than a payload that cannot speak. And the caller bulk-upserts an ARRAY of
 * milestone rows: PostgREST requires every object in a bulk insert to carry the
 * same keys, so a sparse return would fail the batch and drop the whole job's
 * milestones to the slow per-row fallback on every single sync.
 */
export function mapMilestoneChangeFields(ms, now = new Date()) {
  const by = trimOrNull(getField(ms, 'lastchangedby', 'LastChangedBy', 'last_changed_by'));
  let on = lpTimestamp(getField(ms, 'lastchangedon', 'LastChangedOn', 'last_changed_on'));
  if (on !== null) {
    // Same corruption guard as act_date, but stricter: a change timestamp in the
    // future is not a scheduling artefact the way a booked install date is, so
    // unlike actdate it is dropped rather than kept.
    const { reason } = classifyMilestoneDate(on, now);
    if (reason === 'corrupt_past' || reason === 'corrupt_future'
        || reason === 'scheduled_not_yet_reached' || reason === 'unparseable') {
      on = null;
    }
  }
  return { last_changed_by: by, last_changed_on: on };
}
