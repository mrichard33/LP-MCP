// ─── Partner owner sync — src/partners/owner-sync.js ─────────────────────────
//
// Mark, 2026-10-19 (handoff "Partner Lead Ownership Sync"): a NEW LP lead in an
// outside sales partner's branch (Ross Erstling → RFED) is owned in GHL by the
// partner — the contact AND every open opportunity — and goes back to the Reece team
// user (PARTNER_DEFAULT_OWNER_ID) when it leaves the partner. LP is the source of
// truth; one way only; nothing here writes to LP or touches messaging or
// workflows. The one tag it writes is the partner row's ghl_tag (2026-10-21,
// phone-team: GHL's U.RFED fires on it), added on assign, removed on our return. Partners are OWNERS, never followers: GHL's "Only Assigned Data"
// permission keys on the owner.
//
// The rules, in the order they are applied:
//   1. The contact's NEWEST-CREATED lead decides (newestLead; the user, 2026-10-20).
//      A returning homeowner's old BOCA lead must never flip the owner back while a
//      new RFED lead is live, and vice versa. Not pickCurrentLead: its Data-shadow
//      rule (a Data lead yields to a lead with a recent visit) is for F.0 and the
//      disposition field, and it let BOCA ND lead 576867 outrank the newer RFED test
//      lead 583364, so the contact never went to Ross (2026-10-20).
//   2. A matching lead counts when it is NEW (created at or after PARTNER_GO_LIVE_AT),
//      its branch changed INTO a partner branch in this pass, LP CHANGED it after
//      go-live (the user, 2026-10-20: "If we assign it RFED, it should go to Ross";
//      putting a lead in RFED stamps updated_at_lp, so a move a pass never saw still
//      counts), or an earlier decision already aimed it at a partner (a failed write
//      is retried). RFED leads LP has not touched since go-live are never touched.
//      The branch decides, never the zip or the location.
//   3. No match: the owner is returned ONLY for a contact THIS code assigned (an open
//      partner_owner_assignments row) and whose GHL owner is still that partner
//      (handoff v3, Mark 2026-10-20). An internal owner is never changed (rule 8).
//   3b. A partner GHL put there itself is never ours to move: GHL S5.2 Appointment
//      Rescue v2, branch "I. 1 Leg", assigns 1 Leg leads to Ross on its own. With no
//      open assignment for that partner, a return or a reassign is logged
//      skipped_not_ours and nothing is written; a matching lead whose owner is
//      already that partner is a noop and creates no assignment.
//   4. A dispositioned or cancelled lead that stays in RFED keeps the partner (rule
//      4): the branch decides, never the disposition.
//
// 2026-10-22 (handoff, Builds 1 and 2): a partner owner, however it got there, means
// Reece stops dialing the lead. Every path that ends with a partner owning the contact
// (assigned, reassigned, a noop, skipped_not_ours) calls ensurePartnerFive9Removal
// (src/partners/five9-removal.js), and a return calls releasePartnerFive9. A partner
// GHL put there (rule 3b) still is never moved, but now posts ONE card per lead,
// "🤝 PARTNER LEAD ASSIGNED → <partner> (set by GHL)" (reason assigned_by_ghl), so the
// 1 Leg hand-offs are seen. The Five9 step runs after the owner write and never fails it.
//
// Cost: the 15-minute sync calls this for EVERY lead it writes. A lead that is not
// partner-relevant (not matching, previous branch not a partner branch, no recent
// failed decision) returns after the cached map alone, with no read. A relevant lead
// whose last decision already put the same owner within 24 h, with no branch or rep
// change, returns without a GHL call (the memo). Every write is decided from a live
// GHL read and read back; an owner GHL kept is a failure, not a success (the pattern
// of src/actions/handlers/rehash-owner.js).
//
// Never throws to the caller (processProspect, the fast poll, the admin route).

import {
  loadPartnerMap, matchPartnerRow, partnerUserIds, allPartnerBranches, partnerNameForUser,
} from './owner-resolver.js';
import { lpStoredToUtcMs, lpStoredToUtcIso } from '../lp-dates.js';
import { formatEt } from '../approval-card.js';
import { prospectLabel } from '../format-helpers.js';

