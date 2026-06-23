/**
 * Drift Detector — src/services/drift-detector.js
 *
 * After-the-fact detection for the class of failures we cannot prevent at
 * send-time (notably GHL native workflow sends, which bypass the agentic
 * executor). Periodically asks HL MCP for contacts that look closed in
 * GHL (e.g., carrying stage:long-term-nurture for >24h) and joins them
 * against lp_leads to find any whose LP disposition is still active.
 *
 * On mismatch, emits ONE system.drift_batch_detected event per scan
 * carrying all drifted contacts. An agent_rule routes that to GroupMe
 * as a single summary notification. Never auto-overwrites LP.
 *
 * Cron: 30-min interval, kicks 5 min after boot. Killable via
 *   DRIFT_DETECTOR_DISABLED=true.
 *
 * 2026-05-13 — BATCH EMISSION.
 *   PRIOR BEHAVIOR: emitted one system.drift_detected event per drifted
 *   contact, with a 72h per-contact cooldown to avoid GroupMe flooding.
 *   On May 13 a backlog drain caused 23 contacts to drift simultaneously,
 *   producing 23 GroupMe notifications back-to-back.
 *
 *   NEW: emit a single system.drift_batch_detected event at the end of
 *   the scan, payload carrying the full list of drifted contacts and
 *   per-disposition counts. The matching agent_rule formats a summary
 *   notification. One alert per scan, regardless of drift count.
 *
 *   The per-contact cooldown is no longer needed — the scan itself is
 *   throttled to 30 min, and a scan with zero drift emits nothing.
 *
 *   Empty-scan suppression: if drift count is 0, no event is emitted.
 *
 *   Idempotency: keyed on the scan timestamp (minute granularity) so a
 *   retried scan in the same minute doesn't double-emit.
 */

import supabase from '../supabase.js';
import { emitEvent } from '../event-emitter.js';

const ACTIVE_LP_DISPOSITIONS = ['Issued', 'Set', 'Cnf', 'Data', 'NOC', 'OPPFDN', '1Leg', 'BO'];
const DRIFT_THRESHOLD_HOURS = 24;
const SCAN_INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_CLOSURE_TAG = 'stage:long-term-nurture';

async function fetchDriftCandidates(closureTag, closedForHours, limit) {
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
      body: JSON.stringify({
        closure_tag: closureTag,
        closed_for_hours: closedForHours,
        ...(limit ? { limit } : {}),
      }),
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
  const driftDetails = [];
  const dispositionCounts = {};

  for (const c of candidates) {
    const lp = await getLpDisposition(c.lp_prospect_id);
    if (!lp) continue;
    if (ACTIVE_LP_DISPOSITIONS.includes(lp.disposition_code)) {
      driftDetails.push({
        contact_id: c.contact_id,
        lp_lead_id: lp.lp_lead_id,
        lp_prospect_id: c.lp_prospect_id,
        lp_disposition: lp.disposition_code,
        lp_disposition_synced_at: lp.synced_at,
        ghl_closed_at: c.closed_at,
      });
      dispositionCounts[lp.disposition_code] = (dispositionCounts[lp.disposition_code] || 0) + 1;
    }
  }

  const driftCount = driftDetails.length;
  const elapsed = Date.now() - startedAt;

  // ── Empty-scan suppression: no event when nothing drifted ────
  if (driftCount === 0) {
    console.log(`[drift-detector] scan complete: drift=0/${candidates.length} (${elapsed}ms) — no event emitted`);
    return {
      success: true,
      scanned: candidates.length,
      drift: 0,
      drift_details: [],
      disposition_counts: {},
      elapsed_ms: elapsed,
      closure_tag,
      closed_for_hours,
      event_emitted: false,
    };
  }

  // ── Single batch emission ────────────────────────────────────
  // Idempotency keyed on scan-minute so a retried scan in the same
  // minute doesn't double-fire. Different minute = different batch.
  const scanMinuteKey = new Date().toISOString().slice(0, 16);
  const dispositionSummary = Object.entries(dispositionCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([disp, n]) => `${disp}=${n}`)
    .join(', ');

  await emitEvent({
    event_type: 'system.drift_batch_detected',
    source: 'drift_detector',
    entity_type: 'system',
    entity_id: `drift_scan_${scanMinuteKey}`,
    priority: 'high',
    payload: {
      drift_type: 'ghl_closed_lp_active',
      closure_tag,
      closed_for_hours,
      scanned_count: candidates.length,
      drift_count: driftCount,
      disposition_counts: dispositionCounts,
      disposition_summary: dispositionSummary,
      drift_details: driftDetails,
      scan_started_at: new Date(startedAt).toISOString(),
      sample_contacts: driftDetails.slice(0, 5).map(d => ({
        contact_id: d.contact_id,
        lp_disposition: d.lp_disposition,
      })),
    },
    idempotency_key: `drift_batch:${scanMinuteKey}:${closure_tag}`,
  });

  console.log(`[drift-detector] scan complete: drift=${driftCount}/${candidates.length} dispositions=${dispositionSummary} (${elapsed}ms) — 1 batch event emitted`);
  return {
    success: true,
    scanned: candidates.length,
    drift: driftCount,
    drift_details: driftDetails,
    disposition_counts: dispositionCounts,
    disposition_summary: dispositionSummary,
    elapsed_ms: elapsed,
    closure_tag,
    closed_for_hours,
    event_emitted: true,
  };
}

