/**
 * add_to_workflow `json_custom_data` body — scripts/test-add-to-workflow-custom-data.js
 *
 * Covers the 2026-09-24 v2.2 change in src/actions/handlers/workflows.js.
 *
 * E.0 Master Router finds the contact from
 * {{inboundWebhookRequest.customData.ghl_contact_id}}; the default form body only
 * carries the flat contact_id every bridge trigger reads, so a form POST to E.0
 * matched nobody and E.0 ended silently. INTAKE_ROUTE_BACKSTOP_E0 sends
 * format 'json_custom_data'. Asserted at the fetch boundary, like
 * test-remove-from-workflow-tag-clear.js.
 *
 * Run: node --test scripts/test-add-to-workflow-custom-data.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GHL_API_KEY = 'test-key';
process.env.GHL_LOCATION_ID = 'test-location';

let posts = [];
globalThis.fetch = async (url, opts = {}) => {
  const href = String(url?.url || url);
  if (href.startsWith('https://hooks.example/')) {
    posts.push({ href, contentType: opts.headers?.['Content-Type'], body: opts.body });
  }
  // The idempotency guard's contact read: no active-e.0 yet.
  return {
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ contact: { id: 'contact-1', tags: [] } }),
    text: async () => '{}',
  };
};

const { executeAddToWorkflow, buildCustomDataBody } = await import('../src/actions/handlers/workflows.js');

const action = (format) => ({
  target_id: 'contact-1',
  action_payload: {
    webhook_url: 'https://hooks.example/e0',
    canonical_code: 'E.0',
    workflow_name: 'E.0 Master Router',
    format,
    payload: { source: 'intake_backstop', entry_route_rule: 'INTAKE_ROUTE_BACKSTOP_E0', contact_id: 'stale-id' },
  },
});

test('buildCustomDataBody nests the target id where E.0 reads it', () => {
  const body = buildCustomDataBody({ source: 'x', contact_id: 'c1', contactId: 'c1' }, 'c1');
  assert.equal(body.customData.ghl_contact_id, 'c1');
  assert.equal(body.customData.source, 'x');
  assert.equal(body.contact_id, 'c1', 'flat keys kept for triggers that read them');
});

test('json_custom_data POSTs JSON with customData.ghl_contact_id = the real target', async () => {
  posts = [];
  const res = await executeAddToWorkflow(action('json_custom_data'));
  assert.equal(res.route, 'B');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].contentType, 'application/json');
  const body = JSON.parse(posts[0].body);
  assert.equal(body.customData.ghl_contact_id, 'contact-1');
  assert.equal(body.customData.contact_id, 'contact-1', 'a stale payload contact_id never wins');
  assert.equal(body.customData.entry_route_rule, 'INTAKE_ROUTE_BACKSTOP_E0');
});

test('form format is unchanged: flat urlencoded contact_id, no customData', async () => {
  posts = [];
  await executeAddToWorkflow(action('form'));
  assert.equal(posts[0].contentType, 'application/x-www-form-urlencoded');
  const params = new URLSearchParams(posts[0].body);
  assert.equal(params.get('contact_id'), 'contact-1');
  assert.equal(params.get('customData'), null);
});
