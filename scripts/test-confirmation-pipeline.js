/**
 * scripts/test-confirmation-pipeline.js — 2026-10-16 handoff "4. Confirmation Pipeline".
 *
 * The rules (src/confirmation-pipeline/rules.js), the handler, the clock and
 * the sweep, offline: an in-memory Supabase (scripts/lib/fake-supabase.js) and
 * an in-memory GHL that enforces one card per contact per pipeline, as the
 * real account does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './lib/fake-supabase.js';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const rules = await import('../src/confirmation-pipeline/rules.js');
const { syncConfirmationCard } = await import('../src/actions/handlers/confirmation-pipeline-sync.js');
const { runConfirmationClock } = await import('../src/jobs/confirmation-pipeline-clock.js');
const { runConfirmationSweep, listOpenCards } = await import('../src/jobs/confirmation-pipeline-sweep.js');

const {
  readConfig, readAppointment, targetFor, decideMove, closeStatusFor, cardName, isCanvassLead,
  clockNeedsWork, alertDue, sweepAppointmentYmd, DEFAULT_PIPELINE_ID, DEFAULT_STAGE_IDS,
} = rules;

const PIPE = DEFAULT_PIPELINE_ID;
const S = DEFAULT_STAGE_IDS;
const NOW = new Date('2026-10-16T14:00:00Z'); // 10:00 AM ET, Friday
const LIVE = { CONF_PIPE_DRY_RUN: 'false' };
const cfgLive = readConfig(LIVE);

/* ── fakes ─────────────────────────────────────────────────────────────── */

function fakeGhl({ opps = [], contacts = {}, now = () => NOW } = {}) {
  const store = new Map(opps.map((o) => [o.id, { status: 'open', ...o }]));
  const calls = [];
  let seq = 0;
  async function ghlFetch(method, path, body = null) {
    calls.push({ method, path, body });
    const [p, qs] = path.split('?');
    const q = new URLSearchParams(qs || '');
    if (method === 'GET' && p === '/opportunities/search') {
      let list = [...store.values()];
      if (q.get('contact_id')) list = list.filter((o) => o.contactId === q.get('contact_id'));
      if (q.get('pipeline_id')) list = list.filter((o) => o.pipelineId === q.get('pipeline_id'));
      if (q.get('status')) list = list.filter((o) => o.status === q.get('status'));
      return { opportunities: list.map((o) => ({ ...o })), meta: {} };
    }
    let m = /^\/opportunities\/([^/]+)$/.exec(p);
    if (m && method === 'GET') {
      const o = store.get(m[1]);
      if (!o) throw new Error(`GHL GET ${path} → 404: not found`);
      return { opportunity: { ...o } };
    }
    if (m && method === 'PUT') {
      const o = store.get(m[1]);
      if (!o) throw new Error(`GHL PUT ${path} → 404: not found`);
      if (body.pipelineStageId && body.pipelineStageId !== o.pipelineStageId) o.lastStageChangeAt = now().toISOString();
      if (body.status && body.status !== o.status) o.lastStatusChangeAt = now().toISOString();
      Object.assign(o, body);
      return { opportunity: { ...o } };
    }
    if (method === 'POST' && p === '/opportunities/') {
      const dup = [...store.values()].find((o) => o.contactId === body.contactId && o.pipelineId === body.pipelineId);
      if (dup) throw new Error(`GHL POST /opportunities/ → 400: {"message":"Can not create duplicate opportunity for the contact.","meta":{"existingId":"${dup.id}"}}`);
      const id = `opp_${++seq}`;
      store.set(id, { id, ...body, lastStageChangeAt: now().toISOString() });
      return { opportunity: { id } };
    }
    m = /^\/contacts\/([^/]+)$/.exec(p);
    if (m && method === 'GET') return { contact: contacts[m[1]] || { id: m[1], firstName: 'Jane', lastName: 'Doe', tags: [] } };
    throw new Error(`unexpected GHL call ${method} ${path}`);
  }
  return { ghlFetch, store, calls, writes: () => calls.filter((c) => c.method !== 'GET') };
}

const quiet = { log() {}, warn() {}, error() {} };

