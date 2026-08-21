/**
 * Five9 admin write handler — src/actions/handlers/five9.js
 *
 * One dispatcher for all twenty-four five9_* write action types. The real work
 * (guardrails, serialization lock, read-before-write, audit events) lives
 * in src/five9/admin-writes.js — this file is only the executor-facing
 * seam plus the belt-and-braces approval check.
 *
 * Doctrine: these action types are the ONLY path to Five9 writes. They are
 * queued via create_agent_action(requires_approval: true), cleared by a
 * human via approve_action (or the GroupMe callback), and executed here.
 * All of them ship dark behind FIVE9_WRITES_ENABLED (default off).
 */

import {
  executeStartCampaign,
  executeStopCampaign,
  executeResetCampaign,
  executeSetOutboundCampaign,
  executeAddRecordsToList,
  executeDeleteRecordFromList,
  executeAddNumbersToDnc,
  // 2026-08-05 Phase D — user skills + campaign profiles
  executeUserSkillAdd,
  executeUserSkillModify,
  executeUserSkillRemove,
  executeCreateCampaignProfile,
  // 2026-08-06 Phase D-2 — modifyCampaignProfile wrapper WSDL-verified
  executeModifyCampaignProfile,
  // 2026-08-12 Phase F — bulk async list deletion (confirm_token + declared
  // count + volume ceiling + proportion guard; defers while the job runs)
  executeAsyncDeleteRecordsFromList,
  // 2026-08-13 Phase G — config surface: IVR scripts, inbound campaigns,
  // the default IVR schedule, DNIS assignment, and TTS prompts.
  executeCreateIvrScript,
  executeModifyIvrScript,
  executeCreateInboundCampaign,
  executeSetDefaultIvrSchedule,
  executeAddDnisToCampaign,
  executeRemoveDnisFromCampaign,
  executeCreatePromptTts,
  // 2026-08-21 Phase H — user profiles. The two narrow patches are the
  // day-to-day ops; the full-object pair carries Guardrail 12 (role grants).
  executeModifyUserProfileSkills,
  executeModifyUserProfileUserList,
  executeCreateUserProfile,
  executeModifyUserProfile,
} from '../../five9/admin-writes.js';

const FIVE9_WRITE_OPS = {
  five9_start_campaign: executeStartCampaign,
  five9_stop_campaign: executeStopCampaign,
  five9_reset_campaign: executeResetCampaign,
  five9_set_outbound_campaign: executeSetOutboundCampaign,
  five9_add_records_to_list: executeAddRecordsToList,
  five9_delete_record_from_list: executeDeleteRecordFromList,
  // 2026-08-12 Phase F — the BULK sibling of delete_record_from_list.
  five9_async_delete_records_from_list: executeAsyncDeleteRecordsFromList,
  five9_add_numbers_to_dnc: executeAddNumbersToDnc,
  // NOTE: DNC REMOVAL IS NOT AN OP AND MUST NOT BE RE-ADDED. Removed
  // 2026-08-21 by explicit ruling: Reece does not take numbers off DNC under
  // any circumstance, so there is no gate, override, or justification path
  // that makes it available — the action type simply does not exist. A
  // queued five9_remove_numbers_from_dnc now fails as an unknown action type,
  // which is the intended outcome, not a regression to fix.
  // 2026-08-05 Phase D
  five9_user_skill_add: executeUserSkillAdd,
  five9_user_skill_modify: executeUserSkillModify,
  five9_user_skill_remove: executeUserSkillRemove,
  five9_create_campaign_profile: executeCreateCampaignProfile,
  // 2026-08-06 Phase D-2
  five9_modify_campaign_profile: executeModifyCampaignProfile,
  // 2026-08-13 Phase G — the config surface. Together these build inbound
  // routing end to end (prompt → script → campaign → schedule → DNIS), which
  // is why they are ordered that way in the Phase 3 execution sequence.
  // NOTE: deleteIVRScript is used INTERNALLY by create as compensation when
  // its second call fails. It is deliberately absent from this map — nothing
  // can queue a script deletion as an action.
  five9_create_ivr_script: executeCreateIvrScript,
  five9_modify_ivr_script: executeModifyIvrScript,
  five9_create_inbound_campaign: executeCreateInboundCampaign,
  five9_set_default_ivr_schedule: executeSetDefaultIvrSchedule,
  five9_add_dnis_to_campaign: executeAddDnisToCampaign,
  five9_remove_dnis_from_campaign: executeRemoveDnisFromCampaign,
  five9_create_prompt_tts: executeCreatePromptTts,
  // 2026-08-21 Phase H — user profiles. Prefer the two narrow patches: they
  // cover onboarding a setter and adjusting skill routing, and cannot touch a
  // role grant at all. The full-object pair REPLACES the whole struct, so it
  // read-modify-writes and is gated on role grants (Guardrail 12).
  five9_modify_user_profile_skills: executeModifyUserProfileSkills,
  five9_modify_user_profile_user_list: executeModifyUserProfileUserList,
  five9_create_user_profile: executeCreateUserProfile,
  five9_modify_user_profile: executeModifyUserProfile,
};

export async function executeFive9Write(action) {
  const fn = FIVE9_WRITE_OPS[action.action_type];
  if (!fn) throw new Error(`five9 handler: unknown op ${action.action_type}`);
  // Belt-and-braces: a five9 write row must have entered through the
  // approve_action gate. requires_approval=false means someone bypassed it.
  if (action.requires_approval !== true) {
    throw new Error(`REFUSED: ${action.action_type} must be queued with requires_approval=true (approve_action gate)`);
  }
  return fn(action);
}
