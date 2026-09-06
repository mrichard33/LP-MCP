/**
 * Memory schema presence check — src/memory/memory-migrations.js
 *
 * The "mirror in runMigrations()" promised for priority #8 (decision #1673),
 * done as a guarded self-heal: at boot, check that the objects sql/090–094
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
  if (!missing.length) { console.log('[MemorySchema] sql/090–094 present'); return { ok: true, missing: [], applied: [] }; }
  for (const m of missing) console.warn(`[MemorySchema] MISSING: ${m.file} — ${autoApply ? 'applying' : 'set MEMORY_MIGRATIONS_AUTOAPPLY=true to apply at boot, or run the file by hand'}`);
  const applied = [];
  if (autoApply) {
    for (const m of missing) {
      const text = fs.readFileSync(path.join(SQL_DIR, m.file), 'utf8');
      await sql(text);
      applied.push(m.file);
      console.log(`[MemorySchema] applied ${m.file}`);
    }
  }
  return { ok: applied.length === missing.length, missing: missing.map((m) => m.file), applied };
}
