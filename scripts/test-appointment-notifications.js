/**
 * Tests — Agentic Appointment Notifications
 * scripts/test-appointment-notifications.js
 *
 * Covers spec §11 (the build doc's test list). Uses the Node 18+
 * built-in test runner (`node:test`). Run with:
 *
 *   node --test scripts/test-appointment-notifications.js
 *
 * No external test framework, no DB, no network — every external
 * dependency is mocked via dependency injection (runAppointmentNotification
 * accepts a `deps` arg).
 */

// Set test dummies for env vars that gate real network calls. The
// production check in ghlPutContact() insists on GHL_API_KEY being set;
// tests inject their own fetchImpl so the key value is never actually
// sent over the wire.
process.env.GHL_API_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ENABLED_NOTIFICATION_STATUSES,
  validateRequest,
  extractRequestFields,
  runAppointmentNotification,
  writeBackToGhl,
  postToGroupMe,
} from '../src/notifications/appointment-notifications.js';

// ───────────────────────────────────────────────────────────────────
// HELPERS — build a minimal valid normalized payload for orchestrator
// tests. Tests override individual fields as needed.
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
  for (const bad of ['no_show', 'completed', 'confirmed', '', 'CANCELLED ']) {
    const { valid } = validateRequest(buildPayload({ status: bad }));
    // 'CANCELLED ' is normalized lowercase by validator's .trim().toLowerCase()
    // so it lands as 'cancelled' — accepted. Skip that case.
    if (String(bad).trim().toLowerCase() === 'cancelled') continue;
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
  const { valid } = validateRequest(
    buildPayload({ lp_source: '', lp_subsource: '' }),
  );
  assert.equal(valid, true);
});

test('validateRequest rejects missing contact_id', () => {
  const payload = buildPayload();
  delete payload.contact_id;
  const { valid, errors } = validateRequest(payload);
  assert.equal(valid, false);
  assert.ok(errors.some(e => /contact_id/.test(e)));
});

test('ENABLED_NOTIFICATION_STATUSES is the single source of truth', () => {
  assert.deepEqual(ENABLED_NOTIFICATION_STATUSES, ['cancelled', 'rescheduled']);
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
    generateBody: async () => ({
      text: '❌ Window Estimate CANCELLED — Jane Doe',
      model: 'mock-model',
      request_id: 'mock',
      latency_ms: 1,
    }),
    postGroupMe: async () => ({ ok: true, status: 202 }),
    writeGhl: async () => {
      calls.push('writeGhl');
    },
    audit: async () => {
      calls.push('audit');
    },
    fieldIds: { body: 'B', id: 'I', ready: 'R' },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data_gaps, ['decoded_contact:contact_not_found_or_fetch_failed']);
  assert.deepEqual(calls, ['loadContext', 'writeGhl', 'audit']);
});

// ───────────────────────────────────────────────────────────────────
// BODY GENERATION — appointment_title is honored verbatim
// ───────────────────────────────────────────────────────────────────

test('body uses appointment_title from payload (not hardcoded)', async () => {
  let capturedPayload = null;
  const result = await runAppointmentNotification(
    buildPayload({ appointment_title: 'Roof Estimate' }),
    {
      loadContext: async () => buildContext(),
      generateBody: async ({ payload }) => {
        capturedPayload = payload;
        return {
          text: `❌ ${payload.appointment_title} CANCELLED — ${payload.contact_first_name} ${payload.contact_last_name}\n\n(555) 111-2222 · Boca Raton`,
          model: 'mock',
          request_id: 'r',
          latency_ms: 1,
        };
      },
      postGroupMe: async () => ({ ok: true, status: 202 }),
      writeGhl: async () => {},
      audit: async () => {},
      fieldIds: { body: 'B', id: 'I', ready: 'R' },
    },
  );

  assert.equal(result.ok, true);
  assert.ok(
    result.body.includes('Roof Estimate'),
    `expected "Roof Estimate" in body, got: ${result.body}`,
  );
  assert.ok(
    !result.body.includes('Window Estimate'),
    `expected NO "Window Estimate" in body, got: ${result.body}`,
  );
  assert.equal(capturedPayload.appointment_title, 'Roof Estimate');
});

test('body generator with empty lp_source / lp_subsource gets a data_gap flag', async () => {
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
        return { text: 'OK', model: 'mock', request_id: 'r', latency_ms: 1 };
      },
      postGroupMe: async () => ({ ok: true, status: 202 }),
      writeGhl: async () => {},
      audit: async () => {},
      fieldIds: { body: 'B', id: 'I', ready: 'R' },
    },
  );

  assert.equal(capturedContext.source_analytics, null);
  assert.ok(
    capturedContext.data_gaps.some(g => g.startsWith('source_intel_unavailable')),
    `expected source_intel_unavailable in data_gaps: ${JSON.stringify(capturedContext.data_gaps)}`,
  );
});

// ───────────────────────────────────────────────────────────────────
// GHL WRITEBACK ORDERING — ready flip is LAST
// ───────────────────────────────────────────────────────────────────

test('GHL writeback order: body+id first, then ready', async () => {
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
    body: 'msg',
    notificationId: 'nid-1',
    fieldIds: { body: 'BODY_ID', id: 'ID_ID', ready: 'READY_ID' },
    fetchImpl: mockFetch,
  });

  assert.equal(calls.length, 2, `expected 2 GHL PUTs, got ${calls.length}`);
  // Call 1: body + id together
  assert.deepEqual(calls[0].fields.sort(), ['BODY_ID', 'ID_ID'].sort());
  // Call 2: ready, alone, and LAST
  assert.deepEqual(calls[1].fields, ['READY_ID']);
  assert.deepEqual(calls[1].values, ['Yes']);
});

