// ─── Post-issue LP lead rule (pure) — src/lp-post-issue.js ───────────────────
//
// WHY (Reece Training Manual pp. 22–24, handoff 2026-10-09)
//   "Never reschedule within the same lead after it has been issued/run." A lead
//   that LP has issued to a sales rep is a finished visit. A new appointment for
//   that person is a NEW LP lead under the same prospect, carrying the issued
//   lead's Source / Sub-Source / Promoter; or, when a newer lead was already
//   inbounded since, that newer lead.
//
//   Before this, a GHL booking or reschedule re-set whatever lead the resolver
//   landed on: Issue, NoHome, 1Leg, NIS, CCC, NOC, No Demo and Rep Reset leads all
//   took a SetAppointment (terminalDispositionDecision allows them on purpose).
//   Prospect 158825 / LP lead 190599 (2026-10-09) carries four appointment rows,
//   the last one issued to a rep and then CCC; one more GHL reschedule would have
//   become a fifth row on that lead.
//
// WHAT THIS FILE IS
//   The decision only. No I/O, so every branch is a unit test. The reads, the
//   new-lead path, events and Slack live in src/lp-post-issue-rebook.js.
//
// HOW "POST-ISSUE" IS DECIDED, in order
//   1. LP's own issued flag: any appointment row with issued = "true", or the
//      lead's everissued = "true". That is LP saying a rep was sent.
//   2. Otherwise the disposition (the lead's, or the one the caller resolved
//      live) is in POST_ISSUE_DISPOSITIONS.
//   3. Otherwise a disposition in PRE_ISSUE_DISPOSITIONS is pre-issue.
//   A blank disposition with no appointment history is a lead minted minutes
//   ago: unknown_new_lead, and the normal booking proceeds. A disposition in
//   NEITHER list is ambiguous and fails closed in live mode (CANON.RULE.069).
//
// CCC and Reset stay on the post-issue list. Measured on lp_leads 2026-10-09:
// of the CCC leads that carry appointment history, 933 of 938 have an issued
// row; Reset 126 of 126, NIS 157 of 157, NOC 137 of 137. The low overall ratios
// (CCC 933 of 4,414) are leads whose appointment history was never copied,
// not pre-issue leads. CCC in the manual is "customer called in to cancel".

import { lpStoredToUtcMs } from './lp-dates.js';

/** Case-insensitive; compare through isPostIssueDisposition / isPreIssueDisposition. */
export const POST_ISSUE_DISPOSITIONS = Object.freeze([
  'Issue', 'Issued', 'NOC', 'Sale', 'CCC', 'NoHome', '1Leg', 'OPPFDN',
  'Rep Reset', 'RepReset', 'Reset', 'NIS', 'NIS2', 'NoRehash', 'No Demo',
  'NoDemo', 'FDNS', 'SW', 'PM',
]);

export const PRE_ISSUE_DISPOSITIONS = Object.freeze([
  'Data', 'Set', 'Verif', 'Cnf', 'CNF', 'CXL', 'ND', 'DNC',
]);

const key = (v) => String(v ?? '').trim().toUpperCase();
const POST_SET = new Set(POST_ISSUE_DISPOSITIONS.map(key));
const PRE_SET = new Set(PRE_ISSUE_DISPOSITIONS.map(key));
const clean = (v) => (v == null ? '' : String(v).trim());
const truthy = (v) => v === true || clean(v).toLowerCase() === 'true';

export function isPostIssueDisposition(d) { return POST_SET.has(key(d)); }
export function isPreIssueDisposition(d) { return PRE_SET.has(key(d)); }

/** off | shadow | live. Anything unknown is shadow: the safe, observing default. */
export function postIssueMode(env = process.env) {
  const m = clean(env.LP_POST_ISSUE_NEW_LEAD_MODE).toLowerCase();
  return m === 'off' || m === 'live' ? m : 'shadow';
}

/**
 * The appointment rows on a lead. Reads an lp_leads row (raw_lp_data.appointments)
 * or a live LP lead record (appointments); tolerates a JSON string.
 */
export function appointmentsOf(lead) {
  let a = lead?.appointments ?? lead?.raw_lp_data?.appointments;
  if (typeof a === 'string') {
    try { a = JSON.parse(a); } catch { a = null; }
  }
  return Array.isArray(a) ? a : [];
}

function leadDisposition(lead) {
  return clean(lead?.disposition_code ?? lead?.disposition ?? lead?.Disposition ?? lead?.raw_lp_data?.disposition);
}

