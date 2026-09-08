# Session Continuity — SQL Query Library

All queries are executed via `LP MCP:supabase_run_query`. 

**CRITICAL: The supabase_run_query tool returns only row counts for plain SELECT queries. To get actual data back, wrap every SELECT in `json_agg(row_to_json(...))`.**

## Table of Contents

1. Session Restoration (Start of Session)
2. Session Logging (End of Session)
2a. Pending Items (During / End of Session)
2b. Refresh an Existing Checkpoint
3. Decision Logging (During Session)
4. Issue Tracking (During Session)
5. Search & Analysis Queries
6. Transcript Bridge Queries
7. JSONB Field Schemas
8. SQL Escaping Rules

---

## 1. Session Restoration (Start of Session)

### Query 1: Context pack — the ONLY session-start read

`claude_memory_context(topic)` is a Postgres function (LP-MCP `sql/090`,
applied 2026-09-06). One call, ~8k tokens, ranked and size-capped. Pass the
conversation's topic in 2–5 words; pass `NULL` only if there is no subject yet.

```sql
SELECT json_agg(row_to_json(p)) FROM (
  SELECT claude_memory_context('{topic}') AS pack
) p
```

Sections in the returned object:

| Key | What it holds | Cap |
|---|---|---|
| `last_session` | newest checkpoint: id, date, title, phase, surface, origin, chat_url, 1,500-char summary, `open_items` (its rows in `claude_pending_items` with status open / blocked / deferred — next steps first, by priority) | 1 |
| `recent_sessions` | the five checkpoints before it — id, date, title | 5 |
| `open_issues_priority` | open/in_progress defects, critical+high; `origin='live'` first, fresh before `stale`, critical before high, then most recently touched | 25 |
| `decisions_30d` | `status='active'` decisions dated in the last 30 days (retro rows included — they carry the chat's real date) | 25 |
| `resolved_30d` | issues resolved in the last 30 days | 15 |
| `open_pending_recent` | open/blocked rows from `claude_pending_items` created by OTHER sessions in the last 14 days — next steps plus action / question / decision / build items | 20 |
| `topic_matches` | ranked full-text hits for the topic across decisions, issues, sessions (`null` when no topic) | 20 |
| `counts` | open_issues (defects), open_issues_fresh, open_issues_live, open_critical, open_high, open_initiatives, open_pending_items, open_pending_items_30d, active_decisions, sessions — the size of what is NOT in the pack | — |

Every row carries `origin` (`live` / `retro`). Retro rows are reconstructed
from transcripts — evidence, not Mark's confirmed word.

**If the call errors with `function claude_memory_context(...) does not
exist`**, LP-MCP `sql/090` has not been applied to this instance (see
`references/migration-v3.sql`). Tell Mark, then fall back to exactly three
capped reads and nothing more: "Get the most recent session (full row)",
"Get last N sessions", and the capped "Get all open issues" variant below
with its `LIMIT 50` and `origin = 'live'` filter intact.

### DO NOT run at session start — "Get all open issues"

Retired 2026-09-06. It now returns ~640k characters (~160k tokens) because
the retro history was promoted into `claude_known_issues`. It stays here only
as a capped variant for triage work, and only with a `LIMIT`:

```sql
SELECT json_agg(row_to_json(i)) FROM (
  SELECT id, severity, category, description, workflow_id,
    workflow_name, impact, status, reported_date, origin
  FROM claude_known_issues
  WHERE status IN ('open', 'in_progress')
    AND origin = 'live'            -- drop this line to include retro rows
  ORDER BY
    CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2
    WHEN 'medium' THEN 3 WHEN 'low' THEN 4 END,
    updated_at DESC
  LIMIT 50                         -- never remove the LIMIT
) i
```

### Get the most recent session (full row)

Only when the pack's 1,500-char summary is not enough — e.g. you need
`workflows_touched`, `mcp_verified_ids`, or the complete `pending_items`.

```sql
SELECT json_agg(row_to_json(s)) FROM (
  SELECT id, session_date, session_title, phase_focus,
    workflows_touched, phase_status, decisions_made,
    issues_found, issues_resolved, pending_items,
    board_versions, mcp_verified_ids, next_steps, raw_summary,
    chat_url, chat_title, transcript_search_keys,
    surface, log_origin, link_confidence, created_at
  FROM claude_session_logs
  ORDER BY created_at DESC LIMIT 1
) s
```

### Get last N sessions (overview)

```sql
SELECT json_agg(row_to_json(s)) FROM (
  SELECT id, session_date, session_title, phase_focus,
    pending_items, next_steps
  FROM claude_session_logs
  ORDER BY created_at DESC LIMIT 5
) s
```

### Query 4: Transcript reconciliation state (chat surface only)

Two reads feed the reconciliation pass. Run both, then call `recent_chats`
and compare in-context.

**4a — Chats already reviewed (the ledger):**

```sql
SELECT json_agg(row_to_json(l)) FROM (
  SELECT chat_url, chat_title, chat_updated_at, session_id,
    disposition, reviewed_at
  FROM claude_transcript_ledger
  ORDER BY chat_updated_at DESC NULLS LAST
  LIMIT 100
) l
```

**4b — Checkpoints still awaiting a transcript link:**

Only `surface = 'chat'` rows are candidates. Cowork and Code checkpoints are
expected to be unlinked and must not be reported as gaps.

```sql
SELECT json_agg(row_to_json(s)) FROM (
  SELECT id, session_date, session_title, created_at,
    transcript_search_keys, surface, log_origin
  FROM claude_session_logs
  WHERE link_confidence = 'unlinked'
    AND surface = 'chat'
    AND created_at > NOW() - INTERVAL '60 days'
  ORDER BY created_at DESC
) s
```

If `claude_transcript_ledger` does not exist, 4a errors. Treat that as
"bridge not installed": skip reconciliation, keep the context pack (Query 1).

### 1b — Auto-link pass (v4.3, mandatory on the chat surface)

Match each row from 4b to the `recent_chats` entry whose `updated_at` is
within 3 minutes of the session's `created_at` (nearest wins; title
similarity breaks ties; skip and report if still ambiguous). Then, per
match, one write — session link + ledger row together. Never downgrade an
`exact` link.

