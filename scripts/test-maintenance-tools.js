/**
 * stale_lp_tags_cleanup_run — src/tools/maintenance-tools.js (2026-10-11).
 *
 * The guards that matter: a dry run writes nothing, a live run removes only the
 * planned tags and never more than max_removals, and the tool runs the script's
 * own code (no second copy of the plan).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStaleLpTagsCleanupRun, registerMaintenanceTools } from '../src/tools/maintenance-tools.js';
import * as script from './cleanup-stale-lp-tags.js';

const NOW = Date.parse('2026-10-11T20:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

// Three contacts, each with a stale Day 15 tag on a lead made 2 days ago.
const CONTACTS = ['c1', 'c2', 'c3'].map((id) => ({
  ghl_contact_id: id, name: `Lead ${id}`, tags: ['lp-day15-handoff'],
}));
const LEADS = CONTACTS.map((c, i) => ({
  lp_lead_id: 600000 + i, ghl_contact_id: c.ghl_contact_id, disposition_code: 'Set',
  demo_completed: false, created_at_lp: daysAgo(2), updated_at_lp: daysAgo(2),
}));

function fakeDeps() {
  const removed = [];
  const deps = {
    nowMs: NOW,
    hlRunSQL: async () => CONTACTS,
    supabase: {
      from() {
        const chain = {
          select() { return chain; },
          in() { return chain; },
          limit() { return Promise.resolve({ data: LEADS, error: null }); },
        };
        return chain;
      },
    },
    ghlFetch: async (_m, path) => {
      const id = path.split('/').pop();
      return { contact: { tags: removed.includes(id) ? [] : ['lp-day15-handoff'] } };
    },
    executeRemoveTag: async ({ target_id }) => { removed.push(target_id); },
    sleep: async () => {},
    log: () => {},
  };
  return { deps, removed };
}

test('dry run plans the removals and writes nothing', async () => {
  const { deps, removed } = fakeDeps();
  const out = await makeStaleLpTagsCleanupRun({ scriptDeps: deps })({ dry_run: true });
  assert.equal(out.dry_run, true);
  assert.equal(out.planned.day15_handoff, 3);
  assert.equal(out.removals.length, 3);
  assert.equal(out.written, undefined);
  assert.deepEqual(removed, []);
});

test('live run respects max_removals and reports the rest as remaining', async () => {
  const { deps, removed } = fakeDeps();
  const out = await makeStaleLpTagsCleanupRun({ scriptDeps: deps })({ dry_run: false, max_removals: 2 });
  assert.equal(out.written.removed, 2);
  assert.equal(out.remaining, 1);
  assert.equal(removed.length, 2);
  assert.match(out.next_step, /remaining 1/);
});

test('the script with no --max removes everything planned', async () => {
  const { deps, removed } = fakeDeps();
  const res = await script.run(['--live'], deps);
  assert.equal(res.written.removed, 3);
  assert.equal(res.remaining, 0);
  assert.equal(removed.length, 3);
});

test('the tools register as rehash_tag_cleanup_run, check_rule_targets and stale_lp_tags_cleanup_run', () => {
  const names = [];
  registerMaintenanceTools({ tool: (name) => names.push(name) });
  // 2026-10-12: check_rule_targets (F-L, read-only) joined the file.
  // 2026-10-14: rehash_tag_cleanup_run (no dates or ids in GHL tags).
  // 2026-10-19: invoice_bank_redact_run (no saved routing or account numbers).
  assert.deepEqual(names, ['invoice_bank_redact_run', 'ghl_attribution_cleanup_run', 'rehash_tag_cleanup_run', 'check_rule_targets', 'stale_lp_tags_cleanup_run']);
});