function lead(over = {}) {
  return {
    lp_lead_id: '600001', ghl_contact_id: 'c1', disposition_code: 'Set',
    appointment_date: '2026-10-20T10:00:00+00:00', first_name: 'Jane', last_name: 'Doe',
    lead_source: 'Internet', ghl_entry_tag: null, ghl_intent_bucket: null,
    created_at_lp: '2026-10-15T12:00:00+00:00', lp_deleted_at: null, ...over,
  };
}

function setup({ leads = [lead()], rows = [], opps = [], env = LIVE, now = NOW, contacts } = {}) {
  const db = fakeSupabase({ lp_leads: leads, confirmation_opportunities: rows, confirmation_opportunity_log: [] });
  const clock = { now };
  const ghl = fakeGhl({ opps, contacts, now: () => clock.now });
  const slack = [];
  const deps = {
    supabase: db, ghlFetch: ghl.ghlFetch, env, now: () => clock.now, log: quiet,
    postToSlack: async (text, channel) => { slack.push({ text, channel }); return { ok: true, ts: '1.1' }; },
  };
  return { db, ghl, deps, slack, clock, rows: () => db._tables?.confirmation_opportunities };
}

async function table(db, name) {
  const { data } = await db.from(name).select('*');
  return data;
}

/* ── pure rules ────────────────────────────────────────────────────────── */

test('stage order: past → close, CXL, ND, Cnf, Verif, Set <24h, Set', () => {
  const t = (disposition, date) => targetFor({ disposition, appt: readAppointment(date), now: NOW, cfg: cfgLive });
  assert.deepEqual(t('Set', '2026-10-20T10:00:00+00:00'), { kind: 'stage', stage: 'new', reason: 'set' });
  assert.equal(t('Set', '2026-10-17T09:00:00+00:00').stage, 'confirm_now');        // 23h away
  assert.equal(t('Verif', '2026-10-17T09:00:00+00:00').stage, 'issue');             // Issue beats the 24h rule
  assert.equal(t('Cnf', '2026-10-20T10:00:00+00:00').stage, 'confirmed');
  assert.equal(t('ND', '2026-10-20T10:00:00+00:00').stage, 'disqualified');
  assert.deepEqual(t('CXL', '2026-10-20T10:00:00+00:00'), { kind: 'close', status: 'abandoned', reason: 'cxl' });
  assert.equal(t('Cnf', '2026-10-15T18:00:00+00:00').kind, 'close');                // yesterday
  assert.equal(t('Cnf', '2026-10-16T07:00:00+00:00').kind, 'close');                // 3h ago today (>2h)
  assert.equal(t('Cnf', '2026-10-16T09:00:00+00:00').kind, 'stage');                // 1h ago: not yet
  assert.equal(t('Issue', '2026-10-20T10:00:00+00:00').kind, 'hold');               // Issue is not mapped
});

test('a date-only appointment closes by date, never by a time it does not have', () => {
  const appt = readAppointment('2026-10-16T00:00:00+00:00');
  assert.equal(appt.hasTime, false);
  assert.equal(targetFor({ disposition: 'Set', appt, now: new Date('2026-10-16T23:00:00Z'), cfg: cfgLive }).kind, 'stage');
  assert.equal(alertDue({ row: { stage_key: 'new' }, appt, now: NOW, cfg: cfgLive }), false);
});

test('close mapping and card name', () => {
  assert.equal(closeStatusFor('confirmed'), 'won');
  assert.equal(closeStatusFor('disqualified'), 'lost');
  for (const k of ['new', 'issue', 'confirm_now']) assert.equal(closeStatusFor(k), 'abandoned');
  assert.equal(cardName('Jane Doe', readAppointment('2026-10-20T14:30:00+00:00')), 'Jane Doe — 10/20/2026 2:30 PM');
});

test('canvass is read every way the repo marks it', () => {
  assert.ok(isCanvassLead({ lead_source: 'Canvass Sticky' }));
  assert.ok(isCanvassLead({ ghl_entry_tag: 'entry:canvassing' }));
  assert.ok(isCanvassLead({ ghl_intent_bucket: 'canvassing' }));
  assert.ok(isCanvassLead({}, ['active-entry:canvassing']));
  assert.ok(!isCanvassLead({ lead_source: 'Internet' }, ['foo']));
});

