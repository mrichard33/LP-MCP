// ─── Inbound Caller Capture — src/jobs/inbound-caller-capture.js ────────────
//
// WHAT
//   New callers who talked 2+ minutes with an agent but never became an LP lead
//   (v_new_callers_no_lp_30d, sql/127 — read-only here, never modified) are
//   looked up in GHL, labelled (src/inbound-caller-classify.js), stored one row
//   per call in inbound_capture_daily (sql/133) and — only when the mode allows
//   — turned into an LP lead through the ONE creation path: workflow 8e30ff37,
//   via enrollLpLeadCreation() in src/admin/lp-force-addlead.js (the code behind
//   force_lp_lead_creation). There is no second enroll path in this file.
//
// WHY (2026-09-27)
//   In the 30 days to 2026-09-26, 234 new callers talked 2+ minutes with an
//   agent and never became an LP lead — 159 through LightFire, 6 with an
//   appointment set. That is lost revenue, and it is a payroll attribution gap:
//   partner work with no LP lead can be neither paid nor disputed. sql/127
//   found them; nothing acted on them. Every row carries campaign, team,
//   agent_name, call_at and disposition so the payroll engine can attribute
//   the LightFire work later.
//
// MODES — INBOUND_CAPTURE_MODE, default `shadow`
//   off       the schedulers do nothing (the dry-run endpoint still works).
//   shadow    store rows + the daily Slack summary. Creates NOTHING.
//   approval  one agent_actions row per caller, requires_approval=true, action
//             type capture_inbound_caller. Approving runs captureCaller().
//   live      captureCaller() directly.
//   Anything unrecognised is `shadow`, never `live` (lead-leak precedent): a
//   typo must not start creating leads. Leaving shadow is Mark's decision after
//   5+ days of shadow output, and needs sql/133 applied first.
//
// NEVER, IN ANY MODE
//   Touches a DNC caller, sends a message, or books an appointment. The only
//   GHL writes are a new contact (no_ghl_contact) and the 8e30ff37 enrollment.
//
// IDEMPOTENCY
//   inbound_capture_daily is UNIQUE (caller_phone, call_at). A row is CLAIMED
//   with a conditional update (action_taken → in_progress, only if it is not
//   already actioned) before anything is created, so a failed write means no
//   action rather than a double one. A caller already actioned on ANY call is
//   never actioned again, and enrollLpLeadCreation keeps its own
//   create-lead:<contact> marker underneath.
//
// THREE-WAY, NOT A BOOLEAN
//   A failed read of the view, the Five9 DNC list or lp_leads makes the pass
//   `insufficient_evidence`: nothing stored, nothing actioned, nothing posted,
//   runJob files it `unknown`. A failed GHL read labels that one caller
//   `unverified` — never no_ghl_contact, which would create a duplicate contact.
//   A missing inbound_capture_daily table (sql/133 not applied) logs and skips:
//   without it there is no idempotency record, so nothing may be created.
//
// SCHEDULE
//   hourly 08:00–20:00 ET  the action pass, calls from the last
//                          INBOUND_CAPTURE_LOOKBACK_HOURS (48).
//   daily 07:15 ET         the summary: the whole 30-day view, labelled, posted
//                          to the ops channel. After lead-leak's 07:00. Never acts.
//   Both run under one job id (runJob occurrence keys keep them apart).
//
// ENDPOINT
//   GET|POST /api/lp/inbound-capture → the classified list. Never creates, never
//   posts, never stores. Default window: INBOUND_CAPTURE_LOOKBACK_HOURS (48), the
//   same calls the hourly pass sees. ?hours=N picks another window; ?hours=all
//   reads the whole 30-day view.
//
//   2026-09-27 — the default USED to be the whole view. Measured on the first
//   live pass, GHL costs several seconds per caller, so ~232 callers is ~25
//   minutes: past any HTTP timeout, and the whole time it holds the one-pass
//   lock, so the hourly action pass skips its slot. Ask for `all` on purpose.

import { runSQL as defaultRunSQL } from '../admin/supabase-admin.js';
import defaultSupabase from '../supabase.js';
import { checkDncForNumbers as defaultCheckDnc } from '../five9-admin.js';
import { postToSlack as defaultPostToSlack, opsChannelId } from '../slack.js';
import { ghlFetch as defaultGhlFetch } from '../actions/helpers.js';
import { searchByPhone, resolveOrCreateContact, DEFAULT_DEPS as GHL_RESOLVE_DEPS } from '../services/ghl-contact-resolve.js';
import { enrollLpLeadCreation as defaultEnroll } from '../admin/lp-force-addlead.js';
import { runJob } from '../job-runner.js';
import { hourET, todayET } from './lp-report-common.js';
import {
  classifyCaller, isCandidate, normalizeCallerPhone, summarizeCallers, formatDailySummary, isAppointmentSet,
} from '../inbound-caller-classify.js';

