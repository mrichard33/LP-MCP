/**
 * Siro ingest — src/siro/ingest.js (2026-10-16, Siro PR 1)
 *
 * ONE path for every recording, whoever found it (webhook, poll backstop,
 * on-demand ensure): fetch → normalize → resolve the LP lead → upsert
 * siro_recordings → (live) emit siro.recording_processed once → (live) queue
 * the GHL demo note once.
 *
 * Idempotency (CANON.K.072): the event carries idempotency key
 * `siro:<recording_id>` and is stamped on event_emitted_at; the note is
 * CLAIMED on ghl_note_action_id before its agent_actions row is inserted, so a
 * webhook and a poll racing on the same recording write one note. A failed
 * insert clears the claim.
 *
 * Shadow (the default for the webhook and the poll): fetch, normalize,
 * resolve and store; emit nothing, queue nothing, log the demo-note text.
 * Every dependency is injectable (deps.supabase, deps.siro, deps.emitEvent).
 */
import supabaseDefault from '../supabase.js';
import * as siroDefault from './client.js';
import { emitEvent as emitEventDefault } from '../event-emitter.js';
import { normalizeRecording } from './normalize.js';
import { resolveLead } from './resolve-lead.js';
import { buildPresentationFacts } from './presentation-facts.js';
import { buildDemoNote } from './demo-note.js';
import { siroConfig, siroModes } from './config.js';
import { prospectLabel } from '../format-helpers.js';
import { siroUserNames } from './users.js';

export const DEMO_NOTE_RULE = 'SIRO_DEMO_NOTE';
const NOTE_CLAIM_PENDING = -1;

const LEAD_COLS = 'lp_lead_id, lp_prospect_id, ghl_contact_id, phone, demo_date, appointment_date, created_at_lp, disposition_code';

/** readLeads for resolveLead, against lp_leads. Throws on a failed read. */
export function leadReader(supabase) {
  return async ({ by, values }) => {
    const vals = (values || []).filter(Boolean).map(String);
    if (!vals.length) return [];
    let q = supabase.from('lp_leads').select(LEAD_COLS);
    if (by === 'phone') {
      // lp_leads.phone / phone_alt hold 10 digits (checked 2026-10-16).
      const digits = vals[0].replace(/\D/g, '').slice(-10);
      if (digits.length !== 10) return [];
      q = q.or(`phone.eq.${digits},phone_alt.eq.${digits}`);
    } else {
      q = q.in(by, vals);
    }
    const { data, error } = await q.limit(25);
    if (error) throw new Error(`lp_leads read failed: ${error.message}`);
    return data || [];
  };
}

function hasFollowupContext(rec) {
  const f = rec?.followups;
  return Array.isArray(f) && f.some(x => Array.isArray(x?.context) && x.context.length);
}

export function rowMatchesConversationType(row, env = process.env) {
  const want = siroConfig(env).presentationConversationType;
  return !want || !row.conversation_type || row.conversation_type === want;
}

async function readStored(supabase, recordingId) {
  const { data, error } = await supabase.from('siro_recordings')
    .select('recording_id, updated_at_siro, event_emitted_at, ghl_note_action_id, lp_lead_id, ghl_contact_id')
    .eq('recording_id', recordingId).maybeSingle();
  if (error) throw new Error(`siro_recordings read failed: ${error.message}`);
  return data || null;
}

/**
 * Queue the GHL demo note once per recording (§6). Shadow logs the text.
 * @returns {'queued'|'shadow'|'already_claimed'|'no_contact'|'too_old'|'not_ready'|'off'|'failed'}
 */
export async function queueDemoNote(row, { mode, supabase, eventId = null, log = console.log, env = process.env, nowMs = Date.now() } = {}) {
  if (mode === 'off') return 'off';
  if (!row?.ghl_contact_id) return 'no_contact';
  // New visits only (the user, 2026-10-16): turning notes on never back-fills
  // last week's demos onto GHL contacts.
  const recordedMs = Date.parse(row.recorded_at || '');
  if (!Number.isFinite(recordedMs) || nowMs - recordedMs > siroConfig(env).demoNoteMaxAgeH * 3_600_000) return 'too_old';
  const facts = buildPresentationFacts([row], { now: nowMs });
  if (!facts) return 'not_ready';
  // The quotes go to GHL in this internal note (the user's ruling); the bot never sees them.
  const note = buildDemoNote(facts, { pricing: row.pricing || null });
  if (mode !== 'live') {
    log(`[Siro] shadow: demo note for ${prospectLabel(row.lp_prospect_id)}:\n${note}`);
    return 'shadow';
  }
  // Claim first: only one writer wins the null → pending update.
  const { data: claimed, error: claimErr } = await supabase.from('siro_recordings')
    .update({ ghl_note_action_id: NOTE_CLAIM_PENDING })
    .eq('recording_id', row.recording_id).is('ghl_note_action_id', null)
    .select('recording_id');
  if (claimErr) { log(`[Siro] demo note claim failed: ${claimErr.message}`); return 'failed'; }
  if (!claimed?.length) return 'already_claimed';
  const { data: action, error: insErr } = await supabase.from('agent_actions').insert({
    event_id: eventId,
    action_type: 'add_note',
    target_system: 'ghl',
    target_entity: 'contact',
    target_id: row.ghl_contact_id,
    action_payload: { note, siro_recording_id: row.recording_id },
    reasoning: 'Siro demo summary, written once per recording',
    confidence: 1.0,
    rule_applied: DEMO_NOTE_RULE,
    status: 'pending',
    requires_approval: false,
    priority: 5,
  }).select('id').single();
  if (insErr || !action?.id) {
    await supabase.from('siro_recordings').update({ ghl_note_action_id: null })
      .eq('recording_id', row.recording_id).eq('ghl_note_action_id', NOTE_CLAIM_PENDING);
    log(`[Siro] demo note insert failed, claim cleared: ${insErr?.message || 'no id'}`);
    return 'failed';
  }
  await supabase.from('siro_recordings').update({ ghl_note_action_id: action.id })
    .eq('recording_id', row.recording_id);
  return 'queued';
}

