# Omi → LP memory (unconfirmed items)

**What it does.** Mark wears an Omi recorder. When a conversation ends, Omi
posts it to n8n, n8n relays it to LP-MCP, and LP-MCP turns the business content
into **unconfirmed proposals** in the memory tier that already exists.

**What it never does.**

- It never stores a raw transcript. Anywhere. The transcript exists as a string
  in one request and is gone when that request ends.
- It never writes `claude_decision_log` or `claude_known_issues`. Omi proposes;
  it does not decide.
- It never overwrites a confirmed decision. A contradiction is *flagged*.
- It never touches a lead, a contact, the dialer or a message queue — that
  boundary is enforced in code (`src/memory/omi-db.js`), not in a prompt.

---

## The flow

```
Omi app
  │  POST https://<n8n>/webhook/omi-memory?token=<OMI_WEBHOOK_TOKEN>&uid=<omi uid>
  ▼
n8n  "I.OMI — Omi Conversation → LP Memory"    (thin relay, 3 retries)
  │  moves ?token / ?uid into X-Omi-Token / X-Omi-Uid headers
  │  adds Authorization: Bearer <OMI_INGEST_TOKEN>
  ▼
LP-MCP  POST /memory/omi/ingest
  │  1 normalize      transcript built in memory, capped
  │  2 idempotency    sha256('omi|'+conversation_id) — a replay costs nothing
  │  3 extract        ONE JSON call, temperature 0, schema-validated
  │  4 filter         drop items under OMI_MIN_CONFIDENCE
  │  5 scrub          stripPii() BEFORE anything reaches the database
  │  6 dedupe         exact text + vector ≥ 0.90 → a mention, not a new row
  │  7 conflict       vector ≥ 0.85 vs active decisions, then same/conflicts/unrelated
  │  8 write          ONE rpc, ONE transaction  (claude_omi_ingest, sql/101)
  ▼
claude_session_logs  (surface 'omi', log_origin 'omi', one row per conversation)
claude_pending_items (one row per item, origin 'omi', status 'open')
```

## What an item becomes

| Omi said | `item_type` | Notes |
| --- | --- | --- |
| decision_candidate, proposal, commitment, system_change | `unconfirmed_decision` | protected from auto-close |
| action_item, pending_item | `action_needed` | |
| question | `open_question` | protected from auto-close |
| issue, risk | `verification_needed` | description also prefixed "Possible issue heard in Omi — " |

Every item: `kind='pending'`, `status='open'`, `origin='omi'`,
`source_field='omi'`, description prefixed `[Omi YYYY-MM-DD] `,
`raw.confidence_label='unconfirmed'`, and the model's own label kept in
`raw.omi_category`.

A conflicting item additionally gets `priority=1`, the description prefix
`CONFLICTS WITH #<id> — `, and `raw.conflicts_with_decision_id`. **The confirmed
decision is not touched.**

## Confirming something Omi heard

There is no auto-promotion. The path is the one that already exists:

1. Mark reads the item — in the Monday GroupMe digest ("Heard in Omi — confirm
   or drop"), in `memory_search`, or in `counts.omi_open_unconfirmed` on the
   session-start pack.
2. He says yes in chat.
3. `memory_checkpoint` writes the real decision (live / confirmed) **and**
   `close_pending { id, status: 'ratified' }` on the Omi row.

Dropping it is the same call with `status: 'dropped'`.

## Environment variables

| Variable | Default | What it is |
| --- | --- | --- |
| `OMI_INGEST_MODE` | `off` | `off` → 503. `shadow` → everything runs, only a `claude_memory_validation_log` row is written. `live` → memory rows are written. |
| `OMI_INGEST_TOKEN` | — | Bearer token n8n sends. Its own secret, **not** `MCP_AUTH_TOKEN`. Unset = every call is 401. |
| `OMI_WEBHOOK_TOKEN` | — | The token in the Omi webhook URL, relayed as `X-Omi-Token`. Unset = every call is 401. |
| `OMI_ALLOWED_UIDS` | — (empty) | Comma list of Omi user ids allowed. **Empty rejects everything** and logs the uid. |
| `OMI_DEDUPE_THRESHOLD` | `0.90` | Cosine at or above which an item is an existing open item. |
| `OMI_MIN_CONFIDENCE` | `0.5` | Items below this model confidence are dropped. |
| `OMI_MAX_TRANSCRIPT_CHARS` | `60000` | Transcript characters sent to the extractor (first 75% + last 25%). |
| `OMI_MAX_BODY_BYTES` | `2000000` | Request body cap; also the JSON parser limit for `/memory/omi`. |
| `OMI_RATE_LIMIT_PER_MIN` | `30` | Per-uid requests per minute before 429. |
| `OMI_EXTRACT_MODEL` | — | Optional. Read through `src/llm-client.js` for fn `omi_extract`, so this var is the **Anthropic** model id. For OpenAI set `OMI_EXTRACT_PROVIDER=openai` + `OMI_EXTRACT_MODEL_OPENAI`. |

Reuses `MEMORY_CONFLICT_THRESHOLD` (0.85), `OPENAI_API_KEY` (embeddings) and the
Supabase service key — all already set.

## Setup, in order

**The order matters. Never set `live` before sql/101 is applied and shadow
output has been reviewed.**

1. **Merge the PR**, then confirm the Railway deploy is ACTIVE and postdates the
   merge.
2. **Supabase → SQL editor (LP instance)** — run the four blocks of
   `sql/101_omi_memory_source.sql` one at a time (A constraints, D index,
   B function, C pack), then the verification query at the bottom of the file.
   Expect `fn` 1, `surface_ok` / `origin_ok` true, `pack_last` **not** `omi`.
3. **Make two tokens.** PowerShell, run twice, save both:
   ```powershell
   $b = New-Object byte[] 32
   [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
   -join ($b | ForEach-Object { $_.ToString('x2') })
   ```
4. **Railway → LP-MCP → Variables:** `OMI_INGEST_MODE=shadow`,
   `OMI_INGEST_TOKEN=<token 1>`, `OMI_WEBHOOK_TOKEN=<token 2>`,
   `OMI_ALLOWED_UIDS=` (leave blank — step 7 fills it).
5. **n8n** — import `docs/n8n/omi-memory-ingest.json`. Create a **Header Auth**
   credential named `LP MCP – Omi ingest` with Name `Authorization` and Value
   `Bearer <token 1>`, select it on the *POST to LP-MCP* node, and activate.
6. **Omi developer settings** — set the conversation webhook to
   `https://n8n-main-instance-production-981e.up.railway.app/webhook/omi-memory?token=<token 2>`
7. **Record one short test conversation**, then run:
   ```sql
   SELECT json_agg(row_to_json(v)) FROM (
     SELECT check_name, sample, ran_at FROM claude_memory_validation_log
     WHERE check_name LIKE 'omi:%' ORDER BY ran_at DESC LIMIT 5) v;
   ```
   The first run always lands an `omi:uid_rejected` row — that row carries your
   Omi uid. Put it in `OMI_ALLOWED_UIDS`, record another conversation, and an
   `omi:shadow` row appears with the planned items.
8. **After 3–5 real conversations look right in shadow**, decide on
   `OMI_INGEST_MODE=live`. That flip is a separate decision.

## Reading the validation log

| `check_name` | Means |
| --- | --- |
| `omi:uid_rejected` | A call arrived with a uid not in `OMI_ALLOWED_UIDS`. `sample.uid` is the uid. |
| `omi:shadow` | Shadow mode. `sample` is the exact payload that would have been written. |
| `omi:conflict` | An item contradicts active decision `sample.decision_id`. The decision was not changed. |
| `omi:restated` | Something already decided was said again. No row was created; the decision was not re-verified. |
| `omi:ingest_failed` | The ingest threw. `sample` has the conversation id, a byte count, the stage and the error — never any transcript text. |

## Failure behaviour

Any extraction or write failure logs `omi:ingest_failed` and rethrows, so the
route answers 500 and n8n retries. That is safe: the idempotency key means a
retry either writes the conversation for the first time or returns
`duplicate_event`.

A failure that is *not* an error — a conversation with no business content —
writes a `claude_transcript_ledger` row with `disposition='no_content'` so the
conversation is never reprocessed.

## Rollback

Set `OMI_INGEST_MODE=off`. The route answers 503 immediately; nothing else in
the service reads the Omi path. To undo the data, the rows are all findable:
`claude_pending_items WHERE origin='omi'` and
`claude_session_logs WHERE log_origin='omi'`.

## Files

| File | What |
| --- | --- |
| `sql/101_omi_memory_source.sql` | constraints, `claude_omi_ingest()`, the pack v6, the index |
| `src/memory/omi-ingest.js` | normalize, extract, scrub, dedupe, conflict check, write |
| `src/memory/omi-routes.js` | `POST /memory/omi/ingest` and its three guards |
| `src/memory/omi-db.js` | the table-allowlisted Supabase proxy |
| `docs/n8n/omi-memory-ingest.json` | the importable relay workflow |
| `scripts/test-omi-ingest.js` | `node --test scripts/test-omi-ingest.js` |
| `scripts/fixtures/omi-conversation.json` | synthetic payload; the shape reference |
