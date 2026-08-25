/**
 * Tests — an unverified Pro ID must never reach Lead Perfection
 * scripts/test-canvasser-pro-id.js
 *
 * THE RISK. The canvassing intake forwards a number to LP as `pro_id`, and LP
 * resolves it to a promoter NAME on the lead — the canvasser who gets the
 * credit, and the commission.
 *
 * The number arriving from GHL is not guaranteed to be from LP's id space. A
 * SalesRabbit lead id or a GHL user id is also just digits, and LP cannot tell
 * them apart: it looks the number up in ITS table and returns whoever lives
 * there. Live Pro IDs run 1688..6090 — a range a foreign id lands inside
 * easily — so the failure mode is not an error or a blank field. It is a
 * DIFFERENT REAL PERSON silently credited with someone else's lead, and
 * nothing downstream can detect it: a misattributed lead looks exactly like a
 * correct one.
 *
 * So: verify against the roster (ci_canvassers, sql/067 — seeded from LP, the
 * same Pro ID space LP resolves against), and once enforcing, send NOTHING on
 * a miss.
 *
 * ── UNATTRIBUTED BEATS MISATTRIBUTED ───────────────────────────────────────
 * A lead with no promoter is visibly incomplete and someone fixes it. A lead
 * credited to the wrong canvasser pays the wrong person and nobody notices.
 * The lead itself is never blocked — the customer matters more than the
 * attribution.
 *
 * ── BUT IT SHIPS OBSERVING ─────────────────────────────────────────────────
 * A foreign id and a canvasser the roster snapshot has not caught up with look
 * identical: digits that are not in the table. Measured over the 7 days to
 * 2026-08-25, 302 of 371 canvass leads already resolve to names that ARE on
 * the roster — so withholding from day one would strip credit from real
 * canvassers to prevent a misattribution not yet observed. The verdict is
 * recorded on every lead first; CANVASS_PRO_ID_ENFORCE turns it into a block
 * once the real miss rate is known. Both modes are asserted below.
 *
 * No network, no DB — the verdict logic is pure and the roster is a double.
 *
 * Run: node --test scripts/test-canvasser-pro-id.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  verdictFor, isProIdShaped, resolveCanvasserProId, ENFORCE,
} from '../src/services/canvasser-roster.js';
import { buildLpLeadFields } from '../src/canvassing-lead-handler.js';

/** A real roster row, shaped like ci_canvassers. */
const ROSTER_ROW = { pro_id: 5296, name: 'CROSS, GIAN', market: 'ORL', active: true };

/** Roster double: only the ids given exist. */
function fakeRoster(rows) {
  return {
    from() {
      const chain = {
        _id: null,
        select() { return chain; },
        eq(_c, v) { chain._id = v; return chain; },
        limit() {
          return Promise.resolve({ data: rows.filter((r) => r.pro_id === chain._id), error: null });
        },
      };
      return chain;
    },
  };
}

/** Roster double whose read fails. */
const brokenRoster = {
  from() {
    const chain = {
      select() { return chain; },
      eq() { return chain; },
      limit: async () => ({ data: null, error: { message: 'connection reset' } }),
    };
    return chain;
  },
};

// ─── the shape check ────────────────────────────────────────────────────────

test('a Pro ID is digits, and nothing else is', () => {
  assert.equal(isProIdShaped('5296'), true);
  assert.equal(isProIdShaped(5296), true);
  assert.equal(isProIdShaped(' 5296 '), true);
  for (const bad of ['CROSS, GIAN', '', null, undefined, '52a96', '{{contact.pro_id}}', '-5', '5.5']) {
    assert.equal(isProIdShaped(bad), false, `wrongly accepted: ${bad}`);
  }
});

// ─── the verdict ────────────────────────────────────────────────────────────

test('a Pro ID ON the roster is sent, with the canvasser it identifies', () => {
  const v = verdictFor('5296', ROSTER_ROW);
  assert.equal(v.send, true);
  assert.equal(v.proId, '5296');
  assert.equal(v.name, 'CROSS, GIAN');
  assert.equal(v.market, 'ORL');
  assert.equal(v.reason, 'ok');
});

test('THE FIX: enforcing, digits NOT on the roster are withheld', () => {
  // A SalesRabbit or GHL id inside the 1688..6090 range. LP would resolve it
  // to whoever occupies that id — a different real canvasser.
  const v = verdictFor('4102', null, true);
  assert.equal(v.send, false, 'forwarding this is how the wrong person gets the commission');
  assert.equal(v.proId, null);
  assert.equal(v.reason, 'unknown_pro_id');
  assert.equal(v.withheld, true);
});

