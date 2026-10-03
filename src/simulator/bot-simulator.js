/**
 * Bot simulator — src/simulator/bot-simulator.js
 *
 * 2026-10-02 (Mark): "Can we simulate the test so we do not need to run live
 * tests?" Live testing meant typing a whole conversation into the website chat
 * or a phone, one message at a time, waiting on each reply, and then digging
 * through rows to see what the bot meant to do.
 *
 * This runs a scripted conversation through the REAL bots — the real model,
 * prompt, knowledge base, NEPQ planner and guards, service-area and calendar
 * READS — and swaps every outward effect for a recorder:
 *   - live chat: createLiveChatFastLane with the production deps, except that
 *     sends, GHL writes, tags, alerts, events, bookings, cancels, moves and the
 *     reply lock are recorded instead of done, and the thread is the script.
 *   - SMS: generateResponse with dryRun (its existing "no writes" switch) and
 *     a simulated lead + thread instead of a GHL read.
 * Nothing reaches a customer, GHL, LP, Slack or the event log.
 *
 * The result is a transcript: every customer message, the reply, the NEPQ
 * move (and, with NEPQ off, what it would have sent), and every side effect
 * the bot WOULD have taken.
 *
 * It costs real model calls: one per live-chat turn (two on a redraft). An SMS
 * turn is up to three per attempt (classifier, identity pass, reply writer)
 * and a guard redraft is a second attempt, so up to six.
 */

import { createLiveChatFastLane, minimalContext } from '../live-chat/fast-lane.js';
import { BOOKING_CALENDARS } from '../knowledge/booking-calendar-router.js';
import { callbackDecision } from '../agentic/bot-callback.js';

export const SIM_CONTACT_PREFIX = 'sim-';

const GUEST = { firstName: 'Guest', lastName: 'Visitor sim01', phone: null, email: null, postalCode: null };
const RICK = { firstName: 'Rick', lastName: 'Fox', phone: '+13525550188', email: null, postalCode: '34470' };

/** The test conversations (the "good test messages" list). Customer side only. */
export const SCENARIOS = Object.freeze({
  discovery: { title: 'New lead, discovery', persona: GUEST, turns: ['Hi there', 'My windows are old and drafty', 'Mostly the kitchen and living room', 'About 10 years', 'Yes, that would help'] },
  price: { title: 'Price asked twice', persona: GUEST, turns: ['How much for 12 windows?', 'Just give me a number'] },
  // 2026-10-02 (5i59G): the live chat that repeated its price line three times.
  quote: { title: 'Quote request (live chat replay)', persona: GUEST, turns: ['Hi, I would like to get a quote on 12 windows and 2 sliding glass doors.', 'I just want a good price.', 'you just said that.', 'I just said I need new windows. I want a quote. how much?'] },
  financing: { title: 'Financing', persona: GUEST, turns: ['Do you offer financing?', 'How much a month would it be?'] },
  spouse: { title: 'Spouse', persona: GUEST, turns: ["I'm interested but I need to talk to my wife first", 'She has to see it before we decide', 'The first one works for both of us'] },
  think: { title: 'Think it over', persona: GUEST, turns: ['Your windows sound good', 'Let me think about it', 'The first one'] },
  quotes: { title: 'Getting 3 quotes', persona: GUEST, turns: ["We're getting 3 quotes", 'Probably price and the warranty'] },
  not_interested: { title: 'Not interested, twice', persona: GUEST, turns: ['Not interested', 'No'] },
  complaint: { title: 'Complaint', persona: GUEST, turns: ['Your rep never showed up yesterday'] },
  service_area: { title: 'Service area', persona: GUEST, turns: ['Do you service Houston?', '77494', 'What about 10001?'] },
  details: { title: 'Sharing details (no re-asks)', persona: GUEST, turns: ['Hi, I need new windows', 'Danh', '657-242-0815', 'danh.ho@hotmail.com', '1200 Main Street, Katy, TX 77494'] },
  product: { title: 'Product questions', persona: GUEST, turns: ['Do you do single-hung windows?', 'Do you do roofing?'] },
  burst: { title: 'Two quick messages (live chat)', persona: GUEST, channels: ['livechat'], burst: true, turns: ['tomorrow evening 6 pm', "actually, what's the warranty?"] },
  cancel_reschedule: { title: 'Cancel → reschedule (live chat)', persona: GUEST, channels: ['livechat'], appointmentHolder: RICK, turns: ['I need to cancel my appointment', 'Rick Fox 352-555-0188', 'Yes, a different day', 'The first one'] },
  cancel: { title: 'Cancel (live chat)', persona: GUEST, channels: ['livechat'], appointmentHolder: RICK, turns: ['I need to cancel my appointment', 'Rick Fox 352-555-0188', 'No, just cancel it'] },
  spanish: { title: 'Spanish (live chat)', persona: GUEST, channels: ['livechat'], turns: ['Hola, necesito ventanas para mi casa'] },
});

