/**
 * LP Prospect Address Backfill — src/jobs/lp-address-backfill.js
 *
 * Section D3 (2026-08-18 handoff), built on F4: LP prospects whose address
 * is blank while the linked GHL contact holds a real one are repaired via
 * POST /api/Customers/UpdateProspectInfo — the ONLY primitive that can
 * (LeadAdd dedupes onto the prospect and never updates its address; proven
 * live on prospect 452653, which kept a blank address through an estimator
 * push carrying "4360 Washington Place").
 *
 * Sweep:   lp_leads WHERE address is blank-ish AND ghl_contact_id IS NOT NULL,
 *          GHL contact has address1 → UpdateProspectInfo → read back via
 *          GetCustomersByProspectID and CONFIRM the address took. Log
 *          before/after. Never silently no-op — a failed update throws and
 *          is reported.
 * Trigger: backfillProspectAddressForContact(contactId) is exported for the
 *          GHL contact-updated path (call it when address1 becomes
 *          non-empty) and for one-off repairs.
 * Gate:    LP_ADDRESS_BACKFILL_ENABLED — ships UNSET (scheduler disarmed).
 * Rate:    F6 — 60 LP calls/min domain-wide shared with the sync engine.
 *          Each repair costs 3 LP calls (read, write, read-back); the sweep
 *          caps at LP_ADDRESS_BACKFILL_BATCH per pass with an inter-repair
 *          delay, keeping worst case well under the ceiling.
 * CAUTION: UpdateProspectInfo OVERWRITES the fields you send. Only fields
 *          with real values are ever transmitted (buildProspectUpdateFields,
 *          unit-tested) — an empty string is NEVER sent over a populated LP
 *          field.
 *
 * ─── 2026-08-27: the "undefined" blindness fix ──────────────────────────
 * This job shipped testing blankness as `String(x||'').trim() !== ''`, and
 * the sweep queried `.is('address', null)`. Both miss the single most common
 * poisoned value in production: the literal string "undefined", left by a JS
 * serialisation leak in the chatbot intake path.
 *
 * Live proof (contact q5GehRye7DNkN6jlmjl3, Myron Thorner): the per-contact
 * route returned `lp_address_already_present` and skipped a prospect whose LP
 * Address1 was literally "undefined" and whose CSZ was ",   ". The job built
 * to repair exactly this could not see it. Nulling the value by hand and
 * re-running the same route repaired it immediately.
 *
 * Blankness is now decided in ONE place — src/lp-address-validity.js — for
 * this job, the appointment pre-flight and the LP write gate alike.
 */

import supabase from '../supabase.js';
import { getGHLContact } from '../ghl.js';
import { repairProspectAddress } from '../services/lp-callback-requeue.js';
import { isBlankAddress, hasRealValue, BLANKISH_SQL_OR } from '../lp-address-validity.js';

const BACKFILL_ENABLED = () =>
  String(process.env.LP_ADDRESS_BACKFILL_ENABLED || '').toLowerCase() === 'true';
const SWEEP_INTERVAL_MS = Number(process.env.LP_ADDRESS_BACKFILL_INTERVAL_MS || 15 * 60 * 1000);
const BATCH = () => Math.max(1, Number(process.env.LP_ADDRESS_BACKFILL_BATCH) || 10);
const INTER_REPAIR_DELAY_MS = 4000; // 3 LP calls per repair → ~45 calls/min worst case at zero delay; this keeps it far lower

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Repair one contact's LP prospect address from its GHL record.
 * Returns { repaired, reason, prospect_id } and THROWS on a failed update
 * (fail loud — never a silent no-op).
 */
export async function backfillProspectAddressForContact(contactId, deps = {}) {
  const db = deps.supabase || supabase;
  const { data: rows, error } = await db
    .from('lp_leads')
    .select('lp_lead_id, lp_prospect_id, address')
    .eq('ghl_contact_id', contactId)
    .order('created_at_lp', { ascending: false })
    .limit(1);
  if (error) throw new Error(`lp_leads lookup failed for ${contactId}: ${error.message}`);
  const row = rows?.[0];
  if (!row?.lp_prospect_id) return { repaired: false, reason: 'no_lp_prospect', prospect_id: null };

  // 2026-08-27 — was: String(row.address || '').trim() !== ''. That test read
  // the literal string "undefined" as a populated address and skipped the
  // repair. isBlankAddress() treats undefined/null/none/n-a placeholders as
  // blank, which is what they are.
  if (hasRealValue(row.address)) {
    return { repaired: false, reason: 'lp_address_already_present', prospect_id: row.lp_prospect_id };
  }

  const fetchContact = deps.getGHLContact || getGHLContact;
  const contact = await fetchContact(contactId);
  // Same normaliser on the GHL side — a GHL contact carrying "undefined" is
  // not a repair source, it is a second copy of the same bug.
  if (!contact || isBlankAddress(contact.address1)) {
    return { repaired: false, reason: 'ghl_has_no_address', prospect_id: row.lp_prospect_id };
  }

  const result = await (deps.repairProspectAddress || repairProspectAddress)({
    prospectId: row.lp_prospect_id,
    ghlContact: contact,
  }, deps);

  return {
    repaired: true,
    reason: 'repaired',
    prospect_id: row.lp_prospect_id,
    // Surfacing the poisoned value makes the "undefined" class of failure
    // visible in logs instead of looking like an ordinary blank.
    repaired_from: row.address === null ? '(null)' : String(row.address),
    before: result.before,
    after: result.after,
  };
}

