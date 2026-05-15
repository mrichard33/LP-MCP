/**
 * Tests — Agentic Appointment Notifications (email + SMS via GHL)
 * scripts/test-appointment-notifications.js
 *
 * Uses Node 18+ built-in test runner (`node:test`). Run with:
 *
 *   node --test scripts/test-appointment-notifications.js
 *
 * No external test framework, no DB, no network — every external
 * dependency is mocked via dependency injection
 * (runAppointmentNotification accepts a `deps` arg).
 */

// Set test dummies for env vars that gate real network calls. The
// production check in ghlPutContact() insists on GHL_API_KEY being
// set; tests inject their own fetchImpl so the key value is never
// actually sent over the wire.
process.env.GHL_API_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ENABLED_NOTIFICATION_STATUSES,
  validateRequest,
  extractRequestFields,
  runAppointmentNotification,
  writeBackToGhl,
} from '../src/notifications/appointment-notifications.js';

import {
  enforceCharCap,
  stripMarkdown,
  extractJson,
  formatApptDateTime,
  _internal as bodyInternal,
} from '../src/notifications/appointment-body-generator.js';

import { _internal as intelInternal, loadAppointmentContext } from '../src/notifications/appointment-intelligence.js';

// ───────────────────────────────────────────────────────────────────
// HELPERS
// ───────────────────────────────────────────────────────────────────

function buildPayload(overrides = {}) {
  return {
    contact_id: 'gC1',
    contact_name: 'Jane Doe',
    contact_first_name: 'Jane',
    contact_last_name: 'Doe',
    contact_phone: '(555) 111-2222',
    contact_email: '',
    status: 'cancelled',
    calendar_id: 'aJj14ONxh1oFyDcQ706O',
    appointment_title: 'Window Estimate',
    start_time: '10:00 AM',
    start_date: '2026-05-20',
    previous_start_time: '',
    previous_start_date: '',
    lp_source: 'facebook_ad',
    lp_subsource: 'windows_florida_jan',
    assigned_user: 'Alex Rep',
    city: 'Boca Raton',
    postal_code: '33432',
    lifecycle_stage: 'warm',
    trust_state: 'building',
    ...overrides,
  };
}

function buildContext(overrides = {}) {
  return {
    decoded_contact: {
      profile: {
        id: 'gC1',
        name: 'Jane Doe',
        first_name: 'Jane',
        last_name: 'Doe',
        phone: '(555) 111-2222',
        city: 'Boca Raton',
        tags: ['stage:warm'],
        assigned_to: 'user-1',
      },
      custom_fields: {},
    },
    lead_summary: {
      lead: {
        lp_lead_id: 'L100',
        disposition_label: 'Appointment Set',
        disposition_code: 'APT',
        rep_name: 'Alex Rep',
        job_value: null,
        closed_won: false,
      },
      recent: { calls: [], notes: [], activities: [] },
    },
    timeline: [
      { ts: '2026-05-14T10:00:00Z', type: 'call', summary: 'Call: Connected (60s)' },
    ],
    source_analytics: {
      matched_on: 'subsource',
      source: 'facebook_ad',
      subsource: 'windows_florida_jan',
      total_leads: 100,
      closed_won: 18,
      close_rate_pct: 18,
      total_revenue: 540000,
    },
    data_gaps: [],
    ...overrides,
  };
}

// Stand-in for the generator that returns realistic-shape output —
// uses the payload's appointment_title verbatim so pass-through tests
// can assert on it.
function mockGenerateBody(opts = {}) {
  return async ({ payload, context }) => {
    const emoji = payload.status === 'rescheduled' ? '🔄' : '❌';
    const verb = payload.status === 'rescheduled' ? 'RESCHEDULED' : 'CANCELLED';
    const email =
      opts.email ??
      `${emoji} ${payload.appointment_title} ${verb} — ${payload.contact_first_name} ${payload.contact_last_name}\n\n` +
        `Phone: ${payload.contact_phone}\nCity: ${payload.city}\n\nWas: ${payload.start_date} at ${payload.start_time}\n\n` +
        `Source: ${payload.lp_source} → ${payload.lp_subsource}\n\nRep: ${payload.assigned_user}\nNext: rebook within 48h`;
    const sms =
      opts.sms ??
      `${emoji} APPT ${verb}: ${payload.contact_first_name} ${payload.contact_last_name} (${payload.contact_phone}) — ${payload.appointment_title}.`;
    return {
      email_body: email,
      sms_body: sms,
      model: 'claude-sonnet-4-5-mock',
      request_id: 'mock',
      latency_ms: 1,
    };
  };
}

// ───────────────────────────────────────────────────────────────────
// VALIDATION
// ───────────────────────────────────────────────────────────────────

test('validateRequest accepts a minimal valid cancelled payload', () => {
  const { valid, errors } = validateRequest(buildPayload());
  assert.equal(valid, true, `expected valid, got errors: ${JSON.stringify(errors)}`);
});

test('validateRequest rejects status outside whitelist', () => {
  const { valid, errors } = validateRequest(buildPayload({ status: 'booked' }));
  assert.equal(valid, false);
  assert.ok(
    errors.some(e => /must be one of/.test(e)),
    `expected whitelist error, got: ${JSON.stringify(errors)}`,
  );
});

