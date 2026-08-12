/**
 * Five9 admin write handler — src/actions/handlers/five9.js
 *
 * One dispatcher for all fourteen five9_* write action types. The real work
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
  executeRemoveNumbersFromDnc,
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
  five9_remove_numbers_from_dnc: executeRemoveNumbersFromDnc,
  // 2026-08-05 Phase D
  five9_user_skill_add: executeUserSkillAdd,
  five9_user_skill_modify: executeUserSkillModify,
  five9_user_skill_remove: executeUserSkillRemove,
  five9_create_campaign_profile: executeCreateCampaignProfile,
  // 2026-08-06 Phase D-2
  five9_modify_campaign_profile: executeModifyCampaignProfile,
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
