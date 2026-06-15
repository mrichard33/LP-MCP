/**
 * Lead-Selection Pass — src/agentic/lead-selection/select.js
 *
 * Sibling of enroll-existing-eligible.js. Scores the already-classified book
 * into a ranked, SEGMENTED re-engagement candidate list and upserts it into
 * agentic_reengagement_candidates (PK contact_id). It does NOT re-classify
 * and does NOT write to GHL — enrollment is a separate gated step (enroll.js).
 *
 * S1.3 is REACTIVATION, not S4.5 nurture (do NOT revert):
 *   SUPPRESSION_STATES gates S4.5 nurture eligibility. states.js doctrine
 *   routes post-demo declines and confirmed losses TO reactivation (S5.2 / L.*).
 *   So the hard-exclude list is SUPPRESSION_STATES MINUS the two reactivation
 *   states (derived, future-proof) PLUS UNCLASSIFIED (which isn't in
 *   SUPPRESSION_STATES and carries confidence=1, so the floor won't catch it).
 *   The decline/loss states are then RECENCY-GATED per candidate, not excluded
 *   — excluding them verbatim drops ~57% of OPPFDN, the campaign's #1 cohort.
 *
 * Data sourcing notes (build-time corrections, do NOT revert):
 *   - lp_leads join key is lp_leads.ghl_contact_id = agentic_lead_states.contact_id.
 *   - lp_leads fans out per contact → collapse to ONE row per ghl_contact_id
 *     (max created_at_lp) before scoring (PK is contact_id; last-write-wins).
 *   - recency (daysDormant) is NOT in signal_snapshot — compute it from
 *     lp_notes (last note) with lp_leads.created_at_lp (vintage) as fallback.
 *     Batch + paginated here; computeDaysSinceLastContact() (per-contact GHL
 *     Conversations API) stays the authority at ENROLLMENT time, not selection.
 *
 * Route: POST /admin/lead-selection/run { dry_run?, limit?, mode:'score' }
 *
 * v1.0 — 2026-06-15.
 */

import supabase from '../../supabase.js';
import { STATES, SUPPRESSION_STATES } from '../lead-state/states.js';
import { AUTO_EXECUTE_THRESHOLD } from '../lead-state/confidence.js';
import { loadActiveDenylist } from '../../prospect-denylist.js';
import { scoreCandidate, scoringConfig, TIER1_OFFER } from './scoring.js';

// ── CONFIG (env-overridable, tunable) ───────────────────────────────
const DEFAULT_LIMIT = Number(process.env.LEAD_SELECTION_LIMIT || 2000);

const CONFIDENCE_FLOOR     = AUTO_EXECUTE_THRESHOLD;  // 0.75 (cheap guard; inert in practice)
const STALE_DECLINE_DAYS   = Number(process.env.S1_3_STALE_DECLINE_DAYS || 90);
const STALE_LOSS_DAYS      = Number(process.env.S1_3_STALE_LOSS_DAYS || 365);
const INCLUDE_CONFIRMED_LOSS = process.env.S1_3_INCLUDE_CONFIRMED_LOSS === 'true'; // default false (v2)

// Reactivation targets = the two decline/loss states we WANT for S1.3.
const S1_3_REACTIVATION_STATES = [STATES.SUPPRESSED_POST_DEMO_DECLINE, STATES.SUPPRESSED_CONFIRMED_LOSS];
// Hard-exclude = SUPPRESSION_STATES MINUS reactivation targets (derived) + UNCLASSIFIED.
const S1_3_HARD_EXCLUDE = [
  ...SUPPRESSION_STATES.filter(s => !S1_3_REACTIVATION_STATES.includes(s)),
  STATES.UNCLASSIFIED,
];

// Disposition hard-excludes (compliance / unreachable).
const HARD_DISPOSITIONS = new Set(['DNC', 'NOHOME', 'NO HOME', 'BD']);
// Consent kill-switch / unreachable tags.
const STOP_TAGS = new Set(['stop-bot', 'dnc', 'unsubscribed', 'do-not-contact']);
// S1.1 in-flight tag (exclusivity).
const S1_1_TAG = 're-engagement-eligible';

const CLASSIFIER_VERSION_FALLBACK = 'lead-selection-v1.0';
const NOTE_PAGE_SIZE = 1000;
const NOTE_MAX_PAGES = 250; // safety cap (≤250k note rows scanned per run)
// Cap ids per .in() request — a single .in() with the whole pool (hundreds of
// 20-char ids) builds a query-string URL big enough to fail the fetch.
const ID_CHUNK = 150;