/** Parse a message list or a scenario name into one plan. Pure. */
export function resolveScenario({ scenario = null, turns = null, persona = null, title = null, contactId = null } = {}) {
  if (Array.isArray(turns) && turns.length) {
    return { key: 'custom', title: title || 'Custom conversation', persona: { ...GUEST, ...(persona || {}) }, turns: turns.map(String).slice(0, 12), contactId };
  }
  const s = SCENARIOS[scenario];
  if (!s) throw new Error(`unknown scenario "${scenario}". Known: ${Object.keys(SCENARIOS).join(', ')}`);
  return { key: scenario, ...s, persona: { ...s.persona, ...(persona || {}) }, contactId };
}

function tomorrowAt(hourUtc, nowMs) {
  const d = new Date(nowMs + 24 * 3600 * 1000);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

/**
 * Live chat: the real lane, every outward effect recorded.
 * @param {object} plan     resolveScenario() output
 * @param {object} opts     { nepqMode, productionDeps, nowMs }
 */
export async function simulateLiveChat(plan, { nepqMode = 'live', productionDeps, nowMs = Date.now() } = {}) {
  // A real contact (e.g. Mark Test) supplies its GHL/LP record, READ ONLY;
  // the conversation is still the script and every write is still recorded.
  const realContact = plan.contactId || null;
  const contactId = realContact || `${SIM_CONTACT_PREFIX}${plan.key}-${nowMs}`;
  const persona = plan.persona;
  const thread = [];
  const effects = [];
  const rows = new Map();
  let rowId = 0;
  let sent = [];
  const record = (kind, detail) => { effects.push({ turn: currentTurn, kind, ...detail }); };
  let currentTurn = 0;
  const holder = plan.appointmentHolder || null;
  const holderAppt = holder ? {
    appointment_id: 'sim-appt-1', calendar_id: BOOKING_CALENDARS.WINDOW_ESTIMATE,
    start_time: tomorrowAt(22, nowMs), start_time_human: new Date(tomorrowAt(22, nowMs)).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET',
    status: 'confirmed',
  } : null;

  const lane = createLiveChatFastLane({
    ...productionDeps,
    mode: () => 'live',
    nepqMode: () => nepqMode,
    shadowModelEnabled: () => false,
    log: () => {},
    // The missing lead record is the simulation's own doing, not a finding.
    warn: (line) => { if (!/simulated: no lead record/.test(String(line))) record('warning', { line: String(line).slice(0, 300) }); },
    fetchContact: realContact ? productionDeps.fetchContact : async () => ({ id: contactId, firstName: persona.firstName, lastName: persona.lastName, phone: persona.phone, email: persona.email, postalCode: persona.postalCode, tags: [] }),
    fetchMessages: async () => thread.map(m => ({ direction: m.direction, body: m.text, dateAdded: m.at })),
    findConversation: async () => 'sim-conversation',
    buildContext: realContact ? productionDeps.buildContext : async () => { throw new Error('simulated: no lead record'); },
    sendMessage: async ({ message }) => { sent.push(message); return { messageId: `sim-msg-${sent.length}`, method: 'simulated' }; },
    insertAction: async () => { rowId++; rows.set(rowId, {}); return { id: rowId }; },
    updateAction: async (id, patch) => { rows.set(id, { ...(rows.get(id) || {}), ...patch }); },
    claimMessages: async (_c, keys) => ({ fresh: keys, consumed: [] }),
    acquireSlot: async () => ({ acquired: true, holder_token: 'sim' }),
    commitSend: async () => {},
    releaseSlot: async () => {},
    emitEvent: async (e) => { record('event', { event_type: e.event_type }); return { id: 0 }; },
    opsAlert: async (text) => { record('ops_alert', { text: String(text).slice(0, 400) }); },
    fingerprint: () => {},
    markSent: () => {},
    captureIdentity: async (_id, input) => { record('ghl_field_capture', { capture: input?.capture || {}, visitor_text_count: (input?.visitorTexts || []).length }); return null; },
    findContactByPhone: (realContact && !holder) ? productionDeps.findContactByPhone : async (digits) => (holder && String(holder.phone).endsWith(String(digits).slice(-10)) ? { id: 'sim-holder', firstName: holder.firstName, lastName: holder.lastName, phone: holder.phone } : null),
    fetchAppointments: (realContact && !holder) ? productionDeps.fetchAppointments : async () => (holderAppt ? [holderAppt] : []),
    cancelAppointment: async (a) => { record('would_cancel_in_ghl', { appointment_id: a.appointmentId }); return { ok: true }; },
    rescheduleAppointment: async (a) => { record('would_move_same_appointment_in_ghl', { appointment_id: a.oldAppointmentId, new_start: a.startIso }); return { ok: true }; },
    postCancelCard: async (a) => { record('would_post_dispatch_card', { card: a.kind, text: String(a.text || '').slice(0, 400) }); return { ok: true }; },
    bookSlot: async (a) => { record('would_book', { start: a.startIso }); return { ok: true, action_id: 0 }; },
    nepqHandoff: async (a) => {
      // 2026-10-03: a callback (with a number to call) files to Five9 + #contact-center.
      if (a.reason === 'callback_request' && a.kind === 'service') record('would_hand_off_to_service_channel', { reason: a.why || 'planned' });
      else if (a.reason === 'callback_request') record(a.hasPhone === false && !a.phone ? 'would_ask_for_callback_number' : 'would_file_callback_five9_and_contact_center', { reason: a.why || 'planned' });
      else if (a.reason === 'service') record('would_hand_off_to_service_channel', { reason: 'service' });
      else record('would_hand_off_to_person', { reason: a.reason });
    },
  });

  const transcript = [];
  const runTurn = async (text, i) => {
    currentTurn = i + 1;
    const at = new Date(nowMs + i * 60000).toISOString();
    thread.push({ direction: 'inbound', text, at });
    const before = sent.length;
    const t0 = Date.now();
    const out = await lane.processInbound({ contactId, conversationId: 'sim-conversation', messageId: `sim-${nowMs}-${i}`, body: text, dateAdded: at });
    const replies = sent.slice(before);
    for (const r of replies) thread.push({ direction: 'outbound', text: r, at: new Date(Date.parse(at) + 5000).toISOString() });
    const row = out?.action_id != null ? rows.get(out.action_id) : null;
    const er = row?.execution_result || {};
    transcript.push({
      turn: i + 1,
      customer: text,
      bot: replies.length ? replies : null,
      outcome: out?.outcome || null,
      nepq: er.nepq || null,
      flow: er.cancel_flow?.outcome || er.cancel_flow?.step || null,
      seconds: Math.round((Date.now() - t0) / 100) / 10,
    });
  };

  if (plan.burst) {
    // Two messages a moment apart: both turns start before either answers.
    currentTurn = 1;
    const at = new Date(nowMs).toISOString();
    thread.push({ direction: 'inbound', text: plan.turns[0], at });
    thread.push({ direction: 'inbound', text: plan.turns[1], at: new Date(nowMs + 3000).toISOString() });
    const t0 = Date.now();
    const outs = await Promise.all(plan.turns.slice(0, 2).map((body, i) =>
      new Promise(r => setTimeout(r, i * 50)).then(() => lane.processInbound({ contactId, conversationId: 'sim-conversation', messageId: `sim-${nowMs}-b${i}`, body, dateAdded: at }))));
    transcript.push({ turn: 1, customer: plan.turns.slice(0, 2).join('  +  '), bot: sent.slice(), outcome: outs.map(o => o?.outcome).join(' / '), seconds: Math.round((Date.now() - t0) / 100) / 10 });
  } else {
    for (let i = 0; i < plan.turns.length; i++) await runTurn(plan.turns[i], i);
  }
  return { channel: 'livechat', scenario: plan.key, title: plan.title, nepq_mode: nepqMode, contact_id: realContact, transcript, would_do: effects.filter(e => e.kind !== 'event'), events: effects.filter(e => e.kind === 'event').map(e => e.event_type) };
}

/**
 * SMS: the real reply writer in dry-run, with a simulated lead and thread.
 * The send handler's side effects are reported from the generator's flags
 * (hand-off, booking companion), never run.
 */
export async function simulateSms(plan, { nepqMode = 'live', generate, buildRealContext = null, nowMs = Date.now(), maxAttempts = 2 } = {}) {
  const contactId = plan.contactId || `${SIM_CONTACT_PREFIX}sms-${plan.key}-${nowMs}`;
  // A real contact's record, read once (dry run: nothing is written to it).
  const realBase = plan.contactId && buildRealContext ? await buildRealContext(plan.contactId) : null;
  const p = plan.persona;
  const contact = { firstName: /^guest$/i.test(p.firstName || '') ? null : p.firstName, lastName: /^guest$/i.test(p.firstName || '') ? null : p.lastName, phone: p.phone || '+15555550100', email: p.email, postalCode: p.postalCode, tags: [] };
  const thread = [];
  const transcript = [];
  for (let i = 0; i < plan.turns.length; i++) {
    const text = plan.turns[i];
    const at = new Date(nowMs + i * 60000).toISOString();
    thread.push({ direction: 'inbound', channel: 'sms', text, type: 'text', timestamp: at });
    const context = { ...(realBase || minimalContext({ contactId, contact, nowMs: nowMs + i * 60000 })), conversation_recent: thread.slice(-20) };
    const t0 = Date.now();
    let generated = null;
    let error = null;
    let note = null;
    // Per attempt: how long it took and which guard asked for the redraft
    // (2026-10-02: a 107s turn could not be explained from the transcript).
    const attempts = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const ta = Date.now();
      try {
        generated = await generate(contactId, 'sms', text, { dryRun: true, simulatedContext: context, nepqModeOverride: nepqMode, ...(note ? { regenerationNote: note } : {}) });
        attempts.push({ seconds: Math.round((Date.now() - ta) / 100) / 10, guard: null });
        break;
      } catch (err) {
        attempts.push({ seconds: Math.round((Date.now() - ta) / 100) / 10, guard: String(err?.message || err).split(':')[0].slice(0, 60) });
        if (err?.regenerationNote && attempt < maxAttempts) { note = err.regenerationNote; continue; }
        error = String(err?.message || err).slice(0, 300);
      }
    }
    const reply = generated?.message || null;
    if (reply) thread.push({ direction: 'outbound', channel: 'sms', text: reply, type: 'text', timestamp: new Date(Date.parse(at) + 30000).toISOString() });
    const wouldDo = [];
    if (generated?.nepq_handoff) wouldDo.push({ kind: 'would_hand_off_to_person', reason: generated.nepq_handoff.reason });
    if (generated?.dm_handoff) wouldDo.push({ kind: 'would_hand_off_decision_maker', reason: generated.dm_handoff.reason });
    // 2026-10-03: the send handler files the callback (Five9 + #contact-center).
    const cb = reply ? callbackDecision({ handoffReason: generated?.nepq_handoff?.reason || null, otherHandoff: !!generated?.dm_handoff, text: reply }) : null;
    if (cb) wouldDo.push(generated?.service_conversation && cb !== 'planned'
      ? { kind: 'would_hand_off_to_service_channel', reason: cb }
      : { kind: 'would_file_callback_five9_and_contact_center', reason: cb });
    if (generated?.companion_action) wouldDo.push({ kind: `would_${generated.companion_action.action_type}`, payload: generated.companion_action.action_payload || null });
    transcript.push({
      turn: i + 1, customer: text, bot: reply ? [reply] : null, error,
      redrafted: !!note, redraft_guard: attempts.find(a => a.guard)?.guard || null, attempts, intent: generated?.intent_class || null, nepq: generated?.nepq_plan || null,
      would_do: wouldDo, seconds: Math.round((Date.now() - t0) / 100) / 10,
    });
  }
  return { channel: 'sms', scenario: plan.key, title: plan.title, nepq_mode: nepqMode, contact_id: plan.contactId || null, transcript };
}

