/**
 * Tests for src/rule-target-resolve.js and src/jobs/rule-target-check.js
 * (F-L, 2026-10-12). Run: node --test scripts/test-rule-target-resolve.js
 *
 * The F-L fixture is copied from the live rows and the HL mirror as read on
 * 2026-10-12: rule 164 posted to S3.1 v1's webhook (draft workflow, trigger
 * switched off) and rule 165 listened for S3.1 v1 completing (a draft, so it
 * never fires). Rule 165's own target e5af8aab IS owned by S4.1 MV Booking.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRegistry, checkRules, classifyTarget, extractTriggerId, findingLine, registryFresh, ruleTargets,
  HIGH, LOW, INFO, MIN_REGISTRY_WORKFLOWS,
} from '../src/rule-target-resolve.js';
import { runRuleTargetCheck, REGISTRY_SQL } from '../src/jobs/rule-target-check.js';
import { makeCheckRuleTargets } from '../src/tools/maintenance-tools.js';

const HOOK = (id) => `https://services.leadconnectorhq.com/hooks/SsBG7j5KQAIP1SFP2Sca/webhook-trigger/${id}`;
const W21 = '69fdc012-cefc-4917-b156-d6dbc8d13b7c';
const S31_V1 = '142611f6-52e2-4081-ac5a-2a3269b8807b';
const S31_V3 = '27407026-3896-464c-b6b9-a3b7f9021dbf';
const S41 = 'dc355550-8dfc-42bc-a4de-923233a96727';
const S45_LEGACY = '40d77229-555d-49da-9987-9c57db191c0c';
const T_V1 = 'b637c9fd-412d-4e78-9ec1-eec282c0e459';
const T_V3 = '4465fb56-2487-443b-bf6d-1f04925d8c3a';
const T_S41 = 'e5af8aab-bdb3-4a3c-9e65-b594f68eace8';
const NOW = Date.parse('2026-10-13T06:10:00Z');

// Filler so the registry passes the size floor.
const filler = Array.from({ length: MIN_REGISTRY_WORKFLOWS }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `Filler ${i}`, status: 'published', deleted: false,
}));

function liveRows() {
  return {
    syncedAt: '2026-10-12T22:01:20Z',
    workflows: [
      ...filler,
      { id: W21, name: 'S2.5 Pricing Accuracy Education', status: 'published', deleted: false },
      { id: S31_V1, name: 'S3.1 Calculator Solution Pitch', status: 'draft', deleted: false },
      { id: S31_V3, name: 'S3.1 Calculator Positioning Burst v3', status: 'published', deleted: false },
      { id: S41, name: 'S4.1 MV Booking', status: 'published', deleted: false },
      { id: S45_LEGACY, name: 'S4.5 Post-Engagement Seinfeld Nurture', status: 'draft', deleted: false },
    ],
    triggers: [
      { trigger_id: T_V1, workflow_id: S31_V1, active: 'false', deleted: 'false' },
      { trigger_id: T_V3, workflow_id: S31_V3, active: 'true', deleted: 'false' },
      { trigger_id: T_S41, workflow_id: S41, active: 'true', deleted: 'false' },
    ],
  };
}
const registry = () => buildRegistry(liveRows());

const addTmpl = (params) => [{ action_type: 'add_to_workflow', target_system: 'ghl', target_entity: 'contact', params }];

// The rows as they were before the fix (trimmed to the fields the check reads).
const RULE_164_BEFORE = {
  id: 164, rule_key: 'STAGE_4_ROUTE_W2_1_TO_W3_1_V2', enabled: true,
  event_pattern: { payload: { workflow_id: W21 }, event_type: 'ghl.workflow_completed' },
  action_template: addTmpl({ format: 'form', webhook_url: HOOK(T_V1), workflow_name: 'S3.1 Calculator Solution Pitch', canonical_code: 'S3.1' }),
};
const RULE_165_BEFORE = {
  id: 165, rule_key: 'STAGE_5_ROUTE_W3_1_V2_TO_W4_1', enabled: true,
  event_pattern: { payload: { workflow_id: S31_V1 }, event_type: 'ghl.workflow_completed' },
  action_template: addTmpl({ format: 'form', webhook_url: HOOK(T_S41), workflow_name: 'S4.1 MV Booking', canonical_code: 'S4.1' }),
};
const RULE_164_AFTER = {
  ...RULE_164_BEFORE,
  action_template: addTmpl({ format: 'form', webhook_url: HOOK(T_V3), workflow_id: S31_V3, workflow_name: 'S3.1 Calculator Positioning Burst v3', canonical_code: 'S3.1' }),
};
const RULE_165_AFTER = { ...RULE_165_BEFORE, enabled: false };

// ── extractTriggerId ─────────────────────────────────────────────────────

test('extractTriggerId: reads the id after /webhook-trigger/, null when malformed', () => {
  assert.equal(extractTriggerId(HOOK(T_V3)), T_V3);
  assert.equal(extractTriggerId(`${HOOK(T_V3)}?x=1`), T_V3);
  // GHL's other id shape: a 20-character case-sensitive code (the cooling rules).
  assert.equal(extractTriggerId(HOOK('6MzFTv8eV6ZDghK7iXSv')), '6MzFTv8eV6ZDghK7iXSv');
  assert.equal(extractTriggerId('https://services.leadconnectorhq.com/hooks/abc/webhook-trigger/'), null);
  assert.equal(extractTriggerId('https://example.com/webhook/ghl/workflow'), null);
  assert.equal(extractTriggerId(HOOK('x!')), null);
  assert.equal(extractTriggerId(null), null);
});

// ── classifyTarget: each path and outcome ───────────────────────────────

const act = (over) => ({ kind: 'action', action_index: 0, action_type: 'add_to_workflow', workflow_id: null, webhook_url: null, remove_all: false, ...over });

test('workflow_id path: published → ok, draft → draft_target, unknown → missing_target', () => {
  const r = registry();
  assert.equal(classifyTarget(act({ workflow_id: S31_V3 }), r).status, 'ok');
  const draft = classifyTarget(act({ workflow_id: S31_V1 }), r);
  assert.equal(draft.status, 'draft_target');
  assert.equal(draft.severity, HIGH);
  assert.equal(draft.target_kind, 'workflow_id');
  const missing = classifyTarget(act({ workflow_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }), r);
  assert.equal(missing.status, 'missing_target');
  assert.equal(missing.severity, HIGH);
});

test('workflow_id path: a deleted workflow is missing, ids compare case-insensitively', () => {
  const rows = liveRows();
  rows.workflows.push({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Gone', status: 'published', deleted: true });
  const r = buildRegistry(rows);
  assert.equal(classifyTarget(act({ workflow_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }), r).status, 'missing_target');
  assert.equal(classifyTarget(act({ workflow_id: S31_V3.toUpperCase() }), r).status, 'ok');
});

test('webhook_url path: resolved through workflow_triggers to its owner', () => {
  const r = registry();
  const ok = classifyTarget(act({ webhook_url: HOOK(T_V3) }), r);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.target_kind, 'webhook_url');
  assert.equal(ok.target_id, T_V3);
  assert.equal(ok.resolved_workflow_id, S31_V3);
  // e5af8aab belongs to S4.1 MV Booking (the handoff thought nothing owned it).
  assert.equal(classifyTarget(act({ webhook_url: HOOK(T_S41) }), r).resolved_workflow_id, S41);
});

test('webhook_url path: draft owner → draft_target; published owner with a switched-off trigger → inactive_trigger', () => {
  const rows = liveRows();
  const pub = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const off = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  rows.workflows.push({ id: pub, name: 'Published, trigger off', status: 'published', deleted: false });
  rows.triggers.push({ trigger_id: off, workflow_id: pub, active: 'false' });
  const r = buildRegistry(rows);
  const draft = classifyTarget(act({ webhook_url: HOOK(T_V1) }), r);
  assert.equal(draft.status, 'draft_target');
  assert.equal(draft.resolved_workflow_id, S31_V1);
  assert.equal(draft.detail.trigger_active, false);
  const inactive = classifyTarget(act({ webhook_url: HOOK(off) }), r);
  assert.equal(inactive.status, 'inactive_trigger');
  assert.equal(inactive.severity, HIGH);
});

test('webhook_url path: a 20-character trigger code resolves too (case kept, matched case-insensitively)', () => {
  const rows = liveRows();
  rows.workflows.push({ id: 'dc850226-d693-4911-b255-ade8280a0815', name: 'S1.1 v3', status: 'published', deleted: false });
  rows.triggers.push({ trigger_id: '6MzFTv8eV6ZDghK7iXSv', workflow_id: 'dc850226-d693-4911-b255-ade8280a0815', active: 'true' });
  const r = classifyTarget(act({ webhook_url: HOOK('6MzFTv8eV6ZDghK7iXSv') }), buildRegistry(rows));
  assert.equal(r.status, 'ok');
  assert.equal(r.target_id, '6MzFTv8eV6ZDghK7iXSv');
  assert.equal(r.resolved_workflow_id, 'dc850226-d693-4911-b255-ade8280a0815');
});

test('webhook_url path: a trigger nobody owns → missing_target; a malformed URL → unresolvable', () => {
  const r = registry();
  const missing = classifyTarget(act({ webhook_url: HOOK('dddddddd-dddd-4ddd-8ddd-dddddddddddd') }), r);
  assert.equal(missing.status, 'missing_target');
  assert.equal(missing.severity, HIGH);
  const bad = classifyTarget(act({ webhook_url: 'https://services.leadconnectorhq.com/hooks/x/webhook-trigger/' }), r);
  assert.equal(bad.status, 'unresolvable');
  assert.equal(bad.severity, HIGH);
});

test('both present: they must agree; the webhook decides (Route B wins in the executor)', () => {
  const r = registry();
  assert.equal(classifyTarget(act({ webhook_url: HOOK(T_V3), workflow_id: S31_V3 }), r).status, 'ok');
  const mm = classifyTarget(act({ webhook_url: HOOK(T_V3), workflow_id: S41 }), r);
  assert.equal(mm.status, 'mismatch');
  assert.equal(mm.severity, HIGH);
  // A published workflow_id does not rescue a dead webhook.
  assert.equal(classifyTarget(act({ webhook_url: HOOK(T_V1), workflow_id: S31_V3 }), r).status, 'draft_target');
});

test('no id and no URL → unresolvable (HIGH on an add, LOW on a remove)', () => {
  const r = registry();
  assert.deepEqual(
    [classifyTarget(act({}), r).status, classifyTarget(act({}), r).severity],
    ['unresolvable', HIGH],
  );
  assert.equal(classifyTarget(act({ action_type: 'remove_from_workflow' }), r).severity, LOW);
});

test('remove_from_workflow: a draft target is LOW, remove_all is ok, the URL is ignored', () => {
  const r = registry();
  const legacy = classifyTarget(act({ action_type: 'remove_from_workflow', workflow_id: S45_LEGACY }), r);
  assert.equal(legacy.status, 'draft_target');
  assert.equal(legacy.severity, LOW);
  const all = classifyTarget(act({ action_type: 'remove_from_workflow', remove_all: true }), r);
  assert.equal(all.status, 'ok');
  assert.equal(all.target_kind, 'remove_all');
  // A remove only ever uses workflow_id.
  assert.equal(classifyTarget(act({ action_type: 'remove_from_workflow', workflow_id: S31_V3, webhook_url: HOOK(T_V1) }), r).status, 'ok');
});

test('a templated id is dynamic (INFO), never judged', () => {
  const r = registry();
  const d = classifyTarget(act({ workflow_id: '{{payload.workflow_id}}' }), r);
  assert.equal(d.status, 'dynamic');
  assert.equal(d.severity, INFO);
});

// ── ruleTargets ─────────────────────────────────────────────────────────

test('ruleTargets: array or object action_template, params or payload, only workflow actions, plus the completion trigger', () => {
  const rule = {
    id: 1, rule_key: 'X',
    event_pattern: { event_type: 'ghl.workflow_completed', payload: { workflow_id: W21 } },
    action_template: [
      { action_type: 'add_tag', params: { tags: ['x'] } },
      { action_type: 'add_to_workflow', payload: { workflow_id: S41 } },
    ],
  };
  const t = ruleTargets(rule);
  assert.equal(t.length, 2);
  assert.deepEqual([t[0].action_index, t[0].workflow_id], [1, S41]);
  assert.equal(t[1].kind, 'event_trigger');
  const single = ruleTargets({ id: 2, action_template: { action_type: 'remove_from_workflow', params: { remove_all: true } } });
  assert.equal(single.length, 1);
  assert.equal(single[0].remove_all, true);
  // A completion rule with no workflow_id listens to every workflow: nothing to check.
  assert.equal(ruleTargets({ id: 3, event_pattern: { event_type: 'ghl.workflow_completed' }, action_template: [] }).length, 0);
});

test('a completion trigger on a draft or unknown workflow is dead_trigger (HIGH)', () => {
  const r = registry();
  const t = (id) => classifyTarget({ kind: 'event_trigger', action_index: null, workflow_id: id }, r);
  assert.equal(t(W21).status, 'ok');
  assert.equal(t(S31_V1).status, 'dead_trigger');
  assert.equal(t(S31_V1).severity, HIGH);
  assert.equal(t('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee').status, 'dead_trigger');
});

// ── The F-L fixture ─────────────────────────────────────────────────────

test('F-L: the "before" rows give two HIGH findings, the "after" rows none', () => {
  const r = registry();
  const before = checkRules([RULE_164_BEFORE, RULE_165_BEFORE], r);
  const high = before.filter((f) => f.severity === HIGH);
  assert.equal(high.length, 2);
  const by = Object.fromEntries(high.map((f) => [f.rule_id, f]));
  assert.equal(by[164].status, 'draft_target');
  assert.equal(by[164].target_id, T_V1);
  assert.equal(by[165].status, 'dead_trigger');
  assert.equal(by[165].target_id, S31_V1);
  // Rule 165's action itself was fine: S4.1 owns e5af8aab.
  assert.equal(before.find((f) => f.rule_id === 165 && f.target_kind === 'webhook_url').status, 'ok');
  assert.match(findingLine(by[164]), /^Rule #164 STAGE_4_ROUTE_W2_1_TO_W3_1_V2 · add_to_workflow → "S3.1 Calculator Solution Pitch": its workflow is a draft/);

  const after = checkRules([RULE_164_AFTER, RULE_165_AFTER], r);
  assert.equal(after.filter((f) => f.severity === HIGH).length, 0);
  assert.ok(after.every((f) => f.rule_id === 164), 'a disabled rule is not checked');
  assert.ok(after.every((f) => f.status === 'ok'));
});

// ── registryFresh ───────────────────────────────────────────────────────

test('registryFresh: stale, tiny or undated mirrors cannot be judged from', () => {
  assert.equal(registryFresh(registry(), NOW).fresh, true);
  const stale = buildRegistry({ ...liveRows(), syncedAt: '2026-10-11T22:00:00Z' });
  assert.match(registryFresh(stale, NOW).reason, /32h old/);
  assert.equal(registryFresh(buildRegistry({ ...liveRows(), syncedAt: null }), NOW).fresh, false);
  assert.equal(registryFresh(buildRegistry({ workflows: liveRows().workflows.slice(0, 3), syncedAt: '2026-10-12T22:00:00Z' }), NOW).fresh, false);
});

// ── The job ─────────────────────────────────────────────────────────────

function fakeLp({ rules, insertError = null }) {
  const inserted = [];
  return {
    inserted,
    from(table) {
      if (table === 'agent_rules') {
        return { select: () => ({ eq: async (_c, v) => ({ data: rules.filter((r) => r.enabled === v), error: null }) }) };
      }
      if (table === 'rule_target_checks') {
        return { insert: async (rows) => { if (insertError) return { error: { message: insertError } }; inserted.push(...rows); return { error: null }; } };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

const hlRows = (over = {}) => {
  const rows = liveRows();
  return async (sql) => {
    assert.equal(sql, REGISTRY_SQL);
    return [{ synced_at: over.syncedAt ?? rows.syncedAt, workflows: JSON.stringify(rows.workflows), triggers: rows.triggers }];
  };
};

const LEGACY_REMOVES = [148, 150, 151].map((id) => ({
  id, rule_key: `LEGACY_${id}`, enabled: true, event_pattern: { event_type: 'lp.disposition_changed' },
  action_template: [{ action_type: 'remove_from_workflow', params: { workflow_id: S45_LEGACY, canonical_code: 'S4.5' } }],
}));

test('job: an unreadable HL mirror is "could not run" and writes nothing', async () => {
  const lp = fakeLp({ rules: [RULE_164_BEFORE] });
  const out = await runRuleTargetCheck({ deps: { __noDefaults: true, supabase: lp, nowMs: NOW, hlRunSQL: async () => { throw new Error('HL down'); } } });
  assert.equal(out.checked, false);
  assert.match(out.reason, /HL down/);
  assert.equal(lp.inserted.length, 0);
  assert.equal(out.high, undefined, 'never reports a count when it could not look');
});

test('job: a stale mirror is "could not run" too', async () => {
  const lp = fakeLp({ rules: [RULE_164_BEFORE] });
  const out = await runRuleTargetCheck({ deps: { __noDefaults: true, supabase: lp, nowMs: NOW, hlRunSQL: hlRows({ syncedAt: '2026-10-10T00:00:00Z' }) } });
  assert.equal(out.checked, false);
  assert.equal(lp.inserted.length, 0);
});

test('job: writes one row per target, all with one run_at; HIGH lines for the digest; LOW for the legacy removes', async () => {
  const lp = fakeLp({ rules: [RULE_164_BEFORE, RULE_165_BEFORE, RULE_165_AFTER, ...LEGACY_REMOVES] });
  const out = await runRuleTargetCheck({ deps: { __noDefaults: true, supabase: lp, nowMs: NOW, hlRunSQL: hlRows() } });
  assert.equal(out.ok, true);
  assert.equal(out.checked, true);
  assert.equal(out.high, 2);
  assert.equal(out.low, 3);
  assert.equal(lp.inserted.length, out.targets_checked);
  assert.equal(new Set(lp.inserted.map((r) => r.run_at)).size, 1);
  assert.deepEqual(out.high_findings.map((f) => f.rule_id).sort(), [164, 165]);
  assert.ok(out.high_findings.every((f) => f.line && f.reason));
  assert.deepEqual(out.findings.filter((f) => f.severity === LOW).map((f) => f.rule_id).sort(), [148, 150, 151]);
});

test('job: write:false writes nothing; a failed insert keeps the findings but is not ok', async () => {
  const lp = fakeLp({ rules: [RULE_164_BEFORE] });
  const dry = await runRuleTargetCheck({ write: false, deps: { __noDefaults: true, supabase: lp, nowMs: NOW, hlRunSQL: hlRows() } });
  assert.equal(dry.high, 1);
  assert.equal(lp.inserted.length, 0);
  const broken = fakeLp({ rules: [RULE_164_BEFORE], insertError: 'relation does not exist' });
  const out = await runRuleTargetCheck({ deps: { __noDefaults: true, supabase: broken, nowMs: NOW, hlRunSQL: hlRows() } });
  assert.equal(out.ok, false);
  assert.equal(out.high, 1);
  assert.match(out.errors[0], /relation does not exist/);
});

test('check_rule_targets tool: read-only, says plainly when it could not run', async () => {
  const lp = fakeLp({ rules: [RULE_164_BEFORE] });
  const tool = makeCheckRuleTargets({ jobDeps: { __noDefaults: true, supabase: lp, nowMs: NOW, hlRunSQL: hlRows() } });
  const res = await tool({});
  assert.equal(res.ok, true);
  assert.equal(res.high, 1);
  assert.equal(lp.inserted.length, 0);
  const down = makeCheckRuleTargets({ jobDeps: { __noDefaults: true, supabase: lp, nowMs: NOW, hlRunSQL: async () => { throw new Error('x'); } } });
  const r2 = await down({});
  assert.equal(r2.checked, false);
  assert.match(r2.next_step, /NOT a clean result/);
});
