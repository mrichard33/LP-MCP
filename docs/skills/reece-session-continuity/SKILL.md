---
name: reece-session-continuity
description: "Use this skill at the START and END of every working session for the Reece Windows & Doors Antifragile Sales System project. Trigger on: beginning of a new conversation where prior context would help, any mention of 'save session', 'session summary', 'where did we leave off', 'what did we do last time', 'continue from last session', 'log this decision', 'track this issue', or end-of-session requests to capture progress. Also trigger when Mark says 'save state', 'checkpoint', or 'wrap up'. ALSO trigger on requests to reconcile checkpoints against past chats: 'which chats never got saved', 'find the chat where we decided X', 'link this session', 'retro-checkpoint', 'what am I missing across chats', or any decision drawing on combined work from many conversations. Persists session context to Supabase, links each checkpoint to the chat transcript that produced it, and restores both at session start. Do NOT use for general note-taking or non-project documentation."
---

# Reece Session Continuity — Persistent Context Across Conversations

## Overview

> **v4.8 — 2026-09-16.** Gate B said "`updated_at`" without saying which one. `claude_transcript_ledger.chat_updated_at` is the value **at review time**, so a reopened chat keeps its old value — and a gate reading that column rejects every reopened chat, permanently. Session 876 is the case: the ledger says Mar 27, live `conversation_search` returned Sep 9 20:46 UTC, the same day as the session. Read from the ledger, 876's own correct link is refused forever. Worse, a stale value plus a reopen is indistinguishable from a mis-link, so the whole reopen class gets misread as bad data. Gate B now names the **live** value from the `conversation_search` / `recent_chats` result, and the stored column is marked history-only in §4b and at the re-open statement. Sizing the shared-chat population found 66 chats claimed by more than one session — 30 same-day double-checkpoints, 12 within a month, 27 pairs months apart — and 16 groups where **two** rows hold `exact`, a state the schema says cannot happen. Whether one chat may own many sessions is Mark's ruling; nothing is folded until the live-timestamp split exists.
>
> **v4.7 — 2026-09-15.** The first real C2 run wrote nothing, for two reasons. (a) **The worklist was contaminated:** 43 `[FOLDED → #NNN]` rows sat in it, and a folded row's chat belongs to the row it was folded into, so every match found for one is a false positive. `references/queries.md` §4b and the nightly check now both exclude them — *both*, because filtering one and not the other is the v4.6 bug in mirror image. (b) **The matcher had no identity test.** Topical keys match every session on a long-running subject, so three September sessions surfaced spring chats that were already linked. Mechanism 2 step 2 now runs three gates: an up-front set of already-claimed `chat_url`s, a date gate comparing in **ET** (`updated_at` is UTC, `session_date` is an ET date — comparing raw is an off-by-one), and a stricter rule for `write_date` rows, which cannot be date-gated at all and must be confirmed by opening the chat. Investigating also **disproved** a twin theory: only 4 of 188 candidates overlap a linked session by ≥0.60, and Mark ruled those are separate sessions months apart on the same subject. Folding them would have destroyed real work.
>
> **v4.6 — 2026-09-15.** The link sweep was structurally unable to do its job. Mechanism 2 asked for unlinked sessions *newer* than 7 days while the nightly `unlinked_sessions_7d` check flagged those *older* than 7 days — complementary sets, so a sweep could never reach a flagged row, and 64 sessions stayed unlinked through repeated sweeps. Three changes. (a) **No age window in the sweep** — it queries every unlinked `surface='chat'` row, oldest first; the check's `sample` now carries `transcript_search_keys` so it is the sweep's worklist. Keep the two aligned. (b) **Search keys are the primary matcher, timestamps a fallback** — `conversation_search` on `transcript_search_keys` works at any age, while the `recent_chats` ±3-minute rule only holds for a row written live (a sweep-written row's `created_at` is the write date, not the conversation date) and cannot page back far enough for a backlog. (c) **A heal never re-dates a row that is already `exact`** — the C2 statement in `references/queries.md` §6a is split into a link write (always) and a date write guarded by `date_confidence='write_date'`; as written before it would have silently moved 60-odd correct session dates to their chat's last-activity date.
>
> **v4.5 — 2026-09-10.** Mark's ruling, now enforced in the database (LP-MCP `sql/100`): **a refresh's new rows are live and confirmed, even under a reconstructed session.** Confirmed beats reconstructed. The `sql/098` inherit trigger used to copy a retro session's `origin`/`confidence` onto every child it ever received, so a decision Mark stated today in a reopened chat was silently filed as `retro` / `reconstructed` — 95 rows had to be restored by hand on 09-09. Inheritance is now scoped to the parent's own checkpoint window (5 minutes): children written in the same sequence as a retro session still inherit, a later append keeps what its caller gave it. The nightly `provenance_mismatch_children` check follows the same window and reports legitimate refresh children under `sample.refresh_children_excluded` instead of flagging them. Nothing changes in what you pass — the tool already stamps retro children correctly; this stops the database from overruling you.
>
> **v4.4 — 2026-09-08.** The write door now checks provenance (LP-MCP `sql/098`, PR "memory integrity"). Four changes. (a) **Retro mode is the only path for a chat found through search:** `memory_checkpoint({ mode: "retro", source: { chat_url, chat_title, chat_updated_at }, … })`. The tool stamps `log_origin='retro'`, dates the session from `chat_updated_at`, writes the ledger row in the same call, and defaults every decision to `confidence='reconstructed'` unless you pass `confirmed_by_mark: true` for a Mark quote. Retro without a source is rejected — *"retro session requires chat_url and source_chat_updated_at"*. The sweep prompt is now one line (Part 3). (b) **Date sanity:** a `date` in the future or more than 400 days back is rejected on every checkpoint. (c) **One subject, one active decision:** if the nearest active decision scores ≥ 0.85 (cosine) the tool requires `supersedes_id` (replace it) or `same_as_id` (re-confirm it, nothing inserted). `MEMORY_GUARD_MODE=shadow` logs these for 48 h, then `live` rejects. The same guard relabels 3+ "live" checkpoints inside 5 minutes as retro / write_date / flagged — a burst is a sweep, not a session. (d) **`memory_precheck(proposal_text, area)`** — "have we already decided this, and did Mark ever reject it?" — is step 0 before any proposal (Part 4). The nightly job now also validates the tier (unlinked > 7 d, write_date rows, batch pattern, embedding coverage / orphans / drift, open conflicts), files near-duplicate decision pairs in `claude_memory_conflicts` for Mark's ruling, and drafts a session (`origin='nightly'`) for every ledger row left `deferred` with no session. `memory_search` hides superseded / rejected / expired / resolved rows unless `include_closed: true`.
>
> **v4.3 — 2026-09-07.** Two fixes from the first sweep pass (80 chats checkpointed on 9/6–9/7 with no URL, no ledger row, and today's date). (a) **Session date for a reopened chat is the date on its FIRST user message** — the `The current date is …` line that Claude sees attached to the opening turn — never today. If that line is not visible, pass `date_confidence: "write_date"` so the context pack knows not to rank it as recent. (b) **The auto-link pass is now mandatory at every session start and every checkpoint on the chat surface** (Part 1, Mechanism 2): `recent_chats` is compared to every unlinked session written in the last 7 days, matched on timestamp (±3 min, nearest wins, title similarity breaks ties), and the URL, `chat_title`, `link_confidence='inferred'` and a `linked` ledger row are written in one UPDATE. Claude still cannot see its own chat's URL, so each chat gets linked by the *next* chat opened in the same project. "Link sweep" is the command to run only that pass. New column: `claude_session_logs.date_confidence` (`exact` / `write_date`).
>
> **v4.2 — 2026-09-06.** The MCP tools replace hand-written SQL for the three moments. Session start is ONE call, `LP MCP:memory_context(topic)`. Session end, mid-session checkpoint, and refresh are ONE call, `LP MCP:memory_checkpoint(...)` — pass `session_id` to refresh, omit it for a new session; it never creates a second row for the same chat. Search is `LP MCP:memory_search(query)` — full-text plus vector (`MEMORY_VECTOR_MODE=live` since 2026-09-06), so plain-language questions work. The SQL in `references/queries.md` is now the **fallback**, used only when a tool call fails twice. The nightly job (LP-MCP `src/jobs/memory-nightly.js`) flags stale issues, re-embeds changed rows, and — once the auto-close handoff ships — expires old next steps; items that need Mark's ruling are never auto-closed. See "Automatic lifecycle" in Part 5.
>
> **v4.1 — 2026-09-06.** Two additions. (a) **Refresh an existing checkpoint** (Part 2, Moment 2b): re-opening a chat that already has a session row UPDATEs that row and never inserts a second one — Mark names the session number at the top. (b) **workflow_code** on new decisions and issues, looked up from `claude_workflow_ref` (LP-MCP `sql/092`). `area` is now filled by a database trigger (`sql/093`) — never set it by hand unless overriding.
>
> **v4 — 2026-09-05.** Session end no longer writes decisions / issues / pending items into the session JSON — they go to `claude_decision_log`, `claude_known_issues` and the new `claude_pending_items` table, and the session row keeps only the narrative and pointers. Closing an item is an UPDATE, never a re-paste. Issues carry `issue_type`, `stale`, `verified_at`, `merged_into`; decisions carry `status` / `superseded_by`. Schema: LP-MCP `sql/091`.
>
> **v3 — 2026-09-06.** Session start is now ONE call, `claude_memory_context('<topic>')` (~8k tokens), instead of three queries. The old "load all open issues" query is retired: after the retro-history promotion it returns ~160k tokens and must never be run without a `LIMIT`. Ranked full-text search is `claude_memory_search('<query>')`. Both live in LP-MCP `sql/090`. Every decision and issue row now carries `origin` (`live` / `retro`) and `confidence` (`confirmed` / `reconstructed`).

Context loss between conversations is the #1 efficiency killer in this project. Every working session produces decisions, workflow changes, verified IDs, discovered issues, and next steps — all of which evaporate when the conversation ends. This skill solves that by persisting structured session data to Supabase, and restoring it at the start of every new session.

There is a second, subtler failure mode: **a session that was never checkpointed leaves no trace in Supabase at all.** The work exists only in the chat transcript. Any decision made from "what's in Supabase" is therefore made on partial state. The transcript bridge (below) closes that gap by making checkpoints and transcripts cross-reference each other.

The system uses four tables in the LP MCP Supabase instance:
- `claude_session_logs` — one row per session with structured + freeform context
- `claude_decision_log` — every architectural decision, searchable across sessions
- `claude_known_issues` — persistent issue tracker, issues stay open until resolved
- `claude_transcript_ledger` — one row per reviewed chat, linking transcripts to checkpoints

Since v4.2 the three moments use three LP MCP tools — `memory_context`, `memory_checkpoint`, `memory_search` — and since v4.4 a fourth, `memory_precheck`, runs before any proposal. If a tool is not in the tool list, run `tool_search` for `memory_checkpoint` to load all four. `LP MCP:supabase_run_query` and the SQL in `references/queries.md` remain as the fallback path (see "Fallback rule" below).

### Fallback rule

The LP MCP transport has dropped tool calls mid-turn before (issue #1627). If a memory tool call fails or returns nothing: retry once. If it fails again, switch to the SQL path in `references/queries.md` for that moment and say so. **Never end a session without a checkpoint written by one path or the other.**

### CRITICAL: supabase_run_query Behavior

Plain SELECT queries return only a row count, NOT the actual data. To get data back, wrap every SELECT in `json_agg(row_to_json(...))`:

```sql
-- Returns row count only (useless for restoration):
SELECT id, session_title FROM claude_session_logs

-- Returns actual data:
SELECT json_agg(row_to_json(s)) FROM (
  SELECT id, session_title FROM claude_session_logs
) s
```

INSERT/UPDATE with RETURNING clauses return the affected row count (confirmation that the write succeeded). If `json_agg` returns `null`, the inner query matched zero rows — this is an empty result, not an error.

## PREREQUISITE: Table Creation

The `claude_*` tables must be created before this skill can function. The v3 session start additionally needs `claude_memory_context` / `claude_memory_search` from LP-MCP `sql/090`, and the v4 write path needs the lifecycle columns and `claude_pending_items` from LP-MCP `sql/091`. All of this is already in place on the LP instance (applied 2026-09-05/06); the steps below are for a fresh or out-of-date install only.

**Instructions for Mark:**
1. Run the SQL either through `LP MCP:supabase_run_query` (CREATE / ALTER are allowed there — that is how `sql/090` and `sql/091` were applied) or in the Supabase Dashboard → SQL Editor
2. Pick the file for the install state:
   - fresh install → `references/schema.sql`
   - v1 install (no transcript bridge) → `references/migration-v2.sql`, then `references/migration-v3.sql`
   - v2 install (no `origin` / `confidence` columns, or the pack call errors with *function claude_memory_context does not exist*) → `references/migration-v3.sql`
3. Then run LP-MCP `sql/090_claude_memory_context.sql` and `sql/091_memory_lifecycle_pending_items.sql`, in that order, as-is (fetch each with `LP MCP:github_get_file`). They are kept in the repo, not copied into this skill, so there is one definition of each to maintain.
4. Verify with the query at the bottom of `references/migration-v3.sql` — expect 2 functions, 3 FTS indexes, 4 provenance columns, the `claude_pending_items` table, and a pack of 25–40k characters

If the tables don't exist when Claude tries to write, the INSERT will fail. Claude should inform Mark and provide the schema SQL. If only `claude_transcript_ledger` is missing, the core skill still works — degrade to writing search keys and skip all reconciliation. If only the `sql/090` functions are missing, session start degrades to the capped fallback queries in `references/queries.md` §1 — never to the uncapped all-open-issues dump.

---

# PART 1 — THE TRANSCRIPT BRIDGE

Read this part before any linking, reconciliation, or retro-checkpoint work.

## The constraint that shapes everything

**Claude cannot learn its own conversation's URL while inside that conversation.** No tool returns the current chat's ID. The `conversation_search` and `recent_chats` tools return a `url` attribute, but only for *past* chats. Therefore a checkpoint cannot reliably write its own `chat_url` at the moment it is created.

Three mechanisms work around this, in ascending order of reliability. Write mechanism 1 always; the others are opportunistic.

### Mechanism 1 — Search keys (always, every surface)

Every checkpoint stores `transcript_search_keys`: an array of short, distinctive strings **that literally appeared in the conversation text**. Later, `conversation_search` on those keys will surface the source chat even with no URL on file. This works on every surface because it requires no tools at write time — just careful extraction.

Set `link_confidence = 'unlinked'` when keys are the only link.

### Mechanism 2 — Link backfill (automatic, chat surface only)

**Mandatory since v4.3 — run it at every session start AND right after every `memory_checkpoint` on the chat surface, without being asked.** Claude cannot see its own chat in `recent_chats` or `conversation_search` (verified 2026-09-07), so a checkpoint can only be linked by a *later* chat in the same project. Making the pass mandatory means every chat links the ones before it, and nothing stays unlinked for longer than one session.

**No age window (v4.6).** Step 1 queries every unlinked chat session regardless of age. Until v4.6 it asked for rows *newer* than 7 days while the nightly `unlinked_sessions_7d` check flagged rows *older* than 7 days — the exact complement, so the sweep could never touch a single flagged row. 64 sessions sat unlinked for days while every sweep reported nothing to do. **If you ever add a window here, add the same one to the check in `src/jobs/memory-validate.js`.**

Procedure (`references/queries.md` §1b has the SQL):
1. Query unlinked sessions — `chat_url IS NULL AND surface='chat'`, `ORDER BY created_at ASC` so the most overdue come first. No `created_at` bound. The whole population is under 200 rows; the nightly check's `sample` is the same worklist with the search keys already attached.
2. **Match on search keys (primary), then pass three gates.** For each row, call `conversation_search` with 2–3 of its most distinctive `transcript_search_keys`. **Keys establish candidacy; the gates below establish identity** — topical keys (`E.2-VC`, `Bot 5`, `S2.1`) match *every* session on a long-running subject, so a September session will happily surface a May chat. Reject a candidate that fails any gate, and do not spend a fit test on it.

   - **Gate A — already linked.** At sweep start, run ONE query loading every `chat_url` already claimed (from `claude_session_logs` and `claude_transcript_ledger`) into memory, and filter candidates against that set. The ledger's `chat_url` is its primary key, so a second link is impossible by construction. Do this as an up-front set, never a lookup per candidate and never a refusal after the search is already spent.
   - **Gate B — the chat must be able to contain the session.** Reject when `(updated_at AT TIME ZONE 'America/New_York')::date < session_date`. A chat cannot be the source of work dated after its last activity. **The ET conversion is not optional:** `updated_at` is UTC and `session_date` is an ET date, so a chat last active `2026-09-08T02:00Z` is Sept 7 in ET and would be wrongly rejected against a Sept 8 session. Same-day passes.
     - **`updated_at` here means the LIVE value on the `conversation_search` / `recent_chats` result — never `claude_transcript_ledger.chat_updated_at`.** The ledger column is the value *at review time* and goes stale the moment a chat is reopened. A gate reading it rejects every reopened chat, permanently. Worked example: session 876's chat `0e16794c`. The ledger says Mar 27; live search returned Sep 9 20:46 UTC, the same day as the session. Read from the ledger, 876's own correct link is refused forever — and a stale value plus a reopened chat is indistinguishable from a mis-link, so the whole class gets misread.
   - **Gate C — `write_date` rows get no Gate B, so they need more proof.** Gate B only works on `date_confidence='exact'` rows (150 of 231 on 2026-09-15). The other 81 are `write_date`: their `session_date` *is* the write date, so there is nothing to compare and no date guard is possible — and these are exactly the sweep-written rows most likely to mis-match. For them the title-fit test alone is **not** sufficient. Open the candidate chat and confirm the work itself matches before accepting. Never let a `write_date` row ride the same rule as a guarded one.
3. **Match on timestamp (fallback, live rows only).** Only for a session written live in this project in the last 7 days (`date_confidence='exact'`): call `recent_chats(n=20)`, paginate with `before` at most 5 calls, and take the chat whose `updated_at` is within **3 minutes** of the session's `created_at`; title similarity breaks a tie, skip and say so if still ambiguous. **Never use this on a sweep-written row** — its `created_at` is the date the checkpoint was written, not the date of the conversation, so the 3-minute rule matches the wrong chat or nothing at all.
4. One UPDATE per match: `chat_url`, `chat_title`, `link_confidence='inferred'`, plus a ledger row `disposition='linked'`. Never overwrite an `exact` link with an `inferred` one. One chat links to one session (the ledger's `chat_url` is the primary key); on a double match link the fuller row and report the other. **A heal never re-dates a row that already says `date_confidence='exact'`** — see `references/queries.md` §6a.
5. Report one line: "Linked N sessions to their chats." Say nothing if N = 0 and nothing is unlinked.

**"Link sweep"** — when Mark says this, run only steps 1–5 and stop. Both `recent_chats` and `conversation_search` are scoped to the project the chat is in, so a sweep across several projects needs one new chat opened in each project (and one outside any project) with this command. Report the batch per project before writing.

### Mechanism 3 — Mark supplies the URL

If Mark pastes the chat URL at checkpoint time, write it directly and set `link_confidence = 'exact'`. This overrides both other mechanisms. Do not ask for it every session — it is an offer, not a gate.

## Extracting good search keys

This is the single highest-leverage step in the whole skill. Bad keys make a checkpoint permanently unfindable.

A key must be a string a text search would actually match in the transcript. Aim for **5–8 keys, each 1–4 words.**

**Good keys** — distinctive and verbatim:
- Canonical codes: `S4.5`, `W0.0`, `L.4`
- Workflow / pipeline UUIDs or their first segment: `407ec6f2`
- Table and column names: `claude_transcript_ledger`, `workflow_registry`, `agent_rules`
- Proper nouns and partner names: `Contractor Connect`, `LightFire`, `TrustedForm`
- Verbatim error strings: `column does not exist`, `idempotency key collision`
- File paths and function names: `select.js`, `reece-tracker.js`
- Distinctive concept phrases actually spoken: `Data status orphans`, `intake gateway`

**Bad keys** — will not match or will match everything:
- Generic words: `workflow`, `fix`, `sync`, `report`, `issue`
- Claude's own paraphrases that were never typed in the chat
- Meta-words describing the act of talking: `discussed`, `decided`, `session`
- Long sentences — search matches short phrases, not prose

**Test each key before writing it:** can you point to where it appeared in this conversation? If not, drop it.

Write the same keys onto each `claude_decision_log` row created in the session, so a single decision can be traced to the exact chat where it was argued — not just to its session.

## Surface awareness

`conversation_search` and `recent_chats` exist **only on the chat surface.** In Claude Cowork and Claude Code they are absent.

- **All surfaces:** write `transcript_search_keys`, `surface`, `log_origin`, `link_confidence`. Mechanism 1 always works.
- **Chat surface only:** reconciliation (Query 4), timestamp backfill, retro-checkpointing.

Set `surface` to `chat`, `cowork`, or `code` on every write. When reconciliation runs later, checkpoints written from `cowork` or `code` are **expected** to be unlinked — do not flag them as gaps. Only `surface='chat'` rows with `link_confidence='unlinked'` are genuine backfill candidates.

If a reconciliation is requested on a surface without the transcript tools, say so plainly and do the parts that work rather than silently skipping.

## Known blind spot — project scoping

Transcript search is scoped to the current project: a chat inside a project cannot see chats outside it, and vice versa. If Reece work spans both, reconciliation has a permanent blind spot that no schema change fixes. When reporting reconciliation results, state the scope the numbers cover. Never present a reconciliation as exhaustive.

---

# PART 2 — SESSION LIFECYCLE

## Moment 1: Session Start (Context Restoration)

At the beginning of any conversation that involves Reece project work, make ONE tool call, then (chat surface only) the reconciliation pass.

**Call 1: Context pack** — `LP MCP:memory_context({ topic: "<2–5 words>" })`. Returns a ranked, size-capped bundle (~8k tokens): the last session (summary, next steps, open pending items), the five sessions before it, the top 25 open critical/high issues (live rows ranked above reconstructed ones), decisions from the last 30 days, issues resolved in the last 30 days, open pending items from the last 14 days, full-text matches for the topic, and `counts` showing what was NOT included.
**Query 4: Transcript reconciliation** (chat surface only) — still SQL, `references/queries.md` §1.
**Auto-link pass** (chat surface only, mandatory) — Part 1, Mechanism 2. Runs right after Query 4 and reuses its `recent_chats` results.
**Date self-heal** — if the pack's `last_session` is this same chat (Mark named the session number, or the title matches) and its `date_confidence='write_date'`, correct `session_date` now from the date on this chat's first user message and set `date_confidence='exact'` (§1c). This is how the 76 sweep sessions from 2026-09-06/07 get their real dates back, one at a time, as Mark reopens them.

Fallback: `claude_memory_context('<topic>')` via `supabase_run_query` (§1) — identical output.

**Pass a topic.** 2–5 words describing what this conversation is about (`"memory system"`, `"appointment title"`, `"LightFire payroll"`). It drives the `topic_matches` section. Omit it only when the conversation has no subject yet.

**NEVER run the old "load all open issues" query at session start.** As of 2026-09-06 it returns ~640k characters (~160k tokens) — more than a context window — because the retro-session history was promoted into the log tables (856 decisions, 892 issues tagged `origin='retro'`). The pack's `counts.open_issues` tells you how many exist; `claude_memory_search()` finds the specific ones you need.

**Reading `origin`.** Rows tagged `origin='retro'` / `confidence='reconstructed'` were rebuilt from chat transcripts, not written live. Treat them as evidence, not as Mark's confirmed word — same rule as the `[RETRO — …]` prefix on session summaries.

### Running Query 4 — the reconciliation pass

1. Query the ledger for reviewed chats and the checkpoint table for unlinked `surface='chat'` rows.
2. Call `recent_chats` (n=20, desc) for the recent window. Paginate with `before` if needed; stop after ~5 calls.
3. Classify each returned chat:
   - **In the ledger with matching `chat_updated_at`** → already handled, ignore.
   - **In the ledger but `updated_at` has advanced** → the chat continued after review. Re-open it: set disposition back to `deferred` and surface it.
   - **Not in the ledger** → unreviewed. Candidate.
4. For each candidate, try to match it to an unlinked checkpoint by timestamp proximity (Mechanism 2). On a confident match: update the checkpoint's `chat_url` / `chat_title`, set `link_confidence='inferred'`, and write a ledger row with `disposition='linked'`.
5. Anything left over is a chat with **no checkpoint at all**. These are the real finds. Report them; do not auto-write retro-checkpoints without a ruling (see below). **v4.4:** for each one, write a ledger row `disposition='deferred'` with its `chat_url`, `chat_title` and `chat_updated_at` (§6 SQL). That row is what the nightly job turns into a draft session (`log_origin='nightly'`, summary + keys only) for Mark to confirm or drop — LP-MCP cannot see chats itself, so the ledger is its only source.

### Synthesizing the restoration

Do NOT dump raw query results at Mark. Synthesize into 3–5 sentences of natural context: what phase the project is in, what happened last session, what is pending or blocked, open critical/high issues, planned next steps.

Then add **one** line about linkage only if there is something actionable — e.g. "Three chats from last week have no checkpoint; want me to reconstruct them?" If everything reconciles, say nothing about it. Silence is the signal that the bridge is healthy.

## Moment 2: Session End (Context Persistence)

When Mark says "save session", "wrap up", "checkpoint", or when the conversation is clearly ending, write the session log. This is the most important action — skipping it means the next session starts blind.

**Step 0: Extract transcript search keys** *(new — do this first, while the conversation is still in view)*

Scan the conversation for the 5–8 distinctive verbatim strings described in Part 2. Do this before building the summary: once you start composing prose, your own paraphrases start to feel like things that were said. Also determine `surface`, and set `log_origin='live'`.

**Step 0b: Set the session date correctly** *(v4.3 — the sweep pass got this wrong 79 times)*

`date` is **the date the work happened, not the date the checkpoint is written.** Read it from the `The current date is …` line attached to the chat's **first** user message — that is the day the chat started, and it is always in view when you are inside the chat. Only if the chat genuinely spans days and the last day matters more, use the date on the last message instead. If no dated line is visible at all, pass `date_confidence: "write_date"` in the `session` object so the pack can exclude it from "recent" ranking and the next session start corrects it. **v4.4:** the tool rejects a `date` in the future or more than 400 days back — if that happens, you read the wrong line; look again. It also refuses a fourth "live" checkpoint inside five minutes (that pattern is a sweep, and sweeps use retro mode).

A checkpoint written into an old chat that never had one is still `log_origin='live'` — you have the full transcript in view, which is stronger evidence than a retro pass working from search snippets — but the date rule above is what keeps it from masquerading as this week's work. Do not paste the chat URL from memory; leave `chat_url` empty and let the auto-link pass in the next chat fill it.

**Step 1: Build the session summary object**

Gather from the conversation:
- What workflows were touched (IDs, names, what changed)
- Current phase status across all 7 phases
- Decisions made (with rationale and alternatives considered)
- Issues found (new problems discovered)
- Issues resolved (problems fixed this session)
- Pending items (unfinished work, unanswered questions)
- Board versions (if boards were updated)
- MCP-verified IDs (any workflow/pipeline IDs confirmed via MCP)
- Next steps (prioritized, with dependencies and effort)
- Free-text summary (the narrative — what happened, why, what matters)

**Step 2 (v4.2): One call — `LP MCP:memory_checkpoint`**

Steps 2–4a below describe what the tool writes; you no longer write them by hand. Build one payload and call the tool **twice**: first without `confirm` (returns the plan — read it back, check the counts), then with `confirm: true`.

```
memory_checkpoint({
  session: {
    title, summary, phase_focus, surface: "chat" | "cowork" | "code" | "n8n",
    search_keys: [5–8 verbatim strings], date?, chat_url?, chat_title?,
    workflows_touched?, mcp_verified_ids?
  },
  decisions: [{ category, decision, rationale?, options?, workflow_code?, supersedes_id?, same_as_id? }],
  issues: [{ severity, category, description, impact?, fix_instructions?, issue_type?, workflow_code?, workflow_name? }],
  resolved_issues: [{ id, verification_note }],
  verified_issues: [{ id, verification_note }],      // still open, re-checked — clears stale
  pending: [{ description, kind: "pending" | "next_step", item_type, owner?, priority?, ref?, blocked_by?, effort? }],
  close_pending: [{ id, status: "done" | "dropped" | "superseded" | "blocked" | "deferred" | "ratified" }],
  confirm: true
})
```

What the tool does for you: stamps every decision with the session's search keys, sets `origin='live'` / `confidence='confirmed'`, leaves `area` to the trigger, writes pending items to `claude_pending_items`, and closes what you list in `close_pending`. It returns the new `session_id` plus every id it wrote — quote those back to Mark.

**One subject, one active decision (v4.4).** Before inserting a decision the tool embeds its text and looks for the nearest *active* decision. If one scores ≥ 0.85 and you named neither `supersedes_id` nor `same_as_id`, the result is `kind: "validation"` with the matching id in the message (`MEMORY_GUARD_MODE=live`; in `shadow` it is written and logged). Do not rephrase to get past it: run `memory_precheck` on the decision text, read the match, then re-send with `supersedes_id` (Mark changed the ruling — the old row becomes `superseded`) or `same_as_id` (same ruling restated — nothing is inserted, the existing row gets `verified_at`). The result's `guard.checks` lists what the guard saw either way.

`item_type` is validated. Use one of: `next_step`, `verification_needed`, `decision_needed`, `action_needed`, `build_needed`, `unconfirmed_decision`, `open_question`. (`awaiting_action` is rejected.) Anything that needs Mark's ruling is `decision_needed`, `unconfirmed_decision`, or `open_question` — the nightly auto-close never touches those three.

If the result shows `ledger: null` and Mark supplied a URL, upsert the ledger row with §6 SQL.

**Fallback (SQL) — Steps 2–4a as written for v4.1.** Use only under the Fallback rule.

Use the INSERT from `references/queries.md` §2. Since v4 (2026-09-05) the session row holds the narrative and the pointers, not the facts:

- `decisions_made`, `issues_found`, `issues_resolved`, `pending_items`, `next_steps` → write `'[]'::jsonb`. The facts go into their own tables in Steps 3–4a. **One fact, one row, one place.** Writing them into the JSON as well re-creates the double-storage problem the memory audit removed.
- `raw_summary`, `workflows_touched`, `phase_status`, `board_versions`, `mcp_verified_ids`, search keys, `surface`, `log_origin`, `link_confidence` stay as before. If Mark has not supplied a URL, write `chat_url = NULL` and `link_confidence='unlinked'` — the normal, expected case, not a failure.

**Step 3: Write decisions to `claude_decision_log`**

One row per significant decision, with the session_id from Step 2 **and the same `transcript_search_keys`**. `origin='live'`, `confidence='confirmed'` are the defaults — leave them. Set `workflow_code` (the canonical code — `S4.5`, `E.2`, `A.WE-1`) whenever the decision concerns a registered workflow: look it up in `claude_workflow_ref` by code or name (§3, "Find the workflow code"). Do **not** set `area` — the `claude_set_area` trigger (LP-MCP `sql/093`) fills it from the text; pass an explicit `area` only to override the classifier. If a decision replaces an earlier one, UPDATE the old row: `status='superseded', superseded_by=<new id>` (§3). Never delete a decision.

**Step 4: Update the issue tracker (`claude_known_issues`)**

- New issues: INSERT (§4). `issue_type='defect'` is the default; use `'initiative'` for build/plan items and `'metric'` for a measurement you want on record. Set `workflow_code` when a registered workflow is involved (same lookup as decisions). `area` is filled by the trigger.
- Resolved: UPDATE `status='resolved'`, `resolved_date`, `resolved_session_id`, and set `verified_at=now()` with a one-line `verification_note` saying what proved it.
- Re-checked and still open: set `verified_at=now()`, `verification_note`, `stale=false`. This is how the stale flag gets cleared — verification, not activity.
- Same defect already filed: mark the NEW one `status='duplicate', merged_into=<existing id>` rather than filing twice. `claude_memory_search()` first.

**Step 4a: Pending work → `claude_pending_items`**

- New pending items and next steps: one INSERT row each (§2a). `kind='pending'` for open questions / decisions needed / verifications; `kind='next_step'` for the ordered plan, with `priority`.
- Items finished this session: UPDATE `status='done', resolved_session_id=<this session>` (§2a). Dropped or overtaken: `'dropped'` / `'superseded'`. **Never re-paste an open item into a new session** — it is already open, and the context pack surfaces it until it is closed.
- `source_session_id` is the session that CREATED the item, even when a later session closes it.

**Step 5: Confirm to Mark**

Report what was saved: "Session logged. [N] workflows tracked, [M] decisions recorded, [K] issues updated. Next session will restore from this checkpoint." Mention linkage only if unusual — e.g. if `claude_transcript_ledger` is missing, or if Mark supplied a URL and the link is `exact`.

## Moment 2b: Refresh an existing checkpoint

Trigger: Mark opens an old chat and says "refresh session #N", "this chat is
session #N", "re-checkpoint this", or names a session number with the chat
open. This is how reconstructed (retro) checkpoints get upgraded to reviewed
ones, and how unlinked live checkpoints get their URL.

**The rule that makes this safe: a refresh never INSERTs a session row.** Claude
cannot see its own chat URL, so it cannot find the existing row by itself. If
Mark has not named the number, look the chat up by title in
`claude_transcript_ledger` (§6, "Find the session for this chat") and confirm the
number with him before writing anything. If no row is found, this is a
retro-checkpoint (Part 3), not a refresh.

Procedure (v4.2 — one `memory_checkpoint` call with `session_id: N` at the end; SQL for each step in `references/queries.md` §2b is the fallback):

1. **Load** the session row and everything that points at it: decisions
   (`session_id`), issues (`reported_session_id`), pending items
   (`source_session_id`). §2b "Load" SQL — the context pack does not return a
   named old session. Read the summary and the existing rows before reading
   the chat, so you know what is already on record.
2. **Read the chat** you are in — the whole thing, not the first screen.
3. **Search before inserting.** For every decision or issue you would add, run
   `LP MCP:memory_search({ query })` first. Existing row that matches → confirm
   it (step 4), do not file it again. Missing → it goes in the `decisions` /
   `issues` arrays of the refresh call.
4. **Provenance on the refresh.** Rows Mark states or confirms in the refresh
   conversation get `confidence = 'confirmed'`, `verified_at = NOW()` and a
   `verification_note` naming the refresh; `origin` stays whatever it was
   (`retro` records where the row came from, not whether it is trusted). New
   rows Mark states now are `origin = 'live'` — **and they stay that way even
   though the session they hang off is `retro`** (v4.5, `sql/100`: confirmed
   beats reconstructed; the old trigger downgraded them and had to be reversed
   by hand 95 times). Anything Claude infers from the transcript without Mark's
   word stays `retro` / `reconstructed` or goes to `claude_pending_items` as
   `unconfirmed_decision`.
5. **Close what is done.** Pending items from this session that the chat (or
   Mark) shows as finished go in `close_pending` (`done` / `dropped` /
   `superseded`). Issues fixed since go in `resolved_issues` with the proof;
   issues re-checked and still open go in `verified_issues`. Never re-paste an
   open item.
6. **Make the call** — `memory_checkpoint({ session_id: N, session: {...},
   decisions, issues, resolved_issues, verified_issues, pending, close_pending,
   confirm: true })`. Dry-run first (omit `confirm`) and read the plan. In
   `session`: merged search keys (union, keep under ~12); the rewritten summary
   if the reconstruction was thin or wrong, keeping the `[RETRO — …]` prefix
   and adding `[REFRESHED YYYY-MM-DD with Mark in the source chat]` in front;
   `chat_url` + `chat_title` when Mark pastes the URL (the tool sets
   `link_confidence='exact'`). The tool UPDATEs row N — it never inserts a
   second session. Never downgrade an `exact` link.
7. **Ledger row**: if the result shows `ledger: null`, upsert with §6 SQL —
   `disposition = 'linked'`, `chat_updated_at` = the chat's current timestamp,
   `notes` = "refreshed YYYY-MM-DD".
8. **Confirm to Mark**: session number, what was updated, what was added,
   what was closed, and whether the link is now `exact`.

**Refresh pass, 2026-09 (88 sessions, 321 keyless decisions).** Mark opens each
old chat, names the session number, and the refresh call carries `chat_url`
and the search keys. Decisions under that session inherit the keys
automatically — that is how the 321 keyless decisions get filled. Session #107
is one of the 88: its `chat_url` was cleared on 2026-09-06 because it held a
sentence instead of a URL.

Priority order when Mark is working through old chats, from the 2026-09-06
audit: retro sessions that still hold open critical/high issues first, then
live chat sessions with no URL, then retro sessions from the last 60 days. The
rest can stay reconstructed — search labels them.

## Mid-Session Checkpoints

For long sessions (2+ hours of continuous work), save a checkpoint periodically. This protects against conversation drops, context window limits, or browser crashes.

When to checkpoint:
- After completing a major deliverable (build guide, email template, board update)
- After making 3+ architectural decisions
- After discovering a critical issue
- When Mark says "save state" or "checkpoint"
- If the conversation is getting very long (100+ messages)

A checkpoint is the same as Session End. The first `memory_checkpoint` call of a conversation creates the session and returns its id; every later call in the same conversation passes that id as `session_id` so the row is updated, never duplicated. (SQL fallback: UPDATE instead of INSERT.) Decisions, issues and pending items are appended to their tables as they happen — the session row is the only thing that gets rewritten. **On update, merge search keys rather than replacing them** — later stretches of a long session introduce new distinctive terms, and the early ones stay valid. Union the arrays and keep the total under ~12.

---

# PART 3 — RETRO-CHECKPOINTING

When reconciliation finds a chat with no checkpoint, the work in it is invisible to every future session. Reconstructing it is valuable but carries a real risk: **a checkpoint written from a transcript is weaker evidence than one written live.** Provenance must be preserved.

## The sweep prompt (v4.4 — the only path for chats found through search)

> **Retro pass: for each chat you find, call `memory_checkpoint` in retro mode with the search result's `url` and `updated_at`.**

That is the whole instruction. Everything the 9/6–9/7 sweep got wrong (rows stamped live, dated today, no URL, no ledger row) is now impossible through this path: the tool refuses a retro call without a source, stamps the origin itself, dates the row from the chat, and writes the ledger row in the same call.

## Procedure

1. **Get a ruling first.** Report the finding and ask before writing. Do not auto-generate retro-checkpoints during a routine session start — an unattended pass can fabricate state that then gets treated as fact for months.
2. **Read the transcript**, not the snippet. Use `conversation_search` or `recent_chats` to get the chat, and read enough of it to know what actually happened. Keep the result's `url` and `updated_at` — they are the source.
3. **Track provenance per claim.** In the transcript, distinguish:
   - What **Mark** stated or decided → a decision, passed with `confirmed_by_mark: true`
   - What **Claude** proposed, drafted, or recommended → a suggestion, even if Mark reacted warmly
   - What was explicitly hypothetical or a brainstorm → stays hypothetical
   A past Claude recommendation is NOT a decision unless Mark committed to it. This is the most common way retro-checkpoints corrupt the record.
4. **One call, retro mode.** Dry-run first (omit `confirm`), read the plan, then:

```
memory_checkpoint({
  mode: "retro",
  source: { chat_url: <result.url>, chat_title: <result.title>, chat_updated_at: <result.updated_at> },
  session: { title, summary, phase_focus, surface: "chat", search_keys: [5–8 verbatim strings] },
  decisions: [{ category, decision, rationale?, confirmed_by_mark?: true }],   // only what a Mark turn plainly states
  issues: [...], pending: [{ description, item_type: "unconfirmed_decision", ... }],
  confirm: true
})
```

   The tool sets `log_origin='retro'`, `link_confidence='exact'`, `session_date = chat_updated_at` (ET), `source_chat_updated_at`, prefixes the summary with `[RETRO — reconstructed from transcript on YYYY-MM-DD. Decisions unconfirmed by Mark are marked inferred.]`, stamps every decision / issue `origin='retro'`, `confidence='reconstructed'` (a `confirmed_by_mark` decision gets `confirmed`), and writes the ledger row `disposition='retro_written'` — all in one sequence. Never pass `session_id` in retro mode (a refresh is Moment 2b, mode live).
5. **Decisions from a retro pass** go to `claude_decision_log` only when a Mark turn plainly states them. Anything softer goes into `pending` as `item_type: 'unconfirmed_decision'` for Mark to ratify or drop.
6. **If the tool rejects the call** — *"retro session requires chat_url and source_chat_updated_at"* — you did not pass the source. Go back to the search result; do not switch to live mode to get past it.

**SQL fallback (only under the Fallback rule):** write the session with `log_origin='retro'`, `chat_url`, `source_chat_updated_at` (the sql/098 trigger rejects a retro row without both), `link_confidence='exact'`, `session_date` = the chat's date; children with `origin='retro'`, `confidence='reconstructed'`; the ledger row `retro_written`.

## Dispositions

Every reviewed chat gets exactly one ledger row:

- `linked` — a checkpoint exists and is now connected to this chat
- `retro_written` — no checkpoint existed; one was reconstructed from the transcript
- `no_content` — reviewed, nothing worth checkpointing (a quick lookup, a one-off question). **This disposition is the point of the ledger** — without it, the same trivial chat gets re-flagged every single morning.
- `deferred` — worth checkpointing but not now; will resurface next reconciliation

---

# PART 4 — QUERYING HISTORICAL CONTEXT

## "Have we already decided this?" — `memory_precheck` (v4.4, step 0 before any proposal)

Before Cowork proposes a change from a finding, before the Decision Engine writes an `agent_rules` row (reece-agent-rules step 0), before Claude Code opens a PR that touches `sql/` or `src/jobs/`, and before you log a decision in a checkpoint: `LP MCP:memory_precheck({ proposal_text: "<the proposal in plain words>", area?: "<slug>" })`. It returns the top 5 **active** decisions on the subject (same area first, with cosine similarity), superseded / rejected decisions that match at or above the conflict threshold, open rows in `claude_memory_conflicts` that involve them, and a verdict with a next step:

- `clear` — propose it; checkpoint it as a new decision when decided.
- `already_decided` — an active decision covers it. Re-confirm (`same_as_id`) or replace it explicitly (`supersedes_id`). Never file a second one.
- `previously_rejected` — Mark has been here. Read the superseded / rejected row's rationale before re-proposing, and say so when you do.
- `conflict_open` — two active rows disagree and are waiting on a ruling. Get the ruling first (§6a SQL) — proposing on top of an open conflict makes a third truth.

Read-only. When embeddings are unavailable it falls back to full-text and says `leg: "fts"` — then `already_decided` cannot be inferred from similarity, so read the returned rows yourself.

## "What did we decide about X?"

Run `LP MCP:memory_search({ query: "<the question in plain words>" })` first. It runs two legs: ranked full-text (exact tokens — `S4.5`, `8e30ff37`, file names) and vector search (paraphrase — "why do leads get duplicate opportunities" finds the rows even though none contain those words). Live since 2026-09-06; on 3 of 4 plain-language test questions the full-text leg returned nothing and the vector leg returned the answer, so **ask in plain words, do not guess keywords.** Filters: `area`, `kind` (`decision` | `issue` | `session` | `pending`), `include_closed`, `limit`. **v4.4:** superseded, rejected, expired, duplicate and resolved rows are hidden by default — current truth only. Pass `include_closed: true` for "why did we change our mind" and "what fixed it last time" questions; those rows come back weighted low, never hidden. Every hit carries `date_confidence`; a `write_date` row is ranked at half weight. SQL fallback: `claude_memory_search('<query>')` (§5) — full-text only. Read the `origin` column on every hit — `retro` rows are reconstructed. If a decision hit has `transcript_search_keys`, and Mark wants the reasoning rather than just the conclusion, run `conversation_search` on 2–3 of those keys to pull up the chat where it was argued. Offer the chat URL when one is on file.

## "Where was this discussed?"

Given a decision or issue row, resolve to a transcript in this order: `chat_url` if present → `conversation_search` on `transcript_search_keys` → `conversation_search` on distinctive nouns from the decision text itself.

## "What am I missing across all my chats?"

This is a combined-state request and it needs all four sources, stated separately rather than blended:

1. Checkpoints, decisions, and open issues from Supabase
2. The reconciliation pass (Part 2, Query 4) for uncheckpointed chats
3. Memory files for durable context
4. Anything in the current conversation

Present conflicts as conflicts. When Supabase and a transcript disagree, the **later** source usually wins — but say that you are choosing, and why, rather than silently picking one. Flag every `log_origin='retro'` row you rely on as reconstructed.

---

# PART 5 — REFERENCE

## What Counts as a "Decision"

Log decisions that:
- Change the architecture (new workflow, new routing, new tag namespace)
- Reject an alternative (Option A chosen over Option B — log both)
- Set a precedent for future work ("W0.3 uses X pattern, so W0.4-W0.6 should too")
- Resolve a conflict or ambiguity in the system
- Are explicitly flagged by Mark ("remember this" / "important" / "decision made")

Don't log:
- Routine copywriting choices (word selection, sentence structure)
- Formatting decisions (unless they set a template precedent)
- Tool selection (which MCP tool to use)

## What Counts as an "Issue"

Log to `claude_known_issues` when:
- A workflow has a bug that affects live leads
- A routing path is broken or missing
- Tag operations violate the architecture rules
- MCP data contradicts project files
- A published workflow has a dead-end
- Pipeline contacts are stagnating
- Two parallel stacks are conflicting

Severity levels:
- **critical** — actively losing leads or creating duplicate messaging NOW
- **high** — will cause problems within days or silently degrading
- **medium** — suboptimal but contained
- **low** — cosmetic or future-proofing

## Automatic lifecycle (the nightly job)

`src/jobs/memory-nightly.js` runs at 03:00 ET. What it does without a human:

- **Stale issues** — an open defect with no verification and no touch in 60 days gets `stale=true`. Only verification clears it (`verified_issues` in a checkpoint). A stale issue is still open; stale means "nobody has looked," never "fixed."
- **Re-embed** — any row whose text changed is re-embedded so `memory_search` stays current.
- **Auto-close of pending items** (once the 2026-09-06 handoff ships; `MEMORY_AUTOCLOSE_MODE` off → shadow → live):
  - A `next_step` from a session 30+ days old → `expired`
  - Any item from a retro session 90+ days old → `expired`
  - Exact-duplicate descriptions → older ones `superseded`, newest stays open
  - An item whose `ref` issue is resolved or whose PR is merged → `done`
  - **Never auto-closed:** `decision_needed`, `unconfirmed_decision`, `open_question`, and any open defect. Old items that are not fixed stay open and get `stale=true` so they surface in the weekly digest. Mark's ruling: "if it's not fixed, it stays open."
  - Every auto-closed row carries `closed_by='nightly'`, `closed_reason`, `closed_at`. Reopen with one UPDATE to `status='open'`. Expired is not dropped — it means the plan aged out, not that the work was rejected.

Reading these at session start: an `expired` next step is history, not a to-do. A `stale` open issue is a to-do that needs a fresh look.

**Integrity loop (v4.4, sql/098).** The same nightly run, after re-embedding:

- **Validation** — ten checks, one row each in `claude_memory_validation_log`: chat-surface sessions unlinked (all counted; those past 7 days flagged unless ruled `link_unlinkable` in `validation_notes` — a pre-v4.3 row with no search keys and no reachable chat, which no sweep can link), `write_date` rows, live rows in a batch pattern, active decisions with no area, embedding coverage, orphan embeddings, embedding metadata drift, open conflicts, children stamped `live` under a retro session, guard-flagged sessions and unconfirmed drafts. Two repairs, both marks: embedding metadata re-synced from the source rows (so a supersession or a merged duplicate is hidden from search the next night), orphan embeddings flagged `stale_embedding`. Manual run: `POST /admin/memory/validate {"dry_run": true}` (logs, changes nothing).
- **Conflict scan** — active decisions in the same area at cosine ≥ 0.85, and open issues at ≥ 0.90, filed as pairs in `claude_memory_conflicts` (status `open`). Nothing is closed by the scan. Mark rules each pair (§6a): `a_supersedes_b` / `b_supersedes_a` writes `superseded_by` on the loser, `not_a_conflict` leaves both, `merged` (issues) writes `merged_into`. A ruling is reversible with one UPDATE; nothing is deleted.
- **Drafts** — every ledger row left `deferred` with no session becomes a draft session (`log_origin='nightly'`, title prefixed `[DRAFT]`, summary + keys only, never decisions or issues). Mark confirms one by opening the chat and refreshing it (Moment 2b — the refresh promotes it to `live`), or drops it by setting the ledger row to `no_content`.
- **Monday digest** gains three sections: conflicts awaiting ruling, sessions unlinked after 7 days (+ drafts to confirm), and this week's validation checks that flagged rows.

The guard itself (`MEMORY_GUARD_MODE`) ships in `shadow` — it logs what it would reject to `claude_memory_validation_log` (`guard:batch_pattern`, `guard:conflict`) and rejects nothing — and flips to `live` after 48 hours of clean log, the same discipline as every other tier. Rollback: `MEMORY_GUARD_MODE=off` plus dropping `trg_claude_guard_session_insert` on `claude_session_logs`.

## Output Checklist

**Session Start:**
- [ ] `LP MCP:memory_context({ topic })` called with a real topic — NOT the old all-open-issues dump, NOT hand SQL unless the tool failed twice
- [ ] `counts` read, so the size of what was left out is known
- [ ] Reconciliation pass run (chat surface only) — ledger vs. recent_chats
- [ ] Auto-link pass run (Mechanism 2, mandatory): every unlinked `surface='chat'` session, any age, matched by `transcript_search_keys` through `conversation_search` (timestamps only as a fallback on live rows), URL + ledger row written
- [ ] If this chat's own session has `date_confidence='write_date'`, its real date written from the first message (§1c)
- [ ] Context synthesized into natural language (not raw JSON dumps)
- [ ] Uncheckpointed chats reported *only if any were found*

**Session End:**
- [ ] Search keys extracted FIRST, verbatim-verified against the conversation
- [ ] `date` = the date on the chat's FIRST user message, never today (v4.3); `date_confidence='write_date'` set by SQL if no date was visible
- [ ] `memory_checkpoint` dry-run read, then called with `confirm: true` — one call, no hand SQL unless the tool failed twice
- [ ] Decisions carry `workflow_code` where a registered workflow is involved; `supersedes_id` set when replacing an earlier decision, `same_as_id` when restating one (v4.4 — a ≥ 0.85 match with neither is rejected in live guard mode; `memory_precheck` shows the match)
- [ ] Pending items use a valid `item_type`; finished ones listed in `close_pending`, none re-pasted
- [ ] Resolved / re-verified issues listed in `resolved_issues` / `verified_issues` with a `verification_note`
- [ ] Returned ids quoted back to Mark (session, decisions, issues, pending)
- [ ] Auto-link pass run again after the write (chat surface) — links the previous chats in this project; this chat gets linked by the next one

**Refresh (existing checkpoint):**
- [ ] Session number confirmed by Mark or matched from the ledger by title, BEFORE any write
- [ ] Existing decisions / issues / pending items for that session loaded first
- [ ] `memory_search` run before adding any decision or issue; matches confirmed, not re-filed
- [ ] `memory_checkpoint` called with `session_id: N` (never without it on a refresh); keys merged; `[REFRESHED …]` prefix added
- [ ] Confirmed rows carry `verified_at` + `verification_note`; `origin` left as recorded
- [ ] Finished pending items closed with `resolved_session_id`
- [ ] Ledger row upserted `linked` (§6 SQL) if the tool result showed `ledger: null`; URL written as `exact` if Mark pasted it

**Mid-Session:**
- [ ] Checkpoint saved if session is long or major milestone reached
- [ ] Search keys merged (union), not replaced
- [ ] Critical decisions logged immediately (don't wait for session end)

**Retro-Checkpoint:**
- [ ] Mark ruled on it before anything was written
- [ ] Full transcript read, not just the search snippet
- [ ] Provenance tracked per claim — Mark's decisions vs. Claude's past suggestions (`confirmed_by_mark: true` only on a Mark quote)
- [ ] `memory_checkpoint` called with `mode: "retro"` and `source: { chat_url, chat_title, chat_updated_at }` from the search result — never mode live, never `session_id`
- [ ] Unconfirmed decisions parked in `pending` as `unconfirmed_decision`, not in `decisions`
- [ ] Result shows `mode: "retro"`, `ledger: "retro_written"`, and a `session_id` — quote it back

**Before any proposal (Cowork finding, agent rule, PR touching sql/ or src/jobs/):**
- [ ] `memory_precheck({ proposal_text, area })` run; verdict read
- [ ] `already_decided` → re-confirm or supersede explicitly; `previously_rejected` → the old rationale read and cited; `conflict_open` → ruling obtained first
