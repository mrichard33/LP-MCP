// LP Sale → GHL contact backstop — src/services/lp-sale-contact-backstop.js
//
// WHY (2026-10-04): every P2 (Client Lifecycle) card hangs off a GHL contact,
// and 35 in-progress LP sales (~$900k, contracts Nov 2024 – Apr 2026) had NO
// GHL contact at all. The Sale → P2 backstop (src/p2-sale-backstop.js) skips a
// job it cannot attach to anyone and only logged a count, so those sales were
// invisible in GHL for months. The existing LP contact backstop
// (lp-contact-backstop.js) creates contacts only for leads with an UPCOMING
// appointment or a fresh "Data" disposition — a lead that sold without ever
// getting a contact (set and sold before that sweep existed, or entered in LP
// directly) matched neither and never would.
//
// WHAT: every LP job with a contract in the window, not cancelled, whose lead
// has no GHL contact, gets one: find-before-create on the phone
// (resolveOrCreateContact, the hardened path), then the link is written to
// lp_leads. Nothing else. The P2 card follows on the Sale → P2 backstop's next
// pass, exactly as for any other sale (`deal-won` → C.0-IN), so there is still
// one card-making path.
//
// SAFETY — a sold customer must not be treated as a new lead:
//   - Tags are the lead's source tags plus `lp-sale-backstop` and `lp-linked`.
//     NOT `lp-backstop-created` (INTAKE_ROUTE_BACKSTOP_E0 routes those into the
//     E.0 new-lead router) and NOT `stage:new-lead`.
//   - No disposition backfill emit (the LP_DISP_* family is for leads).
//   - The email is copied only when no other GHL contact already holds it. A
//     shared placeholder (a canvasser's own address on 32 contacts, or
//     noemail@gmail.com) is how LP lead 474939 (a Product Received sale) ended
//     up linked to a different homeowner's contact on 2026-10-03.
//   - A sale older than C.0's 90-day staleness window is put into P2 quietly:
//     the Sale → P2 backstop stamps the contact's entry dates first
//     (quietStampNeeded in p2-sale-backstop.js), because GHL's I.AC workflow
//     sets "Date Created" to today on every new contact and C.0 Customer
//     Onboarding would otherwise send "You Made the Call" months after the sale
//     (user ruling 2026-10-04: the backfill goes in quietly).
//
// SALE_CONTACT_BACKSTOP_MODE off | shadow (default) | live.

import { LOST_JOB_STATUSES } from '../lp-job-terminal.js';
import { backstopTagsFor } from './lp-contact-backstop.js';
import { resolveOrCreateContact } from './ghl-contact-resolve.js';
import { normalizePhone } from '../sync-utils.js';
import { GHL_LOCATION_ID } from '../actions/constants.js';

export const SALE_CONTACT_TAG = 'lp-sale-backstop';
export const LINK_SOURCE_SALE_BACKSTOP = 'sale_backstop';
export const LOOKBACK_DAYS = 45;
export const MAX_PER_RUN = 25;
const DAY_MS = 86_400_000;
const CHUNK = 200;

// Canonical ids: src/services/lp-contact-backstop.js (LP_LEAD_ID_FIELD / LP_PROSPECT_ID_FIELD).
const LP_LEAD_ID_FIELD = 'GmAVmW6V9sekD7pVONKr';
const LP_PROSPECT_ID_FIELD = 'ZRQAVrzhtzApzLlHmT87';

// Tags the lead backstop applies that are wrong for someone who already bought.
const NOT_FOR_CUSTOMERS = new Set(['lp-backstop-created', 'stage:new-lead', 'suppress-outbound']);

export function saleContactMode(env = process.env) {
  const m = String(env.SALE_CONTACT_BACKSTOP_MODE || 'shadow').toLowerCase().trim();
  return ['off', 'shadow', 'live'].includes(m) ? m : 'shadow';
}

/** Create-time tags: the lead's source attribution, plus our provenance. */
export function saleContactTags(lead = {}) {
  const base = backstopTagsFor(lead.lead_source, lead.lead_source_detail).filter((t) => !NOT_FOR_CUSTOMERS.has(t));
  return [...new Set([...base, SALE_CONTACT_TAG, 'lp-linked'])];
}

/**
 * Pure. The sales that need a contact: a contract, not cancelled, no contact on
 * the job or its lead, lead not deleted in LP. One entry per lead (its newest
 * contract), newest first.
 */
