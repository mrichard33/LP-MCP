/**
 * Post-issue rule (Reece Training Manual pp. 22–24, 2026-10-09): a lead LP has
 * issued to a rep never takes another appointment. A new LP lead under the
 * prospect carries the issued lead's Source / Sub-Source / Promoter, or a newer
 * lead inbounded since takes it. src/lp-post-issue.js (pure),
 * src/lp-post-issue-rebook.js (reads, the direct addLead, events, Slack) and
 * src/jobs/post-issue-rebook-retry.js (retry before a person is asked).
 *
 * Polarity (CANON.RULE.240): cases 1–4 must NOT trigger, 5–14 must. Cases 15–16
 * are the two real leads from 2026-10-09 (CANON.RULE.241). Cases 17+ are Mark's
 * follow-up the same day: as few people as possible.
 *
 * Run: node --test scripts/test-post-issue-rebook.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPostIssueLead, POST_ISSUE_DISPOSITIONS, PRE_ISSUE_DISPOSITIONS, postIssueMode, appointmentOnLead,
  pickNewerLead, pendingInboundRow, resolveAttribution, resolveSubSource, parsePromoterCatalog, ghlTime12h,
  rebookKey, buildRebookLeadFields,
} from '../src/lp-post-issue.js';
import { postIssueGate, gateVerdict, formatPostIssueCard, __resetPostIssueCacheForTests } from '../src/lp-post-issue-rebook.js';
import { pendingRetries, runPostIssueRetryPass, MAX_ATTEMPTS } from '../src/jobs/post-issue-rebook-retry.js';
import { syncAppointmentToLP } from '../src/lp-appointment-sync.js';
import { executeSetLPAppointment } from '../src/actions/handlers/lp-appointment.js';
import { assertNotTransposed } from '../src/lp-source-ids.js';

// ─── fixtures ──────────────────────────────────────────────────────────────

let apptSeq = 0;
const appt = (apptdate, issued = false, disposition = 'Set') => ({ id: String(++apptSeq), apptdate, issued: issued ? 'true' : 'false', disposition });

const PROSPECT = (over = {}) => ({ firstname: 'Pat', lastname: 'Lee', address1: '1 Main St', city: 'Sarasota', state: 'FL', zip: '34233', email: '', ...over });

// LP lead 190599 / prospect 158825 (Heather Faling) as lp_leads held it on 2026-10-09.
const HEATHER = {
  lp_lead_id: '190599', lp_prospect_id: '158825', disposition_code: 'CCC', phone: '9417269363',
  created_at_lp: '2022-10-12T12:18:24.393+00:00', promoter_name: 'Clements, William - SARA',
  lead_source: 'Canvass', lead_source_detail: 'Canvass',
  prospectRecord: PROSPECT({ firstname: 'Heather', lastname: 'Faling' }),
  raw_lp_data: {
    srs_id: '344',
    appointments: [
      appt('2022-01-04T18:00:00'), appt('2026-10-09T18:00:00'),
      appt('2026-10-09T18:00:00', false, 'Cnf'), appt('2026-10-09T18:00:00', true, 'CCC'),
    ],
  },
};

// LP lead 581387 / prospect 258904 (Erica / Roger): pre-issue Set, moved 10/9 → 10/12.
const ERICA = {
  lp_lead_id: '581387', lp_prospect_id: '258904', disposition_code: 'Set', phone: '8036068219',
  created_at_lp: '2026-10-05T18:00:44.397+00:00', promoter_name: 'Cantalamessa, Masyn - SARA',
  raw_lp_data: { srs_id: '344', appointments: [appt('2026-10-09T18:00:00'), appt('2026-10-12T18:00:00')] },
};

const lead = (over = {}) => ({
  lp_lead_id: '500001', lp_prospect_id: '400001', disposition_code: 'Issue', phone: '5555550101',
  created_at_lp: '2026-09-01T10:00:00+00:00', promoter_name: 'Clements, William - SARA',
  lead_source: 'Canvass', lead_source_detail: 'Canvass',
  raw_lp_data: { srs_id: '344', in1_id: '420000', appointments: [appt('2026-09-05T18:00:00', true, 'Issue')] },
  ...over,
});

const CATALOG = [
  { key: '6075', value: 'Clements, William - SARA' },
  { key: '6193', value: 'Cantalamessa, Masyn - SARA' },
  { key: '5574', value: 'Reece ChatBot, Website' },
  { key: '1111', value: 'Stanley, Michael' }, { key: '2222', value: 'Stanley, Michael' },
  { key: '410', value: '3rd Party Canvasser, 3rd Party' },
];
const SOURCE_CATALOG = [
  { lp_source_id: '344', lp_source_raw: 'Canvass', lp_source_subdetail: 'Canvass', active: true },
  { lp_source_id: '439', lp_source_raw: 'Internet', lp_source_subdetail: 'Modernize', active: true },
];

const CONTACT = 'abcDEFghiJKLmno12345';
const NOW = Date.parse('2026-10-09T20:00:00Z');

// A tiny PostgREST stand-in: select/eq/neq/gte/order/limit/maybeSingle/insert/delete.
function fakeDb(tables = {}, fail = {}) {
  const get = (r, col) => {
    if (col.includes('->>')) { const [a, b] = col.split('->>'); return r?.[a]?.[b] == null ? null : String(r[a][b]); }
    return r?.[col] == null ? null : String(r[col]);
  };
  return {
    tables,
    from(table) {
      const filters = [];
      let op = 'select';
      let payload = null;
      const run = async () => {
        if (fail[table]) return { data: null, error: { message: `${table} down` } };
        if (op === 'insert') {
          const list = tables[table] || (tables[table] = []);
          if (table === 'lp_appointment_sync_marks' && list.some((r) => r.dedup_key === payload.dedup_key)) {
            return { data: null, error: { code: '23505', message: 'duplicate key value' } };
          }
          list.push(payload);
          return { data: null, error: null };
        }
        if (op === 'delete') {
          tables[table] = (tables[table] || []).filter((r) => !filters.every((f) => f(r)));
          return { data: null, error: null };
        }
        return { data: (tables[table] || []).filter((r) => filters.every((f) => f(r))), error: null };
      };
      const q = {
        select: () => q,
        eq: (col, val) => { filters.push((r) => get(r, col) === String(val)); return q; },
        neq: (col, val) => { filters.push((r) => get(r, col) !== String(val)); return q; },
        gte: (col, val) => { filters.push((r) => String(r[col]) >= String(val)); return q; },
        order: () => q,
        limit: () => q,
        insert: (r) => { op = 'insert'; payload = r; return run(); },
        delete: () => { op = 'delete'; return q; },
        maybeSingle: async () => { const r = await run(); return r.error ? r : { data: r.data[0] || null, error: null }; },
        then: (res, rej) => run().then(res, rej),
      };
      return q;
    },
  };
}

/** A live LP GetLead answer for one lead (prospect envelope). */
const liveOf = (l) => [{
  cst_id: l.lp_prospect_id, phone1: l.phone, ...(l.prospectRecord || PROSPECT()),
  leads: [{
    id: l.lp_lead_id, disposition: l.disposition_code, promotername: l.promoter_name,
    source: l.lead_source, sourcesubdescr: l.lead_source_detail, productid: 'Win',
    srs_id: l.raw_lp_data?.srs_id, in1_id: l.raw_lp_data?.in1_id, dateentered: String(l.created_at_lp).slice(0, 19),
    appointments: l.raw_lp_data?.appointments || [],
  }],
}];

