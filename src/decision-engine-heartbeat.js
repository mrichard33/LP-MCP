/**
 * Decision Engine Heartbeat — src/decision-engine-heartbeat.js
 *
 * Phase 1 Optimization Play 2 (2026-05-13).
 *
 * In-process failover scheduler for the Decision Engine. Sits dormant
 * while n8n's external heartbeat is healthy, takes over automatically
 * if n8n stops firing the decision-engine cron.
 *
 * BACKGROUND
 * ──────────
 * Layer 1 of the agentic system relies on a 5-minute n8n cron
 * (workflow ERnvX5hp6i90VVWc) hitting POST /n8n/decision-engine/process
 * to convert pending system_events into agent_actions. When that cron
 * stops firing, events pile up indefinitely — customer replies, booking
 * confirmations, AI handoffs all sit in the queue silently.
 *
 * Cited incident: 2026-05-13. n8n workflow ERnvX5hp6i90VVWc went
 * dormant at 02:25 UTC on 2026-05-11. Schedule trigger silently
 * stopped firing while the workflow was still marked active=true.
 * Other n8n schedules (Daily MV Refresh) continued running. Discovered
 * 2.5 days later when 998 events had accumulated, including:
 *   - 10 unprocessed inbound replies
 *   - 12 appointment bookings
 *   - 14 agentic handoffs
 *   - 8 critical lead_score_changed events
 * Oldest event was 47 hours old.
 *
 * Pairs with src/executor-heartbeat.js which is the equivalent failover
 * for the Action Executor (Layer 2). Together they make the agentic
 * system n8n-independent: n8n is preferred when healthy, but the system
 * recovers on its own within 6 minutes if n8n stops firing.
 *
 * DESIGN
 * ──────
 * Failover, not parallel. The scheduler:
 *   1. Checks the most recent processed_at across system_events
 *   2. If < STALE_THRESHOLD_MS old: skip (n8n is doing its job)
 *   3. If >= STALE_THRESHOLD_MS old: run processEvents
 *
 * Why failover rather than always-on:
 *   - processSingleEvent already has inbound idempotency (MVI v2.5,
 *     processed_events table) so duplicate processing is SAFE for
 *     correctness — same event won't double-fire rules. But running
 *     two drivers in parallel is wasteful.
 *   - Keeps n8n authoritative when healthy. n8n stays the system of
 *     record for "did this 5-min cycle fire" observability.
 *
 * KILL SWITCH
 * ───────────
 *   DECISION_ENGINE_HEARTBEAT_DISABLED=true — disables the scheduler entirely
 *
 * TUNING
 * ──────
 *   STALE_THRESHOLD_MS — how stale "no events processed in X ms" means
 *                        before failover fires. Default 6min — gives
 *                        n8n's 5-min cadence a 1-min buffer.
 *   HEARTBEAT_INTERVAL_MS — how often this scheduler wakes up. Default
 *                           5min — same as n8n cadence.
 *   FIRST_RUN_DELAY_MS — initial wait on boot. Default 3min — gives
 *                        the server time to settle, n8n a chance to
 *                        fire first if it's healthy.
 *
 * MANUAL TRIGGER
 * ──────────────
 *   POST /n8n/decision-engine/heartbeat-de
 *     Forces a heartbeat check immediately (subject to staleness gate).
 *     Pass { force: true } in body to bypass the staleness gate and
 *     run processEvents unconditionally.
 *
 * OBSERVABILITY
 * ─────────────
 *   - Logs every heartbeat decision at info level
 *   - On failover-fire: logs the staleness duration and the processEvents
 *     result summary (events_processed/actions_created counts)
 *   - On skip: logs the most-recent processed_at age in seconds
 */

