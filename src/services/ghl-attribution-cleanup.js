/**
 * Wrong `ghl-attributed` tags, cleaned once — src/services/ghl-attribution-cleanup.js
 *
 * WHY (Joseph Servis, 2026-10-18; the user: "Clear the wrong ones"). Rule 87
 * GHL_ATTR_APPT_BOOKED_VIA_GHL tagged `ghl-attributed`
 * on every A.WE `appt:booked` handoff, and nearly all of them (2,289 of 2,302 in
 * the 30 days to 2026-10-18) were appointments our own LP→GHL sync created: LP /
 * call-center bookings credited to GHL. Its other write, the opportunity field
 * b9gVHuya8iMnJxW4q6Um sent on a CONTACT PUT, never stored anything (0 of 31,711
 * mirrored contacts carry it), so the tag is the only thing to undo. The rule
 * itself now carries `not_sync_created_appointment`.
 *
 * A contact's tag is removed only when the evidence says rule 87 is the sole
 * reason for it:
 *   - rule 87 really ADDED the tag (a completed row that was not a no-op),
 *   - every rule-87 row for the contact points at an appointment our sync
 *     created (an appointment id we cannot place keeps the tag), and
 *   - GHL_ATTR_DIGITAL_ENTRY never touched the contact (any status: a no-op there
 *     means the contact did enter digitally, and the tag is right).
 * The live tag is read before anything is queued; one remove_tag per contact,
 * rule GHL_ATTR_SYNC_CLEANUP, never twice.
 */

export const RULE_KEY = 'GHL_ATTR_SYNC_CLEANUP';
export const TAG = 'ghl-attributed';
export const ATTR_RULE = 'GHL_ATTR_APPT_BOOKED_VIA_GHL';
export const DIGITAL_RULE = 'GHL_ATTR_DIGITAL_ENTRY';

/**
 * Pure. Which contacts lose the tag.
 * @param {object} a
 * @param {Array<{contact_id, status, action, appointment_id}>} a.rule87Rows  every rule-87 add_tag row
 * @param {Set<string>} a.digitalEntryContacts
 * @param {Set<string>} a.syncCreatedIds  appointment ids our sync created
 * @param {Set<string>} [a.alreadyQueued] contacts with a cleanup row already
 * @returns {{ candidates: string[], kept: Record<string, number> }}
 */
export function planAttributionCleanup({ rule87Rows = [], digitalEntryContacts = new Set(), syncCreatedIds = new Set(), alreadyQueued = new Set() } = {}) {
  const byContact = new Map();
  for (const r of rule87Rows) {
    if (!r?.contact_id) continue;
    const list = byContact.get(r.contact_id) || [];
    list.push(r);
    byContact.set(r.contact_id, list);
  }
  const kept = { never_added: 0, digital_entry: 0, not_sync_created: 0, already_queued: 0 };
  const candidates = [];
  for (const [cid, rows] of byContact) {
    const added = rows.some((r) => r.status === 'completed' && r.action !== 'no_op');
    if (!added) { kept.never_added++; continue; }
    if (digitalEntryContacts.has(cid)) { kept.digital_entry++; continue; }
    if (!rows.every((r) => r.appointment_id && syncCreatedIds.has(String(r.appointment_id)))) { kept.not_sync_created++; continue; }
    if (alreadyQueued.has(cid)) { kept.already_queued++; continue; }
    candidates.push(cid);
  }
  return { candidates, kept };
}

export function removeRow(contactId) {
  return {
    event_id: null,
    action_type: 'remove_tag',
    target_system: 'ghl',
    target_entity: 'contact',
    target_id: contactId,
    action_payload: { tag: TAG },
    reasoning: 'Rule 87 tagged ghl-attributed only for appointments our LP→GHL sync created (LP bookings, not GHL); cleanup ruled by the user 2026-10-18.',
    rule_applied: RULE_KEY,
    confidence: 1.0,
    status: 'pending',
    requires_approval: false,
    priority: 200,
  };
}

const PAGE = 1000;
const CHUNK = 200;

async function pageAll(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) return out;
  }
}