function harness({ mode = 'live', leads = [], inbound = [], fail = {}, liveFails = false, prospectFails = false,
  catalog = CATALOG, addLead, inboundInfo } = {}) {
  __resetPostIssueCacheForTests();
  const seen = { events: [], slack: [], fieldWrites: [], adds: [], notes: [], tags: [], alerts: [] };
  const db = fakeDb({
    lp_leads: leads.map(({ prospectRecord, ...l }) => ({ ...l })),
    lp_inbound_queue: inbound, lp_appointment_sync_marks: [], system_events: [], lp_source_catalog: SOURCE_CATALOG,
  }, fail);
  let clock = NOW;
  const deps = {
    nowMs: NOW,
    env: { LP_POST_ISSUE_NEW_LEAD_MODE: mode, SLACK_CHANNEL_SERVICE: 'C_CONTACT_CENTER' },
    supabase: db,
    sleep: async () => {},
    getLeadByLdsId: async (id) => {
      if (liveFails) throw new Error('LP 500');
      const l = leads.find((x) => x.lp_lead_id === String(id));
      return l ? liveOf(l) : [];
    },
    getProspectByCstId: async (cst) => {
      if (liveFails || prospectFails) throw new Error('LP 500');
      const mine = leads.filter((x) => x.lp_prospect_id === String(cst));
      if (!mine.length) return [];
      const env = liveOf(mine[0]);
      env[0].leads = mine.flatMap((m) => liveOf(m)[0].leads);
      return env;
    },
    getPromoters: async () => { if (!catalog) throw new Error('LP 500'); return catalog; },
    getInboundLeadInfo: async () => (inboundInfo ? inboundInfo() : []),
    addLead: async (f) => { seen.adds.push(f); if (addLead) return addLead(f, seen.adds.length); return { status: 'OK', message: 'lead added: 431000', _path: 'legacy' }; },
    extractInboundLeadId: (resp) => (String(resp?.message || '').match(/(\d+)\s*$/) || [])[1] || null,
    updateGHLContactFields: async (id, f) => { seen.fieldWrites.push(f); return true; },
    addGHLNote: async (id, t) => { seen.notes.push(t); },
    applyGHLTag: async (id, t) => { seen.tags.push(t); },
    postToSlack: async (text, ch) => { seen.slack.push({ text, ch }); return { ok: true }; },
    opsChannelId: () => 'C_OPS',
    sendAlertMessage: async (t) => { seen.alerts.push(t); },
    filterNew: async ({ items }) => ({ fresh: items }),
    recordPosted: async () => ({ ok: true }),
    emitEvent: async (e) => {
      seen.events.push(e);
      clock += 1000;
      db.tables.system_events.push({ ...e, created_at: new Date(clock).toISOString() });
      return { ok: true };
    },
  };
  return { deps, seen, db };
}

const gateArgs = (l, over = {}) => ({
  caller: 'test', contactId: CONTACT, ldsId: l.lp_lead_id, prospectId: l.lp_prospect_id,
  appointmentDate: '2026-10-16', appointmentTime: '18:00', phone: l.phone, ...over,
});

