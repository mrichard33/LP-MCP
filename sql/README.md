# SQL / DDL doctrine

The canonical rule for how schema changes get applied to the LP MCP Supabase.
Per-migration files should link here rather than restating policy — three
different versions of it had drifted into the tree by 2026-08-06.

## The rule: split by operation class, not by tool preference

**Additive DDL → MCP `apply_migration`.**
`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN`, non-concurrent `CREATE INDEX`,
`CREATE TYPE`. Auditable, repeatable, and it shows up in `list_migrations`.

**Anything that locks or destroys → Supabase dashboard, with a human watching.**
`DROP`, `ALTER COLUMN TYPE`, backfills on populated tables. The cost of getting
these wrong is an outage, and the value of the dashboard is the person in front
of it, not the tool.

**`CREATE INDEX CONCURRENTLY` → never `apply_migration`.**
`apply_migration` wraps its statements in a transaction and `CONCURRENTLY`
cannot run inside one — it fails outright. Use MCP `execute_sql` (which does
not wrap) or the dashboard. On a **populated** table prefer the dashboard: the
build can run for minutes, holds a session the whole time, and is worth
watching. On a new or empty table either path is fine.

That last item is the reason the older notes in this tree contradicted each
other. It cost nothing on 2026-08-06 because the tables were new and empty; on
a populated table it is an outage, so it is called out separately rather than
folded into "additive".

## Practical notes

- **Mirror boot-critical DDL in `runMigrations()` (`src/index.js`)** so a fresh
  deploy self-heals. Use plain `CREATE INDEX IF NOT EXISTS` there, never
  `CONCURRENTLY` — there is no code path in this repo that runs statements
  outside a transaction, and on a fresh deploy the tables are empty anyway.
  Keep the `CONCURRENTLY` form in the `.sql` file under a `RUN SEPARATELY`
  banner for the existing-table case.
- **Use `runSQL` (`src/admin/supabase-admin.js`), not `supabase.rpc('exec_sql')`,
  inside `runMigrations()`.** `rpc()` reports failure in its return value
  without throwing, so `await` + `catch` never sees it. On 2026-07-22 that
  silently skipped a schema in production and every lead upsert failed on a
  missing column until the DDL was applied by hand. `runSQL` throws.
- **Numbering.** Top-level files are `sql/NNN_snake_case.sql`, zero-padded.
  Nothing enforces uniqueness and numbers have collided before (`021`, `030`,
  `035`, `038` each appear twice) — check the directory and pick deliberately.
  `sql/migrations/YYYY-MM-DD_slug.sql` is the date-named convention for changes
  applied by hand rather than mirrored at boot.
- **File header conventions:** state what the migration is and is *not*, whether
  it is mirrored in `runMigrations()`, a `-- ROLLBACK:` paragraph, an
  `-- AFTER RUNNING:` operational note where relevant, and a trailing
  `-- Verification` section that `SELECT`s the affected rows.