/**
 * The sweep: page over lp_leads rows with a blank-ish LP address and a GHL
 * link, repair the ones whose GHL contact holds an address. Distinct
 * prospects only — two lds rows on one prospect need one repair.
 */
export async function runAddressBackfillSweep(deps = {}) {
  const db = deps.supabase || supabase;
  const { data, error } = await db
    .from('lp_leads')
    // 2026-08-27 — was .is('address', null), which made every "undefined"
    // row invisible to this sweep. BLANKISH_SQL_OR also matches the empty
    // string and the placeholder tokens.
    .or(BLANKISH_SQL_OR)
    .not('ghl_contact_id', 'is', null)
    .not('lp_prospect_id', 'is', null)
    .order('created_at_lp', { ascending: false })
    .limit(200);
  if (error) {
    console.warn(`[AddrBackfill] sweep query failed: ${error.message}`);
    return { candidates: 0, error: error.message };
  }

  // Distinct prospects, newest first. The .or() above is a cheap server-side
  // narrowing; isBlankAddress() is the authority.
  const seen = new Set();
  const candidates = [];
  for (const r of (data || [])) {
    if (!isBlankAddress(r.address)) continue;
    if (seen.has(r.lp_prospect_id)) continue;
    seen.add(r.lp_prospect_id);
    candidates.push(r);
  }

  const batch = candidates.slice(0, BATCH());
  let repaired = 0, skipped = 0, failed = 0;
  for (const row of batch) {
    try {
      const res = await backfillProspectAddressForContact(row.ghl_contact_id, deps);
      if (res.repaired) {
        repaired++;
        console.log(`[AddrBackfill] ✅ prospect ${res.prospect_id} (contact ${row.ghl_contact_id}) address repaired — was ${res.repaired_from}`);
      } else {
        skipped++;
      }
    } catch (err) {
      failed++;
      console.error(`[AddrBackfill] ⛔ prospect ${row.lp_prospect_id} (contact ${row.ghl_contact_id}) repair FAILED: ${err.message}`);
    }
    if (!deps.skipDelay) await sleep(INTER_REPAIR_DELAY_MS);
  }

  console.log(`[AddrBackfill] sweep: ${candidates.length} blank-address prospects, batch ${batch.length} → ${repaired} repaired, ${skipped} skipped, ${failed} failed`);
  return { candidates: candidates.length, batch: batch.length, repaired, skipped, failed };
}

/** Dry-run count for the post-deploy report: how many lp_leads rows have a
 *  blank-ish LP address while the linked GHL contact has one.
 *
 *  NOTE: this count is EXPECTED TO RISE after the 2026-08-27 fix. The extra
 *  rows are the "undefined"-poisoned prospects that were previously invisible,
 *  not new breakage. */
export async function countBackfillCandidates(deps = {}) {
  const db = deps.supabase || supabase;
  const { count, error } = await db
    .from('lp_leads')
    .select('id', { count: 'exact', head: true })
    .or(BLANKISH_SQL_OR)
    .not('ghl_contact_id', 'is', null)
    .not('lp_prospect_id', 'is', null);
  if (error) return { error: error.message };
  return { blank_lp_address_with_ghl_link: count };
}

let _handle = null;
export function startLpAddressBackfillScheduler() {
  if (!BACKFILL_ENABLED()) {
    console.log('[AddrBackfill] scheduler DISARMED (set LP_ADDRESS_BACKFILL_ENABLED=true to arm)');
    return;
  }
  if (_handle) return;
  _handle = setInterval(() => {
    runAddressBackfillSweep().catch((err) => console.error(`[AddrBackfill] sweep error: ${err.message}`));
  }, SWEEP_INTERVAL_MS);
  if (_handle.unref) _handle.unref();
  console.log(`[AddrBackfill] Scheduler armed: every ${Math.round(SWEEP_INTERVAL_MS / 60000)}min, batch ${BATCH()}`);
}

export function registerLpAddressBackfillRoutes(app) {
  // Manual sweep (respects the gate being conceptually armed — the route is
  // an explicit human/ops trigger, so it runs even when the scheduler is
  // disarmed; the dry-run count route is read-only).
  app.post('/n8n/lp-address-backfill/sweep', async (req, res) => {
    try {
      res.json(await runAddressBackfillSweep());
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  app.get('/n8n/lp-address-backfill/dry-run-count', async (req, res) => {
    try {
      res.json(await countBackfillCandidates());
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  // Per-contact trigger for the GHL contact-updated path (call when
  // address1 becomes non-empty).
  app.post('/n8n/lp-address-backfill/contact/:contactId', async (req, res) => {
    try {
      res.json(await backfillProspectAddressForContact(req.params.contactId));
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}

export default {
  runAddressBackfillSweep,
  backfillProspectAddressForContact,
  countBackfillCandidates,
  startLpAddressBackfillScheduler,
  registerLpAddressBackfillRoutes,
};