import supabase from './supabase.js';
import { processEvents } from './decision-engine.js';
import { reportAlertCondition } from './alert-state.js';
import {
  shouldAlertAgenticSilence,
  formatAgenticSilenceAlert,
} from './agentic-silence-alerts.js';
// 2026-09-12 — fail-closed watchdog. rule.condition_failed_closed has been
// emitted since 2026-07-03 and read by nobody; 433,748 of them accumulated
// before a manual sweep found them 71 days later. Nothing watched the one
// signal that says a rule was suppressed on data it could not read.
import {
  summarizeFailClosed,
  shouldAlertFailClosed,
  formatFailClosedAlert,
} from './rule-fail-closed-alerts.js';
// 2026-09-02 — per-contact reply SLA (Jacqueline Branham). Shadow by default.
import { runReplySlaWatchdog } from './jobs/reply-sla-watchdog.js';

// 2026-06-05: promoted from 6-min-late FAILOVER to PRIMARY driver. The n8n
// cron (ERnvX5hp6i90VVWc) silently went dormant on 2026-05-22 while still
// active=true — second occurrence of the 2026-05-13 silent-dormant bug — so
// the in-process scheduler is now the system of record for queue draining.
// n8n, if re-armed, is redundant secondary (processSingleEvent is idempotent
// via the processed_events table, so double-runs are correctness-safe).
//
// Behaviour in PRIMARY mode (default): drain whenever events are pending, on
// HEARTBEAT_INTERVAL_MS, looping processEvents until the queue is empty.
// Set DECISION_ENGINE_HEARTBEAT_PRIMARY_MODE=false to revert to the legacy
// stale-gated failover behaviour without redeploying code.
const PRIMARY_MODE = process.env.DECISION_ENGINE_HEARTBEAT_PRIMARY_MODE !== 'false';

const HEARTBEAT_INTERVAL_MS = parseInt(
  process.env.DECISION_ENGINE_HEARTBEAT_INTERVAL_MS || `${60 * 1000}`, 10
);
const FIRST_RUN_DELAY_MS = parseInt(
  process.env.DECISION_ENGINE_HEARTBEAT_FIRST_RUN_DELAY_MS || `${30 * 1000}`, 10
);

// Staleness gate is only consulted when PRIMARY_MODE is off (legacy failover).
const STALE_THRESHOLD_MS = parseInt(
  process.env.DECISION_ENGINE_STALE_THRESHOLD_MS || `${6 * 60 * 1000}`, 10
);

// Drain loop bounds — one wake processes up to MAX_DRAIN_ITERATIONS batches of
// DRAIN_BATCH_LIMIT, so a burst clears in a single cycle instead of one batch
// per interval. Cap prevents an unbounded run if events arrive faster than we
// drain (the leftover continues on the next tick).
const MAX_DRAIN_ITERATIONS = parseInt(
  process.env.DECISION_ENGINE_HEARTBEAT_MAX_DRAIN_ITERATIONS || '20', 10
);
// 2026-08-03 — agentic-silence watchdog. The 47-hour outage (2026-07-31 →
// 2026-08-02) produced ZERO ai.analysis_completed while replies kept arriving,
// and nothing paged: every existing alarm watches a proxy (queue depth, action
// failures, limiter health) and all of them stayed quiet because nothing backed
// up — replies were consumed and dropped. This watches the pipeline's OUTPUT.
const SILENCE_WINDOW_HOURS = Math.max(
  1, parseInt(process.env.AGENTIC_SILENCE_WINDOW_HOURS || '6', 10)
);
// Eligible replies that must go unanswered before this pages. The literal spec
// (any non-zero reply count) would page on one off-hours message; 2 stays quiet
// there while still catching the real outage, which had 8 replies in 6 hours.
const SILENCE_MIN_REPLIES = Math.max(
  1, parseInt(process.env.AGENTIC_SILENCE_MIN_REPLIES || '2', 10)
);
// One page per window, not one per 60s heartbeat.
//
// 2026-09-05 — CLOSED, so nobody re-opens it. PR #845 observed this alert
// firing at ~75-minute intervals against the 6-hour default and guessed
// AGENTIC_SILENCE_ALERT_COOLDOWN_MS was overridden in Railway. It is not set
// there (LP-MCP production, single replica; checked 2026-09-05). The cadence
// was RESTARTS: the service deployed 13 times on 2026-09-04, and every deploy
// reset lastSilenceAlertAt to 0 — the exact process-local-memory bug #845 was
// written to fix. There is nothing to clear.
const SILENCE_ALERT_COOLDOWN_MS = parseInt(
  process.env.AGENTIC_SILENCE_ALERT_COOLDOWN_MS || `${6 * 60 * 60 * 1000}`, 10
);
// 2026-09-04 — how long an UNRESOLVED silence waits before it re-reminds. The
// cooldown above no longer paces the alert (alert-state.js is edge-triggered);
// it survives only as the degraded path when the state table is unusable.
const SILENCE_REMIND_MS = parseInt(
  process.env.AGENTIC_SILENCE_REMIND_MS || `${24 * 60 * 60 * 1000}`, 10
);

