// ─── Rehash tag cleanup — src/services/rehash-tag-cleanup.js ─────────────────
//
// 2026-10-14 (Mark: "GHL tags must be plain, reusable labels. Never put dates,
// IDs, or other unique values in a tag."). One-time job: the rehash sweep had
// put rehash-lead:<lds>, rehash-since:<YYYY-MM-DD> and rehash-done:<lds> on 646
// contacts. This moves what they say into rehash_stage and takes them off GHL.
//
//   1. BACKFILL  contacts whose contact_tag_snapshot holds one of the three,
//                each READ LIVE from GHL (never written from the snapshot alone:
//                the stale-webhook rule, 2026-09-30):
//                  rehash + rehash-lead:X (+ rehash-since:D) → open row (X, D)
//                  rehash-done:X → ended row, end_reason backfill_done_tag
//                  ('rehash-done:unknown' → lp_lead_id 'unknown')
//                Inserts ignore a row that already exists, so a re-run is safe.
//   2. REMOVE    one remove_tag agent_actions row per old tag (rule
//                REHASH_TAG_CLEANUP), only after that contact's backfill wrote.
//                The plain `rehash` tag stays. bypass_suppression: removing our
//                own bookkeeping tags contacts nobody, so a stop-bot contact is
//                cleaned too (the flag matters only to the mutation gate and to
//                a stop-bot removal, and stop-bot is never in this list).
//
// Dry run by default (counts only). GHL reads are throttled (one per
// throttleMs, 300ms default) with retry and backoff on 429/5xx; a contact that
// still cannot be read is logged and skipped, and the next run picks it up.
//
// deps: { supabase, getContact, sleep?, log? }

export const RULE_KEY = 'REHASH_TAG_CLEANUP';
export const LEGACY_PREFIXES = Object.freeze(['rehash-lead:', 'rehash-since:', 'rehash-done:']);
const STAGE_TABLE = 'rehash_stage';

const lower = (t) => String(t ?? '').trim().toLowerCase();

/** Is this one of the old one-off rehash tags? Pure. */
export function isLegacyRehashTag(tag) {
  const t = lower(tag);
  return LEGACY_PREFIXES.some((p) => t.startsWith(p));
}

/**
 * What one contact's live tags say. Pure.
 * @returns {{ active: {lp_lead_id, demo_date}|null, done: string[], remove: string[] }}
 *   remove keeps each tag exactly as GHL spells it (the DELETE matches it).
 */
export function parseLegacyRehashTags(tags) {
  const raw = Array.isArray(tags) ? tags.filter((t) => typeof t === 'string') : [];
  const t = raw.map(lower);
  const tagged = t.includes('rehash');
  const after = (prefix) => t.filter((x) => x.startsWith(prefix)).map((x) => x.slice(prefix.length).trim()).filter(Boolean);
  const leads = after('rehash-lead:');
  const since = after('rehash-since:').find((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) || null;
  const active = tagged && leads.length ? { lp_lead_id: leads[0], demo_date: since } : null;
  // An open stage for a lead wins over a done tag for the same lead (the old
  // sweep read the tagged state first).
  const done = [...new Set(after('rehash-done:'))].filter((x) => x !== active?.lp_lead_id);
  return { active, done, remove: raw.filter(isLegacyRehashTag) };
}

/** The rehash_stage rows for one contact. Pure. */
export function stageRowsFor(contactId, parsed, nowIso) {
  const rows = [];
  if (parsed.active) rows.push({ ghl_contact_id: contactId, lp_lead_id: parsed.active.lp_lead_id, demo_date: parsed.active.demo_date });
  for (const lead of parsed.done) {
    rows.push({ ghl_contact_id: contactId, lp_lead_id: lead, demo_date: null, started_at: nowIso, ended_at: nowIso, end_reason: 'backfill_done_tag' });
  }
  return rows;
}

export function removeRow(contactId, tag) {
  return {
    event_id: null,
    action_type: 'remove_tag',
    target_system: 'ghl',
    target_entity: 'contact',
    target_id: contactId,
    action_payload: { tag, bypass_suppression: true },
    reasoning: 'No dates or ids in GHL tags (Mark, 2026-10-14): the value now lives in rehash_stage.',
    rule_applied: RULE_KEY,
    confidence: 1.0,
    status: 'pending',
    requires_approval: false,
    priority: 70,
  };
}

const isRetryable = (err) => /\b(429|5\d\d)\b|timeout|timed out|ECONNRESET|fetch failed/i.test(String(err?.message || err));

async function readWithRetry(getContact, id, sleep, tries = 4) {
  let wait = 1000;
  for (let i = 0; ; i++) {
    try {
      return await getContact(id);
    } catch (err) {
      if (i >= tries - 1 || !isRetryable(err)) throw err;
      await sleep(wait);
      wait *= 2;
    }
  }
}

/**
 * Contacts that carry an old tag by contact_tag_snapshot. Every such tag was
 * written by the sweep (rule REHASH_TAG_SWEEP; no agent_rules template or other
 * path builds one), so the candidates are those rows' contacts plus any contact
 * the snapshot shows with `rehash`; the snapshot then keeps the ones it shows
 * with an old tag. A contact missing from the snapshot is kept (read live).
 */
async function readSnapshotContacts(supabase) {
  const ids = new Set();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase.from('agent_actions')
      .select('target_id')
      .eq('rule_applied', 'REHASH_TAG_SWEEP')
      .eq('action_type', 'add_tag')
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`sweep history read: ${error.message}`);
    for (const r of data || []) if (r?.target_id) ids.add(r.target_id);
    if (!data || data.length < pageSize) break;
  }
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase.from('contact_tag_snapshot')
      .select('ghl_contact_id')
      .contains('tags', ['rehash'])
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`snapshot read: ${error.message}`);
    for (const r of data || []) if (r?.ghl_contact_id) ids.add(r.ghl_contact_id);
    if (!data || data.length < pageSize) break;
  }
  const all = [...ids];
  const keep = [];
  for (let i = 0; i < all.length; i += 200) {
    const chunk = all.slice(i, i + 200);
    const { data, error } = await supabase.from('contact_tag_snapshot')
      .select('ghl_contact_id, tags').in('ghl_contact_id', chunk);
    if (error) throw new Error(`snapshot read: ${error.message}`);
    const seen = new Map((data || []).map((r) => [r.ghl_contact_id, r.tags || []]));
    for (const id of chunk) if (!seen.has(id) || seen.get(id).some(isLegacyRehashTag)) keep.push(id);
  }
  return keep;
}

