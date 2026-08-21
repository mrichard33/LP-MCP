/**
 * Five9 Admin API v13 — operation registry and classification
 * src/five9/op-registry.js (Phase H PR3, 2026-08-21)
 *
 * TWO EXPORTS, TWO DIFFERENT JOBS. Do not merge them.
 *
 *   OP_CLASSIFICATION — a row for every one of the 182 operations in
 *     wsdl-schema.json, whether or not we would ever call it. This is the
 *     RECORD: what exists, what kind it is, what we decided, and why. Reads
 *     live here and nowhere else.
 *
 *   OP_REGISTRY — the WRITE registry: the operations reachable as
 *     five9_* agent action types. Reads are deliberately absent — a read is a
 *     direct MCP tool, never an approvable action, so putting one here would
 *     be a category error. Denied operations are absent too, by construction:
 *     the deny-list is asserted against this array, not maintained alongside
 *     it.
 *
 * WHY A REGISTRY AT ALL. Every Five9 write shipped so far has been six
 * touch-points of hand-written wiring per operation — builder, execute
 * function, guards, handler map, tool description, dry-run section. That is
 * roughly a day per operation and 24 action types deep. With buildFromSchema
 * (src/five9/admin-writes.js) taking the serializer, what is left of an
 * operation is its POLICY: which guards, which confirm_token, whether it
 * reads before writing. This file is that policy, declared rather than
 * scattered.
 *
 * WHAT THIS PR DOES NOT DO. It does not register a single new operation. The
 * registry is seeded with exactly the 24 action types that already ship, and
 * `five9_create_campaign_profile` is the only one migrated onto
 * buildFromSchema. Registering ~40 new types in the same PR that introduces
 * the mechanism generating them would ship a mechanism failure as 40 broken
 * operations — and with FIVE9_WRITES_ENABLED armed in production, they would
 * be live-and-approvable on merge. Each tranche is its own PR against a
 * builder that has already proven itself.
 *
 * TIER VOCABULARY — the line between `enabled` and `gated` is about the
 * PAYLOAD, not about risk:
 *   enabled — registered; approve_action alone clears it. Guards still run
 *             and can refuse (an INBOUND target, a campaign already RUNNING),
 *             but the caller needs no extra ceremony in the payload.
 *   gated   — registered, and the payload must carry something MORE than the
 *             approval: a confirm_token restating the target, a
 *             compliance_override plus legal_basis, or a declared record
 *             count. A gated op can refuse an approved action.
 *   denied  — must not be registered. Every denied row carries a specific
 *             reason. Enforced by test, not by convention.
 *   skip    — not a registry candidate. Every read is `skip` unless a ruling
 *             put it elsewhere; a write is `skip` when it is redundant with
 *             something already shipped or has no identified use.
 *
 * THE SCHEMA IS THE AUTHORITY. Every soapOperation named here is asserted to
 * exist in wsdl-schema.json (scripts/test-five9-op-registry.js). Operation
 * names from pre-v13 documents do not survive that assertion — which is how
 * getCallLogReport, getAgentAuditReport and resetListPositions were caught.
 */

import { wsdlSchema } from './admin-writes.js';

export const TIERS = Object.freeze(['enabled', 'gated', 'denied', 'skip']);
export const KINDS = Object.freeze(['read', 'write']);
export const STATUSES = Object.freeze(['shipped', 'not-built']);

/* ====================================================================== *
 * PART A — classification of all 182 v13 operations.
 *
 * Verified against src/five9/wsdl-schema.json (v13.0.00/13, sha256
 * 0da5d331…) on 2026-08-21. The tier list that came out of earlier planning
 * was v9.5-derived and named four operations that do not exist in v13; it is
 * not carried forward here. Anything below is either quoted from the schema
 * or reasoned from a ruling recorded in the reason column.
 * ====================================================================== */

const c = (kind, tier, status, reason) => ({ kind, tier, status, reason });

// Reused reasons — one string, so the doc reads consistently and a change
// lands everywhere the ruling applies.
const DELETE_RULE =
  'Every delete* operation is denied: Five9 has no undo and no audit trail, so a wrong target is unrecoverable and unattributable.';
const AUTODIAL_RULE = 'Reece does not run autodial campaigns (carried-forward ruling, covers the whole autodial family).';
const CONTACT_DB_RULE =
  'LP is the system of record for contact data; writing Five9’s contact DB creates a third divergent copy.';
const FTP_RULE =
  'The payload is a file on a remote FTP host, so approve_action has nothing to review — there is no artifact of what would be written.';
const READ_SHIPPED = 'Read — already wrapped by a reader in src/five9-admin.js; direct MCP tool, never an agent action.';
const READ_AVAILABLE = 'Read — available if needed; no reader built, and reads are never agent actions.';