export const AUDIT = 'partner_owner';
const MEMO_MS = 24 * 60 * 60 * 1000;
const RECENT_FAILED_MS = 24 * 60 * 60 * 1000;
const RECENT_CACHE_MS = 60_000;
const WRITE_REASONS = new Set(['assigned', 'reassigned', 'returned']);
const CARD_REASONS = new Set(['assigned', 'reassigned', 'returned', 'failed', 'assigned_by_ghl']);
// A non-write reason identical to the lead's last one is not logged again (an old
// RFED lead LP touches every day must not grow one skipped_pre_golive row a pass).
const QUIET_REPEAT = new Set(['noop', 'skipped_pre_golive', 'skipped_not_ours', 'no_ghl_contact']);

const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase());

const lpMs = (v) => { const ms = lpStoredToUtcMs(v); return Number.isFinite(ms) ? ms : 0; };
/** The newest-created lead (tie: the most recently updated), the order of current-lead.js without its Data shadow. Pure. */
export function newestLead(leads) {
  if (!Array.isArray(leads) || leads.length === 0) return null;
  return [...leads].sort((a, b) => (lpMs(b.created_at_lp) - lpMs(a.created_at_lp))
    || (lpMs(b.updated_at_lp) - lpMs(a.updated_at_lp)))[0];
}

/** { enabled, reason, goLiveMs, defaultOwner } — off unless PARTNER_GO_LIVE_AT parses. */
export function partnerSyncConfig(env = process.env) {
  const flag = String(env.PARTNER_SYNC_ENABLED ?? 'true').toLowerCase().trim();
  const goLiveMs = Date.parse(env.PARTNER_GO_LIVE_AT || '');
  const defaultOwner = String(env.PARTNER_DEFAULT_OWNER_ID || '').trim() || null;
  if (flag === 'false' || flag === 'off' || flag === '0') return { enabled: false, reason: 'disabled', goLiveMs, defaultOwner };
  if (!Number.isFinite(goLiveMs)) return { enabled: false, reason: 'no_go_live_at', goLiveMs: null, defaultOwner };
  return { enabled: true, reason: null, goLiveMs, defaultOwner };
}

const inFlight = new Set();
let recentFailed = null; // { ids:Set, at }
let openAssigned = null; // { ids:Set, at } contacts with an open partner_owner_assignments row

export function __resetForTests() {
  inFlight.clear();
  recentFailed = null;
  openAssigned = null;
}

async function defaultDeps(deps) {
  const out = { ...deps };
  if (!out.supabase) out.supabase = (await import('../supabase.js')).default;
  if (!out.ghlFetch) out.ghlFetch = (await import('../actions/helpers.js')).ghlFetch;
  if (!out.addNote) out.addNote = (await import('../ghl.js')).addGHLNote;
  if (!out.postToSlack) out.postToSlack = (await import('../slack.js')).postToSlack;
  if (!out.alertPosted) out.alertPosted = await import('../alert-posted.js');
  // The Five9 removal (2026-10-22). Production passes no ghlFetch, so it gets the real
  // module; a test that injects GHL gets none unless it injects partnerFive9 too, so no
  // test ever reaches Five9.
  if (!('partnerFive9' in out)) out.partnerFive9 = deps.ghlFetch ? null : await import('./five9-removal.js');
  out.env = out.env || process.env;
  out.now = out.now || Date.now;
  out.log = out.log || console.log;
  return out;
}

