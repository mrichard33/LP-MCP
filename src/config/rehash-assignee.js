/**
 * Who a Confirmation Call is assigned to — src/config/rehash-assignee.js
 *
 * The user, 2026-10-09: "the confirmation calls should be done from GHL and stay
 * on the GHL calendar. These should actually get assigned to the Rehash team
 * members calendar." A Confirmation Call never reaches LP (PRs #1218/#1220), so
 * the person who makes it is whoever the GHL appointment is assigned to. Before
 * this, our bookings named no assignee and GHL picked one.
 *
 * Order: an explicit assignee on the booking → the contact's owner (the rehash
 * entry makes the Rehash rep the owner, not just a follower) → the Rehash rep.
 *
 * TYcZ9DcNkuPCFYsFxRFV is John Manieri, the Rehash rep: the HL mirror's GHL
 * workflow action "Add Rehash Team as Followers" adds that user, commented
 * "John Manieri". CONFIRMATION_CALL_ASSIGNED_USER_ID overrides it; 'off' turns
 * the default off (the booking then goes out with no assignee, as before).
 */

export const REHASH_REP_USER_ID_DEFAULT = 'TYcZ9DcNkuPCFYsFxRFV';

/** The Rehash rep's GHL user id, or null when switched off. */
export function confirmationCallAssignee(env = process.env) {
  const raw = String(env.CONFIRMATION_CALL_ASSIGNED_USER_ID ?? '').trim();
  if (raw.toLowerCase() === 'off') return null;
  return raw || REHASH_REP_USER_ID_DEFAULT;
}

/**
 * Pure. The GHL user a Confirmation Call goes to.
 *   explicit      an assignee the caller named on the booking
 *   contactOwner  the contact's owner in GHL (contact.assignedTo)
 */
export function confirmationCallAssigneeFor({ explicit, contactOwner } = {}, env = process.env) {
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return clean(explicit) || clean(contactOwner) || confirmationCallAssignee(env);
}
