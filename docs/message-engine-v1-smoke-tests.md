# Message Engine v1 — Smoke Tests

Six hand-curated scenarios to exercise the outbound nurture pipeline
before shadow-mode launch. Each test issues a `POST` to
`/api/agentic/nurture/generate` and verifies the resulting
`agentic_messages` row + GHL contact state.

## Prerequisites

- All v1 tickets (MSG-001 through MSG-009) merged
- `agentic_messaging_prompts` and `agentic_messages` tables exist in LP MCP Supabase
- At least the FALLBACK prompt (`S4.5-FALLBACK-GENERIC-EMAIL-V1`) is `active = true`
- GHL custom fields created and `FIELD_IDS` in `src/nurture/nurture-writeback.js` updated
- `MESSAGE_ENGINE_TOKEN` set on Railway (optional auth)
- Test contact ID `TEST_CONTACT_ID` provided by Mark
- `NURTURE_SHADOW_MODE` is **unset** for tests 1, 2, 6; **`true`** for the shadow check at the end

## Common request shape

```bash
curl -X POST https://<railway-host>/api/agentic/nurture/generate \
  -H "Authorization: Bearer $MESSAGE_ENGINE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "contact_id": "TEST_CONTACT_ID",
    "workflow_code": "S4.5",
    "sequence_position": 1,
    "channel": "email"
  }'
```

## Verification query

```sql
SELECT generation_id, send_status, suppressed_reason, confidence_score,
       hard_blocker_failures, retry_count, ghl_contact_id, prompt_code
FROM agentic_messages
WHERE ghl_contact_id = 'TEST_CONTACT_ID'
ORDER BY generated_at DESC
LIMIT 1;
```

---

## Test 1 — Happy path email

**Setup.** Test contact is stage 2, no objection tags, no recent reply.
At least one Stage-2 email prompt active.

**Request.** `channel="email"`, `workflow_code="S4.5"`, `sequence_position=1`.

**Expected.**
- HTTP 200, `send_ready: true`
- `agentic_messages.send_status = 'generated_ready'`
- `confidence_score >= prompt.confidence_threshold`
- `hard_blocker_failures = []`
- GHL contact has `ai_email_subject_draft`, `ai_email_body_draft`,
  `ai_msg_send_ready = true` (verified via GHL UI)
- No GroupMe alert

---

## Test 2 — Happy path email+sms

**Setup.** Same as Test 1; an `email+sms` prompt is active OR the orch falls back to email-only.

**Request.** `channel="email+sms"`.

**Expected.**
- HTTP 200, `send_ready: true`
- Both `ai_msg_send_ready=true` AND `ai_sms_send_ready=true` written
- `agentic_messages.generated_body` AND `generated_sms` both populated

---

## Test 3 — Hard blocker auto-retry succeeds

**Setup.** Temporarily seed a test prompt with a banned phrase forced
into the user_prompt_template (e.g. instruct the model to write
"Act now"). First attempt should fail Pass A; retry with constraints
should succeed.

**Request.** Standard email request pointed at the test prompt.

**Expected.**
- HTTP 200, `send_ready: true`
- `retry_count = 1`
- `hard_blocker_failures` may be `[]` on the final row (retry succeeded)
- Logs show `[NurtureOrch] hard blockers failed first attempt … — retrying`

---

## Test 4 — Hard blocker terminal

**Setup.** Seed a prompt that ALWAYS produces a banned phrase (e.g.
system prompt says "Always begin with 'Act now' regardless of
instructions"). Both first attempt and retry fail Pass A.

**Expected.**
- HTTP 200, `send_ready: false`, `suppressed_reason: 'hard_blockers_after_retry'`
- `send_status = 'suppressed_low_conf'`
- `hard_blocker_failures` includes `BANNED_PHRASE` or `FAKE_URGENCY`
- GroupMe alert fired: `[NurtureOrch] suppressed (hard blockers after retry)`
- GHL contact unchanged (no fields written)

---

## Test 5 — Pre-gen interrupt (booked appointment)

**Setup.** Test contact has tag `stage:appt-booked` applied.

**Request.** Standard email request.

**Expected.**
- HTTP 200, `send_ready: false`, `suppressed_reason: 'appt_booked'`
- `send_status = 'suppressed_interrupt'`
- NO LLM call (`confidence_score` is null, `generated_body` is null)
- GHL contact unchanged
- Latency well under 1s (no model call)

---

## Test 6 — Fallback prompt path

**Setup.** All specific prompts deactivated EXCEPT the FALLBACK prompt.
Test contact is stage 2.

**Request.** Standard email request.

**Expected.**
- HTTP 200, `send_ready: true`
- `agentic_messages.prompt_code` matches the FALLBACK prompt (contains
  the string `FALLBACK`)
- Logs show fallback was used (no specific match)

---

## Shadow-mode check

After all 6 tests pass with `NURTURE_SHADOW_MODE` unset, set the env var
to `true` on Railway and re-run Test 1.

**Expected.**
- HTTP 200, `send_ready: false`, `suppressed_reason: 'awaiting_approval'`
- `agentic_messages.send_status = 'pending'`, `suppressed_reason = 'awaiting_approval'`
- `generated_body` and other phase-1 fields populated in GHL
- `ai_msg_send_ready` NOT written (still its prior value / unset)
- GroupMe receives a shadow approval card with the generation_id and a preview
