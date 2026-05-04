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
 */

import supabase from '../supabase.js';
import { emitEvent } from '../event-emitter.js';

const ACTIVE_LP_DISPOSITIONS = ['Issued', 'Set', 'Cnf', 'Data', 'NOC', 'OPPFDN', '1Leg', 'BO'];
const DRIFT_THRESHOLD_HOURS = 24;
const SCAN_INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_CLOSURE_TAG = 'stage:long-term-nurture';

async function fetchDriftCandidates(closureTag, closedForHours) {
  const HL_URL = process.env.HL_MCP_URL;
  const HL_TOKEN = process.env.HL_MCP_TOKEN;
  if (!HL_URL) {
    console.warn('[drift-detector] HL_MCP_URL not set — skipping scan');
    return { contacts: [] };
  }
  try {
    const res = await fetch(`${HL_URL.replace(/\/$/, '')}/tools/get_drift_candidates`, {
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

export async function runDriftScan({
  closure_tag = DEFAULT_CLOSURE_TAG,
  closed_for_hours = DRIFT_THRESHOLD_HOURS,
} = {}) {
  const startedAt = Date.now();
  const result = await fetchDriftCandidates(closure_tag, closed_for_hours);
  const candidates = result.contacts || [];
  let driftCount = 0;
  const driftDetails = [];

  for (const c of candidates) {
    const lp = await getLpDisposition(c.lp_prospect_id);
    if (!lp) continue;
    if (ACTIVE_LP_DISPOSITIONS.includes(lp.disposition_code)) {
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
  console.log(`[drift-detector] scan complete: drift=${driftCount}/${candidates.length} (${elapsed}ms)`);
  return {
    success: true,
    scanned: candidates.length,
    drift: driftCount,
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
  console.log(`[drift-detector] scheduler started (initial: ${INITIAL_DELAY_MS / 60000}min, interval: ${SCAN_INTERVAL_MS / 60000}min)`);
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
