/**
 * job-registry.js — the declarative roster of instrumented background jobs.
 *
 * Data only, no imports. It is upserted into `job_registry` at boot
 * (src/job-runner.js registerJobs) and it doubles as the readable answer to
 * "what is supposed to be running on this box?".
 *
 * WHY A REGISTRY AND NOT JUST THE RUN HISTORY (2026-09-16). A job that has
 * never run writes no rows, and a table of runs cannot tell you about a job
 * that is silent — which is the only failure mode that has ever actually hurt
 * here. Listing the expected jobs separately is what makes silence visible.
 *
 * `isEnabled(env)` exists so the dashboard can say "disabled" rather than
 * "stale" for a job that is deliberately switched off. An alarm that fires on
 * the healthy case gets muted, and a muted alarm is how the 47-hour outage and
 * the 71-day blind spot both went unnoticed (CLAUDE.md, "Classify before you
 * threshold").
 *
 * The gate has to be RESOLVED HERE, at boot, and stored: these env vars live on
 * this service and the dashboard cannot see them. Each expression below mirrors
 * the one in the job's own module exactly — including the inverted one
 * (LP_REPORT_WATCHDOG_DISABLED) and the one that is a mode rather than a
 * boolean (OMI_PULL_MODE). If you change a gate there, change it here.
 *
 * ADDING A JOB. Add a row here, then wrap its work call inside its own
 * start*Scheduler() with runJob('<id>', () => runX()). Wrap the WORK, not the
 * timer tick: seven of these tick every five minutes but only act inside an
 * Eastern-time window, and wrapping the tick would file ~288 no-op rows a day
 * each. See docs/job-runs.md.
 *
 * NOT INSTRUMENTED ON PURPOSE: the two 60-second heartbeats
 * (decision-engine-heartbeat, executor-heartbeat). They already have dedicated
 * /heartbeat-status endpoints and edge-triggered alerting, and a row a minute
 * would add ~2,900 rows a day carrying no signal that is not already there.
 */

export const JOBS = Object.freeze([
  // ── No durable run history before this table existed ──────────────────────
  {
    id: 'memory-nightly',
    label: 'Memory nightly',
    group: 'memory',
    cadence: 'daily 03:00 ET',
    enabledEnv: 'MEMORY_NIGHTLY_ENABLED',
    enabledDefault: true,
    isEnabled: (env) => String(env.MEMORY_NIGHTLY_ENABLED || 'true').toLowerCase() !== 'false',
  },
  {
    id: 'capacity-sweep-fast',
    label: 'Capacity sweep (fast pass)',
    group: 'capacity',
    cadence: 'every 15 min',
    enabledEnv: null,
    enabledDefault: true,
    isEnabled: () => true,
  },
  {
    id: 'lp-report-watchdog',
    label: 'LP report watchdog',
    group: 'lp-reports',
    cadence: 'every 5 min from 07:30 ET',
    enabledEnv: 'LP_REPORT_WATCHDOG_DISABLED',
    enabledDefault: true,
    isEnabled: (env) => !String(env.LP_REPORT_WATCHDOG_DISABLED || '').trim(),
  },
  {
    id: 'workflow-projection',
    label: 'Workflow projection',
    group: 'workflows',
    cadence: 'every 2 min',
    enabledEnv: 'WORKFLOW_PROJECTION_ENABLED',
    enabledDefault: true,
    isEnabled: (env) => String(env.WORKFLOW_PROJECTION_ENABLED || 'true').toLowerCase() !== 'false',
  },
  {
    id: 'scorecard-validate',
    label: 'Scorecard validate',
    group: 'scorecard',
    cadence: 'daily 07:00 ET',
    enabledEnv: 'SCORECARD_VALIDATE_ENABLED',
    enabledDefault: true,
    isEnabled: (env) => (env.SCORECARD_VALIDATE_ENABLED || 'true') === 'true',
  },
  {
    id: 'omi-pull',
    label: 'Omi pull',
    group: 'memory',
    cadence: 'every 15 min',
    enabledEnv: 'OMI_PULL_MODE',
    enabledDefault: false,
    isEnabled: (env) => String(env.OMI_PULL_MODE || 'off').toLowerCase().trim() !== 'off',
  },
  {
    id: 'five9-silence-watchdog',
    label: 'Five9 silence watchdog',
    group: 'five9',
    cadence: 'hourly',
    enabledEnv: 'FIVE9_SILENCE_WATCHDOG_ENABLED',
    enabledDefault: true,
    isEnabled: (env) => (env.FIVE9_SILENCE_WATCHDOG_ENABLED || 'true') === 'true',
  },
  {
    id: 'fb-publish-watchdog',
    label: 'Facebook publish watchdog',
    group: 'content',
    cadence: 'every 5 min',
    enabledEnv: 'FB_WATCHDOG_ENABLED',
    enabledDefault: true,
    isEnabled: (env) => (env.FB_WATCHDOG_ENABLED || 'true') === 'true',
  },

  // ── Keep their own detail table, but had no roster entry ──────────────────
  {
    id: 'source-reconcile',
    label: 'Source reconcile',
    group: 'sources',
    cadence: 'daily 05:30 ET',
    enabledEnv: 'SOURCE_RECONCILE_ENABLED',
    enabledDefault: true,
    isEnabled: (env) => (env.SOURCE_RECONCILE_ENABLED || 'true') === 'true',
  },
  {
    id: 'goal-scorecard-daily',
    label: 'Goal scorecard (daily)',
    group: 'scorecard',
    cadence: 'daily 06:00 ET',
    enabledEnv: null,
    enabledDefault: true,
    isEnabled: () => true,
  },
  {
    id: 'lp-report-recon',
    label: 'LP report reconciliation',
    group: 'lp-reports',
    cadence: 'daily 08:00 ET',
    enabledEnv: 'LP_REPORT_RECON_ENABLED',
    enabledDefault: true,
    isEnabled: (env) => (env.LP_REPORT_RECON_ENABLED || 'true').trim() !== 'false',
  },
  {
    id: 'five9-config-snapshot',
    label: 'Five9 config snapshot',
    group: 'five9',
    cadence: 'daily 04:00 ET',
    enabledEnv: 'FIVE9_CONFIG_SNAPSHOT_ENABLED',
    enabledDefault: false,
    isEnabled: (env) => env.FIVE9_CONFIG_SNAPSHOT_ENABLED === 'true',
  },
]);

/** Ids only — handy for tests and for asserting the wiring matches the roster. */
export const JOB_IDS = Object.freeze(JOBS.map((j) => j.id));