export const JOB_ID = 'inbound-caller-capture';
export const TABLE = 'inbound_capture_daily';
export const VIEW = 'v_new_callers_no_lp_30d';
export const ACTION_TYPE = 'capture_inbound_caller';
export const RULE_APPLIED = 'INBOUND_CALLER_CAPTURE';
export const MODES = Object.freeze(['off', 'shadow', 'approval', 'live']);
// A row in one of these states has been acted on (or is being). Never again.
export const ACTIONED = Object.freeze([
  'in_progress', 'approval_queued', 'enrolled', 'contact_created_enrolled', 'already_enrolled',
]);
export const CONTACT_TAG = 'inbound-capture';
const FIRST_HOUR_ET = 8;
const LAST_HOUR_ET = 20;       // inclusive: the 20:00 pass catches the evening
const SUMMARY_HOUR_ET = 7;
const SUMMARY_MINUTE_ET = 15;  // after lead-leak-monitor's 07:00
const HOUR_MS = 60 * 60 * 1000;
const DNC_BATCH = 200;         // five9_check_dnc's own cap
const LEAD_CHUNK = 500;
const MAX_CONSECUTIVE_GHL_ERRORS = 5;

/* --- config, read per pass ---------------------------------------------- */

export function captureMode(env = process.env) {
  const raw = String(env.INBOUND_CAPTURE_MODE ?? '').trim().toLowerCase();
  if (!raw) return 'shadow';
  return MODES.includes(raw) ? raw : 'shadow';
}

