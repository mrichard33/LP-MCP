/**
 * Drift Detector — src/services/drift-detector.js
 *
 * After-the-fact detection for the class of failures we cannot prevent at
 * send-time (notably GHL native workflow sends, which bypass the agentic
 * executor). Periodically asks HL MCP for contacts that look closed in
 * GHL (e.g., carrying stage:long-term-nurture for >24h) and joins them
 * against lp_leads to find any whose LP disposition is still active.
 *
 * On mismatch, emits system.drift_detected — an agent_rule routes that to
 * GroupMe for human reconciliation. Never auto-overwrites LP disposition.
 *
 * Cron: 30-min interval, kicks 5 min after boot. Killable via
 *   DRIFT_DETECTOR_DISABLED=true.
 *
 * 2026-05-11 — EMISSION-LEVEL COOLDOWN.
 *   PROBLEM: idempotency_key used a YYYY-MM-DD bucket, so every new
 *   calendar day let the same drifted contact emit a fresh event. With a
 *   30-min scan loop and contacts staying drifted for days, GroupMe was
 *   seeing the same drift notification 6+ times per contact in a week.
 *
 *   FIX: before emitEvent, query system_events for any drift event for
 *   the same ghl_contact_id within DRIFT_NOTIFY_COOLDOWN_HOURS (default
 *   72h). Skip emission entirely when found. The matching agent_rule
 *   (DRIFT_NOTIFY_GROUPME) also carries cooldown_minutes=4320 in its
 *   action_template params as belt-and-suspenders — the notifications
 *   handler will skip the GroupMe send too if anything slips past here.
 *
 *   The daily YYYY-MM-DD idempotency key is preserved so a single cron
 *   tick that retries doesn't double-fire within the same day. The new
 *   72h cooldown layers on top of that.
 *
 *   Tuning: set DRIFT_NOTIFY_COOLDOWN_HOURS=0 to disable the cooldown
 *   (back to daily emission). Set to any positive number of hours
 *   otherwise.
 */

import supabase from '../supabase.js';
import { emitEvent } from '../event-emitter.js';

const ACTIVE_LP_DISPOSITIONS = ['Issued', 'Set', 'Cnf', 'Data', 'NOC', 'OPPFDN', '1Leg', 'BO'];
const DRIFT_THRESHOLD_HOURS = 24;
const SCAN_INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_CLOSURE_TAG = 'stage:long-term-nurture';
const COOLDOWN_HOURS = Number(process.env.DRIFT_NOTIFY_COOLDOWN_HOURS ?? 72);