test('locked stages: only ND, a Set reschedule and the close get out', () => {
  const at = readAppointment('2026-10-20T10:00:00+00:00').at;
  const row = { stage_key: 'confirmed', ghl_opportunity_id: 'o', appointment_at: at.toISOString(), last_moved_by: 'agent' };
  const live = { stageKey: 'confirmed', status: 'open' };
  const d = (target, disposition, apptAt = at) => decideMove({ row, live, target, disposition, apptAt, lpChangedAt: NOW.toISOString(), now: NOW });
  assert.equal(d({ kind: 'stage', stage: 'issue' }, 'Verif').op, 'blocked');
  assert.equal(d({ kind: 'stage', stage: 'new' }, 'Set').op, 'blocked');
  assert.equal(d({ kind: 'stage', stage: 'disqualified' }, 'ND').op, 'move');
  const later = new Date(at.getTime() + 3600_000);
  const r = d({ kind: 'stage', stage: 'new' }, 'Set', later);
  assert.equal(r.op, 'move'); assert.equal(r.reschedule, true);
  assert.equal(d({ kind: 'close', status: null }, 'Cnf').status, 'won');
});

test('a hand move: the clock never overrides it, a NEWER LP change does', () => {
  const at = readAppointment('2026-10-17T09:00:00+00:00').at;
  const row = { stage_key: 'new', ghl_opportunity_id: 'o', appointment_at: at.toISOString(), last_moved_by: 'agent' };
  const live = { stageKey: 'issue', status: 'open', lastStageChangeAt: '2026-10-16T13:00:00Z' };
  const clock = decideMove({ row, live, target: { kind: 'stage', stage: 'confirm_now' }, disposition: 'Set', apptAt: at, timeBased: true, now: NOW });
  assert.equal(clock.op, 'blocked'); assert.equal(clock.manualDetected, true);
  const older = decideMove({ row, live, target: { kind: 'stage', stage: 'confirmed' }, disposition: 'Cnf', apptAt: at, lpChangedAt: '2026-10-16T12:00:00Z', now: NOW });
  assert.equal(older.op, 'blocked');
  const newer = decideMove({ row, live, target: { kind: 'stage', stage: 'confirmed' }, disposition: 'Cnf', apptAt: at, lpChangedAt: '2026-10-16T13:30:00Z', now: NOW });
  assert.equal(newer.op, 'move');
});

test('clock pre-check: a hand-moved or locked card costs no GHL call', () => {
  const l = lead({ appointment_date: '2026-10-17T09:00:00+00:00' });
  const appt = readAppointment(l.appointment_date);
  const target = targetFor({ disposition: 'Set', appt, now: NOW, cfg: cfgLive });
  const base = { lp_lead_id: '600001', stage_key: 'new', last_lp_disposition: 'Set', appointment_at: appt.at.toISOString(), last_moved_by: 'agent' };
  assert.equal(clockNeedsWork({ row: base, lead: l, target, appt, cfg: cfgLive }), true);
  assert.equal(clockNeedsWork({ row: { ...base, last_moved_by: 'manual' }, lead: l, target, appt, cfg: cfgLive }), false);
  assert.equal(clockNeedsWork({ row: { ...base, stage_key: 'confirmed' }, lead: l, target, appt, cfg: cfgLive }), false);
  assert.equal(clockNeedsWork({ row: { ...base, lp_lead_id: '599999' }, lead: l, target, appt, cfg: cfgLive }), true);
});

test('sweep date: our row, then the Current Appointment field, then the card name', () => {
  assert.equal(sweepAppointmentYmd({ row: { appointment_at: '2026-10-15T14:00:00Z' } }).ymd, '2026-10-15');
  assert.equal(sweepAppointmentYmd({ currentApptField: '10/9/2026', cardTitle: 'X — 10/1/2026' }).ymd, '2026-10-09');
  assert.equal(sweepAppointmentYmd({ cardTitle: 'Jane Doe — 10/1/2026 10:00 AM' }).ymd, '2026-10-01');
  assert.equal(sweepAppointmentYmd({ cardTitle: 'Jane Doe' }).ymd, null);
});