const DRAIN_BATCH_LIMIT = parseInt(
  process.env.DECISION_ENGINE_HEARTBEAT_DRAIN_BATCH_LIMIT || '50', 10
);

// 2026-09-12 — fail-closed watchdog window and threshold. See
// src/rule-fail-closed-alerts.js for the class split; the short version is that
// an unimplemented-operator suppression pages at any volume (the rule cannot
// fire at all) while an unreadable-read suppression pages on a burst. Real
// background after the engine stopped emitting non-events is ~1 infra
// suppression per 6h, so 25 is well clear of normal and still catches an
// outage the moment it starts skipping gates.
const FAIL_CLOSED_WINDOW_HOURS = Math.max(
  1, parseInt(process.env.RULE_FAIL_CLOSED_WINDOW_HOURS || '6', 10)
);
const FAIL_CLOSED_INFRA_THRESHOLD = Math.max(
  1, parseInt(process.env.RULE_FAIL_CLOSED_INFRA_THRESHOLD || '25', 10)
);
// Bounds the read. A window holding more than this is already far past the
// threshold, so the decision is unchanged and the extra rows only cost memory.
const FAIL_CLOSED_SCAN_LIMIT = Math.max(
  100, parseInt(process.env.RULE_FAIL_CLOSED_SCAN_LIMIT || '2000', 10)
);
// A dead rule does not self-resolve — it stays dead until somebody edits it —
// so an unresolved card re-reminds daily, like the agentic-silence key.
const FAIL_CLOSED_REMIND_MS = parseInt(
  process.env.RULE_FAIL_CLOSED_REMIND_MS || `${24 * 60 * 60 * 1000}`, 10
);
const FAIL_CLOSED_ALERT_COOLDOWN_MS = parseInt(
  process.env.RULE_FAIL_CLOSED_ALERT_COOLDOWN_MS || `${6 * 60 * 60 * 1000}`, 10
);

let intervalHandle = null;
let isRunning = false; // reentrancy guard — prevents overlapping drain cycles

// 2026-08-03 — agentic-silence watchdog state. lastSilenceCheck is the most
// recent computation, surfaced on the status route so the watchdog can be
// inspected without waiting for it to fire.
let lastSilenceAlertAt = 0;
let lastSilenceCheck = null;
// 2026-09-02 — most recent reply-SLA pass, surfaced on the status route.
let lastReplySlaCheck = null;
// 2026-09-12 — most recent fail-closed watchdog pass, same purpose.
let lastFailClosedCheck = null;

/**
 * Find the most recent processed_at timestamp across all system_events.
 * Returns ISO string or null if no events have ever been processed.
 */
async function getMostRecentProcessedAt() {
  const { data, error } = await supabase
    .from('system_events')
    .select('processed_at')
    .not('processed_at', 'is', null)
    .order('processed_at', { ascending: false })
    .limit(1);
  if (error) {
    console.warn(`[DecisionEngineHeartbeat] processed_at query failed: ${error.message}`);
    return null;
  }
  return data?.[0]?.processed_at || null;
}

