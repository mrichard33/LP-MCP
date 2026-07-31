// src/services/backstop-insight.js
//
// Model-written read on a backstop run — the "what this actually means"
// line, not a restatement of the counters (the card already shows those).
//
// BEST-EFFORT BY CONSTRUCTION: the sweep has already created contacts by
// the time this runs. Every failure path — no credential, timeout, empty
// response, junk response — returns null, and the caller falls back to the
// deterministic narrative. This must never throw and never delay a card
// beyond its own timeout.
//
// Called ONLY after the exception gate has decided to send, so on the
// steady state (healthy runs, silent) it costs nothing at all.

import { callLLM } from '../llm-client.js';
import { formatLpSource } from '../format-helpers.js';
import { sanitizeNarrative } from '../actions/notification-classifier.js';

export const INSIGHT_CHAR_CAP = parseInt(process.env.LP_BACKSTOP_INSIGHT_CAP || '320', 10);
const MAX_TOKENS = parseInt(process.env.LP_BACKSTOP_INSIGHT_MAX_TOKENS || '200', 10);
const TEMPERATURE = parseFloat(process.env.LP_BACKSTOP_INSIGHT_TEMPERATURE || '0.3');
const INSIGHT_LEAD_SAMPLE = 8;

const SYSTEM_PROMPT = `You write one short operational read for the owner of a home-improvement company about an automated backstop sweep that creates missing CRM contacts for leads sitting in Lead Perfection.

Write 1-2 sentences. Plain English, operational register, no exclamation marks, no reassurance, no pep.

WHAT YOU ARE FOR
The card already lists the counts, the leads, and their sources. Do NOT restate numbers the reader can see. Your job is the read: what this run means for lead flow, and whether it looks like a one-off or a pattern worth watching. Lead with source concentration when one source dominates the affected leads — a single vendor showing up repeatedly is the most actionable signal in this data.

RULES
- Never invent a cause you cannot see in the facts given. If the facts do not support a cause, say what is observable and stop.
- Never name a fix that requires information you do not have.
- Banned vocabulary: "backstop", "sweep", "webhook", "idempotent", "orchestration", "pipeline", "synergy", "leverage", "robust", "seamless". Say "leads that did not reach the CRM" rather than naming internal machinery.
- No markdown, no bullets, no headers, no quotes around your answer.
- Return ONLY the sentences. No preamble.

EXAMPLES OF THE RIGHT REGISTER
"All four leads came in through Modernize, which points at that vendor's delivery rather than anything broad. Worth watching whether the next run is Modernize again."
"These failed on the CRM side rather than on the lead data, so the same leads will likely be picked up on the next pass — unless the same ones fail twice."
"Eligible leads are arriving faster than the per-run limit clears them, so the queue is growing rather than draining."`;

function buildUserPrompt({ sweepMode, severity, counts = {}, scan = {}, errors = [], results = [], maxPerRun }) {
  const touched = results.filter((r) => r && (r.action === 'created' || r.action === 'linked'));
  const lines = [];

  lines.push(`SWEEP_MODE: ${sweepMode}`);
  lines.push(`SEVERITY: ${severity}`);
  lines.push('');
  lines.push('OUTCOME:');
  lines.push(`  created: ${counts.created || 0}`);
  lines.push(`  linked: ${counts.linked || 0}`);
  lines.push(`  errored: ${counts.error || 0}`);
  lines.push(`  no_phone: ${counts.skipped_no_phone || 0}`);
  lines.push(`  dnc_link_only: ${counts.skipped_dnc || 0}`);
  lines.push(`  eligible_this_scan: ${scan.eligible || 0}`);
  lines.push(`  deferred_by_cap: ${scan.deferredCapped || 0} (cap ${maxPerRun})`);
  lines.push('');

  lines.push('LEADS TOUCHED (source > subsource):');
  if (touched.length === 0) {
    lines.push('  (none)');
  } else {
    for (const r of touched.slice(0, INSIGHT_LEAD_SAMPLE)) {
      const src = formatLpSource(r.lead_source, r.lead_source_detail) || 'Unknown';
      lines.push(`  - ${src} | ${r.action}${r.suppressed ? ' | suppressed' : ''}`);
    }
    if (touched.length > INSIGHT_LEAD_SAMPLE) lines.push(`  - (+${touched.length - INSIGHT_LEAD_SAMPLE} more not listed)`);
  }
  lines.push('');

  lines.push('ERRORS:');
  if (!errors.length) {
    lines.push('  (none)');
  } else {
    for (const e of errors.slice(0, INSIGHT_LEAD_SAMPLE)) {
      lines.push(`  - lead ${e.lp_lead_id}: ${String(e.error).slice(0, 200)}`);
    }
  }
  lines.push('');
  lines.push('Write the read per the SYSTEM PROMPT.');
  return lines.join('\n');
}

/** Strip anything the model may have added around the sentences. */
export function cleanInsight(raw) {
  let s = String(raw || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*["'`]+|["'`]+\s*$/g, '')
    // Bold BEFORE bullets: the bullet class includes '*', so on a line that
    // opens with "**bold**" the bullet strip would eat the first asterisk and
    // leave "*bold**" un-matchable by the bold rule. This order handles both
    // "**bold**" and "- **bold**".
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^\s*[-*•]\s*/gm, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!s) return null;
  const { text } = sanitizeNarrative(s);
  s = String(text).trim();
  if (!s) return null;
  if (s.length > INSIGHT_CHAR_CAP) s = `${s.slice(0, INSIGHT_CHAR_CAP - 1).trimEnd()}…`;
  return s;
}

/**
 * Returns a 1-2 sentence read, or null. NEVER throws.
 *
 * Set LP_BACKSTOP_INSIGHT=off to skip the call entirely and always use
 * the deterministic narrative.
 */
export async function generateBackstopInsight(args) {
  if (String(process.env.LP_BACKSTOP_INSIGHT || 'on').toLowerCase() === 'off') return null;
  const startedAt = Date.now();
  try {
    const { text, model } = await callLLM({
      fn: 'backstop_insight',
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(args),
      maxTokens: MAX_TOKENS,
      temperature: TEMPERATURE,
    });
    const insight = cleanInsight(text);
    if (!insight) {
      console.warn('[BackstopInsight] empty/unusable model response — falling back to template narrative');
      return null;
    }
    console.log(`[BackstopInsight] ${args.sweepMode}/${args.severity} chars=${insight.length} model=${model} (${Date.now() - startedAt}ms)`);
    return insight;
  } catch (e) {
    console.warn(`[BackstopInsight] generation failed (${Date.now() - startedAt}ms), using template narrative: ${e.message}`);
    return null;
  }
}

export const _internal = { SYSTEM_PROMPT, buildUserPrompt };
