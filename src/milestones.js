import supabase from './supabase.js';
import { applyGHLTag } from './ghl.js';
import { emitEvent } from './event-emitter.js';
import { classifyMilestoneDate, MIN_PLAUSIBLE_ACT_DATE } from './milestone-gate.js';

// mdt_id → GHL tag lookup (16 milestones for the C.x Customer Journey)
export const MDT_TAG_MAP = {
  R: 'lp-milestone-rtp',
  M: 'lp-milestone-measure',
  O: 'lp-milestone-quoted',
  H: 'lp-milestone-hoa-approved',
  K: 'lp-milestone-ordered',
  U: 'lp-milestone-permit-submit',
  P: 'lp-milestone-permit-issued',
  V: 'lp-milestone-recv-windows',
  E: 'lp-milestone-recv-doors',
  G: 'lp-milestone-recv-all',
  S: 'lp-milestone-install-start',
  F: 'lp-milestone-install-end',
  C: 'lp-milestone-completion',
  I: 'lp-milestone-insp-set',
  B: 'lp-milestone-insp-passed',
  // KNOWN DEFECT (2026-08-06): LP uses mdt_id 'X' for TWO datetypes —
  // 'Inspection Ready' (4,772 rows) and 'Snap and Trim' (580). Keying the
  // map on mdt_id alone means all 4,772 Inspection Ready completions fire
  // lp-milestone-snap-trim. Neither X variant is a customer-facing beat, so
  // this is a reporting-accuracy defect, not a messaging one. Fixing it
  // needs the map keyed on mdt_id + datetype AND the (lp_job_id, mdt_id)
  // conflict key widened — tracked separately, deliberately not in this PR.
  X: 'lp-milestone-snap-trim',
};

// Human-readable labels
export const MDT_LABELS = {
  R: 'RTP (Ready to Process)',
  M: 'Measure',
  O: 'Quoted',
  H: 'HOA Approved',
  K: 'Ordered',
  U: 'Permit Submit',
  P: 'Permit Issued',
  V: 'Receive (Windows)',
  E: 'Receive (Doors)',
  G: 'Received All Product',
  S: 'Install Start',
  F: 'Install End',
  C: 'Completion',
  I: 'Inspection Set',
  B: 'Inspection Passed',
  X: 'Snap and Trim',
};

/**
 * Sweep newly-completed milestones and fire their GHL tags.
 *
 * This is the SECOND of the two milestone fire paths. syncJobAndMilestones
 * (src/sync-children.js) fires inline when a completion first appears on a
 * lead that already has a GHL contact linked; this sweeper catches every
 * other case — contact linked later, tag application failed, or (as of the
 * achievement gate) act_date that was in the future when it was written and
 * has since arrived. It runs on every sync pass.
 *
 * ─── 2026-08-06: TWO DEFECTS FIXED ───────────────────────────────
 *
 * 1. ACHIEVEMENT GATE. The query used to be "act_date IS NOT NULL AND
 *    ghl_tag_fired = false" with no date bound, so a scheduled-but-not-yet-
 *    reached completion fired immediately. 209 rows carried a future
 *    act_date; 56 had fired. See src/milestone-gate.js for the measurement.
 *    Bounded here in Postgres (cheaper than filtering in Node) and
 *    re-checked per row against the shared predicate so both fire paths
 *    agree on what "achieved" means.
 *
 * 2. EVENT PARITY. This sweeper applied the GHL tag but never emitted
 *    lp.milestone_completed — only the inline path did. Result: 1,391 of
 *    5,867 genuinely-fired milestones (24%) reached GHL as a tag but never
 *    reached the Decision Engine, so no P2_MILESTONE_* rule ran and the
 *    opportunity never moved stage. Those customers sat in the wrong
 *    Client Lifecycle stage with the right tag on them. Now emitted with
 *    the same idempotency_key as the inline path, so a milestone that fires
 *    here after a partial inline failure cannot double-emit.
 */
