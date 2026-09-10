/**
 * Memory MCP tools — src/tools/memory-tools.js  (priority #8, 2026-09-06)
 *
 *   memory_context     the session-start pack (sql/090/091) — chat, Cowork,
 *                      Code and n8n all get the same ~8k-token start
 *   memory_search      hybrid full-text + vector memory search (sql/094);
 *                      obeys MEMORY_VECTOR_MODE (off | shadow | live)
 *   memory_checkpoint  write a session checkpoint in the v4 skill shape;
 *                      dry run unless confirm:true. mode 'live' | 'retro'
 *                      (sql/098): retro requires source{chat_url, chat_title,
 *                      chat_updated_at}; the provenance guard
 *                      (MEMORY_GUARD_MODE) checks the batch pattern and the
 *                      ≥ MEMORY_CONFLICT_THRESHOLD supersession rule.
 *   memory_precheck    "have we already decided this / did Mark reject it?"
 *                      — top active decisions, closed matches, open conflicts.
 *
 * All four touch only the claude_* memory tables and memory_vector_queries.
 * Nothing in the customer request path calls them.
 */
import { z } from 'zod';
import supabase from '../supabase.js';
import { SOURCES } from '../memory/memory-text.js';
import { planCheckpoint, applyCheckpoint, CheckpointError } from '../memory/memory-checkpoint.js';
import { withRetry, isTransientError, CHECKPOINT_RETRY } from '../memory/with-retry.js';

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const KINDS = Object.keys(SOURCES);

// Transport retry (issue #1627): the three tools share the Supabase client, so
// the read tools get the same 3-attempt schedule as the checkpoint write.
const READ_RETRY = { ...CHECKPOINT_RETRY, onRetry: (err, attempt, delay) => console.warn(`[Memory] read attempt ${attempt} failed (${err.message}) — retry in ${delay}ms`) };
function rpcError(what, res) {
  const err = new Error(`${what}: ${res.error.message}`);
  if (res.status) err.status = res.status;
  if (res.error.code) err.code = res.error.code;
  if (res.error.details) err.details = res.error.details;
  return err;
}
export function classifyCheckpointError(err) {
  if (err instanceof CheckpointError) return 'validation';
  return isTransientError(err) ? 'transport' : 'write';
}