/** Run one scenario on the channels it applies to. */
export async function runSimulation({ scenario, turns, persona, title, contactId = null, channel = 'both', nepqMode = 'live' }, deps) {
  const plan = resolveScenario({ scenario, turns, persona, title, contactId });
  const allowed = plan.channels || ['livechat', 'sms'];
  const want = channel === 'both' ? allowed : [channel].filter(c => allowed.includes(c));
  const results = [];
  for (const ch of want) {
    try {
      results.push(ch === 'livechat'
        ? await simulateLiveChat(plan, { nepqMode, productionDeps: await deps.productionDeps() })
        : await simulateSms(plan, { nepqMode, generate: await deps.generate(), buildRealContext: deps.buildRealContext || null }));
    } catch (err) {
      results.push({ channel: ch, scenario: plan.key, title: plan.title, error: String(err?.message || err).slice(0, 300) });
    }
  }
  return results;
}

/** One readable block per conversation, for a person. Pure. */
export function formatTranscript(result) {
  if (result.error) return `■ ${result.title} [${result.channel}] FAILED: ${result.error}`;
  const lines = [`■ ${result.title} [${result.channel === 'livechat' ? 'LIVE CHAT' : 'SMS'}] (NEPQ ${result.nepq_mode}${result.contact_id ? `, record ${result.contact_id}` : ''})`];
  for (const t of result.transcript) {
    lines.push(`  Customer: ${t.customer}`);
    if (t.bot?.length) for (const b of t.bot) lines.push(`  Bot:      ${b}`);
    else lines.push(`  Bot:      (no reply${t.outcome ? `, ${t.outcome}` : ''}${t.error ? `: ${t.error}` : ''})`);
    const notes = [];
    if (t.nepq?.move) notes.push(`move=${t.nepq.move}`);
    if (t.nepq?.objection) notes.push(`objection=${t.nepq.objection}`);
    if (t.nepq?.handoff) notes.push(`handoff=${t.nepq.handoff}`);
    if (t.nepq?.changes?.length || t.nepq?.would_change?.length) notes.push(`guard=${(t.nepq.changes || t.nepq.would_change).join(',')}`);
    if (t.redraft_guard) notes.push(`redraft=${t.redraft_guard} (${(t.attempts || []).map(a => `${a.seconds}s`).join(' + ')})`);
    if (t.flow) notes.push(`flow=${t.flow}`);
    for (const w of t.would_do || []) notes.push(`${w.kind}${w.reason ? `:${w.reason}` : ''}`);
    notes.push(`${t.seconds}s`);
    lines.push(`            [${notes.join(' | ')}]`);
  }
  for (const w of result.would_do || []) {
    if (w.kind === 'warning') { lines.push(`  ⚠ ${w.line}`); continue; }
    lines.push(`  ↳ ${w.kind.replace(/_/g, ' ')}${w.reason ? ` (${w.reason})` : ''}${w.card ? ` [${w.card}]` : ''}${w.new_start ? ` → ${w.new_start}` : ''}${w.start ? ` → ${w.start}` : ''}`);
  }
  return lines.join('\n');
}

// ── async jobs (SMS turns take ~30s each on a thinking model) ──
const jobs = new Map();
const MAX_JOBS = 50;

export function startSimulationJob(input, deps) {
  const id = `sim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const job = { id, status: 'running', started_at: new Date().toISOString(), input, results: [], error: null };
  jobs.set(id, job);
  if (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);
  const keys = input.scenario === 'all' ? Object.keys(SCENARIOS) : [input.scenario || null];
  (async () => {
    for (const key of keys) {
      const res = await runSimulation({ ...input, scenario: key }, deps);
      job.results.push(...res);
    }
    job.status = 'done';
    job.completed_at = new Date().toISOString();
  })().catch((err) => { job.status = 'failed'; job.error = String(err?.message || err).slice(0, 300); });
  return job;
}

export function getSimulationJob(id) {
  return jobs.get(id) || null;
}
