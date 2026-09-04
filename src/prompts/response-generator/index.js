/**
 * Prompt text for src/response-generator.js — the barrel.
 *
 * response-generator.js imports this file and nothing else from here:
 *
 *   import * as P from './prompts/response-generator/index.js';
 *
 * so every moved string reads as `P.SOMETHING` at its call site and is greppable
 * back to one module. Split out 2026-09 (Handoff_ResponseGenerator_Split_v1):
 * the generator was 231 KB, roughly 4× the MCP edit ceiling, and most of that
 * bulk was copy. Copy now lives where it can be reviewed as copy.
 *
 *   system-core.js    always-on system prompt sections
 *   banned.js         prohibition and anti-pattern text
 *   examples.js       worked GOOD/BAD examples
 *   framing.js        customer-facing framing per sender / channel / calendar
 *   playbooks.js      per-action and per-state blocks
 *   context-frame.js  the user-prompt data frame and the output contract
 *
 * WHAT DOES NOT LIVE HERE: conditionals (which block applies is the
 * orchestrator's decision), env reads (response-generator.js reads env at module
 * load and a test depends on that), and code-side validators. These modules
 * export strings and pure string-returning functions, nothing else.
 *
 * THE GUARD: scripts/test-response-prompt-snapshot.js asserts the assembled
 * prompts are byte-identical to committed snapshots. Any edit here must land
 * with a deliberate re-baseline (UPDATE_SNAPSHOTS=1) whose snapshot diff IS the
 * copy change under review.
 */
export * from './system-core.js';
export * from './banned.js';
export * from './examples.js';
export * from './framing.js';
export * from './playbooks.js';
export * from './context-frame.js';
