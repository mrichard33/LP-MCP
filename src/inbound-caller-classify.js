// ─── Inbound Caller Capture — the labels — src/inbound-caller-classify.js ────
//
// Pure and dependency-free (CLAUDE.md, "Alerting"): every input is passed in,
// so the label order is unit-testable without GHL, Five9 or Supabase. The job
// that calls it (src/jobs/inbound-caller-capture.js) owns every read.
//
// WHAT
//   A new caller who talked 2+ minutes with an agent but never became an LP lead
//   (v_new_callers_no_lp_30d, sql/127) gets ONE label. First match wins:
//
//     dnc                Five9 DNC, or a GHL opt-out tag. Never touched.
//     not_a_lead         the call said this is not a sales lead: a refusal
//                        disposition, or the Main Number line. Never touched.
//     unmapped_number    a sales call to a number with no LP source on file
//                        (src/inbound-capture-source.js). Listed, never sent:
//                        it would reach LP under the chatbot's source.
//     unverified         a read we needed failed (GHL search, GHL contact, LP
//                        job lookup). Could not tell — never actioned, never
//                        counted as a candidate.
//     already_in_lp      the race: an LP lead with this phone arrived after the
//                        view ran, or the GHL contact already carries an LP
//                        Lead ID.
//     existing_customer  GHL contact tagged as a customer, or it has an LP job.
//     has_ghl_contact    candidate — enroll the existing contact.
//     no_ghl_contact     candidate — create the contact, then enroll.
//
// WHY `unverified` SITS SECOND, NOT LAST (2026-09-27)
//   A GHL read that failed looks exactly like "no contact". Labelled
//   no_ghl_contact, it would CREATE a second contact for someone who already
//   has one — and, worse, for someone whose existing contact carries `dnc`.
//   The only thing a failed read may never do is act, so it is decided right
//   after the one label that needs no GHL read (Five9 DNC).
//
// WHY THE DNC TAG LIST IS WIDER THAN THE HANDOFF'S FOUR
//   The handoff named dnc / dnc-sms / stage:dnc / stop-bot. The consent family
//   in src/services/suppression-check.js (REPLY_BLOCKING_TAGS) also carries
//   dnc-related, do-not-contact, unsubscribed, and appointment-parity-watchdog
//   adds lp-dnc. Missing one of those would create an LP lead — and so a dial —
//   for somebody who opted out. Over-matching only costs a capture.

export const LABELS = Object.freeze([
  'dnc', 'not_a_lead', 'unmapped_number', 'unverified', 'already_in_lp', 'existing_customer', 'has_ghl_contact', 'no_ghl_contact',
]);

// WHY not_a_lead (2026-10-12)
//   The view (sql/127) keeps every 2+ minute call with no LP lead, and the
//   labels never looked at what the call SAID. Of 113 shadow candidates, 42 were
//   Not Interested (20), Cant Do Project (7), Below Minimum (7), Kicked (6) or
//   Out of Area (2): each would have become an LP lead that sales then dials.
//   43 were on "Main Number", the line missed-caller recovery already excludes
//   because it mixes service calls and existing customers (decided 2026-09-23).
//
//   An ALLOW list, not a deny list: a disposition this list has never seen is
//   not a lead. A missed capture costs one lead; a wrong one costs an LP lead,
//   a dial and a confused customer.
export const LEAD_DISPOSITIONS = Object.freeze([
  'Appointment Set',
  'Callback',
  'Reset',
  // A 2+ minute call that ended without a verdict: the conversation may have
  // been real, and these are what the capture exists for.
  'Hung Up',
  'Caller Disconnected',
  'NA',
  'No Disposition',
  'Abandon',
  'Sent To Voicemail',
]);
// Mixes service calls and existing customers. An appointment set there is still a lead.
export const NON_SALES_CAMPAIGNS = Object.freeze(['Main Number']);

const LEAD_DISPO_SET = new Set(LEAD_DISPOSITIONS.map((d) => d.toLowerCase()));
const NON_SALES_SET = new Set(NON_SALES_CAMPAIGNS.map((c) => c.toLowerCase()));

/**
 * Pure. Is this call a sales lead by what it said? `null` when it is,
 * otherwise the reason it is not.
 */
