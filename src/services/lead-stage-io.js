// ─── Lead conversation stage: store + GHL mirror — src/services/lead-stage-io.js
//
// WHY (handoff "Lead Conversation Stage", 2026-10-12)
//   The conversation stage (src/agentic/lead-stage.js) has to survive between
//   turns, be visible to a person, and never cost a customer reply. This file
//   is the I/O half:
//     - lead_conversation_stage (one row per contact) and
//       lead_conversation_stage_events (one row per change), in the LP
//       Supabase project (supabase/migrations/*_lead_conversation_stage.sql);
//     - the GHL mirror: the label goes into the existing "NEPQ Stage" dropdown
//       (contact.nepq_stage, folder Chat Bot). Only when the label CHANGES:
//       a repeat write can re-trigger a GHL workflow listening on the field.
//       A label the live dropdown does not carry is never written (one
//       warning per label). "Stage Last Engaged" is a different field and is
//       never touched.
//
// NEVER THROWS. Every call here runs after the reply went out (or beside a
// booking), fire-and-forget through trackBackground. A missing table (before
// the migration is applied) reads as "no stored row" and the write is
// skipped with one log line, so shipping the code before the table is safe.
//
// The simulator passes `allowSim: true` with an in-memory store and
// `mirror: false`: nothing is written to GHL or Supabase for a test run.

import {
  computeStage, ghlLabelFor, ghlLabelWrite, labelDifference, leadStageMode,
} from '../agentic/lead-stage.js';

export const STAGE_TABLE = 'lead_conversation_stage';
export const STAGE_EVENTS_TABLE = 'lead_conversation_stage_events';
export const NEPQ_STAGE_FIELD_KEY = 'contact.nepq_stage';
export const FIELD_CACHE_TTL_MS = 60 * 60 * 1000;
export const STORE_TIMEOUT_MS = 2000;
// The simulator's contact id prefix (src/simulator/bot-simulator.js). Not
// imported: the simulator pulls in the whole live-chat lane.
const SIM_CONTACT_PREFIX = 'sim-';

/** True when an error means the stage tables do not exist yet. Pure. */
export function isMissingTableError(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || '');
  return code === '42P01' || code === 'PGRST205' || /does not exist|Could not find the table/i.test(msg);
}

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

// ── stores ───────────────────────────────────────────────────────────────

/** The production store. Reads and writes fail soft. */
export function createSupabaseStageStore({ supabase, timeoutMs = STORE_TIMEOUT_MS, warn = console.warn } = {}) {
  let missingLogged = false;
  const missing = (err, what) => {
    if (isMissingTableError(err)) {
      if (!missingLogged) { missingLogged = true; warn(`[LeadStage] ${what}: table not there yet (apply the lead_conversation_stage migration); stage not stored`); }
      return true;
    }
    return false;
  };
  return {
    async read(contactId) {
      try {
        const { data, error } = await withTimeout(
          supabase.from(STAGE_TABLE).select('*').eq('contact_id', contactId).maybeSingle(), timeoutMs, 'stage read');
        if (error) { if (!missing(error, 'read')) warn(`[LeadStage] read failed for ${contactId}: ${error.message}`); return { row: null, ok: false }; }
        return { row: data || null, ok: true };
      } catch (err) {
        warn(`[LeadStage] read failed for ${contactId}: ${err.message}`);
        return { row: null, ok: false };
      }
    },
    async write({ row, event }) {
      try {
        const { error } = await withTimeout(
          supabase.from(STAGE_TABLE).upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'contact_id' }), timeoutMs, 'stage write');
        if (error) { if (!missing(error, 'write')) warn(`[LeadStage] write failed for ${row.contact_id}: ${error.message}`); return false; }
        if (event) {
          const { error: e2 } = await withTimeout(supabase.from(STAGE_EVENTS_TABLE).insert(event), timeoutMs, 'stage event');
          if (e2 && !missing(e2, 'event')) warn(`[LeadStage] event insert failed for ${row.contact_id}: ${e2.message}`);
        }
        return true;
      } catch (err) {
        warn(`[LeadStage] write failed for ${row?.contact_id}: ${err.message}`);
        return false;
      }
    },
    async events(contactId, limit = 50) {
      try {
        const { data, error } = await withTimeout(
          supabase.from(STAGE_EVENTS_TABLE).select('*').eq('contact_id', contactId).order('created_at', { ascending: false }).limit(limit), timeoutMs, 'stage events');
        if (error) return [];
        return data || [];
      } catch { return []; }
    },
  };
}