export async function processMilestoneTriggers(now = new Date()) {
  const { data: newMilestones, error } = await supabase
    .from('lp_job_milestones')
    .select('lp_job_id, lp_lead_id, ghl_contact_id, mdt_id, datetype, act_date')
    .not('act_date', 'is', null)
    // Achievement gate, pushed into Postgres. Upper bound excludes both
    // scheduled-future and the corrupt 2206/2046 rows in one comparison.
    .gte('act_date', MIN_PLAUSIBLE_ACT_DATE)
    .lte('act_date', now.toISOString())
    .eq('ghl_tag_fired', false);

  if (error) {
    console.error('[Milestones] Query failed:', error.message);
    return { processed: 0, fired: 0, errors: 0, gated: 0 };
  }

  let fired = 0;
  let errors = 0;
  let gated = 0;

  // Bug 10: Build a map of lead_id → {ghl_contact_id, lp_prospect_id} from
  // lp_leads so we can resolve contacts and always log prospect IDs.
  const leadIds = [...new Set((newMilestones || []).map(m => m.lp_lead_id).filter(Boolean))];
  const leadDataMap = {};
  if (leadIds.length > 0) {
    const { data: leads } = await supabase
      .from('lp_leads')
      .select('lp_lead_id, ghl_contact_id, lp_prospect_id')
      .in('lp_lead_id', leadIds);
    for (const lead of (leads || [])) {
      leadDataMap[lead.lp_lead_id] = {
        ghl_contact_id: lead.ghl_contact_id,
        lp_prospect_id: lead.lp_prospect_id,
      };
    }
  }

  // Job context for the emitted event payload (job_value drives the P2
  // opportunity's monetary value; branch_code drives market attribution).
  // ONE batched read for the whole sweep, not one per milestone.
  const jobIds = [...new Set((newMilestones || []).map(m => m.lp_job_id).filter(Boolean))];
  const jobDataMap = {};
  if (jobIds.length > 0) {
    const { data: jobs } = await supabase
      .from('lp_jobs')
      .select('lp_job_id, job_value, branch_code')
      .in('lp_job_id', jobIds);
    for (const job of (jobs || [])) {
      jobDataMap[job.lp_job_id] = { job_value: job.job_value, branch_code: job.branch_code };
    }
  }

  for (const milestone of (newMilestones || [])) {
    // Belt-and-braces: the range filter above already excluded these, but
    // running the shared predicate here keeps the two fire paths provably
    // in agreement and catches anything the range filter's timezone
    // handling might let through.
    const verdict = classifyMilestoneDate(milestone.act_date, now);
    if (!verdict.achieved) {
      gated++;
      continue;
    }

    const leadData = leadDataMap[milestone.lp_lead_id] || {};
    // Bug 10: Use lead's ghl_contact_id as fallback if milestone row has null
    const ghlContactId = milestone.ghl_contact_id || leadData.ghl_contact_id;
    const lpProspectId = leadData.lp_prospect_id || null;
    if (!ghlContactId) continue;

    const tag = MDT_TAG_MAP[milestone.mdt_id];
    if (!tag) continue;

    const success = await applyGHLTag(ghlContactId, tag);

    if (success) {
      // Also update ghl_contact_id on milestone row if it was resolved from lead
      const updateFields = { ghl_tag_fired: true };
      if (!milestone.ghl_contact_id && ghlContactId) {
        updateFields.ghl_contact_id = ghlContactId;
      }
      await supabase.from('lp_job_milestones')
        .update(updateFields)
        .eq('lp_job_id', milestone.lp_job_id)
        .eq('mdt_id', milestone.mdt_id);

      // Event parity with the inline path (defect 2 in the header). Same
      // idempotency_key shape — lp_milestone_<contact>_<mdt>_<job> — so a
      // milestone whose inline emit already landed cannot double-fire.
      const jobData = jobDataMap[milestone.lp_job_id] || {};
      try {
        await emitEvent({
          event_type: 'lp.milestone_completed',
          source: 'lp_milestone_sweeper',
          entity_type: 'contact',
          entity_id: ghlContactId,
          ghl_contact_id: ghlContactId,
          payload: {
            mdt_id: milestone.mdt_id,
            datetype: milestone.datetype || null,
            milestone_tag: tag,
            act_date: milestone.act_date,
            job_id: milestone.lp_job_id,
            lp_lead_id: milestone.lp_lead_id,
            job_value: jobData.job_value ?? null,
            branch_code: jobData.branch_code ?? null,
          },
          priority: 'normal',
          idempotency_key: `lp_milestone_${ghlContactId}_${milestone.mdt_id}_${milestone.lp_job_id}`,
        });
      } catch (emitErr) {
        // Non-fatal: the tag landed, which is the customer-visible half.
        // A missed event means the P2 stage move is skipped, which the
        // nightly reconcile can pick up.
        console.warn(`[Milestones] Event emit failed for ${ghlContactId} ${milestone.mdt_id}: ${emitErr.message}`);
      }

      await logTrigger({
        lp_lead_id: milestone.lp_lead_id,
        lp_prospect_id: lpProspectId,
        ghl_contact_id: ghlContactId,
        event: `milestone_${milestone.mdt_id}`,
        tag_fired: tag,
        status: 'success',
      });
      fired++;
    } else {
      await logTrigger({
        lp_lead_id: milestone.lp_lead_id,
        lp_prospect_id: lpProspectId,
        ghl_contact_id: ghlContactId,
        event: `milestone_${milestone.mdt_id}`,
        tag_fired: tag,
        status: 'failed',
        error_detail: 'GHL tag application failed',
      });
      errors++;
    }
  }

  if (gated > 0) {
    console.log(`[Milestones] ${gated} row(s) held by the achievement gate — act_date not yet reached`);
  }

  return { processed: newMilestones?.length || 0, fired, errors, gated };
}

async function logTrigger({ lp_lead_id, lp_prospect_id, ghl_contact_id, event, tag_fired, status, error_detail }) {
  try {
    await supabase.from('lp_trigger_log').insert({
      lp_lead_id,
      lp_prospect_id: lp_prospect_id || null,
      ghl_contact_id,
      event,
      tag_fired,
      status,
      error_detail: error_detail || null,
    });
  } catch (err) {
    console.error('[Milestones] Trigger log write failed:', err.message);
  }
}
