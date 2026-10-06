// ─── LP inbound-queue mirror — src/lp-inbound-queue.js ────────────────────────
//
// 2026-10-06 (issues #153 / #363). LP's inbound queue (GetInboundLeadInfo) had
// no copy on our side, so "how long did this inquiry wait to be checked out?"
// and "which inquiries with an appointment are still waiting?" had no answer
// outside a live LP read. src/jobs/inbound-checkout-watch.js upserts every row
// it reads into lp_inbound_queue (sql/149) through here; create_lp_lead reads
// a row back by in1_id before it asks LP.
//
// FAIL SOFT: until sql/149 is applied the table is missing. A missing table is
// logged ONCE per process and every call returns { ok:false, missing:true } —
// it must never stop the watch from alerting. Any other error is returned,
// never thrown.
//
// TIMES are converted to true UTC here with lpStoredToUtcMs (LP sends Eastern
// wall clock with no offset; never a bare Date.parse).

import { lpStoredToUtcMs } from './lp-dates.js';
import { phone10, lpDateToKey } from './new-lead-dial-backstop.js';

export const TABLE = 'lp_inbound_queue';
const CHUNK = 200;

const t = (v) => {
  const s = String(v ?? '').trim();
  return s || null;
};
const iso = (raw) => {
  const ms = lpStoredToUtcMs(t(raw));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/** One raw GetInboundLeadInfo row → one lp_inbound_queue row (null without an id). Pure. */
export function inboundQueueRow(raw = {}, nowMs = Date.now()) {
  const in1 = t(raw.id ?? raw.in1_id);
  if (!in1) return null;
  return {
    in1_id: in1,
    received_at_lp: iso(raw.datereceived),
    checkout_at_lp: iso(raw.checkoutdate),
    checkout_user: t(raw.checkoutusername),
    checkout_user_id: t(raw.checkoutuser),
    method: t(raw.method),
    lds_id: t(raw.lds_id),
    cst_id: t(raw.cst_id),
    dsp_id: t(raw.dsp_id),
    kill_reason: t(raw.killreason),
    sender: t(raw.sender),
    srs_id: t(raw.srs_id),
    source: t(raw.source),
    source_sub: t(raw.sourcesubdescr),
    brn_id: t(raw.brn_id),
    first_name: t(raw.firstname),
    last_name: t(raw.lastname),
    phone10: phone10(raw.phone),
    lognumber: t(raw.lognumber),
    appt_date: lpDateToKey(raw.apptdate),
    appt_time: t(raw.appttime),
    raw,
    updated_at: new Date(nowMs).toISOString(),
  };
}

/** PostgREST / Postgres "that table does not exist". */
export function isMissingTable(error) {
  const code = String(error?.code ?? '');
  const msg = String(error?.message ?? '');
  return code === '42P01' || code === 'PGRST205' || /does not exist|could not find the table/i.test(msg);
}

const warned = new Set();
function warnMissingOnce(table) {
  if (warned.has(table)) return;
  warned.add(table);
  console.warn(`[LPInboundQueue] ${table} is missing — apply sql/149 from the Supabase dashboard. Continuing without it.`);
}
export function __resetMissingWarningsForTests() { warned.clear(); }

/**
 * Upsert raw inbound rows. first_seen_at is left to its column default, so a
 * row keeps the moment we first saw it. Never throws.
 * @returns {Promise<{ ok: boolean, upserted: number, missing?: boolean, error?: string }>}
 */
export async function upsertInboundQueue(db, rawRows, { nowMs = Date.now() } = {}) {
  const rows = [];
  const seen = new Set();
  for (const r of rawRows || []) {
    const row = inboundQueueRow(r, nowMs);
    if (!row || seen.has(row.in1_id)) continue;
    seen.add(row.in1_id);
    rows.push(row);
  }
  if (!rows.length) return { ok: true, upserted: 0 };
  try {
    let upserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await db.from(TABLE).upsert(rows.slice(i, i + CHUNK), { onConflict: 'in1_id' });
      if (error) {
        if (isMissingTable(error)) { warnMissingOnce(TABLE); return { ok: false, upserted, missing: true }; }
        return { ok: false, upserted, error: error.message };
      }
      upserted += Math.min(CHUNK, rows.length - i);
    }
    return { ok: true, upserted };
  } catch (err) {
    return { ok: false, upserted: 0, error: err.message };
  }
}

/** One mirrored row by in1_id, or null (missing table, no row, read error). Never throws. */
export async function readInboundQueueRow(db, in1) {
  if (!in1) return null;
  try {
    const { data, error } = await db.from(TABLE).select('*').eq('in1_id', String(in1)).maybeSingle();
    if (error) {
      if (isMissingTable(error)) warnMissingOnce(TABLE);
      return null;
    }
    return data || null;
  } catch {
    return null;
  }
}

/**
 * Insert audit rows into a sql/149 table that may not exist yet. Never throws.
 * Used for booked_dial_routing_log.
 */
export async function insertSoft(db, table, rows) {
  if (!rows?.length) return { ok: true, inserted: 0 };
  try {
    const { error } = await db.from(table).insert(rows);
    if (error) {
      if (isMissingTable(error)) { warnMissingOnce(table); return { ok: false, inserted: 0, missing: true }; }
      return { ok: false, inserted: 0, error: error.message };
    }
    return { ok: true, inserted: rows.length };
  } catch (err) {
    return { ok: false, inserted: 0, error: err.message };
  }
}
