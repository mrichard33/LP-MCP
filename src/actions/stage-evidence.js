/**
 * Stage-Transition Evidence Matrix — src/actions/stage-evidence.js
 *
 * 2026-07-03 (pipeline-integrity breach): agent_rules fabricated pipeline
 * milestones — BEHAVIORAL_FAST_TRACK moved opps to "Appointment Booked" on AI
 * intent alone, and the BEHAVIORAL_*_OBJECTION rules moved opps to "Proposal
 * Delivered" with no demo ever occurring (~150 unearned moves / 111 contacts
 * since April). Rule-side mitigation was applied in Supabase; this module is
 * the STRUCTURAL guarantee: the move_opportunity executor refuses any
 * milestone stage move that lacks real-world evidence, no matter which rule
 * requested it.
 *
 * Matrix is keyed by GHL stage ID (via STAGE_MAP) so legacy stage-name
 * aliases are covered automatically. Adding a new gated stage is one entry:
 *   [STAGE_MAP['New Stage']]: { label: 'New Stage', evidence: '<predicate>' }
 *
 * Evidence predicates (evaluateStageEvidence — pure, unit-tested):
 *   booking        — GHL appointment with status new/confirmed/showed
 *                    OR a durable booked-* tag OR LP disposition Set/Cnf.
 *   demo_completed — GHL appointment with status showed
 *                    OR HPA-/HPRC-Completed or lp-demo-completed tag
 *                    OR LP post-demo disposition (FDNS/BO/1Leg/OPPFDN/CS).
 *
 * Demotions (Reactivation, Long-Term Hold, P3 stages, loss stages) and any
 * stage not listed here require no evidence — they are unrestricted, exactly
 * as before.
 *
 * Unknown data = no evidence: if the appointment list, tag set, and LP
 * disposition are ALL unreadable, a gated move is blocked (an unearned move
 * is far costlier than a delayed legitimate one — the rule can re-fire).
 */

import { ghlFetch } from './helpers.js';
import { STAGE_MAP } from './constants.js';
import supabase from '../supabase.js';

// Appointment statuses that prove a booking exists (GHL appointmentStatus,
// lowercased). 'showed' also proves booking — a demo that happened was booked.
const BOOKING_APPT_STATUSES = new Set(['new', 'confirmed', 'showed']);
// LP dispositions that prove a set/confirmed appointment.
const BOOKING_LP_DISPOSITIONS = new Set(['Set', 'Cnf']);
// Durable booking tags (prefix match, case-insensitive): booked-estimate,
// booked-measurement, chatbot-booked-*, stage:booked-*.
const BOOKING_TAG_RE = /^(chatbot-)?booked-|^stage:booked-/i;

// Post-demo evidence.
const DEMO_APPT_STATUSES = new Set(['showed']);
const POST_DEMO_LP_DISPOSITIONS = new Set(['FDNS', 'BO', '1Leg', 'OPPFDN', 'CS']);
// HPA-Completed / HPRC-Completed rep tags + the sync-derived lp-demo-completed
// marker (mirrors a demo-complete LP disposition; see resolveDemoState).
const DEMO_TAG_RE = /^(hpa|hprc)-completed$|^lp-demo-completed$/i;

export const STAGE_EVIDENCE_REQUIREMENTS = {
  [STAGE_MAP['Appointment Booked']]:    { label: 'Appointment Booked',    evidence: 'booking' },
  [STAGE_MAP['Appointment Completed']]: { label: 'Appointment Completed', evidence: 'demo_completed' },
  [STAGE_MAP['Proposal Delivered']]:    { label: 'Proposal Delivered',    evidence: 'demo_completed' },
};

/**
 * Pure predicate. `facts` fields may each be null (unreadable) — null
 * contributes no evidence.
 *   appointments — [{status}] (raw, ANY time — a showed appt is in the past)
 *   tags         — string[]
 *   lpDisposition — string|null
 *
 * Returns { satisfied, matched, missing_evidence } — missing_evidence lists
 * the acceptable evidence classes that were checked and absent.
 */
