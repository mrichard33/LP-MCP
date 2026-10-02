// ─── F.0 integrity audit — src/jobs/f0-integrity-audit.js ────────────────────
//
// 2026-09-30 (fix/f0-oppfdn-integrity). READ-ONLY: never writes to GHL or LP.
//
// F.0 Post-Appointment Follow-Up is meant to hold ONLY contacts whose current
// LP lead (src/current-lead.js) is OPPFDN and who really had a demo
// (src/demo-truth.js). On 2026-09-30 about 19 of 390 contacts in F.0 had no
// demo, because F.0 was entered by a GHL stage trigger that trusted a field
// with two writers. The agent rules F0_ENROLL_CURRENT_OPPFDN /
// F0_EXIT_NOT_OPPFDN now own entry and exit; this job proves they hold, once a
// day, in #ops-alerts.
//
// A contact carrying active-f.0 is flagged when:
//   - no LP lead is linked to it, OR
//   - its current disposition is anything but OPPFDN — Sale included (Mark,
//     2026-09-30: a sale leaves F.0; C.0 onboarding has its own triggers), OR
//   - contactHadDemo() is false.
//
// 2026-10-01 — it also looks the OTHER way: a contact whose current lead is
// OPPFDN with an appointment in the last 14 days (the window
// F0_ENROLL_CURRENT_OPPFDN enrolls in) and who does NOT carry active-f.0 is
// listed as "demoed, not in F.0". On 9/30–10/1, 32 demos never reached F.0
// (the gate read a stale LP Disposition; a blank Data lead hid Sharyn Blake's
// demo) and nothing said so. Contacts carrying one of the enroll rule's own
// exclusion tags are skipped, and so is a contact missing from the HL cache —
// "could not read" is not "missing". Report only: it never enrolls anyone.
//
// 2026-10-02 (Mark) — quieter, and it watches S5.2 too:
//   - "Missing from F.0" counts only demos with an appointment on or after
//     F0_AUDIT_SINCE (default 2026-10-01T15:40:00Z, when rule 393 went live).
//     The older backlog is ignored on purpose: no backfill.
//   - An S5.2 section lists contacts in S5.2 that fail the entry gate
//     (src/s52-entry-gate.js), and no-demo cancels since F0_AUDIT_SINCE that
//     never reached S5.2 and were not blocked on purpose (an s52.entry_blocked
//     event, or a pending 30-minute cancel re-check, means it was decided).
//   - It posts ONLY problems it has not posted in the last 30 days
//     (audit_posted_items, sql/143). A clean run, or one with nothing new,
//     posts nothing — runJob still records the pass. A run that could not read
//     STILL posts, so silence never hides a failure.
//   - The card is one line per contact: name · contact id · what's wrong ·
//     what to do, at most 10 lines plus "N more".

import { pickCurrentLead } from '../current-lead.js';
import { contactHadDemo } from '../demo-truth.js';
import { lpStoredToUtcMs } from '../lp-dates.js';
import { runJob } from '../job-runner.js';
import { hourET, todayET } from './lp-report-common.js';
import { evaluateS52Entry, isGatedState, isS52Target } from '../s52-entry-gate.js';

export const JOB_ID = 'f0-integrity-audit';
export const F0_ACTIVE_TAG = 'active-f.0';
export const RUN_HOUR_ET = 8;
export const MAX_LINES = 25;
const LP_CHUNK = 200;
export const MISSING_WINDOW_DAYS = 14; // = F0_ENROLL_CURRENT_OPPFDN max_days_since_appointment
// Same list as F0_ENROLL_CURRENT_OPPFDN's not_has_any_tag (agent_rules 393):
// a contact the rule would refuse is not "missing".
export const F0_ENROLL_EXCLUDE_TAGS = [
  'customer', 'lp-sale', 'deal-won', 'dnc', 'lp-dnc', 'stage:dnc', 'stop-bot', 'suppress-outbound',
];