/** The simulator's and the tests' store. Same interface, in memory. */
export function createMemoryStageStore() {
  const rows = new Map();
  const events = [];
  return {
    rows, eventLog: events,
    async read(contactId) { return { row: rows.get(contactId) || null, ok: true }; },
    async write({ row, event }) {
      rows.set(row.contact_id, { ...row, updated_at: new Date().toISOString() });
      if (event) events.push({ ...event, created_at: new Date().toISOString() });
      return true;
    },
    async events(contactId, limit = 50) {
      return events.filter(e => e.contact_id === contactId).slice(-limit).reverse();
    },
  };
}

// ── the GHL field ────────────────────────────────────────────────────────

let _field = { value: null, at: 0 };
const _warnedLabels = new Set();

/** Find the NEPQ Stage field in GHL's custom-field list. Pure. */
export function pickStageField(list, { id = null, key = NEPQ_STAGE_FIELD_KEY } = {}) {
  const rows = Array.isArray(list) ? list : [];
  const row = (id && rows.find(r => r?.id === id)) || rows.find(r => r?.fieldKey === key);
  if (!row) return id ? { id, options: null } : null;
  return { id: row.id, options: Array.isArray(row.picklistOptions) ? row.picklistOptions : null, name: row.name || null };
}

/**
 * { id, options } for the NEPQ Stage dropdown, or null when it cannot be
 * found. GHL_FIELD_BOT_STAGE_ID wins for the id; the live options are still
 * read so a label the dropdown lacks is never written. Cached an hour; a
 * failed read is not cached. Never throws.
 */
export async function resolveStageField(deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  if (_field.value && now - _field.at < FIELD_CACHE_TTL_MS) return _field.value;
  const envId = String(env.GHL_FIELD_BOT_STAGE_ID || '').trim() || null;
  try {
    const fetchImpl = deps.ghlFetch || (await import('../actions/helpers.js')).ghlFetch;
    const loc = deps.locationId || (await import('../actions/constants.js')).GHL_LOCATION_ID;
    const res = await fetchImpl('GET', `/locations/${loc}/customFields?model=contact`, null, { maxWaitMs: 1500 });
    const found = pickStageField(res?.customFields, { id: envId });
    if (found) _field = { value: found, at: now };
    else (deps.warn || console.warn)(`[LeadStage] GHL field ${NEPQ_STAGE_FIELD_KEY} not found; the stage is stored but not mirrored`);
    return found;
  } catch (err) {
    (deps.warn || console.warn)(`[LeadStage] GHL field read failed: ${err.message}`);
    // The id from env still lets the write go; GHL itself rejects a bad label.
    return envId ? { id: envId, options: null } : null;
  }
}

/**
 * Write the label to the contact's NEPQ Stage field when it changed.
 * @returns {{ wrote: boolean, why: string }}  never throws
 */
export async function mirrorStageToGhl({ contactId, prevLabel = null, label = null }, deps = {}) {
  const warn = deps.warn || console.warn;
  try {
    const field = await resolveStageField(deps);
    if (!field?.id) return { wrote: false, why: 'no_field' };
    const decision = ghlLabelWrite(prevLabel, label, field.options);
    if (!decision.write) {
      if (decision.why === 'not_in_live_options' && !_warnedLabels.has(label)) {
        _warnedLabels.add(label);
        warn(`[LeadStage] NEPQ Stage dropdown has no "${label}" option; not written (live options: ${(field.options || []).join(' | ')})`);
      }
      return { wrote: false, why: decision.why };
    }
    const fetchImpl = deps.ghlFetch || (await import('../actions/helpers.js')).ghlFetch;
    await fetchImpl('PUT', `/contacts/${contactId}`, { customFields: [{ id: field.id, field_value: label }] }, { maxWaitMs: 1500 });
    return { wrote: true, why: 'changed' };
  } catch (err) {
    const rejected = /→\s*(?:400|422)\b/.test(String(err.message));
    if (rejected && !_warnedLabels.has(label)) { _warnedLabels.add(label); warn(`[LeadStage] GHL rejected NEPQ Stage "${label}": ${err.message}`); }
    else if (!rejected) warn(`[LeadStage] GHL mirror failed for ${contactId}: ${err.message}`);
    return { wrote: false, why: rejected ? 'rejected' : 'error' };
  }
}

export function __resetLeadStageCacheForTest() {
  _field = { value: null, at: 0 };
  _warnedLabels.clear();
}

// ── recording ────────────────────────────────────────────────────────────

