/**
 * The GHL demo note — src/siro/demo-note.js (2026-10-16)
 *
 * Built by code from the presentation facts, never by a model, at most 2,000
 * characters, once per recording (the claim lives on siro_recordings). GHL
 * only: Siro's own LP integration writes the LP note, so we never add one.
 * A note is not Slack text, so it has no prospect-label rule; it never prints
 * an LP lead id either way.
 */
import { formatVisitDate } from './presentation-facts.js';
import { siroRecordingUrl } from './config.js';

export const DEMO_NOTE_MAX = 2000;

export function buildDemoNote(facts) {
  if (!facts) return null;
  const fu = facts.followup || {};
  const hesitations = facts.objections.length
    ? facts.objections.map(o => `  - ${o.type}: customer said "${o.said}"`).join('\n')
    : 'none recorded';
  const lines = [
    `DEMO SUMMARY (Siro) — ${formatVisitDate(facts.recorded_at)} — rep ${facts.rep_name || 'unknown'} — outcome: ${facts.result || 'unknown'}`,
    `What they want: ${facts.interests.length ? facts.interests.join('; ') : 'none recorded'}`,
    `Hesitations:${facts.objections.length ? `\n${hesitations}` : ` ${hesitations}`}`,
    `Questions asked: ${facts.questions.length ? facts.questions.join('; ') : 'none recorded'}`,
    `Follow-up (Siro score ${fu.score ?? 'n/a'}/5): ${fu.action || 'none'}`,
    `Summary: ${facts.summary_lines.length ? facts.summary_lines.join(' ') : 'none recorded'}`,
  ];
  const link = `Recording: ${siroRecordingUrl(facts.recording_id)}`;
  let body = lines.join('\n');
  const room = DEMO_NOTE_MAX - link.length - 1;
  if (body.length > room) body = `${body.slice(0, room - 1).trimEnd()}…`;
  return `${body}\n${link}`;
}
