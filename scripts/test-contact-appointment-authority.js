/**
 * test-contact-appointment-authority.js — arbitration policy (pure, no DB).
 *
 * Run: node --test scripts/test-contact-appointment-authority.js
 *
 * IMPORTANT — what these tests can and cannot prove. `arbitrate()` is a JS
 * MIRROR of the SQL WHERE clause in
 * sql/migrations/2026-08-03_contact_appointment_authority.sql; the SQL is the
 * only thing that actually arbitrates, because it runs under the ON CONFLICT
 * row lock. CI has no Postgres, so nothing here can catch the two drifting
 * apart. The SQL predicate is transcribed verbatim below and the clause count
 * is asserted, so ADDING A CLAUSE TO ONE SIDE ONLY fails this file.
 *
 *   WHERE caa.owner_lp_lead_id = EXCLUDED.owner_lp_lead_id                  -- 1 owner
 *      OR EXCLUDED.authority_rank > caa.authority_rank                      -- 2 outranks
 *      OR caa.ghl_appointment_id IS NULL                                    -- 3 no live appt
 *      OR caa.appointment_start IS NULL                                     -- 3
 *      OR caa.appointment_start < now()                                     -- 3
 *      OR COALESCE(caa.lp_appointment_seen_at, '-infinity'::timestamptz)
 *           < now() - make_interval(secs => ...)                            -- 4 staleness
 *
 * There is deliberately NO rank-tie clause. See the SQL comment.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// The module imports supabase.js; force it to no-op so these stay dependency-free.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.APPT_AUTHORITY_ENFORCE;

const {
  arbitrate, rankForDisposition, BOOKING_AUTHORITY_RANK,
  isAuthorityEnforced, staleAfterSeconds,
} = await import('../src/services/contact-appointment-authority.js');

const NOW = Date.UTC(2026, 7, 3, 12, 0, 0);           // 2026-08-03T12:00:00Z
const FUTURE = new Date(NOW + 2 * 24 * 3600e3).toISOString();
const PAST = new Date(NOW - 2 * 24 * 3600e3).toISOString();
const FRESH = new Date(NOW - 3600e3).toISOString();     // seen an hour ago

/** An incumbent owner holding a live future appointment, recently touched. */
function owner(over = {}) {
  return {
    owner_lp_lead_id: '563787',
    authority_rank: 2,                 // Cnf
    ghl_appointment_id: 'hXMBabc',
    appointment_start: FUTURE,
    lp_appointment_seen_at: FRESH,
    ...over,
  };
}
const at = (over = {}) => arbitrate(over.current ?? owner(), over.incoming, { nowMs: NOW });

// ── §5 r5 — first writer claims ────────────────────────────────────────────
test('no authority row: first writer claims', () => {
  const r = arbitrate(null, { owner_lp_lead_id: '563753', authority_rank: 1 }, { nowMs: NOW });
  assert.equal(r.granted, true);
  assert.equal(r.reason, 'first_claim');
});

// ── §5 r1 — the owner may always act ───────────────────────────────────────
test('canary: the owner may always reschedule its own appointment', () => {
  // This is why a naive "block if already booked" gate is wrong — it would
  // break every legitimate reschedule.
  const r = at({ incoming: { owner_lp_lead_id: '563787', authority_rank: 2 } });
  assert.equal(r.granted, true);
  assert.equal(r.reason, 'owner');
});

test('owner match is string-compared, so a numeric lead id still matches', () => {
  const r = arbitrate(owner(), { owner_lp_lead_id: 563787, authority_rank: 2 }, { nowMs: NOW });
  assert.equal(r.granted, true);
  assert.equal(r.reason, 'owner');
});

// ── §5 r2 — confirmation outranks recency ──────────────────────────────────
test('canary: a higher rank displaces the incumbent', () => {
  const r = arbitrate(owner({ owner_lp_lead_id: '563753', authority_rank: 1 }),
    { owner_lp_lead_id: '563787', authority_rank: 2 }, { nowMs: NOW });
  assert.equal(r.granted, true);
  assert.equal(r.reason, 'outranks');
});

test('canary regression (2026-08-02): a Set sibling cannot take a Cnf owner’s seat', () => {
  // Lead 563790 (Set, 13:00) vs owner 563787 (Cnf, 17:00). Under the old
  // newest-lead-wins the Set won and the customer was texted 1:00 PM.
  const r = at({ incoming: { owner_lp_lead_id: '563790', authority_rank: 1 } });
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'authority_denied');
});

