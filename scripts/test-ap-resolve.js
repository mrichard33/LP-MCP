// scripts/test-ap-resolve.js
//
// POST /intake/ap-resolve — the step that sits BEFORE LeadConduit's Lead
// Perfection Form POST. Three things are load-bearing and all three are pinned
// here:
//
//   1. It NEVER hands back an id in shadow. That is what lets the endpoint be
//      wired into the flow on one day and switched on for real on another.
//   2. It NEVER fails the step. Every path — timeout, GHL error, no phone —
//      answers 200 with an empty contact_id, because a non-200 marks the step
//      failed in LeadConduit and can trip flow error handling.
//   3. The field spellings match what ActiveProspect actually sends. The list
//      is taken from the n8n I.AP "Normalize Lead" node (YOozjkCkeNEe4s3a),
//      which has been receiving real AP payloads since 2026-09-08. A miss here
//      is silent: an empty phone means no match, which looks exactly like a
//      quiet day.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  contactInputFromApBody, vendorFromApBody, resolveApContact, _internal,
} from '../src/ap-intake.js';

const { logClientDisconnect } = _internal;

// A GHL deps stub, same shape as the one in test-ap-intake.js: each queued
// entry is either a response body or an Error to throw.
function ghl(queue) {
  const calls = [];
  return {
    calls,
    async ghlFetch(path, opts = {}) {
      calls.push({ path, method: opts.method || 'GET', body: opts.body });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next ?? { contacts: [] };
    },
  };
}
const quiet = { warn: () => {}, log: () => {}, error: () => {} };

// ─── The field spellings AP actually sends ──────────────────────────────────

test('LeadConduit-native spellings map as well as the LP AddLead ones', () => {
  // Left column is what the n8n I.AP normalizer accepts and our first cut did
  // not. Each one would otherwise resolve to an empty string.
  const c = contactInputFromApBody({
    Phone: '386-555-1234',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email_address: 'ADA@example.com',
    address_1: '1 Analytical Way',
    city: 'Deltona',
    state: 'FL',
    zipcode: '32725',
  });
  assert.equal(c.phone, '386-555-1234');
  assert.equal(c.firstName, 'Ada');
  assert.equal(c.lastName, 'Lovelace');
  assert.equal(c.email, 'ADA@example.com');
  assert.equal(c.address, '1 Analytical Way');
  assert.equal(c.postalCode, '32725');
});

test('every phone spelling the normalizer accepts resolves', () => {
  for (const key of ['phone', 'phone1', 'Phone1', 'phone_1', 'primary_phone',
    'Phone', 'mobile', 'cell', 'phone_number']) {
    assert.equal(contactInputFromApBody({ [key]: '3865551234' }).phone, '3865551234',
      `${key} must map`);
  }
});

test('LP AddLead names still win over the LeadConduit ones', () => {
  // Step 12's mappings are LP legacy names. If AP ever sends both, the LP
  // spelling is the one that was proven against a real delivery.
  const c = contactInputFromApBody({ phone1: '3865551234', mobile: '9045559999' });
  assert.equal(c.phone, '3865551234');
});

test('vendor reads the sub-source spellings lp_source_mapping is keyed on', () => {
  assert.equal(vendorFromApBody({ lp_subsource: 'Modernize' }), 'Modernize');
  assert.equal(vendorFromApBody({ lead_source: 'MyHomePros' }), 'MyHomePros');
  assert.equal(vendorFromApBody({ source_name: 'Google PPC Windows' }), 'Google PPC Windows');
  assert.equal(vendorFromApBody({ sourcesubdescr: 'Angie', vendor: 'other' }), 'Angie',
    'the LP spelling wins');
  assert.equal(vendorFromApBody({}), '');
});

// ─── Shadow returns nothing the flow can act on ─────────────────────────────

test('shadow finds the contact, reports it, and still returns no id', async () => {
  const deps = ghl([{ contacts: [{ id: 'known1', phone: '+13865551234' }] }]);
  const r = await resolveApContact({ phone1: '3865551234' },
    { mode: 'shadow', deps, log: quiet });
  assert.equal(r.outcome, 'found');
  assert.equal(r.contactId, null, 'shadow must never hand back an id');
  assert.equal(r.wouldStamp, 'known1', 'but it must say what it would have handed back');
  assert.equal(deps.calls.filter((c) => c.method === 'POST').length, 0,
    'and it must write nothing');
});

test('live hands back the id shadow only reported', async () => {
  const deps = ghl([{ contacts: [{ id: 'known1', phone: '+13865551234' }] }]);
  const r = await resolveApContact({ phone1: '3865551234' },
    { mode: 'live', deps, log: quiet });
  assert.equal(r.contactId, 'known1');
});