test('CONF_PIPE_DRY_RUN is on unless it says false', () => {
  assert.equal(readConfig({}).dryRun, true);
  assert.equal(readConfig({ CONF_PIPE_DRY_RUN: 'true' }).dryRun, true);
  assert.equal(readConfig({ CONF_PIPE_DRY_RUN: 'false' }).dryRun, false);
});

/* ── handler ───────────────────────────────────────────────────────────── */

test('Set creates one card in the Confirmation Pipeline, named from the appointment', async () => {
  const s = setup();
  const r = await syncConfirmationCard({ contactId: 'c1', lpChangedAt: NOW.toISOString(), deps: s.deps });
  assert.equal(r.outcome, 'create');
  const post = s.ghl.calls.find((c) => c.method === 'POST');
  assert.equal(post.body.pipelineId, PIPE);
  assert.equal(post.body.pipelineStageId, S.new);
  assert.equal(post.body.name, 'Jane Doe — 10/20/2026 10:00 AM');
  const [row] = await table(s.db, 'confirmation_opportunities');
  assert.equal(row.stage_key, 'new'); assert.equal(row.ghl_opportunity_id, 'opp_1'); assert.equal(row.dry_run, false);
  // Same event again: no second card.
  const again = await syncConfirmationCard({ contactId: 'c1', deps: s.deps });
  assert.equal(again.outcome, 'noop');
  assert.equal(s.ghl.calls.filter((c) => c.method === 'POST').length, 1);
});

test('every GHL search carries pipeline_id', async () => {
  const s = setup();
  await syncConfirmationCard({ contactId: 'c1', deps: s.deps });
  const searches = s.ghl.calls.filter((c) => c.path.startsWith('/opportunities/search'));
  assert.ok(searches.length > 0);
  for (const c of searches) assert.match(c.path, new RegExp(`pipeline_id=${PIPE}`));
});

test('dry run: decides and logs, never writes GHL', async () => {
  const s = setup({ env: {} });
  const r = await syncConfirmationCard({ contactId: 'c1', deps: s.deps });
  assert.equal(r.outcome, 'create'); assert.equal(r.dry_run, true);
  assert.equal(s.ghl.writes().length, 0);
  const [row] = await table(s.db, 'confirmation_opportunities');
  assert.equal(row.dry_run, true);
  const log = await table(s.db, 'confirmation_opportunity_log');
  assert.equal(log[0].dry_run, true); assert.equal(log[0].action, 'create');
});

test('a live run treats a dry-run row as no state and creates the card', async () => {
  const s = setup({ env: {} });
  await syncConfirmationCard({ contactId: 'c1', deps: s.deps });
  s.deps.env = LIVE;
  const r = await syncConfirmationCard({ contactId: 'c1', deps: s.deps });
  assert.equal(r.outcome, 'create');
  const rows = await table(s.db, 'confirmation_opportunities');
  assert.equal(rows.length, 1); assert.equal(rows[0].dry_run, false); assert.equal(rows[0].ghl_opportunity_id, 'opp_1');
});

test('Set → Cnf → Verif stays Confirmed → ND goes to Disqualified', async () => {
  const s = setup();
  await syncConfirmationCard({ contactId: 'c1', deps: s.deps });
  const setL = async (code) => { await s.db.from('lp_leads').update({ disposition_code: code }).eq('lp_lead_id', '600001'); };
  await setL('Cnf');
  assert.equal((await syncConfirmationCard({ contactId: 'c1', lpChangedAt: NOW.toISOString(), deps: s.deps })).to_stage, 'confirmed');
  await setL('Verif');
  const v = await syncConfirmationCard({ contactId: 'c1', lpChangedAt: NOW.toISOString(), deps: s.deps });
  assert.equal(v.outcome, 'blocked'); assert.equal(v.reason, 'locked_stage');
  assert.equal(s.ghl.store.get('opp_1').pipelineStageId, S.confirmed);
  await setL('ND');
  await syncConfirmationCard({ contactId: 'c1', lpChangedAt: NOW.toISOString(), deps: s.deps });
  assert.equal(s.ghl.store.get('opp_1').pipelineStageId, S.disqualified);
});

