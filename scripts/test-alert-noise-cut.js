// 2026-10-02 (Mark, alert noise cut). Only cards that need action, plus ONE
// 8 AM digest:
//   - info-only enrollment / routing cards are gone (their events still write);
//   - P2 Won / Lost, appointment parity and the morning checks fold into the
//     digest, each listing only what was never posted (audit_posted_items);
//   - drift posts once per contact, ever;
//   - intake journal waits 60 minutes and posts once per row;
//   - an outage posts when it starts and when it ends, never in between.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
process.env.GHL_API_KEY = process.env.GHL_API_KEY || 'test-ghl-key';
delete process.env.ALERT_DIGEST_ENABLED; // default: on

const noise = await import('../src/alert-noise.js');
const posted = await import('../src/alert-posted.js');
const digest = await import('../src/jobs/ops-morning-digest.js');
const drift = await import('../src/services/drift-detector.js');
const objection = await import('../src/actions/handlers/objection-state.js');
const { sweepIntakeJournal } = await import('../src/intake-journal.js');
const { __testing: parity } = await import('../src/jobs/appointment-parity-watchdog.js');
const { reportAlertCondition } = await import('../src/alert-state.js');
const { mockAlertConditions } = await import('./fixtures/alert-conditions-mock.js');

const NOW = Date.parse('2026-10-03T12:00:00Z'); // 08:00 ET
const HOUR = 3_600_000;

// ── chainable Supabase fake: tables of rows; records writes; upsert merges ──
function fakeDb(tables = {}) {
  const writes = [];
  const db = {
    tables, writes,
    from(table) {
      tables[table] = tables[table] || [];
      const filters = [];
      let op = 'select';
      let payload = null;
      const match = () => tables[table].filter((r) => filters.every((f) => f(r)));
      const q = {
        select() { return q; },
        eq(k, v) { filters.push((r) => r[k] === v || (v === false && r[k] === undefined)); return q; },
        in(k, vs) { filters.push((r) => vs.includes(r[k])); return q; },
        gte(k, v) { filters.push((r) => r[k] != null && String(r[k]) >= String(v)); return q; },
        lt(k, v) { filters.push((r) => r[k] != null && String(r[k]) < String(v)); return q; },
        gt(k, v) { filters.push((r) => r[k] != null && String(r[k]) > String(v)); return q; },
        like(k, v) { filters.push((r) => String(r[k] ?? '').startsWith(String(v).replace(/%$/, ''))); return q; },
        not(k) { filters.push((r) => r[k] != null); return q; },
        is(k, v) { filters.push((r) => (v === null ? r[k] == null : r[k] === v)); return q; },
        order() { return q; },
        limit() { return q; },
        delete() { op = 'delete'; return q; },
        upsert(p) { op = 'upsert'; payload = p; return q; },
        insert(p) { op = 'insert'; payload = p; return q; },
        then(res, rej) {
          let out = { data: null, error: null };
          if (op === 'select') out = { data: match(), error: null };
          else if (op === 'delete') {
            const gone = new Set(match());
            tables[table] = tables[table].filter((r) => !gone.has(r));
            writes.push({ table, op, n: gone.size });
          } else if (op === 'upsert') {
            for (const row of [].concat(payload)) {
              const i = tables[table].findIndex((r) => r.audit === row.audit && r.contact_id === row.contact_id && r.reason === row.reason);
              if (i >= 0) tables[table][i] = { ...tables[table][i], ...row }; else tables[table].push({ ...row });
            }
            writes.push({ table, op, rows: [].concat(payload) });
          } else {
            tables[table].push(...[].concat(payload));
            writes.push({ table, op, rows: [].concat(payload) });
          }
          return Promise.resolve(out).then(res, rej);
        },
      };
      return q;
    },
  };
  return db;
}

// ── 1. Cut cards ────────────────────────────────────────────────────────

