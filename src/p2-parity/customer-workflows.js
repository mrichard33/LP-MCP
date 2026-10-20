/**
 * GHL customer workflows (C-series) — src/p2-parity/customer-workflows.js
 *
 * A P2 loss takes the customer out of C.0–C.5 (the user, 2026-10-20: "I also need the
 * GHL workflow fixes working"). GHL L.6 P2 Loss Classification removes a lost
 * customer from ~44 marketing workflows but none of C.0–C.5, so a cancelled job would
 * keep getting install, check-in, review and referral messages once their
 * test-contact gates come off. GHL's API cannot edit a workflow, but it can remove a
 * contact from one, so LP-MCP does that part of the L.6 fix itself, on every P2 loss
 * it closes (rule 365 through executeUpdateOpportunity, and the parity sweep).
 * Ids read from the HL mirror's `workflows` on 2026-10-20.
 */
export const CUSTOMER_WORKFLOWS = Object.freeze({
  'C.0 Customer Onboarding': '6b2c2920-a21b-4ebd-92df-8e31ef4ed8dc',
  'C.1 Install Progress Updates': '0622436d-ccae-4802-a048-47c16b467c34',
  'C.2 Post-Install Check-In': '3a3f7f4f-92fc-4887-ae77-8a6341d30758',
  'C.3 Expansion': 'c52fe19c-87a7-419b-9b87-e2fe488afe54',
  'C.4 Review Solicitation': '06cfa0bc-a185-46cc-a1bd-f33e579acc0d',
  'C.5 Referral Overlay': '5d84a10a-aa54-4254-b3b8-5fd97664d8b8',
});

/**
 * Remove a contact from every C-series workflow. Fail-soft per workflow: a contact
 * who was never enrolled is the common case, and a failure never undoes the loss.
 * @returns {Promise<{ removed: string[], failed: string[] }>}
 */
export async function removeFromCustomerWorkflows(contactId, { ghlFetch, logger = console } = {}) {
  const removed = []; const failed = [];
  if (!contactId) return { removed, failed };
  const fetchFn = ghlFetch || (await import('../actions/helpers.js')).ghlFetch;
  for (const [name, id] of Object.entries(CUSTOMER_WORKFLOWS)) {
    try {
      await fetchFn('DELETE', `/contacts/${contactId}/workflow/${id}`);
      removed.push(name);
    } catch (err) {
      failed.push(name);
      logger.warn?.(`[CustomerWorkflows] ${contactId}: could not remove from ${name}: ${err.message}`);
    }
  }
  return { removed, failed };
}
