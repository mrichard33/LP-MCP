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
 * Pure. The GHL user a call booking goes to (the user, 2026-10-09, after the
 * clash: pre-demo leads use Confirmation Call too, so the rehash default must
 * not touch it).
 *   Rehash Call calendar  the named assignee → the rep on the lead
 *                         (contactRep, rehashRepFor) → the contact's owner when
 *                         that owner is on the rehash team → the Rehash rep.
 *   Confirmation Call     the named assignee only; otherwise nobody, as before
 *                         #1223 (GHL assigns it).
 *   any other calendar    the named assignee only.
 */
export function callAssigneeFor({ isRehashCalendar = false, explicit, contactRep = null, contactOwner, team = null } = {}, env = process.env) {
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  if (clean(explicit)) return clean(explicit);
  if (!isRehashCalendar) return null;
  // 2026-10-15: the rep on the lead (rehashRepFor) comes before the owner.
  if (clean(contactRep)) return clean(contactRep);
  const owner = clean(contactOwner);
  if (owner && team && team.has(owner)) return owner;
  return confirmationCallAssignee(env);
}

// GHL custom field "Assigned To (User ID)" (ghl-field-decoder.js). On the rehash
// contact read live on 2026-10-15 it held the Rehash rep's id while the API's
// `followers` came back empty, so it is the fallback for the follower.
export const ASSIGNED_TO_USER_FIELD_ID = '7YkTgCb9IXsoQWDsP50E';

/**
 * Pure. The rehash rep for ONE lead (the user, 2026-10-15: "Can we assign it to
 * the follower assigned to the lead?"). The GHL workflow now makes the rehash
 * rep a FOLLOWER and leaves the owner as the Reece team user, so the bot's sends
 * and a person's sends stay apart; a fixed John Manieri id here would ignore
 * whoever the workflow actually put on the lead.
 *   1. a follower on the contact (with `team`: only one on REHASH_TEAM_USER_IDS)
 *   2. the "Assigned To (User ID)" custom field (with `team`: only a team member)
 *   3. null: the caller keeps its old default (the Rehash rep)
 * @param {object|null} contact  a GHL contact (followers, customFields)
 * @param {Set<string>} [team]   rehash team user ids, to rank several followers
 */
export function rehashRepFor(contact, team = null) {
  if (!contact || typeof contact !== 'object') return null;
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const followers = (Array.isArray(contact.followers) ? contact.followers : [])
    .map((f) => clean(typeof f === 'string' ? f : f?.id || f?.userId)).filter(Boolean);
  // With a team given, only a team member counts (2026-10-23): Mark Test's only
  // follower was a "Reece …" GHL user, and the F.0 texts invited "a quick call
  // with Reece". A non-team follower or field value falls through to null, so
  // the caller keeps its default (the Rehash rep). No team: any follower, as before.
  const onTeam = (id) => !team?.size || team.has(id);
  const follower = followers.find((f) => team?.has(f)) || (team?.size ? null : followers[0]);
  if (follower) return follower;
  const field = (Array.isArray(contact.customFields) ? contact.customFields : [])
    .find((f) => f?.id === ASSIGNED_TO_USER_FIELD_ID);
  const fieldId = clean(field?.value ?? field?.fieldValue);
  return fieldId && onTeam(fieldId) ? fieldId : null;
}

/**
 * Pure. The GHL user a Confirmation Call goes to.
 * @deprecated 2026-10-09 — assigned every Confirmation Call to the Rehash rep,
 * pre-demo ones included. Use callAssigneeFor.
 *   explicit      an assignee the caller named on the booking
 *   contactOwner  the contact's owner in GHL (contact.assignedTo)
 */
export function confirmationCallAssigneeFor({ explicit, contactOwner } = {}, env = process.env) {
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return clean(explicit) || clean(contactOwner) || confirmationCallAssignee(env);
}