export function pickSaleLeads(jobs = [], leads = []) {
  const leadById = new Map(leads.map((l) => [String(l.lp_lead_id), l]));
  const byLead = new Map();
  const missingLead = [];
  for (const j of jobs) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(String(j.contractdate || ''))) continue;
    if (LOST_JOB_STATUSES.has(String(j.job_status || '').trim())) continue;
    if (j.ghl_contact_id) continue;
    const lead = leadById.get(String(j.lp_lead_id));
    if (!lead) { missingLead.push(j); continue; }
    if (lead.ghl_contact_id || lead.lp_deleted_at) continue;
    const prev = byLead.get(String(lead.lp_lead_id));
    if (!prev || String(j.contractdate) > String(prev.job.contractdate)) byLead.set(String(lead.lp_lead_id), { lead, job: j });
  }
  const targets = [...byLead.values()].sort((a, b) => String(b.job.contractdate).localeCompare(String(a.job.contractdate)));
  return { targets, missingLead };
}

async function readJobs({ supabase, sinceDay, leadIds }) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from('lp_jobs')
      .select('lp_job_id, lp_lead_id, ghl_contact_id, job_status, job_value, contractdate:raw_lp_data->>contractdate')
      .gte('raw_lp_data->>contractdate', sinceDay);
    if (leadIds?.length) q = q.in('lp_lead_id', leadIds.map(String));
    const { data, error } = await q.order('lp_job_id', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`lp_jobs: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function readLeads({ supabase, leadIds }) {
  const out = [];
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    const { data, error } = await supabase.from('lp_leads')
      .select('lp_lead_id, lp_prospect_id, ghl_contact_id, first_name, last_name, phone, phone_alt, email, address, city, state, zip, lead_source, lead_source_detail, created_at_lp, lp_deleted_at')
      .in('lp_lead_id', leadIds.slice(i, i + CHUNK));
    if (error) throw new Error(`lp_leads: ${error.message}`);
    out.push(...(data || []));
  }
  return out;
}

/** Does another GHL contact already hold this email? Unreadable counts as yes. */
export async function emailHeldByAnother(email, { ghlFetch }) {
  const want = String(email || '').trim().toLowerCase();
  if (!want) return false;
  try {
    const res = await ghlFetch('GET', `/contacts/?query=${encodeURIComponent(want)}&locationId=${GHL_LOCATION_ID}`);
    return (res?.contacts || []).some((c) => String(c?.email || '').trim().toLowerCase() === want);
  } catch {
    return true;
  }
}

/**
 * Link-or-create the contact for one sold lead. Shadow (dryRun) only searches.
 * @returns {{ lp_lead_id, job_id, name, outcome, contact_id?, email_dropped?, error? }}
 */
export async function ensureSaleContact({ lead, job }, { deps, dryRun = true, seenPhones = new Set(), logger = console }) {
  const name = `${String(lead.first_name || '').trim()} ${String(lead.last_name || '').trim()}`.trim();
  const base = { lp_lead_id: String(lead.lp_lead_id), job_id: String(job.lp_job_id), job_status: job.job_status, name };
  const phone = normalizePhone(lead.phone) || normalizePhone(lead.phone_alt);
  if (!phone || phone.length < 10) return { ...base, outcome: 'skipped_no_phone' };
  if (seenPhones.has(phone.slice(-10))) return { ...base, outcome: 'skipped_dup_in_run' };
  seenPhones.add(phone.slice(-10));

  const resolveDeps = { ghlFetch: deps.ghlFetch };
  if (dryRun) {
    const r = await resolveOrCreateContact({ phone }, { create: false, deps: resolveDeps, log: logger });
    return { ...base, outcome: r.contactId ? 'would_link' : 'would_create', contact_id: r.contactId || undefined };
  }

  let email = String(lead.email || '').trim() || null;
  let emailDropped = false;
  if (email && await emailHeldByAnother(email, deps)) { email = null; emailDropped = true; }

  const r = await resolveOrCreateContact({
    firstName: lead.first_name,
    lastName: lead.last_name,
    phone,
    email,
    address: lead.address || null,
    city: lead.city || null,
    state: lead.state || null,
    postalCode: lead.zip || null,
    source: lead.lead_source || 'LP',
    tags: saleContactTags(lead),
    customFields: [
      { id: LP_LEAD_ID_FIELD, field_value: String(lead.lp_lead_id) },
      ...(lead.lp_prospect_id ? [{ id: LP_PROSPECT_ID_FIELD, field_value: String(lead.lp_prospect_id) }] : []),
    ],
  }, { create: true, deps: resolveDeps, log: logger });
  if (!r.contactId) return { ...base, outcome: 'error', error: `no contact (${r.outcome})` };

  // Never clobber a link that raced in.
  const { error: linkErr } = await deps.supabase.from('lp_leads')
    .update({ ghl_contact_id: r.contactId, ghl_link_source: LINK_SOURCE_SALE_BACKSTOP })
    .eq('lp_lead_id', String(lead.lp_lead_id))
    .is('ghl_contact_id', null);
  if (linkErr) return { ...base, outcome: 'error', contact_id: r.contactId, error: `link write failed: ${linkErr.message}` };

  const outcome = r.outcome === 'created' ? 'created' : 'linked';
  if (deps.emitEvent) {
    await Promise.resolve(deps.emitEvent({
      event_type: 'lp.sale_contact_backstop',
      event_subtype: outcome,
      source: 'sale_contact_backstop',
      entity_type: 'contact',
      entity_id: r.contactId,
      ghl_contact_id: r.contactId,
      lp_lead_id: String(lead.lp_lead_id),
      priority: 'low',
      bypass_filter: true,
      payload: { job_id: String(job.lp_job_id), job_status: job.job_status, contract_date: job.contractdate, email_dropped: emailDropped },
      idempotency_key: `sale_contact_backstop:${outcome}:${lead.lp_lead_id}`,
    })).catch((err) => logger.warn?.(`[SaleContactBackstop] event emit failed for lead ${lead.lp_lead_id}: ${err.message}`));
  }
  return { ...base, outcome, contact_id: r.contactId, email_dropped: emailDropped || undefined };
}

async function defaultDeps() {
  const [{ default: supabase }, { ghlFetch }, { emitEvent }] = await Promise.all([
    import('../supabase.js'),
    import('../actions/helpers.js'),
    import('../event-emitter.js'),
  ]);
  return { supabase, ghlFetch, emitEvent };
}

/**
 * One pass. Never throws — failure is { ok: false } so runJob classifies it.
 * `leadIds` limits a run to named leads; `sinceDay` widens the window for a
 * backfill.
 */
export async function runSaleContactBackstop(opts = {}) {
  const logger = opts.logger || console;
  const mode = opts.mode || saleContactMode();
  if (mode === 'off') return { ok: true, skipped: 'SALE_CONTACT_BACKSTOP_MODE=off' };
  const deps = { ...(opts.deps?.__noDefaults ? {} : await defaultDeps()), ...(opts.deps || {}) };
  const nowMs = opts.nowMs ?? Date.now();
  const maxPerRun = opts.maxPerRun ?? MAX_PER_RUN;
  const sinceDay = opts.sinceDay || new Date(nowMs - (opts.lookbackDays ?? LOOKBACK_DAYS) * DAY_MS).toISOString().slice(0, 10);
  const dryRun = mode !== 'live';

  let targets; let missingLead;
  try {
    const jobs = await readJobs({ supabase: deps.supabase, sinceDay, leadIds: opts.leadIds });
    const leadIds = [...new Set(jobs.filter((j) => !j.ghl_contact_id && j.lp_lead_id).map((j) => String(j.lp_lead_id)))];
    const leads = leadIds.length ? await readLeads({ supabase: deps.supabase, leadIds }) : [];
    ({ targets, missingLead } = pickSaleLeads(jobs, leads));
  } catch (err) {
    logger.error?.(`[SaleContactBackstop] could not read sales: ${err.message}`);
    return { ok: false, error: err.message };
  }

  const counts = {};
  const results = [];
  const seenPhones = new Set();
  let failures = 0;
  for (const t of targets.slice(0, maxPerRun)) {
    let r;
    try {
      r = await ensureSaleContact(t, { deps, dryRun, seenPhones, logger });
    } catch (err) {
      r = { lp_lead_id: String(t.lead.lp_lead_id), job_id: String(t.job.lp_job_id), name: '', outcome: 'error', error: err.message };
    }
    if (r.outcome === 'error') failures++;
    counts[r.outcome] = (counts[r.outcome] || 0) + 1;
    results.push(r);
    logger.log?.(`[SaleContactBackstop] ${r.outcome}: lead ${r.lp_lead_id} job ${r.job_id} "${r.job_status || ''}" ${r.name || '(no name)'}${r.contact_id ? ` → ${r.contact_id}` : ''}${r.error ? ` (${r.error})` : ''}`);
  }
  const deferred = Math.max(0, targets.length - maxPerRun);
  if (missingLead.length) logger.log?.(`[SaleContactBackstop] ${missingLead.length} job(s) whose LP lead never synced — not handled here (scripts/repair-p2-missing-lp-jobs.js)`);
  const summary = `${targets.length} sale(s) since ${sinceDay} with no GHL contact — `
    + (Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ') || 'none')
    + (deferred ? `; ${deferred} deferred (cap)` : '')
    + (dryRun ? ` (${mode}, nothing written)` : '');
  if (targets.length) logger.log?.(`[SaleContactBackstop] ${summary}`);
  return { ok: failures === 0, mode, found: targets.length, counts, deferred, results, missing_lead: missingLead.length, summary };
}
