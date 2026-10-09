/**
 * Pause-Workflow Fizzle Sweep — src/pause-workflow-sweep.js
 *
 * 2026-10-08: rewritten; see the block below the imports. The history that
 * follows describes the original 7-day design.
 *
 * Implements the framework's "Pause current drip workflow" primitive
 * (Board A: HOT1 / MOMENTUM ACT-5 / Trust Spike Collapse Handler).
 *
 * The agentic system applies `pause-workflow` tag to a contact when
 * momentum is detected — see rules BEHAVIORAL_FAST_TRACK,
 * INTENT_SPIKE_HOT_WINDOW, AGENTIC_RESPOND_POST_CHATBOT. GHL drip
 * workflows (W0.x bridges, W1.x indoctrination, W4.5 Seinfeld, W11.x
 * reactivation) have Wait For Condition gates checking "Doesn't Have
 * Tag: pause-workflow", so the tag pauses the contact in-place at
 * their current step in any active drip — no re-routing required.
 *
 * RELEASE PATHS:
 *   1. Booking captured → GHL_APPT_STAGE_ADVANCE rule removes tag
 *   2. Manual GHL UI tag removal → operator escape hatch
 *   3. THIS SWEEP — fizzle release at 7 days of customer silence
 *
 * The sweep is the safety net: if the agentic capture fizzles (no
 * conversion, customer stops replying), we release the pause so the
 * drip resumes from where it left off. The contact picks up at their
 * exact position in W11.2 (or wherever) — no orphaning, no re-route.
 *
 * FIZZLE LOGIC:
 *   - Find recent successful add_tag actions for `pause-workflow`
 *   - For each contact: get T_pause = most recent pause-add timestamp
 *   - Get T_inbound = last_reply_at from lead_intelligence (customer's
 *     last inbound message — the right metric for "is the conversation
 *     alive?")
 *   - effective_active_at = max(T_pause, T_inbound)
 *     - If they've replied since the pause was set, the conversation
 *       is alive → use the reply time as the active timestamp
 *     - If no reply since pause, use the pause time
 *   - If now() - effective_active_at >= 7 days → fizzle
 *
 * SAFETY:
 *   - Verifies tag still present in GHL before removing (other release
 *     paths may have already cleared it)
 *   - Only acts on contacts whose pause-add event we can timestamp
 *   - Logs every fizzle as a system event for audit
 *   - 30-day lookback bound on agent_actions query to keep it fast
 */

import supabase from './supabase.js';
import { emitEvent } from './event-emitter.js';
// Co-registered from here rather than from index.js: the suppress-automation
// backfill is the same primitive as this sweep — release an orphaned
// suppression tag that no other path will ever clear — and keeping the two
// wired through one call site avoids a second edit to the 2,000-line
// index.js route block. See src/jobs/suppress-automation-backfill.js.
import { registerSuppressAutomationBackfillRoutes } from './jobs/suppress-automation-backfill.js';
import { runJob } from './job-runner.js';
import { PAUSE_TAG, conversationPauseMode, quietMs, shouldPause, releaseDecision } from './agentic/conversation-pause.js';
import { readPausedContacts, readActivity, readRecentOutbound, readSnapshotTags, queuePause, RELEASE_RULE } from './services/conversation-pause-io.js';

// ═══════════════════════════════════════════════════════════════════
// 2026-10-08 — rewritten (the user: pause drips while a conversation is live,
// resume after 24 quiet hours). The rules live in src/agentic/conversation-pause.js
// and the reads in src/services/conversation-pause-io.js. The old pass read
// "every add_tag in 30 days" in ONE query; PostgREST returned the newest 1,000
// rows (a few hours of tags), so it never saw a pause old enough to release —
// zero agentic.pause_fizzle events ever, 425 contacts parked on 2026-10-08.
// Now every pass:
//   1. pauses any contact a non-workflow text went out to since the last pass
//      (HL-MCP's contact.outbound_message: a rep or the bot typing to the lead);
//   2. reads every contact carrying the tag (the tag snapshot) and releases the
//      ones we paused that have been quiet 24 hours, or paused 28 days (before
//      GHL's 30-day gate timeout exits them). Never a blocked contact, never a
//      pause a GHL workflow set itself.
// CONVERSATION_PAUSE_MODE off|shadow|live (default shadow): shadow pauses and
// releases nothing and reports what it would do (the user, 2026-10-08: the
// stuck contacts get a dry-run report first).
// ═══════════════════════════════════════════════════════════════════

