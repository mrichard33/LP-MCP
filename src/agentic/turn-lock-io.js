// ─── Turn lock I/O — src/agentic/turn-lock-io.js ────────────────────────────
//
// The I/O half of turn-lock.js (read the WHY there): claim an inbound in
// bot_turn_locks before any model call, release it with what happened.
//
//   claimTurn   INSERT ... ON CONFLICT DO NOTHING; on a conflict, read the row
//               and decideClaim(): own it, take a stale / unanswered one over
//               (a compare-and-set on claimed_at, so two takers cannot both
//               win), or refuse with `already_answered` / `turn_owned_by:<rule>`.
//   releaseTurn stamp released_at + outcome on the row this action owns.
//   answeredSince the claims for a contact that ended in a reply after a time
//               (watchdogMayAnswer).
//   resolveTurnKey the key for an inbound when the path has no message id:
//               the matching ghl.reply_received event's id, else the text
//               hash; with no text at all (a re-fire), the LAST inbound's.
//
// FAILS OPEN, like every other duplicate gate on the send path: a read or
// write that fails returns { claimed: null } and the path proceeds as it did
// before Phase 1. A missing table (migration not applied yet) logs once.
// `deps.store` swaps the table for an in-memory store (the simulator, tests).

import { decideClaim, ANSWERED_OUTCOMES } from './turn-lock.js';
import { turnKeyFor, textTurnKey, messageTurnKey, normalizeInbound } from './turn-key.js';

const TABLE = 'bot_turn_locks';
const IO_TIMEOUT_MS = Number(process.env.TURN_LOCK_TIMEOUT_MS || 1500);

let missingLogged = false;
function isMissingRelation(error) {
  return !!error && (error.code === '42P01' || /does not exist|schema cache/i.test(String(error.message || '')));
}
function noteMissing(log) {
  if (missingLogged) return;
  missingLogged = true;
  (log || console.warn)('[TurnLock] bot_turn_locks is absent (apply the Phase 1 migration); claims fail open until then');
}

