/**
 * Bot simulator tools — src/tools/simulator-tools.js  (2026-10-02)
 *
 *   simulate_bot_conversation  run a scripted conversation (a named scenario,
 *                              "all", or your own messages) through the real
 *                              live-chat and/or SMS bot; nothing is sent or written
 *   get_bot_simulation         the transcript of a run, readable or as JSON
 *   run_bot_eval               the gate: every scenario on both bots, scored,
 *                              compared with the last gate run and saved
 *                              (2026-10-06). Run it before and after a prompt
 *                              or model change.
 *
 * WHY: live testing meant typing each message into the website chat or a
 * phone and waiting on every reply (Mark, 2026-10-02). See
 * src/simulator/bot-simulator.js for what is real and what is recorded.
 *
 * Also mounted as POST /admin/bot-simulate, POST /admin/bot-eval and
 * GET /admin/bot-simulate/:id
 * (x-admin-token enforced when ADMIN_API_TOKEN is set, the lp-force-addlead
 * pattern). Schema uses primitive zod types only (see http-tools.js SCHEMA NOTE).
 */
import { checkRequestSecret } from '../security/request-auth.js';
import { z } from 'zod';
import { SCENARIOS, startSimulationJob, getSimulationJob, formatTranscript } from '../simulator/bot-simulator.js';
import { formatScorecard } from '../simulator/sim-scoring.js';

/** The event a saved gate run is stored as (system_events; no table of its own). */
export const EVAL_RUN_EVENT = 'agentic.bot_eval_run';

/** The saved form of a scorecard: codes and turns, never customer text. Pure. */
export function evalRunPayload(scorecard, comparison, runCards = null) {
  const { results = [], ...head } = scorecard || {};
  const compact = (r) => ({ key: r.key, family: r.family || null, pass: r.pass, ...(r.flaky ? { flaky: true } : {}), failures: r.failures.map(f => ({ code: f.code, turn: f.turn ?? null, ...(f.run ? { run: f.run } : {}) })) });
  return {
    scorecard: { ...head, results: results.map(compact) },
    comparison: comparison || null,
    // 2026-10-18 (Phase 1 item 3): one event per gate, every run's results inside.
    ...(Array.isArray(runCards) && runCards.length > 1 ? { runs: runCards.map(c => ({ passed: c.passed, conversations: c.conversations, results: (c.results || []).map(compact) })) } : {}),
  };
}

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });

export const simulatorDeps = {
  productionDeps: () => import('../live-chat/index.js').then(m => m.productionLaneDeps()),
  generate: () => import('../response-generator.js').then(m => m.generateResponse),
  // READ ONLY: a real contact's record for a more realistic run.
  buildRealContext: (contactId) => import('../context-builder.js').then(m => m.buildLeadContext(contactId, { includeConversation: false, skipCache: true })),
  // What a gate run ran on, so two runs are compared knowingly.
  evalMeta: async () => {
    const [{ RESPONSE_GENERATOR_VERSION }, { resolveLLM }, { corePromptVersion }] = await Promise.all([
      import('../response-generator.js'), import('../llm-client.js'), import('../bot-feedback/fingerprint-core.js'),
    ]);
    return {
      prompt_version: corePromptVersion(RESPONSE_GENERATOR_VERSION),
      git_sha: process.env.RAILWAY_GIT_COMMIT_SHA || null,
      models: { sms: resolveLLM('response_generator').model, livechat: resolveLLM('live_chat').model },
    };
  },
  lastEvalRun: async ({ nepqMode = 'live' } = {}) => {
    const { default: supabase } = await import('../supabase.js');
    // The last run in the SAME NEPQ mode (compareScorecards refuses a cross-mode comparison).
    const { data, error } = await supabase.from('system_events').select('payload').eq('event_type', EVAL_RUN_EVENT)
      .order('created_at', { ascending: false }).limit(10);
    if (error) throw new Error(error.message);
    const modeOf = (m) => (m || 'live');
    return (data || []).map(r => r?.payload?.scorecard).find(c => c && modeOf(c.nepq_mode) === modeOf(nepqMode)) || null;
  },
  recordEvalRun: async (scorecard, comparison, runCards = null) => {
    const { emitEvent } = await import('../event-emitter.js');
    return emitEvent({ event_type: EVAL_RUN_EVENT, source: 'bot_eval', entity_type: 'bot_eval', payload: evalRunPayload(scorecard, comparison, runCards), bypass_filter: true });
  },
};

