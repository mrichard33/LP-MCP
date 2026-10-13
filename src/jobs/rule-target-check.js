// ─── Nightly rule-target check — src/jobs/rule-target-check.js ────────────
//
// 2026-10-12 (F-L). Every enabled agent_rules row that adds or removes a
// contact from a GHL workflow, and every rule that fires on a workflow
// finishing, must point at a PUBLISHED workflow. GHL answers 200 to a webhook
// whose trigger sits on a draft, so a dead route reads "completed" forever:
// rule 164 did that 64 times. The pure judgment is src/rule-target-resolve.js;
// this module reads, writes rule_target_checks and schedules.
//
// Runs daily at 02:10 ET (the HL mirror refreshes at ~18:00 ET). HIGH findings
// reach #ops-alerts through the 08:00 digest (ops-morning-digest.js reads this
// job's job_runs row), each one only the first time it appears. A mirror that
// cannot be read, or is older than 26h, is "could not run" (job status
// unknown) and writes nothing: a check that could not look must never report
// zero findings.
//
// Read-only on both databases except its own results table. The MCP tool
// check_rule_targets runs the same check with write:false.

import { runJob } from '../job-runner.js';
import { hourET, todayET } from './lp-report-common.js';
import { buildRegistry, checkRules, findingLine, registryFresh, HIGH, LOW } from '../rule-target-resolve.js';

export const JOB_ID = 'rule-target-check';
export const RUN_HOUR_ET = 2;
export const RUN_MINUTE_ET = 10;
const WRITE_CHUNK = 200;

export function ruleTargetCheckEnabled(env = process.env) {
  return String(env.RULE_TARGET_CHECK_ENABLED ?? 'true').toLowerCase().trim() !== 'false';
}

// One HL round trip. Triggers come from workflow_triggers.raw_json (id,
// active, deleted): a workflow's trigger list is not in workflows.raw_json.
export const REGISTRY_SQL = `SELECT
  (SELECT max(synced_at) FROM workflows WHERE deleted_at IS NULL) AS synced_at,
  (SELECT json_agg(json_build_object('id', ghl_workflow_id, 'name', name, 'status', status,
          'deleted', deleted_at IS NOT NULL)) FROM workflows) AS workflows,
  (SELECT json_agg(json_build_object('trigger_id', raw_json->>'id', 'workflow_id', workflow_id,
          'active', raw_json->>'active', 'deleted', raw_json->>'deleted'))
     FROM workflow_triggers WHERE trigger_event = 'inbound_webhook') AS triggers`;

const asArray = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
};

async function defaultDeps() {
  const [{ default: supabase }, { hlRunSQL }] = await Promise.all([
    import('../supabase.js'),
    import('../admin/hl-client.js'),
  ]);
  return { supabase, hlRunSQL };
}

/** Read the HL mirror into a registry. Throws on a failed read. */
export async function loadRegistry(deps) {
  const rows = await deps.hlRunSQL(REGISTRY_SQL);
  const r = Array.isArray(rows) ? rows[0] : null;
  if (!r) throw new Error('HL registry query returned no row');
  return buildRegistry({ workflows: asArray(r.workflows), triggers: asArray(r.triggers), syncedAt: r.synced_at || null });
}

async function loadRules(deps) {
  const { data, error } = await deps.supabase.from('agent_rules')
    .select('id, rule_key, enabled, event_pattern, action_template')
    .eq('enabled', true);
  if (error) throw new Error(`agent_rules read failed: ${error.message}`);
  return data || [];
}

async function writeFindings(deps, runAt, findings) {
  const rows = findings.map((f) => ({
    run_at: runAt,
    rule_id: f.rule_id,
    rule_key: f.rule_key,
    action_index: f.action_index,
    target_kind: f.target_kind,
    target_id: f.target_id,
    resolved_workflow_id: f.resolved_workflow_id,
    status: f.status,
    severity: f.severity,
    detail: f.detail || {},
  }));
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const { error } = await deps.supabase.from('rule_target_checks').insert(rows.slice(i, i + WRITE_CHUNK));
    if (error) throw new Error(`rule_target_checks insert failed: ${error.message}`);
  }
  return rows.length;
}

