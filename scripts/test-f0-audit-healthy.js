/**
 * F.0 integrity audit: the O.0 handoff is healthy; a lead F.0 never enrolled
 * is enrolled by the audit (handoff v3.4 Fix 5, 2026-10-16).
 * Collier (582185), Fulwood (581286), Dierickx (582740): enrolled in F.0, moved
 * to O.0, still flagged.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const audit = await import('../src/jobs/f0-integrity-audit.js');
const { fakeSupabase } = await import('./lib/fake-supabase.js');

const NOW = Date.parse('2026-10-16T16:00:00Z');
const oppfdn = (cid, leadId) => ({
  ghl_contact_id: cid, lp_lead_id: leadId, disposition_code: 'OPPFDN', closed_won: false,
  appointment_date: '2026-10-14T14:00:00+00:00', created_at_lp: '2026-10-01T10:00:00+00:00', updated_at_lp: '2026-10-14T20:00:00+00:00', lp_deleted_at: null,
});

test('healthy: f.0-v2, active-o.0 or agentic-routed-o.0 (Collier, Fulwood, Dierickx)', () => {
  const leads = [oppfdn('c', 'L')];
  for (const tags of [['rehash', 'f.0-v2', 'active-o.0'], ['f.0-v2', 'agentic-routed-o.0'], ['active-o.0']]) {
    assert.equal(audit.isMissingFromF0(leads, tags, NOW), false, tags.join(','));
  }
  assert.equal(audit.isMissingFromF0(leads, ['lp-demo-completed'], NOW), true);
});

test('only a current OPPFDN lead can be "missing" — an ND / No Demo / Verif current lead never is', () => {
  for (const code of ['ND', 'No Demo', 'Verif']) {
    assert.equal(audit.isMissingFromF0([{ ...oppfdn('c', 'L'), disposition_code: code }], [], NOW), false, code);
  }
});

function deps(seed) {
  const db = fakeSupabase({
    agent_rules: [{ rule_key: 'F0_ENROLL_CURRENT_OPPFDN', action_template: [
      { action_type: 'add_to_workflow', target_system: 'ghl', target_entity: 'contact', params: { format: 'form', webhook_url: 'https://example/f0' } },
    ] }],
    contact_objection_states: [], system_events: [], audit_posted_items: [],
    ...seed,
  });
  return {
    db,
    deps: {
      nowMs: NOW, sinceMs: Date.parse('2026-10-01T15:40:00Z'), supabase: db,
      checkS52Entry: async () => ({ allow: true }),
      sendAlertMessage: async () => { throw new Error('must not post'); },
      hlRunSQL: async (sql) => {
        if (/unnest\(tags\)|unnest\(contacts\.tags\)/.test(sql)) return [];
        return [{ ghl_contact_id: 'never', tags: ['lp-demo-completed'], first_name: 'N', last_name: 'Ever' },
          { ghl_contact_id: 'ran', tags: ['lp-demo-completed'], first_name: 'R', last_name: 'An' }]
          .filter((r) => sql.includes(`'${r.ghl_contact_id}'`));
      },
    },
  };
}

test('F0_ENROLL never ran → the audit enrols with rule 393\'s own actions and reports "auto-enrolled"', async () => {
  const { db, deps: d } = deps({ lp_leads: [oppfdn('never', 'L-never')], agent_actions: [] });
  const r = await audit.runF0IntegrityAudit({ post: false, deps: d });
  assert.equal(r.ok, true);
  const queued = db.tables?.agent_actions || (await db.from('agent_actions').select('*')).data;
  assert.equal(queued.filter((a) => a.rule_applied === 'F0_AUDIT_AUTOENROL').length, 1);
  assert.equal(queued[0].action_payload.webhook_url, 'https://example/f0');
  const item = r.items.find((i) => i.contact_id === 'never');
  assert.equal(item.reason, 'f0_autoenrolled');
  assert.match(item.todo, /auto-enrolled/);
});

test('F0_ENROLL already completed → healthy, dropped, nothing queued', async () => {
  const { db, deps: d } = deps({
    lp_leads: [oppfdn('ran', 'L-ran')],
    agent_actions: [{ target_id: 'ran', status: 'completed', rule_applied: 'F0_ENROLL_CURRENT_OPPFDN', action_type: 'add_to_workflow' }],
  });
  const r = await audit.runF0IntegrityAudit({ post: false, deps: d });
  assert.equal(r.missing.length, 0);
  const rows = (await db.from('agent_actions').select('*')).data;
  assert.equal(rows.length, 1);
});

test('read-only callers (autoEnroll:false) enrol nothing', async () => {
  const { db, deps: d } = deps({ lp_leads: [oppfdn('never', 'L-never')], agent_actions: [] });
  const r = await audit.runF0IntegrityAudit({ post: false, autoEnroll: false, deps: d });
  assert.equal(r.missing.length, 1);
  assert.equal((await db.from('agent_actions').select('*')).data.length, 0);
});
