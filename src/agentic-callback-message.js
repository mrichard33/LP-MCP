/**
 * Agentic Callback Message — src/agentic-callback-message.js
 *
 * Single-purpose endpoint that generates a short, dynamic SMS reply
 * for the HDL.2 (Sales Callback Handler) GHL workflow.
 *
 * Why this exists:
 *   HDL.2 fires when a lead is handed off to a service/sales callback
 *   queue (tags hdl:callback-service, hdl:callback-sales, etc.). The
 *   pre-existing workflow shipped TWO static SMS templates:
 *
 *     within-hours: "Hi {{contact.first_name}}, connecting you with
 *                   our {{contact.service_market_name}} office at
 *                   {{contact.service_phone_display}}. They're picking
 *                   up now. If the call drops, just call them back at
 *                   that number."
 *     after-hours: "Hi {{contact.first_name}}, our
 *                   {{contact.service_market_name}} office is closed
 *                   right now (we're open Mon-Fri 8 AM to 5 PM ET).
 *                   Call us at {{contact.service_phone_display}} during
 *                   those hours and we'll take care of you."
 *
 *   Those templates work for clean intent — but break on edge cases.
 *   E.g. on 2026-04-30 Mark (testing) replied "Yes 30435" by mistake
 *   (typed an action ID where he meant to hit Yes in GroupMe). That
 *   inbound matched CUSTOMER_STATUS_AFFIRMATIVE, fired hdl:callback-
 *   service, HDL.2 took over, and the static template went out as if
 *   it answered a real service request. The lead got a generic
 *   handoff for nothing.
 *
 *   This endpoint replaces the static body with a dynamic one. The
 *   workflow now calls /api/agentic/dynamic-callback-message just
 *   before each SMS step, and the SMS body becomes
 *   {{custom_webhook.N.response.message}}.
 *
 * Endpoint:
 *   POST /api/agentic/dynamic-callback-message
 *
 * Request body (all fields optional except recent_inbound_message):
 *   {
 *     "first_name":              "Mark",
 *     "recent_inbound_message":  "Yes 30435",          REQUIRED
 *     "market_name":             "Boca Raton / Palm Beach",
 *     "service_phone_display":   "(754) 203-9190",
 *     "has_dedicated_phone":     true,
 *     "business_hours":          true,                 // optional override
 *     "contact_id":              "abc123",             // logging only
 *     "handoff_reason":          "callback-service",   // logging only
 *     "callback_type":           "service" | "sales"   // tone hint
 *   }
 *
 *   If business_hours is omitted, we compute it from current ET time
 *   (Mon-Fri 8:00-17:00 America/New_York). This way the workflow
 *   doesn't have to do timezone math; the LP MCP is the source of
 *   truth.
 *
 * Response (always 200, never 4xx/5xx — GHL workflows can't
 * gracefully handle non-200 responses; we return a safe fallback
 * message instead so the SMS still goes out):
 *   {
 *     "message":         "Hey Mark — got your message. Connecting you...",
 *     "reasoning":       "Lead's inbound was ambiguous; warm acknowledgment + handoff.",
 *     "business_hours":  true,
 *     "fell_back":       false,    // true if we used the static fallback
 *     "model":           "claude-sonnet-4-6",
 *     "elapsed_ms":      842,
 *     "request_id":      "a1b2c3d4"
 *   }
 *
 * Audit logging (added 2026-04-30):
 *   Every successful response (AI or fallback) is also written to the
 *   agentic_callback_log Supabase table for prompt tuning and ops
 *   visibility. The write is fire-and-forget — failures are logged
 *   but do NOT block or alter the HTTP response.
 *
 *   The audit row captures BOTH the message that was actually returned
 *   AND the static-fallback equivalent that the OLD template would
 *   have produced — so Mark can run side-by-side comparisons:
 *     SELECT recent_inbound_message,
 *            message AS ai_msg,
 *            static_fallback_message AS old_template
 *     FROM agentic_callback_log
 *     WHERE fell_back = false
 *     ORDER BY created_at DESC
 *     LIMIT 20;
 *
 *   See sql/agentic_callback_log.sql for the table DDL.
 *
 * Failure modes & fallback:
 *   - Claude API down / 5xx / timeout (8s)  → static template
 *   - Missing ANTHROPIC_API_KEY in env       → static template
 *   - Invalid JSON in Claude response        → static template
 *   - Empty/missing message field            → static template
 *   In all fallback cases the workflow still gets a usable SMS body.
 *   `fell_back: true` is set so the audit trail shows when the AI
 *   path didn't run.
 *
 * Latency budget: 8s timeout. The workflow's custom_webhook step
 * blocks on the response before the SMS step; if Claude is slow,
 * the lead waits. 8s is a conservative cap — typical responses
 * land in 1-3s.
 */

