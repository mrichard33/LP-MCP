# Claude Code Handoff — Wire CALLBACK resolution + customer-status probe

**Repo:** `mrichard33/LP-MCP` · **Branch:** `fix/customer-status-probe` (already exists — do NOT create a new one, do NOT touch `main`)
**File to edit:** `src/send-message-handler.js` (110KB — too large for MCP push, hence this handoff)
**Companion module (already committed to this branch):** `src/knowledge/callback-resolver.js`

## Why

- `sql/017` rewired the CALLBACK intent's handoff tag to the placeholder `hdl:callback-pending-classification` and promised a gen-time rewrite in response-generator v2.5. It was never built. No GHL workflow listens on the placeholder (verified live 2026-07-08: only `hdl:callback-sales` → I.HDL-1 and `hdl:callback-service` → I.HDL-2 have tag triggers). Every "call me back" inbound tags a dead tag and the lead gets silence.
- `sql/018`'s CUSTOMER_STATUS_AFFIRMATIVE / _NEGATIVE gates require `pending:customer-status-check` (intent-classifier v1.2 precondition) — and nothing in the codebase applies that tag, so both gates are inert.

This wiring fixes both: known customer → `hdl:callback-service`; known lead → `hdl:callback-sales`; truly unknown → send the probe SMS directly and apply `pending:customer-status-check`; when the yes/no gate later fires, clear the pending tag.

## Edits — apply these 6 str_replace operations exactly

### Edit 1 — import the resolver

**old_str:**
```
import { resolveReplyContext, guardDisclosure, fetchRecentMessages } from './agentic/reply-sender.js';
```

**new_str:**
```
import { resolveReplyContext, guardDisclosure, fetchRecentMessages } from './agentic/reply-sender.js';
// 2026-07-08 — CALLBACK resolution + HDL.3 customer-status probe
// (closes the sql/017/018 gap; see src/knowledge/callback-resolver.js).
import {
  resolveCallbackHandoff,
  buildCustomerStatusProbe,
  CUSTOMER_STATUS_PENDING_TAG,
  CUSTOMER_STATUS_GATE_INTENT_SET,
  CALLBACK_TAG_SALES,
} from './knowledge/callback-resolver.js';
```

### Edit 2 — add removeContactTags helper (mirror of applyContactTags)

**old_str:**
```
  } catch (err) {
    console.warn(`[SendMessage] applyContactTags threw: ${err.message}`);
    return false;
  }
}
```

