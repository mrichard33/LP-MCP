/**
 * LP Addlead Address-Hold Sweeper — src/jobs/lp-addlead-hold-sweeper.js
 *
 * Section D2 (2026-08-18 handoff). Works the lp_addlead_address_hold table
 * the address gate parks incomplete addleads into:
 *
 *   due row → re-enrich from the GHL contact →
 *     complete            → forward to LP, write in1_id back to the GHL
 *                           contact, release ('enriched')
 *     still incomplete    → attempts+1, next_attempt_at += LP_ADDRESS_HOLD_MINUTES
 *     retries exhausted   → forward ANYWAY with notes stamped
 *                           "INCOMPLETE ADDRESS ON FILE", ONE GroupMe alert,
 *                           release ('exhausted')
 *
 * Every held lead still reaches LP — the hold trades minutes of
 * speed-to-lead for a complete prospect record, never a dropped lead.
 *
 * Scheduler pattern follows appointment-parity-watchdog, and — PR #702's
 * lesson — startLpAddleadHoldScheduler()/registerLpAddleadHoldRoutes() are
 * REGISTERED in src/index.js. A job that is never imported is dead code.
 */

import supabase from '../supabase.js';
import { sendGroupMeMessage } from '../groupme.js';
import { addGHLNote, updateGHLContactFields, applyGHLTag } from '../ghl.js';
import { forwardToLp } from '../lp-addlead-proxy.js';
import {
  enrichBodyFromGhl,
  missingAddressFields,
  stampIncompleteNotes,
  holdMinutes,
  holdMaxRetries,
  looksLikeGhlContactId,
} from '../services/lp-address-gate.js';

const FIELD_LP_INBOUND_LEAD_ID = '3YMxheIlPyhACB8zyc3W'; // in1_id custom field

const SWEEP_INTERVAL_MS = Number(process.env.LP_ADDRESS_HOLD_SWEEP_INTERVAL_MS || 60 * 1000);

/** Parse the in1_id out of LP's raw addlead response bytes. */
export function parseInboundIdFromRaw(raw) {
  const text = String(raw || '');
  const m = /lead added[:\s]+(\d+)/i.exec(text);
  return m ? m[1] : null;
}

async function releaseHold(db, id, reason, in1Id = null) {
  const { error } = await db
    .from('lp_addlead_address_hold')
    .update({ released_at: new Date().toISOString(), release_reason: reason, lp_in1_id: in1Id })
    .eq('id', id);
  if (error) console.warn(`[AddrHold] release update failed for hold ${id}: ${error.message}`);
}

async function forwardHeldLead(db, hold, body, reason, deps = {}) {
  const forward = deps.forwardToLp || forwardToLp;
  const lp = await forward(body);
  const rawText = lp.raw ? lp.raw.toString('utf8') : '';
  const in1Id = parseInboundIdFromRaw(rawText);
  if (lp.status >= 400 || !in1Id) {
    // LP refused or returned no id — leave the hold in place for the next
    // pass rather than losing the lead. attempts already advanced.
    console.error(`[AddrHold] LP forward for hold ${hold.id} (log=${hold.ghl_contact_id}) returned status=${lp.status} in1=${in1Id || 'none'} — hold retained`);
    return { forwarded: false, status: lp.status };
  }

  await releaseHold(db, hold.id, reason, in1Id);

  // Write the in1_id back to the GHL contact — the workflow's own writeback
  // never ran because the original webhook call got the HELD response.
  if (looksLikeGhlContactId(hold.ghl_contact_id)) {
    try {
      await updateGHLContactFields(hold.ghl_contact_id, [
        { id: FIELD_LP_INBOUND_LEAD_ID, field_value: in1Id },
      ]);
      await applyGHLTag(hold.ghl_contact_id, 'lp-pushed-by-agentic');
      await addGHLNote(hold.ghl_contact_id,
        `[LP ADDRESS HOLD] Lead released to Lead Perfection (${reason})\n` +
        `LP Inbound ID (in1_id): ${in1Id}\n` +
        `Held ${hold.attempts} retry cycle(s) waiting for a complete address` +
        (reason === 'exhausted' ? ` — forwarded with "${'INCOMPLETE ADDRESS ON FILE'}" stamped in notes.` : '.')
      );
    } catch (err) {
      console.warn(`[AddrHold] GHL writeback failed for ${hold.ghl_contact_id} (non-blocking): ${err.message}`);
    }
  }
  console.log(`[AddrHold] ✅ hold ${hold.id} released (${reason}): log=${hold.ghl_contact_id} in1=${in1Id}`);
  return { forwarded: true, in1_id: in1Id };
}

