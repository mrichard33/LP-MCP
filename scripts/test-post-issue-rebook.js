/**
 * Post-issue rule (Reece Training Manual pp. 22–24, 2026-10-09): a lead LP has
 * issued to a rep never takes another appointment. A new LP lead under the
 * prospect carries the issued lead's Source / Sub-Source / Promoter, or a newer
 * lead inbounded since takes it. src/lp-post-issue.js (pure) and
 * src/lp-post-issue-rebook.js (reads, the new-lead path, events, Slack).
 *
 * Polarity (CANON.RULE.240): cases 1–4 must NOT trigger, 5–14 must. Cases 15–16
 * are the two real leads from 2026-10-09 (CANON.RULE.241).
 *
 * Run: node --test scripts/test-post-issue-rebook.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPostIssueLead, POST_ISSUE_DISPOSITIONS, PRE_ISSUE_DISPOSITIONS, postIssueMode, appointmentOnLead,
  pickNewerLead, pendingInboundRow, resolveAttribution, parsePromoterCatalog, ghlTime12h, rebookKey,
} from '../src/lp-post-issue.js';
import { postIssueGate, gateVerdict, formatPostIssueCard, FIELD, __resetPostIssueCacheForTests } from '../src/lp-post-issue-rebook.js';
import { syncAppointmentToLP } from '../src/lp-appointment-sync.js';
import { executeSetLPAppointment } from '../src/actions/handlers/lp-appointment.js';
import { assertNotTransposed } from '../src/lp-source-ids.js';

// ─── fixtures ──────────────────────────────────────────────────────────────

const appt = (apptdate, issued = false, disposition = 'Set') => ({ id: String(Math.random()).slice(2, 8), apptdate, issued: issued ? 'true' : 'false', disposition });

// LP lead 190599 / prospect 158825 (Heather Faling) as lp_leads held it on 2026-10-09.
const HEATHER = {
  lp_lead_id: '190599', lp_prospect_id: '158825', disposition_code: 'CCC', phone: '9417269363',
  created_at_lp: '2022-10-12T12:18:24.393+00:00', promoter_name: 'Clements, William - SARA',
  lead_source: 'Canvass', lead_source_detail: 'Canvass',
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
  raw_lp_data: { srs_id: '344', appointments: [appt('2026-09-05T18:00:00', true, 'Issue')] },
  ...over,
});

const CATALOG = [
  { key: '6075', value: 'Clements, William - SARA' },
  { key: '6193', value: 'Cantalamessa, Masyn - SARA' },
  { key: '5574', value: 'Reece ChatBot, Website' },
  { key: '1111', value: 'Stanley, Michael' }, { key: '2222', value: 'Stanley, Michael' },
  { key: '410', value: '3rd Party Canvasser, 3rd Party' },
];

const CONTACT = 'abcDEFghiJKLmno12345';
const NOW = Date.parse('2026-10-09T20:00:00Z');

// A tiny PostgREST stand-in: select/eq/neq/order/limit/maybeSingle/insert/delete.
function fakeDb(tables = {}, fail = {}) {
  const get = (r, col) => {
    if (col.includes('->>')) { const [a, b] = col.split('->>'); return r?.[a]?.[b] == null ? null : String(r[a][b]); }
    return r?.[col] == null ? null : String(r[col]);
  };
  const db = {
    tables,
    from(table) {
      const filters = [];
      let op = 'select';
      let payload = null;
      const rows = () => (tables[table] || []).filter((r) => filters.every((f) => f(r)));
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
          const keep = (tables[table] || []).filter((r) => !filters.every((f) => f(r)));
          tables[table] = keep;
          return { data: null, error: null };
        }
        return { data: rows(), error: null };
      };
      const q = {
        select: () => q,
        eq: (col, val) => { filters.push((r) => get(r, col) === String(val)); return q; },
        neq: (col, val) => { filters.push((r) => get(r, col) !== String(val)); return q; },
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
  return db;
}

/** A live LP GetLead answer for one lead (prospect envelope). */
const liveOf = (l) => [{
  cst_id: l.lp_prospect_id, phone1: l.phone,
  leads: [{
    id: l.lp_lead_id, disposition: l.disposition_code, promotername: l.promoter_name,
    srs_id: l.raw_lp_data?.srs_id, dateentered: String(l.created_at_lp).slice(0, 19),
    appointments: l.raw_lp_data?.appointments || [],
  }],
}];

