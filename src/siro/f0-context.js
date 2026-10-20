/**
 * F.0 v2 context — src/siro/f0-context.js (2026-10-16, Siro PR 1)
 *
 * Everything the nurture orchestrator needs for a workflow_code 'F.0' turn,
 * read once from Supabase (never Siro live, except the one on-demand ensure
 * while the demo is younger than SIRO_WAIT_MAX_H):
 *   - the visit facts and the template variables the F.0 prompt rows read
 *     ({{siro.presentation_block}}, {{siro.rehash_rep_first_name}}, …)
 *   - the inputs of postDemoInterrupt (src/siro/f0-interrupts.js)
 *
 * The decisions themselves stay in the pure modules; this file only reads.
 * AIOS: CANON.K.051 (stored memory), K.070 (a failed read is "unknown" and
 * the conservative answer is taken: no visit data, not in rehash → suppress).
 */
import supabaseDefault from '../supabase.js';
import { readSiroRows } from './context-read.js';
import { ensureRecordingForLead } from './ensure-recording.js';
import { buildPresentationFacts, presentationTemplateVars, repFirstName } from './presentation-facts.js';
import { siroConfig, siroModes } from './config.js';
import { buildVisitFacts, fourStepObjectionType, STORY_ANGLES } from './f0-four-step.js';
import { isPostDemoLead } from '../agentic/post-demo-lead.js';
import { lpSold, isUnsoldPostDemo } from '../agentic/post-demo-owner.js';
import { isInRehash, rehashLeadFromContext, stageFromRows } from '../agentic/rehash-state.js';
import { appointmentOnFile } from '../agentic/booking-claim.js';
import { isCustomerP2 } from '../agentic/lead-state/signals/context-reader.js';
import { POST_DEMO_STOP_RX } from '../agentic/nepq-planner.js';
import { getCustomValue } from '../services/ghl-custom-values.js';
import { REHASH_REP_CUSTOM_VALUE } from '../agentic/rehash.js';

const HOUR_MS = 3_600_000;
const SENT_STATUSES = ['ghl_sent_confirmed', 'generated_ready'];

const textOf = (m) => String(m?.text ?? m?.body ?? '');
const isOutbound = (m) => String(m?.direction || '').toLowerCase() === 'outbound';
const atOf = (m) => Date.parse(m?.timestamp || m?.date || m?.dateAdded || '') || null;

/**
 * The sticky post-demo stop (nepq-planner.js planPostDemo): our "I'm here if
 * anything changes." went out and the lead has not asked anything since.
 * The durable trace is the nepq:handoff:rehash_stop tag. Pure.
 */
export function postDemoStopFrom({ conversation = [], tags = [] } = {}) {
  if ((tags || []).some(t => String(t).toLowerCase() === 'nepq:handoff:rehash_stop')) return true;
  const list = Array.isArray(conversation) ? conversation : [];
  let stopAt = -1;
  list.forEach((m, i) => { if (isOutbound(m) && POST_DEMO_STOP_RX.test(textOf(m))) stopAt = i; });
  if (stopAt < 0) return false;
  return !list.slice(stopAt + 1).some(m => !isOutbound(m) && /\?/.test(textOf(m)));
}

/** The lead texted after our last F.0 touch. Pure. */
export function repliedSince({ conversation = [], lastTouchAt = null } = {}) {
  const t = Date.parse(lastTouchAt || '');
  if (!Number.isFinite(t)) return false;
  return (Array.isArray(conversation) ? conversation : []).some(m => !isOutbound(m) && (atOf(m) || 0) > t);
}

/** Hours since the demo: the recording, else LP's demo / appointment date. Pure. */
export function demoAgeHours({ facts = null, lp = null, nowMs = Date.now() } = {}) {
  const at = Date.parse(facts?.recorded_at || lp?.demo_date || lp?.last_appointment_date || lp?.appointment_date || '');
  return Number.isFinite(at) ? Math.max(0, (nowMs - at) / HOUR_MS) : null;
}

async function safe(label, fn, fallback) {
  try { return await fn(); } catch (err) { console.log(`[F0v2] ${label} read failed: ${err.message}`); return fallback; }
}

/**
 * @param {object} context  buildLeadContext() output
 * @param {{contact_id: string, sequence_position: number}} request
 * @returns {Promise<{facts, rows, vars, recordingId, interruptInput}>}
 */
