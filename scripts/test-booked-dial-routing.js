/**
 * Booked-lead dial routing — scripts/test-booked-dial-routing.js
 *
 * Decision #2669 (2026-10-06): a lead with a future appointment comes OFF the
 * setter lists (LP_ASAP, Reece Chatbot, Direct Lead Entry, After DIAL ASAP)
 * and goes ON Conf - Next Day / Conf - 2nd Day. Add first, remove second;
 * removals need approval (decision #1057) unless the standing exception is on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  routingConfig, routingMode, buildCandidate, routeBooked, prefilter, decide, addState, buildRemovalAction,
  buildAddAction, approvalExpired, onePerPhone, priorRemoveKeys, removeKey, RULE_KEY,
  failedAddCount, confMoveDue, formatAddFailedCard,
} from '../src/booked-dial-routing.js';
import { routeList, backstopConfig } from '../src/new-lead-dial-backstop.js';
import { normalizeInboundRow } from '../src/new-lead-dial-backstop.js';
import { runBookedDialRouting, __resetLoggedForTests } from '../src/jobs/booked-dial-routing.js';
import { executeDeleteRecordFromList, listRecordsDeletedFrom } from '../src/five9/admin-writes.js';
import { executeFive9Write } from '../src/actions/handlers/five9.js';
import { describeApprove } from '../src/approval-card.js';

const cfg = routingConfig({});
const edt = (s) => Date.parse(`${s}-04:00`);

// Shelley after checkout: in1 428940 → lds 581671, cst 463389, visit 10/08 6 PM.
const SHELLEY_RAW = {
  id: '428940', firstname: 'Shelley', lastname: '', address1: '21296 Birwood Ave', phone: '(941)467-0700', brn_id: 'FTMYR',
  source: 'Website', sourcesubdescr: 'Reece ChatBot', checkoutdate: '2026-10-06T15:56:02.817', checkoutusername: 'Mcintosh, Sarah',
  apptdate: '10/08/2026', appttime: '6:00 PM', datereceived: '2026-10-06T15:22:04.707', lognumber: 'u5JV2SkaPh8O4XqkCDyM',
  method: 'A', lds_id: '581671', cst_id: '463389', dsp_id: 'Set', killreason: '', sender: 'GHL-Chatbot',
};
const cand = (over = {}, lead = null) => buildCandidate(normalizeInboundRow({ ...SHELLEY_RAW, ...over }), lead);
const pre = (c, nowMs, extra = {}) => prefilter(c, { nowMs, cfg, ...extra });

/* --- routing --------------------------------------------------------------- */

test('mode defaults to shadow; config defaults', () => {
  assert.equal(routingMode({}), 'shadow');
  assert.equal(routingMode({ BOOKED_DIAL_ROUTING_MODE: 'lvie' }), 'shadow');
  assert.deepEqual(cfg.removeLists, ['LP_ASAP', 'Reece Chatbot', 'Direct Lead Entry', 'After DIAL ASAP']);
  assert.deepEqual([...cfg.skipDsp], ['CXL', 'Reset', 'NoShow']);
  // Automatic by default (Mark's standing exception, 2026-10-06); only 'false' turns approval back on.
  assert.equal(cfg.autoRemove, true);
  assert.equal(routingConfig({ BOOKED_ROUTING_AUTO_REMOVE: 'true' }).autoRemove, true);
  assert.equal(routingConfig({ BOOKED_ROUTING_AUTO_REMOVE: 'False' }).autoRemove, false);
  assert.equal(routingConfig({ BOOKED_ROUTING_AUTO_REMOVE: 'no' }).autoRemove, true, 'only the literal false rolls back');
  assert.throws(() => routingConfig({ NEW_LEAD_BACKSTOP_LIST_NEXT_DAY: 'lp_asap' }), /LP owns that list/);
});

test('Shelley on 10/06 → "Conf - 2nd Day"; on 10/07 → "Conf - Next Day"', () => {
  const c = cand();
  assert.equal(c.apptStartMs, Date.parse('2026-10-08T22:00:00Z'));
  assert.equal(routeBooked(c, { nowMs: edt('2026-10-06T16:00:00'), cfg }).addList, 'Conf - 2nd Day');
  assert.equal(routeBooked(c, { nowMs: edt('2026-10-07T09:00:00'), cfg }).addList, 'Conf - Next Day');
  assert.equal(routeBooked(c, { nowMs: edt('2026-10-08T12:00:00'), cfg }).addList, 'Conf - Next Day', 'same day, before the visit');
});

