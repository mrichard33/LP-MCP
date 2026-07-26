/**
 * Intake backstop guards — scripts/test-lp-intake-backstop.js
 *
 * Covers the 2026-07-26 intake-mode additions to
 * src/services/lp-contact-backstop.js. Pure functions only — no GHL I/O, no
 * Supabase — so this runs anywhere.
 *
 * The three things that must never regress:
 *   1. Tag invariant: exactly ONE entry:* and ONE active-entry:* per contact
 *   2. A stale lead can never be created un-suppressed
 *   3. Intake mode's recency window cannot reach past its ceiling
 *
 * Run: node scripts/test-lp-intake-backstop.js
 */

import assert from 'node:assert';
import {
  vendorSlug,
  sourceDetailTagFor,
  backstopTagsFor,
  makeIsWithinIntakeWindow,
  shouldSuppressOutbound,
  selectBackstopTargets,
  isWithinApptWindow,
  MAX_INTAKE_LOOKBACK_HOURS,
  DEFAULT_INTAKE_FRESH_HOURS,
  LP_INTAKE_SUPPRESS_TAG,
} from '../src/services/lp-contact-backstop.js';

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-07-26T18:00:00Z');
const agoHours = (h) => new Date(NOW - h * HOUR).toISOString();

// ─── vendorSlug ──────────────────────────────────────────────────
assert.equal(vendorSlug('Modernize'), 'modernize');
assert.equal(vendorSlug('Lead Gurus'), 'lead-gurus');
assert.equal(vendorSlug('Contractor Appointment-West'), 'contractor-appointment-west');
assert.equal(vendorSlug('MVP Marketing'), 'mvp-marketing');
assert.equal(vendorSlug('  Porch101  '), 'porch101');
assert.equal(vendorSlug(''), '');
assert.equal(vendorSlug(null), '');

// ─── sourceDetailTagFor ──────────────────────────────────────────
assert.equal(sourceDetailTagFor('Internet', 'Modernize'), 'source:internet-modernize');
assert.equal(sourceDetailTagFor('Internet', 'Lead Gurus'), 'source:internet-lead-gurus');
assert.equal(sourceDetailTagFor('Affiliates', 'MVP Marketing'), 'source:affiliate-mvp-marketing');
assert.equal(sourceDetailTagFor('Canvass', 'Canvass'), null, 'Canvass has canvass-subtype:* — no vendor axis');
assert.equal(sourceDetailTagFor('Internet', 'Internet'), null, 'detail == source carries no information');
assert.equal(sourceDetailTagFor('Internet', null), null, 'missing detail → no tag');
assert.equal(sourceDetailTagFor('Job Signs', 'Job Signs'), null, 'unmapped source → no vendor tag');

// ─── backstopTagsFor — THE INVARIANT ─────────────────────────────
const countPrefix = (tags, p) => tags.filter((t) => t.startsWith(p)).length;

for (const [src, detail] of [
  ['Internet', 'Modernize'],
  ['Affiliates', 'MVP Marketing'],
  ['Canvass', 'Canvass'],
  ['Job Signs', 'Job Signs'],
  [undefined, undefined],
]) {
  for (const suppressOutbound of [false, true]) {
    const tags = backstopTagsFor(src, detail, { suppressOutbound });
    const label = `${src}/${detail}/suppress=${suppressOutbound}`;
    assert.equal(countPrefix(tags, 'entry:'), 1, `${label}: exactly one entry:*`);
    assert.equal(countPrefix(tags, 'active-entry:'), 1, `${label}: exactly one active-entry:*`);
    assert.equal(countPrefix(tags, 'stage:'), 1, `${label}: exactly one stage:*`);
    assert.equal(new Set(tags).size, tags.length, `${label}: no duplicate tags`);
    assert.ok(tags.includes('lp-backstop-created'), `${label}: provenance tag present`);
    assert.equal(
      tags.includes(LP_INTAKE_SUPPRESS_TAG), suppressOutbound,
      `${label}: suppress tag present iff requested`,
    );
  }
}

// Vendor attribution actually lands, alongside the base source tag.
{
  const tags = backstopTagsFor('Internet', 'Porch101');
  assert.ok(tags.includes('source:internet'), 'base channel tag retained');
  assert.ok(tags.includes('source:internet-porch101'), 'vendor tag added');
  assert.ok(tags.includes('entry:other') && tags.includes('active-entry:other'));
}
// Backwards compatible: old two-arg call still works (appointment-mode path).
assert.deepEqual(
  backstopTagsFor('Canvass'),
  ['entry:canvassing', 'active-entry:canvassing', 'source:canvass', 'lp-backstop-created', 'lp-linked', 'stage:new-lead'],
  'legacy single-arg call unchanged',
);