const outcomes = (seen) => seen.events.map((e) => e.event_subtype);

const syncDeps = (l, deps, set, over = {}) => ({
  lpAlreadyHasAppointment: async () => false,
  checkConfirmationCallSlot: async () => ({ blocked: false }),
  resolveLPLeadId: async () => ({ ldsId: l.lp_lead_id, prospectId: l.lp_prospect_id, source: 's', step: 0, disp: l.disposition_code }),
  postDemoLock: async () => ({ locked: false }),
  lpSetAppointment: async (a) => { set.push(a.ldsId); return { Result: 0 }; },
  postIssueGate: (o) => postIssueGate(o, deps),
  ...over,
});

// ═══ Pure rule ═════════════════════════════════════════════════════════════

test('every listed post-issue disposition is post-issue; every pre-issue one is not', () => {
  for (const d of POST_ISSUE_DISPOSITIONS) assert.equal(isPostIssueLead({ disposition_code: d }).postIssue, true, d);
  for (const d of PRE_ISSUE_DISPOSITIONS) {
    const v = isPostIssueLead({ disposition_code: d, raw_lp_data: { appointments: [appt('2026-10-01T18:00:00')] } });
    assert.deepEqual([v.postIssue, v.reason], [false, 'pre_issue'], d);
  }
  assert.equal(isPostIssueLead({ disposition_code: ' no demo ' }).postIssue, true, 'case and spaces');
});

test('LP\'s issued flag wins over a pre-issue disposition (CXL after a rep went out)', () => {
  const v = isPostIssueLead({ disposition_code: 'CXL', raw_lp_data: { appointments: [appt('2026-10-01T18:00:00', true, 'CXL')] } });
  assert.deepEqual([v.postIssue, v.reason], [true, 'lp_issued_flag']);
  assert.equal(isPostIssueLead({ disposition_code: 'Set', everissued: 'true' }).reason, 'lp_issued_flag');
});

test('a stale lp_leads Set is post-issue when the caller\'s live disposition says Issue', () => {
  assert.equal(isPostIssueLead({ disposition_code: 'Set' }, { knownDisposition: 'Issue' }).postIssue, true);
});

test('blank disposition, no history → unknown_new_lead; a disposition in neither list is ambiguous', () => {
  assert.equal(isPostIssueLead({ disposition_code: '', raw_lp_data: {} }).reason, 'unknown_new_lead');
  assert.equal(isPostIssueLead(null).reason, 'unknown_new_lead');
  const v = isPostIssueLead({ disposition_code: 'Soft Confirm' });
  assert.deepEqual([v.postIssue, v.ambiguous], [false, true]);
});

test('mode defaults to shadow; only off and live switch it', () => {
  assert.equal(postIssueMode({}), 'shadow');
  assert.equal(postIssueMode({ LP_POST_ISSUE_NEW_LEAD_MODE: 'LIVE' }), 'live');
  assert.equal(postIssueMode({ LP_POST_ISSUE_NEW_LEAD_MODE: 'off' }), 'off');
  assert.equal(postIssueMode({ LP_POST_ISSUE_NEW_LEAD_MODE: 'yes' }), 'shadow');
});

test('promoter: matched exactly once → sent; anything uncertain → blank, never 830/5574, never a stop', () => {
  const cat = parsePromoterCatalog(CATALOG);
  const base = { srsId: '344', promoterName: 'Clements, William - SARA', catalog: cat, assertNotTransposed };
  assert.deepEqual(resolveAttribution(base), { ok: true, srsId: '344', srsSource: 'lead', proId: '6075', promoterStatus: 'matched' });
  for (const [over, status] of [
    [{ promoterName: '' }, 'no_promoter_on_issued_lead'],
    [{ promoterName: 'Nobody, Here' }, 'promoter_not_in_lp_catalog'],
    [{ promoterName: 'Stanley, Michael' }, 'promoter_name_ambiguous'],
    [{ promoterName: '3rd Party Canvasser, 3rd Party' }, 'pro_id_not_4_digit'],
    [{ catalog: null }, 'promoter_catalog_unreadable'],
  ]) {
    const a = resolveAttribution({ ...base, ...over });
    assert.deepEqual([a.ok, a.proId, a.promoterStatus], [true, null, status], status);
  }
});

test('Sub-Source: the lead\'s own, then lp_source_catalog by name, then the issued lead\'s inbound row', () => {
  assert.deepEqual(resolveSubSource({ srsId: '344' }), { srsId: '344', srsSource: 'lead' });
  assert.deepEqual(resolveSubSource({ srsId: '0', leadSource: 'canvass', leadSourceDetail: 'CANVASS', sourceCatalog: SOURCE_CATALOG }), { srsId: '344', srsSource: 'source_catalog' });
  assert.deepEqual(resolveSubSource({ srsId: '0', leadSource: 'Nope', leadSourceDetail: 'Nope', sourceCatalog: SOURCE_CATALOG, inboundSrs: '811' }), { srsId: '811', srsSource: 'inbound_row' });
  assert.equal(resolveSubSource({ srsId: '5574', sourceCatalog: [], inboundSrs: '0' }), null, 'a 4-digit id is a promoter, not a Sub-Source');
  assert.deepEqual(resolveAttribution({ srsId: '0', catalog: [] }), { ok: false, reason: 'srs_id_unresolvable' });
});

