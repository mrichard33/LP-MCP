// ─── Has this lead had a demo? — src/agentic/post-demo-lead.js ───────────────
//
// WHY (the user, 2026-10-13)
//   "If the appointment is post demo then we do not need to worry about these
//   requirements. We can assume the lead already meets the requirements."
//   The rep qualified the home in person, so a lead past its demo is never
//   asked the qualifying questions again and never declined by job-scope.js
//   (rental, commercial, the three-opening minimum and its check), the tenant
//   decline (non-owner.js), the set-ND card (scope-dq.js) or an LP note that
//   only says rental / commercial / below minimum (lead-facts.js).
//
//   Post demo, by any of:
//   - the current LP disposition is a demo (demo-truth.js: Sale, OPPFDN,
//     NoRehash, FDNS, SW, PM), or LP has it closed won;
//   - the contact carries `lp-demo-completed`, `stage:post-appointment`,
//     `rehash` or `active-f.0`, or its stage tag is `stage:post-appointment`.
//   NOT `lp.demo_completed`: LP sets that for NOC, where the rep did not demo
//   (demo-truth.js).
//
// PURE. No I/O.

import { isDemoDisposition } from '../demo-truth.js';

const POST_DEMO_TAGS = new Set(['lp-demo-completed', 'stage:post-appointment', 'rehash', 'active-f.0']);

/**
 * @param {{ lp?: object|null, tags?: string[], stageTag?: string|null }} a
 *   lp: the reply context's `context.lp` (disposition code in `disposition`)
 * @returns {boolean}
 */
export function isPostDemoLead({ lp = null, tags = [], stageTag = null } = {}) {
  if (lp && (isDemoDisposition(lp.disposition ?? lp.disposition_code) || lp.closed_won === true)) return true;
  const list = (Array.isArray(tags) ? tags : []).map(t => String(t).trim().toLowerCase());
  if (list.some(t => POST_DEMO_TAGS.has(t))) return true;
  return String(stageTag || '').trim().toLowerCase() === 'stage:post-appointment';
}
