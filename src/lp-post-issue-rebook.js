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
//   live    a post-issue lead never takes the SetAppointment; see gate().
//
// FAILS CLOSED (CANON.RULE.069): in live, a lead that cannot be read, a
// disposition in neither list, an unreadable prospect / inbound queue / promoter
// catalog / contact, or any doubt about attribution stops the write and asks a
// person in #contact-center (CANON.RULE.059). Nothing here falls back to the
// chatbot 830 / 5574 pair.
//
// SIDE EFFECTS (live, CANON.STD.014): one idempotency claim in
// lp_appointment_sync_marks before anything, the contact's four fields saved
// before they are written, and restored (claim released) when the enroll fails.

import {
  postIssueMode, isPostIssueLead, appointmentOnLead, pickNewerLead, issuedSinceMs,
  pendingInboundRow, parsePromoterCatalog, resolveAttribution, ghlTime12h, rebookKey,
} from './lp-post-issue.js';
import { assertNotTransposed } from './lp-source-ids.js';

export const POST_ISSUE_AUDIT = 'lp_post_issue_rebook';

// GHL fields workflow 8e30ff37 ("Send Lead to Lead Perfection") reads for
// addlead. Verified in the HL mirror 2026-10-09: srs_id = {{contact.lp_source_id}},
// pro_id = {{contact.pro_id}}, adate = Format Date(last_appointment_start_date,
// YYYY-MM-DD → MM/DD/YYYY), atime = {{contact.last_appointment_start_time}}.
export const FIELD = Object.freeze({
  SRS: 'k6j4IBh5IejPooSCsj49',   // LP SubSource, 3-digit
  PRO: 'BbUJ6RrdTjjEqqRA8JVx',   // LP Promoter, 4-digit
  APPT_DATE: 'x8KO5o89WPLfC7ivia3A', // Current (Last) Appointment Start Date
  APPT_TIME: 'U67epWMNqjbf0SHAllEZ', // Current (Last) Appointment Start Time
});

// Read by I.LP-A's exit branch: without it I.LP-A sees no lp-appt-synced and
// enrolls 8e30ff37 from the GHL side with whatever attribution the contact has.
const DEFERRED_TAG = 'lp-appt-deferred';

const ESCALATE = new Set([
  'post_issue_check_failed', 'post_issue_needs_manual_lead',
  'newer_lead_pending_in_inbound_queue', 'post_issue_enroll_failed',
]);

const CATALOG_TTL_MS = 60 * 60 * 1000;
let catalogCache = null;
export function __resetPostIssueCacheForTests() { catalogCache = null; }

const clean = (v) => (v == null ? '' : String(v).trim());

async function defaults() {
  const [{ default: supabase }, lp, ghl, slack, alerts, posted, events, enroll] = await Promise.all([
    import('./supabase.js'), import('./lp-client.js'), import('./ghl.js'), import('./slack.js'),
    import('./alert-state.js'), import('./alert-posted.js'), import('./event-emitter.js'),
    import('./admin/lp-force-addlead.js'),
  ]);
  return {
    supabase,
    getLeadByLdsId: lp.getLeadByLdsId,
    getProspectByCstId: lp.getProspectByCstId,
    getPromoters: () => lp.getLeadsSourceSubPromoter('p'),
    getGHLContact: ghl.getGHLContact,
    updateGHLContactFields: ghl.updateGHLContactFields,
    addGHLNote: ghl.addGHLNote,
    applyGHLTag: ghl.applyGHLTag,
    enrollLpLeadCreation: enroll.enrollLpLeadCreation,
    postToSlack: slack.postToSlack,
    opsChannelId: slack.opsChannelId,
    sendAlertMessage: alerts.sendAlertMessage,
    filterNew: posted.filterNew,
    recordPosted: posted.recordPosted,
    emitEvent: events.emitEvent,
  };
}