export function notALeadReason({ disposition, campaign } = {}) {
  const dispo = String(disposition ?? '').trim();
  const camp = String(campaign ?? '').trim();
  if (NON_SALES_SET.has(camp.toLowerCase()) && !isAppointmentSet(dispo)) {
    return `"${camp}" line (service calls and existing customers)`;
  }
  if (!LEAD_DISPO_SET.has(dispo.toLowerCase())) {
    return dispo ? `disposition "${dispo}" is not a sales lead` : 'no disposition recorded';
  }
  return null;
}
export const CANDIDATE_LABELS = Object.freeze(['has_ghl_contact', 'no_ghl_contact']);

// 2026-10-07: stop-bot left this list. It turns the BOT off; it is not a
// DNC (the user's ruling), so a caller who carries it is still captured and
// dialed like anyone else.
export const DNC_TAGS = Object.freeze([
  'dnc', 'dnc-sms', 'stage:dnc',
  'dnc-related', 'do-not-contact', 'unsubscribed', 'lp-dnc',
]);
// src/actions/service-card.js SOLD_TAGS — the tags that mean "already bought".
export const CUSTOMER_TAGS = Object.freeze([
  'customer', 'deal-won', 'closed-won', 'lp-status:closed-won', 'sw-customer',
]);
// GHL "LP Lead ID" (src/ghl-field-map.js). Set = LP already has this person.
export const LP_LEAD_ID_FIELD = 'GmAVmW6V9sekD7pVONKr';

const DNC_SET = new Set(DNC_TAGS);
const CUSTOMER_SET = new Set(CUSTOMER_TAGS);

/**
 * Caller phone → 10 digits, the same rule the view uses
 * (right(regexp_replace(ani,'\D','','g'),10)): strip everything but digits and
 * keep the last ten. Fewer than ten digits is no phone at all.
 */
