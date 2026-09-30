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
// It ALWAYS posts: a clean run says so, and a run that could not read says
// that, so silence never means "did not run".

import { pickCurrentLead } from '../current-lead.js';
import { contactHadDemo } from '../demo-truth.js';
import { runJob } from '../job-runner.js';
import { hourET, todayET } from './lp-report-common.js';

export const JOB_ID = 'f0-integrity-audit';
export const F0_ACTIVE_TAG = 'active-f.0';
export const RUN_HOUR_ET = 8;
export const MAX_LINES = 25;
const LP_CHUNK = 200;

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

/** Pure. The Slack card body. */
export function formatF0AuditReport({ total, flagged, error = null }) {
  if (error) return `⚠️ F.0 integrity audit could not run: ${error}`;
  if (flagged.length === 0) return `✅ F.0 integrity: 0 of ${total} active contacts flagged — clean.`;
  const lines = flagged.slice(0, MAX_LINES)
    .map((f) => `• ${f.contact_id} · ${f.disposition || 'none'} · ${f.reason}`);
  const more = flagged.length > MAX_LINES ? [`…and ${flagged.length - MAX_LINES} more`] : [];
  return [`🔎 F.0 integrity: ${flagged.length} of ${total} active contacts flagged`, ...lines, ...more].join('\n');
}

async function defaultDeps() {
  const [{ default: supabase }, { hlRunSQL }, { sendAlertMessage }] = await Promise.all([
    import('../supabase.js'),
    import('../admin/hl-client.js'),
    import('../alert-state.js'),
  ]);
  return { supabase, hlRunSQL, sendAlertMessage };
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
      .select('ghl_contact_id, lp_lead_id, disposition_code, closed_won, created_at_lp, updated_at_lp, appts:raw_lp_data->appointments')
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

/**
 * Run the audit. `post: true` sends the card to #ops-alerts (Slack only, via
 * sendAlertMessage — CLAUDE.md: operational alarms never go to GroupMe).
 * Returns { ok, total, flagged, text }. A read failure is ok:false, so runJob
 * records the pass as failed rather than clean.
 */
export async function runF0IntegrityAudit({ post = true, deps: depsArg } = {}) {
  const deps = depsArg || await defaultDeps();
  let result;
  try {
    const ids = await loadActiveF0Contacts(deps);
    const leads = await loadLeads(deps, ids);
    const flagged = [];
    for (const id of ids.sort()) {
      const flag = flagF0Contact(leads.get(id));
      if (flag) flagged.push({ contact_id: id, ...flag });
    }
    result = { ok: true, total: ids.length, flagged };
  } catch (err) {
    result = { ok: false, total: 0, flagged: [], error: err.message };
  }
  result.text = formatF0AuditReport(result);
  if (post) await deps.sendAlertMessage(result.text, { channel: 'ops' });
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