let running = false;

/** Split an array into chunks of size n. */
function chunkIds(arr, n = ID_CHUNK) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ── Batch enrichment helpers (all chunk their .in() lists) ──────────

/** Collapse lp_leads to ONE representative row per ghl_contact_id (max created_at_lp). */
async function fetchLeadMap(allIds) {
  const map = new Map();
  for (const ids of chunkIds(allIds)) {
    const { data, error } = await supabase
      .from('lp_leads')
      .select('ghl_contact_id, lp_prospect_id, lead_source, lead_source_detail, disposition_code, demo_completed, created_at_lp')
      .in('ghl_contact_id', ids);
    if (error) throw new Error(`lp_leads join failed: ${error.message}`);
    for (const row of data || []) {
      const k = row.ghl_contact_id;
      const prev = map.get(k);
      if (!prev) { map.set(k, row); continue; }
      // keep the newest by created_at_lp (deterministic representative)
      const a = Date.parse(prev.created_at_lp || 0) || 0;
      const b = Date.parse(row.created_at_lp || 0) || 0;
      if (b >= a) map.set(k, row);
    }
  }
  return map;
}

/** contact_id → Set(tags) from contact_tag_snapshot. */
async function fetchTagMap(allIds) {
  const map = new Map();
  for (const ids of chunkIds(allIds)) {
    const { data, error } = await supabase
      .from('contact_tag_snapshot')
      .select('ghl_contact_id, tags')
      .in('ghl_contact_id', ids);
    if (error) throw new Error(`contact_tag_snapshot read failed: ${error.message}`);
    for (const row of data || []) {
      const tags = Array.isArray(row.tags) ? row.tags.map(t => String(t).toLowerCase()) : [];
      map.set(row.ghl_contact_id, new Set(tags));
    }
  }
  return map;
}

/** Set of contact_ids with an active S1.1 enrollment action (exclusivity). */
async function fetchS11EnrolledSet(allIds) {
  const set = new Set();
  for (const ids of chunkIds(allIds)) {
    const { data, error } = await supabase
      .from('agent_actions')
      .select('target_id')
      .eq('action_type', 'add_to_workflow')
      .ilike('rule_applied', 'ENROLL_S1_1%')
      .in('target_id', ids);
    if (error) throw new Error(`S1.1 action scan failed: ${error.message}`);
    for (const a of data || []) set.add(a.target_id);
  }
  return set;
}

/**
 * contact_id → daysDormant. last note from lp_notes (chunked by id, then
 * paginated newest-first per chunk; the first row seen per contact is its max),
 * falling back to lp vintage.
 */
