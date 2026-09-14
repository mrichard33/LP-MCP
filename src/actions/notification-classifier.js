/**
 * Notification Classifier — src/actions/notification-classifier.js
 *
 * v1.2 (2026-09-14) — The always-on Prospect line now reads
 * "Not yet assigned" rather than the literal "NONE" when LP has not
 * issued a prospect ID. Doctrine unchanged (the line always renders;
 * absence is signal) — only the wording, because "NONE" read as a
 * permanent verdict on the lead rather than a not-yet state.
 *
 * v1.1 (2026-06-11) — REQUIRED-FIELD CARD per Mark's directive: every
 * classified card now renders Market and Src (LP Source > Subsource)
 * lines — "Unknown" when unresolvable, consistent with the
 * absence-is-signal doctrine on the Prospect line — plus optional Reason
 * (loss-reason:* tag, humanized), 📅 appointment (date AND time,
 * always together), and 📐 Estimate (calculator measurements) lines.
 * New buildClassifiedNotification args: rep, market, lpSource,
 * lpSourceDetail, lossReason, appointmentDisplay, calcSummary.
 * All optional — existing callers render unchanged minus the two new
 * always-on lines.
 *
 * v1.0 (2026-05-14) — Canonical 4-class notification taxonomy per
 * Reece_GroupMe_Notification_Standard_v1.md.
 *
 * The four classes:
 *   system        🤖 SYSTEM EVENT          — machine-state transitions
 *   priority      🚨 SALES PRIORITY        — human action required
 *   intelligence  🧠 PIPELINE INTELLIGENCE — strategic reasoning
 *   debug         🔧 DEBUG                 — internal only, never rep-facing
 *
 * Opt-in for rules:
 *   Add `notification_class` + `action_verb` + `tier` + `status` +
 *   `narrative` to the send_notification action's params. If present,
 *   notifications.js routes through buildClassifiedNotification() in
 *   this module. If absent, falls back to legacy buildRichNotification
 *   (in enrichment.js), but with sanitizeNarrative() applied to the
 *   message field so forbidden language is stripped regardless.
 *
 * Class 4 (debug) routing:
 *   When notification_class === 'debug' and process.env.GROUPME_DEV_BOT_ID
 *   is set, the message is sent to the dev bot via sendToDevChannel
 *   (bypasses the rep-facing groupme.js entirely). When GROUPME_DEV_BOT_ID
 *   is unset, the message is console-logged only — never sent to the
 *   rep channel.
 */

import { formatPhone, formatLpSource } from '../format-helpers.js';

// ══════════════════════════════════════════════════════════════════════
// CLASS DEFINITIONS
// ══════════════════════════════════════════════════════════════════════

export const NOTIFICATION_CLASSES = {
  system:       { emoji: '🤖', label: 'SYSTEM EVENT' },
  priority:     { emoji: '🚨', label: 'SALES PRIORITY' },
  intelligence: { emoji: '🧠', label: 'PIPELINE INTELLIGENCE' },
  debug:        { emoji: '🔧', label: 'DEBUG' },
};

// The Prospect line renders this when LP has not issued a prospect ID.
// Exported so every other card builder uses the SAME words — the LP
// appointment card's inline LP reference drifted from this line once
// already (one printed NONE, the other N/A).
export const PROSPECT_UNASSIGNED = 'Not yet assigned';

export const ALLOWED_TIERS = ['Cold', 'Warm', 'Hot', 'Imminent'];
export const REP_FACING_CLASSES = new Set(['system', 'priority', 'intelligence']);

// ══════════════════════════════════════════════════════════════════════
// FORBIDDEN LANGUAGE — sanitizer rules
//
// Applied to every notification narrative. Replaces engineering-shame
// vocabulary and debug-leakage patterns with operational equivalents.
// Defense in depth: even if a rule author writes "step #149 buggy
// fallthrough" in their narrative, the rep never sees those words.
// ══════════════════════════════════════════════════════════════════════

