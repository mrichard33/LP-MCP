/**
 * Memory schema presence check — src/memory/memory-migrations.js
 *
 * The "mirror in runMigrations()" promised for priority #8 (decision #1673),
 * done as a guarded self-heal: at boot, check that the objects sql/090–115
 * create are present; log one WARN line per missing object. Apply the files
 * ONLY when MEMORY_MIGRATIONS_AUTOAPPLY=true — production already has all of
 * them, and the .sql files stay the single definition (never copied into
 * index.js). Files are applied whole through runSQL(), in order, and every
 * statement in them is idempotent (IF NOT EXISTS / CREATE OR REPLACE).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSQL } from '../admin/supabase-admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(__dirname, '..', '..', 'sql');

export const MEMORY_MIGRATIONS = [
  { file: '090_claude_memory_context.sql',          check: "SELECT 1 FROM pg_proc WHERE proname = 'claude_memory_context'" },
  { file: '091_memory_lifecycle_pending_items.sql', check: "SELECT 1 FROM information_schema.tables WHERE table_name = 'claude_pending_items'" },
  { file: '092_memory_taxonomy_area_workflow_ref.sql', check: "SELECT 1 FROM pg_proc WHERE proname = 'claude_area_for'" },
  { file: '093_memory_area_trigger.sql',            check: "SELECT 1 FROM pg_proc WHERE proname = 'claude_set_area'" },
  { file: '094_claude_memory_embeddings.sql',       check: "SELECT 1 FROM pg_proc WHERE proname = 'match_memory_embeddings'" },
  { file: '096_pending_autoclose.sql',              check: "SELECT 1 FROM information_schema.tables WHERE table_name = 'claude_memory_autoclose_log'" },
  { file: '097_pack_date_confidence.sql',           check: "SELECT 1 FROM pg_proc WHERE proname = 'claude_memory_context' AND prosrc LIKE '%date_confidence%'" },
  { file: '098_memory_integrity.sql',               check: "SELECT 1 FROM pg_trigger t JOIN information_schema.tables x ON x.table_name = 'claude_memory_conflicts' WHERE t.tgname = 'trg_claude_guard_session_insert'" },
  { file: '099_checkpoint_key_deterministic.sql',   check: "SELECT 1 FROM pg_proc WHERE proname = 'claude_checkpoint_key'" },
  { file: '100_provenance_inherit_narrow.sql',      check: "SELECT 1 FROM pg_proc WHERE proname = 'claude_inherit_provenance' AND prosrc LIKE '%in_parent_window%'" },
  // sql/101 needs BOTH halves: the writer function and the widened surface
  // CHECK. With the function present but the constraint still on the old list,
  // every Omi ingest would fail inside the transaction with a check_violation.
  { file: '101_omi_memory_source.sql',              check: "SELECT 1 FROM pg_proc WHERE proname = 'claude_omi_ingest'" },
  { file: '101_omi_memory_source.sql',              check: "SELECT 1 FROM pg_constraint WHERE conname = 'claude_session_logs_surface_check' AND pg_get_constraintdef(oid) LIKE '%omi%'" },
  // sql/102 needs the same two-part check for the same reason: with the writer
  // present but the surface CHECK still on the old list, the first ruling of the
  // day would fail inside the transaction trying to insert its dashboard session.
  { file: '102_command_center.sql',                 check: "SELECT 1 FROM pg_proc WHERE proname = 'claude_rule_apply'" },
  { file: '102_command_center.sql',                 check: "SELECT 1 FROM pg_constraint WHERE conname = 'claude_session_logs_surface_check' AND pg_get_constraintdef(oid) LIKE '%dashboard%'" },
  { file: '112_command_center_r2.sql',              check: "SELECT 1 FROM pg_proc WHERE proname = 'claude_rule_batch'" },
  // Section D is the one that can be half-applied: the functions go in without
  // complaint while the VIEW is still v1, and the lanes then read as empty
  // rather than as broken. Probe the view's own columns, not just a function.
  { file: '112_command_center_r2.sql',              check: "SELECT 1 FROM information_schema.columns WHERE table_name = 'v_command_center_queue' AND column_name = 'omi_action_item_id'" },
  // A plain ADD COLUMN, so one probe is enough — there is no second half to be
  // half-applied here, unlike 101/102/112 above.
  { file: '115_session_project.sql',                check: "SELECT 1 FROM information_schema.columns WHERE table_name = 'claude_session_logs' AND column_name = 'project'" },
];

export async function checkMemorySchema({ sql = runSQL, autoApply = String(process.env.MEMORY_MIGRATIONS_AUTOAPPLY || 'false') === 'true' } = {}) {
  const missing = [];
  for (const m of MEMORY_MIGRATIONS) {
    try {
      const rows = await sql(m.check);
      if (!Array.isArray(rows) || rows.length === 0) missing.push(m);
    } catch (err) {
      console.warn(`[MemorySchema] check failed for ${m.file}: ${err.message}`);
      missing.push(m);
    }
  }
  if (!missing.length) { console.log('[MemorySchema] sql/090–115 present'); return { ok: true, missing: [], applied: [] }; }
  // A file can appear more than once above (sql/101 is checked in two parts);
  // report and apply it once.
  const missingFiles = [...new Set(missing.map((m) => m.file))];
  for (const f of missingFiles) console.warn(`[MemorySchema] MISSING: ${f} — ${autoApply ? 'applying' : 'set MEMORY_MIGRATIONS_AUTOAPPLY=true to apply at boot, or run the file by hand'}`);
  const applied = [];
  if (autoApply) {
    for (const f of missingFiles) {
      const text = fs.readFileSync(path.join(SQL_DIR, f), 'utf8');
      await sql(text);
      applied.push(f);
      console.log(`[MemorySchema] applied ${f}`);
    }
  }
  return { ok: applied.length === missingFiles.length, missing: missingFiles, applied };
}
