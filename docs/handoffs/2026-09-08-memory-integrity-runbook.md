# Memory integrity — apply, shadow, cleanup runbook

**PR:** `claude/memory-integrity-system-br8pf5` · **Migration:** `sql/098_memory_integrity.sql` · **Database:** LP Supabase `rcjcgjlqzepicbwhnnjl`
**Rule:** mark, never delete. Every statement below adds a status or a pointer. Nothing is dropped except the two function signatures sql/098 recreates.

## 1. Apply sql/098 (Mark approves, then LP MCP `supabase_run_query`)

Apply the file section by section. Every statement is idempotent; re-running a section is safe.

| Section | What | Note |
|---|---|---|
| A | columns on sessions / decisions / issues / embeddings | plain `ADD COLUMN IF NOT EXISTS` |
| B | `claude_memory_conflicts`, `claude_memory_validation_log` | empty tables |
| C | `claude_guard_session_insert()` + trigger; `claude_inherit_provenance()` + 2 triggers | always on; the batch rule marks, the retro rule rejects a retro row without a source |
| D | `match_memory_embeddings`, `claude_memory_search` | the two `DROP FUNCTION IF EXISTS` statements need `confirm_destructive: true` — they are signature changes, recreated in the same section |
| E | `claude_memory_context()` v5 | pack: write_date demotion on decisions / issues, `open_conflicts`, four new counts |

Verify with the query at the bottom of the file: 3 triggers, 2 tables, 3 session columns, `claude_memory_search` with 3 args, `last_session` still `exact`, pack 25–40k characters.

Smoke test the guard inside a transaction: `INSERT INTO claude_session_logs (session_title, log_origin) VALUES ('x','retro')` must fail with *retro session requires chat_url and source_chat_updated_at*. Then `ROLLBACK`.

## 2. Deploy and env (Railway, LP MCP service)

Add, leave everything else as is:

```
MEMORY_GUARD_MODE=shadow            # flip to live after 48 h of clean guard rows
MEMORY_CONFLICT_THRESHOLD=0.85      # code default; tune without a deploy
MEMORY_ISSUE_DUPLICATE_THRESHOLD=0.90
```

Boot log should read `[MemorySchema] sql/090–098 present` and list `memory_precheck` among the MCP tools. If it says `MISSING: 098_memory_integrity.sql`, section 1 was not applied (do not set `MEMORY_MIGRATIONS_AUTOAPPLY` — apply by hand).

## 3. Shadow window (48 h)

```sql
SELECT json_agg(row_to_json(g)) FROM (
  SELECT ran_at, check_name, rows_checked, rows_flagged, sample, notes
  FROM claude_memory_validation_log WHERE check_name LIKE 'guard:%' ORDER BY ran_at DESC LIMIT 50
) g
```

- `guard:batch_pattern` rows = live checkpoints that would have been refused (3+ in 5 min). Expect zero outside sweeps.
- `guard:conflict` rows = decisions written without naming a ≥ 0.85 active match. Read `sample.nearest`; if the matches are real duplicates the rule is right, if they are different subjects lower nothing — raise `MEMORY_CONFLICT_THRESHOLD` to 0.88 and watch another day.

Then `MEMORY_GUARD_MODE=live`. Rollback at any point: `MEMORY_GUARD_MODE=off`; `DROP TRIGGER trg_claude_guard_session_insert ON claude_session_logs` if the DB-side retro rule has to go too.

## 4. First validation and conflict pass

```
POST /admin/memory/validate {"dry_run": true}            # logs every check, changes nothing
POST /admin/memory/validate {"dry_run": false, "full": true}   # repairs (metadata sync, orphan flags) + files ALL conflict pairs (batches C4 + C5)
```

Expect 40–80 decision pairs and 30–60 issue pairs in `claude_memory_conflicts`. Rule on them with the SQL in the skill's `references/queries.md` §6a, one screen at a time.

## 5. Cleanup batches (each shown before written)

