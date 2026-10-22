// ─── Partner leads leave the Reece Five9 lists — src/partners/five9-removal.js ─
//
// Handoff 2026-10-22 (Build 1). Once an outside sales partner (Ross Erstling) owns a
// contact in GHL, Reece's floor must stop dialing it: Micaella kept dialing the three
// 1 Leg leads GHL had already handed to Ross, from "Data - Hot - ORL less than 7" and
// DIAL ASAP. A contact becomes the partner's by EITHER path:
//   a) our owner sync (src/partners/owner-sync.js: assigned / reassigned), or
//   b) GHL itself (S5.2 v2 "I. 1 Leg", U.RFED on phone-team: owner-sync's rule 3b,
//      which it never moves), found by owner-sync or by the sweep
//      (src/jobs/partner-five9-sweep.js), which reads the contact's live owner.
//
// THE TRIGGER (the user, 2026-10-22): "When a lead gets tagged phone team then it should
// be removed from all Five9 dialing list." The partner's GHL tag (partner_owner_map.ghl_tag,
// Ross → phone-team) is the trigger: the tag processor (src/ghl-tag-handler.js →
// partnerTagTrigger) runs the removal the moment the tag lands and a release when it
// comes off. A partner OWNER still qualifies as a backup: on 2026-10-22 the three known
// Ross 1 Leg contacts were Ross's in GHL with no phone-team tag, and adding the tag
// ourselves would fire U.RFED's customer SMS and email. A release needs both gone.
//
// WHAT IT DOES: every phone on the contact (GHL phone + additional phones + every
// lp_leads phone / phone_alt) comes off every outbound list in Five9's LIVE inventory
// except Sale / Rehash / Inbound Queue (the disqualified set, disqualifiedTargetLists),
// as five9_delete_record_from_list rows of 10 lists, keyed number1, skip_missing_lists.
// A list the number is not on reads not_on_list. The executor reads each list back
// (per_list); the sweep reads the rows' results and posts a ⚠️ card on a failure.
//
// WHY AGAIN EVERY DAY: Lead Perfection's own Five9 export repopulates the lists at
// 6 AM ET (src/booked-dial-routing.js "LP RE-ADDS", src/five9-admin.js). Nothing in
// LP-MCP or n8n loads those lists, so the source cannot be filtered from code; until
// LP excludes partner-owned leads from its export, the removal is claimed once per
// "removal day" (the ET date of now − 6h20m), so the first pass after each 6 AM load
// takes the numbers off again.
//
// NOT THE DNC LIST: the domain-wide Five9 DNC collides with the DNC Lift process
// (src/consent/), and a list removal needs no undo. On a return (the lead goes back
// to the Reece team) the release writes a row, cancels any removal row not yet run,
// and LP's next 6 AM load puts the numbers back: nothing is written to Five9.
//
// MODE: PARTNER_FIVE9_REMOVAL_MODE off | log | enforce, default log. log reads the
// owner and the inventory and records what would come off (partner_five9_removals,
// mode 'log'); enforce queues the rows, unarmed (keyed on rule PARTNER_FIVE9_REMOVAL
// in src/actions/handlers/five9.js, and only while the mode is still enforce at
// execution). FIVE9_WRITES_ENABLED still decides whether the SOAP delete is real.
//
// Never throws to the caller: the owner write never waits on, or fails because of, Five9.

import { disqualifiedTargetLists } from '../actions/handlers/disqualified-cleanup.js';
import { MAX_DELETE_LISTS_PER_ACTION } from '../five9/admin-writes.js';
import { prospectLabel, slackPhone } from '../format-helpers.js';
import { loadPartnerMap } from './owner-resolver.js';

export const RULE = 'PARTNER_FIVE9_REMOVAL';
export const AUDIT = 'partner_five9';
export const MODES = Object.freeze(['off', 'log', 'enforce']);
// LP's export lands at 6 AM ET; 20 minutes of margin before the new day's removal counts.
export const DAY_ROLLOVER_MS = (6 * 60 + 20) * 60 * 1000;
const PENDING_STATUSES = ['pending', 'pending_approval', 'approved'];

const digits10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const normTag = (t) => String(t ?? '').trim().toLowerCase();

