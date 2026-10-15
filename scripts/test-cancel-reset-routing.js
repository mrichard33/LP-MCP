/**
 * test-cancel-reset-routing.js — cancelled leads → Five9 "Resets-Hot"
 * (the user, 2026-10-15). Of 274 leads cancelled 10-01..10-14, 103 were never
 * called again. Covers the decision order, the record (number1-only key, LDS
 * key for the screen pop) and one live pass end to end with fakes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cancelResetMode, cancelResetConfig, decideCancelReset, buildResetRecord, markKey,
} from '../src/cancel-reset-routing.js';
import { runCancelResetRouting } from '../src/jobs/cancel-reset-routing.js';

const NOW = Date.parse('2026-10-15T17:30:00Z'); // 1:30 PM EDT
const cfg = cancelResetConfig({});
// LP stores Eastern wall clock; 10:00 AM EDT on 10-14.
const lead = (over = {}) => ({
  lp_lead_id: '582931', lp_prospect_id: '466001', first_name: 'Pat', last_name: 'Q',
  disposition_code: 'CXL', phone10: '3525550188', updated_wall: '2026-10-14T10:00:00', ...over,
});
const ok = { newestLeadId: '582931', sold: false, onDnc: false, optedOut: false, resetCalled: false, marked: false, nowMs: NOW, cfg };

test('mode: live by the user\'s ruling; a typo never dials', () => {
  assert.equal(cancelResetMode({}), 'live');
  assert.equal(cancelResetMode({ CANCEL_RESET_ROUTING_MODE: 'off' }), 'off');
  assert.equal(cancelResetMode({ CANCEL_RESET_ROUTING_MODE: 'lvie' }), 'shadow');
  assert.equal(cfg.list, 'Resets-Hot');
});

test('a cancelled lead nobody reset is pushed; CCC counts as cancelled', () => {
  assert.deepEqual(decideCancelReset({ ...ok, lead: lead() }), { action: 'push', reason: 'cancelled_not_reset' });
  assert.equal(decideCancelReset({ ...ok, lead: lead({ disposition_code: 'CCC' }) }).action, 'push');
});

test('never pushed: a newer lead, sold, DNC, opted out, already reset, already pushed, not cancelled', () => {
  const r = (over) => decideCancelReset({ ...ok, lead: lead(), ...over }).reason;
  assert.equal(r({ newestLeadId: '583999' }), 'newer_lead');
  assert.equal(r({ sold: true }), 'sold');
  assert.equal(r({ onDnc: true }), 'dnc');
  assert.equal(r({ optedOut: true }), 'opted_out');
  assert.equal(r({ resetCalled: true }), 'reset_called');
  assert.equal(r({ marked: true }), 'already_pushed');
  assert.equal(decideCancelReset({ ...ok, lead: lead({ disposition_code: 'Set' }) }).reason, 'not_cancelled');
  assert.equal(decideCancelReset({ ...ok, lead: lead({ lp_prospect_id: null }) }).reason, 'no_custid');
});

test('could not read DNC or consent: wait, never dial blind', () => {
  assert.deepEqual(decideCancelReset({ ...ok, lead: lead(), onDnc: null }), { action: 'wait', reason: 'dnc_unreadable' });
  assert.deepEqual(decideCancelReset({ ...ok, lead: lead(), optedOut: null }), { action: 'wait', reason: 'consent_unreadable' });
});

test('timing: a fresh cancel waits the grace; an old one is out of the window', () => {
  // 1:15 PM EDT cancel, read at 1:30 PM: inside the 30-minute grace.
  assert.equal(decideCancelReset({ ...ok, lead: lead({ updated_wall: '2026-10-15T13:15:00' }) }).reason, 'too_new');
  assert.equal(decideCancelReset({ ...ok, lead: lead({ updated_wall: '2026-09-20T10:00:00' }) }).reason, 'out_of_window');
});

test('the record carries the LP keys for the screen pop; the push is keyed on number1 alone', () => {
  const rec = buildResetRecord(lead());
  assert.deepEqual(rec.fieldNames, ['number1', 'first_name', 'last_name', 'CustID', 'lead_id', 'LPRecKey']);
  assert.deepEqual(rec.values, ['3525550188', 'Pat', 'Q', '466001', '582931', 'LDS582931']);
  assert.equal(markKey('582931', '2026-10-14T10:00:00'), 'cancel-reset:582931:2026-10-14');
});

function harness({ dnc = [], optOutLeads = [], resetCallAt = null } = {}) {
  const inserted = [];
  const marks = new Set();
  const runSQL = async (sql) => {
    if (/FROM lp_leads\s+WHERE disposition_code IN/.test(sql)) {
      return [lead(), lead({ lp_lead_id: '581045', lp_prospect_id: '466002', phone10: '3525550199' })];
    }
    if (/newest_id/.test(sql)) {
      return [{ phone10: '3525550188', newest_id: '582931', sold: false }, { phone10: '3525550199', newest_id: '581045', sold: false }];
    }
    if (/FROM five9_events_raw/.test(sql)) return resetCallAt ? [{ phone10: '3525550199', campaign: 'Resets-Hot', last_at: resetCallAt }] : [];
    if (/FROM contact_consent/.test(sql)) return optOutLeads.map((id) => ({ lead_id: id, prospect_id: null }));
    throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
  };
  const supabase = {
    from(table) {
      const api = {
        _rows: null,
        select() { return api; },
        in(_c, keys) { return Promise.resolve({ data: keys.filter((k) => marks.has(k)).map((k) => ({ dedup_key: k })), error: null }); },
        upsert(row) {
          const fresh = !marks.has(row.dedup_key);
          marks.add(row.dedup_key);
          return { select: () => Promise.resolve({ data: fresh ? [row] : [], error: null }) };
        },
        insert(row) {
          inserted.push(row);
          return { select: () => ({ single: () => Promise.resolve({ data: { id: inserted.length }, error: null }) }) };
        },
        delete() { return { in: () => Promise.resolve({ error: null }) }; },
      };
      return table ? api : api;
    },
  };
  return { inserted, deps: { runSQL, supabase, checkDnc: async () => ({ on_dnc: dnc }) } };
}

test('live pass: pushes each cancelled lead once to Resets-Hot, skips the one a Reset campaign already called', async () => {
  // 581045 was called by Resets-Hot at 11 AM EDT on 10-14, after its 10 AM cancel.
  const h = harness({ resetCallAt: '2026-10-14T15:00:00Z' });
  const out = await runCancelResetRouting({ env: {}, nowMs: NOW, deps: h.deps });
  assert.equal(out.pushed, 1);
  assert.equal(out.counts.reset_called, 1);
  const a = h.inserted[0];
  assert.equal(a.action_type, 'five9_add_records_to_list');
  assert.equal(a.target_id, 'Resets-Hot');
  assert.equal(a.requires_approval, false);
  assert.equal(a.rule_applied, 'CANCEL_RESET_ROUTING');
  assert.equal(a.action_payload.key_fields, undefined, 'number1 alone: the existing record is old enough for Resets V2');
  const again = await runCancelResetRouting({ env: {}, nowMs: NOW + 15 * 60_000, deps: h.deps });
  assert.equal(again.pushed, 0, 'once per cancel');
  assert.equal(again.counts.already_pushed, 1);
});

test('live pass: DNC and opt-outs are skipped; shadow writes nothing', async () => {
  const h = harness({ dnc: ['3525550188'], optOutLeads: ['581045'] });
  const out = await runCancelResetRouting({ env: {}, nowMs: NOW, deps: h.deps });
  assert.equal(out.pushed, 0);
  assert.equal(out.counts.dnc, 1);
  assert.equal(out.counts.opted_out, 1);
  const s = harness();
  const shadow = await runCancelResetRouting({ env: { CANCEL_RESET_ROUTING_MODE: 'shadow' }, nowMs: NOW, deps: s.deps });
  assert.equal(shadow.counts.would_push, 2);
  assert.equal(s.inserted.length, 0);
});

test('a failed DNC read waits instead of dialing', async () => {
  const h = harness();
  h.deps.checkDnc = async () => { throw new Error('Five9 404'); };
  const out = await runCancelResetRouting({ env: {}, nowMs: NOW, deps: h.deps });
  assert.equal(out.pushed, 0);
  assert.equal(out.counts.dnc_unreadable, 2);
  assert.equal(h.inserted.length, 0);
});