test('off never touches GHL at all', async () => {
  const deps = ghl([]);
  const r = await resolveApContact({ phone1: '3865551234' },
    { mode: 'off', deps, log: quiet });
  assert.equal(r.outcome, 'skipped');
  assert.equal(r.contactId, null);
  assert.equal(deps.calls.length, 0, 'off is a true kill switch — not even a search');
});

// ─── It never fails the step ────────────────────────────────────────────────

test('a GHL error answers with no id rather than throwing', async () => {
  // If this threw, the route would 500 and LeadConduit would mark the step
  // failed — which is the one outcome that can cost a lead.
  const deps = ghl([new Error('GHL GET /contacts/ → 503: upstream down')]);
  const r = await resolveApContact({ phone1: '3865551234' },
    { mode: 'live', deps, log: quiet });
  assert.ok(['error', 'none'].includes(r.outcome));
  assert.equal(r.contactId, null);
});

test('a lead with no usable phone is answered, not rejected', async () => {
  const deps = ghl([]);
  const r = await resolveApContact({ firstname: 'Ada' }, { mode: 'live', deps, log: quiet });
  assert.equal(r.outcome, 'no_phone');
  assert.equal(r.contactId, null);
  assert.equal(deps.calls.length, 0);
});

test('a slow GHL is capped, and the cap reads as timeout not as a match', async () => {
  // The ceiling is the whole reason this endpoint can sit in front of LP: the
  // pipe it joins (n8n YOozjkCkeNEe4s3a) never errored, it just took up to
  // 20.7s, and ActiveProspect gave up while it was still working.
  const deps = {
    calls: [],
    ghlFetch: () => new Promise((r) => setTimeout(() => r({ contacts: [] }), 3000)),
  };
  const prev = process.env.AP_INTAKE_RESOLVE_TIMEOUT_MS;
  try {
    const started = Date.now();
    const r = await resolveApContact({ phone1: '3865551234' },
      { mode: 'live', deps, log: quiet });
    // Default ceiling is 1200ms; the stub would take 3000.
    assert.equal(r.outcome, 'timeout');
    assert.equal(r.contactId, null);
    assert.ok(Date.now() - started < 2500, 'answered at the ceiling, not at GHL\'s pace');
  } finally {
    if (prev === undefined) delete process.env.AP_INTAKE_RESOLVE_TIMEOUT_MS;
    else process.env.AP_INTAKE_RESOLVE_TIMEOUT_MS = prev;
  }
});

// ─── Learning AP's real timeout ─────────────────────────────────────────────

/** Express-ish req/res pair whose `close` handler the test fires by hand. */
function reqRes({ writableFinished }) {
  const reqHandlers = {};
  const resHandlers = {};
  return {
    req: { on: (ev, fn) => { reqHandlers[ev] = fn; } },
    res: { writableFinished, on: (ev, fn) => { resHandlers[ev] = fn; } },
    fireReqClose: () => reqHandlers.close?.(),
    fireResClose: () => resHandlers.close?.(),
  };
}

function captureWarnings(fn) {
  const lines = [];
  const prevWarn = console.warn;
  console.warn = (m) => lines.push(m);
  try { fn(); } finally { console.warn = prevWarn; }
  return lines;
}

test('a client that hangs up before we answer is logged', () => {
  // LeadConduit exposes no delivery timeout setting and publishes none, so this
  // line is the only evidence of what AP's real ceiling is.
  const h = reqRes({ writableFinished: false });
  const lines = captureWarnings(() => {
    logClientDisconnect(h.req, h.res, Date.now() - 4200, 'AP-RESOLVE');
    h.fireResClose();
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[AP-RESOLVE\] client disconnected after \d+ms/);
});

test('a fully-sent response logs nothing', () => {
  const h = reqRes({ writableFinished: true });
  const lines = captureWarnings(() => {
    logClientDisconnect(h.req, h.res, Date.now(), 'AP-RESOLVE');
    h.fireResClose();
  });
  assert.equal(lines.length, 0, 'every successful lead would otherwise log a false alarm');
});

test('it listens on the RESPONSE, never the request', () => {
  // Regression, seen in production on the very first four probes: the first cut
  // used req.on('close'), which fires as soon as the request BODY has been read
  // — on every healthy request, before the handler has answered. It logged
  // `ActiveProspect gave up` at severity error for all four successful probes.
  // An alarm that fires on the healthy case gets muted, and this alarm is the
  // only measurement of AP's real timeout we can ever take.
  const h = reqRes({ writableFinished: false });
  const lines = captureWarnings(() => {
    logClientDisconnect(h.req, h.res, Date.now(), 'AP-RESOLVE');
    h.fireReqClose();   // the event the broken version listened for
  });
  assert.equal(lines.length, 0, 'a request-stream close is not a disconnect');
});