const FORBIDDEN_PATTERNS = [
  // Code/debug leakage
  { pattern: /\bstep\s*#?\s*\d+\b/gi,           replacement: 'sequence step',         kind: 'step_number' },
  { pattern: /\bnode\s*#?\s*\d+\b/gi,           replacement: 'node',                   kind: 'node_ref' },
  // UUID workflow IDs
  { pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
                                                replacement: '[workflow]',             kind: 'uuid' },

  // Engineering-shame vocabulary
  { pattern: /\bbuggy\s+fallthrough\b/gi,       replacement: 'unhandled branch',       kind: 'shame_word' },
  { pattern: /\bbuggy\b/gi,                     replacement: '',                       kind: 'shame_word' },
  { pattern: /\bfallthrough\b/gi,               replacement: 'unhandled branch',       kind: 'shame_word' },
  { pattern: /\b(an?\s+)?upstream\s+routing\s+bug\b/gi,
                                                replacement: 'routing anomaly',        kind: 'shame_word' },
  { pattern: /\b(routing\s+)?bug(s)?\s+worth\s+investigating\b/gi,
                                                replacement: 'anomaly flagged for review', kind: 'shame_word' },
  { pattern: /\bcrashed\b/gi,                   replacement: 'failed',                 kind: 'shame_word' },
  { pattern: /\bmisfired\b/gi,                  replacement: 'fired in error',         kind: 'shame_word' },
  { pattern: /\bBug\s+\d+\b/gi,                 replacement: 'known condition',        kind: 'bug_id' },
];

/**
 * Strip forbidden language from a narrative string and return both the
 * cleaned text and the list of violations that were patched. Hits are
 * returned so the caller can log them (for tracking down which rules
 * still author forbidden phrases) without surfacing them to reps.
 */
export function sanitizeNarrative(text) {
  if (!text || typeof text !== 'string') return { text: text || '', hits: [] };
  let out = text;
  const hits = [];
  for (const rule of FORBIDDEN_PATTERNS) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(out)) {
      hits.push(rule.kind);
      rule.pattern.lastIndex = 0;
      out = out.replace(rule.pattern, rule.replacement);
    }
  }
  // Collapse extra whitespace left by removals + tidy spacing before punctuation
  out = out.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
  return { text: out, hits };
}

/**
 * Validate-only check (no mutation). Returns { ok, violations: [...] }.
 * Used for runtime audit / dev assertions; production path uses
 * sanitizeNarrative which silently patches.
 */
export function validateNotification(text) {
  if (!text) return { ok: true, violations: [] };
  const violations = [];
  for (const rule of FORBIDDEN_PATTERNS) {
    rule.pattern.lastIndex = 0;
    const m = text.match(rule.pattern);
    rule.pattern.lastIndex = 0;
    if (m && m.length > 0) violations.push({ kind: rule.kind, matches: m });
  }
  return { ok: violations.length === 0, violations };
}

// ══════════════════════════════════════════════════════════════════════
// AUTO-CLASSIFICATION (legacy rules without explicit class)
// ══════════════════════════════════════════════════════════════════════

const DEBUG_KEYS    = /^(DEBUG_|DRIFT_|SYNC_FAIL|SCHEMA_)/i;
const PRIORITY_KEYS = /(HOT_LEAD|CALL_NOW|FAST_TRACK|CALLBACK|REP_ONLY|ESCALATE|SPOUSE_GATE|HIGH_INTENT|IMMINENT)/i;
const INTEL_KEYS    = /(OBJECTION|CLASSIF|DISENGAG|RECLASSIF|SUPPRESS|REASON|EARN|TRUST_STATE|^BEHAVIORAL_|^LP_DISP_|^INTENT_)/i;
const SYSTEM_KEYS   = /(BACKSTOP|HANDOFF|EXIT|EXITS|ROUTE_TO|REROUTE|REMOVE|CANCEL_REQ|CANCEL_EXEC|CLEANUP|REAP|ENROLL|RESCUE|BOOKING)/i;

export function inferClassification(ruleKey = '', message = '') {
  const k = String(ruleKey);
  const m = String(message);

  if (DEBUG_KEYS.test(k) || /\bDRIFT\b.*BATCH/i.test(m)) return 'debug';
  if (PRIORITY_KEYS.test(k) || /CALL WITHIN|🔥 HOT LEAD|REP CALLBACK QUEUED/i.test(m)) return 'priority';
  if (SYSTEM_KEYS.test(k))   return 'system';
  if (INTEL_KEYS.test(k))    return 'intelligence';
  return 'system'; // safe default — operational rather than strategic
}

// ══════════════════════════════════════════════════════════════════════
// CARD BUILDER
// ══════════════════════════════════════════════════════════════════════

