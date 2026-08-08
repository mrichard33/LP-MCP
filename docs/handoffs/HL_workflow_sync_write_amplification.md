# Handoff — HL workflow sync writes 122M rows to maintain 33K

**Repo:** `mrichard33/HL-MCP`
**File:** `src/extractor/workflow-extractor.ts` (38.7 KB — over the MCP push ceiling, hence this handoff)
**Prepared:** 2026-08-08
**Priority:** Medium. Real waste, not a fire — HL is healthy at 99.9% cache hit and 12.9 DB hours since December. Do this when there's a calm window, not under pressure.

---

## The finding

`pg_stat_user_tables` on the HL Supabase (`jtlngmcrtqncimtjjzlz`):

| Table | Live rows | Inserts | Deletes |
|---|---:|---:|---:|
| `workflow_connections` | 11,289 | 40,643,166 | 40,631,877 |
| `workflow_actions` | 10,765 | 39,368,614 | 39,357,863 |
| `workflow_steps` | 10,732 | 39,366,271 | 34,983,626 |
| `workflow_triggers` | 611 | 2,618,235 | 2,617,624 |

**~122 million row writes to maintain ~33,000 rows.** Roughly 3,600x churn.

## Why

Section 5 of `extractAndSyncWorkflows` runs unconditionally, once per workflow, once per hourly sync:

```ts
// 5. Clear existing detail data for this workflow before re-inserting
await supabase.from('workflow_steps').delete().eq('workflow_id', workflowDetail.id);
await supabase.from('workflow_connections').delete().eq('workflow_id', workflowDetail.id);
await supabase.from('workflow_triggers').delete().eq('workflow_id', workflowDetail.id);
await supabase.from('workflow_actions').delete().eq('workflow_id', workflowDetail.id);
```

311 workflows × 24 syncs/day × the full step/connection/action graph, regardless of whether anything changed. In practice almost nothing changes hour to hour.

## Why the fix is cheap

**The function already knows whether the workflow changed.** Section 4 deep-compares the incoming `raw_json` against the newest snapshot to decide whether to write a new snapshot version:

```ts
if (!latestSnapshot || normalizedExisting !== normalizedNew) {
```

That expression is exactly the signal needed. It just isn't hoisted or reused. No new comparison logic, no new hashing, no schema change.

---

## The edits

Four changes. Each `old` block is unique in the file as of SHA `87856c88e1dee8fc917c96ee8421d7fde6e0322b`.

### 1 — add the counter to the interface

**Find:**
```ts
  connections_synced: number;
  snapshots_created: number;
  errors: string[];
```

**Replace with:**
```ts
  connections_synced: number;
  snapshots_created: number;
  workflows_unchanged: number;
  errors: string[];
```

### 2 — initialise it (TWO sites — both must be changed)

Both the early-return object in the overlap guard and the main `result` initialiser use the same shape. `tsc` will flag whichever one you miss, so it is safe to rely on the compiler here.

**Find (occurrence 1, inside the `workflowSyncInProgress` early return):**
```ts
      connections_synced: 0,
      snapshots_created: 0,
      errors: ['Workflow sync already in progress — skipping overlapping run.'],
```

**Replace with:**
```ts
      connections_synced: 0,
      snapshots_created: 0,
      workflows_unchanged: 0,
      errors: ['Workflow sync already in progress — skipping overlapping run.'],
```

**Find (occurrence 2, the main `const result: SyncResult`):**
```ts
    connections_synced: 0,
    snapshots_created: 0,
    errors: [],
    failed_workflow_ids: [],
  };
```

**Replace with:**
```ts
    connections_synced: 0,
    snapshots_created: 0,
    workflows_unchanged: 0,
    errors: [],
    failed_workflow_ids: [],
  };
```

### 3 — hoist the comparison into a named const

**Find:**
```ts
        if (!latestSnapshot || normalizedExisting !== normalizedNew) {
          const newVersion = latestSnapshot ? latestSnapshot.version + 1 : 1;
          await supabase.from('workflow_snapshots').insert({
            workflow_id: workflowDetail.id,
            version: newVersion,
            json_structure: rawJson,
          });
          result.snapshots_created++;
        }
```

**Replace with:**
```ts
        // The snapshot comparison is also the signal for whether the detail
        // tables need rewriting at all — see the skip block below.
        const contentChanged = !latestSnapshot || normalizedExisting !== normalizedNew;

        if (contentChanged) {
          const newVersion = latestSnapshot ? latestSnapshot.version + 1 : 1;
          await supabase.from('workflow_snapshots').insert({
            workflow_id: workflowDetail.id,
            version: newVersion,
            json_structure: rawJson,
          });
          result.snapshots_created++;
        }
```

