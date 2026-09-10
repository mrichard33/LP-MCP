/**
 * Memory validation — src/jobs/memory-validate.js  (sql/098, 2026-09-08)
 *
 * Nightly integrity checks over the claude_* memory tier. Each check is ONE
 * SELECT returning { rows_checked, rows_flagged, sample } and writes one row to
 * claude_memory_validation_log. Repairs run only when dry_run is false, and
 * they only MARK or SYNC — nothing is deleted:
 *
 *   embedding_metadata_sync   claude_memory_embeddings.status / origin / area /
 *                             date_confidence copied from the source row when
 *                             they drifted (a status flip, a supersession, a
 *                             merged duplicate) so the vector filter is always
 *                             current — no OpenAI call needed.
 *   orphan_embeddings         embedding rows whose source row is gone get
 *                             stale_embedding = true (hidden, kept).
 *
 * Missing embeddings are not repaired here: the nightly re-embed step
 * (memory-embed.js planKind) already embeds every row without one.
 *
 * Draft checkpoints (runDraftCheckpoints): LP-MCP cannot see Claude chats, so
 * the source of "chats with no checkpoint" is the transcript ledger — the
 * chat-surface reconciliation pass writes disposition='deferred' rows (url,
 * title, updated_at) for chats it found but did not checkpoint. Each such row
 * with no session_id gets a draft session (log_origin='nightly', summary +
 * search keys only, never decisions or issues) and the ledger row is pointed
 * at it. Mark confirms by refreshing the session (which promotes it to
 * 'live') or drops it.
 *
 * SQL shape follows memory-autoclose.js: SELECT candidates first (the run_sql
 * RPC returns only {status:'ok'} for a non-SELECT), then UPDATE.
 */
import supabase from '../supabase.js';
import { checkpointKeyFor } from '../memory/memory-checkpoint.js';

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const SAMPLE = 10;