test('5 days out → no add yet, but off the setter lists now (Mark, 2026-10-06 follow-up)', () => {
  const c = cand({ apptdate: '10/11/2026' });
  const p = pre(c, edt('2026-10-06T16:00:00'));
  assert.equal(p.action, 'candidate');
  assert.equal(p.reason, 'appt_3plus_days');
  assert.equal(p.route.hold, true);
  assert.equal(p.route.addList, null);
  const d = decide({ ...{ onDnc: false, contact: null, adds: 'not_needed', removedToday: false, removedBefore: false, addClaimed: false, cfg }, pre: p });
  assert.deepEqual([d.add, d.remove], [false, true]);
});

test('past appointment, killed, skipped dispositions, not booked, sold → skipped', () => {
  const now = edt('2026-10-08T19:00:00');
  assert.equal(pre(cand(), now).reason, 'past_appointment'); // 6 PM visit, 7 PM now
  assert.equal(pre(cand({ apptdate: '10/05/2026' }), now).reason, 'past_appointment');
  assert.equal(pre(cand({ killreason: 'Duplicate' }), now).reason, 'killed');
  assert.equal(pre(cand({ dsp_id: 'CXL' }), now).reason, 'disposition_CXL');
  assert.equal(pre(cand({ dsp_id: 'Data' }), now).reason, 'not_booked');
  assert.equal(pre(cand(), edt('2026-10-06T16:00:00'), { sold: true }).reason, 'sold');
});

test('lp_leads (current) overrides the inbound row — a later cancel wins', () => {
  const lead = { lp_lead_id: '581671', disposition_code: 'CXL', appointment_date: '2026-10-08 18:00:00+00', lp_prospect_id: '463389' };
  assert.equal(pre(cand({}, lead), edt('2026-10-06T16:00:00')).reason, 'disposition_CXL');
});

test('an inquiry LP has not issued (no CustID) waits — never removal without an add', () => {
  const c = cand({ lds_id: '', cst_id: '', checkoutdate: '' });
  assert.equal(pre(c, edt('2026-10-06T16:00:00')).reason, 'awaiting_lp_checkout');
});

test('one candidate per phone, newest row wins', () => {
  const older = cand({ id: '1', datereceived: '2026-10-05T10:00:00' });
  const newer = cand({ id: '2', datereceived: '2026-10-06T10:00:00' });
  const { winners, dropped } = onePerPhone([newer, older]);
  assert.deepEqual(winners.map((c) => c.in1), ['2']);
  assert.deepEqual(dropped.map((c) => c.in1), ['1']);
});

/* --- the decision ----------------------------------------------------------- */

const ok = (now) => pre(cand(), now);
const base = { onDnc: false, contact: null, adds: 'none', removedToday: false, removedBefore: false, addClaimed: false, cfg };

test('first pass: add only; the removal waits for the add to complete', () => {
  const d = decide({ ...base, pre: ok(edt('2026-10-06T16:00:00')) });
  assert.equal(d.add, true);
  assert.equal(d.remove, false);
});

test('add completed → removal', () => {
  const d = decide({ ...base, pre: ok(edt('2026-10-06T16:05:00')), adds: 'done', addClaimed: true });
  assert.equal(d.add, false);
  assert.equal(d.remove, true);
});

test('add failed once → one retry, no removal; twice → a person is told, still no removal', () => {
  const p = ok(edt('2026-10-06T16:05:00'));
  const once = decide({ ...base, pre: p, adds: 'failed', addClaimed: true, failedAdds: 1 });
  assert.deepEqual([once.add, once.retry, once.remove], [true, true, false]);
  const twice = decide({ ...base, pre: p, adds: 'failed', addClaimed: true, failedAdds: 2 });
  assert.deepEqual([twice.add, twice.remove, twice.alert, twice.reason], [false, false, true, 'add_failed_twice']);
  // The retry was queued but its row is gone/failed too → the person, not a third try.
  assert.equal(decide({ ...base, pre: p, adds: 'failed', addClaimed: true, failedAdds: 1, retryClaimed: true }).alert, true);
  assert.equal(decide({ ...base, pre: p, adds: 'pending', addClaimed: true }).remove, false);
});

test('failedAddCount counts only failed rows for that list', () => {
  const rows = [
    { list: 'Conf - 2nd Day', status: 'failed' }, { list: 'Conf - 2nd Day', status: 'pending' },
    { list: 'Conf - Next Day', status: 'failed' }, { list: 'Conf - 2nd Day', status: 'skipped' },
  ];
  assert.equal(failedAddCount(rows, 'Conf - 2nd Day'), 2);
});

