/**
 * Call Moments — core — src/knowledge/ci-moments-core.js
 *
 * Pure helpers for mining objection / question moments out of CI transcripts
 * (kb-retriever.js v1.12). No Supabase / LLM / OpenAI imports, so
 * scripts/test-kb-call-moments.js runs with no env. Runtime in ci-moments.js.
 *
 * v1.0 — 2026-09-03. Initial.
 */

export const KB_CALL_MOMENTS_MODES = new Set(['off', 'shadow', 'live']);

/** off (default) | shadow (extract + retrieve + log, never injected) | live (injected). */
export function getKbCallMomentsMode(env = process.env) {
  const m = String(env.KB_CALL_MOMENTS_MODE || 'off').toLowerCase().trim();
  return KB_CALL_MOMENTS_MODES.has(m) ? m : 'off';
}

export const PROMPT_VERSION = 'cm-1';

export const MOMENT_KINDS = new Set(['objection', 'question', 'buying_signal']);
export const OBJECTION_TYPES = new Set(['price', 'timing', 'spouse', 'trust', 'competitor', 'diy', 'other']);

// ci_summaries.outcome values that mean the call is not worth mining.
export const SKIP_OUTCOMES = new Set(['no_meaningful_contact', 'wrong_number', 'dnc_request']);
// Outcomes that count as the call "winning" for won-only retrieval.
export const WON_OUTCOMES = new Set(['appointment_set', 'appointment_confirmed', 'appointment_rescheduled']);
export const SKIP_DIRECTIONS = new Set(['Internal', 'Internal Voicemail', 'Inbound Voicemail']);

// Same compliance/identity gates as the other tiers.
export const CALL_MOMENTS_SKIP_INTENTS = new Set([
  'STOP', 'ANGRY', 'WRONG_NUMBER', 'MOVED', 'WHO_IS_THIS',
  'CUSTOMER_STATUS_AFFIRMATIVE', 'CUSTOMER_STATUS_NEGATIVE', 'SERVICE_AREA_INQUIRY',
]);

export function shouldRunCallMoments(intentClass, messageText) {
  if (!messageText || typeof messageText !== 'string' || !messageText.trim()) return false;
  if (!intentClass) return false;
  return !CALL_MOMENTS_SKIP_INTENTS.has(intentClass);
}

/** Is this call worth an extraction pass? row = joined ci_calls/ci_transcripts/ci_summaries fields. */
export function isEligibleCall(row, minChars = 400) {
  if (!row) return false;
  if (SKIP_DIRECTIONS.has(String(row.direction || ''))) return false;
  if (SKIP_OUTCOMES.has(String(row.outcome || ''))) return false;
  if (row.transcript_intelligible === false) return false;
  return String(row.transcript_text || '').length >= minChars;
}

export function callWon(outcome) {
  return WON_OUTCOMES.has(String(outcome || ''));
}