// ─── Checks: one SELECT each → { rows_checked, rows_flagged, sample } ──────
export const VALIDATION_CHECKS = Object.freeze([
  {
    name: 'unlinked_sessions_7d',
    description: 'chat-surface sessions with no chat_url, older than 7 days',
    sql: `
SELECT
  (SELECT count(*) FROM claude_session_logs WHERE chat_url IS NULL AND coalesce(surface,'chat')='chat')::int AS rows_checked,
  (SELECT count(*) FROM claude_session_logs WHERE chat_url IS NULL AND coalesce(surface,'chat')='chat' AND created_at < now() - interval '7 days')::int AS rows_flagged,
  (SELECT jsonb_agg(x) FROM (SELECT id, session_date, log_origin, left(session_title, 80) AS title
     FROM claude_session_logs WHERE chat_url IS NULL AND coalesce(surface,'chat')='chat' AND created_at < now() - interval '7 days'
     ORDER BY created_at DESC LIMIT ${SAMPLE}) x) AS sample`,
  },
  {
    name: 'write_date_rows',
    description: "sessions (and their children) whose date is only the write date",
    sql: `
SELECT
  (SELECT count(*) FROM claude_session_logs)::int AS rows_checked,
  (SELECT count(*) FROM claude_session_logs WHERE date_confidence = 'write_date')::int AS rows_flagged,
  jsonb_build_object(
    'sessions', (SELECT jsonb_agg(id ORDER BY id) FROM (SELECT id FROM claude_session_logs WHERE date_confidence = 'write_date' ORDER BY id LIMIT ${SAMPLE}) s),
    'decisions', (SELECT count(*) FROM claude_decision_log WHERE date_confidence = 'write_date'),
    'issues', (SELECT count(*) FROM claude_known_issues WHERE date_confidence = 'write_date')) AS sample`,
  },
  {
    name: 'batch_pattern_live',
    description: "'live' sessions written in a burst (4th+ row inside a 5-minute window), last 30 days",
    sql: `
SELECT
  (SELECT count(*) FROM claude_session_logs WHERE log_origin = 'live' AND created_at > now() - interval '30 days')::int AS rows_checked,
  (SELECT count(*) FROM (
     SELECT id, count(*) OVER (ORDER BY created_at RANGE BETWEEN interval '5 minutes' PRECEDING AND CURRENT ROW) AS n
     FROM claude_session_logs WHERE log_origin = 'live' AND created_at > now() - interval '30 days') w
   WHERE n >= 4)::int AS rows_flagged,
  (SELECT jsonb_agg(x) FROM (
     SELECT id, created_at::text AS created_at, n FROM (
       SELECT id, created_at, count(*) OVER (ORDER BY created_at RANGE BETWEEN interval '5 minutes' PRECEDING AND CURRENT ROW) AS n
       FROM claude_session_logs WHERE log_origin = 'live' AND created_at > now() - interval '30 days') w
     WHERE n >= 4 ORDER BY created_at DESC LIMIT ${SAMPLE}) x) AS sample`,
  },
  {
    name: 'duplicate_sessions_24h',
    description: 'sessions written twice for the same surface / date / title in the last 24 hours (sql/099 regression watch)',
    sql: `
SELECT
  (SELECT count(*) FROM claude_session_logs WHERE created_at > now() - interval '24 hours')::int AS rows_checked,
  (SELECT coalesce(sum(n - 1), 0) FROM (
     SELECT count(*) AS n FROM claude_session_logs WHERE created_at > now() - interval '24 hours'
     GROUP BY coalesce(surface, 'chat'), session_date,
              lower(btrim(regexp_replace(coalesce(session_title, ''), '\\s+', ' ', 'g')))
     HAVING count(*) > 1) t)::int AS rows_flagged,
  (SELECT jsonb_agg(x) FROM (
     SELECT session_date, left(min(session_title), 80) AS title, count(*) AS n, array_agg(id ORDER BY id) AS ids
     FROM claude_session_logs WHERE created_at > now() - interval '24 hours'
     GROUP BY coalesce(surface, 'chat'), session_date,
              lower(btrim(regexp_replace(coalesce(session_title, ''), '\\s+', ' ', 'g')))
     HAVING count(*) > 1
     ORDER BY count(*) DESC, session_date DESC LIMIT ${SAMPLE}) x) AS sample`,
  },
  {
    name: 'active_decisions_no_area',
    description: 'active decisions with area NULL (the sql/093 trigger should have filled it)',
    sql: `
SELECT
  (SELECT count(*) FROM claude_decision_log WHERE status = 'active')::int AS rows_checked,
  (SELECT count(*) FROM claude_decision_log WHERE status = 'active' AND area IS NULL)::int AS rows_flagged,
  (SELECT jsonb_agg(id ORDER BY id) FROM (SELECT id FROM claude_decision_log WHERE status = 'active' AND area IS NULL ORDER BY id LIMIT ${SAMPLE}) x) AS sample`,
  },
  {
    name: 'embedding_coverage',
    description: 'source rows (non-duplicate) with no embedding row',
    sql: `
SELECT
  ((SELECT count(*) FROM claude_decision_log WHERE coalesce(status,'') <> 'duplicate')
   + (SELECT count(*) FROM claude_known_issues WHERE coalesce(status,'') <> 'duplicate')
   + (SELECT count(*) FROM claude_session_logs)
   + (SELECT count(*) FROM claude_pending_items))::int AS rows_checked,
  ((SELECT count(*) FROM claude_decision_log d WHERE coalesce(d.status,'') <> 'duplicate' AND NOT EXISTS (SELECT 1 FROM claude_memory_embeddings e WHERE e.source_table='claude_decision_log' AND e.source_id=d.id))
   + (SELECT count(*) FROM claude_known_issues i WHERE coalesce(i.status,'') <> 'duplicate' AND NOT EXISTS (SELECT 1 FROM claude_memory_embeddings e WHERE e.source_table='claude_known_issues' AND e.source_id=i.id))
   + (SELECT count(*) FROM claude_session_logs s WHERE NOT EXISTS (SELECT 1 FROM claude_memory_embeddings e WHERE e.source_table='claude_session_logs' AND e.source_id=s.id))
   + (SELECT count(*) FROM claude_pending_items p WHERE NOT EXISTS (SELECT 1 FROM claude_memory_embeddings e WHERE e.source_table='claude_pending_items' AND e.source_id=p.id)))::int AS rows_flagged,
  jsonb_build_object(
    'decisions', (SELECT count(*) FROM claude_decision_log d WHERE coalesce(d.status,'') <> 'duplicate' AND NOT EXISTS (SELECT 1 FROM claude_memory_embeddings e WHERE e.source_table='claude_decision_log' AND e.source_id=d.id)),
    'issues',    (SELECT count(*) FROM claude_known_issues i WHERE coalesce(i.status,'') <> 'duplicate' AND NOT EXISTS (SELECT 1 FROM claude_memory_embeddings e WHERE e.source_table='claude_known_issues' AND e.source_id=i.id)),
    'sessions',  (SELECT count(*) FROM claude_session_logs s WHERE NOT EXISTS (SELECT 1 FROM claude_memory_embeddings e WHERE e.source_table='claude_session_logs' AND e.source_id=s.id)),
    'pending',   (SELECT count(*) FROM claude_pending_items p WHERE NOT EXISTS (SELECT 1 FROM claude_memory_embeddings e WHERE e.source_table='claude_pending_items' AND e.source_id=p.id)),
    'embeddings', (SELECT count(*) FROM claude_memory_embeddings WHERE NOT stale_embedding)) AS sample`,
  },
  {
    name: 'orphan_embeddings',
    description: 'embedding rows whose source row no longer exists (not yet marked stale)',
    sql: `
SELECT
  (SELECT count(*) FROM claude_memory_embeddings)::int AS rows_checked,
  (SELECT count(*) FROM claude_memory_embeddings e WHERE NOT e.stale_embedding AND NOT (
      (e.source_table='claude_decision_log'  AND EXISTS (SELECT 1 FROM claude_decision_log  d WHERE d.id=e.source_id)) OR
      (e.source_table='claude_known_issues'  AND EXISTS (SELECT 1 FROM claude_known_issues  i WHERE i.id=e.source_id)) OR
      (e.source_table='claude_session_logs'  AND EXISTS (SELECT 1 FROM claude_session_logs  s WHERE s.id=e.source_id)) OR
      (e.source_table='claude_pending_items' AND EXISTS (SELECT 1 FROM claude_pending_items p WHERE p.id=e.source_id))))::int AS rows_flagged,
  (SELECT jsonb_agg(x) FROM (SELECT e.id, e.source_table, e.source_id FROM claude_memory_embeddings e WHERE NOT e.stale_embedding AND NOT (
      (e.source_table='claude_decision_log'  AND EXISTS (SELECT 1 FROM claude_decision_log  d WHERE d.id=e.source_id)) OR
      (e.source_table='claude_known_issues'  AND EXISTS (SELECT 1 FROM claude_known_issues  i WHERE i.id=e.source_id)) OR
      (e.source_table='claude_session_logs'  AND EXISTS (SELECT 1 FROM claude_session_logs  s WHERE s.id=e.source_id)) OR
      (e.source_table='claude_pending_items' AND EXISTS (SELECT 1 FROM claude_pending_items p WHERE p.id=e.source_id)))
     ORDER BY e.id LIMIT ${SAMPLE}) x) AS sample`,
  },
  {
    name: 'embedding_metadata_drift',
    description: 'embedding rows whose status / origin / area / date_confidence differ from the source row',
    sql: `
SELECT
  (SELECT count(*) FROM claude_memory_embeddings WHERE NOT stale_embedding)::int AS rows_checked,
  ((SELECT count(*) FROM claude_memory_embeddings e JOIN claude_decision_log d ON d.id=e.source_id AND e.source_table='claude_decision_log'
      WHERE e.status IS DISTINCT FROM d.status OR e.origin IS DISTINCT FROM d.origin OR e.area IS DISTINCT FROM d.area OR e.date_confidence IS DISTINCT FROM d.date_confidence)
   + (SELECT count(*) FROM claude_memory_embeddings e JOIN claude_known_issues i ON i.id=e.source_id AND e.source_table='claude_known_issues'
      WHERE e.status IS DISTINCT FROM i.status OR e.origin IS DISTINCT FROM i.origin OR e.area IS DISTINCT FROM i.area OR e.date_confidence IS DISTINCT FROM i.date_confidence)
   + (SELECT count(*) FROM claude_memory_embeddings e JOIN claude_session_logs s ON s.id=e.source_id AND e.source_table='claude_session_logs'
      WHERE e.origin IS DISTINCT FROM s.log_origin OR e.area IS DISTINCT FROM s.area OR e.date_confidence IS DISTINCT FROM s.date_confidence)
   + (SELECT count(*) FROM claude_memory_embeddings e JOIN claude_pending_items p ON p.id=e.source_id AND e.source_table='claude_pending_items'
      WHERE e.status IS DISTINCT FROM p.status OR e.origin IS DISTINCT FROM p.origin OR e.area IS DISTINCT FROM p.area))::int AS rows_flagged,
  (SELECT jsonb_agg(x) FROM (
     SELECT e.source_table, e.source_id, e.status AS emb_status, d.status AS src_status, e.date_confidence AS emb_dc, d.date_confidence AS src_dc
     FROM claude_memory_embeddings e JOIN claude_decision_log d ON d.id=e.source_id AND e.source_table='claude_decision_log'
     WHERE e.status IS DISTINCT FROM d.status OR e.origin IS DISTINCT FROM d.origin OR e.area IS DISTINCT FROM d.area OR e.date_confidence IS DISTINCT FROM d.date_confidence
     ORDER BY e.source_id DESC LIMIT ${SAMPLE}) x) AS sample`,
  },
  {
    name: 'conflicts_open',
    description: 'claude_memory_conflicts rows awaiting a ruling',
    sql: `
SELECT
  (SELECT count(*) FROM claude_memory_conflicts)::int AS rows_checked,
  (SELECT count(*) FROM claude_memory_conflicts WHERE status = 'open')::int AS rows_flagged,
  (SELECT jsonb_agg(x) FROM (SELECT id, kind, row_a, row_b, round(similarity::numeric, 3) AS similarity FROM claude_memory_conflicts WHERE status = 'open' ORDER BY similarity DESC, id LIMIT ${SAMPLE}) x) AS sample`,
  },
  {
    name: 'provenance_mismatch_children',
    description: "decisions / issues stamped origin='live' whose parent session is retro (cleanup batch C1)",
    sql: `
SELECT
  ((SELECT count(*) FROM claude_decision_log d JOIN claude_session_logs s ON s.id = d.session_id)
   + (SELECT count(*) FROM claude_known_issues i JOIN claude_session_logs s ON s.id = i.reported_session_id))::int AS rows_checked,
  ((SELECT count(*) FROM claude_decision_log d JOIN claude_session_logs s ON s.id = d.session_id WHERE s.log_origin = 'retro' AND d.origin = 'live')
   + (SELECT count(*) FROM claude_known_issues i JOIN claude_session_logs s ON s.id = i.reported_session_id WHERE s.log_origin = 'retro' AND i.origin = 'live'))::int AS rows_flagged,
  jsonb_build_object(
    'decisions', (SELECT jsonb_agg(id ORDER BY id) FROM (SELECT d.id FROM claude_decision_log d JOIN claude_session_logs s ON s.id = d.session_id WHERE s.log_origin = 'retro' AND d.origin = 'live' ORDER BY d.id LIMIT ${SAMPLE}) x),
    'issues', (SELECT jsonb_agg(id ORDER BY id) FROM (SELECT i.id FROM claude_known_issues i JOIN claude_session_logs s ON s.id = i.reported_session_id WHERE s.log_origin = 'retro' AND i.origin = 'live' ORDER BY i.id LIMIT ${SAMPLE}) x)) AS sample`,
  },
  {
    name: 'flagged_sessions',
    description: "sessions the guard relabelled (validation_status = 'flagged') plus unconfirmed nightly drafts",
    sql: `
SELECT
  (SELECT count(*) FROM claude_session_logs)::int AS rows_checked,
  (SELECT count(*) FROM claude_session_logs WHERE validation_status = 'flagged' OR log_origin = 'nightly')::int AS rows_flagged,
  jsonb_build_object(
    'flagged', (SELECT jsonb_agg(id ORDER BY id DESC) FROM (SELECT id FROM claude_session_logs WHERE validation_status = 'flagged' ORDER BY id DESC LIMIT ${SAMPLE}) x),
    'nightly_drafts', (SELECT count(*) FROM claude_session_logs WHERE log_origin = 'nightly')) AS sample`,
  },
]);