```sql
WITH s AS (
  UPDATE claude_session_logs
  SET chat_url = 'https://claude.ai/chat/<uuid>',
      chat_title = '<title from recent_chats>',
      link_confidence = 'inferred',
      updated_at = NOW()
  WHERE id = <session_id>
    AND link_confidence <> 'exact'
  RETURNING id
)
INSERT INTO claude_transcript_ledger
  (chat_url, chat_title, chat_updated_at, session_id, disposition, reviewed_at)
SELECT 'https://claude.ai/chat/<uuid>', '<title>', '<updated_at>', id, 'linked', NOW()
FROM s
ON CONFLICT (chat_url) DO UPDATE
  SET session_id = EXCLUDED.session_id,
      chat_updated_at = EXCLUDED.chat_updated_at,
      disposition = 'linked',
      reviewed_at = NOW()
```

`supabase_run_query` rejects a statement that *begins* with `WITH` when it
modifies data. If it does, run the UPDATE and the INSERT as two calls, UPDATE
first.

### 1c — Date self-heal for a sweep-written session

Run when the pack's `last_session` is the chat you are in and it carries
`date_confidence = 'write_date'`. The real date is on the chat's first user
message.

```sql
UPDATE claude_session_logs
SET session_date = '<YYYY-MM-DD from the first message>',
    date_confidence = 'exact',
    updated_at = NOW()
WHERE id = <session_id>
  AND date_confidence = 'write_date'
```

Then move the session's decisions, issues and pending items to the same
date (they inherited the wrong one), two more calls:

```sql
UPDATE claude_decision_log SET decision_date = '<YYYY-MM-DD>'
WHERE session_id = <session_id>;

UPDATE claude_known_issues SET reported_date = '<YYYY-MM-DD>'
WHERE reported_session_id = <session_id> AND status IN ('open','in_progress');
```

---

## 2. Session Logging (End of Session)

### Create a session log entry

**v4:** `decisions_made`, `issues_found`, `issues_resolved`, `pending_items`, `next_steps` are written as `'[]'::jsonb`. Those facts live in `claude_decision_log`, `claude_known_issues` and `claude_pending_items` (§2a, §3, §4). The JSON columns remain only so the 690 pre-v4 rows keep their provenance.

Replace all `{variables}` with actual values. JSONB fields must be valid JSON strings. Single quotes in text values must be doubled (`''`).

```sql
INSERT INTO claude_session_logs (
  session_date, session_title, phase_focus,
  workflows_touched, phase_status, decisions_made,
  issues_found, issues_resolved, pending_items,
  board_versions, mcp_verified_ids, next_steps, raw_summary,
  chat_url, chat_title, transcript_search_keys,
  surface, log_origin, link_confidence
) VALUES (
  '{session_date}',
  '{session_title}',
  '{phase_focus}',
  '{workflows_touched_json}'::jsonb,
  '{phase_status_json}'::jsonb,
  '{decisions_made_json}'::jsonb,
  '{issues_found_json}'::jsonb,
  '{issues_resolved_json}'::jsonb,
  '{pending_items_json}'::jsonb,
  '{board_versions_json}'::jsonb,
  '{mcp_verified_ids_json}'::jsonb,
  '{next_steps_json}'::jsonb,
  '{raw_summary_escaped}',
  {chat_url_or_NULL},
  {chat_title_or_NULL},
  '{transcript_search_keys_json}'::jsonb,
  '{surface}',
  '{log_origin}',
  '{link_confidence}'
) RETURNING id, session_title, created_at
```

**Transcript bridge values:**
- `{chat_url_or_NULL}` / `{chat_title_or_NULL}` — a quoted string if Mark
  supplied the URL, otherwise the bare keyword `NULL` (no quotes)
- `{transcript_search_keys_json}` — e.g. `["S4.5", "claude_transcript_ledger", "Contractor Connect"]`
- `{surface}` — `chat` | `cowork` | `code`
- `{log_origin}` — `live` for a normal checkpoint, `retro` for one
  reconstructed from a transcript
- `{link_confidence}` — `exact` if a URL is on file, else `unlinked`.
  Never write `inferred` at insert time; that value is only set by the
  timestamp-backfill pass.

**Note:** RETURNING clause works with INSERT/UPDATE through supabase_run_query — it returns the specified columns directly without needing the json_agg wrapper.

### Update an existing session (mid-session checkpoint)