async function withDeps(deps = {}) {
  // Only load the production modules a test did not replace.
  const needed = ['supabase', 'getLeadByLdsId', 'emitEvent'].some((k) => !deps[k]);
  return needed ? { ...(await defaults()), ...deps } : deps;
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/** The prospect's leads as LP returns them (GetLead by customer) → flat lead list. */
function liveLeads(resp) {
  const prospects = Array.isArray(resp) ? resp : Array.isArray(resp?.data) ? resp.data : [];
  const out = [];
  for (const p of prospects) {
    for (const l of (Array.isArray(p?.leads) ? p.leads : [])) {
      out.push({ ...l, lp_lead_id: clean(l.id ?? l.lds_id), lp_prospect_id: clean(p.cst_id), phone: clean(p.phone1), created_at_lp: l.dateentered });
    }
  }
  return out;
}

function fromDbRow(r) {
  if (!r) return null;
  return { ...r, appointments: r.raw_lp_data?.appointments, srs_id: r.raw_lp_data?.srs_id };
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
      .select('lp_lead_id, lp_prospect_id, disposition_code, raw_lp_data, created_at_lp, lead_source, lead_source_detail, promoter_name, phone')
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

async function readProspectLeads(prospectId, d) {
  if (!prospectId) return { ok: false, error: 'no_prospect_id' };
  try {
    const { data, error } = await d.supabase.from('lp_leads')
      .select('lp_lead_id, lp_prospect_id, disposition_code, raw_lp_data, created_at_lp')
      .eq('lp_prospect_id', String(prospectId));
    if (error) throw new Error(error.message);
    const dbLeads = (data || []).map(fromDbRow);
    // LP live adds a lead minted since the last sync; best-effort on top.
    let live = [];
    try { live = liveLeads(await d.getProspectByCstId(String(prospectId), { fast: true })); } catch { /* lp_leads answered */ }
    const byId = new Map(dbLeads.map((l) => [l.lp_lead_id, l]));
    for (const l of live) byId.set(l.lp_lead_id, { ...(byId.get(l.lp_lead_id) || {}), ...l });
    return { ok: true, leads: [...byId.values()] };
  } catch (err) {
    try {
      return { ok: true, leads: liveLeads(await d.getProspectByCstId(String(prospectId), { fast: true })) };
    } catch (err2) {
      return { ok: false, error: `${err.message}; live: ${err2.message}` };
    }
  }
}

async function readInboundRows(phone10, d) {
  if (!phone10) return { ok: true, rows: [] };
  try {
    const { data, error } = await d.supabase.from('lp_inbound_queue')
      .select('in1_id, received_at_lp, checkout_at_lp, lds_id, kill_reason, method, phone10')
      .eq('phone10', phone10);
    if (error) throw new Error(error.message);
    return { ok: true, rows: data || [] };
  } catch (err) {
    return { ok: false, error: err.message };
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

function readField(contact, id) {
  const cf = contact?.customFields || contact?.customField || [];
  const hit = Array.isArray(cf) ? cf.find((f) => f?.id === id) : null;
  const v = hit?.value ?? hit?.field_value;
  return v == null ? '' : String(v).trim();
}

// ─── Record + escalate ──────────────────────────────────────────────────────

function ghlLink(contactId, env) {
  const loc = env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';
  return `https://app.gohighlevel.com/v2/location/${loc}/contacts/detail/${contactId}`;
}

const OUTCOME_TEXT = {
  post_issue_check_failed: {
    why: 'We could not tell whether the LP lead was already issued, so nothing was written.',
    todo: 'Check the lead in LP. If it was issued, create a NEW lead under this prospect with the same Source, Sub-Source and Promoter and set the appointment on it; if not, set the appointment on the lead.',
  },
  post_issue_needs_manual_lead: {
    why: 'The lead was already issued, but its Source / Sub-Source / Promoter could not be matched with certainty, so no new lead was created.',
    todo: 'In LP, create a NEW lead under this prospect with the same Source, Sub-Source and Promoter as the issued lead, and set the appointment on it.',
  },
  newer_lead_pending_in_inbound_queue: {
    why: 'The lead was already issued, and a newer inquiry for this phone is waiting in LP\'s inbound queue.',
    todo: 'Check out that inquiry in LP and set the appointment on it. Do not create another lead.',
  },
  post_issue_enroll_failed: {
    why: 'The lead was already issued; sending the new lead to LP failed, and the contact\'s fields were put back.',
    todo: 'In LP, create a NEW lead under this prospect with the same Source, Sub-Source and Promoter as the issued lead, and set the appointment on it.',
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
  if (r.srs_id || r.pro_id) lines.push(`Attribution: srs_id ${r.srs_id || '?'} / pro_id ${r.pro_id || '?'}`);
  if (r.mode === 'live') {
    lines.push(`What happened: ${t.why} No appointment was written to the issued lead.`);
    lines.push(`👉 ${t.todo}`);
  } else {
    lines.push(`Today's path ran unchanged (${r.caller}).`);
  }
  if (r.contact_id && !/^\d+$/.test(String(r.contact_id))) lines.push(ghlLink(r.contact_id, env));
  return lines.join('\n');
}

async function record(r, d) {
  await Promise.resolve(d.emitEvent({
    event_type: 'lp.post_issue_rebook',
    event_subtype: r.mode === 'live' ? r.outcome : `shadow_${r.outcome}`,
    source: 'lp_mcp',
    entity_type: 'contact',
    entity_id: String(r.contact_id),
    ghl_contact_id: /^\d+$/.test(String(r.contact_id)) ? null : r.contact_id,
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

async function notify(r, d) {
  const live = r.mode === 'live';
  if (live && !ESCALATE.has(r.outcome)) return { posted: false, reason: 'not_escalated' };
  const env = d.env || process.env;
  const channel = live ? clean(env.SLACK_CHANNEL_SERVICE) : clean(d.opsChannelId?.());
  const items = [{ key: r.idempotency_key || `${r.contact_id}:${r.issued_lead_id}:${r.appt_date}:${r.appt_time}`, reason: `${r.mode}:${r.outcome}` }];
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

/** The outcome a previous run recorded for this key (the event is the record). */
async function recordedOutcome(keyStr, d) {
  try {
    // Live, first-hand outcomes only: shadow events and earlier duplicates
    // carry the same key.
    const { data } = await d.supabase.from('system_events')
      .select('payload, created_at').eq('event_type', 'lp.post_issue_rebook')
      .eq('payload->>idempotency_key', keyStr).eq('payload->>mode', 'live')
      .neq('payload->>outcome', 'post_issue_rebook_duplicate')
      .order('created_at', { ascending: false }).limit(1);
    return data?.[0]?.payload || null;
  } catch {
    return null;
  }
}

// ─── Step 3: the new lead ───────────────────────────────────────────────────

/**
 * Plan the rebook (3b + 3c). Read-only: shadow runs exactly this.
 * @returns {{ outcome, reason?, newer_lead_id?, in1_id?, srs_id?, pro_id? }}
 */
export async function planRebook({ issuedLead, phone }, d) {
  const prospect = await readProspectLeads(issuedLead.lp_prospect_id, d);
  if (!prospect.ok) return { outcome: 'post_issue_check_failed', reason: `prospect_leads_unreadable: ${prospect.error}` };
  const newer = pickNewerLead(issuedLead, prospect.leads);
  if (newer) return { outcome: 'used_newer_lead', newer_lead_id: clean(newer.lp_lead_id) };

  const inbound = await readInboundRows(phone10(phone || issuedLead.phone), d);
  if (!inbound.ok) return { outcome: 'post_issue_check_failed', reason: `inbound_queue_unreadable: ${inbound.error}` };
  const pending = pendingInboundRow(inbound.rows, issuedSinceMs(issuedLead));
  if (pending) return { outcome: 'newer_lead_pending_in_inbound_queue', in1_id: clean(pending.in1_id), reason: 'inbound_inquiry_waiting' };

  const attribution = resolveAttribution({
    srsId: issuedLead.srs_id ?? issuedLead.raw_lp_data?.srs_id,
    promoterName: issuedLead.promoter_name ?? issuedLead.promotername ?? issuedLead.raw_lp_data?.promotername,
    catalog: await promoterCatalog(d, d.nowMs ?? Date.now()),
    assertNotTransposed,
  });
  if (!attribution.ok) return { outcome: 'post_issue_needs_manual_lead', reason: `attribution_unresolved: ${attribution.reason}` };
  return { outcome: 'post_issue_new_lead_enrolled', srs_id: attribution.srsId, pro_id: attribution.proId };
}

/**
 * Live: claim → newer lead / pending inquiry → attribution → checkpoint the
 * contact's fields → write them → enroll 8e30ff37 (compensate on failure).
 */
export async function createLeadForPostIssueRebook({ contactId, issuedLead, appointmentDate, appointmentTime, phone, base }, d) {
  const keyStr = rebookKey({ contactId, issuedLeadId: issuedLead.lp_lead_id, dateYmd: appointmentDate, timeHHMM: appointmentTime });
  const r = { ...base, idempotency_key: keyStr, compensation_applied: false, previous_values: null };

  const c = await claim(keyStr, r, d);
  if (c.duplicate) {
    const prior = await recordedOutcome(keyStr, d);
    console.log(`[LP-POST-ISSUE] ${keyStr} already claimed — recorded outcome ${prior?.outcome || '(in flight)'}`);
    return { ...r, outcome: 'post_issue_rebook_duplicate', recorded_outcome: prior?.outcome || null, newer_lead_id: prior?.newer_lead_id || null };
  }
  if (!c.claimed) return { ...r, outcome: 'post_issue_check_failed', reason: `idempotency_claim_failed: ${c.error}` };

  const plan = await planRebook({ issuedLead, phone }, d);
  if (plan.outcome !== 'post_issue_new_lead_enrolled') {
    // A pending inquiry and a newer lead are settled answers: keep the claim so a
    // re-fire returns them. Anything that stopped for want of data releases it.
    if (plan.outcome === 'post_issue_check_failed' || plan.outcome === 'post_issue_needs_manual_lead') await release(keyStr, d);
    return { ...r, ...plan };
  }
  r.srs_id = plan.srs_id;
  r.pro_id = plan.pro_id;

  // 3d. Checkpoint before writing anything.
  const contact = await Promise.resolve(d.getGHLContact(contactId)).catch(() => null);
  if (!contact) {
    await release(keyStr, d);
    return { ...r, outcome: 'post_issue_needs_manual_lead', reason: 'contact_unreadable' };
  }
  const previous = {
    [FIELD.SRS]: readField(contact, FIELD.SRS), [FIELD.PRO]: readField(contact, FIELD.PRO),
    [FIELD.APPT_DATE]: readField(contact, FIELD.APPT_DATE), [FIELD.APPT_TIME]: readField(contact, FIELD.APPT_TIME),
  };
  r.previous_values = previous;
  const restore = async () => {
    const ok = await Promise.resolve(d.updateGHLContactFields(contactId,
      Object.entries(previous).map(([id, v]) => ({ id, field_value: v })))).catch(() => false);
    r.compensation_applied = true;
    r.restore_ok = ok === true;
    await release(keyStr, d);
  };

  const wrote = await Promise.resolve(d.updateGHLContactFields(contactId, [
    { id: FIELD.SRS, field_value: plan.srs_id },
    { id: FIELD.PRO, field_value: plan.pro_id },
    { id: FIELD.APPT_DATE, field_value: appointmentDate },
    { id: FIELD.APPT_TIME, field_value: ghlTime12h(appointmentTime) || appointmentTime },
  ])).catch((err) => err.message);
  if (wrote !== true) {
    await restore();
    return { ...r, outcome: 'post_issue_enroll_failed', reason: `field_write_failed: ${wrote}` };
  }

  // 3e. Enroll. force: the 24h create-lead:<contact> mark would otherwise skip
  // it; notify:false: no GroupMe card (CLAUDE.md, migrating to Slack).
  let enrolled;
  try {
    enrolled = await d.enrollLpLeadCreation({ contactId, force: true, notify: false });
  } catch (err) {
    enrolled = { success: false, error: err.message };
  }
  if (!enrolled?.success) {
    await restore();
    return { ...r, outcome: 'post_issue_enroll_failed', reason: `enroll_failed: ${enrolled?.error || enrolled?.action || 'unknown'}` };
  }

  // 3f.
  await Promise.resolve(d.addGHLNote(contactId,
    `[LP SYNC] Lead ${issuedLead.lp_lead_id} was already issued (${base.issued_disposition || 'issued'}). ` +
    `New LP lead requested for ${appointmentDate} ${ghlTime12h(appointmentTime) || appointmentTime}, mirroring ` +
    `Source/Sub-Source/Promoter (srs_id ${plan.srs_id}, pro_id ${plan.pro_id}). Per call-center rule.`,
  )).catch(() => {});
  return { ...r, outcome: 'post_issue_new_lead_enrolled', enroll_action: enrolled.action || null };
}

// ─── The gate ───────────────────────────────────────────────────────────────

/**
 * Ask before an LP SetAppointment. Never throws.
 *
 * @param {object} o
 * @param {string} o.caller            which SetAppointment path ('sync_webhook', 'set_lp_appointment', …)
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
  const base = {
    mode, caller: o.caller, contact_id: o.contactId, contact_name: o.contactName || null, phone: o.phone || null,
    issued_lead_id: String(o.ldsId), lp_prospect_id: o.prospectId || null,
    appt_date: o.appointmentDate || null, appt_time: o.appointmentTime || null,
    srs_id: null, pro_id: null, previous_values: null, compensation_applied: false,
  };

  try {
    const verdict = gateVerdict(await readLeadForGate(o.ldsId, d), o.knownDisposition);
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
      r = { ...base, outcome: 'post_issue_check_failed', reason: verdict.failed ? verdict.reason : `${verdict.reason}: ${verdict.disposition}` };
    } else if (appointmentOnLead(lead, o.appointmentDate, o.appointmentTime)) {
      // The issued appointment itself, re-sent. Not a rebook.
      r = { ...base, outcome: 'same_appointment_on_issued_lead', reason: 'appointment_already_on_lead' };
    } else if (o.requireBookable) {
      r = { ...base, outcome: 'skipped_post_issue_lead', reason: 'watchdog_never_creates_leads' };
    } else if (o.ghlContact === false) {
      r = { ...base, outcome: 'post_issue_needs_manual_lead', reason: 'target_is_lp_lead_id_no_ghl_contact' };
    } else if (o.appointmentDate && o.appointmentDate < new Date(nowMs - 5 * 3600_000).toISOString().slice(0, 10)) {
      r = { ...base, outcome: 'skipped_post_issue_lead', reason: 'appointment_in_the_past' };
    } else if (mode === 'shadow') {
      const plan = await planRebook({ issuedLead: { ...lead, lp_lead_id: String(o.ldsId) }, phone: o.phone }, d);
      r = { ...base, ...plan, idempotency_key: rebookKey({ contactId: o.contactId, issuedLeadId: o.ldsId, dateYmd: o.appointmentDate, timeHHMM: o.appointmentTime }) };
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
    if (o.ghlContact !== false && r.outcome !== 'same_appointment_on_issued_lead' && r.outcome !== 'skipped_post_issue_lead') {
      await Promise.resolve(d.applyGHLTag(o.contactId, DEFERRED_TAG)).catch(() => {});
    }
    console.warn(`[LP-POST-ISSUE] ⛔ ${o.caller}: lead ${o.ldsId} is post-issue (${base.issued_reason}) → ${r.outcome}${r.reason ? ` (${r.reason})` : ''} — no SetAppointment on it`);
    return {
      proceed: false,
      result: {
        success: r.outcome === 'post_issue_new_lead_enrolled' || r.outcome === 'same_appointment_on_issued_lead'
          || (r.outcome === 'post_issue_rebook_duplicate' && r.recorded_outcome === 'post_issue_new_lead_enrolled'),
        action: r.outcome === 'same_appointment_on_issued_lead' ? 'already_set_in_lp' : r.outcome,
        contact_id: o.contactId,
        issued_lead_id: String(o.ldsId),
        lp_lead_id: String(o.ldsId),
        lp_prospect_id: base.lp_prospect_id,
        issued_disposition: base.issued_disposition,
        issued_reason: base.issued_reason,
        reason: r.reason || null,
        in1_id: r.in1_id || null,
        srs_id: r.srs_id || null,
        pro_id: r.pro_id || null,
        idempotency_key: r.idempotency_key || null,
        compensation_applied: r.compensation_applied || false,
        recorded_outcome: r.recorded_outcome || null,
        post_issue_outcome: r.outcome,
      },
    };
  } catch (err) {
    // An unexpected error is "could not tell" (CANON.RULE.069): live refuses,
    // shadow records it and runs today's path.
    const r = { ...base, outcome: 'post_issue_check_failed', reason: `gate_error: ${err.message}` };
    await record(r, d);
    if (mode === 'shadow') return { proceed: true, post_issue: { mode, outcome: r.outcome } };
    await notify(r, d);
    return { proceed: false, result: { success: false, action: 'post_issue_check_failed', contact_id: o.contactId, lp_lead_id: String(o.ldsId), issued_lead_id: String(o.ldsId), reason: r.reason } };
  }
}