test('cut rules: the seed leaves no send_notification, and every other step stays', () => {
  const template = [
    { action_type: 'add_tag', params: { tag: 'objection-detected' } },
    { action_type: 'send_notification', target_system: 'groupme', params: { action_verb: 'ROUTED TO S5.2 v2' } },
    { action_type: 'transition_objection_state', params: { proposed_state: 'APPOINTMENT_FRICTION.timing_delay' } },
  ];
  const out = noise.stripNotifications(template);
  assert.deepEqual(out.map((t) => t.action_type), ['add_tag', 'transition_objection_state']);
  for (const key of noise.CUT_NOTIFICATION_RULE_KEYS) {
    const planned = noise.planRuleActions({ rule_key: key, action_template: out }, {});
    assert.equal(planned.some((t) => t.action_type === 'send_notification'), false, key);
  }
  assert.equal(noise.CUT_NOTIFICATION_RULE_KEYS.length, 7);
});

test('P2 Won/Lost: the card is dropped at queue time while the digest is on, back when it is off', () => {
  const rule = { rule_key: 'P2_JOB_TERMINAL_WON', action_template: [
    { action_type: 'update_opportunity' }, { action_type: 'send_notification', params: { action_verb: 'P2 MARKED WON' } },
  ] };
  assert.deepEqual(noise.planRuleActions(rule, {}).map((t) => t.action_type), ['update_opportunity']);
  assert.deepEqual(noise.planRuleActions(rule, { ALERT_DIGEST_ENABLED: 'false' }).map((t) => t.action_type), ['update_opportunity', 'send_notification']);
  // A KEEP rule is never touched.
  const hot = { rule_key: 'HOT_CALL_IMMEDIATE', action_template: [{ action_type: 'send_notification' }] };
  assert.equal(noise.planRuleActions(hot, {}).length, 1);
});

test('STATE_ROUTING_NOTIFICATION: the transition no longer chains a routing card', () => {
  assert.equal(objection.ROUTING_NOTIFICATION_CARDS, false);
  assert.equal(objection.routingNotificationSpecFor({ contact_id: 'c1', state_code: 'APPOINTMENT_DISRUPTION.cancelled' }), null);
});

// ── 2. Shared dedupe ────────────────────────────────────────────────────

test('alert-posted: TTL rows age out, permanent rows never do, a failed read returns everything', async () => {
  const db = fakeDb({ audit_posted_items: [
    { audit: 'a', contact_id: 'old', reason: 'r', posted_at: new Date(NOW - 40 * 86_400_000).toISOString(), permanent: false },
    { audit: 'a', contact_id: 'perm', reason: 'r', posted_at: new Date(NOW - 400 * 86_400_000).toISOString(), permanent: true },
    { audit: 'a', contact_id: 'recent', reason: 'r', posted_at: new Date(NOW - 86_400_000).toISOString(), permanent: false },
  ] });
  const items = ['old', 'perm', 'recent', 'new'].map((key) => ({ key, reason: 'r' }));
  const { fresh } = await posted.filterNew({ audit: 'a', items, ttlDays: 30, nowMs: NOW, deps: { supabase: db } });
  assert.deepEqual(fresh.map((i) => i.key), ['old', 'new']);
  assert.equal(db.tables.audit_posted_items.some((r) => r.contact_id === 'old'), false, 'expired row deleted');
  assert.equal(db.tables.audit_posted_items.some((r) => r.contact_id === 'perm'), true, 'permanent row kept');

  const broken = { from() { throw new Error('down'); } };
  const r = await posted.filterNew({ audit: 'a', items, deps: { supabase: broken } });
  assert.equal(r.dedupe, 'unavailable');
  assert.equal(r.fresh.length, 4);
});

// ── 3. Digest ───────────────────────────────────────────────────────────

const iso = (ms) => new Date(ms).toISOString();
function digestDeps({ tables = {}, jobs = {}, names = {} } = {}) {
  const sent = [];
  const db = fakeDb({ agent_actions: [], alert_conditions: [], audit_posted_items: [], ...tables });
  const job = (id) => jobs[id] || { status: 'ok', value: {} };
  return {
    sent, db,
    deps: {
      __noDefaults: true,
      nowMs: NOW,
      today: '2026-10-03',
      supabase: db,
      hlRunSQL: async (sql) => Object.entries(names).filter(([id]) => sql.includes(`'${id}'`))
        .map(([id, n]) => ({ ghl_contact_id: id, first_name: n.split(' ')[0], last_name: n.split(' ')[1] })),
      sendAlertMessage: async (text, opts) => { sent.push({ text, opts }); return { sent: true }; },
      runJob: async (id, fn) => { const j = job(id); if (j.value === undefined && j.status === 'ok') await fn(); return j; },
      runF0Audit: async () => ({}), runLeadLeak: async () => ({}), runLinkLeak: async () => ({}), runP2Unresolvable: async () => ({}),
    },
  };
}

