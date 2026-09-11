/**
 * Established-Facts Handler — src/actions/handlers/established-facts.js
 *
 * action_type: persist_established_facts
 *
 * Writes the facts the analyzer established from the lead's own words onto the
 * GHL contact record, at the moment the analyzer knows them.
 *
 * WHY A DEDICATED ACTION TYPE (and not an update_custom_fields template)
 * ─────────────────────────────────────────────────────────────────────
 * The obvious design is a rule whose action_template is one
 * update_custom_fields writing "only the fields present and non-null". That
 * cannot work, for three separate reasons, all verified in this repo:
 *
 *   1. agent_rules.action_template is STATIC JSON. It has no conditional, so
 *      "only the fields present and non-null" is not expressible in it.
 *   2. createActionsFromRule (src/decision-engine.js) copies `tmpl.params`
 *      into action_payload VERBATIM. Nothing but send_message is rewritten at
 *      queue time, so a template cannot carry a per-lead value.
 *   3. executeUpdateCustomFields does not interpolate at all, and
 *      interpolatePayload (src/actions/helpers.js) is shallow — it maps over
 *      array ITEMS but does not descend into objects, so it could never reach
 *      `fields[].field_value` even if it were wired in.
 *
 * So the values are resolved here, in code, from the source event. The rule
 * carries no values whatsoever — it decides WHEN, this decides WHAT. That is
 * also how the existing QUALIFYING_DATA_PERSIST write works
 * (src/send-message-handler.js), which this rule runs ahead of rather than
 * replaces.
 *
 * CONTEXT-AWARE: registered in CONTEXT_AWARE_HANDLERS so getEventContext()
 * spreads the ai.analysis_completed payload into `context`, giving us
 * `context.established_facts` without a second read.
 *
 * IDEMPOTENT BY NATURE: writing the same field the same value twice is a
 * no-op at GHL, and this never clears a field — a fact the analyzer did not
 * establish on this turn is simply absent from the write.
 */

import { updateGHLContactFields } from '../../ghl.js';
import { normalizeEstablishedFacts } from '../../agentic/established-facts-fields.js';

/**
 * @param {object} action   agent_actions row
 * @param {object} context  spread ai.analysis_completed payload
 * @param {{updateFields?: Function}} [deps]  injected for tests — an ES module
 *   namespace is frozen, so the GHL client cannot be monkey-patched and has to
 *   be passed in. The executor calls this with two arguments and gets the real
 *   client by default.
 */
export async function executePersistEstablishedFacts(action, context, deps = {}) {
  const updateFields = deps.updateFields || updateGHLContactFields;
  const contactId = action.target_id;
  if (!contactId) throw new Error('Missing contactId');

  // The action payload may carry facts directly (a manual queue, a replay);
  // otherwise they come from the source event the rule fired on.
  const raw = action.action_payload?.established_facts
    ?? context?.established_facts
    ?? null;

  const { fields, written, dropped } = normalizeEstablishedFacts(raw);

  if (dropped.length) {
    console.warn(
      `[EstablishedFacts] dropped for ${contactId}: ` +
      dropped.map(d => `${d.key}="${d.value}" (${d.reason})`).join(', ')
    );
  }

  // Nothing writable is a legitimate outcome, not a failure. The analyzer may
  // have established only that a question was ANSWERED (prior_quotes, email,
  // timeline) with no field behind it — real information, carried on the
  // event for the responder, with nothing to write to the record. Throwing
  // here would retry a no-op three times and then alert on it.
  if (!fields.length) {
    console.log(`[EstablishedFacts] nothing writable for ${contactId} — no-op`);
    return {
      action: 'established_facts_noop',
      contact_id: contactId,
      written: [],
      dropped: dropped.map(d => d.key),
    };
  }

  const result = await updateFields(contactId, fields);
  if (result === 'not_found') throw new Error(`GHL contact ${contactId} not found (deleted?)`);
  if (!result) throw new Error('GHL custom field update failed');

  console.log(
    `[EstablishedFacts] ✅ ${contactId}: ${written.join(', ')} ` +
    `(${fields.map(f => `${f.id}="${f.field_value}"`).join(', ')})`
  );

  return {
    action: 'established_facts_persisted',
    contact_id: contactId,
    written,
    dropped: dropped.map(d => d.key),
    field_count: fields.length,
    fields: fields.map(f => f.id),
  };
}
