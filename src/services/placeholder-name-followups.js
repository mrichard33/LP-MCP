/**
 * After a real name replaces the chat widget's placeholder — src/services/placeholder-name-followups.js
 *
 * 2026-10-16 (Melissa, GHL 6U6uceZGMQRz8XEQc9Lk, LP lead 584060). Her chat
 * contact was "Guest Visitor Anlxy". The bot saved "Melissa" but the surname
 * stayed, and GHL's A.WE Window Estimate Handler created the P1 opportunity
 * from {{contact.name}} seven seconds after the booking: "Melissa Visitor
 * Anlxy". GHL creates that opportunity, so code cannot stop it; what code can
 * do is (1) save the name before booking (fast-lane.js) and (2) rename any
 * open opportunity that still carries the placeholder once the real name
 * lands, and (3) re-send an LP lead that create_lp_lead held for want of a
 * name (tag `name-placeholder`).
 *
 * Pure pieces are exported for scripts/test-melissa-trace.js; every network
 * and database reach goes through `deps`.
 */

const PLACEHOLDER_FULL_RX = /\bguest\s+visitor\s+[a-z0-9]+\b/gi;
const PLACEHOLDER_SURNAME_RX = /\s*\bvisitor\s+[a-z0-9]{3,8}\b/gi;
const NAME_PLACEHOLDER_TAG = 'name-placeholder';

/** Does a name still carry the widget's placeholder? Pure. */
export function hasPlaceholderToken(name) {
  const n = String(name || '');
  return /\bguest\s+visitor\b/i.test(n) || /\bvisitor\s+[a-z0-9]{3,8}\b/i.test(n);
}

/**
 * The opportunity name with the placeholder replaced by the real name:
 * "Melissa Visitor Anlxy" → "Melissa", "Guest Visitor abcde — 10/18 2:00 PM"
 * → "Melissa — 10/18 2:00 PM". Pure.
 */
export function renamedOpportunityName(oppName, cleanName) {
  const real = String(cleanName || '').trim();
  if (!real) return null;
  const out = String(oppName || '')
    .replace(PLACEHOLDER_FULL_RX, real)
    .replace(PLACEHOLDER_SURNAME_RX, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return out || real;
}

/** The open opportunities to rename, as [{ id, from, to }]. Pure. */
export function opportunityRenames(opps, cleanName) {
  const out = [];
  for (const o of Array.isArray(opps) ? opps : []) {
    if (!o?.id || String(o.status || 'open').toLowerCase() !== 'open') continue;
    if (!hasPlaceholderToken(o.name)) continue;
    const to = renamedOpportunityName(o.name, cleanName);
    if (to && to !== o.name) out.push({ id: o.id, from: o.name, to });
  }
  return out;
}

/**
 * Rename the contact's open "Visitor" opportunities (one update_opportunity
 * row each, rule PLACEHOLDER_NAME_REPAIR) and re-send a held LP lead.
 * Best-effort: never throws.
 *
 * deps: fetchOpportunities(contactId) → opps[], insertAction(row),
 *       readTags(contactId) → string[] (optional), enrollLpLeadCreation({ contactId }) (optional), log/warn.
 */
export async function repairAfterNamePromotion(contactId, { firstName, lastName = null } = {}, deps = {}) {
  const log = deps.log || ((m) => console.log(m));
  const warn = deps.warn || ((m) => console.warn(m));
  const cleanName = [firstName, lastName].filter(Boolean).join(' ').trim();
  const result = { renamed: 0, lp_redriven: false };
  if (!contactId || !cleanName) return result;
  try {
    const opps = await deps.fetchOpportunities(contactId);
    for (const r of opportunityRenames(opps, cleanName)) {
      await deps.insertAction({
        action_type: 'update_opportunity', target_system: 'ghl', target_entity: 'contact', target_id: contactId,
        action_payload: { opportunity_id: r.id, name: r.to },
        reasoning: `The opportunity still carried the chat placeholder ("${r.from}"); renamed to the visitor's real name`,
        confidence: 1.0, rule_applied: 'PLACEHOLDER_NAME_REPAIR', status: 'pending', requires_approval: false,
      });
      result.renamed++;
    }
    if (result.renamed) log(`[NameRepair] ${contactId}: ${result.renamed} opportunity name(s) queued for "${cleanName}"`);
  } catch (err) {
    warn(`[NameRepair] opportunity rename failed for ${contactId}: ${err.message}`);
  }
  // An LP lead held for want of a name goes now (create_lp_lead / the addlead
  // proxy tag the contact name-placeholder and skip).
  try {
    const tags = deps.readTags ? await deps.readTags(contactId) : null;
    if (Array.isArray(tags) && tags.includes(NAME_PLACEHOLDER_TAG) && deps.enrollLpLeadCreation) {
      await deps.enrollLpLeadCreation({ contactId, force: true, notify: false });
      result.lp_redriven = true;
      log(`[NameRepair] ${contactId}: LP lead held for a name re-sent`);
    }
  } catch (err) {
    warn(`[NameRepair] LP re-send failed for ${contactId}: ${err.message}`);
  }
  return result;
}