export function registerMemoryTools(server) {
  server.tool(
    'memory_context',
    'Session-start context pack for the Reece project memory (~8k tokens): last session + its open items, five prior sessions, top 25 open critical/high issues (live before retro), decisions and resolutions from the last 30 days, open pending items from the last 14 days, full-text matches for the topic, and counts of what was left out. Read-only. Pass the conversation topic in 2–5 words.',
    { topic: z.string().optional().describe("2–5 words, e.g. 'appointment title' or 'LightFire payroll'. Omit only when there is no subject yet.") },
    async ({ topic } = {}) => {
      if (!supabase) return text({ error: 'Supabase client not configured' });
      try {
        const data = await withRetry(async () => {
          const res = await supabase.rpc('claude_memory_context', { p_topic: topic && topic.trim() ? topic.trim() : null });
          if (res.error) throw rpcError('claude_memory_context', res);
          return res.data;
        }, READ_RETRY);
        return text(data);
      } catch (err) {
        return text({ error: err.message, kind: isTransientError(err) ? 'transport' : 'read', attempts: err.attempts });
      }
    },
  );

  server.tool(
    'memory_search',
    'Ranked search over project memory (decisions, issues, sessions, pending items). Full-text always; the vector leg runs when MEMORY_VECTOR_MODE is shadow or live and its results are returned only in live. Superseded / rejected / expired / duplicate / resolved rows are HIDDEN by default (include_closed: true brings history back, weighted low). Every row carries origin (live | retro — retro rows are reconstructed, not confirmed), status and date_confidence. Read-only apart from the memory_vector_queries log.',
    {
      query: z.string().min(2).describe('What you are looking for, in plain words. Exact tokens (S4.5, 8e30ff37, a file name) also match.'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
      area: z.string().optional().describe('Area slug filter, e.g. appointments, five9-dialer, memory-system'),
      kind: z.enum(['decision', 'issue', 'session', 'pending']).optional().describe('Restrict the vector leg to one row type'),
      include_closed: z.boolean().optional().describe('Include superseded / rejected / resolved / expired rows (default false — current truth only)'),
    },
    async ({ query, limit, area, kind, include_closed } = {}) => {
      try {
        const { hybridMemorySearch } = await import('../memory/memory-search.js');
        const out = await withRetry(() => hybridMemorySearch(query, { limit, filterArea: area, filterKind: kind, includeClosed: include_closed }), READ_RETRY);
        return text(out);
      } catch (err) {
        return text({ error: err.message, kind: isTransientError(err) ? 'transport' : 'read', attempts: err.attempts });
      }
    },
  );

  const decision = z.object({
    category: z.string().describe('one of architecture, routing, messaging, appointments, sync, integration, data, agentic, infrastructure, reporting, compliance, operations'),
    decision: z.string(), rationale: z.string().optional(),
    options: z.array(z.string()).optional().describe('alternatives considered'),
    workflow_code: z.string().optional().describe('canonical code, e.g. S4.5, when a registered workflow is involved'),
    supersedes_id: z.number().int().optional().describe('id of the decision this one replaces — it is marked superseded'),
    same_as_id: z.number().int().optional().describe('id of an existing active decision this merely re-confirms — nothing new is inserted; the existing row gets verified_at'),
    confirmed_by_mark: z.boolean().optional().describe('retro mode only: the transcript shows Mark stating this — confidence becomes confirmed instead of reconstructed'),
  });
  const issue = z.object({
    severity: z.enum(['critical', 'high', 'medium', 'low']), category: z.string(), description: z.string(),
    impact: z.string().optional(), fix_instructions: z.string().optional(),
    workflow_code: z.string().optional(), workflow_name: z.string().optional(),
    issue_type: z.enum(['defect', 'initiative', 'metric']).optional().describe('default defect'),
  });
  const idNote = z.object({ id: z.number().int(), verification_note: z.string().describe('what proved it — file, PR, live check') });
  const pending = z.object({
    kind: z.enum(['pending', 'next_step']).optional(), item_type: z.string().optional(),
    description: z.string(), priority: z.number().int().optional(), effort: z.string().optional(),
    blocked_by: z.string().optional(), ref: z.string().optional(), owner: z.string().optional(),
  });
  const close = z.object({ id: z.number().int(), status: z.enum(['done', 'dropped', 'superseded', 'blocked', 'deferred', 'ratified']).optional() });

  server.tool(
    'memory_checkpoint',
    'Write a project-memory checkpoint in one call (the v4 session-continuity shape): a session row, decisions (each stamped with the session search keys), issues, resolutions, pending items and closures. Give session_id to REFRESH an existing session instead of inserting a new one — it never creates a second session for the same chat. mode "live" (default) = you are inside the chat; mode "retro" = you reconstructed an old chat from search and MUST pass source{chat_url, chat_title, chat_updated_at} (the row is stamped retro, dated from the chat, ledger row written). A date in the future or more than 400 days back is rejected. A new decision whose nearest active decision scores ≥ 0.85 must name it via supersedes_id or same_as_id (MEMORY_GUARD_MODE shadow logs, live rejects). Safe to re-send: the session identity is a hash of surface + date + title, so a call repeated after a dropped response refreshes that session (result: inserted false, "refreshed existing session #N") instead of writing a twin. Dry run unless confirm is true.',
    {
      mode: z.enum(['live', 'retro']).optional().describe('live (default): written from inside the chat. retro: reconstructed from a search result — source is required'),
      source: z.object({
        chat_url: z.string().describe('url from the conversation_search / recent_chats result'),
        chat_title: z.string().optional(),
        chat_updated_at: z.string().describe('updated_at from the search result (ISO) — becomes session_date'),
      }).optional().describe('retro mode only'),
      session_id: z.number().int().optional().describe('existing session to update (refresh / mid-session). Omit for a new session.'),
      session: z.object({
        title: z.string().optional(), date: z.string().optional().describe('YYYY-MM-DD — the date on the chat\'s FIRST message (default today ET). Rejected if in the future or > 400 days back'),
        date_confidence: z.enum(['exact', 'write_date']).optional().describe("default exact. Use write_date when date is only the day this checkpoint is written (retro sweeps) — the session-start pack then demotes it"),
        phase_focus: z.string().optional(), summary: z.string().optional().describe('the narrative'),
        search_keys: z.array(z.string()).optional().describe('5–8 short strings that literally appeared in the conversation'),
        surface: z.enum(['chat', 'cowork', 'code', 'n8n']).optional(),
        chat_url: z.string().optional(), chat_title: z.string().optional(),
        workflows_touched: z.array(z.any()).optional(), mcp_verified_ids: z.array(z.any()).optional(),
      }).optional(),
      decisions: z.array(decision).optional(),
      issues: z.array(issue).optional(),
      resolved_issues: z.array(idNote).optional(),
      verified_issues: z.array(idNote).optional().describe('re-checked and still open — clears stale'),
      pending: z.array(pending).optional(),
      close_pending: z.array(close).optional(),
      confirm: z.boolean().optional().describe('true to write; otherwise returns the plan'),
      checkpoint_key: z.string().min(8).optional().describe('override the identity key. Normally unnecessary: the key is derived from surface + session date + title, so simply re-sending the same checkpoint refreshes the same session. Pass partial.checkpoint_key from a previous transport failure to resume that exact session.'),
    },
    async (args = {}) => {
      try {
        if (args.confirm !== true) return text(planCheckpoint(args));
        const out = await applyCheckpoint(args, { checkpoint_key: args.checkpoint_key || null });
        return text({ ok: true, ...out });
      } catch (err) {
        const kind = classifyCheckpointError(err);
        const body = { ok: false, kind, error: err.message, attempts: err.attempts ?? err.partial?.attempts ?? 1, partial: err.partial ?? null };
        if (kind === 'transport') body.hint = 'Transient failure after retries. partial lists what already landed — fall back to SQL for the rest, or simply re-send the same checkpoint: the identity key is deterministic, so it resumes that session rather than creating a second one.';
        if (kind === 'validation' && /supersedes_id|same_as_id/.test(err.message)) body.hint = 'Run memory_precheck on the decision text to see the matching decision, then re-send with supersedes_id (replace it) or same_as_id (re-confirm it).';
        return text(body);
      }
    },
  );

  server.tool(
    'memory_precheck',
    'Before proposing a change, a rule, or a PR: "have we already decided this, and did Mark ever reject it?" Returns the top 5 ACTIVE decisions on the subject (same area first), superseded / rejected decisions that match at or above the conflict threshold, open rows in claude_memory_conflicts that involve them, and a verdict: clear | already_decided | previously_rejected | conflict_open. Read-only. Call it from Cowork before a finding proposes a change, from the Decision Engine before an agent_rules insert, and from Claude Code before a PR that touches sql/ or src/jobs/.',
    {
      proposal_text: z.string().min(5).describe('The proposal in plain words — what you are about to suggest or change'),
      area: z.string().optional().describe('Area slug to rank first, e.g. appointments, agentic-engine, memory-system'),
      limit: z.number().int().min(1).max(20).optional().describe('Max active decisions returned (default 5)'),
    },
    async ({ proposal_text, area, limit } = {}) => {
      try {
        const { memoryPrecheck } = await import('../memory/memory-precheck.js');
        const out = await withRetry(() => memoryPrecheck(proposal_text, { area, limit }), READ_RETRY);
        return text(out);
      } catch (err) {
        return text({ error: err.message, kind: isTransientError(err) ? 'transport' : 'read', attempts: err.attempts });
      }
    },
  );

  console.log(`[Memory] MCP tools registered: memory_context, memory_search, memory_checkpoint, memory_precheck (kinds: ${KINDS.join(', ')}; guard=${process.env.MEMORY_GUARD_MODE || 'shadow'})`);
}