export const AUDIT_KEY = 'f0-s52-integrity';
export const CARD_MAX_LINES = 10;
export const POSTED_TTL_DAYS = 30;
export const DEFAULT_AUDIT_SINCE = '2026-10-01T15:40:00Z';
export const S52_ACTIVE_TAGS = ['active-s5.2', 'active-w5.2'];
// A cancel the cold-cancel rules (171 / 271) would refuse anyway is not a
// "missed" S5.2 entry: their own not_has_any_tag lists plus the opt-outs.
export const S52_CANCEL_EXCLUDE_TAGS = [
  'lp-demo-completed', 'stage:post-appointment', 'bj:stage-4-negotiating', 'bj:stage-5-committed',
  'hard-disqualified', 'suppress-outbound', 'stop-bot', 'rescission-state:active',
  'intent-rescission-rescue', 'lost-post-rescission', 's52-task-created', 'stage:dnc',
  'dnc', 'lp-dnc', 'customer', 'lp-sale', 'deal-won',
];
const S52_CANCEL_WINDOW_DAYS = 14; // = rule 271 lp_current_lead_match.appointment_within_days
const LIVE_CONFIRM_CAP = 25;

/** F0_AUDIT_SINCE as epoch ms (default: when rule 393 went live). */
export function auditSinceMs(env = process.env) {
  const ms = Date.parse(env.F0_AUDIT_SINCE || DEFAULT_AUDIT_SINCE);
  return Number.isFinite(ms) ? ms : Date.parse(DEFAULT_AUDIT_SINCE);
}

/** Pure. Why this contact should not be in F.0, or null when it belongs. */
export function flagF0Contact(leads) {
  const rows = Array.isArray(leads) ? leads : [];
  if (rows.length === 0) return { disposition: null, reason: 'no LP lead linked' };
  const current = pickCurrentLead(rows);
  const disposition = String(current?.disposition_code ?? '').trim() || null;
  if (disposition !== 'OPPFDN') {
    return { disposition, reason: `current disposition is ${disposition || 'empty'}, not OPPFDN` };
  }
  if (!contactHadDemo(rows)) return { disposition, reason: 'no real demo on record' };
  return null;
}

/**
 * Pure. True when this contact demoed recently (current lead OPPFDN, appointment
 * within MISSING_WINDOW_DAYS and not in the future) but is not in F.0.
 * tags === undefined means the contact is not in the HL cache: not missing.
 */
export function isMissingFromF0(leads, tags, nowMs = Date.now(), sinceMs = -Infinity) {
  if (!Array.isArray(tags)) return false;
  const lower = tags.map((t) => String(t).toLowerCase());
  if (lower.includes(F0_ACTIVE_TAG) || F0_ENROLL_EXCLUDE_TAGS.some((t) => lower.includes(t))) return false;
  const current = pickCurrentLead(Array.isArray(leads) ? leads : []);
  if (String(current?.disposition_code ?? '').trim() !== 'OPPFDN') return false;
  const apptMs = current.appointment_date ? lpStoredToUtcMs(current.appointment_date) : NaN;
  if (!Number.isFinite(apptMs) || apptMs > nowMs) return false;
  // 2026-10-02 — demos before F0_AUDIT_SINCE are the old backlog (no backfill).
  if (apptMs < sinceMs) return false;
  return (nowMs - apptMs) / 86_400_000 <= MISSING_WINDOW_DAYS;
}

/**
 * Pure. A no-demo cancel that should have reached S5.2 and did not.
 * `ctx` = { tags, blocked, recheckQueued, s52Enrolled } for this contact.
 * tags undefined (not in the HL cache) → not missed: could not read is not missing.
 */
export function isMissedS52Cancel(leads, ctx = {}, nowMs = Date.now(), sinceMs = -Infinity) {
  const { tags, blocked, recheckQueued, s52Enrolled } = ctx;
  if (!Array.isArray(tags) || blocked || recheckQueued || s52Enrolled) return false;
  const lower = tags.map((t) => String(t).toLowerCase());
  if (S52_ACTIVE_TAGS.some((t) => lower.includes(t))) return false;
  if (S52_CANCEL_EXCLUDE_TAGS.some((t) => lower.includes(t))) return false;
  const rows = Array.isArray(leads) ? leads : [];
  const current = pickCurrentLead(rows);
  if (!['CXL', 'CCC'].includes(String(current?.disposition_code ?? '').trim())) return false;
  const changedMs = lpStoredToUtcMs(current.updated_at_lp);
  if (!Number.isFinite(changedMs) || changedMs < sinceMs) return false;
  const apptMs = current.appointment_date ? lpStoredToUtcMs(current.appointment_date) : NaN;
  if (!Number.isFinite(apptMs) || (nowMs - apptMs) / 86_400_000 > S52_CANCEL_WINDOW_DAYS) return false;
  return evaluateS52Entry({ leads: rows, tags, nowMs }).allow;
}