// ─── makeIsWithinIntakeWindow ────────────────────────────────────
{
  const within72 = makeIsWithinIntakeWindow(72, NOW);
  assert.ok(within72({ created_at_lp: agoHours(0.2) }), 'minutes old → in');
  assert.ok(within72({ created_at_lp: agoHours(71) }), 'just inside → in');
  assert.ok(!within72({ created_at_lp: agoHours(73) }), 'just outside → out');
  assert.ok(within72({ created_at_lp: agoHours(-0.5) }), 'small clock skew tolerated');
  assert.ok(!within72({ created_at_lp: agoHours(-5) }), 'far-future row rejected');
  assert.ok(!within72({ created_at_lp: 'garbage' }), 'unparseable rejected');
  assert.ok(!within72({ created_at_lp: null }), 'null rejected');
}
// The ceiling is enforced regardless of what the caller asks for.
{
  const absurd = makeIsWithinIntakeWindow(9_999_999, NOW);
  assert.ok(!absurd({ created_at_lp: agoHours(MAX_INTAKE_LOOKBACK_HOURS + 24) }),
    'MAX_INTAKE_LOOKBACK_HOURS clamps a mis-parameterized run');
  assert.ok(absurd({ created_at_lp: agoHours(MAX_INTAKE_LOOKBACK_HOURS - 24) }),
    'inside the ceiling still passes');
}

// ─── shouldSuppressOutbound — the safety belt ────────────────────
{
  const fresh = { created_at_lp: agoHours(1) };
  const stale = { created_at_lp: agoHours(72) };

  assert.equal(shouldSuppressOutbound(fresh, { nowMs: NOW }).suppress, false,
    'fresh lead on a forward run → NOT suppressed');
  assert.equal(shouldSuppressOutbound(stale, { nowMs: NOW }).suppress, true,
    'BELT: stale lead is suppressed even on a forward-only run');
  assert.equal(shouldSuppressOutbound(fresh, { suppressOutbound: true, nowMs: NOW }).suppress, true,
    'backlog run suppresses even a fresh lead');
  assert.equal(shouldSuppressOutbound({ created_at_lp: 'nope' }, { nowMs: NOW }).suppress, true,
    'unparseable timestamp fails toward silence');
  assert.equal(shouldSuppressOutbound({}, { nowMs: NOW }).suppress, true,
    'missing timestamp fails toward silence');

  // Boundary sits exactly at freshHours.
  assert.equal(shouldSuppressOutbound({ created_at_lp: agoHours(DEFAULT_INTAKE_FRESH_HOURS - 0.1) }, { nowMs: NOW }).suppress, false);
  assert.equal(shouldSuppressOutbound({ created_at_lp: agoHours(DEFAULT_INTAKE_FRESH_HOURS + 0.1) }, { nowMs: NOW }).suppress, true);

  assert.equal(shouldSuppressOutbound(stale, { nowMs: NOW }).reason, 'stale_72h', 'reason is auditable');
  assert.equal(shouldSuppressOutbound(fresh, { suppressOutbound: true, nowMs: NOW }).reason, 'run_mode_backlog');
}

// ─── selectBackstopTargets with an injected window ───────────────
{
  // Rows MUST be created_at_lp DESC, as the scans return them.
  const rows = [
    { lp_lead_id: 'A', created_at_lp: agoHours(1),  phone: '(407) 492-0504' },
    { lp_lead_id: 'B', created_at_lp: agoHours(2),  phone: '4074920504' },   // dupe of A
    { lp_lead_id: 'C', created_at_lp: agoHours(3),  phone: '123' },          // bad phone
    { lp_lead_id: 'D', created_at_lp: agoHours(4),  phone: '9045348352' },
    { lp_lead_id: 'E', created_at_lp: agoHours(500), phone: '3055551212' },  // outside window
  ];
  const sel = selectBackstopTargets(rows, {
    maxPerRun: 10,
    withinWindow: makeIsWithinIntakeWindow(72, NOW),
  });

  assert.deepEqual(sel.targets.map((t) => t.lead.lp_lead_id), ['A', 'D'], 'window + phone + dedupe');
  assert.equal(sel.targets[0].superseded, 1, 'B recorded as superseded by A, not processed');
  assert.deepEqual(sel.noPhone.map((l) => l.lp_lead_id), ['C'], 'bad phone reported, never created');
  assert.equal(sel.eligible, 2);
  assert.equal(sel.deferredCapped, 0);

  const capped = selectBackstopTargets(rows, {
    maxPerRun: 1,
    withinWindow: makeIsWithinIntakeWindow(72, NOW),
  });
  assert.equal(capped.targets.length, 1, 'cap respected');
  assert.equal(capped.deferredCapped, 1, 'remainder deferred, not dropped silently');
}

// The default window is still appointment mode — intake must not have
// loosened the shipped path.
{
  const dataLead = { lp_lead_id: 'X', created_at_lp: agoHours(1), phone: '4074920504', appointment_date: null };
  const sel = selectBackstopTargets([dataLead], { maxPerRun: 10 });
  assert.equal(sel.targets.length, 0, 'REGRESSION GUARD: appointment mode still rejects a no-appointment lead');
  assert.equal(isWithinApptWindow(dataLead), false);
}

console.log('✅ lp intake backstop: all assertions passed');
