/**
 * Pure tests for src/jobs/memory-autoclose.js and src/memory/with-retry.js.
 * No env needed — runSQL is mocked. Run: node --test scripts/test-memory-autoclose.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOCLOSE_RULES, PROTECTED_ITEM_TYPES, PROTECTED_LIST_SQL, runAutoclose,
  RULE_A_SELECT, RULE_B_SELECT, RULE_C_SELECT, RULE_D1_SELECT, RULE_D2_SELECT, RULE_STALE_SELECT,
  shadowSql, closeSql, supersedeSql, staleFlagSql, clearWouldCloseSql, logSql, prNumbersIn, prRefsIn, mergedPrRows, mergedAfterSession,
  prIntent, unresolvedReposIn,
} from '../src/jobs/memory-autoclose.js';
import { withRetry, isTransientError } from '../src/memory/with-retry.js';

const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const PROTECTED = PROTECTED_ITEM_TYPES;

/** Fixture rows and a tiny SQL simulator: SELECTs are answered from the rule tag, UPDATEs are recorded. */
function fixtures() {
  return [
    { id: 1, kind: 'next_step', item_type: 'next_step', origin: 'live', status: 'open', description: 'ship the thing', session_date: daysAgo(45) },
    { id: 2, kind: 'next_step', item_type: 'next_step', origin: 'live', status: 'open', description: 'fresh step', session_date: daysAgo(3) },
    { id: 3, kind: 'pending', item_type: 'decision_needed', origin: 'retro', status: 'open', description: 'Mark to decide X', session_date: daysAgo(400) },
    { id: 4, kind: 'pending', item_type: 'action_needed', origin: 'retro', status: 'open', description: 'Retro action', session_date: daysAgo(130) },
    { id: 5, kind: 'pending', item_type: 'action_needed', origin: 'live', status: 'open', description: 'Dedupe   me', session_date: daysAgo(10) },
    { id: 6, kind: 'pending', item_type: 'action_needed', origin: 'live', status: 'open', description: 'dedupe me', session_date: daysAgo(2) },
    { id: 7, kind: 'pending', item_type: 'verification_needed', origin: 'live', status: 'open', description: 'verify after PR #866 merges', ref: null, session_date: daysAgo(5) },
    { id: 8, kind: 'pending', item_type: 'open_question', origin: 'live', status: 'open', description: 'dedupe me', session_date: daysAgo(1) },
    { id: 9, kind: 'pending', item_type: 'action_needed', origin: 'live', status: 'open', description: 'old untouched', session_date: daysAgo(200), stale: false, verified_at: null },
  ];
}

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ');
const notProtected = (r) => !PROTECTED.includes(r.item_type || '');
const ageDays = (r) => Math.floor((Date.now() - new Date(r.session_date).getTime()) / DAY);