test('the add-failed card names the lead and asks for a hand add', () => {
  const text = formatAddFailedCard([{ c: cand(), list: 'Conf - 2nd Day' }]);
  assert.match(text, /add them in Five9 by hand/);
  assert.match(text, /Shelley · \(941\) 467-0700 · visit .* → "Conf - 2nd Day" \(LP lead 581671\)/);
});

test('a move from 2nd Day to Next Day is due once both adds completed', () => {
  const route = { addList: 'Conf - Next Day' };
  const both = [{ list: 'Conf - 2nd Day', status: 'completed' }, { list: 'Conf - Next Day', status: 'completed' }];
  assert.equal(confMoveDue({ route, addRows: both, moveClaimed: false, cfg }), true);
  assert.equal(confMoveDue({ route, addRows: both, moveClaimed: true, cfg }), false);
  assert.equal(confMoveDue({ route, addRows: [both[1]], moveClaimed: false, cfg }), false, 'never on 2nd Day');
  assert.equal(confMoveDue({ route, addRows: [both[0], { list: 'Conf - Next Day', status: 'pending' }], moveClaimed: false, cfg }), false, 'Next Day add not done yet');
  assert.equal(confMoveDue({ route: { addList: 'Conf - 2nd Day' }, addRows: both, moveClaimed: false, cfg }), false);
});

test('backstop holds 3+ day visits ONLY while booked routing is live (#2)', () => {
  const nowMs = edt('2026-10-06T16:00:00');
  const appt = { hasAppt: true, apptDateEt: '2026-10-11', apptStartMs: null, nowMs };
  assert.equal(routeList({ ...appt, cfg: backstopConfig({}) }).list, 'Conf - 2nd Day', 'shadow (default): unchanged');
  assert.equal(routeList({ ...appt, cfg: backstopConfig({ BOOKED_DIAL_ROUTING_MODE: 'shadow' }) }).list, 'Conf - 2nd Day');
  assert.equal(routeList({ ...appt, cfg: backstopConfig({ BOOKED_DIAL_ROUTING_MODE: 'off' }) }).list, 'Conf - 2nd Day');
  assert.equal(routeList({ ...appt, cfg: backstopConfig({ BOOKED_DIAL_ROUTING_MODE: 'live' }) }).skip, 'appt_held_for_booked_routing');
  // Two days out is still the backstop's to push, live or not.
  const two = { ...appt, apptDateEt: '2026-10-08' };
  assert.equal(routeList({ ...two, cfg: backstopConfig({ BOOKED_DIAL_ROUTING_MODE: 'live' }) }).list, 'Conf - 2nd Day');
});

test('already on the target Confirmation list → no add, removal goes ahead', () => {
  const d = decide({ ...base, pre: ok(edt('2026-10-06T16:00:00')), contact: { list: 'Conf - 2nd Day' } });
  assert.deepEqual([d.add, d.remove, d.reason], [false, true, 'already_on_confirmation_list']);
});

test('Cnf (already confirmed) → no add, removal yes', () => {
  const p = pre(cand({ dsp_id: 'Cnf' }), edt('2026-10-06T16:00:00'));
  assert.equal(p.route.addList, null);
  const d = decide({ ...base, pre: p });
  assert.deepEqual([d.add, d.remove], [false, true]);
});

test('DNC → skipped; DNC unreadable → wait; Five9 record unreadable → no add', () => {
  assert.equal(decide({ ...base, pre: ok(edt('2026-10-06T16:00:00')), onDnc: true }).reason, 'dnc');
  assert.equal(decide({ ...base, pre: ok(edt('2026-10-06T16:00:00')), onDnc: null }).reason, 'dnc_unreadable');
  assert.equal(decide({ ...base, pre: ok(edt('2026-10-06T16:00:00')), contact: 'error' }).add, false);
});

test('6 AM LP re-add: removal re-queued once that day, only with evidence', () => {
  const p = ok(edt('2026-10-07T08:00:00'));
  const later = { ...base, pre: p, adds: 'done', addClaimed: true, removedBefore: true };
  assert.deepEqual(decide({ ...later, contact: { list: 'LP_ASAP' } }), { add: false, remove: true, reason: 'lp_readded', readded: true });
  assert.equal(decide({ ...later, contact: { list: 'Conf - Next Day' } }).remove, false);
  assert.equal(decide({ ...later, contact: { list: 'LP_ASAP' }, removedToday: true }).remove, false, 'once that day');
});

