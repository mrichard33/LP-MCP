/**
 * Regex budget — scripts/test-regex-budget.js
 *
 * Phase 0 (architecture review 2026-10-17): src/agentic grows a regex for
 * nearly every live incident, and each one is another way for a reply to be
 * read wrong. Growth is allowed, but not silently: the count of `_RX =`
 * declarations under src/agentic is held to scripts/fixtures/regex-budget.json,
 * and raising the budget needs a `reason` that names the scenario
 * (a SCENARIOS key in src/simulator/bot-simulator.js) showing why.
 *
 * A count BELOW the budget passes; lower the budget in the same change so the
 * room is not spent later without a reason.
 *
 * Run: node --test scripts/test-regex-budget.js
 */
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const AGENTIC = path.join(ROOT, 'src', 'agentic');
const BUDGET_FILE = path.join(HERE, 'fixtures', 'regex-budget.json');
const SEED_REASON = /^Phase 0 seed\b/;
// The seed reason covers the seed count only; any budget above it needs its own.
const SEED_COUNT = 296;

/** Every `_RX =` declaration under a directory, recursively (matches, not lines). */
export function countRegexDeclarations(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) n += countRegexDeclarations(p);
    else if (entry.name.endsWith('.js')) n += (fs.readFileSync(p, 'utf8').match(/_RX\s*=/g) || []).length;
  }
  return n;
}

/** Does a budget reason name a scenario key? Pure. */
export function reasonNamesScenario(reason, keys) {
  const words = new Set(String(reason || '').match(/[a-z0-9_]+/gi) || []);
  return keys.some(k => words.has(k));
}

const { SCENARIOS } = await import('../src/simulator/bot-simulator.js');
const budget = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
const count = countRegexDeclarations(AGENTIC);

test('the budget file is well formed', () => {
  assert.ok(Number.isInteger(budget.count) && budget.count > 0, 'count is a positive integer');
  assert.match(String(budget.updated || ''), /^\d{4}-\d{2}-\d{2}$/, 'updated is a date');
  assert.ok(String(budget.reason || '').trim(), 'reason is set');
});

test('src/agentic holds no more regexes than the budget', () => {
  console.log(`regex budget: ${count} declared / ${budget.count} budgeted${count < budget.count ? ' (lower the budget)' : ''}`);
  assert.ok(
    count <= budget.count,
    `src/agentic now declares ${count} _RX regexes, over the budget of ${budget.count}. ` +
    'If the new one is needed, raise scripts/fixtures/regex-budget.json in the same change ' +
    'with a reason that names the scenario key that shows why.',
  );
});

test('a raised budget names the scenario that justifies it', () => {
  if (SEED_REASON.test(String(budget.reason)) && budget.count <= SEED_COUNT) return;
  assert.ok(
    reasonNamesScenario(budget.reason, Object.keys(SCENARIOS)),
    `regex-budget.json reason "${budget.reason}" names no SCENARIOS key`,
  );
});

test('reasonNamesScenario reads a key as a whole word', () => {
  assert.equal(reasonNamesScenario('rehash_defer: "call me in the spring" needed a season word', ['rehash_defer', 'price']), true);
  assert.equal(reasonNamesScenario('pricing tweak', ['price']), false);
  assert.equal(reasonNamesScenario('', ['price']), false);
});