/** Validate and normalise a run request. Pure; throws a readable error. */
export function parseSimRequest({ scenario = null, messages_json = null, channel = 'both', nepq_mode = 'live', persona_json = null, title = null, contact_id = null, lead_stage_mode = null, kb_exemplar_mode = null, runs = null, turn_lock_mode = null } = {}) {
  let turns = null;
  if (messages_json) {
    try { turns = JSON.parse(messages_json); } catch { throw new Error('messages_json must be a JSON array of strings'); }
    if (!Array.isArray(turns) || !turns.length || !turns.every(t => typeof t === 'string')) throw new Error('messages_json must be a JSON array of strings');
  }
  let persona = null;
  if (persona_json) {
    try { persona = JSON.parse(persona_json); } catch { throw new Error('persona_json must be a JSON object'); }
  }
  if (!turns && scenario !== 'all' && !SCENARIOS[scenario]) throw new Error(`scenario must be one of: all, ${Object.keys(SCENARIOS).join(', ')} (or pass messages_json)`);
  if (!['both', 'livechat', 'sms'].includes(channel)) throw new Error('channel must be both, livechat or sms');
  if (!['live', 'off'].includes(nepq_mode)) throw new Error('nepq_mode must be live or off');
  if (contact_id && !/^[A-Za-z0-9]{10,40}$/.test(String(contact_id))) throw new Error('contact_id must be a GHL contact id');
  // 2026-10-12: try the stored-stage planner before Railway's LEAD_STAGE_MODE is
  // switched (the stage is kept in memory either way; nothing is written).
  if (lead_stage_mode != null && lead_stage_mode !== '' && !['shadow', 'live'].includes(lead_stage_mode)) throw new Error('lead_stage_mode must be shadow or live');
  // 2026-10-12: try past-win exemplars before Railway's KB_EXEMPLAR_MODE is switched.
  if (kb_exemplar_mode != null && kb_exemplar_mode !== '' && !['off', 'shadow', 'live'].includes(kb_exemplar_mode)) throw new Error('kb_exemplar_mode must be off, shadow or live');
  // 2026-10-18 (Phase 1 item 3): the gate's runs (1-4; the gate defaults to 2).
  if (runs != null && runs !== '' && !(Number.isInteger(Number(runs)) && Number(runs) >= 1 && Number(runs) <= 4)) throw new Error('runs must be 1 to 4');
  // 2026-10-18 (Phase 1): try TURN_LOCK_MODE=live in the simulator before Railway's is switched.
  if (turn_lock_mode != null && turn_lock_mode !== '' && !['shadow', 'live'].includes(turn_lock_mode)) throw new Error('turn_lock_mode must be shadow or live');
  return { scenario: turns ? null : scenario, turns, persona, title, channel, nepqMode: nepq_mode, contactId: contact_id || null, leadStageMode: lead_stage_mode || null, kbExemplarMode: kb_exemplar_mode || null, ...(runs != null && runs !== '' ? { runs: Number(runs) } : {}), turnLockMode: turn_lock_mode || null };
}

async function waitFor(job, seconds) {
  const until = Date.now() + Math.min(Math.max(0, seconds), 100) * 1000;
  while (job.status === 'running' && Date.now() < until) await new Promise(r => setTimeout(r, 1000));
  return job;
}

function render(job, format) {
  if (format === 'json') return text(job);
  const head = `Simulation ${job.id}: ${job.status}${job.error ? ` (${job.error})` : ''} — ${job.results.length} conversation(s)${job.runs > 1 ? ` · run ${Math.min(job.runs, (job.runs_done || 0) + (job.status === 'running' ? 1 : 0))} of ${job.runs} (transcripts below are run 1)` : ''}`;
  const card = job.scorecard ? [formatScorecard(job.scorecard, job.comparison || null) + (job.save_error ? `\n(${job.save_error})` : '')] : [];
  return text([head, ...card, ...job.results.map(formatTranscript)].join('\n\n'));
}