test('the new lead\'s body comes from LP\'s prospect record; no name or phone → null', () => {
  const f = buildRebookLeadFields({
    prospect: { ...PROSPECT(), phone1: '(555) 555-0101' }, srsId: '344', proId: null, dateYmd: '2026-10-16', timeHHMM: '18:00',
    contactId: CONTACT, issuedLeadId: '500001', issuedDisposition: 'Issue',
  });
  assert.equal(f.phone, '5555550101');
  assert.deepEqual([f.srs_id, f.pro_id, f.apptdate, f.appttime, f.lognumber], ['344', '', '10/16/2026', '6:00 PM', CONTACT]);
  assert.ok(!('TextOptIn' in f) && !('HasConsent' in f), 'no consent asserted for a returning prospect');
  assert.match(f.notes, /500001 was already issued \(Issue\)/);
  assert.equal(buildRebookLeadFields({ prospect: { ...PROSPECT(), phone1: '' }, srsId: '344' }), null);
  assert.equal(buildRebookLeadFields({ prospect: { ...PROSPECT({ firstname: '' }), phone1: '5555550101' }, srsId: '344' }), null);
  assert.equal(buildRebookLeadFields({ prospect: { ...PROSPECT(), phone1: '5555550101' }, srsId: '344', contactId: '500001' }).lognumber, undefined, 'an LP id is not a lognumber');
});

test('same date and time already on the lead is the issued appointment, not a rebook', () => {
  assert.equal(appointmentOnLead(HEATHER, '2026-10-09', '18:00'), true);
  assert.equal(appointmentOnLead(HEATHER, '2026-10-09', '14:00'), false);
  assert.equal(appointmentOnLead(HEATHER, '2026-10-16', '18:00'), false);
});

test('newer lead: entered after the issued one and not itself issued; the newest wins', () => {
  const issued = lead();
  const older = lead({ lp_lead_id: '499999', created_at_lp: '2026-08-01T10:00:00+00:00', disposition_code: 'Data', raw_lp_data: {} });
  const newerIssued = lead({ lp_lead_id: '500002', created_at_lp: '2026-09-10T10:00:00+00:00', disposition_code: 'NoHome' });
  const newer = lead({ lp_lead_id: '500003', created_at_lp: '2026-09-20T10:00:00+00:00', disposition_code: 'Data', raw_lp_data: {} });
  const newest = lead({ lp_lead_id: '500004', created_at_lp: '2026-09-25T10:00:00+00:00', disposition_code: 'Set', raw_lp_data: {} });
  assert.equal(pickNewerLead(issued, [issued, older, newerIssued, newer, newest]).lp_lead_id, '500004');
  assert.equal(pickNewerLead(issued, [issued, older, newerIssued]), null);
});

test('pending inbound: a waiting inquiry received after the issue counts; checked-out or killed ones do not', () => {
  const since = Date.parse('2026-10-01T00:00:00Z');
  const rows = [
    { in1_id: 'a', received_at_lp: '2026-09-20T10:00:00Z' },
    { in1_id: 'b', received_at_lp: '2026-10-05T10:00:00Z', lds_id: '590000' },
    { in1_id: 'c', received_at_lp: '2026-10-05T10:00:00Z', kill_reason: 'dup' },
    { in1_id: 'd', received_at_lp: '2026-10-06T10:00:00Z' },
  ];
  assert.equal(pendingInboundRow(rows, since).in1_id, 'd');
  assert.equal(pendingInboundRow(rows.slice(0, 3), since), null);
});

test('helpers: GHL time, idempotency key', () => {
  assert.equal(ghlTime12h('18:00'), '6:00 PM');
  assert.equal(ghlTime12h('09:30'), '9:30 AM');
  assert.equal(ghlTime12h('00:15'), '12:15 AM');
  assert.equal(rebookKey({ contactId: 'c', issuedLeadId: '1', dateYmd: '2026-10-16', timeHHMM: '18:00' }), 'post-issue-rebook:c:1:2026-10-16:18:00');
});

test('verdict: both reads failing is "could not tell"; one good read decides', () => {
  assert.equal(gateVerdict({ db: { ok: false }, live: { ok: false } }).failed, true);
  assert.equal(gateVerdict({ db: { ok: true, lead: null }, live: { ok: false } }).failed, true, 'no row + live down');
  assert.equal(gateVerdict({ db: { ok: true, lead: lead({ disposition_code: 'Set', raw_lp_data: {} }) }, live: { ok: false } }).postIssue, false);
  assert.equal(gateVerdict({ db: { ok: false }, live: { ok: true, lead: lead() } }).postIssue, true);
});

// ═══ Should NOT trigger (1–4) ══════════════════════════════════════════════

test('1. Set, no issued flag → proceeds on the existing lead', async () => {
  const l = lead({ disposition_code: 'Set', raw_lp_data: { srs_id: '344', appointments: [appt('2026-10-01T18:00:00')] } });
  const { deps, seen } = harness({ leads: [l] });
  const r = await postIssueGate(gateArgs(l), deps);
  assert.deepEqual([r.proceed, r.ldsId], [true, undefined]);
  assert.deepEqual(outcomes(seen), ['pre_issue_proceed']);
  assert.deepEqual([seen.adds.length, seen.fieldWrites.length, seen.slack.length], [0, 0, 0]);
});

