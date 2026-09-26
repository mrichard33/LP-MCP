// ─── Startup schema check — src/admin/startup-schema.js ─────────────────────
//
// Runs the boot-time schema mirrors (src/admin/startup-mirrors.js) the way a
// careful operator would: LOOK first, touch only what is missing, and say
// FAILED only when a second look still shows something missing.
//
// 2026-09-26 — why this exists. Every boot ran ~47 blocks of
// "ADD COLUMN IF NOT EXISTS" / "CREATE ... IF NOT EXISTS" through run_sql, and
// on many deploys some logged "[Migration] ... FAILED" with either
//   "canceling statement due to lock timeout"                       or
//   "Could not query the database for the schema cache. Retrying."  (PGRST002)
// (2026-09-19 00:16 UTC: 043, 046, 050, 059, 117, 121; 09-23: 043; 09-25: 121;
// 09-26 20:21 UTC: two containers booting 7s apart, fifteen blocks.) Every
// object those blocks create was checked on the live LP project that day and
// was present. The FAILED lines were false alarms — and loud ones: "apply
// sql/121 from the dashboard NOW", "will 500 on every sale".
//
// Root causes:
//   1. The PostgREST `authenticator` role has lock_timeout = 8s and
//      statement_timeout = 8s. run_sql is SECURITY DEFINER with no proconfig,
//      so it inherits them. ALTER TABLE ... ADD COLUMN IF NOT EXISTS takes an
//      ACCESS EXCLUSIVE lock BEFORE it checks whether the column exists, so a
//      no-op on a busy table (lp_leads, 244k rows + the 15-minute sync) fails
//      when the lock is not free within 8s. Worse, while it waits in the lock
//      queue every later query on that table — reads included — waits behind
//      it. Six blocks touch lp_leads.
//   2. Every DDL statement, even a no-op, fires the pgrst_ddl_watch event
//      trigger, which tells PostgREST to reload its schema cache. Dozens of
//      them back to back is a reload storm; run_sql goes through PostgREST, so
//      calls landing mid-reload get PGRST002 — and so can any live request the
//      app makes in those seconds.
//   3. Overlapping boots (five Railway variables set one at a time = five
//      redeploys) run all of it twice, contending for the same locks.
//
// What this does instead:
//   - ONE catalog read per boot (information_schema.tables / .columns,
//     pg_views, pg_indexes). No table lock, no DDL event.
//   - A block whose declared objects all exist is skipped: "present".
//   - A block with something missing runs its SQL; on a lock timeout or
//     PGRST002 it waits and retries once; then the catalog is read again.
//     Present now → "applied". Still missing → the block's own FAILED line,
//     naming exactly what is missing, and one ops card for the whole boot.
//   - If the catalog read itself fails we claim NOTHING — neither present nor
//     missing (CLAUDE.md's three-way verdict: a read that failed must neither
//     page nor clear). We log "could not verify" and run every block the old
//     way for this boot, with no ops card.
//
// Pure: every I/O goes through `deps`, so scripts/test-startup-schema.js runs
// without Supabase or GroupMe.

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** Errors worth one retry: the lock was busy or PostgREST was mid-reload. */
export const TRANSIENT_ERROR = /lock timeout|statement timeout|canceling statement|schema cache|PGRST002|deadlock detected/i;

export function isTransientError(err) {
  return TRANSIENT_ERROR.test(String(err?.message ?? err ?? ''));
}

const errText = (err) => String(err?.message ?? err ?? 'unknown error');

/** Tables whose columns the catalog read must return (declared column owners). */
export function columnTables(blocks) {
  const names = new Set();
  for (const b of blocks) for (const [t] of b.expects?.columns || []) names.add(t);
  return [...names].sort();
}

/**
 * The one read-only catalog query. Columns are limited to the tables the
 * blocks declare columns on (~3.5k columns in public otherwise); tables,
 * views and indexes are small enough to read whole.
 */