/** I/O: everything planAttributionCleanup needs. Throws on any failed read (nothing is queued then). */
export async function readCleanupFacts(db, { readSyncCreatedStarts }) {
  const actions = await pageAll(() => db.from('agent_actions')
    .select('target_id, status, event_id, act:execution_result->>action')
    .eq('rule_applied', ATTR_RULE).eq('action_type', 'add_tag').order('id', { ascending: true }));
  const eventIds = [...new Set(actions.map((a) => a.event_id).filter(Boolean))];
  const apptByEvent = new Map();
  for (let i = 0; i < eventIds.length; i += CHUNK) {
    const { data, error } = await db.from('system_events')
      .select('id, aid:payload->calendar->>appointmentId, aid2:payload->>appointment_id')
      .in('id', eventIds.slice(i, i + CHUNK));
    if (error) throw new Error(`system_events read failed: ${error.message}`);
    for (const e of data || []) apptByEvent.set(e.id, e.aid || e.aid2 || null);
  }
  const rule87Rows = actions.map((a) => ({
    contact_id: a.target_id, status: a.status, action: a.act || null, appointment_id: apptByEvent.get(a.event_id) || null,
  }));
  const apptIds = [...new Set(rule87Rows.map((r) => r.appointment_id).filter(Boolean))];
  const syncCreatedIds = new Set();
  for (let i = 0; i < apptIds.length; i += CHUNK) {
    const m = await readSyncCreatedStarts(db, apptIds.slice(i, i + CHUNK));
    for (const id of m.keys()) syncCreatedIds.add(String(id));
  }
  const contacts = [...new Set(rule87Rows.map((r) => r.contact_id).filter(Boolean))];
  const digitalEntryContacts = new Set();
  const alreadyQueued = new Set();
  for (let i = 0; i < contacts.length; i += CHUNK) {
    const ids = contacts.slice(i, i + CHUNK);
    const { data, error } = await db.from('agent_actions').select('target_id, rule_applied')
      .in('rule_applied', [DIGITAL_RULE, RULE_KEY]).in('target_id', ids).limit(5000);
    if (error) throw new Error(`agent_actions read failed: ${error.message}`);
    for (const r of data || []) (r.rule_applied === RULE_KEY ? alreadyQueued : digitalEntryContacts).add(r.target_id);
  }
  return { rule87Rows, syncCreatedIds, digitalEntryContacts, alreadyQueued };
}

/**
 * The run. Dry run: counts and a sample, nothing read live, nothing written.
 * Live: read each candidate (up to maxRemovals) live and queue one remove_tag
 * when the tag is still there.
 * deps: { db, readSyncCreatedStarts, getContact(id) → contact|null, sleep, log }
 */
export async function runAttributionCleanup({ dryRun = true, maxRemovals = 200, throttleMs = 250 } = {}, deps = {}) {
  const { db, getContact } = deps;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.log || console.log;
  const facts = await readCleanupFacts(db, deps);
  const { candidates, kept } = planAttributionCleanup(facts);
  const report = { dry_run: dryRun, candidates: candidates.length, kept, sample: candidates.slice(0, 10), queued: 0, tag_already_gone: 0, unreadable: 0, errors: [] };
  if (dryRun) {
    log(`[AttrCleanup] DRY: ${candidates.length} contacts would lose ${TAG} (kept ${JSON.stringify(kept)})`);
    return report;
  }
  const batch = candidates.slice(0, Math.max(0, maxRemovals));
  for (let i = 0; i < batch.length; i++) {
    const id = batch[i];
    if (i > 0 && throttleMs > 0) await sleep(throttleMs);
    let contact = null;
    try { contact = await getContact(id); } catch (err) { report.errors.push(`${id}: read ${String(err?.message || err).slice(0, 120)}`); }
    if (!contact) { report.unreadable++; continue; }
    const tags = (contact.tags || []).map((t) => String(t).toLowerCase());
    if (!tags.includes(TAG)) { report.tag_already_gone++; continue; }
    const { error } = await db.from('agent_actions').insert(removeRow(id));
    if (error) { report.errors.push(`${id}: queue ${error.message}`); continue; }
    report.queued++;
  }
  report.remaining = Math.max(0, candidates.length - batch.length);
  report.errors = report.errors.slice(0, 50);
  log(`[AttrCleanup] LIVE: queued ${report.queued}, already gone ${report.tag_already_gone}, unreadable ${report.unreadable}, remaining ${report.remaining}`);
  return report;
}