export async function runAddleadHoldSweep(deps = {}) {
  const db = deps.supabase || supabase;
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from('lp_addlead_address_hold')
    .select('*')
    .is('released_at', null)
    .lte('next_attempt_at', nowIso)
    .order('next_attempt_at', { ascending: true })
    .limit(20);
  if (error) {
    console.warn(`[AddrHold] sweep query failed: ${error.message}`);
    return { processed: 0, error: error.message };
  }

  let released = 0, exhausted = 0, retried = 0;
  for (const hold of (data || [])) {
    try {
      const attempts = (hold.attempts || 0) + 1;
      const { body: enriched } = await enrichBodyFromGhl(hold.payload || {}, deps);
      const missing = missingAddressFields(enriched);

      if (missing.length === 0) {
        await db.from('lp_addlead_address_hold').update({ attempts }).eq('id', hold.id);
        const r = await forwardHeldLead(db, { ...hold, attempts }, enriched, 'enriched', deps);
        if (r.forwarded) released++;
        continue;
      }

      if (attempts >= holdMaxRetries()) {
        // NEVER DROP: retries exhausted → forward anyway, stamped, one alert.
        const stamped = stampIncompleteNotes(enriched);
        await db.from('lp_addlead_address_hold').update({ attempts }).eq('id', hold.id);
        const r = await forwardHeldLead(db, { ...hold, attempts }, stamped, 'exhausted', deps);
        if (r.forwarded) {
          exhausted++;
          const name = [stamped.firstname, stamped.lastname].filter(Boolean).join(' ') || '(no name)';
          sendGroupMeMessage(
            `⚠️ ADDLEAD FORWARDED WITH INCOMPLETE ADDRESS\n` +
            `👤 ${name}\n` +
            `📞 ${stamped.phone1 || stamped.phone || 'no phone'} | Contact: ${hold.ghl_contact_id}\n` +
            `Missing after ${attempts} enrichment attempts: ${missing.join(', ')}\n` +
            `LP notes are stamped "INCOMPLETE ADDRESS ON FILE" — collect the address on the first call ` +
            `and it will backfill to the prospect via UpdateProspectInfo.`,
            { flushNow: true }
          ).catch((err) => console.warn(`[AddrHold] GroupMe alert failed: ${err.message}`));
        }
        continue;
      }

      const nextAt = new Date(Date.now() + holdMinutes() * 60 * 1000).toISOString();
      const { error: updErr } = await db
        .from('lp_addlead_address_hold')
        .update({ attempts, next_attempt_at: nextAt })
        .eq('id', hold.id);
      if (updErr) console.warn(`[AddrHold] retry update failed for hold ${hold.id}: ${updErr.message}`);
      retried++;
    } catch (err) {
      console.error(`[AddrHold] hold ${hold.id} processing threw (retained for next pass): ${err.message}`);
    }
  }

  if ((data || []).length) {
    console.log(`[AddrHold] sweep: ${data.length} due → ${released} enriched+released, ${exhausted} exhausted+forwarded, ${retried} re-parked`);
  }
  return { processed: (data || []).length, released, exhausted, retried };
}

let _handle = null;
export function startLpAddleadHoldScheduler() {
  if (_handle) return;
  _handle = setInterval(() => {
    runAddleadHoldSweep().catch((err) => console.error(`[AddrHold] sweep error: ${err.message}`));
  }, SWEEP_INTERVAL_MS);
  if (_handle.unref) _handle.unref();
  console.log(`[AddrHold] Scheduler armed: every ${Math.round(SWEEP_INTERVAL_MS / 1000)}s (hold=${holdMinutes()}min, max_retries=${holdMaxRetries()})`);
}

export function registerLpAddleadHoldRoutes(app) {
  app.post('/n8n/lp-addlead-hold/sweep', async (req, res) => {
    try {
      res.json(await runAddleadHoldSweep());
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}

export const _internal = { forwardHeldLead, releaseHold };
export default { runAddleadHoldSweep, startLpAddleadHoldScheduler, registerLpAddleadHoldRoutes };
