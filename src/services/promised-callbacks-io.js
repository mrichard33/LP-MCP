/**
 * Promised callbacks — the I/O. src/services/promised-callbacks-io.js
 *
 * 2026-10-07. The decisions live in src/agentic/promised-callbacks.js; this
 * file reads and writes `promised_callbacks` (sql/150) and posts the re-flag
 * card. Everything fails soft: a promise that cannot be recorded never stops
 * a reply, and a table that does not exist yet reads as "no open promise".
 *
 * deps: { supabase, postToSlack, filterNew, recordPosted, env, log, warn, now }
 */

import {
  readCallPromise, promiseDueAt, phone10, promisedCallbackMode, decideRepeatPromise, formatReflagCard,
} from '../agentic/promised-callbacks.js';

const AUDIT_REFLAG = 'promised_call_reflag';
// The simulator's contact id prefix (src/simulator/bot-simulator.js SIM_CONTACT_PREFIX).
// Not imported: the simulator pulls in the whole live-chat lane.
const SIM_CONTACT_PREFIX = 'sim-';

async function defaults(deps) {
  const out = { ...deps };
  if (!out.supabase) out.supabase = (await import('../supabase.js')).default;
  if (!out.postToSlack) out.postToSlack = (await import('../slack.js')).postToSlack;
  if (!out.filterNew || !out.recordPosted) {
    const ap = await import('../alert-posted.js');
    out.filterNew ||= ap.filterNew;
    out.recordPosted ||= ap.recordPosted;
  }
  out.env ||= process.env;
  out.log ||= console.log;
  out.warn ||= console.warn;
  out.now ||= Date.now;
  return out;
}

/** The open promise for a contact, or null (also on any read error). */
export async function findOpenPromise(contactId, deps = {}) {
  if (!contactId) return null;
  try {
    const d = await defaults(deps);
    const { data, error } = await d.supabase.from('promised_callbacks')
      .select('*').eq('ghl_contact_id', contactId).eq('status', 'open').limit(1);
    if (error) throw new Error(error.message);
    return Array.isArray(data) && data.length ? data[0] : null;
  } catch (err) {
    (deps.warn || console.warn)(`[PromisedCallback] open-promise read failed for ${contactId} (no guard this turn): ${err.message}`);
    return null;
  }
}

/**
 * After a reply is SENT: if it promised a call, record the promise. One open
 * row per contact (the partial unique index): a second promise while one is
 * open keeps the first row (its promised_at and due_at stand).
 *
 * @param {{ contactId, text, phone, rule, actionId, channel, kind }} p
 *   kind 'service' is never recorded: a service hand-off goes to #service and
 *   promises "a team member will reach out", not a sales call.
 */
export async function recordPromiseIfAny(p, deps = {}) {
  const d = await defaults(deps);
  const mode = promisedCallbackMode(d.env);
  if (mode === 'off' || !p?.contactId || p.kind === 'service') return { recorded: false, reason: mode === 'off' ? 'off' : 'not_applicable' };
  // A simulator contact is never a real promise (2026-10-09: four sim-quote-*
  // rows reached the live table). The simulator also swaps this dep out; this
  // is the floor if a new simulator path forgets to.
  if (String(p.contactId).startsWith(SIM_CONTACT_PREFIX)) return { recorded: false, reason: 'simulated' };
  const read = readCallPromise(p.text);
  if (!read.promised) return { recorded: false, reason: 'no_promise' };
  const nowMs = d.now();
  const row = {
    ghl_contact_id: p.contactId,
    phone10: phone10(p.phone),
    promised_at: new Date(nowMs).toISOString(),
    promised_by_rule: p.rule || null,
    promised_action_id: Number.isFinite(Number(p.actionId)) ? Number(p.actionId) : null,
    channel: p.channel || null,
    rep: read.rep,
    promise_text: String(read.sentence || '').slice(0, 300),
    due_at: new Date(promiseDueAt(nowMs)).toISOString(),
    status: 'open',
    mode,
  };
  try {
    const { data, error } = await d.supabase.from('promised_callbacks').insert(row).select('id').maybeSingle();
    if (error) {
      if (error.code === '23505' || /duplicate key|unique/i.test(error.message || '')) {
        d.log(`[PromisedCallback] ${p.contactId} already has an open promise — kept the first one`);
        return { recorded: false, reason: 'already_open' };
      }
      throw new Error(error.message);
    }
    d.log(`[PromisedCallback] recorded #${data?.id ?? '?'} for ${p.contactId} (${mode}, rep=${read.rep || 'none'}, due ${row.due_at})`);
    return { recorded: true, id: data?.id ?? null, row };
  } catch (err) {
    d.warn(`[PromisedCallback] could not record the promise for ${p.contactId} (fail-soft): ${err.message}`);
    return { recorded: false, reason: 'error' };
  }
}

