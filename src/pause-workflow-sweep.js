/**
 * Pause-Workflow Fizzle Sweep — src/pause-workflow-sweep.js
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

const FIZZLE_DAYS = 7;
const FIZZLE_MS = FIZZLE_DAYS * 86400000;
const PAUSE_LOOKBACK_DAYS = 30;
const GHL_API_KEY = process.env.GHL_API_KEY;

/**
 * Fetch a contact's current tags from GHL.
 * Returns null on lookup failure (sweep treats null as "skip").
 */
async function fetchContactTags(contactId) {
  if (!GHL_API_KEY || !contactId) return null;
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.warn(`[PauseSweep] GHL contact lookup failed for ${contactId}: ${res.status}`);
      return null;
    }
    const data = await res.json();
    return data?.contact?.tags || [];
  } catch (err) {
    console.warn(`[PauseSweep] GHL contact lookup error for ${contactId}: ${err.message}`);
    return null;
  }
}

/**
 * Remove a tag from a GHL contact via the dedicated tag-removal endpoint.
 * Subtractive — only removes the listed tag, leaves all others intact.
 */
async function removeContactTag(contactId, tag) {
  if (!GHL_API_KEY || !contactId) return false;
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ tags: [tag] }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[PauseSweep] Tag removal failed for ${contactId}: ${res.status} ${body}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[PauseSweep] Tag removal error for ${contactId}: ${err.message}`);
    return false;
  }
}

/**
 * Get the most recent successful pause-workflow add_tag action per contact
 * within the lookback window. Returns Map<contactId, timestamp>.
 */
async function findRecentPauses() {
  const lookbackStart = new Date(Date.now() - PAUSE_LOOKBACK_DAYS * 86400000).toISOString();

  const { data, error } = await supabase
    .from('agent_actions')
    .select('target_id, executed_at, action_payload, status')
    .eq('action_type', 'add_tag')
    .eq('target_system', 'ghl')
    .eq('status', 'completed')
    .gte('executed_at', lookbackStart)
    .order('executed_at', { ascending: false });

  if (error) {
    console.error(`[PauseSweep] agent_actions query failed:`, error.message);
    return new Map();
  }

  // Group by target_id, keep the most recent pause-workflow action per contact.
  // Filter on payload at the JS level — Supabase JSONB filters via the API are
  // brittle and the action volume here (agent_actions in 30 days) is small
  // enough that an in-memory filter is safer.
  const byContact = new Map();
  for (const row of data || []) {
    const tag = row.action_payload?.tag;
    if (tag !== 'pause-workflow') continue;
    if (!row.target_id || !row.executed_at) continue;
    if (!byContact.has(row.target_id)) {
      // First entry for this contact = most recent (query is DESC by executed_at)
      byContact.set(row.target_id, row.executed_at);
    }
  }
  return byContact;
}

/**
 * Look up last_reply_at for a contact from lead_intelligence.
 * Returns ISO string or null.
 */
async function fetchLastReplyAt(contactId) {
  const { data, error } = await supabase
    .from('lead_intelligence')
    .select('last_reply_at')
    .eq('ghl_contact_id', contactId)
    .maybeSingle();
  if (error) {
    console.warn(`[PauseSweep] lead_intelligence fetch failed for ${contactId}: ${error.message}`);
    return null;
  }
  return data?.last_reply_at || null;
}

/**
 * Run the sweep. For each contact with a pause-workflow add in the lookback
 * window, decide whether to fizzle-release.
 */
export async function runPauseWorkflowSweep({ dryRun = false } = {}) {
  const startTime = Date.now();
  const pauses = await findRecentPauses();

  if (pauses.size === 0) {
    return {
      success: true,
      checked: 0,
      released: 0,
      skipped: 0,
      dry_run: !!dryRun,
      elapsed_ms: Date.now() - startTime,
    };
  }

  let released = 0;
  let skipped_already_released = 0;
  let skipped_still_active = 0;
  let skipped_lookup_failed = 0;
  let errors = 0;
  const releases = [];

  for (const [contactId, pauseAtIso] of pauses.entries()) {
    try {
      // Verify tag is still present in GHL — other release paths (booking,
      // manual UI removal) may have already cleared it.
      const tags = await fetchContactTags(contactId);
      if (tags === null) { skipped_lookup_failed++; continue; }
      if (!tags.includes('pause-workflow')) {
        skipped_already_released++;
        continue;
      }

      // Compute effective active timestamp: most recent of pause time and
      // the customer's last inbound reply. If the customer is actively
      // replying (post-pause), the conversation is alive — don't fizzle.
      const lastReplyIso = await fetchLastReplyAt(contactId);
      const pauseMs = Date.parse(pauseAtIso) || 0;
      const replyMs = lastReplyIso ? Date.parse(lastReplyIso) : 0;
      const effectiveActiveMs = Math.max(pauseMs, replyMs || 0);
      const ageMs = Date.now() - effectiveActiveMs;

      if (ageMs < FIZZLE_MS) {
        skipped_still_active++;
        continue;
      }

      // Fizzle: remove the tag, log it.
      const ageDays = Math.round(ageMs / 86400000 * 10) / 10;
      const reason = replyMs > pauseMs
        ? `silent ${ageDays}d since last reply`
        : `silent ${ageDays}d since pause set (no replies)`;

      if (dryRun) {
        console.log(`[PauseSweep] DRY RUN would release ${contactId} (${reason})`);
        releases.push({ contactId, reason, ageDays });
        released++;
        continue;
      }

      const ok = await removeContactTag(contactId, 'pause-workflow');
      if (!ok) { errors++; continue; }

      // Emit a system event so this is auditable in the event history
      // alongside the original pause-add. Routes through normal emitEvent
      // path for idempotency + processed-tracking.
      await emitEvent({
        event_type: 'agentic.pause_fizzle',
        event_subtype: 'released',
        source: 'pause_workflow_sweep',
        entity_type: 'contact',
        entity_id: contactId,
        ghl_contact_id: contactId,
        payload: {
          reason,
          age_days: ageDays,
          pause_set_at: pauseAtIso,
          last_reply_at: lastReplyIso,
          fizzle_threshold_days: FIZZLE_DAYS,
        },
        priority: 'low',
        idempotency_key: `pause_fizzle_${contactId}_${Math.floor(Date.now() / 3600000)}`,
      });

      console.log(`[PauseSweep] Released pause-workflow on ${contactId} — ${reason}`);
      releases.push({ contactId, reason, ageDays });
      released++;
    } catch (err) {
      console.error(`[PauseSweep] Error processing ${contactId}: ${err.message}`);
      errors++;
    }
  }

  const elapsed_ms = Date.now() - startTime;
  const summary = {
    success: true,
    checked: pauses.size,
    released,
    skipped_already_released,
    skipped_still_active,
    skipped_lookup_failed,
    errors,
    dry_run: !!dryRun,
    elapsed_ms,
    releases: dryRun ? releases : undefined,
  };

  console.log(`[PauseSweep] Done: ${pauses.size} checked → ${released} released, ${skipped_already_released} already-released, ${skipped_still_active} still-active, ${skipped_lookup_failed} lookup-failed, ${errors} errors (${elapsed_ms}ms)`);

  return summary;
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS ROUTES + INTERVAL
// ═══════════════════════════════════════════════════════════════════

const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes — matches field sync cadence
let intervalHandle = null;

/**
 * Start the in-process sweep interval. Runs every 15 minutes as a safety
 * net independent of n8n. The 7-day fizzle threshold means a 15-min
 * cadence is fine — no need for tighter scheduling.
 */
export function startPauseWorkflowSweepScheduler() {
  if (intervalHandle) return;
  // First run after 2 minutes — gives the server time to settle on boot.
  setTimeout(() => {
    runPauseWorkflowSweep().catch(err => {
      console.error('[PauseSweep] Scheduled run failed:', err.message);
    });
    intervalHandle = setInterval(() => {
      runPauseWorkflowSweep().catch(err => {
        console.error('[PauseSweep] Scheduled run failed:', err.message);
      });
    }, SWEEP_INTERVAL_MS);
  }, 120000);
  console.log(`[PauseSweep] Scheduler armed: 7-day fizzle threshold, ${SWEEP_INTERVAL_MS / 60000}min cadence`);
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
}