**new_str:**
```
  } catch (err) {
    console.warn(`[SendMessage] applyContactTags threw: ${err.message}`);
    return false;
  }
}

/**
 * 2026-07-08 — Remove tags from a contact. Mirror of applyContactTags for
 * GHL's DELETE /contacts/{id}/tags endpoint. Returns true on success,
 * false on any failure (never throws).
 */
async function removeContactTags(contactId, tagList) {
  if (!contactId || !Array.isArray(tagList) || tagList.length === 0) return false;
  if (!GHL_API_KEY) return false;
  const filtered = tagList.filter(t => typeof t === 'string' && t.length > 0);
  if (filtered.length === 0) return false;

  try {
    await acquireToken();
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ tags: filtered }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 429) {
      report429();
      console.warn(`[SendMessage] removeContactTags 429 for ${contactId}`);
      return false;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[SendMessage] removeContactTags ${res.status}: ${text.slice(0, 150)}`);
      return false;
    }
    bumpContactCache(contactId);
    return true;
  } catch (err) {
    console.warn(`[SendMessage] removeContactTags threw: ${err.message}`);
    return false;
  }
}
```

### Edit 3 — handleShortCircuit: CALLBACK resolution + pending-tag clear

**old_str:**
```
async function handleShortCircuit(contactId, generated, action, context) {
  const handoffTag = generated.handoff_tag;
  const isDQ = !!generated.is_disqualifier;

  const tagsToApply = [];
  if (handoffTag) tagsToApply.push(handoffTag);
  if (isDQ) tagsToApply.push('suppress-automation');

  let tagApplied = false;
  if (tagsToApply.length > 0) {
    tagApplied = await applyContactTags(contactId, tagsToApply);
  }
```

**new_str:**
```
async function handleShortCircuit(contactId, generated, action, context, opts = {}) {
  let handoffTag = generated.handoff_tag;
  const isDQ = !!generated.is_disqualifier;
  const contactTags = Array.isArray(opts.tags) ? opts.tags : [];

  // ── CALLBACK resolution (2026-07-08 — closes the sql/017/018 gap) ──
  // The classifier hands CALLBACK off with the placeholder tag
  // hdl:callback-pending-classification, which NO GHL workflow listens on
  // (verified live: only hdl:callback-sales → I.HDL-1 and
  // hdl:callback-service → I.HDL-2 have tag triggers). sql/017 promised a
  // gen-time rewrite that was never built — every CALLBACK inbound was
  // applying a dead tag and going silent. Resolve it here:
  //   known customer → hdl:callback-service
  //   known lead     → hdl:callback-sales
  //   ambiguous      → send the HDL.3 customer-status probe directly and
  //                    apply pending:customer-status-check so the sql/018
  //                    yes/no gates can interpret the answer.
  let callbackBasis = null;
  if (generated.intent_class === 'CALLBACK') {
    if (contactTags.includes(CUSTOMER_STATUS_PENDING_TAG)) {
      // Probe already outstanding and the lead asked for a callback again
      // without answering it — stop asking, default to the sales queue so
      // a human picks it up (sales can transfer a customer).
      handoffTag = CALLBACK_TAG_SALES;
      callbackBasis = 'probe_pending_default_sales';
    } else {
      const resolution = await resolveCallbackHandoff(contactId);
      if (resolution.tag) {
        handoffTag = resolution.tag;
        callbackBasis = resolution.basis;
      } else {
        // Ambiguous — ask the probe instead of handing off.
        return await sendCustomerStatusProbe(contactId, generated, action, context, opts);
      }
    }
    console.log(`[SendMessage] CALLBACK resolved for ${contactId}: ${handoffTag} (${callbackBasis})`);
  }

  const tagsToApply = [];
  if (handoffTag) tagsToApply.push(handoffTag);
  if (isDQ) tagsToApply.push('suppress-automation');

  let tagApplied = false;
  if (tagsToApply.length > 0) {
    tagApplied = await applyContactTags(contactId, tagsToApply);
  }

  // ── Customer-status probe answered → clear the pending tag ────────
  // The CUSTOMER_STATUS_* gates only fire while pending:customer-status-
  // check is on the contact (intent-classifier v1.2 precondition). Once
  // the answer routes to a concrete hdl:* queue the probe is resolved —
  // clear the tag so a short "yes"/"no" weeks later can never re-trip it.
  let pendingCleared = false;
  if (
    CUSTOMER_STATUS_GATE_INTENT_SET.has(generated.intent_class) &&
    contactTags.includes(CUSTOMER_STATUS_PENDING_TAG)
  ) {
    pendingCleared = await removeContactTags(contactId, [CUSTOMER_STATUS_PENDING_TAG]);
    console.log(`[SendMessage] customer-status probe answered by ${contactId} → ${handoffTag}; pending tag ${pendingCleared ? 'cleared' : 'CLEAR FAILED'}`);
  }
```

### Edit 4 — handleShortCircuit: GroupMe basis line

**old_str:**
```
    `Method: ${generated.classification_method || 'unknown'} (${(generated.classifier_confidence || 0).toFixed(2)})\n` +
```

**new_str:**
```
    `Method: ${generated.classification_method || 'unknown'} (${(generated.classifier_confidence || 0).toFixed(2)})\n` +
    (callbackBasis ? `Callback basis: ${callbackBasis}\n` : '') +
```

### Edit 5 — handleShortCircuit: return fields + append probe sender function

**old_str:**
```
    classifier_confidence: generated.classifier_confidence,
    classification_method: generated.classification_method,
    reason: 'compliance_gate_handoff',
  };
}
```

**new_str:**
```
    classifier_confidence: generated.classifier_confidence,
    classification_method: generated.classification_method,
    callback_basis: callbackBasis,
    pending_cleared: pendingCleared,
    reason: 'compliance_gate_handoff',
  };
}

/**
 * 2026-07-08 — HDL.3 customer-status probe.
 *
 * Fires when a CALLBACK short-circuit resolves AMBIGUOUS (no customer or
 * lead signals on record). Applies pending:customer-status-check — the
 * precondition the sql/018 CUSTOMER_STATUS_* gates require — then sends
 * the probe question directly. The lead's short yes/no answer routes to
 * hdl:callback-service / hdl:callback-sales via the gates, and
 * handleShortCircuit clears the pending tag when that happens.
 *
 * Ordering: the tag is applied BEFORE the send. If the send fails and the
 * executor retries, handleShortCircuit sees the pending tag on the retry
 * and defaults to hdl:callback-sales — the lead always reaches a human.
 * If TAG application fails, we don't ask a question the system can't hear
 * the answer to — fall straight back to the sales queue.
 */
