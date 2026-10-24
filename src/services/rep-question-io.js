// ─── Filing a question for the rehash rep — src/services/rep-question-io.js ────
//
// The I/O half of rep-question.js (the user, 2026-10-24: "you let them know that
// you will put a note for John"). After the send, a question the assistant could
// not answer becomes, for the rep on the lead (rehashRepFor, else the rehash rep):
//   1. a GHL task, due the next business day at 12:00 ET;
//   2. a contact note with the question;
//   3. ONE ❓ card in #contact-rehash (postToSlack; a failed post is an
//      #ops-alerts line, never silence).
// Once per contact per question (audit_posted_items `rep_question`, 30 days), so a
// second, different question the same day still reaches the rep. Never throws and
// never blocks the reply: every step is best-effort and logged.
//
// deps (tests): { ghlFetch, getContact, addGHLNote, postToSlack, opsAlert, filterNew, recordPosted, emitEvent, env, log, nowMs }

import { rehashTeamUserIds } from '../agentic/rehash-state.js';
import { rehashRepFor } from '../config/rehash-assignee.js';
import { rehashSlackChannel } from '../agentic/rehash.js';
import { promiseDueAt } from '../agentic/promised-callbacks.js';
import { repQuestionKey, repQuestionTask } from './rep-question.js';

export const REP_QUESTION_AUDIT = 'rep_question';

async function withDefaults(deps) {
  const d = { ...deps };
  d.env ||= process.env;
  d.log ||= console.log;
  d.nowMs ||= Date.now();
  if (!d.ghlFetch && !d.getContact) {
    const { getContactCached } = await import('../actions/contact-cache.js');
    d.getContact = (id) => getContactCached(id, null, { maxWaitMs: 2000 });
  }
  if (!d.ghlFetch) d.ghlFetch = (await import('../actions/helpers.js')).ghlFetch;
  if (!d.addGHLNote) d.addGHLNote = (await import('../ghl.js')).addGHLNote;
  if (!d.postToSlack) d.postToSlack = (await import('../slack.js')).postToSlack;
  if (!d.opsAlert) {
    const { sendAlertMessage } = await import('../alert-state.js');
    d.opsAlert = (text) => sendAlertMessage(text, { channel: 'ops' });
  }
  if (!d.filterNew || !d.recordPosted) {
    const posted = await import('../alert-posted.js');
    d.filterNew ||= posted.filterNew;
    d.recordPosted ||= posted.recordPosted;
  }
  if (!d.emitEvent) d.emitEvent = (await import('../event-emitter.js')).emitEvent;
  return d;
}

/**
 * File one question for the rep. Never throws.
 * @returns {Promise<{ filed: boolean, reason?: string, task?: string, note?: string, card?: string }>}
 */
export async function fileRepQuestion({ contactId, question, source = 'model', repName = null, firstName = null, recent = [] }, deps = {}) {
  if (!contactId || !question) return { filed: false, reason: 'nothing_to_file' };
  let d;
  try { d = await withDefaults(deps); } catch (err) { return { filed: false, reason: `deps: ${err.message}` }; }
  const item = { key: contactId, reason: `q:${repQuestionKey(question)}` };
  try {
    const { fresh } = await d.filterNew({ audit: REP_QUESTION_AUDIT, items: [item], ttlDays: 30 });
    if (!fresh.length) return { filed: false, reason: 'already_filed' };
  } catch { /* an unreadable store files again: the safe direction */ }

  const contact = d.getContact ? await d.getContact(contactId).catch(() => null) : null;
  // The rep's first name, resolved like the F.0 texts' (never guessed).
  if (!repName) {
    try {
      const resolve = d.resolveRep || (await import('../siro/f0-context.js')).resolveRehashRepFirst;
      repName = await resolve(contactId);
    } catch { /* the team below */ }
  }
  repName = repName && repName !== 'Reece Team' ? repName : 'the rehash team';
  const team = rehashTeamUserIds(d.env);
  const assignedTo = rehashRepFor(contact, team) || [...team][0] || null;
  const t = repQuestionTask({ firstName: firstName || contact?.firstName || null, rep: repName, question, recent });
  const out = { filed: true };
  try {
    await d.ghlFetch('POST', `/contacts/${contactId}/tasks`, {
      title: t.title, body: t.body, dueDate: new Date(promiseDueAt(d.nowMs)).toISOString(), completed: false,
      ...(assignedTo ? { assignedTo } : {}),
    });
    out.task = 'created';
  } catch (err) {
    out.task = `failed: ${err.message}`;
    console.warn(`[RepQuestion] task for ${contactId} failed (the note and card still carry it): ${err.message}`);
  }
  try { await d.addGHLNote(contactId, t.note); out.note = 'added'; } catch (err) { out.note = `failed: ${err.message}`; }
  const channel = rehashSlackChannel(d.env);
  try {
    const res = await d.postToSlack(`${t.card}\nContact ID: ${contactId}`, channel);
    out.card = res?.ok ? 'posted' : `failed: ${res?.error || 'unknown'}`;
    if (!res?.ok) {
      await Promise.resolve(d.opsAlert(`🚨 QUESTION FOR ${String(repName || 'John').toUpperCase()} NOT POSTED\nContact ID: ${contactId}\nSlack said: ${res?.error || 'unknown'} (channel ${channel})\n→ The assistant told a lead ${repName || 'John'} would answer: "${question}". The GHL task is ${out.task}.`)).catch(() => {});
    }
  } catch (err) { out.card = `failed: ${err.message}`; }
  await d.recordPosted({ audit: REP_QUESTION_AUDIT, items: [item] }).catch(() => {});
  await Promise.resolve(d.emitEvent({
    event_type: 'agentic.rep_question_filed', source: 'send_message', entity_type: 'contact', entity_id: contactId,
    ghl_contact_id: contactId, priority: 'normal', bypass_filter: true,
    payload: { contact_id: contactId, source, task: out.task, note: out.note, card: out.card },
  })).catch(() => {});
  d.log(`[RepQuestion] ${contactId}: question for ${repName} filed (${source}; task ${out.task}, note ${out.note}, card ${out.card})`);
  return out;
}
