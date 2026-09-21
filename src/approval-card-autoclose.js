/**
 * Approval card auto-close — src/approval-card-autoclose.js
 *
 * WHY (2026-09-21): an approval card only closed when a human resolved it
 * through resolveApproval. Every other path moved the ACTIONS and left the
 * CARD pending forever: Phase 2 auto-execute, Phase 3 auto-reject, the
 * approve_action tool, the dashboard. 118 such cards had built up, oldest
 * from 2026-04-24, and they looked like live decisions to anyone reading them.
 *
 * RULE: a pending card with NO action still in pending_approval is closed as
 * 'auto_closed'. A card with ANY action still waiting is left alone — a human
 * still owes that decision.
 *
 * FAIL CLOSED: if the read of agent_actions fails, nothing is closed. Closing
 * on a failed read would hide a live decision; leaving a stale card open for
 * one more pass costs nothing.
 *
 * RACE-SAFE: the UPDATE re-checks status='pending', so a card a human is
 * resolving at the same moment is never overwritten.
 *
 * Kill switch: APPROVAL_CARD_AUTOCLOSE_DISABLED=true.
 */
import supabase from './supabase.js';

// Cards per page. Kept small because every card's action_ids go into one
// .in() filter, and PostgREST puts that list in the URL. The largest
// action_ids seen live is 11, so 50 cards is ~550 ids — well inside a URL.
const PAGE_SIZE = 50;
// Upper bound per pass, so one pass can never run away.
const MAX_PAGES = 10;

/**
 * Pure: which of these cards are stale, given the set of action ids still in
 * pending_approval? Exported for offline tests.
 */
export function selectStaleCards(cards, waitingIds) {
  return (cards || []).filter((c) => !(c.action_ids || []).some((id) => waitingIds.has(id)));
}

export async function closeStaleApprovalCards({ dryRun = false, client = supabase } = {}) {
  if (process.env.APPROVAL_CARD_AUTOCLOSE_DISABLED === 'true') {
    return { closed: 0, checked: 0, disabled: true };
  }

  let checked = 0;
  let closed = 0;
  const closedRefs = [];
  // Cards we looked at and deliberately LEFT open. A closed card drops out of
  // the 'pending' result set, so the next read must skip only these or it
  // would step over rows it never examined. Advancing an offset rather than
  // re-reading the same page keeps `page` incrementing on every iteration,
  // which is what makes MAX_PAGES a real bound instead of an advisory one.
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const { data: cards, error: cardErr } = await client
      .from('groupme_approval_requests')
      .select('id, short_ref, action_ids')
      .eq('status', 'pending')
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (cardErr) {
      console.warn(`[ApprovalCards] card read failed (nothing closed): ${cardErr.message}`);
      return { closed, checked, error: cardErr.message };
    }
    if (!cards?.length) break;
    checked += cards.length;

    const allIds = [...new Set(cards.flatMap((c) => c.action_ids || []))];
    let waiting = new Set();
    if (allIds.length) {
      const { data: stillWaiting, error: waitErr } = await client
        .from('agent_actions')
        .select('id')
        .in('id', allIds)
        .eq('status', 'pending_approval');
      if (waitErr) {
        console.warn(`[ApprovalCards] action read failed (fail closed, nothing closed): ${waitErr.message}`);
        return { closed, checked, error: waitErr.message };
      }
      waiting = new Set((stillWaiting || []).map((r) => r.id));
    }

    const stale = selectStaleCards(cards, waiting);
    if (stale.length && !dryRun) {
      const { error: updErr } = await client
        .from('groupme_approval_requests')
        .update({ status: 'auto_closed', resolved_by: 'system:auto_close', resolved_at: new Date().toISOString() })
        .in('id', stale.map((c) => c.id))
        .eq('status', 'pending');
      if (updErr) {
        console.warn(`[ApprovalCards] close failed: ${updErr.message}`);
        return { closed, checked, error: updErr.message };
      }
    }
    if (stale.length) {
      closed += stale.length;
      closedRefs.push(...stale.map((c) => c.short_ref));
    }

    // A dry run closes nothing, so every card stays in the result set.
    offset += dryRun ? cards.length : cards.length - stale.length;
    if (cards.length < PAGE_SIZE) break;
  }

  if (closed) {
    const shown = closedRefs.slice(0, 20).join(', ');
    console.log(`[ApprovalCards] ${dryRun ? 'DRY RUN would auto-close' : 'auto-closed'} ${closed} stale card(s): ${shown}${closedRefs.length > 20 ? ', …' : ''}`);
  }
  return { closed, checked, dry_run: !!dryRun };
}
