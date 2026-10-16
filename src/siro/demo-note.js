/**
 * The GHL demo note — src/siro/demo-note.js (2026-10-16)
 *
 * Built by code from the presentation facts, never by a model, at most 2,000
 * characters, once per recording (the claim lives on siro_recordings). GHL
 * only: Siro's own LP integration writes the LP note, so we never add one.
 * A note is not Slack text, so it has no prospect-label rule; it never prints
 * an LP lead id either way.
 *
 * Prices: the user's ruling (2026-10-16) is that the quotes from the visit are
 * saved in GHL, so this internal note carries siro_recordings.pricing (first
 * and final quote, financing, scope and cost).
 */
import { formatVisitDate, joinItems, PRICING_LABELS } from './presentation-facts.js';
import { siroRecordingUrl } from './config.js';

export const DEMO_NOTE_MAX = 2000;

export function pricingLines(pricing) {
  if (!pricing || typeof pricing !== 'object') return [];
  return PRICING_LABELS
    .filter(([k]) => pricing[k] != null && String(pricing[k]).trim())
    .map(([k, label]) => `  - ${label}: ${String(pricing[k]).trim()}`);
}

/**
 * @param {object|null} facts    buildPresentationFacts()
 * @param {{pricing?: object|null}} [o]  siro_recordings.pricing (default: facts.pricing)
 */
export function buildDemoNote(facts, { pricing = undefined } = {}) {
  if (!facts) return null;
  if (pricing === undefined) pricing = facts.pricing || null;
  const fu = facts.followup || {};
  const ins = facts.insights || {};
  const hesitations = facts.objections.length
    ? facts.objections.map(o => `  - ${o.type}: ${o.said}`).join('\n')
    : null;
  const next = ins.follow_up_summary || (ins.next_steps || [])[0] || fu.action;
  const price = pricingLines(pricing);
  const lines = [
    `DEMO SUMMARY (Siro) — ${formatVisitDate(facts.recorded_at)} — rep ${facts.rep_name || 'unknown'} — outcome: ${facts.result || 'unknown'}`,
    `What they want: ${facts.interests.length ? joinItems(facts.interests) : 'none recorded'}`,
    hesitations ? `Hesitations:\n${hesitations}` : 'Hesitations: none recorded',
    ins.main_objection ? `Main objection: ${ins.main_objection}${ins.secondary_objection ? ` (also: ${ins.secondary_objection})` : ''}` : null,
    ins.objection_summary ? `Why they held off: ${ins.objection_summary}` : null,
    ins.scope ? `Scope discussed: ${ins.scope}` : null,
    price.length ? `Pricing (from the visit):\n${price.join('\n')}` : null,
    `Next step: ${next || 'none recorded'}${ins.follow_up_time ? ` (follow up: ${ins.follow_up_time})` : ''}`,
    `Siro follow-up score: ${fu.score ?? 'n/a'}/5`,
    facts.questions.length ? `Questions asked: ${joinItems(facts.questions)}` : null,
  ].filter(Boolean);
  const link = `Recording: ${siroRecordingUrl(facts.recording_id)}`;
  let body = lines.join('\n');
  const room = DEMO_NOTE_MAX - link.length - 1;
  if (body.length > room) body = `${body.slice(0, room - 1).trimEnd()}…`;
  return `${body}\n${link}`;
}
