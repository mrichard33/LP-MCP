/**
 * replay-bot-eval.js — replay live incidents through today's bot and grade the
 * turn the way the incident says it should have gone.
 *
 * Phase 0 (architecture review 2026-10-17). Each case in
 * scripts/fixtures/replay/<set>.json names one stored reply (contact, message
 * ref, channel, disposition, tags, intent) and what it should have been:
 * `expected.question_allowed` (may the reply ask anything?) and
 * `expected.move_family` (close | rehash_track | booking | discovery |
 * handoff | answer).
 *
 * Customer conversations stay in the LP database (the user, 2026-10-05,
 * reconfirmed for this set 2026-10-18): the fixture holds no message text,
 * thread or name. This script reads inbound_text and the thread from
 * bot_message_context by message_ref when it runs, and prints only ids, codes
 * and pass/fail. Never commit an export or its output with text in it.
 *
 *   node scripts/replay-bot-eval.js [--set 2026-10-w42] [--planner-only] [--from-file rows.json] [--json]
 *
 *   default         generateResponse(contact, 'sms', inbound, { dryRun: true, simulatedContext })
 *                   (the simulator's seam): needs the model and database keys. Scores the
 *                   reply's "?" and the plan's move family. A live-chat case runs through the
 *                   SMS writer here (the chat lane needs its own deps): an approximation.
 *   --planner-only  planNepqTurn on the same context, no model. Scores the move family, and
 *                   question_allowed from the plan's own no_question (a proxy for the reply).
 *   --from-file     an array of bot_message_context rows (the cases' rows, plus earlier
 *                   live-chat rows of those contacts) instead of the database.
 *
 * Not part of the gate and not in `npm test` (it needs the database);
 * scripts/test-replay-bot-eval.js covers the pure parts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── pure ────────────────────────────────────────────────────────────────────

const CLOSE_STEPS = new Set(['post_demo_close', 'post_demo_stop', 'post_demo_space', 'sign_off', 'defer', 'competitor_signed']);
const BOOKING_STEPS = new Set(['offer_slots', 'hold', 'confirm', 'collect', 'ask_day', 'booked', 'rehash_confirm', 'slot_taken']);
const DISCOVERY_STEPS = new Set(['open', 'discover', 'probe', 'consequence', 'bridge', 'bridge_followup', 'qualify', 'status_frame']);

/** The family of a plan (the planner's full plan or the stored summary). Pure. */
export function moveFamily(plan) {
  if (!plan) return 'none';
  const step = String(plan.step || '');
  const move = String(plan.required_move || plan.move || '');
  if (plan.no_question === true || CLOSE_STEPS.has(step)) return 'close';
  if (plan.handoff || step === 'handoff') return 'handoff';
  if (BOOKING_STEPS.has(step) || BOOKING_STEPS.has(move)) return 'booking';
  if (plan.post_demo === true || step.startsWith('post_demo') || step.startsWith('rehash_')) return 'rehash_track';
  if (DISCOVERY_STEPS.has(step) || DISCOVERY_STEPS.has(move)) return 'discovery';
  return 'answer';
}

const normalizeChannel = (c) => (String(c || '').replace('_', '') === 'livechat' ? 'livechat' : 'sms');

/**
 * The thread the reply was written against, oldest first, in the planner's
 * shape. SMS rows store it in input_snapshot.thread; live-chat rows store none,
 * so it is rebuilt from the contact's earlier live-chat rows (each row's
 * inbound, then its reply) within six hours. The case's own inbound is left
 * out (the planner adds the trigger). Pure.
 */
