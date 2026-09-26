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
  {
    id: 'freshness-refresh',
    label: 'Mirror freshness refresh',
    group: 'sync',
    cadence: 'daily 02:00 ET',
    enabledEnv: 'FRESHNESS_REFRESH_ENABLED',
    enabledDefault: false,
    isEnabled: (env) => String(env.FRESHNESS_REFRESH_ENABLED || 'false').toLowerCase() === 'true',
  },
  {
    id: 'link-leak-monitor',
    label: 'LP↔GHL link leak monitor',
    group: 'sync',
    cadence: 'daily 06:00 ET',
    enabledEnv: 'LINK_LEAK_MONITOR_ENABLED',
    // ON by default, unlike the two above. The failure it watches for is
    // silence — the link leak reopened twice and neither round was noticed —
    // and a watchdog that ships switched off watches nothing.
    enabledDefault: true,
    isEnabled: (env) => String(env.LINK_LEAK_MONITOR_ENABLED || 'true').toLowerCase() !== 'false',
  },
  {
    id: 'p2-unresolvable-monitor',
    label: 'P2 opportunities with no LP job',
    group: 'sync',
    cadence: 'daily 06:30 ET',
    enabledEnv: 'P2_UNRESOLVABLE_MONITOR_ENABLED',
    // ON by default, for the same reason as the monitor above: what it watches
    // for is a pile that nothing counted for months. It is also the only writer
    // of p2_link_health, so switching it off stops the history as well as the
    // alert.
    enabledDefault: true,
    isEnabled: (env) => String(env.P2_UNRESOLVABLE_MONITOR_ENABLED || 'true').toLowerCase() !== 'false',
  },
  {
    id: 'tag-hygiene-sweep',
    label: 'Tag hygiene sweep',
    group: 'ghl',
    cadence: 'daily 03:00 ET',
    enabledEnv: 'TAG_SWEEP_ENABLED',
    // OFF by default (2026-09-22): unlike the monitors above, this job WRITES
    // to GHL contacts. It is switched on by setting TAG_SWEEP_ENABLED=true, and
    // even then runs in TAG_SWEEP_MODE=report until Mark flips it to apply.
    enabledDefault: false,
    isEnabled: (env) => String(env.TAG_SWEEP_ENABLED || '').toLowerCase() === 'true',
  },
  {
    id: 'office-power-ranking',
    label: 'Office power ranking',
    group: 'notifications',
    // 2026-09-25: month-to-date by default (OFFICE_POWER_RANKING_WINDOW=mtd)
    // posts at 20:00 ET; the rolling 7-day mode keeps 08:00 ET.
    cadence: 'daily 20:00 ET (mtd) / 08:00 ET (rolling)',
    enabledEnv: 'OFFICE_POWER_RANKING_ENABLED',
    // OFF by default (2026-09-24): a public league table that names every
    // office including last is a sales-floor decision, not something a deploy
    // should start doing on its own.
    enabledDefault: false,
    isEnabled: (env) => String(env.OFFICE_POWER_RANKING_ENABLED || '').toLowerCase() === 'true',
  },
  {
    // 2026-09-25: announces sales LP shows as won that the GHL I.LP-IN path
    // never announced (LP's webhook stopped delivering on 09-24). ON by
    // default; SALE_ANNOUNCE_BACKSTOP_ENABLED=false turns it off. Mirrors
    // backstopEnabled() in src/notifications/sale-backstop.js.
    id: 'sale-announce-backstop',
    label: 'Sale announcement backstop',
    group: 'notifications',
    cadence: 'every 10 min',
    enabledEnv: 'SALE_ANNOUNCE_BACKSTOP_ENABLED',
    enabledDefault: true,
    isEnabled: (env) => String(env.SALE_ANNOUNCE_BACKSTOP_ENABLED || 'true').toLowerCase() !== 'false',
  },
  {
    // 2026-09-25: last month's final standings, 08:00 ET on the 1st, before
    // every office starts again at $0. Same gate as the daily board, and only
    // in month-to-date mode — the rolling board has no month to close.
    id: 'office-power-ranking-final',
    label: 'Office power ranking — month final',
    group: 'notifications',
    cadence: 'monthly, 1st 08:00 ET',
    enabledEnv: 'OFFICE_POWER_RANKING_ENABLED',
    enabledDefault: false,
    isEnabled: (env) => String(env.OFFICE_POWER_RANKING_ENABLED || '').toLowerCase() === 'true'
      && String(env.OFFICE_POWER_RANKING_WINDOW || 'mtd').toLowerCase() !== 'rolling',
  },
  {
    id: 'missed-caller-recovery',
    label: 'Missed paid caller recovery',
    group: 'five9',
    cadence: 'every 15 min',
    enabledEnv: 'MISSED_CALLER_RECOVERY_MODE',
    // A MODE, not a boolean (2026-09-24): off | shadow | live, default shadow.
    // Enabled in shadow too — shadow runs every decision and logs would_push,
    // so a silent shadow job is as much a defect as a silent live one.
    // Mirrors recoveryMode() in src/jobs/missed-caller-recovery.js: anything
    // but an explicit 'off' runs (an unrecognised value falls back to shadow).
    enabledDefault: true,
    isEnabled: (env) => String(env.MISSED_CALLER_RECOVERY_MODE || 'shadow').toLowerCase().trim() !== 'off',
  },
  {
    id: 'lead-leak-monitor',
    label: 'Lead leak monitor (uncalled LP leads)',
    group: 'five9',
    cadence: 'daily 07:00 ET',
    enabledEnv: 'LEAD_LEAK_MONITOR_MODE',
    // A MODE, not a boolean (2026-09-26): off | shadow | live, default shadow.
    // Shadow measures and stores every morning, so a silent shadow run is a
    // defect too. Mirrors leadLeakMode() in src/jobs/lead-leak-monitor.js.
    enabledDefault: true,
    isEnabled: (env) => String(env.LEAD_LEAK_MONITOR_MODE || 'shadow').toLowerCase().trim() !== 'off',
  },
  {
    id: 'lead-uncalled-check',
    label: 'Leads waiting with no Five9 call',
    group: 'five9',
    cadence: 'hourly 08:00–20:00 ET',
    enabledEnv: 'LEAD_LEAK_ALERT_MODE',
    // A MODE (2026-09-26): off | shadow | live, default shadow. Shadow still
    // runs every hour and logs the card it would send, so a silent shadow pass
    // is a defect too. Mirrors alertMode() in src/lead-speed-alerts.js.
    enabledDefault: true,
    isEnabled: (env) => String(env.LEAD_LEAK_ALERT_MODE || 'shadow').toLowerCase().trim() !== 'off',
  },
]);

/** Ids only — handy for tests and for asserting the wiring matches the roster. */
export const JOB_IDS = Object.freeze(JOBS.map((j) => j.id));
