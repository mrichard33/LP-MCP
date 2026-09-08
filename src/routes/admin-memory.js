/**
 * Admin memory routes — src/routes/admin-memory.js  (sql/098, 2026-09-08)
 *
 *   POST /admin/memory/event      n8n door. A workflow that fails (or notices
 *                                 something) files a pending item or an issue
 *                                 with origin='n8n'. NEVER a decision — the
 *                                 route returns 400 for kind='decision'. The
 *                                 same provenance guard applies: rows hang off
 *                                 one session per ET day (log_origin='n8n',
 *                                 surface='n8n'), an open issue with the same
 *                                 description is returned instead of filed
 *                                 twice, and every row carries the source
 *                                 workflow name.
 *       body: { kind: "pending" | "issue", description, source?: "<n8n workflow>",
 *               severity?, category?, impact?, item_type?, ref?, workflow_code?, workflow_name?, priority? }
 *
 *   POST /admin/memory/validate   manual run of the nightly validation checks
 *                                 and the conflict scan.
 *       body: { dry_run?: bool (default true), full?: bool (conflict scan over
 *               every row, not just the last 24 h) }
 *       dry_run:true writes validation-log rows and changes nothing else.
 *
 * Both routes sit behind `authenticate` (Bearer MCP_AUTH_TOKEN) like every
 * other /admin route. Nothing in the customer request path calls them.
 */
import supabase from '../supabase.js';
import { runSQL } from '../admin/supabase-admin.js';
import { runMemoryValidation } from '../jobs/memory-validate.js';
import { runConflictScan } from '../jobs/memory-conflicts.js';

const EVENT_KINDS = new Set(['pending', 'issue']);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const PENDING_TYPES = new Set(['action_needed', 'decision_needed', 'verification_needed', 'open_question', 'build_needed', 'next_step']);

class BadRequest extends Error {}

function dateET(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
const s = (v, max) => (v == null ? null : String(v).slice(0, max));

/** Pure: validate the event body. Exported for tests. */
export function parseEvent(body = {}) {
  const kind = String(body.kind || '').toLowerCase().trim();
  if (kind === 'decision') throw new BadRequest('decisions are never written through the n8n door — file a pending item (item_type decision_needed) for Mark instead');
  if (!EVENT_KINDS.has(kind)) throw new BadRequest(`kind must be one of ${[...EVENT_KINDS].join(', ')}`);
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!description) throw new BadRequest('description (non-empty string) required');
  const source = s(body.source || body.workflow || 'n8n', 120);
  const out = { kind, description: description.slice(0, 4000), source, ref: s(body.ref, 200), workflow_code: s(body.workflow_code, 20), workflow_name: s(body.workflow_name, 200) };
  if (kind === 'issue') {
    const severity = String(body.severity || 'medium').toLowerCase();
    if (!SEVERITIES.has(severity)) throw new BadRequest('severity must be critical|high|medium|low');
    out.severity = severity;
    out.category = s(body.category || 'integration', 40);
    out.impact = s(body.impact, 2000);
  } else {
    const item_type = String(body.item_type || 'action_needed').toLowerCase();
    if (!PENDING_TYPES.has(item_type)) throw new BadRequest(`item_type must be one of ${[...PENDING_TYPES].join(', ')}`);
    out.item_type = item_type;
    out.priority = body.priority == null ? null : Number(body.priority);
    if (out.priority != null && !Number.isInteger(out.priority)) throw new BadRequest('priority must be an integer');
  }
  return out;
}

