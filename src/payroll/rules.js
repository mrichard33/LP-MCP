// ─── Payroll rules — src/payroll/rules.js ────────────────────────────────────
//
// PURE. No I/O, no project imports beyond the pure date helper, so every rule
// that decides a dollar amount is testable offline
// (scripts/test-payroll-engine.js). The job (src/jobs/payroll-engine.js) owns
// the reads, the writes and the Slack post.
//
// WHERE THE EVENTS COME FROM (ruled 2026-09-26)
//   The handoff named LP report 134 as the only source, but 134 carries sold
//   jobs at the RTP milestone and nothing else: no confirmations, no demos, no
//   lead dates, no source, no setter, no lead id. So:
//     - lp_leads is the source for every pay event;
//     - 134 supplies ONLY the net amount (and net date) for the 1.5% rule.
//
// WHO IS LIGHTFIRE
//   An LF agent carries "- LF" in the last-name part of LP's "Last, First"
//   name. Live spellings vary in spacing: "Deer - LF, Craig",
//   "Edwards-LF, Monique", "Gray-LF, Romeala". An exact-string list would
//   miss the next hire, so this is a pattern.
//
// "No, Setter" IS NOT A CANVASS MARKER (ruled 2026-09-26)
//   It means the appointment arrived pre-set with no phone setter. About 2/3
//   are canvass; the rest are vendor pre-sets (Lead Gurus, MVP Marketing,
//   Prolific). Canvass is identified by lead_source only. A canvass lead with
//   no setter goes to review and is never skipped; a non-canvass one earns no
//   setter pay and is not flagged.
//
// MONEY IS INTEGER CENTS. The only fractional input is pay_rules.pct, which is
// turned into integer millionths before it touches a cent value.

import crypto from 'node:crypto';
import { lpStoredToUtcMs } from '../lp-dates.js';

export const TZ = 'America/New_York';
export const DEFAULT_AGED_DAYS = 30;
export const PAYEE_LIGHTFIRE = 'lightfire';
export const PAYEE_CALL_CENTER = 'call_center';
export const EVENT_CANVASS_CONFIRM = 'canvass_confirmed_appt';
export const EVENT_DEMO = 'completed_demo';
export const EVENT_DIRECT_NET = 'direct_job_net';
export const CANVASS_SOURCES = Object.freeze(['Canvass', 'Canvass Sticky']);
export const NO_SETTER = 'No, Setter';
// `info` (2026-09-27): a $0 row the partner should SEE but nobody needs to act
// on — a new-lead demo, which is paid through the 1.5% when the job nets.
export const STATUSES = Object.freeze(['pending', 'needs_review', 'disputed', 'excluded', 'info', 'approved', 'paid']);
/** Lines that count toward the payable total. needs_review / disputed never do. */
export const PAYABLE = Object.freeze(['pending', 'approved', 'paid']);

const DAY_MS = 24 * 60 * 60 * 1000;
const LF_RE = /\s*-\s*LF\s*,/i;

export function isLightFireAgent(name) {
  return typeof name === 'string' && LF_RE.test(name);
}

export function isCanvassLead(lead) {
  return CANVASS_SOURCES.includes(String(lead?.lead_source ?? '').trim());
}

/** "No, Setter" or nothing recorded at all — both mean no phone agent is on file. */
export function isNoAgent(name) {
  const n = String(name ?? '').trim();
  return n === '' || n === NO_SETTER;
}

export function agedDays(env = process.env) {
  const n = Number.parseInt(env.PAYROLL_AGED_DAYS, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_AGED_DAYS;
}

/* ─── dates ──────────────────────────────────────────────────────────────── */

const etFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** ET calendar date (YYYY-MM-DD) of a true instant. */
export function etDate(d = new Date()) {
  return etFmt.format(d);
}

/**
 * ET calendar date of an LP-stored timestamp. lp_leads keeps LP's Eastern
 * wall-clock time tagged +00:00 (src/lp-dates.js), so the value is converted
 * to true UTC first and then read back in Eastern. Plain `YYYY-MM-DD` values
 * (134's rtp_date) pass through unchanged.
 */
export function lpEtDate(stored) {
  if (stored == null || stored === '') return null;
  if (typeof stored === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(stored)) return stored;
  const ms = lpStoredToUtcMs(stored);
  return ms == null ? null : etDate(new Date(ms));
}

/** Whole calendar days from one YYYY-MM-DD to another (b − a). */
export function daysBetween(a, b) {
  if (!a || !b) return null;
  const ms = Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / DAY_MS) : null;
}