export function registerSimulatorTools(server, deps = simulatorDeps) {
  server.tool(
    'simulate_bot_conversation',
    'Run a test conversation through the REAL live-chat and/or SMS bot (real model, prompt, knowledge, NEPQ planner, guards) ' +
      'with every send, GHL/LP write, tag, alert, booking and cancel only RECORDED. Returns a job id; poll get_bot_simulation. ' +
      `Scenarios: all, ${Object.keys(SCENARIOS).join(', ')}. Or pass your own customer messages as messages_json.`,
    {
      scenario: z.string().optional().describe('Named scenario, or "all".'),
      messages_json: z.string().optional().describe('Your own customer messages, as a JSON array of strings (max 12).'),
      persona_json: z.string().optional().describe('Optional customer record, e.g. {"firstName":"Dana","phone":"+13525550101","postalCode":"33908"}.'),
      contact_id: z.string().optional().describe('Optional real GHL contact whose record is READ for realism (e.g. the sandbox test contact s2Omf2RcK5YBISwgHHOe). Nothing is sent or written to it. Never a real lead, nor a contact tagged hard-disqualified or suppress-outbound.'),
      channel: z.string().optional().describe('both (default), livechat or sms.'),
      nepq_mode: z.string().optional().describe('live (default: the NEPQ backbone answers) or off (today\'s production replies).'),
      lead_stage_mode: z.string().optional().describe('shadow or live: run with the stored conversation stage recorded only (shadow) or driving the planner (live). Default: Railway\'s LEAD_STAGE_MODE. Kept in memory; nothing is written.'),
      kb_exemplar_mode: z.string().optional().describe('off, shadow or live: past-win examples for this run only (live puts them in the prompt). Default: Railway\'s KB_EXEMPLAR_MODE.'),
      wait_seconds: z.number().optional().describe('Wait up to this many seconds (max 100) for the result before returning.'),
    },
    async (args) => {
      let req;
      try { req = parseSimRequest(args); } catch (err) { return text({ error: err.message }); }
      const job = startSimulationJob(req, deps);
      if (args.wait_seconds) await waitFor(job, args.wait_seconds);
      return job.status === 'running' ? text({ job_id: job.id, status: 'running', next: 'call get_bot_simulation with this job_id' }) : render(job, 'text');
    },
  );

  server.tool(
    'run_bot_eval',
    'The bot gate: runs EVERY scenario through the real live-chat and SMS bots (real model, nothing sent or written), ' +
      'scores each conversation against the hard checks and the scenario\'s own rules, compares with the last gate run ' +
      'and saves the result. Run it before and after any prompt or model change and ship only if it is not worse. ' +
      'Every scenario runs `runs` times (default 2): a key passes only if it passes in every run, and one that passes in one run and fails in another is reported as flaky, never compared. ' +
      'Cost: ~260 real model turns per gate at the default 2 runs (about 20-30 minutes); returns a job id for get_bot_simulation.',
    {
      runs: z.number().optional().describe('How many times each scenario runs (1-4, default 2).'),
      turn_lock_mode: z.string().optional().describe('shadow or live (default: Railway\'s TURN_LOCK_MODE). live runs the turn lock as it would skip.'),
      nepq_mode: z.string().optional().describe('live (default, production) or off.'),
      lead_stage_mode: z.string().optional().describe('shadow or live (default: Railway\'s LEAD_STAGE_MODE). live runs the stored-stage planner before it is switched on.'),
      kb_exemplar_mode: z.string().optional().describe('off, shadow or live (default: Railway\'s KB_EXEMPLAR_MODE). live puts past-win examples in the prompt before it is switched on.'),
    },
    async ({ nepq_mode = 'live', lead_stage_mode = null, kb_exemplar_mode = null, runs = 2, turn_lock_mode = null } = {}) => {
      let req;
      try { req = parseSimRequest({ scenario: 'all', channel: 'both', nepq_mode, lead_stage_mode, kb_exemplar_mode, runs, turn_lock_mode }); } catch (err) { return text({ error: err.message }); }
      const job = startSimulationJob({ ...req, gate: true }, deps);
      return text({ job_id: job.id, status: 'running', next: 'call get_bot_simulation with this job_id (wait_seconds up to 100, repeat until done); the scorecard is at the top' });
    },
  );

  server.tool(
    'get_bot_simulation',
    'The transcript of a simulate_bot_conversation run: every customer message, the bot reply, the NEPQ move and what the bot would have done.',
    {
      job_id: z.string().describe('From simulate_bot_conversation.'),
      format: z.string().optional().describe('text (default) or json.'),
      wait_seconds: z.number().optional().describe('Wait up to this many seconds (max 100) for a running job.'),
    },
    async ({ job_id, format = 'text', wait_seconds = 0 }) => {
      const job = getSimulationJob(job_id);
      if (!job) return text({ error: `no simulation ${job_id} (jobs live in memory and are lost on a deploy)` });
      if (wait_seconds) await waitFor(job, wait_seconds);
      return render(job, format);
    },
  );
}

