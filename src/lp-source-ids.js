/**
 * LP attribution ID registry — src/lp-source-ids.js
 *
 * srs_id = LP SubSource (WHERE the lead came from)  — SETUP → CUSTOMERS → SOURCE SUBS
 * pro_id = LP Promoter employee ID (WHO procured it) — a different table entirely
 *
 * ─────────────────────────────────────────────────────────────────────
 * v2.0 (2026-08-18) — CHATBOT srs_id CORRECTED TO 830. The previous
 * values were inverted, and the guard below enforced the inversion.
 *
 * WHY THE OLD VALUES WERE WRONG. 830 exists in BOTH LP tables:
 *   SubSource 830 = "Reece ChatBot"      (source "Website")
 *   Promoter  830 = "Godlewski, Paul"
 * That collision is almost certainly what made the original I.CT pairing
 * look transposed. It wasn't. `srs_id=830` was right all along.
 *
 * EVIDENCE (live lp_leads, pulled 2026-08-18):
 *   srs_id 830  → source "Website", sourcesubdescr "Reece ChatBot"
 *                 100 leads, 33 in the last 30 days, still flowing.
 *                 Sits inside the coherent 3-digit Website SubSource block:
 *                 533 Google, 534 Facebook, 535 Instagram, 536 Flyer on Door,
 *                 537 Radio, 538 TV, 539 Mail, 540 Newspaper, 541 Home Show,
 *                 542 Previous Customer, 543 Customer Referral, 544 Magazine,
 *                 545 Billboard, 830 Reece ChatBot, 842 Website Estimate Calculator.
 *   srs_id 5574 → source "", sourcesubdescr "". TWO leads, EVER. Both blank.
 *                 5574 is not in the SubSource table at all; LP stores the
 *                 integer and resolves nothing.
 *
 * Ruled by Mark 2026-08-18 after reading the LP record directly.
 *
 * CONSEQUENCE OF THE OLD VALUES: every agentic chatbot push after
 * 2026-08-01 sent srs_id=5574 (no attribution) and pro_id=830, which
 * credited promoter Godlewski, Paul. All six Godlewski leads in LP are
 * GHL-originated (each carries a 20-char GHL contact ID as lognumber);
 * he never canvassed one.
 *
 * IF YOU ARE ABOUT TO "FIX" THIS BACK: don't. Read SETUP → CUSTOMERS →
 * SOURCE SUBS in the LP UI first. The number you want is the one whose
 * description is "Reece ChatBot". As of 2026-08-18 that is 830.
 * ─────────────────────────────────────────────────────────────────────
 *
 * HISTORICAL NOTE (v1.0, superseded). This file was created on 2026-08-01
 * in the belief that GHL workflow I.CT (98f54471) had shipped
 * `srs_id=830&pro_id=5574` backwards, splitting one bot across
 * "Chat (REECE WEBSITE)" (srs_id 749) and "Reece ChatBot" (srs_id 830).
 * The split was real. The diagnosis of which side was wrong was not:
 * 749 and 830 are two different SubSource rows, and the fix was to
 * consolidate onto 830 — not to abandon it for a number that resolves
 * to nothing.
 *
 * Never inline these values again.
 */

export const LP_SRS = {
  // LP SubSource "Reece ChatBot" — source "Website". Verified against the
  // live SubSource table 2026-08-18. Was '5574' (invalid) v1.0–v1.x.
  CHATBOT: '830',
};

export const LP_PRO = {
  // Promoters are the people who PROCURE a lead — canvassers, home-show
  // staff, telemarketers. A chatbot lead has no promoter, so there is no
  // CHATBOT entry here by design.
  //
  // Do NOT add one. Sending pro_id on a self-serve web lead credits a
  // human for work they did not do and corrupts promoter-level reporting.
  // See dropPromoterForSelfServe() below and the caller in
  // src/actions/handlers/lp-lead.js.
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
 * SubSource IDs that represent a self-serve digital surface: the lead
 * arrived on its own and no human procured it. pro_id must be omitted for
 * these (Mark's ruling, 2026-08-18: "pro_id is really for when there is a
 * canvasser").
 *
 * Add to this set when a new self-serve SubSource is created in LP.
 */
export const SELF_SERVE_SRS_IDS = new Set([
  '830',  // Reece ChatBot
  '842',  // Website Estimate Calculator
  '749',  // Chat (REECE WEBSITE) — legacy chatbot row, still receives stragglers
]);

/**
 * Return the pro_id that should actually be sent, given the resolved
 * srs_id. Returns '' for self-serve digital sources so the caller omits
 * the field entirely.
 *
 * Canvassing, home shows and telemarketing keep their promoter — that is
 * the whole point of the field.
 *
 * @param {string|number} srsId  resolved LP SubSource ID
 * @param {string|number} proId  resolved LP Promoter ID (may be blank)
 * @returns {string} the pro_id to send, or '' to omit
 */
export function dropPromoterForSelfServe(srsId, proId) {
  if (!proId) return '';
  if (SELF_SERVE_SRS_IDS.has(String(srsId))) return '';
  return String(proId);
}

/**
 * Guard the known transposition. Throw rather than misattribute.
 *
 * v2.0 — the expected pair is INVERTED from v1.0. The transposed shape is
 * now `srs_id=5574 / pro_id=830`: a SubSource slot holding a number that
 * resolves to nothing, and a promoter slot holding the real SubSource ID.
 * That is precisely what the v1.0 registry produced, so this guard now
 * catches its own predecessor's output.
 *
 * Deliberately narrow: it fires only on that exact pair, not on any
 * unfamiliar combination. A broad "does this look wrong" heuristic would
 * reject the legitimate non-chatbot srs/pro pairs that flow through
 * create_lp_lead from contact custom fields.
 *
 * Throwing is the correct failure mode: the action goes `failed`, the
 * reaper does not retry create_lp_lead (marked non-idempotent 2026-05-01),
 * and GroupMe escalates — all far better than silently writing a lead into
 * LP under the wrong source, which cannot be corrected after the fact.
 * LP exposes no write endpoint that accepts srs_id; UpdateProspectInfo
 * covers name/address/phone/email only, so a misattributed lead can only
 * be repaired by hand in the LP UI.
 *
 * @param {string|number} srsId  resolved LP SubSource ID
 * @param {string|number} proId  resolved LP Promoter ID
 * @throws {Error} when the pair is the known transposition
 */
export function assertNotTransposed(srsId, proId) {
  if (String(srsId) === '5574' && String(proId) === LP_SRS.CHATBOT) {
    throw new Error(
      `LP attribution transposed: srs_id=${srsId}/pro_id=${proId}. ` +
      `5574 is not a SubSource (it resolves to blank in LP); ${LP_SRS.CHATBOT} is ` +
      `"Reece ChatBot". Expected srs_id=${LP_SRS.CHATBOT} with no pro_id.`
    );
  }
}

export default {
  LP_SRS,
  LP_PRO,
  LP_EMP,
  SELF_SERVE_SRS_IDS,
  dropPromoterForSelfServe,
  assertNotTransposed,
};