function everIssued(lead) {
  return truthy(lead?.everissued) || truthy(lead?.raw_lp_data?.everissued);
}

/**
 * @param {object|null} lead  lp_leads row or live LP lead record
 * @param {object} [o]
 * @param {string} [o.knownDisposition]  what the caller resolved (often live LP)
 * @returns {{ postIssue: boolean, ambiguous?: boolean, reason: string, disposition: string|null }}
 */
export function isPostIssueLead(lead, { knownDisposition = null } = {}) {
  const known = clean(knownDisposition);
  if (!lead && !known) return { postIssue: false, reason: 'unknown_new_lead', disposition: null };

  const appts = appointmentsOf(lead);
  const disp = leadDisposition(lead) || known;
  if (appts.some((a) => truthy(a?.issued)) || everIssued(lead)) {
    return { postIssue: true, reason: 'lp_issued_flag', disposition: disp || null };
  }
  // Either reading says post-issue → post-issue. lp_leads can lag LP by a sync
  // cycle, and the caller's disposition is usually the live one.
  for (const d of [leadDisposition(lead), known]) {
    if (d && isPostIssueDisposition(d)) return { postIssue: true, reason: 'post_issue_disposition', disposition: d };
  }
  if (!disp && !appts.length) return { postIssue: false, reason: 'unknown_new_lead', disposition: null };
  if (!disp || isPreIssueDisposition(disp)) return { postIssue: false, reason: 'pre_issue', disposition: disp || null };
  return { postIssue: false, ambiguous: true, reason: 'unrecognised_disposition', disposition: disp };
}

/** 'YYYY-MM-DD' and 'HH:MM' from LP's wall-clock apptdate ("2026-10-09T18:00:00"). */
function lpWallClockParts(raw) {
  const m = /^(\d{4}-\d{2}-\d{2})[T\s](\d{2}):(\d{2})/.exec(clean(raw));
  return m ? { date: m[1], time: `${m[2]}:${m[3]}` } : null;
}

/**
 * True when this exact date and time is already an appointment row on the lead.
 * Then the "booking" is a re-sync of the appointment that was issued (a webhook
 * re-fire, the parity watchdog), not a rebook, and must never mint a new lead.
 */
export function appointmentOnLead(lead, dateYmd, timeHHMM) {
  if (!dateYmd || !timeHHMM) return false;
  const rows = appointmentsOf(lead).map((a) => lpWallClockParts(a?.apptdate));
  const top = lpWallClockParts(lead?.apptdate ?? lead?.raw_lp_data?.apptdate);
  return [...rows, top].some((p) => p && p.date === dateYmd && p.time === timeHHMM);
}

/**
 * True UTC ms from an LP time. LP sends Eastern wall clock with no offset, and
 * lp_leads stores the same digits tagged +00:00; both are read as wall clock
 * (offset dropped) and converted, so they compare with lp_inbound_queue's
 * received_at_lp, which is already true UTC.
 */
