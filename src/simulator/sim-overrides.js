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

/** Run fn with these overrides in force. Unknown or empty values are ignored. */
export function runWithSimOverrides(overrides, fn) {
  const kbExemplarMode = KB_EXEMPLAR_OVERRIDE_MODES.includes(overrides?.kbExemplarMode) ? overrides.kbExemplarMode : null;
  if (!kbExemplarMode) return fn();
  return store.run({ kbExemplarMode }, fn);
}

/** The simulator's KB_EXEMPLAR_MODE for this run, or null outside one. */
export function simKbExemplarMode() {
  return store.getStore()?.kbExemplarMode || null;
}