export function evaluateStageEvidence(evidenceKind, { appointments = null, tags = null, lpDisposition = null } = {}) {
  const appts = Array.isArray(appointments) ? appointments : [];
  const tagList = Array.isArray(tags) ? tags : [];

  if (evidenceKind === 'booking') {
    if (appts.some((a) => BOOKING_APPT_STATUSES.has(String(a?.status || '').toLowerCase()))) {
      return { satisfied: true, matched: 'appointment_status', missing_evidence: [] };
    }
    const tag = tagList.find((t) => BOOKING_TAG_RE.test(String(t)));
    if (tag) return { satisfied: true, matched: `tag:${tag}`, missing_evidence: [] };
    if (lpDisposition && BOOKING_LP_DISPOSITIONS.has(lpDisposition)) {
      return { satisfied: true, matched: `lp_disposition:${lpDisposition}`, missing_evidence: [] };
    }
    return {
      satisfied: false,
      matched: null,
      missing_evidence: ['appointment_new_confirmed_showed', 'booked_tag', 'lp_disposition_set_cnf'],
    };
  }

  if (evidenceKind === 'demo_completed') {
    if (appts.some((a) => DEMO_APPT_STATUSES.has(String(a?.status || '').toLowerCase()))) {
      return { satisfied: true, matched: 'appointment_showed', missing_evidence: [] };
    }
    const tag = tagList.find((t) => DEMO_TAG_RE.test(String(t)));
    if (tag) return { satisfied: true, matched: `tag:${tag}`, missing_evidence: [] };
    if (lpDisposition && POST_DEMO_LP_DISPOSITIONS.has(lpDisposition)) {
      return { satisfied: true, matched: `lp_disposition:${lpDisposition}`, missing_evidence: [] };
    }
    return {
      satisfied: false,
      matched: null,
      missing_evidence: ['appointment_showed', 'demo_completed_tag', 'lp_post_demo_disposition'],
    };
  }

  // Unknown evidence kind in the matrix = config bug → no evidence satisfied.
  return { satisfied: false, matched: null, missing_evidence: [`unknown_evidence_kind:${evidenceKind}`] };
}

// ── Fact gathering (each fail-soft to null = no evidence) ────────────

async function fetchAllAppointments(contactId) {
  try {
    const data = await ghlFetch('GET', `/contacts/${contactId}/appointments`);
    const events = Array.isArray(data?.events) ? data.events
      : Array.isArray(data?.appointments) ? data.appointments : [];
    // Raw statuses, NO time filter — a 'showed' appointment is in the past.
    return events.map((e) => ({ status: String(e.appointmentStatus || e.status || '').toLowerCase() }));
  } catch (err) {
    console.warn(`[stage-evidence] appointment fetch failed for ${contactId}: ${err.message}`);
    return null;
  }
}

async function fetchTags(contactId) {
  try {
    const data = await ghlFetch('GET', `/contacts/${contactId}`);
    return data?.contact?.tags || [];
  } catch (err) {
    console.warn(`[stage-evidence] tag fetch failed for ${contactId}: ${err.message}`);
    return null;
  }
}

async function fetchLPDisposition(contactId) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.from('lp_leads')
      .select('disposition_code')
      .eq('ghl_contact_id', contactId)
      .order('synced_at', { ascending: false })
      .limit(1).maybeSingle();
    if (error) throw new Error(error.message);
    return data?.disposition_code || null;
  } catch (err) {
    console.warn(`[stage-evidence] LP disposition fetch failed for ${contactId}: ${err.message}`);
    return null;
  }
}

/**
 * Executor entry point. Returns:
 *   { required: false }                                    — stage not gated
 *   { required: true, allowed: true,  matched }            — evidence found
 *   { required: true, allowed: false, label, evidence_kind,
 *     missing_evidence }                                   — BLOCK the move
 */
export async function checkStageMoveEvidence(contactId, stageId) {
  const requirement = STAGE_EVIDENCE_REQUIREMENTS[stageId];
  if (!requirement) return { required: false };

  const [appointments, tags, lpDisposition] = await Promise.all([
    fetchAllAppointments(contactId),
    fetchTags(contactId),
    fetchLPDisposition(contactId),
  ]);

  const verdict = evaluateStageEvidence(requirement.evidence, { appointments, tags, lpDisposition });
  return {
    required: true,
    allowed: verdict.satisfied,
    label: requirement.label,
    evidence_kind: requirement.evidence,
    matched: verdict.matched,
    missing_evidence: verdict.missing_evidence,
    facts_unreadable: appointments === null && tags === null && lpDisposition === null,
  };
}