const positiveInt = (raw, fallback) => {
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function captureConfig(env = process.env) {
  return {
    mode: captureMode(env),
    lookbackHours: positiveInt(env.INBOUND_CAPTURE_LOOKBACK_HOURS, 48),
    // Blank → the ops channel the other monitors report to (#ops-alerts).
    slackChannel: String(env.INBOUND_CAPTURE_SLACK_CHANNEL ?? '').trim() || opsChannelId(),
  };
}

function resolveDeps(deps = {}) {
  return {
    runSQL: deps.runSQL || defaultRunSQL,
    db: deps.supabase || defaultSupabase,
    checkDnc: deps.checkDnc || defaultCheckDnc,
    ghlFetch: deps.ghlFetch || defaultGhlFetch,
    enroll: deps.enroll || defaultEnroll,
    postToSlack: deps.postToSlack || defaultPostToSlack,
    log: deps.log || console,
  };
}

/* --- reads -------------------------------------------------------------- */

const sqlList = (values) => values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(',');
const asRows = (res, what) => {
  if (!Array.isArray(res)) throw new Error(`${what} returned no row set`);
  return res;
};

/** The view, optionally narrowed to calls since `sinceMs`. Newest first. */
async function readCallers({ runSQL, sinceMs }) {
  const where = sinceMs ? `WHERE call_at >= '${new Date(sinceMs).toISOString()}'` : '';
  return asRows(await runSQL(`
    SELECT caller, campaign, disposition, minutes, agent_name, team, call_at
      FROM ${VIEW} ${where}
     ORDER BY call_at DESC
  `), VIEW);
}

/** Five9 DNC membership in five9_check_dnc-sized batches. Throws if any batch fails. */
async function readFive9Dnc({ checkDnc, phones }) {
  const onDnc = new Set();
  for (let i = 0; i < phones.length; i += DNC_BATCH) {
    const res = await checkDnc(phones.slice(i, i + DNC_BATCH));
    for (const n of (res?.on_dnc || [])) {
      const p = normalizeCallerPhone(n);
      if (p) onDnc.add(p);
    }
  }
  return onDnc;
}

/**
 * Phones with an lp_leads row RIGHT NOW — the race between the view and this
 * pass. `phone` uses the idx_lp_leads_phone10 expression byte-for-byte (see
 * lead-leak-monitor.js); phone_alt matches the view's own lp_ph CTE.
 */
async function readLpPhones({ runSQL, phones }) {
  const found = new Set();
  for (let i = 0; i < phones.length; i += LEAD_CHUNK) {
    const list = sqlList(phones.slice(i, i + LEAD_CHUNK));
    const rows = asRows(await runSQL(`
      SELECT right(regexp_replace(coalesce(phone, ''::text), '[^0-9]'::text, ''::text, 'g'::text), 10) AS p
        FROM lp_leads
       WHERE right(regexp_replace(coalesce(phone, ''::text), '[^0-9]'::text, ''::text, 'g'::text), 10) IN (${list})
      UNION
      SELECT right(regexp_replace(phone_alt, '\\D', '', 'g'), 10)
        FROM lp_leads
       WHERE phone_alt IS NOT NULL AND right(regexp_replace(phone_alt, '\\D', '', 'g'), 10) IN (${list})
    `), 'lp_leads race check');
    for (const r of rows) if (r?.p) found.add(String(r.p));
  }
  return found;
}

/**
 * GHL contact for a phone, through the hardened find-before-create helper
 * (src/services/ghl-contact-resolve.js — no new GHL client). A hit is re-read
 * in full: the search projection does not reliably carry tags or custom
 * fields, and those are what decide dnc / already_in_lp / existing_customer.
 * Returns { status: 'found' | 'none' | 'error', contact?, error? }.
 */
export async function lookupGhl(phone10, { ghlFetch, log }) {
  try {
    const hit = await searchByPhone(phone10, { deps: { ...GHL_RESOLVE_DEPS, ghlFetch }, log });
    if (!hit?.id) return { status: 'none' };
    const full = await ghlFetch('GET', `/contacts/${hit.id}`);
    const contact = full?.contact || full;
    if (!contact?.id) return { status: 'error', error: `contact ${hit.id} read returned nothing` };
    return { status: 'found', contact };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}

/** GHL contact ids that have an LP job. Throws on a failed read. */
async function readLpJobContacts({ runSQL, contactIds }) {
  const has = new Set();
  if (!contactIds.length) return has;
  for (let i = 0; i < contactIds.length; i += LEAD_CHUNK) {
    const rows = asRows(await runSQL(`
      SELECT DISTINCT ghl_contact_id FROM lp_jobs WHERE ghl_contact_id IN (${sqlList(contactIds.slice(i, i + LEAD_CHUNK))})
    `), 'lp_jobs');
    for (const r of rows) if (r?.ghl_contact_id) has.add(String(r.ghl_contact_id));
  }
  return has;
}

/* --- the measurement ---------------------------------------------------- */

function toRow(c) {
  return {
    caller_phone: normalizeCallerPhone(c.caller),
    call_at: c.call_at ? new Date(c.call_at).toISOString() : null,
    campaign: c.campaign ?? null,
    team: c.team ?? null,
    agent_name: c.agent_name ?? null,
    disposition: c.disposition ?? null,
    minutes: c.minutes == null ? null : Number(c.minutes),
  };
}

/**
 * Classify a set of view rows. Never throws. Returns
 *   { verdict: 'ok' | 'insufficient_evidence', rows, summary, errors }
 * Each row: the attribution columns + label, why, ghl_contact_id.
 */
export async function classifyCallers(viewRows, { deps = {} } = {}) {
  const d = resolveDeps(deps);
  const errors = [];
  const insufficient = (stage, err) => {
    errors.push(`${stage}: ${err.message}`);
    return { verdict: 'insufficient_evidence', rows: [], summary: null, errors };
  };

  const calls = (viewRows || []).map(toRow).filter((r) => r.caller_phone && r.call_at);
  const phones = [...new Set(calls.map((r) => r.caller_phone))];

  let five9Dnc;
  try {
    five9Dnc = phones.length ? await readFive9Dnc({ checkDnc: d.checkDnc, phones }) : new Set();
  } catch (err) { return insufficient('five9 dnc', err); }

  let lpPhones;
  try {
    lpPhones = phones.length ? await readLpPhones({ runSQL: d.runSQL, phones }) : new Set();
  } catch (err) { return insufficient('lp_leads race check', err); }

  // GHL, once per phone. A Five9-DNC caller is not looked up at all: nothing
  // about GHL can change that label, and it saves the token.
  const ghlByPhone = new Map();
  let consecutive = 0;
  let ghlErrors = 0;
  for (const p of phones) {
    if (five9Dnc.has(p)) continue;
    if (consecutive >= MAX_CONSECUTIVE_GHL_ERRORS) {
      ghlByPhone.set(p, { status: 'error', error: 'skipped after repeated GHL failures' });
      ghlErrors += 1;
      continue;
    }
    const res = await lookupGhl(p, d);
    ghlByPhone.set(p, res);
    if (res.status === 'error') { consecutive += 1; ghlErrors += 1; } else consecutive = 0;
  }
  if (ghlErrors) errors.push(`ghl lookup: ${ghlErrors} failed (labelled unverified)`);

  const contactIds = [...new Set([...ghlByPhone.values()]
    .filter((g) => g.status === 'found').map((g) => String(g.contact.id)))];
  let lpJobContacts = null;
  try {
    lpJobContacts = await readLpJobContacts({ runSQL: d.runSQL, contactIds });
  } catch (err) {
    errors.push(`lp_jobs: ${err.message} (contacts labelled unverified)`);
  }

  const rows = calls.map((r) => {
    const ghl = ghlByPhone.get(r.caller_phone) || { status: five9Dnc.has(r.caller_phone) ? 'none' : 'error' };
    const cid = ghl.status === 'found' ? String(ghl.contact.id) : null;
    const lpJob = !cid ? null : lpJobContacts ? { status: lpJobContacts.has(cid) ? 'yes' : 'no' } : { status: 'error' };
    const { label, why } = classifyCaller({ caller: r.caller_phone }, { five9Dnc, lpPhones, ghl, lpJob });
    return { ...r, label, why, ghl_contact_id: cid };
  });

  return { verdict: 'ok', rows, summary: summarizeCallers(rows), errors };
}

/** Read the view (optionally the last `hours`) and classify it. Never throws. */
export async function measureCallers({ nowMs = Date.now(), hours = null, deps = {} } = {}) {
  const d = resolveDeps(deps);
  let viewRows;
  try {
    viewRows = await readCallers({ runSQL: d.runSQL, sinceMs: hours ? nowMs - hours * HOUR_MS : null });
  } catch (err) {
    return { verdict: 'insufficient_evidence', rows: [], summary: null, errors: [`${VIEW}: ${err.message}`] };
  }
  return classifyCallers(viewRows, { deps });
}

/* --- acting on one caller ------------------------------------------------ */

function phoneDisplay(p) {
  return p && p.length === 10 ? `${p.slice(0, 3)}-${p.slice(3, 6)}-${p.slice(6)}` : String(p || '');
}

/** The GHL `source` a created contact carries. */
export function contactSource(campaign) {
  return `Inbound Call – ${String(campaign || 'Unknown campaign').trim()}`;
}

/**
 * Capture ONE caller: re-check the label with fresh reads (a caller queued
 * for approval hours ago may have opted out or reached LP since), then create
 * the GHL contact if there is none, then enroll through 8e30ff37. The one
 * place both `live` and an approved `approval` action go through.
 *
 * Returns { ok, action_taken, label, ghl_contact_id, detail }.
 * action_taken: enrolled | contact_created_enrolled | already_enrolled |
 *               not_a_candidate | failed
 */
export async function captureCaller(input, { deps = {} } = {}) {
  const d = resolveDeps(deps);
  const row = toRow({ ...input, caller: input.caller_phone ?? input.caller });
  if (!row.caller_phone) return { ok: false, action_taken: 'failed', label: null, detail: 'no usable phone' };

  const recheck = await classifyCallers([{ ...input, caller: row.caller_phone, call_at: row.call_at || new Date().toISOString() }], { deps });
  if (recheck.verdict !== 'ok') {
    return { ok: false, action_taken: 'failed', label: null, detail: recheck.errors.join('; ') };
  }
  const { label, why } = recheck.rows[0];
  let contactId = recheck.rows[0].ghl_contact_id;
  if (!isCandidate(label)) {
    return { ok: true, action_taken: 'not_a_candidate', label, ghl_contact_id: contactId, detail: why };
  }

  let created = false;
  try {
    if (label === 'no_ghl_contact') {
      const res = await resolveOrCreateContact(
        { phone: row.caller_phone, source: contactSource(row.campaign), tags: [CONTACT_TAG] },
        { create: true, deps: { ...GHL_RESOLVE_DEPS, ghlFetch: d.ghlFetch }, log: d.log },
      );
      if (res.outcome === 'found') {
        // Someone else made the contact between our check and our create. Its
        // tags were never read, so do nothing now; the next pass labels it.
        return { ok: true, action_taken: 'not_a_candidate', label, ghl_contact_id: res.contactId, detail: 'a GHL contact appeared mid-capture' };
      }
      if (res.outcome !== 'created' || !res.contactId) {
        return { ok: false, action_taken: 'failed', label, detail: `contact create returned ${res.outcome}` };
      }
      contactId = res.contactId;
      created = true;
    }
    const enrolled = await d.enroll({ contactId, calendarName: `Inbound call · ${row.campaign || 'unknown'}` });
    const already = enrolled?.action === 'create_lead_already_enrolled';
    return {
      ok: true,
      action_taken: already ? 'already_enrolled' : created ? 'contact_created_enrolled' : 'enrolled',
      label,
      ghl_contact_id: contactId,
      detail: enrolled?.action || null,
    };
  } catch (err) {
    return { ok: false, action_taken: 'failed', label, ghl_contact_id: contactId || null, detail: err.message };
  }
}

/** The agent_actions row approval mode queues. Plain English: it IS the card. */
export function buildApprovalAction(row, { runAt }) {
  const when = new Date(row.call_at).toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const who = row.agent_name ? ` with ${row.agent_name}` : '';
  const team = [row.team, row.campaign].filter(Boolean).join(', ');
  return {
    event_id: null,
    action_type: ACTION_TYPE,
    target_system: 'ghl',
    target_entity: 'contact',
    // A contact id when there is one. Otherwise the phone behind a prefix, so
    // the executor's resolvers never mistake ten digits for an LP lead id.
    target_id: row.ghl_contact_id || `inbound:${row.caller_phone}`,
    action_payload: {
      caller_phone: row.caller_phone,
      call_at: row.call_at,
      campaign: row.campaign,
      team: row.team,
      agent_name: row.agent_name,
      disposition: row.disposition,
      minutes: row.minutes,
      label: row.label,
      ghl_contact_id: row.ghl_contact_id,
      queued_at: new Date(runAt).toISOString(),
    },
    reasoning: `A new caller (${phoneDisplay(row.caller_phone)}) talked ${row.minutes ?? '?'} min${who}`
      + `${team ? ` (${team})` : ''} on ${when} ET, dispositioned "${row.disposition || 'none'}", `
      + 'and was never entered in LP.',
    rule_applied: RULE_APPLIED,
    status: 'pending_approval',
    requires_approval: true,
    batch_id: null,
    sequence_order: 0,
  };
}

/* --- storage ------------------------------------------------------------ */

function isMissingTable(error) {
  const m = `${error?.code || ''} ${error?.message || ''}`;
  return /42P01|PGRST205|does not exist|could not find the table/i.test(m);
}

/** Existing rows for these phones. { missing: true } when sql/133 is not applied. */
async function readExisting(db, phones) {
  const rows = [];
  for (let i = 0; i < phones.length; i += LEAD_CHUNK) {
    const { data, error } = await db.from(TABLE)
      .select('caller_phone, call_at, action_taken, agent_action_id')
      .in('caller_phone', phones.slice(i, i + LEAD_CHUNK));
    if (error) {
      if (isMissingTable(error)) return { missing: true, rows: [] };
      throw new Error(`${TABLE} read: ${error.message}`);
    }
    rows.push(...(data || []));
  }
  return { missing: false, rows };
}

const rowKey = (phone, callAt) => `${phone}|${new Date(callAt).toISOString()}`;

/**
 * Claim one row for action: flip action_taken to in_progress ONLY if it is not
 * already actioned. True when this pass owns it; false when another pass (or a
 * previous run) got there first, or the write failed.
 */
async function claimRow(db, row) {
  const { data, error } = await db.from(TABLE)
    .update({ action_taken: 'in_progress' })
    .eq('caller_phone', row.caller_phone)
    .eq('call_at', row.call_at)
    .not('action_taken', 'in', `(${ACTIONED.join(',')})`)
    .select('id');
  if (error) throw new Error(`${TABLE} claim: ${error.message}`);
  return Array.isArray(data) && data.length === 1;
}

async function finishRow(db, row, patch) {
  const { error } = await db.from(TABLE).update(patch)
    .eq('caller_phone', row.caller_phone).eq('call_at', row.call_at);
  if (error) throw new Error(`${TABLE} update: ${error.message}`);
}

/* --- the hourly action pass --------------------------------------------- */

/** One scheduled action pass. Returns the runJob verdict shape. */
export async function runInboundCapture({ env = process.env, nowMs = Date.now(), deps = {} } = {}) {
  const cfg = captureConfig(env);
  if (cfg.mode === 'off') return { skipped: true, reason: 'INBOUND_CAPTURE_MODE=off' };
  const d = resolveDeps(deps);

  const m = await measureCallers({ nowMs, hours: cfg.lookbackHours, deps });
  if (m.verdict === 'insufficient_evidence') {
    d.log.warn(`[InboundCapture] insufficient_evidence — ${m.errors.join('; ')}`);
    return { checked: false, readFailed: true, verdict: m.verdict, reason: m.errors.join('; '), mode: cfg.mode };
  }

  const phones = [...new Set(m.rows.map((r) => r.caller_phone))];
  let existing;
  try {
    existing = await readExisting(d.db, phones);
  } catch (err) {
    return { checked: false, readFailed: true, reason: err.message, mode: cfg.mode };
  }
  if (existing.missing) {
    // No idempotency record → nothing may be created, and nothing can be stored.
    d.log.warn(`[InboundCapture] ${TABLE} does not exist — apply sql/133 from the dashboard. `
      + `Classified ${m.summary.callers} callers (${m.summary.candidates} to capture); stored and actioned nothing.`);
    return { skipped: true, reason: `${TABLE} missing (sql/133 not applied)`, mode: cfg.mode };
  }

  const done = new Map(existing.rows.map((r) => [rowKey(r.caller_phone, r.call_at), r]));
  const actionedPhones = new Set(existing.rows.filter((r) => ACTIONED.includes(r.action_taken)).map((r) => r.caller_phone));
  const runAt = new Date(nowMs).toISOString();
  const errors = [...m.errors];

  // Decide what each call row becomes. Rows newest first: one caller who rang
  // three times is captured once, on the newest call.
  const plannedPhones = new Set();
  const toStore = [];
  const toAct = [];
  for (const r of m.rows) {
    const prior = done.get(rowKey(r.caller_phone, r.call_at));
    if (prior && ACTIONED.includes(prior.action_taken)) continue; // never overwrite an actioned row
    let action = 'none';
    if (isCandidate(r.label)) {
      if (actionedPhones.has(r.caller_phone) || plannedPhones.has(r.caller_phone)) {
        action = 'skipped_duplicate';
      } else if (cfg.mode === 'shadow') {
        action = 'shadow';
        plannedPhones.add(r.caller_phone);
      } else {
        action = 'pending';
        plannedPhones.add(r.caller_phone);
        toAct.push(r);
      }
    }
    toStore.push({
      run_at: runAt,
      caller_phone: r.caller_phone,
      call_at: r.call_at,
      campaign: r.campaign,
      team: r.team,
      agent_name: r.agent_name,
      disposition: r.disposition,
      minutes: r.minutes,
      label: r.label,
      mode: cfg.mode,
      action_taken: action,
      ghl_contact_id: r.ghl_contact_id,
    });
  }

  let stored = 0;
  if (toStore.length) {
    const { error, count } = await d.db.from(TABLE)
      .upsert(toStore, { onConflict: 'caller_phone,call_at', count: 'exact' });
    if (error) {
      // Without the rows there is nothing to claim, so nothing is actioned.
      return { ok: false, mode: cfg.mode, errors: [...errors, `${TABLE} write: ${error.message}`] };
    }
    if (typeof count === 'number' && count !== toStore.length) {
      return { ok: false, mode: cfg.mode, errors: [...errors, `${TABLE} write: expected ${toStore.length} rows, wrote ${count}`] };
    }
    stored = toStore.length;
  }

  const tally = { queued: 0, created: 0, already: 0, not_candidate: 0, failed: 0, lost_claim: 0 };
  for (const r of toAct) {
    let claimed = false;
    try {
      claimed = await claimRow(d.db, r);
    } catch (err) {
      errors.push(err.message);
    }
    if (!claimed) { tally.lost_claim += 1; continue; }

    // Once something exists outside this table (a queued action, a contact, an
    // enrollment) the claim must never be released to `failed`: the next pass
    // would do it again. A row stuck in_progress is the safe direction.
    let sideEffect = false;
    try {
      if (cfg.mode === 'approval') {
        const { data, error } = await d.db.from('agent_actions')
          .insert(buildApprovalAction(r, { runAt: nowMs })).select('id').single();
        if (error || !data?.id) throw new Error(`agent_actions insert: ${error?.message || 'no id returned'}`);
        sideEffect = true;
        await finishRow(d.db, r, { action_taken: 'approval_queued', agent_action_id: data.id });
        tally.queued += 1;
      } else {
        const res = await captureCaller(r, { deps });
        sideEffect = res.action_taken !== 'failed' && res.action_taken !== 'not_a_candidate';
        await finishRow(d.db, r, {
          action_taken: res.action_taken, label: res.label || r.label, ghl_contact_id: res.ghl_contact_id || r.ghl_contact_id,
        });
        if (res.action_taken === 'enrolled' || res.action_taken === 'contact_created_enrolled') tally.created += 1;
        else if (res.action_taken === 'already_enrolled') tally.already += 1;
        else if (res.action_taken === 'not_a_candidate') tally.not_candidate += 1;
        else { tally.failed += 1; errors.push(`capture ${r.caller_phone}: ${res.detail}`); }
      }
    } catch (err) {
      tally.failed += 1;
      errors.push(`capture ${r.caller_phone}: ${err.message}`);
      // Nothing happened outside the table: release the claim so the next pass
      // can retry. A failed release leaves it in_progress (never twice).
      if (!sideEffect) await finishRow(d.db, r, { action_taken: 'failed' }).catch(() => {});
    }
  }

  const s = m.summary;
  const line = `callers=${s.callers} candidates=${s.candidates} dnc=${s.by_label.dnc} in_lp=${s.by_label.already_in_lp}`
    + ` customer=${s.by_label.existing_customer} unverified=${s.by_label.unverified} stored=${stored}`
    + ` queued=${tally.queued} created=${tally.created} already=${tally.already} failed=${tally.failed}`;
  d.log.log(`[InboundCapture] ${cfg.mode} ${cfg.lookbackHours}h — ${line}`);

  const hardFailure = tally.failed > 0 || errors.some((e) => / (claim|update|write): /.test(e));
  return { ok: !hardFailure, mode: cfg.mode, summary: line, stored, ...tally, ...(hardFailure ? { errors } : { notes: errors }) };
}

/* --- the daily summary -------------------------------------------------- */

/** What the action passes did in the last 24h, for the summary's last line. Null if unreadable. */
async function readRecentActions(db, sinceIso) {
  const { data, error } = await db.from(TABLE).select('action_taken').gte('run_at', sinceIso);
  if (error) return null;
  const out = { queued: 0, created: 0, failed: 0 };
  for (const r of data || []) {
    if (r.action_taken === 'approval_queued') out.queued += 1;
    else if (r.action_taken === 'enrolled' || r.action_taken === 'contact_created_enrolled') out.created += 1;
    else if (r.action_taken === 'failed') out.failed += 1;
  }
  return out;
}

/** The 07:15 ET summary: the whole 30-day view, labelled, posted. Never acts, never stores. */
export async function runInboundCaptureSummary({ env = process.env, nowMs = Date.now(), deps = {} } = {}) {
  const cfg = captureConfig(env);
  if (cfg.mode === 'off') return { skipped: true, reason: 'INBOUND_CAPTURE_MODE=off' };
  const d = resolveDeps(deps);

  const m = await measureCallers({ nowMs, hours: null, deps });
  if (m.verdict === 'insufficient_evidence') {
    d.log.warn(`[InboundCapture] summary insufficient_evidence — ${m.errors.join('; ')}`);
    return { checked: false, readFailed: true, reason: m.errors.join('; '), mode: cfg.mode };
  }
  const actioned = cfg.mode === 'shadow' ? null
    : await readRecentActions(d.db, new Date(nowMs - 24 * HOUR_MS).toISOString());
  const text = formatDailySummary({ runDate: todayET(new Date(nowMs)), mode: cfg.mode, summary: m.summary, actioned });
  const res = await d.postToSlack(text, cfg.slackChannel);
  const posted = !!res?.ok;
  // postToSlack never throws: a bad channel or token must be surfaced here, or
  // it reads exactly like a quiet morning (CLAUDE.md).
  const errors = [...m.errors, ...(posted ? [] : [`slack: ${res?.error || 'post failed'}`])];
  d.log.log(`[InboundCapture] summary ${cfg.mode} — callers=${m.summary.callers} candidates=${m.summary.candidates}`
    + ` appts_set=${m.summary.appointments_set}${posted ? ' posted' : ' NOT posted'}`);
  return { ok: posted, mode: cfg.mode, posted, summary: `callers=${m.summary.callers} candidates=${m.summary.candidates}`, ...(posted ? { notes: errors } : { errors }) };
}

/* --- endpoint ----------------------------------------------------------- */

// One pass at a time per process: a 30-day dry run is ~2 GHL reads per caller.
let inFlight = null;
async function guarded(fn) {
  if (inFlight) return { busy: true };
  inFlight = fn();
  try { return await inFlight; } finally { inFlight = null; }
}

/**
 * The endpoint's body. Exported for tests. Never creates, posts or stores.
 * `hours`: omitted → the lookback window (48h); a number → that many hours;
 * 'all' → the whole 30-day view (slow — see the header).
 */
export async function dryRun({ hours, nowMs = Date.now(), env = process.env, deps = {} } = {}) {
  const cfg = captureConfig(env);
  if (hours === 'all') hours = null;
  else hours = positiveInt(hours, cfg.lookbackHours);
  const m = await measureCallers({ nowMs, hours, deps });
  if (m.verdict === 'insufficient_evidence') return { ok: false, verdict: m.verdict, errors: m.errors };
  const byTeamLabel = {};
  for (const r of m.rows) {
    const t = (byTeamLabel[r.team || 'unmapped'] ||= {});
    t[r.label] = (t[r.label] || 0) + 1;
  }
  return {
    ok: true,
    dry_run: true,
    mode: cfg.mode,
    window: hours ? `${hours}h` : '30d (whole view)',
    summary: m.summary,
    calls_by_team_and_label: byTeamLabel,
    appointments_set_candidates: m.rows.filter((r) => isCandidate(r.label) && isAppointmentSet(r.disposition)).length,
    rows: m.rows,
    errors: m.errors,
  };
}

export function registerInboundCaptureRoutes(app) {
  const handler = async (req, res) => {
    const raw = String(req.query?.hours ?? req.body?.hours ?? '').trim().toLowerCase();
    // Blank or unreadable → the 48h default inside dryRun; `all` → the whole view.
    const hours = raw === 'all' ? 'all' : raw || undefined;
    try {
      const out = await guarded(() => dryRun({ hours }));
      if (out.busy) return res.status(409).json({ ok: false, error: 'an inbound-capture pass is already running' });
      res.status(out.ok ? 200 : 503).json(out);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  };
  app.get('/api/lp/inbound-capture', handler);
  app.post('/api/lp/inbound-capture', handler);
  console.log('[InboundCapture] Route registered: GET+POST /api/lp/inbound-capture (dry run)');
}

/* --- schedulers --------------------------------------------------------- */
// Same 5-minute tick as the other monitors. The WORK is wrapped in runJob, not
// the tick (docs/job-runs.md); the occurrence key stops a second replica from
// running the same slot twice.

function minuteET(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', minute: '2-digit' }).formatToParts(d);
  return Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
}

/** Which pass, if any, a tick at `d` should run. Exported for tests. */
export function dueSlot(d = new Date()) {
  const h = hourET(d);
  const day = todayET(d);
  if (h === SUMMARY_HOUR_ET && minuteET(d) >= SUMMARY_MINUTE_ET) return { kind: 'summary', occurrence: `${day}-summary` };
  if (h >= FIRST_HOUR_ET && h <= LAST_HOUR_ET) return { kind: 'hourly', occurrence: `${day}T${String(h).padStart(2, '0')}` };
  return null;
}

let timer = null;
const lastSlot = { summary: null, hourly: null };

export function startInboundCaptureScheduler() {
  if (timer) return;
  if (captureMode() === 'off') {
    console.log('[InboundCapture] disabled (INBOUND_CAPTURE_MODE=off)');
    return;
  }
  console.log(`[InboundCapture] Scheduler started — hourly ${FIRST_HOUR_ET}:00–${LAST_HOUR_ET}:00 ET + summary 07:15 ET (mode=${captureMode()})`);
  const tick = async () => {
    const slot = dueSlot();
    if (!slot || lastSlot[slot.kind] === slot.occurrence) return;
    lastSlot[slot.kind] = slot.occurrence;
    const work = slot.kind === 'summary' ? runInboundCaptureSummary : runInboundCapture;
    try {
      await runJob(JOB_ID, () => guarded(() => work())
        .then((r) => (r?.busy ? { skipped: true, reason: 'another inbound-capture pass was running' } : r)),
      { occurrence: slot.occurrence });
    } catch (err) {
      console.error(`[InboundCapture] ${slot.kind} pass failed:`, err.message);
    }
  };
  timer = setInterval(tick, 5 * 60 * 1000);
}

export function stopInboundCaptureScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