test('digest: a clean day is one line, "All clear."', async () => {
  const { deps, sent } = digestDeps();
  const r = await digest.runOpsMorningDigest({ post: true, deps });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].opts.channel, 'ops');
  assert.match(sent[0].text, /All clear\.$/);
  assert.deepEqual(r.failures, []);
});

test('digest: P2 won/lost with names, new parity keys only, and the morning checks as sections', async () => {
  const tables = {
    agent_actions: [
      { target_id: 'w1', rule_applied: 'P2_JOB_TERMINAL_WON', action_type: 'update_opportunity', status: 'completed', executed_at: iso(NOW - 2 * HOUR), execution_result: {} },
      { target_id: 'l1', rule_applied: 'P2_JOB_TERMINAL_LOST', action_type: 'update_opportunity', status: 'completed', executed_at: iso(NOW - 3 * HOUR), execution_result: { l6: {} } },
      { target_id: 'x1', rule_applied: 'P2_JOB_TERMINAL_WON', action_type: 'update_opportunity', status: 'completed', executed_at: iso(NOW - 2 * HOUR), execution_result: { action: 'skipped_already_won' } },
      { target_id: 'old', rule_applied: 'P2_JOB_TERMINAL_WON', action_type: 'update_opportunity', status: 'completed', executed_at: iso(NOW - 30 * HOUR), execution_result: {} },
    ],
    alert_conditions: [
      { alert_key: 'appt_parity:gap:cancellation_drift:p-new', state: 'firing', first_seen_at: iso(NOW - 5 * HOUR) },
      { alert_key: 'appt_parity:gap:cancellation_drift:p-old', state: 'firing', first_seen_at: iso(NOW - 50 * HOUR) },
      { alert_key: 'appt_parity:gap:ghl_missing_appointment:p-posted', state: 'firing', first_seen_at: iso(NOW - 4 * HOUR) },
    ],
    audit_posted_items: [
      { audit: 'appt_parity', contact_id: 'p-posted', reason: 'parity:ghl_missing_appointment', posted_at: iso(NOW - HOUR), permanent: false },
      { audit: 'f0-s52-integrity', contact_id: 'f-old', reason: 'f0_flag:CXL', posted_at: iso(NOW - 86_400_000), permanent: false },
    ],
  };
  const jobs = {
    'f0-integrity-audit': { status: 'ok', value: { items: [
      { contact_id: 'f-old', name: 'Old One', reason: 'f0_flag:CXL', wrong: 'in F.0 — CXL', todo: 'remove from F.0' },
      { contact_id: 'f-new', name: 'New One', reason: 's52_flag:demo_on_any_lead', wrong: 'in S5.2 — had a demo', todo: 'remove from S5.2' },
    ] } },
    'lead-leak-monitor': { status: 'ok', value: { digestItems: { intakeMissing: [{ ghl_contact_id: 'g1', first_name: 'Ann', last_name: 'B', date_added: '2026-10-02T10:00:00Z' }], retired: [], speedSlow: [] } } },
    'link-leak-monitor': { status: 'ok', value: { verdict: 'alert', offenders: [{ table: 'lp_notes', count: 12 }] } },
    'p2-unresolvable-monitor': { status: 'ok', value: { verdict: 'healthy', sample: { unresolvable: 3 } } },
  };
  const { deps, sent, db } = digestDeps({ tables, jobs, names: { w1: 'Wendy Win', l1: 'Larry Loss', 'p-new': 'Pat New' } });
  await digest.runOpsMorningDigest({ post: true, deps });
  assert.equal(sent.length, 1, 'one post');
  const t = sent[0].text;
  assert.match(t, /P2 closed in the last 24h \(1 won, 1 lost\)/);
  assert.match(t, /Won: 1 — Wendy Win/);
  assert.match(t, /Lost: 1 — Larry Loss/);
  assert.match(t, /Appointment parity — 1 new gap/);
  assert.match(t, /Pat New \(p-new\) · cancelled on one side only · cancel it in the other system/);
  assert.doesNotMatch(t, /p-old|p-posted/, 'old and already-posted parity keys are not listed');
  assert.match(t, /F\.0 \/ S5\.2 integrity — 1 new/);
  assert.doesNotMatch(t, /Old One/);
  assert.match(t, /Lead leak — 1 new/);
  assert.match(t, /lp_notes · 12 new row/);
  assert.doesNotMatch(t, /P2 opportunities with no LP job/, 'a healthy monitor has no section');
  const recorded = db.tables.audit_posted_items.map((r) => `${r.audit}|${r.contact_id}`);
  for (const k of ['appt_parity|p-new', 'f0-s52-integrity|f-new', 'lead_leak|g1', 'link_leak|lp_notes']) assert.ok(recorded.includes(k), k);

  // Next morning, nothing new → All clear (P2 events outside 24h by then).
  const again = digestDeps({ tables: { ...tables, agent_actions: [], audit_posted_items: db.tables.audit_posted_items }, jobs });
  await digest.runOpsMorningDigest({ post: true, deps: again.deps });
  assert.match(again.sent[0].text, /All clear\./);
});

