/**
 * F.0 v2 post-demo interrupts — src/siro/f0-interrupts.js (2026-10-16)
 *
 * Pure. Runs before any model call for workflow_code 'F.0', ahead of the
 * orchestrator's existing interrupt list (send gate / DNC / stop-bot,
 * stop-seinfeld, booked, follow-up promise, layer-3 suppress, recent reply).
 * Returns null (generate), { suppress, terminal } or { hold, reason }.
 *
 * Order is the order of certainty: a sale ends the sequence before anything
 * else is asked (C.0 owns customers), then the facts that end the post-demo
 * track, then the ones that hand the thread to a person or to the reply path,
 * and last the wait for the Siro visit data.
 *
 * Wait for Siro: a demo younger than SIRO_WAIT_MAX_H (24h) with no
 * context_ready recording is held SIRO_WAIT_HOLD_H (2h) once the on-demand
 * ensure has been tried; past the window the message is written from the LP
 * notes alone (the prompt's no-visit-data variant).
 */

export const F0_SUPPRESS_REASONS = Object.freeze([
  'sold', 'not_post_demo', 'rehash_ended', 'newer_lead', 'booked', 'note_dq',
  'disqualified', 'post_demo_stop', 'lead_replied_since_last_touch', 'rehash_owned',
]);

const SOLD_TAGS = ['deal-won'];
const DQ_TAGS = ['lp-disqualified'];

/**
 * @param {object} i
 * @param {boolean} i.lpSold              LP closed-won / Sale, or a P2 customer
 * @param {boolean} i.unsoldPostDemo      past the demo (or rehash) and not sold
 * @param {boolean} i.rehashActive        in the 30-day rehash window (rehash_stage open / OPPFDN)
 * @param {boolean} i.newerLead           a newer lp_leads row on the prospect
 * @param {boolean} i.appointmentOnFile   a future appointment (a rebook happened)
 * @param {boolean} i.noteDq              a team note says we cannot run the lead
 * @param {boolean} i.postDemoStop        the sticky two-no stop was sent
 * @param {boolean} i.repliedSinceLastTouch the lead texted after our last F.0 touch
 * @param {boolean} i.rehashOwned         John owns the lead (rehash-owned.js, REHASH_OWNED_MODE=live)
 * @param {string[]} i.tags               lowercased contact tags
 * @param {object|null} i.siroFacts       buildPresentationFacts() or null
 * @param {number|null} i.demoAgeH        hours since the demo
 * @param {number} [i.waitMaxH=24]
 * @param {number} [i.waitHoldH=2]
 */
export function postDemoInterrupt({
  lpSold = false, unsoldPostDemo = false, rehashActive = false, newerLead = false,
  appointmentOnFile = false, noteDq = false, postDemoStop = false,
  repliedSinceLastTouch = false, rehashOwned = false, tags = [], siroFacts = null, demoAgeH = null,
  waitMaxH = 24, waitHoldH = 2,
} = {}) {
  const t = new Set((tags || []).map(x => String(x).toLowerCase()));
  const end = (suppress) => ({ suppress, terminal: true });

  if (lpSold || SOLD_TAGS.some(x => t.has(x))) return end('sold');
  if (!unsoldPostDemo) return end('not_post_demo');
  if (!rehashActive) return end('rehash_ended');
  if (newerLead) return end('newer_lead');
  // 2026-10-21 (Mark): a Rehash Call is booked, LP has the visit set, or John
  // tagged the contact rehash-owned: John owns the lead, so no F.0 touch goes.
  if (rehashOwned) return end('rehash_owned');
  if (appointmentOnFile) return end('booked');
  if (noteDq) return end('note_dq');
  if (DQ_TAGS.some(x => t.has(x))) return end('disqualified');
  if (postDemoStop) return end('post_demo_stop');
  // The reply path owns a live thread; the workflow's pause gate normally
  // catches this first, so it is not terminal: the next cycle may go.
  if (repliedSinceLastTouch) return { suppress: 'lead_replied_since_last_touch', terminal: false };

  if (!siroFacts && Number.isFinite(demoAgeH) && demoAgeH < waitMaxH) {
    return { hold: Math.max(1, Math.round(waitHoldH)), reason: 'awaiting_siro' };
  }
  return null;
}