import crypto from 'crypto';
import supabase from './supabase.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.CALLBACK_MESSAGE_MODEL
  || process.env.RESPONSE_GENERATOR_MODEL
  || 'claude-sonnet-4-6';
const MAX_TOKENS = parseInt(process.env.CALLBACK_MESSAGE_MAX_TOKENS || '300', 10);
const TIMEOUT_MS = parseInt(process.env.CALLBACK_MESSAGE_TIMEOUT_MS || '8000', 10);
const TIMEZONE = process.env.REECE_TIMEZONE || 'America/New_York';

// ═══════════════════════════════════════════════════════════════════
// SYSTEM PROMPT
// ═══════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You write a single short SMS reply for Reece Windows & Doors when a lead is being handed off from the agentic responder to a human team (sales or service callback queue).

CONTEXT
The lead has just sent an inbound message that triggered a handoff. The exact handoff tag varies (hdl:callback-service, hdl:callback-sales) but the SMS purpose is the same: acknowledge what they said, point them at the right office, and hand off cleanly. A human team takes it from here.

Two paths:
- WITHIN BUSINESS HOURS (Mon-Fri 8 AM-5 PM ET): the office can pick up now. The SMS confirms the handoff and gives the dispatch number as a fallback in case the call drops.
- OUTSIDE BUSINESS HOURS: the office is closed. The SMS lets the lead know the hours and gives them the number to call back.

VOICE
- First person plural ("we", "our team") — never "I"
- Warm and natural, like a knowledgeable South Florida neighbor — not robotic, not pushy, not corporate
- Use the lead's first name if provided
- Reference what they actually said when it makes sense (e.g. "got your message", "sorry to hear about the windows"); if their message is gibberish, garbled, or off-topic, just acknowledge generically ("got your message") and move on — don't echo nonsense back at them
- Acknowledge the specific market by name ("our Boca Raton / Palm Beach office") so the handoff feels rooted, not generic
- Always provide the service phone number in the format given (don't reformat)

HARD RULES
- 1-2 sentences max. Under 200 characters ideal, 320 max.
- Plain text only. No emojis. No exclamation marks. No ALL CAPS.
- No markdown, no formatting, no links.
- Never quote prices or estimates.
- Never invent product details, hours, or services we don't offer.
- Never pretend the call is already happening if business_hours=false.
- Never say "I just sent an email" or reference any external content.
- Never sell, upsell, or pitch — this is a clean handoff, not a sales touch.
- For ambiguous, garbled, or accidental inbounds (typos, single words, fragmented messages), DO NOT try to interpret literal content. Just give a warm generic acknowledgment and hand off.

CONTENT EXPECTATIONS BY PATH

WITHIN BUSINESS HOURS:
- Acknowledge briefly (1 short clause): "Hey [Name] — got your message" or similar adapted to what they said.
- State the handoff: "connecting you with our [market] office at [phone]" or "our [market] team is on it — call them at [phone]".
- One safety net line: "if the call drops, just call back at that number" OR "they'll reach out shortly" — pick whichever fits.

OUTSIDE BUSINESS HOURS:
- Acknowledge briefly.
- State that the office is closed AND the hours: "(Mon-Fri 8 AM to 5 PM ET)".
- Provide the dispatch number to call during hours.

GOOD EXAMPLES

Inbound: "Yes 30435"  (gibberish/typo)
Within hours, market=Boca Raton / Palm Beach, phone=(754) 203-9190, name=Mark:
"Hey Mark — got your message. We're connecting you with our Boca Raton / Palm Beach office now at (754) 203-9190. If the call drops, just call them back at that number."

Inbound: "Yes 30435"
After hours, market=Boca Raton / Palm Beach, phone=(754) 203-9190, name=Mark:
"Hey Mark — got your message. Our Boca Raton / Palm Beach office is closed right now (Mon-Fri 8 AM to 5 PM ET). Give them a call at (754) 203-9190 during those hours and we'll take care of you."

Inbound: "My windows won't close all the way and I have a leak"
Within hours, market=Ft. Lauderdale, phone=(754) 203-9190, name=Sarah:
"Hey Sarah — sorry to hear that. Our Ft. Lauderdale service team is on it; they'll be reaching out from (754) 203-9190 shortly. If the call drops, just call them back at that number."

Inbound: "Hello?? Is anyone there?"
After hours, market=Central Florida, phone=(800) 555-1234, name=Jim:
"Hey Jim — sorry for the wait. Our Central Florida office is closed right now (Mon-Fri 8 AM to 5 PM ET). Give them a call at (800) 555-1234 first thing tomorrow and we'll take care of you."

Inbound: "Cancel"
Within hours, name=Robert:
"Hey Robert — got your message. We're connecting you with our team at the office now so they can get this sorted. If the call drops, just call them back at the number we sent."

OUTPUT FORMAT
Return ONLY a valid JSON object. The first character must be { and the last must be }. No preamble, no markdown fences, no commentary.
{
  "message": "the SMS body to send",
  "reasoning": "1 sentence explaining your read of the inbound and the handoff approach"
}`;

// ═══════════════════════════════════════════════════════════════════
// BUSINESS HOURS LOGIC
// ═══════════════════════════════════════════════════════════════════

/**
 * Are we currently within Reece's stated business hours?
 * Mon-Fri 8 AM - 5 PM, America/New_York. Returns boolean.
 */
function isWithinBusinessHours(now = new Date()) {
  // Use Intl to get the day of week + hour in ET regardless of server tz.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const weekday = parts.find(p => p.type === 'weekday')?.value || '';
  const hourStr = parts.find(p => p.type === 'hour')?.value || '0';
  const hour = parseInt(hourStr, 10);

  const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday);
  const isInWindow = hour >= 8 && hour < 17;
  return isWeekday && isInWindow;
}

// ═══════════════════════════════════════════════════════════════════
// FALLBACK TEMPLATES (when AI path fails — also written to audit log
// on EVERY row for side-by-side comparison)
// ═══════════════════════════════════════════════════════════════════

function buildFallbackMessage({ first_name, market_name, service_phone_display, business_hours }) {
  const name = first_name ? `${first_name}` : 'there';
  const market = market_name || 'our team';
  const phone = service_phone_display || '(954) 800-8906';

  if (business_hours) {
    return `Hi ${name}, connecting you with our ${market} office at ${phone}. ` +
           `They're picking up now. If the call drops, just call them back at that number.`;
  }
  return `Hi ${name}, our ${market} office is closed right now (we're open Mon-Fri 8 AM to 5 PM ET). ` +
         `Call us at ${phone} during those hours and we'll take care of you.`;
}