export const OP_CLASSIFICATION = Object.freeze({
  /* -- campaign lifecycle ------------------------------------------------ */
  startCampaign: c('write', 'enabled', 'shipped', 'Shipped as five9_start_campaign; refuses an INBOUND target and skips a campaign already RUNNING.'),
  stopCampaign: c('write', 'enabled', 'shipped', 'Shipped as five9_stop_campaign; refuses an INBOUND target and skips a campaign already NOT_RUNNING.'),
  forceStopCampaign: c('write', 'enabled', 'shipped', 'Reached through five9_stop_campaign when action_payload.force === true; deliberately not a separate action type.'),
  resetCampaign: c('write', 'gated', 'shipped', 'Shipped as five9_reset_campaign: confirm_token restating the campaign name, and REFUSES a RUNNING campaign — reset clears dispositions and list positions, making every record re-dialable at once.'),
  createOutboundCampaign: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the new campaign name, refuse unless profileName names an existing campaign profile, and create only with state=NOT_RUNNING.'),
  modifyOutboundCampaign: c('write', 'gated', 'shipped', 'Shipped as five9_set_outbound_campaign: confirm_token restating the campaign name, a PATCHABLE_FIELDS whitelist narrower than the schema, and the FCC/FTC abandonment guard on maxQueueTime / maxDroppedCallsPercentage.'),
  renameCampaign: c('write', 'denied', 'not-built', 'DNIS→campaign→source attribution keys on campaign names; a rename silently re-buckets every historical call.'),
  deleteCampaign: c('write', 'denied', 'not-built', DELETE_RULE),
  createInboundCampaign: c('write', 'enabled', 'shipped', 'Shipped as five9_create_inbound_campaign; requires action_payload.script_name because Five9 refuses to create one with a null defaultIvrSchedule.'),
  modifyInboundCampaign: c('write', 'denied', 'not-built', 'Guardrail 2 makes inbound campaigns immutable; setDefaultIVRSchedule is the sanctioned way to re-point one.'),
  createAutodialCampaign: c('write', 'denied', 'not-built', AUTODIAL_RULE),
  modifyAutodialCampaign: c('write', 'denied', 'not-built', AUTODIAL_RULE),
  getAutodialCampaign: c('read', 'denied', 'not-built', `${AUTODIAL_RULE} It is a read, so it could never be an action type; the ruling is recorded here so the family reads as one decision.`),
  getCampaigns: c('read', 'skip', 'shipped', READ_SHIPPED),
  getCampaignState: c('read', 'skip', 'shipped', READ_SHIPPED),
  getOutboundCampaign: c('read', 'skip', 'shipped', READ_SHIPPED),
  getInboundCampaign: c('read', 'skip', 'shipped', READ_SHIPPED),
  getCallCountersState: c('read', 'skip', 'not-built', READ_AVAILABLE),

  /* -- campaign composition: lists, skills, dispositions, strategies ----- */
  addListsToCampaign: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the campaign name, and refuse while the campaign is RUNNING — adding a list changes what is dialing underneath the agents on it.'),
  removeListsFromCampaign: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the campaign name, and refuse while the campaign is RUNNING.'),
  modifyCampaignLists: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the campaign name; this REPLACES the list set, so it must read-before-write and refuse while the campaign is RUNNING.'),
  addSkillsToCampaign: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the campaign name; refuse while RUNNING.'),
  removeSkillsFromCampaign: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the campaign name, and refuse removal of the last skill on a RUNNING campaign — that strands every queued call on it.'),
  addDispositionsToCampaign: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the campaign name; dispositions drive CC payroll bonus math, so the set a campaign offers is not a silent change.'),
  removeDispositionsFromCampaign: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the campaign name, and refuse any disposition named in the CC payroll bonus mapping.'),
  asyncUpdateCampaignDispositions: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the campaign name plus an expected_count, same shape as async_delete_records_from_list — this is the bulk form of a payroll-sensitive change.'),
  resetCampaignDispositions: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the campaign name and refuse while RUNNING — same re-dialable-at-once blast radius as resetCampaign, scoped to dispositions.'),
  setCampaignStrategies: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the campaign name and refuse while RUNNING — a strategy governs dial pacing, which is the compliance-exposed dimension.'),
  getCampaignStrategies: c('read', 'skip', 'not-built', READ_AVAILABLE),
  getListsForCampaign: c('read', 'skip', 'shipped', READ_SHIPPED),
  getCampaignDNISList: c('read', 'skip', 'shipped', READ_SHIPPED),

  /* -- DNIS -------------------------------------------------------------- */
  addDNISToCampaign: c('write', 'gated', 'shipped', 'Shipped as five9_add_dnis_to_campaign: REFUSES a number currently assigned to a different campaign without compliance_override, because reassigning a live number silently re-routes a marketing line and breaks its attribution.'),
  removeDNISFromCampaign: c('write', 'gated', 'shipped', 'Shipped as five9_remove_dnis_from_campaign: confirm_token restating the campaign name, because removing a DNIS dead-ends a live number that still looks fine from the outside.'),
  getDNISList: c('read', 'skip', 'shipped', READ_SHIPPED),

  /* -- lists and records ------------------------------------------------- */
  createList: c('write', 'enabled', 'not-built', 'A new list is empty and attached to nothing until a separate approved action adds it to a campaign; nothing dials as a result of this call.'),
  deleteList: c('write', 'denied', 'not-built', DELETE_RULE),
  deleteAllFromList: c('write', 'denied', 'not-built', DELETE_RULE),
  addRecordToList: c('write', 'enabled', 'shipped', 'Shipped as five9_add_records_to_list, capped at MAX_RECORDS_PER_ACTION (50) per action.'),
  addRecordToListSimple: c('write', 'skip', 'not-built', 'Redundant with addRecordToList, which ships; a second builder for the same effect is maintenance with no new capability.'),
  asyncAddRecordsToList: c('write', 'gated', 'not-built', 'The bulk sibling of add_records_to_list — guard: confirm_token restating the list name plus expected_record_count, mirroring async_delete. NOTE: buildAsyncAddRecordsToListXml already ships, but only to describe the ROLLBACK for async delete; no action type reaches it.'),
  addToList: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the list name plus expected_record_count — inline bulk add, reviewable at approval time.'),
  addToListCsv: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the list name plus expected_record_count; the CSV rides inline, so the approver can see what is being added.'),
  addToListFtp: c('write', 'denied', 'not-built', FTP_RULE),
  deleteRecordFromList: c('write', 'enabled', 'shipped', 'Shipped as five9_delete_record_from_list — single-record deletion by dial key.'),
  asyncDeleteRecordsFromList: c('write', 'gated', 'shipped', 'Shipped as five9_async_delete_records_from_list: confirm_token restating the list name, a declared expected_record_count, and refusal above FIVE9_MAX_LIST_DELETE or >50% of the list without compliance_override.'),
  deleteFromList: c('write', 'skip', 'not-built', 'asyncDeleteRecordsFromList already ships with the volume ceiling, proportion guard and declared-count check; a second bulk-delete path would need all three re-implemented to be equally safe.'),
  deleteFromListCsv: c('write', 'skip', 'not-built', 'Redundant with deleteFromList for the same reason: asyncDeleteRecordsFromList already ships with the volume ceiling, proportion guard and declared-count check this path would have to duplicate.'),
  deleteFromListFtp: c('write', 'denied', 'not-built', FTP_RULE),
  resetListPosition: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the list name, and refuse while any campaign using the list is RUNNING — rewinding the position re-dials the list from the top. (The v1 handoff called this resetListPositions, plural, which does not exist in v13.)'),
  getListsInfo: c('read', 'skip', 'shipped', READ_SHIPPED),
  getListImportResult: c('read', 'skip', 'shipped', READ_SHIPPED),
  isImportRunning: c('read', 'skip', 'shipped', READ_SHIPPED),
  getCrmImportResult: c('read', 'skip', 'not-built', READ_AVAILABLE),

  /* -- contact database (LP is the system of record) --------------------- */
  updateContacts: c('write', 'denied', 'not-built', CONTACT_DB_RULE),
  updateContactsCsv: c('write', 'denied', 'not-built', CONTACT_DB_RULE),
  updateContactsFtp: c('write', 'denied', 'not-built', `${CONTACT_DB_RULE} ${FTP_RULE}`),
  updateCrmRecord: c('write', 'denied', 'not-built', CONTACT_DB_RULE),
  asyncUpdateCrmRecords: c('write', 'denied', 'not-built', CONTACT_DB_RULE),
  deleteFromContacts: c('write', 'denied', 'not-built', `${CONTACT_DB_RULE} ${DELETE_RULE}`),
  deleteFromContactsCsv: c('write', 'denied', 'not-built', `${CONTACT_DB_RULE} ${DELETE_RULE}`),
  deleteFromContactsFtp: c('write', 'denied', 'not-built', `${CONTACT_DB_RULE} ${FTP_RULE}`),
  getContactRecords: c('read', 'skip', 'not-built', READ_AVAILABLE),
  getContactFields: c('read', 'skip', 'not-built', READ_AVAILABLE),
  createContactField: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the field name, and refuse a name that collides with an existing field — a contact field is the schema every list import maps onto.'),
  modifyContactField: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the field name, and refuse any change to `type` on a field referenced by list-dispatch or a shipped field order — a type change breaks every existing mapping.'),
  deleteContactField: c('write', 'denied', 'not-built', DELETE_RULE),

  /* -- DNC --------------------------------------------------------------- */
  addNumbersToDnc: c('write', 'enabled', 'shipped', 'Shipped as five9_add_numbers_to_dnc. DNC is ADD-ONLY by ruling.'),
  removeNumbersFromDnc: c('write', 'denied', 'not-built', 'Ruled by Mark 2026-08-21 and removed outright: Reece does not take numbers off DNC under any circumstance, so there is no gate, override, or reason string that yields it. The action type five9_remove_numbers_from_dnc must stay an unknown action type.'),
  checkDncForNumbers: c('read', 'skip', 'shipped', READ_SHIPPED),

  /* -- dispositions ------------------------------------------------------ */
  createDisposition: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the disposition name, and refuse a name colliding with an existing one — CC payroll bonus math keys on disposition NAMES.'),
  modifyDisposition: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the disposition name, and refuse any payload that changes the name field (that is renameDisposition by another route, which is denied).'),
  renameDisposition: c('write', 'denied', 'not-built', 'CC payroll bonus math reads disposition names; a rename silently corrupts payroll history.'),
  removeDisposition: c('write', 'denied', 'not-built', 'CC payroll bonus math reads disposition names; removing one silently corrupts payroll history.'),
  updateDispositions: c('write', 'denied', 'not-built', 'Bulk disposition rewrite — the same payroll-history corruption as renameDisposition, at list scale and with no per-name review step.'),
  updateDispositionsCsv: c('write', 'denied', 'not-built', 'Bulk disposition rewrite — the same payroll-history corruption as renameDisposition, at list scale and with no per-name review step.'),
  updateDispositionsFtp: c('write', 'denied', 'not-built', FTP_RULE),
  getDisposition: c('read', 'skip', 'not-built', READ_AVAILABLE),
  getDispositions: c('read', 'skip', 'shipped', READ_SHIPPED),
  getDispositionsImportResult: c('read', 'skip', 'not-built', READ_AVAILABLE),

  /* -- campaign profiles ------------------------------------------------- */
  createCampaignProfile: c('write', 'enabled', 'shipped', 'Shipped as five9_create_campaign_profile. FIRST OPERATION MIGRATED ONTO buildFromSchema (PR3) — a new profile is attached to nothing until a separate approved patch moves a campaign onto it.'),
  modifyCampaignProfile: c('write', 'gated', 'shipped', 'Shipped as five9_modify_campaign_profile: confirm_token restating the profile name, because a profile is shared — `Data Leads` alone serves five campaigns.'),
  deleteCampaignProfile: c('write', 'denied', 'not-built', DELETE_RULE),
  modifyCampaignProfileCrmCriteria: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the profile name, and refuse while any campaign on the profile is RUNNING — CRM criteria decide WHICH records dial, so this is a compliance-exposed selection change.'),
  modifyCampaignProfileDispositions: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the profile name, and refuse removal of any disposition in the CC payroll bonus mapping.'),
  modifyCampaignProfileFilterOrder: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the profile name, and refuse while any campaign on the profile is RUNNING — filter order decides dial precedence across the profile.'),
  getCampaignProfiles: c('read', 'skip', 'shipped', READ_SHIPPED),
  getCampaignProfileDispositions: c('read', 'skip', 'not-built', READ_AVAILABLE),
  getCampaignProfileFilter: c('read', 'skip', 'not-built', READ_AVAILABLE),

  /* -- IVR scripts and routing ------------------------------------------- */
  createIVRScript: c('write', 'enabled', 'shipped', 'Shipped as five9_create_ivr_script. createIVRScript takes ONLY <name>, so the executor owns the create→modify seam and compensates with deleteIVRScript when the second call fails.'),
  modifyIVRScript: c('write', 'gated', 'shipped', 'Shipped as five9_modify_ivr_script: confirm_token restating the script name, and refuses a script live on more than one RUNNING campaign without compliance_override — there is no staging step between save and live.'),
  deleteIVRScript: c('write', 'denied', 'shipped', 'Reachable ONLY as create-compensation inside executeCreateIvrScript, exactly as today. It must never become a registered action type: nothing may queue a script deletion.'),
  getIVRScripts: c('read', 'skip', 'shipped', READ_SHIPPED),
  setDefaultIVRSchedule: c('write', 'enabled', 'shipped', 'Shipped as five9_set_default_ivr_schedule — the sanctioned way to re-point an inbound campaign, since modifyInboundCampaign is denied.'),
  getIvrIcons: c('read', 'skip', 'not-built', `${READ_AVAILABLE} NEW SURFACE — never considered before PR3.`),
  setIvrIcons: c('write', 'skip', 'not-built', 'NEW SURFACE, flagged for Mark. Icons are the visual representation of a script in the Five9 IVR designer and have no runtime effect on routing; proposed skip as cosmetic.'),
  removeIvrIcons: c('write', 'skip', 'not-built', 'NEW SURFACE, flagged for Mark. Cosmetic, as setIvrIcons — proposed skip.'),
  getIvrScriptOwnership: c('read', 'skip', 'not-built', `${READ_AVAILABLE} NEW SURFACE — never considered before PR3.`),
  setIvrScriptOwnership: c('write', 'skip', 'not-built', 'NEW SURFACE, flagged for Mark. The schema shows a single `othersCanCopy` boolean, so this governs whether other admins may COPY a script — not who may edit or run it. Proposed skip: no agentic need, and it is not the access-control grant the name suggests.'),
  removeIvrScriptOwnership: c('write', 'skip', 'not-built', 'NEW SURFACE, flagged for Mark. Clears the othersCanCopy flag set by setIvrScriptOwnership — proposed skip for the same reason.'),

  /* -- prompts ----------------------------------------------------------- */
  addPromptTTS: c('write', 'enabled', 'shipped', 'Shipped as five9_create_prompt_tts — a new TTS prompt is referenced by nothing until a script points at it.'),
  modifyPromptTTS: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the prompt name, and refuse a prompt referenced by an IVR script live on a RUNNING campaign without compliance_override — this changes what callers hear, immediately.'),
  addPromptWav: c('write', 'skip', 'not-built', 'Binary audio upload; no agentic path produces a WAV, and TTS already covers the prompt need.'),
  addPromptWavInline: c('write', 'skip', 'not-built', 'Binary audio upload; no agentic path produces a WAV, and TTS already covers the prompt need.'),
  modifyPromptWav: c('write', 'skip', 'not-built', 'Binary audio upload; no agentic path produces a WAV, and TTS already covers the prompt need.'),
  modifyPromptWavInline: c('write', 'skip', 'not-built', 'Binary audio upload; no agentic path produces a WAV, and TTS already covers the prompt need.'),
  deletePrompt: c('write', 'denied', 'not-built', DELETE_RULE),
  deleteLanguagePrompt: c('write', 'denied', 'not-built', DELETE_RULE),
  getPrompt: c('read', 'skip', 'not-built', READ_AVAILABLE),
  getPrompts: c('read', 'skip', 'shipped', READ_SHIPPED),

  /* -- skills ------------------------------------------------------------ */
  createSkill: c('write', 'enabled', 'not-built', 'A new skill routes nothing until a separate approved action assigns it to a user or campaign.'),
  modifySkill: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the skill name, and refuse while any campaign carrying the skill is RUNNING — skill parameters decide live call routing.'),
  deleteSkill: c('write', 'denied', 'not-built', DELETE_RULE),
  userSkillAdd: c('write', 'enabled', 'shipped', 'Shipped as five9_user_skill_add; reads the user’s current skills first and refuses a level outside 1–9.'),
  userSkillModify: c('write', 'enabled', 'shipped', 'Shipped as five9_user_skill_modify; reads before writing and refuses a skill the user does not hold.'),
  userSkillRemove: c('write', 'enabled', 'shipped', 'Shipped as five9_user_skill_remove; reads before writing. <level> is schema-required even on remove.'),
  getSkill: c('read', 'skip', 'not-built', READ_AVAILABLE),
  getSkills: c('read', 'skip', 'shipped', READ_SHIPPED),
  getSkillInfo: c('read', 'skip', 'not-built', READ_AVAILABLE),
  getSkillsInfo: c('read', 'skip', 'not-built', READ_AVAILABLE),
  addSkillAudioFile: c('write', 'skip', 'not-built', 'Audio asset management; a Five9-UI task with no agentic path that produces the file.'),
  removeSkillAudioFile: c('write', 'skip', 'not-built', 'Audio asset management; a Five9-UI task with no agentic path that produces the file.'),
  getSkillAudioFiles: c('read', 'skip', 'not-built', READ_AVAILABLE),
  setSkillVoicemailGreeting: c('write', 'skip', 'not-built', 'Audio asset management; a Five9-UI task with no agentic path that produces the greeting.'),
  getSkillVoicemailGreeting: c('read', 'skip', 'not-built', READ_AVAILABLE),

  /* -- users, profiles, agent groups ------------------------------------- */
  createUser: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the user name, plus the Guardrail 12 role check — a new user carrying admin or supervisor needs compliance_override AND a written legal_basis.'),
  modifyUser: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the user name, plus the Guardrail 12 role check on any roles block that populates admin or supervisor.'),
  deleteUser: c('write', 'denied', 'not-built', DELETE_RULE),
  modifyUserCannedReports: c('write', 'skip', 'not-built', 'Per-user report subscriptions; no agentic need identified.'),
  setUserVoicemailGreeting: c('write', 'skip', 'not-built', 'Audio asset management; a Five9-UI task with no agentic path that produces the greeting.'),
  getUserVoicemailGreeting: c('read', 'skip', 'not-built', READ_AVAILABLE),
  getUserInfo: c('read', 'skip', 'not-built', READ_AVAILABLE),
  getUsersInfo: c('read', 'skip', 'shipped', READ_SHIPPED),
  getUserGeneralInfo: c('read', 'skip', 'not-built', READ_AVAILABLE),
  getUsersGeneralInfo: c('read', 'skip', 'shipped', READ_SHIPPED),
  createUserProfile: c('write', 'gated', 'shipped', 'Shipped as five9_create_user_profile: confirm_token restating the profile name plus Guardrail 12 on any submitted roles block granting admin or supervisor.'),
  modifyUserProfile: c('write', 'gated', 'shipped', 'Shipped as five9_modify_user_profile: REPLACES the whole userProfile struct, so it read-modify-writes; confirm_token is checked against Five9’s own spelling of the live profile, and Guardrail 12 applies to changes.roles.'),
  modifyUserProfileSkills: c('write', 'enabled', 'shipped', 'Shipped as five9_modify_user_profile_skills — the narrow patch: {profile_name, add_skills[], remove_skills[]}, cannot touch a role grant.'),
  modifyUserProfileUserList: c('write', 'enabled', 'shipped', 'Shipped as five9_modify_user_profile_user_list — the narrow patch: {profile_name, add_users[], remove_users[]}, cannot touch a role grant.'),
  deleteUserProfile: c('write', 'denied', 'not-built', DELETE_RULE),
  getUserProfile: c('read', 'skip', 'shipped', READ_SHIPPED),
  getUserProfiles: c('read', 'skip', 'shipped', `${READ_SHIPPED} Takes Five9’s misspelled userProfileNamePatern.`),
  createAgentGroup: c('write', 'enabled', 'not-built', 'A new agent group contains nobody and routes nothing until a separate approved action populates it.'),
  modifyAgentGroup: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the group name — group membership decides supervisor visibility and reporting rollups.'),
  deleteAgentGroup: c('write', 'denied', 'not-built', DELETE_RULE),
  getAgentGroup: c('read', 'skip', 'not-built', READ_AVAILABLE),
  getAgentGroups: c('read', 'skip', 'not-built', READ_AVAILABLE),

  /* -- call variables ---------------------------------------------------- */
  createCallVariable: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the variable name, and refuse a name colliding with an existing variable — call variables are the payload IVR scripts and agent screens read.'),
  modifyCallVariable: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the variable name, and refuse a change to a variable referenced by a shipped IVR script or list mapping.'),
  deleteCallVariable: c('write', 'denied', 'not-built', DELETE_RULE),
  createCallVariablesGroup: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the group name; a group is the namespace call variables resolve within.'),
  modifyCallVariablesGroup: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the group name, and refuse a rename that would orphan variables resolving through it.'),
  deleteCallVariablesGroup: c('write', 'denied', 'not-built', DELETE_RULE),
  getCallVariables: c('read', 'skip', 'not-built', READ_AVAILABLE),
  getCallVariableGroups: c('read', 'skip', 'not-built', READ_AVAILABLE),

  /* -- reason codes ------------------------------------------------------ */
  createReasonCode: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the reason code name — adherence reporting keys on the name, the same hazard that denies renameDisposition.'),
  modifyReasonCode: c('write', 'gated', 'not-built', 'Guard: confirm_token restating the reason code name, and refuse any payload that renames it — adherence history keys on the name.'),
  deleteReasonCode: c('write', 'denied', 'not-built', DELETE_RULE),
  deleteReasonCodeByType: c('write', 'denied', 'not-built', DELETE_RULE),
  getReasonCode: c('read', 'skip', 'not-built', READ_AVAILABLE),
  getReasonCodeByType: c('read', 'skip', 'not-built', READ_AVAILABLE),

  /* -- web connectors ---------------------------------------------------- */
  createWebConnector: c('write', 'denied', 'not-built', 'A web connector posts live call and contact data to an arbitrary URL from the agent desktop; there is no destination allow-list, so creating one agentically is an exfiltration path with no review of where the data goes.'),
  modifyWebConnector: c('write', 'denied', 'not-built', 'Repointing an existing connector’s URL is the same exfiltration path as creating one, without even the appearance of a new object.'),
  deleteWebConnector: c('write', 'denied', 'not-built', DELETE_RULE),
  getWebConnectors: c('read', 'skip', 'not-built', READ_AVAILABLE),

  /* -- dialing rules and tenant configuration ---------------------------- */
  setDialingRules: c('write', 'denied', 'not-built', 'State dialing rules — currently REGION — are the TCPA/state-calling-hours enforcement surface; changing them agentically moves a compliance boundary.'),
  getDialingRules: c('read', 'skip', 'not-built', READ_AVAILABLE),
  modifyVCCConfiguration: c('write', 'denied', 'not-built', 'Tenant-wide configuration: one call changes settings for every campaign, agent and list at once, and there is no narrower operation to scope an approval to the field actually being changed.'),
  getVCCConfiguration: c('read', 'skip', 'shipped', READ_SHIPPED),
  setLocale: c('write', 'skip', 'not-built', 'Tenant display locale, set once at provisioning; no agentic need identified.'),
  getLocale: c('read', 'skip', 'not-built', READ_AVAILABLE),
  getAvailableLocales: c('read', 'skip', 'not-built', READ_AVAILABLE),
  updateConfigurationTranslations: c('write', 'skip', 'not-built', 'Localisation strings for the agent desktop; no agentic need identified.'),
  getConfigurationTranslations: c('read', 'skip', 'not-built', READ_AVAILABLE),

  /* -- speed dial (NEW SURFACE) ------------------------------------------ */
  createSpeedDialNumber: c('write', 'skip', 'not-built', 'NEW SURFACE, flagged for Mark. Schema is {code, number, description} — an agent-desktop dialling shortcut with no routing or compliance effect. Proposed skip: no agentic need identified.'),
  removeSpeedDialNumber: c('write', 'skip', 'not-built', 'NEW SURFACE, flagged for Mark. Removes a desktop shortcut by code; proposed skip for the same reason as createSpeedDialNumber. Note it is remove*, not delete*, and destroys no history.'),
  getSpeedDialNumbers: c('read', 'skip', 'not-built', `${READ_AVAILABLE} NEW SURFACE — never considered before PR3.`),

  /* -- reporting and session --------------------------------------------- */
  runReport: c('read', 'skip', 'shipped', 'Read-path: starts a report run and returns a handle; mutates no configuration. Already wrapped by runReport / runReportAndWait in src/five9-admin.js.'),
  isReportRunning: c('read', 'skip', 'shipped', READ_SHIPPED),
  getReportResult: c('read', 'skip', 'shipped', READ_SHIPPED),
  getReportResultCsv: c('read', 'skip', 'not-built', READ_AVAILABLE),
  getApiVersions: c('read', 'skip', 'not-built', READ_AVAILABLE),
  closeSession: c('write', 'skip', 'not-built', 'Session lifecycle, not a configuration mutation — the SOAP client manages its own sessions.'),
});