test('live check 1: a card a person moved to Confirmed stays there on Verif', async () => {
  const s = setup();
  await syncConfirmationCard({ contactId: 'c1', deps: s.deps });
  s.ghl.store.get('opp_1').pipelineStageId = S.confirmed;                 // a person moves it
  s.ghl.store.get('opp_1').lastStageChangeAt = '2026-10-16T13:50:00Z';
  await s.db.from('lp_leads').update({ disposition_code: 'Verif' }).eq('lp_lead_id', '600001');
  const r = await syncConfirmationCard({ contactId: 'c1', lpChangedAt: NOW.toISOString(), deps: s.deps });
  assert.equal(r.outcome, 'blocked'); assert.equal(r.manual_detected, true);
  assert.equal(s.ghl.store.get('opp_1').pipelineStageId, S.confirmed);
  const [row] = await table(s.db, 'confirmation_opportunities');
  assert.equal(row.last_moved_by, 'manual'); assert.equal(row.stage_key, 'confirmed');
  const log = await table(s.db, 'confirmation_opportunity_log');
  assert.ok(log.some((l) => l.action === 'manual_detected'));
});

test('live check 2: a card moved back to New by hand at <24h is not moved by the clock', async () => {
  const s = setup({ leads: [lead({ appointment_date: '2026-10-17T09:00:00+00:00' })] });
  await syncConfirmationCard({ contactId: 'c1', deps: s.deps });            // → confirm_now
  assert.equal(s.ghl.store.get('opp_1').pipelineStageId, S.confirm_now);
  s.ghl.store.get('opp_1').pipelineStageId = S.new;                        // a person moves it back
  s.ghl.store.get('opp_1').lastStageChangeAt = '2026-10-16T13:55:00Z';
  const before = s.ghl.writes().length;
  await runConfirmationClock({ deps: s.deps });
  await runConfirmationClock({ deps: s.deps });
  assert.equal(s.ghl.store.get('opp_1').pipelineStageId, S.new);
  assert.equal(s.ghl.writes().length, before);
});

test('the clock finds a hand move before its 24h move, records it, then stops reading GHL for it', async () => {
  const s = setup({ leads: [lead({ appointment_date: '2026-10-17T12:00:00+00:00' })] });
  s.clock.now = new Date('2026-10-16T10:00:00Z');                           // 30h away → new
  await syncConfirmationCard({ contactId: 'c1', deps: s.deps });
  s.ghl.store.get('opp_1').pipelineStageId = S.issue;                      // a person moves it to Issue
  s.ghl.store.get('opp_1').lastStageChangeAt = '2026-10-16T11:00:00Z';
  s.clock.now = new Date('2026-10-16T17:00:00Z');                           // 23h away: the clock wants Confirm Now
  await runConfirmationClock({ deps: s.deps });
  assert.equal(s.ghl.store.get('opp_1').pipelineStageId, S.issue);
  const [row] = await table(s.db, 'confirmation_opportunities');
  assert.equal(row.last_moved_by, 'manual'); assert.equal(row.stage_key, 'issue');
  const before = s.ghl.calls.length;
  await runConfirmationClock({ deps: s.deps });
  assert.equal(s.ghl.calls.length, before, 'a hand-moved card costs no GHL call on later passes');
});

test('a reschedule renames and re-opens a locked card, and clears the alert', async () => {
  const s = setup();
  await syncConfirmationCard({ contactId: 'c1', deps: s.deps });
  await s.db.from('lp_leads').update({ disposition_code: 'Cnf' }).eq('lp_lead_id', '600001');
  await syncConfirmationCard({ contactId: 'c1', lpChangedAt: NOW.toISOString(), deps: s.deps });
  await s.db.from('confirmation_opportunities').update({ alerted_at: NOW.toISOString() }).eq('lp_lead_id', '600001');
  await s.db.from('lp_leads').update({ disposition_code: 'Set', appointment_date: '2026-10-21T18:00:00+00:00' }).eq('lp_lead_id', '600001');
  const r = await syncConfirmationCard({ contactId: 'c1', lpChangedAt: NOW.toISOString(), deps: s.deps });
  assert.equal(r.outcome, 'move'); assert.equal(r.to_stage, 'new'); assert.equal(r.renamed, true);
  const card = s.ghl.store.get('opp_1');
  assert.equal(card.name, 'Jane Doe — 10/21/2026 6:00 PM'); assert.equal(card.pipelineStageId, S.new);
  const [row] = await table(s.db, 'confirmation_opportunities');
  assert.equal(row.alerted_at, null);
  assert.equal(s.ghl.calls.filter((c) => c.method === 'POST').length, 1, 'never a second card');
});

