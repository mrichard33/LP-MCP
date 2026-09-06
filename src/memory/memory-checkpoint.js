/**
 * Memory Checkpoint — src/memory/memory-checkpoint.js
 *
 * One call writes everything the reece-session-continuity skill (v4) writes at
 * session end, in the same shape: the session row is the timeline (JSON fact
 * columns stay []), decisions / issues / pending items go to their own tables
 * with the session's transcript_search_keys copied onto each decision.
 * With `session_id` set it is a REFRESH / mid-session checkpoint: the session
 * row is UPDATEd (keys unioned, summary replaced, link never downgraded) and
 * new facts are appended — it never inserts a second session for a chat.
 *
 * `db` is injected so scripts/test-memory-checkpoint.js runs without env.
 *
 * v1.0 — 2026-09-06. Initial (priority #8).
 */
import supabase from '../supabase.js';

const SURFACES = new Set(['chat', 'cowork', 'code', 'n8n']);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const ISSUE_TYPES = new Set(['defect', 'initiative', 'metric']);
const PENDING_KINDS = new Set(['pending', 'next_step']);
const PENDING_TYPES = new Set(['action_needed', 'decision_needed', 'verification_needed', 'open_question', 'build_needed', 'next_step', 'unconfirmed_decision']);
const CLOSE_STATUSES = new Set(['done', 'dropped', 'superseded', 'blocked', 'deferred', 'ratified']);

export class CheckpointError extends Error {}