test('2. Cnf / Verif, no issued flag → existing lead', async () => {
  for (const d of ['Cnf', 'Verif']) {
    const l = lead({ disposition_code: d, raw_lp_data: { srs_id: '344', appointments: [appt('2026-10-01T18:00:00', false, d)] } });
    const { deps, seen } = harness({ leads: [l] });
    assert.equal((await postIssueGate(gateArgs(l), deps)).proceed, true, d);
    assert.equal(seen.adds.length, 0, d);
  }
});

test('3. a lead minted minutes ago (blank disposition, no history) → existing lead', async () => {
  const l = lead({ disposition_code: null, raw_lp_data: {} });
  const { deps, seen } = harness({ leads: [l] });
  assert.equal((await postIssueGate(gateArgs(l), deps)).proceed, true);
  assert.deepEqual(outcomes(seen), ['pre_issue_proceed']);
});

test('4a. mode off: no reads, no events, proceeds', async () => {
  const l = lead();
  const { deps, seen } = harness({ mode: 'off', leads: [l], liveFails: true });
  assert.deepEqual(await postIssueGate(gateArgs(l), deps), { proceed: true });
  assert.equal(seen.events.length, 0);
});

test('4b. shadow with an issued lead: event + one #ops line, then today\'s path; zero side effects', async () => {
  const l = lead();
  const { deps, seen, db } = harness({ mode: 'shadow', leads: [l] });
  const r = await postIssueGate(gateArgs(l), deps);
  assert.equal(r.proceed, true);
  assert.equal(r.ldsId, undefined, 'shadow never redirects the write');
  assert.deepEqual(outcomes(seen), ['shadow_post_issue_new_lead_sent']);
  assert.equal(seen.events[0].payload.fields, undefined, 'the lead body is not stored on the event');
  assert.equal(seen.slack.length, 1);
  assert.equal(seen.slack[0].ch, 'C_OPS');
  assert.deepEqual([seen.adds.length, seen.fieldWrites.length, seen.tags.length, seen.notes.length], [0, 0, 0, 0]);
  assert.equal(db.tables.lp_appointment_sync_marks.length, 0, 'no claim written in shadow');
});

test('4c. syncAppointmentToLP in shadow sets the appointment on the issued lead exactly as before', async () => {
  const l = lead();
  const { deps } = harness({ mode: 'shadow', leads: [l] });
  const set = [];
  await syncAppointmentToLP({ contactId: CONTACT, appointmentDate: '2026-10-16', appointmentTime: '06:00 PM' }, syncDeps(l, deps, set)).catch(() => {});
  assert.deepEqual(set, ['500001']);
});

// ═══ Should trigger, live (5–14) ═══════════════════════════════════════════

test('5. issued:"true" (Issue) → no SetAppointment; the new lead goes straight to LP with the issued lead\'s attribution', async () => {
  const l = lead();
  const { deps, seen } = harness({ leads: [l] });
  const r = await postIssueGate(gateArgs(l), deps);
  assert.equal(r.proceed, false);
  assert.equal(r.result.action, 'post_issue_new_lead_sent');
  assert.equal(r.result.success, true);
  assert.deepEqual([r.result.srs_id, r.result.pro_id, r.result.promoter_status, r.result.in1_id], ['344', '6075', 'matched', '431000']);
  assert.equal(seen.adds.length, 1);
  const f = seen.adds[0];
  assert.deepEqual([f.firstname, f.phone, f.srs_id, f.pro_id, f.apptdate, f.appttime, f.lognumber, f.sender],
    ['Pat', '5555550101', '344', '6075', '10/16/2026', '6:00 PM', CONTACT, 'GHL-PostIssueRebook']);
  assert.deepEqual(seen.fieldWrites, [[{ id: '3YMxheIlPyhACB8zyc3W', field_value: '431000' }]], 'only the inquiry id is written to GHL');
  assert.ok(seen.tags.includes('lp-appt-deferred'), 'I.LP-A must not enroll a second lead');
  assert.match(seen.notes[0], /Lead 500001 was already issued/);
  assert.equal(seen.slack.length, 0, 'success needs no person');
  const ev = seen.events.at(-1);
  assert.equal(ev.event_type, 'lp.post_issue_rebook');
  assert.equal(ev.payload.idempotency_key, 'post-issue-rebook:abcDEFghiJKLmno12345:500001:2026-10-16:18:00');
});

test('6. NoHome / 1Leg / NOC / No Demo / NIS → new lead', async () => {
  for (const d of ['NoHome', '1Leg', 'NOC', 'No Demo', 'NIS']) {
    const l = lead({ disposition_code: d, raw_lp_data: { srs_id: '344', appointments: [] } });
    const { deps, seen } = harness({ leads: [l] });
    const r = await postIssueGate(gateArgs(l), deps);
    assert.equal(r.result?.action, 'post_issue_new_lead_sent', d);
    assert.equal(seen.adds.length, 1, d);
  }
});