export const JOB_ID = 'pause-workflow-sweep';
const MAX_RELEASES_PER_PASS = 40;
const OUTBOUND_LOOKBACK_MS = 15 * 60 * 1000;
// Outbound watermark: where the last pass stopped reading. A dry run never
// moves it, so a manual report cannot make the scheduled pass skip texts.
const sweepState = { lastOutboundSeenIso: null };

async function defaultDeps() {
  const [{ ghlFetch }, { executeRemoveTag }] = await Promise.all([
    import('./actions/helpers.js'),
    import('./actions/handlers/tags.js'),
  ]);
  return { supabase, ghlFetch, executeRemoveTag, emitEvent, state: sweepState, now: () => Date.now(), env: process.env, log: console.log, warn: console.warn };
}

/**
 * Pause the drips because a conversation is live (an inbound text, or a
 * non-workflow outbound). Never throws. `tags` may be the contact's current
 * tags when the caller already has them; otherwise the snapshot is read.
 */
export async function pauseForConversation({ contactId, tags = null, why = 'conversation' }, deps = {}) {
  const d = { ...(await defaultDeps().catch(() => ({ supabase, env: process.env, log: console.log, warn: console.warn }))), ...deps };
  try {
    const mode = conversationPauseMode(d.env);
    if (!contactId || mode === 'off') return { paused: false, reason: mode === 'off' ? 'off' : 'no_contact' };
    let current = Array.isArray(tags) ? tags : null;
    if (!current) current = (await readSnapshotTags([contactId], { supabase: d.supabase })).get(contactId) || [];
    const decision = shouldPause({ tags: current });
    if (!decision.pause) return { paused: false, reason: decision.reason };
    if (mode !== 'live') {
      d.log(`[ConversationPause] shadow: would pause drips for ${contactId} (${why})`);
      return { paused: false, reason: 'shadow' };
    }
    await queuePause(contactId, why, { supabase: d.supabase });
    d.log(`[ConversationPause] pausing drips for ${contactId} (${why})`);
    return { paused: true, reason: why };
  } catch (err) {
    (d.warn || console.warn)(`[ConversationPause] pause failed for ${contactId} (fail-soft): ${err.message}`);
    return { paused: false, reason: 'error' };
  }
}

/**
 * One pass. dryRun reports what live would do and changes nothing, whatever
 * the mode. Returns a summary for job_runs and the manual route.
 */
