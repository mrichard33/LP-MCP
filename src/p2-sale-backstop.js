/**
 * P2 sale backstop — src/p2-sale-backstop.js
 *
 * ONE question: is there an LP sale whose contact has NO Client Lifecycle (P2)
 * opportunity at all? If so, put it there.
 *
 * WHY THIS EXISTS (2026-10-03)
 * ----------------------------
 * The GHL "Pipeline Value" tile kept falling while sales held steady (~80 LP
 * jobs a week). A P2 card is built by exactly one chain:
 *
 *   LP outbound webhook → GHL I.LP-IN (7f24f79d) Sold branch adds `deal-won`
 *   → GHL C.0-IN Sale Made Entry (1825422d) moves P1 to Sale Recorded and
 *     creates the P2 "Contract Signed" card, valued from LP Gross Sale Amount.
 *
 * LP's webhook all but stopped delivering on 2026-09-24 (measured in
 * src/notifications/sale-backstop.js). That backstop rescued the Slack sale
 * announcement only; nothing rescued `deal-won`. Contacts with
 * `lp-status:closed-won` that also got `deal-won`, by week added:
 *
 *   09-07  62 of 65     09-14  64 of 90     09-21  19 of 115     09-28  3 of 35
 *
 * On 2026-10-03, 46 of the 237 contacts with an LP contract in the last 21 days
 * had no P2 opportunity at all — 41 LP Sales (~$1.1M) still sitting at P1
 * "Appointment Booked". Our own code never covered it: checkLeadTriggers in
 * src/sync-triggers.js filtered on raw_lp_data->won_tag_fired, a key no row has
 * ever carried, so it matched 0 of 3,377 won leads and never added the tag.
 *
 * WHAT IT DOES (Mark/user ruling 2026-10-03)
 * -----------------------------------------
 * For each recent LP job whose contact has no P2 opportunity in ANY status:
 *   live job, no `deal-won`      → add `deal-won`. Exactly the step I.LP-IN
 *                                  would have taken; C.0-IN builds the card and
 *                                  starts onboarding, one copy of that logic.
 *   live job, `deal-won` already → C.0-IN had its chance (its tag trigger will
 *     there, still no card         not fire again), so create the card here
 *                                  through executeMoveOpportunity — same create
 *                                  path, value, LP Job ID stamp and lock as a
 *                                  milestone move. Waits RETAG_WAIT_MS after our
 *                                  own tag so C.0-IN is not raced.
 *   live job on a do-not-contact → create the card directly, never the tag:
 *     contact                      `deal-won` starts customer onboarding.
 *   job Cancelled / Credit       → create the card closed Lost with the job's
 *     Decline / … (LOST set)       lost reason and post to L.6, the same
 *                                  handling a cancelled sale gets when its card
 *                                  exists. No `deal-won`, so no onboarding.
 *   job Paid In Full (WON set)   → create the card closed Won.
 *   job with no price yet        → report only. C.0-IN would exit on an empty
 *                                  LP Gross Sale Amount, and a card with no value
 *                                  is what this is trying to stop.
 *
 * Reads the HL mirror first (cheap) and asks GHL live only for contacts the
 * mirror shows with no P2 card — the mirror lags ~30 minutes, so a live read
 * is the deciding one. Any unreadable read skips that contact: never guess.
 *
 * SALE_P2_BACKSTOP_MODE off | shadow (default) | live. Shadow decides and
 * logs `[SaleP2Backstop]` lines; only live writes.
 */

import { decidingJob, OPP_CF_LP_JOB_ID, readOppJobId } from './p2-opportunity-context.js';
import { WON_JOB_STATUSES } from './lp-job-terminal.js';
import { lostReasonIdForJobStatus } from './lp-lost-reasons.js';
import { PIPELINE_IDS, STAGE_MAP, GHL_LOCATION_ID } from './actions/constants.js';
import { SALE_CONTACT_TAG } from './services/lp-sale-contact-backstop.js';

export const P2_PIPELINE_ID = PIPELINE_IDS.P2;
export const CONTRACT_SIGNED_STAGE = 'Contract Signed';
export const DEAL_WON_TAG = 'deal-won';
export const RULE_KEY = 'P2_SALE_BACKSTOP';

