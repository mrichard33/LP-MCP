/**
 * test-canvassing-webhook-body.js — GHL webhook body shape + event attribution.
 *
 * Regression coverage for the 2026-07-30 defect: every event-form submission
 * 400'd with `canvass_version must be "v2" (got "(empty)")` on a field that is
 * a STATIC literal in the workflow. The body parsed fine — GHL's standard
 * Webhook action nests the step's declared keys under `customData`, and
 * validateCanvassingPayload read them flat. Confirmed against 6/6 live
 * ghl.entry_detected shape fingerprints in system_events.
 *
 * Also covers the srs_id → sender derivation and the event booking window,
 * both of which ride the same intake.
 *
 * Run: node --test scripts/test-canvassing-webhook-body.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Match test-canvassing-lead-handler.js: scrub creds before the module loads
// so fail-open paths can't find an ambient client.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { flattenWebhookBody, webhookShapeFingerprint } =
  await import('../src/webhook-body.js');
const { validateCanvassingPayload, buildLpLeadFields } =
  await import('../src/canvassing-lead-handler.js');
const {
  convertCanvassAppointment,
  APPT_WINDOW_DAYS,
  EVENT_WINDOW_DAYS,
} = await import('../src/canvassing-time.js');

// The keys the workflow step declares. In production these arrive nested.
const DECLARED = {
  ghl_contact_id: 'CONTACT123',
  canvass_version: 'v2',
  first_name: 'Test',
  last_name: 'Homeowner',
  phone_raw: '+19545551234',
  address1: '123 Main St',
  city: 'Fort Myers',
  state: 'FL',
  zip: '33901',
};

// What GHL actually posts: native contact keys + display-name custom fields at
// the top level, the step's declared keys nested under customData.
function ghlStandardWebhookBody(declared = DECLARED) {
  return {
    contact_id: 'CONTACT123',
    first_name: 'Test',
    phone: '+19545551234',
    'Canvassing Notes': '',
    'Pro ID': 5862,
    location: { id: 'SsBG7j5KQAIP1SFP2Sca' },
    customData: { ...declared },
  };
}

// ─── The production 400 ─────────────────────────────────────────

test('customData object: the exact shape that 400d in production', () => {
  const { ok, errors, normalized } = validateCanvassingPayload(ghlStandardWebhookBody());
  assert.equal(ok, true, `expected ok, got errors: ${JSON.stringify(errors)}`);
  assert.equal(normalized.canvass_version, 'v2');
  assert.equal(normalized.ghl_contact_id, 'CONTACT123');
});

test('customData stringified JSON resolves the same', () => {
  const body = ghlStandardWebhookBody();
  body.customData = JSON.stringify(DECLARED);
  const { ok, normalized } = validateCanvassingPayload(body);
  assert.equal(ok, true);
  assert.equal(normalized.canvass_version, 'v2');
  assert.equal(normalized.ghl_contact_id, 'CONTACT123');
});

test('customData array of {key,value} pairs resolves the same', () => {
  const body = ghlStandardWebhookBody();
  body.customData = Object.entries(DECLARED).map(([key, value]) => ({ key, value }));
  const { ok, normalized } = validateCanvassingPayload(body);
  assert.equal(ok, true);
  assert.equal(normalized.canvass_version, 'v2');
  assert.equal(normalized.ghl_contact_id, 'CONTACT123');
});

test('flat body still validates — no regression on the door-to-door path', () => {
  const { ok, normalized } = validateCanvassingPayload({ ...DECLARED });
  assert.equal(ok, true);
  assert.equal(normalized.ghl_contact_id, 'CONTACT123');
});

test('top-level key wins over a customData key of the same name', () => {
  const merged = flattenWebhookBody({
    ghl_contact_id: 'TOPLEVEL',
    customData: { ghl_contact_id: 'NESTED', canvass_version: 'v2' },
  });
  assert.equal(merged.ghl_contact_id, 'TOPLEVEL');
  assert.equal(merged.canvass_version, 'v2');
});

test('an empty top-level value defers to customData', () => {
  // GHL sends '' for unresolved merge tags; that must not mask the real value.
  const merged = flattenWebhookBody({
    ghl_contact_id: '',
    customData: { ghl_contact_id: 'NESTED' },
  });
  assert.equal(merged.ghl_contact_id, 'NESTED');
});

test('a genuinely empty body still 400s with both original errors', () => {
  const { ok, errors } = validateCanvassingPayload({});
  assert.equal(ok, false);
  assert.ok(errors.includes('ghl_contact_id is required'));
  assert.ok(errors.some((e) => e.startsWith('canvass_version must be "v2"')));
});

test('a non-object body is still rejected structurally', () => {
  assert.equal(validateCanvassingPayload(null).ok, false);
  assert.equal(validateCanvassingPayload([]).ok, false);
  assert.equal(validateCanvassingPayload('nope').ok, false);
});

test('flattenWebhookBody does not mutate its input', () => {
  const input = { customData: { a: 1 } };
  const out = flattenWebhookBody(input);
  assert.equal(out.a, 1);
  assert.equal(input.a, undefined);
});

// ─── Event attribution ──────────────────────────────────────────

test('srs_id from customData drives srs_id and sender on the LP fields', () => {
  const body = ghlStandardWebhookBody({ ...DECLARED, srs_id: '869' });
  const { ok, normalized } = validateCanvassingPayload(body);
  assert.equal(ok, true);
  assert.equal(normalized.srs_id, '869');

  const fields = buildLpLeadFields(normalized, null);
  assert.equal(fields.srs_id, '869');
  assert.equal(fields.sender, 'GHL-Events');
});

test('absent srs_id keeps Canvass 344 / GHL-Canvassing unchanged', () => {
  const { normalized } = validateCanvassingPayload(ghlStandardWebhookBody());
  const fields = buildLpLeadFields(normalized, null);
  assert.equal(fields.srs_id, '344');
  assert.equal(fields.sender, 'GHL-Canvassing');
});

test('an explicit srs_id of 344 is treated as canvassing, not an event', () => {
  const body = ghlStandardWebhookBody({ ...DECLARED, srs_id: '344' });
  const { normalized } = validateCanvassingPayload(body);
  const fields = buildLpLeadFields(normalized, null);
  assert.equal(fields.srs_id, '344');
  assert.equal(fields.sender, 'GHL-Canvassing');
});

// ─── Booking window ─────────────────────────────────────────────

// Monday, so fridayExceptionDeadline() is inert and daysOut alone decides.
// 08/03 → 08/20 is 17 days out: beyond 2, inside 21.
const NOW = new Date('2026-08-03T14:00:00Z');
const FAR = { appt_date: '08/20/2026', appt_slot: '6:00 PM' };

test('canvass window stays 2 days; event window accepts 21', () => {
  const canvass = convertCanvassAppointment(FAR, NOW, APPT_WINDOW_DAYS);
  assert.equal(canvass.status, 'beyond_window');

  const event = convertCanvassAppointment(FAR, NOW, EVENT_WINDOW_DAYS);
  assert.equal(event.status, 'ok');
  assert.equal(event.atime, '6:00 PM');
  assert.equal(event.adate, '08/20/2026');
});

test('default windowDays preserves legacy 2-day behaviour', () => {
  assert.equal(convertCanvassAppointment(FAR, NOW).status, 'beyond_window');
});

test('a non-whitelisted slot is unparseable at any window', () => {
  const r = convertCanvassAppointment(
    { appt_date: '08/20/2026', appt_slot: '10:30 AM' }, NOW, EVENT_WINDOW_DAYS,
  );
  assert.equal(r.status, 'unparseable');
  assert.equal(r.atime, null);
});

test('a past appointment is still past even on the event window', () => {
  const r = convertCanvassAppointment(
    { appt_date: '07/20/2026', appt_slot: '6:00 PM' }, NOW, EVENT_WINDOW_DAYS,
  );
  assert.equal(r.status, 'past');
});

// ─── Diagnostic ─────────────────────────────────────────────────

test('webhookShapeFingerprint records the content-type and customData shape', () => {
  const fp = webhookShapeFingerprint({
    headers: { 'content-type': 'application/json' },
    body: ghlStandardWebhookBody(),
    query: {},
  });
  assert.equal(fp.content_type, 'application/json');
  assert.equal(fp.customData_shape, `object{${Object.keys(DECLARED).length}}`);
  assert.ok(fp.customData_keys.includes('canvass_version'));
  assert.ok(fp.body_keys.includes('customData'));
});

test('webhookShapeFingerprint never throws on a malformed request', () => {
  assert.doesNotThrow(() => webhookShapeFingerprint(undefined));
  assert.doesNotThrow(() => webhookShapeFingerprint({}));
  assert.doesNotThrow(() => webhookShapeFingerprint({ body: 'not an object' }));
});