/**
 * Check whether there are pending events that warrant firing the engine.
 * Returns count of unprocessed events (capped at 1 for efficiency).
 */
async function hasPendingEvents() {
  const { count, error } = await supabase
    .from('system_events')
    .select('id', { count: 'exact', head: true })
    .eq('processed', false);
  if (error) {
    console.warn(`[DecisionEngineHeartbeat] pending count failed: ${error.message}`);
    return false;
  }
  return (count || 0) > 0;
}

/**
 * Check if the decision engine needs a failover kick. Returns:
 *   { needs_run: bool, last_processed_at, age_ms, has_pending }
 */
async function checkEngineHealth() {
  const [lastIso, hasPending] = await Promise.all([
    getMostRecentProcessedAt(),
    hasPendingEvents(),
  ]);

  if (!hasPending) {
    // Nothing to process — no need to fire regardless of staleness.
    return { needs_run: false, last_processed_at: lastIso, age_ms: null, has_pending: false };
  }

  if (!lastIso) {
    // Pending events exist but no processing history — fire to drain.
    return { needs_run: true, last_processed_at: null, age_ms: null, has_pending: true };
  }

  const ageMs = Date.now() - Date.parse(lastIso);
  // PRIMARY mode: pending events alone warrant a run (no staleness wait).
  // Legacy FAILOVER mode (PRIMARY_MODE=false): only fire once stale ≥ threshold.
  return {
    needs_run: PRIMARY_MODE ? true : ageMs >= STALE_THRESHOLD_MS,
    last_processed_at: lastIso,
    age_ms: ageMs,
    has_pending: true,
  };
}

/**
 * 2026-08-03 — Count the agentic pipeline's output vs its answerable input over
 * the rolling window.
 *
 * Replies the bot was deliberately forbidden to answer are NOT missed analyses.
 * A live check on 2026-08-02 found 4 replies / 0 analyses that were entirely
 * correct — every one from a stop-bot / DNC contact. Counting raw replies would
 * page critical on a healthy night, and an alarm that cries wolf gets muted,
 * which is how the next 47-hour outage happens. Both consumer paths mark those
 * events: `skipped: <reason>` (analyzePendingReplies) and `bot_silenced:
 * <reason>` (the reply buffer).
 *
 * Counting is done in JS rather than SQL aggregates because reply volume in a
 * 6h window is tiny and it keeps the null-action_taken case (a reply still
 * in-flight — eligible) obviously correct.
 *
 * @returns {Promise<object|null>} counts, or null if the read failed.
 */
