/**
 * F.0 test link — src/siro/f0-test-link.js (the user, 2026-10-21)
 *
 * Pure. There was no supported way to test F.0 v2 end to end on a test
 * contact: the 2026-10-21 run linked Mark Test (hZOcPk6XmMvWVvjZJ7mz) to Mr.
 * Jackson's visit by hand (a cloned siro_recordings row + a hand-made
 * rehash_stage row), the rehash tag sweep closed that stage at 23:13Z because
 * Mark Test's own LP lead 583364 is 'Data', and every generate call after it
 * was suppressed rehash_ended.
 *
 * F0_TEST_LINKS = "testContactId:realLpLeadId,…" (e.g.
 * "hZOcPk6XmMvWVvjZJ7mz:583780"). A contact is linked only when it is listed
 * AND carries the tag aios-test, so a stray entry can never touch a real lead.
 * When linked, F.0 reads the visit of the real LP lead (read-only) and treats
 * the test contact as an unsold post-demo lead in rehash; nothing is ever
 * written to, sent to, tagged on or carded for the real lead's own GHL contact
 * or LP lead. Never throws: a bad value is no link.
 */

export const TEST_LINK_TAG = 'aios-test';

const GHL_ID_RX = /^[A-Za-z0-9]{10,40}$/;
const LP_LEAD_RX = /^\d{3,10}$/;

/** "c1:583780, c2:1" → Map(contactId → lpLeadId). A malformed pair is skipped. */
export function parseTestLinks(raw) {
  const out = new Map();
  try {
    for (const part of String(raw || '').split(',')) {
      const i = part.indexOf(':');
      if (i <= 0) continue;
      const contactId = part.slice(0, i).trim();
      const lpLeadId = part.slice(i + 1).trim();
      if (GHL_ID_RX.test(contactId) && LP_LEAD_RX.test(lpLeadId)) out.set(contactId, lpLeadId);
    }
  } catch { /* a bad value is no link */ }
  return out;
}

/** Every contact listed in F0_TEST_LINKS, tag or not (the rehash sweep skips them all). */
export function testLinkedContactIds(env = process.env) {
  return new Set(parseTestLinks(env?.F0_TEST_LINKS).keys());
}

/**
 * @param {string} contactId
 * @param {string[]} tags  the contact's current tags
 * @returns {{ lpLeadId: string } | null}
 */
export function testLinkFor(contactId, tags, env = process.env) {
  try {
    if (!contactId) return null;
    const lpLeadId = parseTestLinks(env?.F0_TEST_LINKS).get(String(contactId));
    if (!lpLeadId) return null;
    const tagged = (Array.isArray(tags) ? tags : []).some(t => String(t).trim().toLowerCase() === TEST_LINK_TAG);
    return tagged ? { lpLeadId } : null;
  } catch {
    return null;
  }
}
