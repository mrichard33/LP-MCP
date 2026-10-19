/**
 * Inbound capture: does this caller already have a lead? — src/inbound-capture-match.js
 *
 * The user, 2026-10-19 (option B): "search our system and try to match to the
 * existing lead". A caller whose newest LP lead (or LP inquiry still waiting to
 * be checked out) is from the last 15 days is MATCHED to it: no new lead. A
 * caller whose leads are all older is a returning homeowner and gets a FRESH
 * lead, the 15-day rule create_lp_lead already applies (Mark, 2026-09-28,
 * src/services/lp-existing-lead-guard.js).
 *
 * WHY FOUR SOURCES, NOT lp_leads ALONE
 *   lp_leads is 94-99% complete only from August 2026; it holds 16% of
 *   February's leads and 5% of April's (measured 2026-10-19), so an older
 *   lead often is not there. LP's inbound queue (lp_inbound_queue) holds
 *   inquiries nobody has checked out yet, which are not in lp_leads at all.
 *   The GHL contact may carry an LP Lead ID. LP itself, read live by phone, is
 *   the one complete source, so it decides whenever the cheaper reads have not
 *   already found a recent lead.
 *
 * THREE-WAY, NOT A BOOLEAN: a read that failed is `unverified`, never "no
 * lead". The capture only ever acts on a clear `create` / `create_returning`.
 *
 * decideLeadMatch is pure; readLeadMatch owns the reads behind a deps seam.
 */

export const MATCH_WINDOW_DAYS = 15;
const DAY_MS = 24 * 60 * 60 * 1000;
// GHL "LP Lead ID" — 8e30ff37's first step skips any contact that has one.
export const LP_LEAD_ID_FIELD = 'GmAVmW6V9sekD7pVONKr';

/** LP's created_at_lp holds Eastern wall-clock digits under a UTC label. Day
 *  granularity makes the 4-5h skew irrelevant here (like the guard). */