**C1 — sweep children (Mark, one "go").** 101 decisions + 144 issues under sessions 705–781 still say `origin='live'`.

```sql
-- preview
SELECT json_agg(row_to_json(x)) FROM (
  SELECT 'decision' AS kind, d.id, s.id AS session_id, s.date_confidence FROM claude_decision_log d JOIN claude_session_logs s ON s.id = d.session_id
  WHERE s.id BETWEEN 705 AND 781 AND s.log_origin = 'retro' AND d.origin = 'live'
  UNION ALL
  SELECT 'issue', i.id, s.id, s.date_confidence FROM claude_known_issues i JOIN claude_session_logs s ON s.id = i.reported_session_id
  WHERE s.id BETWEEN 705 AND 781 AND s.log_origin = 'retro' AND i.origin = 'live'
) x;
-- write (245 rows expected)
UPDATE claude_decision_log d SET origin = 'retro', confidence = 'reconstructed', date_confidence = s.date_confidence
FROM claude_session_logs s WHERE s.id = d.session_id AND s.id BETWEEN 705 AND 781 AND s.log_origin = 'retro' AND d.origin = 'live';
UPDATE claude_known_issues i SET origin = 'retro', confidence = 'reconstructed', date_confidence = s.date_confidence, updated_at = now()
FROM claude_session_logs s WHERE s.id = i.reported_session_id AND s.id BETWEEN 705 AND 781 AND s.log_origin = 'retro' AND i.origin = 'live';
```

The `provenance_mismatch_children` validation check reads 0 afterwards. The next nightly re-syncs the embedding metadata so those rows drop out of the default search ranking as `retro` / `write_date`.

**C2 / C3 — link the ~150 unlinked chat sessions.** Runs from a chat inside each project (chatbot project separately): `conversation_search` on each row's `transcript_search_keys`, match on title, then the C2 statement in `queries.md` §6a (session heal + C3 children + ledger row). One chat links to one session (ledger PK); on a double match link the fuller row and report the other. Never overwrite an `exact` link. Report the batch per project before writing.

**C7 — workflow_code backfill (batch list first).**

```sql
-- preview: name matches ≥ 0.6 (pg_trgm)
SELECT json_agg(row_to_json(x)) FROM (
  SELECT d.id, d.workflow_name, r.canonical_code, r.canonical_name, round(similarity(lower(r.canonical_name), lower(d.workflow_name))::numeric, 2) AS sim
  FROM claude_decision_log d
  JOIN LATERAL (SELECT canonical_code, canonical_name FROM claude_workflow_ref r
                WHERE similarity(lower(r.canonical_name), lower(d.workflow_name)) >= 0.6
                ORDER BY similarity(lower(r.canonical_name), lower(d.workflow_name)) DESC LIMIT 1) r ON true
  WHERE d.workflow_code IS NULL AND d.workflow_name IS NOT NULL
  ORDER BY sim DESC
) x;
-- write
UPDATE claude_decision_log d
SET workflow_code = (SELECT canonical_code FROM claude_workflow_ref r
                     WHERE similarity(lower(r.canonical_name), lower(d.workflow_name)) >= 0.6
                     ORDER BY similarity(lower(r.canonical_name), lower(d.workflow_name)) DESC LIMIT 1)
WHERE d.workflow_code IS NULL AND d.workflow_name IS NOT NULL
  AND EXISTS (SELECT 1 FROM claude_workflow_ref r WHERE similarity(lower(r.canonical_name), lower(d.workflow_name)) >= 0.6);
```

**C8 — keyless decisions inherit the parent session's keys (automatic).**

```sql
UPDATE claude_decision_log d SET transcript_search_keys = s.transcript_search_keys
FROM claude_session_logs s
WHERE s.id = d.session_id
  AND (d.transcript_search_keys IS NULL OR d.transcript_search_keys = '[]'::jsonb)
  AND jsonb_array_length(coalesce(s.transcript_search_keys, '[]'::jsonb)) > 0;
```