export async function loadF0Context(context, request, { env = process.env, deps = {}, nowMs = Date.now(), allowEnsure = true } = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const cfg = siroConfig(env);
  const lp = context?.lp || {};
  const lead = context?.lead || {};
  const tags = (lead.current_tags || []).map(t => String(t).toLowerCase());
  const read = deps.readSiroRows || readSiroRows;
  const readArgs = { supabase, contactId: request.contact_id, leadIds: [lp.lead_id], prospectId: lp.prospect_id };

  let rows = await safe('siro_recordings', () => read(readArgs), []);
  let facts = buildPresentationFacts(rows, { now: nowMs });
  const ageBefore = demoAgeHours({ facts, lp, nowMs });
  if (!facts && allowEnsure && Number.isFinite(ageBefore) && ageBefore < cfg.waitMaxH && lp.lead_id) {
    const ensured = await (deps.ensureRecordingForLead || ensureRecordingForLead)(
      { lp_lead_id: lp.lead_id, phone: lead.phone, demo_date: lp.demo_date, appointment_date: lp.last_appointment_date || lp.appointment_date },
      { env, deps, nowMs },
    );
    if (ensured === 'row') {
      rows = await safe('siro_recordings', () => read(readArgs), []);
      facts = buildPresentationFacts(rows, { now: nowMs });
    }
  }
  const recording = facts ? rows.find(r => r.recording_id === facts.recording_id) : null;
  const demoLeadId = String(recording?.lp_lead_id || lp.lead_id || '');

  // Rehash: the demo lead's own 30-day window and its rehash_stage row. Tags
  // are NOT read here: F.0 itself carries active-f.0, which would read as
  // "in rehash" forever.
  const stageRows = await safe('rehash_stage', async () => {
    const { data, error } = await supabase.from('rehash_stage')
      .select('ghl_contact_id, lp_lead_id, demo_date, started_at, ended_at').eq('ghl_contact_id', request.contact_id);
    if (error) throw new Error(error.message);
    return data || [];
  }, null);
  const stage = stageRows ? stageFromRows(stageRows) : null;
  const currentLead = rehashLeadFromContext(lp);
  const rehashActive = (!!stage?.open && String(stage.open.lp_lead_id) === demoLeadId)
    || isInRehash({ tags: [], currentLead, stage, nowMs, env });

  // A newer lead on the prospect than the demo lead.
  const newest = lp.prospect_id ? await safe('lp_leads', async () => {
    const { data, error } = await supabase.from('lp_leads').select('lp_lead_id, created_at_lp')
      .eq('lp_prospect_id', String(lp.prospect_id)).order('created_at_lp', { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    return data?.[0] || null;
  }, null) : null;
  const newerLead = !!(newest && demoLeadId && String(newest.lp_lead_id) !== demoLeadId
    && Number(newest.lp_lead_id) > Number(demoLeadId));

  // The last F.0 touch that went out (or was ready to), for "replied since".
  const lastTouch = await safe('agentic_messages', async () => {
    const { data, error } = await supabase.from('agentic_messages').select('generated_at')
      .eq('ghl_contact_id', request.contact_id).eq('workflow_code', 'F.0').in('send_status', SENT_STATUSES)
      .order('generated_at', { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    return data?.[0]?.generated_at || null;
  }, null);

  const sold = lpSold(lp) || isCustomerP2(context) || tags.includes('deal-won');
  const postAppointment = isPostDemoLead({ lp, tags, stageTag: lead.current_stage_tag || null });

  // The rehash rep's first name, as the reply path reads it (the GHL custom
  // value rehash_rep_name); never guessed: "Reece Team" when none.
  const repRaw = await (deps.getCustomValue || getCustomValue)(REHASH_REP_CUSTOM_VALUE);
  const rehashRepFirst = repFirstName(repRaw) || 'Reece Team';

  const age = demoAgeHours({ facts, lp, nowMs });
  const modes = siroModes(env);
  const followupTextLive = modes.followupText === 'live';
  const vars = {
    ...presentationTemplateVars(facts, { followupTextLive }),
    rehash_rep_first_name: rehashRepFirst,
    days_since_demo: Number.isFinite(age) ? String(Math.floor(age / 24)) : '',
    recording_id: facts?.recording_id || '',
    presentation: facts,
  };
  // 2026-10-19 (Mark, ruling 6): the Four-Step prompts (F0_FORMULA_MODE=
  // four_step) read the visit as <visit_facts> (no price, no sensitive detail)
  // and are picked by Siro's MAIN objection: v1 picked by the first moment
  // type, so 8 of 10 preview leads got the price variant, Mr. Jackson's
  // "decision maker not present" included.
  if (modes.f0Formula === 'four_step') {
    const objectionType = fourStepObjectionType(facts);
    vars.formula = 'four_step';
    vars.objection_type = objectionType;
    vars.story_angle = STORY_ANGLES[objectionType] || STORY_ANGLES.none;
    vars.visit_facts = buildVisitFacts(facts, { firstName: lead.first_name || '', repFirstName: rehashRepFirst, followupTextLive });
  }
  return {
    facts,
    rows,
    vars,
    recordingId: facts?.recording_id || null,
    interruptInput: {
      lpSold: sold,
      unsoldPostDemo: isUnsoldPostDemo({ postAppointment, rehash: rehashActive, sold }),
      rehashActive,
      newerLead,
      appointmentOnFile: !!appointmentOnFile({ upcomingAppointments: [], lp, nowMs }),
      noteDq: !!context?.lead_facts?.note_dq,
      postDemoStop: postDemoStopFrom({ conversation: context?.conversation_recent || [], tags }),
      repliedSinceLastTouch: repliedSince({ conversation: context?.conversation_recent || [], lastTouchAt: lastTouch }),
      tags,
      siroFacts: facts,
      demoAgeH: age,
      waitMaxH: cfg.waitMaxH,
      waitHoldH: cfg.waitHoldH,
    },
  };
}
