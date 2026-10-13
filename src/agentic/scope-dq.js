// ─── A home we cannot work on: ask a person to set ND — src/agentic/scope-dq.js ─
//
// WHY (the user, 2026-10-13)
//   Both bots turn away a commercial property or a rental property
//   (job-scope.js). The user: "It should then update the
//   lead as ND status." LP's API has no call that changes a disposition (the
//   client writes leads, appointments, prospect fields, DNC and notes only), so
//   the user approved the stopgap: a note on the LP lead, and ONE card to
//   #contact-center asking a person to set ND in LP.
//
//   - Only the lead's OWN words in THIS message count (job-scope.js's
//     readers), whether or not a guard had to rewrite the reply: a draft that
//     already said no is still a turn-away. Said earlier is not a new one.
//   - Below the three-opening minimum is not included (not asked for).
//   - Commercial and rental only: manufactured homes and tall buildings were
//     not part of the ask.
//   - Once per contact per kind, ever (audit `scope_dq`, permanent). No Five9
//     callback and no `callback:requested` tag (NO_DIAL_REASONS): the bot said
//     no, so nobody calls to sell. No stop-bot (not ruled).
//   - SCOPE_DQ_MODE off|shadow|live, default live (the user asked for it).
//
// PURE. Every write is a deps call (production deps: src/services/scope-dq-io.js).

import { jobScopeFromThread } from './job-scope.js';

export const SCOPE_DQ_REASON = 'scope_dq';
export const SCOPE_DQ_AUDIT = 'scope_dq';

const LABEL = { commercial: 'a commercial property', rental: 'a rental property' };

/** SCOPE_DQ_MODE: off | shadow | live (default live). */
export function scopeDqMode(env = process.env) {
  const v = String(env?.SCOPE_DQ_MODE || 'live').trim().toLowerCase();
  return v === 'off' || v === 'shadow' ? v : 'live';
}

/** 'commercial' | 'rental' | null, from the lead's newest message. Pure. */
export function scopeDqKind(inbound) {
  if (!String(inbound || '').trim()) return null;
  const { block } = jobScopeFromThread([], inbound);
  return block === 'commercial' || block === 'rental' ? block : null;
}

/** The note on the LP prospect. Pure. */
export function lpNoteText(kind) {
  return `Bot: the lead said the home is ${LABEL[kind] || 'one we do not work on'}, which we do not work on. `
    + 'The bot told them we cannot help with this home and booked nothing. Set this lead to ND.';
}

/** The card's extra lines. Pure. */
export function cardExtra({ kind, prospectId = null, leadId = null, note = 'skipped', phone = null }) {
  const lp = prospectId
    ? `LP: prospect ${prospectId}${leadId ? ` · lead ${leadId}` : ''}`
    : 'LP: no LP lead is linked to this contact. Search LP by phone; if there is no lead, there is nothing to set.';
  const noteLine = note === 'added' ? 'LP note: added.'
    : note === 'failed' ? 'LP note: could NOT be added (LP refused or was unreachable).'
      : 'LP note: not added (no LP prospect).';
  // The full number, digits only (the user, 2026-10-13), so LP can be searched by it.
  const digits = String(phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return [`Why: ${LABEL[kind] || kind}.`, digits ? `Phone: ${digits}` : null, lp, noteLine].filter(Boolean).join('\n');
}

/**
 * Note + card, once per contact per kind. Never throws.
 * @param {{ contactId, kind, channel, inbound, firstName?, phone?, nowMs? }} a
 * @param {{ mode?, resolveLp, addLpNote, filterNew, recordPosted, routeHandoff, log? }} deps
 * @returns {Promise<{ done: boolean, reason?: string, note?: string, routed?: boolean }>}
 */
export async function runScopeDq({ contactId, kind, channel = 'sms', inbound = '', firstName = null, phone = null, nowMs = Date.now() }, deps) {
  const log = deps.log || ((m) => console.log(m));
  if (!contactId || !kind) return { done: false, reason: 'not_applicable' };
  const mode = deps.mode || 'live';
  if (mode === 'off') return { done: false, reason: 'mode_off' };
  try {
    const items = [{ key: contactId, reason: kind }];
    const { fresh } = await deps.filterNew({ audit: SCOPE_DQ_AUDIT, items, nowMs });
    if (!fresh.length) { log(`[ScopeDq] ${contactId} ${kind}: already asked for ND, not repeated`); return { done: false, reason: 'already_done' }; }
    if (mode === 'shadow') { log(`[ScopeDq] shadow ${contactId} ${kind}: would add the LP note and post the set-ND card`); return { done: false, reason: 'shadow' }; }

    let lp = { prospectId: null, leadId: null };
    try { lp = (await deps.resolveLp(contactId)) || lp; } catch (err) { log(`[ScopeDq] ${contactId} LP lookup failed: ${err.message}`); }
    let note = 'skipped';
    if (lp.prospectId) {
      try { await deps.addLpNote(lp.prospectId, lpNoteText(kind)); note = 'added'; } catch (err) { note = 'failed'; log(`[ScopeDq] ${contactId} LP note failed: ${err.message}`); }
    }
    const routed = await deps.routeHandoff({
      contactId, reason: SCOPE_DQ_REASON, channel, inbound, firstName, nowMs,
      extra: cardExtra({ kind, prospectId: lp.prospectId, leadId: lp.leadId, note, phone }),
    });
    await deps.recordPosted({ audit: SCOPE_DQ_AUDIT, items, permanent: true, nowMs });
    log(`[ScopeDq] ${contactId} ${kind}: LP note ${note}, card routed`);
    return { done: true, note, routed: !!routed?.routed };
  } catch (err) {
    log(`[ScopeDq] ${contactId} ${kind} failed: ${err.message}`);
    return { done: false, reason: 'error' };
  }
}