const displayName = (info) => {
  const n = [info?.first_name, info?.last_name].map((x) => String(x ?? '').trim()).filter(Boolean).join(' ');
  return n || '(no name)';
};

/** Pure. Every problem as one card item with a stable reason key. */
export function auditItems(result) {
  const name = (id) => displayName(result.names?.get?.(id));
  const items = [];
  for (const f of result.flagged || []) {
    items.push({ contact_id: f.contact_id, name: name(f.contact_id), reason: `f0_flag:${f.disposition || 'none'}`,
      wrong: `in F.0 — ${f.reason}`, todo: 'remove from F.0' });
  }
  for (const m of result.missing || []) {
    items.push({ contact_id: m.contact_id, name: name(m.contact_id), reason: 'f0_missing',
      wrong: `demoed (lead ${m.lp_lead_id ?? '?'}, OPPFDN) but not in F.0`, todo: 'check why F.0 did not enroll' });
  }
  for (const f of result.s52?.flagged || []) {
    items.push({ contact_id: f.contact_id, name: name(f.contact_id), reason: `s52_flag:${f.reason}`,
      wrong: `in S5.2 — ${S52_REASON_TEXT[f.reason] || f.reason}`, todo: 'remove from S5.2' });
  }
  for (const m of result.s52?.missed || []) {
    items.push({ contact_id: m.contact_id, name: name(m.contact_id), reason: 's52_missed_cancel',
      wrong: `no-demo cancel (lead ${m.lp_lead_id ?? '?'}, ${m.disposition}) not in S5.2 and not blocked`, todo: 'check why S5.2 did not enroll' });
  }
  return items;
}

const S52_REASON_TEXT = {
  canvassing: 'canvassing contact',
  demo_on_any_lead: 'had a demo',
  live_appointment: 'has a live appointment',
  current_lead_issue: 'current lead is Issue',
  current_lead_no_demo: 'current lead is No Demo / ND / NOC',
};

/** Pure. The Slack card for NEW items only. */
export function formatAuditCard(items, { total = items.length } = {}) {
  const lines = items.slice(0, CARD_MAX_LINES).map((i) => `• ${i.name} · ${i.contact_id} · ${i.wrong} · ${i.todo}`);
  if (items.length > CARD_MAX_LINES) lines.push(`…and ${items.length - CARD_MAX_LINES} more`);
  const head = total > items.length
    ? `🔎 F.0 / S5.2 integrity: ${items.length} new problem(s) (${total - items.length} already posted)`
    : `🔎 F.0 / S5.2 integrity: ${items.length} new problem(s)`;
  return [head, ...lines].join('\n');
}

function listLines(rows, render) {
  const lines = rows.slice(0, MAX_LINES).map(render);
  return rows.length > MAX_LINES ? [...lines, `…and ${rows.length - MAX_LINES} more`] : lines;
}