/**
 * Run the check. → { ok, checked, summary, high, low, findings, high_findings, ... }
 * `checked: false` (job status unknown) when the mirror is unreadable or stale.
 */
export async function runRuleTargetCheck({ write = true, includeOk = false, deps: depsArg } = {}) {
  const deps = { ...(depsArg?.__noDefaults ? {} : await defaultDeps()), ...(depsArg || {}) };
  const nowMs = deps.nowMs ?? Date.now();

  let registry;
  try {
    registry = await loadRegistry(deps);
  } catch (err) {
    return { checked: false, reason: `HL workflow mirror unreadable: ${err.message}`, summary: 'check could not run: HL workflow mirror unreadable' };
  }
  const fresh = registryFresh(registry, nowMs);
  if (!fresh.fresh) return { checked: false, reason: fresh.reason, summary: `check could not run: ${fresh.reason}` };

  const rules = await loadRules(deps);
  const findings = checkRules(rules, registry);
  const high = findings.filter((f) => f.severity === HIGH);
  const low = findings.filter((f) => f.severity === LOW);
  const runAt = new Date(nowMs).toISOString();

  let written = 0;
  const errors = [];
  if (write) {
    try { written = await writeFindings(deps, runAt, findings); } catch (err) { errors.push(err.message); }
  }

  const slim = (f) => ({
    rule_id: f.rule_id, rule_key: f.rule_key, action_index: f.action_index, action_type: f.action_type,
    status: f.status, severity: f.severity, target_kind: f.target_kind, target_id: f.target_id,
    resolved_workflow_id: f.resolved_workflow_id, workflow_name: f.detail?.workflow_name ?? null,
  });
  const listed = findings.filter((f) => includeOk || f.severity === HIGH || f.severity === LOW);
  const out = {
    ok: errors.length === 0,
    checked: true,
    run_at: runAt,
    rules_checked: rules.length,
    targets_checked: findings.length,
    high: high.length,
    low: low.length,
    written,
    registry_synced_at: registry.syncedAt,
    // The digest reads these from job_runs.detail; one line per HIGH finding.
    high_findings: high.map((f) => ({ rule_id: f.rule_id, reason: `${f.status}:${f.action_index ?? 'trigger'}:${f.target_id || 'none'}`, line: findingLine(f) })),
    findings: listed.map(slim),
    summary: `${findings.length} target(s) on ${rules.length} rule(s): ${high.length} high, ${low.length} low`,
    ...(errors.length ? { errors } : {}),
  };
  console.log(`[RuleTargetCheck] ${out.summary}${write ? `, ${written} row(s) written` : ''}`);
  return out;
}

// ── Scheduler — daily at 02:10 ET ───────────────────────────────────────────
// The 5-minute tick convention; the WORK is wrapped in runJob, not the tick.
let timer = null;
let lastRunSlot = null;

function minuteET(d = new Date()) {
  const m = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', minute: '2-digit' }).format(d);
  return Number(m);
}

export function startRuleTargetCheckScheduler() {
  if (timer) return;
  if (!ruleTargetCheckEnabled()) {
    console.log('[RuleTargetCheck] disabled (RULE_TARGET_CHECK_ENABLED=false)');
    return;
  }
  console.log('[RuleTargetCheck] Scheduler started — daily run at 02:10 ET');
  const checkAndRun = async () => {
    const now = new Date();
    const today = todayET(now);
    if (hourET(now) === RUN_HOUR_ET && minuteET(now) >= RUN_MINUTE_ET && lastRunSlot !== today) {
      lastRunSlot = today;
      try {
        await runJob(JOB_ID, () => runRuleTargetCheck(), { occurrence: today });
      } catch (err) {
        console.error('[RuleTargetCheck] run failed:', err.message);
      }
    }
  };
  timer = setInterval(checkAndRun, 5 * 60 * 1000);
  timer.unref?.();
}

export function stopRuleTargetCheckScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
