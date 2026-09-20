/**
 * Milestone Ordering — src/milestone-order.js
 *
 * ONE question: of the milestones that landed in this sync pass, which is
 * the FURTHEST ALONG?
 *
 * WHY THIS EXISTS
 * ---------------
 * When a returning customer is linked to LP for the first time, the whole
 * job history arrives in a single pass and every completion looks like a
 * first completion. Contact PIDxmWzCs35NHgW85vOW replayed 12 milestones
 * spanning Dec 2024 → Apr 2025 in six seconds on 2026-08-16, emitting 12
 * lp.milestone_completed events. Seven P2_MILESTONE_* rules matched and
 * queued 24 actions; the opportunity ended BEHIND where it had already
 * been because the forward-only guard was reading stale GHL state at that
 * rate.
 *
 * ORDINALS ARE STAGE POSITIONS, NOT DATES. LP milestones do not arrive in
 * stage order (Ordered lands +10d, Permit Issued +21d, but Ordered targets
 * a later stage). Ranking by act_date would pick the wrong winner. These
 * ordinals mirror the P2 stage each live agent_rule targets, read from
 * agent_rules on 2026-08-16:
 *   M → Financing Pending (2)          R → Released to Production (RTP) (3)
 *   H,U,P → Permitting & HOA (4)       K,G → In Production (5)
 *   S → Install Scheduled (6)          F,C,I → Install Completed (7)
 *   B → Referral & Expansion (8)
 *
 * These are the GHL stage LABEL numbers ("2. Financing Pending"), not the
 * zero-based indices in src/pipeline-guard.js. Nothing here is compared
 * against STAGE_POSITIONS — the ordinals only rank milestones against each
 * other — so the off-by-one is intentional and harmless.
 *
 * Ordinal 0 = no P2_MILESTONE_* rule exists (O Quoted, V Recv Windows,
 * E Recv Doors, X Snap/Trim). Those are tag-only and never win the emit.
 */

export const P2_MILESTONE_ORDINAL = {
  M: 2, R: 3, H: 4, U: 4, P: 4, K: 5, G: 5, S: 6, F: 7, C: 7, I: 7, B: 8,
};

// Deterministic tie-break within the same ordinal when act_dates also tie.
const TIE_BREAK = ['M', 'R', 'H', 'U', 'P', 'K', 'G', 'S', 'F', 'C', 'I', 'B'];

export function milestoneOrdinal(mdtId) {
  return P2_MILESTONE_ORDINAL[mdtId] ?? 0;
}

/**
 * @param {Array<{mdtId: string, actDateEt: string|null}>} fires
 * @returns {string|null} mdt_id that should emit, or null if none are staged
 */
export function selectFurthestMilestone(fires = []) {
  let best = null;
  for (const f of fires) {
    const ord = milestoneOrdinal(f.mdtId);
    if (ord === 0) continue;
    if (!best) { best = { ...f, ord }; continue; }
    if (ord > best.ord) { best = { ...f, ord }; continue; }
    if (ord === best.ord) {
      const a = Date.parse(f.actDateEt || '') || 0;
      const b = Date.parse(best.actDateEt || '') || 0;
      if (a > b || (a === b && TIE_BREAK.indexOf(f.mdtId) > TIE_BREAK.indexOf(best.mdtId))) {
        best = { ...f, ord };
      }
    }
  }
  return best ? best.mdtId : null;
}

export const __testing = { TIE_BREAK };