async function sendCustomerStatusProbe(contactId, generated, action, context, opts = {}) {
  const rawChannel = opts.channel || generated.channel || 'sms';
  const channel = rawChannel === 'email' ? 'email' : rawChannel === 'livechat' ? 'livechat' : 'sms';

  let firstName = null;
  try {
    const { name } = await resolveContactInfo(contactId, context);
    firstName = (name || '').trim().split(/\s+/)[0] || null;
  } catch { /* fail-soft — probe copy has a no-name variant */ }

  const message = buildCustomerStatusProbe(firstName);

  const primed = await applyContactTags(contactId, [CUSTOMER_STATUS_PENDING_TAG]);
  if (!primed) {
    const fallbackApplied = await applyContactTags(contactId, [CALLBACK_TAG_SALES]);
    console.warn(`[SendMessage] probe priming failed for ${contactId} — falling back to ${CALLBACK_TAG_SALES} (applied: ${fallbackApplied})`);
    return {
      action: 'send_message_handed_off',
      contact_id: contactId,
      channel,
      intent_class: generated.intent_class,
      handler_code: generated.handler_code,
      handoff_tag: CALLBACK_TAG_SALES,
      tags_applied: fallbackApplied ? [CALLBACK_TAG_SALES] : [],
      is_disqualifier: false,
      classifier_confidence: generated.classifier_confidence,
      classification_method: generated.classification_method,
      reason: 'probe_priming_failed_fallback_sales',
    };
  }

  const { result: sendResult, sendMethod } = await sendWithFallback(
    contactId, message, channel, null, action,
    { fromNumber: opts.replyContext?.fromNumber || null }
  );

  // GHL 2xx IS the success — commit the sent marker so a watchdog retry
  // dedups instead of re-sending (same rationale as the main send path).
  if (action.id != null) {
    await commitAgenticSend(contactId, String(action.id), {
      message_id: sendResult?.messageId || null,
      conversation_id: sendResult?.conversationId || null,
    });
  }

  sendGroupMeMessage(
    `❓ CUSTOMER-STATUS PROBE SENT\n` +
    `👤 ${context?.contact_name || action?.action_payload?.contact_name || contactId}\n` +
    `Lead asked for a callback but has no customer/lead signals on record.\n` +
    `Tag applied: ${CUSTOMER_STATUS_PENDING_TAG}\n` +
    `Probe: "${message.slice(0, 120)}"\n` +
    `→ Their yes/no answer routes to hdl:callback-service / hdl:callback-sales.`
  ).catch(err => console.warn(`[SendMessage] GroupMe (probe) failed: ${err.message}`));

  console.log(`[SendMessage] ❓ CUSTOMER-STATUS PROBE sent to ${contactId} via ${sendMethod} (${channel})`);

  return {
    action: 'message_sent',
    contact_id: contactId,
    channel,
    message_length: message.length,
    sent_body: String(message).slice(0, 500),
    rule_trigger: action.rule_applied || 'manual',
    send_method: sendMethod,
    conversation_id: sendResult?.conversationId || null,
    message_id: sendResult?.messageId || null,
    ai_generated: false,
    intent_class: generated.intent_class,
    classifier_method: generated.classification_method,
    reason: 'customer_status_probe_sent',
    customer_status_probe: true,
    tags_applied: [CUSTOMER_STATUS_PENDING_TAG],
    _agentic_committed: action.id != null,
  };
}
```

### Edit 6 — call site: pass channel / replyContext / tags into the short-circuit

**old_str:**
```
        if (generated.short_circuit) {
          return await handleShortCircuit(contactId, generated, action, context);
        }
```

**new_str:**
```
        if (generated.short_circuit) {
          return await handleShortCircuit(contactId, generated, action, context, {
            channel,
            replyContext,
            tags,
          });
        }
```

## After applying

1. `node --check src/send-message-handler.js` and `node --check src/knowledge/callback-resolver.js`
2. Commit to `fix/customer-status-probe` with a plain-language WHAT/WHY/impact message (see the resolver module's commit for the root-cause writeup). The PR against `main` is already open — this commit completes it.
3. Do NOT merge to `main` from Claude Code — Mark reviews and merges (Railway auto-deploys on merge).

## Test plan (after deploy, Mark Test contact `0kk3xz6XatILy8jajymX`)

Mark Test carries funnel tags, so a plain "call me back" should resolve `funnel_tags_present` → `hdl:callback-sales` → I.HDL-1 fires. To test the probe branch, use a fresh throwaway contact with `agentic-active` and no other tags/opp/LP record:

1. Text "can someone call me back" → expect probe SMS + `pending:customer-status-check` applied + GroupMe "CUSTOMER-STATUS PROBE SENT".
2. Reply "yes current customer" → expect `hdl:callback-service` applied, pending tag removed, I.HDL-2 sends the dynamic callback SMS.
3. Repeat 1 on another fresh contact, reply "no, new" → expect `hdl:callback-sales`, pending tag removed, I.HDL-1 fires.
4. Reply with a long unrelated message while primed → v1.2 guard downgrades to UNCLEAR, normal AI reply, pending tag stays (probe still outstanding) — expected.

## Known follow-ups (not in this PR)

- **approval-path.js parity:** approval-path also handles `compliance_gate_handoff` during pre-generation (L~598). Rules with `requires_approval=true` that hit a CALLBACK short-circuit there would still apply the dead placeholder. The live agentic reply rule (AGENTIC_RESPOND_POST_CHATBOT) auto-fires through executeSendMessage, so this PR covers the hot path. Verify/mirror in a follow-up.
- **Stale pending tag:** if a primed lead never answers and never triggers a gate, the tag lingers. Blast radius is bounded by the v1.2 ≤8-word guard and the fact that both gates only route to a human callback queue. A TTL sweep can come later if it ever bites.
- **sql/018 header comment** still claims the guard lives in "response-generator.js v2.5 postProcessClassification" — stale; reality is intent-classifier v1.2 + this wiring. Doc-only.