test('validateRequest rejects unknown statuses (defense in depth on whitelist)', () => {
  for (const bad of ['no_show', 'completed', 'confirmed', '']) {
    const { valid } = validateRequest(buildPayload({ status: bad }));
    assert.equal(valid, false, `expected invalid for status='${bad}'`);
  }
});

test('validateRequest requires previous_start_* when status=rescheduled', () => {
  const { valid, errors } = validateRequest(buildPayload({ status: 'rescheduled' }));
  assert.equal(valid, false);
  assert.ok(errors.some(e => /previous_start_time/.test(e)));
  assert.ok(errors.some(e => /previous_start_date/.test(e)));
});

test('validateRequest accepts rescheduled when previous_start_* present', () => {
  const { valid, errors } = validateRequest(
    buildPayload({
      status: 'rescheduled',
      previous_start_date: '2026-05-15',
      previous_start_time: '9:00 AM',
    }),
  );
  assert.equal(valid, true, `expected valid, errors: ${JSON.stringify(errors)}`);
});

test('validateRequest accepts empty lp_source / lp_subsource (per contract)', () => {
  const { valid } = validateRequest(buildPayload({ lp_source: '', lp_subsource: '' }));
  assert.equal(valid, true);
});

test('validateRequest rejects missing contact_id', () => {
  const payload = buildPayload();
  delete payload.contact_id;
  const { valid, errors } = validateRequest(payload);
  assert.equal(valid, false);
  assert.ok(errors.some(e => /contact_id/.test(e)));
});

test('ENABLED_NOTIFICATION_STATUSES is the single source of truth — adding a status accepts it', () => {
  // Production validator uses ENABLED_NOTIFICATION_STATUSES by default.
  // Pass an extended array to prove the whitelist is the only gate.
  // Adding 'booked' here demonstrates that a one-line append to the
  // module constant is sufficient to enable the new status in
  // production code — no other validation logic touches the status.
  assert.deepEqual(ENABLED_NOTIFICATION_STATUSES, ['cancelled', 'rescheduled']);

  // Without extension: 'booked' is rejected.
  const a = validateRequest(buildPayload({ status: 'booked' }));
  assert.equal(a.valid, false);

  // With extension: 'booked' is accepted.
  const b = validateRequest(buildPayload({ status: 'booked' }), [
    ...ENABLED_NOTIFICATION_STATUSES,
    'booked',
  ]);
  assert.equal(b.valid, true, `expected booked to validate with extended list, got: ${JSON.stringify(b.errors)}`);
});

// ───────────────────────────────────────────────────────────────────
// REQUEST EXTRACTION
// ───────────────────────────────────────────────────────────────────

test('extractRequestFields merges customData (object) over body keys', () => {
  const merged = extractRequestFields({
    contact_id: 'A',
    customData: { contact_id: 'B', status: 'cancelled' },
  });
  assert.equal(merged.contact_id, 'B');
  assert.equal(merged.status, 'cancelled');
});

test('extractRequestFields parses customData as JSON string', () => {
  const merged = extractRequestFields({
    customData: JSON.stringify({ contact_id: 'C', status: 'rescheduled' }),
  });
  assert.equal(merged.contact_id, 'C');
  assert.equal(merged.status, 'rescheduled');
});

test('extractRequestFields handles customData as array of {key,value} pairs', () => {
  const merged = extractRequestFields({
    customData: [
      { key: 'contact_id', value: 'D' },
      { key: 'status', value: 'cancelled' },
    ],
  });
  assert.equal(merged.contact_id, 'D');
  assert.equal(merged.status, 'cancelled');
});

// ───────────────────────────────────────────────────────────────────
// BODY GENERATOR — caps + markdown + JSON extraction
// ───────────────────────────────────────────────────────────────────

test('enforceCharCap keeps text under cap as-is', () => {
  const text = 'hello world';
  assert.equal(enforceCharCap(text, 50), text);
});

test('enforceCharCap truncates with ellipsis when over cap (SMS scenario)', () => {
  const text = 'x'.repeat(500);
  const out = enforceCharCap(text, 300);
  assert.equal(out.length, 300);
  assert.equal(out.endsWith('…'), true);
  // 299 x's + 1 ellipsis = 300 chars
  assert.equal(out.slice(0, 299), 'x'.repeat(299));
});

test('enforceCharCap truncates email scenario at 1500', () => {
  const text = 'a'.repeat(2000);
  const out = enforceCharCap(text, 1500);
  assert.equal(out.length, 1500);
  assert.equal(out.endsWith('…'), true);
});

test('stripMarkdown removes bold, italic, code spans, fenced blocks', () => {
  assert.equal(stripMarkdown('hello **world**'), 'hello world');
  assert.equal(stripMarkdown('a _b_ c'), 'a b c');
  assert.equal(stripMarkdown('`code` here'), 'code here');
  assert.equal(stripMarkdown('text\n```js\nx\n```\nmore'), 'text\n\nmore');
});

test('extractJson handles raw JSON', () => {
  const out = extractJson('{"email_body":"e","sms_body":"s"}');
  assert.equal(out.email_body, 'e');
  assert.equal(out.sms_body, 's');
});

test('extractJson handles ```json-fenced JSON', () => {
  const out = extractJson('```json\n{"email_body":"e","sms_body":"s"}\n```');
  assert.equal(out.email_body, 'e');
  assert.equal(out.sms_body, 's');
});