```sql
UPDATE claude_session_logs SET
  workflows_touched = '{workflows_touched_json}'::jsonb,
  phase_status = '{phase_status_json}'::jsonb,
  pending_items = '{pending_items_json}'::jsonb,
  next_steps = '{next_steps_json}'::jsonb,
  raw_summary = '{raw_summary_escaped}',
  transcript_search_keys = (
    SELECT jsonb_agg(DISTINCT k) FROM jsonb_array_elements(
      transcript_search_keys || '{new_search_keys_json}'::jsonb
    ) k
  ),
  updated_at = NOW()
WHERE id = {session_id}
RETURNING id, updated_at
```

The `transcript_search_keys` expression **unions** old and new keys rather
than replacing them — a long session keeps accumulating distinctive terms and
the early ones stay valid. Keep the merged total under ~12.

---

## 2a. Pending Items (During / End of Session)

`claude_pending_items` is the single home for open work (LP-MCP `sql/091`, 2026-09-05).
One row per pending item or next step. `source_session_id` = the session that
created it. Controlled `status`: `open` · `blocked` · `deferred` · `done` ·
`dropped` · `superseded` · `ratified`.

### Add a pending item or next step

```sql
INSERT INTO claude_pending_items
  (source_session_id, source_field, source_index, kind, item_type, description,
   status, priority, effort, blocked_by, ref, workflow_id, owner,
   origin, session_date, created_at)
VALUES
  ({session_id}, 'live', {n}, '{pending|next_step}', '{action_needed|decision_needed|verification_needed|open_question|build_needed|next_step}',
   '{description}', 'open', {priority_or_NULL}, '{effort}', '{blocked_by}', '{ref}', '{workflow_id}', '{owner}',
   'live', '{session_date}', NOW())
RETURNING id, description
```

`source_field='live'` and a running `source_index` (0, 1, 2 …) per session keep
the row unique; pre-v4 rows use `'pending_items'` / `'next_steps'` there.

### Close, drop, or supersede an item

```sql
UPDATE claude_pending_items
SET status = '{done|dropped|superseded|blocked|deferred}',
    resolved_session_id = {session_id},
    updated_at = NOW()
WHERE id = {item_id}
RETURNING id, status, description
```

### Open items by topic

```sql
SELECT json_agg(row_to_json(p)) FROM (
  SELECT id, source_session_id, session_date, kind, item_type, status, priority, description
  FROM claude_pending_items
  WHERE status IN ('open','blocked','deferred')
    AND description ILIKE '%{keyword}%'
  ORDER BY session_date DESC, priority NULLS LAST, id
  LIMIT 30
) p
```

---

## 2b. Refresh an Existing Checkpoint

Used when Mark re-opens a chat that already has a session row (SKILL.md,
Moment 2b). **Never INSERT into claude_session_logs during a refresh.**

### Load the session and everything that points at it

```sql
SELECT json_agg(row_to_json(x)) FROM (
  SELECT
    (SELECT row_to_json(s) FROM (
       SELECT id, session_date, session_title, phase_focus, log_origin, surface,
              chat_url, link_confidence, transcript_search_keys, raw_summary
       FROM claude_session_logs WHERE id = {session_id}) s) AS session,
    (SELECT json_agg(json_build_object('id', id, 'status', status, 'origin', origin,
       'confidence', confidence, 'decision', left(decision, 200)))
       FROM claude_decision_log WHERE session_id = {session_id}) AS decisions,
    (SELECT json_agg(json_build_object('id', id, 'status', status, 'severity', severity,
       'origin', origin, 'stale', stale, 'description', left(description, 200)))
       FROM claude_known_issues WHERE reported_session_id = {session_id}) AS issues,
    (SELECT json_agg(json_build_object('id', id, 'kind', kind, 'type', item_type,
       'status', status, 'description', left(description, 200)))
       FROM claude_pending_items WHERE source_session_id = {session_id}) AS pending
) x
```

### Refresh the session row (UPDATE only)

```sql
UPDATE claude_session_logs SET
  raw_summary = '[REFRESHED {today} with Mark in the source chat] ' || '{raw_summary_escaped}',
  transcript_search_keys = (
    SELECT jsonb_agg(DISTINCT k) FROM jsonb_array_elements(
      COALESCE(transcript_search_keys, '[]'::jsonb) || '{new_search_keys_json}'::jsonb
    ) k
  ),
  chat_url        = COALESCE({chat_url_or_NULL}, chat_url),
  chat_title      = COALESCE({chat_title_or_NULL}, chat_title),
  link_confidence = CASE WHEN {chat_url_or_NULL} IS NOT NULL THEN 'exact' ELSE link_confidence END,
  updated_at = NOW()
WHERE id = {session_id}
RETURNING id, link_confidence, updated_at
```

Keep the existing `[RETRO — …]` prefix inside `{raw_summary_escaped}` when the
row was reconstructed; the `[REFRESHED …]` tag goes in front of it. If Mark did
not paste the URL, pass the bare keyword `NULL` for both URL slots and the link
is left exactly as it was.

### Confirm an existing retro row (decision or issue) with Mark's word

```sql
UPDATE claude_decision_log SET
  confidence = 'confirmed',
  verified_at = NOW()
WHERE id = {decision_id}
RETURNING id, origin, confidence
```

```sql
UPDATE claude_known_issues SET
  confidence = 'confirmed',
  verified_at = NOW(),
  verification_note = 'Confirmed by Mark during refresh of session #{session_id} on {today}',
  stale = false,
  updated_at = NOW()
WHERE id = {issue_id}
RETURNING id, origin, confidence, status
```

