/**
 * LP attribution ID registry — src/lp-source-ids.js
 *
 * srs_id = LP SubSource   (WHERE the lead came from) — SETUP → CUSTOMERS → SOURCE SUBS
 * pro_id = LP Promoter ID (WHO is credited)          — a different table entirely
 *
 * ═════════════════════════════════════════════════════════════════════
 * v2.1 (2026-08-18) — CANONICAL SOURCE OF TRUTH IS THE NOTION
 * "UTM Parameters" DATABASE (Marketing & Content →
 * 30a68239-dd72-8081-9867-f10333ef320e). Every pair below is copied from
 * it. Do not derive these from code, from LP row inspection, or from
 * reasoning about which number "looks like" a SubSource. Read the table.
 *
 *   Name                                LP Source ID   Pro ID
 *   ─────────────────────────────────   ────────────   ──────
 *   Chatbot Leads                            830        5574
 *   Estimate Calculator - Landing Page       842        5862
 *   Estimate Calculator - Direct Mail        837        5396
 *   Canvassing Leads                         344        (none — dynamic)
 *   Reece Charity Event                      847        (none)
 *
 * THE RULE, corrected. pro_id is NOT "only when a canvasser is involved".
 * It is the inverse: the DIGITAL channels each carry a FIXED per-channel
 * pseudo-promoter, which is how LP segments self-serve sources in
 * promoter-level reporting. Canvassing is the one WITHOUT a static Pro ID,
 * because its promoter is a real, varying human passed per lead — which is
 * why the canvassing row's utm_campaign is `{{contact.promotor}}` rather
 * than a constant.
 *
 * Sanity check on the ID ranges, which is the fastest way to catch a swap:
 *   SubSource IDs are 3-digit  — 344, 533-545, 830, 837, 842, 847
 *   Promoter IDs are 4-digit   — 5396, 5574, 5686, 5862
 * A 4-digit value in the srs_id slot is a transposition. Always.
 *
 * ─── HISTORY, so nobody re-derives the wrong answer a third time ───
 *
 * v1.0 (2026-08-01) had CHATBOT srs_id 5574 / pro_id 830 — exactly
 * reversed — and shipped a guard that THREW on the correct pair. Result:
 * chatbot pushes sent 5574 into the SubSource slot (resolves to nothing in
 * LP: 2 leads ever, both with blank source and blank sourcesubdescr) and
 * 830 into the promoter slot, where LP resolved it to "Godlewski, Paul".
 * All six Godlewski leads in LP are GHL-originated; he never worked one.
 *
 * v2.0 (2026-08-18, same day, superseded within hours) corrected srs_id to
 * 830 but then removed LP_PRO.CHATBOT entirely and added a
 * dropPromoterForSelfServe() helper, on the reasoning that a self-serve
 * lead has no promoter. That reasoning was wrong and the Notion table says
 * so: self-serve is precisely where the fixed Pro ID lives. Both the
 * constant and the helper are gone again in v2.1.
 *
 * WHAT MADE THIS HARD, recorded so the next person is faster:
 *   1. 830 exists in BOTH tables — SubSource 830 "Reece ChatBot" AND
 *      Promoter 830 "Godlewski, Paul". Looking up 830 and finding a person
 *      does not mean 830 is a promoter ID.
 *   2. The field constants in lp-lead.js were themselves swapped
 *      (see that file, v1.3), so reading a contact's custom fields
 *      reproduced the inversion rather than exposing it.
 *   3. Two SubSource rows describe the same bot — 749 "Chat (REECE
 *      WEBSITE)" and 830 "Reece ChatBot". The consolidation target is 830.
 *
 * Never inline these values again. If a value here disagrees with the
 * Notion table, the Notion table wins and this file is stale.
 * ═════════════════════════════════════════════════════════════════════
 */

/** LP SubSource IDs (3-digit). Source: Notion "UTM Parameters". */
export const LP_SRS = {
  CHATBOT: '830',              // "Reece ChatBot" — source "Website"
  CALCULATOR_LANDING: '842',   // "Website Estimate Calculator" — source "Main Website"
  CALCULATOR_DIRECTMAIL: '837',
  CANVASSING: '344',           // "Canvass"
  CHARITY_EVENT: '847',
  CHATBOT_LEGACY: '749',       // "Chat (REECE WEBSITE)" — pre-consolidation chatbot row
};