/** The analyzer's buyer_stage (1-5) as a number, or null. Pure. */
function buyerStageOf(v) {
  const n = Number(v);
  return v != null && v !== '' && Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

async function defaults(deps) {
  const out = { ...deps };
  out.env ||= process.env;
  out.log ||= console.log;
  out.warn ||= console.warn;
  if (!out.store) {
    const supabase = out.supabase || (await import('../supabase.js')).default;
    out.store = createSupabaseStageStore({ supabase, warn: out.warn });
  }
  return out;
}

/**
 * Compute the stage for this turn, store it, mirror the label. The shared
 * path for a bot turn, the booking event and an opt-out.
 *
 * @param {object} a
 * @param {string} a.contactId
 * @param {object} [a.input]   { conversation, trigger, plan, ctx, buyerStage } (built by the reply path)
 * @param {string} [a.reply]   what the bot sent this turn
 * @param {string} [a.channel]
 * @param {object} [a.ctx]     extra context ({ booked, optedOut, ... })
 * @param {string} [a.move]    the plan move, for last_move
 * @returns {Promise<object>}  { before, after, reason, label, mirrored } or { skipped }
 */
export async function recordStage({ contactId, input = {}, reply = '', channel = null, ctx = {}, move = null }, rawDeps = {}) {
  if (!contactId) return { skipped: 'no_contact' };
  if (String(contactId).startsWith(SIM_CONTACT_PREFIX) && !rawDeps.allowSim) return { skipped: 'sim' };
  let deps;
  try { deps = await defaults(rawDeps); } catch (err) { console.warn(`[LeadStage] setup failed: ${err.message}`); return { skipped: 'setup' }; }
  const mode = leadStageMode(deps.env);
  if (mode === 'off') return { skipped: 'off' };
  try {
    const { row } = await deps.store.read(contactId);
    const stored = row ? { stage: row.stage, track: row.track, facts: row.facts || {} } : null;
    const result = computeStage({
      stored,
      conversation: input.conversation || [],
      trigger: input.trigger || '',
      reply,
      plan: input.plan || null,
      ctx: { ...(input.ctx || {}), ...ctx },
    });
    const label = ghlLabelFor(result.stage);
    const prevLabel = row?.ghl_label || null;
    let mirrored = { wrote: false, why: 'disabled' };
    if (deps.mirror !== false) mirrored = await mirrorStageToGhl({ contactId, prevLabel, label }, deps);
    // ghl_label records what GHL holds: it moves only when the write landed
    // (or nothing needed writing), so a failed write is retried next change.
    const ghlLabel = (mirrored.wrote || mirrored.why === 'unchanged') ? label : prevLabel;
    const now = new Date().toISOString();
    await deps.store.write({
      row: {
        contact_id: contactId,
        track: result.track,
        stage: result.stage,
        ghl_label: ghlLabel,
        buyer_stage: buyerStageOf(input.buyerStage) ?? row?.buyer_stage ?? null,
        facts: result.facts,
        last_move: move || input.plan?.required_move || null,
        channel: channel || row?.channel || null,
        mode,
        ...(row ? {} : { created_at: now }),
      },
      event: result.changed ? {
        contact_id: contactId, from_stage: result.from, to_stage: result.stage, reason: result.reason, channel, mode,
      } : null,
    });
    if (result.changed) deps.log(`[LeadStage] ${contactId}: ${result.from || '(none)'} → ${result.stage} (${result.reason}) label=${label}${mirrored.wrote ? ' [GHL written]' : ''}`);
    return { before: result.from, after: result.stage, reason: result.reason, label, mirrored: mirrored.why, facts: result.facts };
  } catch (err) {
    deps.warn(`[LeadStage] record failed for ${contactId} (fail-soft): ${err.message}`);
    return { skipped: 'error', error: err.message };
  }
}

/** A bot turn that went out. */
export function recordTurnStage(a, deps = {}) {
  return recordStage(a, deps);
}

/** The real booking-created event (ghl.appointment_booked): stage → booked. */
export function recordBookedStage({ contactId, channel = null, source = null }, deps = {}) {
  return recordStage({ contactId, channel, ctx: { booked: true }, move: source ? `booking:${source}` : 'booking' }, deps);
}

/** An opt-out the bot answered with silence (SMS STOP short-circuit). */
export function recordOptOutStage({ contactId, channel = null }, deps = {}) {
  return recordStage({ contactId, channel, ctx: { optedOut: true }, move: 'opt_out' }, deps);
}

/** What GET /admin/lead-stage/:contactId returns. Never throws. */
export async function readStageReport(contactId, rawDeps = {}) {
  const deps = await defaults(rawDeps);
  const { row, ok } = await deps.store.read(contactId);
  const events = await deps.store.events(contactId, 50);
  let field = null;
  try { field = await resolveStageField(deps); } catch { field = null; }
  return {
    contact_id: contactId,
    mode: leadStageMode(deps.env),
    read_ok: ok,
    stage: row?.stage || null,
    track: row?.track || null,
    ghl_label: row?.ghl_label || null,
    expected_label: row ? ghlLabelFor(row.stage) : null,
    buyer_stage: row?.buyer_stage ?? null,
    facts: row?.facts || null,
    last_move: row?.last_move || null,
    channel: row?.channel || null,
    updated_at: row?.updated_at || null,
    events,
    ghl_field: field ? { id: field.id, options: field.options, ...labelDifference(field.options || []) } : null,
  };
}