**C4 / C5 — conflicts and issue duplicates.** Filed by section 4; ruled screen by screen (§6a SQL).

**C6 — 607 stale open issues (Mark, five screens of ~120 by area).** Standing ruling: unfixed stays open. Per row: `resolved` (with `verified_at`, `verification_note`), `wont_fix`, or stays open with `verified_at = now()` (clears `stale`).

```sql
SELECT json_agg(row_to_json(x)) FROM (
  SELECT id, severity, area, left(description, 140) AS description, reported_date, origin
  FROM claude_known_issues WHERE status IN ('open','in_progress') AND stale AND area = '<area>'
  ORDER BY severity, reported_date LIMIT 120
) x;
```

**C9 — memory files vs. latest session (read-only diff, ~47 files).** For each `/areas/*` and `/people/*` file, `memory_search` on the subject, compare with the newest session that mentions it, list disagreements. Nothing written until Mark rules.

Order: C1 → C2/C3 → C7/C8 → C4/C5 → C6/C9.

## 6. Testing plan status (handoff §11)

| Test | Where |
|---|---|
| live session with 3 more in the last 5 min → retro / write_date / flagged | trigger (sql/098 C) + tool guard; `scripts/test-memory-integrity.js` covers the tool side |
| retro without chat_url → rejected with the guard message | tool (`RETRO_SOURCE_MESSAGE`) and trigger; tested |
| retro with source → retro, dated from the chat, ledger in one sequence, exact link | tested |
| date in the future / > 400 days → rejected | tested |
| new decision cosine 0.9, no supersedes_id → rejected naming the id (live) / logged (shadow) | tested |
| same with supersedes_id → inserted, old row superseded; same_as_id → re-confirmed, nothing inserted | tested |
| `memory_search("quiet hours clamp")` hides superseded / duplicate unless include_closed | sql/098 D + `memory-search.js`; verify live after apply |
| `claude_memory_context('memory system')` last_session ≤ 704 while 705–781 are write_date; no sweep issue in top 25 | sql/098 E keeps the sql/097 rules; verify live after apply |
| `POST /admin/memory/validate {"dry_run": true}` → log rows, zero data changes | tested (route + job) |
| nightly real run → pairs filed, coverage 100 %, digest with three new sections | first night after apply; `GET /admin/memory/nightly/status` |
| `scripts/test-memory-integrity.js` twice → identical | pure tests; run twice |
| reversibility: flip one ruling back | §6a "Reverse a ruling" |

## 7. Dashboard tile (separate PR after this one merges)

`reece-dashboard`: one tile reading `claude_memory_validation_log` (latest row per check) plus `claude_memory_context(NULL)->'counts'`: unlinked sessions · write_date rows · open conflicts · embedding coverage % · pack token size · median `memory_search` latency (`memory_vector_queries`). Green when unlinked ≤ 5, write_date = 0, conflicts ≤ 10, coverage 100 %, pack ≤ 9k tokens.

---

## Addendum — 2026-09-10: provenance inheritance narrowed (sql/100)

Mark's ruling, after 95 rows were restored by hand on 09-09: **a refresh's new
rows are live and confirmed even under a reconstructed session.** Confirmed
beats reconstructed.

The sql/098 `claude_inherit_provenance()` trigger copied a retro parent's
`origin` / `confidence` onto every child it ever received, including children
appended weeks later by a live refresh. sql/100 scopes inheritance to the
parent's own checkpoint window (5 minutes, the same constant as
`BATCH_WINDOW_MINUTES`): a retro checkpoint's own children still inherit, a
later append keeps what its caller gave it. `date_confidence` follows the same
window, because inside it the child is dated from the session and outside it the
child is dated the day it was actually decided.

The nightly `provenance_mismatch_children` check uses the same window and
reports legitimate refresh children under `sample.refresh_children_excluded`
rather than flagging them, so it reads 0 instead of 95 once applied.

