/**
 * Drift Detector — src/services/drift-detector.js
 *
 * After-the-fact detection for the class of failures we cannot prevent at
 * send-time (notably GHL native workflow sends, which bypass the agentic
 * executor). Periodically asks HL MCP for contacts that look closed in
 * GHL (e.g., carrying stage:long-term-nurture for >24h) and joins them
 * against lp_leads to find any whose LP disposition is still active.
 *
 * On mismatch, posts ONE #ops-alerts card per contact the first time it is
 * seen, never again (2026-10-02, see postDriftCards). It still emits the
 * system.drift_batch_detected event for the record, but that event is not on
 * the intake allowlist and routes nowhere. Never auto-overwrites LP.
 *
 * Cron: 30-min interval, kicks 5 min after boot. Killable via
 *   DRIFT_DETECTOR_DISABLED=true.
 *
 * 2026-09-05 — EDGE-TRIGGERED (follow-on to PR #845).
 *   PRIOR BEHAVIOR: every scan emitted the ENTIRE drift set. Batching
 *   (below) fixed the shape of the alert but not its repetition — the
 *   scan-minute idempotency key differs on every scan by construction,
 *   so it only ever deduped a retry within the same minute. A contact
 *   that drifted and was never fixed was re-announced every 30 minutes
 *   indefinitely: 48 cards a day for one unresolved problem, and the
 *   worst offender by volume among the watchdogs PR #845 catalogued.
 *
 *   NEW: each drifted contact is its own condition in alert_conditions
 *   (src/alert-state.js), keyed 'drift:ghl_closed_lp_active:<contact_id>'.
 *   The batch is emitted only for contacts whose firing edge this scan
 *   won, so an ongoing drift set is silent and a contact whose LP
 *   disposition is fixed clears without a card. Survives restarts and
 *   replicas, which the old in-process approaches did not.
 *
 *   Two reads that are NOT evidence of health, and must clear nothing:
 *   a failed HL candidate fetch, and an unusable alert_conditions table.
 *   The first skips the scan; the second falls back to emitting the full
 *   set at most once per DRIFT_ALERT_FALLBACK_COOLDOWN_MS (default 6h).
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
import { claimAlertConditionSet, confirmAlertSend } from '../alert-state.js';
import { filterNew, recordPosted } from '../alert-posted.js';

const ACTIVE_LP_DISPOSITIONS = ['Issued', 'Set', 'Cnf', 'Data', 'NOC', 'OPPFDN', '1Leg', 'BO'];
const DRIFT_THRESHOLD_HOURS = 24;
const SCAN_INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_CLOSURE_TAG = 'stage:long-term-nurture';

// One condition per drifted contact. Drift persists until a human fixes LP, so
// identity is the contact — not the scan, and not the disposition code, which
// can change while the same contact stays wrong.
const DRIFT_ALERT_PREFIX = 'drift:ghl_closed_lp_active:';

// Degraded path only, reached when alert_conditions is unusable. Deliberately
// long: without per-contact state the only safe emission is the whole set, and
// that must not go out every 30 minutes.
const FALLBACK_COOLDOWN_MS = parseInt(
  process.env.DRIFT_ALERT_FALLBACK_COOLDOWN_MS || `${6 * 60 * 60 * 1000}`, 10
);
let lastFallbackEmitAt = 0;

/** TESTS ONLY — clear the degraded-path clock. */
export function __resetDriftFallback() { lastFallbackEmitAt = 0; }

/**
 * Emit the batch event. `details` is what the card announces; `all` is the full
 * current drift set, carried alongside so the payload still describes the whole
 * problem even when the card names only the new arrivals.
 */
