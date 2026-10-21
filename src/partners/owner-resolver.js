// ─── Partner owner resolver — src/partners/owner-resolver.js ────────────────
//
// Mark, 2026-10-19: a lead in an outside sales partner's LP branch belongs to that
// partner's GHL user. The mapping is data (partner_owner_map, seeded with Ross
// Erstling → branch RFED), never code: a new partner or a partner's rep is a row.
//
// Order (rule 5): an ACTIVE row for the exact branch + rep wins, then the ACTIVE
// branch-only row (lp_rep_name NULL = the whole branch), then nothing. Branch and
// rep compare trimmed and lowercased; LP pads brn_id and stores reps "Last, First".
//
// partnerUserIds() holds EVERY row's user, active or not: a partner switched off
// still owns leads in GHL, and the "return to Reece" rule (rule 8) must still be
// able to recognise them.
//
// The map is cached for 60 s (the fast poll runs every 90 s and the 15-minute sync
// calls this per lead). A read that fails keeps the last good map; with none, it
// throws, and the caller treats that as "could not tell" and writes nothing.

const CACHE_MS = 60_000;

let cache = null; // { rows, at }

const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase());

export function clearCache() {
  cache = null;
}

async function defaultSupabase() {
  return (await import('../supabase.js')).default;
}

/** All mapping rows (cached). deps: { supabase, now } */
export async function loadPartnerMap(deps = {}) {
  const now = (deps.now || Date.now)();
  if (cache && now - cache.at < CACHE_MS) return cache.rows;
  const db = deps.supabase || await defaultSupabase();
  if (!db) throw new Error('partner_owner_map: LP Supabase not configured');
  const { data, error } = await db.from('partner_owner_map')
    // '*' so ghl_tag (2026-10-21) is read once its migration lands and its absence before then is no error.
    .select('*');
  if (error) {
    if (cache) {
      console.warn(`[PartnerOwner] partner_owner_map read failed, keeping the last map: ${error.message}`);
      return cache.rows;
    }
    throw new Error(`partner_owner_map read failed: ${error.message}`);
  }
  cache = { rows: data || [], at: now };
  return cache.rows;
}

/** Pure: the mapping row for a lead, or null. */
export function matchPartnerRow(rows, { lp_branch_id, rep_name } = {}) {
  const branch = norm(lp_branch_id);
  if (!branch) return null;
  const rep = norm(rep_name);
  const active = (rows || []).filter((r) => r.active !== false && norm(r.lp_branch_id) === branch);
  if (rep) {
    const exact = active.find((r) => norm(r.lp_rep_name) && norm(r.lp_rep_name) === rep);
    if (exact) return exact;
  }
  return active.find((r) => !norm(r.lp_rep_name)) || null;
}

export async function resolvePartnerOwner(lead, deps = {}) {
  return matchPartnerRow(await loadPartnerMap(deps), lead);
}

/** Every partner GHL user id, active or not. */
export async function partnerUserIds(deps = {}) {
  const rows = await loadPartnerMap(deps);
  return new Set(rows.map((r) => String(r.ghl_user_id || '').trim()).filter(Boolean));
}

/** Upper-cased branches any ACTIVE row maps (the fast poll's filter). */
export async function partnerBranches(deps = {}) {
  const rows = await loadPartnerMap(deps);
  return new Set(rows.filter((r) => r.active !== false).map((r) => String(r.lp_branch_id || '').trim().toUpperCase()).filter(Boolean));
}

/** Upper-cased branches ANY row maps, active or not (the "used to be partner" test). */
export async function allPartnerBranches(deps = {}) {
  const rows = await loadPartnerMap(deps);
  return new Set(rows.map((r) => String(r.lp_branch_id || '').trim().toUpperCase()).filter(Boolean));
}

/** Partner name for a GHL user id, or null. */
export async function partnerNameForUser(userId, deps = {}) {
  if (!userId) return null;
  const rows = await loadPartnerMap(deps);
  return rows.find((r) => String(r.ghl_user_id) === String(userId))?.partner_name || null;
}
