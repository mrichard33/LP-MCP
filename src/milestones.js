import supabase from './supabase.js';
import { applyGHLTag } from './ghl.js';

// mdt_id → GHL tag lookup (16 milestones for W12.x Customer Journey)
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

// Process newly completed milestones — fire GHL tags
export async function processMilestoneTriggers() {
  const { data: newMilestones, error } = await supabase
    .from('lp_job_milestones')
    .select('lp_job_id, lp_lead_id, ghl_contact_id, mdt_id, act_date')
    .not('act_date', 'is', null)
    .eq('ghl_tag_fired', false);

  if (error) {
    console.error('[Milestones] Query failed:', error.message);
    return { processed: 0, fired: 0, errors: 0 };
  }

  let fired = 0;
  let errors = 0;

  for (const milestone of (newMilestones || [])) {
    if (!milestone.ghl_contact_id) continue;

    const tag = MDT_TAG_MAP[milestone.mdt_id];
    if (!tag) continue;

    const success = await applyGHLTag(milestone.ghl_contact_id, tag);

    if (success) {
      await supabase.from('lp_job_milestones')
        .update({ ghl_tag_fired: true })
        .eq('lp_job_id', milestone.lp_job_id)
        .eq('mdt_id', milestone.mdt_id);

      await logTrigger({
        lp_lead_id: milestone.lp_lead_id,
        ghl_contact_id: milestone.ghl_contact_id,
        event: `milestone_${milestone.mdt_id}`,
        tag_fired: tag,
        status: 'success',
      });
      fired++;
    } else {
      await logTrigger({
        lp_lead_id: milestone.lp_lead_id,
        ghl_contact_id: milestone.ghl_contact_id,
        event: `milestone_${milestone.mdt_id}`,
        tag_fired: tag,
        status: 'failed',
        error_detail: 'GHL tag application failed',
      });
      errors++;
    }
  }

  return { processed: newMilestones?.length || 0, fired, errors };
}

async function logTrigger({ lp_lead_id, ghl_contact_id, event, tag_fired, status, error_detail }) {
  try {
    await supabase.from('lp_trigger_log').insert({
      lp_lead_id,
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
