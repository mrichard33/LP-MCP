/**
 * LP attribution ID registry — src/lp-source-ids.js
 *
 * srs_id = LP SubSource (WHERE the lead came from)
 * pro_id = LP Promoter employee ID (WHO procured it)
 *
 * These two are trivially transposable and have been transposed in
 * production: GHL workflow I.CT (98f54471) shipped `srs_id=830&pro_id=5574`
 * — backwards — sending 670 leads to "Chat (REECE WEBSITE)" between
 * 2024-06-26 and 2026-07-27 while the agentic path wrote the same bot's
 * leads to "Reece ChatBot". One bot, two source records, two close rates
 * that were never comparable.
 *
 * Never inline these values again.
 */

export const LP_SRS = {
  CHATBOT: '5574',            // LP SubSource "Reece ChatBot"
};

export const LP_PRO = {
  CHATBOT: '830',             // LP promoter pseudo-employee
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
 * Guard the known transposition. Throw rather than misattribute.
 *
 * Deliberately narrow: it fires only on the exact I.CT swap
 * (srs_id=830 / pro_id=5574), not on any unfamiliar pair. A broad
 * "does this look wrong" heuristic would reject the legitimate
 * non-chatbot srs/pro combinations that flow through create_lp_lead
 * from contact custom fields.
 *
 * Throwing is the correct failure mode here: the action goes `failed`,
 * the reaper does not retry create_lp_lead (marked non-idempotent
 * 2026-05-01), and GroupMe escalates — all far better than silently
 * writing a lead into LP under the wrong source, which is unfixable
 * after the fact without rewriting attribution history.
 *
 * @param {string|number} srsId  resolved LP SubSource ID
 * @param {string|number} proId  resolved LP Promoter ID
 * @throws {Error} when the pair is the known I.CT transposition
 */
export function assertNotTransposed(srsId, proId) {
  if (String(srsId) === LP_PRO.CHATBOT && String(proId) === LP_SRS.CHATBOT) {
    throw new Error(
      `LP attribution transposed: srs_id=${srsId}/pro_id=${proId} is the known ` +
      `I.CT swap. Expected srs_id=${LP_SRS.CHATBOT}/pro_id=${LP_PRO.CHATBOT}.`
    );
  }
}

export default { LP_SRS, LP_PRO, LP_EMP, assertNotTransposed };
