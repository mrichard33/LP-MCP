/**
 * test-ghl-event-handoff.js — /webhook/ghl-event field resolution.
 *
 * Regression coverage for the 2026-07-31 defect: every GHL workflow handoff
 * landed as event_subtype 'unknown' with lp_lead_id null, so every rule keyed
 * on a real subtype missed and action_taken came back 'no_matching_rules'.
 *
 * Root cause: the handler read contact_id / trigger_context / lp_lead_id off
 * the payload ROOT. GHL's standard outbound Webhook step reserves the root for
 * its own contact/calendar/workflow fields plus every custom field keyed by
 * DISPLAY name ("LP Lead ID", "Appointment Date"), and nests the step's
 * declared keys under `customData`.
 *
 * The fixture below mirrors the real body stored on system_events id 2418399
 * (contact ZuBLBlXOH3i1XKkwhn59, workflow I.LP-A LP Set Appointment,
 * 2026-07-31 20:30:32 UTC), confirmed by querying the stored payload:
 *   - root had contact_id, and ~300 display-name keys
 *   - root had NO trigger_context, NO lp_lead_id, NO event_subtype
 *   - customData held all nine declared keys as a plain object
 *
 * Run: node --test scripts/test-ghl-event-handoff.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Match test-canvassing-webhook-body.js: scrub creds before the module loads
// so fail-open paths can't find an ambient client.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { resolveGhlHandoffFields, GHL_HANDOFF_SUBTYPE_MAP } =
  await import('../src/rest-api.js');

const CONTACT_ID = 'ZuBLBlXOH3i1XKkwhn59';

// The keys the I.LP-A "Send to LP MCP" step declares. In production these
// arrive nested under customData, never at the root.
const DECLARED = {
  contact_id: CONTACT_ID,
  lp_lead_id: '511364',
  contact_name: 'Mark Moreland',
  contact_email: 'mark@example.com',
  contact_phone: '+19545550100',
  calendar_name: 'Window Estimate',
  trigger_context: 'appointment_booked',
  appointment_date: '2026-08-07',
  appointment_time: '6:00 PM',
};

// What GHL actually posts: native contact keys + display-name custom fields at
// the root, the step's declared keys nested under customData. Note the root
// carries "LP Lead ID" (display name) but not lp_lead_id, and no
// trigger_context at all — that is the whole defect.
function ghlStandardWebhookBody(customData = { ...DECLARED }) {
  return {
    contact_id: CONTACT_ID,
    first_name: 'Mark',
    last_name: 'Moreland',
    full_name: 'Mark Moreland',
    email: 'mark@example.com',
    phone: '+19545550100',
    'LP Lead ID': '511364',
    'Appointment Date': '',
    'Appointment Time': '',
    'LP Market': 'FTLAU',
    calendar: { id: 'aJj14ONxh1oFyDcQ706O', title: 'Window Estimate' },
    workflow: { id: '1b3cf452-5d59-4d9e-93b3-1a51b8536431', name: 'I.LP-A LP Set Appointment' },
    location: { id: 'SsBG7j5KQAIP1SFP2Sca' },
    customData,
  };
}

// ─── The defect itself ──────────────────────────────────────────────

test('nested customData resolves trigger_context, lp_lead_id and contact_id', () => {
  const r = resolveGhlHandoffFields(ghlStandardWebhookBody());

  assert.equal(r.triggerContext, 'appointment_booked');
  assert.equal(r.lpLeadId, '511364');
  assert.equal(r.contactId, CONTACT_ID);
});

test('nested customData classifies as appt:booked at high priority', () => {
  const r = resolveGhlHandoffFields(ghlStandardWebhookBody());

  // Pre-fix this was 'unknown' / 'normal' — the exact values event 2418399 stored.
  assert.equal(r.eventSubtype, 'appt:booked');
  assert.equal(r.priority, 'high');
});

test('root-only reads are what regressed: root alone carries no trigger context', () => {
  // Sanity-check the fixture actually reproduces the production shape, so this
  // suite fails loudly if someone "fixes" it by adding root keys.
  const body = ghlStandardWebhookBody();
  assert.equal(body.trigger_context, undefined);
  assert.equal(body.lp_lead_id, undefined);
  assert.equal(body.event_subtype, undefined);
});

// ─── Explicit event_subtype (edit 2) ────────────────────────────────

test('explicit event_subtype in customData wins over the mapped trigger_context', () => {
  const r = resolveGhlHandoffFields(ghlStandardWebhookBody({
    ...DECLARED,
    trigger_context: 'appointment_booked',
    event_subtype: 'appt:booked_via_ghl',
  }));

  assert.equal(r.eventSubtype, 'appt:booked_via_ghl');
  // trigger_context still drives priority and the idempotency key.
  assert.equal(r.triggerContext, 'appointment_booked');
  assert.equal(r.priority, 'high');
});

test('event_subtype lets a caller emit a subtype with no trigger_context equivalent', () => {
  const r = resolveGhlHandoffFields({
    contact_id: CONTACT_ID,
    event_subtype: 'custom:thing_happened',
  });

  assert.equal(r.eventSubtype, 'custom:thing_happened');
  assert.equal(r.triggerContext, 'unknown');
  assert.equal(r.priority, 'normal');
});

// ─── Backward compatibility: flat callers ───────────────────────────

test('flat payloads (n8n, curl, Custom Webhook / LC Premium) still resolve', () => {
  const r = resolveGhlHandoffFields({
    contact_id: CONTACT_ID,
    lp_lead_id: '511364',
    trigger_context: 'appointment_booked',
  });

  assert.equal(r.contactId, CONTACT_ID);
  assert.equal(r.lpLeadId, '511364');
  assert.equal(r.triggerContext, 'appointment_booked');
  assert.equal(r.eventSubtype, 'appt:booked');
  assert.equal(r.priority, 'high');
});

test('camelCase flat keys still resolve', () => {
  const r = resolveGhlHandoffFields({
    contactId: CONTACT_ID,
    lpLeadId: '511364',
    triggerContext: 'disposition_changed',
  });

  assert.equal(r.contactId, CONTACT_ID);
  assert.equal(r.lpLeadId, '511364');
  assert.equal(r.eventSubtype, 'lp:disposition');
  assert.equal(r.priority, 'normal');
});

// ─── Precedence: an empty merge tag must not clobber a good root value ──

test('empty customData.contact_id does not clobber a populated root contact_id', () => {
  // contact_id is the ONE key both root and customData genuinely carry. If the
  // {{contact.id}} merge tag renders empty, a naive {...root, ...customData}
  // spread would blank it and the request would 400 out.
  const r = resolveGhlHandoffFields(ghlStandardWebhookBody({
    ...DECLARED,
    contact_id: '',
  }));

  assert.equal(r.contactId, CONTACT_ID);
  assert.equal(r.triggerContext, 'appointment_booked');
});

test('a populated customData value still fills a root key GHL left empty', () => {
  const r = resolveGhlHandoffFields({
    contact_id: '',
    lp_lead_id: '',
    customData: { contact_id: CONTACT_ID, lp_lead_id: '511364', trigger_context: 'stage_advanced' },
  });

  assert.equal(r.contactId, CONTACT_ID);
  assert.equal(r.lpLeadId, '511364');
  assert.equal(r.eventSubtype, 'pipeline:advanced');
});

// ─── The other customData shapes GHL sends ──────────────────────────

test('customData as stringified JSON resolves', () => {
  const r = resolveGhlHandoffFields({
    contact_id: CONTACT_ID,
    customData: JSON.stringify({ lp_lead_id: '511364', trigger_context: 'appointment_booked' }),
  });

  assert.equal(r.lpLeadId, '511364');
  assert.equal(r.eventSubtype, 'appt:booked');
  assert.equal(r.priority, 'high');
});

test('customData as an array of {key,value} pairs resolves', () => {
  const r = resolveGhlHandoffFields({
    contact_id: CONTACT_ID,
    customData: [
      { key: 'lp_lead_id', value: '511364' },
      { key: 'trigger_context', value: 'appointment_cancelled' },
    ],
  });

  assert.equal(r.lpLeadId, '511364');
  assert.equal(r.eventSubtype, 'appt:cancelled');
  assert.equal(r.priority, 'high');
});

// ─── Subtype map + fallbacks ────────────────────────────────────────

test('every mapped trigger_context resolves to its subtype', () => {
  for (const [context, subtype] of Object.entries(GHL_HANDOFF_SUBTYPE_MAP)) {
    const r = resolveGhlHandoffFields({ contact_id: CONTACT_ID, customData: { trigger_context: context } });
    assert.equal(r.eventSubtype, subtype, `${context} should map to ${subtype}`);
  }
});

test('an unmapped trigger_context passes through unchanged', () => {
  const r = resolveGhlHandoffFields({
    contact_id: CONTACT_ID,
    customData: { trigger_context: 'something_new' },
  });

  assert.equal(r.eventSubtype, 'something_new');
  assert.equal(r.priority, 'normal');
});

test('every appointment_* context is high priority', () => {
  for (const context of Object.keys(GHL_HANDOFF_SUBTYPE_MAP)) {
    if (!context.startsWith('appointment')) continue;
    const r = resolveGhlHandoffFields({ contact_id: CONTACT_ID, customData: { trigger_context: context } });
    assert.equal(r.priority, 'high', `${context} should be high priority`);
  }
});

test('a payload with neither contact_id nor lp_lead_id yields the values the 400 guard checks', () => {
  const r = resolveGhlHandoffFields({ customData: { trigger_context: 'tag_added' } });

  assert.equal(r.contactId, '');
  assert.equal(r.lpLeadId, null);
});

// ─── The raw body stays the audit record ────────────────────────────

test('resolution does not mutate the payload stored as the audit record', () => {
  const body = ghlStandardWebhookBody();
  const before = JSON.stringify(body);

  resolveGhlHandoffFields(body);

  assert.equal(JSON.stringify(body), before);
  // customData still nested, root still free of the declared keys — the row's
  // `payload` column keeps the verbatim body GHL sent.
  assert.equal(body.trigger_context, undefined);
  assert.equal(body.customData.trigger_context, 'appointment_booked');
});