export function addDays(ymd, n) {
  const d = new Date(Date.parse(`${ymd}T12:00:00Z`) + n * DAY_MS);
  return d.toISOString().slice(0, 10);
}

/**
 * The previous Monday–Sunday in America/New_York, as calendar dates.
 * Worked in calendar dates rather than instants, so a DST change inside the
 * week (or on the Sunday it ends) cannot shift a boundary by an hour into the
 * neighbouring day.
 */
export function previousWeekET(now = new Date()) {
  const today = etDate(now);
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  const sinceMonday = (dow + 6) % 7;
  const thisMonday = addDays(today, -sinceMonday);
  return { start: addDays(thisMonday, -7), end: addDays(thisMonday, -1) };
}

/**
 * Query bounds for an LP-stored timestamp column: [start 00:00, end+1 00:00)
 * in the stored (ET wall-clock, +00:00-tagged) form, so the filter stays
 * index-eligible without converting every row.
 */
export function lpStoredBounds(period) {
  return { gte: `${period.start}T00:00:00+00:00`, lt: `${addDays(period.end, 1)}T00:00:00+00:00` };
}

/** First day of every calendar month the period touches. */
export function monthsTouched(period) {
  const out = [];
  let m = `${period.start.slice(0, 7)}-01`;
  const last = `${period.end.slice(0, 7)}-01`;
  while (m <= last) {
    out.push(m);
    const [y, mo] = m.split('-').map(Number);
    m = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`;
  }
  return out;
}

/* ─── money ──────────────────────────────────────────────────────────────── */

/**
 * pct × cents, rounded half up to the cent, in integer arithmetic. pct is
 * turned into millionths first (0.0150 → 15000) so float error in the rate
 * can never move a cent.
 */
export function applyPct(cents, pct) {
  const c = Math.trunc(Number(cents));
  const micro = Math.round(Number(pct) * 1e6);
  if (!Number.isFinite(c) || !Number.isFinite(micro)) return 0;
  const sign = c < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(c) * micro + 500000) / 1e6);
}

export function formatCents(cents) {
  const n = Math.trunc(Number(cents) || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

/* ─── identity ───────────────────────────────────────────────────────────── */

/** sha256(payee|lead_id|event_type|event_date) — the ledger's idempotency key. */
export function lineKey(payee, leadId, eventType, eventDate) {
  return crypto.createHash('sha256').update(`${payee}|${leadId}|${eventType}|${eventDate}`).digest('hex');
}

/* ─── events ─────────────────────────────────────────────────────────────── */

/**
 * Is this event LightFire's to be paid (or visibly excluded) for?
 *   - an LF agent → yes
 *   - an excluded (AI) agent → yes, so the exclusion SHOWS in the ledger
 *   - an in-house Reece agent → no, it is not LightFire's event
 *   - no agent on file:
 *       canvass CONFIRMATION → yes, to review: an appointment was confirmed
 *         and nobody is recorded as confirming it — the data does not match up
 *       a demo or a net (set-based) → no. Ruled 2026-09-27: a canvass
 *         appointment arrives pre-set ("No, Setter"), LightFire did not set it
 *         and already earns $15 for confirming it. A vendor pre-set is not
 *         LightFire's either. Neither earns a line.
 */
export function isLightFireCandidate(agent, lead, excluded, { setBased = true } = {}) {
  if (isLightFireAgent(agent)) return true;
  if (excluded?.has?.(String(agent ?? '').trim())) return true;
  if (isNoAgent(agent)) return !setBased && isCanvassLead(lead);
  return false;
}

function baseEvent(lead, eventType, agent, eventDate, extra = {}) {
  return {
    payee: PAYEE_LIGHTFIRE,
    event_type: eventType,
    lp_lead_id: String(lead.lp_lead_id),
    campaign: lead.lead_source ?? null,
    agent_name: isNoAgent(agent) ? (String(agent ?? '').trim() || null) : String(agent).trim(),
    event_date: eventDate,
    lead_created_date: lpEtDate(lead.created_at_lp),
    set_date: lpEtDate(lead.set_date),
    no_agent: isNoAgent(agent),
    canvass: isCanvassLead(lead),
    ...extra,
  };
}

/**
 * LightFire events for one period.
 *   canvassLeads  lp_leads rows: canvass, confirmed_date in the period
 *   demoLeads     lp_leads rows: ever_sat, demo_date in the period
 *   netJobs       [{ lead, job_number, rtp_date, net_cents }] — 134 rows already
 *                 matched to their lp_leads row
 */
export function buildLightFireEvents({ canvassLeads = [], demoLeads = [], netJobs = [], excluded = new Set(), period }) {
  const inPeriod = (d) => d && (!period || (d >= period.start && d <= period.end));
  const events = [];

  for (const lead of canvassLeads) {
    if (!isCanvassLead(lead)) continue;
    const date = lpEtDate(lead.confirmed_date);
    if (!inPeriod(date)) continue;
    if (!isLightFireCandidate(lead.confirmed_by_name, lead, excluded, { setBased: false })) continue;
    events.push(baseEvent(lead, EVENT_CANVASS_CONFIRM, lead.confirmed_by_name, date));
  }

  for (const lead of demoLeads) {
    if (lead.ever_sat !== true) continue;
    const date = lpEtDate(lead.demo_date);
    if (!inPeriod(date)) continue;
    if (!isLightFireCandidate(lead.set_by_name, lead, excluded)) continue;
    events.push(baseEvent(lead, EVENT_DEMO, lead.set_by_name, date));
  }

  for (const job of netJobs) {
    const lead = job.lead;
    if (!lead) continue;
    const date = lpEtDate(job.rtp_date);
    if (!inPeriod(date)) continue;
    if (!isLightFireCandidate(lead.set_by_name, lead, excluded)) continue;
    events.push(baseEvent(lead, EVENT_DIRECT_NET, lead.set_by_name, date, {
      job_number: job.job_number ?? null,
      basis_cents: Math.trunc(Number(job.net_cents) || 0),
    }));
  }
  return events;
}

/**
 * The key's lead component. A Direct line is per JOB, not per lead: one lead
 * can net two contracts on the same day, and keying on the lead alone would
 * drop the second as a "duplicate" — an under-payment nobody would see.
 */
export function eventLineKey(ev) {
  const leadPart = ev.event_type === EVENT_DIRECT_NET && ev.job_number
    ? `${ev.lp_lead_id}:${ev.job_number}` : ev.lp_lead_id;
  return lineKey(ev.payee, leadPart, ev.event_type, ev.event_date);
}

/* ─── rules ──────────────────────────────────────────────────────────────── */

/**
 * The active rule for this payee/event on this date. A campaign-specific rule
 * beats a catch-all (campaign NULL); among equals the latest effective_from
 * wins.
 */
export function findRule(rules, { payeeType, partnerId, eventType, eventDate, campaign }) {
  const hits = (rules || []).filter((r) => r.active !== false
    && r.payee_type === payeeType
    && (payeeType === 'call_center' || r.partner_id === partnerId)
    && r.event_type === eventType
    && r.effective_from <= eventDate
    && (!r.effective_to || r.effective_to >= eventDate)
    && (r.campaign == null || r.campaign === campaign));
  hits.sort((a, b) => (b.campaign != null) - (a.campaign != null)
    || String(b.effective_from).localeCompare(String(a.effective_from)));
  return hits[0] || null;
}

function ruleAmount(rule, ev) {
  if (rule.pct != null && ev.basis_cents != null) return applyPct(ev.basis_cents, rule.pct);
  return Math.trunc(Number(rule.amount_cents) || 0);
}

/**
 * One event → one ledger line, or null when the event earns no line at all.
 * First match wins:
 *   1. excluded agent (AI setter)            → excluded, $0
 *   2. line_key already paid in another run  → disputed
 *   3. no active rule                        → needs_review, $0
 *   4. age rule, but lead age unknown        → needs_review, $0 (fail closed)
 *   5. new_only rule, lead aged              → null (the demo rule pays it)
 *   6. net amount zero or negative           → needs_review, $0
 *   7. no confirmer on file (canvass)        → needs_review
 *   8. aged_only rule, lead not aged         → info, $0 (not payable, not flagged)
 *   9. rule requires review                  → needs_review, amount computed
 *  10. otherwise                             → pending, amount computed
 *
 * Flag only what does not match up (ruled 2026-09-27). A new-lead demo is not
 * a dispute — nobody billed it at the aged rate; it simply earns the 1.5%
 * instead — so it is an `info` row the partner can see, not a flag.
 *
 * ctx: { rules, partnerId, excluded:Set, paidElsewhere:Map<line_key, run_id>, agedDays }
 */
export function evaluateLine(ev, ctx) {
  const days = ctx.agedDays ?? DEFAULT_AGED_DAYS;
  const key = eventLineKey(ev);
  const base = {
    line_key: key,
    lp_lead_id: ev.lp_lead_id,
    campaign: ev.campaign ?? null,
    agent_name: ev.agent_name ?? null,
    event_type: ev.event_type,
    event_date: ev.event_date,
    lead_created_date: ev.lead_created_date ?? null,
    rule_id: null,
    amount_cents: 0,
    source_report: ev.event_type === EVENT_DIRECT_NET ? '134 Jobs by Milestone Date' : 'lp_leads',
  };
  const line = (status, flag_reason, extra = {}) => ({ ...base, status, flag_reason, ...extra });

  if (ev.agent_name && ctx.excluded?.has?.(ev.agent_name)) return line('excluded', 'AI setter');

  const paidRun = ctx.paidElsewhere?.get?.(key);
  if (paidRun) return line('disputed', `already paid in run ${paidRun}`);

  const rule = findRule(ctx.rules, {
    payeeType: 'partner', partnerId: ctx.partnerId, eventType: ev.event_type,
    eventDate: ev.event_date, campaign: ev.campaign,
  });
  if (!rule) return line('needs_review', 'no rule');
  const withRule = { rule_id: rule.id };

  let aged = null;
  if (rule.lead_age_rule !== 'any') {
    const age = daysBetween(ev.lead_created_date, ev.set_date);
    if (age == null) return line('needs_review', 'lead age unknown (no created or set date)', withRule);
    aged = age >= days;
    if (rule.lead_age_rule === 'new_only' && aged) return null;
  }

  if (ev.event_type === EVENT_DIRECT_NET && !(ev.basis_cents > 0)) {
    return line('needs_review', 'net amount is zero or negative', withRule);
  }

  const amount = ruleAmount(rule, ev);
  if (ev.no_agent) {
    return line('needs_review', 'canvass appointment confirmed with no confirmer recorded — check who confirmed it',
      { ...withRule, amount_cents: amount });
  }
  if (rule.lead_age_rule === 'aged_only' && aged === false) {
    return line('info', 'not payable – new lead (paid 1.5% on net)', withRule);
  }
  if (rule.requires_review) {
    return line('needs_review', 'caller unprovable (LightFire dialer)', { ...withRule, amount_cents: amount });
  }
  return line('pending', null, { ...withRule, amount_cents: amount });
}

/* ─── summaries ──────────────────────────────────────────────────────────── */

function emptyBucket() {
  const b = {};
  for (const s of STATUSES) b[s] = { count: 0, cents: 0 };
  return b;
}

/** Counts and cents per status, overall and per campaign, plus the payable total. */
export function summarizeLines(lines) {
  const total = emptyBucket();
  const byCampaign = new Map();
  for (const l of lines || []) {
    const c = l.campaign || '(no campaign)';
    if (!byCampaign.has(c)) byCampaign.set(c, emptyBucket());
    for (const b of [total, byCampaign.get(c)]) {
      if (!b[l.status]) continue;
      b[l.status].count += 1;
      b[l.status].cents += Math.trunc(Number(l.amount_cents) || 0);
    }
  }
  const payable = PAYABLE.reduce((s, k) => s + total[k].cents, 0);
  return { total, byCampaign: Object.fromEntries(byCampaign), payableCents: payable, lineCount: (lines || []).length };
}

/**
 * Report 135 vs lp_leads. `missing` are 135 lead ids (set or sold) that match
 * no lp_leads row by lp_lead_id OR lp_prospect_id — 135 prints the prospect id
 * for most leads (1,560 of 1,561 "missing" on 2026-09-26 were prospect ids).
 * Returns null when there is nothing to report.
 */
export function describeMissingLeads(check) {
  if (!check) return null;
  if (check.error) return `⚠️ Missing-lead check could not run (${check.error}) — lp_leads coverage NOT verified this week.`;
  const { missingSets = 0, missingSold = 0, sets = 0, sold = 0, window } = check;
  if (!missingSets && !missingSold) return null;
  const w = window ? ` (report 135, ${window.start} – ${window.end})` : '';
  return `⚠️ Possible missing leads - review: ${missingSets} of ${sets} set and ${missingSold} of ${sold} sold leads in report 135 are not in lp_leads${w}. Their pay events cannot be computed until they sync.`;
}