function str(v, name, { required = false, max = 20000 } = {}) {
  if (v == null || v === '') { if (required) throw new CheckpointError(`${name} is required`); return null; }
  if (typeof v !== 'string') throw new CheckpointError(`${name} must be a string`);
  return v.slice(0, max);
}
function isoDate(v, name, fallback) {
  if (v == null || v === '') return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new CheckpointError(`${name} must be YYYY-MM-DD`);
  return String(v);
}
function todayET(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Validate and normalise the payload. Throws CheckpointError on bad input. */
export function validateCheckpoint(input = {}, now = new Date()) {
  const today = todayET(now);
  const sessionId = input.session_id == null ? null : Number(input.session_id);
  if (input.session_id != null && (!Number.isInteger(sessionId) || sessionId < 1)) throw new CheckpointError('session_id must be a positive integer');
  const s = input.session || {};
  const keys = Array.isArray(s.search_keys) ? s.search_keys.map((k) => String(k).trim()).filter(Boolean) : [];
  if (!sessionId && keys.length < 3) throw new CheckpointError('session.search_keys needs at least 3 verbatim keys for a new session');
  if (keys.length > 12) throw new CheckpointError('session.search_keys: keep it under 12');
  const surface = s.surface ? String(s.surface).toLowerCase() : 'chat';
  if (!SURFACES.has(surface)) throw new CheckpointError(`session.surface must be one of ${[...SURFACES].join(', ')}`);

  const session = {
    title: str(s.title, 'session.title', { required: !sessionId, max: 300 }),
    date: isoDate(s.date, 'session.date', today),
    phase_focus: str(s.phase_focus, 'session.phase_focus', { max: 120 }),
    summary: str(s.summary, 'session.summary', { required: !sessionId }),
    search_keys: keys, surface,
    chat_url: str(s.chat_url, 'session.chat_url', { max: 500 }),
    chat_title: str(s.chat_title, 'session.chat_title', { max: 300 }),
    workflows_touched: Array.isArray(s.workflows_touched) ? s.workflows_touched : [],
    mcp_verified_ids: Array.isArray(s.mcp_verified_ids) ? s.mcp_verified_ids : [],
  };

  const decisions = (input.decisions || []).map((d, i) => ({
    category: str(d.category, `decisions[${i}].category`, { required: true, max: 40 }),
    decision: str(d.decision, `decisions[${i}].decision`, { required: true }),
    rationale: str(d.rationale, `decisions[${i}].rationale`),
    options: Array.isArray(d.options) ? d.options.map(String) : [],
    workflow_code: str(d.workflow_code, `decisions[${i}].workflow_code`, { max: 20 }),
    supersedes_id: d.supersedes_id == null ? null : Number(d.supersedes_id),
  }));
  const issues = (input.issues || []).map((x, i) => {
    const severity = String(x.severity || '').toLowerCase();
    if (!SEVERITIES.has(severity)) throw new CheckpointError(`issues[${i}].severity must be critical|high|medium|low`);
    const issue_type = x.issue_type ? String(x.issue_type).toLowerCase() : 'defect';
    if (!ISSUE_TYPES.has(issue_type)) throw new CheckpointError(`issues[${i}].issue_type must be defect|initiative|metric`);
    return {
      severity, issue_type,
      category: str(x.category, `issues[${i}].category`, { required: true, max: 40 }),
      description: str(x.description, `issues[${i}].description`, { required: true }),
      impact: str(x.impact, `issues[${i}].impact`),
      fix_instructions: str(x.fix_instructions, `issues[${i}].fix_instructions`),
      workflow_code: str(x.workflow_code, `issues[${i}].workflow_code`, { max: 20 }),
      workflow_name: str(x.workflow_name, `issues[${i}].workflow_name`, { max: 200 }),
    };
  });
  const resolved_issues = (input.resolved_issues || []).map((r, i) => ({
    id: Number(r.id), note: str(r.verification_note, `resolved_issues[${i}].verification_note`, { required: true, max: 500 }),
  }));
  const verified_issues = (input.verified_issues || []).map((r, i) => ({
    id: Number(r.id), note: str(r.verification_note, `verified_issues[${i}].verification_note`, { required: true, max: 500 }),
  }));
  const pending = (input.pending || []).map((p, i) => {
    const kind = String(p.kind || 'pending').toLowerCase();
    if (!PENDING_KINDS.has(kind)) throw new CheckpointError(`pending[${i}].kind must be pending|next_step`);
    const item_type = String(p.item_type || (kind === 'next_step' ? 'next_step' : 'action_needed')).toLowerCase();
    if (!PENDING_TYPES.has(item_type)) throw new CheckpointError(`pending[${i}].item_type invalid`);
    return {
      kind, item_type,
      description: str(p.description, `pending[${i}].description`, { required: true }),
      priority: p.priority == null ? null : Number(p.priority),
      effort: str(p.effort, `pending[${i}].effort`, { max: 100 }),
      blocked_by: str(p.blocked_by, `pending[${i}].blocked_by`, { max: 300 }),
      ref: str(p.ref, `pending[${i}].ref`, { max: 200 }),
      owner: str(p.owner, `pending[${i}].owner`, { max: 100 }),
    };
  });
  const close_pending = (input.close_pending || []).map((c, i) => {
    const status = String(c.status || 'done').toLowerCase();
    if (!CLOSE_STATUSES.has(status)) throw new CheckpointError(`close_pending[${i}].status invalid`);
    return { id: Number(c.id), status };
  });
  for (const list of [resolved_issues, verified_issues, close_pending]) {
    for (const r of list) if (!Number.isInteger(r.id) || r.id < 1) throw new CheckpointError('ids must be positive integers');
  }
  return { session_id: sessionId, session, decisions, issues, resolved_issues, verified_issues, pending, close_pending, today };
}

function must(res, what) {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

/** Write the checkpoint. Returns ids. `db` defaults to the LP Supabase client. */
export async function applyCheckpoint(input, { db = supabase, now = new Date() } = {}) {
  if (!db) throw new Error('Supabase client not configured');
  const c = validateCheckpoint(input, now);
  const nowIso = now.toISOString();
  const out = { session_id: null, updated: false, decision_ids: [], issue_ids: [], pending_ids: [], resolved: [], verified: [], closed: [], superseded: [], ledger: null };

  // 1. Session row — UPDATE the named one, else INSERT.
  let keys = c.session.search_keys;
  if (c.session_id) {
    const cur = must(await db.from('claude_session_logs').select('id, transcript_search_keys, link_confidence, chat_url').eq('id', c.session_id).maybeSingle(), 'load session');
    if (!cur) throw new CheckpointError(`session ${c.session_id} not found`);
    keys = [...new Set([...(Array.isArray(cur.transcript_search_keys) ? cur.transcript_search_keys : []), ...keys])].slice(0, 12);
    const patch = { transcript_search_keys: keys, updated_at: nowIso };
    if (c.session.summary) patch.raw_summary = c.session.summary;
    if (c.session.title) patch.session_title = c.session.title;
    if (c.session.phase_focus) patch.phase_focus = c.session.phase_focus;
    if (c.session.chat_url && cur.link_confidence !== 'exact') {
      patch.chat_url = c.session.chat_url; patch.chat_title = c.session.chat_title; patch.link_confidence = 'exact';
    }
    must(await db.from('claude_session_logs').update(patch).eq('id', c.session_id), 'update session');
    out.session_id = c.session_id; out.updated = true;
  } else {
    const row = {
      session_date: c.session.date, session_title: c.session.title, phase_focus: c.session.phase_focus,
      workflows_touched: c.session.workflows_touched, phase_status: {}, decisions_made: [], issues_found: [],
      issues_resolved: [], pending_items: [], board_versions: [], mcp_verified_ids: c.session.mcp_verified_ids,
      next_steps: [], raw_summary: c.session.summary, chat_url: c.session.chat_url, chat_title: c.session.chat_title,
      transcript_search_keys: keys, surface: c.session.surface, log_origin: 'live',
      link_confidence: c.session.chat_url ? 'exact' : 'unlinked',
    };
    const ins = must(await db.from('claude_session_logs').insert(row).select('id').single(), 'insert session');
    out.session_id = ins.id;
  }
  const sid = out.session_id;

  // 2. Decisions (+ supersede).
  for (const d of c.decisions) {
    const ins = must(await db.from('claude_decision_log').insert({
      session_id: sid, decision_date: c.session.date, category: d.category, decision: d.decision,
      options_considered: d.options, rationale: d.rationale, workflow_code: d.workflow_code,
      reversible: true, transcript_search_keys: keys,
    }).select('id').single(), 'insert decision');
    out.decision_ids.push(ins.id);
    if (d.supersedes_id) {
      must(await db.from('claude_decision_log').update({ status: 'superseded', superseded_by: ins.id }).eq('id', d.supersedes_id), 'supersede decision');
      out.superseded.push(d.supersedes_id);
    }
  }

  // 3. Issues.
  for (const x of c.issues) {
    const ins = must(await db.from('claude_known_issues').insert({
      reported_date: c.session.date, reported_session_id: sid, severity: x.severity, category: x.category,
      description: x.description, impact: x.impact, fix_instructions: x.fix_instructions,
      workflow_code: x.workflow_code, workflow_name: x.workflow_name, issue_type: x.issue_type, status: 'open',
    }).select('id').single(), 'insert issue');
    out.issue_ids.push(ins.id);
  }
  for (const r of c.resolved_issues) {
    must(await db.from('claude_known_issues').update({
      status: 'resolved', resolved_date: c.session.date, resolved_session_id: sid,
      verified_at: nowIso, verification_note: r.note, stale: false, updated_at: nowIso,
    }).eq('id', r.id), 'resolve issue');
    out.resolved.push(r.id);
  }
  for (const r of c.verified_issues) {
    must(await db.from('claude_known_issues').update({ verified_at: nowIso, verification_note: r.note, stale: false, updated_at: nowIso }).eq('id', r.id), 'verify issue');
    out.verified.push(r.id);
  }

  // 4. Pending items (source_index continues from the session's highest 'live' index).
  if (c.pending.length) {
    const last = must(await db.from('claude_pending_items').select('source_index').eq('source_session_id', sid).eq('source_field', 'live').order('source_index', { ascending: false }).limit(1), 'pending index');
    let idx = (last && last[0] && Number.isInteger(last[0].source_index)) ? last[0].source_index + 1 : 0;
    for (const p of c.pending) {
      const ins = must(await db.from('claude_pending_items').insert({
        source_session_id: sid, source_field: 'live', source_index: idx++, kind: p.kind, item_type: p.item_type,
        description: p.description, status: 'open', priority: p.priority, effort: p.effort, blocked_by: p.blocked_by,
        ref: p.ref, owner: p.owner, origin: 'live', session_date: c.session.date, created_at: nowIso,
      }).select('id').single(), 'insert pending');
      out.pending_ids.push(ins.id);
    }
  }
  for (const cl of c.close_pending) {
    must(await db.from('claude_pending_items').update({ status: cl.status, resolved_session_id: sid, updated_at: nowIso }).eq('id', cl.id), 'close pending');
    out.closed.push(cl.id);
  }

  // 5. Ledger row when a URL is on file.
  if (c.session.chat_url) {
    must(await db.from('claude_transcript_ledger').upsert({
      chat_url: c.session.chat_url, chat_title: c.session.chat_title, chat_updated_at: nowIso,
      session_id: sid, disposition: 'linked', reviewed_at: nowIso,
      notes: `memory_checkpoint ${c.today}${out.updated ? ' (refresh)' : ''}`,
    }, { onConflict: 'chat_url' }), 'ledger upsert');
    out.ledger = 'linked';
  }
  return out;
}

/** What applyCheckpoint would do, without touching the database. */
export function planCheckpoint(input, now = new Date()) {
  const c = validateCheckpoint(input, now);
  return {
    dry_run: true,
    session: c.session_id ? `UPDATE claude_session_logs #${c.session_id}` : `INSERT claude_session_logs (${c.session.surface}, ${c.session.date})`,
    search_keys: c.session.search_keys,
    decisions: c.decisions.length, superseding: c.decisions.filter((d) => d.supersedes_id).length,
    issues: c.issues.length, resolved_issues: c.resolved_issues.length, verified_issues: c.verified_issues.length,
    pending: c.pending.length, close_pending: c.close_pending.length,
    ledger: c.session.chat_url ? 'linked (exact)' : 'none (unlinked)',
    hint: 'add "confirm": true to write',
  };
}