/** Pure. The full report text (stdout / post=false). The Slack card is formatAuditCard. */
export function formatF0AuditReport({ total, flagged, missing = [], s52 = null, error = null }) {
  if (error) return `⚠️ F.0 integrity audit could not run: ${error}`;
  const s52Flagged = s52?.flagged || [];
  const s52Missed = s52?.missed || [];
  if (flagged.length === 0 && missing.length === 0 && s52Flagged.length === 0 && s52Missed.length === 0) {
    return `✅ F.0 integrity: 0 of ${total} active contacts flagged, 0 demos missing — clean.`
      + (s52 ? `\n✅ S5.2 integrity: 0 of ${s52.total} active contacts flagged, 0 cancels missed — clean.` : '');
  }
  const out = [];
  if (flagged.length) {
    out.push(`🔎 F.0 integrity: ${flagged.length} of ${total} active contacts flagged`,
      ...listLines(flagged, (f) => `• ${f.contact_id} · ${f.disposition || 'none'} · ${f.reason}`));
  }
  if (missing.length) {
    out.push(`🚪 Demoed in the last ${MISSING_WINDOW_DAYS} days but NOT in F.0: ${missing.length}`,
      ...listLines(missing, (m) => `• ${m.contact_id} · lead ${m.lp_lead_id ?? '?'}`));
  }
  if (s52Flagged.length) {
    out.push(`🔎 S5.2 integrity: ${s52Flagged.length} of ${s52.total} active contacts fail the entry gate`,
      ...listLines(s52Flagged, (f) => `• ${f.contact_id} · ${f.reason}${f.confirmed === false ? ' (cache only — live read failed)' : ''}`));
  }
  if (s52Missed.length) {
    out.push(`🚪 No-demo cancels NOT in S5.2 and not blocked: ${s52Missed.length}`,
      ...listLines(s52Missed, (m) => `• ${m.contact_id} · lead ${m.lp_lead_id ?? '?'} · ${m.disposition}`));
  }
  return out.join('\n');
}

async function defaultDeps() {
  const [{ default: supabase }, { hlRunSQL }, { sendAlertMessage }, { checkS52Entry }] = await Promise.all([
    import('../supabase.js'),
    import('../admin/hl-client.js'),
    import('../alert-state.js'),
    import('../s52-entry-gate.js'),
  ]);
  return { supabase, hlRunSQL, sendAlertMessage, checkS52Entry };
}

async function loadActiveF0Contacts(deps) {
  const rows = await deps.hlRunSQL(
    `SELECT ghl_contact_id FROM contacts
      WHERE deleted_at IS NULL AND ghl_contact_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM unnest(tags) t WHERE lower(t) = '${F0_ACTIVE_TAG}')`,
  );
  return [...new Set((rows || []).map((r) => r.ghl_contact_id).filter(Boolean))];
}

async function loadLeads(deps, contactIds) {
  if (!deps.supabase) throw new Error('LP Supabase not configured');
  const byContact = new Map();
  for (let i = 0; i < contactIds.length; i += LP_CHUNK) {
    const { data, error } = await deps.supabase.from('lp_leads')
      .select('ghl_contact_id, lp_lead_id, disposition_code, closed_won, appointment_date, created_at_lp, updated_at_lp, appts:raw_lp_data->appointments')
      .in('ghl_contact_id', contactIds.slice(i, i + LP_CHUNK))
      .is('lp_deleted_at', null);
    if (error) throw new Error(`lp_leads read failed: ${error.message}`);
    for (const row of data || []) {
      if (!byContact.has(row.ghl_contact_id)) byContact.set(row.ghl_contact_id, []);
      byContact.get(row.ghl_contact_id).push(row);
    }
  }
  return byContact;
}

// Contacts with an OPPFDN lead whose appointment is inside the window. Wide on
// purpose (one extra day); isMissingFromF0 makes the exact call on the
// CURRENT lead.
async function loadRecentOppfdnContacts(deps, nowMs) {
  const since = new Date(nowMs - (MISSING_WINDOW_DAYS + 1) * 86_400_000).toISOString();
  const { data, error } = await deps.supabase.from('lp_leads')
    .select('ghl_contact_id')
    .eq('disposition_code', 'OPPFDN')
    .gte('appointment_date', since)
    .not('ghl_contact_id', 'is', null)
    .is('lp_deleted_at', null)
    .limit(5000);
  if (error) throw new Error(`recent OPPFDN read failed: ${error.message}`);
  return [...new Set((data || []).map((r) => r.ghl_contact_id).filter(Boolean))];
}