function withTimeout(promise, msLimit, label) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${msLimit}ms`)), msLimit); }),
  ]).finally(() => clearTimeout(t));
}

/** bot_turn_locks through supabase-js. */
export function supabaseTurnLockStore(supabase) {
  return {
    async insertIfAbsent(row) {
      const { data, error } = await withTimeout(
        supabase.from(TABLE).upsert(row, { onConflict: 'contact_id,turn_key', ignoreDuplicates: true }).select('contact_id'),
        IO_TIMEOUT_MS, 'turn lock insert');
      if (error) throw Object.assign(new Error(error.message), { pg: error });
      return Array.isArray(data) && data.length > 0;
    },
    async read(contactId, turnKey) {
      const { data, error } = await withTimeout(
        supabase.from(TABLE).select('*').eq('contact_id', contactId).eq('turn_key', turnKey).maybeSingle(),
        IO_TIMEOUT_MS, 'turn lock read');
      if (error) throw Object.assign(new Error(error.message), { pg: error });
      return data || null;
    },
    async takeover(row, prevClaimedAt) {
      let q = supabase.from(TABLE).update({ ...row, released_at: null, outcome: null })
        .eq('contact_id', row.contact_id).eq('turn_key', row.turn_key);
      q = prevClaimedAt ? q.eq('claimed_at', prevClaimedAt) : q.is('claimed_at', null);
      const { data, error } = await withTimeout(q.select('contact_id'), IO_TIMEOUT_MS, 'turn lock takeover');
      if (error) throw Object.assign(new Error(error.message), { pg: error });
      return Array.isArray(data) && data.length > 0;
    },
    async release({ contactId, turnKey, ownerActionId, outcome, releasedAt }) {
      let q = supabase.from(TABLE).update({ released_at: releasedAt, outcome })
        .eq('contact_id', contactId).eq('turn_key', turnKey).is('released_at', null);
      if (ownerActionId != null) q = q.eq('owner_action_id', String(ownerActionId));
      const { error } = await withTimeout(q, IO_TIMEOUT_MS, 'turn lock release');
      if (error) throw Object.assign(new Error(error.message), { pg: error });
      return true;
    },
    async answeredSince(contactId, sinceIso) {
      const { data, error } = await withTimeout(
        supabase.from(TABLE).select('claimed_at, outcome').eq('contact_id', contactId)
          .in('outcome', [...ANSWERED_OUTCOMES]).gte('claimed_at', sinceIso).limit(20),
        IO_TIMEOUT_MS, 'turn lock answered read');
      if (error) throw Object.assign(new Error(error.message), { pg: error });
      return data || [];
    },
  };
}

/** The same contract in memory (the simulator and tests). */
export function memoryTurnLockStore() {
  const rows = new Map();
  const k = (c, t) => `${c}\u0000${t}`;
  return {
    rows,
    async insertIfAbsent(row) {
      if (rows.has(k(row.contact_id, row.turn_key))) return false;
      rows.set(k(row.contact_id, row.turn_key), { released_at: null, outcome: null, ...row });
      return true;
    },
    async read(c, t) { return rows.get(k(c, t)) || null; },
    async takeover(row, prevClaimedAt) {
      const cur = rows.get(k(row.contact_id, row.turn_key));
      if (!cur || cur.claimed_at !== prevClaimedAt) return false;
      rows.set(k(row.contact_id, row.turn_key), { ...cur, ...row, released_at: null, outcome: null });
      return true;
    },
    async release({ contactId, turnKey, ownerActionId, outcome, releasedAt }) {
      const cur = rows.get(k(contactId, turnKey));
      if (!cur || cur.released_at) return false;
      if (ownerActionId != null && String(cur.owner_action_id) !== String(ownerActionId)) return false;
      rows.set(k(contactId, turnKey), { ...cur, released_at: releasedAt, outcome });
      return true;
    },
    async answeredSince(contactId, sinceIso) {
      const since = Date.parse(sinceIso);
      return [...rows.values()].filter(r => r.contact_id === contactId && ANSWERED_OUTCOMES.has(r.outcome) && Date.parse(r.claimed_at) >= since);
    },
  };
}

function storeFrom(deps = {}) {
  if (deps.store) return deps.store;
  if (deps.supabase) return supabaseTurnLockStore(deps.supabase);
  return null;
}

/**
 * Claim an inbound for this path. Never throws.
 * @returns {Promise<{ claimed: true, takeover?: string, stale?: boolean } | { claimed: false, skip_reason: string, owner_rule: string|null, claimed_at: string|null } | { claimed: null, error: string }>}
 */
export async function claimTurn({ contactId, turnKey, ownerRule = null, channel = null, ownerActionId = null } = {}, deps = {}) {
  const store = storeFrom(deps);
  const log = deps.log || console.log;
  const warn = deps.warn || console.warn;
  if (!store || !contactId || !turnKey) return { claimed: null, error: !store ? 'no_store' : 'no_key' };
  const nowMs = Number.isFinite(deps.nowMs) ? deps.nowMs : Date.now();
  const row = {
    contact_id: String(contactId),
    turn_key: String(turnKey),
    owner_rule: ownerRule ? String(ownerRule).slice(0, 120) : null,
    owner_action_id: ownerActionId != null ? String(ownerActionId) : null,
    channel: channel || null,
    claimed_at: new Date(nowMs).toISOString(),
  };
  try {
    if (await store.insertIfAbsent(row)) return { claimed: true };
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await store.read(row.contact_id, row.turn_key);
      const d = decideClaim(existing, { ownerActionId, nowMs });
      if (d.action === 'insert') {
        if (await store.insertIfAbsent(row)) return { claimed: true };
        continue;
      }
      if (d.action === 'own') return { claimed: true, reentry: true };
      if (d.action === 'refuse') return { claimed: false, skip_reason: d.skip_reason, owner_rule: d.owner_rule, claimed_at: d.claimed_at };
      // takeover: compare-and-set on the claimed_at we read.
      if (await store.takeover(row, existing.claimed_at)) {
        if (d.reason === 'stale') warn(`[TurnLock] stale claim on ${row.contact_id} ${row.turn_key} by ${d.owner_rule || '?'} since ${d.claimed_at} — taken over by ${row.owner_rule || '?'}`);
        else log(`[TurnLock] ${row.contact_id} ${row.turn_key}: ${d.owner_rule || '?'} released without a reply — ${row.owner_rule || '?'} takes the turn`);
        return { claimed: true, takeover: d.reason, stale: d.reason === 'stale' };
      }
    }
    const last = await store.read(row.contact_id, row.turn_key);
    return { claimed: false, skip_reason: `turn_owned_by:${last?.owner_rule || 'unknown'}`, owner_rule: last?.owner_rule || null, claimed_at: last?.claimed_at || null };
  } catch (err) {
    if (isMissingRelation(err?.pg)) noteMissing(warn);
    else warn(`[TurnLock] claim failed for ${contactId} ${turnKey} (fail-open): ${err.message}`);
    return { claimed: null, error: err.message };
  }
}

/** Release this action's claim with an outcome. Never throws. */
export async function releaseTurn({ contactId, turnKey, ownerActionId = null, outcome } = {}, deps = {}) {
  const store = storeFrom(deps);
  if (!store || !contactId || !turnKey || !outcome) return { released: false };
  try {
    const nowMs = Number.isFinite(deps.nowMs) ? deps.nowMs : Date.now();
    await store.release({ contactId: String(contactId), turnKey: String(turnKey), ownerActionId, outcome: String(outcome).slice(0, 120), releasedAt: new Date(nowMs).toISOString() });
    return { released: true };
  } catch (err) {
    if (!isMissingRelation(err?.pg)) (deps.warn || console.warn)(`[TurnLock] release failed for ${contactId} ${turnKey}: ${err.message}`);
    return { released: false, error: err.message };
  }
}

/** Times (ms) of claims for this contact that ended in a reply since `sinceMs`. Fails open to []. */
export async function answeredSince(contactId, sinceMs, deps = {}) {
  const store = storeFrom(deps);
  if (!store || !contactId || !Number.isFinite(sinceMs)) return [];
  try {
    const rows = await store.answeredSince(String(contactId), new Date(sinceMs - 5000).toISOString());
    return rows.map(r => Date.parse(r.claimed_at)).filter(Number.isFinite);
  } catch {
    return [];
  }
}

/**
 * The turn key for this path's inbound. Order: a message id the path carries;
 * the ghl.reply_received event whose text matches (its message id, so a path
 * holding only the text and one holding the id agree); the text hash. With no
 * text (a re-fire), the LAST inbound from this contact. Fails soft to the text
 * hash, or null when there is nothing to name the turn by.
 * @returns {Promise<{ key: string|null, source: string, inbound_at?: string|null }>}
 */
export async function resolveTurnKey({ contactId, messageId = null, text = null } = {}, deps = {}) {
  const direct = messageTurnKey(messageId);
  if (direct) return { key: direct, source: 'message_id' };
  const want = normalizeInbound(text);
  if (!deps.supabase || !contactId) return { key: textTurnKey(text), source: want ? 'text' : 'none' };
  try {
    const since = new Date((Number.isFinite(deps.nowMs) ? deps.nowMs : Date.now()) - 24 * 3600 * 1000).toISOString();
    const { data, error } = await withTimeout(
      deps.supabase.from('system_events').select('id, created_at, payload')
        .eq('ghl_contact_id', contactId).eq('event_type', 'ghl.reply_received').gte('created_at', since)
        .order('id', { ascending: false }).limit(want ? 20 : 1),
      IO_TIMEOUT_MS, 'turn key read');
    if (error || !Array.isArray(data)) return { key: textTurnKey(text), source: want ? 'text' : 'none' };
    const hit = want ? data.find(e => normalizeInbound(e?.payload?.message_text) === want) : data[0];
    if (!hit) return { key: textTurnKey(text), source: want ? 'text' : 'none' };
    const key = turnKeyFor({ messageId: hit.payload?.message_id || null, text: hit.payload?.message_text || null });
    return { key, source: want ? 'event_match' : 'last_inbound', inbound_at: hit.created_at || null };
  } catch {
    return { key: textTurnKey(text), source: want ? 'text' : 'none' };
  }
}

export default { claimTurn, releaseTurn, answeredSince, resolveTurnKey, supabaseTurnLockStore, memoryTurnLockStore };