`origin` is never changed by a refresh — it records where the row came from.

### New rows found during a refresh

Use the normal INSERTs in §3 and §4 with `session_id = {session_id}`. Rows Mark
states in the refresh conversation take the defaults (`origin = 'live'`,
`confidence = 'confirmed'`); rows only inferred from the transcript are written
with `origin = 'retro'`, `confidence = 'reconstructed'` added to the column
list, or parked in `claude_pending_items` as `unconfirmed_decision`. Close
finished pending items with the UPDATE in §2a, `resolved_session_id = {session_id}`.

### Ledger after a refresh

Use "Write or update a ledger row" in §6 with `disposition = 'linked'`,
`session_id = {session_id}`, `chat_updated_at` = the chat's current timestamp,
`notes = 'refreshed {today}'`.

---

## 3. Decision Logging (During Session)

### Log a decision

```sql
INSERT INTO claude_decision_log (
  session_id, decision_date, category, decision,
  options_considered, rationale, workflow_id, workflow_name, workflow_code, reversible,
  transcript_search_keys
) VALUES (
  {session_id},
  '{decision_date}',
  '{category}',
  '{decision}',
  '{options_json}'::jsonb,
  '{rationale}',
  {workflow_id_or_NULL},
  {workflow_name_or_NULL},
  {workflow_code_or_NULL},
  {reversible},
  '{transcript_search_keys_json}'::jsonb
) RETURNING id, decision, area, created_at
```

`workflow_code` is the canonical code (`S4.5`, `E.2`, `A.WE-1`) — set it whenever
the decision concerns a registered workflow, `NULL` otherwise. `area` is not in
the column list on purpose: the `claude_set_area` trigger (LP-MCP `sql/093`)
fills it from the text, and `RETURNING area` shows what it chose. Pass
`area = '{slug}'` explicitly only to override the classifier.

### Find the workflow code

```sql
SELECT json_agg(row_to_json(w)) FROM (
  SELECT canonical_code, canonical_name, workflow_id, stage_family, status
  FROM claude_workflow_ref
  WHERE canonical_code ILIKE '{code_or_fragment}%'
     OR canonical_name ILIKE '%{name_fragment}%'
     OR workflow_id LIKE '{uuid_prefix}%'
  ORDER BY canonical_code LIMIT 10
) w
```

`claude_workflow_ref` is a cache of the HL `workflow_registry` (sql/092) — the
registry always wins; if a code is missing here, it is new and the cache is
refreshed by the priority #8 nightly job.

Use the **same** search keys as the parent session log. This is what lets a
single decision resolve back to the exact chat where it was argued, rather
than only to its session row.

### Supersede a decision

Never delete. When a new decision replaces an old one:

```sql
UPDATE claude_decision_log
SET status = 'superseded', superseded_by = {new_decision_id}
WHERE id = {old_decision_id}
RETURNING id, status, superseded_by
```

`status` values: `active` (default) · `superseded` · `rejected`. `verified_at`
marks the date Mark last re-confirmed a decision (the 20 ratified 2026-09-05
carry it).

### Decision categories

Use one of these standardized category values:
- `architecture` — funnel structure, workflow routing, pipeline design
- `appointment` — calendar types, qualification tiers, booking logic
- `content` — story arc assignments, formula selection, messaging approach
- `tag_operations` — tag namespace changes, conflict resolution
- `publication` — publish/unpublish decisions, migration sequence
- `integration` — LP sync, n8n, Five9, external system decisions
- `tooling` — MCP changes, Supabase schema, dashboard design, skills

---

## 4. Issue Tracking (During Session)

### Report a new issue

```sql
INSERT INTO claude_known_issues (
  reported_date, reported_session_id, severity, category,
  description, workflow_id, workflow_name, workflow_code, impact, fix_instructions, status
) VALUES (
  '{date}', {session_id}, '{severity}', '{category}',
  '{description}', {workflow_id_or_NULL}, {workflow_name_or_NULL}, {workflow_code_or_NULL},
  '{impact}', '{fix_instructions}', 'open'
) RETURNING id, severity, area, description
```

`workflow_code` as in §3 ("Find the workflow code"). `area` is filled by the
`claude_set_area` trigger; `RETURNING area` shows the result.

### Resolve an issue

```sql
UPDATE claude_known_issues SET
  status = 'resolved',
  resolved_date = CURRENT_DATE,
  resolved_session_id = {session_id},
  verified_at = NOW(),
  verification_note = '{what proved it — file, PR, live check}',
  stale = false,
  updated_at = NOW()
WHERE id = {issue_id}
RETURNING id, description, status
```

### Re-verify an issue that is still open (clears the stale flag)

```sql
UPDATE claude_known_issues SET
  verified_at = NOW(),
  verification_note = '{still present on main / live check, date}',
  stale = false,
  updated_at = NOW()
WHERE id = {issue_id}
RETURNING id, stale, verified_at
```

### Mark a duplicate (keep the most complete / highest-severity row)

```sql
UPDATE claude_known_issues SET
  status = 'duplicate', merged_into = {keep_id}, updated_at = NOW()
WHERE id = {dup_id}
RETURNING id, merged_into
```