/* ====================================================================== *
 * PART B — the write registry.
 *
 * Seeded with exactly the 24 action types that already ship. `builder` names
 * the serializer: 'buildFromSchema' means the generic schema walk, anything
 * else is a custom builder that the generic path cannot express (positional
 * list-record bodies, a bare-string action field, the create→modify seam).
 *
 * `guards` names the exported functions in admin-writes.js that can refuse.
 * It is documentation of policy, not a dispatch table — the executors still
 * call their own guards. Wiring the registry INTO dispatch is a later PR;
 * doing it here would mean the mechanism and its first users land together.
 * ====================================================================== */

const reg = (actionType, soapOperation, complexType, tier, {
  guards = [], confirmToken = null, readBeforeWrite = false, builder = 'buildFromSchema', note = '',
} = {}) => ({
  actionType, soapOperation, complexType, kind: 'write', tier,
  guards, confirmToken, readBeforeWrite, builder, note,
});

export const OP_REGISTRY = Object.freeze([
  /* -- lifecycle --------------------------------------------------------- */
  reg('five9_start_campaign', 'startCampaign', null, 'enabled', {
    guards: ['refuseIfInbound', 'decideLifecycleNoop'], readBeforeWrite: true,
    builder: 'buildCampaignNameXml',
    note: 'Body is a bare <campaignName> string, not a complexType — no schema walk to do.',
  }),
  reg('five9_stop_campaign', 'stopCampaign', null, 'enabled', {
    guards: ['refuseIfInbound', 'decideLifecycleNoop'], readBeforeWrite: true,
    builder: 'buildCampaignNameXml',
    note: 'Dispatches to forceStopCampaign when action_payload.force === true.',
  }),
  reg('five9_reset_campaign', 'resetCampaign', null, 'gated', {
    guards: ['refuseIfInbound', 'checkConfirmToken', 'checkResetCampaignState'],
    confirmToken: 'campaign_name', readBeforeWrite: true, builder: 'buildCampaignNameXml',
  }),
  reg('five9_set_outbound_campaign', 'modifyOutboundCampaign', 'outboundCampaign', 'gated', {
    guards: ['refuseIfInbound', 'checkConfirmToken', 'checkCompliancePatch', 'verifyPatchReadBack'],
    confirmToken: 'campaign_name', readBeforeWrite: true,
    builder: 'buildModifyOutboundCampaignXml',
    note: 'Not yet migrated: PATCHABLE_FIELDS, the timer trio and the campaignDialingAction pair all sit on top of the sequence walk. Next tranche.',
  }),

  /* -- lists ------------------------------------------------------------- */
  reg('five9_add_records_to_list', 'addRecordToList', null, 'enabled', {
    guards: ['assertNoRecordFailures'], builder: 'buildAddRecordToListXml',
    note: 'Positional <fieldsMapping>/<fields> pairing — not an xs:sequence walk; stays custom.',
  }),
  reg('five9_delete_record_from_list', 'deleteRecordFromList', null, 'enabled', {
    guards: ['assertNoRecordFailures'], builder: 'buildDeleteRecordFromListXml',
    note: 'Positional record body — stays custom.',
  }),
  reg('five9_async_delete_records_from_list', 'asyncDeleteRecordsFromList', 'listDeleteSettings', 'gated', {
    guards: ['checkConfirmToken', 'assertDeclaredRecordCount', 'checkListDeleteCompliance', 'verifyListDeleteCounts'],
    confirmToken: 'list_name', readBeforeWrite: true,
    builder: 'buildAsyncDeleteRecordsFromListXml',
    note: 'Also requires action_payload.expected_record_count; defers while the import job runs.',
  }),

  /* -- DNC --------------------------------------------------------------- */
  reg('five9_add_numbers_to_dnc', 'addNumbersToDnc', null, 'enabled', {
    guards: ['checkDncForNumbers'], readBeforeWrite: true, builder: 'buildNumbersXml',
    note: 'ADD-ONLY. There is no removal counterpart and none may be added.',
  }),

  /* -- user skills ------------------------------------------------------- */
  reg('five9_user_skill_add', 'userSkillAdd', 'userSkill', 'enabled', {
    guards: ['heldSkill'], readBeforeWrite: true, builder: 'buildUserSkillXml',
    note: 'Custom only for the 1–9 level validation; the body itself is a plain sequence walk.',
  }),
  reg('five9_user_skill_modify', 'userSkillModify', 'userSkill', 'enabled', {
    guards: ['heldSkill'], readBeforeWrite: true, builder: 'buildUserSkillXml',
  }),
  reg('five9_user_skill_remove', 'userSkillRemove', 'userSkill', 'enabled', {
    guards: ['heldSkill'], readBeforeWrite: true, builder: 'buildUserSkillXml',
    note: '<level> is schema-required even on remove (minOccurs=1).',
  }),

  /* -- campaign profiles ------------------------------------------------- */
  reg('five9_create_campaign_profile', 'createCampaignProfile', 'campaignProfileInfo', 'enabled', {
    guards: ['checkProfileCompliance'], readBeforeWrite: true, builder: 'buildFromSchema',
    note: 'MIGRATED IN PR3 — the first op on the schema-driven builder. Proven byte-identical to the hand-written loop it replaced.',
  }),
  reg('five9_modify_campaign_profile', 'modifyCampaignProfile', 'campaignProfileInfo', 'gated', {
    guards: ['checkConfirmToken', 'checkProfileCompliance'], confirmToken: 'profile_name',
    readBeforeWrite: true, builder: 'buildFromSchema',
    note: 'Shares buildCampaignProfileXml with create, so it rode the same migration.',
  }),

  /* -- config surface (Phase G) ------------------------------------------ */
  reg('five9_create_ivr_script', 'createIVRScript', 'ivrScriptDef', 'enabled', {
    guards: ['assertWellFormedXml', 'assertIvrDefinitionLimit'], readBeforeWrite: true,
    builder: 'buildIvrScriptNameXml + buildIvrScriptDefXml',
    note: 'Two SOAP calls, not atomic: createIVRScript takes only <name>. Compensates with deleteIVRScript when the modify fails.',
  }),
  reg('five9_modify_ivr_script', 'modifyIVRScript', 'ivrScriptDef', 'gated', {
    guards: ['checkConfirmToken', 'assertWellFormedXml', 'assertIvrDefinitionLimit'],
    confirmToken: 'name', readBeforeWrite: true, builder: 'buildIvrScriptDefXml',
    note: 'Refuses a script live on >1 RUNNING campaign without compliance_override.',
  }),
  reg('five9_create_inbound_campaign', 'createInboundCampaign', 'inboundCampaign', 'enabled', {
    guards: ['assertUserProfileExists'], readBeforeWrite: true, builder: 'buildInboundCampaignXml',
    note: 'Nested callWrapup + defaultIvrSchedule; requires action_payload.script_name because Five9 refuses a null defaultIvrSchedule.',
  }),
  reg('five9_set_default_ivr_schedule', 'setDefaultIVRSchedule', 'ivrScriptSchedule', 'enabled', {
    readBeforeWrite: true, builder: 'buildSetDefaultIvrScheduleXml',
  }),
  reg('five9_add_dnis_to_campaign', 'addDNISToCampaign', null, 'gated', {
    guards: ['checkDnisSteal'], readBeforeWrite: true, builder: 'buildCampaignDnisXml',
    note: 'Refuses a number assigned to another campaign without compliance_override.',
  }),
  reg('five9_remove_dnis_from_campaign', 'removeDNISFromCampaign', null, 'gated', {
    guards: ['checkConfirmToken'], confirmToken: 'campaign_name', readBeforeWrite: true,
    builder: 'buildCampaignDnisXml',
  }),
  reg('five9_create_prompt_tts', 'addPromptTTS', null, 'enabled', {
    readBeforeWrite: true, builder: 'buildPromptTtsXml',
  }),

  /* -- user profiles (Phase H) ------------------------------------------- */
  reg('five9_modify_user_profile_skills', 'modifyUserProfileSkills', null, 'enabled', {
    guards: ['assertUserProfileExists', 'assertSomethingToDo'], readBeforeWrite: true,
    builder: 'buildModifyUserProfileSkillsXml',
    note: 'Narrow patch; cannot reach a role grant, so Guardrail 12 does not apply.',
  }),
  reg('five9_modify_user_profile_user_list', 'modifyUserProfileUserList', null, 'enabled', {
    guards: ['assertUserProfileExists', 'assertSomethingToDo', 'checkAddUsersKnown'],
    readBeforeWrite: true, builder: 'buildModifyUserProfileUserListXml',
    note: 'Narrow patch; cannot reach a role grant, so Guardrail 12 does not apply.',
  }),
  reg('five9_create_user_profile', 'createUserProfile', 'userProfile', 'gated', {
    guards: ['checkConfirmToken', 'checkRoleGrant'], confirmToken: 'profile_name',
    readBeforeWrite: true, builder: 'buildUserProfileXml',
    note: 'Guardrail 12: a submitted roles block populating admin or supervisor needs compliance_override AND legal_basis.',
  }),
  reg('five9_modify_user_profile', 'modifyUserProfile', 'userProfile', 'gated', {
    guards: ['checkConfirmToken', 'checkRoleGrant', 'assertUserProfileExists', 'mergeUserProfile'],
    confirmToken: 'profile_name', readBeforeWrite: true, builder: 'buildUserProfileXml',
    note: 'REPLACES the whole struct, so it read-modify-writes; the token is checked against Five9’s own spelling of the live profile.',
  }),
]);