/** A sale gets this long for the normal I.LP-IN → C.0-IN path before we step in. */
export const GRACE_MS = 30 * 60 * 1000;
/** After WE add `deal-won`, C.0-IN gets this long to build the card. */
export const RETAG_WAIT_MS = 60 * 60 * 1000;
export const LOOKBACK_DAYS = 45;
/** Writes per pass. A backlog drains over a few passes instead of one burst. */
export const MAX_ACTIONS = 25;

/**
 * Tags that mean "do not message this person". `deal-won` starts customer
 * onboarding, so these contacts get the card created directly instead.
 */
export const NO_ONBOARDING_TAGS = Object.freeze([
  'stop-bot', 'dnc', 'lp-dnc', 'stage:dnc', 'suppress-outbound', 'dnc-sms', 'dnc-voice', 'dnc-email',
]);

/**
 * 2026-10-04: a contact the sale-contact backstop just created gets this long
 * before anything here touches it. GHL's I.AC workflow writes "Date Created" =
 * today a few seconds after any contact is created; the quiet stamp below must
 * land after that, never before.
 */
export const NEW_CONTACT_SETTLE_MS = 10 * 60 * 1000;
/** C.0 Customer Onboarding exits when both entry dates are older than this. */
export const QUIET_AFTER_DAYS = 90;
// C.0 Customer Onboarding's "Stale Lead" branch reads these two contact fields.
export const DATE_CREATED_FIELD = 'sKFUjCKYgCdD0KQiQGo2';
export const LP_ENTRY_DATE_FIELD = '5wa3f6WZJ6xVnAklUYhC';

/** Pure. A just-created sale-backstop contact that GHL is still setting up. */
export function newContactSettling(contact, nowMs) {
  if (!tagsOf(contact).includes(SALE_CONTACT_TAG)) return false;
  const added = Date.parse(contact?.dateAdded || '');
  return Number.isFinite(added) && nowMs - added < NEW_CONTACT_SETTLE_MS;
}

/**
 * Pure. Should this sale go into P2 without onboarding? Only a contact the
 * sale-contact backstop created (an old customer GHL never knew) for a sale
 * older than C.0's own staleness window. User ruling 2026-10-04: the 35 sales
 * backfilled from Nov 2024 – Apr 2026 go in quietly. A fresh sale whose
 * contact is created late still gets onboarding, like any other sale.
 */
export function quietStampNeeded({ contact, contractDate, nowMs }) {
  if (!tagsOf(contact).includes(SALE_CONTACT_TAG)) return false;
  const signed = Date.parse(String(contractDate || '').slice(0, 10));
  return Number.isFinite(signed) && nowMs - signed > QUIET_AFTER_DAYS * DAY_MS;
}

const MODES = new Set(['off', 'shadow', 'live']);
export function backstopMode(env = process.env) {
  const m = String(env.SALE_P2_BACKSTOP_MODE || 'shadow').toLowerCase().trim();
  return MODES.has(m) ? m : 'shadow';
}

const DAY_MS = 86_400_000;
const CHUNK = 200;

const tagsOf = (contact) => (Array.isArray(contact?.tags) ? contact.tags.map((t) => String(t).toLowerCase().trim()) : []);
const jobValue = (job) => {
  const v = parseFloat(job?.job_value);
  return Number.isFinite(v) && v > 0 ? v : null;
};

/**
 * Pure. When did this sale become "ours to rescue"? The first Sale event our
 * sync recorded for the lead (our own clock). With no Sale event (a job keyed
 * under another disposition), the end of the contract day in Eastern time —
 * LP dates are Eastern wall clock (CLAUDE.md), and 04:00Z the next day is
 * midnight EDT, so a same-day contract always gets its grace.
 */