### 4 — gate the delete/insert on it

**Find:**
```ts
        // 5. Clear existing detail data for this workflow before re-inserting
        await supabase.from('workflow_steps').delete().eq('workflow_id', workflowDetail.id);
```

**Replace with:**
```ts
        // 2026-08-08 — skip the whole detail rewrite when the workflow's
        // raw_json is byte-identical to the newest snapshot.
        //
        // Sections 5-8 delete and re-insert every step, connection, trigger and
        // action for a workflow on every hourly cycle, whether or not anything
        // changed. Measured cost: 40.6M inserts + 40.6M deletes on
        // workflow_connections to maintain 11,289 live rows, and the same
        // pattern on workflow_actions, workflow_steps and workflow_triggers —
        // ~122M row writes for ~33K rows.
        //
        // The guard is deliberately NOT just `!contentChanged`. If the detail
        // tables are empty for this workflow — first run after a migration, or
        // a previous cycle that failed partway through section 6 — then the
        // snapshot can match while the cached graph is missing, and skipping
        // would leave it missing forever. So we skip only when unchanged AND
        // at least one step row already exists. A workflow that genuinely has
        // no parseable steps probes zero every time and falls through to the
        // rewrite exactly as it does today.
        //
        // The probe is a LIMIT 1 existence check, not count:'exact' — it only
        // ever asks "> 0", and an exact count would walk every matching row.
        if (!contentChanged) {
          const { data: existingSteps } = await supabase
            .from('workflow_steps')
            .select('step_id')
            .eq('workflow_id', workflowDetail.id)
            .limit(1);

          if (existingSteps && existingSteps.length > 0) {
            result.workflows_unchanged++;
            continue;
          }
        }

        // 5. Clear existing detail data for this workflow before re-inserting
        await supabase.from('workflow_steps').delete().eq('workflow_id', workflowDetail.id);
```

---

## What stays the same on purpose

- **`workflows` upsert (section 3) still runs every cycle.** It carries `synced_at`, which is the freshness signal `get_sync_health` and `forceLive` decisions depend on. 311 rows is cheap. Do not gate this.
- **The soft-delete sweep** at the end is untouched — workflows removed in GHL are still detected.
- **The overlap guard, error handling and `sync_log`** are untouched.
- The skip sits *after* the `workflows` upsert and snapshot logic, so a workflow that is unchanged still gets its `synced_at` bumped and still reports as synced.

## Expected result

Steady-state hourly churn on the four detail tables should drop by roughly 99%, from ~5,000 rows written per cycle to near zero when nothing changed. `workflows_unchanged` in the sync result tells you it is working — expect it to approach `workflows_total` on a quiet cycle.

The autovacuum thresholds tightened on these tables on 2026-08-08 (`sql/058` statement 6, HL section) stay useful either way; they just stop being load-bearing.

## Verification

1. `npx tsc --noEmit` — the repo's required check. This is the one that matters: TypeScript reports undeclared identifiers as `Cannot find name`, so it catches the exact class of defect that took LP MCP down on 2026-08-08 (a `node --check` parse on a JS file does not).
2. Deploy, then confirm the first sync logs a non-zero `workflows_unchanged`.
3. Confirm the graph is still intact after a full cycle:

```sql
SELECT
  (SELECT count(*) FROM workflow_steps)       AS steps,
  (SELECT count(*) FROM workflow_connections) AS connections,
  (SELECT count(*) FROM workflow_actions)     AS actions,
  (SELECT count(*) FROM workflow_triggers)    AS triggers;
-- expect approximately 10,732 / 11,289 / 10,765 / 611 — unchanged
```

4. Then re-read the churn a day later; `n_tup_ins` should be climbing far more slowly:

```sql
SELECT relname, n_live_tup, n_tup_ins, n_tup_del
FROM pg_stat_user_tables
WHERE relname LIKE 'workflow_%'
ORDER BY n_tup_ins DESC;
```

## Rollback

Revert the commit. There is no schema change and no data migration, so a revert restores the previous behaviour on the next sync cycle. Worst realistic failure is that the skip is too aggressive and a workflow's cached graph goes stale — a manual `sync_workflows` call after the revert rebuilds it, since the snapshot comparison will then differ.