test('GHL writeback throws if body+id call fails — ready never written', async () => {
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
        body: 'msg',
        notificationId: 'nid-1',
        fieldIds: { body: 'B', id: 'I', ready: 'R' },
        fetchImpl: mockFetch,
      }),
    /ghl_500/,
  );
  // Only the first call (body+id) was attempted; ready never reached.
  assert.equal(calls.length, 1);
  assert.ok(!calls.some(c => c.fields.includes('R')));
});

test('orchestrator does NOT attempt GHL writes when GroupMe POST fails', async () => {
  const calls = [];

  const result = await runAppointmentNotification(buildPayload(), {
    loadContext: async () => buildContext(),
    generateBody: async () => ({ text: 'msg', model: 'mock', request_id: 'r', latency_ms: 1 }),
    postGroupMe: async () => {
      calls.push('postGroupMe:failed');
      return { ok: false, status: 503, body: 'down' };
    },
    writeGhl: async () => {
      calls.push('writeGhl:UNEXPECTED');
    },
    audit: async row => {
      calls.push(`audit:err=${row.error}:ghl=${row.ghl_writeback_at}`);
    },
    fieldIds: { body: 'B', id: 'I', ready: 'R' },
  });

  assert.equal(result.ok, false);
  assert.equal(result.http_status, 502);
  assert.ok(/groupme_post_failed/.test(result.error));
  assert.ok(!calls.some(c => c.startsWith('writeGhl')), `unexpected GHL write: ${calls.join(' | ')}`);
  // Audit was still written, ghl_writeback_at is null.
  assert.ok(calls.some(c => c.includes('audit:err=groupme_post_failed') && c.endsWith(':ghl=null')));
});

test('orchestrator does NOT flip ready when body+id GHL call fails', async () => {
  const ghlCalls = [];
  const mockGhlFetch = async (url, opts) => {
    const fields = JSON.parse(opts.body).customFields.map(f => f.id);
    ghlCalls.push(fields);
    // First call (body+id) fails
    if (ghlCalls.length === 1) {
      return new Response('boom', { status: 500 });
    }
    return new Response('{}', { status: 200 });
  };

  const result = await runAppointmentNotification(buildPayload(), {
    loadContext: async () => buildContext(),
    generateBody: async () => ({ text: 'msg', model: 'mock', request_id: 'r', latency_ms: 1 }),
    postGroupMe: async () => ({ ok: true, status: 202 }),
    audit: async () => {},
    fieldIds: { body: 'BODY_ID', id: 'ID_ID', ready: 'READY_ID' },
    fetchImpl: mockGhlFetch,
  });

  assert.equal(result.ok, false);
  assert.equal(result.http_status, 502);
  assert.ok(/ghl_writeback_failed/.test(result.error));
  assert.equal(result.groupme_posted, true);
  // Only the body+id call was attempted; ready never written.
  assert.equal(ghlCalls.length, 1);
  assert.ok(!ghlCalls.some(c => c.includes('READY_ID')));
});

// ───────────────────────────────────────────────────────────────────
// GROUPME POST
// ───────────────────────────────────────────────────────────────────

test('postToGroupMe returns ok=false when GROUPME_BOT_ID is missing', async () => {
  const result = await postToGroupMe('hello', { botId: '', fetchImpl: fetch });
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.match(result.body, /no_groupme_bot_id_configured/);
});

test('postToGroupMe truncates text to 1000 chars', async () => {
  let capturedBody;
  const mockFetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return new Response('{}', { status: 202 });
  };
  const longText = 'x'.repeat(2000);
  const result = await postToGroupMe(longText, { botId: 'test_bot', fetchImpl: mockFetch });
  assert.equal(result.ok, true);
  assert.equal(capturedBody.text.length, 1000);
  assert.equal(capturedBody.bot_id, 'test_bot');
});

// ───────────────────────────────────────────────────────────────────
// SUCCESS PATH — full happy path with audit assertions
// ───────────────────────────────────────────────────────────────────

test('full happy path: groupme posted, ghl written, ready flipped, audit clean', async () => {
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
        text: '❌ Window Estimate CANCELLED — Jane Doe\n\n(555) 111-2222 · Boca Raton',
        model: 'claude-sonnet-4-5',
        request_id: 'r',
        latency_ms: 30,
      };
    },
    postGroupMe: async () => {
      events.push('groupme');
      return { ok: true, status: 202 };
    },
    audit: async row => {
      events.push(`audit:err=${row.error}`);
      assert.ok(row.notification_id);
      assert.equal(row.error, null);
      assert.ok(row.groupme_posted_at);
      assert.ok(row.ghl_writeback_at);
      assert.equal(row.model_used, 'claude-sonnet-4-5');
    },
    fieldIds: { body: 'B', id: 'I', ready: 'R' },
    fetchImpl: mockGhlFetch,
  });

  assert.equal(result.ok, true);
  assert.equal(result.http_status, 200);
  assert.equal(result.groupme_posted, true);
  assert.equal(result.ghl_writeback_success, true);
  assert.ok(result.notification_id);
  // Verify ordering of side-effects.
  assert.deepEqual(events, ['context', 'generate', 'groupme', 'audit:err=null']);
  // Verify GHL call order: body+id first, ready second.
  assert.equal(ghlCalls.length, 2);
  assert.deepEqual(ghlCalls[0].sort(), ['B', 'I'].sort());
  assert.deepEqual(ghlCalls[1], ['R']);
});