/** Pure: the partner map row a contact belongs to, by its partner owner first, then by a partner tag; or null. */
export function partnerFor(contact, rows) {
  const active = (rows || []).filter((r) => r && r.ghl_user_id);
  const owner = String(contact?.assignedTo || '');
  const byOwner = owner && active.find((r) => String(r.ghl_user_id) === owner);
  if (byOwner) return { row: byOwner, via: 'owner' };
  const tags = new Set((contact?.tags || []).map(normTag));
  const byTag = active.find((r) => r.ghl_tag && tags.has(normTag(r.ghl_tag)));
  return byTag ? { row: byTag, via: 'tag' } : null;
}

/** Pure: the partner tags in a list of (normalized) tags. */
export function partnerTagsIn(tags, rows) {
  const wanted = new Set((rows || []).map((r) => normTag(r?.ghl_tag)).filter(Boolean));
  return (tags || []).map(normTag).filter((t) => wanted.has(t));
}

/** off | log | enforce; anything unknown is log (records only). Pure. */
export function partnerFive9Mode(env = process.env) {
  const v = String(env.PARTNER_FIVE9_REMOVAL_MODE || 'log').trim().toLowerCase();
  return MODES.includes(v) ? v : 'log';
}

/** The ET date whose 6 AM load this pass follows (YYYY-MM-DD). Pure. */
export function removalDay(nowMs = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(nowMs - DAY_ROLLOVER_MS));
}

/** Every distinct 10-digit phone on the contact and its LP leads. Pure. */
export function phonesOf(contact, leads = []) {
  const raw = [contact?.phone];
  for (const p of contact?.additionalPhones || []) raw.push(typeof p === 'string' ? p : p?.phone);
  for (const l of leads || []) raw.push(l?.phone, l?.phone_alt);
  return [...new Set(raw.map(digits10).filter((p) => p.length === 10))];
}

/** Pure: the agent_actions rows for one removal (one row per phone per 10 lists). */
export function planRemovalRows({ contactId, phones, lists, partnerName, group, lead = null, nowMs = Date.now() }) {
  const rows = [];
  const queuedAt = new Date(nowMs).toISOString();
  const chunks = [];
  for (let i = 0; i < lists.length; i += MAX_DELETE_LISTS_PER_ACTION) chunks.push(lists.slice(i, i + MAX_DELETE_LISTS_PER_ACTION));
  for (const ph of phones) {
    chunks.forEach((chunk, i) => rows.push({
      action_type: 'five9_delete_record_from_list', target_system: 'five9', target_entity: 'list', target_id: contactId,
      action_payload: {
        list_names: chunk, field_names: ['number1'], values: [ph], list_delete_mode: 'DELETE_ALL',
        skip_missing_lists: true, group, chunk: { index: i + 1, of: chunks.length }, phone: ph,
        partner_name: partnerName || null, lp_prospect_id: lead?.lp_prospect_id || null,
        reason: 'partner_owned', queued_at: queuedAt,
      },
      reasoning: `${partnerName || 'A partner'} owns this lead in GHL, so Reece stops dialing it: off every outbound list (part ${i + 1} of ${chunks.length}). A list the number is not on is left as is.`,
      rule_applied: RULE, confidence: 1.0, status: 'pending', requires_approval: false, priority: 70,
    }));
  }
  return rows;
}

/** Pure: the ⚠️ card for a removal that could not be done. */
export function buildFailureCard({ contact, contactId, partnerName, lead, phones, error }) {
  const name = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim() || 'Unknown name';
  return [
    `*⚠️ PARTNER LEAD STILL ON A REECE FIVE9 LIST (${partnerName || 'partner'})*`,
    `${name} · ${prospectLabel(lead?.lp_prospect_id)}`,
    `Phone: ${(phones || []).map(slackPhone).join(', ') || 'none on file'}`,
    `Contact ID: ${contactId}`,
    `Error: ${String(error || 'unknown').slice(0, 300)}`,
    'Remove the number from the Reece dialing lists in Five9 by hand.',
  ].join('\n');
}

async function defaultDeps(deps) {
  const out = { ...deps };
  if (!out.supabase) out.supabase = (await import('../supabase.js')).default;
  if (!out.ghlFetch) out.ghlFetch = (await import('../actions/helpers.js')).ghlFetch;
  if (!out.getListsInfo) out.getListsInfo = (await import('../five9-admin.js')).getListsInfo;
  if (!out.postToSlack) out.postToSlack = (await import('../slack.js')).postToSlack;
  if (!out.alertPosted) out.alertPosted = await import('../alert-posted.js');
  out.env = out.env || process.env;
  out.now = out.now || Date.now;
  out.log = out.log || console.log;
  return out;
}