test('a repeat homeowner\'s new lead re-points the existing card (one card per contact)', async () => {
  const oldAt = readAppointment('2026-10-01T10:00:00+00:00').at.toISOString();
  const s = setup({
    leads: [lead({ lp_lead_id: '590000', created_at_lp: '2026-09-20T10:00:00+00:00', appointment_date: '2026-10-01T10:00:00+00:00', disposition_code: 'NOC' }),
      lead({ lp_lead_id: '600001' })],
    rows: [{ id: 1, lp_lead_id: '590000', ghl_contact_id: 'c1', ghl_opportunity_id: 'old', stage_key: 'confirmed', last_moved_by: 'agent', appointment_at: oldAt, closed_status: 'won', closed_at: '2026-10-01T16:00:00Z', contact_name: 'Jane Doe', card_name: 'Jane Doe — 10/1/2026 10:00 AM', dry_run: false, updated_at: '2026-10-01T16:00:00Z' }],
    opps: [{ id: 'old', contactId: 'c1', pipelineId: PIPE, pipelineStageId: S.confirmed, status: 'won', name: 'Jane Doe — 10/1/2026 10:00 AM' }],
  });
  const r = await syncConfirmationCard({ contactId: 'c1', lpChangedAt: NOW.toISOString(), deps: s.deps });
  assert.equal(r.outcome, 'reopen'); assert.equal(r.opportunity_id, 'old');
  const card = s.ghl.store.get('old');
  assert.equal(card.status, 'open'); assert.equal(card.pipelineStageId, S.new); assert.equal(card.name, 'Jane Doe — 10/20/2026 10:00 AM');
  const rows = await table(s.db, 'confirmation_opportunities');
  assert.equal(rows.length, 1); assert.equal(rows[0].lp_lead_id, '600001'); assert.equal(rows[0].closed_status, null);
  assert.equal(s.ghl.calls.filter((c) => c.method === 'POST').length, 0);
});

test('never a card for a past appointment; canvass is skipped', async () => {
  const past = setup({ leads: [lead({ appointment_date: '2026-10-10T10:00:00+00:00' })] });
  assert.equal((await syncConfirmationCard({ contactId: 'c1', deps: past.deps })).outcome, 'skip');
  assert.equal(past.ghl.calls.length, 0);
  const canvass = setup({ leads: [lead({ lead_source: 'Canvass' })] });
  assert.equal((await syncConfirmationCard({ contactId: 'c1', deps: canvass.deps })).reason, 'canvass_lead');
  assert.equal(canvass.ghl.calls.length, 0);
  const tagged = setup({ contacts: { c1: { id: 'c1', firstName: 'Jane', tags: ['active-entry:canvassing'] } } });
  assert.equal((await syncConfirmationCard({ contactId: 'c1', deps: tagged.deps })).reason, 'canvass_lead');
  assert.equal(tagged.ghl.writes().length, 0);
});

test('CXL closes the card abandoned; the card is kept, not deleted', async () => {
  const s = setup();
  await syncConfirmationCard({ contactId: 'c1', deps: s.deps });
  await s.db.from('lp_leads').update({ disposition_code: 'CXL' }).eq('lp_lead_id', '600001');
  const r = await syncConfirmationCard({ contactId: 'c1', lpChangedAt: NOW.toISOString(), deps: s.deps });
  assert.equal(r.outcome, 'close'); assert.equal(r.closed_status, 'abandoned');
  assert.equal(s.ghl.store.get('opp_1').status, 'abandoned');
  assert.ok(!s.ghl.calls.some((c) => c.method === 'DELETE'));
});

test('a duplicate-400 adopts the card only when it is in this pipeline', async () => {
  const s = setup({ opps: [{ id: 'p1card', contactId: 'c1', pipelineId: 'x0cxXOkKwqAWVvcPdKZQ', pipelineStageId: 'x', status: 'open' }] });
  // A P1 card does not collide (GHL's rule is per pipeline): a new card is made and P1 is untouched.
  await syncConfirmationCard({ contactId: 'c1', deps: s.deps });
  assert.equal(s.ghl.store.get('p1card').pipelineStageId, 'x');
  assert.ok(!s.ghl.calls.some((c) => c.method === 'PUT' && c.path.includes('p1card')));
});