async function fetchDriftCandidates(closureTag, closedForHours) {
  const HL_URL = process.env.HL_MCP_URL;
  const HL_TOKEN = process.env.HL_INTERNAL_TOKEN || process.env.HL_MCP_TOKEN;
  if (!HL_URL) {
    console.warn('[drift-detector] HL_MCP_URL not set — skipping scan');
    return { contacts: [] };
  }
  try {
    const res = await fetch(`${HL_URL.replace(/\/$/, '')}/internal/get-drift-candidates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(HL_TOKEN ? { 'Authorization': `Bearer ${HL_TOKEN}` } : {}),
      },
      body: JSON.stringify({ closure_tag: closureTag, closed_for_hours: closedForHours }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.warn(`[drift-detector] HL MCP get_drift_candidates failed: ${res.status}`);
      return { contacts: [] };
    }
    return await res.json();
  } catch (err) {
    console.error(`[drift-detector] HL MCP fetch error: ${err.message}`);
    return { contacts: [] };
  }
}

async function getLpDisposition(lp_prospect_id) {
  if (!supabase || !lp_prospect_id) return null;
  const { data } = await supabase
    .from('lp_leads')
    .select('lp_lead_id, disposition_code, synced_at')
    .eq('lp_prospect_id', String(lp_prospect_id))
    .order('synced_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

/**
 * 2026-05-11 — check whether a drift event has been emitted for this
 * contact within the cooldown window. Returns true if we should SKIP
 * emission (recent event exists), false if we should proceed.
 *
 * Returns false when COOLDOWN_HOURS is 0 (cooldown disabled).
 */
async function isWithinCooldown(ghlContactId) {
  if (!supabase || !ghlContactId || COOLDOWN_HOURS <= 0) return false;
  try {
    const since = new Date(Date.now() - COOLDOWN_HOURS * 3600 * 1000).toISOString();
    const { data, error } = await supabase
      .from('system_events')
      .select('id, created_at')
      .eq('event_type', 'system.drift_detected')
      .eq('ghl_contact_id', ghlContactId)
      .gte('created_at', since)
      .order('id', { ascending: false })
      .limit(1);
    if (error) {
      console.warn(`[drift-detector] cooldown lookup failed for ${ghlContactId}: ${error.message}`);
      return false; // fail-open: emit on lookup error rather than silently drop
    }
    return Array.isArray(data) && data.length > 0;
  } catch (err) {
    console.warn(`[drift-detector] cooldown lookup error for ${ghlContactId}: ${err.message}`);
    return false; // fail-open
  }
}

export async function runDriftScan({
  closure_tag = DEFAULT_CLOSURE_TAG,
  closed_for_hours = DRIFT_THRESHOLD_HOURS,
} = {}) {
  const startedAt = Date.now();
  const result = await fetchDriftCandidates(closure_tag, closed_for_hours);
  const candidates = result.contacts || [];
  let driftCount = 0;
  let cooldownSkipped = 0;
  const driftDetails = [];

  for (const c of candidates) {
    const lp = await getLpDisposition(c.lp_prospect_id);
    if (!lp) continue;
    if (ACTIVE_LP_DISPOSITIONS.includes(lp.disposition_code)) {
      // 2026-05-11 — cooldown guard. Skip if we already notified for this
      // contact within the last DRIFT_NOTIFY_COOLDOWN_HOURS.
      if (await isWithinCooldown(c.contact_id)) {
        cooldownSkipped++;
        continue;
      }

      const todayKey = new Date().toISOString().slice(0, 10);
      await emitEvent({
        event_type: 'system.drift_detected',
        source: 'drift_detector',
        entity_type: 'contact',
        entity_id: c.contact_id,
        ghl_contact_id: c.contact_id,
        lp_lead_id: lp.lp_lead_id,
        lp_prospect_id: c.lp_prospect_id,
        priority: 'high',
        payload: {
          drift_type: 'ghl_closed_lp_active',
          closure_tag,
          ghl_closed_at: c.closed_at,
          lp_disposition: lp.disposition_code,
          lp_disposition_synced_at: lp.synced_at,
        },
        idempotency_key: `drift:${c.contact_id}:${todayKey}`,
      });
      driftDetails.push({
        contact_id: c.contact_id,
        lp_disposition: lp.disposition_code,
      });
      driftCount++;
    }
  }

  const elapsed = Date.now() - startedAt;
  console.log(`[drift-detector] scan complete: drift=${driftCount}/${candidates.length} cooldown_skipped=${cooldownSkipped} (${elapsed}ms)`);
  return {
    success: true,
    scanned: candidates.length,
    drift: driftCount,
    cooldown_skipped: cooldownSkipped,
    cooldown_hours: COOLDOWN_HOURS,
    drift_details: driftDetails,
    elapsed_ms: elapsed,
    closure_tag,
    closed_for_hours,
  };
}

export function startDriftDetectorScheduler() {
  if (process.env.DRIFT_DETECTOR_DISABLED === 'true') {
    console.log('[drift-detector] scheduler disabled via DRIFT_DETECTOR_DISABLED');
    return;
  }
  setTimeout(() => {
    runDriftScan().catch(e => console.error(`[drift-detector] scan error: ${e.message}`));
    setInterval(() => {
      runDriftScan().catch(e => console.error(`[drift-detector] scan error: ${e.message}`));
    }, SCAN_INTERVAL_MS);
  }, INITIAL_DELAY_MS);
  console.log(`[drift-detector] scheduler started (initial: ${INITIAL_DELAY_MS / 60000}min, interval: ${SCAN_INTERVAL_MS / 60000}min, cooldown: ${COOLDOWN_HOURS}h)`);
}

export function registerDriftDetectorRoutes(app) {
  app.post('/n8n/drift-detector/scan', async (req, res) => {
    try {
      const out = await runDriftScan(req.body || {});
      res.json(out);
    } catch (err) {
      console.error('[drift-detector] /scan error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });
}
