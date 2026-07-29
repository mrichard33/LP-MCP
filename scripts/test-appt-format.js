/**
 * Guards for src/appointments/format.js.
 *
 * Invariants under guard:
 *   • Title is "{First} {Last} - {Calendar}", never the reversed form LP MCP
 *     writes today ("Window Estimate - Jane").
 *   • With no usable name the title is the BARE calendar name — never
 *     I.LP-IN's "  - Window Estimate" (leading spaces + dangling separator,
 *     verified live on 6 of 1,503).
 *   • A placeholder name ("Guest Visitor") counts as no name.
 *   • Calendar names are the strings other writers actually put in live titles,
 *     NOT CALENDAR_NAME_MAP's short forms ('MV', 'HPA').
 *   • Address returns null without a street line, so the phone calendars never
 *     get a ", FL" fragment.
 *   • Both builders no-op unless APPT_FORMAT_ENABLED === 'true'.
 */

// src/supabase.js reads env at import time, and format.js reaches it through
// the contact cache. Stub before importing anything.
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAppointmentTitle,
  buildAppointmentAddress,
  calendarTitleName,
  applyAppointmentFormat,
  isFormatEnabled,
  CALENDAR_TITLE_NAME,
} from '../src/appointments/format.js';

const WE = 'aJj14ONxh1oFyDcQ706O';
const MV = 'zEdPmkNccR2ovo3rQAd3';
const HPA = 'zS1wg0JqQ1zsszJyJqKX';

// ─── Title ──────────────────────────────────────────────────────────

test('title is {Name} - {Calendar}, the brief\'s worked example', () => {
  assert.equal(
    buildAppointmentTitle({ firstName: 'Jenette', lastName: 'Victory', calendarId: WE }),
    'Jenette Victory - Window Estimate'
  );
});

test('MV uses the string every other writer uses live, not the short form', () => {
  assert.equal(
    buildAppointmentTitle({ firstName: 'Terry', lastName: 'Linton', calendarId: MV }),
    'Terry Linton - Window Measurement Verification'
  );
  // The short form is what CALENDAR_NAME_MAP holds; it must not leak in here.
  assert.ok(!CALENDAR_TITLE_NAME[MV].includes('MV'));
});

test('HPA has no live precedent — falls to the canonical long form', () => {
  assert.equal(
    buildAppointmentTitle({ firstName: 'Ann', lastName: 'Lee', calendarId: HPA }),
    'Ann Lee - Home Protection Assessment'
  );
});

test('empty name yields the BARE calendar name, not "  - Window Estimate"', () => {
  const t = buildAppointmentTitle({ firstName: '', lastName: '', calendarId: WE });
  assert.equal(t, 'Window Estimate');
  assert.ok(!t.startsWith(' '), 'no leading space');
  assert.ok(!t.includes(' - '), 'no dangling separator');
});

test('whitespace-only name parts are treated as absent', () => {
  assert.equal(
    buildAppointmentTitle({ firstName: '   ', lastName: '\t', calendarId: WE }),
    'Window Estimate'
  );
});

test('placeholder name counts as no name', () => {
  assert.equal(
    buildAppointmentTitle({ firstName: 'Guest', lastName: 'Visitor', calendarId: WE }),
    'Window Estimate'
  );
});

test('a single name part still produces a real title', () => {
  assert.equal(
    buildAppointmentTitle({ firstName: 'Bryon', lastName: '', calendarId: WE }),
    'Bryon - Window Estimate'
  );
});

test('unknown calendar id falls back to the caller-supplied name', () => {
  assert.equal(
    buildAppointmentTitle({ firstName: 'Ed', lastName: 'Cahill', calendarId: 'nope', calendarName: 'Some Calendar' }),
    'Ed Cahill - Some Calendar'
  );
});

test('known calendar id WINS over a caller-supplied name', () => {
  // The in-process sites pass the existing bare title as calendarName; the id
  // must take precedence so a stale/short name cannot survive.
  assert.equal(
    buildAppointmentTitle({ firstName: 'Ed', lastName: 'Cahill', calendarId: MV, calendarName: 'MV' }),
    'Ed Cahill - Window Measurement Verification'
  );
});

test('no calendar and no name yields null, leaving the caller title untouched', () => {
  assert.equal(buildAppointmentTitle({ firstName: '', lastName: '', calendarId: '' }), null);
});

test('name with no calendar yields just the name', () => {
  assert.equal(buildAppointmentTitle({ firstName: 'Ed', lastName: 'Cahill', calendarId: '' }), 'Ed Cahill');
});

test('re-formatting an already-formatted title is idempotent', () => {
  const once = buildAppointmentTitle({ firstName: 'Ed', lastName: 'Cahill', calendarId: WE });
  const twice = buildAppointmentTitle({ firstName: 'Ed', lastName: 'Cahill', calendarId: WE, calendarName: once });
  assert.equal(twice, once);
});