// ═══════════════════════════════════════════════════════════════════
// CLAUDE CALL
// ═══════════════════════════════════════════════════════════════════

function buildUserPrompt(input) {
  const lines = [];
  lines.push('Generate the SMS reply.');
  lines.push('');

  lines.push(`Lead's first name: ${input.first_name || '(not provided — use a warm generic opener like "Hey there" or just lead with "Got your message")'}`);
  lines.push(`Lead's inbound message (verbatim, this is what they just sent): "${(input.recent_inbound_message || '').slice(0, 400)}"`);
  lines.push(`Service market name: ${input.market_name || 'our team'}`);
  lines.push(`Dispatch phone number (use this format VERBATIM in the message): ${input.service_phone_display || '(954) 800-8906'}`);

  lines.push('');
  if (input.business_hours) {
    lines.push('PATH: WITHIN BUSINESS HOURS — the office can pick up now. The SMS confirms the handoff and gives the number as a fallback in case the call drops.');
  } else {
    lines.push('PATH: OUTSIDE BUSINESS HOURS — the office is closed. The SMS gives them the hours (Mon-Fri 8 AM to 5 PM ET) and the number to call during those hours.');
  }

  if (input.callback_type) {
    const typeHint = input.callback_type === 'sales'
      ? 'Callback type: SALES (lead is at a sales decision point, not a service issue) — keep tone slightly warmer and forward-leaning.'
      : 'Callback type: SERVICE (existing customer with a question or concern about already-installed product) — keep tone empathetic and solution-oriented.';
    lines.push(typeHint);
  }

  if (input.has_dedicated_phone === false) {
    lines.push('Note: this market does not have a dedicated service line — the dispatch number is the general office number. Tone unchanged, just be aware.');
  }

  lines.push('');
  lines.push('Apply the SYSTEM PROMPT rules and return the JSON object only. Remember: if the inbound is gibberish, a typo, or otherwise nonsensical, DO NOT echo it back — give a warm generic acknowledgment and hand off cleanly.');

  return lines.join('\n');
}