test('addState reads any rule\'s Confirmation adds', () => {
  assert.equal(addState([{ list: 'Conf - 2nd Day', status: 'completed' }], 'Conf - 2nd Day'), 'done');
  assert.equal(addState([{ list: 'Conf - Next Day', status: 'completed' }], 'Conf - 2nd Day'), 'none');
  assert.equal(addState([{ list: 'Conf - 2nd Day', status: 'failed' }], 'Conf - 2nd Day'), 'failed');
  assert.equal(addState([{ list: 'Conf - 2nd Day', status: 'failed' }, { list: 'Conf - 2nd Day', status: 'pending' }], 'Conf - 2nd Day'), 'pending');
  assert.equal(addState([], null), 'not_needed');
});

/* --- the actions ---------------------------------------------------------------- */

test('removal runs automatically unless BOOKED_ROUTING_AUTO_REMOVE=false; expires at the appointment', () => {
  const c = cand();
  const approval = routingConfig({ BOOKED_ROUTING_AUTO_REMOVE: 'false' });
  const row = buildRemovalAction(c, { reason: 'appt_in_2_days', confList: 'Conf - 2nd Day', cfg: approval, nowMs: edt('2026-10-06T16:05:00') });
  assert.equal(row.requires_approval, true);
  assert.equal(row.status, 'pending_approval');
  assert.equal(row.rule_applied, RULE_KEY);
  assert.equal(row.target_id, 'u5JV2SkaPh8O4XqkCDyM');
  assert.deepEqual(row.action_payload.list_names, cfg.removeLists);
  assert.deepEqual(row.action_payload.values, ['9414670700']);
  assert.equal(row.action_payload.approval_expires_at, '2026-10-08T22:00:00.000Z');
  const auto = buildRemovalAction(c, { reason: 'x', confList: 'Conf - 2nd Day', cfg, nowMs: 0 });
  assert.equal(auto.requires_approval, false);
  assert.equal(auto.status, 'pending');
});

test('the add is the auto-approved op, never LP_ASAP, never call-now', () => {
  const row = buildAddAction(cand(), { fieldNames: ['number1'], values: ['9414670700'], number1: '9414670700' }, 'Conf - 2nd Day', { reason: 'r', nowMs: 0 });
  assert.equal(row.action_type, 'five9_add_records_to_list');
  assert.equal(row.requires_approval, false);
  assert.equal(row.action_payload.call_now_mode, undefined);
  assert.equal(row.target_id, 'Conf - 2nd Day');
});

test('expired approval → not executed (no Five9 call)', async () => {
  const action = { id: 9, action_type: 'five9_delete_record_from_list', requires_approval: true, rule_applied: RULE_KEY,
    action_payload: { list_names: ['LP_ASAP'], field_names: ['number1'], values: ['9414670700'], approval_expires_at: '2026-01-01T00:00:00Z' } };
  assert.equal(approvalExpired(action, Date.now()), true);
  const res = await executeFive9Write(action);
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'approval_expired');
});

test('the delete payload is validated before anything runs', async () => {
  assert.throws(() => executeDeleteRecordFromList({ action_payload: {} }), /list_name or list_names/);
  assert.throws(() => executeDeleteRecordFromList({ action_payload: { list_names: Array.from({ length: 11 }, (_, i) => `L${i}`) } }), /per action cap/);
});

test('"not on the list" is a no-op: listRecordsDeleted 0 parses as zero', () => {
  assert.equal(listRecordsDeletedFrom('<return><listRecordsDeleted>0</listRecordsDeleted><success>true</success></return>'), 0);
  assert.equal(listRecordsDeletedFrom('<listRecordsDeleted>1</listRecordsDeleted>'), 1);
  assert.equal(listRecordsDeletedFrom('<x/>'), null);
});

test('executor: an unarmed removal runs only for this rule, and BOOKED_ROUTING_AUTO_REMOVE=false refuses it', async () => {
  const unarmed = (rule) => ({ action_type: 'five9_delete_record_from_list', requires_approval: false, rule_applied: rule, action_payload: {} });
  const prev = process.env.BOOKED_ROUTING_AUTO_REMOVE;
  try {
    process.env.BOOKED_ROUTING_AUTO_REMOVE = 'false';
    await assert.rejects(() => executeFive9Write(unarmed(RULE_KEY)), /must be queued with requires_approval=true/, 'rollback switch');
    delete process.env.BOOKED_ROUTING_AUTO_REMOVE;
    // Another rule's removal is never carved out.
    await assert.rejects(() => executeFive9Write(unarmed('SOMETHING_ELSE')), /must be queued with requires_approval=true/);
    await assert.rejects(() => executeFive9Write(unarmed(undefined)), /must be queued with requires_approval=true/);
    // Default: past the approval gate — fails on its own payload validation instead.
    await assert.rejects(() => executeFive9Write(unarmed(RULE_KEY)), /requires action_payload\.list_name or list_names/);
  } finally {
    if (prev === undefined) delete process.env.BOOKED_ROUTING_AUTO_REMOVE; else process.env.BOOKED_ROUTING_AUTO_REMOVE = prev;
  }
});

