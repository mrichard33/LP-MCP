/**
 * injection-guard — classifier layer for prompt injection, with a decision
 * record for every check (2026-10-07; IT/GoCloud security review 2026-09-23).
 *
 * AI OS canon: CANON.STD.019 (layered guardrails; untrusted content is data),
 * CANON.STD.018 (guardrails finish before the action, cheapest first, tested
 * failure policy), CANON.SEC.006 (independent input screening), CANON.P.008
 * (defend in layers), CANON.EVT.009 (guardrail decision record).
 *
 * LAYERS, cheapest first:
 *   0. src/security/untrusted-text.js strips invisible characters (already live
 *      on SMS, live chat and the analyzer; 2026-10-07 also on call transcripts).
 *   1. HEURISTIC (this file, no I/O, <1 ms): known injection shapes —
 *      instruction override, role/delimiter spoofing, prompt extraction,
 *      tool/exfiltration asks, encoded payloads, many hidden characters.
 *   2. MODEL CLASSIFIER (optional): when INJECTION_CLASSIFIER_URL is set, an
 *      LLM Guard API server (protectai/llm-guard, POST /analyze/prompt) scores
 *      the text. Capped at INJECTION_CLASSIFIER_TIMEOUT_MS (1500). An outage or
 *      timeout FAILS OPEN to the heuristic verdict and is recorded as such —
 *      a customer reply must never wait on a security sidecar.
 *
 * MODES (INJECTION_GUARD_MODE): off | shadow (DEFAULT) | live.
 *   shadow — classify and record; never changes what runs.
 *   live   — same record, and `block: true` on an `injection` verdict for
 *            surfaces listed in INJECTION_GUARD_BLOCK_SURFACES (default
 *            'ci_transcript'). Customer chat surfaces are deliberately NOT in
 *            the default: blocking a customer's reply needs Mark's ruling and a
 *            bot-gate run (CLAUDE.md, run_bot_eval) first.
 *
 * DECISION RECORD. One guardrail_decisions row per check (sql/152): surface,
 * verdict, score, signals, layer, action, latency, a SHA-256 of the text —
 * never the text itself (customer conversations stay out of new tables).
 * Fire-and-forget; a failed write never affects the caller.
 */

import crypto from 'node:crypto';

const TABLE = 'guardrail_decisions';

