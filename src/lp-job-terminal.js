/**
 * Terminal LP job statuses — src/lp-job-terminal.js
 * ONE definition, shared by scripts/reconcile-p2-stages.js, the P2 create guard
 * (src/p2-opportunity-context.js) and the stale-fire gate. Mirrors the
 * event_subtype_in lists on agent_rules 365 (P2_JOB_TERMINAL_LOST) and 366
 * (P2_JOB_TERMINAL_WON). 'Installed & Unpaid' is deliberately in NEITHER set.
 */
export const WON_JOB_STATUSES = new Set([
  'Paid In Full', 'PIF Survey Ready', 'PIF NO Survey', 'Assumed Complete',
]);
export const LOST_JOB_STATUSES = new Set([
  'Cancelled', 'Cancelled By Mgt', 'Dead Deal', 'Sent To Attorney', 'Credit Decline',
]);