async function fetchDaysDormantMap(allIds, leadMap) {
  const lastNote = new Map();
  for (const ids of chunkIds(allIds)) {
    const remaining = new Set(ids);
    for (let page = 0; page < NOTE_MAX_PAGES && remaining.size > 0; page++) {
      const from = page * NOTE_PAGE_SIZE;
      const { data, error } = await supabase
        .from('lp_notes')
        .select('ghl_contact_id, created_at_lp')
        .in('ghl_contact_id', ids)
        .not('created_at_lp', 'is', null)
        .order('created_at_lp', { ascending: false })
        .range(from, from + NOTE_PAGE_SIZE - 1);
      if (error) throw new Error(`lp_notes recency read failed: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const row of data) {
        const k = row.ghl_contact_id;
        if (!lastNote.has(k)) { // first (newest) wins
          lastNote.set(k, row.created_at_lp);
          remaining.delete(k);
        }
      }
      if (data.length < NOTE_PAGE_SIZE) break;
    }
  }

  const now = Date.now();
  const out = new Map();
  for (const id of allIds) {
    const noteTs = lastNote.get(id);
    const vintage = leadMap.get(id)?.created_at_lp;
    const ref = noteTs || vintage; // prefer last human touch, else lead vintage
    if (!ref) { out.set(id, null); continue; }
    const ms = Date.parse(ref);
    if (!Number.isFinite(ms)) { out.set(id, null); continue; }
    out.set(id, Math.max(0, Math.floor((now - ms) / 86400000)));
  }
  return out;
}

// ── Per-candidate exclusion gate ────────────────────────────────────
// Returns the first matching exclusion_reason, or null if enrollable.
function evaluateExclusion({ stateRow, leadRow, tags, daysDormant, denylist, s11Set }) {
  const contactId = stateRow.contact_id;
  const st = stateRow.current_state;

  // Enrollability (F2 reach): no matched GHL/lp row → not sendable.
  if (!leadRow) return 'no_ghl_match';

  // Compliance / unreachable disposition.
  const disp = String(leadRow.disposition_code || '').trim().toUpperCase();
  if (HARD_DISPOSITIONS.has(disp)) return 'hard_disposition';

  // Consent kill-switch / unreachable tags.
  if (tags) {
    for (const t of STOP_TAGS) if (tags.has(t)) return 'stop_bot';
  }
  // Sync-health denylist (keyed on LP prospect id).
  if (leadRow.lp_prospect_id && denylist.has(String(leadRow.lp_prospect_id))) return 'prospect_denylist';

  // Confidence floor (cheap belt-and-suspenders; authoritative states pass at ~1.0).
  if (typeof stateRow.classification_confidence === 'number' && stateRow.classification_confidence < CONFIDENCE_FLOOR) {
    return 'low_confidence';
  }

  // Recency gate — post-demo declines (THE load-bearing gate: keeps actively-worked leads out).
  if (st === STATES.SUPPRESSED_POST_DEMO_DECLINE) {
    if (daysDormant == null) return 'decline_recency_unknown';
    if (daysDormant < STALE_DECLINE_DAYS) return 'decline_too_fresh';
  }

  // Recency gate — confirmed losses (flag-gated, longer fuse).
  if (st === STATES.SUPPRESSED_CONFIRMED_LOSS) {
    if (!INCLUDE_CONFIRMED_LOSS) return 'confirmed_loss_v2_deferred';
    if (daysDormant == null || daysDormant < STALE_LOSS_DAYS) return 'loss_too_fresh';
  }

  // S1.1 ↔ S1.3 exclusivity — one re-engagement workflow per contact.
  if (s11Set.has(contactId)) return 's1_1_active';
  if (tags && tags.has(S1_1_TAG)) return 's1_1_active';

  return null; // enrollable
}

// ── Main pass ───────────────────────────────────────────────────────

export async function runScorePass({ limit = DEFAULT_LIMIT, dryRun = false } = {}) {
  if (running) return { success: true, skipped: true, reason: 'already_running' };
  running = true;
  const startedAt = Date.now();

  try {
    // 1. Candidate states (everything NOT hard-excluded).
    const { data: states, error } = await supabase
      .from('agentic_lead_states')
      .select('contact_id, current_state, classification_confidence, classifier_version, state_reason')
      .not('current_state', 'in', `(${S1_3_HARD_EXCLUDE.join(',')})`)
      .order('state_classified_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`agentic_lead_states scan failed: ${error.message}`);
    const candidates = states || [];
    const ids = candidates.map(s => s.contact_id);

    // 2. Batch enrichment.
    const [leadMap, tagMap, s11Set, denylist] = await Promise.all([
      fetchLeadMap(ids),
      fetchTagMap(ids),
      fetchS11EnrolledSet(ids),
      loadActiveDenylist(),
    ]);
    const dormancyMap = await fetchDaysDormantMap(ids, leadMap);

    // 3. Evaluate + score.
    const rows = [];
    const segmentCounts = {};
    const exclusionCounts = {};
    let enrollableCount = 0, excludedCount = 0;

    for (const stateRow of candidates) {
      const contactId = stateRow.contact_id;
      const leadRow = leadMap.get(contactId) || null;
      const tags = tagMap.get(contactId) || null;
      const daysDormant = dormancyMap.get(contactId) ?? null;

      const exclusion = evaluateExclusion({ stateRow, leadRow, tags, daysDormant, denylist, s11Set });
      const enrollable = exclusion === null;

      const { score, components, segment, temperature, target_offer_rung } =
        scoreCandidate(stateRow, leadRow, daysDormant);

      if (enrollable) {
        enrollableCount++;
        segmentCounts[segment] = (segmentCounts[segment] || 0) + 1;
      } else {
        excludedCount++;
        exclusionCounts[exclusion] = (exclusionCounts[exclusion] || 0) + 1;
      }

      rows.push({
        contact_id: contactId,
        score,
        segment,
        temperature,
        target_offer_rung,
        disposition_code: leadRow?.disposition_code ?? null,
        source: leadRow?.lead_source_detail || leadRow?.lead_source || null,
        enrollable,
        exclusion_reason: exclusion,
        components,
        classifier_version: stateRow.classifier_version || CLASSIFIER_VERSION_FALLBACK,
        _score: score, // local-only for ranking
      });
    }

    // 4. Rank enrollable rows by score desc; assign rank (excluded → null).
    const ranked = rows.filter(r => r.enrollable).sort((a, b) => b._score - a._score);
    ranked.forEach((r, i) => { r.rank = i + 1; });
    for (const r of rows) { if (r.rank === undefined) r.rank = null; delete r._score; }

    // 5. Upsert. The candidate table is analysis output (never a GHL write), so
    //    the score pass ALWAYS writes it — `dry_run` governs only the enroll pass.
    //    Omit enrolled / enrollment_action_id so the enroll pass's stamps survive
    //    re-scoring (PostgREST upsert only updates supplied columns).
    const nowIso = new Date().toISOString();
    let upserted = 0;
    {
      const payload = rows.map(r => ({
        contact_id: r.contact_id,
        score: r.score,
        rank: r.rank,
        segment: r.segment,
        temperature: r.temperature,
        target_offer_rung: r.target_offer_rung,
        disposition_code: r.disposition_code,
        source: r.source,
        enrollable: r.enrollable,
        exclusion_reason: r.exclusion_reason,
        components: r.components,
        classifier_version: r.classifier_version,
        scored_at: nowIso,
      }));
      for (let i = 0; i < payload.length; i += 500) {
        const chunk = payload.slice(i, i + 500);
        const { error: upErr } = await supabase
          .from('agentic_reengagement_candidates')
          .upsert(chunk, { onConflict: 'contact_id' });
        if (upErr) throw new Error(`candidate upsert failed: ${upErr.message}`);
        upserted += chunk.length;
      }
    }

    const elapsed_ms = Date.now() - startedAt;
    const top_preview = ranked.slice(0, 10).map(r => ({
      contact_id: r.contact_id, rank: r.rank, score: r.score, segment: r.segment,
      temperature: r.temperature, disposition_code: r.disposition_code, source: r.source,
    }));

    const summary = {
      success: true,
      mode: 'score',
      dry_run: dryRun,
      scanned: candidates.length,
      enrollable: enrollableCount,
      excluded: excludedCount,
      upserted,
      segment_counts: segmentCounts,
      exclusion_counts: exclusionCounts,
      top_preview,
      config: {
        limit,
        confidence_floor: CONFIDENCE_FLOOR,
        stale_decline_days: STALE_DECLINE_DAYS,
        stale_loss_days: STALE_LOSS_DAYS,
        include_confirmed_loss: INCLUDE_CONFIRMED_LOSS,
        hard_exclude_states: S1_3_HARD_EXCLUDE,
        tier1_offer: TIER1_OFFER,
        scoring: scoringConfig(),
      },
      elapsed_ms,
    };
    console.log(
      `[LeadSelection] score done: ${enrollableCount} enrollable, ${excludedCount} excluded ` +
      `of ${candidates.length} scanned (dry_run=${dryRun}, ${elapsed_ms}ms). segments=${JSON.stringify(segmentCounts)}`
    );
    return summary;
  } finally {
    running = false;
  }
}

/** Read-back report of the current candidate table (no re-scoring). */
export async function getSelectionReport() {
  const startedAt = Date.now();
  const { data, error } = await supabase
    .from('agentic_reengagement_candidates')
    .select('segment, temperature, enrollable, exclusion_reason, enrolled');
  if (error) throw new Error(`candidate report read failed: ${error.message}`);
  const rows = data || [];

  const segment_counts = {}, exclusion_counts = {};
  let enrollable = 0, excluded = 0, enrolled = 0;
  for (const r of rows) {
    if (r.enrolled) enrolled++;
    if (r.enrollable) {
      enrollable++;
      segment_counts[r.segment] = (segment_counts[r.segment] || 0) + 1;
    } else {
      excluded++;
      exclusion_counts[r.exclusion_reason || 'unknown'] = (exclusion_counts[r.exclusion_reason || 'unknown'] || 0) + 1;
    }
  }
  return {
    success: true,
    total: rows.length,
    enrollable, excluded, enrolled,
    segment_counts, exclusion_counts,
    elapsed_ms: Date.now() - startedAt,
  };
}
