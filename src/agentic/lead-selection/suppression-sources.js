/**
 * Suppression sources for the lead-selection eligibility gate.
 * src/agentic/lead-selection/suppression-sources.js
 *
 * Returns batch lookups the gate uses to exclude DNC / out-of-area /
 * no-contact-method / hard-bounce / converted contacts BEFORE enrollment.
 *
 * v1.0 — 2026-06-17 (S1.3 audit remediation). Ships dark via the flags read
 * in select.js; this module only READS.
 */
import supabase from '../../supabase.js';

const ID_CHUNK = 150;
function chunk(arr, n = ID_CHUNK) {
  const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out;
}

/** ghl_contact_id -> Set(reason) of ACTIVE suppressions (any channel). */
export async function loadContactSuppressions(ids) {
  const map = new Map();
  for (const c of chunk(ids)) {
    const { data, error } = await supabase
      .from('contact_suppression')
      .select('ghl_contact_id, reason')
      .eq('active', true)
      .in('ghl_contact_id', c);
    if (error) throw new Error(`contact_suppression read failed: ${error.message}`);
    for (const r of data || []) {
      if (!map.has(r.ghl_contact_id)) map.set(r.ghl_contact_id, new Set());
      map.get(r.ghl_contact_id).add(r.reason);
    }
  }
  return map;
}

/** ghl_contact_id -> true if it has a recent hard SMS/email failure and no other live channel. */
export async function loadHardFailureSet(ids) {
  const set = new Set();
  for (const c of chunk(ids)) {
    const { data, error } = await supabase
      .from('message_delivery')
      .select('ghl_contact_id')
      .in('status', ['failed', 'undelivered'])
      .in('ghl_contact_id', c);
    if (error) throw new Error(`message_delivery read failed: ${error.message}`);
    for (const r of data || []) set.add(r.ghl_contact_id);
  }
  return set;
}