export async function runPauseWorkflowSweep({ dryRun = false } = {}, deps = {}) {
  const d = { ...(await defaultDeps()), ...deps };
  const mode = conversationPauseMode(d.env);
  if (mode === 'off' && !dryRun) return { ok: true, skipped: true, mode };
  const act = mode === 'live' && !dryRun;
  const nowMs = d.now();
  const quiet = quietMs(d.env);
  const summary = { ok: true, mode, dry_run: !!dryRun, paused: 0, would_pause: 0, checked: 0, released: 0, would_release: 0, release_errors: 0, by_reason: {}, releases: [] };

  // 1. A conversational text went out since the last pass → pause.
  const sinceIso = d.state.lastOutboundSeenIso || new Date(nowMs - OUTBOUND_LOOKBACK_MS).toISOString();
  const outbound = await readRecentOutbound(sinceIso, { supabase: d.supabase });
  if (outbound.length && !dryRun) d.state.lastOutboundSeenIso = outbound[outbound.length - 1].at;
  const outIds = [...new Set(outbound.map(o => o.contactId))];
  const outTags = await readSnapshotTags(outIds, { supabase: d.supabase });
  for (const id of outIds) {
    if (!shouldPause({ tags: outTags.get(id) || [] }).pause) continue;
    if (!act) { summary.would_pause += 1; continue; }
    try { await queuePause(id, 'outbound_text', { supabase: d.supabase }); summary.paused += 1; } catch (err) { d.warn(`[ConversationPause] queue failed for ${id}: ${err.message}`); }
  }

  // 2. Release the quiet ones.
  const pausedContacts = await readPausedContacts({ supabase: d.supabase });
  summary.checked = pausedContacts.length;
  const activity = await readActivity(pausedContacts.map(c => c.id), { supabase: d.supabase, nowMs });
  for (const c of pausedContacts) {
    const a = activity.get(c.id) || {};
    const decision = releaseDecision({ tags: c.tags, ...a, nowMs, quiet });
    summary.by_reason[decision.reason] = (summary.by_reason[decision.reason] || 0) + 1;
    if (!decision.release) continue;
    if (!act) {
      summary.would_release += 1;
      if (summary.releases.length < 500) summary.releases.push({ contactId: c.id, reason: decision.reason, paused_at: a.pausedAtMs ? new Date(a.pausedAtMs).toISOString() : null, last_activity_at: a.lastActivityMs ? new Date(a.lastActivityMs).toISOString() : null });
      continue;
    }
    if (summary.released >= MAX_RELEASES_PER_PASS) continue;
    try {
      // Live tags before a write: the snapshot can lag GHL.
      const live = await d.ghlFetch('GET', `/contacts/${c.id}`);
      const liveTags = live?.contact?.tags || null;
      if (!liveTags) { summary.release_errors += 1; continue; }
      const recheck = releaseDecision({ tags: liveTags, ...a, nowMs, quiet });
      if (!recheck.release) continue;
      await d.executeRemoveTag({ target_id: c.id, action_payload: { tag: PAUSE_TAG }, rule_applied: RELEASE_RULE }, {});
      summary.released += 1;
      summary.releases.push({ contactId: c.id, reason: recheck.reason });
      await d.emitEvent({
        event_type: 'agentic.pause_fizzle', event_subtype: 'released', source: 'pause_workflow_sweep',
        entity_type: 'contact', entity_id: c.id, ghl_contact_id: c.id, priority: 'low',
        payload: { reason: recheck.reason, paused_at: a.pausedAtMs ? new Date(a.pausedAtMs).toISOString() : null, last_activity_at: a.lastActivityMs ? new Date(a.lastActivityMs).toISOString() : null, quiet_hours: quiet / 3600000 },
        idempotency_key: `pause_fizzle_${c.id}_${Math.floor(nowMs / 3600000)}`,
      }).catch(() => {});
    } catch (err) {
      summary.release_errors += 1;
      d.warn(`[ConversationPause] release failed for ${c.id}: ${err.message}`);
    }
  }
  if (!act) summary.releases = dryRun ? summary.releases : summary.releases.slice(0, 50);
  d.log(`[ConversationPause] ${mode}${dryRun ? ' (dry run)' : ''}: ${summary.checked} paused contacts, ${act ? summary.released : summary.would_release} ${act ? 'released' : 'would release'}, ${act ? summary.paused : summary.would_pause} ${act ? 'paused' : 'would pause'} on outbound; ${JSON.stringify(summary.by_reason)}`);
  return summary;
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS ROUTES + INTERVAL
// ═══════════════════════════════════════════════════════════════════

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let intervalHandle = null;
let running = false;

export function startPauseWorkflowSweepScheduler() {
  if (intervalHandle) return;
  if (conversationPauseMode() === 'off') {
    console.log('[PauseSweep] scheduler not started (CONVERSATION_PAUSE_MODE=off)');
    return;
  }
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runJob(JOB_ID, () => runPauseWorkflowSweep());
    } catch (err) {
      console.error('[PauseSweep] Scheduled run failed:', err.message);
    } finally {
      running = false;
    }
  };
  // First run after 2 minutes — gives the server time to settle on boot.
  setTimeout(() => {
    tick();
    intervalHandle = setInterval(tick, SWEEP_INTERVAL_MS);
  }, 120000);
  console.log(`[PauseSweep] Scheduler armed: ${conversationPauseMode()}, ${quietMs() / 3600000}h quiet window, every ${SWEEP_INTERVAL_MS / 60000} min`);
}

export function registerPauseWorkflowSweepRoutes(app) {
  app.post('/n8n/pause-workflow/sweep', async (req, res) => {
    try {
      const dryRun = req.body?.dryRun === true || req.query?.dryRun === 'true';
      const result = await runPauseWorkflowSweep({ dryRun });
      res.json(result);
    } catch (err) {
      console.error('[PauseSweep] /sweep error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /n8n/suppress-automation/backfill — drains the orphaned
  // suppress-automation backlog left by AUTOMATION_SUPPRESS_ON_BOOKING
  // (disabled 2026-08-25). Dry-run by default; see the module header.
  registerSuppressAutomationBackfillRoutes(app);
}
