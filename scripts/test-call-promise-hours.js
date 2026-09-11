/**
 * test-call-promise-hours.js — the guard on "someone will call you right now".
 *
 * WHY THIS EXISTS
 * ───────────────
 * "PHONE ROOM: OPEN" used to be computed from the Five9 dial window ALONE —
 * src/dial-window.js, 08:00-21:00 ET, EVERY DAY (Mark's 2026-09-04 ruling).
 * The Callback Request campaign runs in PREVIEW mode, which needs a logged-in
 * agent to place the call, so the bot could promise an immediate callback at
 * 8:30 PM on a Sunday against an empty room.
 *
 * Mark reopened that ruling on 2026-09-11 and reversed it: when the office is
 * closed, the bot must not suggest anyone will call immediately. He confirmed
 * the staffed hours the same day:
 *
 *     Mon-Fri  8:00 AM - 8:00 PM ET
 *     Sat      9:00 AM - 8:00 PM ET
 *     Sun      9:00 AM - 5:00 PM ET
 *
 * Those are the defaults in src/staffed-hours.js and the expectations below.
 *
 * DST: every case is pinned to a real UTC instant and asserted against the ET
 * wall clock, with both an EDT and an EST table, because the server runs UTC
 * and a getHours()-based implementation would pass half the year and fail the
 * other half.
 *
 * Run: node --test scripts/test-call-promise-hours.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const {
  isWithinStaffedHours,
  nextStaffedOpening,
  staffedHoursHuman,
  staffedHoursBounds,
  etParts,
} = await import('../src/staffed-hours.js');

const {
  canPromiseImmediateCall,
  isWithinDialWindow,
  dialWindowPromptLine,
} = await import('../src/dial-window.js');

const { findImmediateCallPromises } = await import('../src/response-generator.js');

const CALL_PROMISE_ENV = [
  'CALL_PROMISE_HOURS_ET',
  'CALL_PROMISE_DAYS_ET',
  'CALL_PROMISE_START_HOUR_ET',
  'CALL_PROMISE_END_HOUR_ET',
];

/** Run fn with the given env, restoring whatever was there before. */
function withEnv(vars, fn) {
  const saved = {};
  for (const k of CALL_PROMISE_ENV) saved[k] = process.env[k];
  try {
    for (const k of CALL_PROMISE_ENV) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) process.env[k] = v;
    return fn();
  } finally {
    for (const k of CALL_PROMISE_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** Assert a UTC instant really is the ET wall-clock time we think it is. */
function assertEt(iso, expectHour, expectMinute, label) {
  const p = etParts(Date.parse(iso));
  assert.equal(p.hour, expectHour, `${label}: ET hour`);
  assert.equal(p.minute, expectMinute, `${label}: ET minute`);
}

// ══════════════════════════════════════════════════════════════════════
// DST TABLE — EDT (UTC-4, summer) and EST (UTC-5, winter)
//
// Each row: a UTC instant, what ET calls it, and whether the floor is staffed.
// The EST rows are the SAME ET wall-clock times as the EDT rows, one hour
// further from UTC. An implementation using getHours() gets one table right
// and the other wrong.
// ══════════════════════════════════════════════════════════════════════

const DST_TABLE = [
  // ── EDT (UTC-4). 2026-09-07 is a Monday. ──
  { iso: '2026-09-07T11:59:00Z', et: 'Mon 07:59 EDT', h: 7,  m: 59, staffed: false, note: 'Mon 7:59 AM — one minute before the floor opens' },
  { iso: '2026-09-07T12:00:00Z', et: 'Mon 08:00 EDT', h: 8,  m: 0,  staffed: true,  note: 'Mon 8:00 AM — open on the dot' },
  { iso: '2026-09-11T23:59:00Z', et: 'Thu 19:59 EDT', h: 19, m: 59, staffed: true,  note: 'Thu 7:59 PM — last staffed minute' },
  { iso: '2026-09-12T00:00:00Z', et: 'Thu 20:00 EDT', h: 20, m: 0,  staffed: false, note: 'Thu 8:00 PM — half-open on the top' },
  { iso: '2026-09-11T20:59:00Z', et: 'Fri 16:59 EDT', h: 16, m: 59, staffed: true,  note: 'Fri 4:59 PM — mid-afternoon' },
  { iso: '2026-09-11T21:00:00Z', et: 'Fri 17:00 EDT', h: 17, m: 0,  staffed: true,  note: 'Fri 5:00 PM — STILL staffed; weekdays run to 8 PM' },
  { iso: '2026-09-12T00:30:00Z', et: 'Fri 20:30 EDT', h: 20, m: 30, staffed: false, note: 'Fri 8:30 PM — closed' },
  { iso: '2026-09-12T12:30:00Z', et: 'Sat 08:30 EDT', h: 8,  m: 30, staffed: false, note: 'Sat 8:30 AM — Saturday opens at 9, not 8' },
  { iso: '2026-09-12T13:00:00Z', et: 'Sat 09:00 EDT', h: 9,  m: 0,  staffed: true,  note: 'Sat 9:00 AM — Saturday opening' },
  { iso: '2026-09-12T16:00:00Z', et: 'Sat 12:00 EDT', h: 12, m: 0,  staffed: true,  note: 'Sat noon — staffed' },
  { iso: '2026-09-13T20:59:00Z', et: 'Sun 16:59 EDT', h: 16, m: 59, staffed: true,  note: 'Sun 4:59 PM — last staffed Sunday minute' },
  { iso: '2026-09-13T21:00:00Z', et: 'Sun 17:00 EDT', h: 17, m: 0,  staffed: false, note: 'Sun 5:00 PM — Sunday closes early' },
  { iso: '2026-09-14T00:00:00Z', et: 'Sun 20:00 EDT', h: 20, m: 0,  staffed: false, note: 'Sun 8:00 PM — THE REGRESSION: dial window says open, floor is empty' },

  // ── EST (UTC-5). 2026-01-05 is a Monday. ──
  { iso: '2026-01-05T12:59:00Z', et: 'Mon 07:59 EST', h: 7,  m: 59, staffed: false, note: 'Mon 7:59 AM in EST' },
  { iso: '2026-01-05T13:00:00Z', et: 'Mon 08:00 EST', h: 8,  m: 0,  staffed: true,  note: 'Mon 8:00 AM in EST' },
  { iso: '2026-01-09T22:00:00Z', et: 'Fri 17:00 EST', h: 17, m: 0,  staffed: true,  note: 'Fri 5:00 PM in EST — still staffed' },
  { iso: '2026-01-10T01:30:00Z', et: 'Fri 20:30 EST', h: 20, m: 30, staffed: false, note: 'Fri 8:30 PM in EST — closed' },
  { iso: '2026-01-10T13:30:00Z', et: 'Sat 08:30 EST', h: 8,  m: 30, staffed: false, note: 'Sat 8:30 AM in EST' },
  { iso: '2026-01-10T17:00:00Z', et: 'Sat 12:00 EST', h: 12, m: 0,  staffed: true,  note: 'Sat noon in EST' },
  { iso: '2026-01-12T01:00:00Z', et: 'Sun 20:00 EST', h: 20, m: 0,  staffed: false, note: 'Sun 8:00 PM in EST — the regression, winter half' },
];

test('DST table — every instant is the ET wall-clock time the row claims', () => {
  withEnv({}, () => {
    for (const row of DST_TABLE) assertEt(row.iso, row.h, row.m, row.et);
  });
});

test('DST table — isWithinStaffedHours matches Mark\'s confirmed hours', () => {
  withEnv({}, () => {
    for (const row of DST_TABLE) {
      assert.equal(
        isWithinStaffedHours(Date.parse(row.iso)),
        row.staffed,
        `${row.et} — ${row.note}`
      );
    }
  });
});

test('REGRESSION — Sunday 8 PM: the dialer is running but nobody is there', () => {
  withEnv({}, () => {
    const at = Date.parse('2026-09-14T00:00:00Z');
    assert.equal(etParts(at).isoDay, 7, 'is a Sunday in ET');
    assert.equal(etParts(at).hour, 20, 'is 8 PM ET');
    assert.equal(isWithinDialWindow(at), true, 'Five9 IS dialing — 08:00-21:00 every day');
    assert.equal(isWithinStaffedHours(at), false, 'but the floor is not staffed');
    assert.equal(canPromiseImmediateCall(at), false, 'so no immediate callback may be promised');
  });
});

test('canPromiseImmediateCall needs BOTH facts — 8:30 PM on a weekday', () => {
  withEnv({}, () => {
    const at = Date.parse('2026-09-12T00:30:00Z'); // Fri 8:30 PM EDT
    assert.equal(isWithinDialWindow(at), true, 'dialer runs to 9 PM');
    assert.equal(isWithinStaffedHours(at), false, 'floor went home at 8 PM');
    assert.equal(canPromiseImmediateCall(at), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// nextStaffedOpening
// ══════════════════════════════════════════════════════════════════════

const OPENING_CASES = [
  { iso: '2026-09-12T00:30:00Z', et: 'Fri 8:30 PM EDT', human: 'Saturday at 9:00 AM' },
  { iso: '2026-09-13T01:00:00Z', et: 'Sat 9:00 PM EDT', human: 'Sunday at 9:00 AM' },
  { iso: '2026-09-14T00:00:00Z', et: 'Sun 8:00 PM EDT', human: 'Monday at 8:00 AM' },
  { iso: '2026-09-07T11:59:00Z', et: 'Mon 7:59 AM EDT', human: 'today at 8:00 AM' },
  { iso: '2026-09-12T12:30:00Z', et: 'Sat 8:30 AM EDT', human: 'today at 9:00 AM' },
  { iso: '2026-01-10T01:30:00Z', et: 'Fri 8:30 PM EST', human: 'Saturday at 9:00 AM' },
  { iso: '2026-01-12T01:00:00Z', et: 'Sun 8:00 PM EST', human: 'Monday at 8:00 AM' },
];

test('nextStaffedOpening names the right day and hour', () => {
  withEnv({}, () => {
    for (const c of OPENING_CASES) {
      assert.equal(nextStaffedOpening(Date.parse(c.iso)).human, c.human, c.et);
    }
  });
});

test('nextStaffedOpening returns an instant that IS the opening hour in ET', () => {
  withEnv({}, () => {
    for (const c of OPENING_CASES) {
      const { atMs } = nextStaffedOpening(Date.parse(c.iso));
      const p = etParts(atMs);
      const expectedHour = Number(c.human.match(/at (\d+):00 (AM|PM)/)[1]);
      assert.equal(p.hour, expectedHour, `${c.et} → ${c.human}`);
      assert.equal(p.minute, 0, `${c.et}: on the hour`);
      assert.ok(atMs > Date.parse(c.iso), `${c.et}: the opening is in the future`);
    }
  });
});

test('nextStaffedOpening is DST-correct across the spring-forward weekend', () => {
  withEnv({}, () => {
    // 2026-03-08 is the US spring-forward Sunday. Sat 2026-03-07 9:00 PM EST.
    const at = Date.parse('2026-03-08T02:00:00Z');
    assert.equal(etParts(at).isoDay, 6, 'Saturday in ET');
    assert.equal(etParts(at).hour, 21, '9 PM ET');
    const next = nextStaffedOpening(at);
    assert.equal(next.human, 'Sunday at 9:00 AM');
    // Sunday 9 AM lands AFTER the 2 AM jump, so it is 13:00Z, not 14:00Z.
    assert.equal(etParts(next.atMs).hour, 9);
    assert.equal(new Date(next.atMs).toISOString(), '2026-03-08T13:00:00.000Z');
  });
});

test('nextStaffedOpening is DST-correct across the fall-back weekend', () => {
  withEnv({}, () => {
    // 2026-11-01 is the US fall-back Sunday. Sat 2026-10-31 9:00 PM EDT.
    const at = Date.parse('2026-11-01T01:00:00Z');
    assert.equal(etParts(at).isoDay, 6, 'Saturday in ET');
    assert.equal(etParts(at).hour, 21, '9 PM ET');
    const next = nextStaffedOpening(at);
    assert.equal(next.human, 'Sunday at 9:00 AM');
    // Sunday 9 AM lands AFTER the 2 AM fall-back, so EST: 14:00Z.
    assert.equal(etParts(next.atMs).hour, 9);
    assert.equal(new Date(next.atMs).toISOString(), '2026-11-01T14:00:00.000Z');
  });
});

// ══════════════════════════════════════════════════════════════════════
// The prompt line
// ══════════════════════════════════════════════════════════════════════

test('dialWindowPromptLine OPEN states the staffed hours, not the dial window', () => {
  withEnv({}, () => {
    const line = dialWindowPromptLine(Date.parse('2026-09-11T20:59:00Z')); // Fri 4:59 PM
    assert.match(line, /^PHONE ROOM: OPEN right now \(staffed /);
    assert.match(line, /Mon–Fri 8:00 AM–8:00 PM, Sat 9:00 AM–8:00 PM, Sun 9:00 AM–5:00 PM ET/);
    assert.match(line, /An immediate callback CAN be promised\.$/);
  });
});

test('dialWindowPromptLine CLOSED names the next opening', () => {
  withEnv({}, () => {
    const line = dialWindowPromptLine(Date.parse('2026-09-14T00:00:00Z')); // Sun 8 PM
    assert.match(line, /^PHONE ROOM: CLOSED right now\./);
    assert.match(line, /The next call can go out Monday at 8:00 AM ET\./);
    assert.match(line, /An immediate callback CANNOT be promised\.$/);
  });
});

test('the prompt line renders hours from the env, never a hardcoded string', () => {
  withEnv({ CALL_PROMISE_HOURS_ET: '1-5:7-19' }, () => {
    const line = dialWindowPromptLine(Date.parse('2026-09-11T20:59:00Z'));
    assert.match(line, /staffed Mon–Fri 7:00 AM–7:00 PM ET/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Env overrides and malformed values
// ══════════════════════════════════════════════════════════════════════

test('default schedule is Mark\'s confirmed hours', () => {
  withEnv({}, () => {
    assert.deepEqual(staffedHoursBounds().schedule, {
      1: [8, 20], 2: [8, 20], 3: [8, 20], 4: [8, 20], 5: [8, 20], 6: [9, 20], 7: [9, 17],
    });
    assert.equal(staffedHoursHuman(), 'Mon–Fri 8:00 AM–8:00 PM, Sat 9:00 AM–8:00 PM, Sun 9:00 AM–5:00 PM ET');
  });
});

test('CALL_PROMISE_HOURS_ET per-day override works', () => {
  withEnv({ CALL_PROMISE_HOURS_ET: '1-5:9-17,6:10-14' }, () => {
    assert.deepEqual(staffedHoursBounds().schedule, {
      1: [9, 17], 2: [9, 17], 3: [9, 17], 4: [9, 17], 5: [9, 17], 6: [10, 14],
    });
    // Sunday is now unstaffed entirely.
    assert.equal(isWithinStaffedHours(Date.parse('2026-09-13T16:00:00Z')), false, 'Sun noon');
    assert.equal(isWithinStaffedHours(Date.parse('2026-09-12T15:00:00Z')), true, 'Sat 11 AM');
    assert.equal(isWithinStaffedHours(Date.parse('2026-09-12T18:30:00Z')), false, 'Sat 2:30 PM');
  });
});

test('the flat DAYS/START/END override still works', () => {
  withEnv({ CALL_PROMISE_DAYS_ET: '1,2,3,4,5', CALL_PROMISE_START_HOUR_ET: '8', CALL_PROMISE_END_HOUR_ET: '17' }, () => {
    assert.equal(staffedHoursHuman(), 'Mon–Fri 8:00 AM–5:00 PM ET');
    assert.equal(isWithinStaffedHours(Date.parse('2026-09-11T20:59:00Z')), true,  'Fri 4:59 PM');
    assert.equal(isWithinStaffedHours(Date.parse('2026-09-11T21:00:00Z')), false, 'Fri 5:00 PM');
    assert.equal(isWithinStaffedHours(Date.parse('2026-09-12T16:00:00Z')), false, 'Sat noon');
    assert.equal(nextStaffedOpening(Date.parse('2026-09-11T21:30:00Z')).human, 'Monday at 8:00 AM', 'Fri 5:30 PM');
  });
});

test('a single flat var switches to the flat form with sane partners', () => {
  withEnv({ CALL_PROMISE_END_HOUR_ET: '17' }, () => {
    assert.equal(staffedHoursHuman(), 'Mon–Fri 8:00 AM–5:00 PM ET');
  });
});

const MALFORMED = [
  { CALL_PROMISE_HOURS_ET: 'garbage' },
  { CALL_PROMISE_HOURS_ET: '1-5:8-20,9:9-17' },      // day 9 does not exist
  { CALL_PROMISE_HOURS_ET: '1-5:20-8' },             // end before start
  { CALL_PROMISE_HOURS_ET: '1-5:8-25' },             // hour out of range
  { CALL_PROMISE_HOURS_ET: '' },
  { CALL_PROMISE_DAYS_ET: '1,2,nope' },
  { CALL_PROMISE_DAYS_ET: '0,8' },
  { CALL_PROMISE_START_HOUR_ET: 'lunchtime', CALL_PROMISE_END_HOUR_ET: 'dinner' },
  { CALL_PROMISE_START_HOUR_ET: '-3' },
  { CALL_PROMISE_START_HOUR_ET: '8.5' },
];

test('every malformed env value falls back to the defaults — never a half-schedule', () => {
  const expected = withEnv({}, () => staffedHoursHuman());
  for (const vars of MALFORMED) {
    withEnv(vars, () => {
      assert.equal(
        staffedHoursHuman(),
        expected,
        `malformed ${JSON.stringify(vars)} should fall back to the defaults`
      );
    });
  }
});

// ══════════════════════════════════════════════════════════════════════
// findImmediateCallPromises — the body guard
// ══════════════════════════════════════════════════════════════════════

const PROMISE_HITS = [
  'Someone will call you right away.',
  "I'll have someone call you right now.",
  'Our team will call you shortly.',
  'A specialist will ring you momentarily.',
  'We can call you ASAP.',
  'Someone will reach out in the next few minutes.',
  'Someone will reach out in a few minutes.',
  'We will phone you within the next 10 minutes.',
  'We will call you within 5 min.',
  "They'll get back to you right away.",
  "We'll reach you any minute.",
  "Someone will contact you shortly.",
];

const PROMISE_MISSES = [
  "Our team is out for the day — someone will reach out Monday at 8:00 AM ET.",
  "Happy to help. What size are the openings?",
  "We'll call you tomorrow afternoon.",
  "Someone will call you back during business hours.",
  "I'll get you on the calendar shortly — does Thursday at 2 work?", // 'shortly' with no call verb near it
  "The estimate will be ready shortly.",
  "Give us a call any time at (954) 800-8906.",
];

test('findImmediateCallPromises catches immediate-callback language', () => {
  for (const body of PROMISE_HITS) {
    assert.ok(
      findImmediateCallPromises(body).length > 0,
      `should have flagged: ${body}`
    );
  }
});

test('findImmediateCallPromises leaves safe copy alone', () => {
  for (const body of PROMISE_MISSES) {
    assert.deepEqual(
      findImmediateCallPromises(body),
      [],
      `should NOT have flagged: ${body}`
    );
  }
});

test('the immediacy phrase must be in the same breath as the call verb', () => {
  const far = "Someone will call you back. We're getting the paperwork over to the office and it should all be wrapped up shortly.";
  assert.deepEqual(findImmediateCallPromises(far), [], 'two sentences apart is not a promise of an immediate call');
});

// ══════════════════════════════════════════════════════════════════════
// The safe fallback must not re-introduce the promise the guard removes
// ══════════════════════════════════════════════════════════════════════

test('the AI safe fallback is hours-aware', async () => {
  const { buildAiFallback } = await import('../src/ai-fallback.js');
  await withEnv({}, async () => {
    const openAt = Date.parse('2026-09-11T20:59:00Z');   // Fri 4:59 PM — staffed
    const closedAt = Date.parse('2026-09-14T00:00:00Z'); // Sun 8:00 PM — not

    for (const channel of ['email', 'sms']) {
      // Inside staffed hours the copy is unchanged — "shortly" is true.
      const open = buildAiFallback(channel, null, { atMs: openAt });
      assert.match(open.message, /shortly/, `${channel}: "shortly" is fine while staffed`);

      const closed = buildAiFallback(channel, null, { atMs: closedAt });
      assert.doesNotMatch(closed.message, /shortly/, `${channel}: never "shortly" after hours`);
      assert.match(closed.message, /Monday at 8:00 AM ET/, `${channel}: names the next opening`);
      assert.deepEqual(findImmediateCallPromises(closed.message), [],
        `${channel}: the after-hours fallback must pass the same guard the reply path does`);
    }
  });
});