export function threadForCase(row, priorRows = []) {
  const snap = row?.input_snapshot && typeof row.input_snapshot === 'object' ? row.input_snapshot : {};
  if (Array.isArray(snap.thread) && snap.thread.length) {
    const turns = snap.thread
      .filter(m => (m?.kind || 'message') === 'message')
      .map(m => ({ direction: String(m?.direction || '').toLowerCase() === 'outbound' ? 'outbound' : 'inbound', text: String(m?.body ?? m?.text ?? ''), timestamp: m?.at || null }))
      .filter(m => m.text.trim());
    const last = turns.at(-1);
    if (last && last.direction === 'inbound' && last.text.trim() === String(row.inbound_text || '').trim()) turns.pop();
    return turns;
  }
  const at = Date.parse(row?.generated_at || '');
  const turns = [];
  for (const p of [...priorRows].sort((a, b) => Date.parse(a.generated_at) - Date.parse(b.generated_at))) {
    const pAt = Date.parse(p.generated_at || '');
    if (p.ghl_contact_id !== row.ghl_contact_id || p.message_ref === row.message_ref) continue;
    if (normalizeChannel(p.channel) !== normalizeChannel(row.channel)) continue;
    if (!(pAt < at) || at - pAt > 6 * 3600_000) continue;
    if (String(p.inbound_text || '').trim()) turns.push({ direction: 'inbound', text: String(p.inbound_text), timestamp: p.generated_at });
    if (String(p.reply_text || '').trim()) turns.push({ direction: 'outbound', text: String(p.reply_text), timestamp: p.generated_at });
  }
  return turns;
}

/** Grade one replayed turn. Pure. question_allowed null = not graded. */
export function scoreCase(expected = {}, observed = {}) {
  const failures = [];
  if (expected.move_family && observed.move_family !== expected.move_family) failures.push(`move_family ${observed.move_family || 'none'} (expected ${expected.move_family})`);
  if (expected.question_allowed === false && observed.asks === true) failures.push('question_not_allowed');
  if (expected.question_allowed === true && observed.asks === false && observed.asks_source === 'reply') failures.push('expected_a_question');
  return { pass: failures.length === 0, failures };
}

/** The planner's input for a case, as the SMS reply writer builds it (no slots, no stored stage). Pure. */
export function plannerArgsForCase(testCase, row, priorRows, { isPostDemoLead, isRehashContact, postDemoMode = 'live' } = {}) {
  const tags = (testCase.contact_tags || []).map(t => String(t).toLowerCase());
  const lp = testCase.lp_disposition ? { matched: true, disposition: testCase.lp_disposition } : { matched: false };
  const rehash = isRehashContact ? isRehashContact({ tags }) : false;
  const pastDemo = rehash || (isPostDemoLead ? isPostDemoLead({ lp, tags }) : false);
  return {
    channel: normalizeChannel(testCase.channel),
    trigger: String(row.inbound_text || ''),
    conversation: threadForCase(row, priorRows),
    slots: [],
    allSlots: [],
    firstName: null,
    hasAppointment: tags.includes('booking:active') || tags.includes('appt-exists'),
    nextStepLabel: 'a free visit at your home',
    postDemoLead: pastDemo,
    postDemo: postDemoMode === 'live' && pastDemo,
    rehash,
    rehashRep: null,
    // The live-chat lane does not pass the classifier's CALLBACK to its planner.
    callbackRequested: normalizeChannel(testCase.channel) === 'sms' && String(testCase.intent_class || '').toUpperCase() === 'CALLBACK',
    stageLive: false,
    stage: null,
    knownOpenings: false,
    nowMs: Date.parse(row.generated_at || '') || Date.now(),
  };
}

/** One table for a person: ids, codes, pass/fail. No customer text. Pure. */
export function formatReport(results, { mode }) {
  const passed = results.filter(r => r.pass).length;
  const lines = [`Replay ${mode}: ${passed}/${results.length} pass (${results.length ? Math.round((passed / results.length) * 100) : 0}%)`];
  for (const r of results) {
    lines.push(`  ${r.pass ? 'ok  ' : 'FAIL'} ${r.message_ref.padEnd(7)} ${r.channel.padEnd(9)} expected ${String(r.expected.move_family).padEnd(12)} q=${String(r.expected.question_allowed).padEnd(5)} got ${String(r.observed.move_family).padEnd(12)} step=${r.observed.step || '-'}${r.observed.asks == null ? '' : ` asks=${r.observed.asks}${r.observed.asks_source === 'plan' ? '(plan)' : ''}`}${r.recorded_step ? ` | live step=${r.recorded_step}` : ''}${r.failures.length ? ` — ${r.failures.join('; ')}` : ''}`);
  }
  return lines.join('\n');
}

// ── io ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes(name);