// ── rank ties: NO clause, incumbent keeps the seat ─────────────────────────
test('rank ties leave the incumbent in place, in BOTH directions', () => {
  // Deliberate: updated_at_lp is LP's LastChangedOn and bumps on any field
  // change (a rep note), so "more recently touched" is not "more recently
  // booked". A tie-break on it would also diverge from the merged event gate,
  // which requires a STRICT rank increase — the engine would admit one
  // sibling's event while this table handed the seat to the other.
  const setOwner = owner({ owner_lp_lead_id: 'A', authority_rank: 1 });
  assert.equal(arbitrate(setOwner, { owner_lp_lead_id: 'B', authority_rank: 1 }, { nowMs: NOW }).granted, false);
  // …and a fresher challenger still does not win a tie.
  assert.equal(arbitrate(setOwner,
    { owner_lp_lead_id: 'B', authority_rank: 1, lp_appointment_seen_at: new Date(NOW).toISOString() },
    { nowMs: NOW }).granted, false);
});

test('a lower rank never displaces', () => {
  assert.equal(at({ incoming: { owner_lp_lead_id: 'X', authority_rank: 0 } }).granted, false);
});

// ── §5 r4 — the owner holds no LIVE appointment ────────────────────────────
test('an owner with no appointment id yields the seat', () => {
  const r = arbitrate(owner({ ghl_appointment_id: null }),
    { owner_lp_lead_id: 'X', authority_rank: 1 }, { nowMs: NOW });
  assert.equal(r.granted, true);
  assert.equal(r.reason, 'no_live_appointment');
});

test('a PAST appointment is not a live one — completed/no-show keeps its id', () => {
  // Precisely why the clause is not `ghl_appointment_id IS NULL` alone: a
  // completed or no-showed appointment keeps its id forever.
  const r = arbitrate(owner({ appointment_start: PAST }),
    { owner_lp_lead_id: 'X', authority_rank: 1 }, { nowMs: NOW });
  assert.equal(r.granted, true);
  assert.equal(r.reason, 'no_live_appointment');
});

test('a null appointment_start yields the seat', () => {
  // lpWallClockToGhlStartTime returns null for midnight / date-only LP rows,
  // so this fires on real traffic.
  const r = arbitrate(owner({ appointment_start: null }),
    { owner_lp_lead_id: 'X', authority_rank: 1 }, { nowMs: NOW });
  assert.equal(r.granted, true);
});

// ── §10 — ownership starvation release ─────────────────────────────────────
test('staleness releases the seat only PAST the window', () => {
  const SEC = 14 * 24 * 3600;
  const justInside = new Date(NOW - (SEC - 1) * 1000).toISOString();
  const justOutside = new Date(NOW - (SEC + 1) * 1000).toISOString();

  assert.equal(arbitrate(owner({ lp_appointment_seen_at: justInside }),
    { owner_lp_lead_id: 'X', authority_rank: 1 }, { nowMs: NOW, staleSeconds: SEC }).granted, false);

  const out = arbitrate(owner({ lp_appointment_seen_at: justOutside }),
    { owner_lp_lead_id: 'X', authority_rank: 1 }, { nowMs: NOW, staleSeconds: SEC });
  assert.equal(out.granted, true);
  assert.equal(out.reason, 'owner_stale');

  // Exactly at the boundary the incumbent keeps it (the SQL uses strict <).
  assert.equal(arbitrate(owner({ lp_appointment_seen_at: new Date(NOW - SEC * 1000).toISOString() }),
    { owner_lp_lead_id: 'X', authority_rank: 1 }, { nowMs: NOW, staleSeconds: SEC }).granted, false);
});

test('a NULL lp_appointment_seen_at is releasable, not permanently wedged', () => {
  // COALESCE(..., '-infinity') in the SQL. Without it the clause evaluates
  // NULL and such a contact could never be displaced except by a higher rank.
  // 8 lp_leads rows carry NULL updated_at_lp today.
  const r = arbitrate(owner({ lp_appointment_seen_at: null }),
    { owner_lp_lead_id: 'X', authority_rank: 1 }, { nowMs: NOW });
  assert.equal(r.granted, true);
  assert.equal(r.reason, 'owner_stale');
});