/**
 * LP Promoter IDs (4-digit). Source: Notion "UTM Parameters".
 *
 * These are fixed per-channel pseudo-promoters for self-serve digital
 * sources. Canvassing and events are deliberately absent: their promoter
 * is a real person and is passed per-lead, not from this registry.
 */
export const LP_PRO = {
  CHATBOT: '5574',
  CALCULATOR_LANDING: '5862',
  CALCULATOR_DIRECTMAIL: '5396',
};

/**
 * The canonical srs_id → pro_id pairing. Use resolvePromoterForSource()
 * rather than reading this directly.
 */
export const SRS_TO_PRO = {
  [LP_SRS.CHATBOT]: LP_PRO.CHATBOT,
  [LP_SRS.CALCULATOR_LANDING]: LP_PRO.CALCULATOR_LANDING,
  [LP_SRS.CALCULATOR_DIRECTMAIL]: LP_PRO.CALCULATOR_DIRECTMAIL,
};

/**
 * LP employee IDs.
 * 5686 = "Integration, GoHighLevel" — the setter on every appointment our
 * system sets via SetAppointment. Also the default empid for UpdateDNCStatus.
 */
export const LP_EMP = {
  GHL_INTEGRATION: '5686',
};

/**
 * Resolve the pro_id to send for a given srs_id.
 *
 * An explicitly supplied proId always wins — canvassing and events pass a
 * real promoter per lead and must never be overridden. When none is
 * supplied and the source is a known digital channel, the registry pair is
 * used. Otherwise returns '' and the caller omits the field.
 *
 * @param {string|number} srsId  resolved LP SubSource ID
 * @param {string|number} [proId] explicitly supplied promoter, if any
 * @returns {string} the pro_id to send, or '' to omit
 */
export function resolvePromoterForSource(srsId, proId) {
  if (proId) return String(proId);
  return SRS_TO_PRO[String(srsId)] || '';
}

/**
 * Guard the known transposition. Throw rather than misattribute.
 *
 * v2.1 — generalised from a single hardcoded pair to the structural rule,
 * because this exact swap has now been made twice in opposite directions
 * and a narrow check caught neither. SubSource IDs are 3-digit and
 * Promoter IDs are 4-digit, so a 4-digit srs_id paired with a 3-digit
 * pro_id is a transposition regardless of which channel it came from.
 *
 * Throwing is the correct failure mode: the action goes `failed`, the
 * reaper does not retry create_lp_lead (non-idempotent since 2026-05-01),
 * and GroupMe escalates. Far better than silently writing a lead under the
 * wrong source — LP exposes NO write endpoint that accepts srs_id
 * (UpdateProspectInfo covers name/address/phone/email only), so a
 * misattributed lead can only ever be repaired by hand in the LP UI.
 *
 * @param {string|number} srsId  resolved LP SubSource ID
 * @param {string|number} proId  resolved LP Promoter ID
 * @throws {Error} when the pair looks transposed
 */
export function assertNotTransposed(srsId, proId) {
  const s = String(srsId || '');
  const p = String(proId || '');
  if (!s || !p) return;
  if (!/^\d+$/.test(s) || !/^\d+$/.test(p)) return;

  if (s.length >= 4 && p.length === 3) {
    throw new Error(
      `LP attribution transposed: srs_id=${s}/pro_id=${p}. LP SubSource IDs ` +
      `are 3-digit and Promoter IDs are 4-digit, so these are the wrong way ` +
      `round. Canonical pairs live in the Notion "UTM Parameters" table — ` +
      `chatbot is srs_id=${LP_SRS.CHATBOT}/pro_id=${LP_PRO.CHATBOT}.`
    );
  }
}

export default {
  LP_SRS,
  LP_PRO,
  SRS_TO_PRO,
  LP_EMP,
  resolvePromoterForSource,
  assertNotTransposed,
};