export function normalizeCallerPhone(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

export function isCandidate(label) {
  return CANDIDATE_LABELS.includes(label);
}

/** "Appointment Set" and its variants. The one disposition that is money on the table. */
export function isAppointmentSet(disposition) {
  return /appointment\s*set/i.test(String(disposition ?? ''));
}

function tagsOf(contact) {
  return (Array.isArray(contact?.tags) ? contact.tags : [])
    .map((t) => String(t ?? '').trim().toLowerCase())
    .filter(Boolean);
}

/** A GHL custom field, whichever shape the contact came back in. '' when blank. */
export function readCustomField(contact, id) {
  for (const list of [contact?.customFields, contact?.customField]) {
    if (!Array.isArray(list)) continue;
    const hit = list.find((f) => f && (f.id === id || f.fieldId === id));
    const v = hit?.value ?? hit?.field_value;
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/**
 * One label, first match wins.
 *
 * @param {object} caller   a view row; `caller` is the phone
 * @param {object} ctx
 *   five9Dnc     Set<phone10> on the Five9 DNC list (the read must have succeeded)
 *   lpPhones     Set<phone10> with an lp_leads row NOW (the race check)
 *   ghl          { status: 'found' | 'none' | 'error', contact }
 *   lpJob        { status: 'yes' | 'no' | 'error' } — only read when a contact exists
 * @returns {{ label: string, why: string }}
 */
export function classifyCaller(caller, ctx = {}) {
  const phone = normalizeCallerPhone(caller?.caller ?? caller?.caller_phone);
  if (!phone) return { label: 'unverified', why: 'no usable phone' };

  const ghl = ctx.ghl || { status: 'error' };
  const contact = ghl.status === 'found' ? ghl.contact : null;
  const tags = tagsOf(contact);

  if (ctx.five9Dnc?.has(phone)) return { label: 'dnc', why: 'on the Five9 DNC list' };
  const dncTag = tags.find((t) => DNC_SET.has(t));
  if (dncTag) return { label: 'dnc', why: `GHL tag ${dncTag}` };

  // Decided from the call itself, before any GHL read: nothing GHL holds can
  // turn a refusal into a lead. `ctx.notALead` lets the job apply the
  // caller's NEWEST call to every row of that caller.
  const notLead = ctx.notALead !== undefined ? ctx.notALead : notALeadReason(caller);
  if (notLead) return { label: 'not_a_lead', why: notLead };
  // 2026-10-12: no LP source for the number called → listed, never sent.
  if (ctx.noSource) return { label: 'unmapped_number', why: ctx.noSource };

  if (ghl.status === 'error' || (ghl.status === 'found' && !contact?.id)) {
    return { label: 'unverified', why: 'GHL lookup failed' };
  }

  if (ctx.lpPhones?.has(phone)) return { label: 'already_in_lp', why: 'an LP lead with this phone now exists' };
  const lpLeadId = readCustomField(contact, LP_LEAD_ID_FIELD);
  // lead-id-ok: classifier reason, the daily post prints counts only
  if (lpLeadId) return { label: 'already_in_lp', why: `GHL contact carries LP lead ${lpLeadId}` };

  const soldTag = tags.find((t) => CUSTOMER_SET.has(t));
  if (soldTag) return { label: 'existing_customer', why: `GHL tag ${soldTag}` };
  if (contact) {
    if (ctx.lpJob?.status === 'yes') return { label: 'existing_customer', why: 'has an LP job' };
    if (ctx.lpJob?.status !== 'no') return { label: 'unverified', why: 'LP job lookup failed' };
    return { label: 'has_ghl_contact', why: 'GHL contact, no LP lead' };
  }
  return { label: 'no_ghl_contact', why: 'no GHL contact, no LP lead' };
}

/**
 * The counts the daily Slack post and the dry-run endpoint print. One caller is
 * counted once — by their newest call — however many times they rang.
 */
export function summarizeCallers(rows) {
  const newest = new Map();
  for (const r of rows || []) {
    const prev = newest.get(r.caller_phone);
    if (!prev || Date.parse(r.call_at) > Date.parse(prev.call_at)) newest.set(r.caller_phone, r);
  }
  const people = [...newest.values()];
  const byLabel = Object.fromEntries(LABELS.map((l) => [l, 0]));
  const byTeam = {};
  let appointmentsSet = 0;
  for (const r of people) {
    byLabel[r.label] = (byLabel[r.label] || 0) + 1;
    const team = r.team || 'unmapped';
    byTeam[team] = byTeam[team] || { callers: 0, candidates: 0 };
    byTeam[team].callers += 1;
    if (isCandidate(r.label)) byTeam[team].candidates += 1;
    if (isAppointmentSet(r.disposition)) appointmentsSet += 1;
  }
  return {
    calls: (rows || []).length,
    callers: people.length,
    candidates: people.filter((r) => isCandidate(r.label)).length,
    appointments_set: appointmentsSet,
    by_label: byLabel,
    by_team: byTeam,
  };
}

const MODE_LINE = {
  off: 'OFF — nothing runs',
  shadow: 'SHADOW — nothing was created',
  approval: 'APPROVAL — each capture waits for a person',
  live: 'LIVE — leads are created automatically',
};

/** The daily ops post. Plain text; the Slack mirror renders it as-is. */
export function formatDailySummary({ runDate, mode, summary, actioned = null }) {
  const s = summary;
  const b = s.by_label;
  const teams = Object.entries(s.by_team)
    .sort((a, b2) => b2[1].callers - a[1].callers)
    .map(([team, t]) => `${team} ${t.callers} (${t.candidates} to capture)`)
    .join(' · ');
  const lines = [
    `📞 Inbound callers with no LP lead — ${runDate} (last 30 days)`,
    `Mode: ${MODE_LINE[mode] || mode}`,
    `Callers found: ${s.callers} (${s.calls} calls of 2+ min) · appointments set: ${s.appointments_set}`,
    `To capture: ${s.candidates} — has GHL contact ${b.has_ghl_contact}, no GHL contact ${b.no_ghl_contact}`,
    `Left alone: DNC ${b.dnc} · not a lead ${b.not_a_lead} · number with no LP source ${b.unmapped_number} · already in LP ${b.already_in_lp} · existing customer ${b.existing_customer}`
      + (b.unverified ? ` · could not check ${b.unverified}` : ''),
    `By team: ${teams || 'none'}`,
  ];
  if (actioned) {
    lines.push(`Last 24h: ${actioned.queued} queued for approval · ${actioned.created} leads created · ${actioned.failed} failed`);
  }
  return lines.join('\n');
}