async function getAgenticSilenceCounts() {
  if (!supabase) return null;
  const since = new Date(Date.now() - SILENCE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  try {
    const [analysesRes, repliesRes] = await Promise.all([
      supabase
        .from('system_events')
        .select('id', { count: 'exact', head: true })
        .eq('event_type', 'ai.analysis_completed')
        .gte('created_at', since),
      supabase
        .from('system_events')
        .select('action_taken')
        .eq('event_type', 'ghl.reply_received')
        .gte('created_at', since)
        .limit(1000),
    ]);
    if (analysesRes.error) throw analysesRes.error;
    if (repliesRes.error) throw repliesRes.error;

    const replies = Array.isArray(repliesRes.data) ? repliesRes.data : [];
    const isSilenced = (a) => typeof a === 'string'
      && (a.startsWith('skipped: ') || a.startsWith('bot_silenced: '));
    const skippedReplies = replies.filter(r => isSilenced(r?.action_taken)).length;

    return {
      analyses: analysesRes.count ?? 0,
      eligibleReplies: replies.length - skippedReplies,
      skippedReplies,
      windowHours: SILENCE_WINDOW_HOURS,
      checked_at: new Date().toISOString(),
    };
  } catch (err) {
    console.warn(`[DecisionEngineHeartbeat] agentic-silence count failed: ${err.message}`);
    return null;
  }
}

/**
 * 2026-08-03 — GroupMe alert when the agentic pipeline has produced no
 * analyses while answerable replies arrived. Edge-triggered since 2026-09-04:
 * one card per outage plus a daily reminder while it is unresolved.
 *
 * Best-effort: a read failure or a send failure is logged, never thrown, and a
 * failed read NEVER alerts — "I couldn't tell" must not page, matching the
 * fail-open posture used throughout this subsystem. Since 2026-09-04 that rule
 * cuts both ways: it must not CLEAR either, or a quiet night would announce a
 * recovery nobody earned.
 */
async function maybeAlertAgenticSilence() {
  const counts = await getAgenticSilenceCounts();
  if (!counts) return { alerted: false, error: 'count_failed' };

  const { alert, reasons, critical, verdict } = shouldAlertAgenticSilence(counts, {
    minReplies: SILENCE_MIN_REPLIES,
  });
  lastSilenceCheck = { ...counts, alert, reasons, verdict };

  // 2026-09-04 — edge-triggered (src/alert-state.js). This alert fired 4x in
  // 90min on 2026-09-04 for one continuous outage.
  //
  // The verdict mapping is the important part. shouldAlertAgenticSilence
  // returns alert:false for TWO different reasons, and collapsing them would
  // be worse than the bug being fixed: 'healthy' means analyses actually ran,
  // but 'insufficient_evidence' only means the night was too quiet to
  // conclude. Clearing on the latter would announce "RECOVERED" on every
  // low-traffic night, telling an operator the bot is fine when nothing has
  // been proven at all. That maps to null — touch nothing.
  const active = verdict === 'alert' ? true : verdict === 'healthy' ? false : null;

  // Leads are being ghosted while this is open and it does NOT self-resolve —
  // the 2026-07-31 outage ran 47 hours — so unlike the live-ops keys this one
  // carries a daily re-reminder.
  const res = await reportAlertCondition({
    key: 'agentic:silence',
    active,
    label: 'agentic bot answering again',
    text: () => formatAgenticSilenceAlert(counts, reasons),
    detail: reasons.join('; '),
    remindMs: SILENCE_REMIND_MS,
    fallbackCooldownMs: SILENCE_ALERT_COOLDOWN_MS,
  });
  if (res.sent && active === true) {
    lastSilenceAlertAt = Date.now();
    console.error(`[DecisionEngineHeartbeat] AGENTIC SILENCE alert sent — ${reasons.join('; ')}`);
  }
  return { alerted: !!(res.sent && active === true), action: res.action, reasons, critical, counts };
}

/**
 * 2026-09-12 — read the fail-closed window.
 *
 * Returns null on a read failure, which maps to 'insufficient_evidence' and
 * touches nothing: "I could not tell" must neither page nor clear, the same
 * posture as getAgenticSilenceCounts.
 */
async function getFailClosedSummary() {
  if (!supabase) return null;
  const since = new Date(Date.now() - FAIL_CLOSED_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  try {
    const { data, error } = await supabase
      .from('system_events')
      .select('payload, ghl_contact_id')
      .eq('event_type', 'rule.condition_failed_closed')
      .gte('created_at', since)
      .limit(FAIL_CLOSED_SCAN_LIMIT);
    if (error) throw error;

    const rows = (Array.isArray(data) ? data : []).map(r => ({
      rule_key: r?.payload?.rule_key || null,
      detail: r?.payload?.detail || null,
      ghl_contact_id: r?.ghl_contact_id || null,
    }));
    return {
      ...summarizeFailClosed(rows, FAIL_CLOSED_WINDOW_HOURS),
      checked_at: new Date().toISOString(),
    };
  } catch (err) {
    console.warn(`[DecisionEngineHeartbeat] fail-closed summary failed: ${err.message}`);
    return null;
  }
}

/**
 * 2026-09-12 — GroupMe alert when rules are being suppressed on data the engine
 * could not read, or on conditions it cannot evaluate at all.
 *
 * Best-effort throughout: a read failure or a send failure is logged, never
 * thrown, and a failed read neither pages nor clears.
 */
async function maybeAlertFailClosed() {
  const summary = await getFailClosedSummary();
  const { alert, reasons, critical, verdict } = shouldAlertFailClosed(summary, {
    infraThreshold: FAIL_CLOSED_INFRA_THRESHOLD,
  });
  lastFailClosedCheck = summary ? { ...summary, alert, reasons, verdict } : { verdict, error: 'read_failed' };

  // Same three-way mapping as the silence watchdog: only a window we actually
  // read can clear the condition.
  const active = verdict === 'alert' ? true : verdict === 'healthy' ? false : null;

  const res = await reportAlertCondition({
    key: 'rules:fail_closed',
    // 2026-09-14 — operational alarm, so it rides the ops channel like the LP
    // report watchdog and the capacity sweep. That routes it to the dedicated
    // ops bot AND mirrors it to SLACK_CHANNEL_OPS (#ops-alerts) via
    // sendGroupMeMessage → mirrorToSlack, which is where this needs to land:
    // Reece is migrating off GroupMe. The mirror is fail-silent by design, so
    // a missing SLACK_MIRROR_ENABLED / SLACK_CHANNEL_OPS looks exactly like a
    // quiet night — worth one forced check after deploy rather than assuming.
    channel: 'ops',
    active,
    label: 'rule suppressions back to baseline',
    text: () => formatFailClosedAlert(summary, reasons),
    detail: reasons.join('; '),
    remindMs: FAIL_CLOSED_REMIND_MS,
    fallbackCooldownMs: FAIL_CLOSED_ALERT_COOLDOWN_MS,
  });
  if (res.sent && active === true) {
    console.error(`[DecisionEngineHeartbeat] RULE FAIL-CLOSED alert sent — ${reasons.join('; ')}`);
  }
  return { alerted: !!(res.sent && active === true), action: res.action, reasons, critical, summary };
}

/**
 * One heartbeat cycle. Checks staleness, fires processEvents if needed.
 * Returns the result for logging / route response.
 */
export async function runDecisionEngineHeartbeat({ force = false } = {}) {
  if (process.env.DECISION_ENGINE_HEARTBEAT_DISABLED === 'true') {
    return { skipped: true, reason: 'DECISION_ENGINE_HEARTBEAT_DISABLED=true' };
  }

  // 2026-08-03 — runs BEFORE the health/skip branch on purpose. A silent
  // pipeline has NO pending events (replies are consumed and marked processed),
  // so the heartbeat skips with 'no_pending_events' — exactly the state the
  // watchdog exists to catch. Gating the check on a firing heartbeat would
  // blind it precisely during the outage it is meant to page on.
  await maybeAlertAgenticSilence();

  // 2026-09-02 — per-contact reply SLA. Same placement reasoning as the
  // silence watchdog above: a stalled reply leaves NO pending event, so this
  // must run before the skip branch. Never throws into the heartbeat.
  lastReplySlaCheck = await runReplySlaWatchdog()
    .catch((err) => { console.warn(`[DecisionEngineHeartbeat] reply SLA watchdog threw (ignored): ${err.message}`); return { error: err.message }; });

  // 2026-09-12 — fail-closed watchdog. Same placement reasoning again: a
  // suppressed rule leaves no pending event (the source event is processed
  // normally, it just produces no action), so this has to run before the skip
  // branch or it would only look during a backlog.
  await maybeAlertFailClosed()
    .catch((err) => { console.warn(`[DecisionEngineHeartbeat] fail-closed watchdog threw (ignored): ${err.message}`); });

  const health = await checkEngineHealth();

  if (!force && !health.needs_run) {
    const ageSeconds = health.age_ms != null ? Math.round(health.age_ms / 1000) : null;
    const reason = !health.has_pending ? 'no_pending_events' : 'n8n_healthy';
    console.log(`[DecisionEngineHeartbeat] Skip — ${reason}${ageSeconds !== null ? ` (last processed_at ${ageSeconds}s ago)` : ''}`);
    return {
      skipped: true,
      reason,
      last_processed_at: health.last_processed_at,
      age_ms: health.age_ms,
      has_pending: health.has_pending,
      stale_threshold_ms: STALE_THRESHOLD_MS,
    };
  }

  const ageDescription = health.age_ms != null
    ? `${Math.round(health.age_ms / 1000)}s stale`
    : 'no prior processing';
  console.log(
    `[DecisionEngineHeartbeat] FAILOVER — firing processEvents (${ageDescription}, threshold ${STALE_THRESHOLD_MS}ms${force ? ', forced' : ''})`
  );

  const startedAt = Date.now();
  // Drain loop: processEvents handles up to DRAIN_BATCH_LIMIT per call. Loop
  // until the queue is empty (events_processed === 0) or MAX_DRAIN_ITERATIONS
  // is reached, so a burst larger than one batch clears in this single wake
  // rather than waiting HEARTBEAT_INTERVAL_MS per batch.
  let iterations = 0;
  let totalProcessed = 0;
  let totalActions = 0;
  let totalAiRouted = 0;
  let totalDeduped = 0;
  let lastResult = null;
  try {
    while (iterations < MAX_DRAIN_ITERATIONS) {
      const result = await processEvents({ limit: DRAIN_BATCH_LIMIT });
      lastResult = result;
      iterations += 1;
      const n = result?.events_processed || 0;
      totalProcessed += n;
      totalActions += result?.total_actions_created || 0;
      totalAiRouted += result?.ai_routed || 0;
      totalDeduped += result?.deduped || 0;
      if (n === 0) break; // queue drained
    }
  } catch (err) {
    console.error(`[DecisionEngineHeartbeat] processEvents threw after ${iterations} iteration(s): ${err.message}`);
    return {
      skipped: false,
      fired: true,
      forced: !!force,
      error: err.message,
      iterations,
      events_processed: totalProcessed,
      total_actions_created: totalActions,
      last_processed_at_before: health.last_processed_at,
      age_ms_before: health.age_ms,
      elapsed_ms: Date.now() - startedAt,
    };
  }

  const capHitWithBacklog =
    iterations >= MAX_DRAIN_ITERATIONS && (lastResult?.events_processed || 0) > 0;
  if (capHitWithBacklog) {
    console.warn(
      `[DecisionEngineHeartbeat] Drain cap hit (${MAX_DRAIN_ITERATIONS} batches) with events still pending — remaining will clear on the next tick`
    );
  }

  console.log(
    `[DecisionEngineHeartbeat] Done — ${totalProcessed} processed across ${iterations} batch(es) (${totalActions} actions, ${totalAiRouted} AI-routed, ${totalDeduped} deduped), ${Date.now() - startedAt}ms`
  );
  return {
    skipped: false,
    fired: true,
    forced: !!force,
    primary_mode: PRIMARY_MODE,
    iterations,
    drained_fully: !capHitWithBacklog,
    events_processed: totalProcessed,
    total_actions_created: totalActions,
    ai_routed: totalAiRouted,
    deduped: totalDeduped,
    last_processed_at_before: health.last_processed_at,
    age_ms_before: health.age_ms,
    engine_result: lastResult,
    elapsed_ms: Date.now() - startedAt,
  };
}

/**
 * Start the in-process heartbeat scheduler. Idempotent — calling twice
 * is a no-op.
 */
export function startDecisionEngineHeartbeatScheduler() {
  if (intervalHandle) return;
  if (process.env.DECISION_ENGINE_HEARTBEAT_DISABLED === 'true') {
    console.log('[DecisionEngineHeartbeat] Disabled via DECISION_ENGINE_HEARTBEAT_DISABLED=true — scheduler not armed');
    return;
  }

  // Reentrancy-guarded tick. If a previous drain is still in flight (burst
  // larger than one cycle, or slow GHL), skip this tick instead of running a
  // second drain in parallel. The manual /heartbeat-de route intentionally
  // bypasses this guard; processEvents idempotency keeps that safe.
  const tick = async (label) => {
    if (isRunning) {
      console.log(`[DecisionEngineHeartbeat] ${label} skipped — previous cycle still running`);
      return;
    }
    isRunning = true;
    try {
      await runDecisionEngineHeartbeat();
    } catch (err) {
      console.error(`[DecisionEngineHeartbeat] ${label} failed:`, err.message);
    } finally {
      isRunning = false;
    }
  };

  setTimeout(() => {
    tick('Initial run');
    intervalHandle = setInterval(() => tick('Scheduled run'), HEARTBEAT_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);

  console.log(
    `[DecisionEngineHeartbeat] Scheduler armed (${PRIMARY_MODE ? 'PRIMARY' : 'FAILOVER'} mode): ` +
    `interval=${HEARTBEAT_INTERVAL_MS}ms, first_run_delay=${FIRST_RUN_DELAY_MS}ms, ` +
    `drain_batch=${DRAIN_BATCH_LIMIT}, max_drain_iterations=${MAX_DRAIN_ITERATIONS}` +
    `${PRIMARY_MODE ? '' : `, stale_threshold=${STALE_THRESHOLD_MS}ms`}`
  );
}

/**
 * Express routes:
 *   POST /n8n/decision-engine/heartbeat-de
 *     Manually trigger a heartbeat check. Body: { force?: boolean }.
 *     If force=true, bypasses the staleness gate and fires processEvents.
 *
 *   GET /n8n/decision-engine/heartbeat-de-status
 *     Returns the current health state without firing the engine.
 */
export function registerDecisionEngineHeartbeatRoutes(app) {
  app.post('/n8n/decision-engine/heartbeat-de', async (req, res) => {
    try {
      const force = req.body?.force === true;
      const result = await runDecisionEngineHeartbeat({ force });
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[DecisionEngineHeartbeat] /heartbeat-de error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/n8n/decision-engine/heartbeat-de-status', async (req, res) => {
    try {
      const health = await checkEngineHealth();
      res.json({
        success: true,
        ...health,
        stale_threshold_ms: STALE_THRESHOLD_MS,
        heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
        disabled: process.env.DECISION_ENGINE_HEARTBEAT_DISABLED === 'true',
        // 2026-08-03 — agentic-silence watchdog. `last_check` is null until the
        // first heartbeat cycle runs; ?refresh=1 computes it on demand.
        agentic_silence: {
          window_hours: SILENCE_WINDOW_HOURS,
          min_replies: SILENCE_MIN_REPLIES,
          alert_cooldown_ms: SILENCE_ALERT_COOLDOWN_MS,
          last_alert_at: lastSilenceAlertAt || null,
          last_check: req.query?.refresh ? await getAgenticSilenceCounts() : lastSilenceCheck,
        },
        // 2026-09-02 — per-contact reply SLA. ?refresh=1 runs a pass on demand.
        reply_sla: req.query?.refresh ? await runReplySlaWatchdog() : lastReplySlaCheck,
        // 2026-09-12 — fail-closed watchdog. Same ?refresh=1 contract, so the
        // current suppression picture is one curl away instead of a SQL trip.
        rule_fail_closed: {
          window_hours: FAIL_CLOSED_WINDOW_HOURS,
          infra_threshold: FAIL_CLOSED_INFRA_THRESHOLD,
          last_check: req.query?.refresh ? await getFailClosedSummary() : lastFailClosedCheck,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}
