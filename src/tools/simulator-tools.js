/**
 * Bot simulator tools — src/tools/simulator-tools.js  (2026-10-02)
 *
 *   simulate_bot_conversation  run a scripted conversation (a named scenario,
 *                              "all", or your own messages) through the real
 *                              live-chat and/or SMS bot; nothing is sent or written
 *   get_bot_simulation         the transcript of a run, readable or as JSON
 *
 * WHY: live testing meant typing each message into the website chat or a
 * phone and waiting on every reply (Mark, 2026-10-02). See
 * src/simulator/bot-simulator.js for what is real and what is recorded.
 *
 * Also mounted as POST /admin/bot-simulate and GET /admin/bot-simulate/:id
 * (x-admin-token enforced when ADMIN_API_TOKEN is set, the lp-force-addlead
 * pattern). Schema uses primitive zod types only (see http-tools.js SCHEMA NOTE).
 */
import { z } from 'zod';
import { SCENARIOS, startSimulationJob, getSimulationJob, formatTranscript } from '../simulator/bot-simulator.js';

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });

export const simulatorDeps = {
  productionDeps: () => import('../live-chat/index.js').then(m => m.productionLaneDeps()),
  generate: () => import('../response-generator.js').then(m => m.generateResponse),
};

/** Validate and normalise a run request. Pure; throws a readable error. */
export function parseSimRequest({ scenario = null, messages_json = null, channel = 'both', nepq_mode = 'live', persona_json = null, title = null } = {}) {
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
  return { scenario: turns ? null : scenario, turns, persona, title, channel, nepqMode: nepq_mode };
}

async function waitFor(job, seconds) {
  const until = Date.now() + Math.min(Math.max(0, seconds), 100) * 1000;
  while (job.status === 'running' && Date.now() < until) await new Promise(r => setTimeout(r, 1000));
  return job;
}

function render(job, format) {
  if (format === 'json') return text(job);
  const head = `Simulation ${job.id}: ${job.status}${job.error ? ` (${job.error})` : ''} — ${job.results.length} conversation(s)`;
  return text([head, ...job.results.map(formatTranscript)].join('\n\n'));
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
      channel: z.string().optional().describe('both (default), livechat or sms.'),
      nepq_mode: z.string().optional().describe('live (default: the NEPQ backbone answers) or off (today\'s production replies).'),
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
  const authed = (req, res) => {
    const required = process.env.ADMIN_API_TOKEN;
    if (required && req.headers['x-admin-token'] !== required) { res.status(401).json({ error: 'x-admin-token required' }); return false; }
    return true;
  };
  app.post('/admin/bot-simulate', (req, res) => {
    if (!authed(req, res)) return;
    let parsed;
    try { parsed = parseSimRequest({ ...req.body, messages_json: Array.isArray(req.body?.messages) ? JSON.stringify(req.body.messages) : req.body?.messages_json, persona_json: req.body?.persona ? JSON.stringify(req.body.persona) : req.body?.persona_json }); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    const job = startSimulationJob(parsed, deps);
    return res.status(202).json({ job_id: job.id, status_url: `/admin/bot-simulate/${job.id}` });
  });
  app.get('/admin/bot-simulate/:id', (req, res) => {
    if (!authed(req, res)) return;
    const job = getSimulationJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'not found (jobs are in memory and lost on a deploy)' });
    if (req.query.format === 'text') return res.type('text/plain').send([`Simulation ${job.id}: ${job.status}`, ...job.results.map(formatTranscript)].join('\n\n'));
    return res.json(job);
  });
}