Issue `status` values: `open` · `in_progress` · `resolved` · `duplicate` ·
`wont_fix` · `archived`. `issue_type`: `defect` (default) · `initiative` ·
`metric`. Only `defect` rows count as open issues in the context pack.

### Issue categories

- `routing` — wrong workflow routing, broken branches
- `tag_conflict` — duplicate tags, missing tag operations
- `messaging` — wrong content, duplicate sends, missing emails
- `pipeline` — stagnant opportunities, wrong stage mapping
- `trigger` — dead triggers, duplicate triggers, conflicts
- `timing` — excessive waits, wrong delays
- `data` — LP sync issues, missing fields, stale cache
- `infrastructure` — Railway, Supabase, MCP connectivity

---

## 5. Search & Analysis Queries

### Search memory (decisions + issues + sessions) — use this first

`claude_memory_search(query, limit)` — ranked full-text search (LP-MCP
`sql/090`). Plain phrases work (`appointment title`), quoted phrases work
(`"stop-bot"`), and exact tokens the parser would mangle (`S4.5`, `8e30ff37`,
`select.js`) are caught by an exact-match fallback. `kind` is `decision`,
`issue`, or `session`; `origin` is `live` or `retro`.

```sql
SELECT json_agg(row_to_json(m)) FROM (
  SELECT kind, id, date, text, origin, status, category, session_id, rank
  FROM claude_memory_search('{query}', 20)
) m
```

### Search decisions by keyword (legacy — substring only, unranked)

Kept for exact-substring checks. Prefer `claude_memory_search` above.

```sql
SELECT json_agg(row_to_json(d)) FROM (
  SELECT d.id, d.decision_date, d.category, d.decision, d.rationale, d.origin, s.session_title
  FROM claude_decision_log d
  JOIN claude_session_logs s ON d.session_id = s.id
  WHERE d.decision ILIKE '%{keyword}%' OR d.rationale ILIKE '%{keyword}%'
  ORDER BY d.decision_date DESC, d.id DESC
) d
```

### Get all decisions for a specific workflow

```sql
SELECT json_agg(row_to_json(d)) FROM (
  SELECT decision_date, category, decision, rationale, options_considered
  FROM claude_decision_log
  WHERE workflow_name ILIKE '%{workflow_name}%' OR workflow_id = '{workflow_id}'
  ORDER BY created_at DESC
) d
```

### Get session history for a specific phase

```sql
SELECT json_agg(row_to_json(s)) FROM (
  SELECT session_date, session_title, workflows_touched, 
    pending_items, next_steps
  FROM claude_session_logs
  WHERE phase_focus ILIKE '%{phase_name}%'
  ORDER BY session_date DESC
) s
```

### Issue resolution rate

```sql
SELECT json_agg(row_to_json(r)) FROM (
  SELECT 
    COUNT(*) FILTER (WHERE status = 'open') as open_issues,
    COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
    COUNT(*) FILTER (WHERE status = 'resolved') as resolved_issues,
    COUNT(*) FILTER (WHERE severity = 'critical' AND status = 'open') as critical_open,
    COUNT(*) FILTER (WHERE severity = 'high' AND status = 'open') as high_open,
    COUNT(*) FILTER (WHERE origin = 'retro' AND status = 'open') as retro_open
  FROM claude_known_issues
) r
```

### Get full session by ID

```sql
SELECT json_agg(row_to_json(s)) FROM (
  SELECT * FROM claude_session_logs WHERE id = {session_id}
) s
```

### Count all records across tables

```sql
SELECT json_agg(row_to_json(c)) FROM (
  SELECT 
    (SELECT COUNT(*) FROM claude_session_logs) as sessions,
    (SELECT COUNT(*) FROM claude_decision_log) as decisions,
    (SELECT COUNT(*) FROM claude_known_issues) as issues,
    (SELECT COUNT(*) FROM claude_known_issues WHERE status = 'open') as open_issues
) c
```

---

## 6. Transcript Bridge Queries

### Backfill a link after timestamp matching (Mechanism 2)

Run once a `recent_chats` result has been matched to an unlinked checkpoint by
timestamp proximity. The guard prevents an inferred match from ever clobbering
a URL Mark supplied directly.

```sql
UPDATE claude_session_logs SET
  chat_url = '{chat_url}',
  chat_title = '{chat_title_escaped}',
  link_confidence = 'inferred',
  updated_at = NOW()
WHERE id = {session_id}
  AND link_confidence <> 'exact'
RETURNING id, chat_url, link_confidence
```

### Set an exact link (Mark supplied the URL)

```sql
UPDATE claude_session_logs SET
  chat_url = '{chat_url}',
  chat_title = '{chat_title_escaped}',
  link_confidence = 'exact',
  updated_at = NOW()
WHERE id = {session_id}
RETURNING id, chat_url, link_confidence
```

### Write or update a ledger row

`chat_url` is the primary key, so an upsert handles both first review and
re-review after a chat continued.

```sql
INSERT INTO claude_transcript_ledger (
  chat_url, chat_title, chat_updated_at, session_id, disposition, notes
) VALUES (
  '{chat_url}',
  '{chat_title_escaped}',
  '{chat_updated_at}',
  {session_id_or_NULL},
  '{disposition}',
  '{notes_escaped}'
)
ON CONFLICT (chat_url) DO UPDATE SET
  chat_title = EXCLUDED.chat_title,
  chat_updated_at = EXCLUDED.chat_updated_at,
  session_id = COALESCE(EXCLUDED.session_id, claude_transcript_ledger.session_id),
  disposition = EXCLUDED.disposition,
  notes = EXCLUDED.notes,
  reviewed_at = NOW()
RETURNING chat_url, disposition, reviewed_at
```