async function emitDriftBatch({
  details, all, candidates, startedAt, scanMinuteKey,
  closure_tag, closed_for_hours, dispositionSummary, emit,
}) {
  const counts = details.reduce((acc, d) => {
    acc[d.lp_disposition] = (acc[d.lp_disposition] || 0) + 1;
    return acc;
  }, {});
  await emit({
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
      drift_count: details.length,
      disposition_counts: counts,
      disposition_summary: dispositionSummary(details),
      drift_details: details,
      total_drift_count: all.length,
      all_drift_details: all,
      scan_started_at: new Date(startedAt).toISOString(),
      sample_contacts: details.slice(0, 5).map(d => ({
        contact_id: d.contact_id,
        lp_disposition: d.lp_disposition,
      })),
    },
    idempotency_key: `drift_batch:${scanMinuteKey}:${closure_tag}`,
  });
}

/**
 * `ok` distinguishes "HL says nothing drifted" from "we could not ask HL".
 * Both return zero contacts, and before edge-triggering that difference did not
 * matter — a failed fetch just emitted no event. It matters now: an empty list
 * read as healthy would mark every live drift condition resolved and then
 * re-announce all of them on the next successful scan.
 */
async function fetchDriftCandidates(closureTag, closedForHours, limit) {
  const HL_URL = process.env.HL_MCP_URL;
  const HL_TOKEN = process.env.HL_INTERNAL_TOKEN || process.env.HL_MCP_TOKEN;
  if (!HL_URL) {
    console.warn('[drift-detector] HL_MCP_URL not set — skipping scan');
    return { contacts: [], ok: false };
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
      return { contacts: [], ok: false };
    }
    return { ...(await res.json()), ok: true };
  } catch (err) {
    console.error(`[drift-detector] HL MCP fetch error: ${err.message}`);
    return { contacts: [], ok: false };
  }
}

// ── 2026-10-02 (Mark): ONE card per drifted contact, ever ──────────────
// The batch event above never reached anyone: system.drift_batch_detected is
// not on the intake allowlist, so emitEvent filtered it while the keys were
// still marked announced. Now each contact gets its own #ops-alerts card the
// first time it is seen, recorded PERMANENTLY in audit_posted_items
// (audit='drift'). It never posts again for that contact — not after it
// clears and drifts back, not after a redeploy. Not part of the morning digest
// and not behind ALERT_DIGEST_ENABLED.
//
// Two guards against a flood, because the backlog is ~150 contacts:
//   - posting waits until backfillDriftPosted() has marked every contact the
//     alert table already knows (firing or cleared) as posted;
//   - an unreadable audit_posted_items posts NOTHING this scan (the shared
//     helper's "treat all as new" is the wrong default here), and at most
//     DRIFT_CARDS_PER_SCAN cards go out per scan — the rest wait, unrecorded.
export const DRIFT_AUDIT = 'drift';
const DRIFT_REASON = 'drift';
const DRIFT_CARDS_PER_SCAN = 20;
let driftBackfillDone = false;

/** TESTS ONLY. */
export function __resetDriftBackfill(done = false) { driftBackfillDone = done; }

/**
 * Mark every contact alert_conditions already holds under the drift prefix as
 * posted for good. Idempotent. Returns { ok, marked }.
 */
export async function backfillDriftPosted(deps = {}) {
  const db = deps.supabase || supabase;
  try {
    const { data, error } = await db.from('alert_conditions')
      .select('alert_key')
      .like('alert_key', `${DRIFT_ALERT_PREFIX}%`);
    if (error) throw new Error(error.message);
    const items = (data || []).map((r) => ({ key: r.alert_key.slice(DRIFT_ALERT_PREFIX.length), reason: DRIFT_REASON }))
      .filter((i) => i.key);
    const res = await recordPosted({ audit: DRIFT_AUDIT, items, permanent: true, deps: { supabase: db } });
    if (!res.ok) throw new Error(res.error || 'record failed');
    driftBackfillDone = true;
    console.log(`[drift-detector] backfill: ${items.length} drift contact(s) marked as already posted (permanent)`);
    return { ok: true, marked: items.length };
  } catch (err) {
    console.warn(`[drift-detector] backfill failed — drift cards held until it succeeds: ${err.message}`);
    return { ok: false, marked: 0, error: err.message };
  }
}

/** Pure. The card for one drifted contact. */
export function formatDriftCard(d, name) {
  return `🔁 GHL closed / LP active — ${name || '(no name)'} · ${d.contact_id} · LP lead ${d.lp_lead_id ?? '?'} still ${d.lp_disposition} · ` +
    'close the LP lead, or reopen the contact in GHL';
}

