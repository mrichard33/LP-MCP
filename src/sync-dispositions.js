// ─── Disposition Sync — src/sync-dispositions.js ──────────────────
//
// LP disposition code reference data. Seeds from LP API endpoint,
// then backfills from actual lead data (LP API only returns ~2 codes).

import supabase from './supabase.js';
import { getDispositions } from './lp-client.js';
import { extractArray } from './sync-utils.js';

// Known disposition code → human-readable label map
export const KNOWN_DISPOSITION_LABELS = {
  'Sale':     { label: 'Contract Signed',            category: 'closed_won',  recoverable: false },
  'Data':     { label: 'No Contact / Raw Lead',      category: 'active',      recoverable: true },
  'OPPFDN':   { label: 'Opportunity Found',          category: 'active',      recoverable: true },
  'CXL':      { label: 'Cancelled',                  category: 'closed_lost', recoverable: true },
  'CCC':      { label: 'Cannot Contact',             category: 'deferred',    recoverable: true },
  'PM':       { label: 'Pending Measure',            category: 'active',      recoverable: false },
  '1Leg':     { label: 'One Leg Present',            category: 'active',      recoverable: true },
  'Set':      { label: 'Appointment Set',            category: 'active',      recoverable: false },
  'Cnf':      { label: 'Appointment Confirmed',      category: 'active',      recoverable: false },
  'NS':       { label: 'No Show',                    category: 'active',      recoverable: true },
  'FDNS':     { label: 'Final Demo No Show',         category: 'active',      recoverable: true },
  'DNC':      { label: 'Do Not Contact',             category: 'dead',        recoverable: false },
  'Verif':    { label: 'Needs Verification',         category: 'active',      recoverable: true },
  'SW':       { label: 'Sold — Written Up',          category: 'closed_won',  recoverable: false },
  'NI':       { label: 'Not Interested',             category: 'closed_lost', recoverable: true },
  'NOP NOP':  { label: 'No Opportunity — No Opp',    category: 'closed_lost', recoverable: false },
  'BO':       { label: 'Be Back / Follow Up',        category: 'active',      recoverable: true },
  'NIS':      { label: 'Not Interested — Shown',     category: 'closed_lost', recoverable: true },
  'NOP ITM':  { label: 'No Opp — In The Market',     category: 'active',      recoverable: true },
  'NOP MPR':  { label: 'No Opp — Must Price Right',  category: 'active',      recoverable: true },
  'No Demo':  { label: 'Demo Not Completed',         category: 'active',      recoverable: true },
  'OPP NOI':  { label: 'Opportunity — Not Int Now',  category: 'deferred',    recoverable: true },
  'NG':       { label: 'No Good / Bad Lead',         category: 'dead',        recoverable: false },
  // Legacy codes (string-only, no category info)
  'NH': 'No Home', 'DK': 'Door Knock - No Answer', 'CB': 'Call Back',
  'AP': 'Appointment Set', 'DM': 'Demo Completed', 'RS': 'Reschedule',
  'SL': 'Sold', 'CN': 'Cancelled', 'NQ': 'Not Qualified',
  'WR': 'Wrong Number', 'DC': 'Disconnected', 'BZ': 'Busy',
  'NA': 'No Answer', 'AM': 'Answering Machine', 'LM': 'Left Message',
  'RF': 'Referral', 'HU': 'Hung Up', 'PI': 'Price Inquiry',
  'CC': 'Credit Check', 'OT': 'Other',
};

// Categories whose dispositions count as "terminal" for the rebook staleness
// guard (a new booking arriving while the GHL disposition mirror still holds
// one of these). DELIBERATELY closed_lost ONLY:
//  - closed_won (Sale/SW): real business state — a post-sale Confirmation
//    Call rebook must not erase it, and no cancel-branch workflow keys off it.
//  - dead (DNC/NG): compliance-sensitive — DNC mirrors a do-not-call signal;
//    auto-clearing could unmute suppression. A booking on a DNC lead is an
//    anomaly for humans to review, not for an auto-clear.
//  - active/deferred: not terminal by definition.
const STALE_GUARD_TERMINAL_CATEGORIES = new Set(['closed_lost']);

/** Category for a disposition code, or null for unknown/legacy string-only codes. */
export function dispositionCategory(code) {
  const entry = KNOWN_DISPOSITION_LABELS[code];
  return entry && typeof entry === 'object' ? entry.category : null;
}

/** True if `code` is a terminal disposition the rebook staleness guard acts on. */
export function isStaleGuardTerminalDisposition(code) {
  return STALE_GUARD_TERMINAL_CATEGORIES.has(dispositionCategory(code));
}

export async function syncDispositions() {
  try {
    const response = await getDispositions();
    const items = extractArray(response);
    if (items.length === 0) {
      console.log('[Sync] Dispositions raw response:', JSON.stringify(response)?.slice(0, 500));
    } else {
      console.log('[Sync] Dispositions sample:', JSON.stringify(items[0]));
    }
    let synced = 0;
    for (const d of items) {
      const code = String(d.key || d.Key || d.Code || d.code || d.disposition_code || d.DispositionCode || d.ID || d.id || '');
      if (!code) continue;
      await supabase.from('lp_dispositions').upsert({
        disposition_code: code,
        disposition_label: d.value || d.Value || d.Description || d.description || d.Label || d.label || d.Name || d.name || '',
        category: d.Category || d.category || null,
        is_recoverable: d.is_recoverable ?? true,
        synced_at: new Date().toISOString(),
      }, { onConflict: 'disposition_code' });
      synced++;
    }
    console.log(`[Sync] Synced ${synced} dispositions`);
    return synced;
  } catch (err) {
    console.warn('[Sync] Dispositions sync failed:', err.message);
    return 0;
  }
}

export async function backfillDispositionsFromLeads() {
  try {
    let allCodes = new Set();
    let offset = 0;
    const pageSize = 1000;
    while (true) {
      const { data } = await supabase.from('lp_leads')
        .select('disposition_code').not('disposition_code', 'is', null)
        .range(offset, offset + pageSize - 1);
      if (!data || data.length === 0) break;
      for (const r of data) { if (r.disposition_code) allCodes.add(r.disposition_code); }
      if (data.length < pageSize) break;
      offset += pageSize;
    }
    if (allCodes.size === 0) return;
    const codes = [...allCodes];
    let added = 0;
    for (const code of codes) {
      const { data: existing } = await supabase.from('lp_dispositions')
        .select('disposition_code').eq('disposition_code', code).maybeSingle();
      if (!existing) {
        const known = KNOWN_DISPOSITION_LABELS[code];
        const label = typeof known === 'string' ? known : known?.label || code;
        const category = typeof known === 'object' ? known.category : null;
        const recoverable = typeof known === 'object' ? known.recoverable : true;
        await supabase.from('lp_dispositions').upsert({
          disposition_code: code, disposition_label: label,
          category, is_recoverable: recoverable, synced_at: new Date().toISOString(),
        }, { onConflict: 'disposition_code' });
        added++;
      }
    }
    console.log(`[Sync] Disposition backfill: ${added} new from lead data (${codes.length} unique codes found)`);
    if (codes.length <= 50) console.log(`[Sync] Codes found: ${codes.join(', ')}`);
  } catch (err) {
    console.warn('[Sync] Disposition backfill failed:', err.message);
  }
}