// ─── Repairs (live only; mark / sync, never delete) ────────────────────────
export const REPAIR_METADATA_SYNC_SQL = Object.freeze([
  `UPDATE claude_memory_embeddings e SET status = d.status, origin = d.origin, area = d.area, date_confidence = d.date_confidence
FROM claude_decision_log d WHERE e.source_table = 'claude_decision_log' AND e.source_id = d.id
  AND (e.status IS DISTINCT FROM d.status OR e.origin IS DISTINCT FROM d.origin OR e.area IS DISTINCT FROM d.area OR e.date_confidence IS DISTINCT FROM d.date_confidence)`,
  `UPDATE claude_memory_embeddings e SET status = i.status, origin = i.origin, area = i.area, date_confidence = i.date_confidence
FROM claude_known_issues i WHERE e.source_table = 'claude_known_issues' AND e.source_id = i.id
  AND (e.status IS DISTINCT FROM i.status OR e.origin IS DISTINCT FROM i.origin OR e.area IS DISTINCT FROM i.area OR e.date_confidence IS DISTINCT FROM i.date_confidence)`,
  `UPDATE claude_memory_embeddings e SET origin = s.log_origin, area = s.area, date_confidence = s.date_confidence
FROM claude_session_logs s WHERE e.source_table = 'claude_session_logs' AND e.source_id = s.id
  AND (e.origin IS DISTINCT FROM s.log_origin OR e.area IS DISTINCT FROM s.area OR e.date_confidence IS DISTINCT FROM s.date_confidence)`,
  `UPDATE claude_memory_embeddings e SET status = p.status, origin = p.origin, area = p.area
FROM claude_pending_items p WHERE e.source_table = 'claude_pending_items' AND e.source_id = p.id
  AND (e.status IS DISTINCT FROM p.status OR e.origin IS DISTINCT FROM p.origin OR e.area IS DISTINCT FROM p.area)`,
]);