async function leadsFor(d, contactId) {
  const { data, error } = await d.supabase.from('lp_leads')
    .select('lp_lead_id, lp_prospect_id, phone, phone_alt, created_at_lp')
    .eq('ghl_contact_id', String(contactId)).is('lp_deleted_at', null).limit(50);
  if (error) throw new Error(`lp_leads read failed: ${error.message}`);
  return data || [];
}

async function postFailure(d, { contactId, day, ...card }) {
  const channel = String(d.env.PARTNER_ALERT_SLACK_CHANNEL || '').trim();
  if (!channel) return { posted: false, why: 'channel_unset' };
  const items = [{ key: `${contactId}:${day}`, reason: 'five9_failed' }];
  try {
    const { fresh } = await d.alertPosted.filterNew({ audit: AUDIT, items, deps: { supabase: d.supabase } });
    if (!fresh.length) return { posted: false, why: 'already_posted' };
    const res = await d.postToSlack(buildFailureCard({ contactId, ...card }), channel);
    if (res?.ok) await d.alertPosted.recordPosted({ audit: AUDIT, items, deps: { supabase: d.supabase } });
    return { posted: Boolean(res?.ok) };
  } catch (err) {
    d.log(`[PartnerFive9] failure card for ${contactId} not posted: ${err.message}`);
    return { posted: false, why: err.message };
  }
}

/** The contact's latest removal / release row (any mode), or null. Throws on a failed read. */
export async function latestRow(supabase, contactId) {
  const { data, error } = await supabase.from('partner_five9_removals')
    .select('id, action, mode, removal_day, group_key, created_at')
    .eq('ghl_contact_id', String(contactId))
    .order('created_at', { ascending: false }).limit(1);
  if (error) throw new Error(`partner_five9_removals read failed: ${error.message}`);
  return data?.[0] || null;
}

/**
 * Take a partner-owned contact off every Reece Five9 list (once per removal day and mode).
 * opts: { contactId, contact?, partnerRows?, partnerName?, trigger, dryRun, deps }
 * Qualifies by a partner owner OR the partner's GHL tag (partnerFor).
 * Returns { ok, outcome, ... } — never throws.
 */
