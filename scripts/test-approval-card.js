/**
 * test-approval-card.js — plain-English approval cards (2026-09-22).
 *
 * No network and no database. The card body is pure (src/approval-card.js);
 * the loader and renderApprovalCard are exercised through a stub supabase.
 *
 * The fixture is the live card that prompted the change: agent_actions
 * #486315 / system_events #3856701, pulled 2026-09-22.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import {
  BRANCH_NAMES,
  branchName,
  buildApprovalCardText,
  conditionFieldsUsed,
  describeApprove,
  describeEvent,
  describeReject,
  formatEt,
  repDisplayName,
  stripRulePrefix,
} from '../src/approval-card.js';
import { loadApprovalCardContext } from '../src/approval-card-context.js';
import { renderApprovalCard } from '../src/groupme.js';

// ─── live fixture: #486315 ─────────────────────────────────────────

const ACTION_486315 = {
  id: 486315,
  event_id: 3856701,
  action_type: 'update_opportunity',
  action_payload: { status: 'won', pipeline: 'P2' },
  reasoning: 'Rule P2_JOB_TERMINAL_WON: LP job reached a collected status -> mark P2 opportunity won',
  rule_applied: 'P2_JOB_TERMINAL_WON',
  target_id: 'KHI08xNpaUax4wOmzFEE',
  batch_id: 'evt_3856701_rule_P2_JOB_TERMINAL_WON_1790103265193',
};

const EVENT_3856701 = {
  id: 3856701,
  event_type: 'lp.job_status_changed',
  event_subtype: 'Paid In Full',
  created_at: '2026-09-22T18:53:29.912014+00:00',
  payload: {
    job_value: 116000,
    lp_job_id: '58856',
    lp_lead_id: '551617',
    new_status: 'Paid In Full',
    old_status: 'Started',
    branch_code: 'FTMYR',
    ghl_contact_id: 'KHI08xNpaUax4wOmzFEE',
  },
};

const RULE_P2_WON = {
  rule_key: 'P2_JOB_TERMINAL_WON',
  rule_name: 'LP job reached a collected status -> mark P2 opportunity won',
  conditions: null,
  context_conditions: { event_subtype_in: ['Paid In Full', 'PIF Survey Ready', 'PIF NO Survey', 'Assumed Complete'] },
};

// What the old card showed: all of this was on it, none of it is decision-relevant here.
const ENRICHMENT_486315 = {
  repName: 'Carr, Michael',
  lpSource: 'Internet',
  disposition: 'Sale',
  prospectId: '440531',
  score: -10,
  tier: 'cold',
  marketCode: null,
  market: null,
};

const EXPECTED_486315 = [
  '🔔 Approval needed · #486315',
  'LP job reached a collected status → mark P2 opportunity won',
  "What happened: Stacey Wheeler's LP job #58856 changed Started → Paid In Full (Sep 22, 2:53 PM ET).",
  "If you approve: Stacey's Pipeline 2 opportunity is marked WON ($116,000).",
  'If you reject: Nothing changes; the Pipeline 2 opportunity stays as it is. It is not retried.',
  'Contact: Stacey Wheeler · (561) 373-9673 · Rep: Michael Carr · Branch: Fort Myers · Source: Internet',
  'ref: P2_JOB_TERMINAL_WON · event 3856701',
].join('\n');

function card486315(overrides = {}) {
  return buildApprovalCardText({
    actions: [ACTION_486315],
    shortRef: '486315',
    rule: RULE_P2_WON,
    event: EVENT_3856701,
    contactName: 'Stacey Wheeler',
    contactPhone: '+15613739673',
    enrichment: ENRICHMENT_486315,
    ...overrides,
  });
}

test('lp.job_status_changed + update_opportunity renders the exact plain-English card', () => {
  assert.equal(card486315(), EXPECTED_486315);
});

test('the rule code appears ONLY in the footer ref line', () => {
  const lines = card486315().split('\n');
  const withCode = lines.filter(l => l.includes('P2_JOB_TERMINAL_WON'));
  assert.deepEqual(withCode, ['ref: P2_JOB_TERMINAL_WON · event 3856701']);
  assert.equal(lines.at(-1), withCode[0]);
});

test('the rule code is scrubbed even when the reasoning fallback echoes it', () => {
  const text = buildApprovalCardText({
    actions: [{ ...ACTION_486315, reasoning: 'Rule P2_JOB_TERMINAL_WON: fired because P2_JOB_TERMINAL_WON matched' }],
    shortRef: '486315',
    rule: null,
    event: null,
    contactName: 'Stacey Wheeler',
  });
  const lines = text.split('\n');
  assert.deepEqual(lines.filter(l => l.includes('P2_JOB_TERMINAL_WON')), ['ref: P2_JOB_TERMINAL_WON · event 3856701']);
});

test('score / tier / disposition / prospect stay off a card whose rule does not use them', () => {
  const text = card486315();
  for (const noise of ['Score', 'Tier', 'Disposition', 'Prospect', '-10', 'cold', '440531']) {
    assert.ok(!text.includes(noise), `card should not mention ${noise}`);
  }
});

test('…and appear when the rule conditions reference them', () => {
  const rule = { rule_name: 'W9.0 silent-terminal', context_conditions: { lp_disposition_in: ['OPPFDN'], min_intent_score: 50 } };
  assert.deepEqual(conditionFieldsUsed(rule), { score: true, tier: false, disposition: true, prospect: false });
  const text = card486315({ rule });
  assert.match(text, /^Disposition: Sale · Score: -10$/m);
  assert.ok(!text.includes('Tier'));
});

// ─── UTC → ET ─────────────────────────────────────────────────────

test('UTC renders in ET, both sides of DST', () => {
  assert.equal(formatEt('2026-09-22T18:53:29Z'), 'Sep 22, 2:53 PM ET');   // EDT, UTC-4
  assert.equal(formatEt('2026-01-15T12:00:00Z'), 'Jan 15, 7:00 AM ET');   // EST, UTC-5
  // A UTC time after midnight is still the previous day in ET.
  assert.equal(formatEt('2026-09-23T02:30:00Z'), 'Sep 22, 10:30 PM ET');
  assert.equal(formatEt('not a date'), null);
  assert.equal(formatEt(null), null);
});

// ─── branch codes ────────────────────────────────────────────────

test('branch codes map to branch names; unknown codes never print', () => {
  assert.equal(branchName('FTMYR'), 'Fort Myers');
  assert.equal(branchName('ftmyr '), 'Fort Myers');
  assert.equal(branchName('STPET'), 'St. Petersburg');
  assert.equal(branchName('RFED'), null);
  assert.equal(branchName(''), null);
  assert.equal(Object.keys(BRANCH_NAMES).length, 9);
});

test('branch falls back to the enrichment market code, then the market name', () => {
  const noEventBranch = { ...EVENT_3856701, payload: { ...EVENT_3856701.payload, branch_code: undefined } };
  assert.match(card486315({ event: noEventBranch, enrichment: { ...ENRICHMENT_486315, marketCode: 'JAX' } }), /Branch: Jacksonville/);
  assert.match(card486315({ event: noEventBranch, enrichment: { ...ENRICHMENT_486315, market: 'Sarasota' } }), /Branch: Sarasota/);
  assert.doesNotMatch(card486315({ event: noEventBranch }), /Branch:/);
  // An unmapped code is not printed as a code.
  const rfed = { ...EVENT_3856701, payload: { ...EVENT_3856701.payload, branch_code: 'RFED' } };
  assert.doesNotMatch(card486315({ event: rfed }), /RFED/);
});

test('LP "Last, First" rep names read First Last', () => {
  assert.equal(repDisplayName('Carr, Michael'), 'Michael Carr');
  assert.equal(repDisplayName("O'Connor, Tim"), "Tim O'Connor");
  assert.equal(repDisplayName('Tim OConnor'), 'Tim OConnor');
  assert.equal(repDisplayName(null), null);
});

// ─── other action types ──────────────────────────────────────────

test('send_sms shows the full message text', () => {
  const long = 'Hi Stacey, this is Michael from Reece. '.repeat(8).trim();
  const action = { id: 1, action_type: 'send_sms', action_payload: { message: long }, rule_applied: 'X_RULE' };
  const approve = describeApprove(action, { contactName: 'Stacey Wheeler' });
  assert.equal(approve, `Sends Stacey this text:\n“${long}”`);
  assert.equal(describeReject([action], { contactName: 'Stacey Wheeler' }), 'Nothing changes; nothing is sent to Stacey. It is not retried.');
});

test('send_message uses the pre-generated reply from enrichment, or says the draft failed', () => {
  const action = { action_type: 'send_message', action_payload: { channel: 'sms', requires_ai_generation: false } };
  assert.equal(
    describeApprove(action, { contactName: 'Jo Diaz', enrichment: { generatedMessage: 'Tuesday at 3 works.' } }),
    'Sends Jo this text:\n“Tuesday at 3 works.”',
  );
  assert.match(
    describeApprove(action, { contactName: 'Jo Diaz', enrichment: { aiGenerationError: 'timeout' } }),
    /draft failed to generate \(timeout\)\. Reject and handle by hand\./,
  );
});

test('add_tag names the tag and its meaning when known', () => {
  assert.equal(
    describeApprove({ action_type: 'add_tag', action_payload: { tag: 'loss-reason:dnc' } }, {}),
    'Adds tag `loss-reason:dnc` — records why the deal was lost.',
  );
  assert.equal(
    describeApprove({ action_type: 'add_tag', action_payload: { tag: 'hot-lead' } }, {}),
    'Adds tag `hot-lead`.',
  );
});

test('unknown action types fall back to a short key: value list, private keys hidden', () => {
  const text = describeApprove({
    action_type: 'five9_modify_campaign_lists',
    action_payload: { campaign_name: 'Aged Leads', lists: ['A', 'B'], _escalated_at: '2026-09-02T17:20:42Z' },
  }, {});
  assert.equal(text, 'Runs five9 modify campaign lists with: campaign name: Aged Leads, lists: A, B.');
});

test('create_task and add_to_workflow read in plain English, due date in ET', () => {
  assert.equal(
    describeApprove({ action_type: 'create_task', action_payload: { title: 'Call back about the quote', due_date: '2026-09-24', assigned_to_name: 'Michael Carr' } }, {}),
    'Creates a task for Michael Carr: Call back about the quote (due Sep 24).',
  );
  // A GHL user id is not a name.
  assert.match(
    describeApprove({ action_type: 'create_task', action_payload: { title: 'x', assigned_to: 'aBcD1234EfGh5678IjKl' } }, {}),
    /for the contact's owner:/,
  );
  assert.equal(
    describeApprove({ action_type: 'add_to_workflow', action_payload: { canonical_name: 'S4.5 Post-Demo Follow-up' } }, { contactName: 'Stacey Wheeler' }),
    'Enrolls Stacey in S4.5 Post-Demo Follow-up.',
  );
});

test('a mixed batch lists each change and gives a generic reject line', () => {
  const actions = [
    { id: 480682, action_type: 'set_stage', action_payload: { tag: 'stage:booked-main-appointment' }, rule_applied: 'DNC_LIFT_ON_REENGAGEMENT_LP', event_id: 1 },
    { id: 480687, action_type: 'set_dnd', action_payload: { status: 'inactive', channels: ['SMS', 'Call'] }, rule_applied: 'DNC_LIFT_ON_REENGAGEMENT_LP' },
  ];
  const text = buildApprovalCardText({ actions, shortRef: '480682', contactName: 'Frederic Bien' });
  assert.match(text, /^If you approve:$/m);
  assert.match(text, /^• Moves Frederic to the "booked main appointment" stage\.$/m);
  assert.match(text, /^• Turns Do Not Disturb OFF \(SMS, Call\), so Frederic can be contacted again\.$/m);
  assert.match(text, /^If you reject: Nothing changes; none of the above happens\. It is not retried\.$/m);
});

// ─── what happened ───────────────────────────────────────────────

test('missing event row falls back to the reasoning without its "Rule CODE:" prefix', () => {
  const text = card486315({ event: null });
  assert.match(text, /^What happened: LP job reached a collected status -> mark P2 opportunity won$/m);
  assert.match(text, /^ref: P2_JOB_TERMINAL_WON · event 3856701$/m);
  assert.equal(stripRulePrefix('Rule ABC_1: did a thing'), 'did a thing');
});

test('disposition events say who dispositioned what, and when', () => {
  const five9 = {
    event_type: 'five9.disposition_set',
    created_at: '2026-09-17T19:42:39Z',
    payload: { disposition_name: 'Appointment Set', agent_name: 'Daana Ellis - LF', call_end_at: '2026-09-17T19:42:38.549Z' },
  };
  assert.equal(
    describeEvent({ event: five9, contactName: 'Frederic Bien' }),
    'Frederic Bien was dispositioned "Appointment Set" on a Five9 call by Daana Ellis (Sep 17, 3:42 PM ET).',
  );
  const lp = { event_type: 'lp.disposition_changed', created_at: '2026-09-21T16:05:00Z', payload: { disposition_code: 'Verif' } };
  assert.equal(describeEvent({ event: lp, contactName: 'Frederic Bien' }), 'Frederic Bien was dispositioned "Verif" in LP (Sep 21, 12:05 PM ET).');
});

test('inbound message events quote the first 120 characters', () => {
  const msg = 'x'.repeat(200);
  const ev = { event_type: 'ghl.reply_received', created_at: '2026-09-22T14:00:00Z', payload: { message_text: msg } };
  const out = describeEvent({ event: ev, contactName: 'Jo Diaz' });
  assert.equal(out, `Jo Diaz texted: “${'x'.repeat(119)}…” (Sep 22, 10:00 AM ET).`);
});

test('a contact id is never used as a name', () => {
  const text = card486315({ contactName: 'KHI08xNpaUax4wOmzFEE' });
  assert.match(text, /^If you approve: The contact's Pipeline 2 opportunity/m);
  assert.match(text, /^Contact: Unknown contact · /m);
});

// ─── loader + renderApprovalCard (stub supabase) ─────────────────

function stubSupabase(rows, { failRule = false } = {}) {
  return {
    from(table) {
      const filters = {};
      const q = {
        select() { return q; },
        eq(k, v) { filters[k] = v; return q; },
        limit() { return q; },
        async maybeSingle() {
          if (table === 'agent_rules' && failRule) return { data: null, error: { message: 'boom' } };
          const row = (rows[table] || []).find(r => Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)));
          return { data: row || null, error: null };
        },
      };
      return q;
    },
  };
}

test('renderApprovalCard: live #486315 through the loader, GroupMe keeps its reply footer, Slack does not', async () => {
  const deps = { supabase: stubSupabase({ agent_rules: [RULE_P2_WON], system_events: [EVENT_3856701] }) };
  const { slackCardText, groupmeText } = await renderApprovalCard(
    [ACTION_486315], 'Stacey Wheeler', '+15613739673', ENRICHMENT_486315, deps,
  );
  assert.equal(slackCardText, EXPECTED_486315);
  assert.equal(groupmeText, `${EXPECTED_486315}\n\nReply: Yes 486315  •  No 486315  •  Edit 486315 <describe change>`);
});

test('a failed rule read still produces a card — it falls back, never throws', async () => {
  const deps = { supabase: stubSupabase({ system_events: [EVENT_3856701] }, { failRule: true }) };
  const ctx = await loadApprovalCardContext(ACTION_486315, deps);
  assert.equal(ctx.rule, null);
  assert.equal(ctx.event.id, 3856701);
  const { slackCardText } = await renderApprovalCard([ACTION_486315], 'Stacey Wheeler', null, {}, deps);
  assert.match(slackCardText, /^Approve: update opportunity$/m);
  assert.match(slackCardText, /^What happened: Stacey Wheeler's LP job #58856/m);
});