export const REPAIR_ORPHANS_SQL = `
UPDATE claude_memory_embeddings e SET stale_embedding = true
WHERE NOT e.stale_embedding AND NOT (
  (e.source_table='claude_decision_log'  AND EXISTS (SELECT 1 FROM claude_decision_log  d WHERE d.id=e.source_id)) OR
  (e.source_table='claude_known_issues'  AND EXISTS (SELECT 1 FROM claude_known_issues  i WHERE i.id=e.source_id)) OR
  (e.source_table='claude_session_logs'  AND EXISTS (SELECT 1 FROM claude_session_logs  s WHERE s.id=e.source_id)) OR
  (e.source_table='claude_pending_items' AND EXISTS (SELECT 1 FROM claude_pending_items p WHERE p.id=e.source_id)))`;

export function validationLogSql({ check_name, mode, rows_checked = null, rows_flagged = null, sample = null, notes = null }) {
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? 'NULL' : String(Math.trunc(Number(v))));
  return `INSERT INTO claude_memory_validation_log (check_name, mode, rows_checked, rows_flagged, sample, notes)
VALUES (${q(check_name)}, ${mode == null ? 'NULL' : q(mode)}, ${num(rows_checked)}, ${num(rows_flagged)}, ${sample == null ? 'NULL' : `${q(JSON.stringify(sample))}::jsonb`}, ${notes == null ? 'NULL' : q(notes)})`;
}