export async function ensurePartnerFive9Removal(opts = {}) {
  let d;
  try { d = await defaultDeps(opts.deps || {}); } catch (err) { return { ok: false, outcome: 'deps_unavailable', error: err.message }; }
  const { contactId, trigger = 'sweep', dryRun = false } = opts;
  const mode = partnerFive9Mode(d.env);
  if (mode === 'off' && !dryRun) return { ok: true, outcome: 'off' };
  if (!contactId) return { ok: true, outcome: 'no_contact' };
  const day = removalDay(d.now());
  let contact = opts.contact || null;
  let leads = [];
  let phones = [];
  try {
    if (!contact) contact = (await d.ghlFetch('GET', `/contacts/${contactId}`))?.contact;
    if (!contact) throw new Error(`contact ${contactId} not found in GHL`);
    const owner = String(contact.assignedTo || '');
    const rows = opts.partnerRows || await loadPartnerMap(d);
    const hit = partnerFor(contact, rows);
    if (!hit) return { ok: true, outcome: 'not_partner_owned', owner: owner || null };
    const partnerUser = String(hit.row.ghl_user_id);
    const partnerName = opts.partnerName || hit.row.partner_name || null;

    if (!dryRun) {
      const { data: done, error } = await d.supabase.from('partner_five9_removals').select('id')
        .eq('ghl_contact_id', String(contactId)).eq('action', 'remove').eq('mode', mode).eq('removal_day', day).limit(1);
      if (error) throw new Error(`partner_five9_removals read failed: ${error.message}`);
      if (done?.length) return { ok: true, outcome: 'already_done_today', removal_day: day, mode };
    }

    leads = await leadsFor(d, contactId);
    phones = phonesOf(contact, leads);
    if (!phones.length) return { ok: true, outcome: 'no_phone' };
    // Fail closed on the inventory, as the disqualified cleanup does: a removal
    // planned against guessed names is how "Data - Hot" failed every run.
    const lists = disqualifiedTargetLists((await d.getListsInfo())?.lists);
    if (!lists.length) throw new Error('Five9 list inventory came back empty');
    const lead = [...leads].sort((a, b) => String(b.created_at_lp || '').localeCompare(String(a.created_at_lp || '')))[0] || null;
    const group = `partner:${contactId}:${day}`;
    const plan = { removal_day: day, phones, lists, group };
    if (dryRun) return { ok: true, outcome: 'would_remove', mode, ...plan };

    // The claim is written BEFORE anything is queued (a unique index backs it).
    const { error: claimErr } = await d.supabase.from('partner_five9_removals').insert({
      ghl_contact_id: String(contactId), ghl_user_id: partnerUser, partner_name: partnerName,
      action: 'remove', mode, trigger, removal_day: day, phones, lists, group_key: mode === 'enforce' ? group : null,
      lp_lead_id: lead?.lp_lead_id ? String(lead.lp_lead_id) : null, // lead-id-ok: machine value in our own table
      detail: { list_count: lists.length, via: hit.via },
      created_at: new Date(d.now()).toISOString(),
    });
    if (claimErr) {
      if (String(claimErr.code) === '23505') return { ok: true, outcome: 'already_done_today', removal_day: day, mode };
      throw new Error(`partner_five9_removals claim failed: ${claimErr.message}`);
    }
    if (mode === 'log') {
      d.log(`[PartnerFive9] log: ${contactId} (${partnerName || partnerUser}, by ${hit.via}) would leave ${lists.length} list(s) for ${phones.length} phone(s)`);
      return { ok: true, outcome: 'logged', mode, via: hit.via, ...plan };
    }
    const actionRows = planRemovalRows({ contactId, phones, lists, partnerName, group, lead, nowMs: d.now() });
    const { error: insErr } = await d.supabase.from('agent_actions').insert(actionRows);
    if (insErr) {
      // Release the claim so the next pass tries again, and say so now.
      await d.supabase.from('partner_five9_removals').delete()
        .eq('ghl_contact_id', String(contactId)).eq('action', 'remove').eq('mode', mode).eq('removal_day', day);
      throw new Error(`agent_actions insert failed: ${insErr.message}`);
    }
    d.log(`[PartnerFive9] enforce: ${contactId} (${partnerName || partnerUser}, by ${hit.via}) queued ${actionRows.length} removal row(s), ${phones.length} phone(s) × ${lists.length} list(s)`);
    return { ok: true, outcome: 'queued', mode, via: hit.via, rows_queued: actionRows.length, ...plan };
  } catch (err) {
    d.log(`[PartnerFive9] ${contactId}: ${err.message}`);
    const card = mode === 'enforce' && !dryRun
      ? await postFailure(d, { contactId, day, contact, partnerName: opts.partnerName, lead: leads[0] || null, phones, error: err.message })
      : null;
    return { ok: false, outcome: 'error', error: err.message, ...(card ? { card } : {}) };
  }
}

/**
 * The lead went back to the Reece team: stop re-removing, cancel removals not yet run.
 * Nothing is written to Five9 (no DNC was used); LP's next 6 AM load restores the lists.
 */
export async function releasePartnerFive9(opts = {}) {
  let d;
  try { d = await defaultDeps(opts.deps || {}); } catch (err) { return { ok: false, outcome: 'deps_unavailable', error: err.message }; }
  const { contactId, trigger = 'returned', dryRun = false } = opts;
  if (!contactId) return { ok: true, outcome: 'no_contact' };
  try {
    const last = await latestRow(d.supabase, contactId);
    if (!last || last.action !== 'remove') return { ok: true, outcome: 'nothing_to_release' };
    // Released only when neither the partner tag nor a partner owner remains (read live;
    // a failed read releases nothing).
    const contact = opts.contact || (await d.ghlFetch('GET', `/contacts/${contactId}`))?.contact;
    if (!contact) throw new Error(`contact ${contactId} not found in GHL`);
    const still = partnerFor(contact, opts.partnerRows || await loadPartnerMap(d));
    if (still) return { ok: true, outcome: 'still_partner', via: still.via };
    if (dryRun) return { ok: true, outcome: 'would_release' };
    const { data: cancelled, error: cErr } = await d.supabase.from('agent_actions')
      .update({ status: 'skipped', execution_result: { skipped: true, reason: 'partner_returned_to_reece' } })
      .eq('rule_applied', RULE).eq('target_id', String(contactId)).in('status', PENDING_STATUSES)
      .select('id');
    if (cErr) throw new Error(`agent_actions cancel failed: ${cErr.message}`);
    const { error } = await d.supabase.from('partner_five9_removals').insert({
      ghl_contact_id: String(contactId), action: 'release', mode: last.mode, trigger,
      detail: { cancelled_rows: (cancelled || []).length, after: last.id },
      created_at: new Date(d.now()).toISOString(),
    });
    if (error) throw new Error(`partner_five9_removals release write failed: ${error.message}`);
    d.log(`[PartnerFive9] released ${contactId} (${trigger}); ${(cancelled || []).length} queued removal(s) cancelled`);
    return { ok: true, outcome: 'released', cancelled_rows: (cancelled || []).length };
  } catch (err) {
    d.log(`[PartnerFive9] release ${contactId}: ${err.message}`);
    return { ok: false, outcome: 'error', error: err.message };
  }
}