`{disposition}` is one of `linked`, `retro_written`, `no_content`, `deferred`.

### Find the session for this chat (before a refresh)

Claude cannot read its own chat URL, so a refresh starts by matching the chat
title Mark can see at the top of the screen. Confirm the number with Mark
before any write; if nothing matches, it is a retro-checkpoint, not a refresh.

```sql
SELECT json_agg(row_to_json(l)) FROM (
  SELECT l.session_id, l.chat_title, l.disposition, l.chat_updated_at,
         s.session_date, s.session_title, s.log_origin, s.link_confidence
  FROM claude_transcript_ledger l
  LEFT JOIN claude_session_logs s ON s.id = l.session_id
  WHERE l.chat_title ILIKE '%{title_fragment_escaped}%'
  ORDER BY l.chat_updated_at DESC LIMIT 10
) l
```

If the chat has no ledger row, fall back to the session titles:

```sql
SELECT json_agg(row_to_json(s)) FROM (
  SELECT id, session_date, session_title, log_origin, link_confidence, chat_url
  FROM claude_session_logs
  WHERE session_title ILIKE '%{title_fragment_escaped}%'
     OR chat_title ILIKE '%{title_fragment_escaped}%'
  ORDER BY session_date DESC LIMIT 10
) s
```

### Re-open a ledger row whose chat has advanced

When `recent_chats` reports an `updated_at` later than the stored
`chat_updated_at`, the chat continued after it was reviewed.

```sql
UPDATE claude_transcript_ledger SET
  disposition = 'deferred',
  chat_updated_at = '{new_chat_updated_at}',
  notes = 'Chat continued after review — needs re-checkpoint',
  reviewed_at = NOW()
WHERE chat_url = '{chat_url}'
  AND chat_updated_at < '{new_chat_updated_at}'
RETURNING chat_url, disposition
```

### Find checkpoints by search key

Uses the GIN containment operator, so it hits the index.

```sql
SELECT json_agg(row_to_json(s)) FROM (
  SELECT id, session_date, session_title, chat_url,
    transcript_search_keys, log_origin
  FROM claude_session_logs
  WHERE transcript_search_keys @> '["{key}"]'::jsonb
  ORDER BY created_at DESC
) s
```

For a partial or case-insensitive match, expand the array instead:

```sql
SELECT json_agg(row_to_json(s)) FROM (
  SELECT DISTINCT ON (s.id) s.id, s.session_date, s.session_title, s.chat_url
  FROM claude_session_logs s,
       jsonb_array_elements_text(s.transcript_search_keys) AS k
  WHERE k ILIKE '%{key_fragment}%'
  ORDER BY s.id, s.created_at DESC
) s
```

### Resolve a decision to its transcript

```sql
SELECT json_agg(row_to_json(d)) FROM (
  SELECT d.decision_date, d.category, d.decision, d.rationale,
    d.transcript_search_keys,
    s.session_title, s.chat_url, s.link_confidence, s.log_origin
  FROM claude_decision_log d
  JOIN claude_session_logs s ON d.session_id = s.id
  WHERE d.decision ILIKE '%{keyword}%' OR d.rationale ILIKE '%{keyword}%'
  ORDER BY d.created_at DESC
) d
```

Resolution order: use `chat_url` if present; otherwise run
`conversation_search` on 2-3 of the `transcript_search_keys`; otherwise fall
back to distinctive nouns in the decision text itself.

### Bridge health check

```sql
SELECT json_agg(row_to_json(h)) FROM (
  SELECT
    COUNT(*) AS total_checkpoints,
    COUNT(*) FILTER (WHERE link_confidence = 'exact') AS exact_links,
    COUNT(*) FILTER (WHERE link_confidence = 'inferred') AS inferred_links,
    COUNT(*) FILTER (WHERE link_confidence = 'unlinked'
                     AND surface = 'chat') AS unlinked_chat,
    COUNT(*) FILTER (WHERE surface IN ('cowork', 'code')) AS non_chat_surface,
    COUNT(*) FILTER (WHERE log_origin = 'retro') AS retro_written,
    COUNT(*) FILTER (WHERE jsonb_array_length(transcript_search_keys) = 0)
      AS missing_search_keys,
    (SELECT COUNT(*) FROM claude_transcript_ledger) AS chats_reviewed,
    (SELECT COUNT(*) FROM claude_transcript_ledger
     WHERE disposition = 'deferred') AS chats_deferred
  FROM claude_session_logs
) h
```

`missing_search_keys` is the number to watch. A checkpoint with zero keys and
no URL is effectively unfindable — those are pre-migration rows or Step 0 was
skipped.

---

## 6a. Conflicts, Validation and Drafts (v4.4 — LP-MCP sql/098)

All of these are SQL fallbacks or ruling statements; the tools and the nightly
job do the routine work. Every statement marks — nothing here deletes.