const rowsOf = (r) => (Array.isArray(r) ? r : []);

/**
 * Run every check, log each, then (live only) the two repairs.
 * @param {Object} opts  dry_run (log rows still written; no repairs), mode label, deps.runSQL
 */
export async function runMemoryValidation({ dry_run = false, mode = 'nightly', deps = {} } = {}) {
  const sql = deps.runSQL;
  if (typeof sql !== 'function') throw new Error('runMemoryValidation: deps.runSQL required');
  const doLog = deps.log !== false;   // the nightly dry run passes log:false — SELECTs only
  const result = { dry_run, mode, logged: doLog, checks: {}, repairs: {}, flagged_total: 0, errors: [] };
  for (const c of VALIDATION_CHECKS) {
    try {
      const row = rowsOf(await sql(c.sql))[0] || {};
      const entry = { rows_checked: Number(row.rows_checked) || 0, rows_flagged: Number(row.rows_flagged) || 0, sample: row.sample ?? null };
      result.checks[c.name] = entry;
      result.flagged_total += entry.rows_flagged;
      if (doLog) await sql(validationLogSql({ check_name: c.name, mode: dry_run ? 'dry_run' : mode, rows_checked: entry.rows_checked, rows_flagged: entry.rows_flagged, sample: entry.sample, notes: c.description }));
    } catch (err) {
      result.checks[c.name] = { error: err.message };
      result.errors.push(`${c.name}: ${err.message}`);
    }
  }
  if (dry_run) return result;
  // Repairs: counts come from the checks above (run_sql reports no row counts for UPDATEs).
  const drift = result.checks.embedding_metadata_drift?.rows_flagged || 0;
  const orphans = result.checks.orphan_embeddings?.rows_flagged || 0;
  try {
    if (drift > 0) for (const s of REPAIR_METADATA_SYNC_SQL) await sql(s);
    result.repairs.embedding_metadata_sync = { affected: drift };
    if (drift > 0) await sql(validationLogSql({ check_name: 'repair:embedding_metadata_sync', mode, rows_checked: drift, rows_flagged: drift, notes: 'synced status/origin/area/date_confidence from source rows' }));
  } catch (err) { result.repairs.embedding_metadata_sync = { error: err.message }; result.errors.push(`repair metadata: ${err.message}`); }
  try {
    if (orphans > 0) await sql(REPAIR_ORPHANS_SQL);
    result.repairs.orphan_embeddings = { affected: orphans };
    if (orphans > 0) await sql(validationLogSql({ check_name: 'repair:orphan_embeddings', mode, rows_checked: orphans, rows_flagged: orphans, notes: 'stale_embedding=true (kept, hidden)' }));
  } catch (err) { result.repairs.orphan_embeddings = { error: err.message }; result.errors.push(`repair orphans: ${err.message}`); }
  return result;
}