test('extractJson handles preamble + json', () => {
  const out = extractJson('Here is the JSON:\n{"email_body":"e","sms_body":"s"}\nThanks.');
  assert.equal(out.email_body, 'e');
  assert.equal(out.sms_body, 's');
});

test('extractJson throws on non-json input', () => {
  assert.throws(() => extractJson('no json here'), /non_json_response/);
});

test('body generator caps: email cap is 1500, sms cap is 300 (from env-default constants)', () => {
  assert.equal(bodyInternal.EMAIL_CHAR_CAP, 1500);
  assert.equal(bodyInternal.SMS_CHAR_CAP, 300);
});

// ───────────────────────────────────────────────────────────────────
// PAYLOAD PASS-THROUGH — appointment_title must NOT be hardcoded
// ───────────────────────────────────────────────────────────────────

test('appointment_title pass-through: both bodies contain payload title, not "Window Estimate"', async () => {
  let receivedPayload;

  const result = await runAppointmentNotification(
    buildPayload({ appointment_title: 'Roof Estimate' }),
    {
      loadContext: async () => buildContext(),
      generateBody: async ({ payload }) => {
        receivedPayload = payload;
        return {
          email_body: `❌ ${payload.appointment_title} CANCELLED — ${payload.contact_first_name} ${payload.contact_last_name}\n\nDetails...`,
          sms_body: `❌ APPT CANCELLED: ${payload.contact_first_name} ${payload.contact_last_name} — ${payload.appointment_title}.`,
          model: 'mock',
          request_id: 'r',
          latency_ms: 1,
        };
      },
      writeGhl: async () => {},
      audit: async () => {},
      fieldIds: { body: 'B', sms: 'S', id: 'I', ready: 'R' },
    },
  );

  assert.equal(result.ok, true);
  // Both bodies contain the payload title.
  assert.ok(
    result.email_body.includes('Roof Estimate'),
    `email_body missing 'Roof Estimate': ${result.email_body}`,
  );
  assert.ok(
    result.sms_body.includes('Roof Estimate'),
    `sms_body missing 'Roof Estimate': ${result.sms_body}`,
  );
  // Neither body contains the default 'Window Estimate'.
  assert.ok(
    !result.email_body.includes('Window Estimate'),
    `email_body unexpectedly contains 'Window Estimate': ${result.email_body}`,
  );
  assert.ok(
    !result.sms_body.includes('Window Estimate'),
    `sms_body unexpectedly contains 'Window Estimate': ${result.sms_body}`,
  );
  assert.equal(receivedPayload.appointment_title, 'Roof Estimate');
});

test('body generator with empty lp_source / lp_subsource gets source_analytics=null + data_gap flag', async () => {
  let capturedContext = null;
  await runAppointmentNotification(
    buildPayload({ lp_source: '', lp_subsource: '' }),
    {
      loadContext: async () =>
        buildContext({
          source_analytics: null,
          data_gaps: ['source_intel_unavailable:empty_lp_source'],
        }),
      generateBody: async ({ context }) => {
        capturedContext = context;
        return { email_body: 'e', sms_body: 's', model: 'mock', request_id: 'r', latency_ms: 1 };
      },
      writeGhl: async () => {},
      audit: async () => {},
      fieldIds: { body: 'B', sms: 'S', id: 'I', ready: 'R' },
    },
  );

  assert.equal(capturedContext.source_analytics, null);
  assert.ok(
    capturedContext.data_gaps.some(g => g.startsWith('source_intel_unavailable')),
    `expected source_intel_unavailable in data_gaps: ${JSON.stringify(capturedContext.data_gaps)}`,
  );
});

// ───────────────────────────────────────────────────────────────────
// CONTEXT LOADER — partial failure handling
// ───────────────────────────────────────────────────────────────────

