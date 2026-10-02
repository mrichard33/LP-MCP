// "Post only new" — src/alert-posted.js
//
// 2026-10-02 (Mark, alert noise cut). One store for "has this already been
// put in front of a person?": audit_posted_items (sql/143, permanent flag
// sql/144). Lifted out of the F.0 audit so every alert that must post only new
// items — the morning digest sections, the once-per-contact drift card, the
// intake-journal card, the uncalled-leads card — shares one table and one rule.
//
//   audit       which alert ('f0-s52-integrity', 'drift', 'lead_uncalled', …)
//   contact_id  the item's id: a contact id, an LP lead id, a journal id
//   reason      what was wrong, so a NEW problem on the same contact still posts
//   permanent   never expires (drift: once per contact, ever, Mark 2026-10-02)
//
// A row counts as "posted" while it is permanent or younger than the caller's
// TTL. A failed read returns EVERY item as new: a broken dedupe store must
// never turn a real problem into silence. A failed write is logged; the item
// may then post again next time, which is the safe direction.

const CHUNK = 200;

let _supabase = null;
async function defaultSupabase() {
  if (!_supabase) _supabase = (await import('./supabase.js')).default;
  return _supabase;
}

/**
 * @param {object} o
 * @param {string} o.audit
 * @param {Array<{ key: string, reason: string }>} o.items  extra fields pass through
 * @param {number} [o.ttlDays=30]  ignored for permanent rows, which always count
 * @param {number} [o.nowMs]
 * @param {object} [o.deps]  { supabase }
 * @returns {Promise<{ fresh: object[], dedupe: 'ok'|'unavailable'|'none' }>}
 */
export async function filterNew({ audit, items, ttlDays = 30, nowMs = Date.now(), deps = {} }) {
  if (!items?.length) return { fresh: [], dedupe: 'none' };
  const db = deps.supabase || await defaultSupabase();
  const cutoffIso = new Date(nowMs - ttlDays * 86_400_000).toISOString();
  try {
    // Housekeeping: expired, non-permanent rows of this audit only.
    await db.from('audit_posted_items').delete().eq('audit', audit).eq('permanent', false).lt('posted_at', cutoffIso);
    const ids = [...new Set(items.map((i) => String(i.key)))];
    const seen = new Set();
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { data, error } = await db.from('audit_posted_items')
        .select('contact_id, reason, posted_at, permanent')
        .eq('audit', audit)
        .in('contact_id', ids.slice(i, i + CHUNK));
      if (error) throw new Error(error.message);
      for (const r of data || []) {
        if (r.permanent === true || String(r.posted_at) >= cutoffIso) seen.add(`${r.contact_id}|${r.reason}`);
      }
    }
    return { fresh: items.filter((i) => !seen.has(`${i.key}|${i.reason}`)), dedupe: 'ok' };
  } catch (err) {
    console.warn(`[AlertPosted] ${audit}: audit_posted_items unreadable — treating every item as new: ${err.message}`);
    return { fresh: items, dedupe: 'unavailable' };
  }
}

/** Record items as posted. Never throws. */
export async function recordPosted({ audit, items, permanent = false, nowMs = Date.now(), deps = {} }) {
  if (!items?.length) return { ok: true, recorded: 0 };
  try {
    const db = deps.supabase || await defaultSupabase();
    const postedAt = new Date(nowMs).toISOString();
    const rows = items.map((i) => ({ audit, contact_id: String(i.key), reason: i.reason, posted_at: postedAt, permanent }));
    const { error } = await db.from('audit_posted_items').upsert(rows, { onConflict: 'audit,contact_id,reason' });
    if (error) throw new Error(error.message);
    return { ok: true, recorded: rows.length };
  } catch (err) {
    console.warn(`[AlertPosted] ${audit}: could not record ${items.length} posted item(s) — they may post again: ${err.message}`);
    return { ok: false, recorded: 0, error: err.message };
  }
}

/** Highest N already posted for a counts-only line stored as reason `count:N`. */
export async function lastPostedCount({ audit, key, ttlDays = 30, nowMs = Date.now(), deps = {} }) {
  const db = deps.supabase || await defaultSupabase();
  const cutoffIso = new Date(nowMs - ttlDays * 86_400_000).toISOString();
  const { data, error } = await db.from('audit_posted_items')
    .select('reason, posted_at')
    .eq('audit', audit)
    .eq('contact_id', String(key))
    .gte('posted_at', cutoffIso);
  if (error) throw new Error(error.message);
  let max = 0;
  for (const r of data || []) {
    const n = Number(String(r.reason).replace(/^count:/, ''));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/** Pure. Max `limit` lines, then "+N more". */
export function capLines(lines, limit = 10) {
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit), `+${lines.length - limit} more`];
}

/** ALERT_DIGEST_ENABLED, default true (Mark, 2026-10-02). False restores per-alert posting. */
export function alertDigestEnabled(env = process.env) {
  return String(env.ALERT_DIGEST_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
}