test('7. OPPFDN / Sale → new lead, reached through syncAppointmentToLP ahead of the terminal guard', async () => {
  for (const d of ['OPPFDN', 'Sale']) {
    const l = lead({ disposition_code: d });
    const { deps, seen } = harness({ leads: [l] });
    const set = [];
    const res = await syncAppointmentToLP({ contactId: CONTACT, appointmentDate: '2026-10-16', appointmentTime: '06:00 PM' },
      syncDeps(l, deps, set, { postDemoLock: undefined }));
    assert.equal(res.action, 'post_issue_new_lead_sent', d);
    assert.deepEqual(set, [], d);
    assert.equal(seen.adds.length, 1, d);
  }
});

test('8. a newer, non-issued lead on the prospect takes the SetAppointment; no new lead', async () => {
  const issued = lead();
  const newer = lead({ lp_lead_id: '500050', created_at_lp: '2026-09-20T10:00:00+00:00', disposition_code: 'Data', raw_lp_data: { srs_id: '344', appointments: [] } });
  const { deps, seen } = harness({ leads: [issued, newer] });
  const set = [];
  await syncAppointmentToLP({ contactId: CONTACT, appointmentDate: '2026-10-16', appointmentTime: '06:00 PM' }, syncDeps(issued, deps, set)).catch(() => {});
  assert.deepEqual(set, ['500050']);
  assert.equal(seen.adds.length, 0);
  assert.ok(outcomes(seen).includes('used_newer_lead'));
});

test('9. a waiting inquiry for the phone → no new lead and no card (inbound-checkout-watch owns it)', async () => {
  const l = lead();
  const { deps, seen } = harness({ leads: [l], inbound: [{ in1_id: '429001', phone10: '5555550101', received_at_lp: '2026-10-08T15:00:00Z' }] });
  const r = await postIssueGate(gateArgs(l), deps);
  assert.equal(r.result.action, 'newer_lead_pending_in_inbound_queue');
  assert.equal(r.result.in1_id, '429001');
  assert.deepEqual([seen.adds.length, seen.slack.length], [0, 0]);
  assert.ok(seen.tags.includes('lp-appt-deferred'));
});

test('10. promoter cannot be matched → the lead is still sent, promoter blank, nobody asked (Mark, 2026-10-09)', async () => {
  for (const [over, status] of [
    [{ promoter_name: 'Nobody, Here' }, 'promoter_not_in_lp_catalog'],
    [{ promoter_name: null }, 'no_promoter_on_issued_lead'],
    [{ promoter_name: 'Stanley, Michael' }, 'promoter_name_ambiguous'],
  ]) {
    const l = lead(over);
    const { deps, seen } = harness({ leads: [l] });
    const r = await postIssueGate(gateArgs(l), deps);
    assert.equal(r.result.action, 'post_issue_new_lead_sent', status);
    assert.equal(r.result.promoter_status, status);
    assert.equal(seen.adds[0].pro_id, '', status);
    assert.ok(!JSON.stringify(seen.adds).includes('5574'), 'never the chatbot promoter');
    assert.equal(seen.slack.length, 0, status);
  }
});

test('10b. srs_id 0 → Sub-Source from lp_source_catalog; none anywhere → one card, nothing sent', async () => {
  const l = lead({ raw_lp_data: { srs_id: '0', in1_id: '420000', appointments: [appt('2026-09-05T18:00:00', true)] } });
  const { deps, seen } = harness({ leads: [l] });
  const r = await postIssueGate(gateArgs(l), deps);
  assert.deepEqual([r.result.action, r.result.srs_id, r.result.srs_source], ['post_issue_new_lead_sent', '344', 'source_catalog']);

  const none = lead({ lead_source: 'Mystery', lead_source_detail: 'Mystery', raw_lp_data: { srs_id: '0', appointments: [appt('2026-09-05T18:00:00', true)] } });
  const h = harness({ leads: [none] });
  const r2 = await postIssueGate(gateArgs(none), h.deps);
  assert.deepEqual([r2.result.action, r2.result.reason], ['post_issue_needs_manual_lead', 'srs_id_unresolvable']);
  assert.equal(h.seen.adds.length, 0);
  assert.equal(h.seen.slack.length, 1);
  assert.equal(h.seen.slack[0].ch, 'C_CONTACT_CENTER');
  assert.equal(h.db.tables.lp_appointment_sync_marks.length, 0, 'claim released');
});

test('11. lp_leads AND LP live both fail (after one quick retry) → fail closed, no card yet: the retry job tries first', async () => {
  const l = lead();
  const { deps, seen } = harness({ leads: [l], fail: { lp_leads: true }, liveFails: true });
  const set = [];
  const res = await syncAppointmentToLP({ contactId: CONTACT, appointmentDate: '2026-10-16', appointmentTime: '06:00 PM' }, syncDeps(l, deps, set));
  assert.deepEqual([res.action, res.reason, res.retryable], ['post_issue_check_failed', 'lead_unreadable', true]);
  assert.deepEqual([set.length, seen.adds.length, seen.slack.length], [0, 0, 0]);
});

test('11b. a disposition in neither list fails closed in live (retryable)', async () => {
  const l = lead({ disposition_code: 'Soft Confirm', raw_lp_data: { srs_id: '344', appointments: [] } });
  const { deps, seen } = harness({ leads: [l] });
  const r = await postIssueGate(gateArgs(l), deps);
  assert.equal(r.result.action, 'post_issue_check_failed');
  assert.match(r.result.reason, /unrecognised_disposition/);
  assert.equal(seen.adds.length, 0);
});

