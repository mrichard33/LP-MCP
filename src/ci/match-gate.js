/**
 * Call Intelligence — the early match gate — src/ci/match-gate.js
 *
 * §8b. Decides ONE thing: having already resolved which customer a fetched
 * call belongs to, is this call worth a Whisper transcription?
 *
 * ── WHY THE ORDER CHANGED ──────────────────────────────────────────────────
 * The pipeline ran fetch → transcribe → analyze → match → sync, so matching
 * was paid for after transcription. It does not use the transcript: it keys on
 * campaign + customer phone against LP. Measured over 4,154 transcripts and
 * 113.5 audio-hours (~$40.86 at whisper-1's $0.006/min), 2,034 led to a
 * writable match and 2,120 did not — 51% of the spend buying nothing that ever
 * reached a customer record.
 *
 * The common path is now fetch → match → transcribe → analyze → sync. Nothing
 * about resolving a customer required the audio to have been transcribed
 * first; it was only ever an accident of stage ordering.
 *
 * ── THIS MODULE IS PURE, AND THAT IS THE POINT ─────────────────────────────
 * The decision to NOT spend money is exactly the decision that fails silently:
 * a gate that is too aggressive looks identical to a pipeline that is working
 * fine but quiet. That is the failure mode that hid the 2026-08-22 filename
 * break for three days. So the rule set is a pure function over an already-made
 * match decision — every boundary below is assertable with no database, no
 * OpenAI, and no clock — and the worker's only job is to obey it and record it.
 *
 * ── THE THREE BYPASSES ─────────────────────────────────────────────────────
 * Each one is a case where "no writable target" is TRUE and gating would still
 * destroy something that has value today.
 *
 *   1. canvasser_ani. The canvasser routing design DELIBERATELY uses the
 *      transcript to work out which customer the call is about, precisely
 *      BECAUSE the ANI is the canvasser's phone and match.js refuses to key on
 *      it. Those calls resolve to tier 'none' by construction. Gating them
 *      would not trim waste, it would make that project impossible.
 *
 *   2. tier 'none' with the caller unknown to LP, while CI_TRANSCRIBE_UNMATCHED
 *      is on (the default). See config.js — some of these are new leads and the
 *      transcript is the only record of them.
 *
 *   3. An existing transcript. A requeued call must never re-transcribe and
 *      re-pay for audio already bought.
 *
 * ── WHAT COUNTS AS "NO WRITABLE TARGET" ────────────────────────────────────
 * ONLY a definitive tier 'none'. `ambiguous` means several candidates and the
 * transcript may yet be what chooses between them; `probable` is one flag away
 * from writable. Gating on anything short of 'none' trades real notes for small
 * savings. tierWritable() from sync.js is the authority on writability itself —
 * the tier rules are not re-implemented here.
 */

import { getConfig } from './config.js';
import { tierWritable } from './sync.js';

/** ci_events.stage for every gate decision. */
export const GATE_STAGE = 'match_gate';
/** ci_events.event for every gate decision, in BOTH directions. */
export const GATE_EVENT = 'decision';

/**
 * Reasons, as stored strings. Named because /ci/health counts them and a
 * rename would silently zero a column somebody is watching.
 */
export const GATE_REASONS = {
  TRANSCRIPT_EXISTS: 'transcript_exists',
  CANVASSER_ANI: 'canvasser_ani',
  TIER_WRITABLE: 'tier_writable',
  TIER_NOT_DEFINITIVE: 'tier_not_definitive',
  UNMATCHED_TRANSCRIPTION_ENABLED: 'unmatched_transcription_enabled',
  NO_WRITABLE_TARGET: 'no_writable_target',
};

/**
 * Should this call be transcribed?
 *
 * Rules are ordered and the FIRST hit wins, so the three bypasses are checked
 * before the one rule that can withhold a transcript. Reading top to bottom is
 * reading the policy.
 *
 * @param {object}  args
 * @param {string}  args.tier          the LP match tier just resolved
 * @param {Array}   [args.canvassers]  roster hits, from match.js's guard
 * @param {boolean} [args.hasTranscript] a ci_transcripts row already exists
 * @param {object}  [args.cfg]
 * @returns {{transcribe: boolean, reason: string, tier: string, writable: boolean}}
 */
export function transcribeGate({ tier, canvassers = [], hasTranscript = false, cfg = getConfig() } = {}) {
  const resolved = String(tier ?? 'none');
  // Asked of the LP target: LP is the only one `probable` can ever reach
  // (§8 never permits a probable write to GHL), so it is the generous read of
  // "could this call's match produce a note", which is the right question for
  // a gate that must fail toward spending money.
  const writable = tierWritable(resolved, 'lp', cfg);
  const verdict = (transcribe, reason) => ({ transcribe, reason, tier: resolved, writable });

  // BYPASS 3 — the audio is already paid for. First, because it is true
  // regardless of anything else below and costs nothing either way.
  if (hasTranscript) return verdict(true, GATE_REASONS.TRANSCRIPT_EXISTS);

  // BYPASS 1 — the whole canvasser design depends on this transcript.
  if (Array.isArray(canvassers) && canvassers.length > 0) {
    return verdict(true, GATE_REASONS.CANVASSER_ANI);
  }

  // A tier a note can actually be written from. No further questions.
  if (writable) return verdict(true, GATE_REASONS.TIER_WRITABLE);

  // Not writable, but not a definitive miss either: 'ambiguous', or 'probable'
  // with CALL_INTEL_ALLOW_PROBABLE off. Both still transcribe — see the header.
  if (resolved !== 'none') return verdict(true, GATE_REASONS.TIER_NOT_DEFINITIVE);

  // BYPASS 2 — tier 'none', and the default posture says keep the transcript.
  if (cfg.transcribeUnmatched) return verdict(true, GATE_REASONS.UNMATCHED_TRANSCRIPTION_ENABLED);

  // The only path that withholds a transcription.
  return verdict(false, GATE_REASONS.NO_WRITABLE_TARGET);
}

/**
 * The detail written to ci_events for one gate decision.
 *
 * `audio_seconds` is carried on BOTH outcomes, not just the gated-out one:
 * seconds-not-transcribed is only interpretable next to seconds-transcribed,
 * and a health number that can only ever grow proves nothing about whether the
 * gate is too aggressive.
 */
export function gateEventDetail(call, gate, extra = {}) {
  const seconds = Number(call?.duration_seconds ?? 0);
  return {
    transcribed: gate.transcribe,
    reason: gate.reason,
    tier: gate.tier,
    writable: gate.writable,
    audio_seconds: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0,
    ...extra,
  };
}

export default { transcribeGate, gateEventDetail, GATE_STAGE, GATE_EVENT, GATE_REASONS };