/* ── clock ─────────────────────────────────────────────────────────────── */

test('clock: the 24h move happens when it is due', async () => {
  const s = setup({ leads: [lead({ appointment_date: '2026-10-17T12:00:00+00:00' })] });
  s.clock.now = new Date('2026-10-16T10:00:00Z');                           // 30h away → new
  await syncConfirmationCard({ contactId: 'c1', deps: s.deps });
  assert.equal(s.ghl.store.get('opp_1').pipelineStageId, S.new);
  s.clock.now = new Date('2026-10-16T17:00:00Z');                           // 23h away
  const res = await runConfirmationClock({ deps: s.deps });
  assert.equal(res.counts.move, 1);
  assert.equal(s.ghl.store.get('opp_1').pipelineStageId, S.confirm_now);
});

test('clock: one 4h alert per appointment; an empty channel only logs', async () => {
  const s = setup({ leads: [lead({ appointment_date: '2026-10-16T13:00:00+00:00' })] }); // 1 PM ET, 3h away
  await syncConfirmationCard({ contactId: 'c1', deps: s.deps });
  await runConfirmationClock({ deps: s.deps });
  assert.equal(s.slack.length, 0);
  let [row] = await table(s.db, 'confirmation_opportunities');
  assert.ok(row.alerted_at, 'set even with no channel, so the warning is once');

  const t = setup({ leads: [lead({ appointment_date: '2026-10-16T13:00:00+00:00' })], env: { ...LIVE, CONF_SLACK_CHANNEL: 'C123' } });
  await syncConfirmationCard({ contactId: 'c1', deps: t.deps });
  await runConfirmationClock({ deps: t.deps });
  await runConfirmationClock({ deps: t.deps });
  assert.equal(t.slack.length, 1);
  assert.equal(t.slack[0].channel, 'C123');
  assert.match(t.slack[0].text, /Jane Doe — 10\/16\/2026 1:00 PM/);
  assert.doesNotMatch(t.slack[0].text, /\d{10}/, 'no phone on the card');
  [row] = await table(t.db, 'confirmation_opportunities');
  assert.ok(row.alerted_at);
});

test('clock: a card closes at appointment + 2h, Confirmed → won', async () => {
  const s = setup({ leads: [lead({ appointment_date: '2026-10-16T13:00:00+00:00', disposition_code: 'Cnf' })] });
  await syncConfirmationCard({ contactId: 'c1', deps: s.deps });
  s.clock.now = new Date('2026-10-16T18:30:00Z');                           // 2:30 PM ET: 1.5h after
  await runConfirmationClock({ deps: s.deps });
  assert.equal(s.ghl.store.get('opp_1').status, 'open');
  s.clock.now = new Date('2026-10-16T19:30:00Z');                           // 3:30 PM ET: 2.5h after
  await runConfirmationClock({ deps: s.deps });
  assert.equal(s.ghl.store.get('opp_1').status, 'won');
  const [row] = await table(s.db, 'confirmation_opportunities');
  assert.equal(row.closed_status, 'won');
});

/* ── sweep ─────────────────────────────────────────────────────────────── */