function harness({ mode = 'live', leads = [], inbound = [], fail = {}, liveFails = false, liveLead = undefined,
  catalog = CATALOG, enroll, fieldWrite, contact } = {}) {
  __resetPostIssueCacheForTests();
  const seen = { events: [], slack: [], fieldWrites: [], enrolls: [], notes: [], tags: [], alerts: [] };
  const db = fakeDb({ lp_leads: leads.map((l) => ({ ...l })), lp_inbound_queue: inbound, lp_appointment_sync_marks: [], system_events: [] }, fail);
  const deps = {
    nowMs: NOW,
    env: { LP_POST_ISSUE_NEW_LEAD_MODE: mode, SLACK_CHANNEL_SERVICE: 'C_CONTACT_CENTER' },
    supabase: db,
    getLeadByLdsId: async (id) => {
      if (liveFails) throw new Error('LP 500');
      if (liveLead !== undefined) return liveLead;
      const l = leads.find((x) => x.lp_lead_id === String(id));
      return l ? liveOf(l) : [];
    },
    getProspectByCstId: async () => { throw new Error('not used'); },
    getPromoters: async () => { if (!catalog) throw new Error('LP 500'); return catalog; },
    getGHLContact: async () => (contact === undefined ? {
      id: CONTACT,
      customFields: [
        { id: FIELD.SRS, value: '830' }, { id: FIELD.PRO, value: '5574' },
        { id: FIELD.APPT_DATE, value: '2026-10-01' }, { id: FIELD.APPT_TIME, value: '2:00 PM' },
      ],
    } : contact),
    updateGHLContactFields: async (id, f) => { seen.fieldWrites.push(f); return fieldWrite ? fieldWrite(seen.fieldWrites.length) : true; },
    enrollLpLeadCreation: async (a) => { seen.enrolls.push(a); if (enroll) return enroll(a); return { success: true, action: 'enrolled_lead_creation_workflow' }; },
    addGHLNote: async (id, t) => { seen.notes.push(t); },
    applyGHLTag: async (id, t) => { seen.tags.push(t); },
    postToSlack: async (text, ch) => { seen.slack.push({ text, ch }); return { ok: true }; },
    opsChannelId: () => 'C_OPS',
    sendAlertMessage: async (t) => { seen.alerts.push(t); },
    filterNew: async ({ items }) => ({ fresh: items }),
    recordPosted: async () => ({ ok: true }),
    emitEvent: async (e) => { seen.events.push(e); db.tables.system_events.push({ ...e, created_at: new Date().toISOString() }); return { ok: true }; },
  };
  return { deps, seen, db };
}

const gateArgs = (l, over = {}) => ({
  caller: 'test', contactId: CONTACT, ldsId: l.lp_lead_id, prospectId: l.lp_prospect_id,
  appointmentDate: '2026-10-16', appointmentTime: '18:00', phone: l.phone, ...over,
});

const outcomes = (seen) => seen.events.map((e) => e.event_subtype);

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

test('attribution: certain or nothing, never the chatbot fallback', () => {
  const cat = parsePromoterCatalog(CATALOG);
  const ok = resolveAttribution({ srsId: '344', promoterName: 'Clements, William - SARA', catalog: cat, assertNotTransposed });
  assert.deepEqual(ok, { ok: true, srsId: '344', proId: '6075' });
  const reason = (o) => resolveAttribution({ srsId: '344', promoterName: 'Clements, William - SARA', catalog: cat, assertNotTransposed, ...o }).reason;
  assert.equal(reason({ promoterName: '' }), 'no_promoter_on_issued_lead');
  assert.equal(reason({ promoterName: 'Nobody, Here' }), 'promoter_not_in_lp_catalog');
  assert.equal(reason({ promoterName: 'Stanley, Michael' }), 'promoter_name_ambiguous');
  assert.equal(reason({ promoterName: '3rd Party Canvasser, 3rd Party' }), 'pro_id_not_4_digit');
  assert.equal(reason({ srsId: '0' }), 'srs_id_missing_or_not_3_digit');
  assert.equal(reason({ srsId: '5574' }), 'srs_id_missing_or_not_3_digit');
  assert.equal(reason({ catalog: null }), 'promoter_catalog_unreadable');
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
  assert.deepEqual([seen.enrolls.length, seen.fieldWrites.length, seen.slack.length], [0, 0, 0]);
});