function must(res, what) {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

/** One session per ET day for n8n events; found by checkpoint_key so it is never duplicated. */
export async function n8nSessionFor(db, now = new Date()) {
  const today = dateET(now);
  const key = `n8n:${today}`;
  const cur = must(await db.from('claude_session_logs').select('id').eq('checkpoint_key', key).maybeSingle(), 'find n8n session');
  if (cur?.id) return { id: cur.id, created: false };
  const ins = must(await db.from('claude_session_logs').insert({
    session_date: today, date_confidence: 'exact', session_title: `n8n events ${today}`,
    phase_focus: 'n8n job events', raw_summary: `Pending items and issues written by n8n workflows on ${today} through POST /admin/memory/event.`,
    transcript_search_keys: ['n8n', 'memory/event', today], surface: 'n8n', log_origin: 'n8n', link_confidence: 'unlinked',
    workflows_touched: [], phase_status: {}, decisions_made: [], issues_found: [], issues_resolved: [],
    pending_items: [], board_versions: [], mcp_verified_ids: [], next_steps: [], checkpoint_key: key,
  }).select('id').single(), 'insert n8n session');
  return { id: ins.id, created: true };
}

/** Write the event. Exported for tests (db injected). */
export async function writeEvent(ev, { db, now = new Date() } = {}) {
  if (!db) throw new Error('Supabase client not configured');
  const nowIso = now.toISOString();
  const today = dateET(now);
  const session = await n8nSessionFor(db, now);
  const text = `[n8n:${ev.source}] ${ev.description}`;
  if (ev.kind === 'issue') {
    const dup = must(await db.from('claude_known_issues').select('id, status').eq('description', text).in('status', ['open', 'in_progress']).limit(1), 'dedupe issue');
    if (Array.isArray(dup) && dup[0]?.id) return { ok: true, kind: 'issue', id: dup[0].id, session_id: session.id, deduped: true };
    const ins = must(await db.from('claude_known_issues').insert({
      reported_date: today, reported_session_id: session.id, severity: ev.severity, category: ev.category,
      description: text, impact: ev.impact, workflow_code: ev.workflow_code, workflow_name: ev.workflow_name,
      issue_type: 'defect', status: 'open', origin: 'n8n', confidence: 'confirmed',
    }).select('id').single(), 'insert issue');
    return { ok: true, kind: 'issue', id: ins.id, session_id: session.id, deduped: false };
  }
  const last = must(await db.from('claude_pending_items').select('source_index').eq('source_session_id', session.id).eq('source_field', 'n8n').order('source_index', { ascending: false }).limit(1), 'pending index');
  const idx = (last && last[0] && Number.isInteger(last[0].source_index)) ? last[0].source_index + 1 : 0;
  const ins = must(await db.from('claude_pending_items').insert({
    source_session_id: session.id, source_field: 'n8n', source_index: idx, kind: 'pending', item_type: ev.item_type,
    description: text, status: 'open', priority: ev.priority, ref: ev.ref, owner: 'n8n',
    origin: 'n8n', session_date: today, created_at: nowIso,
  }).select('id').single(), 'insert pending');
  return { ok: true, kind: 'pending', id: ins.id, session_id: session.id, deduped: false };
}

/**
 * @param {import('express').Express} app
 * @param {Function} [authenticate]
 * @param {Object}   [deps]  db, runSQL, validate, conflicts, now — test injection
 */
export function registerAdminMemoryRoutes(app, authenticate, deps = {}) {
  const guards = typeof authenticate === 'function' ? [authenticate] : [];
  const db = () => deps.db || supabase;
  const sql = deps.runSQL || runSQL;
  const validate = deps.validate || runMemoryValidation;
  const conflicts = deps.conflicts || runConflictScan;

  app.post('/admin/memory/event', ...guards, async (req, res) => {
    let ev;
    try { ev = parseEvent(req.body || {}); } catch (err) {
      if (err instanceof BadRequest) return res.status(400).json({ ok: false, error: err.message });
      throw err;
    }
    try {
      const out = await writeEvent(ev, { db: db(), now: deps.now ? deps.now() : new Date() });
      return res.status(out.deduped ? 200 : 201).json(out);
    } catch (err) {
      console.error('[MemoryEvent] /admin/memory/event failed:', err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/admin/memory/validate', ...guards, async (req, res) => {
    const body = req.body || {};
    const dry_run = body.dry_run !== false;   // default true: a manual run is a look, not a change
    const full = body.full === true;
    try {
      const validation = await validate({ dry_run, mode: dry_run ? 'dry_run' : 'manual', deps: { runSQL: sql } });
      const scan = await conflicts({ dry_run, full, deps: { runSQL: sql } });
      return res.json({ ok: validation.errors.length === 0 && scan.errors.length === 0, dry_run, full, validation, conflicts: scan });
    } catch (err) {
      console.error('[MemoryValidate] /admin/memory/validate failed:', err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  console.log(`[Memory] Routes: POST /admin/memory/event (n8n: pending | issue, never decision) | POST /admin/memory/validate (dry_run default true)${guards.length ? ' (authenticated)' : ' (UNAUTHENTICATED — no middleware passed)'}`);
}