/**
 * Read-only enrichment of the drift scan for the dashboard Issues page.
 *
 * Returns the drifted contacts (closed in GHL but LP disposition still active)
 * shaped for the dashboard's `DriftCandidate` type:
 *   { rows: [{ contact_id, name, reason, ghl_status, lp_status, last_lp_activity_at }] }
 *
 * Unlike runDriftScan() this emits NO event and writes nothing — it backs the
 * `get_drift_candidates` MCP tool the dashboard calls (with no args → defaults).
 * lp_leads is joined in one batched query per chunk (latest row per prospect).
 */
export async function getEnrichedDriftCandidates({
  closure_tag = DEFAULT_CLOSURE_TAG,
  closed_for_hours = DRIFT_THRESHOLD_HOURS,
  limit = 1000,
} = {}) {
  const result = await fetchDriftCandidates(closure_tag, closed_for_hours, limit);
  const candidates = result.contacts || [];
  if (!candidates.length || !supabase) {
    return { rows: [], scanned: candidates.length, drift: 0, closure_tag, closed_for_hours };
  }

  // Latest lp_leads row per prospect, batched (synced_at desc → first seen wins).
  const prospectIds = [...new Set(
    candidates.map(c => c.lp_prospect_id).filter(Boolean).map(String),
  )];
  const latestByProspect = {};
  const CHUNK = 300;
  for (let i = 0; i < prospectIds.length; i += CHUNK) {
    const chunk = prospectIds.slice(i, i + CHUNK);
    const { data } = await supabase
      .from('lp_leads')
      .select('lp_prospect_id, lp_lead_id, first_name, last_name, disposition_code, disposition_label, last_contact_date, updated_at_lp, synced_at')
      .in('lp_prospect_id', chunk)
      .order('synced_at', { ascending: false });
    for (const row of (data || [])) {
      const key = String(row.lp_prospect_id);
      if (!latestByProspect[key]) latestByProspect[key] = row;
    }
  }

  const rows = [];
  for (const c of candidates) {
    const lp = latestByProspect[String(c.lp_prospect_id)];
    if (!lp || !ACTIVE_LP_DISPOSITIONS.includes(lp.disposition_code)) continue;
    const name = [lp.first_name, lp.last_name].filter(Boolean).join(' ').trim() || null;
    rows.push({
      contact_id: c.contact_id,
      name,
      reason: `Closed in GHL (${closure_tag}) but LP disposition is still active`,
      ghl_status: closure_tag,
      lp_status: lp.disposition_label || lp.disposition_code || null,
      last_lp_activity_at: lp.last_contact_date || lp.updated_at_lp || lp.synced_at || null,
    });
  }
  return { rows, scanned: candidates.length, drift: rows.length, closure_tag, closed_for_hours };
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
  console.log(`[drift-detector] scheduler started (initial: ${INITIAL_DELAY_MS / 60000}min, interval: ${SCAN_INTERVAL_MS / 60000}min) — batch emission mode`);
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