export function buildCatalogSql(tables) {
  for (const t of tables) {
    if (!IDENT.test(t)) throw new Error(`startup schema: invalid table name ${JSON.stringify(t)}`);
  }
  const list = tables.length ? tables.map((t) => `'${t}'`).join(', ') : `''`;
  return `SELECT jsonb_build_object(
    'tables',  COALESCE((SELECT jsonb_agg(table_name::text) FROM information_schema.tables
                          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'), '[]'::jsonb),
    'views',   COALESCE((SELECT jsonb_agg(viewname::text) FROM pg_views
                          WHERE schemaname = 'public'), '[]'::jsonb),
    'indexes', COALESCE((SELECT jsonb_agg(indexname::text) FROM pg_indexes
                          WHERE schemaname = 'public'), '[]'::jsonb),
    'columns', COALESCE((SELECT jsonb_agg(table_name::text || '.' || column_name::text)
                           FROM information_schema.columns
                          WHERE table_schema = 'public' AND table_name IN (${list})), '[]'::jsonb)
  )`;
}

/**
 * Turn the raw run_sql result into sets. Anything that is not the expected
 * shape THROWS, so the caller treats it as a failed read — never as "the
 * database is empty", which would read every object as missing and page.
 * An empty table list is refused for the same reason: a live database always
 * has tables, so zero means we could not see them, not that they are gone.
 */
export function parseCatalog(raw) {
  const r = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;
  const ok = r && typeof r === 'object'
    && ['tables', 'views', 'indexes', 'columns'].every((k) => Array.isArray(r[k]));
  if (!ok) throw new Error('catalog read returned an unexpected shape');
  if (r.tables.length === 0) throw new Error('catalog read returned no tables');
  return {
    tables: new Set(r.tables),
    views: new Set(r.views),
    indexes: new Set(r.indexes),
    columns: new Set(r.columns),
  };
}

/** Everything a block declares that the catalog does not show, as readable names. */
export function missingObjects(expects, catalog) {
  const out = [];
  for (const t of expects?.tables || []) if (!catalog.tables.has(t)) out.push(`table ${t}`);
  for (const v of expects?.views || []) if (!catalog.views.has(v)) out.push(`view ${v}`);
  for (const [t, c] of expects?.columns || []) if (!catalog.columns.has(`${t}.${c}`)) out.push(`${t}.${c}`);
  for (const i of expects?.indexes || []) if (!catalog.indexes.has(i)) out.push(`index ${i}`);
  return out;
}

export function formatMissingAlert(failures) {
  const lines = [
    `🛠️ LP-MCP startup schema: ${failures.length} block${failures.length === 1 ? '' : 's'} still missing objects after apply + retry + re-check`,
  ];
  for (const f of failures) {
    lines.push(`• ${f.name}: ${f.missing.join(', ')}${f.error ? ` (last error: ${f.error})` : ''}`);
  }
  lines.push('Apply the named sql/ file from the Supabase dashboard. Deploy log has the full [Migration] lines.');
  return lines.join('\n');
}

/**
 * Run every mirror block in order. Never throws; returns the tallies.
 *
 * deps:
 *   runSQL(sql, confirmDestructive)  required — src/admin/supabase-admin.js
 *   readCatalog(sql)                 defaults to runSQL(sql)
 *   readSqlFile(relPath)             for blocks with sqlFile
 *   opsAlert(text)                   one card when something is really missing
 *   log                              { log, warn, error }, defaults to console
 *   sleep(ms), retryDelayMs          the pause before the single retry
 */