No existing row is rewritten by sql/100 — the 95 keep the provenance the ruling
gave them. Rollback: re-run the `claude_inherit_provenance()` block in sql/098
section C.

---

## Addendum — 2026-09-15: the link sweep could not reach its own backlog (C2/C3)

64 sessions stayed `link_confidence='unlinked'` through repeated sweeps while
the nightly count of checked rows kept rising. The sweep was not failing — it
was looking at the complement of the problem.

**Three defects, all fixed in the skill and its query reference:**

1. **Disjoint windows.** Mechanism 2 step 1 asked for unlinked sessions
   `created_at > now() - interval '7 days'`; the nightly `unlinked_sessions_7d`
   check flags `created_at < now() - interval '7 days'`. No sweep could ever
   touch a flagged row. The sweep now has no age window (`queries.md` §4b lost
   its 60-day bound too), and the check's `rows_checked` stays windowless so it
   agrees with the pack's `unlinked_sessions` count. **Keep them aligned.**
2. **The wrong matcher.** Step 3 matched `recent_chats.updated_at` to the
   session's `created_at` within 3 minutes. For a sweep-written row `created_at`
   is the *write* date, so the rule was comparing against the wrong clock
   entirely — and `recent_chats` pages back only ~100 chats, far short of an
   August backlog. `conversation_search` on `transcript_search_keys` is now the
   primary matcher (works at any age); the timestamp rule is a fallback for live
   rows only. The check's `sample` now carries the search keys, so it is the
   sweep's worklist.
3. **The heal would have corrupted dates.** The §6a C2 statement set
   `session_date` from the chat's `updated_at` for every row it healed, guarded
   only on `link_confidence`. Most of the 64 already carry a correct
   `date_confidence='exact'` date reconstructed from their first user message,
   and a chat's `updated_at` is its *last* activity. It is now two statements:
   the link write always runs, the date write is guarded by
   `date_confidence='write_date'`. The C3 child statements carry the same guard,
   so a decision appended later by a live refresh keeps its own date (sql/100
   ruling).

Running C2 now: one chat per project (both `recent_chats` and
`conversation_search` are project-scoped), report the batch per project before
writing, one chat links to one session, never overwrite an `exact` link, never
re-date a row that already says `exact`.