test('2. Cnf / Verif, no issued flag → existing lead', async () => {
  for (const d of ['Cnf', 'Verif']) {
    const l = lead({ disposition_code: d, raw_lp_data: { srs_id: '344', appointments: [appt('2026-10-01T18:00:00', false, d)] } });
    const { deps, seen } = harness({ leads: [l] });
    assert.equal((await postIssueGate(gateArgs(l), deps)).proceed, true, d);
    assert.equal(seen.enrolls.length, 0, d);
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
  assert.deepEqual(outcomes(seen), ['shadow_post_issue_new_lead_enrolled']);
  assert.equal(seen.slack.length, 1);
  assert.equal(seen.slack[0].ch, 'C_OPS');
  assert.match(seen.slack[0].text, /shadow/i);
  assert.deepEqual([seen.enrolls.length, seen.fieldWrites.length, seen.tags.length, seen.notes.length], [0, 0, 0, 0]);
  assert.equal(db.tables.lp_appointment_sync_marks.length, 0, 'no claim written in shadow');
});

test('4c. syncAppointmentToLP in shadow sets the appointment on the issued lead exactly as before', async () => {
  const l = lead();
  const { deps } = harness({ mode: 'shadow', leads: [l] });
  const set = [];
  await syncAppointmentToLP({ contactId: CONTACT, appointmentDate: '2026-10-16', appointmentTime: '06:00 PM' }, {
    lpAlreadyHasAppointment: async () => false,
    checkConfirmationCallSlot: async () => ({ blocked: false }),
    resolveLPLeadId: async () => ({ ldsId: l.lp_lead_id, prospectId: l.lp_prospect_id, source: 's', step: 0, disp: 'Issue' }),
    postDemoLock: async () => ({ locked: false }),
    lpSetAppointment: async (a) => { set.push(a.ldsId); return { Result: 0 }; },
    postIssueGate: (o) => postIssueGate(o, deps),
  }).catch(() => {});
  assert.deepEqual(set, ['500001']);
});

// ═══ Should trigger, live (5–14) ═══════════════════════════════════════════

test('5. issued:"true" (Issue) → no SetAppointment; fields written; enroll with force:true, no GroupMe', async () => {
  const l = lead();
  const { deps, seen } = harness({ leads: [l] });
  const r = await postIssueGate(gateArgs(l), deps);
  assert.equal(r.proceed, false);
  assert.equal(r.result.action, 'post_issue_new_lead_enrolled');
  assert.equal(r.result.success, true);
  assert.deepEqual([r.result.srs_id, r.result.pro_id], ['344', '6075']);
  assert.deepEqual(seen.enrolls, [{ contactId: CONTACT, force: true, notify: false }]);
  assert.deepEqual(seen.fieldWrites[0], [
    { id: FIELD.SRS, field_value: '344' }, { id: FIELD.PRO, field_value: '6075' },
    { id: FIELD.APPT_DATE, field_value: '2026-10-16' }, { id: FIELD.APPT_TIME, field_value: '6:00 PM' },
  ]);
  assert.match(seen.notes[0], /Lead 500001 was already issued/);
  assert.ok(seen.tags.includes('lp-appt-deferred'), 'I.LP-A must not enroll a second lead');
  assert.equal(seen.slack.length, 0, 'success needs no person');
  const ev = seen.events.at(-1);
  assert.equal(ev.event_type, 'lp.post_issue_rebook');
  assert.equal(ev.payload.idempotency_key, 'post-issue-rebook:abcDEFghiJKLmno12345:500001:2026-10-16:18:00');
  assert.deepEqual(ev.payload.previous_values[FIELD.SRS], '830');
  assert.equal(ev.payload.compensation_applied, false);
});

test('6. NoHome / 1Leg / NOC / No Demo / NIS → new lead', async () => {
  for (const d of ['NoHome', '1Leg', 'NOC', 'No Demo', 'NIS']) {
    const l = lead({ disposition_code: d, raw_lp_data: { srs_id: '344', appointments: [] } });
    const { deps, seen } = harness({ leads: [l] });
    const r = await postIssueGate(gateArgs(l), deps);
    assert.equal(r.result?.action, 'post_issue_new_lead_enrolled', d);
    assert.equal(seen.enrolls.length, 1, d);
  }
});

test('7. OPPFDN / Sale → new lead, reached through syncAppointmentToLP ahead of the terminal guard', async () => {
  for (const d of ['OPPFDN', 'Sale']) {
    const l = lead({ disposition_code: d });
    const { deps, seen } = harness({ leads: [l] });
    let set = 0;
    const res = await syncAppointmentToLP({ contactId: CONTACT, appointmentDate: '2026-10-16', appointmentTime: '06:00 PM' }, {
      lpAlreadyHasAppointment: async () => false,
      checkConfirmationCallSlot: async () => ({ blocked: false }),
      resolveLPLeadId: async () => ({ ldsId: l.lp_lead_id, prospectId: l.lp_prospect_id, source: 's', step: 0, disp: d }),
      lpSetAppointment: async () => { set++; return { Result: 0 }; },
      postIssueGate: (o) => postIssueGate(o, deps),
    });
    assert.equal(res.action, 'post_issue_new_lead_enrolled', d);
    assert.equal(set, 0, d);
    assert.equal(seen.enrolls.length, 1, d);
  }
});

test('8. a newer, non-issued lead on the prospect takes the SetAppointment; no enroll', async () => {
  const issued = lead();
  const newer = lead({ lp_lead_id: '500050', created_at_lp: '2026-09-20T10:00:00+00:00', disposition_code: 'Data', raw_lp_data: { srs_id: '344', appointments: [] } });
  const { deps, seen } = harness({ leads: [issued, newer] });
  const set = [];
  await syncAppointmentToLP({ contactId: CONTACT, appointmentDate: '2026-10-16', appointmentTime: '06:00 PM' }, {
    lpAlreadyHasAppointment: async () => false,
    checkConfirmationCallSlot: async () => ({ blocked: false }),
    resolveLPLeadId: async () => ({ ldsId: issued.lp_lead_id, prospectId: issued.lp_prospect_id, source: 's', step: 0, disp: 'Issue' }),
    postDemoLock: async () => ({ locked: false }),
    lpSetAppointment: async (a) => { set.push(a.ldsId); return { Result: 0 }; },
    postIssueGate: (o) => postIssueGate(o, deps),
  }).catch(() => {});
  assert.deepEqual(set, ['500050']);
  assert.equal(seen.enrolls.length, 0);
  assert.ok(outcomes(seen).includes('used_newer_lead'));
});

test('9. a waiting inquiry for the phone → no enroll, #contact-center card naming it', async () => {
  const l = lead();
  const { deps, seen } = harness({ leads: [l], inbound: [{ in1_id: '429001', phone10: '5555550101', received_at_lp: '2026-10-08T15:00:00Z' }] });
  const r = await postIssueGate(gateArgs(l), deps);
  assert.equal(r.result.action, 'newer_lead_pending_in_inbound_queue');
  assert.equal(r.result.in1_id, '429001');
  assert.equal(seen.enrolls.length, 0);
  assert.equal(seen.fieldWrites.length, 0);
  assert.equal(seen.slack.length, 1);
  assert.equal(seen.slack[0].ch, 'C_CONTACT_CENTER');
  assert.match(seen.slack[0].text, /429001/);
});

test('10. promoter cannot be matched → no field writes, no enroll, no 830/5574, card, claim released', async () => {
  for (const over of [{ promoter_name: 'Nobody, Here' }, { promoter_name: null }, { raw_lp_data: { srs_id: '0', appointments: [appt('2026-09-05T18:00:00', true)] } }]) {
    const l = lead(over);
    const { deps, seen, db } = harness({ leads: [l] });
    const r = await postIssueGate(gateArgs(l), deps);
    assert.equal(r.result.action, 'post_issue_needs_manual_lead');
    assert.match(r.result.reason, /^attribution_unresolved/);
    assert.deepEqual([seen.fieldWrites.length, seen.enrolls.length], [0, 0]);
    assert.ok(!JSON.stringify(seen.events).includes('"pro_id":"5574"'));
    assert.equal(seen.slack[0].ch, 'C_CONTACT_CENTER');
    assert.equal(db.tables.lp_appointment_sync_marks.length, 0, 'claim released for a retry');
  }
});

test('11. lp_leads AND LP live both fail → fail closed: no SetAppointment, no enroll, card', async () => {
  const l = lead();
  const { deps, seen } = harness({ leads: [l], fail: { lp_leads: true }, liveFails: true });
  let set = 0;
  const res = await syncAppointmentToLP({ contactId: CONTACT, appointmentDate: '2026-10-16', appointmentTime: '06:00 PM' }, {
    lpAlreadyHasAppointment: async () => false,
    checkConfirmationCallSlot: async () => ({ blocked: false }),
    resolveLPLeadId: async () => ({ ldsId: l.lp_lead_id, prospectId: l.lp_prospect_id, source: 's', step: 0, disp: '' }),
    postDemoLock: async () => ({ locked: false }),
    lpSetAppointment: async () => { set++; return { Result: 0 }; },
    postIssueGate: (o) => postIssueGate(o, deps),
  });
  assert.equal(res.action, 'post_issue_check_failed');
  assert.equal(res.reason, 'lead_unreadable');
  assert.deepEqual([set, seen.enrolls.length], [0, 0]);
  assert.equal(seen.slack[0].ch, 'C_CONTACT_CENTER');
  assert.match(seen.slack[0].text, /could not tell/i);
});

test('11b. a disposition in neither list fails closed in live', async () => {
  const l = lead({ disposition_code: 'Soft Confirm', raw_lp_data: { srs_id: '344', appointments: [] } });
  const { deps, seen } = harness({ leads: [l] });
  const r = await postIssueGate(gateArgs(l), deps);
  assert.equal(r.result.action, 'post_issue_check_failed');
  assert.match(r.result.reason, /unrecognised_disposition/);
  assert.equal(seen.enrolls.length, 0);
});

test('12. enroll throws → the four fields go back to their saved values, claim released, card', async () => {
  const l = lead();
  const { deps, seen, db } = harness({ leads: [l], enroll: () => { throw new Error('GHL 422'); } });
  const r = await postIssueGate(gateArgs(l), deps);
  assert.equal(r.result.action, 'post_issue_enroll_failed');
  assert.equal(r.result.compensation_applied, true);
  assert.equal(seen.fieldWrites.length, 2);
  assert.deepEqual(seen.fieldWrites[1], [
    { id: FIELD.SRS, field_value: '830' }, { id: FIELD.PRO, field_value: '5574' },
    { id: FIELD.APPT_DATE, field_value: '2026-10-01' }, { id: FIELD.APPT_TIME, field_value: '2:00 PM' },
  ]);
  assert.equal(db.tables.lp_appointment_sync_marks.length, 0);
  assert.equal(seen.slack[0].ch, 'C_CONTACT_CENTER');
  assert.equal(seen.events.at(-1).payload.restore_ok, true);
});

test('12b. a field write that fails is compensated the same way; no enroll', async () => {
  const l = lead();
  const { deps, seen } = harness({ leads: [l], fieldWrite: (n) => (n === 1 ? false : true) });
  const r = await postIssueGate(gateArgs(l), deps);
  assert.equal(r.result.action, 'post_issue_enroll_failed');
  assert.equal(seen.enrolls.length, 0);
  assert.equal(seen.fieldWrites.length, 2, 'write, then restore');
});

test('12c. a contact that cannot be read is never written', async () => {
  const l = lead();
  const { deps, seen } = harness({ leads: [l], contact: null });
  const r = await postIssueGate(gateArgs(l), deps);
  assert.equal(r.result.action, 'post_issue_needs_manual_lead');
  assert.deepEqual([seen.fieldWrites.length, seen.enrolls.length], [0, 0]);
});

test('13. the same webhook twice → exactly one enroll; the second returns the recorded outcome', async () => {
  const l = lead();
  const { deps, seen } = harness({ leads: [l] });
  const first = await postIssueGate(gateArgs(l), deps);
  const second = await postIssueGate(gateArgs(l), deps);
  assert.equal(first.result.action, 'post_issue_new_lead_enrolled');
  assert.equal(second.result.action, 'post_issue_rebook_duplicate');
  assert.equal(second.result.recorded_outcome, 'post_issue_new_lead_enrolled');
  assert.equal(second.result.success, true);
  assert.equal(seen.enrolls.length, 1);
});

test('14. the parity watchdog on an issued lead → refused, no enroll, no card', async () => {
  const l = lead();
  const { deps, seen } = harness({ leads: [l] });
  let set = 0;
  const res = await syncAppointmentToLP({ contactId: CONTACT, appointmentDate: '2026-10-16', appointmentTime: '06:00 PM', requireBookable: true }, {
    lpAlreadyHasAppointment: async () => false,
    checkConfirmationCallSlot: async () => ({ blocked: false }),
    resolveLPLeadId: async () => ({ ldsId: l.lp_lead_id, prospectId: l.lp_prospect_id, source: 's', step: 0, disp: 'Issue' }),
    lpSetAppointment: async () => { set++; return { Result: 0 }; },
    postIssueGate: (o) => postIssueGate(o, deps),
  });
  assert.equal(res.action, 'skipped_post_issue_lead');
  assert.deepEqual([set, seen.enrolls.length, seen.slack.length], [0, 0, 0]);
});

test('14b. set_lp_appointment on a bare LP lead id that is issued → a person, never a write', async () => {
  const l = lead();
  const { deps, seen } = harness({ leads: [l] });
  const res = await executeSetLPAppointment(
    { target_id: '500001', action_payload: { appt_date: '2026-10-16', appt_time: '18:00' } },
    { deps: { postIssueGate: (o) => postIssueGate(o, deps) } },
  );
  assert.equal(res.action, 'post_issue_needs_manual_lead');
  assert.equal(res.reason, 'target_is_lp_lead_id_no_ghl_contact');
  assert.equal(seen.enrolls.length, 0);
});

// ═══ Real incidents (15–16) ════════════════════════════════════════════════

test('15. Heather Faling (prospect 158825, lead 190599, CCC after an issued 10/9 visit): a reschedule is a NEW lead', async () => {
  const { deps, seen } = harness({ leads: [HEATHER] });
  const r = await postIssueGate(gateArgs(HEATHER, { appointmentDate: '2026-10-16', appointmentTime: '18:00' }), deps);
  assert.equal(r.proceed, false, 'no fifth appointment row on 190599');
  assert.equal(r.result.action, 'post_issue_new_lead_enrolled');
  assert.equal(r.result.issued_reason, 'lp_issued_flag');
  assert.deepEqual([r.result.srs_id, r.result.pro_id], ['344', '6075'], 'Canvass / Clements, William - SARA mirrored');
  assert.equal(seen.enrolls.length, 1);
});

test('15b. Heather: the issued 10/9 6 PM appointment re-sent is not a rebook (no new lead, no write)', async () => {
  const { deps, seen } = harness({ leads: [HEATHER] });
  const r = await postIssueGate(gateArgs(HEATHER, { appointmentDate: '2026-10-09', appointmentTime: '18:00' }), deps);
  assert.equal(r.proceed, false);
  assert.equal(r.result.action, 'already_set_in_lp');
  assert.equal(r.result.post_issue_outcome, 'same_appointment_on_issued_lead');
  assert.deepEqual([seen.enrolls.length, seen.fieldWrites.length, seen.slack.length], [0, 0, 0]);
});

test('16. Erica / Roger (lead 581387, pre-issue Set) moved 10/9 → 10/12 stays on the same lead', async () => {
  const { deps, seen } = harness({ leads: [ERICA] });
  const set = [];
  await syncAppointmentToLP({ contactId: 'THHRENLYFDRKGUKUGFgw', appointmentDate: '2026-10-12', appointmentTime: '06:00 PM' }, {
    lpAlreadyHasAppointment: async () => false,
    checkConfirmationCallSlot: async () => ({ blocked: false }),
    resolveLPLeadId: async () => ({ ldsId: '581387', prospectId: '258904', source: 's', step: 0, disp: 'Set' }),
    postDemoLock: async () => ({ locked: false }),
    lpSetAppointment: async (a) => { set.push(a.ldsId); return { Result: 0 }; },
    postIssueGate: (o) => postIssueGate(o, deps),
  }).catch(() => {});
  assert.deepEqual(set, ['581387']);
  assert.deepEqual(outcomes(seen), ['pre_issue_proceed']);
  assert.equal(seen.enrolls.length, 0);
});

// ═══ The card ══════════════════════════════════════════════════════════════

test('the #contact-center card names the person, the leads, the reason and the one thing to do', () => {
  const text = formatPostIssueCard({
    mode: 'live', outcome: 'post_issue_needs_manual_lead', caller: 'sync_appointment_to_lp',
    contact_id: CONTACT, contact_name: 'Heather Faling', phone: '9417269363', lp_prospect_id: '158825',
    issued_lead_id: '190599', issued_disposition: 'CCC', issued_reason: 'lp_issued_flag',
    appt_date: '2026-10-16', appt_time: '18:00', reason: 'attribution_unresolved: promoter_not_in_lp_catalog',
  }, { GHL_LOCATION_ID: 'LOC' });
  for (const s of ['Heather Faling', '9417269363', '158825', '190599', 'CCC', '2026-10-16 18:00', 'promoter_not_in_lp_catalog', 'create a NEW lead', `contacts/detail/${CONTACT}`]) {
    assert.ok(text.includes(s), s);
  }
});