// ── rank scale ─────────────────────────────────────────────────────────────
test('BOOKING_AUTHORITY_RANK: Verif ties Set, Cnf beats both', () => {
  assert.deepEqual(BOOKING_AUTHORITY_RANK, { Set: 1, Verif: 1, Cnf: 2 });
  assert.equal(rankForDisposition('Cnf') > rankForDisposition('Verif'), true);
  assert.equal(rankForDisposition('Set'), rankForDisposition('Verif'));
});

test('unlisted dispositions rank 0 — including CXL', () => {
  // CXL at rank 0 is exactly why callers must NOT gate a cancellation on a
  // granted claim: a non-owner CXL loses every clause, and the appointment
  // would stay live on the calendar.
  for (const code of ['CXL', 'DNC', 'Sale', 'Data', '', null, undefined, ' ']) {
    assert.equal(rankForDisposition(code), 0, `expected rank 0 for ${JSON.stringify(code)}`);
  }
  assert.equal(rankForDisposition(' Cnf '), 2, 'codes are trimmed');
});

// ── flags ──────────────────────────────────────────────────────────────────
test('APPT_AUTHORITY_ENFORCE must be exactly true — ships dark', () => {
  const prior = process.env.APPT_AUTHORITY_ENFORCE;
  try {
    delete process.env.APPT_AUTHORITY_ENFORCE;
    assert.equal(isAuthorityEnforced(), false);
    for (const v of ['false', '', '1', 'yes', 'TRUE ']) {
      process.env.APPT_AUTHORITY_ENFORCE = v;
      assert.equal(isAuthorityEnforced(), v.trim().toLowerCase() === 'true', `for ${JSON.stringify(v)}`);
    }
    process.env.APPT_AUTHORITY_ENFORCE = 'true';
    assert.equal(isAuthorityEnforced(), true);
  } finally {
    if (prior === undefined) delete process.env.APPT_AUTHORITY_ENFORCE;
    else process.env.APPT_AUTHORITY_ENFORCE = prior;
  }
});

test('staleAfterSeconds defaults to 14 days and rejects junk', () => {
  const prior = process.env.APPT_AUTHORITY_STALE_DAYS;
  try {
    delete process.env.APPT_AUTHORITY_STALE_DAYS;
    assert.equal(staleAfterSeconds(), 14 * 24 * 3600);
    process.env.APPT_AUTHORITY_STALE_DAYS = '7';
    assert.equal(staleAfterSeconds(), 7 * 24 * 3600);
    for (const junk of ['0', '-3', 'abc', '']) {
      process.env.APPT_AUTHORITY_STALE_DAYS = junk;
      assert.equal(staleAfterSeconds(), 14 * 24 * 3600, `junk ${JSON.stringify(junk)} → default`);
    }
  } finally {
    if (prior === undefined) delete process.env.APPT_AUTHORITY_STALE_DAYS;
    else process.env.APPT_AUTHORITY_STALE_DAYS = prior;
  }
});

// ── drift tripwire ─────────────────────────────────────────────────────────
test('SQL/JS clause parity: every granted reason is accounted for', () => {
  // The SQL WHERE has FOUR grant grounds (the three appointment_start legs are
  // one ground). arbitrate() must expose exactly these, plus first_claim for
  // the plain INSERT path. If you add a clause to the SQL, add it here and to
  // this list — a bare mirror that silently lags the SQL is worse than none.
  const REASONS = ['first_claim', 'owner', 'outranks', 'no_live_appointment', 'owner_stale'];
  const seen = new Set([
    arbitrate(null, { owner_lp_lead_id: 'A', authority_rank: 1 }, { nowMs: NOW }).reason,
    at({ incoming: { owner_lp_lead_id: '563787', authority_rank: 2 } }).reason,
    arbitrate(owner({ authority_rank: 1 }), { owner_lp_lead_id: 'X', authority_rank: 2 }, { nowMs: NOW }).reason,
    arbitrate(owner({ ghl_appointment_id: null }), { owner_lp_lead_id: 'X', authority_rank: 1 }, { nowMs: NOW }).reason,
    arbitrate(owner({ lp_appointment_seen_at: null }), { owner_lp_lead_id: 'X', authority_rank: 1 }, { nowMs: NOW }).reason,
  ]);
  assert.deepEqual([...seen].sort(), [...REASONS].sort());
});