export function scrubPii(text) {
  return String(text || '')
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[email]')
    .replace(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[phone]')
    .replace(/\b\d{1,6}\s+(?:[A-Z][A-Za-z]+\s){1,4}(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Blvd|Boulevard|Way|Cir|Circle|Pl|Place|Ter|Terrace|Trl|Trail|Pkwy|Parkway)\b\.?/g, '[address]')
    .replace(/https?:\/\/\S+/g, '[link]');
}

export const EXTRACTION_SYSTEM_PROMPT = `You read one transcript of a phone call between a Reece Windows & Doors agent and a Florida homeowner. The transcript has NO speaker labels — infer who is speaking from content. Extract up to 6 "moments" and return ONLY JSON: {"moments":[...]}.

A moment is one of:
- "objection": the homeowner pushes back, hesitates, or declines. objection_type is one of price, timing, spouse, trust, competitor, diy, other.
- "question": the homeowner asks something factual about the product, price, process, financing, warranty, permits, insurance, or the company.
- "buying_signal": the homeowner volunteers readiness (asks for times, asks what happens next, says they've been meaning to do this).

Each moment: {"kind": ..., "objection_type": (objections only, else null), "customer_said": the homeowner's words, as close to verbatim as the transcript allows, max 280 chars, "agent_said": the agent's immediate response, max 420 chars, or null if there was none, "resolved": true if the homeowner moved forward on that point within the call (agreed to a time, accepted the explanation, gave the information asked for), false if they held their position, null if unclear, "confidence": 0-1}.

Rules: never invent words; if you cannot tell who said it, skip it; write [phone], [email], [address] instead of any phone number, email, or street address; skip greetings, hold music, and small talk; prefer fewer high-confidence moments over many weak ones. If there are no moments, return {"moments":[]}.`;

export function buildExtractionUser(transcriptText, meta = {}) {
  const head = [
    meta.campaign ? `Campaign: ${meta.campaign}` : null,
    meta.outcome ? `Call outcome (from summary): ${meta.outcome}` : null,
    meta.duration_seconds ? `Duration: ${meta.duration_seconds}s` : null,
  ].filter(Boolean).join('\n');
  return `${head}\n\nTRANSCRIPT:\n${String(transcriptText || '').slice(0, 12000)}`;
}

/** Normalize the model's JSON into rows we are willing to store. Drops anything malformed. */
export function validateMoments(raw, maxMoments = 6) {
  const list = Array.isArray(raw?.moments) ? raw.moments : Array.isArray(raw) ? raw : [];
  const out = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const kind = String(m.kind || '').toLowerCase().trim();
    if (!MOMENT_KINDS.has(kind)) continue;
    const customer = scrubPii(String(m.customer_said || '').trim()).slice(0, 280);
    if (customer.length < 8) continue;
    const agent = m.agent_said ? scrubPii(String(m.agent_said).trim()).slice(0, 420) : null;
    let objectionType = null;
    if (kind === 'objection') {
      const t = String(m.objection_type || 'other').toLowerCase().trim();
      objectionType = OBJECTION_TYPES.has(t) ? t : 'other';
    }
    const resolved = m.resolved === true ? true : m.resolved === false ? false : null;
    const c = Number(m.confidence);
    const confidence = Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : null;
    out.push({ kind, objection_type: objectionType, customer_said: customer, agent_said: agent && agent.length >= 8 ? agent : null, resolved, confidence });
    if (out.length >= maxMoments) break;
  }
  return out;
}

/**
 * Turn nearest real objections into the { type: similarity } shape the v1.10
 * classifier already consumes: per-type MAX similarity, 'other' excluded.
 * Returns null when there are too few neighbours to trust (caller falls back).
 */
export function scoresFromMoments(rows, minRows = 3) {
  if (!Array.isArray(rows) || rows.length < minRows) return null;
  const scores = {};
  for (const r of rows) {
    const t = r?.objection_type;
    if (!t || t === 'other' || typeof r.similarity !== 'number') continue;
    if (!(t in scores) || r.similarity > scores[t]) scores[t] = r.similarity;
  }
  return Object.keys(scores).length > 0 ? scores : null;
}

export function formatCallMomentsForPrompt(rows, opts = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const maxChars = opts.maxChars || 1200;
  const max = opts.max || 2;
  const lines = [
    'FROM REAL CALLS (a homeowner said something similar on the phone and the agent\'s answer moved them forward — match the approach and tone in writing, NOT the wording; phone phrasing is not text phrasing; never reuse a name, date, time, price, address, or promise from these):',
  ];
  let used = lines[0].length;
  let n = 0;
  for (const r of rows) {
    if (n >= max) break;
    const tag = r.kind === 'objection' ? `objection:${r.objection_type || 'other'}` : r.kind;
    const head = `  ${n + 1}. [${tag} | ${r.call_won ? 'call booked' : 'point resolved'} | sim ${(r.similarity ?? 0).toFixed(2)}]`;
    const said = `     Homeowner: "${String(r.customer_said || '').slice(0, 280)}"`;
    const reply = r.agent_said ? `     Agent: "${String(r.agent_said).slice(0, 420)}"` : null;
    const piece = [head, said, reply].filter(Boolean).join('\n');
    if (used + piece.length > maxChars) break;
    lines.push(piece);
    used += piece.length;
    n++;
  }
  return n === 0 ? '' : lines.join('\n');
}