/**
 * @param {string} recordingId
 * @param {object} o
 * @param {'webhook'|'poll'|'ensure'} o.source
 * @param {'off'|'shadow'|'live'} o.mode      the caller's mode (webhook / sync)
 * @param {object} [o.raw]                    the recording, when already fetched
 * @param {object} [o.flags]                  webhook processed / linked flags
 * @param {boolean} [o.onlyIfNewer]           poll: skip a row we already hold at this updatedAt
 * @returns {Promise<{result:string, row?:object}>}
 */
export async function processRecording(recordingId, {
  source, mode = 'shadow', raw = null, flags = {}, onlyIfNewer = false, reprocess = false,
  env = process.env, deps = {},
} = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const siro = deps.siro || siroDefault;
  const emitEvent = deps.emitEvent || emitEventDefault;
  const log = deps.log || console.log;
  if (!supabase) return { result: 'no_database' };

  // An unchanged recording is skipped before any Siro call (the poll re-reads
  // the watermark minute every pass).
  if (raw && onlyIfNewer && !reprocess && raw.updatedAt) {
    const held = await readStored(supabase, String(raw.id || recordingId));
    if (held?.updated_at_siro && held.lp_lead_id
      && Date.parse(held.updated_at_siro) >= Date.parse(raw.updatedAt)) return { result: 'unchanged' };
  }
  let rec = raw;
  // The LIST call returns the summary but not Siro's follow-up block (rep name,
  // objections, follow-up timing, quotes): all 158 rows the first reprocess
  // stored from it had no rep and no prices (2026-10-16). Only the single-record
  // GET carries it, so a list item without it is fetched whole.
  if (!rec || !Array.isArray(rec.summary) || !hasFollowupContext(rec)) {
    const res = await siro.getRecording(recordingId);
    if (!res.ok) return { result: res.status === 404 ? 'not_found' : 'fetch_failed', error: res.error };
    rec = res.data?.data && res.data.data.id ? res.data.data : res.data;
  }
  const userNames = deps.userNames || await siroUserNames({ siro });
  const row = normalizeRecording(rec, { source, flags, userNames });
  if (!row) return { result: 'unreadable' };
  if (!rowMatchesConversationType(row, env)) return { result: 'other_conversation_type' };

  const stored = await readStored(supabase, row.recording_id);
  if (onlyIfNewer && !reprocess && stored?.updated_at_siro && row.updated_at_siro
    && Date.parse(stored.updated_at_siro) >= Date.parse(row.updated_at_siro) && stored.lp_lead_id) {
    return { result: 'unchanged' };
  }

  let match;
  try {
    match = await resolveLead(row, { readLeads: deps.readLeads || leadReader(supabase) });
  } catch (err) {
    log(`[Siro] lead resolve failed for ${row.recording_id}: ${err.message}`);
    match = { lp_lead_id: stored?.lp_lead_id || null, lp_prospect_id: null, ghl_contact_id: stored?.ghl_contact_id || null, match_method: 'none' };
  }
  const full = { ...row, ...match };
  // Never overwrite our own claims from the upsert.
  const { error: upErr } = await supabase.from('siro_recordings')
    .upsert(full, { onConflict: 'recording_id' });
  if (upErr) return { result: 'store_failed', error: upErr.message };

  const ready = full.processed && !!full.lp_lead_id && !full.deleted;
  if (mode !== 'live') {
    if (ready && !reprocess) await queueDemoNote({ ...full }, { mode: 'shadow', supabase, log, env });
    return { result: ready ? 'stored_shadow' : (full.lp_lead_id ? 'stored_not_processed' : 'stored_no_lead'), row: full };
  }
  if (!ready) return { result: full.lp_lead_id ? 'stored_not_processed' : 'stored_no_lead', row: full };

  let eventId = null;
  if (!stored?.event_emitted_at) {
    const facts = buildPresentationFacts([full]);
    const evt = await emitEvent({
      event_type: 'siro.recording_processed',
      source: 'siro',
      entity_type: 'recording',
      entity_id: full.recording_id,
      ghl_contact_id: full.ghl_contact_id,
      lp_lead_id: full.lp_lead_id,
      lp_prospect_id: full.lp_prospect_id,
      payload: {
        recording_id: full.recording_id,
        lp_lead_id: full.lp_lead_id,
        lp_prospect_id: full.lp_prospect_id,
        ghl_contact_id: full.ghl_contact_id,
        rep_name: full.rep_name,
        result: full.result,
        followup_score: full.followup_score,
        objections: (facts?.objections || []).map(o => o.type),
        interests: facts?.interests || [],
        match_method: full.match_method,
      },
      idempotency_key: `siro:${full.recording_id}`,
    });
    eventId = evt && evt.id ? evt.id : null;
    await supabase.from('siro_recordings').update({ event_emitted_at: new Date().toISOString() })
      .eq('recording_id', full.recording_id).is('event_emitted_at', null);
  }
  const noteMode = siroModes(env).demoNote;
  const note = await queueDemoNote({ ...full }, { mode: noteMode, supabase, eventId, log, env });
  return { result: `live_${note}`, row: full };
}