/** contactId -> Set of tags already queued for removal and not yet run. */
async function readPendingRemovals(supabase) {
  const { data, error } = await supabase.from('agent_actions')
    .select('target_id, action_payload')
    .eq('rule_applied', RULE_KEY)
    .in('status', ['pending', 'approved', 'executing'])
    .limit(10000);
  if (error) throw new Error(`pending removals read: ${error.message}`);
  const map = new Map();
  for (const r of data || []) {
    const tag = r?.action_payload?.tag;
    if (!r?.target_id || !tag) continue;
    if (!map.has(r.target_id)) map.set(r.target_id, new Set());
    map.get(r.target_id).add(lower(tag));
  }
  return map;
}

export async function runRehashTagCleanup({ dryRun = true, throttleMs = 300, limit = 0, contactIds = null } = {}, deps = {}) {
  const { supabase, getContact } = deps;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.log || console.log;
  const nowIso = new Date((deps.now || Date.now)()).toISOString();
  const report = {
    dry_run: dryRun,
    contacts_found: 0,
    contacts_read: 0,
    rows_backfilled: { active: 0, ended: 0 },
    tags_queued_for_removal: 0,
    unreadable: 0,
    unreadable_ids: [],
    errors: [],
  };

  let ids = Array.isArray(contactIds) && contactIds.length ? [...new Set(contactIds)] : await readSnapshotContacts(supabase);
  report.contacts_found = ids.length;
  if (limit > 0) ids = ids.slice(0, limit);
  const pending = dryRun ? new Map() : await readPendingRemovals(supabase);

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (i > 0 && throttleMs > 0) await sleep(throttleMs);
    let contact;
    try {
      contact = await readWithRetry(getContact, id, sleep);
    } catch (err) {
      contact = null;
      report.errors.push(`${id}: read ${String(err?.message || err).slice(0, 120)}`);
    }
    if (!contact) {
      report.unreadable++;
      if (report.unreadable_ids.length < 50) report.unreadable_ids.push(id);
      log(`[RehashTagCleanup] ${id}: unreadable, skipped (the next run picks it up)`);
      continue;
    }
    report.contacts_read++;
    const parsed = parseLegacyRehashTags(contact.tags || []);
    const rows = stageRowsFor(id, parsed, nowIso);
    const already = pending.get(id) || new Set();
    const removals = parsed.remove.filter((t) => !already.has(lower(t)));

    if (dryRun) {
      report.rows_backfilled.active += parsed.active ? 1 : 0;
      report.rows_backfilled.ended += parsed.done.length;
      report.tags_queued_for_removal += removals.length;
      continue;
    }

    if (rows.length) {
      const { error } = await supabase.from(STAGE_TABLE)
        .upsert(rows, { onConflict: 'ghl_contact_id,lp_lead_id', ignoreDuplicates: true });
      // The backfill failed: the tags stay, so the data is not lost. Next run.
      if (error) { report.errors.push(`${id}: backfill ${error.message}`); continue; }
      report.rows_backfilled.active += parsed.active ? 1 : 0;
      report.rows_backfilled.ended += parsed.done.length;
    }
    if (removals.length) {
      const { error } = await supabase.from('agent_actions').insert(removals.map((t) => removeRow(id, t)));
      if (error) { report.errors.push(`${id}: queue ${error.message}`); continue; }
      report.tags_queued_for_removal += removals.length;
    }
  }

  report.errors = report.errors.slice(0, 50);
  log(`[RehashTagCleanup] ${dryRun ? 'DRY' : 'LIVE'}: ${JSON.stringify({ ...report, errors: report.errors.length, unreadable_ids: undefined })}`);
  return report;
}
