/**
 * The post-demo objection family never routes a rehash contact into O.0 (Mark,
 * 2026-10-21). The rules are database rows; this holds the seed to the ruling.
 *
 * Run: node --test scripts/test-rehash-no-o0-routing-seed.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../sql/seeds/2026-10-21_rehash_no_o0_routing.sql', import.meta.url), 'utf8');
const body = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

const FAMILY = [
  'BEHAVIORAL_COMPETITOR_OBJECTION', 'BEHAVIORAL_PRICE_OBJECTION', 'BEHAVIORAL_SPOUSE_OBJECTION',
  'BEHAVIORAL_TIMING_OBJECTION', 'BEHAVIORAL_TRUST_OBJECTION', 'BEHAVIORAL_DIY_OBJECTION',
  'BRIDGE_CONCERN_COMPETITOR', 'BRIDGE_CONCERN_PRICE', 'BRIDGE_CONCERN_SPOUSE',
  'BRIDGE_CONCERN_TIMING', 'BRIDGE_CONCERN_TRUST', 'BRIDGE_CONCERN_DIY', 'OBJECTION_ROUTE_POST_DEMO',
];

test('the whole post-demo objection family, and nothing else', () => {
  for (const k of FAMILY) assert.match(body, new RegExp(`'${k}'`), k);
  for (const k of ['RESCISSION_RESCUE_HUMAN_OWNED', 'LOOP_ESCALATION_UNCLEAR', 'LP_DISP_']) assert.doesNotMatch(body, new RegExp(k), k);
});

test('the skip is the three rehash tags only, never the post-demo tags', () => {
  assert.match(body, /\["rehash","active-f\.0","rehash-owned"\]/);
  for (const t of ['stage:post-appointment', 'lp-demo-completed', 'bj:stage-4']) assert.doesNotMatch(body, new RegExp(`"${t}"`), t);
});

test('only the workflow moves move; tags and notifications stay on the parent', () => {
  assert.match(body, /WHERE a->>'action_type' IN \('add_to_workflow', 'remove_from_workflow'\)\) AS moves/);
  assert.match(body, /WHERE a->>'action_type' NOT IN \('add_to_workflow', 'remove_from_workflow'\)\) AS keep/);
  assert.match(body, /action_template = sp\.keep/);
});

test('the routing branch also removes the contact from F.0 v2', () => {
  assert.match(body, /07559309-9f55-4adf-8eff-9e5e3e5c3979/);
  assert.match(body, /15f47572-9ffc-453d-995d-a1890441f290/);
});

test('idempotent, and every split is logged', () => {
  assert.match(body, /NOT EXISTS \(SELECT 1 FROM agent_rules x WHERE x\.rule_key = r\.rule_key \|\| '_ROUTE'\)/);
  assert.match(body, /INSERT INTO bot_change_log/);
});