export async function runStartupSchema(blocks, deps = {}) {
  const log = deps.log || console;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const retryDelayMs = deps.retryDelayMs ?? 3000;
  const readCatalogRaw = deps.readCatalog || ((sql) => deps.runSQL(sql));
  const catalogSql = buildCatalogSql(columnTables(blocks));

  const tally = { verified: false, present: 0, applied: 0, missing: 0, alwaysRun: 0, alwaysRunFailed: 0, unverifiedOk: 0, unverifiedFailed: 0, failures: [] };

  // One retry on a transient error for anything that goes over run_sql.
  async function withRetry(label, fn) {
    try {
      return { value: await fn() };
    } catch (err) {
      if (!isTransientError(err)) return { error: err };
      log.warn(`[Migration] ${label}: ${errText(err)} — retrying once in ${Math.round(retryDelayMs / 1000)}s`);
      await sleep(retryDelayMs);
      try {
        return { value: await fn() };
      } catch (err2) {
        return { error: err2 };
      }
    }
  }

  const readCatalog = async () => {
    const r = await withRetry('startup schema catalog read', async () => parseCatalog(await readCatalogRaw(catalogSql)));
    return r.error ? { error: r.error } : { catalog: r.value };
  };

  async function applyBlock(block) {
    const statements = block.sqlFile
      ? [await deps.readSqlFile(block.sqlFile)]
      : Array.isArray(block.sql) ? block.sql : [block.sql];
    for (const sql of statements) await deps.runSQL(sql, !!block.confirmDestructive);
  }

  const say = (level, msg) => (log[level] || log.log).call(log, msg);

  // Today's behaviour, for always-run blocks and for a boot we could not verify.
  async function runUnchecked(block) {
    const r = await withRetry(block.name, () => applyBlock(block));
    if (!r.error) {
      log.log(block.ready);
      return true;
    }
    say(block.level || 'error', `${block.fail} ${errText(r.error)}`);
    return false;
  }

  let { catalog, error: readError } = await readCatalog();

  if (!catalog) {
    log.warn(`[Migration] startup schema: could not verify (catalog read failed: ${errText(readError)}) — running every block as before, no ops alert this boot`);
    for (const block of blocks) {
      if (await runUnchecked(block)) tally.unverifiedOk += 1;
      else tally.unverifiedFailed += 1;
    }
    log.warn(`[Migration] startup schema: could not verify — ${tally.unverifiedOk} ran ok, ${tally.unverifiedFailed} failed (${blocks.length} blocks, unverified)`);
    return tally;
  }

  tally.verified = true;
  for (const block of blocks) {
    if (!block.expects) {
      tally.alwaysRun += 1;
      if (!(await runUnchecked(block))) tally.alwaysRunFailed += 1;
      continue;
    }

    const before = missingObjects(block.expects, catalog);
    if (before.length === 0) {
      tally.present += 1;
      continue;
    }

    const r = await withRetry(block.name, () => applyBlock(block));
    const reread = await readCatalog();
    let still;
    if (reread.catalog) {
      catalog = reread.catalog;
      still = missingObjects(block.expects, catalog);
    } else if (!r.error) {
      // The SQL ran cleanly and the re-read failed: trust the run, as before.
      still = [];
    } else {
      // The first read proved these missing and the SQL failed: still missing.
      still = before;
    }

    if (still.length === 0) {
      tally.applied += 1;
      log.log(`${block.ready} — created ${before.join(', ')}`);
    } else {
      tally.missing += 1;
      const error = r.error ? errText(r.error) : null;
      tally.failures.push({ name: block.name, missing: still, error });
      say(block.level || 'error', `${block.fail} missing: ${still.join(', ')}${error ? ` — ${error}` : ''}`);
    }
  }

  const always = tally.alwaysRun
    ? ` (${tally.alwaysRun} function block${tally.alwaysRun === 1 ? '' : 's'} always run, ${tally.alwaysRunFailed} failed)`
    : '';
  say(tally.missing > 0 ? 'error' : 'log',
    `[Migration] startup schema: ${tally.present} present, ${tally.applied} applied, ${tally.missing} missing${always}`);

  if (tally.missing > 0 && deps.opsAlert) {
    try {
      await deps.opsAlert(formatMissingAlert(tally.failures));
    } catch (err) {
      log.warn(`[Migration] startup schema: ops alert failed: ${errText(err)}`);
    }
  }
  return tally;
}
