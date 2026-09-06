/**
 * Memory MCP tools — src/tools/memory-tools.js  (priority #8, 2026-09-06)
 *
 *   memory_context     the session-start pack (sql/090/091) — chat, Cowork,
 *                      Code and n8n all get the same ~8k-token start
 *   memory_search      hybrid full-text + vector memory search (sql/094);
 *                      obeys MEMORY_VECTOR_MODE (off | shadow | live)
 *   memory_checkpoint  write a session checkpoint in the v4 skill shape;
 *                      dry run unless confirm:true
 *
 * All three touch only the claude_* memory tables and memory_vector_queries.
 * Nothing in the customer request path calls them.
 */
import { z } from 'zod';
import supabase from '../supabase.js';
import { SOURCES } from '../memory/memory-text.js';
import { planCheckpoint, applyCheckpoint, CheckpointError } from '../memory/memory-checkpoint.js';

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const KINDS = Object.keys(SOURCES);

export function registerMemoryTools(server) {
  server.tool(
    'memory_context',
    'Session-start context pack for the Reece project memory (~8k tokens): last session + its open items, five prior sessions, top 25 open critical/high issues (live before retro), decisions and resolutions from the last 30 days, open pending items from the last 14 days, full-text matches for the topic, and counts of what was left out. Read-only. Pass the conversation topic in 2–5 words.',
    { topic: z.string().optional().describe("2–5 words, e.g. 'appointment title' or 'LightFire payroll'. Omit only when there is no subject yet.") },
    async ({ topic } = {}) => {
      if (!supabase) return text({ error: 'Supabase client not configured' });
      const { data, error } = await supabase.rpc('claude_memory_context', { p_topic: topic && topic.trim() ? topic.trim() : null });
      if (error) return text({ error: `claude_memory_context: ${error.message}` });
      return text(data);
    },
  );

  server.tool(
    'memory_search',
    'Ranked search over project memory (decisions, issues, sessions, pending items). Full-text always; the vector leg runs when MEMORY_VECTOR_MODE is shadow or live and its results are returned only in live. Every row carries origin (live | retro — retro rows are reconstructed, not confirmed) and status. Read-only apart from the memory_vector_queries log.',
    {
      query: z.string().min(2).describe('What you are looking for, in plain words. Exact tokens (S4.5, 8e30ff37, a file name) also match.'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
      area: z.string().optional().describe('Area slug filter, e.g. appointments, five9-dialer, memory-system'),
      kind: z.enum(['decision', 'issue', 'session', 'pending']).optional().describe('Restrict the vector leg to one row type'),
      include_closed: z.boolean().optional().describe('Include superseded / resolved / done rows in the vector leg (default true)'),
    },
    async ({ query, limit, area, kind, include_closed } = {}) => {
      try {
        const { hybridMemorySearch } = await import('../memory/memory-search.js');
        const out = await hybridMemorySearch(query, { limit, filterArea: area, filterKind: kind, includeClosed: include_closed });
        return text(out);
      } catch (err) {
        return text({ error: err.message });
      }
    },
  );

  const decision = z.object({
    category: z.string().describe('one of architecture, routing, messaging, appointments, sync, integration, data, agentic, infrastructure, reporting, compliance, operations'),
    decision: z.string(), rationale: z.string().optional(),
    options: z.array(z.string()).optional().describe('alternatives considered'),
    workflow_code: z.string().optional().describe('canonical code, e.g. S4.5, when a registered workflow is involved'),
    supersedes_id: z.number().int().optional().describe('id of the decision this one replaces — it is marked superseded'),
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
    'Write a project-memory checkpoint in one call (the v4 session-continuity shape): a session row, decisions (each stamped with the session search keys), issues, resolutions, pending items and closures. Give session_id to REFRESH an existing session instead of inserting a new one — it never creates a second session for the same chat. Dry run unless confirm is true.',
    {
      session_id: z.number().int().optional().describe('existing session to update (refresh / mid-session). Omit for a new session.'),
      session: z.object({
        title: z.string().optional(), date: z.string().optional().describe('YYYY-MM-DD, default today ET'),
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
    },
    async (args = {}) => {
      try {
        if (args.confirm !== true) return text(planCheckpoint(args));
        const out = await applyCheckpoint(args);
        return text({ ok: true, ...out });
      } catch (err) {
        return text({ ok: false, error: err.message, kind: err instanceof CheckpointError ? 'validation' : 'write' });
      }
    },
  );

  console.log(`[Memory] MCP tools registered: memory_context, memory_search, memory_checkpoint (kinds: ${KINDS.join(', ')})`);
}
