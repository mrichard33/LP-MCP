/**
 * LP addlead address gate — scripts/test-lp-address-gate.js
 *
 * Section D of the 2026-08-18 handoff. The properties under test:
 *   - hold-and-enrich, NEVER DROP: every decision path resolves to forward
 *     or hold — there is no reject;
 *   - shadow mode never holds (ship state);
 *   - enforce holds only what enrichment could not complete;
 *   - the chatbot forward_then_backfill policy forwards immediately;
 *   - the website-form lognumber shape (lead 567596's actual emitter —
 *     session UUID, not a GHL contact id) is never "enriched" against GHL;
 *   - gate internals fail OPEN (an exception forwards untouched);
 *   - the exhausted-hold notes stamp is idempotent;
 *   - the sweeper parses LP's raw addlead response for the in1_id.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
process.env.GHL_API_KEY = process.env.GHL_API_KEY || 'test-ghl-key';

const {
  applyAddressGate,
  missingAddressFields,
  isChatbotOriginated,
  looksLikeGhlContactId,
  enrichBodyFromGhl,
  stampIncompleteNotes,
  INCOMPLETE_NOTES_STAMP,
} = await import('../src/services/lp-address-gate.js');
const { parseInboundIdFromRaw } = await import('../src/jobs/lp-addlead-hold-sweeper.js');

const GHL_ID = 'KE2VqAhWZ91iCdmwAmmx';
const WEBSITE_LOGNUMBER = '9b6a5eec_63ed_4aff_8033_d2a2a4af8e3f'; // lead 567596's actual lognumber

const COMPLETE = {
  firstname: 'John', lastname: 'Czeropski', phone1: '2246501321',
  address1: '4360 Washington Place', city: 'Ave Maria', state: 'FL', zip: '34142',
  sender: 'GHL-Window Estimator', srs_id: '842', lognumber: GHL_ID,
};

function zipOnly(over = {}) {
  return { ...COMPLETE, address1: '', city: '', state: '  ', ...over };
}

// ─── field detection ───────────────────────────────────────────────

test('complete body has no missing fields', () => {
  assert.deepEqual(missingAddressFields(COMPLETE), []);
});

test('zip-only body (the 08-16 failure shape) misses address1/city/state', () => {
  assert.deepEqual(missingAddressFields(zipOnly()), ['address1', 'city', 'state']);
});

test('whitespace-only state counts as missing (LP stores "  ")', () => {
  assert.deepEqual(missingAddressFields({ ...COMPLETE, state: '  ' }), ['state']);
});

// ─── origin detection ──────────────────────────────────────────────

test('chatbot detection: sender and srs_id 5574 both count', () => {
  assert.equal(isChatbotOriginated({ sender: 'GHL-ChatBot Timeout' }), true);
  assert.equal(isChatbotOriginated({ sender: 'GHL-X', srs_id: '5574' }), true);
  assert.equal(isChatbotOriginated(COMPLETE), false);
});

test('GHL contact ids resolve; website session UUIDs never do', () => {
  assert.equal(looksLikeGhlContactId(GHL_ID), true);
  assert.equal(looksLikeGhlContactId(WEBSITE_LOGNUMBER), false);
  assert.equal(looksLikeGhlContactId(''), false);
});

// ─── enrichment ────────────────────────────────────────────────────

test('missing fields fill from the GHL contact', async () => {
  const { body, filled } = await enrichBodyFromGhl(zipOnly(), {
    getGHLContact: async () => ({ address1: '4360 Washington Place', city: 'Ave Maria', state: 'FL', postalCode: '34142' }),
  });
  assert.deepEqual(filled.sort(), ['address1', 'city', 'state']);
  assert.equal(body.address1, '4360 Washington Place');
  assert.deepEqual(missingAddressFields(body), []);
});

test('a website-form lognumber is never fetched against GHL', async () => {
  let called = 0;
  const { filled } = await enrichBodyFromGhl(zipOnly({ lognumber: WEBSITE_LOGNUMBER }), {
    getGHLContact: async () => { called++; return {}; },
  });
  assert.equal(called, 0);
  assert.deepEqual(filled, []);
});

test('enrichment fetch failure fails open (body unchanged)', async () => {
  const input = zipOnly();
  const { body, filled } = await enrichBodyFromGhl(input, {
    getGHLContact: async () => { throw new Error('GHL down'); },
  });
  assert.equal(body, input);
  assert.deepEqual(filled, []);
});

// ─── the gate decision table ───────────────────────────────────────

function sbInsertMock({ conflict = false } = {}) {
  const calls = { inserts: [], updates: [] };
  const client = {
    from() { return this; },
    insert(row) {
      calls.inserts.push(row);
      return {
        select() { return this; },
        async maybeSingle() {
          return conflict
            ? { data: null, error: { code: '23505', message: 'dup' } }
            : { data: { id: 77 }, error: null };
        },
      };
    },
    update(patch) {
      calls.updates.push(patch);
      return { eq() { return this; }, async is() { return { error: null }; } };
    },
  };
  return { client, calls };
}

test('mode off → forward, untouched', async () => {
  const res = await applyAddressGate(zipOnly(), { mode: 'off' });
  assert.equal(res.action, 'forward');
  assert.equal(res.reason, 'gate_off');
});

test('complete body → forward (any mode)', async () => {
  const res = await applyAddressGate(COMPLETE, { mode: 'enforce' });
  assert.equal(res.action, 'forward');
  assert.equal(res.reason, 'complete');
});

test('shadow + incomplete + unenrichable → forward with would_hold', async () => {
  const res = await applyAddressGate(zipOnly(), {
    mode: 'shadow',
    getGHLContact: async () => ({}),
  });
  assert.equal(res.action, 'forward');
  assert.equal(res.would_hold, true);
  assert.equal(res.reason, 'shadow_would_hold');
});

test('enforce + incomplete + enrichable → forward the ENRICHED body', async () => {
  const res = await applyAddressGate(zipOnly(), {
    mode: 'enforce',
    getGHLContact: async () => ({ address1: '4360 Washington Place', city: 'Ave Maria', state: 'FL' }),
  });
  assert.equal(res.action, 'forward');
  assert.equal(res.reason, 'enriched_complete');
  assert.equal(res.body.address1, '4360 Washington Place');
});

test('enforce + incomplete + unenrichable → HOLD', async () => {
  const { client, calls } = sbInsertMock();
  const res = await applyAddressGate(zipOnly(), {
    mode: 'enforce',
    getGHLContact: async () => ({}),
    supabase: client,
  });
  assert.equal(res.action, 'hold');
  assert.equal(res.hold.held, true);
  assert.equal(calls.inserts.length, 1);
  assert.deepEqual(calls.inserts[0].missing_fields, ['address1', 'city', 'state']);
});

test('a second incomplete addlead refreshes the live hold instead of stacking', async () => {
  const { client, calls } = sbInsertMock({ conflict: true });
  const res = await applyAddressGate(zipOnly(), {
    mode: 'enforce',
    getGHLContact: async () => ({}),
    supabase: client,
  });
  assert.equal(res.action, 'hold');
  assert.equal(res.hold.refreshed, true);
  assert.equal(calls.updates.length, 1);
});

test('enforce + chatbot + forward_then_backfill policy → forwards now', async () => {
  process.env.LP_CHATBOT_ADDRESS_POLICY = 'forward_then_backfill';
  try {
    const res = await applyAddressGate(zipOnly({ sender: 'GHL-ChatBot' }), {
      mode: 'enforce',
      getGHLContact: async () => ({}),
    });
    assert.equal(res.action, 'forward');
    assert.equal(res.reason, 'chatbot_forward_then_backfill');
  } finally {
    delete process.env.LP_CHATBOT_ADDRESS_POLICY;
  }
});

test('enforce + chatbot + default hold_then_forward policy → holds', async () => {
  const { client } = sbInsertMock();
  const res = await applyAddressGate(zipOnly({ sender: 'GHL-ChatBot' }), {
    mode: 'enforce',
    getGHLContact: async () => ({}),
    supabase: client,
  });
  assert.equal(res.action, 'hold');
});

test('gate internals fail OPEN — a hold-table error forwards untouched', async () => {
  const res = await applyAddressGate(zipOnly(), {
    mode: 'enforce',
    getGHLContact: async () => ({}),
    supabase: {
      from() { return this; },
      insert() {
        return { select() { return this; }, async maybeSingle() { return { data: null, error: { code: '500', message: 'db down' } }; } };
      },
    },
  });
  assert.equal(res.action, 'forward');
  assert.match(res.reason, /gate_error/);
});

// ─── exhausted-hold notes stamp ────────────────────────────────────

test('notes stamp prefixes and preserves; idempotent', () => {
  const once = stampIncompleteNotes({ notes: 'canvasser brief' });
  assert.equal(once.notes, `${INCOMPLETE_NOTES_STAMP} | canvasser brief`);
  const twice = stampIncompleteNotes(once);
  assert.equal(twice.notes, once.notes);
  const empty = stampIncompleteNotes({});
  assert.equal(empty.notes, INCOMPLETE_NOTES_STAMP);
});

// ─── sweeper response parse ────────────────────────────────────────

test('in1_id parses from LP raw addlead responses', () => {
  assert.equal(parseInboundIdFromRaw('{"status":"OK","message":"lead added: 415895"}'), '415895');
  assert.equal(parseInboundIdFromRaw('Lead Added: 12345'), '12345');
  assert.equal(parseInboundIdFromRaw('ERROR: something'), null);
  assert.equal(parseInboundIdFromRaw(''), null);
});

// ─── state normalization on backfill (2026-08-27) ──────────────────
//
// LP TRUNCATES its state column to two characters, silently. GHL stores the
// state spelled out, so backfilling it raw wrote "Fl" — wrong, still shaped
// like a state code, never an error. Verified in lp_prospects: 39 rows "Fl",
// 18 "fl", 829 "nu" (the literal string "null" truncated).

test('a spelled-out GHL state is backfilled as its two-letter code', async () => {
  const { body, filled } = await enrichBodyFromGhl(zipOnly(), {
    getGHLContact: async () => ({ address1: '5476 Enclave Crossing Way', city: 'Delray Beach', state: 'Florida', postalCode: '33484' }),
  });
  assert.ok(filled.includes('state'));
  assert.equal(body.state, 'FL');
  assert.deepEqual(missingAddressFields(body), []);
});

test('a nullish GHL state is NOT backfilled — the gate holds instead of writing "nu"', async () => {
  const { body, filled } = await enrichBodyFromGhl(zipOnly(), {
    getGHLContact: async () => ({ address1: '5476 Enclave Crossing Way', city: 'Delray Beach', state: 'null', postalCode: '33484' }),
  });
  // normalizeState blanks it, isBlank() then rejects it: state stays missing.
  assert.ok(!filled.includes('state'));
  assert.ok(missingAddressFields(body).includes('state'));
  // The other fields still fill — one bad value must not block the rest.
  assert.ok(filled.includes('address1'));
  assert.ok(filled.includes('city'));
});

test('an already-correct state code is backfilled unchanged', async () => {
  const { body } = await enrichBodyFromGhl(zipOnly(), {
    getGHLContact: async () => ({ address1: '4360 Washington Place', city: 'Ave Maria', state: 'FL', postalCode: '34142' }),
  });
  assert.equal(body.state, 'FL');
});

// ─── the "null" literal is not a value (2026-08-27) ────────────────
//
// isBlank used to be `String(v).trim() !== ''`, so the four-character string
// "null" counted as a real address field: missingAddressFields never flagged
// it, the gate neither enriched nor held, and it forwarded to LP — which
// truncates the column to two characters. That is why 604 prospects read a
// state of "nu". A wrong-but-plausible value beat a blank one purely because
// it was long enough.

test('a "null" literal counts as MISSING, not as a value', () => {
  for (const junk of ['null', 'NULL', 'undefined', 'NaN', 'none', 'N/A', 'na']) {
    assert.deepEqual(
      missingAddressFields({ ...COMPLETE, state: junk }),
      ['state'],
      `"${junk}" was treated as a real state`,
    );
  }
});

test('a "null" literal in any address field is caught', () => {
  assert.deepEqual(
    missingAddressFields({ ...COMPLETE, address1: 'null', city: 'undefined' }).sort(),
    ['address1', 'city'],
  );
});

test('real values are still values — 0 and false are not nullish', () => {
  assert.deepEqual(missingAddressFields(COMPLETE), []);
  // A zip of "0" is wrong data but it is not "nothing was here"; the gate must
  // not silently reinterpret it.
  assert.deepEqual(missingAddressFields({ ...COMPLETE, zip: '0' }), []);
});

test('a body carrying state "null" is now enriched from GHL instead of forwarded', async () => {
  const { body, filled } = await enrichBodyFromGhl({ ...COMPLETE, state: 'null' }, {
    getGHLContact: async () => ({ address1: '4360 Washington Place', city: 'Ave Maria', state: 'Florida', postalCode: '34142' }),
  });
  assert.deepEqual(filled, ['state']);
  assert.equal(body.state, 'FL');
  assert.deepEqual(missingAddressFields(body), []);
});
