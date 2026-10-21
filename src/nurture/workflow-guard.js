/**
 * Active-workflow guard for the nurture generate route — src/nurture/workflow-guard.js
 * (Mark, 2026-10-21, F.0 v2 position-0 handoff, Change 2)
 *
 * Pure. A generate call writes draft fields onto the contact, so only the
 * workflow the contact is actually in may ask for one: the contact's "Active
 * Marketing Workflow ID" (GHL field VFSNtEqSUh5yX7RyktBj) must be the GHL id of
 * the workflow asking. A stale enrollment (a contact moved to S4.5 while an old
 * F.0 run still loops) would otherwise overwrite the live workflow's drafts.
 *
 * NURTURE_WORKFLOW_IDS maps a workflow_code to its GHL id:
 *   "F.0:<f0 v2 id>,S4.5:f99fba97-6d2f-4fd6-966c-b5e5e36f8938"
 * (the S4.5 id is the one the field holds for S4.5 contacts in the HL mirror,
 * 2026-10-21; the handoff's "…-8e7f2ff2e2bd" was a typo). A code with no entry
 * is not checked (today's behavior). A code WITH an entry is checked fail
 * closed: an empty field or an unreadable contact refuses, like the decision
 * engine's custom_field_eq.
 */

export const ACTIVE_MARKETING_WORKFLOW_FIELD_ID = 'VFSNtEqSUh5yX7RyktBj';

/** "F.0:<id>,S4.5:<id>" → Map(code → id). A malformed pair is skipped. Pure. */
export function parseWorkflowIds(raw) {
  const out = new Map();
  for (const part of String(raw || '').split(',')) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const code = part.slice(0, i).trim();
    const id = part.slice(i + 1).trim();
    if (code && id) out.set(code, id);
  }
  return out;
}

/**
 * @param {{code: string, mapping: Map<string,string>, activeId: string|null}} o
 *   activeId  the field's value; '' when empty, null when the contact was unreadable
 * @returns {{ decision: 'skip'|'allow'|'refuse', expected: string|null, active: string|null }}
 */
export function activeWorkflowDecision({ code, mapping, activeId }) {
  const expected = mapping?.get(String(code || '')) || null;
  if (!expected) return { decision: 'skip', expected: null, active: activeId ?? null };
  const active = typeof activeId === 'string' ? activeId.trim() : null;
  return { decision: active && active === expected ? 'allow' : 'refuse', expected, active: active || null };
}
