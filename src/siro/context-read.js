/**
 * The visit, for the reply path — src/siro/context-read.js (2026-10-16, Siro PR 1)
 *
 * The reply path reads Supabase, never Siro live (CANON.K.051): the newest
 * context_ready siro_recordings rows for the contact's LP lead / prospect /
 * GHL contact, at most 3, inside 1.5 seconds. Only a lead past its demo (or
 * in rehash) pays for the read; a pre-demo lead never does. A failed read is
 * [] and one log line (CANON.K.070). With SIRO_ENSURE_MODE=live a lead with
 * no row gets one on-demand Siro look first.
 *
 * SIRO_CONTEXT_MODE off | shadow (default: read and log what would be added,
 * pass nothing) | live (LEAD FACTS gets the PRESENTATION block and
 * context.siro is set).
 */
import supabaseDefault from '../supabase.js';
import { siroModes } from './config.js';
import { buildPresentationFacts } from './presentation-facts.js';
import { ensureRecordingForLead } from './ensure-recording.js';
import { isPostDemoLead } from '../agentic/post-demo-lead.js';
import { isInRehash, rehashLeadFromContext } from '../agentic/rehash-state.js';
import { prospectLabel } from '../format-helpers.js';

const READ_BUDGET_MS = 1500;
const COLS = 'recording_id, rep_name, rep_email, result, recorded_at, summary, moments, followup_score, followup_status, followup_action, insights, pricing, processed, deleted, lp_lead_id, lp_prospect_id, ghl_contact_id';

function within(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms); })])
    .finally(() => clearTimeout(t));
}

/** A lead past its demo or in rehash. Pure. */
export function needsPresentation({ lp = null, lead = null } = {}) {
  const tags = lead?.current_tags || [];
  if (isPostDemoLead({ lp, tags, stageTag: lead?.current_stage_tag || null })) return true;
  try { return isInRehash({ tags, currentLead: rehashLeadFromContext(lp) }); } catch { return false; }
}

/** Newest context_ready rows for a contact. Throws on a failed read. */
export async function readSiroRows({ supabase = supabaseDefault, contactId = null, leadIds = [], prospectId = null, limit = 3 } = {}) {
  const ors = [];
  const ids = [...new Set((leadIds || []).filter(Boolean).map(String))];
  if (ids.length) ors.push(`lp_lead_id.in.(${ids.join(',')})`);
  if (prospectId) ors.push(`lp_prospect_id.eq.${String(prospectId)}`);
  if (contactId) ors.push(`ghl_contact_id.eq.${String(contactId)}`);
  if (!ors.length || !supabase) return [];
  const { data, error } = await supabase.from('siro_recordings').select(COLS)
    .or(ors.join(',')).eq('context_ready', true).eq('deleted', false)
    .order('recorded_at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * @returns {Promise<{mode:string, rows:object[], facts:object|null, applied:boolean}>}
 *   applied — live mode and a recording found: the caller adds it to the context.
 */
export async function siroForContext({ contactId, lp, lead }, { env = process.env, deps = {} } = {}) {
  const mode = siroModes(env).context;
  const none = { mode, rows: [], facts: null, applied: false };
  if (mode === 'off' || !needsPresentation({ lp, lead })) return none;
  const read = deps.readSiroRows || readSiroRows;
  const args = { supabase: deps.supabase || supabaseDefault, contactId, leadIds: [lp?.lead_id], prospectId: lp?.prospect_id };
  let rows = [];
  try {
    rows = await within(read(args), READ_BUDGET_MS);
    if (!rows.length && lp?.lead_id) {
      const ensured = await (deps.ensureRecordingForLead || ensureRecordingForLead)({
        lp_lead_id: lp.lead_id, phone: lead?.phone, demo_date: lp.demo_date, appointment_date: lp.appointment_date || lp.last_appointment_date,
      }, { env, deps });
      if (ensured === 'row') rows = await within(read(args), READ_BUDGET_MS);
    }
  } catch (err) {
    console.log(`[Siro] context read failed for ${prospectLabel(lp?.prospect_id)}: ${err.message}`);
    return none;
  }
  const facts = buildPresentationFacts(rows);
  if (!facts) return { ...none, rows };
  if (mode === 'shadow') {
    console.log(`[Siro] shadow: would add presentation facts for ${prospectLabel(lp?.prospect_id)} (recording ${facts.recording_id})`);
    return { mode, rows, facts, applied: false };
  }
  return { mode, rows, facts, applied: true };
}
