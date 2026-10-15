// ─── release_rehash_owner — src/actions/handlers/rehash-owner.js ─────────────
//
// The user, 2026-10-09: "I want to unassign the rehash team members' ownership
// of the lead after 30 days … The idea is to remove the rehash rep after rehash
// is completed." Queued by src/jobs/rehash-tag-sweep.js when a contact's rehash
// stage ends (30 days after the demo, a newer lead, or our system already took
// the lead out).
//
// Clears the GHL owner (contact.assignedTo) ONLY when the owner, read live right
// now, is a rehash team member (REHASH_TEAM_USER_IDS, default John Manieri). A
// contact a person reassigned to anyone else in the meantime is left alone. The
// write is read back: an owner GHL kept is a failure, not a success.
//
// 2026-10-15: the GHL rehash workflow now adds the rep as a FOLLOWER and leaves
// the owner as the Reece team user, and removes the follower itself after 30
// days. So this action normally finds no rehash owner and does nothing; it
// stays for contacts entered before that change.

import { ghlFetch } from '../helpers.js';
import { rehashTeamUserIds } from '../../agentic/rehash-state.js';

export async function executeReleaseRehashOwner(action, _context = {}, deps = {}) {
  const contactId = action.target_id;
  if (!contactId) throw new Error('release_rehash_owner: target_id is required');
  const fetch = deps.ghlFetch || ghlFetch;
  const team = deps.team || rehashTeamUserIds();

  const before = (await fetch('GET', `/contacts/${contactId}`))?.contact;
  if (!before) throw new Error(`release_rehash_owner: contact ${contactId} not found`);
  const owner = before.assignedTo ? String(before.assignedTo) : null;
  if (!owner) return { action: 'no_owner', contact_id: contactId };
  if (!team.has(owner)) return { action: 'owner_not_rehash_team', contact_id: contactId, owner };

  await fetch('PUT', `/contacts/${contactId}`, { assignedTo: null });
  const after = (await fetch('GET', `/contacts/${contactId}`))?.contact;
  const still = after?.assignedTo ? String(after.assignedTo) : null;
  if (still === owner) throw new Error(`release_rehash_owner: GHL kept owner ${owner} on ${contactId}`);
  console.log(`[RehashOwner] ${contactId}: rehash owner ${owner} released (now ${still || 'unassigned'})`);
  return { action: 'owner_released', contact_id: contactId, previous_owner: owner, owner_now: still };
}