test('sweep: closes every past-dated card (hand-made ones too), keeps today, names cards with no date', async () => {
  const s = setup({
    leads: [],
    rows: [{ id: 1, lp_lead_id: '1', ghl_contact_id: 'a', ghl_opportunity_id: 'o1', stage_key: 'confirmed', last_moved_by: 'agent', appointment_at: '2026-10-15T14:00:00Z', dry_run: false }],
    opps: [
      { id: 'o1', contactId: 'a', pipelineId: PIPE, pipelineStageId: S.confirmed, name: 'A — 10/15/2026 10:00 AM' },
      { id: 'o2', contactId: 'b', pipelineId: PIPE, pipelineStageId: S.new, name: 'B' },
      { id: 'o3', contactId: 'c', pipelineId: PIPE, pipelineStageId: S.issue, name: 'C — 10/16/2026 6:00 PM' },
      { id: 'o4', contactId: 'd', pipelineId: PIPE, pipelineStageId: S.disqualified, name: 'D' },
      { id: 'p5', contactId: 'e', pipelineId: 'peerSJtm3CX2NJt0NLkR', pipelineStageId: 'z', name: 'Canvass — 10/1/2026' },
    ],
    contacts: {
      b: { id: 'b', customFields: [{ id: 'x8KO5o89WPLfC7ivia3A', value: '10/14/2026' }] },
      c: { id: 'c', customFields: [] },
      d: { id: 'd', customFields: [] },
    },
    env: { ...LIVE, CONF_SLACK_CHANNEL: 'C123' },
  });
  s.clock.now = new Date('2026-10-16T04:05:00Z');                           // 00:05 ET
  const r = await runConfirmationSweep({ deps: s.deps });
  assert.deepEqual({ won: r.counts.won, lost: r.counts.lost, abandoned: r.counts.abandoned, kept: r.counts.kept }, { won: 1, lost: 0, abandoned: 1, kept: 1 });
  assert.equal(s.ghl.store.get('o1').status, 'won');
  assert.equal(s.ghl.store.get('o2').status, 'abandoned');
  assert.equal(s.ghl.store.get('o3').status, 'open');
  assert.equal(s.ghl.store.get('o4').status, 'open', 'no readable date: left open');
  assert.equal(s.ghl.store.get('p5').status, 'open', 'Pipeline 5 is never touched');
  assert.deepEqual(r.needs_date.map((c) => c.id), ['o4']);
  assert.equal(s.slack.length, 1);
  assert.match(s.slack[0].text, /won 1, lost 0, abandoned 1/);
  assert.match(s.slack[0].text, /Needs a date \(1/);
});

test('sweep: dry run writes nothing and posts nothing', async () => {
  const s = setup({ leads: [], env: { CONF_SLACK_CHANNEL: 'C123' }, opps: [{ id: 'o2', contactId: 'b', pipelineId: PIPE, pipelineStageId: S.new, name: 'B — 10/1/2026' }] });
  const r = await runConfirmationSweep({ deps: s.deps });
  assert.equal(r.counts.abandoned, 1);
  assert.equal(s.ghl.writes().length, 0);
  assert.equal(s.slack.length, 0);
});

test('sweep pages through every open card', async () => {
  const pages = [
    { opportunities: [{ id: 'a', pipelineId: PIPE, status: 'open' }], meta: { startAfter: 1, startAfterId: 'a' } },
    { opportunities: [{ id: 'b', pipelineId: PIPE, status: 'open' }], meta: { startAfter: 2, startAfterId: 'b' } },
    { opportunities: [], meta: {} },
  ];
  const paths = [];
  const deps = { ghlFetch: async (_m, p) => { paths.push(p); return pages.shift(); } };
  const { cards, truncated } = await listOpenCards(deps, cfgLive);
  assert.deepEqual(cards.map((c) => c.id), ['a', 'b']);
  assert.equal(truncated, false);
  assert.match(paths[1], /startAfterId=a/);
  for (const p of paths) assert.match(p, new RegExp(`pipeline_id=${PIPE}`));
});

/* ── pipeline-safety fixes ─────────────────────────────────────────────── */

test('bot context never reads a Confirmation card as the contact\'s opportunity', () => {
  const src = readFileSync(new URL('../src/context-builder.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function fetchOpportunity'), src.indexOf('async function fetchOpportunity') + 900);
  assert.match(fn, /filter\(\(o\) => !CONFIRMATION_PIPELINE_IDS\.has\(o\.pipelineId\)\)/);
  assert.match(src, /'ThrBNpyzJhAON4WFC855'/);
  assert.match(src, /'peerSJtm3CX2NJt0NLkR'/);
});

test('move_opportunity duplicate recovery never PUTs onto another pipeline\'s card', () => {
  const src = readFileSync(new URL('../src/actions/handlers/opportunities.js', import.meta.url), 'utf8');
  const guard = src.indexOf("reason: 'duplicate_in_other_pipeline'");
  const put = src.indexOf("await ghlFetch('PUT', `/opportunities/${existingId}`");
  assert.ok(guard > 0 && put > guard, 'the pipeline check comes before the recovery PUT');
});