/* ====================================================================== *
 * Derived views and lookups.
 * ====================================================================== */

/** soapOperation → reason, for every operation ruled out. */
export const DENIED_OPERATIONS = Object.freeze(
  Object.fromEntries(
    Object.entries(OP_CLASSIFICATION)
      .filter(([, v]) => v.tier === 'denied')
      .map(([op, v]) => [op, v.reason])
  )
);

/**
 * Action types that must NOT exist. Kept explicit rather than derived: a
 * derived list would go quiet the moment someone removed the classification
 * row, which is exactly the change that needs to fail loudly.
 */
export const FORBIDDEN_ACTION_TYPES = Object.freeze([
  'five9_remove_numbers_from_dnc',
  'five9_delete_ivr_script',
  'five9_delete_campaign',
  'five9_delete_list',
  'five9_delete_user',
  'five9_delete_user_profile',
  'five9_rename_campaign',
  'five9_rename_disposition',
  'five9_remove_disposition',
  'five9_set_dialing_rules',
  'five9_modify_inbound_campaign',
  'five9_update_contacts',
  'five9_update_crm_record',
]);

export const registryByActionType = () =>
  new Map(OP_REGISTRY.map((e) => [e.actionType, e]));

export const isDenied = (soapOperation) =>
  Object.hasOwn(DENIED_OPERATIONS, soapOperation);

/** Classification rows for a tier, as [operation, row] pairs. */
export const byTier = (tier) =>
  Object.entries(OP_CLASSIFICATION).filter(([, v]) => v.tier === tier);

/** Every classified operation that is absent from the v13 schema. */
export function unknownOperations(schema = wsdlSchema()) {
  return Object.keys(OP_CLASSIFICATION).filter((op) => !schema.operations[op]);
}

/** Every v13 operation with no classification row. */
export function unclassifiedOperations(schema = wsdlSchema()) {
  return Object.keys(schema.operations).filter((op) => !OP_CLASSIFICATION[op]);
}