const ms = (v) => {
  if (v == null || v === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/**
 * @param {object} p
 *   callAtMs          when the call happened
 *   supabaseLeads     [{ lp_lead_id, lp_prospect_id, created_at_lp }] for the phone
 *   openInquiries     [{ in1_id, cst_id, received_at_lp }] not yet checked out
 *   ghlLeadId         the contact's LP Lead ID field ('' when none)
 *   live              LP live answer: { ldsId, prospectId, createdAtLp } | null (none)
 *   liveError         the live read failed (string) — only matters when it decides
 *   liveRead          the live read was made (false = skipped because already decided)
 * @returns {{ verdict: 'reuse'|'create'|'create_returning'|'unverified'|'need_live',
 *             lead: object|null, why: string }}
 *   need_live: the cheap sources found no recent lead; read LP live and ask again.
 */
export function decideLeadMatch({
  callAtMs, supabaseLeads = [], openInquiries = [], ghlLeadId = '', live = null, liveError = null, liveRead = false,
  windowDays = MATCH_WINDOW_DAYS,
} = {}) {
  const cutoff = (Number.isFinite(callAtMs) ? callAtMs : Date.now()) - windowDays * DAY_MS;
  const recent = (t) => t == null || t >= cutoff; // no date = brand new (the guard's rule)

  const inquiry = (openInquiries || [])[0];
  if (inquiry) {
    return { verdict: 'reuse', lead: { kind: 'inquiry', in1_id: inquiry.in1_id || null, prospect_id: inquiry.cst_id || null, at: inquiry.received_at_lp || null },
      why: 'an LP inquiry for this phone is waiting to be checked out' };
  }

  const known = (supabaseLeads || [])
    .map((l) => ({ kind: 'lead', lead_id: String(l.lp_lead_id), prospect_id: l.lp_prospect_id ? String(l.lp_prospect_id) : null, at: l.created_at_lp || null, t: ms(l.created_at_lp) }))
    .sort((a, b) => (b.t ?? Infinity) - (a.t ?? Infinity));
  const recentKnown = known.find((l) => recent(l.t));
  if (recentKnown) return { verdict: 'reuse', lead: strip(recentKnown), why: `LP lead from ${dayOf(recentKnown.at)} (within ${windowDays} days)` };

  // A lead id on the contact that Supabase does not have: its date is unknown
  // unless LP live names it.
  const ghlId = String(ghlLeadId || '').trim();
  const ghlUnknown = ghlId && !known.some((l) => l.lead_id === ghlId);

  if (!liveRead) return { verdict: 'need_live', lead: null, why: 'no recent lead in Supabase; ask LP' };
  if (liveError) return { verdict: 'unverified', lead: null, why: `LP lookup failed: ${liveError}` };

  if (live && live.ldsId) {
    const t = ms(live.createdAtLp);
    const lead = { kind: 'lead', lead_id: String(live.ldsId), prospect_id: live.prospectId ? String(live.prospectId) : null, at: live.createdAtLp || null };
    if (recent(t)) return { verdict: 'reuse', lead, why: `LP lead from ${dayOf(lead.at)} (within ${windowDays} days)` };
  }
  if (ghlUnknown && !(live && String(live.ldsId) === ghlId)) {
    // Neither Supabase nor LP's phone search can date it: treat it as new
    // (never a duplicate on a guess).
    return { verdict: 'reuse', lead: { kind: 'lead', lead_id: ghlId, prospect_id: null, at: null }, why: 'the GHL contact carries an LP lead we could not date' };
  }
  const newestOld = (live && live.ldsId) ? { kind: 'lead', lead_id: String(live.ldsId), prospect_id: live.prospectId ? String(live.prospectId) : null, at: live.createdAtLp || null }
    : known[0] ? strip(known[0]) : null;
  if (newestOld) {
    return { verdict: 'create_returning', lead: newestOld, why: `returning caller: newest LP lead is from ${dayOf(newestOld.at)}, older than ${windowDays} days` };
  }
  return { verdict: 'create', lead: null, why: 'no LP lead for this phone' };
}

function strip(l) {
  const { t, ...rest } = l;
  return rest;
}
function dayOf(at) {
  const t = ms(at);
  return t == null ? 'an unknown date' : new Date(t).toISOString().slice(0, 10);
}

/**
 * Read everything decideLeadMatch needs for one phone, cheapest first, and
 * only ask LP live when Supabase and the queue have not already settled it.
 * Never throws: a failed read is `unverified`.
 *
 * deps: runSQL, findExistingLpLead (LP live by phone → newest lead or null)
 */
export async function readLeadMatch({ phone10, callAtMs, ghlLeadId = '' }, deps = {}) {
  const q = (x) => `'${String(x).replace(/'/g, "''")}'`;
  let supabaseLeads;
  let openInquiries;
  try {
    const rows = await deps.runSQL(`
      SELECT lp_lead_id::text AS lp_lead_id, lp_prospect_id::text AS lp_prospect_id,
             ((created_at_lp AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York') AS created_at_lp
        FROM lp_leads
       WHERE lp_deleted_at IS NULL
         AND (right(regexp_replace(coalesce(phone, ''::text), '[^0-9]'::text, ''::text, 'g'::text), 10) = ${q(phone10)}
              OR right(regexp_replace(coalesce(phone_alt, ''), '\\D', '', 'g'), 10) = ${q(phone10)}
              ${ghlLeadId ? `OR lp_lead_id::text = ${q(ghlLeadId)}` : ''})
       ORDER BY created_at_lp DESC NULLS FIRST
       LIMIT 20`);
    if (!Array.isArray(rows)) throw new Error('lp_leads read returned no row set');
    supabaseLeads = rows;
    const inq = await deps.runSQL(`
      SELECT in1_id, cst_id, received_at_lp FROM lp_inbound_queue
       WHERE phone10 = ${q(phone10)} AND checkout_at_lp IS NULL AND coalesce(kill_reason, '') = ''
       ORDER BY received_at_lp DESC NULLS LAST LIMIT 5`);
    if (!Array.isArray(inq)) throw new Error('lp_inbound_queue read returned no row set');
    openInquiries = inq;
  } catch (err) {
    return { verdict: 'unverified', lead: null, why: `lead match read failed: ${err.message}` };
  }

  const first = decideLeadMatch({ callAtMs, supabaseLeads, openInquiries, ghlLeadId });
  if (first.verdict !== 'need_live') return first;

  let live = null;
  let liveError = null;
  try {
    live = await deps.findExistingLpLead(phone10);
  } catch (err) {
    liveError = err.message || String(err);
  }
  return decideLeadMatch({ callAtMs, supabaseLeads, openInquiries, ghlLeadId, live, liveError, liveRead: true });
}