/**
 * Build a classified notification card per the v1.1 standard.
 *
 * @param {object} args
 * @param {'system'|'priority'|'intelligence'|'debug'} args.notification_class
 * @param {string} args.action_verb   — header verb, e.g. 'BACKSTOP ROUTED', 'CALL NOW'
 * @param {string} args.name          — contact display name
 * @param {string} args.phone         — raw phone (formatted internally)
 * @param {string} args.contactId     — GHL contact ID
 * @param {string} [args.prospectId]  — LP prospect ID; renders "Not yet assigned" if absent
 * @param {string} [args.market]      — v1.1: market name; renders "Unknown" if absent
 * @param {string} [args.lpSource]    — v1.1: LP Source (parent channel)
 * @param {string} [args.lpSourceDetail] — v1.1: LP Subsource
 * @param {string} [args.lossReason]  — v1.1: humanized loss reason; renders 🚫 line when present
 * @param {string} [args.appointmentDisplay] — v1.1: pre-formatted "MM/DD/YYYY at h:mm AM" string; renders 📅 line when present
 * @param {string} [args.calcSummary] — v1.1: e.g. "7 windows · est. $18,585"; renders 📐 line when present
 * @param {string} [args.address]     — v1.2: single line "street, city ST zip"; renders 📍 when present
 * @param {string} [args.email]       — v1.2: renders ✉️ when present
 * @param {string} [args.jobSize]     — v1.2: e.g. "8 windows · 2 doors"; renders 📐 Job size when present
 * @param {string} [args.canvasser]   — v1.2: resolved canvasser NAME; renders 🚪 when present
 * @param {string} [args.rep]         — 2026-09-14: assigned sales rep NAME; renders 🧑\u200d💼 when present
 * @param {string} [args.lpRef]       — v1.2: e.g. "inbound #418575" or "Lead 570351 | Prospect 454810"; renders 📋 LP when present
 * @param {'Cold'|'Warm'|'Hot'|'Imminent'} [args.tier]
 * @param {string} [args.status]      — short status descriptor
 * @param {string} args.narrative     — 1-2 sentence doctrinal explanation
 * @param {string} [args.actWithin]   — Class 2 only, e.g. '15 minutes'
 * @param {string} [args.nextStep]    — Class 3 only, e.g. 'S1.1 enrollment'
 * @param {string} [args.refHash]     — appended as `ref: ${refHash}`
 * @returns {string}
 */
