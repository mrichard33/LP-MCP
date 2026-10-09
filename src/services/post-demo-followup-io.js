// ─── Post-demo follow-up filing — src/services/post-demo-followup-io.js ──────
//
// WHY (Mark, 2026-10-09). Melissa Watts texted "Please follow up with me early
// November" and then "Follow up in November please." The bot offered two slots
// both times and nobody was told to call her in November. A dated follow-up
// the bot confirms ("That works, Melissa. I'll check back in November.") is a
// promise, so it is filed for a person after the send:
//   1. a GHL task "Follow up — {name} asked for {label}", due at 9:00 AM ET on
//      that day, assigned to the rehash rep (the first REHASH_TEAM_USER_IDS id);
//   2. the tag `followup-requested`;
//   3. a contact note with the date, so the promise survives a task API failure.
// Once per contact per date (audit_posted_items, audit `post_demo_followup`):
// Melissa's second "November" files nothing new. Fire-and-forget: never blocks
// or fails the reply. Every step is best-effort and logged.
//
// deps (tests): { ghlFetch, applyGHLTag, addGHLNote, filterNew, recordPosted, emitEvent, env, log }

import { rehashTeamUserIds } from '../agentic/rehash-state.js';

export const FOLLOWUP_TAG = 'followup-requested';
export const FOLLOWUP_AUDIT = 'post_demo_followup';

async function withDefaults(deps) {
  const d = { ...deps };
  d.env ||= process.env;
  d.log ||= console.log;
  if (!d.ghlFetch) d.ghlFetch = (await import('../actions/helpers.js')).ghlFetch;
  if (!d.applyGHLTag || !d.addGHLNote) {
    const ghl = await import('../ghl.js');
    d.applyGHLTag ||= ghl.applyGHLTag;
    d.addGHLNote ||= ghl.addGHLNote;
  }
  if (!d.filterNew || !d.recordPosted) {
    const posted = await import('../alert-posted.js');
    d.filterNew ||= posted.filterNew;
    d.recordPosted ||= posted.recordPosted;
  }
  if (!d.emitEvent) d.emitEvent = (await import('../event-emitter.js')).emitEvent;
  return d;
}

/** The task, tag and note text for one deferral. Pure. */
export function followUpTask({ firstName = null, label, untilIso, triggerMessage = '' }, env = process.env) {
  const who = firstName || 'This lead';
  const assignedTo = [...rehashTeamUserIds(env)][0] || null;
  const said = String(triggerMessage || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return {
    title: `Follow up — ${who} asked for ${label}`,
    body: `${who} asked us to follow up ${label}${said ? `: "${said}"` : '.'} The bot confirmed it and promised nothing sooner.`,
    dueDate: untilIso,
    assignedTo,
    note: `📅 FOLLOW-UP REQUESTED: ${label} (due ${untilIso.slice(0, 10)}).${said ? ` They said: "${said}"` : ''}`,
  };
}

/**
 * File a confirmed post-demo follow-up. Never throws.
 * @returns {Promise<{ filed: boolean, reason?: string, task?: string, tag?: string, note?: string }>}
 */
export async function filePostDemoFollowUp({ contactId, deferral, firstName = null, triggerMessage = '' }, deps = {}) {
  if (!contactId || !deferral?.untilIso || !deferral?.label) return { filed: false, reason: 'nothing_to_file' };
  let d;
  try { d = await withDefaults(deps); } catch (err) { return { filed: false, reason: `deps: ${err.message}` }; }
  const item = { key: contactId, reason: `until:${deferral.untilIso.slice(0, 10)}` };
  try {
    const { fresh } = await d.filterNew({ audit: FOLLOWUP_AUDIT, items: [item], ttlDays: 90 });
    if (!fresh.length) return { filed: false, reason: 'already_filed' };
  } catch { /* an unreadable store files again: the safe direction */ }

  const t = followUpTask({ firstName, label: deferral.label, untilIso: deferral.untilIso, triggerMessage }, d.env);
  const out = { filed: true };
  try {
    await d.ghlFetch('POST', `/contacts/${contactId}/tasks`, {
      title: t.title, body: t.body, dueDate: t.dueDate, completed: false, ...(t.assignedTo ? { assignedTo: t.assignedTo } : {}),
    });
    out.task = 'created';
  } catch (err) {
    out.task = `failed: ${err.message}`;
    console.warn(`[PostDemo] follow-up task for ${contactId} failed (the note still carries it): ${err.message}`);
  }
  try { await d.applyGHLTag(contactId, FOLLOWUP_TAG); out.tag = 'added'; } catch (err) { out.tag = `failed: ${err.message}`; }
  try { await d.addGHLNote(contactId, t.note); out.note = 'added'; } catch (err) { out.note = `failed: ${err.message}`; }
  await d.recordPosted({ audit: FOLLOWUP_AUDIT, items: [item] }).catch(() => {});
  await Promise.resolve(d.emitEvent({
    event_type: 'agentic.post_demo_followup_filed', source: 'send_message', entity_type: 'contact', entity_id: contactId,
    ghl_contact_id: contactId, priority: 'low', bypass_filter: true,
    payload: { contact_id: contactId, until: deferral.untilIso, label: deferral.label, task: out.task, tag: out.tag, note: out.note },
  })).catch(() => {});
  d.log(`[PostDemo] ${contactId}: follow-up filed for ${deferral.label} (task ${out.task}, tag ${out.tag}, note ${out.note})`);
  return out;
}