export function firstSeenMs({ saleEventAt = null, contractDate = null } = {}) {
  const ev = saleEventAt ? Date.parse(saleEventAt) : NaN;
  if (Number.isFinite(ev)) return ev;
  const day = String(contractDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return NaN;
  return Date.parse(`${day}T04:00:00Z`) + DAY_MS;
}

const dayMs = (d) => {
  const day = String(d || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : NaN;
};
const hasPayment = (job) => Array.isArray(job?.payments) && job.payments.some((p) => parseFloat(p?.pmtamount) > 0);
const within10pct = (a, b) => {
  const x = parseFloat(a);
  const y = parseFloat(b);
  return Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0 && Math.abs(x - y) <= 0.1 * Math.max(x, y);
};

/**
 * Pure. Does a P2 card already stand for THIS job? (2026-10-03, repeat customers)
 *
 * "The contact has a P2 card" was the first rule, and it skipped every returning
 * customer: their earlier job's card is closed Won, `deal-won` is already on the
 * contact so C.0-IN never builds another, and the new job had no card at all
 * (7 live jobs, ~$76k, on 2026-10-03 — e.g. 60124 after 59380 Paid In Full).
 *
 * Covered when: any card is OPEN; or a closed card is stamped with this job's
 * LP Job ID; or a closed card has no stamp and was created on/after the job's
 * contract day (C.0-IN's own cards carry no stamp, and are made at the sale).
 */
export function p2CoversJob(opps = [], job = {}) {
  const list = (opps || []).filter(Boolean);
  if (list.some((o) => String(o.status || 'open').toLowerCase() === 'open')) return true;
  const jobId = String(job?.lp_job_id ?? '').trim();
  const contract = dayMs(job?.contractdate);
  return list.some((o) => {
    const stamped = readOppJobId(o);
    if (stamped) return stamped === jobId;
    const created = Date.parse(o.createdAt || o.date_added || '');
    return Number.isFinite(created) && Number.isFinite(contract) && created >= contract;
  });
}

/**
 * Pure. Is this live job probably an earlier quote that a PAID job replaced,
 * rather than a second sale? (2026-10-03, user ruling: list these, never add.)
 * True when the job has no payment AND the contact has a paid job (WON status)
 * that was written later, or whose value — or a closed P2 card's value — is
 * within 10% of this job's. 58338 ($74,536, no payment) beside 58102 Paid In
 * Full ($80,191) is the case; adding it would put $74k of dead quote in pipeline.
 */
export const DUPLICATE_WINDOW_DAYS = 60;
export function looksLikeDuplicateOfPaidJob(job, allJobs = [], p2Opps = []) {
  if (!job || hasPayment(job)) return false;
  const id = String(job.lp_job_id);
  const contract = dayMs(job.contractdate);
  // "Similar price" counts only near in time: a customer who paid $13,192 in
  // April 2025 and bought again for $14,000 in October 2026 (60104) is a real
  // second sale, not a copy.
  const near = (ms) => Number.isFinite(ms) && Number.isFinite(contract) && Math.abs(ms - contract) <= DUPLICATE_WINDOW_DAYS * DAY_MS;
  const paid = (allJobs || []).filter((j) => j && String(j.lp_job_id) !== id && WON_JOB_STATUSES.has(String(j.job_status || '').trim()));
  if (paid.some((j) => {
    const written = dayMs(j.contractdate);
    return (Number.isFinite(contract) && written > contract) || (near(written) && within10pct(j.job_value, job.job_value));
  })) return true;
  return (p2Opps || []).some((o) => String(o?.status || '').toLowerCase() !== 'open'
    && near(Date.parse(o?.createdAt || o?.date_added || ''))
    && within10pct(o?.monetaryValue ?? o?.monetary_value, job.job_value));
}

/**
 * Pure. What to do for one contact.
 *
 * @param {object} c
 * @param {string} c.verdict      decidingJob verdict: live | terminal_won | terminal_lost | no_job
 * @param {object} c.job          the deciding job
 * @param {object[]|null} c.p2Opps  the contact's P2 opportunities, any status; null = unreadable
 * @param {object|null} c.contact  live GHL contact; null = unreadable
 * @param {number|null} c.taggedAtMs  when this sweep last added `deal-won`, if ever
 * @param {number} c.nowMs
 * @returns {{ action: string, reason: string }}
 */
export function planForSale({ verdict, job, p2Opps, contact, taggedAtMs = null, nowMs, allJobs = [] }) {
  if (p2Opps === null || p2Opps === undefined) return { action: 'skip', reason: 'p2_unreadable' };
  if (!job || verdict === 'no_job') return { action: 'skip', reason: 'no_job' };
  if (p2Opps.length > 0) {
    // Only a LIVE job can be a repeat customer's uncovered sale. A terminal job
    // on a contact that already has a card is left alone: a second Won/Lost card
    // would double-count history.
    if (verdict !== 'live' || p2CoversJob(p2Opps, job)) return { action: 'skip', reason: 'has_p2' };
    if (jobValue(job) === null) return { action: 'report', reason: 'no_price_yet' };
    if (looksLikeDuplicateOfPaidJob(job, allJobs, p2Opps)) return { action: 'report', reason: 'possible_duplicate_of_paid_job' };
    // Listed for a person, never written (2026-10-03). This GHL account allows ONE
    // P2 card per contact: the create came back "Can not create duplicate
    // opportunity", and the duplicate recovery in executeMoveOpportunity then
    // REOPENED the customer's old Won card (Nancy Bill, Michael Blackford, Jeffrey
    // Gallager, Dianne Ferwerda: all four moved from Won / Referral & Expansion
    // back to open / Contract Signed). `deal-won` is no answer either: it is
    // already on the contact, and C.0-IN's find-opportunity step picks the old card.
    return { action: 'report', reason: 'repeat_customer_one_card_limit' };
  }

  if (newContactSettling(contact, nowMs)) return { action: 'wait', reason: 'new_contact_settling' };

  if (verdict === 'terminal_lost') {
    return lostReasonIdForJobStatus(job.job_status)
      ? { action: 'create_lost', reason: `job ${String(job.job_status).trim()}` }
      : { action: 'report', reason: `no lost reason for "${job.job_status}"` };
  }
  if (verdict === 'terminal_won') return { action: 'create_won', reason: `job ${String(job.job_status).trim()}` };

  if (jobValue(job) === null) return { action: 'report', reason: 'no_price_yet' };
  if (looksLikeDuplicateOfPaidJob(job, allJobs, p2Opps)) return { action: 'report', reason: 'possible_duplicate_of_paid_job' };
  if (!contact) return { action: 'skip', reason: 'contact_unreadable' };

  const tags = tagsOf(contact);
  if (NO_ONBOARDING_TAGS.some((t) => tags.includes(t))) return { action: 'create_open', reason: 'do_not_contact' };
  if (!tags.includes(DEAL_WON_TAG)) return { action: 'tag_deal_won', reason: 'no_deal_won' };
  if (Number.isFinite(taggedAtMs) && nowMs - taggedAtMs < RETAG_WAIT_MS) {
    return { action: 'wait', reason: 'c0_has_not_had_time' };
  }
  return { action: 'create_open', reason: 'deal_won_but_no_card' };
}

// ─── Reads (each a deps seam) ────────────────────────────────────

async function readRecentJobs({ supabase, sinceDay }) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('lp_jobs')
      .select('lp_job_id, lp_lead_id, ghl_contact_id, job_status, job_value, contractdate:raw_lp_data->>contractdate')
      .gte('raw_lp_data->>contractdate', sinceDay)
      .order('lp_job_id', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`lp_jobs: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out.filter((j) => /^\d{4}-\d{2}-\d{2}/.test(String(j.contractdate || '')));
}

async function readLeadContacts({ supabase, leadIds }) {
  const map = new Map();
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    const { data, error } = await supabase.from('lp_leads')
      .select('lp_lead_id, ghl_contact_id').in('lp_lead_id', leadIds.slice(i, i + CHUNK));
    if (error) throw new Error(`lp_leads: ${error.message}`);
    for (const l of data || []) if (l.ghl_contact_id) map.set(String(l.lp_lead_id), l.ghl_contact_id);
  }
  return map;
}

async function readSaleEventTimes({ supabase, leadIds, sinceIso }) {
  const map = new Map();
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    const { data, error } = await supabase.from('system_events')
      .select('lp_lead_id, created_at')
      .eq('event_type', 'lp.disposition_changed').eq('event_subtype', 'Sale')
      .gte('created_at', sinceIso)
      .in('lp_lead_id', leadIds.slice(i, i + CHUNK));
    if (error) throw new Error(`sale events: ${error.message}`);
    for (const e of data || []) {
      const id = String(e.lp_lead_id);
      if (!map.has(id) || String(e.created_at) < map.get(id)) map.set(id, e.created_at);
    }
  }
  return map;
}

/**
 * Contacts the HL mirror shows with an OPEN P2 card. A contact whose cards are
 * all closed still goes to the live read: its new job may be uncovered
 * (p2CoversJob). 2026-10-03 — was "any status", which hid repeat customers.
 */
async function readMirrorP2Contacts({ hlRunSQL, esc, contactIds }) {
  const has = new Set();
  for (let i = 0; i < contactIds.length; i += CHUNK) {
    const ids = contactIds.slice(i, i + CHUNK).map((id) => `'${esc(id)}'`).join(',');
    const rows = await hlRunSQL(
      `SELECT DISTINCT ghl_contact_id FROM opportunities WHERE deleted_at IS NULL `
      + `AND status = 'open' AND ghl_pipeline_id = '${esc(P2_PIPELINE_ID)}' AND ghl_contact_id IN (${ids})`,
    );
    for (const r of rows || []) has.add(r.ghl_contact_id);
  }
  return has;
}

async function readTaggedAt({ supabase, contactIds }) {
  const map = new Map();
  for (let i = 0; i < contactIds.length; i += CHUNK) {
    const { data, error } = await supabase.from('system_events')
      .select('ghl_contact_id, created_at')
      .eq('event_type', 'p2.sale_backstop').eq('event_subtype', 'tagged_deal_won')
      .in('ghl_contact_id', contactIds.slice(i, i + CHUNK));
    if (error) throw new Error(`backstop events: ${error.message}`);
    for (const e of data || []) {
      const t = Date.parse(e.created_at);
      if (Number.isFinite(t) && t > (map.get(e.ghl_contact_id) ?? -Infinity)) map.set(e.ghl_contact_id, t);
    }
  }
  return map;
}

async function liveP2Opps({ ghlFetch, contactId }) {
  try {
    const res = await ghlFetch('GET', `/opportunities/search?location_id=${GHL_LOCATION_ID}&contact_id=${contactId}&pipeline_id=${P2_PIPELINE_ID}`);
    return Array.isArray(res?.opportunities) ? res.opportunities : null;
  } catch {
    return null;
  }
}

async function liveContact({ ghlFetch, contactId }) {
  try {
    const res = await ghlFetch('GET', `/contacts/${contactId}`);
    return res?.contact || null;
  } catch {
    return null;
  }
}

async function defaultDeps() {
  const [{ default: supabase }, { hlRunSQL, esc }, { ghlFetch }, { applyGHLTag }, { emitEvent }, l6, p2ctx] = await Promise.all([
    import('./supabase.js'),
    import('./admin/hl-client.js'),
    import('./actions/helpers.js'),
    import('./ghl.js'),
    import('./event-emitter.js'),
    import('./loss-routing/l6.js'),
    import('./p2-opportunity-context.js'),
  ]);
  return {
    supabase, hlRunSQL, esc, ghlFetch, applyGHLTag, emitEvent,
    postL6: l6.maybePostL6,
    loadP2CreateContext: p2ctx.loadP2CreateContext,
    jobsForContact: (await import('./lp-job-value.js')).jobsForContact,
  };
}

/**
 * Find every recent sale with no P2 card and decide what to do with each.
 * Throws on a failed bulk read — the caller reports "could not tell".
 *
 * @returns {Promise<Array<{ contactId, job, verdict, plan, firstSeenAt }>>}
 */
export async function findSalesMissingP2(deps) {
  const {
    supabase, hlRunSQL, esc = (s) => String(s).replace(/'/g, "''"), ghlFetch, jobsForContact,
    nowMs = Date.now(), lookbackDays = LOOKBACK_DAYS, sinceDay = null, graceMs = GRACE_MS,
    logger = console,
  } = deps;

  const since = sinceDay || new Date(nowMs - lookbackDays * DAY_MS).toISOString().slice(0, 10);
  const jobs = await readRecentJobs({ supabase, sinceDay: since });

  // Contact for each job: its own link, else its parent lead's (jobsForContact's rule).
  const needLead = [...new Set(jobs.filter((j) => !j.ghl_contact_id && j.lp_lead_id).map((j) => String(j.lp_lead_id)))];
  const leadContact = needLead.length ? await readLeadContacts({ supabase, leadIds: needLead }) : new Map();
  const byContact = new Map();
  let unlinked = 0;
  for (const j of jobs) {
    const cid = j.ghl_contact_id || leadContact.get(String(j.lp_lead_id)) || null;
    if (!cid) { unlinked++; continue; }
    if (!byContact.has(cid)) byContact.set(cid, []);
    byContact.get(cid).push(j);
  }
  if (unlinked) logger.log?.(`[SaleP2Backstop] ${unlinked} recent job(s) have no GHL contact — not checked (see the link-leak monitor)`);
  if (!byContact.size) return [];

  // Cheap first pass: drop every contact the mirror already shows with an OPEN P2 card.
  const withP2 = await readMirrorP2Contacts({ hlRunSQL, esc, contactIds: [...byContact.keys()] });
  const suspects = [...byContact.keys()].filter((cid) => !withP2.has(cid));
  if (!suspects.length) return [];

  const leadIds = [...new Set(suspects.flatMap((cid) => byContact.get(cid).map((j) => String(j.lp_lead_id))).filter(Boolean))];
  const saleAt = await readSaleEventTimes({ supabase, leadIds, sinceIso: new Date(Date.parse(since) - 30 * DAY_MS).toISOString() });
  const taggedAt = await readTaggedAt({ supabase, contactIds: suspects });

  const out = [];
  for (const cid of suspects) {
    // The deciding job across ALL the contact's jobs (placeholders dropped), and
    // only if it is one of the recent ones — an old job is not this sweep's.
    const all = await jobsForContact(cid);
    if (all.error) { logger.warn?.(`[SaleP2Backstop] ${cid}: jobs unreadable (${all.error}) — skipped`); continue; }
    const { job, verdict } = decidingJob(all.jobs);
    const recentIds = new Set(byContact.get(cid).map((j) => String(j.lp_job_id)));
    if (!job || !recentIds.has(String(job.lp_job_id))) continue;
    const recent = byContact.get(cid).find((j) => String(j.lp_job_id) === String(job.lp_job_id)) || job;

    const seen = firstSeenMs({ saleEventAt: saleAt.get(String(recent.lp_lead_id)), contractDate: recent.contractdate });
    if (!Number.isFinite(seen) || nowMs - seen < graceMs) continue;

    const p2Opps = await liveP2Opps({ ghlFetch, contactId: cid });
    const contact = p2Opps && p2Opps.length === 0 ? await liveContact({ ghlFetch, contactId: cid }) : null;
    const plan = planForSale({ verdict, job: { ...recent, ...job }, p2Opps, contact, taggedAtMs: taggedAt.get(cid) ?? null, nowMs, allJobs: all.jobs });
    out.push({
      contactId: cid,
      contactName: [contact?.firstName, contact?.lastName].filter(Boolean).join(' ') || contact?.contactName || null,
      job: { lp_job_id: String(job.lp_job_id), lp_lead_id: recent.lp_lead_id ?? null, job_status: job.job_status, job_value: jobValue(job), contractdate: recent.contractdate },
      verdict,
      plan,
      quiet: quietStampNeeded({ contact, contractDate: recent.contractdate, nowMs }),
      firstSeenAt: new Date(seen).toISOString(),
    });
  }
  return out;
}

// ─── Writes ──────────────────────────────────────────────────────

async function createCard({ deps, sale, status }) {
  const { ghlFetch, loadP2CreateContext } = deps;
  const ctx = await loadP2CreateContext(sale.contactId, { eventJobId: sale.job.lp_job_id });
  const contact = await liveContact({ ghlFetch, contactId: sale.contactId });
  const name = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ') || contact?.contactName || 'Unknown';
  const value = sale.job.job_value;
  const created = await ghlFetch('POST', '/opportunities/', {
    pipelineId: P2_PIPELINE_ID,
    pipelineStageId: STAGE_MAP[CONTRACT_SIGNED_STAGE],
    locationId: GHL_LOCATION_ID,
    contactId: sale.contactId,
    name,
    status,
    ...(value ? { monetaryValue: value } : {}),
    ...(ctx?.source ? { source: ctx.source } : {}),
    customFields: [{ id: OPP_CF_LP_JOB_ID, field_value: String(sale.job.lp_job_id) }],
  });
  const opportunityId = created?.opportunity?.id || null;
  if (!opportunityId) throw new Error('GHL returned no opportunity id');
  return { opportunityId, contact };
}

/**
 * Back-date a quiet sale's entry dates to when the customer entered LP, so C.0
 * Customer Onboarding takes its own "Stale Lead" exit when the P2 card appears.
 * Both fields are true for the person; only I.AC's "today" was wrong for them.
 */
async function stampQuietEntryDates(sale, deps) {
  let entered = null;
  if (deps.supabase && sale.job.lp_lead_id != null) {
    const { data } = await deps.supabase.from('lp_leads').select('created_at_lp')
      .eq('lp_lead_id', String(sale.job.lp_lead_id)).maybeSingle();
    entered = data?.created_at_lp || null;
  }
  const contract = String(sale.job.contractdate || '').slice(0, 10);
  let day = String(entered || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > contract) day = contract;
  await deps.ghlFetch('PUT', `/contacts/${sale.contactId}`, {
    customFields: [{ id: DATE_CREATED_FIELD, field_value: day }, { id: LP_ENTRY_DATE_FIELD, field_value: day }],
  });
  return day;
}

async function act(sale, deps, { runId }) {
  const { plan } = sale;
  // Stamp BEFORE the write that makes the card: C.0 reads the dates the moment
  // the card is created. A failed stamp fails the write; the next pass retries.
  if (sale.quiet && WRITES.has(plan.action)) {
    try {
      await stampQuietEntryDates(sale, deps);
    } catch (err) {
      return { ok: false, error: `quiet stamp failed: ${err.message}` };
    }
  }
  switch (plan.action) {
    case 'tag_deal_won': {
      const ok = await deps.applyGHLTag(sale.contactId, DEAL_WON_TAG);
      if (!ok) return { ok: false, error: 'tag apply failed' };
      await emit(deps, sale, 'tagged_deal_won');
      return { ok: true };
    }
    case 'create_open': {
      // A plain create, never executeMoveOpportunity (2026-10-03): its
      // duplicate-opportunity recovery PUTs onto whatever card GHL collided
      // with, which reopened four Won cards. Here a collision is a failed write
      // that touches nothing.
      const { opportunityId } = await createCard({ deps, sale, status: 'open' });
      await emit(deps, sale, 'created_open', { opportunity_id: opportunityId });
      return { ok: true, opportunityId };
    }
    case 'create_won': {
      const { opportunityId } = await createCard({ deps, sale, status: 'won' });
      await emit(deps, sale, 'created_won', { opportunity_id: opportunityId });
      return { ok: true, opportunityId };
    }
    case 'create_lost': {
      const lostReasonId = lostReasonIdForJobStatus(sale.job.job_status);
      const { opportunityId, contact } = await createCard({ deps, sale, status: 'lost' });
      // GHL's create does not take a lost reason; set it on the card we just made.
      await deps.ghlFetch('PUT', `/opportunities/${opportunityId}`, { status: 'lost', lostReasonId });
      // Same as every other P2 loss (src/actions/index.js): it must reach L.6.
      // Idempotent through tag_hygiene_log; never fails the rescue.
      const l6 = await deps.postL6({
        contactId: sale.contactId, opportunityId, lostReasonId, runType: 'l6_auto', runId, contact: contact || undefined,
      }).catch((err) => ({ action: 'failed', reason: err.message }));
      await emit(deps, sale, 'created_lost', { opportunity_id: opportunityId, l6: l6?.action || null });
      return { ok: true, opportunityId, l6: l6?.action || null };
    }
    default:
      return { ok: true, skipped: true };
  }
}

function emit(deps, sale, subtype, extra = {}) {
  return Promise.resolve(deps.emitEvent({
    event_type: 'p2.sale_backstop',
    event_subtype: subtype,
    source: 'p2_sale_backstop',
    entity_type: 'contact',
    entity_id: String(sale.contactId),
    ghl_contact_id: String(sale.contactId),
    lp_lead_id: sale.job.lp_lead_id != null ? String(sale.job.lp_lead_id) : null,
    priority: 'low',
    bypass_filter: true,
    payload: {
      job_id: sale.job.lp_job_id, job_status: sale.job.job_status, job_value: sale.job.job_value,
      contract_date: sale.job.contractdate, reason: sale.plan.reason, ...extra,
    },
    // A needs-review note is recorded ONCE per job (the digest lists it once);
    // a write may legitimately repeat on a later pass, so it is keyed per minute.
    idempotency_key: subtype === 'needs_review'
      ? `p2_sale_backstop:needs_review:${sale.contactId}:${sale.job.lp_job_id}`
      : `p2_sale_backstop:${subtype}:${sale.contactId}:${sale.job.lp_job_id}:${Math.floor(Date.now() / 60000)}`,
  })).catch((err) => console.warn(`[SaleP2Backstop] event emit failed for ${sale.contactId}: ${err.message}`));
}

const WRITES = new Set(['tag_deal_won', 'create_open', 'create_won', 'create_lost']);

/**
 * One pass. Never throws — failure is { ok: false } so runJob classifies it
 * from the return value. `mode` overrides SALE_P2_BACKSTOP_MODE (the backfill
 * script passes it).
 */
export async function runSaleP2Backstop(opts = {}) {
  const logger = opts.logger || console;
  const mode = opts.mode || backstopMode();
  if (mode === 'off') return { ok: true, skipped: 'SALE_P2_BACKSTOP_MODE=off' };
  const deps = { ...(opts.deps?.__noDefaults ? {} : await defaultDeps()), ...(opts.deps || {}) };
  const nowMs = opts.nowMs ?? Date.now();
  const maxActions = opts.maxActions ?? MAX_ACTIONS;
  // A one-time backfill may want only some write kinds (2026-10-03: the older
  // live jobs and repeat sales, without minting Won/Lost cards for every sale
  // finished before P2 existed). Absent = every kind.
  const only = Array.isArray(opts.onlyActions) && opts.onlyActions.length ? new Set(opts.onlyActions) : null;
  const runId = `p2_sale_backstop:${new Date(nowMs).toISOString()}`;

  let sales;
  try {
    sales = await findSalesMissingP2({ ...deps, nowMs, lookbackDays: opts.lookbackDays, sinceDay: opts.sinceDay, logger });
  } catch (err) {
    logger.error?.(`[SaleP2Backstop] could not read sales: ${err.message}`);
    return { ok: false, error: err.message };
  }

  const counts = {};
  const results = [];
  let writes = 0;
  let failures = 0;
  for (const sale of sales) {
    counts[sale.plan.action] = (counts[sale.plan.action] || 0) + 1;
    // A sale a person must look at (no price yet, no lost reason) is recorded
    // for the 08:00 ops digest in every mode — it writes nothing to GHL.
    if (sale.plan.action === 'report' && deps.emitEvent) await emit(deps, sale, 'needs_review');
    const line = `${sale.contactName || '(no name)'} (${sale.contactId}) job ${sale.job.lp_job_id} `
      + `"${sale.job.job_status}" $${Math.round(sale.job.job_value || 0).toLocaleString('en-US')} `
      + `contract ${String(sale.job.contractdate).slice(0, 10)} → ${sale.plan.action} (${sale.plan.reason})`;
    const filteredOut = only && WRITES.has(sale.plan.action) && !only.has(sale.plan.action);
    if (!WRITES.has(sale.plan.action) || mode !== 'live' || writes >= maxActions || filteredOut) {
      const why = filteredOut ? 'not selected' : (mode === 'live' && WRITES.has(sale.plan.action) ? 'deferred (cap)' : mode);
      if (sale.plan.action !== 'skip') logger.log?.(`[SaleP2Backstop] ${why}: ${line}`);
      results.push({ ...sale, done: false });
      continue;
    }
    writes++;
    try {
      const r = await act(sale, deps, { runId });
      if (!r.ok) failures++;
      logger.log?.(`[SaleP2Backstop] ${r.ok ? 'done' : `FAILED (${r.error})`}: ${line}`);
      results.push({ ...sale, done: r.ok, result: r });
    } catch (err) {
      failures++;
      logger.warn?.(`[SaleP2Backstop] FAILED (${err.message}): ${line}`);
      results.push({ ...sale, done: false, error: err.message });
    }
  }

  const summary = `${sales.length} sale(s) with no P2 card — `
    + Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ')
    + (mode === 'live' ? `; ${writes - failures} fixed, ${failures} failed` : ` (${mode}, nothing written)`);
  if (sales.length) logger.log?.(`[SaleP2Backstop] ${summary}`);
  return { ok: failures === 0, mode, missing: sales.length, counts, writes, failures, results, summary };
}
