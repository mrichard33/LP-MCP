// ─── Rule → workflow target resolver — src/rule-target-resolve.js ──────────
//
// Pure, no I/O. Given the enabled agent_rules and a snapshot of the HL workflow
// mirror (workflows + workflow_triggers), answer: does every workflow action and
// every "workflow completed" trigger point at a PUBLISHED workflow?
//
// WHY (F-L, 2026-10-12). Rule 164 STAGE_4_ROUTE_W2_1_TO_W3_1_V2 sent 64
// contacts to S3.1 v1 through its inbound webhook. S3.1 v1 is a DRAFT and that
// trigger is switched off, but GHL answers 200 to the POST anyway, so every add
// read "completed" and nobody moved. The old audit only checked
// params.workflow_id and never looked inside params.webhook_url (workflow_id
// NULL). This resolver reads both paths, and resolves a webhook through
// workflow_triggers (raw_json.id = the id after /webhook-trigger/), because a
// workflow's trigger list is NOT in workflows.raw_json. Searching raw_json is
// what made the handoff call S4.1's trigger e5af8aab "owned by nothing".
//
// Statuses (one per checked target):
//   ok               published workflow (and, for a webhook, an active trigger)
//   draft_target     the workflow exists but is not published
//   inactive_trigger published workflow, but the webhook trigger is switched off
//   missing_target   nothing owns the id, or the workflow is deleted
//   mismatch         workflow_id and webhook_url name two different workflows
//   unresolvable     no workflow_id and no usable webhook_url
//   dead_trigger     a ghl.workflow_completed rule listens to an unpublished
//                    (or unknown) workflow, so it can never fire
//   dynamic          a templated id ({{…}}), resolved at run time; not judged
//
// Severity: add_to_workflow and dead_trigger → HIGH (a contact silently goes
// nowhere); remove_from_workflow → LOW (removing from a draft does no harm;
// report only, e.g. rules 148/150/151 → S4.5-LEGACY-V1 40d77229).

export const HIGH = 'high';
export const LOW = 'low';
export const INFO = 'info';
export const REGISTRY_MAX_AGE_H = 26;
// The mirror holds ~hundreds of workflows. A read that returns almost none is
// a broken read, not an empty account: refuse it rather than call every rule
// "missing".
export const MIN_REGISTRY_WORKFLOWS = 20;

const WORKFLOW_ACTIONS = new Set(['add_to_workflow', 'remove_from_workflow']);
const COMPLETED_EVENT = 'ghl.workflow_completed';

/**
 * The trigger id after /webhook-trigger/ in a GHL inbound-webhook URL, or null.
 * GHL issues two shapes: a UUID (4465fb56-…) and a 20-character code
 * (6MzFTv8eV6ZDghK7iXSv, the cooling and S1.1 rules). The code is
 * case-sensitive, so it is returned as written; lookups compare lowercased.
 */
