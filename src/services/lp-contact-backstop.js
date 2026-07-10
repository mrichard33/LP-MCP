// LP Contact Auto-Create Backstop — src/services/lp-contact-backstop.js
//
// WHY: GHL contact creation currently depends on LP's outbound webhook
//   reaching GHL workflow I.LP-IN, and delivery is demonstrably inconsistent
//   (verified 2026-07-09: 7 of 23 unique Set leads for July 10 had no
//   ghl_contact_id — same sources/days as delivered ones). LP webhooks don't
//   retry. No contact → no GHL appointment → the lead is invisible to the
//   dashboard, reminders, and confirmation sequences. The polling sync sees
//   100% of LP leads, so this backstop moves contact creation onto the
//   guaranteed pipe: every LP lead with an upcoming Set/Cnf/Verif appointment
//   and no GHL contact gets one (find-before-create), then reconciles its
//   Window Estimate appointment immediately.
//
// SHAPE: a flag-gated periodic sweep (NOT a decision-engine rule —
//   createActionsFromRule takes target_id from event.ghl_contact_id and
//   auto-skips exactly the unlinked leads we need). The scheduler + admin
//   endpoint live in src/admin/lp-contact-backstop.js; this module is the
//   pure/core logic (scan → per-lead find-or-create → reconcile), all GHL I/O
//   via ghlFetch so the whole path is testable under one global.fetch stub.
//   The intended entry point in production is POST /admin/lp-contact-backstop
//   (dry-run default) and the env-gated 15-min sweep.
//
// COEXISTENCE: races benignly with I.LP-IN — find-before-create + the
//   duplicate-400 re-search dedupe contacts, and reconcileLpAppointmentToGhl
//   is idempotent (same-time skip). Its DNC consent guard makes a matched
//   do-not-contact a link-only case (no appointment).

import supabase from '../supabase.js';
import { ghlFetch } from '../actions/helpers.js';
import { GHL_LOCATION_ID } from '../actions/constants.js';
import { reconcileLpAppointmentToGhl } from './lp-ghl-appointment-reconciler.js';
import { normalizePhone } from '../sync-utils.js';
import { appointmentDelta } from '../appointment-dates.js';
import { emitDispositionBackfill } from '../sync-leads.js';
import { buildClassifiedNotification } from '../actions/notification-classifier.js';
import { sendGroupMeMessage } from '../groupme.js';

// LP custom field IDs (canonical: src/actions/handlers/lp-lead.js:65,
// src/lp-appointment-sync.js:205-207). Written as { id, field_value } —
// the repo convention (updateGHLContactFields / resolve-or-create.js:151).
const LP_LEAD_ID_FIELD = 'GmAVmW6V9sekD7pVONKr';
const LP_PROSPECT_ID_FIELD = 'ZRQAVrzhtzApzLlHmT87';

// Only live-appointment dispositions. NOT CXL — no value creating a contact
// for a cancelled appointment; NOT DNC/Issue/others.
const DISPOSITIONS = ['Set', 'Cnf', 'Verif'];
const DEFAULT_HORIZON_DAYS = 45;
// Absolute upper bound enforced REGARDLESS of the caller's horizon_days. This
// — not the caller-supplied window — is the guard that keeps garbage-dated LP
// rows (verified live: unlinked "future" appointments dated Sept 2026, and junk
// like year 3026/2033/2029) from ever minting a contact. A mis-parameterized
// POST /admin/lp-contact-backstop {horizon_days: 99999} cannot get past it.
export const MAX_HORIZON_DAYS = 60;
export const DEFAULT_MAX_PER_RUN = 50;

// ─── Tag mapping (create-time only) ──────────────────────────────────
// Mirrors what I.LP-IN-created contacts carry today (verified on Lopez
// Raices / Cangemi). Invariants: exactly ONE active-entry:* and ONE stage:*.
// lp-backstop-created is distinct from I.LP-IN's lp-inbound so provenance is
// auditable. Mark can tune this later — kept as one exported constant.
export const LP_BACKSTOP_ALWAYS_TAGS = ['lp-backstop-created', 'lp-linked', 'stage:new-lead'];
export const LP_BACKSTOP_TAG_MAP = {
  Canvass:    ['entry:canvassing', 'active-entry:canvassing', 'source:canvass'],
  Internet:   ['entry:other', 'active-entry:other', 'source:internet'],
  Affiliates: ['entry:other', 'active-entry:other', 'source:affiliate'],
};
const LP_BACKSTOP_DEFAULT_TAGS = ['entry:other', 'active-entry:other', 'source:unknown'];