async function loadTags(deps, ids, names = null) {
  const tags = new Map();
  for (let i = 0; i < ids.length; i += LP_CHUNK) {
    const inList = ids.slice(i, i + LP_CHUNK).map((id) => `'${String(id).replace(/'/g, "''")}'`).join(',');
    const rows = await deps.hlRunSQL(
      `SELECT ghl_contact_id, to_jsonb(tags) AS tags, first_name, last_name FROM contacts WHERE deleted_at IS NULL AND ghl_contact_id IN (${inList})`,
    );
    for (const r of rows || []) {
      tags.set(r.ghl_contact_id, Array.isArray(r.tags) ? r.tags : []);
      if (names) names.set(r.ghl_contact_id, { first_name: r.first_name, last_name: r.last_name });
    }
  }
  return tags;
}

// Written as unnest(contacts.tags) so it never reads as the F.0 query above.
async function loadActiveS52Contacts(deps) {
  const rows = await deps.hlRunSQL(
    `SELECT ghl_contact_id FROM contacts
      WHERE deleted_at IS NULL AND ghl_contact_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM unnest(contacts.tags) t WHERE lower(t) IN ('${S52_ACTIVE_TAGS.join("','")}'))`,
  );
  return [...new Set((rows || []).map((r) => r.ghl_contact_id).filter(Boolean))];
}

// Newest objection state per contact. A contact in S5.2 for a pre-demo worry
// (APPOINTMENT_FRICTION other than ghost) belongs there with a live
// appointment — the gate does not judge it, so neither does the audit.
async function loadLatestStates(deps, ids) {
  const latest = new Map();
  for (let i = 0; i < ids.length; i += LP_CHUNK) {
    const { data, error } = await deps.supabase.from('contact_objection_states')
      .select('contact_id, state_code, entered_at, exited_at')
      .in('contact_id', ids.slice(i, i + LP_CHUNK))
      .is('exited_at', null);
    if (error) throw new Error(`contact_objection_states read failed: ${error.message}`);
    for (const r of data || []) {
      const prev = latest.get(r.contact_id);
      if (!prev || String(r.entered_at) > String(prev.entered_at)) latest.set(r.contact_id, r);
    }
  }
  return latest;
}

async function auditS52(deps, nowMs, sinceMs, names) {
  const ids = (await loadActiveS52Contacts(deps)).sort();
  const flagged = [];
  if (ids.length) {
    const [leads, tags, states] = await Promise.all([loadLeads(deps, ids), loadTags(deps, ids, names), loadLatestStates(deps, ids)]);
    let liveChecks = 0;
    for (const id of ids) {
      const state = states.get(id)?.state_code;
      if (state && !isGatedState(state)) continue; // pre-demo friction: not the gate's business
      const verdict = evaluateS52Entry({ leads: leads.get(id) || [], tags: tags.get(id) || [], nowMs });
      if (verdict.allow) continue;
      // Confirm against LP / GHL live before listing it (cache can lag).
      if (liveChecks < LIVE_CONFIRM_CAP && deps.checkS52Entry) {
        liveChecks++;
        const live = await deps.checkS52Entry(id, { nowMs });
        if (live.allow) continue;
        if (!String(live.reason).startsWith('read_failed')) { flagged.push({ contact_id: id, reason: live.reason, confirmed: true }); continue; }
        flagged.push({ contact_id: id, reason: verdict.reason, confirmed: false });
        continue;
      }
      flagged.push({ contact_id: id, reason: verdict.reason, confirmed: false });
    }
  }

  // The other direction: no-demo cancels since the cutoff that never got in.
  const sinceIso = new Date(sinceMs).toISOString();
  const { data: cxl, error } = await deps.supabase.from('lp_leads')
    .select('ghl_contact_id')
    .in('disposition_code', ['CXL', 'CCC'])
    .gte('updated_at_lp', sinceIso)
    .not('ghl_contact_id', 'is', null)
    .is('lp_deleted_at', null)
    .limit(5000);
  if (error) throw new Error(`recent cancels read failed: ${error.message}`);
  const candidates = [...new Set((cxl || []).map((r) => r.ghl_contact_id).filter(Boolean))].sort();
  const missed = [];
  if (candidates.length) {
    const [leads, tags, decided] = await Promise.all([
      loadLeads(deps, candidates), loadTags(deps, candidates, names), loadS52Decisions(deps, candidates, sinceIso),
    ]);
    for (const id of candidates) {
      const rows = leads.get(id) || [];
      const ctx = { tags: tags.get(id), ...(decided.get(id) || {}) };
      if (isMissedS52Cancel(rows, ctx, nowMs, sinceMs)) {
        const cur = pickCurrentLead(rows);
        missed.push({ contact_id: id, lp_lead_id: cur?.lp_lead_id ?? null, disposition: cur?.disposition_code ?? null });
      }
    }
  }
  return { total: ids.length, flagged, missed };
}