test('the approval card names the phone, the person, the lists, the visit and the expiry — no pronoun', () => {
  const row = buildRemovalAction(cand(), { reason: 'appt_in_2_days', confList: 'Conf - 2nd Day', cfg, nowMs: 0 });
  const text = describeApprove(row, { contactName: 'Shelley' });
  assert.match(text, /\(941\) 467-0700|941-467-0700|9414670700/);
  assert.match(text, /Shelley/);
  assert.match(text, /"LP_ASAP", "Reece Chatbot", "Direct Lead Entry", "After DIAL ASAP"/);
  assert.match(text, /Shelley is booked for/);
  assert.match(text, /Conf - 2nd Day/);
  assert.match(text, /Expires at the appointment time/);
  assert.doesNotMatch(text, /\b(she|he|they|her|his|their)\b/i);
});

/* --- the pass ------------------------------------------------------------------- */

function harness({ inbound = [SHELLEY_RAW], soldPhones = [], dnc = [], contactList = null, addRows = [], mirrorMissing = false } = {}) {
  const marks = new Map();
  const actions = [];
  const logs = [];
  const posts = [];
  const postedKeys = new Set();
  const markReads = [];
  let nextId = 1000;
  const state = { addRows: [...addRows] };
  const supabase = {
    from(name) {
      if (name === 'lp_inbound_queue') {
        const res = mirrorMissing ? { data: null, error: { code: '42P01', message: 'missing' } } : { data: inbound.map((raw) => ({ raw })), error: null };
        const chain = { gte: () => chain, then: (f, r) => Promise.resolve(res).then(f, r) };
        return { select: () => chain };
      }
      if (name === 'lp_appointment_sync_marks') {
        return {
          // The job reads its claims by prefix + age in pages (readBookedMarks).
          select: () => {
            const q = { prefix: null };
            const chain = {
              like: (_c, pat) => { q.prefix = pat.replace(/%$/, ''); return chain; },
              gte: () => chain,
              order: () => chain,
              range: async (from, to) => {
                markReads.push({ from, to });
                const all = [...marks.keys()].filter((k) => k.startsWith(q.prefix)).sort();
                return { data: all.slice(from, to + 1).map((k) => ({ dedup_key: k })), error: null };
              },
            };
            return chain;
          },
          upsert: (r) => ({ select: async () => (marks.has(r.dedup_key) ? { data: [], error: null } : (marks.set(r.dedup_key, r), { data: [{ dedup_key: r.dedup_key }], error: null })) }),
          delete: () => ({ in: async (_c, keys) => { for (const k of keys) marks.delete(k); return { error: null }; } }),
        };
      }
      if (name === 'agent_actions') {
        return {
          insert: (row) => ({ select: () => ({ single: async () => { const id = nextId++; actions.push({ ...row, id }); return { data: { id }, error: null }; } }) }),
          select: () => { const c = { eq: () => c, limit: async () => ({ data: actions.filter((a) => a.status === 'pending_approval'), error: null }) }; return c; },
          update: (patch) => ({ in: (_c, ids) => ({ eq: async () => { for (const a of actions) if (ids.includes(a.id)) Object.assign(a, patch); return { error: null }; } }) }),
        };
      }
      if (name === 'booked_dial_routing_log') return { insert: async (rows) => { logs.push(...rows); return { error: null }; } };
      throw new Error(`unexpected table ${name}`);
    },
  };
  const runSQL = async (sql) => {
    if (/FROM lp_leads WHERE created_at_lp/.test(sql)) return [];
    if (/closed_won = true/.test(sql)) return soldPhones.map((p) => ({ phone10: p }));
    if (/five9_add_records_to_list/.test(sql)) {
      // Our own queued adds count too, as they would in agent_actions.
      const own = actions.filter((a) => a.action_type === 'five9_add_records_to_list')
        .map((a) => ({ id: a.id, status: a.status, target_id: a.target_id, payload: JSON.stringify(a.action_payload) }));
      return [...state.addRows, ...own];
    }
    throw new Error(`unexpected SQL ${sql.slice(0, 60)}`);
  };
  const contactRes = (list) => ({ records: [{ fields: ['number1', 'lead_id', 'f9_last_list'], records: [{ values: { data: ['9414670700', '581671', list] } }] }] });
  return {
    marks, actions, logs, state, posts, markReads,
    setContactList: (l) => { contactList = l; },
    deps: {
      supabase, runSQL,
      checkDnc: async () => ({ on_dnc: dnc }),
      getContactRecords: async () => (contactList ? contactRes(contactList) : { records: [] }),
      listInboundLeads: async ({ page }) => (page === 1 ? inbound : []),
      reportAlertCondition: async () => {},
      postToSlack: async (text, channel) => { posts.push({ text, channel }); return { ok: true }; },
      filterNew: async ({ items }) => ({ fresh: items.filter((i) => !postedKeys.has(i.key)) }),
      recordPosted: async ({ items }) => { for (const i of items) postedKeys.add(i.key); },
    },
  };
}
const LIVE = { BOOKED_DIAL_ROUTING_MODE: 'live', SLACK_CHANNEL_SERVICE: 'C_SERVICE' };