/** Evaluates each rule's WHERE clause in JS over the fixture (same semantics as the SQL). */
function simulateSelect(rows, sql) {
  const open = rows.filter((r) => r.status === 'open');
  if (sql === RULE_A_SELECT) return open.filter((r) => r.kind === 'next_step' && ageDays(r) > 30 && notProtected(r)).map(({ id }) => ({ id }));
  if (sql === RULE_B_SELECT) return open.filter((r) => r.origin === 'retro' && ageDays(r) > 90 && notProtected(r)).map(({ id }) => ({ id }));
  if (sql === RULE_C_SELECT) {
    const groups = new Map();
    for (const r of open) { const k = norm(r.description); (groups.get(k) || groups.set(k, []).get(k)).push(r); }
    const out = [];
    for (const g of groups.values()) {
      g.sort((a, b) => (b.session_date.localeCompare(a.session_date)) || b.id - a.id);
      const keep = g[0];
      for (const r of g.slice(1)) if (notProtected(r)) out.push({ id: r.id, keep_id: keep.id });
    }
    return out.sort((a, b) => a.id - b.id);
  }
  if (sql === RULE_D1_SELECT) return [];
  if (sql === RULE_D2_SELECT) return open.filter((r) => /PR\s*#?\d+/i.test(`${r.description} ${r.ref || ''}`) && notProtected(r)).map(({ id, description, ref }) => ({ id, description, ref }));
  if (sql === RULE_STALE_SELECT) return open.filter((r) => !r.stale && !r.verified_at && ageDays(r) > 120 && notProtected(r)).map(({ id }) => ({ id }));
  throw new Error(`unexpected SELECT: ${sql.slice(0, 60)}`);
}

function mockSql(rows) {
  const calls = [];
  const runSQL = async (sql) => {
    calls.push(sql);
    if (/^\s*SELECT/i.test(sql)) return simulateSelect(rows, sql);
    return { status: 'ok' };
  };
  return { runSQL, calls, updates: () => calls.filter((s) => /^\s*UPDATE/i.test(s)), logs: () => calls.filter((s) => /^\s*INSERT INTO claude_memory_autoclose_log/i.test(s)) };
}

// PR #866 in LP-MCP "merged today" — always on/after fixture #7's session date (5 days ago).
const fetchPRMerged = async (n, repo) => (n === 866 && repo === 'mrichard33/LP-MCP' ? { merged_at: new Date().toISOString() } : null);
const env = { GITHUB_PAT: 'x' };

// 1. off → zero SQL calls
test("mode='off' makes zero SQL calls and logs nothing", async () => {
  const m = mockSql(fixtures());
  const r = await runAutoclose({ mode: 'off', deps: { runSQL: m.runSQL, env } });
  assert.equal(r.mode, 'off'); assert.equal(m.calls.length, 0);
  const r2 = await runAutoclose({ mode: undefined, deps: { runSQL: m.runSQL, env } });
  assert.equal(r2.mode, 'off'); assert.equal(m.calls.length, 0);
  const r3 = await runAutoclose({ mode: 'bogus', deps: { runSQL: m.runSQL, env } });
  assert.equal(r3.mode, 'off'); assert.equal(m.calls.length, 0);
});

// 2. shadow → every UPDATE sets would_close, none sets status
test("mode='shadow': every statement sets would_close, none touches status / stale / closed_*", async () => {
  const m = mockSql(fixtures());
  const r = await runAutoclose({ mode: 'shadow', deps: { runSQL: m.runSQL, fetchPR: fetchPRMerged, env } });
  assert.deepEqual(r.errors, []);
  const updates = m.updates();
  assert.ok(updates.length >= 5, `expected shadow updates, got ${updates.length}`);
  for (const u of updates) {
    const setClause = u.split(/\bWHERE\b/)[0];
    assert.match(setClause, /would_close/);
    assert.doesNotMatch(setClause, /\bstatus\s*=/, `shadow must not set status: ${u}`);
    assert.doesNotMatch(setClause, /\bstale\s*=\s*true/, `shadow must not flag stale: ${u}`);
    assert.doesNotMatch(setClause, /closed_(by|reason|at)\s*=/, `shadow must not set closed_*: ${u}`);
  }
  assert.equal(r.rules['A:next_step_30d'].affected, 1); assert.deepEqual(r.rules['A:next_step_30d'].sample_ids, [1]);
  assert.equal(r.rules['B:retro_90d'].affected, 1); assert.deepEqual(r.rules['B:retro_90d'].sample_ids, [4]);
  assert.equal(r.rules['C:duplicate'].affected, 2); assert.deepEqual(r.rules['C:duplicate'].sample_ids, [5, 6]);
  // #7 "verify after PR #866 merges" is a passing mention: tagged D:pr_mentioned, never a close candidate.
  assert.equal(r.rules['D:pr_merged'].affected, 0);
  assert.equal(r.rules['D:pr_mentioned'].affected, 1); assert.deepEqual(r.rules['D:pr_mentioned'].sample_ids, [7]);
  assert.equal(r.rules['STALE:untouched_120d'].affected, 1); assert.deepEqual(r.rules['STALE:untouched_120d'].sample_ids, [9]);
  // one log row per rule (+ one for D:pr_mentioned), in shadow mode
  const logs = m.logs();
  assert.equal(logs.length, AUTOCLOSE_RULES.length + 1);
  for (const l of logs) assert.match(l, /VALUES \('shadow'/);
  // the cleanup keeps every id tagged this run
  const cleanup = updates.find((u) => /SET would_close=NULL WHERE would_close IS NOT NULL/.test(u));
  assert.ok(cleanup); for (const id of [1, 4, 7, 9]) assert.match(cleanup, new RegExp(`\\b${id}\\b`));
});

// 3. protected set never touched
test('protected item_types appear in every rule WHERE and a 400-day-old decision_needed is untouched', async () => {
  for (const sql of [RULE_A_SELECT, RULE_B_SELECT, RULE_C_SELECT, RULE_D1_SELECT, RULE_D2_SELECT, RULE_STALE_SELECT]) {
    assert.ok(sql.includes(`NOT IN ${PROTECTED_LIST_SQL}`), `missing protected clause: ${sql.slice(0, 80)}`);
  }
  assert.equal(PROTECTED_LIST_SQL, "('decision_needed','unconfirmed_decision','open_question','approval_needed')");
  for (const rule of AUTOCLOSE_RULES) assert.ok(rule.select.includes(PROTECTED_LIST_SQL), `${rule.tag} lacks protected clause`);
  const rows = fixtures();
  const m = mockSql(rows);
  const r = await runAutoclose({ mode: 'live', deps: { runSQL: m.runSQL, fetchPR: fetchPRMerged, env } });
  assert.deepEqual(r.errors, []);
  for (const u of m.updates()) {
    const idsInUpdate = (u.match(/ARRAY\[([^\]]*)\]/)?.[1] || '').split(',').map(Number).filter(Boolean);
    const pairs = [...u.matchAll(/\((\d+),(\d+)\)/g)].map((x) => Number(x[1]));
    assert.ok(!idsInUpdate.includes(3) && !pairs.includes(3), `decision_needed #3 (400 days) must never be touched: ${u}`);
    assert.ok(!idsInUpdate.includes(8) && !pairs.includes(8), `open_question #8 must never be touched: ${u}`);
  }
  for (const entry of Object.values(r.rules)) assert.ok(!entry.sample_ids.includes(3) && !entry.sample_ids.includes(8));
});

// 4. rule C keeps the newest id per normalized description
test('rule C keeps the newest open copy per normalised description and points older copies at it', async () => {
  const rows = fixtures();
  const m = mockSql(rows);
  const r = await runAutoclose({ mode: 'live', deps: { runSQL: m.runSQL, fetchPR: fetchPRMerged, env } });
  // 'dedupe me' group: #5 (10d), #6 (2d), #8 (1d, protected). Keeper = #8 (newest); #5 and #6 are older, non-protected → superseded by 8.
  assert.equal(r.rules['C:duplicate'].affected, 2);
  assert.deepEqual(r.rules['C:duplicate'].sample_ids, [5, 6]);
  const sup = m.updates().find((u) => /SET status='superseded'/.test(u));
  assert.ok(sup);
  assert.match(sup, /VALUES \(5,8\),\(6,8\)/);
  assert.match(sup, /closed_reason='C:duplicate'/);
  assert.match(sup, /p\.status='open'/);
  assert.match(RULE_C_SELECT, /PARTITION BY lower\(regexp_replace\(description,'\\s\+',' ','g'\)\)/);
  assert.match(RULE_C_SELECT, /ORDER BY coalesce\(session_date, created_at::date\) DESC, id DESC/);
});

// 5. STALE never changes status
test('STALE rule only ever sets stale=true — never status', async () => {
  assert.doesNotMatch(RULE_STALE_SELECT, /status\s*=\s*'(expired|done|superseded)'/);
  const s = staleFlagSql([9]);
  const setClause = s.split(/\bWHERE\b/)[0];
  assert.match(setClause, /SET stale=true/);
  assert.doesNotMatch(setClause, /\bstatus\s*=/);
  assert.match(s, /WHERE status='open' AND stale=false AND id = ANY\(ARRAY\[9\]::int\[\]\)/);
  const m = mockSql(fixtures());
  const r = await runAutoclose({ mode: 'live', deps: { runSQL: m.runSQL, fetchPR: fetchPRMerged, env } });
  const staleUpd = m.updates().filter((u) => /SET stale=true/.test(u));
  assert.equal(staleUpd.length, 1);
  assert.doesNotMatch(staleUpd[0].split(/\bWHERE\b/)[0], /\bstatus\s*=/);
  assert.equal(r.rules['STALE:untouched_120d'].status, undefined);
  assert.equal(AUTOCLOSE_RULES.find((x) => x.rule === 'STALE').status, null);
});

test('live close SQL is status-changing, re-checks open, and clears the shadow tag', () => {
  const s = closeSql('A:next_step_30d', 'expired', [1, 2]);
  assert.match(s, /SET status='expired', closed_by='nightly', closed_reason='A:next_step_30d', closed_at=now\(\), would_close=NULL/);
  assert.match(s, /WHERE status='open' AND id = ANY\(ARRAY\[1,2\]::int\[\]\)/);
  assert.match(shadowSql("x'y", [3]), /would_close='x''y'/, 'quotes escaped');
  assert.match(clearWouldCloseSql([]), /^UPDATE claude_pending_items SET would_close=NULL WHERE would_close IS NOT NULL$/);
  assert.match(logSql({ mode: 'live', rule: 'A', affected: 3, sample_ids: [1, 2, 3], notes: "it's" }), /VALUES \('live', 'A', 3, ARRAY\[1,2,3\]::integer\[\], 'it''s'\)/);
  assert.match(logSql({ mode: 'live', rule: 'A', affected: 0 }), /, 0, NULL, NULL\)/);
  assert.doesNotMatch(supersedeSql('C:duplicate', [{ id: 5, keep_id: 8 }]) + closeSql('t', 'done', [1]) + staleFlagSql([2]), /\bDELETE\b|\bDROP\b|\bTRUNCATE\b/i);
});