test('orchestrator continues when context loader reports data_gaps', async () => {
  const calls = [];
  const ctxWithGaps = buildContext({
    decoded_contact: null,
    data_gaps: ['decoded_contact:contact_not_found_or_fetch_failed'],
  });

  const result = await runAppointmentNotification(buildPayload(), {
    loadContext: async () => {
      calls.push('loadContext');
      return ctxWithGaps;
    },
    generateBody: mockGenerateBody(),
    writeGhl: async () => {
      calls.push('writeGhl');
    },
    audit: async () => {
      calls.push('audit');
    },
    fieldIds: { body: 'B', sms: 'S', id: 'I', ready: 'R' },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data_gaps, ['decoded_contact:contact_not_found_or_fetch_failed']);
  assert.deepEqual(calls, ['loadContext', 'writeGhl', 'audit']);
});

// ───────────────────────────────────────────────────────────────────
// GHL WRITEBACK — strict order, 3-field + 1-field shape
// ───────────────────────────────────────────────────────────────────

test('GHL writeback order: body+sms+id together, then ready', async () => {
  const calls = [];
  const mockFetch = async (url, opts) => {
    const parsed = JSON.parse(opts.body);
    calls.push({
      method: opts.method,
      fields: parsed.customFields.map(f => f.id),
      values: parsed.customFields.map(f => f.field_value),
    });
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  await writeBackToGhl({
    contactId: 'gC1',
    emailBody: 'email content',
    smsBody: 'sms content',
    notificationId: 'nid-1',
    fieldIds: { body: 'BODY_ID', sms: 'SMS_ID', id: 'ID_ID', ready: 'READY_ID' },
    fetchImpl: mockFetch,
  });

  assert.equal(calls.length, 2, `expected 2 GHL PUTs, got ${calls.length}`);
  // Build the call-1 field→value map BEFORE sorting (Array.sort
  // mutates, which would scramble the value-array alignment).
  const call1Map = {};
  for (let i = 0; i < calls[0].fields.length; i++) {
    call1Map[calls[0].fields[i]] = calls[0].values[i];
  }
  // Verify the email body landed on body, SMS body on sms, id on id.
  assert.equal(call1Map['BODY_ID'], 'email content');
  assert.equal(call1Map['SMS_ID'], 'sms content');
  assert.equal(call1Map['ID_ID'], 'nid-1');
  // Call 1: body + sms + id together (order within array doesn't
  // matter for the strict-order contract — only that all three land
  // before ready). Use a copy for the set check so we don't mutate
  // the captured array.
  assert.deepEqual([...calls[0].fields].sort(), ['BODY_ID', 'ID_ID', 'SMS_ID']);
  // Call 2: ready alone, LAST, set to "Yes".
  assert.deepEqual(calls[1].fields, ['READY_ID']);
  assert.deepEqual(calls[1].values, ['Yes']);
});

test('GHL writeback throws + ready never written if body+sms+id call fails', async () => {
  const calls = [];
  const mockFetch = async (url, opts) => {
    calls.push({ fields: JSON.parse(opts.body).customFields.map(f => f.id) });
    if (calls.length === 1) {
      return new Response('GHL down', { status: 500 });
    }
    return new Response('{}', { status: 200 });
  };

  await assert.rejects(
    () =>
      writeBackToGhl({
        contactId: 'gC1',
        emailBody: 'e',
        smsBody: 's',
        notificationId: 'nid-1',
        fieldIds: { body: 'B', sms: 'S', id: 'I', ready: 'R' },
        fetchImpl: mockFetch,
      }),
    /ghl_500/,
  );
  // Only the first call (body+sms+id) was attempted; ready never reached.
  assert.equal(calls.length, 1);
  assert.ok(!calls.some(c => c.fields.includes('R')));
});

test('writeBackToGhl throws if any of the 4 field IDs is unconfigured', async () => {
  for (const missing of ['body', 'sms', 'id', 'ready']) {
    const fieldIds = { body: 'B', sms: 'S', id: 'I', ready: 'R' };
    fieldIds[missing] = '';
    await assert.rejects(
      () =>
        writeBackToGhl({
          contactId: 'gC1',
          emailBody: 'e',
          smsBody: 's',
          notificationId: 'nid-1',
          fieldIds,
          fetchImpl: async () => new Response('{}', { status: 200 }),
        }),
      /ghl_field_ids_not_configured/,
      `expected throw when '${missing}' field id is empty`,
    );
  }
});

test('orchestrator does NOT flip ready when body+sms+id GHL call fails', async () => {
  const ghlCalls = [];
  const mockGhlFetch = async (url, opts) => {
    const fields = JSON.parse(opts.body).customFields.map(f => f.id);
    ghlCalls.push(fields);
    if (ghlCalls.length === 1) {
      return new Response('boom', { status: 500 });
    }
    return new Response('{}', { status: 200 });
  };

  const result = await runAppointmentNotification(buildPayload(), {
    loadContext: async () => buildContext(),
    generateBody: mockGenerateBody(),
    audit: async () => {},
    fieldIds: { body: 'BODY_ID', sms: 'SMS_ID', id: 'ID_ID', ready: 'READY_ID' },
    fetchImpl: mockGhlFetch,
  });

  assert.equal(result.ok, false);
  assert.equal(result.http_status, 502);
  assert.ok(/ghl_writeback_failed/.test(result.error));
  // Only call-1 happened; ready never written.
  assert.equal(ghlCalls.length, 1);
  assert.ok(!ghlCalls.some(c => c.includes('READY_ID')));
});

// ───────────────────────────────────────────────────────────────────
// FULL HAPPY PATH
// ───────────────────────────────────────────────────────────────────

test('full happy path: bodies written, ready flipped, audit clean', async () => {
  const events = [];
  const ghlCalls = [];
  const mockGhlFetch = async (url, opts) => {
    ghlCalls.push(JSON.parse(opts.body).customFields.map(f => f.id));
    return new Response('{}', { status: 200 });
  };

  const result = await runAppointmentNotification(buildPayload(), {
    loadContext: async () => {
      events.push('context');
      return buildContext();
    },
    generateBody: async () => {
      events.push('generate');
      return {
        email_body: '❌ Window Estimate CANCELLED — Jane Doe\n\nPhone: (555) 111-2222',
        sms_body: '❌ APPT CANCELLED: Jane Doe — Window Estimate.',
        model: 'claude-sonnet-4-5',
        request_id: 'r',
        latency_ms: 30,
      };
    },
    audit: async row => {
      events.push(`audit:err=${row.error}`);
      assert.ok(row.notification_id);
      assert.equal(row.error, null);
      assert.ok(row.ghl_writeback_at);
      assert.equal(row.model_used, 'claude-sonnet-4-5');
      assert.ok(row.email_body.startsWith('❌ Window Estimate CANCELLED'));
      assert.ok(row.sms_body.startsWith('❌ APPT CANCELLED'));
    },
    fieldIds: { body: 'B', sms: 'S', id: 'I', ready: 'R' },
    fetchImpl: mockGhlFetch,
  });

  assert.equal(result.ok, true);
  assert.equal(result.http_status, 200);
  assert.equal(result.ghl_writeback_success, true);
  assert.ok(result.notification_id);
  assert.ok(result.email_body);
  assert.ok(result.sms_body);
  // Verify ordering of side-effects.
  assert.deepEqual(events, ['context', 'generate', 'audit:err=null']);
  // Verify GHL call order: body+sms+id first, ready second.
  assert.equal(ghlCalls.length, 2);
  assert.deepEqual([...ghlCalls[0]].sort(), ['B', 'I', 'S']);
  assert.deepEqual(ghlCalls[1], ['R']);
});

// ───────────────────────────────────────────────────────────────────
// AUDIT ROW SHAPE ON FAILURE
// ───────────────────────────────────────────────────────────────────

test('audit row on body-generation failure: bodies null, ghl_writeback_at null, error tagged', async () => {
  let auditRow = null;

  const result = await runAppointmentNotification(buildPayload(), {
    loadContext: async () => buildContext(),
    generateBody: async () => {
      throw new Error('anthropic_500:internal');
    },
    writeGhl: async () => {
      throw new Error('should_not_reach');
    },
    audit: async row => {
      auditRow = row;
    },
    fieldIds: { body: 'B', sms: 'S', id: 'I', ready: 'R' },
  });

  assert.equal(result.ok, false);
  assert.equal(result.http_status, 502);
  assert.ok(/body_generation_failed/.test(result.error));
  assert.ok(auditRow);
  assert.equal(auditRow.email_body, null);
  assert.equal(auditRow.sms_body, null);
  assert.equal(auditRow.ghl_writeback_at, null);
  assert.ok(/body_generation_failed/.test(auditRow.error));
});

// ───────────────────────────────────────────────────────────────────
// DATE / TIME FORMATTER
// ───────────────────────────────────────────────────────────────────

const FORMATTER_CASES = [
  ['2026-05-16', '6:00 PM', '05-16-2026 at 6:00 PM'],
  ['2026-05-16', '18:00', '05-16-2026 at 6:00 PM'],
  ['2026-05-16', '06:00:00', '05-16-2026 at 6:00 AM'],
  ['5/16/2026', '6:00 PM', '05-16-2026 at 6:00 PM'],
  ['2026-05-16', '', '05-16-2026'],
  ['', '6:00 PM', '6:00 PM'],
  ['', '', ''],
  ['not-a-date', 'not-a-time', ''],
];

for (const [d, t, expected] of FORMATTER_CASES) {
  test(`formatApptDateTime: date='${d}' time='${t}' -> '${expected}'`, () => {
    assert.equal(formatApptDateTime(d, t), expected);
  });
}

// ───────────────────────────────────────────────────────────────────
// buildUserPrompt — dispatch-context labeled facts
// ───────────────────────────────────────────────────────────────────

function dispatchPayload(overrides = {}) {
  return {
    status: 'cancelled',
    appointment_title: 'Window Estimate',
    calendar_id: 'aJj14ONxh1oFyDcQ706O',
    contact_id: 'y4dvOxt',
    contact_first_name: 'Mark',
    contact_last_name: 'Richard',
    contact_phone: '(954) 508-1512',
    contact_email: 'mfollen@icloud.com',
    city: 'Delray Beach',
    postal_code: '33484',
    assigned_user: '',
    start_date: '2026-05-16',
    start_time: '6:00 PM',
    lp_source: '',
    lp_subsource: '',
    ...overrides,
  };
}

test('buildUserPrompt: formats timing via formatApptDateTime', () => {
  const ctx = {
    decoded_contact: { profile: { tags: [] }, custom_fields: {} },
    lead_summary: { lead: { lp_prospect_id: '427375' }, recent: { calls: [], notes: [], activities: [] } },
    timeline: [],
    effective_source: 'Estimate Calculator',
    effective_subsource: 'Estimate Calculator',
    data_gaps: [],
  };
  const out = bodyInternal.buildUserPrompt({ payload: dispatchPayload(), context: ctx });
  assert.match(out, /was:\s*05-16-2026 at 6:00 PM/);
});

test('buildUserPrompt: reads prospect_id from resolved_prospect_id when present', () => {
  const ctx = {
    decoded_contact: { profile: { tags: [] }, custom_fields: {} },
    lead_summary: { lead: { lp_prospect_id: null }, recent: { calls: [], notes: [], activities: [] } },
    timeline: [],
    resolved_prospect_id: '427375',
    effective_source: '',
    effective_subsource: '',
    data_gaps: [],
  };
  const out = bodyInternal.buildUserPrompt({ payload: dispatchPayload(), context: ctx });
  assert.match(out, /prospect_id:\s*427375/);
});

test('buildUserPrompt: uses GHL ID label (not Contact) in the labeled-facts block', () => {
  const ctx = {
    decoded_contact: { profile: { tags: [] }, custom_fields: {} },
    lead_summary: { lead: { lp_prospect_id: null }, recent: { calls: [], notes: [], activities: [] } },
    timeline: [],
    effective_source: '',
    effective_subsource: '',
    resolved_prospect_id: null,
    data_gaps: [],
  };
  const out = bodyInternal.buildUserPrompt({ payload: dispatchPayload(), context: ctx });
  // The user prompt still exposes contact_id verbatim; the GHL ID label is
  // applied by the SYSTEM_PROMPT when rendering. Sanity-check both.
  assert.match(out, /contact_id:\s*y4dvOxt/);
  assert.match(out, /prospect_id:\s*\(unknown\)/);
});

test('buildUserPrompt: substitutes "(unknown)" when resolved_prospect_id is null', () => {
  const ctx = {
    decoded_contact: { profile: { tags: [] }, custom_fields: {} },
    lead_summary: { lead: { lp_prospect_id: null }, recent: { calls: [], notes: [], activities: [] } },
    timeline: [],
    effective_source: '',
    effective_subsource: '',
    data_gaps: [],
  };
  const out = bodyInternal.buildUserPrompt({ payload: dispatchPayload(), context: ctx });
  assert.match(out, /prospect_id:\s*\(unknown\)/);
});

test('SYSTEM_PROMPT uses "GHL ID" label, never "Contact {id}"', () => {
  const sys = bodyInternal.SYSTEM_PROMPT;
  assert.match(sys, /GHL ID \{contact_id\}/);
  // The literal "Contact {contact_id}" rendering must not appear anywhere
  // in the system prompt (the old label was the source of "Contact <id>"
  // strings in rendered bodies).
  assert.ok(
    !/Contact \{contact_id\}/.test(sys),
    'SYSTEM_PROMPT still references "Contact {contact_id}" — should be "GHL ID {contact_id}"',
  );
  assert.ok(
    !/Contact y4dvOxtWW12xGrBavCUt/.test(sys),
    'SYSTEM_PROMPT example still renders "Contact y4dvOxt..." — should be "GHL ID y4dvOxt..."',
  );
});

test('buildUserPrompt: surfaces chat_transcript_tail, concern tags, pain_point', () => {
  const ctx = {
    decoded_contact: {
      profile: { tags: ['concern-expressed:timing'] },
      custom_fields: {
        chatbot: [{ name: 'Chat Transcript', value: "A long transcript ending with: don't have the money for windows right now" }],
        ai: [{ name: 'Pain Point', value: 'Clarity' }],
      },
    },
    lead_summary: { lead: { lp_prospect_id: '427375' }, recent: { calls: [], notes: [], activities: [] } },
    timeline: [],
    effective_source: 'Estimate Calculator',
    effective_subsource: 'Estimate Calculator',
    data_gaps: [],
  };
  const out = bodyInternal.buildUserPrompt({ payload: dispatchPayload(), context: ctx });
  assert.match(out, /chat_transcript_tail:.*money for windows right now/);
  assert.match(out, /concern_signals:.*concern-expressed:timing/);
  assert.match(out, /pain_point:\s*Clarity/);
});

test('buildUserPrompt: counts prior_cancellations and prior_reschedules from timeline + tags', () => {
  const ctx = {
    decoded_contact: { profile: { tags: ['appt-cancelled'] }, custom_fields: {} },
    lead_summary: { lead: { lp_prospect_id: '427375', appointment_set: 2 }, recent: { calls: [], notes: [], activities: [] } },
    timeline: [
      { ts: '2026-05-14', type: 'event:appointment_rescheduled', summary: 'Appointment moved' },
      { ts: '2026-05-13', type: 'event:appointment_cancelled', summary: 'Cancelled' },
    ],
    effective_source: '',
    effective_subsource: '',
    data_gaps: [],
  };
  const out = bodyInternal.buildUserPrompt({ payload: dispatchPayload(), context: ctx });
  assert.match(out, /prior_cancellations:\s*[12]/);
  assert.match(out, /prior_reschedules:\s*1/);
});

test('buildUserPrompt: rescheduled payload emits both was: and new: formatted lines', () => {
  const ctx = {
    decoded_contact: { profile: { tags: [] }, custom_fields: {} },
    lead_summary: { lead: { lp_prospect_id: '427375' }, recent: { calls: [], notes: [], activities: [] } },
    timeline: [],
    effective_source: '',
    effective_subsource: '',
    data_gaps: [],
  };
  const out = bodyInternal.buildUserPrompt({
    payload: dispatchPayload({
      status: 'rescheduled',
      start_date: '2026-05-18',
      start_time: '6:00 PM',
      previous_start_date: '2026-05-15',
      previous_start_time: '10:00 AM',
    }),
    context: ctx,
  });
  assert.match(out, /was:\s*05-15-2026 at 10:00 AM/);
  assert.match(out, /new:\s*05-18-2026 at 6:00 PM/);
});

// ───────────────────────────────────────────────────────────────────
// LP SOURCE FALLBACK — loadAppointmentContext effective_source resolution
// ───────────────────────────────────────────────────────────────────

test('loadAppointmentContext: falls back to LP lead_source when payload source is empty', async () => {
  const ctx = await loadAppointmentContext({
    contact_id: 'gC1',
    lp_source: '',
    lp_subsource: '',
    _deps: {
      loadDecodedContact: async () => ({
        profile: { id: 'gC1', name: 'Test', tags: [] },
        custom_fields: {},
      }),
      loadLeadSummary: async () => ({
        lead: {
          lp_lead_id: 'L1',
          lp_prospect_id: '123',
          lead_source: 'Canvass',
          lead_source_detail: 'Door-to-Door',
        },
        recent: { calls: [], notes: [], activities: [] },
      }),
      loadContactTimeline: async () => [],
      loadSourceAnalytics: async (src, sub) => ({
        matched_on: 'source',
        source: src,
        subsource: sub,
        total_leads: 10,
        closed_won: 2,
        close_rate_pct: 20,
        total_revenue: 30000,
      }),
    },
  });

  assert.equal(ctx.effective_source, 'Canvass');
  assert.equal(ctx.effective_subsource, 'Door-to-Door');
  assert.ok(
    ctx.data_gaps.includes('source_resolved_from:lp_fallback'),
    `expected source_resolved_from:lp_fallback in data_gaps: ${JSON.stringify(ctx.data_gaps)}`,
  );
  // Retry populated source_analytics using the LP-resolved source.
  assert.ok(ctx.source_analytics);
  assert.equal(ctx.source_analytics.source, 'Canvass');
});

test('loadAppointmentContext: keeps payload source when present, no fallback', async () => {
  const ctx = await loadAppointmentContext({
    contact_id: 'gC1',
    lp_source: 'facebook_ad',
    lp_subsource: 'windows_jan',
    _deps: {
      loadDecodedContact: async () => ({ profile: { id: 'gC1', tags: [] }, custom_fields: {} }),
      loadLeadSummary: async () => ({
        lead: { lp_lead_id: 'L1', lead_source: 'Canvass', lead_source_detail: 'Door-to-Door' },
        recent: { calls: [], notes: [], activities: [] },
      }),
      loadContactTimeline: async () => [],
      loadSourceAnalytics: async () => null,
    },
  });

  assert.equal(ctx.effective_source, 'facebook_ad');
  assert.equal(ctx.effective_subsource, 'windows_jan');
  assert.ok(!ctx.data_gaps.includes('source_resolved_from:lp_fallback'));
});

test('loadAppointmentContext: no fallback when LP lead_source also empty', async () => {
  const ctx = await loadAppointmentContext({
    contact_id: 'gC1',
    lp_source: '',
    lp_subsource: '',
    _deps: {
      loadDecodedContact: async () => ({ profile: { id: 'gC1', tags: [] }, custom_fields: {} }),
      loadLeadSummary: async () => ({
        lead: { lp_lead_id: 'L1', lead_source: '', lead_source_detail: '' },
        recent: { calls: [], notes: [], activities: [] },
      }),
      loadContactTimeline: async () => [],
      loadSourceAnalytics: async () => null,
    },
  });

  assert.equal(ctx.effective_source, null);
  assert.equal(ctx.effective_subsource, null);
  assert.ok(!ctx.data_gaps.includes('source_resolved_from:lp_fallback'));
});

// ───────────────────────────────────────────────────────────────────
// PROSPECT ID — 3-tier resolution chain
// ───────────────────────────────────────────────────────────────────

test('Tier 1: resolves prospect_id from lp_leads when present', async () => {
  let phoneLookupCalls = 0;
  const ctx = await loadAppointmentContext({
    contact_id: 'gC1',
    contact_phone: '(954) 508-1512',
    lp_source: '',
    lp_subsource: '',
    _deps: {
      loadDecodedContact: async () => ({ profile: { id: 'gC1', tags: [] }, custom_fields: {} }),
      loadLeadSummary: async () => ({
        lead: { lp_lead_id: 'L1', lp_prospect_id: '111222' },
        recent: { calls: [], notes: [], activities: [] },
      }),
      loadContactTimeline: async () => [],
      loadSourceAnalytics: async () => null,
      lookupProspectByPhone: async () => {
        phoneLookupCalls++;
        return '999999';
      },
    },
  });

  assert.equal(ctx.resolved_prospect_id, '111222');
  assert.equal(phoneLookupCalls, 0, 'Tier 3 must not run when Tier 1 resolves');
  assert.ok(!ctx.data_gaps.some(g => /prospect_resolved_from/.test(g)));
});

test('Tier 2: resolves prospect_id from decoded_contact custom field when lp_leads empty', async () => {
  let phoneLookupCalls = 0;
  const ctx = await loadAppointmentContext({
    contact_id: 'gC1',
    contact_phone: '(954) 508-1512',
    lp_source: '',
    lp_subsource: '',
    _deps: {
      loadDecodedContact: async () => ({
        profile: { id: 'gC1', tags: [] },
        custom_fields: {
          identity: [
            { name: 'LP Prospect ID', value: '427375', id: 'ZRQAVrzhtzApzLlHmT87' },
          ],
        },
      }),
      loadLeadSummary: async () => ({
        lead: { lp_lead_id: 'L1', lp_prospect_id: null },
        recent: { calls: [], notes: [], activities: [] },
      }),
      loadContactTimeline: async () => [],
      loadSourceAnalytics: async () => null,
      lookupProspectByPhone: async () => {
        phoneLookupCalls++;
        return '999999';
      },
    },
  });

  assert.equal(ctx.resolved_prospect_id, '427375');
  assert.equal(phoneLookupCalls, 0, 'Tier 3 must not run when Tier 2 resolves');
  assert.ok(
    !ctx.data_gaps.includes('prospect_resolved_from:lp_api_lookup'),
    `Tier 2 hit should NOT add lp_api_lookup data gap: ${JSON.stringify(ctx.data_gaps)}`,
  );
});

test('Tier 2: finds LP Prospect ID by field id even under non-identity category', async () => {
  const ctx = await loadAppointmentContext({
    contact_id: 'gC1',
    contact_phone: '',
    lp_source: '',
    lp_subsource: '',
    _deps: {
      loadDecodedContact: async () => ({
        profile: { id: 'gC1', tags: [] },
        custom_fields: {
          // Field showed up under an unexpected category — should still resolve.
          unknown: [
            { name: 'Mystery', value: 'xx', id: 'someOtherId' },
            { name: 'LP Prospect ID', value: '555', id: 'ZRQAVrzhtzApzLlHmT87' },
          ],
        },
      }),
      loadLeadSummary: async () => ({
        lead: { lp_lead_id: 'L1', lp_prospect_id: null },
        recent: { calls: [], notes: [], activities: [] },
      }),
      loadContactTimeline: async () => [],
      loadSourceAnalytics: async () => null,
      lookupProspectByPhone: async () => null,
    },
  });

  assert.equal(ctx.resolved_prospect_id, '555');
});

test('Tier 3: falls through to LP API search by phone when lead_summary AND decoded_contact miss', async () => {
  const ctx = await loadAppointmentContext({
    contact_id: 'gC1',
    contact_phone: '(954) 508-1512',
    lp_source: '',
    lp_subsource: '',
    _deps: {
      loadDecodedContact: async () => ({
        profile: { id: 'gC1', tags: [] },
        custom_fields: { identity: [{ name: 'Something Else', value: 'x', id: 'aaa' }] },
      }),
      loadLeadSummary: async () => ({
        lead: { lp_lead_id: 'L1', lp_prospect_id: null },
        recent: { calls: [], notes: [], activities: [] },
      }),
      loadContactTimeline: async () => [],
      loadSourceAnalytics: async () => null,
      lookupProspectByPhone: async phone => {
        assert.equal(phone, '(954) 508-1512');
        return '999888';
      },
    },
  });

  assert.equal(ctx.resolved_prospect_id, '999888');
  assert.ok(
    ctx.data_gaps.includes('prospect_resolved_from:lp_api_lookup'),
    `Tier 3 hit must record lp_api_lookup data gap: ${JSON.stringify(ctx.data_gaps)}`,
  );
});

test('Tier 3 fallthrough: leaves prospect unknown when LP API returns no match', async () => {
  const ctx = await loadAppointmentContext({
    contact_id: 'gC1',
    contact_phone: '(954) 508-1512',
    lp_source: '',
    lp_subsource: '',
    _deps: {
      loadDecodedContact: async () => ({
        profile: { id: 'gC1', tags: [] },
        custom_fields: {},
      }),
      loadLeadSummary: async () => ({
        lead: { lp_lead_id: 'L1', lp_prospect_id: null },
        recent: { calls: [], notes: [], activities: [] },
      }),
      loadContactTimeline: async () => [],
      loadSourceAnalytics: async () => null,
      lookupProspectByPhone: async () => null,
    },
  });

  assert.equal(ctx.resolved_prospect_id, null);
  assert.ok(
    !ctx.data_gaps.some(g => /prospect_resolved_from/.test(g)),
    `No-match Tier 3 must NOT record a prospect_resolved_from gap: ${JSON.stringify(ctx.data_gaps)}`,
  );
});

test('Tier 3: silent fallthrough when LP API throws', async () => {
  const ctx = await loadAppointmentContext({
    contact_id: 'gC1',
    contact_phone: '(954) 508-1512',
    lp_source: '',
    lp_subsource: '',
    _deps: {
      loadDecodedContact: async () => ({
        profile: { id: 'gC1', tags: [] },
        custom_fields: {},
      }),
      loadLeadSummary: async () => ({
        lead: { lp_lead_id: 'L1', lp_prospect_id: null },
        recent: { calls: [], notes: [], activities: [] },
      }),
      loadContactTimeline: async () => [],
      loadSourceAnalytics: async () => null,
      lookupProspectByPhone: async () => {
        throw new Error('lp_leads_phone_lookup:boom');
      },
    },
  });

  assert.equal(ctx.resolved_prospect_id, null);
  assert.ok(!ctx.data_gaps.some(g => /prospect_resolved_from/.test(g)));
});

test('Tier 3: skipped when no contact_phone provided', async () => {
  let phoneLookupCalls = 0;
  const ctx = await loadAppointmentContext({
    contact_id: 'gC1',
    contact_phone: '',
    lp_source: '',
    lp_subsource: '',
    _deps: {
      loadDecodedContact: async () => ({
        profile: { id: 'gC1', tags: [] },
        custom_fields: {},
      }),
      loadLeadSummary: async () => ({
        lead: { lp_lead_id: 'L1', lp_prospect_id: null },
        recent: { calls: [], notes: [], activities: [] },
      }),
      loadContactTimeline: async () => [],
      loadSourceAnalytics: async () => null,
      lookupProspectByPhone: async () => {
        phoneLookupCalls++;
        return '999999';
      },
    },
  });

  assert.equal(ctx.resolved_prospect_id, null);
  assert.equal(phoneLookupCalls, 0);
});
