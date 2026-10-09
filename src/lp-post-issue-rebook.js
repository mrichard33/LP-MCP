// ─── Post-issue rebook: new LP lead instead of re-setting an issued one ──────
// src/lp-post-issue-rebook.js
//
// WHY: Reece Training Manual pp. 22–24 — never reschedule within a lead that
// has been issued/run. The rule itself (what "post-issue" means, which newer
// lead wins, how attribution is mirrored) is pure and lives in
// src/lp-post-issue.js. This file does the reads and the one write path.
//
// WHERE IT RUNS: right before both LP SetAppointment calls in the repo —
// syncAppointmentToLP (src/lp-appointment-sync.js: the GHL webhook, the
// set_lp_appointment MCP tool, the parity watchdog) and executeSetLPAppointment
// (src/actions/handlers/lp-appointment.js: the set_lp_appointment action,
// create_lp_lead's reuse paths, the inbound-checkout watch). Every LP
// SetAppointment in src/ goes through one of the two.
//
// MODES (LP_POST_ISSUE_NEW_LEAD_MODE, default shadow — CANON.STD.015: creating
// an LP lead is irreversible, so go-live is Mark's decision)
//   off     nothing here runs.
//   shadow  the full decision runs READ-ONLY, one lp.post_issue_rebook event per
//           booking and one #ops-alerts line per decision that live would have
//           changed; then the caller behaves exactly as before.
//   live    a post-issue lead never takes the SetAppointment; see postIssueGate.
//
// AS FEW PEOPLE AS POSSIBLE (Mark, 2026-10-09: "limit depending on a person to
// need to input a lead"). The new lead goes STRAIGHT to LP's addLead, built from
// LP's own prospect record — not through GHL workflow 8e30ff37, whose "Source ID
// and Pro ID" gate and GHL field writes made a person necessary whenever a
// promoter was missing. A promoter that cannot be matched goes out blank (Mark's
// ruling, same day); a Sub-Source falls back through two more sources
// (resolveSubSource). A read or a send that fails is retried by
// src/jobs/post-issue-rebook-retry.js; #contact-center hears only after 3
// attempts or 2 hours. Left for a person: no Sub-Source anywhere, a prospect
// with no name or phone, LP down for hours, and checking the new inquiry out in
// LP (LP has no import API; inbound-checkout-watch already watches that).
//
// FAILS CLOSED (CANON.RULE.069): in live, a lead that cannot be read or a
// disposition in neither list never takes the SetAppointment.
//
// SIDE EFFECTS (live, CANON.STD.014): one idempotency claim in
// lp_appointment_sync_marks before anything; before a re-send, LP's inbound
// queue is checked for the row a "failed" send may still have created.

import {
  postIssueMode, isPostIssueLead, appointmentOnLead, pickNewerLead, issuedSinceMs,
  pendingInboundRow, parsePromoterCatalog, resolveAttribution, ghlTime12h, rebookKey,
  buildRebookLeadFields,
} from './lp-post-issue.js';
import { assertNotTransposed } from './lp-source-ids.js';
import { lpStoredToUtcMs } from './lp-dates.js';

export const POST_ISSUE_AUDIT = 'lp_post_issue_rebook';
export const EVENT_TYPE = 'lp.post_issue_rebook';

// The GHL field create_lp_lead writes the new inquiry's id into; the LP inbound
// callback and the inbound-checkout watch link the issued lds from it.
const FIELD_LP_INBOUND_LEAD_ID = '3YMxheIlPyhACB8zyc3W';

// Read by I.LP-A's exit branch: without it I.LP-A sees no lp-appt-synced and
// enrolls 8e30ff37 from the GHL side, a second lead for the same booking.
const DEFERRED_TAG = 'lp-appt-deferred';

/** Failures the retry job tries again before anyone is asked. */
export const RETRYABLE = new Set(['post_issue_check_failed', 'post_issue_send_failed']);

const CATALOG_TTL_MS = 60 * 60 * 1000;
let catalogCache = null;
export function __resetPostIssueCacheForTests() { catalogCache = null; }

const clean = (v) => (v == null ? '' : String(v).trim());
const isGhlContactId = (id) => Boolean(clean(id)) && !/^\d+$/.test(clean(id));