test('calendarTitleName maps every live calendar', () => {
  assert.equal(calendarTitleName(WE), 'Window Estimate');
  assert.equal(calendarTitleName('DQYMaJ22N6zL4SXjHukw'), 'Protection Profile Review');
  assert.equal(calendarTitleName('gFWoSQrlKIdfRbAPV842'), 'Confirmation Call');
  assert.equal(calendarTitleName('unknown'), null);
});

// ─── Address ────────────────────────────────────────────────────────

test('address joins the four parts', () => {
  assert.equal(
    buildAppointmentAddress({ address1: '536 Parkdale Blvd', city: 'Lehigh Acres', state: 'FL', postalCode: '33974' }),
    '536 Parkdale Blvd, Lehigh Acres, FL, 33974'
  );
});

test('address omits missing middle parts without leaving empty segments', () => {
  assert.equal(
    buildAppointmentAddress({ address1: '17306 Darby Ln', city: '', state: 'FL', postalCode: '33558' }),
    '17306 Darby Ln, FL, 33558'
  );
});

test('address is null without a street line — no ", FL" fragment', () => {
  assert.equal(buildAppointmentAddress({ city: 'Tampa', state: 'FL', postalCode: '33558' }), null);
  assert.equal(buildAppointmentAddress({ address1: '   ', city: 'Tampa' }), null);
  assert.equal(buildAppointmentAddress({}), null);
});

test('street alone is a valid address', () => {
  assert.equal(buildAppointmentAddress({ address1: '759 Rio Vista Dr' }), '759 Rio Vista Dr');
});

// ─── Flag gating ────────────────────────────────────────────────────

test('isFormatEnabled is strictly "true"', () => {
  const prev = process.env.APPT_FORMAT_ENABLED;
  try {
    for (const v of [undefined, '', 'false', '1', 'yes']) {
      if (v === undefined) delete process.env.APPT_FORMAT_ENABLED;
      else process.env.APPT_FORMAT_ENABLED = v;
      assert.equal(isFormatEnabled(), false, `"${v}" must not enable`);
    }
    process.env.APPT_FORMAT_ENABLED = 'TRUE ';
    assert.equal(isFormatEnabled(), true, 'trimmed + lowercased');
  } finally {
    if (prev === undefined) delete process.env.APPT_FORMAT_ENABLED;
    else process.env.APPT_FORMAT_ENABLED = prev;
  }
});

test('applyAppointmentFormat is a no-op while the flag is off', () => {
  const prev = process.env.APPT_FORMAT_ENABLED;
  delete process.env.APPT_FORMAT_ENABLED;
  try {
    const body = { calendarId: WE, title: 'Window Estimate' };
    const out = applyAppointmentFormat(body, { firstName: 'Jenette', lastName: 'Victory', address1: '1 Main St' });
    assert.equal(body.title, 'Window Estimate', 'title untouched');
    assert.equal(body.address, undefined, 'address never set');
    assert.equal(out.addressPopulated, false);
  } finally {
    if (prev === undefined) delete process.env.APPT_FORMAT_ENABLED;
    else process.env.APPT_FORMAT_ENABLED = prev;
  }
});

test('applyAppointmentFormat sets title and address when enabled', () => {
  const prev = process.env.APPT_FORMAT_ENABLED;
  process.env.APPT_FORMAT_ENABLED = 'true';
  try {
    const body = { calendarId: WE, title: 'Window Estimate' };
    const out = applyAppointmentFormat(body, {
      firstName: 'Jenette', lastName: 'Victory',
      address1: '536 Parkdale Blvd', city: 'Lehigh Acres', state: 'FL', postalCode: '33974',
    });
    assert.equal(body.title, 'Jenette Victory - Window Estimate');
    assert.equal(body.address, '536 Parkdale Blvd, Lehigh Acres, FL, 33974');
    assert.equal(out.title, 'Jenette Victory - Window Estimate');
    assert.equal(out.addressPopulated, true);
  } finally {
    if (prev === undefined) delete process.env.APPT_FORMAT_ENABLED;
    else process.env.APPT_FORMAT_ENABLED = prev;
  }
});

test('enabled but addressless contact leaves address unset and reports false', () => {
  const prev = process.env.APPT_FORMAT_ENABLED;
  process.env.APPT_FORMAT_ENABLED = 'true';
  try {
    const body = { calendarId: 'gFWoSQrlKIdfRbAPV842', title: 'Confirmation Call' };
    const out = applyAppointmentFormat(body, { firstName: 'Mike', lastName: 'Hak', state: 'FL' });
    assert.equal(body.title, 'Mike Hak - Confirmation Call');
    assert.equal(body.address, undefined);
    assert.equal(out.addressPopulated, false);
  } finally {
    if (prev === undefined) delete process.env.APPT_FORMAT_ENABLED;
    else process.env.APPT_FORMAT_ENABLED = prev;
  }
});