test('shadow: would_add logged, nothing queued, no marks', async () => {
  __resetLoggedForTests();
  const h = harness();
  const res = await runBookedDialRouting({ env: {}, nowMs: edt('2026-10-06T16:00:00'), deps: h.deps });
  assert.equal(res.ok, true, res.errors.join());
  assert.equal(h.actions.length, 0);
  assert.equal(h.marks.size, 0);
  assert.deepEqual(h.logs.map((l) => [l.action, l.list_name, l.mode]), [['would_add', 'Conf - 2nd Day', 'shadow']]);
});

test('live: add first; removal only after the add completed; a duplicate pass adds nothing', async () => {
  __resetLoggedForTests();
  const h = harness();
  const t1 = edt('2026-10-06T16:00:00');
  await runBookedDialRouting({ env: LIVE, nowMs: t1, deps: h.deps });
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].action_type, 'five9_add_records_to_list');
  assert.equal(h.actions[0].target_id, 'Conf - 2nd Day');
  assert.ok(h.actions[0].action_payload.field_names.includes('CustID'));

  // Same pass again while the add is still pending: no second add, no removal.
  await runBookedDialRouting({ env: LIVE, nowMs: t1 + 60_000, deps: h.deps });
  assert.equal(h.actions.length, 1);

  // The executor completes the add → next pass queues the removal, automatically (standing exception).
  h.actions[0].status = 'completed';
  await runBookedDialRouting({ env: LIVE, nowMs: t1 + 5 * 60_000, deps: h.deps });
  assert.equal(h.actions.length, 2);
  assert.equal(h.actions[1].action_type, 'five9_delete_record_from_list');
  assert.equal(h.actions[1].requires_approval, false);
  assert.equal(h.actions[1].status, 'pending');
  assert.equal(h.actions[1].rule_applied, RULE_KEY);
  assert.deepEqual(h.logs.filter((l) => l.agent_action_id).map((l) => l.action), ['added', 'remove_queued']);

  // And not again that day.
  await runBookedDialRouting({ env: LIVE, nowMs: t1 + 10 * 60_000, deps: h.deps });
  assert.equal(h.actions.length, 2);
});

test('live: a failed add is retried once, then #contact-center is told once — never a removal', async () => {
  __resetLoggedForTests();
  const h = harness();
  const t1 = edt('2026-10-06T16:00:00');
  await runBookedDialRouting({ env: LIVE, nowMs: t1, deps: h.deps });
  h.actions[0].status = 'failed';
  await runBookedDialRouting({ env: LIVE, nowMs: t1 + 5 * 60_000, deps: h.deps });
  assert.deepEqual(h.actions.map((a) => a.action_type), ['five9_add_records_to_list', 'five9_add_records_to_list'], 'one retry');
  assert.equal(h.posts.length, 0);
  h.actions[1].status = 'failed';
  const res = await runBookedDialRouting({ env: LIVE, nowMs: t1 + 10 * 60_000, deps: h.deps });
  assert.equal(h.actions.length, 2, 'no third add, no removal');
  assert.equal(res.add_failed, 1);
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].channel, 'C_SERVICE');
  assert.match(h.posts[0].text, /BOOKED LEADS NOT ON A CONFIRMATION LIST/);
  await runBookedDialRouting({ env: LIVE, nowMs: t1 + 15 * 60_000, deps: h.deps });
  assert.equal(h.posts.length, 1, 'told once');
});

test('rollback: BOOKED_ROUTING_AUTO_REMOVE=false queues the removal for approval', async () => {
  __resetLoggedForTests();
  const h = harness({ inbound: [{ ...SHELLEY_RAW, apptdate: '10/11/2026' }] });
  await runBookedDialRouting({ env: { ...LIVE, BOOKED_ROUTING_AUTO_REMOVE: 'false' }, nowMs: edt('2026-10-06T16:00:00'), deps: h.deps });
  assert.equal(h.actions[0].requires_approval, true);
  assert.equal(h.actions[0].status, 'pending_approval');
});