// ─── Layer 1: heuristic signals ───────────────────────────────────────────
// Each signal: id, weight, pattern. Weights add; ≥ INJECTION ≥ SUSPICIOUS.
// Patterns are deliberately about INSTRUCTIONS TO A MODEL, not about topics:
// "ignore the noise, the windows rattle" must not score.
export const SIGNALS = Object.freeze([
  { id: 'override_instructions', weight: 0.7,
    re: /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your|the|these|system)\b[^.\n]{0,30}\b(instructions?|prompts?|rules?|guidelines?|directives?|context)\b/i },
  { id: 'new_instructions', weight: 0.45,
    re: /\b(new|updated|real|actual|following)\s+(instructions?|system\s+prompt|rules)\s*(:|are\b|follow\b)/i },
  { id: 'role_reassign', weight: 0.45,
    // "You are now my favorite window company" is a customer, not an attack:
    // the reassignment must name a model-ish role (benign corpus, 2026-10-07).
    re: /\b(you\s+are\s+now\s+(an?\s+|the\s+|in\s+)?(unrestricted\s+|unfiltered\s+|jailbroken\s+|new\s+)?(ai|assistant|bot|model|system|developer|admin|dan)\b|from\s+now\s+on\s+you\s+(will|must|are)\s+(answer|respond|act|ignore|obey)|act\s+as\s+(an?\s+)?(unrestricted|unfiltered|different|evil|jailbroken)|pretend\s+(to\s+be|you\s+are)\s+(an?\s+)?(ai|assistant|system|developer|admin))\b/i },
  { id: 'jailbreak_terms', weight: 0.5,
    re: /\b(jailbreak|DAN\s+mode|developer\s+mode\s+(enabled|on)|do\s+anything\s+now|no\s+restrictions\s+mode)\b/i },
  { id: 'prompt_extraction', weight: 0.6,
    re: /\b(reveal|show|print|repeat|output|tell\s+me|what\s+(is|are))\b[^.\n]{0,25}\b(your|the)\s+(system\s+prompt|initial\s+prompt|hidden\s+(instructions|prompt)|instructions\s+above|developer\s+message)\b/i },
  { id: 'role_delimiter', weight: 0.6,
    re: /(<\|im_(start|end)\|>|<\|(system|assistant|user)\|>|\[\/?INST\]|<<\/?SYS>>|<\/?(system|assistant)>|^\s*#{2,}\s*(system|instruction)s?\b|^\s*(system|assistant)\s*:)/im },
  { id: 'tool_invocation', weight: 0.45,
    re: /\b(call|invoke|run|execute|use)\s+(the\s+)?(tool|function)\b|\b(supabase_run_query|http_request|set_railway_env_var|redeploy_railway_service|rollback_railway_deployment|send_message|add_tags|remove_tags|update_contact)\b/i },
  { id: 'exfiltration', weight: 0.5,
    re: /\b(send|post|forward|upload|email|exfiltrate|leak)\b[^.\n]{0,40}\b(api[\s_-]?keys?|tokens?|passwords?|secrets?|credentials?|env(ironment)?\s+var(iable)?s?|customer\s+(list|data|records))\b/i },
  { id: 'sql_or_shell', weight: 0.35,
    re: /(\b(drop|truncate|delete\s+from|insert\s+into|update\s+\w+\s+set|alter\s+table|grant\s+all)\b\s+\w+|;\s*--|\b(curl|wget)\s+https?:\/\/|\brm\s+-rf\b)/i },
  { id: 'url_with_payload', weight: 0.3,
    re: /https?:\/\/[^\s]+[?&][^\s=]{1,30}=\{?[^\s]{0,10}(prompt|secret|key|token|data)/i },
  // Invoice-shaped (security review, 2026-10-19): a vendor document that talks
  // to "the AI processing this invoice" or tells it to approve, set the vendor
  // or set its confidence. Each scores suspicious; either flags the invoice for
  // a person (it is never auto-approved), which is all an invoice needs.
  { id: 'addressed_to_model', weight: 0.3,
    re: /\b(note|message|instructions?|attention)\s+(to|for)\s+(the\s+|any\s+)?(ai|a\.i\.|assistant|model|llm|bot|automated\s+(system|reader|processor))\b|\b(ai|assistant|model|llm|bot|system)\s+(reading|processing|parsing|reviewing|analy[sz]ing)\s+this\b/i },
  { id: 'invoice_override', weight: 0.3,
    re: /\b(auto[\s-]?approve|pre[\s-]?approved?\s+(invoice|payment)|mark\s+(this|it)\s+(invoice\s+)?(as\s+)?(approved|paid|verified)|set\s+(the\s+)?(confidence|vendor(_match_id)?)\b|vendor_match_id|confidence\s*[:=]\s*(1(\.0+)?|100\s*%))/i },
  { id: 'encoded_payload', weight: 0.3,
    re: /(?:[A-Za-z0-9+/]{80,}={0,2})|(?:\\x[0-9a-f]{2}){12,}|(?:%[0-9a-f]{2}){20,}/i },
]);

export const THRESHOLDS = Object.freeze({ suspicious: 0.3, injection: 0.7 });
const HIDDEN_CHARS_SIGNAL = { id: 'hidden_characters', perChar: 0.05, max: 0.4, min: 3 };

/**
 * Pure, synchronous, never throws.
 * @param {string} text  the CLEANED text (after untrusted-text.js)
 * @param {object} [opts]
 * @param {number} [opts.removedCount]  invisible chars the sanitizer removed
 * @returns {{ verdict: 'clean'|'suspicious'|'injection', score: number, signals: string[] }}
 */
export function classifyHeuristic(text, { removedCount = 0 } = {}) {
  const s = String(text ?? '');
  const signals = [];
  let score = 0;
  if (s) {
    for (const sig of SIGNALS) {
      if (sig.re.test(s)) { signals.push(sig.id); score += sig.weight; }
    }
  }
  if (removedCount >= HIDDEN_CHARS_SIGNAL.min) {
    signals.push(HIDDEN_CHARS_SIGNAL.id);
    score += Math.min(HIDDEN_CHARS_SIGNAL.max, removedCount * HIDDEN_CHARS_SIGNAL.perChar);
  }
  score = Math.min(1, Math.round(score * 100) / 100);
  return { verdict: verdictFor(score), score, signals };
}

export function verdictFor(score) {
  if (score >= THRESHOLDS.injection) return 'injection';
  if (score >= THRESHOLDS.suspicious) return 'suspicious';
  return 'clean';
}

// ─── Config ───────────────────────────────────────────────────────────────

export function guardMode(env = process.env) {
  const m = String(env.INJECTION_GUARD_MODE || '').trim().toLowerCase();
  return ['off', 'shadow', 'live'].includes(m) ? m : 'shadow';
}

export function blockSurfaces(env = process.env) {
  const raw = env.INJECTION_GUARD_BLOCK_SURFACES;
  const list = (raw === undefined ? 'ci_transcript' : String(raw))
    .split(',').map((x) => x.trim()).filter(Boolean);
  return new Set(list);
}

// ─── Layer 2: optional LLM Guard sidecar ──────────────────────────────────

/**
 * POST {INJECTION_CLASSIFIER_URL}/analyze/prompt  { prompt, scanners_suppress? }
 * LLM Guard API answers { is_valid, scanners: { PromptInjection: <risk 0..1> } }.
 * Returns { ok, score } or { ok:false, reason }. Never throws.
 */
export async function classifyRemote(text, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const base = String(env.INJECTION_CLASSIFIER_URL || '').trim().replace(/\/+$/, '');
  if (!base) return { ok: false, reason: 'not_configured' };
  const timeoutMs = Number(env.INJECTION_CLASSIFIER_TIMEOUT_MS) > 0 ? Number(env.INJECTION_CLASSIFIER_TIMEOUT_MS) : 1500;
  const headers = { 'content-type': 'application/json' };
  if (env.INJECTION_CLASSIFIER_TOKEN) headers.authorization = `Bearer ${env.INJECTION_CLASSIFIER_TOKEN}`;
  try {
    const res = await fetchImpl(`${base}/analyze/prompt`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt: String(text ?? '').slice(0, 8000) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const body = await res.json();
    const raw = body?.scanners?.PromptInjection ?? body?.scanners?.prompt_injection;
    const score = typeof raw === 'number' ? Math.max(0, Math.min(1, raw)) : (body?.is_valid === false ? 1 : 0);
    return { ok: true, score };
  } catch (err) {
    return { ok: false, reason: err?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}

// ─── Decision record ──────────────────────────────────────────────────────

export function textHash(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex');
}

let _client;
async function defaultClient() {
  if (_client !== undefined) return _client;
  try { _client = (await import('../supabase.js')).default ?? null; } catch { _client = null; }
  return _client;
}

/** Fire-and-forget. Never throws, never awaited by hot paths. */
export async function recordDecision(row, { client } = {}) {
  try {
    const db = client ?? await defaultClient();
    if (!db) return { ok: false, reason: 'no_client' };
    const { error } = await db.from(TABLE).insert(row);
    if (error) {
      if (!recordDecision._warned) {
        recordDecision._warned = true;
        console.warn(`[InjectionGuard] decision record failed (sql/152 applied?): ${error.message}`);
      }
      return { ok: false, reason: error.message };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ─── The one entry point ──────────────────────────────────────────────────

/**
 * Screen untrusted text before a model reads it.
 *
 * @param {object} args
 * @param {string} args.surface     'sms_reply' | 'live_chat' | 'analyzer' | 'ci_transcript' | ...
 * @param {string} args.text        cleaned text (after cleanInboundForModel)
 * @param {number} [args.removedCount]
 * @param {string} [args.sourceRef] contact id / call id — an id, never content
 * @param {boolean} [args.awaitRemote=false]  wait for the sidecar (only where
 *   latency does not matter, e.g. the call-transcript worker)
 * @returns {Promise<{ mode, verdict, score, signals, layer, block, action }>}
 */
export async function guardUntrustedText({
  surface, text, removedCount = 0, sourceRef = null, awaitRemote = false,
  env = process.env, deps = {},
} = {}) {
  const mode = guardMode(env);
  if (mode === 'off') return { mode, verdict: 'clean', score: 0, signals: [], layer: 'off', block: false, action: 'allow' };

  const started = Date.now();
  const h = classifyHeuristic(text, { removedCount });
  let verdict = h.verdict;
  let score = h.score;
  let layer = 'heuristic';
  let remoteNote = null;

  const remoteWanted = !!String(env.INJECTION_CLASSIFIER_URL || '').trim();
  const runRemote = async () => {
    const r = await (deps.classifyRemote || classifyRemote)(text, { env });
    if (r.ok) {
      // Layers combine by MAX: either layer can raise the verdict, neither lowers it.
      if (r.score > score) { score = Math.round(r.score * 100) / 100; verdict = verdictFor(score); }
      layer = 'heuristic+llm_guard';
    } else {
      remoteNote = r.reason; // fail open, recorded
    }
  };
  if (remoteWanted && awaitRemote) await runRemote();

  const block = mode === 'live' && verdict === 'injection' && blockSurfaces(env).has(surface);
  const action = block ? 'block' : (verdict === 'clean' ? 'allow' : 'allow_flagged');

  const write = () => (deps.recordDecision || recordDecision)({
    surface,
    mode,
    verdict,
    score,
    signals: h.signals,
    layer,
    action,
    classifier_error: remoteNote,
    removed_chars: removedCount || 0,
    text_sha256: textHash(text),
    text_chars: String(text ?? '').length,
    source_ref: sourceRef ? String(sourceRef).slice(0, 120) : null,
    latency_ms: Date.now() - started,
  });

  if (remoteWanted && !awaitRemote) {
    // Hot path: the sidecar result only improves the RECORD, never this answer.
    Promise.resolve().then(runRemote).then(write).catch(() => {});
  } else {
    Promise.resolve().then(write).catch(() => {});
  }

  if (verdict !== 'clean') {
    console.log(`[InjectionGuard] ${surface} ${verdict} score=${score} signals=${h.signals.join(',') || '-'} action=${action} mode=${mode}${sourceRef ? ` ref=${sourceRef}` : ''}`);
  }
  return { mode, verdict, score, signals: h.signals, layer, block, action };
}

/** Same as guardUntrustedText but synchronous-fire: for hot paths. */
export function guardInBackground(args) {
  guardUntrustedText(args).catch(() => {});
}
