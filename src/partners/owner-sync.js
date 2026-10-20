// ─── Partner owner sync — src/partners/owner-sync.js ─────────────────────────
//
// Mark, 2026-10-19 (handoff "Partner Lead Ownership Sync"): a NEW LP lead in an
// outside sales partner's branch (Ross Erstling → RFED) is owned in GHL by the
// partner — the contact AND every open opportunity — and goes back to the Reece team
// user (PARTNER_DEFAULT_OWNER_ID) when it leaves the partner. LP is the source of
// truth; one way only; nothing here writes to LP or touches messaging, tags or
// workflows. Partners are OWNERS, never followers: GHL's "Only Assigned Data"
// permission keys on the owner.
//
// The rules, in the order they are applied:
//   1. The contact's CURRENT lead decides (pickCurrentLead, src/current-lead.js; the
//      user, 2026-10-20). A returning homeowner's old BOCA lead must never flip the
//      owner back while a new RFED lead is live, and vice versa.
//   2. A matching lead counts only when it is NEW: created at or after
//      PARTNER_GO_LIVE_AT, or its branch changed INTO a partner branch in this pass, or
//      an earlier decision already aimed it at a partner (so a lead that moved in
//      after go-live stays the partner's, and a failed write is retried). The 314
//      older RFED leads are never touched (no backfill).
//   3. No match: the owner is returned ONLY when GHL's current owner is a partner
//      user (rule 8). An internal owner is never changed.
//   4. A dispositioned or cancelled lead that stays in RFED keeps the partner (rule
//      4): the branch decides, never the disposition.
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
import { pickCurrentLead } from '../current-lead.js';
import { lpStoredToUtcMs, lpStoredToUtcIso } from '../lp-dates.js';
import { formatEt } from '../approval-card.js';
import { prospectLabel } from '../format-helpers.js';

export const AUDIT = 'partner_owner';
const MEMO_MS = 24 * 60 * 60 * 1000;
const RECENT_FAILED_MS = 24 * 60 * 60 * 1000;
const RECENT_CACHE_MS = 60_000;
const WRITE_REASONS = new Set(['assigned', 'reassigned', 'returned']);
const CARD_REASONS = new Set(['assigned', 'reassigned', 'returned', 'failed']);
// A non-write reason identical to the lead's last one is not logged again (an old
// RFED lead LP touches every day must not grow one skipped_pre_golive row a pass).
const QUIET_REPEAT = new Set(['noop', 'skipped_pre_golive', 'no_ghl_contact']);

const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase());

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

export function __resetForTests() {
  inFlight.clear();
  recentFailed = null;
}

async function defaultDeps(deps) {
  const out = { ...deps };
  if (!out.supabase) out.supabase = (await import('../supabase.js')).default;
  if (!out.ghlFetch) out.ghlFetch = (await import('../actions/helpers.js')).ghlFetch;
  if (!out.addNote) out.addNote = (await import('../ghl.js')).addGHLNote;
  if (!out.postToSlack) out.postToSlack = (await import('../slack.js')).postToSlack;
  if (!out.alertPosted) out.alertPosted = await import('../alert-posted.js');
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
  }[reason];
  const lines = [
    `*${head}*`,
    `${name} · ${prospectLabel(lead?.lp_prospect_id)}`,
    `Partner: ${partnerName || '—'} · LP branch ${lead?.lp_branch_id || '—'} · rep ${lead?.rep_name || '—'}`,
    `Owner was: ${fromLabel}`,
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
  for (const o of opps) {
    if (String(o.assignedTo || '') === target) { done.push(o.id); continue; }
    try {
      await d.ghlFetch('PUT', `/opportunities/${o.id}`, { assignedTo: target });
      const back = (await d.ghlFetch('GET', `/opportunities/${o.id}`))?.opportunity;
      if (String(back?.assignedTo || '') !== target) throw new Error(`GHL kept owner ${back?.assignedTo || 'none'}`);
      done.push(o.id);
    } catch (err) {
      failed.push({ id: o.id, error: err.message });
    }
  }
  return { opportunities: done, opportunity_failures: failed, contact: after };
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
    if (!wasPartnerBranch && !(await recentFailedLeadIds(d)).has(String(lead.lp_lead_id))) {
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
  const current = pickCurrentLead(leads) || lead;
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
    const aimedBefore = decidingHistory.some((h) => partnerIds.has(String(h.to_owner || ''))
      || partnerIds.has(String(h.planned_target || '')));
    eligibility = newLead ? 'new_lead' : movedIn ? 'branch_changed_in' : aimedBefore ? 'previously_assigned' : null;
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
        && String(lastD.to_owner || '') === target
        && d.now() - Date.parse(lastD.created_at) < MEMO_MS) {
      return { ok: true, reason: 'memo', target };
    }
  }

  const contact = await readContact(d, lead.ghl_contact_id);
  const from = contact.assignedTo ? String(contact.assignedTo) : null;

  if (!match) {
    // Rule 3/8: only a partner-owned contact is returned.
    if (!from || !partnerIds.has(from)) return { ok: true, reason: 'not_partner_owned', from };
    if (!cfg.defaultOwner) {
      const out = { ok: false, reason: 'failed', error: 'PARTNER_DEFAULT_OWNER_ID unset', from };
      if (!dryRun) {
        await writeLog(d, { ...base, reason: 'failed', from_owner: from, error: out.error, partner_name: await partnerNameForUser(from, d) });
      }
      return out;
    }
    target = cfg.defaultOwner;
  }

  const partnerName = match?.partner_name || await partnerNameForUser(from, d);
  if (from === target) {
    const out = { ok: true, reason: 'noop', from, target, eligibility };
    if (!dryRun && !quiet('noop')) await writeLog(d, { ...base, reason: 'noop', from_owner: from, to_owner: target, partner_name: partnerName });
    return out;
  }

  const reason = match
    ? (from && partnerIds.has(from) ? 'reassigned' : 'assigned')
    : 'returned';
  const toLabel = ownerLabel(target, match?.partner_name || null, cfg.defaultOwner);
  const fromLabel = ownerLabel(from, await partnerNameForUser(from, d), cfg.defaultOwner);
  if (dryRun) {
    return { ok: true, reason, dry_run: true, from, target, partner_name: partnerName, eligibility, deciding_lead: String(deciding.lp_lead_id) };
  }

  let applied;
  try {
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

  const stamp = formatEt(new Date(d.now()));
  const note = `Owner → ${toLabel} · LP branch ${deciding.lp_branch_id || '—'} · rep ${deciding.rep_name || '—'} · ${stamp}`;
  try {
    await d.addNote(lead.ghl_contact_id, note);
  } catch (err) {
    console.warn(`[PartnerOwner] note on ${lead.ghl_contact_id} failed (owner already set): ${err.message}`);
  }
  await writeLog(d, {
    ...base, reason, from_owner: from, to_owner: target, partner_name: partnerName,
    detail: { opportunities: applied.opportunities, eligibility, deciding_lead: String(deciding.lp_lead_id) },
  });
  const card = await postCard(d, { reason, lead: deciding, target, contact: applied.contact || contact, partnerName, toLabel, fromLabel });
  d.log(`[PartnerOwner] ${reason}: contact ${lead.ghl_contact_id} ${from || 'none'} → ${target} (${applied.opportunities.length} open opportunit${applied.opportunities.length === 1 ? 'y' : 'ies'})`);
  return { ok: true, reason, from, target, opportunities: applied.opportunities, card };
}