// 2026-10-03: the Sale → P2 backstop's work is a digest section, not its own card.
test('digest: Sale → P2 backstop fixes are counted; a no-price sale is named once', async () => {
  const tables = {
    system_events: [
      { event_type: 'p2.sale_backstop', event_subtype: 'tagged_deal_won', ghl_contact_id: 's1', created_at: iso(NOW - 2 * HOUR), payload: {} },
      { event_type: 'p2.sale_backstop', event_subtype: 'created_lost', ghl_contact_id: 's2', created_at: iso(NOW - 3 * HOUR), payload: {} },
      { event_type: 'p2.sale_backstop', event_subtype: 'needs_review', ghl_contact_id: 's3', created_at: iso(NOW - 4 * HOUR),
        payload: { job_id: '59882', job_status: 'Awaiting Paperwork', reason: 'no_price_yet' } },
      { event_type: 'p2.sale_backstop', event_subtype: 'needs_review', ghl_contact_id: 's4', created_at: iso(NOW - 4 * HOUR),
        payload: { job_id: '58338', job_status: 'Awaiting Paperwork', reason: 'possible_duplicate_of_paid_job' } },
      { event_type: 'p2.sale_backstop', event_subtype: 'needs_review', ghl_contact_id: 's5', created_at: iso(NOW - 4 * HOUR),
        payload: { job_id: '60074', job_status: 'RTP Await recission', reason: 'repeat_customer_one_card_limit' } },
      { event_type: 'p2.sale_backstop', event_subtype: 'tagged_deal_won', ghl_contact_id: 'old', created_at: iso(NOW - 30 * HOUR), payload: {} },
    ],
  };
  const { deps, sent, db } = digestDeps({ tables, names: { s1: 'Sam Sale', s2: 'Cara Cancel', s3: 'Nora Noprice' } });
  await digest.runOpsMorningDigest({ post: true, deps });
  const t = sent[0].text;
  assert.match(t, /Sales put into P2 by the backstop \(24h\)/);
  assert.match(t, /deal-won added \(C\.0 builds the card\): 1 — Sam Sale/);
  assert.match(t, /card created as Lost: 1 — Cara Cancel/);
  assert.match(t, /Nora Noprice \(s3\) · LP job 59882 "Awaiting Paperwork" · LP job has no price yet — not in P2 · price the job in LP/);
  assert.match(t, /\(s4\) · LP job 58338 "Awaiting Paperwork" · looks like an old quote a paid job replaced — not in P2 · close it in LP if it is dead/);
  assert.match(t, /\(s5\) · LP job 60074 "RTP Await recission" · repeat customer: GHL allows one P2 card per person and the old one is closed — not in P2 · decide by hand; do not reopen the old card/);
  assert.ok(db.tables.audit_posted_items.some((r) => r.audit === 'p2_sale_backstop' && r.contact_id === 's3'));

  // Next morning: the no-price sale is not named again; with no new fixes, All clear.
  const again = digestDeps({ tables: { system_events: [{ ...tables.system_events[2], created_at: iso(NOW + 20 * HOUR) }], audit_posted_items: db.tables.audit_posted_items } });
  await digest.runOpsMorningDigest({ post: true, deps: { ...again.deps, nowMs: NOW + 24 * HOUR } });
  assert.match(again.sent[0].text, /All clear\./);
});