test('12. addLead throws → send_failed, claim released, no card; a re-try that finds the row in LP sends nothing twice', async () => {
  const l = lead();
  const h = harness({ leads: [l], addLead: () => { throw new Error('LP timeout'); } });
  const r = await postIssueGate(gateArgs(l), h.deps);
  assert.deepEqual([r.result.action, r.result.retryable], ['post_issue_send_failed', true]);
  assert.equal(h.db.tables.lp_appointment_sync_marks.length, 0);
  assert.equal(h.seen.slack.length, 0);
  // LP did take it after all: LP's inbound read by lognumber shows the row.
  h.deps.getInboundLeadInfo = async () => [{ id: '431777', datereceived: '2026-10-09T16:01:00' }];
  const again = await postIssueGate(gateArgs(l), h.deps);
  assert.equal(again.result.action, 'post_issue_new_lead_sent');
  assert.equal(again.result.in1_id, '431777');
  assert.equal(h.seen.adds.length, 1, 'addLead ran once, never twice');
});

test('12b. a prospect with no phone → one card, nothing sent', async () => {
  const l = { ...lead(), prospectRecord: PROSPECT(), phone: '' };
  const { deps, seen } = harness({ leads: [l] });
  const r = await postIssueGate(gateArgs(l, { phone: '' }), deps);
  assert.deepEqual([r.result.action, r.result.reason], ['post_issue_needs_manual_lead', 'prospect_has_no_name_or_phone']);
  assert.equal(seen.adds.length, 0);
  assert.equal(seen.slack[0].ch, 'C_CONTACT_CENTER');
});

test('13. the same webhook twice → exactly one new lead; the second returns the recorded outcome', async () => {
  const l = lead();
  const { deps, seen } = harness({ leads: [l] });
  const first = await postIssueGate(gateArgs(l), deps);
  const second = await postIssueGate(gateArgs(l), deps);
  assert.equal(first.result.action, 'post_issue_new_lead_sent');
  assert.equal(second.result.action, 'post_issue_rebook_duplicate');
  assert.equal(second.result.recorded_outcome, 'post_issue_new_lead_sent');
  assert.equal(second.result.success, true);
  assert.equal(seen.adds.length, 1);
});

test('14. the parity watchdog on an issued lead → refused, no new lead, no card', async () => {
  const l = lead();
  const { deps, seen } = harness({ leads: [l] });
  const set = [];
  const res = await syncAppointmentToLP({ contactId: CONTACT, appointmentDate: '2026-10-16', appointmentTime: '06:00 PM', requireBookable: true },
    syncDeps(l, deps, set));
  assert.equal(res.action, 'skipped_post_issue_lead');
  assert.deepEqual([set.length, seen.adds.length, seen.slack.length], [0, 0, 0]);
});

test('14b. set_lp_appointment on a bare LP lead id that is issued → the new lead is sent without a person', async () => {
  const l = lead({ ghl_contact_id: CONTACT });
  const { deps, seen } = harness({ leads: [l] });
  const res = await executeSetLPAppointment(
    { target_id: '500001', action_payload: { appt_date: '2026-10-16', appt_time: '18:00' } },
    { deps: { postIssueGate: (o) => postIssueGate(o, deps) } },
  );
  assert.equal(res.action, 'post_issue_new_lead_sent');
  assert.equal(seen.adds[0].lognumber, CONTACT, 'lognumber from lp_leads.ghl_contact_id');
  assert.deepEqual(seen.fieldWrites, [], 'no GHL contact on the call, no GHL write');
});

// ═══ Real incidents (15–16) ════════════════════════════════════════════════

test('15. Heather Faling (prospect 158825, lead 190599, CCC after an issued 10/9 visit): a reschedule is a NEW lead', async () => {
  const { deps, seen } = harness({ leads: [HEATHER] });
  const r = await postIssueGate(gateArgs(HEATHER, { appointmentDate: '2026-10-16', appointmentTime: '18:00' }), deps);
  assert.equal(r.proceed, false, 'no fifth appointment row on 190599');
  assert.equal(r.result.action, 'post_issue_new_lead_sent');
  assert.equal(r.result.issued_reason, 'lp_issued_flag');
  assert.deepEqual([r.result.srs_id, r.result.pro_id], ['344', '6075'], 'Canvass / Clements, William - SARA mirrored');
  assert.deepEqual([seen.adds[0].firstname, seen.adds[0].lastname], ['Heather', 'Faling']);
});

test('15b. Heather: the issued 10/9 6 PM appointment re-sent is not a rebook (no new lead, no write)', async () => {
  const { deps, seen } = harness({ leads: [HEATHER] });
  const r = await postIssueGate(gateArgs(HEATHER, { appointmentDate: '2026-10-09', appointmentTime: '18:00' }), deps);
  assert.equal(r.proceed, false);
  assert.equal(r.result.action, 'already_set_in_lp');
  assert.equal(r.result.post_issue_outcome, 'same_appointment_on_issued_lead');
  assert.deepEqual([seen.adds.length, seen.fieldWrites.length, seen.slack.length], [0, 0, 0]);
});