### Defer a chat for the nightly draft (reconciliation found it, nobody checkpointed it)
```sql
INSERT INTO claude_transcript_ledger (chat_url, chat_title, chat_updated_at, disposition, reviewed_at, notes)
VALUES ('<url>', '<title>', '<updated_at>', 'deferred', now(), 'reconciliation YYYY-MM-DD: no checkpoint')
ON CONFLICT (chat_url) DO UPDATE SET chat_title = EXCLUDED.chat_title, chat_updated_at = EXCLUDED.chat_updated_at,
  disposition = CASE WHEN claude_transcript_ledger.session_id IS NULL THEN 'deferred' ELSE claude_transcript_ledger.disposition END,
  reviewed_at = now()
```
The nightly job turns each such row (no `session_id`) into a draft session
(`log_origin='nightly'`) and points the ledger row at it. To drop a draft:
`UPDATE claude_transcript_ledger SET disposition='no_content' WHERE chat_url='<url>'`
(the draft session stays, marked by its origin).

### Open conflicts awaiting a ruling
```sql
SELECT json_agg(row_to_json(c)) FROM (
  SELECT c.id, c.kind, c.row_a, c.row_b, round(c.similarity::numeric, 3) AS similarity, c.detected_at::date AS detected,
         left(coalesce(da.decision, ia.description), 160) AS text_a, coalesce(da.decision_date, ia.reported_date) AS date_a,
         left(coalesce(db.decision, ib.description), 160) AS text_b, coalesce(db.decision_date, ib.reported_date) AS date_b
  FROM claude_memory_conflicts c
  LEFT JOIN claude_decision_log da ON c.kind = 'decision' AND da.id = c.row_a
  LEFT JOIN claude_decision_log db ON c.kind = 'decision' AND db.id = c.row_b
  LEFT JOIN claude_known_issues ia ON c.kind = 'issue' AND ia.id = c.row_a
  LEFT JOIN claude_known_issues ib ON c.kind = 'issue' AND ib.id = c.row_b
  WHERE c.status = 'open'
  ORDER BY c.similarity DESC, c.id
  LIMIT 20
) c
```

### Rule on a decision conflict (one screen, one ruling each)
```sql
-- A supersedes B (the newer or fuller row wins; B stays, marked)
UPDATE claude_memory_conflicts SET status='a_supersedes_b', ruled_by='Mark', ruled_at=now() WHERE id = <conflict id>;
UPDATE claude_decision_log SET status='superseded', superseded_by=<row_a> WHERE id = <row_b> AND status='active';

-- B supersedes A: swap the two ids and use status 'b_supersedes_a'.

-- Not a conflict (two different subjects that happen to read alike)
UPDATE claude_memory_conflicts SET status='not_a_conflict', ruled_by='Mark', ruled_at=now() WHERE id = <conflict id>;
```

### Rule on an issue duplicate pair (batch C5)
```sql
UPDATE claude_known_issues SET status='duplicate', merged_into=<keep id>, updated_at=now() WHERE id = <dup id> AND status IN ('open','in_progress');
UPDATE claude_memory_conflicts SET status='merged', ruled_by='Mark', ruled_at=now() WHERE id = <conflict id>;
```

### Reverse a ruling (both rows return to active; embeddings re-weighted the next night)
```sql
UPDATE claude_decision_log SET status='active', superseded_by=NULL WHERE id = <row that lost>;
UPDATE claude_memory_conflicts SET status='open', ruled_by=NULL, ruled_at=NULL WHERE id = <conflict id>;
```

### This week's validation results (what the nightly flagged)
```sql
SELECT json_agg(row_to_json(v)) FROM (
  SELECT DISTINCT ON (check_name) check_name, mode, rows_checked, rows_flagged, ran_at, sample
  FROM claude_memory_validation_log
  WHERE ran_at > now() - interval '7 days'
  ORDER BY check_name, ran_at DESC
) v
```
`guard:batch_pattern` and `guard:conflict` rows are what `MEMORY_GUARD_MODE=shadow`
would have rejected — review them before flipping the guard to `live`.

### Heal a sweep-written session once its chat is found (batch C2; never overwrite an exact link)
```sql
UPDATE claude_session_logs
SET chat_url = '<url>', chat_title = '<title>', source_chat_updated_at = '<updated_at>',
    session_date = ('<updated_at>'::timestamptz AT TIME ZONE 'America/New_York')::date,
    date_confidence = 'exact', link_confidence = 'inferred', validation_status = 'passed',
    validation_notes = coalesce(validation_notes, '{}'::jsonb) || jsonb_build_object('healed', now(), 'by', 'link sweep'),
    updated_at = now()
WHERE id = <session id> AND coalesce(link_confidence, 'unlinked') <> 'exact';

-- C3, same statement family: the children follow the healed date
UPDATE claude_decision_log d SET decision_date = s.session_date, date_confidence = 'exact'
FROM claude_session_logs s WHERE s.id = d.session_id AND s.id = <session id> AND s.date_confidence = 'exact';
UPDATE claude_known_issues i SET reported_date = s.session_date, date_confidence = 'exact'
FROM claude_session_logs s WHERE s.id = i.reported_session_id AND s.id = <session id> AND s.date_confidence = 'exact';

INSERT INTO claude_transcript_ledger (chat_url, chat_title, chat_updated_at, session_id, disposition, reviewed_at, notes)
VALUES ('<url>', '<title>', '<updated_at>', <session id>, 'linked', now(), 'link sweep YYYY-MM-DD')
ON CONFLICT (chat_url) DO UPDATE SET session_id = EXCLUDED.session_id, disposition = 'linked', reviewed_at = now()
WHERE claude_transcript_ledger.session_id IS NULL;
```