test('OBSERVING (the shipped default), the same id is recorded but still sent', () => {
  // Measured before shipping: 302 of 371 canvass leads already resolve to
  // names that ARE on the roster. Withholding on day one would strip credit
  // from real canvassers to prevent a misattribution not yet observed — so
  // the verdict is recorded first and enforcement is a separate decision.
  const v = verdictFor('4102', null, false);
  assert.equal(v.send, true, 'a stale roster must not silently strip attribution');
  assert.equal(v.proId, '4102');
  assert.equal(v.reason, 'unknown_pro_id', 'but it is still named, so the rate is queryable');
  assert.equal(v.withheld, false);
});

test('it ships OBSERVING — enforcement is opt-in', () => {
  assert.equal(ENFORCE(), false, 'CANVASS_PRO_ID_ENFORCE must default off');
});

test('a non-numeric value is refused, and says so distinctly', () => {
  // Distinct from unknown_pro_id on purpose: this means the GHL field is
  // mapped to the wrong thing, which is a different fix from a stale roster.
  assert.equal(verdictFor('CROSS, GIAN', null).reason, 'not_numeric');
  assert.equal(verdictFor('{{contact.pro_id}}', null).reason, 'not_numeric');
  assert.equal(verdictFor('', null).reason, 'absent');
  assert.equal(verdictFor(null, null).reason, 'absent');
});

test('an INACTIVE canvasser is still a real identity — credited, not dropped', () => {
  const v = verdictFor('5296', { ...ROSTER_ROW, active: false });
  assert.equal(v.send, true, 'they left the doors; they did not stop being who they are');
  assert.equal(v.reason, 'inactive_canvasser');
  assert.equal(v.name, 'CROSS, GIAN');
});

// ─── the lookup ─────────────────────────────────────────────────────────────

test('a roster hit resolves the canvasser', async () => {
  const v = await resolveCanvasserProId('5296', { db: fakeRoster([ROSTER_ROW]), enforce: true });
  assert.equal(v.send, true);
  assert.equal(v.name, 'CROSS, GIAN');
});

test('a roster MISS withholds the id when enforcing', async () => {
  const v = await resolveCanvasserProId('4102', { db: fakeRoster([ROSTER_ROW]), enforce: true });
  assert.equal(v.send, false);
  assert.equal(v.reason, 'unknown_pro_id');
});

test('a roster READ FAILURE does not guess — enforcing, it withholds', async () => {
  // If we cannot read the roster we do not know whether the id is real, and
  // "probably fine" is exactly the misattribution this prevents.
  const v = await resolveCanvasserProId('5296', { db: brokenRoster, enforce: true });
  assert.equal(v.send, false);
  assert.equal(v.reason, 'roster_unavailable');
});

test('a roster READ FAILURE while observing still sends — a blip is not a verdict', async () => {
  // A transient DB error must not quietly strip credit from every canvasser
  // until it clears.
  const v = await resolveCanvasserProId('5296', { db: brokenRoster, enforce: false });
  assert.equal(v.send, true);
  assert.equal(v.proId, '5296');
  assert.equal(v.reason, 'roster_unavailable');
});

test('one canvasser holding several roster rows still resolves', async () => {
  // (pro_id, phone_last10) is the composite key — three Pro IDs carry two
  // numbers each, so duplicates by pro_id are expected and legitimate.
  const two = [
    { ...ROSTER_ROW, pro_id: 4502, name: 'DOE, JANE' },
    { ...ROSTER_ROW, pro_id: 4502, name: 'DOE, JANE' },
  ];
  const v = await resolveCanvasserProId('4502', { db: fakeRoster(two), enforce: true });
  assert.equal(v.send, true);
  assert.equal(v.name, 'DOE, JANE');
});

// ─── what actually goes to LP ───────────────────────────────────────────────

const PAYLOAD = {
  ghl_contact_id: 'ghl-1',
  first_name: 'Test', last_name: 'Person',
  phone_raw: '7273302574',
  pro_id: '4102',          // a foreign id
  promoter: '',
};

test('the verified id is what reaches the LP field map', () => {
  const fields = buildLpLeadFields(PAYLOAD, null, { proId: '5296' });
  assert.equal(fields.pro_id, '5296');
});

test('a REJECTED id sends no promoter at all — it does not fall back', () => {
  // The regression that would undo this whole guard: falling back to the raw
  // payload value when the verified one is absent would forward the very id
  // the roster just refused.
  const fields = buildLpLeadFields(PAYLOAD, null, { proId: null });
  assert.notEqual(fields.pro_id, '4102', 'the refused id must not reach LP');
  assert.ok(!fields.pro_id, 'no promoter is the correct outcome here');
});

test('the pure builder still works uninjected, and never sends unchecked', () => {
  // Called without the option (tests, ad-hoc use) it keeps its old behaviour.
  // processCanvassingLead always passes the verified value.
  const fields = buildLpLeadFields({ ...PAYLOAD, pro_id: '5152' }, null);
  assert.equal(fields.pro_id, '5152');
});