**The 32 unlinkable sessions (Mark's ruling, 2026-09-15).** With the sweep fixed,
the overdue backlog read 109, and it split in two: 77 rows carry
`transcript_search_keys` and are C2's batch; 32 rows (4/15 – 8/01) were written
before search keys existed and their chats are months beyond `recent_chats`
reach, so no pass will ever link them. Leaving them flagged would pin the alarm
permanently and hide a genuinely new unlinked session.

They are marked, not deleted, and not moved out of `unlinked`:
`link_confidence` stays `unlinked` (it is the truth) and the ruling goes in
`validation_notes->>'link_unlinkable'`. `link_confidence` has a CHECK
constraint (`exact` | `inferred` | `unlinked`), so a new value there would need
a migration and would ripple into every query and doc reading the column;
`validation_notes` is already the field used for marks of this kind
(`duplicate_of`, `reason`, `ruling`). The nightly check excludes marked rows
from `rows_flagged` and from the worklist sample, but still counts them in
`rows_checked`. Reversible: strip the key and the row reappears in the alarm.
The mark is about absent keys, not a permanent exemption — a row that later
gains keys or a URL is picked up again.

---

## Addendum — 2026-09-15 (2): the first real C2 run, and what it found

The sweep ran in Reece Marketing & Funnel Builder and wrote nothing. Both causes
are now fixed; a third finding overturned the sweep's own diagnosis.

**1. The worklist was contaminated.** 43 of 231 unlinked-with-keys rows are
`[FOLDED → #NNN]` — folded into another session, so their chat belongs to that
other row and every match is a false positive. `queries.md` §4b and
`unlinked_sessions_7d` now both exclude them, and both carry the alignment
reminder: filtering one and not the other *is* the v4.6 bug in mirror image.

**2. The matcher had no identity test.** Topical keys (`E.2-VC`, `Bot 5`) match
every session on a long-running subject, so three September sessions surfaced
spring chats that were already linked. Mechanism 2 step 2 now runs three gates:
one up-front set of already-claimed `chat_url`s (not a per-candidate lookup), a
date gate comparing **in ET** — `updated_at` is UTC, `session_date` is an ET
date, so raw comparison is an off-by-one that rejects a chat active late the
previous evening — and a stricter rule for `write_date` rows, which cannot be
date-gated at all (their `session_date` *is* the write date) and must be
confirmed by opening the chat.

**3. The twin theory was wrong, and folding would have destroyed real work.**
The sweep inferred from three refusals that most of the backlog were duplicates.
Key-set overlap across all 188 candidates says otherwise: 4 rows at ≥0.60, 21 at
0.40–0.60, **163 with no strong twin**. All four ≥0.60 pairs are a spring retro
row against a September live row, and every one of those retro dates is
corroborated to the day by its ledger `chat_updated_at` (367 Mar 11, 434 Apr 7,
462 Apr 18, 516 May 7, 521 May 8). Mark ruled: separate sessions months apart on
the same long-running subject. **No twin folding.** The one genuine duplicate is
1035/1037 — same day, 27 minutes apart, both live.

**A NULL trap caught in testing.** The first version of the folded filter used a
bare `NOT (validation_notes ? 'folded_into')`. `validation_notes` is NULL on 77
of the 78 overdue rows, and `NULL ? 'k'` is NULL, not false — so the WHERE
dropped every one of them and `rows_flagged` read 0 instead of 77. A clean-looking
alarm hiding all the work. Every jsonb existence test here is now
coalesce-wrapped, with a test asserting it stays that way.

**Still open:** the ~144 clean candidates need per-project sweep chats, and
nothing on a session row says which project its chat lives in. `area` is
populated on all 188 and partitions them well (chatbot-lane 51, calculator-lane
18, scorecard-reporting 16, appointments 14, lp-ghl-sync 13, …), so the cheap fix
is a one-time area→project map rather than 188 judgements, plus a `project`
column written at checkpoint time going forward.

---

## Addendum — 2026-09-16: the stale column, and the shared-chat population

**The 24-row clear landed.** Unlinked-with-keys 232 → 256, clean candidates
188 → 212, 619 `exact` links untouched, 876 and 855 held as ruled. The cause was
a positional zip: sorted sessions matched against sorted chats, attaching
September sessions to spring chats other sessions own.

**Gate B was reading the wrong column.** `claude_transcript_ledger.chat_updated_at`
is the value at *review* time. A reopened chat keeps its old value, so a gate
reading it rejects every reopened chat permanently — it would have refused session
876's own correct link (ledger Mar 27; live search Sep 9 20:46 UTC, same day as
the session). Gate B now names the live `conversation_search` / `recent_chats`
value, and the stored column is marked history-only at §4b and at the re-open
statement. Never gate on it.

**The shared-chat population: 66 chats, not 92.** The 92 was pair-count inflated
by groups of three or more.

| Group span | Chats | Nature |
|---|---|---|
| Same day | 30 | double-checkpoints (the 1035/1037 pattern) |
| 1–30 days | 12 | ambiguous |
| Months apart | 24 (27 pairs) | reopen vs mis-link |

**A key-overlap proxy split the 27 as 19 reopen / 8 mis-link, and it is not
trustworthy.** It scored 876 a mis-link at 0.00 overlap when 876 is a proven
reopen: the September session simply extracted different search keys for the same
chat, so overlap measures whether two checkpointers picked similar words, not
whether it is the same conversation. Treat 8 as an upper bound on mis-links. The
definitive split needs live timestamps and therefore runs from a chat, not from
Claude Code.