/** Create-time tag set for a lead_source: mapped-or-default base + always tags. */
export function backstopTagsFor(leadSource) {
  const base = LP_BACKSTOP_TAG_MAP[leadSource] || LP_BACKSTOP_DEFAULT_TAGS;
  return [...base, ...LP_BACKSTOP_ALWAYS_TAGS];
}

// ─── Name hygiene ────────────────────────────────────────────────────
// Light only: trim + collapse whitespace, and drop pure-junk placeholders to
// empty (the existing n8n enrich/name-normalization pipeline does the rest).
const NAME_JUNK = new Set(['n/a', 'na', 'n\\a', '..', '...', '?', '-', '.', 'none', 'null', 'unknown', 'test']);
export function cleanName(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return NAME_JUNK.has(t.toLowerCase()) ? '' : t;
}

// ─── Selection ───────────────────────────────────────────────────────
/**
 * Scan lp_leads for backstop candidates: unlinked leads with an upcoming
 * Set/Cnf/Verif appointment and a plausibly-valid phone. Coarse SQL date
 * prefilter (appointment_date stores ET wall-clock mislabeled as UTC → bounds
 * widened a day each side), exact day-granular filtering in JS.
 *
 * @returns {{ targets, noPhone, deferredCapped, eligible, totalRows }}
 *   targets: [{ lead, superseded }] deduped by phone (newest wins), capped.
 *   noPhone: report-only rows dropped for missing/short phone.
 */
