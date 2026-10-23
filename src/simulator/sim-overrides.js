/**
 * Per-run overrides for the bot simulator — src/simulator/sim-overrides.js
 *
 * WHY (2026-10-12). KB_EXEMPLAR_MODE had been in shadow since 2026-09-03 and the
 * bot gate (run_bot_eval) could not try it: the knowledge pack reads the mode
 * from Railway's environment, and the only way to see a run with exemplars on
 * was to switch them on for every customer. The stage mode got a per-run option
 * by threading it through both bots; the knowledge pack sits too deep for that
 * (both bots, the memoised prepare, the live-chat lane), so the simulator sets
 * the override in AsyncLocalStorage around a run, like src/ghl-caller.js does
 * for the GHL caller label.
 *
 * Outside a simulation the store is empty and every getter returns null, so a
 * production turn can never pick an override up.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage();

export const KB_EXEMPLAR_OVERRIDE_MODES = Object.freeze(['off', 'shadow', 'live']);

// 2026-10-19 (handoff v2): the Siro, deal-hint and takeover modes, so the gate
// can try each before Mark flips it on Railway.
export const SIM_MODE_OVERRIDES = Object.freeze({
  siroContextMode: ['off', 'shadow', 'live'],
  siroFollowupTextMode: ['off', 'shadow', 'live'],
  f0FormulaMode: ['v1', 'four_step'],
  rehashDealHintMode: ['once', 'every'],
  humanTakeoverMode: ['off', 'shadow', 'live'],
  // 2026-10-21 (rehash booking + better-price handoff): the two rehash-only
  // switches (src/agentic/rehash-flags.js), so the gate can compare on and off.
  rehashBookingFix: ['on', 'off'],
  rehashBetterPrice: ['on', 'off'],
  // 2026-10-21 (rehash pause + ownership): John owns a booked lead, a rehash
  // rep's manual message pauses the bot 15 minutes, and the rehash reply's voice.
  rehashOwnedMode: ['off', 'shadow', 'live'],
  rehashPauseMode: ['off', 'shadow', 'live'],
  rehashVoiceMode: ['rep', 'team'],
  // 2026-10-23 (Kim Turko): an owned lead's direct question gets a short answer.
  rehashOwnedAnswerMode: ['off', 'shadow', 'live'],
});

/** Run fn with these overrides in force. Unknown or empty values are ignored. */
export function runWithSimOverrides(overrides, fn) {
  const kbExemplarMode = KB_EXEMPLAR_OVERRIDE_MODES.includes(overrides?.kbExemplarMode) ? overrides.kbExemplarMode : null;
  // 2026-10-19: BOT_INCLUDE_REVIN_THREAD for this run (src/revin/thread.js).
  const includeRevinThread = typeof overrides?.includeRevinThread === 'boolean' ? overrides.includeRevinThread : null;
  const modes = {};
  for (const [k, allowed] of Object.entries(SIM_MODE_OVERRIDES)) {
    if (allowed.includes(overrides?.[k])) modes[k] = overrides[k];
  }
  if (!kbExemplarMode && includeRevinThread == null && !Object.keys(modes).length) return fn();
  return store.run({ kbExemplarMode, includeRevinThread, ...modes }, fn);
}

/** The simulator's mode overrides for this run ({} outside one). */
export function simModeOverrides() {
  const st = store.getStore() || {};
  const out = {};
  for (const k of Object.keys(SIM_MODE_OVERRIDES)) if (st[k]) out[k] = st[k];
  return out;
}
/** The Siro overrides (siroContextMode, siroFollowupTextMode, f0FormulaMode), each null when unset. */
export function simSiroOverrides() {
  const st = store.getStore() || {};
  return { siroContextMode: st.siroContextMode || null, siroFollowupTextMode: st.siroFollowupTextMode || null, f0FormulaMode: st.f0FormulaMode || null };
}

/** The simulator's KB_EXEMPLAR_MODE for this run, or null outside one. */
export function simKbExemplarMode() {
  return store.getStore()?.kbExemplarMode || null;
}

/** The simulator's BOT_INCLUDE_REVIN_THREAD for this run (true/false), or null outside one. */
export function simIncludeRevinThread() {
  const v = store.getStore()?.includeRevinThread;
  return typeof v === 'boolean' ? v : null;
}