/** Lead ids whose last decision in 24 h failed — still partner-relevant whatever the branch now says. */
async function recentFailedLeadIds(d) {
  const now = d.now();
  if (recentFailed && now - recentFailed.at < RECENT_CACHE_MS) return recentFailed.ids;
  const { data, error } = await d.supabase.from('partner_owner_log')
    .select('lp_lead_id, reason, created_at')
    .gte('created_at', new Date(now - RECENT_FAILED_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw new Error(`partner_owner_log read failed: ${error.message}`);
  const latest = new Map();
  for (const r of data || []) if (!latest.has(String(r.lp_lead_id))) latest.set(String(r.lp_lead_id), r.reason);
  const ids = new Set([...latest].filter(([, reason]) => reason === 'failed').map(([id]) => id));
  recentFailed = { ids, at: now };
  return ids;
}

/** Contacts this code assigned to a partner and has not handed back (cached 60 s). */
async function openAssignmentContactIds(d) {
  const now = d.now();
  if (openAssigned && now - openAssigned.at < RECENT_CACHE_MS) return openAssigned.ids;
  const { data, error } = await d.supabase.from('partner_owner_assignments')
    .select('ghl_contact_id')
    .is('released_at', null)
    .limit(5000);
  if (error) throw new Error(`partner_owner_assignments read failed: ${error.message}`);
  const ids = new Set((data || []).map((r) => String(r.ghl_contact_id)));
  openAssigned = { ids, at: now };
  return ids;
}

/** The contact's open assignment (live read), or null. A failed read throws: could not tell. */
async function openAssignmentFor(d, contactId) {
  const { data, error } = await d.supabase.from('partner_owner_assignments')
    .select('ghl_contact_id, lp_lead_id, partner_name, ghl_user_id, assigned_at, released_at')
    .eq('ghl_contact_id', String(contactId))
    .is('released_at', null)
    .maybeSingle();
  if (error) throw new Error(`partner_owner_assignments read failed: ${error.message}`);
  return data || null;
}

/** Written BEFORE the GHL write: an owner we set is always one we can hand back. */
async function claimAssignment(d, { contactId, lead, partnerName, userId }) {
  const { error } = await d.supabase.from('partner_owner_assignments').upsert({
    ghl_contact_id: String(contactId),
    lp_lead_id: String(lead.lp_lead_id), // lead-id-ok: machine value in our own table
    partner_name: partnerName || null,
    ghl_user_id: String(userId),
    assigned_at: new Date(d.now()).toISOString(),
    released_at: null,
  }, { onConflict: 'ghl_contact_id' });
  openAssigned = null;
  if (error) throw new Error(`partner_owner_assignments write failed: ${error.message}`);
}

async function releaseAssignment(d, contactId) {
  try {
    const { error } = await d.supabase.from('partner_owner_assignments')
      .update({ released_at: new Date(d.now()).toISOString() })
      .eq('ghl_contact_id', String(contactId))
      .is('released_at', null);
    if (error) throw new Error(error.message);
  } catch (err) {
    // The owner is already right; the next pass sees an owner that is not the
    // assignment's and closes the row then.
    console.warn(`[PartnerOwner] could not release assignment for contact ${contactId}: ${err.message}`);
  }
  openAssigned = null;
}

async function lastLogFor(d, lpLeadId) {
  const { data, error } = await d.supabase.from('partner_owner_log')
    .select('reason, to_owner, planned_target, created_at')
    .eq('lp_lead_id', String(lpLeadId))
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(`partner_owner_log read failed: ${error.message}`);
  return data || [];
}

async function contactLeads(d, contactId) {
  const { data, error } = await d.supabase.from('lp_leads')
    .select('lp_lead_id, lp_prospect_id, lp_branch_id, rep_name, ghl_contact_id, disposition_code, appointment_date, created_at_lp, updated_at_lp')
    .eq('ghl_contact_id', String(contactId))
    .is('lp_deleted_at', null)
    .limit(50);
  if (error) throw new Error(`lp_leads read failed: ${error.message}`);
  return data || [];
}

async function writeLog(d, row) {
  try {
    const { error } = await d.supabase.from('partner_owner_log').insert({ ...row, created_at: new Date(d.now()).toISOString() });
    if (error) throw new Error(error.message);
  } catch (err) {
    console.warn(`[PartnerOwner] could not write partner_owner_log (${row.reason}) for contact ${row.ghl_contact_id}: ${err.message}`);
  }
}

function ownerLabel(userId, partnerName, defaultOwner) {
  if (partnerName) return partnerName;
  if (userId && userId === defaultOwner) return 'Reece team';
  return userId || 'nobody';
}

/** Pure: the card for one decision. */
export function buildPartnerCard({ reason, contact, lead, partnerName, toLabel, fromLabel, error }) {
  const name = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim() || contact?.contactName || 'Unknown name';
  const head = {
    assigned: `🤝 PARTNER LEAD ASSIGNED → ${toLabel}`,
    reassigned: `🔁 PARTNER LEAD REASSIGNED → ${toLabel}`,
    returned: `↩️ PARTNER LEAD RETURNED → ${toLabel}`,
    failed: `⚠️ PARTNER OWNER UPDATE FAILED (wanted ${toLabel})`,
    assigned_by_ghl: `🤝 PARTNER LEAD ASSIGNED → ${toLabel} (set by GHL)`,
  }[reason];
  const lines = [
    `*${head}*`,
    `${name} · ${prospectLabel(lead?.lp_prospect_id)}`,
    `Partner: ${partnerName || '—'} · LP branch ${lead?.lp_branch_id || '—'} · rep ${lead?.rep_name || '—'}`,
    reason === 'assigned_by_ghl'
      ? 'GHL made the partner the owner (S5.2 "I. 1 Leg" or U.RFED), not LP-MCP. LP-MCP leaves this owner as it is.'
      : `Owner was: ${fromLabel}`,
    `Contact ID: ${contact?.id || lead?.ghl_contact_id || 'unknown'}`,
  ];
  if (error) lines.push(`Error: ${String(error).slice(0, 300)}`);
  return lines.join('\n');
}

async function postCard(d, { reason, lead, target, contact, partnerName, toLabel, fromLabel, error }) {
  if (!CARD_REASONS.has(reason)) return { posted: false, why: 'no_card_reason' };
  const channel = String(d.env.PARTNER_ALERT_SLACK_CHANNEL || '').trim();
  if (!channel) {
    d.log(`[PartnerOwner] ${reason} card for contact ${lead.ghl_contact_id} not posted: PARTNER_ALERT_SLACK_CHANNEL unset`);
    return { posted: false, why: 'channel_unset' };
  }
  // One card per lead + reason + target, ever (handoff rule 3j). The key is a
  // machine value in audit_posted_items, never printed. lead-id-ok: dedupe key
  const items = [{ key: `${lead.lp_lead_id}:${target}`, reason }];
  const { fresh } = await d.alertPosted.filterNew({ audit: AUDIT, items, deps: { supabase: d.supabase } });
  if (!fresh.length) return { posted: false, why: 'already_posted' };
  const text = buildPartnerCard({ reason, contact, lead, partnerName, toLabel, fromLabel, error });
  const res = await d.postToSlack(text, channel);
  if (res?.ok) {
    await d.alertPosted.recordPosted({ audit: AUDIT, items, permanent: true, deps: { supabase: d.supabase } });
    return { posted: true };
  }
  console.warn(`[PartnerOwner] Slack post failed for contact ${lead.ghl_contact_id}: ${res?.error || 'unknown'}`);
  return { posted: false, why: res?.error || 'post_failed' };
}

/**
 * The rule 3b card for a contact the sweep found (src/jobs/partner-five9-sweep.js):
 * the same card, key and dedupe as the sync's own, so the two never post it twice.
 */
export async function postGhlSetCard({ contact, lead, partnerName, partnerUserId, deps = {} }) {
  if (!lead?.lp_lead_id) return { posted: false, why: 'no_lead' };
  const d = await defaultDeps(deps);
  return postCard(d, { reason: 'assigned_by_ghl', lead, target: partnerUserId, contact, partnerName,
    toLabel: partnerName || partnerUserId, fromLabel: '—' });
}

/** Live owner of the contact, or throws. */
async function readContact(d, contactId) {
  const res = await d.ghlFetch('GET', `/contacts/${contactId}`);
  const contact = res?.contact;
  if (!contact) throw new Error(`contact ${contactId} not found in GHL`);
  return contact;
}

async function openOpportunities(d, contactId) {
  const loc = d.env.GHL_LOCATION_ID;
  const res = await d.ghlFetch('GET', `/opportunities/search?location_id=${loc}&contact_id=${contactId}&limit=100`);
  return (res?.opportunities || []).filter((o) => String(o.status || 'open').toLowerCase() === 'open');
}

// GHL refuses an owner who cannot see the opportunity's pipeline ("Can not make this user … owner as User does not
// have permission to access this pipeline …"): Ross has no access to "3. Recycle, Lost, Deferred …", so the RFED test
// contact's one open card there failed every retry (2026-10-20). The user's ruling: skip a pipeline the partner cannot
// see. The card keeps its owner, is listed as skipped, and is not a failure.
export const PIPELINE_ACCESS_RX = /does not have permission to access this pipeline/i;

// 2026-10-21 (the user): "When a lead has the tag applied phone-team this is what
// triggers the lead being assigned to Ross and a notification sent to Ross."
// GHL "U.RFED Lead Assigned to Phone Team" fires on the tag being ADDED (assign
// the partner, then an internal SMS to the owner). So once our sync makes the
// partner the owner, it adds the partner row's ghl_tag (partner_owner_map; Ross →
// phone-team). Read back; a failed tag never undoes the owner, it is logged
// (detail.tag) and tried again on the next pass. On a return the tag comes off,
// only for a contact we assigned, so a later lead in the branch fires GHL again.
const hasTag = (contact, tag) => (contact?.tags || []).some((t) => norm(t) === norm(tag));

async function ensurePartnerTag(d, contactId, tag, contact) {
  if (!tag) return null;
  if (hasTag(contact, tag)) return { tag, present: true, added: false };
  try {
    await d.ghlFetch('POST', `/contacts/${contactId}/tags`, { tags: [tag] });
    const back = await readContact(d, contactId);
    const ok = hasTag(back, tag);
    return ok ? { tag, present: true, added: true } : { tag, present: false, added: false, error: 'tag missing on read-back' };
  } catch (err) {
    return { tag, present: false, added: false, error: err.message };
  }
}

async function removePartnerTag(d, contactId, tag, contact) {
  if (!tag || !hasTag(contact, tag)) return null;
  try {
    await d.ghlFetch('DELETE', `/contacts/${contactId}/tags`, { tags: [tag] });
    return { tag, removed: true };
  } catch (err) {
    return { tag, removed: false, error: err.message };
  }
}

/** PUT the owner on the contact and every open opportunity, reading each back. */
async function applyOwner(d, contactId, target) {
  await d.ghlFetch('PUT', `/contacts/${contactId}`, { assignedTo: target });
  const after = await readContact(d, contactId);
  if (String(after.assignedTo || '') !== target) {
    throw new Error(`GHL kept contact owner ${after.assignedTo || 'none'} (wanted ${target})`);
  }
  const opps = await openOpportunities(d, contactId);
  const done = [];
  const failed = [];
  const skipped = [];
  for (const o of opps) {
    if (String(o.assignedTo || '') === target) { done.push(o.id); continue; }
    try {
      await d.ghlFetch('PUT', `/opportunities/${o.id}`, { assignedTo: target });
      const back = (await d.ghlFetch('GET', `/opportunities/${o.id}`))?.opportunity;
      if (String(back?.assignedTo || '') !== target) throw new Error(`GHL kept owner ${back?.assignedTo || 'none'}`);
      done.push(o.id);
    } catch (err) {
      if (PIPELINE_ACCESS_RX.test(err.message)) skipped.push({ id: o.id, pipeline_id: o.pipelineId || null });
      else failed.push({ id: o.id, error: err.message });
    }
  }
  return { opportunities: done, opportunity_failures: failed, opportunities_skipped: skipped, contact: after };
}

/**
 * Decide, and (unless dryRun) apply, the owner for one processed lead.
 * lead: the lp_leads view just written ({ lp_lead_id, lp_prospect_id, lp_branch_id,
 *   rep_name, ghl_contact_id, created_at_lp, updated_at_lp }).
 * opts: { prevRow, dryRun, deps }
 */
export async function syncPartnerOwner(lead, { prevRow = null, dryRun = false, deps = {} } = {}) {
  let d;
  try {
    d = await defaultDeps(deps);
  } catch (err) {
    return { ok: false, reason: 'deps_unavailable', error: err.message };
  }
  const cfg = partnerSyncConfig(d.env);
  if (!cfg.enabled && !dryRun) return { ok: true, reason: cfg.reason };
  if (!lead?.lp_lead_id) return { ok: true, reason: 'no_lead' };

  const lockKey = String(lead.ghl_contact_id || `lead:${lead.lp_lead_id}`);
  if (inFlight.has(lockKey)) return { ok: true, reason: 'in_flight' };
  inFlight.add(lockKey);
  try {
    return await decideAndApply(d, cfg, lead, prevRow, dryRun);
  } catch (err) {
    console.warn(`[PartnerOwner] contact ${lead.ghl_contact_id || 'none'}: ${err.message}`);
    return { ok: false, reason: 'error', error: err.message };
  } finally {
    inFlight.delete(lockKey);
  }
}

async function decideAndApply(d, cfg, lead, prevRow, dryRun) {
  const rows = await loadPartnerMap(d);
  const thisMatch = matchPartnerRow(rows, lead);
  const prevBranch = String(prevRow?.lp_branch_id || '').trim().toUpperCase();
  const branchChanged = prevRow != null && norm(prevRow.lp_branch_id) !== norm(lead.lp_branch_id);
  const repChanged = prevRow != null && norm(prevRow.rep_name) !== norm(lead.rep_name);

  // Relevance: with no match, no partner history in this pass and no recent failure,
  // there is nothing to do and nothing to read.
  if (!thisMatch) {
    const partnerBranchesAny = await allPartnerBranches(d);
    const wasPartnerBranch = prevBranch && partnerBranchesAny.has(prevBranch);
    if (!wasPartnerBranch
        && !(lead.ghl_contact_id && (await openAssignmentContactIds(d)).has(String(lead.ghl_contact_id)))
        && !(await recentFailedLeadIds(d)).has(String(lead.lp_lead_id))) {
      return { ok: true, reason: 'not_partner_lead' };
    }
  }

  // Every decision is logged under the lead that DECIDED it (the contact's current
  // lead), so the memo, the retry and the status route read one history.
  const baseFor = (l) => ({
    lp_lead_id: String(l.lp_lead_id),
    ghl_contact_id: lead.ghl_contact_id || null,
    lp_branch_id: l.lp_branch_id || null,
    rep_name: l.rep_name || null,
    lp_changed_at: lpStoredToUtcIso(l.updated_at_lp),
  });
  const quietIn = (hist) => (reason) => {
    const last = hist[0];
    return Boolean(last && last.reason === reason && QUIET_REPEAT.has(reason)
      && d.now() - Date.parse(last.created_at) < MEMO_MS);
  };
  const history = await lastLogFor(d, lead.lp_lead_id);
  let base = baseFor(lead);
  let quiet = quietIn(history);

  if (!lead.ghl_contact_id) {
    const out = { ok: true, reason: 'no_ghl_contact', partner_name: thisMatch?.partner_name || null };
    if (!dryRun && !quiet('no_ghl_contact')) await writeLog(d, { ...base, reason: 'no_ghl_contact', partner_name: out.partner_name });
    return out;
  }

  // Rule 1: the contact's current lead decides.
  const leads = await contactLeads(d, lead.ghl_contact_id);
  if (!leads.some((l) => String(l.lp_lead_id) === String(lead.lp_lead_id))) leads.push(lead);
  const current = newestLead(leads) || lead;
  const isCurrent = String(current.lp_lead_id) === String(lead.lp_lead_id);
  // The lead just written is fresher than the row read back on a skip path.
  const deciding = isCurrent ? { ...current, ...lead } : current;
  const match = matchPartnerRow(rows, deciding);
  const decidingHistory = isCurrent ? history : await lastLogFor(d, deciding.lp_lead_id);
  base = baseFor(deciding);
  quiet = quietIn(decidingHistory);
  const partnerIds = await partnerUserIds(d);

  let target = null;
  let eligibility = null;
  if (match) {
    const createdMs = lpStoredToUtcMs(deciding.created_at_lp);
    const newLead = Number.isFinite(createdMs) && Number.isFinite(cfg.goLiveMs) && createdMs >= cfg.goLiveMs;
    const movedIn = isCurrent && branchChanged && matchPartnerRow(rows, lead) != null;
    const changedMs = lpStoredToUtcMs(deciding.updated_at_lp);
    const changedAfter = Number.isFinite(changedMs) && Number.isFinite(cfg.goLiveMs) && changedMs >= cfg.goLiveMs;
    const aimedBefore = decidingHistory.some((h) => partnerIds.has(String(h.to_owner || ''))
      || partnerIds.has(String(h.planned_target || '')));
    eligibility = newLead ? 'new_lead' : movedIn ? 'branch_changed_in' : changedAfter ? 'changed_after_go_live'
      : aimedBefore ? 'previously_assigned' : null;
    if (!eligibility) {
      const out = {
        ok: true, reason: 'skipped_pre_golive', partner_name: match.partner_name,
        would_assign_if_eligible: match.ghl_user_id, deciding_lead: String(deciding.lp_lead_id),
      };
      if (!dryRun && !quiet('skipped_pre_golive')) {
        await writeLog(d, { ...base, reason: 'skipped_pre_golive', partner_name: match.partner_name, planned_target: null });
      }
      return out;
    }
    target = String(match.ghl_user_id);
    // The memo: the same owner put (or confirmed) in the last 24 h, nothing moved.
    const lastD = decidingHistory[0];
    if (!dryRun && lastD && !branchChanged && !repChanged
        && (WRITE_REASONS.has(lastD.reason) || lastD.reason === 'noop')
        && (!match.ghl_tag || lastD.detail?.tag?.present === true)
        && String(lastD.to_owner || '') === target
        && d.now() - Date.parse(lastD.created_at) < MEMO_MS) {
      return { ok: true, reason: 'memo', target };
    }
  }

  const contact = await readContact(d, lead.ghl_contact_id);
  const from = contact.assignedTo ? String(contact.assignedTo) : null;
  const assignment = await openAssignmentFor(d, lead.ghl_contact_id);
  // Rule 3b: a partner owner with no open assignment for THAT partner was put there by
  // GHL (the S5.2 "I. 1 Leg" path) or by a person, never by us.
  const partnerNotOurs = Boolean(from && partnerIds.has(from)
    && (!assignment || String(assignment.ghl_user_id) !== from));
  // Builds 1 and 2 (2026-10-22). Never throws, never blocks the owner write.
  const five9 = async (trigger, contactNow, partnerName) => {
    if (dryRun || !d.partnerFive9) return null;
    const fdeps = { supabase: d.supabase, ghlFetch: d.ghlFetch, postToSlack: d.postToSlack, alertPosted: d.alertPosted, env: d.env, now: d.now, log: d.log };
    try {
      const r = trigger === 'returned'
        ? await d.partnerFive9.releasePartnerFive9({ contactId: lead.ghl_contact_id, trigger, deps: fdeps })
        : await d.partnerFive9.ensurePartnerFive9Removal({
          contactId: lead.ghl_contact_id, contact: contactNow, partnerUserIds: partnerIds, partnerName, trigger, deps: fdeps,
        });
      return r && { outcome: r.outcome, ...(r.mode ? { mode: r.mode } : {}), ...(r.rows_queued ? { rows_queued: r.rows_queued } : {}),
        ...(r.lists ? { list_count: r.lists.length } : {}), ...(r.error ? { error: r.error } : {}) };
    } catch (err) {
      return { outcome: 'error', error: err.message };
    }
  };
  // Rule 3b, seen: a partner GHL put on the contact gets one card per lead + partner.
  const ghlSetCard = async (partnerName) => {
    if (dryRun) return null;
    return postCard(d, { reason: 'assigned_by_ghl', lead: deciding, target: from, contact, partnerName,
      toLabel: partnerName || from, fromLabel: '—' });
  };
  const notOurs = async () => {
    const out = { ok: true, reason: 'skipped_not_ours', from, would_target: match ? String(match.ghl_user_id) : cfg.defaultOwner };
    const partnerName = await partnerNameForUser(from, d);
    out.card = await ghlSetCard(partnerName);
    out.five9 = await five9('ghl_set', contact, partnerName);
    if (!dryRun && !quiet('skipped_not_ours')) {
      await writeLog(d, { ...base, reason: 'skipped_not_ours', from_owner: from, partner_name: partnerName,
        detail: { would_target: out.would_target, ghl_set: true, ...(out.five9 ? { five9: out.five9 } : {}) } });
    }
    return out;
  };

  if (!match) {
    // Rule 3/8: only a contact we assigned, still owned by that partner, is returned.
    if (assignment && String(assignment.ghl_user_id) !== from && !dryRun) await releaseAssignment(d, lead.ghl_contact_id);
    if (partnerNotOurs) return notOurs();
    if (!assignment || !from || !partnerIds.has(from)) return { ok: true, reason: 'not_partner_owned', from };
    if (!cfg.defaultOwner) {
      const out = { ok: false, reason: 'failed', error: 'PARTNER_DEFAULT_OWNER_ID unset', from };
      if (!dryRun) {
        await writeLog(d, { ...base, reason: 'failed', from_owner: from, error: out.error, partner_name: await partnerNameForUser(from, d) });
      }
      return out;
    }
    target = cfg.defaultOwner;
  } else if (partnerNotOurs && from !== target) {
    return notOurs();
  }

  const partnerName = match?.partner_name || await partnerNameForUser(from, d);
  // A write of ours that set the contact but failed on an opportunity is finished on
  // the next pass rather than read as a noop (only for a contact we assigned).
  const finishOurs = Boolean(match && assignment && String(assignment.ghl_user_id) === target
    && decidingHistory[0]?.reason === 'failed');
  if (from === target && !finishOurs) {
    const out = { ok: true, reason: 'noop', from, target, eligibility };
    // A partner owner with no assignment of ours: GHL set it (rule 3b, Build 2).
    const ghlSet = Boolean(match && partnerNotOurs);
    if (match && !dryRun) {
      if (ghlSet) out.card = await ghlSetCard(partnerName);
      out.five9 = await five9(ghlSet ? 'ghl_set' : 'owner_sync', contact, partnerName);
    }
    const extra = { ...(ghlSet ? { ghl_set: true } : {}), ...(out.five9 ? { five9: out.five9 } : {}) };
    if (match?.ghl_tag && !hasTag(contact, match.ghl_tag)) {
      if (dryRun) return { ...out, would_tag: match.ghl_tag };
      out.tag = await ensurePartnerTag(d, lead.ghl_contact_id, match.ghl_tag, contact);
      await writeLog(d, { ...base, reason: 'noop', from_owner: from, to_owner: target, partner_name: partnerName, detail: { tag: out.tag, eligibility, ...extra } });
      return out;
    }
    if (!dryRun && !quiet('noop')) {
      const detail = { ...(match?.ghl_tag ? { tag: { tag: match.ghl_tag, present: true, added: false } } : {}), ...extra };
      await writeLog(d, { ...base, reason: 'noop', from_owner: from, to_owner: target, partner_name: partnerName,
        ...(Object.keys(detail).length ? { detail } : {}) });
    }
    return out;
  }

  const reason = match
    ? (from && partnerIds.has(from) && from !== target ? 'reassigned' : 'assigned')
    : 'returned';
  const toLabel = ownerLabel(target, match?.partner_name || null, cfg.defaultOwner);
  const fromLabel = ownerLabel(from, await partnerNameForUser(from, d), cfg.defaultOwner);
  if (dryRun) {
    return { ok: true, reason, dry_run: true, from, target, partner_name: partnerName, eligibility, deciding_lead: String(deciding.lp_lead_id),
      ...(match?.ghl_tag ? { would_tag: match.ghl_tag } : {}) };
  }

  let applied;
  try {
    if (match) await claimAssignment(d, { contactId: lead.ghl_contact_id, lead: deciding, partnerName: match.partner_name, userId: target });
    applied = await applyOwner(d, lead.ghl_contact_id, target);
    if (applied.opportunity_failures.length) {
      throw new Error(`opportunity owner not set on ${applied.opportunity_failures.map((f) => `${f.id} (${f.error})`).join(', ')}`);
    }
  } catch (err) {
    await writeLog(d, {
      ...base, reason: 'failed', from_owner: from, planned_target: target, partner_name: partnerName, error: err.message,
      detail: applied ? { opportunities: applied.opportunities, opportunity_failures: applied.opportunity_failures } : null,
    });
    recentFailed = null;
    await postCard(d, { reason: 'failed', lead: deciding, target, contact, partnerName, toLabel, fromLabel, error: err.message });
    return { ok: false, reason: 'failed', from, target, error: err.message };
  }

  let tag = null;
  if (match) {
    tag = await ensurePartnerTag(d, lead.ghl_contact_id, match.ghl_tag, applied.contact);
  } else {
    const ourRow = assignment && rows.find((r) => String(r.ghl_user_id) === String(assignment.ghl_user_id) && r.ghl_tag);
    if (ourRow) tag = await removePartnerTag(d, lead.ghl_contact_id, ourRow.ghl_tag, applied.contact || contact);
    await releaseAssignment(d, lead.ghl_contact_id);
  }
  if (tag?.error) console.warn(`[PartnerOwner] tag ${tag.tag} on ${lead.ghl_contact_id}: ${tag.error} (owner already set; retried next pass)`);
  // Build 1: a partner owner leaves the Reece Five9 lists; a return stops that.
  const five9Result = await five9(match ? 'owner_sync' : 'returned', applied.contact || contact, partnerName);
  const stamp = formatEt(new Date(d.now()));
  const note = `Owner → ${toLabel} · LP branch ${deciding.lp_branch_id || '—'} · rep ${deciding.rep_name || '—'} · ${stamp}`;
  try {
    await d.addNote(lead.ghl_contact_id, note);
  } catch (err) {
    console.warn(`[PartnerOwner] note on ${lead.ghl_contact_id} failed (owner already set): ${err.message}`);
  }
  await writeLog(d, {
    ...base, reason, from_owner: from, to_owner: target, partner_name: partnerName,
    detail: {
      opportunities: applied.opportunities, eligibility, deciding_lead: String(deciding.lp_lead_id),
      ...(applied.opportunities_skipped.length ? { opportunities_skipped_no_pipeline_access: applied.opportunities_skipped } : {}),
      ...(tag ? { tag } : {}),
      ...(five9Result ? { five9: five9Result } : {}),
    },
  });
  const card = await postCard(d, { reason, lead: deciding, target, contact: applied.contact || contact, partnerName, toLabel, fromLabel });
  d.log(`[PartnerOwner] ${reason}: contact ${lead.ghl_contact_id} ${from || 'none'} → ${target} (${applied.opportunities.length} open opportunit${applied.opportunities.length === 1 ? 'y' : 'ies'})`);
  return { ok: true, reason, from, target, opportunities: applied.opportunities, card, ...(tag ? { tag } : {}), ...(five9Result ? { five9: five9Result } : {}) };
}
