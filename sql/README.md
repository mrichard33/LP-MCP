# Schema changes: the migrations ledger

The one rule for how schema reaches the LP Supabase project ("Reece Lead Perfection Sync",
ref `rcjcgjlqzepicbwhnnjl`). Other repos and per-migration files link here rather than restating it.

## Why this exists (2026-10-12, Fix 1)

Until this date, schema changes were pasted into the Supabase SQL editor by hand. The database's own
record of applied migrations (`supabase_migrations.schema_migrations`) listed 8 entries while this folder
held 157 numbered files, 55 date-named files in `sql/migrations/`, 73 seeds and 5 verify scripts. Five
repositories (LP-MCP, Reece-Dashboard, n8n, window-calculator, the AI OS loader) created tables in the same
database with no shared record. Eight file numbers were used twice (021, 030, 035, 038, 082, 106, 129, 135),
and ~75 blocks in `src/admin/startup-mirrors.js` re-declared DDL inline so most of it existed twice.
The repo and the database could not say whether they agreed.

## The rule

**A schema change is one file in `supabase/migrations/`, applied by CI, recorded by the database.**

1. **Name:** `supabase/migrations/<YYYYMMDDHHMMSS>_<snake_case>.sql`, UTC timestamp, e.g.
   `20261015143000_add_lp_leads_verified_source.sql`. The Supabase CLI applies files in version order.
2. **Content:** additive and idempotent where the statement allows it (`CREATE TABLE IF NOT EXISTS`,
   `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE VIEW`, `CREATE OR REPLACE FUNCTION`). A header says
   what it is, why, what it is NOT, and a `-- ROLLBACK:` paragraph. New views get NEW names; never
   mutate a live view's column list in place.
3. **Destructive statements** (`DROP`, `TRUNCATE`, `DELETE FROM`, `ALTER COLUMN ... TYPE`,
   `DROP COLUMN/CONSTRAINT`) need the line `-- destructive: approved by <name> <YYYY-MM-DD>` inside the
   file. CI refuses to apply a new destructive file without it. A person still watches: export or
   archive first, drop in a later migration.
4. **`CREATE INDEX CONCURRENTLY`** cannot run inside a transaction and the CLI wraps each file in one.
   Use a plain `CREATE INDEX IF NOT EXISTS` in the migration. For a hot, populated table where the lock
   matters, run the `CONCURRENTLY` form by hand FIRST (it will then be a no-op in the migration) and
   say so in the file header with the line `-- applied by hand first: <name> <YYYY-MM-DD>`. Without
   it, the PR's drift check sets the pending file aside and reads the hand-made objects as drift; with
   it, statements on objects the file declares are a notice, anything else still fails (2026-10-15,
   the system-health tables).
5. **One database, one ledger.** Reece-Dashboard, n8n, window-calculator and the AI OS loads put their
   LP-project DDL in THIS folder, in a PR to this repo. DDL for the HL project goes in
   `HL-MCP/supabase/migrations/`. Nothing else writes schema anywhere.
6. **`sql/NNN_*.sql` is frozen at 157.** It is history, kept so the dated comments and incident notes stay
   readable. `scripts/check-migrations.js` fails CI on a `158_*.sql`. `sql/migrations/`, `sql/verify/`,
   `sql/rollback/` and `sql/analysis/` are history too.
7. **`sql/seeds/` is unchanged.** It records DATA changes to `agent_rules`, `kb_faqs` and friends, applied
   through the MCP on the day they went live (CHANGELOG.md explains). Seeds are not schema.

## How it runs (`.github/workflows/db-migrate.yml`)

| Event | Job | What happens |
|---|---|---|
| Pull request touching `supabase/` | `check` | `scripts/check-migrations.js` (names, duplicate versions, destructive marker, baseline order, the sql/ freeze); then, with secrets, `supabase migration list` must show no database version the repo lacks; then, once a baseline exists, `supabase db diff` must be empty. |
| Merge to `main` with new files | `push` | `supabase db push` applies exactly the versions the database has not recorded, in order. Nothing else. |
| Manual run, `action=baseline` | `baseline` | Dumps the live schema (public + ai_os, no data) into `<ts>_baseline_dump.sql`, marks it applied, opens a PR. Run ONCE. |

Secrets (repository secrets, Settings → Secrets and variables → Actions): `SUPABASE_ACCESS_TOKEN` (a personal
access token from supabase.com/dashboard/account/tokens) and `SUPABASE_DB_PASSWORD` (Project Settings →
Database). Without them the check job prints a warning and skips the live comparison; the push job fails
loudly and applies nothing.

### The baseline, and why order matters

The 157 old files cannot be replayed. The ledger therefore starts from a **baseline dump**: one file holding the
live schema as `supabase db dump` prints it, recorded as already applied so `db push` never executes it against
production. Everything before it in this folder is a commented stub for a version the database already lists
(the CLI refuses to push when the database has a version the repo does not).

The drift check builds a shadow database by replaying this folder from empty. A migration that alters a table
the stubs never created fails there. So: **until the baseline exists, only stubs may live here**, and every
real migration must sort after the baseline. `check-migrations.js` enforces both.

### What the boot does now

`src/admin/startup-schema.js` still reads the catalog once per boot and compares it with the ~75 declared
blocks in `startup-mirrors.js`. It names anything missing and pages #ops-alerts once. It applies **nothing**
unless `STARTUP_SCHEMA_APPLY=true` (the rollback switch). The memory check (`src/memory/memory-migrations.js`)
is the same: warn, never apply. A fresh database is built with `supabase db push`, not by booting the app.

## Working with it

```bash
# A new table
cat > supabase/migrations/$(date -u +%Y%m%d%H%M%S)_my_table.sql <<'EOF'
-- my_table: what, why, what it is not. ROLLBACK: DROP TABLE my_table;
CREATE TABLE IF NOT EXISTS my_table (...);
EOF
node scripts/check-migrations.js      # the same checks CI runs, no secrets needed
npm test                              # scripts/test-sql-ledger.js is part of the suite
```

Open the PR. CI checks it. Merge. CI applies it. `list_migrations` (Supabase MCP) shows it.

Read in the database: the Supabase MCP `list_migrations`; or `SELECT version, name FROM
supabase_migrations.schema_migrations ORDER BY version`.

## Reading the old files

- `sql/NNN_*.sql`: the file header says what it is, whether it was mirrored at boot, how to roll it back and
  how to verify it. Numbers collide; read the name too.
- `sql/migrations/YYYY-MM-DD_*.sql`: changes applied by hand, never mirrored.
- `sql/cleanup/`: proposed clean-ups that have NOT run (see each file).
