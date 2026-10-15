/**
 * The rehash rep is the follower on THIS lead, not a fixed John Manieri
 * (the user, 2026-10-15: "Can we assign it to the follower assigned to the
 * lead?"). src/config/rehash-assignee.js rehashRepFor, used by the Rehash Call
 * booking, the calendar read and the post-demo follow-up task.
 *
 *   node --test scripts/test-rehash-rep.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rehashRepFor, callAssigneeFor, ASSIGNED_TO_USER_FIELD_ID, REHASH_REP_USER_ID_DEFAULT } from '../src/config/rehash-assignee.js';
import { readRehashCallSlots, ghlUserFirstName } from '../src/agentic/rehash-slots.js';
import { followUpTask, filePostDemoFollowUp } from '../src/services/post-demo-followup-io.js';

const JOHN = REHASH_REP_USER_ID_DEFAULT;
const AI_USER = '3K6HtoPyBLWeQrrnSnCD';
const field = (v) => [{ id: ASSIGNED_TO_USER_FIELD_ID, value: v }];

test('a follower on the lead is the rep', () => {
  assert.equal(rehashRepFor({ followers: ['repA'], assignedTo: AI_USER }), 'repA');
});

test('several followers: the one on the rehash team wins, else the first', () => {
  assert.equal(rehashRepFor({ followers: ['sales1', 'repB'] }, new Set(['repB'])), 'repB');
  assert.equal(rehashRepFor({ followers: ['sales1', 'repB'] }, new Set(['other'])), 'sales1');
  assert.equal(rehashRepFor({ followers: [{ id: 'repC' }] }), 'repC');
});

test('no follower: the "Assigned To (User ID)" field (the live rehash contact, 2026-10-15)', () => {
  assert.equal(rehashRepFor({ followers: [], assignedTo: AI_USER, customFields: field(JOHN) }), JOHN);
});

test('neither: null, so the caller keeps its default', () => {
  assert.equal(rehashRepFor({ followers: [], customFields: [] }), null);
  assert.equal(rehashRepFor(null), null);
  assert.equal(callAssigneeFor({ isRehashCalendar: true, contactRep: null, contactOwner: AI_USER, team: new Set([JOHN]) }, {}), JOHN);
});

test('callAssigneeFor: a named assignee wins, then the rep on the lead, never on other calendars', () => {
  assert.equal(callAssigneeFor({ isRehashCalendar: true, explicit: 'named', contactRep: 'repA' }, {}), 'named');
  assert.equal(callAssigneeFor({ isRehashCalendar: true, contactRep: 'repA', contactOwner: JOHN, team: new Set([JOHN]) }, {}), 'repA');
  assert.equal(callAssigneeFor({ isRehashCalendar: false, contactRep: 'repA' }, {}), null);
});

test('the calendar is read for the follower, and their first name comes from GHL', async () => {
  const seen = [];
  const r = await readRehashCallSlots({ contactId: 'c1', timezone: 'America/New_York', env: { REHASH_CALENDAR_ID: 'cal' } }, {
    getContact: async () => ({ followers: ['repA'], assignedTo: AI_USER }),
    getUserName: async (id) => (id === 'repA' ? 'Dana' : null),
    fetchFreeSlots: async (_cal, o) => { seen.push(o.userId); return { slots: [{ iso: '2026-10-16T14:00:00Z' }, { iso: '2026-10-16T15:00:00Z' }] }; },
    selectOfferableSlots: (av) => ({ slots: av.slots }),
    isOpen: () => true,
  });
  assert.deepEqual(seen, ['repA']);
  assert.equal(r.rep, 'repA');
  assert.equal(r.repName, 'Dana');
});

test('ghlUserFirstName: first word of the name, null on a failed read, never throws', async () => {
  assert.equal(await ghlUserFirstName('u1', { ghlFetch: async () => ({ firstName: 'Dana Lee' }) }), 'Dana');
  assert.equal(await ghlUserFirstName('u2', { ghlFetch: async () => { throw new Error('404'); } }), null);
  assert.equal(await ghlUserFirstName(null), null);
});

test('the follow-up task goes to the rep on the lead, else the rehash team default', async () => {
  assert.equal(followUpTask({ label: 'in November', untilIso: '2026-11-02T14:00:00Z', rep: 'repA' }, {}).assignedTo, 'repA');
  assert.equal(followUpTask({ label: 'in November', untilIso: '2026-11-02T14:00:00Z' }, {}).assignedTo, JOHN);
  const posted = [];
  await filePostDemoFollowUp({ contactId: 'c1', deferral: { untilIso: '2026-11-02T14:00:00Z', label: 'in November' } }, {
    env: {}, log: () => {},
    getContact: async () => ({ followers: [], customFields: field('repF') }),
    ghlFetch: async (m, path, body) => { if (path.endsWith('/tasks')) posted.push(body); return {}; },
    applyGHLTag: async () => {}, addGHLNote: async () => {},
    filterNew: async ({ items }) => ({ fresh: items }), recordPosted: async () => {}, emitEvent: async () => {},
  });
  assert.equal(posted[0]?.assignedTo, 'repF');
});