## 7. JSONB Field Schemas

### workflows_touched

```json
[
  {
    "id": "407ec6f2-1f90-45d7-b95d-52584b688d9c",
    "name": "W0.0 - Master Router",
    "action": "modified",
    "steps_before": 130,
    "steps_after": 131,
    "changes": "Added High-Intent Digital branch"
  }
]
```

### phase_status

```json
{
  "phase_0": "complete",
  "phase_1": "complete",
  "phase_2": "in_progress",
  "phase_3": "not_started",
  "phase_4": "not_started",
  "phase_5": "not_started",
  "phase_6": "not_started"
}
```

### board_versions

```json
{
  "board_a": "v5.14 FINAL",
  "board_b": "v6.14 FINAL",
  "board_c": "v2.1 FINAL"
}
```

### mcp_verified_ids

```json
{
  "W0.0": "407ec6f2-1f90-45d7-b95d-52584b688d9c",
  "W0.1": "85f4600a-a55d-4fb5-bd62-d2886dc3d461",
  "pipeline_1": "x0cxXOkKwqAWVvcPdKZQ"
}
```

### next_steps

> **Deprecated in v4 (2026-09-05).** Write `[]` here; use the table (§2a / §3 / §4). Shape kept for reading the 690 pre-v4 rows.

```json
[
  {
    "priority": 1,
    "action": "Build W0.7 High-Intent Digital workflow shell",
    "blocked_by": null,
    "effort": "15 min"
  },
  {
    "priority": 2,
    "action": "Verify all 7 branches with test contacts",
    "blocked_by": "W0.7 shell creation",
    "effort": "30 min"
  }
]
```

### pending_items

> **Deprecated in v4 (2026-09-05).** Write `[]` here; use the table (§2a / §3 / §4). Shape kept for reading the 690 pre-v4 rows.

```json
[
  {
    "type": "decision_needed",
    "description": "High-Intent Digital source identification method",
    "options": ["UTM-based", "Tag-based", "Lead Source field"],
    "blocking": "W0.0 7th branch"
  },
  {
    "type": "verification_needed",
    "description": "Confirm W3.0 exit target is correct",
    "workflow_id": "673b0fa7"
  }
]
```

### decisions_made (inline in session log)

> **Deprecated in v4 (2026-09-05).** Write `[]` here; use the table (§2a / §3 / §4). Shape kept for reading the 690 pre-v4 rows.

```json
[
  {
    "category": "architecture",
    "decision": "W0.3 uses customer/DQ gate before buyer journey content",
    "rationale": "Existing customers entering chatbot were receiving Stage 1 marketing"
  }
]
```

### transcript_search_keys

Flat array of short verbatim strings that appeared in the conversation.
5-8 entries, each 1-4 words. Every entry must be traceable to actual
conversation text — never a paraphrase.

```json
[
  "S4.5",
  "claude_transcript_ledger",
  "Contractor Connect",
  "407ec6f2",
  "Data status orphans",
  "select.js"
]
```

Avoid generic terms (`workflow`, `sync`, `fix`, `report`) — they match
everything and are worthless as keys.

### issues_found / issues_resolved (inline in session log)

> **Deprecated in v4 (2026-09-05).** Write `[]` here; use the table (§2a / §3 / §4). Shape kept for reading the 690 pre-v4 rows.

```json
[
  {
    "severity": "high",
    "category": "routing",
    "description": "W1.0 missing success path to W3.0",
    "workflow_id": "5dc8f50f"
  }
]
```

---

## 8. SQL Escaping Rules

When building INSERT/UPDATE queries:
- **Single quotes in text:** `'` → `''` (double single quote). This is the most common escaping need.
- **JSONB fields:** Build the JSON object first, serialize it, then escape any single quotes inside the JSON string.
- **Dates:** Use ISO format `YYYY-MM-DD`
- **Booleans:** Use `true` / `false` (lowercase, no quotes)
- **NULLs:** Use `NULL` (no quotes)
- **Newlines in text:** Replace `\n` with space or use `E'...\n...'` escaped string syntax
- **Double quotes in JSON:** These are fine inside JSONB — JSON uses double quotes natively. Only single quotes need escaping for the SQL wrapper.

### Common Escaping Pitfall

Apostrophes in text values break the INSERT. Postgres delimits string literals
with single quotes, so an apostrophe inside the text terminates the literal
early and the rest is parsed as SQL:

```sql
-- FAILS: the apostrophe in "Mark's" ends the string literal early
INSERT INTO claude_session_logs (session_title, raw_summary)
VALUES ('Board sync', 'Rebuilt Mark's workflow routing')

-- WORKS: the apostrophe is doubled inside the literal
INSERT INTO claude_session_logs (session_title, raw_summary)
VALUES ('Board sync', 'Rebuilt Mark''s workflow routing')
```

The doubled `''` is Postgres escape syntax, not a typo. It is stored and read
back as a single apostrophe — the saved value is `Rebuilt Mark's workflow
routing`. This applies to every text and JSONB field in all four tables.

### Testing a Query

Before writing a complex INSERT, test with a simple one first:
```sql
INSERT INTO claude_session_logs (session_date, session_title) 
VALUES ('2026-03-21', 'Test Entry') 
RETURNING id
```
If that works, the tables are properly created and writable.