test('live: a visit 5 days out comes off the setter lists right away, no add', async () => {
  __resetLoggedForTests();
  const h = harness({ inbound: [{ ...SHELLEY_RAW, apptdate: '10/11/2026' }] });
  await runBookedDialRouting({ env: LIVE, nowMs: edt('2026-10-06T16:00:00'), deps: h.deps });
  assert.deepEqual(h.actions.map((a) => a.action_type), ['five9_delete_record_from_list']);
  assert.deepEqual(h.actions[0].action_payload.list_names, cfg.removeLists);
  assert.equal(h.actions[0].requires_approval, false);
  assert.equal(h.actions[0].action_payload.reason, 'appt_3plus_days');
  assert.match(describeApprove(h.actions[0], { contactName: 'Shelley' }), /3\+ days out; the number goes on a confirmation list two days before it/);
});

test('live: moved from 2nd Day to Next Day → one removal from "Conf - 2nd Day" only', async () => {
  __resetLoggedForTests();
  const h = harness({ addRows: [
    { id: 1, status: 'completed', target_id: 'Conf - 2nd Day', payload: '{"records":[["9414670700"]]}' },
    { id: 2, status: 'completed', target_id: 'Conf - Next Day', payload: '{"records":[["9414670700"]]}' },
  ] });
  h.marks.set(removeKey('9414670700', '2026-10-08', '2026-10-06'), {}); // setter lists done yesterday
  h.setContactList('Conf - Next Day');
  await runBookedDialRouting({ env: LIVE, nowMs: edt('2026-10-07T09:00:00'), deps: h.deps });
  assert.equal(h.actions.length, 1);
  assert.deepEqual(h.actions[0].action_payload.list_names, ['Conf - 2nd Day']);
  assert.equal(h.actions[0].action_payload.reason, 'moved_to_next_day');
  assert.match(describeApprove(h.actions[0], { contactName: 'Shelley' }), /stops a second confirmation call/);
  await runBookedDialRouting({ env: LIVE, nowMs: edt('2026-10-07T09:05:00'), deps: h.deps });
  assert.equal(h.actions.length, 1, 'once per visit');
});

test('live: setter removal and the 2nd Day removal due together → ONE card', async () => {
  __resetLoggedForTests();
  const h = harness({ addRows: [
    { id: 1, status: 'completed', target_id: 'Conf - 2nd Day', payload: '{"records":[["9414670700"]]}' },
    { id: 2, status: 'completed', target_id: 'Conf - Next Day', payload: '{"records":[["9414670700"]]}' },
  ] });
  await runBookedDialRouting({ env: LIVE, nowMs: edt('2026-10-07T09:00:00'), deps: h.deps });
  assert.equal(h.actions.length, 1);
  assert.deepEqual(h.actions[0].action_payload.list_names, [...cfg.removeLists, 'Conf - 2nd Day']);
});

test('live: a backstop add that completed counts — removal without a second add', async () => {
  __resetLoggedForTests();
  const h = harness({ addRows: [{ id: 1, status: 'completed', target_id: 'Conf - 2nd Day', payload: '{"records":[["9414670700","Shelley"]]}' }] });
  await runBookedDialRouting({ env: LIVE, nowMs: edt('2026-10-06T16:00:00'), deps: h.deps });
  assert.deepEqual(h.actions.map((a) => a.action_type), ['five9_delete_record_from_list']);
});

test('live: 6 AM LP re-add → removal re-queued once that day, counted', async () => {
  __resetLoggedForTests();
  const h = harness({ addRows: [{ id: 1, status: 'completed', target_id: 'Conf - Next Day', payload: '{"records":[["9414670700"]]}' }] });
  // Yesterday's removal claim.
  h.marks.set(removeKey('9414670700', '2026-10-08', '2026-10-06'), {});
  h.setContactList('LP_ASAP');
  const res = await runBookedDialRouting({ env: LIVE, nowMs: edt('2026-10-07T08:00:00'), deps: h.deps });
  assert.equal(res.lp_readded, 1);
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].action_payload.lp_readded, true);
  await runBookedDialRouting({ env: LIVE, nowMs: edt('2026-10-07T08:05:00'), deps: h.deps });
  assert.equal(h.actions.length, 1, 'once that day');
});