export function registerSimulatorRoutes(app, deps = simulatorDeps) {
  // Staged, constant-time (2026-10-06, src/security/request-auth.js): open
  // when ADMIN_API_TOKEN is unset only under AUTH_ENFORCE_MODE=log.
  const authed = (req, res) => {
    const d = checkRequestSecret(req, { route: req.path || 'admin-sim', secret: process.env.ADMIN_API_TOKEN, headers: ['x-admin-token'] });
    if (d.allow) return true;
    res.status(d.status).json(d.status === 503 ? { error: 'ADMIN_API_TOKEN is not set; this endpoint is closed' } : { error: 'x-admin-token required' });
    return false;
  };
  app.post('/admin/bot-simulate', (req, res) => {
    if (!authed(req, res)) return;
    let parsed;
    try { parsed = parseSimRequest({ ...req.body, messages_json: Array.isArray(req.body?.messages) ? JSON.stringify(req.body.messages) : req.body?.messages_json, persona_json: req.body?.persona ? JSON.stringify(req.body.persona) : req.body?.persona_json }); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    const job = startSimulationJob(parsed, deps);
    return res.status(202).json({ job_id: job.id, status_url: `/admin/bot-simulate/${job.id}` });
  });
  // The gate spends ~260 real model turns (2 runs), so unlike bot-simulate it refuses
  // when ADMIN_API_TOKEN is unset instead of running open (2026-10-06 audit:
  // fail-open admin secrets were finding F7).
  app.post('/admin/bot-eval', (req, res) => {
    if (!process.env.ADMIN_API_TOKEN) return res.status(503).json({ error: 'ADMIN_API_TOKEN is not set; the bot gate is closed' });
    if (!authed(req, res)) return;
    let parsed;
    try { parsed = parseSimRequest({ scenario: 'all', channel: 'both', nepq_mode: req.body?.nepq_mode || 'live', lead_stage_mode: req.body?.lead_stage_mode || null, kb_exemplar_mode: req.body?.kb_exemplar_mode || null, runs: req.body?.runs ?? 2, turn_lock_mode: req.body?.turn_lock_mode || null }); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    const job = startSimulationJob({ ...parsed, gate: true }, deps);
    return res.status(202).json({ job_id: job.id, status_url: `/admin/bot-simulate/${job.id}` });
  });
  app.get('/admin/bot-simulate/:id', (req, res) => {
    if (!authed(req, res)) return;
    const job = getSimulationJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'not found (jobs are in memory and lost on a deploy)' });
    if (req.query.format === 'text') return res.type('text/plain').send([`Simulation ${job.id}: ${job.status}`, ...(job.scorecard ? [formatScorecard(job.scorecard, job.comparison || null)] : []), ...job.results.map(formatTranscript)].join('\n\n'));
    return res.json(job);
  });
}