// Per contact since the cutoff: blocked on purpose (s52.entry_blocked), a
// cancel re-check queued, or an S5.2 enrollment that went out.
async function loadS52Decisions(deps, ids, sinceIso) {
  const out = new Map();
  const mark = (id, k) => out.set(id, { ...(out.get(id) || {}), [k]: true });
  for (let i = 0; i < ids.length; i += LP_CHUNK) {
    const chunk = ids.slice(i, i + LP_CHUNK);
    const { data: ev, error: evErr } = await deps.supabase.from('system_events')
      .select('ghl_contact_id, payload')
      .eq('event_type', 's52.entry_blocked')
      .in('ghl_contact_id', chunk)
      .gte('created_at', sinceIso);
    if (evErr) throw new Error(`s52.entry_blocked read failed: ${evErr.message}`);
    // A block because a read FAILED is not a decision — keep listing it.
    for (const r of ev || []) if (!String(r.payload?.reason || '').startsWith('read_failed')) mark(r.ghl_contact_id, 'blocked');
    const { data: acts, error: aErr } = await deps.supabase.from('agent_actions')
      .select('target_id, action_type, action_payload, status, rule_applied')
      .in('target_id', chunk)
      .in('action_type', ['add_to_workflow', 's52_cancel_recheck'])
      .gte('created_at', sinceIso);
    if (aErr) throw new Error(`agent_actions read failed: ${aErr.message}`);
    for (const a of acts || []) {
      if (a.action_type === 's52_cancel_recheck' && a.status === 'pending') mark(a.target_id, 'recheckQueued');
      if (a.action_type === 'add_to_workflow' && a.status === 'completed' && isS52Target(a.action_payload)) mark(a.target_id, 's52Enrolled');
    }
  }
  return out;
}

/**
 * Drop items already posted in the last POSTED_TTL_DAYS. Also deletes rows
 * past the TTL. A failed read posts everything (never silence a real problem).
 */
async function filterNewItems(deps, items, nowMs) {
  if (!items.length) return { fresh: [], dedupe: 'none' };
  const cutoffIso = new Date(nowMs - POSTED_TTL_DAYS * 86_400_000).toISOString();
  try {
    await deps.supabase.from('audit_posted_items').delete().eq('audit', AUDIT_KEY).lt('posted_at', cutoffIso);
    const ids = [...new Set(items.map((i) => i.contact_id))];
    const seen = new Set();
    for (let i = 0; i < ids.length; i += LP_CHUNK) {
      const { data, error } = await deps.supabase.from('audit_posted_items')
        .select('contact_id, reason')
        .eq('audit', AUDIT_KEY)
        .in('contact_id', ids.slice(i, i + LP_CHUNK))
        .gte('posted_at', cutoffIso);
      if (error) throw new Error(error.message);
      for (const r of data || []) seen.add(`${r.contact_id}|${r.reason}`);
    }
    return { fresh: items.filter((i) => !seen.has(`${i.contact_id}|${i.reason}`)), dedupe: 'ok' };
  } catch (err) {
    console.warn(`[F0Audit] audit_posted_items unreadable — posting everything: ${err.message}`);
    return { fresh: items, dedupe: 'unavailable' };
  }
}

async function recordPosted(deps, items, nowMs) {
  if (!items.length) return;
  try {
    const rows = items.map((i) => ({ audit: AUDIT_KEY, contact_id: i.contact_id, reason: i.reason, posted_at: new Date(nowMs).toISOString() }));
    const { error } = await deps.supabase.from('audit_posted_items').upsert(rows, { onConflict: 'audit,contact_id,reason' });
    if (error) throw new Error(error.message);
  } catch (err) {
    console.warn(`[F0Audit] could not record posted items (they may repeat tomorrow): ${err.message}`);
  }
}