test('live: no LP re-add on a later day → nothing re-queued', async () => {
  __resetLoggedForTests();
  const h = harness({ addRows: [{ id: 1, status: 'completed', target_id: 'Conf - Next Day', payload: '{"records":[["9414670700"]]}' }] });
  h.marks.set(removeKey('9414670700', '2026-10-08', '2026-10-06'), {});
  h.setContactList('Conf - Next Day');
  await runBookedDialRouting({ env: LIVE, nowMs: edt('2026-10-07T08:00:00'), deps: h.deps });
  assert.equal(h.actions.length, 0);
});

test('live: sold and DNC phones are skipped', async () => {
  __resetLoggedForTests();
  const sold = harness({ soldPhones: ['9414670700'] });
  await runBookedDialRouting({ env: LIVE, nowMs: edt('2026-10-06T16:00:00'), deps: sold.deps });
  assert.equal(sold.actions.length, 0);
  __resetLoggedForTests();
  const dnc = harness({ dnc: ['9414670700'] });
  const res = await runBookedDialRouting({ env: LIVE, nowMs: edt('2026-10-06T16:00:00'), deps: dnc.deps });
  assert.equal(dnc.actions.length, 0);
  assert.ok(res.by_reason.dnc);
});

test('live: an expired pending approval is moved out of the queue', async () => {
  __resetLoggedForTests();
  const h = harness({ inbound: [] });
  h.actions.push({ id: 1, rule_applied: RULE_KEY, status: 'pending_approval', action_payload: { approval_expires_at: '2026-10-06T10:00:00Z', phone: '9414670700' } });
  const res = await runBookedDialRouting({ env: LIVE, nowMs: edt('2026-10-06T16:00:00'), deps: h.deps });
  assert.equal(res.approvals_expired, 1);
  assert.equal(h.actions[0].status, 'skipped');
  assert.ok(h.logs.some((l) => l.action === 'expired'));
});

test('mirror missing → falls back to the LP live read', async () => {
  __resetLoggedForTests();
  const h = harness({ mirrorMissing: true });
  const res = await runBookedDialRouting({ env: {}, nowMs: edt('2026-10-06T16:00:00'), deps: h.deps });
  assert.equal(res.inbound_source, 'lp_live');
  assert.equal(res.counts.would_add, 1);
});

test('a failed read queues nothing', async () => {
  __resetLoggedForTests();
  const h = harness();
  h.deps.runSQL = async () => { throw new Error('db down'); };
  const res = await runBookedDialRouting({ env: LIVE, nowMs: edt('2026-10-06T16:00:00'), deps: h.deps });
  assert.equal(res.ok, false);
  assert.equal(res.insufficient_evidence, true);
  assert.equal(h.actions.length, 0);
});

test('prior removal keys cover the previous days, not today', () => {
  const keys = priorRemoveKeys('9414670700', '2026-10-08', edt('2026-10-07T08:00:00'), 2);
  assert.deepEqual(keys, ['booked-remove:9414670700:2026-10-08:2026-10-06', 'booked-remove:9414670700:2026-10-08:2026-10-05']);
});

test('claims are read in ONE small request however many leads there are (2026-10-06: ~3,000 keys by name killed every pass)', async () => {
  __resetLoggedForTests();
  const many = Array.from({ length: 400 }, (_, i) => ({
    ...SHELLEY_RAW, id: String(500000 + i), lds_id: String(600000 + i), cst_id: String(700000 + i),
    phone: `(941)5${String(i).padStart(6, '0')}`, datereceived: '2026-10-06T10:00:00',
  }));
  const h = harness({ inbound: many });
  h.marks.set('dial-backstop:1:conf-next-day', {}); // another job's claim: never read
  const res = await runBookedDialRouting({ env: {}, nowMs: edt('2026-10-06T16:00:00'), deps: h.deps });
  assert.equal(res.ok, true, res.errors.join());
  assert.equal(h.markReads.length, 1);
  assert.equal(res.counts.would_add, 20, 'capped by BOOKED_ROUTING_MAX_ADDS');
});

test('the claim read pages until a short page', async () => {
  const { readBookedMarks } = await import('../src/jobs/booked-dial-routing.js');
  const keys = Array.from({ length: 2500 }, (_, i) => `booked-remove:${i}`);
  const calls = [];
  const db = { from: () => ({ select: () => {
    const chain = { like: () => chain, gte: () => chain, order: () => chain,
      range: async (from, to) => { calls.push(from); return { data: keys.slice(from, to + 1).map((k) => ({ dedup_key: k })), error: null }; } };
    return chain;
  } }) };
  const seen = await readBookedMarks(db, Date.now());
  assert.equal(seen.size, 2500);
  assert.deepEqual(calls, [0, 1000, 2000]);
});