function wallMs(raw) {
  const s = clean(raw);
  if (!s) return NaN;
  const ms = lpStoredToUtcMs(s.length <= 10 ? `${s}T00:00:00Z` : s.replace(/(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/, 'Z'));
  return Number.isFinite(ms) ? ms : NaN;
}

function leadIdOf(lead) {
  return clean(lead?.lp_lead_id ?? lead?.id ?? lead?.lds_id);
}

function leadCreatedMs(lead) {
  return wallMs(lead?.created_at_lp ?? lead?.dateentered ?? lead?.raw_lp_data?.dateentered ?? lead?.entrydate);
}

/**
 * The newest lead on the same prospect that was entered after the issued lead
 * and is not itself post-issue (manual: "a newer lead was already inbounded since
 * the issued one → use that newer lead"). null when there is none, or when the
 * issued lead's entry time cannot be read (no guessing which is newer).
 */
export function pickNewerLead(issuedLead, prospectLeads) {
  const issuedId = leadIdOf(issuedLead);
  const since = leadCreatedMs(issuedLead);
  if (!Number.isFinite(since)) return null;
  const candidates = (prospectLeads || [])
    .filter((l) => leadIdOf(l) && leadIdOf(l) !== issuedId)
    .filter((l) => Number.isFinite(leadCreatedMs(l)) && leadCreatedMs(l) > since)
    .filter((l) => {
      const v = isPostIssueLead(l);
      return !v.postIssue && !v.ambiguous;
    })
    .sort((a, b) => leadCreatedMs(b) - leadCreatedMs(a));
  return candidates[0] || null;
}

/**
 * When the issued lead was issued, for "inbounded since": the latest issued
 * appointment's date, else the lead's entry time.
 */
export function issuedSinceMs(issuedLead) {
  const issued = appointmentsOf(issuedLead)
    .filter((a) => truthy(a?.issued))
    .map((a) => wallMs(a?.apptdate))
    .filter(Number.isFinite);
  return issued.length ? Math.max(...issued) : leadCreatedMs(issuedLead);
}

/**
 * A lp_inbound_queue row still waiting to be checked out (the is_waiting test in
 * sql/149) and received after `sinceMs`. Our own new-lead push lands here too,
 * so a second reschedule finds it and does not create another lead.
 */
export function pendingInboundRow(rows, sinceMs) {
  const waiting = (rows || []).filter((r) => !r?.checkout_at_lp && !clean(r?.lds_id)
    && !clean(r?.kill_reason) && clean(r?.method) !== 'X');
  const after = waiting.filter((r) => {
    const ms = Date.parse(clean(r?.received_at_lp));
    return !Number.isFinite(sinceMs) || (Number.isFinite(ms) && ms > sinceMs);
  });
  after.sort((a, b) => Date.parse(clean(b.received_at_lp)) - Date.parse(clean(a.received_at_lp)));
  return after[0] || null;
}

/** LP's promoter catalog (GetLeadsSourceSubPromoter type 'p') → [{ id, name }]. */
export function parsePromoterCatalog(resp) {
  const rows = Array.isArray(resp) ? resp : Array.isArray(resp?.rows) ? resp.rows : Array.isArray(resp?.data) ? resp.data : [];
  return rows
    .map((r) => ({ id: clean(r?.key ?? r?.id), name: clean(r?.value ?? r?.name) }))
    .filter((r) => r.id && r.name);
}

const nameKey = (s) => clean(s).replace(/\s+/g, ' ').toLowerCase();

/**
 * Mirror the issued lead's attribution. CERTAIN or nothing: an srs_id that is
 * not a 3-digit LP SubSource, a promoter that LP's own catalog does not name
 * exactly once, or a pro_id that is not 4 digits all stop the new lead. Never
 * the chatbot fallbacks (830 / 5574) that ensureLpSourceAndProId would supply:
 * a lead written under the wrong source can only be fixed by hand in LP.
 *
 * @param {object} o
 * @param {string} o.srsId          the issued lead's srs_id (raw_lp_data.srs_id)
 * @param {string} o.promoterName   the issued lead's promoter, as LP prints it
 * @param {Array<{id,name}>|null} o.catalog  parsePromoterCatalog output; null = unreadable
 * @param {Function} o.assertNotTransposed   from src/lp-source-ids.js
 * @returns {{ ok: true, srsId, proId } | { ok: false, reason }}
 */
export function resolveAttribution({ srsId, promoterName, catalog, assertNotTransposed }) {
  const srs = clean(srsId);
  if (!/^\d{3}$/.test(srs) || srs === '000') return { ok: false, reason: 'srs_id_missing_or_not_3_digit' };
  const promoter = clean(promoterName);
  if (!promoter) return { ok: false, reason: 'no_promoter_on_issued_lead' };
  if (!Array.isArray(catalog)) return { ok: false, reason: 'promoter_catalog_unreadable' };
  const hits = catalog.filter((p) => nameKey(p.name) === nameKey(promoter));
  const ids = [...new Set(hits.map((h) => h.id))];
  if (!ids.length) return { ok: false, reason: 'promoter_not_in_lp_catalog' };
  if (ids.length > 1) return { ok: false, reason: 'promoter_name_ambiguous' };
  const pro = ids[0];
  if (!/^\d{4}$/.test(pro)) return { ok: false, reason: 'pro_id_not_4_digit' };
  try {
    assertNotTransposed?.(srs, pro);
  } catch {
    return { ok: false, reason: 'attribution_transposed' };
  }
  return { ok: true, srsId: srs, proId: pro };
}

/** 'h:mm AM' — the shape GHL's own calendar writes into the appointment time field. */
export function ghlTime12h(timeHHMM) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(clean(timeHHMM));
  if (!m) return null;
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** The idempotency key for one rebook (CANON.STD.014). */
export function rebookKey({ contactId, issuedLeadId, dateYmd, timeHHMM }) {
  return `post-issue-rebook:${contactId}:${issuedLeadId}:${dateYmd}:${timeHHMM}`;
}