/** Pure: the read-back of one enforce group's executed rows. */
export function summarizeGroup(actions) {
  const rows = Array.isArray(actions) ? actions : [];
  const removedFrom = new Set();
  const errors = [];
  let open = 0;
  for (const a of rows) {
    if (a.status === 'failed') errors.push(String(a.error_message || a.execution_result?.error || 'failed').slice(0, 200));
    else if (!['completed', 'skipped', 'suppressed', 'expired'].includes(a.status)) open++;
    for (const l of a.execution_result?.per_list || []) if (l.outcome === 'deleted') removedFrom.add(l.list);
    if (a.execution_result?.list && a.execution_result?.records_deleted > 0) removedFrom.add(a.execution_result.list);
  }
  return { settled: open === 0, open, removed_from: [...removedFrom].sort(), errors, dry_run: rows.some((a) => a.execution_result?.dry_run) };
}

/**
 * Read back recent enforce groups: record what came off (detail.five9) and post one ⚠️ card per failed group.
 * Never throws; returns counts.
 */
export async function settleRecentGroups({ deps = {}, sinceMs = 2 * 24 * 60 * 60 * 1000 } = {}) {
  const d = await defaultDeps(deps);
  const out = { checked: 0, settled: 0, failed: 0 };
  const { data: groups, error } = await d.supabase.from('partner_five9_removals')
    .select('id, ghl_contact_id, partner_name, removal_day, phones, group_key, lp_lead_id, detail')
    .eq('action', 'remove').eq('mode', 'enforce')
    .gte('created_at', new Date(d.now() - sinceMs).toISOString()).limit(200);
  if (error) throw new Error(`partner_five9_removals read failed: ${error.message}`);
  for (const g of groups || []) {
    if (!g.group_key || g.detail?.five9?.settled) continue;
    out.checked++;
    const { data: actions, error: aErr } = await d.supabase.from('agent_actions')
      .select('id, status, execution_result, error_message')
      .eq('rule_applied', RULE).eq('target_id', g.ghl_contact_id)
      .contains('action_payload', { group: g.group_key }).limit(100);
    if (aErr) continue;
    const s = summarizeGroup(actions);
    if (!s.settled) continue;
    const five9 = { settled: true, removed_from: s.removed_from, errors: s.errors, ...(s.dry_run ? { dry_run: true } : {}) };
    await d.supabase.from('partner_five9_removals').update({ detail: { ...(g.detail || {}), five9 } }).eq('id', g.id);
    out.settled++;
    if (s.errors.length) {
      out.failed++;
      await postFailure(d, {
        contactId: g.ghl_contact_id, day: g.removal_day, contact: null, partnerName: g.partner_name,
        lead: null, phones: g.phones, error: s.errors[0],
      });
    }
  }
  return out;
}

/**
 * The tag trigger (the user, 2026-10-22), called by the tag processor with the diff it
 * computed. A partner tag added → the removal now; one removed → the release (which
 * still holds while a partner owns the contact). Never throws. Off with the partner
 * sync off or the mode off, so the processor's own tests never reach Five9.
 */
export async function partnerTagTrigger({ contactId, added = [], removed = [], deps = {} } = {}) {
  try {
    const env = deps.env || process.env;
    if (partnerFive9Mode(env) === 'off') return { outcome: 'off' };
    const { partnerSyncConfig } = await import('./owner-sync.js');
    if (!partnerSyncConfig(env).enabled) return { outcome: 'partner_sync_off' };
    const d = await defaultDeps(deps);
    const rows = await loadPartnerMap(d);
    if (partnerTagsIn(added, rows).length) {
      return await ensurePartnerFive9Removal({ contactId, partnerRows: rows, trigger: 'tag_added', deps: d });
    }
    if (partnerTagsIn(removed, rows).length) {
      return await releasePartnerFive9({ contactId, partnerRows: rows, trigger: 'tag_removed', deps: d });
    }
    return { outcome: 'no_partner_tag' };
  } catch (err) {
    console.warn(`[PartnerFive9] tag trigger for ${contactId}: ${err.message}`);
    return { outcome: 'error', error: err.message };
  }
}