/**
 * Before a reply is SENT: the repeat guard. Returns the text to send.
 * Live: a reply that promises a call while one is open becomes the repeat
 * line, the row is re-flagged and #contact-center hears about it (once a day
 * per contact). Shadow: the reply is unchanged; the would-be change is logged.
 *
 * @returns {Promise<{ text: string, action: string, open: object|null }>}
 */
export async function guardRepeatPromise({ contactId, text, name = null }, deps = {}) {
  const body = String(text || '');
  try {
    const d = await defaults(deps);
    const mode = promisedCallbackMode(d.env);
    if (mode === 'off' || !contactId || String(contactId).startsWith(SIM_CONTACT_PREFIX)) return { text: body, action: 'none', open: null };
    const open = await findOpenPromise(contactId, d);
    const decision = decideRepeatPromise({ open, text: body, mode });
    if (decision.action === 'none') return { text: body, action: 'none', open };
    if (decision.action === 'would_replace') {
      d.log(`[PromisedCallback] shadow: would_block_repeat_promise ${contactId} (open #${open.id}) → "${decision.line}"`);
      return { text: body, action: 'would_replace', open };
    }
    d.log(`[PromisedCallback] repeat_promise_blocked ${contactId} (open #${open.id}) → "${decision.line}"`);
    await reflag(open, { name }, d);
    return { text: decision.text, action: 'replace', open };
  } catch (err) {
    (deps.warn || console.warn)(`[PromisedCallback] repeat guard failed for ${contactId} (reply unchanged): ${err.message}`);
    return { text: body, action: 'error', open: null };
  }
}

/** Bump the re-flag counter and tell #contact-center (once a day per contact). Never throws. */
async function reflag(open, { name }, d) {
  const nowMs = d.now();
  try {
    await d.supabase.from('promised_callbacks')
      .update({ reflag_count: (open.reflag_count || 0) + 1, last_reflagged_at: new Date(nowMs).toISOString(), updated_at: new Date(nowMs).toISOString() })
      .eq('id', open.id);
  } catch (err) {
    d.warn(`[PromisedCallback] re-flag write failed for #${open.id}: ${err.message}`);
  }
  try {
    const channel = String(d.env.SLACK_CHANNEL_SERVICE || '').trim();
    if (!channel) { d.warn('[PromisedCallback] SLACK_CHANNEL_SERVICE unset — re-flag card not posted'); return; }
    const item = { key: open.ghl_contact_id, reason: `reflag:${new Date(nowMs).toISOString().slice(0, 10)}` };
    const { fresh } = await d.filterNew({ audit: AUDIT_REFLAG, items: [item], ttlDays: 2, nowMs });
    if (!fresh.length) return;
    const res = await d.postToSlack(formatReflagCard({ promise: open, name, locationId: d.env.GHL_LOCATION_ID || null }), channel);
    if (res?.ok) await d.recordPosted({ audit: AUDIT_REFLAG, items: [item], nowMs });
    else d.warn(`[PromisedCallback] re-flag card failed for ${open.ghl_contact_id}: ${res?.error || 'unknown'}`);
  } catch (err) {
    d.warn(`[PromisedCallback] re-flag card threw for ${open.ghl_contact_id}: ${err.message}`);
  }
}