async function lookupNames(ids) {
  if (!ids.length) return new Map();
  try {
    const { hlRunSQL, esc } = await import('../admin/hl-client.js');
    const rows = await hlRunSQL(
      `SELECT ghl_contact_id, first_name, last_name FROM contacts WHERE ghl_contact_id IN (${ids.map((id) => `'${esc(id)}'`).join(',')})`,
    );
    return new Map((rows || []).map((r) => [r.ghl_contact_id, [r.first_name, r.last_name].filter(Boolean).join(' ').trim()]));
  } catch {
    return new Map();
  }
}

/**
 * Post the once-ever card for each drifted contact not yet posted.
 * deps: { supabase, send, lookupNames, backfill }
 */
export async function postDriftCards(driftDetails, deps = {}) {
  if (!driftDetails.length) return { posted: 0, held: 0, reason: 'no_drift' };
  const db = deps.supabase || supabase;
  if (!driftBackfillDone) {
    const bf = await (deps.backfill || backfillDriftPosted)({ supabase: db });
    if (!bf.ok) return { posted: 0, held: driftDetails.length, reason: 'backfill_pending' };
  }
  const items = driftDetails.map((d) => ({ ...d, key: d.contact_id, reason: DRIFT_REASON }));
  const { fresh, dedupe } = await filterNew({ audit: DRIFT_AUDIT, items, deps: { supabase: db } });
  if (dedupe === 'unavailable') return { posted: 0, held: items.length, reason: 'dedupe_unavailable' };
  const batch = fresh.slice(0, DRIFT_CARDS_PER_SCAN);
  if (!batch.length) return { posted: 0, held: 0, reason: 'nothing_new' };
  const send = deps.send || (await import('../alert-state.js')).sendAlertMessage;
  const names = await (deps.lookupNames || lookupNames)(batch.map((d) => d.contact_id));
  let posted = 0;
  for (const d of batch) {
    const res = await send(formatDriftCard(d, names.get(d.contact_id)), { channel: 'ops' });
    if (res?.sent === false) continue; // not recorded → tried again next scan
    await recordPosted({ audit: DRIFT_AUDIT, items: [d], permanent: true, deps: { supabase: db } });
    posted++;
  }
  console.log(`[drift-detector] drift cards: ${posted} posted, ${fresh.length - posted} waiting`);
  return { posted, held: fresh.length - posted, reason: 'ok' };
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
  // Injectable emitter, same seam as backstop-notify's `send`. ES module
  // bindings are read-only, so this is how a test observes what would have been
  // announced without reaching system_events.
  emit = emitEvent,
  // 2026-10-02 — the once-per-contact card; injectable for tests.
  postCards = postDriftCards,
} = {}) {
  const startedAt = Date.now();
  const result = await fetchDriftCandidates(closure_tag, closed_for_hours);

  // Could not ask HL. NOT the same as "nothing drifted" — proceeding would read
  // an empty list as health, clear every open drift condition, and re-announce
  // the lot on the next successful scan. Touch nothing.
  if (result.ok === false) {
    return {
      success: false,
      error: 'drift candidate fetch failed — scan skipped, alert state untouched',
      scanned: 0,
      drift: 0,
      drift_details: [],
      disposition_counts: {},
      elapsed_ms: Date.now() - startedAt,
      closure_tag,
      closed_for_hours,
      event_emitted: false,
    };
  }

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
  const scanMinuteKey = new Date().toISOString().slice(0, 16);
  const dispositionSummary = (details) => Object.entries(
    details.reduce((acc, d) => {
      acc[d.lp_disposition] = (acc[d.lp_disposition] || 0) + 1;
      return acc;
    }, {}),
  ).sort((a, b) => b[1] - a[1]).map(([disp, n]) => `${disp}=${n}`).join(', ');

  // Once-per-contact cards first: they do not depend on the claim set below.
  let cards = { posted: 0, held: 0, reason: 'not_run' };
  try {
    cards = await postCards(driftDetails);
  } catch (err) {
    console.warn(`[drift-detector] drift cards failed: ${err.message}`);
  }

  const baseResult = {
    drift_cards: cards,
    success: true,
    scanned: candidates.length,
    drift: driftCount,
    drift_details: driftDetails,
    disposition_counts: dispositionCounts,
    disposition_summary: dispositionSummary(driftDetails),
    elapsed_ms: elapsed,
    closure_tag,
    closed_for_hours,
  };

  // ── Edge-trigger the batch on per-contact condition state ────
  // Until 2026-09-05 this emitted the whole drift set on every scan, so a
  // contact nobody fixed was re-announced every 30 minutes forever — 48 cards a
  // day for one unresolved problem. Now each contact is its own condition; the
  // batch carries only the ones that just started drifting, and a resolved
  // contact clears silently.
  const keyFor = (contactId) => `${DRIFT_ALERT_PREFIX}${contactId}`;
  const claim = await claimAlertConditionSet({
    prefix: DRIFT_ALERT_PREFIX,
    activeKeys: driftDetails.map((d) => keyFor(d.contact_id)),
    label: 'GHL closed / LP active drift',
    detail: driftCount ? `${driftCount} drifted: ${dispositionSummary(driftDetails)}` : 'no drift',
  });

  // The state table is unusable. Degrade to the pre-2026-09-05 behavior — emit
  // the full set — but rate-limited, so a DB outage cannot restore the storm.
  if (!claim.ok) {
    const now = Date.now();
    if (driftCount === 0) {
      console.log(`[drift-detector] scan complete: drift=0/${candidates.length} (${elapsed}ms) — no event emitted`);
      return { ...baseResult, event_emitted: false, new_drift: 0, cleared_drift: 0, alert_state: claim.reason };
    }
    if (now - lastFallbackEmitAt < FALLBACK_COOLDOWN_MS) {
      console.warn(`[drift-detector] alert-state unavailable (${claim.reason}) — batch suppressed by fallback cooldown`);
      return { ...baseResult, event_emitted: false, new_drift: 0, cleared_drift: 0, alert_state: claim.reason };
    }
    lastFallbackEmitAt = now;
    await emitDriftBatch({ details: driftDetails, all: driftDetails, candidates, startedAt, scanMinuteKey, closure_tag, closed_for_hours, dispositionSummary, emit });
    console.warn(`[drift-detector] alert-state unavailable (${claim.reason}) — emitted full batch of ${driftCount} on the fallback path`);
    return { ...baseResult, event_emitted: true, new_drift: driftCount, cleared_drift: 0, alert_state: claim.reason };
  }

  const newKeys = new Set(claim.newlyFiring);
  const newDetails = driftDetails.filter((d) => newKeys.has(keyFor(d.contact_id)));

  if (newDetails.length === 0) {
    console.log(
      `[drift-detector] scan complete: drift=${driftCount}/${candidates.length} ` +
      `new=0 cleared=${claim.cleared.length} (${elapsed}ms) — no event emitted`,
    );
    return { ...baseResult, event_emitted: false, new_drift: 0, cleared_drift: claim.cleared.length };
  }

  await emitDriftBatch({
    details: newDetails, all: driftDetails, candidates, startedAt, scanMinuteKey,
    closure_tag, closed_for_hours, dispositionSummary, emit,
  });
  // Only now is the incident announced. A failed emit leaves notify_count at 0
  // and the row firing, so the contact is not re-announced — the cost is one
  // silent recovery, which is what this watchdog wants anyway.
  await confirmAlertSend(claim.newlyFiring);

  console.log(
    `[drift-detector] scan complete: drift=${driftCount}/${candidates.length} ` +
    `new=${newDetails.length} cleared=${claim.cleared.length} dispositions=${dispositionSummary(newDetails)} ` +
    `(${elapsed}ms) — 1 batch event emitted`,
  );
  return { ...baseResult, event_emitted: true, new_drift: newDetails.length, cleared_drift: claim.cleared.length };
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