// ─── Draft checkpoints for chats the ledger knows but nobody checkpointed ──
export const DRAFT_CANDIDATES_SQL = `
SELECT chat_url, chat_title, chat_updated_at::text AS chat_updated_at
FROM claude_transcript_ledger
WHERE disposition = 'deferred' AND session_id IS NULL AND chat_url IS NOT NULL
ORDER BY chat_updated_at DESC NULLS LAST LIMIT 20`;

function dateET(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Pure: the session row a draft becomes. Exported for tests. */
export function draftSessionRow(cand, now = new Date()) {
  const updated = cand.chat_updated_at ? new Date(cand.chat_updated_at) : null;
  const valid = updated && !Number.isNaN(updated.getTime());
  const title = String(cand.chat_title || 'untitled chat').slice(0, 300);
  const today = dateET(now);
  const session_date = valid ? dateET(updated) : today;
  const session_title = `[DRAFT] ${title}`.slice(0, 300);
  return {
    session_date,
    date_confidence: valid ? 'exact' : 'write_date',
    session_title,
    phase_focus: 'nightly draft — confirm or drop',
    raw_summary: `[NIGHTLY DRAFT ${today} — chat "${title}" was found by reconciliation but never checkpointed. Open the chat and refresh this session (memory_checkpoint with session_id) to confirm it, or mark the ledger row no_content to drop it.]`,
    transcript_search_keys: [title].filter(Boolean),
    chat_url: cand.chat_url, chat_title: title,
    source_chat_updated_at: valid ? updated.toISOString() : null,
    surface: 'chat', log_origin: 'nightly', link_confidence: 'exact',
    workflows_touched: [], phase_status: {}, decisions_made: [], issues_found: [], issues_resolved: [],
    pending_items: [], board_versions: [], mcp_verified_ids: [], next_steps: [],
    // Deterministic (sql/099): a second nightly pass over the same ledger row
    // hits the unique key instead of drafting the chat twice.
    checkpoint_key: checkpointKeyFor({ surface: 'chat', date: session_date, title: session_title }),
  };
}

/**
 * Draft a session for every ledger row deferred with no session. Never writes
 * decisions or issues. dry_run lists the candidates only.
 * @param {Object} opts  dry_run, deps.runSQL (candidates), deps.db (supabase client for the insert)
 */
export async function runDraftCheckpoints({ dry_run = false, now = new Date(), deps = {} } = {}) {
  const sql = deps.runSQL;
  const db = deps.db || supabase;
  if (typeof sql !== 'function') throw new Error('runDraftCheckpoints: deps.runSQL required');
  const out = { dry_run, candidates: 0, drafted: [], already_drafted: [], errors: [] };
  const cands = rowsOf(await sql(DRAFT_CANDIDATES_SQL));
  out.candidates = cands.length;
  out.sample = cands.slice(0, 5).map((c) => ({ chat_url: c.chat_url, chat_title: c.chat_title }));
  if (dry_run || !cands.length || !db) return out;
  for (const cand of cands) {
    try {
      const row = draftSessionRow(cand, now);
      let ins = await db.from('claude_session_logs').insert(row).select('id').single();
      let fresh = true;
      if (ins.error && (ins.error.code === '23505' || /duplicate key value|violates unique constraint/i.test(ins.error.message || ''))) {
        // A previous pass already drafted this chat (sql/099 deterministic key).
        ins = await db.from('claude_session_logs').select('id').eq('checkpoint_key', row.checkpoint_key).maybeSingle();
        fresh = false;
      }
      if (ins.error) throw new Error(ins.error.message);
      if (!ins.data?.id) throw new Error('draft session vanished after a duplicate-key insert');
      const upd = await db.from('claude_transcript_ledger').update({ session_id: ins.data.id, notes: `nightly draft ${dateET(now)}` }).eq('chat_url', cand.chat_url);
      if (upd.error) throw new Error(upd.error.message);
      (fresh ? out.drafted : out.already_drafted).push(ins.data.id);
    } catch (err) { out.errors.push(`${cand.chat_url}: ${err.message}`); }
  }
  if (out.drafted.length) {
    try { await sql(validationLogSql({ check_name: 'nightly_drafts_written', mode: 'nightly', rows_checked: cands.length, rows_flagged: out.drafted.length, sample: out.drafted.slice(0, SAMPLE), notes: 'draft sessions (origin nightly) for deferred ledger rows' })); }
    catch (err) { out.errors.push(`log: ${err.message}`); }
  }
  return out;
}