test('16. Erica / Roger (lead 581387, pre-issue Set) moved 10/9 → 10/12 stays on the same lead', async () => {
  const { deps, seen } = harness({ leads: [ERICA] });
  const set = [];
  await syncAppointmentToLP({ contactId: 'THHRENLYFDRKGUKUGFgw', appointmentDate: '2026-10-12', appointmentTime: '06:00 PM' },
    syncDeps(ERICA, deps, set)).catch(() => {});
  assert.deepEqual(set, ['581387']);
  assert.deepEqual(outcomes(seen), ['pre_issue_proceed']);
  assert.equal(seen.adds.length, 0);
});

// ═══ Retry before a person (17+) ═══════════════════════════════════════════

const ev = (outcome, minutesAgo, extra = {}) => ({
  created_at: new Date(NOW - minutesAgo * 60_000).toISOString(),
  payload: { mode: 'live', idempotency_key: 'k1', outcome, contact_id: CONTACT, ghl_contact: true, issued_lead_id: '500001', appt_date: '2026-10-16', appt_time: '18:00', ...extra },
});

test('17. pendingRetries: retry a fresh failure, wait 10 min between tries, give up at 3 tries or 2 hours, stop on success', () => {
  assert.deepEqual(pendingRetries([ev('post_issue_check_failed', 15)], NOW).map((p) => [p.attempts, p.giveUp]), [[1, false]]);
  assert.deepEqual(pendingRetries([ev('post_issue_check_failed', 5)], NOW), [], 'too soon');
  assert.equal(pendingRetries([ev('post_issue_check_failed', 50), ev('post_issue_send_failed', 30), ev('post_issue_send_failed', 15)], NOW)[0].giveUp, true);
  assert.equal(MAX_ATTEMPTS, 3);
  assert.equal(pendingRetries([ev('post_issue_check_failed', 130)], NOW)[0].giveUp, true, '2 hours');
  assert.deepEqual(pendingRetries([ev('post_issue_check_failed', 50), ev('post_issue_new_lead_sent', 30)], NOW), []);
  assert.deepEqual(pendingRetries([ev('post_issue_check_failed', 50, { gave_up: true })], NOW), [], 'already gave up');
  assert.deepEqual(pendingRetries([{ ...ev('post_issue_check_failed', 50), payload: { ...ev('x', 0).payload, mode: 'shadow', outcome: 'post_issue_check_failed' } }], NOW), [], 'shadow never retried');
});

test('18. the retry job re-drives through syncAppointmentToLP; a good result stops the key', async () => {
  const { deps, seen, db } = harness();
  db.tables.system_events.push({ event_type: 'lp.post_issue_rebook', ...ev('post_issue_check_failed', 15) });
  const calls = [];
  const res = await runPostIssueRetryPass({
    ...deps, syncAppointmentToLP: async (a) => { calls.push(a); return { action: 'post_issue_new_lead_sent' }; },
    executeSetLPAppointment: async () => { throw new Error('not this path'); },
  });
  assert.deepEqual([res.retried, res.resolved], [1, 1]);
  assert.deepEqual([calls[0].contactId, calls[0].appointmentDate, calls[0].appointmentTime], [CONTACT, '2026-10-16', '18:00']);
  assert.equal(outcomes(seen).at(-1), 'post_issue_retry_resolved');
  assert.equal(seen.slack.length, 0);
});

test('19. the retry job gives up after 3 tries with ONE #contact-center card', async () => {
  const { deps, seen, db } = harness();
  for (const e of [ev('post_issue_check_failed', 60), ev('post_issue_check_failed', 40), ev('post_issue_check_failed', 20)]) {
    db.tables.system_events.push({ event_type: 'lp.post_issue_rebook', ...e });
  }
  const res = await runPostIssueRetryPass({ ...deps, syncAppointmentToLP: async () => { throw new Error('must not re-drive'); }, executeSetLPAppointment: async () => {} });
  assert.equal(res.gave_up, 1);
  assert.equal(seen.slack.length, 1);
  assert.equal(seen.slack[0].ch, 'C_CONTACT_CENTER');
  assert.match(seen.slack[0].text, /Tried 3 time/);
  const again = await runPostIssueRetryPass({ ...deps, syncAppointmentToLP: async () => {}, executeSetLPAppointment: async () => {} });
  assert.equal(again.gave_up, 0, 'the gave_up event stops the key');
});

test('20. the retry job does nothing outside live mode', async () => {
  const { deps } = harness({ mode: 'shadow' });
  assert.deepEqual(await runPostIssueRetryPass(deps), { ok: true, skipped: 'not_live' });
});

// ═══ The card ══════════════════════════════════════════════════════════════

test('the #contact-center card names the person, the leads, the reason and the one thing to do', () => {
  const text = formatPostIssueCard({
    mode: 'live', outcome: 'post_issue_needs_manual_lead', caller: 'sync_appointment_to_lp',
    contact_id: CONTACT, contact_name: 'Heather Faling', phone: '9417269363', lp_prospect_id: '158825',
    issued_lead_id: '190599', issued_disposition: 'CCC', issued_reason: 'lp_issued_flag',
    appt_date: '2026-10-16', appt_time: '18:00', reason: 'srs_id_unresolvable',
  }, { GHL_LOCATION_ID: 'LOC' });
  for (const s of ['Heather Faling', '9417269363', '158825', '190599', 'CCC', '2026-10-16 18:00', 'srs_id_unresolvable', 'create a NEW lead', `contacts/detail/${CONTACT}`]) {
    assert.ok(text.includes(s), s);
  }
});