// 2026-10-04: sales the sale-contact backstop gave a GHL contact are counted in the digest.
test('digest: sales given a GHL contact are listed', async () => {
  const tables = {
    system_events: [
      { event_type: 'lp.sale_contact_backstop', event_subtype: 'created', ghl_contact_id: 'k1', created_at: iso(NOW - 2 * HOUR), payload: {} },
      { event_type: 'lp.sale_contact_backstop', event_subtype: 'linked', ghl_contact_id: 'k2', created_at: iso(NOW - 3 * HOUR), payload: {} },
    ],
  };
  const { deps, sent } = digestDeps({ tables, names: { k1: 'Walberto Perez', k2: 'John Pitzer' } });
  await digest.runOpsMorningDigest({ post: true, deps });
  assert.match(sent[0].text, /Sales given a GHL contact \(24h\)/);
  assert.match(sent[0].text, /contact created: 1 — Walberto Perez/);
  assert.match(sent[0].text, /linked to an existing contact: 1 — John Pitzer/);
});

test('digest: a sub-job that fails posts its own "could not run" card; the digest still posts', async () => {
  const jobs = { 'lead-leak-monitor': { status: 'failed', error: 'Five9 history read failed' } };
  const { deps, sent } = digestDeps({ jobs });
  const r = await digest.runOpsMorningDigest({ post: true, deps });
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /Lead leak monitor could not run: Five9 history read failed/);
  assert.match(sent[1].text, /All clear\./);
  assert.equal(r.failures.length, 1);
});

test('digest: max 10 lines per section, then "+N more"', () => {
  assert.deepEqual(posted.capLines(Array.from({ length: 13 }, (_, i) => `l${i}`)).slice(-1), ['+3 more']);
  const text = digest.formatDigest([{ title: 'T', lines: [...Array.from({ length: 10 }, (_, i) => `x${i}`), '+3 more'] }], { date: 'D' });
  assert.equal(text.split('\n').filter((l) => l.startsWith('• ')).length, 10);
  assert.match(text, /\n\+3 more$/);
});

test('parity watchdog: with the digest on, a new gap is recorded as state and posts nothing', async () => {
  const confirmed = [];
  const r = await parity.maybeAlertParityGaps({
    success: true, errors: [], as_of: 'now', outcomes: {},
    findings: [{ class: 'cancellation_drift', contact_id: 'c1', name: 'Lead c1', lp_appointment_date: '2026-09-20T14:00:00+00:00' }],
  }, {
    dryRun: true,
    deps: {
      digestEnabled: true,
      claimAlertConditionSet: async ({ activeKeys }) => ({ ok: true, newlyFiring: activeKeys, cleared: [] }),
      confirmAlertSend: async (keys) => { confirmed.push(...keys); },
      send: async () => { throw new Error('must not post per key'); },
    },
  });
  assert.equal(r.action, 'digest');
  assert.equal(confirmed.length, 1);
});

// ── 4. Drift: once per contact, ever ────────────────────────────────────

const driftDetail = (id) => ({ contact_id: id, lp_lead_id: `L-${id}`, lp_disposition: 'Set' });

test('drift: first detection posts one card; clearing and re-firing posts nothing; backfilled contacts post nothing', async () => {
  const db = fakeDb({
    alert_conditions: [{ alert_key: 'drift:ghl_closed_lp_active:old1' }, { alert_key: 'drift:ghl_closed_lp_active:old2' }],
    audit_posted_items: [],
  });
  drift.__resetDriftBackfill(false);
  const sent = [];
  const deps = { supabase: db, send: async (text, opts) => { sent.push({ text, opts }); return { sent: true }; }, lookupNames: async () => new Map([['new1', 'Nina New']]) };

  const r1 = await drift.postDriftCards([driftDetail('old1'), driftDetail('old2'), driftDetail('new1')], deps);
  assert.equal(r1.posted, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].opts.channel, 'ops');
  assert.match(sent[0].text, /Nina New · new1 · LP lead L-new1 still Set/);
  assert.ok(db.tables.audit_posted_items.every((r) => r.permanent === true));

  // Same contact clears (absent from a scan) and drifts again, much later.
  await drift.postDriftCards([driftDetail('old1')], deps);
  const r3 = await drift.postDriftCards([driftDetail('new1'), driftDetail('old2')], deps);
  assert.equal(r3.posted, 0);
  assert.equal(sent.length, 1, 'never a second card for a contact');
});