async function callClaude(userPrompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Claude API ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = data.content
    ?.filter(block => block.type === 'text')
    .map(block => block.text)
    .join('') || '';

  return parseJson(text);
}

function parseJson(text) {
  let clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error(`No valid JSON object in Claude response: ${text.slice(0, 200)}`);
    }
    return JSON.parse(clean.slice(start, end + 1));
  }
}

// ═══════════════════════════════════════════════════════════════════
// AUDIT LOG
// ═══════════════════════════════════════════════════════════════════

/**
 * Fire-and-forget write to agentic_callback_log. Failures (table
 * missing, RLS denial, network blip) are logged at warn level but
 * NEVER thrown — the HTTP response has already been sent by the time
 * this runs, and a missed audit row is acceptable; a failed request
 * is not.
 *
 * Called by the route handler with the full input + result so we
 * can capture everything in a single row.
 */
async function logToAudit(input, result) {
  try {
    const row = {
      contact_id:              input.contact_id || null,
      first_name:              input.first_name || null,
      recent_inbound_message:  input.recent_inbound_message || null,
      market_name:             input.market_name || null,
      service_phone_display:   input.service_phone_display || null,
      has_dedicated_phone:     typeof input.has_dedicated_phone === 'boolean'
        ? input.has_dedicated_phone
        : null,
      business_hours:          result.business_hours,
      callback_type:           input.callback_type || null,
      handoff_reason:          input.handoff_reason || null,

      message:                 result.message || null,
      reasoning:               result.reasoning || null,
      fell_back:               !!result.fell_back,
      fell_back_reason:        result.fell_back_reason || null,

      static_fallback_message: result.static_fallback_message || null,

      model:                   result.model || null,
      elapsed_ms:              typeof result.elapsed_ms === 'number' ? result.elapsed_ms : null,
      request_id:              result.request_id || null,
      message_length:          typeof result.message === 'string' ? result.message.length : null,
    };

    const { error } = await supabase.from('agentic_callback_log').insert(row);
    if (error) {
      // Most likely cause: table doesn't exist yet (Mark hasn't run the
      // CREATE TABLE in Supabase dashboard). Log once at warn — the
      // endpoint stays functional regardless.
      console.warn(`[CallbackMessage] audit_log_insert error: ${error.message}`);
    }
  } catch (err) {
    console.warn(`[CallbackMessage] audit_log_insert threw: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════

async function generateCallbackMessage(input) {
  const reqId = crypto.randomBytes(4).toString('hex');
  const startedAt = Date.now();

  // Resolve business_hours: explicit override wins, otherwise compute.
  const business_hours = typeof input.business_hours === 'boolean'
    ? input.business_hours
    : isWithinBusinessHours();

  // Always compute the static-fallback equivalent. We attach it to the
  // result so the audit log has a side-by-side baseline regardless of
  // whether the AI path ran. Cheap to compute (pure string concat).
  const static_fallback_message = buildFallbackMessage({ ...input, business_hours });

  // Hard-required: a non-empty inbound message.
  const trimmedInbound = (input.recent_inbound_message || '').trim();
  if (!trimmedInbound) {
    console.log(`[CallbackMessage] [${reqId}] no_inbound_message — fallback (${Date.now() - startedAt}ms)`);
    return {
      message: static_fallback_message,
      reasoning: 'No recent_inbound_message provided — used static fallback template.',
      business_hours,
      fell_back: true,
      fell_back_reason: 'missing_inbound_message',
      static_fallback_message,
      model: null,
      elapsed_ms: Date.now() - startedAt,
      request_id: reqId,
    };
  }

  // No API key configured — fall back without trying Claude.
  if (!ANTHROPIC_API_KEY) {
    console.warn(`[CallbackMessage] [${reqId}] no_api_key — fallback (${Date.now() - startedAt}ms)`);
    return {
      message: static_fallback_message,
      reasoning: 'ANTHROPIC_API_KEY not configured — used static fallback template.',
      business_hours,
      fell_back: true,
      fell_back_reason: 'no_api_key',
      static_fallback_message,
      model: null,
      elapsed_ms: Date.now() - startedAt,
      request_id: reqId,
    };
  }

  const userPrompt = buildUserPrompt({ ...input, business_hours });

  try {
    const parsed = await callClaude(userPrompt);
    const message = typeof parsed?.message === 'string' ? parsed.message.trim() : '';
    if (!message) {
      throw new Error('AI returned empty message field');
    }

    // Final length sanity — clamp at 480 chars (3 SMS segments). The
    // prompt asks for ~200; this is a defensive ceiling, not a target.
    const clamped = message.length > 480 ? message.slice(0, 480) : message;

    const elapsed = Date.now() - startedAt;
    console.log(`[CallbackMessage] [${reqId}] ok contact=${input.contact_id || 'n/a'} ` +
      `market=${input.market_name || 'n/a'} hours=${business_hours} ` +
      `len=${clamped.length} model=${MODEL} (${elapsed}ms)`);

    return {
      message: clamped,
      reasoning: typeof parsed?.reasoning === 'string' ? parsed.reasoning.slice(0, 400) : null,
      business_hours,
      fell_back: false,
      static_fallback_message,
      model: MODEL,
      elapsed_ms: elapsed,
      request_id: reqId,
    };
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    console.warn(`[CallbackMessage] [${reqId}] ai_error contact=${input.contact_id || 'n/a'} ` +
      `err="${err.message}" — fallback (${elapsed}ms)`);
    return {
      message: static_fallback_message,
      reasoning: `AI generation failed (${err.message}); used static fallback template.`,
      business_hours,
      fell_back: true,
      fell_back_reason: err.message,
      static_fallback_message,
      model: MODEL,
      elapsed_ms: elapsed,
      request_id: reqId,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
// ROUTE REGISTRATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Registers POST /api/agentic/dynamic-callback-message on the given
 * Express app. No-auth — same posture as /api/service-area/lookup since
 * GHL custom_webhook can't easily pass auth tokens. The endpoint is
 * write-free for the LEAD's data (no GHL contact mutations) — only
 * appends to agentic_callback_log for audit.
 */
export function registerCallbackMessageRoutes(app) {
  app.post('/api/agentic/dynamic-callback-message', async (req, res) => {
    try {
      const body = req.body || {};
      const sanitizedInput = {
        first_name: typeof body.first_name === 'string' ? body.first_name.slice(0, 100) : null,
        recent_inbound_message: typeof body.recent_inbound_message === 'string'
          ? body.recent_inbound_message.slice(0, 1000)
          : '',
        market_name: typeof body.market_name === 'string' ? body.market_name.slice(0, 100) : null,
        service_phone_display: typeof body.service_phone_display === 'string'
          ? body.service_phone_display.slice(0, 50)
          : null,
        has_dedicated_phone: typeof body.has_dedicated_phone === 'boolean'
          ? body.has_dedicated_phone
          : null,
        business_hours: typeof body.business_hours === 'boolean'
          ? body.business_hours
          : undefined,
        contact_id: typeof body.contact_id === 'string' ? body.contact_id.slice(0, 100) : null,
        handoff_reason: typeof body.handoff_reason === 'string' ? body.handoff_reason.slice(0, 100) : null,
        callback_type: ['sales', 'service'].includes(body.callback_type) ? body.callback_type : null,
      };

      const result = await generateCallbackMessage(sanitizedInput);

      // Always 200, even on internal errors — see header comment.
      // Strip static_fallback_message from the HTTP response — it's an
      // internal audit artifact, not part of the public contract.
      const { static_fallback_message: _omit, ...publicResult } = result;
      res.json(publicResult);

      // Fire-and-forget audit write. Doesn't block the response, never
      // throws. If the table doesn't exist yet, we'll see a one-line
      // warn in Railway logs and the endpoint keeps working.
      logToAudit(sanitizedInput, result).catch(() => { /* swallow */ });
    } catch (err) {
      // Truly unexpected error (something not caught by generateCallbackMessage's
      // own try/catch). Log it and return the after-hours fallback as a last
      // resort so the workflow still gets a usable SMS body.
      console.error(`[CallbackMessage] Unhandled error: ${err.message}`);
      const fallback = `Hi there, our team is closed right now (we're open Mon-Fri 8 AM to 5 PM ET). ` +
                       `Call us at (954) 800-8906 during those hours and we'll take care of you.`;
      res.json({
        message: fallback,
        reasoning: `Unhandled endpoint error (${err.message}); emergency fallback.`,
        business_hours: false,
        fell_back: true,
        fell_back_reason: 'unhandled_endpoint_error',
        model: null,
        elapsed_ms: 0,
        request_id: null,
      });
    }
  });

  console.log('[REST API] Registered: POST /api/agentic/dynamic-callback-message (no-auth, HDL.2 dynamic SMS, audit-logged)');
}