/**
 * Run the audit. `post: true` sends a card of NEW problems to #ops-alerts
 * (Slack only, via sendAlertMessage — CLAUDE.md: operational alarms never go
 * to GroupMe). Nothing new → no post. A read failure always posts.
 * Returns { ok, total, flagged, missing, s52, items, posted, text }. A read
 * failure is ok:false, so runJob records the pass as failed rather than clean.
 */
export async function runF0IntegrityAudit({ post = true, deps: depsArg } = {}) {
  const deps = depsArg || await defaultDeps();
  const nowMs = deps.nowMs ?? Date.now();
  const sinceMs = deps.sinceMs ?? auditSinceMs();
  const names = new Map();
  let result;
  try {
    const ids = await loadActiveF0Contacts(deps);
    const leads = await loadLeads(deps, ids);
    const flagged = [];
    for (const id of ids.sort()) {
      const flag = flagF0Contact(leads.get(id));
      if (flag) flagged.push({ contact_id: id, ...flag });
    }
    if (flagged.length) await loadTags(deps, flagged.map((f) => f.contact_id), names);
    const candidates = await loadRecentOppfdnContacts(deps, nowMs);
    const [candLeads, candTags] = await Promise.all([loadLeads(deps, candidates), loadTags(deps, candidates, names)]);
    const missing = [];
    for (const id of candidates.sort()) {
      const rows = candLeads.get(id) || [];
      if (isMissingFromF0(rows, candTags.get(id), nowMs, sinceMs)) {
        missing.push({ contact_id: id, lp_lead_id: pickCurrentLead(rows)?.lp_lead_id ?? null });
      }
    }
    const s52 = await auditS52(deps, nowMs, sinceMs, names);
    result = { ok: true, total: ids.length, flagged, missing, s52, names };
  } catch (err) {
    result = { ok: false, total: 0, flagged: [], missing: [], s52: null, error: err.message };
  }
  result.text = formatF0AuditReport(result);
  result.items = result.ok ? auditItems(result) : [];
  result.posted = 0;
  if (post) {
    if (!result.ok) {
      await deps.sendAlertMessage(result.text, { channel: 'ops' });
    } else if (result.items.length) {
      const { fresh, dedupe } = await filterNewItems(deps, result.items, nowMs);
      result.dedupe = dedupe;
      if (fresh.length) {
        await deps.sendAlertMessage(formatAuditCard(fresh, { total: result.items.length }), { channel: 'ops' });
        await recordPosted(deps, fresh, nowMs);
        result.posted = fresh.length;
      } else {
        console.log(`[F0Audit] ${result.items.length} problem(s), all already posted — no card`);
      }
    } else {
      console.log('[F0Audit] clean — no card');
    }
  }
  delete result.names;
  return result;
}

function auditEnabled(env = process.env) {
  return String(env.F0_AUDIT_ENABLED || 'true').toLowerCase() !== 'false';
}

// ── Scheduler — daily at 08:00 ET ──────────────────────────────────────────
// Same 5-minute tick as the other daily jobs (docs/job-runs.md); the work is
// wrapped in runJob, not the tick.
let timer = null;
let lastRunSlot = null;

export function startF0IntegrityAuditScheduler() {
  if (timer) return;
  if (!auditEnabled()) {
    console.log('[F0Audit] disabled (F0_AUDIT_ENABLED=false)');
    return;
  }
  console.log('[F0Audit] Scheduler started — daily run at 08:00 ET');
  const checkAndRun = async () => {
    const today = todayET();
    if (hourET() === RUN_HOUR_ET && lastRunSlot !== today) {
      lastRunSlot = today;
      try {
        await runJob(JOB_ID, () => runF0IntegrityAudit({ post: true }), { occurrence: today });
      } catch (err) {
        console.error('[F0Audit] run failed:', err.message);
      }
    }
  };
  timer = setInterval(checkAndRun, 5 * 60 * 1000);
  timer.unref?.();
}

export function stopF0IntegrityAuditScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