async function defaults() {
  const [{ default: supabase }, lp, ghl, slack, alerts, posted, events] = await Promise.all([
    import('./supabase.js'), import('./lp-client.js'), import('./ghl.js'), import('./slack.js'),
    import('./alert-state.js'), import('./alert-posted.js'), import('./event-emitter.js'),
  ]);
  return {
    supabase,
    getLeadByLdsId: lp.getLeadByLdsId,
    getProspectByCstId: lp.getProspectByCstId,
    getPromoters: () => lp.getLeadsSourceSubPromoter('p'),
    getInboundLeadInfo: lp.getInboundLeadInfo,
    addLead: lp.addLead,
    extractInboundLeadId: lp.extractInboundLeadId,
    updateGHLContactFields: ghl.updateGHLContactFields,
    addGHLNote: ghl.addGHLNote,
    applyGHLTag: ghl.applyGHLTag,
    postToSlack: slack.postToSlack,
    opsChannelId: slack.opsChannelId,
    sendAlertMessage: alerts.sendAlertMessage,
    filterNew: posted.filterNew,
    recordPosted: posted.recordPosted,
    emitEvent: events.emitEvent,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

async function withDeps(deps = {}) {
  // Only load the production modules a test did not replace.
  const needed = ['supabase', 'getLeadByLdsId', 'emitEvent', 'addLead'].some((k) => !deps[k]);
  return needed ? { ...(await defaults()), ...deps } : deps;
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/** LP's GetLead answer (prospect envelope) → flat lead list, each carrying its prospect. */
function liveLeads(resp) {
  const prospects = Array.isArray(resp) ? resp : Array.isArray(resp?.data) ? resp.data : [];
  const out = [];
  for (const p of prospects) {
    const prospect = {
      cst_id: clean(p?.cst_id), firstname: p?.firstname, lastname: p?.lastname, address1: p?.address1,
      city: p?.city, state: p?.state, zip: p?.zip, phone1: p?.phone1, email: p?.email,
    };
    for (const l of (Array.isArray(p?.leads) ? p.leads : [])) {
      out.push({ ...l, lp_lead_id: clean(l.id ?? l.lds_id), lp_prospect_id: clean(p.cst_id), phone: clean(p.phone1), created_at_lp: l.dateentered, prospect });
    }
  }
  return out;
}

function fromDbRow(r) {
  if (!r) return null;
  return { ...r, appointments: r.raw_lp_data?.appointments, srs_id: r.raw_lp_data?.srs_id, in1_id: r.raw_lp_data?.in1_id };
}

/**
 * The resolved lead from lp_leads AND LP live. Both are asked unless lp_leads
 * already says post-issue: lp_leads lags LP by a sync cycle, and a lead issued
 * since would otherwise read as pre-issue. Never throws.
 */
export async function readLeadForGate(ldsId, d) {
  const out = { db: { ok: false, lead: null }, live: { ok: false, lead: null } };
  try {
    const { data, error } = await d.supabase.from('lp_leads')
      .select('lp_lead_id, lp_prospect_id, disposition_code, raw_lp_data, created_at_lp, lead_source, lead_source_detail, promoter_name, phone, ghl_contact_id')
      .eq('lp_lead_id', String(ldsId)).maybeSingle();
    if (error) throw new Error(error.message);
    out.db = { ok: true, lead: fromDbRow(data) };
  } catch (err) {
    out.db = { ok: false, lead: null, error: err.message };
  }
  if (out.db.lead && isPostIssueLead(out.db.lead).postIssue) return out;
  try {
    const leads = liveLeads(await d.getLeadByLdsId(String(ldsId), { fast: true }));
    out.live = { ok: true, lead: leads.find((l) => l.lp_lead_id === String(ldsId)) || null };
  } catch (err) {
    out.live = { ok: false, lead: null, error: err.message };
  }
  return out;
}

/** Combine the two reads into one verdict. Pure. */
export function gateVerdict(reads, knownDisposition) {
  const { db, live } = reads;
  if (!db.ok && !live.ok) return { failed: true, reason: 'lead_unreadable' };
  // lp_leads had no row and LP live could not answer: "could not tell".
  if (!db.lead && !live.ok) return { failed: true, reason: 'lead_unreadable' };
  const dbV = db.lead ? isPostIssueLead(db.lead, { knownDisposition }) : null;
  const liveV = live.lead ? isPostIssueLead(live.lead, { knownDisposition }) : null;
  const hit = [liveV, dbV].find((v) => v?.postIssue);
  // The live record carries the freshest appointments; lp_leads the columns.
  const lead = live.lead || db.lead
    ? { ...(db.lead || {}), ...(live.lead || {}), lp_lead_id: clean(db.lead?.lp_lead_id || live.lead?.lp_lead_id) }
    : null;
  if (hit) return { ...hit, lead };
  const v = liveV || dbV || isPostIssueLead(null, { knownDisposition });
  return { ...v, lead };
}

/** Every lead on the prospect (lp_leads + LP live), and LP's prospect record when live answered. */
async function readProspectLeads(prospectId, d) {
  if (!prospectId) return { ok: false, error: 'no_prospect_id' };
  let live = null;
  try { live = liveLeads(await d.getProspectByCstId(String(prospectId), { fast: true })); } catch { /* lp_leads may answer */ }
  try {
    const { data, error } = await d.supabase.from('lp_leads')
      .select('lp_lead_id, lp_prospect_id, disposition_code, raw_lp_data, created_at_lp')
      .eq('lp_prospect_id', String(prospectId));
    if (error) throw new Error(error.message);
    const byId = new Map((data || []).map(fromDbRow).map((l) => [l.lp_lead_id, l]));
    for (const l of live || []) byId.set(l.lp_lead_id, { ...(byId.get(l.lp_lead_id) || {}), ...l });
    return { ok: true, leads: [...byId.values()], prospect: live?.[0]?.prospect || null };
  } catch (err) {
    if (live) return { ok: true, leads: live, prospect: live[0]?.prospect || null };
    return { ok: false, error: `lp_leads: ${err.message}; LP live unreadable` };
  }
}

async function readInboundRows(phone10, d) {
  if (!phone10) return { ok: true, rows: [] };
  try {
    const { data, error } = await d.supabase.from('lp_inbound_queue')
      .select('in1_id, received_at_lp, checkout_at_lp, lds_id, kill_reason, method, phone10, srs_id, lognumber')
      .eq('phone10', phone10);
    if (error) throw new Error(error.message);
    return { ok: true, rows: data || [] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function readOne(table, column, value, select, d) {
  try {
    const { data, error } = await d.supabase.from(table).select(select).eq(column, String(value));
    if (error) return null;
    return data || [];
  } catch {
    return null;
  }
}

async function promoterCatalog(d, nowMs) {
  if (catalogCache && nowMs - catalogCache.at < CATALOG_TTL_MS) return catalogCache.rows;
  try {
    const rows = parsePromoterCatalog(await d.getPromoters());
    if (!rows.length) return null;
    catalogCache = { at: nowMs, rows };
    return rows;
  } catch {
    return null;
  }
}

const phone10 = (p) => clean(p).replace(/\D/g, '').slice(-10);

/**
 * Did LP already take a lead for this person since `sinceMs`? addLead is not
 * idempotent and a timeout does not mean it failed, so a re-send asks first:
 * our mirror of LP's inbound queue by phone, then LP live by lognumber.
 * @returns {Promise<{ sent: boolean, in1_id?: string, unknown?: boolean }>}
 */
async function alreadySent({ phone, contactId, sinceMs }, d) {
  const after = (ms) => Number.isFinite(ms) && ms >= sinceMs - 2 * 60_000;
  const mirror = await readInboundRows(phone10(phone), d);
  const hit = (mirror.rows || []).find((r) => after(Date.parse(clean(r.received_at_lp))) && !clean(r.kill_reason));
  if (hit) return { sent: true, in1_id: clean(hit.in1_id) };
  if (!isGhlContactId(contactId)) return { sent: false, unknown: !mirror.ok };
  try {
    const resp = await d.getInboundLeadInfo({ lognumber: contactId }, { fast: true });
    const rows = Array.isArray(resp) ? resp : Array.isArray(resp?.data) ? resp.data : [];
    const row = rows.find((r) => after(lpStoredToUtcMs(clean(r?.datereceived).replace(/(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/, 'Z'))));
    return row ? { sent: true, in1_id: clean(row.id ?? row.in1_id) } : { sent: false };
  } catch {
    return { sent: false, unknown: !mirror.ok };
  }
}

// ─── Record + escalate ──────────────────────────────────────────────────────

function ghlLink(contactId, env) {
  const loc = env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';
  return `https://app.gohighlevel.com/v2/location/${loc}/contacts/detail/${contactId}`;
}

const NEW_LEAD_TODO = 'In LP, create a NEW lead under this prospect with the same Source and Sub-Source as the issued lead (Promoter too, if it has one), and set the appointment on it.';
const OUTCOME_TEXT = {
  post_issue_check_failed: {
    why: 'After several tries we still could not tell whether the LP lead was already issued, so nothing was written.',
    todo: 'Check the lead in LP. If it was issued, create a NEW lead under this prospect with the same Source and Sub-Source and set the appointment on it; if not, set the appointment on the lead.',
  },
  post_issue_send_failed: {
    why: 'The lead was already issued, and LP would not take the new lead after several tries.',
    todo: NEW_LEAD_TODO,
  },
  post_issue_needs_manual_lead: {
    why: 'The lead was already issued, and the new lead cannot be sent automatically.',
    todo: NEW_LEAD_TODO,
  },
};

/** One #contact-center card (live) or one #ops-alerts line (shadow), once per key. */
export function formatPostIssueCard(r, env = process.env) {
  const t = OUTCOME_TEXT[r.outcome] || { why: r.outcome, todo: 'Check the lead in LP.' };
  const lines = [
    r.mode === 'live' ? '🧾 *LP lead needs a person: appointment on an issued lead*' : `🕶️ *Post-issue rule (shadow): live would have done ${r.would_do || r.outcome}*`,
    `👤 ${r.contact_name || r.contact_id}${r.phone ? ` · ${r.phone}` : ''}`,
    `🆔 Prospect ${r.lp_prospect_id || '?'} · issued lead ${r.issued_lead_id || '?'} (${r.issued_disposition || 'no disposition'}, ${r.issued_reason || '?'})`,
    `📅 Requested: ${r.appt_date || '?'} ${r.appt_time || ''}`.trim(),
    `Reason: ${r.reason || r.outcome}`,
  ];
  if (r.in1_id) lines.push(`Inbound inquiry: ${r.in1_id}`);
  if (r.srs_id || r.pro_id) lines.push(`Attribution: srs_id ${r.srs_id || '?'} / pro_id ${r.pro_id || 'none'}`);
  if (r.mode === 'live') {
    if (r.attempts) lines.push(`Tried ${r.attempts} time(s) automatically.`);
    lines.push(`What happened: ${t.why} No appointment was written to the issued lead.`);
    lines.push(`👉 ${t.todo}`);
  } else {
    lines.push(`Today's path ran unchanged (${r.caller}).`);
  }
  if (isGhlContactId(r.contact_id)) lines.push(ghlLink(r.contact_id, env));
  return lines.join('\n');
}

export async function record(r, d) {
  await Promise.resolve(d.emitEvent({
    event_type: EVENT_TYPE,
    event_subtype: r.mode === 'live' ? r.outcome : `shadow_${r.outcome}`,
    source: 'lp_mcp',
    entity_type: 'contact',
    entity_id: String(r.contact_id),
    ghl_contact_id: isGhlContactId(r.contact_id) ? r.contact_id : null,
    lp_lead_id: r.issued_lead_id || null,
    lp_prospect_id: r.lp_prospect_id || null,
    priority: 'normal',
    // This type has no consuming rule; without bypass_filter the intake filter
    // drops it (same precedent as lp.appointment_defer_pending_inbound).
    bypass_filter: true,
    idempotency_key: `${r.idempotency_key || `post-issue:${r.contact_id}:${r.issued_lead_id}`}:${r.mode}:${r.outcome}:${d.nowMs ?? Date.now()}`,
    payload: r,
  })).catch((err) => console.warn(`[LP-POST-ISSUE] event write failed: ${err.message}`));
}

/**
 * Live: a card only for what needs a person — a lead that cannot be sent
 * automatically, or a retryable failure the retry job gave up on (r.gave_up).
 * Shadow: one #ops-alerts line per decision live would change.
 */
export async function notify(r, d) {
  const live = r.mode === 'live';
  if (live && !(r.outcome === 'post_issue_needs_manual_lead' || (r.gave_up && RETRYABLE.has(r.outcome)))) {
    return { posted: false, reason: 'not_escalated' };
  }
  const env = d.env || process.env;
  const channel = live ? clean(env.SLACK_CHANNEL_SERVICE) : clean(d.opsChannelId?.());
  const items = [{ key: r.idempotency_key || `${r.contact_id}:${r.issued_lead_id}:${r.appt_date}:${r.appt_time}`, reason: `${r.mode}:${live ? 'needs_person' : r.outcome}` }];
  try {
    const { fresh } = await d.filterNew({ audit: POST_ISSUE_AUDIT, items, ttlDays: 30 });
    if (!fresh.length) return { posted: false, reason: 'already_posted' };
    const res = channel
      ? await Promise.resolve(d.postToSlack(formatPostIssueCard(r, env), channel)).catch((err) => ({ ok: false, error: err.message }))
      : { ok: false, error: live ? 'SLACK_CHANNEL_SERVICE unset' : 'SLACK_CHANNEL_OPS unset' };
    if (res?.ok) {
      await d.recordPosted({ audit: POST_ISSUE_AUDIT, items });
      console.log(`[LP-POST-ISSUE] ${live ? '#contact-center card' : 'shadow line'} posted: ${r.outcome} for ${r.contact_id}`);
      return { posted: true };
    }
    // A missing card looks like a quiet night (CLAUDE.md), so say so in #ops.
    if (live) {
      await Promise.resolve(d.sendAlertMessage(
        `⚠️ Could not post the post-issue LP card to #contact-center (${res?.error || 'unknown'}). ` +
        `Contact ${r.contact_id}, issued lead ${r.issued_lead_id}: ${r.outcome}.`, { channel: 'ops' },
      )).catch(() => {});
    } else {
      console.warn(`[LP-POST-ISSUE] shadow line not posted (${res?.error || 'unknown'})`);
    }
    return { posted: false, reason: 'post_failed', error: res?.error || null };
  } catch (err) {
    console.warn(`[LP-POST-ISSUE] notify failed: ${err.message}`);
    return { posted: false, reason: 'error', error: err.message };
  }
}

// ─── Idempotency claim (CANON.STD.014) ──────────────────────────────────────

async function claim(keyStr, r, d) {
  try {
    const { error } = await d.supabase.from('lp_appointment_sync_marks').insert({
      dedup_key: keyStr, contact_id: r.contact_id, lds_id: r.issued_lead_id,
      appt_date: r.appt_date, appt_time: r.appt_time, created_at: new Date(d.nowMs ?? Date.now()).toISOString(),
    });
    if (!error) return { claimed: true };
    if (String(error.code) === '23505' || /duplicate key/i.test(error.message || '')) return { claimed: false, duplicate: true };
    return { claimed: false, error: error.message };
  } catch (err) {
    return { claimed: false, error: err.message };
  }
}

async function release(keyStr, d) {
  try {
    const { error } = await d.supabase.from('lp_appointment_sync_marks').delete().eq('dedup_key', keyStr);
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    console.warn(`[LP-POST-ISSUE] could not release claim ${keyStr}: ${err.message}`);
    return false;
  }
}

/** Live events already recorded for this key, oldest first. */
export async function eventsForKey(keyStr, d) {
  try {
    const { data } = await d.supabase.from('system_events')
      .select('payload, created_at').eq('event_type', EVENT_TYPE)
      .eq('payload->>idempotency_key', keyStr).eq('payload->>mode', 'live')
      .order('created_at', { ascending: true });
    return (data || []).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  } catch {
    return [];
  }
}

/** The outcome a previous run recorded for this key (the event is the record). */
async function recordedOutcome(keyStr, d) {
  const rows = (await eventsForKey(keyStr, d)).filter((e) => e.payload?.outcome !== 'post_issue_rebook_duplicate');
  return rows.at(-1)?.payload || null;
}

// ─── Step 3: the new lead ───────────────────────────────────────────────────

/**
 * Plan the rebook: a newer lead, a waiting inquiry, or the new lead's body.
 * Read-only: shadow runs exactly this.
 */
export async function planRebook({ issuedLead, phone, contactId, appointmentDate, appointmentTime, issuedDisposition }, d) {
  const prospect = await readProspectLeads(issuedLead.lp_prospect_id, d);
  if (!prospect.ok) return { outcome: 'post_issue_check_failed', retryable: true, reason: `prospect_leads_unreadable: ${prospect.error}` };
  const newer = pickNewerLead(issuedLead, prospect.leads);
  if (newer) return { outcome: 'used_newer_lead', newer_lead_id: clean(newer.lp_lead_id) };

  const inbound = await readInboundRows(phone10(phone || issuedLead.phone), d);
  if (!inbound.ok) return { outcome: 'post_issue_check_failed', retryable: true, reason: `inbound_queue_unreadable: ${inbound.error}` };
  const pending = pendingInboundRow(inbound.rows, issuedSinceMs(issuedLead));
  if (pending) return { outcome: 'newer_lead_pending_in_inbound_queue', in1_id: clean(pending.in1_id), reason: 'inbound_inquiry_waiting' };

  // Sub-Source fallbacks are read only when the lead's own srs_id is unusable.
  const srsId = issuedLead.srs_id ?? issuedLead.raw_lp_data?.srs_id;
  const needFallback = !/^\d{3}$/.test(clean(srsId)) || clean(srsId) === '000';
  const attribution = resolveAttribution({
    srsId,
    leadSource: issuedLead.lead_source ?? issuedLead.source,
    leadSourceDetail: issuedLead.lead_source_detail ?? issuedLead.sourcesubdescr,
    sourceCatalog: needFallback ? await readOne('lp_source_catalog', 'active', 'true', 'lp_source_id, lp_source_raw, lp_source_subdetail, active', d) : null,
    inboundSrs: needFallback && issuedLead.in1_id
      ? (await readOne('lp_inbound_queue', 'in1_id', issuedLead.in1_id, 'srs_id', d))?.[0]?.srs_id
      : null,
    promoterName: issuedLead.promoter_name ?? issuedLead.promotername ?? issuedLead.raw_lp_data?.promotername,
    catalog: await promoterCatalog(d, d.nowMs ?? Date.now()),
    assertNotTransposed,
  });
  if (!attribution.ok) return { outcome: 'post_issue_needs_manual_lead', reason: attribution.reason };

  const prospectRecord = prospect.prospect || issuedLead.prospect || null;
  if (!prospectRecord) return { outcome: 'post_issue_check_failed', retryable: true, reason: 'prospect_record_unreadable' };
  const fields = buildRebookLeadFields({
    prospect: prospectRecord, srsId: attribution.srsId, proId: attribution.proId,
    dateYmd: appointmentDate, timeHHMM: appointmentTime,
    contactId: isGhlContactId(contactId) ? contactId : issuedLead.ghl_contact_id,
    issuedLeadId: issuedLead.lp_lead_id, issuedDisposition,
    product: issuedLead.productid,
  });
  if (!fields) return { outcome: 'post_issue_needs_manual_lead', reason: 'prospect_has_no_name_or_phone' };
  return {
    outcome: 'post_issue_new_lead_sent', srs_id: attribution.srsId, srs_source: attribution.srsSource,
    pro_id: attribution.proId, promoter_status: attribution.promoterStatus, fields,
  };
}

/** Live: claim → plan → (already sent?) → addLead → GHL bookkeeping. */
export async function createLeadForPostIssueRebook({ contactId, issuedLead, appointmentDate, appointmentTime, phone, base }, d) {
  const keyStr = base.idempotency_key;
  const r = { ...base };

  const c = await claim(keyStr, r, d);
  if (c.duplicate) {
    const prior = await recordedOutcome(keyStr, d);
    console.log(`[LP-POST-ISSUE] ${keyStr} already claimed — recorded outcome ${prior?.outcome || '(in flight)'}`);
    return { ...r, outcome: 'post_issue_rebook_duplicate', recorded_outcome: prior?.outcome || null, newer_lead_id: prior?.newer_lead_id || null, in1_id: prior?.in1_id || null };
  }
  if (!c.claimed) return { ...r, outcome: 'post_issue_check_failed', retryable: true, reason: `idempotency_claim_failed: ${c.error}` };

  const plan = await planRebook({ issuedLead, phone, contactId, appointmentDate, appointmentTime, issuedDisposition: base.issued_disposition }, d);
  const { fields, ...planInfo } = plan;
  if (plan.outcome !== 'post_issue_new_lead_sent') {
    // A newer lead and a waiting inquiry are settled answers: keep the claim so a
    // re-fire returns them. Anything that stopped for want of data releases it.
    if (plan.outcome === 'post_issue_check_failed' || plan.outcome === 'post_issue_needs_manual_lead') await release(keyStr, d);
    return { ...r, ...planInfo };
  }
  Object.assign(r, planInfo);

  // A send that "failed" may still have reached LP. Before a re-send, look.
  const prior = (await eventsForKey(keyStr, d)).filter((e) => e.payload?.outcome === 'post_issue_send_failed');
  if (prior.length) {
    const check = await alreadySent({ phone: fields.phone, contactId, sinceMs: Date.parse(prior[0].created_at) }, d);
    if (check.sent) return finishSent({ ...r, in1_id: check.in1_id || null, found_after_failed_send: true }, { contactId, issuedLead, appointmentDate, appointmentTime }, d);
    if (check.unknown) {
      await release(keyStr, d);
      return { ...r, outcome: 'post_issue_send_failed', retryable: true, reason: 'previous_send_unverifiable' };
    }
  }

  let resp;
  try {
    resp = await d.addLead(fields);
  } catch (err) {
    await release(keyStr, d);
    return { ...r, outcome: 'post_issue_send_failed', retryable: true, reason: `add_lead_failed: ${String(err.message).slice(0, 200)}` };
  }
  return finishSent({ ...r, in1_id: d.extractInboundLeadId?.(resp) || null, lp_path: resp?._path || null }, { contactId, issuedLead, appointmentDate, appointmentTime }, d);
}

async function finishSent(r, { contactId, issuedLead, appointmentDate, appointmentTime }, d) {
  if (isGhlContactId(contactId)) {
    if (r.in1_id) {
      await Promise.resolve(d.updateGHLContactFields(contactId, [{ id: FIELD_LP_INBOUND_LEAD_ID, field_value: r.in1_id }])).catch(() => {});
    }
    await Promise.resolve(d.applyGHLTag(contactId, DEFERRED_TAG)).catch(() => {});
    await Promise.resolve(d.addGHLNote(contactId,
      `[LP SYNC] Lead ${issuedLead.lp_lead_id} was already issued (${r.issued_disposition || 'issued'}). ` +
      `New LP lead sent for ${appointmentDate} ${ghlTime12h(appointmentTime) || appointmentTime}` +
      `${r.in1_id ? ` (inquiry ${r.in1_id})` : ''}, Sub-Source ${r.srs_id}, Promoter ${r.pro_id || 'none'}. Per call-center rule.`,
    )).catch(() => {});
  }
  return { ...r, outcome: 'post_issue_new_lead_sent' };
}

// ─── The gate ───────────────────────────────────────────────────────────────

/**
 * Ask before an LP SetAppointment. Never throws.
 *
 * @param {object} o
 * @param {string} o.caller            which SetAppointment path ('sync_appointment_to_lp', …)
 * @param {string} o.contactId         GHL contact id, or an LP lead id when the target is one
 * @param {string} o.ldsId             the resolved LP lead
 * @param {string} [o.prospectId]
 * @param {string} [o.knownDisposition] the resolver's disposition
 * @param {string} o.appointmentDate   YYYY-MM-DD
 * @param {string} o.appointmentTime   HH:MM (24h)
 * @param {boolean} [o.requireBookable] the parity watchdog: never creates leads
 * @param {boolean} [o.ghlContact=true] false when the target is a bare LP lead id
 * @param {string} [o.contactName]
 * @param {string} [o.phone]
 * @returns {Promise<{ proceed: true, ldsId?: string, post_issue?: object }
 *                 | { proceed: false, result: object }>}
 */
export async function postIssueGate(o, deps = {}) {
  const d = await withDeps(deps);
  const env = d.env || process.env;
  const mode = postIssueMode(env);
  if (mode === 'off') return { proceed: true };

  const nowMs = d.nowMs ?? Date.now();
  // Callers hand over 'H:MM' or 'HH:MM'; LP's rows read 'HH:MM'.
  const t = /^(\d{1,2}):(\d{2})/.exec(clean(o.appointmentTime));
  o = { ...o, appointmentTime: t ? `${t[1].padStart(2, '0')}:${t[2]}` : clean(o.appointmentTime) || null };
  const ghlContact = o.ghlContact !== false && isGhlContactId(o.contactId);
  const base = {
    mode, caller: o.caller, contact_id: o.contactId, contact_name: o.contactName || null, phone: o.phone || null,
    ghl_contact: ghlContact, known_disposition: o.knownDisposition || null,
    issued_lead_id: String(o.ldsId), lp_prospect_id: o.prospectId || null,
    appt_date: o.appointmentDate || null, appt_time: o.appointmentTime || null,
    idempotency_key: rebookKey({ contactId: o.contactId, issuedLeadId: o.ldsId, dateYmd: o.appointmentDate, timeHHMM: o.appointmentTime }),
    srs_id: null, pro_id: null,
  };

  try {
    let reads = await readLeadForGate(o.ldsId, d);
    let verdict = gateVerdict(reads, o.knownDisposition);
    if (verdict.failed && d.sleep) {
      // One quick second try: most LP read failures are a blip.
      await d.sleep(2000);
      reads = await readLeadForGate(o.ldsId, d);
      verdict = gateVerdict(reads, o.knownDisposition);
    }
    const lead = verdict.lead;
    Object.assign(base, {
      lp_prospect_id: base.lp_prospect_id || lead?.lp_prospect_id || null,
      issued_disposition: verdict.disposition || o.knownDisposition || null,
      issued_reason: verdict.reason,
    });

    // Not post-issue: the normal booking. Recorded so shadow can say how many
    // bookings the gate saw.
    if (!verdict.failed && !verdict.ambiguous && !verdict.postIssue) {
      await record({ ...base, outcome: 'pre_issue_proceed' }, d);
      return { proceed: true };
    }

    let r;
    if (verdict.failed || verdict.ambiguous) {
      r = { ...base, outcome: 'post_issue_check_failed', retryable: true, reason: verdict.failed ? verdict.reason : `${verdict.reason}: ${verdict.disposition}` };
    } else if (appointmentOnLead(lead, o.appointmentDate, o.appointmentTime)) {
      // The issued appointment itself, re-sent. Not a rebook.
      r = { ...base, outcome: 'same_appointment_on_issued_lead', reason: 'appointment_already_on_lead' };
    } else if (o.requireBookable) {
      r = { ...base, outcome: 'skipped_post_issue_lead', reason: 'watchdog_never_creates_leads' };
    } else if (o.appointmentDate && o.appointmentDate < new Date(nowMs - 5 * 3600_000).toISOString().slice(0, 10)) {
      r = { ...base, outcome: 'skipped_post_issue_lead', reason: 'appointment_in_the_past' };
    } else if (mode === 'shadow') {
      const { fields, ...plan } = await planRebook({
        issuedLead: { ...lead, lp_lead_id: String(o.ldsId) }, phone: o.phone, contactId: o.contactId,
        appointmentDate: o.appointmentDate, appointmentTime: o.appointmentTime, issuedDisposition: base.issued_disposition,
      }, d);
      r = { ...base, ...plan };
    } else {
      r = await createLeadForPostIssueRebook({
        contactId: o.contactId, issuedLead: { ...lead, lp_lead_id: String(o.ldsId) },
        appointmentDate: o.appointmentDate, appointmentTime: o.appointmentTime, phone: o.phone, base,
      }, d);
    }

    if (mode === 'shadow') {
      await record(r, d);
      // Only a decision that changes behaviour gets a line; the issued
      // appointment re-sent is a no-op either way.
      if (r.outcome !== 'same_appointment_on_issued_lead') await notify({ ...r, would_do: r.outcome }, d);
      console.log(`[LP-POST-ISSUE] 🕶️ shadow ${o.caller}: lead ${o.ldsId} ${base.issued_reason} → live would ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`);
      return { proceed: true, post_issue: { mode, outcome: r.outcome } };
    }

    // Live.
    await record(r, d);
    if (r.outcome === 'used_newer_lead' || (r.outcome === 'post_issue_rebook_duplicate' && r.recorded_outcome === 'used_newer_lead' && r.newer_lead_id)) {
      console.log(`[LP-POST-ISSUE] lead ${o.ldsId} issued — setting the appointment on newer lead ${r.newer_lead_id}`);
      return { proceed: true, ldsId: r.newer_lead_id, post_issue: { mode, outcome: 'used_newer_lead', issued_lead_id: String(o.ldsId) } };
    }
    await notify(r, d);
    // Every refusal that leaves the booking for us or a person to finish holds
    // I.LP-A off its own 8e30ff37 fallback (a second, unattributed lead).
    if (ghlContact && r.outcome !== 'same_appointment_on_issued_lead' && r.outcome !== 'skipped_post_issue_lead') {
      await Promise.resolve(d.applyGHLTag(o.contactId, DEFERRED_TAG)).catch(() => {});
    }
    console.warn(`[LP-POST-ISSUE] ⛔ ${o.caller}: lead ${o.ldsId} is post-issue (${base.issued_reason}) → ${r.outcome}${r.reason ? ` (${r.reason})` : ''} — no SetAppointment on it`);
    return { proceed: false, result: resultFor(r, o) };
  } catch (err) {
    // An unexpected error is "could not tell" (CANON.RULE.069): live refuses
    // (and the retry job tries again), shadow records it and runs today's path.
    const r = { ...base, outcome: 'post_issue_check_failed', retryable: true, reason: `gate_error: ${err.message}` };
    await record(r, d);
    if (mode === 'shadow') return { proceed: true, post_issue: { mode, outcome: r.outcome } };
    return { proceed: false, result: resultFor(r, o) };
  }
}

function resultFor(r, o) {
  const sent = r.outcome === 'post_issue_new_lead_sent'
    || (r.outcome === 'post_issue_rebook_duplicate' && r.recorded_outcome === 'post_issue_new_lead_sent');
  return {
    success: sent || r.outcome === 'same_appointment_on_issued_lead',
    action: r.outcome === 'same_appointment_on_issued_lead' ? 'already_set_in_lp' : r.outcome,
    contact_id: o.contactId,
    issued_lead_id: String(o.ldsId),
    lp_lead_id: String(o.ldsId),
    lp_prospect_id: r.lp_prospect_id,
    issued_disposition: r.issued_disposition,
    issued_reason: r.issued_reason,
    reason: r.reason || null,
    retryable: Boolean(r.retryable),
    in1_id: r.in1_id || null,
    srs_id: r.srs_id || null,
    srs_source: r.srs_source || null,
    pro_id: r.pro_id || null,
    promoter_status: r.promoter_status || null,
    idempotency_key: r.idempotency_key || null,
    recorded_outcome: r.recorded_outcome || null,
    post_issue_outcome: r.outcome,
  };
}