export function extractTriggerId(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/webhook-trigger\/([A-Za-z0-9][A-Za-z0-9_-]{7,63})(?:[/?#]|$)/);
  return m ? m[1] : null;
}

const isTemplated = (v) => typeof v === 'string' && v.includes('{{');
const norm = (v) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null);

function templateList(actionTemplate) {
  if (Array.isArray(actionTemplate)) return actionTemplate;
  if (actionTemplate && typeof actionTemplate === 'object') return [actionTemplate];
  return [];
}

/**
 * Everything one rule points at: its workflow actions (by index in
 * action_template) and, for a ghl.workflow_completed rule, the workflow it
 * listens to.
 */
export function ruleTargets(rule) {
  const out = [];
  templateList(rule?.action_template).forEach((tmpl, i) => {
    const type = tmpl?.action_type;
    if (!WORKFLOW_ACTIONS.has(type)) return;
    // Same lookup as the engine (decision-engine.js: tmpl.params || tmpl.payload).
    const p = tmpl.params || tmpl.payload || {};
    out.push({
      kind: 'action',
      action_index: i,
      action_type: type,
      workflow_id: p.workflow_id ?? null,
      webhook_url: p.webhook_url ?? null,
      remove_all: p.remove_all === true || p.remove_all === 'true',
      workflow_name: p.workflow_name || p.canonical_name || null,
    });
  });
  const eventType = rule?.event_type || rule?.event_pattern?.event_type || null;
  const listensTo = rule?.event_pattern?.payload?.workflow_id ?? null;
  if (eventType === COMPLETED_EVENT && listensTo) {
    out.push({ kind: 'event_trigger', action_index: null, action_type: null, workflow_id: listensTo });
  }
  return out;
}

/**
 * Build the lookup the classifier reads from the HL rows.
 * workflows: [{ id, name, status, deleted }], triggers: [{ trigger_id, workflow_id, active, deleted }]
 */
export function buildRegistry({ workflows = [], triggers = [], syncedAt = null } = {}) {
  const wf = new Map();
  for (const w of workflows) {
    const id = norm(w?.id);
    if (id) wf.set(id, { id, name: w.name || null, status: norm(w.status) || 'unknown', deleted: w.deleted === true });
  }
  const trig = new Map();
  for (const t of triggers) {
    const id = norm(t?.trigger_id);
    const owner = norm(t?.workflow_id);
    if (!id || !owner) continue;
    const list = trig.get(id) || [];
    list.push({ workflow_id: owner, active: !(t.active === false || t.active === 'false'), deleted: t.deleted === true || t.deleted === 'true' });
    trig.set(id, list);
  }
  return { workflows: wf, triggers: trig, syncedAt };
}

/** Is the mirror fresh and big enough to judge from? → { fresh, reason } */
export function registryFresh(registry, nowMs = Date.now(), maxH = REGISTRY_MAX_AGE_H) {
  const n = registry?.workflows?.size ?? 0;
  if (n < MIN_REGISTRY_WORKFLOWS) return { fresh: false, reason: `HL workflow mirror returned ${n} workflow(s) (expected ${MIN_REGISTRY_WORKFLOWS}+)` };
  const t = Date.parse(registry.syncedAt || '');
  if (!Number.isFinite(t)) return { fresh: false, reason: 'HL workflow mirror has no synced_at' };
  const ageH = (nowMs - t) / 3_600_000;
  if (ageH > maxH) return { fresh: false, reason: `HL workflow mirror is ${Math.round(ageH)}h old (max ${maxH}h)` };
  return { fresh: true, reason: null };
}

function judgeWorkflow(registry, id) {
  const w = registry.workflows.get(norm(id));
  if (!w || w.deleted) return { status: 'missing_target', workflow: w || null };
  if (w.status !== 'published') return { status: 'draft_target', workflow: w };
  return { status: 'ok', workflow: w };
}

function judgeWebhook(registry, url) {
  const triggerId = extractTriggerId(url);
  if (!triggerId) return { status: 'unresolvable', triggerId: null, workflow: null, note: 'webhook_url has no /webhook-trigger/<id>' };
  const owners = (registry.triggers.get(triggerId.toLowerCase()) || []).filter((o) => !o.deleted);
  if (!owners.length) return { status: 'missing_target', triggerId, workflow: null, note: 'no workflow owns this trigger' };
  // Prefer the owner that would actually run (published + active).
  const rank = (o) => {
    const w = registry.workflows.get(o.workflow_id);
    return (w && !w.deleted && w.status === 'published' ? 2 : 0) + (o.active ? 1 : 0);
  };
  const owner = [...owners].sort((a, b) => rank(b) - rank(a))[0];
  const wf = judgeWorkflow(registry, owner.workflow_id);
  if (wf.status !== 'ok') return { ...wf, triggerId, ownerId: owner.workflow_id, triggerActive: owner.active };
  if (!owner.active) return { status: 'inactive_trigger', workflow: wf.workflow, triggerId, ownerId: owner.workflow_id, triggerActive: false };
  return { status: 'ok', workflow: wf.workflow, triggerId, ownerId: owner.workflow_id, triggerActive: true };
}

function severityFor(target, status) {
  if (status === 'ok') return null;
  if (status === 'dynamic') return INFO;
  if (target.kind === 'event_trigger') return HIGH;
  return target.action_type === 'add_to_workflow' ? HIGH : LOW;
}

/** Classify one target. → { target_kind, target_id, resolved_workflow_id, status, severity, detail } */
export function classifyTarget(target, registry) {
  const finish = (status, f) => ({
    target_kind: f.target_kind,
    target_id: f.target_id ?? null,
    resolved_workflow_id: f.workflow?.id ?? f.ownerId ?? null,
    status,
    severity: severityFor(target, status),
    detail: {
      workflow_name: f.workflow?.name ?? null,
      workflow_status: f.workflow?.status ?? null,
      ...(f.triggerActive === undefined ? {} : { trigger_active: f.triggerActive }),
      ...(f.note ? { note: f.note } : {}),
      ...(f.other ? f.other : {}),
    },
  });

  if (target.kind === 'event_trigger') {
    if (isTemplated(target.workflow_id)) return finish('dynamic', { target_kind: 'event_trigger', target_id: target.workflow_id });
    const r = judgeWorkflow(registry, target.workflow_id);
    return finish(r.status === 'ok' ? 'ok' : 'dead_trigger', { target_kind: 'event_trigger', target_id: norm(target.workflow_id), workflow: r.workflow });
  }

  if (target.remove_all) return finish('ok', { target_kind: 'remove_all', target_id: null });

  const wfId = target.workflow_id;
  // Route B (webhook) is what the executor uses for an ADD when a URL is
  // present (executeAddToWorkflow); a REMOVE only ever uses workflow_id.
  const url = target.action_type === 'add_to_workflow' ? target.webhook_url : null;

  if (isTemplated(wfId) || isTemplated(url)) {
    return finish('dynamic', { target_kind: isTemplated(url) ? 'webhook_url' : 'workflow_id', target_id: url || wfId });
  }

  if (url) {
    const hook = judgeWebhook(registry, url);
    const base = { target_kind: 'webhook_url', target_id: hook.triggerId || String(url).slice(0, 200), workflow: hook.workflow, ownerId: hook.ownerId, triggerActive: hook.triggerActive, note: hook.note };
    if (hook.status !== 'ok') return finish(hook.status, base);
    if (wfId && norm(wfId) !== hook.workflow.id) {
      return finish('mismatch', { ...base, note: 'workflow_id names a different workflow than the webhook trigger', other: { workflow_id: norm(wfId) } });
    }
    return finish('ok', base);
  }

  if (wfId) {
    const r = judgeWorkflow(registry, wfId);
    return finish(r.status, { target_kind: 'workflow_id', target_id: norm(wfId), workflow: r.workflow });
  }

  return finish('unresolvable', { target_kind: 'none', target_id: null, note: 'no workflow_id and no webhook_url' });
}

/** Every finding for a list of rules. Disabled rules are skipped. */
export function checkRules(rules, registry) {
  const findings = [];
  for (const rule of rules || []) {
    if (rule?.enabled === false) continue;
    for (const t of ruleTargets(rule)) {
      findings.push({
        rule_id: rule.id ?? null,
        rule_key: rule.rule_key ?? null,
        action_index: t.action_index,
        action_type: t.action_type,
        ...classifyTarget(t, registry),
      });
    }
  }
  return findings;
}

const WHAT = {
  draft_target: 'its workflow is a draft',
  inactive_trigger: 'the webhook trigger is switched off',
  missing_target: 'no workflow owns that target',
  mismatch: 'workflow_id and webhook_url disagree',
  unresolvable: 'it names no workflow',
  dead_trigger: 'it listens for a workflow that is not published, so it never fires',
};

/** Pure. One plain line for the ops digest. */
export function findingLine(f) {
  const name = f.detail?.workflow_name ? `"${f.detail.workflow_name}"` : (f.resolved_workflow_id || f.target_id || 'unknown target');
  const what = f.action_type ? `${f.action_type} → ${name}` : `trigger ${name}`;
  return `Rule #${f.rule_id} ${f.rule_key} · ${what}: ${WHAT[f.status] || f.status} · point it at a published workflow or disable it`;
}