test('rules run in order and a row matched by an earlier rule is excluded from later ones', async () => {
  // #4 is retro + 130 days: matches B (90d) and STALE (120d). B runs first, STALE must skip it.
  const rows = fixtures();
  const m = mockSql(rows);
  const r = await runAutoclose({ mode: 'shadow', deps: { runSQL: m.runSQL, fetchPR: fetchPRMerged, env } });
  assert.ok(r.rules['B:retro_90d'].sample_ids.includes(4));
  assert.ok(!r.rules['STALE:untouched_120d'].sample_ids.includes(4));
});

test('dry_run counts every rule and writes nothing', async () => {
  const m = mockSql(fixtures());
  const r = await runAutoclose({ mode: 'shadow', dry_run: true, deps: { runSQL: m.runSQL, fetchPR: fetchPRMerged, env } });
  assert.equal(m.updates().length, 0); assert.equal(m.logs().length, 0);
  assert.ok(m.calls.every((s) => /^\s*SELECT/i.test(s)));
  assert.equal(r.rules['A:next_step_30d'].affected, 1);
  assert.equal(r.rules['C:duplicate'].affected, 2);
  assert.equal(r.matched, 6);
});

test('rule D2: skipped without a GitHub token; closes only rows whose named PRs are all merged; caches lookups', async () => {
  const m = mockSql(fixtures());
  const r = await runAutoclose({ mode: 'live', deps: { runSQL: m.runSQL, env: {} } });
  assert.equal(r.rules['D:pr_merged'].skipped, 'no GITHUB_PAT/GITHUB_TOKEN');
  assert.equal(r.rules['D:pr_merged'].affected, 0);
  assert.deepEqual(prNumbersIn({ description: 'see PR #866 and pr #867; PR#866 again. PR 5 phase and PR1 are not PRs', ref: 'PR # 868' }), [866, 867, 868]);
  assert.match(RULE_D2_SELECT, /PR\\s\*#\\s\*\\d\+/, 'SQL filter requires the # form too');
  let calls = 0;
  const fetchPR = async (n) => { calls++; if (n === 1) return { merged_at: 'x' }; if (n === 2) return { merged_at: null }; if (n === 3) return null; throw new Error('GitHub 502'); };
  const d2 = await mergedPrRows([
    { id: 10, description: 'Merge PR #1' }, { id: 11, description: 'Merge PR #1 and PR #2' }, { id: 12, description: 'Merge PR #3' },
    { id: 13, description: 'Merge PR #4' }, { id: 14, description: 'Deploy PR #1 again' },
  ], fetchPR);
  assert.deepEqual(d2.ids, [10, 14]); assert.deepEqual(d2.mention, []);
  assert.equal(calls, 4, 'one lookup per distinct PR');
  assert.equal(d2.errors.length, 1); assert.match(d2.errors[0], /^mrichard33\/LP-MCP#4: GitHub 502/);
  assert.equal(d2.too_early, 0);
});

test('rule D2 resolves the repo from the text and only counts merges on/after the item session date', async () => {
  // Repo resolution: nearest mention before the PR token wins, then after, else LP-MCP.
  assert.deepEqual(prRefsIn({ description: 'HL-MCP PR #151 opportunities sync cadence' }), [{ repo: 'mrichard33/HL-MCP', number: 151 }]);
  assert.deepEqual(prRefsIn({ description: 'PR #591 awaiting Mark review and merge' }), [{ repo: 'mrichard33/LP-MCP', number: 591 }]);
  assert.deepEqual(prRefsIn({ description: 'Deploy PR #12 to the Reece Dashboard' }), [{ repo: 'mrichard33/Reece-Dashboard', number: 12 }]);
  assert.deepEqual(prRefsIn({ description: 'lp-mcp PR #10 then hl_mcp PR #11 then PR #12 (ghl-workflows) and n8n PR #13' }), [
    { repo: 'mrichard33/LP-MCP', number: 10 }, { repo: 'mrichard33/HL-MCP', number: 11 },
    { repo: 'mrichard33/HL-MCP', number: 12 }, { repo: 'mrichard33/n8n', number: 13 },
  ], 'a mention before the token beats a nearer one after it');
  assert.deepEqual(prRefsIn({ description: 'PR #5 and PR #5 again', ref: 'PR #5' }), [{ repo: 'mrichard33/LP-MCP', number: 5 }], 'deduped per repo+number');
  assert.deepEqual(prRefsIn({ description: 'merge PR #390 into dev, promote dev to main, set the n8n Railway service to always-on' }),
    [{ repo: 'mrichard33/LP-MCP', number: 390 }], 'a repo named a sentence later (#1148) does not claim the PR');

  // Date gate.
  assert.equal(mergedAfterSession('2026-07-30T12:00:00Z', '2026-07-28'), true);
  assert.equal(mergedAfterSession('2026-07-28T23:59:00Z', '2026-07-28'), true, 'same day counts');
  assert.equal(mergedAfterSession('2026-03-01T00:00:00Z', '2026-07-28'), false);
  assert.equal(mergedAfterSession(null, '2026-07-28'), false);

  // The three production false positives from the first shadow run, plus two correct closes.
  const merged = {
    'mrichard33/LP-MCP#151': '2026-03-02T10:00:00Z',   // LP-MCP's own #151 — merged months before the item
    'mrichard33/HL-MCP#151': '2026-07-30T10:00:00Z',   // the HL-MCP PR the item actually names
    'mrichard33/LP-MCP#120': '2026-02-11T10:00:00Z',   // "PR #120 fix/kiosk..." is not LP-MCP's #120
    'mrichard33/LP-MCP#625': '2026-08-01T10:00:00Z',   // merged before the item that says rows are NOT rolled back by it
    'mrichard33/LP-MCP#591': '2026-07-30T10:00:00Z',   // awaiting merge on 07-29, merged 07-30 → done
    'mrichard33/LP-MCP#481': '2026-07-06T18:00:00Z',   // merged the same day → done
  };
  const calls = [];
  const fetchPR = async (n, repo) => { calls.push(`${repo}#${n}`); const m = merged[`${repo}#${n}`]; return m ? { merged_at: m } : null; };
  const rows = [
    { id: 402, description: 'HL-MCP PR #151 opportunities sync cadence and ceiling', item_type: 'awaiting_merge', session_date: '2026-07-28' },
    { id: 405, description: 'Confirm opportunities failure rate drops to near zero after PR #151 deploys', session_date: '2026-07-28' },
    { id: 533, description: 'PR #120 fix/kiosk-skips-supabase-auth open, awaiting Mark review and merge', session_date: '2026-07-31' },
    { id: 647, description: '56 already-fired-early milestone rows are NOT rolled back by PR #625', session_date: '2026-08-06' },
    { id: 371, description: 'PR #591 awaiting Mark review and merge', session_date: '2026-07-29' },
    { id: 313, description: 'User merges PR #481 -> Railway deploys', session_date: '2026-07-06' },
  ];
  const d2 = await mergedPrRows(rows, fetchPR);
  assert.deepEqual(d2.ids, [402, 371, 313]); assert.deepEqual(d2.mention, []);
  assert.equal(d2.too_early, 3, '#405, #533 and #647 name PRs merged before the item existed');
  assert.deepEqual(d2.errors, []);
  assert.equal(new Set(calls).size, calls.length, 'each repo+number fetched once');
  assert.ok(calls.includes('mrichard33/HL-MCP#151') && calls.includes('mrichard33/LP-MCP#151'));
  assert.match(RULE_D2_SELECT, /AS session_date/, 'the SELECT carries the session date the gate needs');
  assert.match(RULE_D2_SELECT, /^\s*SELECT id, item_type, description, ref,/, 'the SELECT carries item_type — prIntent reads it (second shadow run, 2026-09-06)');
});

test('rule D2 (ruling 1): a row naming a repo the resolver does not know is skipped', () => {
  assert.deepEqual(unresolvedReposIn({ description: 'HL-MCP PR #151 sync cadence' }), []);
  assert.deepEqual(unresolvedReposIn({ description: 'PR #12 in the Reece Dashboard repo, then n8n PR #3' }), []);
  assert.deepEqual(unresolvedReposIn({ description: 'mrichard33/kiosk PR #120 awaiting merge' }), ['kiosk']);
  assert.deepEqual(unresolvedReposIn({ description: 'PR #7 open in the payroll-sync repo' }), ['payroll-sync']);
  assert.deepEqual(unresolvedReposIn({ description: 'merge PR #9 (repo lightfire)' }), ['lightfire']);
  assert.deepEqual(unresolvedReposIn({ description: 'this repo PR #4; same repo PR #5' }), [], 'stopwords are not repo names');
});

test('rule D2 (ruling 2): only items ABOUT SHIPPING the PR close; passing mentions never do', () => {
  const ship = [
    { description: 'PR #591 awaiting Mark review and merge' },
    { description: 'User merges PR #481 -> Railway deploys' },
    { description: 'Merge dev to main and deploy PR #402; until then STAGE_4/5_ROUTE reaps continue' },
    { description: 'PR #328 (sync-leads v10.1 ghl_contact_id link fix) open on dev->main — awaiting Mark merge' },
    { description: 'HL-MCP PR #151 opportunities sync cadence and ceiling', item_type: 'awaiting_merge' },
    { description: 'Ship PR #12' },
    { description: 'Close PR #77 once CI is green' },
    { description: 'Merge PR #721, close #720 unmerged', item_type: 'next_step' },   // #2241: the shipping twin of #668; "#720 unmerged" is not a "PR #" ref
    { description: 'PR #120 fix/kiosk-skips-supabase-auth open, awaiting Mark review and merge', item_type: 'merge_needed' },  // #533 (held by the date gate, not by intent)
  ];
  const mention = [
    { description: '56 already-fired-early milestone rows are NOT rolled back by PR #625 - the 6 Install End fields' },   // #647
    { description: 'Confirm opportunities failure rate drops to near zero after PR #151 deploys' },                       // #405
    { description: 'verify after PR #866 merges', item_type: 'verification_needed' },
    { description: 'Ask Mark to rule on whether the debounce is still needed on top of PR #810' },
    { description: 'Answer the three section 4b questions in PR #797, especially Credit Decline' },
    { description: 'Confirm PR #778 contains full Project 2 scope' },
    { description: 'Close PHASE 0 items 1-6 before any PR #5 live-write flag flip' },
    { description: 'Update the runbook with the field order from PR #640' },
    // Real rows from the first shadow run that must NOT close:
    { description: "Skill v4 delta for Mark's copy: set workflow_code on new decisions. Area is no longer the skill's job - sql/093 (LP-MCP PR #866, merged 2026-09-06) fills it by BEFORE INSERT trigger.", item_type: 'next_step' },        // #2863: "merged" AFTER the token is context
    { description: 'Session 172 claimed HL main unchanged — false: PRs #153 and #154 merged. The PR #650 workflow-extractor handoff may still be unapplied', item_type: 'verification_needed' },  // #857
    { description: 'Close PR #859 unmerged (patches dead file nurture-hard-blockers.js)' },                                                                                                       // #1004
    { description: 'Pending at session end: merge PR #390 into dev, promote dev to main. Not confirmed.', item_type: 'verification_needed' },                                                    // #1148
    { description: 'PR #141 merge not confirmed in-session', item_type: 'verification_needed' },                                                                                                  // #1162
    { description: 'MERGE PR #721 (fix/lp-attribution-830-5574). CLOSE #720 UNMERGED — same commits.', item_type: 'review_needed' },                                                              // #668
    { description: 'Apply PR #650 handoff (HL workflow-extractor write amplification) — still unapplied', item_type: 'next_step' },                                                              // #2396
    { description: 'PR #845 has under 2 hours of live runtime as of this checkpoint. Re-check tomorrow morning.', item_type: 'verification_needed' },                                             // #1045
  ];
  for (const r of ship) assert.equal(prIntent(r), 'ship', `should be ship: ${r.description}`);
  for (const r of mention) assert.equal(prIntent(r), 'mention', `should be mention: ${r.description}`);
});

test('rule D2 end to end: ship rows close, mention rows keep a D:pr_mentioned tag in BOTH modes, #647 never closes', async () => {
  const merged = { 'mrichard33/LP-MCP#591': '2026-07-30T10:00:00Z', 'mrichard33/LP-MCP#625': '2026-08-20T10:00:00Z', 'mrichard33/HL-MCP#151': '2026-07-30T10:00:00Z', 'mrichard33/LP-MCP#120': '2026-08-02T10:00:00Z' };
  const fetchPR = async (n, repo) => { const m = merged[`${repo}#${n}`]; return m ? { merged_at: m } : null; };
  const d2rows = [
    { id: 371, description: 'PR #591 awaiting Mark review and merge', session_date: '2026-07-29' },
    { id: 647, description: '56 already-fired-early milestone rows are NOT rolled back by PR #625 - the 6 Install End fields', session_date: '2026-08-06' },
    { id: 402, description: 'HL-MCP PR #151 opportunities sync cadence and ceiling', item_type: 'awaiting_merge', session_date: '2026-07-28' },
    { id: 533, description: 'mrichard33/kiosk PR #120 open, awaiting Mark review and merge', item_type: 'merge_needed', session_date: '2026-07-31' },
  ];
  const d2 = await mergedPrRows(d2rows, fetchPR);
  assert.deepEqual(d2.ids, [371, 402]);
  assert.deepEqual(d2.mention, [647], '#647 is a passing mention: tagged, never closed');
  assert.equal(d2.unresolved, 1, '#533 names a repo we cannot resolve and is skipped');

  const runSQL = (calls) => async (sql) => {
    calls.push(sql);
    if (sql === RULE_D2_SELECT) return d2rows;
    if (/^\s*SELECT/i.test(sql)) return [];
    return { status: 'ok' };
  };
  for (const mode of ['shadow', 'live']) {
    const calls = [];
    const r = await runAutoclose({ mode, deps: { runSQL: runSQL(calls), fetchPR, env } });
    assert.deepEqual(r.errors, []);
    assert.equal(r.rules['D:pr_merged'].affected, 2); assert.deepEqual(r.rules['D:pr_merged'].sample_ids, [371, 402]);
    assert.equal(r.rules['D:pr_mentioned'].affected, 1); assert.deepEqual(r.rules['D:pr_mentioned'].sample_ids, [647]);
    assert.equal(r.rules['D:pr_mentioned'].closes, false);
    assert.equal(r.rules['D:pr_merged'].unresolved_repo, 1);
    const tagMention = calls.find((s) => /SET would_close='D:pr_mentioned'/.test(s));
    assert.ok(tagMention, `${mode}: mention rows are tagged`); assert.match(tagMention, /ARRAY\[647\]/);
    for (const s of calls.filter((s) => /^\s*UPDATE/.test(s))) {
      if (/SET status=/.test(s)) assert.doesNotMatch(s, /\b647\b/, `${mode}: #647 must never be closed: ${s}`);
    }
    const logMention = calls.find((s) => /INSERT INTO claude_memory_autoclose_log/.test(s) && /'D:pr_mentioned'/.test(s));
    assert.match(logMention, new RegExp(`VALUES \\('${mode}', 'D', 1, ARRAY\\[647\\]`));
    const cleanup = calls.find((s) => /SET would_close=NULL WHERE would_close IS NOT NULL/.test(s));
    assert.match(cleanup, /\b647\b/, `${mode}: the cleanup keeps #647's tag`);
    if (mode === 'live') {
      const close = calls.find((s) => /SET status='done'/.test(s));
      assert.match(close, /closed_reason='D:pr_merged'/); assert.match(close, /ARRAY\[371,402\]/);
      assert.doesNotMatch(cleanup, /\b371\b|\b402\b/, 'closed rows do not need their tag kept');
    } else {
      assert.ok(!calls.some((s) => /SET status=/.test(s)), 'shadow never closes');
    }
  }
});

test('a failing rule is recorded and the remaining rules still run', async () => {
  const rows = fixtures();
  const base = mockSql(rows);
  const runSQL = async (sql) => { if (sql === RULE_B_SELECT) throw new Error('boom'); return base.runSQL(sql); };
  const r = await runAutoclose({ mode: 'shadow', deps: { runSQL, fetchPR: fetchPRMerged, env } });
  assert.deepEqual(r.errors, ['B:retro_90d: boom']);
  assert.equal(r.rules['B:retro_90d'].error, 'boom');
  assert.equal(r.rules['C:duplicate'].affected, 2);
  assert.equal(r.rules['STALE:untouched_120d'].affected, 2, '#4 now falls through to STALE because B did not claim it');
});

// 7. withRetry
test('withRetry retries ECONNRESET three times and does not retry a validation error', async () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  let n = 0;
  const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  await assert.rejects(() => withRetry(async () => { n++; throw err; }, { sleep }), /ECONNRESET/);
  assert.equal(n, 3); assert.deepEqual(sleeps, [250, 1000]); assert.equal(err.attempts, 3);

  n = 0;
  const ok = await withRetry(async () => { n++; if (n < 3) throw new Error('TypeError: fetch failed'); return 'done'; }, { sleep });
  assert.equal(ok, 'done'); assert.equal(n, 3);

  n = 0;
  class CheckpointError extends Error {}
  await assert.rejects(() => withRetry(async () => { n++; throw new CheckpointError('session.title is required'); }, { sleep }), CheckpointError);
  assert.equal(n, 1, 'validation error must not be retried');

  n = 0;
  const e4 = Object.assign(new Error('insert session: duplicate key'), { status: 409 });
  await assert.rejects(() => withRetry(async () => { n++; throw e4; }, { sleep }), /duplicate key/);
  assert.equal(n, 1, '4xx must not be retried');

  n = 0;
  const e5 = Object.assign(new Error('insert: upstream'), { status: 503 });
  await assert.rejects(() => withRetry(async () => { n++; throw e5; }, { sleep, attempts: 2 }), /upstream/);
  assert.equal(n, 2);

  assert.equal(isTransientError(new Error('column "foo" does not exist')), false);
  assert.equal(isTransientError(Object.assign(new Error('x'), { code: '23505' })), false);
  assert.equal(isTransientError(Object.assign(new Error('x'), { code: '08006' })), true);
  assert.equal(isTransientError(new Error('GitHub 502: bad gateway')), true);
  assert.equal(isTransientError(new Error('socket hang up')), true);
  assert.equal(isTransientError(new Error('id 503 not found')), false, 'a bare number is not an HTTP status');
});