export function buildClassifiedNotification(args = {}) {
  const {
    notification_class,
    action_verb,
    name,
    phone,
    contactId,
    prospectId,
    market,
    lpSource,
    lpSourceDetail,
    lossReason,
    appointmentDisplay,
    calcSummary,
    address,
    email,
    jobSize,
    canvasser,
    rep,
    lpRef,
    tier,
    status,
    narrative,
    actWithin,
    nextStep,
    refHash,
  } = args;

  const klass     = NOTIFICATION_CLASSES[notification_class] || NOTIFICATION_CLASSES.system;
  const cleanTier = ALLOWED_TIERS.includes(tier) ? tier : 'Warm';
  const cleanStat = String(status || 'Active').slice(0, 60);
  const verb      = String(action_verb || 'EVENT').toUpperCase().slice(0, 60);

  // Sanitize narrative — strips step numbers, "buggy", UUIDs, etc.
  const { text: narrativeText, hits } = sanitizeNarrative(narrative || '');
  if (hits.length > 0) {
    console.log(`[Classifier] Sanitized narrative for ${verb}: stripped ${hits.join(', ')}`);
  }
  const finalNarrative = narrativeText || '(no narrative provided)';

  const lines = [];
  lines.push(`${klass.emoji} ${klass.label} — ${verb}`);
  lines.push('');

  const displayPhone = formatPhone(phone);
  lines.push(`👤 ${name || 'Unknown'}${displayPhone ? ` | ${displayPhone}` : ''}`);
  lines.push(`Contact ID: ${contactId || 'unknown'}`);

  // Per Mark's v4.2 directive the Prospect line ALWAYS renders — absence is
  // signal. v1.2 (2026-09-14): the absent value reads "Not yet assigned"
  // rather than "NONE", which reps were reading as a permanent verdict on the
  // lead instead of a state LP has yet to reach.
  const prospectClean = (prospectId && String(prospectId).trim() && prospectId !== 'Not in LP')
    ? String(prospectId)
    : PROSPECT_UNASSIGNED;
  lines.push(`Prospect: ${prospectClean}`);

  // v1.1 — Market and Src are required fields on every card. "Unknown"
  // when unresolvable — absence is signal, same doctrine as Prospect.
  lines.push(`🌍 Market: ${market || 'Unknown'}`);
  lines.push(`📋 Src: ${formatLpSource(lpSource, lpSourceDetail) || 'Unknown'}`);

  // v1.2 (2026-08-27) — the facts that make a card worth acting on rather than
  // just reading. Each renders ONLY when the caller passes it, so every
  // existing caller produces byte-identical output. Deliberately NOT
  // always-on with an "Unknown" fallback like Market and Src above: an empty
  // 📍 line is noise on the many cards that have no address to show, whereas
  // an unresolved Market is itself the signal.
  if (address)   lines.push(`📍 ${address}`);
  if (email)     lines.push(`✉️ ${email}`);
  if (jobSize)   lines.push(`📐 Job size: ${jobSize}`);
  if (canvasser) lines.push(`🚪 Canvasser: ${canvasser}`);
  if (rep)       lines.push(`🧑\u200d💼 Rep: ${rep}`);
  if (lpRef)     lines.push(`📋 LP: ${lpRef}`);

  lines.push('');

  lines.push(`📊 Tier: ${cleanTier}`);
  lines.push(`📌 Status: ${cleanStat}`);

  // v1.1 — loss reason: the WHY behind DISQUALIFIED / loss closeouts.
  if (lossReason) {
    lines.push(`🚫 Reason: ${lossReason}`);
  }

  // v1.1 — appointment context: pre-formatted date+time (callers must
  // pass a combined string; never time-only).
  if (appointmentDisplay) {
    lines.push(`📅 ${appointmentDisplay}`);
  }

  // v1.1 — calculator measurements (completion notifications).
  if (calcSummary) {
    lines.push(`📐 Estimate: ${calcSummary}`);
  }

  lines.push('');

  // Class 2 may add "⏰ Act within" before the narrative
  if (notification_class === 'priority' && actWithin) {
    lines.push(`⏰ Act within: ${actWithin}`);
    lines.push('');
  }

  lines.push(`📝 ${finalNarrative}`);

  // Class 3 may add "🎯 Next" after the narrative
  if (notification_class === 'intelligence' && nextStep) {
    lines.push('');
    lines.push(`🎯 Next: ${nextStep}`);
  }

  if (refHash) {
    lines.push('');
    lines.push(`ref: ${refHash}`);
  }

  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════════════════
// HELPERS used by notifications.js
// ══════════════════════════════════════════════════════════════════════

/**
 * Does this payload opt into the new classified format? True when the
 * rule has explicitly set notification_class or action_verb.
 */
export function isClassifiedPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  return Boolean(payload.notification_class || payload.action_verb);
}

/**
 * Should this class skip the rep-facing channel? Currently only debug.
 */
export function isDevOnly(classKey) {
  return classKey === 'debug';
}

/**
 * Resolve the GroupMe bot_id override for a given class. Returns undefined
 * for rep-facing classes (use default bot). Returns process.env.GROUPME_DEV_BOT_ID
 * for debug. Returning null for debug when no DEV_BOT_ID is set
 * signals the caller to skip the send entirely.
 */
export function resolveBotIdOverride(classKey) {
  if (classKey === 'debug') return process.env.GROUPME_DEV_BOT_ID || null;
  return undefined; // use default
}

// ══════════════════════════════════════════════════════════════════════
// CLASS 4 DEV-CHANNEL TRANSPORT
//
// Self-contained sender for debug-class notifications. Bypasses the
// rep-facing groupme.js entirely so debug messages can never be
// accidentally routed to a rep channel. When GROUPME_DEV_BOT_ID is
// unset, falls back to console-log only — safer default than silently
// re-routing to the main channel.
// ══════════════════════════════════════════════════════════════════════

export async function sendToDevChannel(text) {
  const devBotId = process.env.GROUPME_DEV_BOT_ID;
  if (!devBotId) {
    console.log('[Classifier] DEBUG (no GROUPME_DEV_BOT_ID set, log-only): ' + String(text).slice(0, 200));
    return { sent: false, reason: 'no_dev_bot_id' };
  }
  try {
    const res = await fetch('https://api.groupme.com/v3/bots/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: devBotId, text: String(text).slice(0, 1000) }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[Classifier] DEV channel POST failed: ${res.status} ${body.slice(0, 200)}`);
      return { sent: false, reason: `http_${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.error('[Classifier] DEV channel send failed:', err.message);
    return { sent: false, reason: err.message };
  }
}