test('drift: no card until the backfill succeeds, and none when the posted store is unreadable', async () => {
  drift.__resetDriftBackfill(false);
  const sent = [];
  const send = async (t) => { sent.push(t); return { sent: true }; };
  const r1 = await drift.postDriftCards([driftDetail('n1')], { supabase: fakeDb(), send, backfill: async () => ({ ok: false }) });
  assert.equal(r1.reason, 'backfill_pending');
  drift.__resetDriftBackfill(true);
  const broken = { from() { throw new Error('down'); } };
  const r2 = await drift.postDriftCards([driftDetail('n1')], { supabase: broken, send });
  assert.equal(r2.reason, 'dedupe_unavailable');
  assert.equal(sent.length, 0);
});

// ── 5. Intake journal: 60 minutes, once ─────────────────────────────────

function journalClient(rows, firstSeen) {
  const db = fakeDb({ intake_journal: rows, audit_posted_items: [] });
  // The claim set lives in alert_conditions (the shared PostgreSQL-semantics
  // mock); each orphan is already claimed, first seen at `firstSeen`.
  const ac = mockAlertConditions(new Map(rows.map((r) => {
    const key = `intake_journal:unfinished:${r.id}`;
    return [key, { alert_key: key, state: 'firing', label: 'x', first_seen_at: firstSeen, last_seen_at: firstSeen, notify_count: 1, last_notified_at: firstSeen }];
  })));
  return { tables: db.tables, from: (t) => (t === 'alert_conditions' ? ac.from(t) : db.from(t)) };
}

test('intake journal: nothing before 60 minutes, one card after, never twice', async () => {
  process.env.INTAKE_JOURNAL_MODE = 'live';
  const rows = [{ id: 7, route: '/webhook/lp', received_at: iso(NOW - 80 * 60_000), status: 'received' }];
  const sent = [];
  const send = async (text, opts) => { sent.push({ text, opts }); return { sent: true }; };

  const early = journalClient(rows, iso(NOW - 20 * 60_000));
  const r1 = await sweepIntakeJournal({ client: early, send, nowMs: NOW });
  assert.equal(r1.action, 'silent');
  assert.equal(sent.length, 0);

  const late = journalClient(rows, iso(NOW - 61 * 60_000));
  const r2 = await sweepIntakeJournal({ client: late, send, nowMs: NOW });
  assert.equal(r2.action, 'fired');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /still unfinished 60\+ minutes/);

  const r3 = await sweepIntakeJournal({ client: late, send, nowMs: NOW + 5 * 60_000 });
  assert.equal(r3.action, 'silent');
  assert.equal(sent.length, 1, 'posted once per row');
});

// ── 6. Outage: down once, up once ───────────────────────────────────────

test('outage (remindMs 0): down → 1 post, still down → 0, back up → 1', async () => {
  const client = mockAlertConditions(new Map());
  const sent = [];
  const call = (active, nowMs) => reportAlertCondition({
    key: 'ci:recording_archive_unreachable', active, label: 'archive', text: () => 'DOWN', recoveredText: 'UP',
    channel: 'ops', remindMs: 0, client, nowMs, send: async (b) => { sent.push(b); return { sent: true }; },
  });
  await call(true, NOW);
  assert.equal(sent.length, 1);
  for (let h = 1; h <= 72; h += 6) await call(true, NOW + h * HOUR);
  assert.equal(sent.length, 1, 'no re-notify while still down');
  await call(false, NOW + 80 * HOUR);
  assert.equal(sent.length, 2);
  assert.match(String(sent[1]), /UP/);
});
