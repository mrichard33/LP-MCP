/**
 * Five9 admin write handler — src/actions/handlers/five9.js
 *
 * One dispatcher for every five9_* write action type. The real work
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
  // 2026-08-21 Phase H PR4 — web connectors (Guardrail 13) and campaign
  // composition. NOTE the absentee: executeRemoveDispositionsFromCampaign is
  // built in admin-writes.js and deliberately NOT imported here — see the map
  // below.
  executeCreateWebConnector,
  executeModifyWebConnector,
  executeCreateOutboundCampaign,
  executeAddListsToCampaign,
  executeRemoveListsFromCampaign,
  executeModifyCampaignLists,
  executeAddSkillsToCampaign,
  executeRemoveSkillsFromCampaign,
  executeAddDispositionsToCampaign,
  executeResetCampaignDispositions,
  executeSetCampaignStrategies,
  executeCreateList,
  executeResetListPosition,
  executeRemoveNumbersFromDncReentry,
  REENTRY_DNC_LIFT_RULE_KEY,
  executeRemoveNumbersFromDncApproved,
} from '../../five9/admin-writes.js';
import { isCallbackRearmDelete, checkCallbackRearm } from '../../five9/callback-rearm.js';
import { noticeDisqualifiedRemoval } from '../../notifications/disqualified-removed.js';

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
  // 2026-09-21 — the ONE re-entry removal (Mark's ruling: a consumer who
  // comes back with a fresh first-party submission is lifted everywhere,
  // Five9 included). Welded to DNC_LIFT_ON_REENTRY_E0 and re-proves the
  // consent tag and the event's age at execution time; it does not reopen a
  // general removal path and does not lift a contact-initiated STOP. The
  // contract is in src/five9/admin-writes.js.
  five9_remove_numbers_from_dnc_reentry: executeRemoveNumbersFromDncReentry,
  // 2026-09-28 — the SECOND narrow removal (Consent Model v1): a lift a
  // person approved in Slack (#dnc-lift-approval). Welded to SLACK_DNC_LIFT,
  // refuses any approval that is not a Slack user through approve_action,
  // needs the card's slack_ts, and resolves numbers from the contact only.
  // It is NOT carved out of the approval assertion below — the approval IS
  // the gate. Contract in src/five9/admin-writes.js.
  five9_remove_numbers_from_dnc_approved: executeRemoveNumbersFromDncApproved,
  // NOTE: GENERAL DNC REMOVAL IS NOT AN OP AND MUST NOT BE RE-ADDED. Removed
  // 2026-08-21 by explicit ruling: Reece does not take numbers off DNC under
  // any circumstance, so there is no gate, override, or justification path
  // that makes it available — the action type simply does not exist. A
  // queued five9_remove_numbers_from_dnc now fails as an unknown action type,
  // which is the intended outcome, not a regression to fix. The re-entry op
  // above is a DIFFERENT action type on purpose: nothing that was queued
  // against the old name can start working again by accident.
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
  // 2026-08-21 Phase H PR4 — web connectors. Both carry Guardrail 13: the
  // destination allow-list (FIVE9_WEBCONNECTOR_ALLOWED_HOSTS) that PR3's
  // `denied` ruling said was missing. There is deliberately no
  // compliance_override path on either — an override would reintroduce the
  // arbitrary-URL hole one approved action at a time. deleteWebConnector is
  // NOT here and stays denied under DELETE_RULE.
  five9_create_web_connector: executeCreateWebConnector,
  five9_modify_web_connector: executeModifyWebConnector,
  // 2026-08-21 Phase H PR4 — campaign composition: what a campaign dials, who
  // it routes to, how it paces. Almost all refuse while the target is
  // RUNNING; the exceptions are add_dispositions (purely additive) and
  // remove_skills (which carries the sharper last-skill guard instead).
  five9_create_outbound_campaign: executeCreateOutboundCampaign,
  five9_add_lists_to_campaign: executeAddListsToCampaign,
  five9_remove_lists_from_campaign: executeRemoveListsFromCampaign,
  five9_modify_campaign_lists: executeModifyCampaignLists,
  five9_add_skills_to_campaign: executeAddSkillsToCampaign,
  five9_remove_skills_from_campaign: executeRemoveSkillsFromCampaign,
  five9_add_dispositions_to_campaign: executeAddDispositionsToCampaign,
  five9_reset_campaign_dispositions: executeResetCampaignDispositions,
  five9_set_campaign_strategies: executeSetCampaignStrategies,
  five9_create_list: executeCreateList,
  five9_reset_list_position: executeResetListPosition,
  // NOT REGISTERED, ON PURPOSE: five9_remove_dispositions_from_campaign.
  // executeRemoveDispositionsFromCampaign is BUILT in admin-writes.js, but its
  // required guard — refuse any disposition in the CC payroll bonus mapping —
  // has no authoritative source. Searched 2026-08-21: no Bonus_Structure.md in
  // any repo, no payroll table in Supabase, and the two authoritative Notion
  // payroll documents derive every bonus from Lead Perfection reports rather
  // than Five9 dispositions (and contradict each other on the one disposition
  // they do name). A guard keyed on a guessed list would read as protection
  // while protecting nothing, so the op stays unreachable: queuing
  // five9_remove_dispositions_from_campaign fails as an unknown action type,
  // which is the intended outcome. See PAYROLL_PROTECTED_DISPOSITIONS for what
  // registering it would take.
};

// The single op exempt from the execution-time approval assertion below.
// Mirrors AUTO_APPROVED_FIVE9_OP in src/tools/agent-tools.js, which is where
// the ruling and the reasoning live — read that comment before touching this.
// Duplicated as a literal rather than imported because this is the
// belt-and-braces half of a deliberately two-layer gate: importing the queue
// layer's constant would mean one edit silently opens both. The pair is
// pinned together by scripts/test-five9-approval-carveout.js.
const EXEC_AUTO_APPROVED_FIVE9_OP = 'five9_add_records_to_list';

// 2026-09-21 — the second carve-out, mirroring AUTO_APPROVED_FIVE9_DNC_OP in
// src/tools/agent-tools.js. Same two-layer discipline: a literal, not an
// import, so one edit cannot open both layers. Add-only and irreversible on
// the Five9 side, so holding it behind approval delays a consumer's opt-out
// rather than protecting them. Armed only while FIVE9_WRITES_ENABLED is set —
// the flag check is duplicated here for the same belt-and-braces reason.
const EXEC_AUTO_APPROVED_FIVE9_DNC_OP = 'five9_add_numbers_to_dnc';

// 2026-09-21 — the re-entry DNC lift. Note what this keys on: the ACTION's
// rule_applied, not the action type. The exemption belongs to one rule, so a
// row of this type queued by anything else is still armed AND still refused
// by the op itself. Keying it on the type would make the exemption reusable
// by whoever queues the next one, which is exactly what the 2026-08-21
// removal ruling was protecting against.
const EXEC_AUTO_APPROVED_REENTRY_OP = 'five9_remove_numbers_from_dnc_reentry';

// 2026-10-06 — booked-lead routing removals (decision #2669), unarmed by
// Mark's standing exception to #1057 ("If we're adding to one list, we should be
// able to automatically remove it from the other list"). Keyed, like the
// re-entry lift, on WHO QUEUED IT: only rows from rule BOOKED_DIAL_ROUTING. Any
// other five9_delete_record_from_list still needs approval. Rollback:
// BOOKED_ROUTING_AUTO_REMOVE=false. A literal, not an import — same two-layer rule.
const EXEC_AUTO_APPROVED_BOOKED_REMOVE_OP = 'five9_delete_record_from_list';
const BOOKED_ROUTING_RULE_KEY = 'BOOKED_DIAL_ROUTING';

// 2026-10-09 — the callback re-arm delete (src/five9/callback-rearm.js). A repeat
// callback push over an entry already on "Callback Request" updates it in place
// and never dials, so lp-requeue removes that entry first. Unarmed for the same
// reason the push is: a promised call cannot wait on a click. Welded to rule
// LP_CALLBACK_REARM_FIVE9 AND to the callback list alone (isCallbackRearmDelete:
// one list, callbackListName(), never LP_ASAP). The same op from any other rule,
// or naming any other list, is still armed. 2026-10-19: the Spanish list
// (SPANISH_FIVE9_LIST) is re-armable too, because its campaign runs the same
// Callback Request V3 profile (rearmableLists).
// 2026-10-16 — disqualified leads (ND / No Demo, Mark, handoff v3.4 Fix 2) come
// off every outbound list. Rows from rule LP_DISP_DISQUALIFIED run unarmed — the
// same carve-out pattern as BOOKED_ROUTING_AUTO_REMOVE, keyed on who queued it.
// 2026-10-19 (the user): automatic by default ("the updates are occurring
// correctly each time"); DISQUALIFIED_FIVE9_AUTO_REMOVE=false is the rollback to
// approval cards. A notice (no buttons) says what LP said and what came off.
const DISQUALIFIED_RULE_KEY = 'LP_DISP_DISQUALIFIED';
// 2026-10-22 (handoff: partner leads leave every Reece Five9 list). A contact an
// outside partner (Ross) owns in GHL comes off the Reece lists, again after each
// 6 AM LP load (src/partners/five9-removal.js). Unarmed, keyed on rule
// PARTNER_FIVE9_REMOVAL, and only while PARTNER_FIVE9_REMOVAL_MODE is still
// `enforce` at execution: flipping the mode back to log stops queued rows too.
const PARTNER_REMOVAL_RULE_KEY = 'PARTNER_FIVE9_REMOVAL';

function execAutoApproved(actionType, action) {
  if (actionType === EXEC_AUTO_APPROVED_FIVE9_OP) return true;
  if (actionType === EXEC_AUTO_APPROVED_BOOKED_REMOVE_OP) {
    if (isCallbackRearmDelete(action)) return true;
    if (action?.rule_applied === DISQUALIFIED_RULE_KEY) {
      return String(process.env.DISQUALIFIED_FIVE9_AUTO_REMOVE || '').trim().toLowerCase() !== 'false';
    }
    if (action?.rule_applied === PARTNER_REMOVAL_RULE_KEY) {
      return String(process.env.PARTNER_FIVE9_REMOVAL_MODE || '').trim().toLowerCase() === 'enforce';
    }
    return action?.rule_applied === BOOKED_ROUTING_RULE_KEY
      && String(process.env.BOOKED_ROUTING_AUTO_REMOVE || '').trim().toLowerCase() !== 'false';
  }
  if (actionType === EXEC_AUTO_APPROVED_REENTRY_OP) {
    return action?.rule_applied === REENTRY_DNC_LIFT_RULE_KEY;
  }
  if (actionType !== EXEC_AUTO_APPROVED_FIVE9_DNC_OP) return false;
  return String(process.env.FIVE9_WRITES_ENABLED || '').toLowerCase() === 'true';
}

export async function executeFive9Write(action) {
  const fn = FIVE9_WRITE_OPS[action.action_type];
  if (!fn) throw new Error(`five9 handler: unknown op ${action.action_type}`);
  // Belt-and-braces: a five9 write row must have entered through the
  // approve_action gate. requires_approval=false means someone bypassed it —
  // except for the carved-out ops, which are queued unarmed by design.
  if (action.requires_approval !== true && !execAutoApproved(action.action_type, action)) {
    throw new Error(`REFUSED: ${action.action_type} must be queued with requires_approval=true (approve_action gate)`);
  }
  const result = await fn(action);
  // 2026-10-09 — a callback push that did not grow the list updated an entry in
  // place and will not dial: say so now, not at the 15-minute verify sweep.
  const rearm = await checkCallbackRearm(action, result);
  // 2026-10-19 — an automatic ND / No Demo removal still tells the team.
  const notice = await noticeDisqualifiedRemoval(action, result);
  const out = rearm ? { ...result, rearm } : result;
  return notice ? { ...out, notice } : out;
}