**16 groups hold two `exact` links** (e.g. 939/968/971/973/974 against 234–237).
Two sessions both claiming `exact` on one chat is a state the schema says cannot
happen, which is the real question surfacing: if reopens are common, "one chat,
one session" is wrong as a schema rule and the ledger's `chat_url` primary key
cannot express the alternative. Refresh-only would fold ~19+ September sessions
into spring rows — destroying real work, one-directionally. Many-sessions-per-chat
is truthful but is a v4.0 LOCKED migration and Mark's ruling. **Nothing is folded
until the live-timestamp table exists.**

---

## Addendum — 2026-09-16 (3): the reopen verdict, session.project, and the C2 search order

**The schema question is settled empirically.** Mark ran the 27-pair
live-timestamp split himself: **20 of 27 resolved, every one a reopen, zero
mis-links.** Seven remain only because their chats live in projects unreachable
from one chat (798/227, 799/226, 800/228, 945/459, 1045/506, 1054/510, 1056/512).
**Do not re-run the split.**

That is stronger than the key-overlap proxy suggested and in the same direction:
reopens are not merely the larger bucket, they are the only bucket observed. So
"one chat, one session" is wrong as a *schema rule*, not as data hygiene, and the
ledger's `chat_url` primary key cannot express the alternative. The fork —
refresh-only versus a primary-plus-siblings ledger — is answerable now but is a
v4.0 LOCKED migration and stays Mark's ruling. 876 and the three remaining held
rows (798/227, 800/228, 945/459) all wait on it; they are the same question.
947/457 resolved as a reopen and is no longer held.

**Root cause of the C2 cost: no project field.** `memory_checkpoint` never
recorded which Claude project a chat lived in, and `conversation_search` is
project-scoped. sql/115 adds `claude_session_logs.project`, written at checkpoint
time (skill v4.9). Free text, not an enum — project names change, and a CHECK
here would repeat the `link_confidence` problem. Nothing is backfilled: an absent
project is the truth for an old row.

**The area→project table is a SEARCH ORDER, not an assignment.** Each sweep chat
already knows its own project implicitly, because search only returns that
project's chats. Roughly 12 chats × 3 probe searches from the largest areas' most
distinctive keys discovers the partition empirically; write the discovered project
onto whatever hits. Do not assign 189 rows by inference.

| area | n | probable project |
|---|---|---|
| chatbot-lane | **51** | GHL Chatbot — **see blocker below** |
| calculator-lane | 18 | Window Calculator · ROI Calculator |
| scorecard-reporting | 16 | Reece Daily Ops · Reece Call Center |
| appointments | 14 | Reece Lead Routing · Reece Daily Ops |
| lp-ghl-sync | 13 | MCP GHL-Notion · n8n Workflow Architect |
| agentic-engine | 11 | Reece n8n Workflow Architect |
| content-copy | 10 | Reece Email Writer |
| partners-vendors | 10 | Reece Daily Ops |
| general | 9 | **unassignable — leave last** |
| infrastructure | 7 | Memory System Optimization · n8n |
| objections-rescue | 6 | Reece Lead Routing |
| routing-workflows | 6 | Reece Lead Routing |
| memory-system | 3 | Memory System Optimization |
| five9-dialer | 3 | Reece Call Center |
| lead-intake | 3 | Reece Lead Routing |
| canvassing | 3 | Reece Lead Routing |
| nurture-reengagement | 3 | Reece Email Writer |
| call-intelligence | 2 | Reece Call Center |
| payroll-callcenter | 1 | CC Payroll — Weekly |

**Blocker, resolve before starting: chatbot-lane is 51 rows — a quarter of the
backlog — and its project is not visible from Mark's current chat list.** No
sweep method reaches those rows until that access gap is closed, so settle it
first rather than discovering it mid-pass. `general` (9) is unassignable by
design; expect some of it to stay unlinked permanently.