async function loadRows(cases) {
  const file = opt('--from-file');
  if (file) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw) ? raw : (raw?.result?.[0]?.json_agg || []);
  }
  const { default: supabase } = await import('../src/supabase.js');
  if (!supabase) throw new Error('Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY); or pass --from-file');
  const cols = 'message_ref, ghl_contact_id, channel, intent_class, buyer_stage, generated_at, inbound_text, reply_text, input_snapshot';
  const { data, error } = await supabase.from('bot_message_context').select(cols).eq('message_type', 'reply').in('message_ref', cases.map(c => c.message_ref));
  if (error) throw new Error(`bot_message_context read failed: ${error.message}`);
  const rows = [...(data || [])];
  for (const c of cases.filter(x => normalizeChannel(x.channel) === 'livechat')) {
    const own = rows.find(r => r.message_ref === c.message_ref);
    if (!own) continue;
    const since = new Date(Date.parse(own.generated_at) - 6 * 3600_000).toISOString();
    const { data: prior, error: pErr } = await supabase.from('bot_message_context').select(cols)
      .eq('message_type', 'reply').eq('ghl_contact_id', c.contact_id).gte('generated_at', since).lt('generated_at', own.generated_at);
    if (pErr) throw new Error(`bot_message_context prior read failed: ${pErr.message}`);
    rows.push(...(prior || []));
  }
  return rows;
}

async function main() {
  const set = opt('--set', '2026-10-w42');
  const plannerOnly = flag('--planner-only');
  const fixture = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'replay', `${set}.json`), 'utf8'));
  const cases = fixture.cases || [];
  const rows = await loadRows(cases);
  const { planNepqTurn } = await import('../src/agentic/nepq-planner.js');
  const { isPostDemoLead } = await import('../src/agentic/post-demo-lead.js');
  const { isRehashContact } = await import('../src/agentic/rehash.js');
  const results = [];
  for (const c of cases) {
    const row = rows.find(r => r.message_ref === c.message_ref);
    const base = { message_ref: c.message_ref, channel: normalizeChannel(c.channel), expected: c.expected, recorded_step: row?.recorded_plan?.step || null };
    if (!row) { results.push({ ...base, pass: false, observed: {}, failures: ['row_not_found'] }); continue; }
    const planArgs = plannerArgsForCase(c, row, rows, { isPostDemoLead, isRehashContact, postDemoMode: opt('--post-demo', 'live') });
    let observed;
    try {
      if (plannerOnly) {
        const plan = planNepqTurn(planArgs);
        observed = { move_family: moveFamily(plan), step: plan?.step || null, asks: plan ? plan.no_question !== true : null, asks_source: 'plan' };
      } else {
        const [{ generateResponse }, { minimalContext }, { withPersonaLp }] = await Promise.all([
          import('../src/response-generator.js'), import('../src/live-chat/fast-lane.js'), import('../src/simulator/bot-simulator.js'),
        ]);
        const contactId = `replay-${c.message_ref}`;
        const contact = { phone: '+15555550100', tags: c.contact_tags || [] };
        const persona = c.lp_disposition ? { lp: { disposition: c.lp_disposition } } : {};
        const context = { ...withPersonaLp(minimalContext({ contactId, contact, nowMs: planArgs.nowMs }), persona), conversation_recent: planArgs.conversation.map(t => ({ ...t, channel: 'sms', type: 'text' })) };
        const out = await generateResponse(contactId, 'sms', planArgs.trigger, { dryRun: true, simulatedContext: context, nepqModeOverride: 'live' });
        observed = { move_family: moveFamily(out?.nepq_plan), step: out?.nepq_plan?.step || null, asks: String(out?.message || '').includes('?'), asks_source: 'reply' };
      }
    } catch (err) {
      results.push({ ...base, pass: false, observed: {}, failures: [`error: ${String(err?.message || err).slice(0, 120)}`] });
      continue;
    }
    results.push({ ...base, observed, ...scoreCase(c.expected, observed) });
  }
  if (flag('--json')) { console.log(JSON.stringify({ set, mode: plannerOnly ? 'planner-only' : 'model', results }, null, 2)); return; }
  console.log(formatReport(results, { mode: plannerOnly ? 'planner-only (no model; asks = the plan asks, a proxy)' : 'model (dry run)' }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err?.message || err); process.exit(1); });
}