export async function scanContactBackstopCandidates({
  horizonDays = DEFAULT_HORIZON_DAYS,
  maxPerRun = DEFAULT_MAX_PER_RUN,
  limit = 0,
} = {}) {
  if (!supabase) throw new Error('Supabase not configured');

  // Clamp the SQL upper bound to the absolute ceiling regardless of the caller's
  // horizonDays — the JS gate in selectBackstopTargets re-asserts the same bound
  // so garbage-dated rows can never slip through either layer.
  const effHorizon = Math.min(Math.max(0, horizonDays), MAX_HORIZON_DAYS);
  const fromIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const toIso = new Date(Date.now() + (effHorizon + 1) * 24 * 3600 * 1000).toISOString();

  const PAGE = 1000;
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('lp_leads')
      .select('lp_lead_id, ghl_contact_id, disposition_code, appointment_date, created_at_lp, first_name, last_name, phone, lead_source, lp_prospect_id')
      .is('ghl_contact_id', null)
      .in('disposition_code', DISPOSITIONS)
      .gte('appointment_date', fromIso)
      .lte('appointment_date', toIso)
      .order('created_at_lp', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`lp_leads backstop scan failed at offset ${from}: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  return { ...selectBackstopTargets(rows, { maxPerRun, limit }), totalRows: rows.length };
}

/**
 * Pure JS selection over already-pulled lp_leads rows (rows MUST be
 * created_at_lp DESC): today-or-future gate → phone gate → dedupe by phone
 * (newest wins) → safety cap. Exported for direct testing.
 *
 * @returns {{ targets:[{lead,superseded}], noPhone, deferredCapped, eligible }}
 */
export function selectBackstopTargets(rows, { maxPerRun = DEFAULT_MAX_PER_RUN, limit = 0 } = {}) {
  // Within-window, day-granular: today (>=0) through the ABSOLUTE ceiling
  // (MAX_HORIZON_DAYS), independent of any caller horizon param. Rejects
  // past-dated AND absurd-future rows (Sept-2026 stragglers, year-3026/2033
  // junk) — this bound is the whole protection against minting garbage
  // contacts. Deliberately NOT lpWallClockToGhlStartTime: it returns null for
  // date-only / exact-midnight rows ("time TBD"), which must still get a
  // contact — the appointment follows when LP posts a real time and the
  // LP_APPT_GHL_SYNC_* rules fire.
  const isWithinWindow = (lead) => {
    const d = appointmentDelta(lead.appointment_date);
    return !!(d && d.days_delta >= 0 && d.days_delta <= MAX_HORIZON_DAYS);
  };

  const noPhone = [];
  const phoneValid = [];
  for (const lead of rows) {
    if (!isWithinWindow(lead)) continue;
    const p = normalizePhone(lead.phone);
    if (!p || p.length < 10) { noPhone.push(lead); continue; }
    phoneValid.push({ lead, phone: p });
  }

  // Dedupe by normalized phone — newest created_at_lp wins (rows are already
  // desc, so first seen per phone wins). Multi-lead reality (Mark Test = 4).
  const byPhone = new Map();
  for (const { lead, phone } of phoneValid) {
    if (!byPhone.has(phone)) byPhone.set(phone, { lead, superseded: 0 });
    else byPhone.get(phone).superseded++;
  }

  const eligibleList = Array.from(byPhone.values());
  const cap = limit > 0 ? Math.min(limit, maxPerRun) : maxPerRun;
  const targets = eligibleList.slice(0, cap);
  const deferredCapped = Math.max(0, eligibleList.length - targets.length);

  return { targets, noPhone, deferredCapped, eligible: eligibleList.length };
}

// ─── GHL contact I/O (all via ghlFetch) ──────────────────────────────
/** Pick the phone-matching contact from a search result, verifying last-10 digits when the projection carries a phone. */
function pickPhoneMatch(contacts, normalizedPhone) {
  const list = Array.isArray(contacts) ? contacts : [];
  if (list.length === 0) return null;
  const want = normalizedPhone.slice(-10);
  const exact = list.find((c) => {
    const cp = normalizePhone(c?.phone);
    return cp && cp.slice(-10) === want;
  });
  if (exact) return exact;
  // No contact carries a matching phone in the projection: only accept the top
  // hit when it has no phone at all (trust the phone query); a mismatching
  // phone is a false positive we must not link.
  return list[0]?.phone ? null : list[0];
}

async function searchByPhone(normalizedPhone) {
  const q = encodeURIComponent(normalizedPhone);
  const res = await ghlFetch('GET', `/contacts/?query=${q}&locationId=${GHL_LOCATION_ID}`);
  return pickPhoneMatch(res?.contacts, normalizedPhone);
}

/** Custom-field stamps needed on an existing contact (only where currently empty). */
function stampFieldsFor(lead, contact) {
  const cfs = Array.isArray(contact?.customFields) ? contact.customFields : [];
  const has = (id) => cfs.some((f) => f.id === id && String(f.field_value ?? f.value ?? '').trim() !== '');
  const stamp = [];
  if (lead.lp_lead_id && !has(LP_LEAD_ID_FIELD)) stamp.push({ id: LP_LEAD_ID_FIELD, field_value: String(lead.lp_lead_id) });
  if (lead.lp_prospect_id && !has(LP_PROSPECT_ID_FIELD)) stamp.push({ id: LP_PROSPECT_ID_FIELD, field_value: String(lead.lp_prospect_id) });
  return stamp;
}

/** A GHL 400 that means "this phone already exists" (server-side dedup). */
function isDuplicate400(err) {
  const m = String(err?.message || '');
  return /→\s*400/.test(m) && /duplicat/i.test(m);
}

// ─── Per-lead flow (find-before-create) ──────────────────────────────
/**
 * Link-or-create the GHL contact for one unlinked lead, then reconcile its
 * Window Estimate appointment. `contactCache` is a per-lead Map shared with
 * the reconciler so a matched contact is read once. `seenPhones` dedupes
 * within a run (belt over the scan-level dedupe).
 */
export async function processOneLead({ lead, dryRun = false, seenPhones, contactCache }) {
  contactCache = contactCache || new Map();
  seenPhones = seenPhones || new Set();
  const base = { lp_lead_id: lead.lp_lead_id, name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim() };

  const phone = normalizePhone(lead.phone);
  if (!phone || phone.length < 10) return { ...base, outcome: 'skipped_no_phone' };
  if (seenPhones.has(phone)) return { ...base, outcome: 'skipped_dup_in_run' };
  seenPhones.add(phone);

  let match = await searchByPhone(phone);
  let contactId = null;
  let action = null; // 'linked' | 'created'

  if (match) {
    contactId = match.id;
    action = 'linked';
    const full = await ghlFetch('GET', `/contacts/${contactId}`);
    const contact = full?.contact || full || {};
    if (!dryRun) {
      const stamp = stampFieldsFor(lead, contact);
      if (stamp.length) await ghlFetch('PUT', `/contacts/${contactId}`, { customFields: stamp });
    }
    contactCache.set(contactId, contact); // prime reconciler's DNC read
  } else if (!dryRun) {
    const body = {
      locationId: GHL_LOCATION_ID,
      firstName: cleanName(lead.first_name),
      lastName: cleanName(lead.last_name),
      phone: lead.phone,
      source: 'lp-backstop',
      tags: backstopTagsFor(lead.lead_source),
      customFields: [
        { id: LP_LEAD_ID_FIELD, field_value: String(lead.lp_lead_id) },
        ...(lead.lp_prospect_id ? [{ id: LP_PROSPECT_ID_FIELD, field_value: String(lead.lp_prospect_id) }] : []),
      ],
    };
    try {
      const cr = await ghlFetch('POST', '/contacts/', body);
      contactId = cr?.contact?.id || cr?.id || null;
      action = 'created';
    } catch (err) {
      if (!isDuplicate400(err)) throw err;
      // GHL deduped server-side (I.LP-IN may have raced in). Re-search → link.
      match = await searchByPhone(phone);
      if (!match) throw err;
      contactId = match.id;
      action = 'linked';
      const full = await ghlFetch('GET', `/contacts/${contactId}`);
      contactCache.set(contactId, full?.contact || full || {});
    }
  } else {
    // Dry-run with no match: would create — nothing to reconcile (no contact).
    return { ...base, phone, outcome: 'created', appointment_result: 'dry_run_no_contact', dry_run: true };
  }

  if (!contactId) return { ...base, phone, outcome: 'error', error: 'no_contact_id_after_create' };

  if (!dryRun && supabase) {
    const { error: updErr } = await supabase.from('lp_leads')
      .update({ ghl_contact_id: contactId })
      .eq('lp_lead_id', lead.lp_lead_id)
      .is('ghl_contact_id', null); // never clobber a link that raced in
    if (updErr) console.warn(`[LpContactBackstop] ghl_contact_id writeback failed for lead ${lead.lp_lead_id}: ${updErr.message}`);
  }

  // Announce the disposition to the event system for every rescued lead
  // (created OR linked). The direct reconcile below only creates the
  // appointment; without this emit the E.0 router and the rest of the
  // LP_DISP_* rule family never see these previously-invisible leads, which
  // is exactly how the appointment/routing gap re-opens. Idempotency-keyed
  // (disp_<id>_backfill_<disp>) so it never double-fires with the reconciler
  // or a later normal-sync emit; no-op for baseline dispositions.
  if (!dryRun) {
    await emitDispositionBackfill({
      lpLeadId: lead.lp_lead_id,
      lpProspectId: lead.lp_prospect_id,
      ghlContactId: contactId,
      disposition: lead.disposition_code,
      leadName: base.name || null,
      leadSource: lead.lead_source || null,
    }).catch((e) => console.warn(`[LpContactBackstop] disposition emit failed for lead ${lead.lp_lead_id}: ${e.message}`));
  }

  // Reconcile the appointment immediately — the appointment appearing is the
  // point; toNotify:true so reminder/confirmation sequences fire off the GHL
  // booking trigger for these previously-invisible leads.
  const rec = await reconcileLpAppointmentToGhl({ contactId, lead, toNotify: true, contactCache, dryRun });
  const apptResult = rec.outcome === 'noop' ? rec.reason : rec.outcome;
  const outcome = rec.reason === 'dnc_consent' ? 'skipped_dnc' : action; // matched DNC = link-only

  return { ...base, phone, contact_id: contactId, action, outcome, appointment_result: apptResult, dry_run: dryRun || undefined };
}

// ─── Run loop ────────────────────────────────────────────────────────
function leadLine(r) {
  const nm = (r.name || '(no name)').padEnd(24);
  const appt = r.appointment_result ? `appt=${r.appointment_result}` : '';
  return `${String(r.outcome).padEnd(18)} lead=${String(r.lp_lead_id).padEnd(8)} ${nm} ${r.contact_id ? `contact=${r.contact_id} ` : ''}${appt}`.trimEnd();
}

/**
 * Run the backstop over scanned candidates. Sequential (ghlFetch's token
 * bucket throttles GHL). `job` is optional live progress state (admin route).
 * Returns the summary; also written to job.summary when a job is passed.
 */
export async function runLpContactBackstop({
  dryRun = true,
  horizonDays = DEFAULT_HORIZON_DAYS,
  maxPerRun = DEFAULT_MAX_PER_RUN,
  limit = 0,
  job = null,
} = {}) {
  const scan = await scanContactBackstopCandidates({ horizonDays, maxPerRun, limit });
  if (job) job.total = scan.targets.length;

  const counts = { linked: 0, created: 0, skipped_no_phone: 0, skipped_dnc: 0, error: 0 };
  const lines = [];
  const errors = [];
  const seenPhones = new Set();

  for (const { lead } of scan.targets) {
    try {
      const r = await processOneLead({ lead, dryRun, seenPhones, contactCache: new Map() });
      counts[r.outcome] = (counts[r.outcome] || 0) + 1;
      lines.push(leadLine(r));
    } catch (err) {
      counts.error++;
      const msg = String(err?.message || err).slice(0, 300);
      errors.push({ lp_lead_id: lead.lp_lead_id, error: msg });
      lines.push(`error              lead=${String(lead.lp_lead_id).padEnd(8)} → ${msg}`);
    }
    if (job) { job.processed++; job.errors = errors.length; }
  }

  // Report-only rows (no valid phone): counted, never created.
  counts.skipped_no_phone = scan.noPhone.length;
  for (const l of scan.noPhone) {
    lines.push(`skipped_no_phone   lead=${String(l.lp_lead_id).padEnd(8)} ${`${l.first_name || ''} ${l.last_name || ''}`.trim() || '(no name)'} phone=${l.phone || '—'}`);
  }

  const summary = {
    dry_run: dryRun,
    horizon_days: horizonDays,
    max_per_run: maxPerRun,
    scanned_rows: scan.totalRows,
    eligible: scan.eligible,
    processed: scan.targets.length,
    deferred_capped: scan.deferredCapped,
    counts,
    errors,
    lines,
  };

  if (job) {
    job.summary = summary;
    job.status = 'completed';
    job.completed_at = new Date().toISOString();
  }

  // One intelligence-class rep summary per LIVE run with activity — no
  // per-contact spam. Best-effort: a send failure never fails the sweep.
  if (!dryRun && (counts.created || counts.linked || counts.skipped_dnc)) {
    try {
      const card = buildClassifiedNotification({
        notification_class: 'intelligence',
        action_verb: 'LP CONTACT BACKSTOP',
        name: 'LP Contact Backstop sweep',
        contactId: '—',
        tier: 'Warm',
        status: 'Backstop sweep',
        narrative:
          `Auto-create backstop swept ${scan.targets.length} unlinked LP lead(s): ` +
          `${counts.created} created, ${counts.linked} linked, ${counts.skipped_dnc} DNC link-only, ` +
          `${counts.skipped_no_phone} no-phone, ${scan.deferredCapped} deferred (cap ${maxPerRun}).`,
        next_step: 'Newest lp_leads rows now linked; LP_APPT_GHL_SYNC_* rules own them going forward.',
      });
      await sendGroupMeMessage(card, { flushNow: true });
    } catch (e) {
      console.warn(`[LpContactBackstop] summary notification failed: ${e.message}`);
    }
  }

  return summary;
}
