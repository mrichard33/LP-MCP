/**
 * Tests for src/mode-registry.js and src/mode-registry-sync.js (Fix 2, 2026-10-12).
 *
 * The registry is only worth having if it cannot fall behind the code. So the
 * first test scans src/ for every `*_MODE` flag the code reads and fails both
 * ways: a flag with no entry, and an entry whose flag is gone. 40 of the 91
 * flags were read as `process.env.X_MODE` and 51 through an injected
 * `env.X_MODE` / `env?.X_MODE`; a `process.env`-only scan would miss most.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODES, MODE_NAMES, NEEDS_RULING, resolveMode, stateOf } from '../src/mode-registry.js';
import { modeRows, registerModes } from '../src/mode-registry-sync.js';
import { JOBS } from '../src/job-registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const READ_RX = /\benv\??\.([A-Z][A-Z0-9_]*_MODE)\b/g;
const JOB_RX = /enabledEnv:\s*'([A-Z][A-Z0-9_]*_MODE)'/g;

export function scanModeFlags(dir) {
  const found = new Set();
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      for (const m of src.matchAll(READ_RX)) found.add(m[1]);
      for (const m of src.matchAll(JOB_RX)) found.add(m[1]);
    }
  };
  walk(dir);
  return found;
}

test('every *_MODE flag the code reads has a registry entry, and no entry is stale', () => {
  const inCode = scanModeFlags(path.join(ROOT, 'src'));
  const inRegistry = new Set(MODE_NAMES);
  const missing = [...inCode].filter((n) => !inRegistry.has(n)).sort();
  const stale = [...inRegistry].filter((n) => !inCode.has(n)).sort();
  assert.deepEqual(missing, [],
    `Flags read in src/ with no entry in src/mode-registry.js: ${missing.join(', ')}. ` +
    'Add one (default, values, since, decider, evidence, goLive) so the /modes page shows it.');
  assert.deepEqual(stale, [],
    `Entries in src/mode-registry.js whose flag no code reads any more: ${stale.join(', ')}. Remove them.`);
});

test('the scanner sees both spellings of a flag read', () => {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'mode-guard-'));
  fs.writeFileSync(path.join(tmp, 'a.js'), "const a = process.env.ALPHA_MODE || 'off';\n");
  fs.writeFileSync(path.join(tmp, 'b.js'), "export const b = (env = process.env) => env?.BETA_MODE;\n");
  fs.writeFileSync(path.join(tmp, 'c.js'), "{ enabledEnv: 'GAMMA_MODE' }\nconst PAGING_MODE = 'x';\n");
  assert.deepEqual([...scanModeFlags(tmp)].sort(), ['ALPHA_MODE', 'BETA_MODE', 'GAMMA_MODE']);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the roster is pinned (bump on purpose when a flag is added or removed)', () => {
  assert.equal(MODES.length, 119); // +CHAT_RETURN_LP_MODE (2026-10-19); +EMAIL_POST_DEMO_MODE (2026-10-19); +DNC_LIFT_APPROVAL_MODE (2026-10-18); +TURN_LOCK_MODE (2026-10-18, Phase 1); +POST_APPT_CLOSE_MODE (2026-10-16); +SIRO_WEBHOOK/SYNC/CONTEXT/ENSURE/DEMO_NOTE/SCORECARD_SYNC_MODE, +F0_V2_MODE (2026-10-16); +HOLD_RETURN_RECOVERY_MODE (2026-10-16); +ESTIMATE_DRIFT_FIX_MODE (2026-10-16); +LIVE_CHAT_LARGE_JOB_ALERT_MODE, +LIVE_CHAT_SUMMARY_MODE (2026-10-15); +FIVE9_JOURNEY_SYNC_MODE (2026-10-15); +CANCEL_RESET_ROUTING_MODE (2026-10-15); +MISSED_INBOUND_SWEEP_MODE (2026-10-15); +HEALTH_CHECKS_MODE, +DIALER_SLA_MODE, +APPT_PIPELINE_MODE, +INCIDENT_NOTIFIER_MODE, +HEALTH_RETENTION_MODE (2026-10-15); +SCOPE_DQ_MODE (2026-10-13); +AFTER_ASAP_RETRY_MODE, +AFTER_ASAP_RETRY_CALL_NOW_MODE (2026-10-14)
  assert.equal(new Set(MODE_NAMES).size, MODES.length, 'duplicate names');
});

test('every entry is complete and consistent', () => {
  const groups = new Set(['bot', 'knowledge', 'intake', 'lp', 'sales', 'dialer', 'alerts', 'security', 'memory']);
  for (const e of MODES) {
    const where = e.name;
    assert.ok(groups.has(e.group), `${where}: unknown group ${e.group}`);
    assert.ok(['enum', 'boolean', 'choice'].includes(e.kind), `${where}: kind`);
    assert.ok(e.values.length >= 2, `${where}: values`);
    assert.ok(e.values.includes(e.default), `${where}: default ${e.default} not in values`);
    for (const v of [...e.live, ...e.shadow, ...e.off]) assert.ok(e.values.includes(v), `${where}: ${v} not in values`);
    assert.match(e.since, /^2026-\d{2}-\d{2}$/, `${where}: since`);
    assert.ok(['Mark', 'the user'].includes(e.decider), `${where}: decider`);
    assert.ok(e.goLive && e.goLive.length > 5, `${where}: goLive (use NEEDS_RULING when no ruling says)`);
    assert.ok(e.note && e.note.length > 10, `${where}: note`);
    if (e.kind === 'choice') {
      assert.equal(e.live.length + e.shadow.length + e.off.length, 0, `${where}: a choice has no states`);
    } else {
      assert.notEqual(stateOf(e, e.default), 'other', `${where}: the default must map to a state`);
    }
    if (e.evidence.job) assert.ok(JOBS.some((j) => j.id === e.evidence.job), `${where}: evidence job ${e.evidence.job} is not in job-registry.js`);
  }
});

test('a job gated by a mode flag runs exactly when the registry says the flag is not off', () => {
  // post-issue-rebook-retry only retries live sends, so its job runs on
  // `live` alone (src/job-registry.js); every other gate is "anything but off".
  const LIVE_ONLY = new Set(['post-issue-rebook-retry']);
  for (const j of JOBS) {
    const e = MODES.find((x) => x.name === j.enabledEnv);
    if (!e) continue;
    for (const v of [...e.values, undefined]) {
      const env = v === undefined ? {} : { [e.name]: v };
      const st = stateOf(e, resolveMode(e, env));
      const expected = LIVE_ONLY.has(j.id) ? st === 'live' : st !== 'off';
      assert.equal(Boolean(j.isEnabled(env)), expected, `${j.id} with ${e.name}=${v ?? '(unset)'}`);
    }
  }
});

test('resolveMode uses the variable, then the fallback flag, then the default', () => {
  const e = MODES.find((x) => x.name === 'NEW_LEAD_BACKSTOP_CALL_NOW_MODE');
  assert.equal(resolveMode(e, {}), 'ANY');
  assert.equal(resolveMode(e, { FIVE9_CALLBACK_CALL_NOW_MODE: 'NEW_LIST_ONLY' }), 'NEW_LIST_ONLY');
  assert.equal(resolveMode(e, { NEW_LEAD_BACKSTOP_CALL_NOW_MODE: ' NONE ', FIVE9_CALLBACK_CALL_NOW_MODE: 'ANY' }), 'NONE');
  assert.equal(resolveMode(MODES.find((x) => x.name === 'SEND_GATE_MODE'), { SEND_GATE_MODE: '' }), 'shadow');
});

test('stateOf: listed values, "otherwise" flags, choices, and an unknown value', () => {
  const by = (n) => MODES.find((x) => x.name === n);
  assert.equal(stateOf(by('SEND_GATE_MODE'), 'LIVE'), 'live');
  assert.equal(stateOf(by('SEND_GATE_MODE'), 'shaddow'), 'other');
  assert.equal(stateOf(by('NEPQ_LAYER_MODE'), 'off'), 'off');
  assert.equal(stateOf(by('NEPQ_LAYER_MODE'), 'anything'), 'live');
  assert.equal(stateOf(by('NURTURE_SHADOW_MODE'), 'true'), 'shadow');
  assert.equal(stateOf(by('NURTURE_SHADOW_MODE'), 'false'), 'live');
  assert.equal(stateOf(by('SQL_TOOL_MODE'), 'readwrite'), 'off');
  assert.equal(stateOf(by('LP_REQUEUE_MODE'), 'five9'), 'choice');
});

test('modeRows records the value, the state and whether the variable is set', () => {
  const rows = modeRows(MODES, { env: { SEND_GATE_MODE: 'live', KB_VECTOR_MODE: 'shadow' }, now: Date.parse('2026-10-12T00:00:00Z') });
  assert.equal(rows.length, 119);
  const send = rows.find((r) => r.name === 'SEND_GATE_MODE');
  assert.equal(send.current_value, 'live');
  assert.equal(send.current_state, 'live');
  assert.equal(send.is_set, true);
  const sql = rows.find((r) => r.name === 'SQL_TOOL_MODE');
  assert.equal(sql.current_state, 'off');
  assert.equal(sql.is_set, false);
  assert.equal(sql.registered_at, '2026-10-12T00:00:00.000Z');
  assert.ok(rows.every((r) => r.go_live && r.decider && r.since));
});

test('registerModes upserts on name and never throws', async () => {
  const calls = [];
  const fake = (error) => ({ from: (t) => ({ upsert: async (rows, opts) => { calls.push({ t, n: rows.length, opts }); return { error }; } }) });
  const ok = await registerModes(MODES, { supabase: fake(null), env: {} });
  assert.equal(ok.registered, 119);
  assert.deepEqual(calls[0], { t: 'feature_modes', n: 119, opts: { onConflict: 'name' } });
  const bad = await registerModes(MODES, { supabase: fake({ message: 'relation "feature_modes" does not exist' }), env: {} });
  assert.equal(bad.registered, 0);
  assert.match(bad.error, /does not exist/);
  assert.deepEqual(await registerModes(MODES, { supabase: null }), { registered: 0, skipped: 'no supabase' });
});

test('flags still waiting on a ruling say so, never an invented test', () => {
  const waiting = MODES.filter((e) => e.goLive === NEEDS_RULING);
  assert.ok(waiting.length > 0);
  for (const e of waiting) assert.notEqual(stateOf(e, e.default), 'choice', e.name);
});

test('Monday review line: counts shadow flags and names the ones waiting 14+ days', async () => {
  const { shadowReviewLines } = await import('../src/jobs/ops-morning-digest.js');
  const now = Date.parse('2026-10-19T12:00:00Z');
  const rows = [
    { name: 'A_MODE', current_state: 'shadow', since: '2026-09-01', go_live: 'a real test' },
    { name: 'B_MODE', current_state: 'shadow', since: '2026-10-15', go_live: NEEDS_RULING },
    { name: 'C_MODE', current_state: 'shadow', since: '2026-09-01', state_changed_at: '2026-10-10T00:00:00Z', go_live: NEEDS_RULING },
    { name: 'D_MODE', current_state: 'shadow', since: '2026-09-20', go_live: NEEDS_RULING },
    { name: 'E_MODE', current_state: 'live', since: '2026-01-01' },
  ];
  const lines = shadowReviewLines(rows, now);
  assert.match(lines[0], /^4 flags in shadow; 2 for 14\+ days/);
  assert.equal(lines[1], 'waiting longest: A_MODE (48d), D_MODE (29d, no go-live test yet)');
  assert.deepEqual(shadowReviewLines([{ name: 'E_MODE', current_state: 'live' }], now), []);
});
