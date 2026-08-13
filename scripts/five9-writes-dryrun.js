/**
 * Five9 writes dry-run — scripts/five9-writes-dryrun.js
 *
 * Prints, for every Phase C write op, the exact SOAP method + inner XML
 * that would be sent for a representative payload, plus every guardrail
 * verdict (pass and fail variants) and the five9.admin_write audit event
 * shape that would be emitted. ZERO network, ZERO DB — this is the
 * reviewable "what would Claude send" artifact before FIVE9_WRITES_ENABLED
 * ever flips.
 *
 * Usage: node scripts/five9-writes-dryrun.js --dry
 * The --dry flag is REQUIRED (exit 1 otherwise) so this script can never be
 * fat-fingered into something that looks like a live write path.
 */
import {
  five9WritesEnabled,
  refuseIfInbound,
  checkCompliancePatch,
  validateDncRemovals,
  buildCampaignNameXml,
  buildNumbersXml,
  buildModifyOutboundCampaignXml,
  buildAddRecordToListXml,
  buildDeleteRecordFromListXml,
  decideLifecycleNoop,
  checkConfirmToken,
  // 2026-08-05 Phase D
  buildUserSkillXml,
  buildCampaignProfileXml,
  checkProfileCompliance,
  exactUserPattern,
  actionFieldXml,
  // 2026-08-13 Phase G — config surface
  buildIvrScriptNameXml,
  buildIvrScriptDefXml,
  buildInboundCampaignXml,
  buildCampaignDnisXml,
  buildSetDefaultIvrScheduleXml,
  buildPromptTtsXml,
  assertWellFormedXml,
  checkDnisSteal,
  requiredConfirmToken,
} from '../src/five9/admin-writes.js';

if (!process.argv.includes('--dry')) {
  console.error('Refusing to run without --dry. Usage: node scripts/five9-writes-dryrun.js --dry');
  console.error('(There is no live mode. There is no live start/stop test target. Do not invent one.)');
  process.exit(1);
}

const out = [];
const section = (t) => out.push(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`);
const line = (k, v) => out.push(`${k}: ${v}`);
const verdict = (label, fn) => {
  try {
    const r = fn();
    out.push(`  [PASS] ${label}${r !== undefined && typeof r === 'object' ? ' → ' + JSON.stringify(r) : ''}`);
  } catch (err) {
    out.push(`  [REFUSED] ${label} → ${err.message}`);
  }
};
const eventShape = (subtype, entityType, entityId, extra = {}) => JSON.stringify({
  event_type: 'five9.admin_write',
  event_subtype: subtype,
  source: 'claude',
  entity_type: entityType,
  entity_id: entityId,
  payload: { action_id: '<agent_actions.id>', op: subtype, success: '<bool>', error: '<null|message>', request: '<action_payload>', ...extra },
  previous_state: '<read-before-write>',
  new_state: '<read-back-after-write>',
  bypass_filter: true,
}, null, 2);

section('Master flag');
line('FIVE9_WRITES_ENABLED', process.env.FIVE9_WRITES_ENABLED ?? '(unset)');
line('five9WritesEnabled()', five9WritesEnabled());
out.push('  While false, every handler runs in DRY-RUN: reads + guardrails execute,');
out.push('  the exact SOAP body is logged ([FIVE9 WRITES][DRY-RUN] ...), the audit');
out.push('  event fires with dry_run:true, and the action completes as (dry-run).');
out.push('  The mutating SOAP call is NEVER made until the flag is the literal "true".');

section('five9_start_campaign / five9_stop_campaign / five9_reset_campaign');
line('SOAP method', 'startCampaign | stopCampaign (forceStopCampaign when payload.force===true) | resetCampaign');
line('inner XML', buildCampaignNameXml('REHASH OUTBOUND'));
out.push('Guardrails:');
verdict('OUTBOUND target allowed', () => refuseIfInbound({ name: 'REHASH OUTBOUND', type: 'OUTBOUND' }));
verdict('INBOUND target (Main Number) refused', () => refuseIfInbound({ name: 'Main Number', type: 'INBOUND' }));
verdict('start on RUNNING campaign → skipped no-op', () => {
  const noop = decideLifecycleNoop('start_campaign', 'RUNNING');
  if (noop) throw new Error(`skipped: ${noop}`);
});
verdict('stop on NOT_RUNNING campaign → skipped no-op', () => {
  const noop = decideLifecycleNoop('stop_campaign', 'NOT_RUNNING');
  if (noop) throw new Error(`skipped: ${noop}`);
});
out.push('Audit event:');
out.push(eventShape('start_campaign', 'five9_campaign', 'REHASH OUTBOUND'));

section('five9_set_outbound_campaign (modifyOutboundCampaign — read → merge → modify → read-back)');
const patch = { dialingMode: 'POWER', dialingRatio: 2, maxDroppedCallsPercentage: 3, maxQueueTime: 2 };
line('SOAP method', 'modifyOutboundCampaign');
line('inner XML', buildModifyOutboundCampaignXml('REHASH OUTBOUND', patch));
out.push('Guardrails:');
verdict('compliant patch (2s queue, 3% abandon)', () => checkCompliancePatch(patch));
verdict('maxQueueTime 5s without override refused', () => {
  const c = checkCompliancePatch({ maxQueueTime: 5 });
  if (!c.ok) throw new Error(`compliance — ${c.violations.join('; ')}`);
  return c;
});
verdict('maxQueueTime 5s WITH compliance_override:true', () => checkCompliancePatch({ maxQueueTime: 5 }, { complianceOverride: true }));
verdict('abandon 4% without override refused', () => {
  const c = checkCompliancePatch({ maxDroppedCallsPercentage: 4 });
  if (!c.ok) throw new Error(`compliance — ${c.violations.join('; ')}`);
  return c;
});
verdict('unknown field (typo) refused at build time', () => buildModifyOutboundCampaignXml('X', { maxQueTime: 2 }));
verdict('lifecycle field via patch refused', () => buildModifyOutboundCampaignXml('X', { state: 'RUNNING' }));
verdict('confirm_token restating campaign name accepted', () => checkConfirmToken('set_outbound_campaign', { campaign_name: 'REHASH OUTBOUND', confirm_token: 'REHASH OUTBOUND' }));
verdict('missing confirm_token refused', () => checkConfirmToken('set_outbound_campaign', { campaign_name: 'REHASH OUTBOUND' }));
out.push('Audit event:');
out.push(eventShape('set_outbound_campaign', 'five9_campaign', 'REHASH OUTBOUND', { compliance: '<verdict>', verify_mismatches: '<read-back drift>' }));

section('five9_set_outbound_campaign — CRMRedialTimeout (Phase E)');
line('SOAP method', 'modifyOutboundCampaign');
line('inner XML', buildModifyOutboundCampaignXml('DIAL ASAP', { CRMRedialTimeout: 300 }));
line('note', 'tns:baseOutboundCampaign field — emits as a timer struct, never a bare integer');
out.push('Guardrails:');
verdict('redial floor accepts the intended 300s (5 min)', () => checkCompliancePatch({ CRMRedialTimeout: 300 }));
verdict('redial floor refuses 60s without override',
  () => { const c = checkCompliancePatch({ CRMRedialTimeout: 60 }); if (!c.ok) throw new Error(c.violations.join('; ')); return c; });
verdict('60s WITH compliance_override accepted', () => checkCompliancePatch({ CRMRedialTimeout: 60 }, { complianceOverride: true }));
verdict('order-array membership does not grant patchability (analyzeLevel)',
  () => buildModifyOutboundCampaignXml('DIAL ASAP', { analyzeLevel: '20' }));
out.push('Audit event:');
out.push(eventShape('set_outbound_campaign', 'five9_campaign', 'DIAL ASAP', { compliance: '<verdict>' }));

section('five9_add_records_to_list (addRecordToList, ≤50 records/action)');
line('SOAP method', 'addRecordToList');
line('inner XML', buildAddRecordToListXml('Claude Callbacks', ['number1', 'first_name', 'last_name'], ['5551234567', 'Jane', 'Doe']));
out.push('Audit event:');
out.push(eventShape('add_records_to_list', 'five9_list', 'Claude Callbacks'));

section('five9_delete_record_from_list (deleteRecordFromList)');
line('SOAP method', 'deleteRecordFromList');
line('inner XML', buildDeleteRecordFromListXml('Claude Callbacks', ['number1'], ['5551234567'], 'DELETE_ALL'));
out.push('Guardrails:');
verdict('invalid delete mode refused', () => buildDeleteRecordFromListXml('L', ['number1'], ['5551234567'], 'DELETE_EVERYTHING'));
out.push('Audit event:');
out.push(eventShape('delete_record_from_list', 'five9_list', 'Claude Callbacks'));

section('five9_add_numbers_to_dnc (addNumbersToDnc)');
line('SOAP method', 'addNumbersToDnc');
line('inner XML', buildNumbersXml(['5551234567', '5559876543']));
out.push('Audit event (previous/new state = checkDncForNumbers before/after):');
out.push(eventShape('add_numbers_to_dnc', 'five9_dnc', 'dnc'));

section('five9_remove_numbers_from_dnc (removeNumbersFromDnc — per-number reason REQUIRED)');
line('SOAP method', 'removeNumbersFromDnc');
line('inner XML', buildNumbersXml(['5551234567']));
out.push('Guardrails:');
verdict('removal with reason accepted', () => validateDncRemovals([{ number: '5551234567', reason: 'customer re-consented in writing 2026-07-20' }]));
verdict('removal without reason refused', () => validateDncRemovals([{ number: '5551234567' }]));
verdict('confirm_token restating the numbers accepted', () => checkConfirmToken('remove_numbers_from_dnc', { removals: [{ number: '5551234567', reason: 'r' }], confirm_token: '5551234567' }));
verdict('wrong confirm_token refused', () => checkConfirmToken('remove_numbers_from_dnc', { removals: [{ number: '5551234567', reason: 'r' }], confirm_token: '5550000000' }));
out.push('Audit event (dnc_reasons carried verbatim):');
out.push(eventShape('remove_numbers_from_dnc', 'five9_dnc', 'dnc', { dnc_reasons: '[{ number, reason }, ...]' }));

section('five9_user_skill_add / five9_user_skill_modify / five9_user_skill_remove (userSkillAdd|Modify|Remove)');
line('SOAP methods', 'userSkillAdd / userSkillModify / userSkillRemove — all three take one <userSkill> (WSDL-confirmed)');
line('inner XML', buildUserSkillXml({ userName: 'cdeer', skillName: 'Dispatch', level: 2 }));
line('read-before-write pattern', exactUserPattern('cdeer') + '  (anchored + escaped: "jflanders" cannot match "jflanders2")');
out.push('Guardrails:');
verdict('level within 1-9 accepted', () => buildUserSkillXml({ userName: 'cdeer', skillName: 'Dispatch', level: 9 }));
verdict('level 10 refused', () => buildUserSkillXml({ userName: 'cdeer', skillName: 'Dispatch', level: 10 }));
verdict('omitted level refused (schema-required element)', () => buildUserSkillXml({ userName: 'cdeer', skillName: 'Dispatch' }));
verdict('missing skill_name refused', () => buildUserSkillXml({ userName: 'cdeer', level: 1 }));
out.push('  [NO-OP] adding a skill the user already holds -> { skipped: already_holds_skill }');
out.push('  [NO-OP] removing/modifying a skill the user does not hold -> { skipped: does_not_hold_skill }');
out.push('Audit event (previous/new state = that user\'s full skill set before/after):');
out.push(eventShape('user_skill_add', 'five9_user_skill', 'cdeer:Dispatch', { verified: '<bool: skill held == expected>' }));

section('five9_create_campaign_profile (createCampaignProfile)');
line('SOAP method', 'createCampaignProfile');
line('inner XML', buildCampaignProfileXml('Data-Hot', { numberOfAttempts: 8, ANI: '7275133151', description: 'per-tier profile' }));
out.push('Guardrails:');
verdict('numberOfAttempts within ceiling accepted', () => checkProfileCompliance({ numberOfAttempts: 12 }));
verdict('numberOfAttempts 100 refused (live Data Leads value)', () => { const c = checkProfileCompliance({ numberOfAttempts: 100 }); if (!c.ok) throw new Error(c.violations.join('; ')); return c; });
verdict('nested dialingSchedule refused (not patchable in v1)', () => buildCampaignProfileXml('P', { dialingSchedule: {} }));
verdict('renaming via patch refused', () => buildCampaignProfileXml('P', { name: 'Renamed' }));
out.push('  [NO-OP] profile name already exists -> { skipped: profile_already_exists }');
out.push('Audit event:');
out.push(eventShape('create_campaign_profile', 'five9_campaign_profile', 'Data-Hot', { compliance: '<verdict>' }));

section('five9_modify_campaign_profile (modifyCampaignProfile — confirm_token REQUIRED)');
line('SOAP method', 'modifyCampaignProfile');
line('wrapper', 'SAME <campaignProfile> element as createCampaignProfile (WSDL-verified 2026-08-06)');
line('inner XML', buildCampaignProfileXml('Data Leads', { numberOfAttempts: 8 }));
out.push('Guardrails:');
verdict('attempts ceiling refuses 100 without override',
  () => { const c = checkProfileCompliance({ numberOfAttempts: 100 }); if (!c.ok) throw new Error(c.violations.join('; ')); return c; });
verdict('rollback to 100 WITH compliance_override accepted',
  () => checkProfileCompliance({ numberOfAttempts: 100 }, { complianceOverride: true }));
verdict('confirm_token restating the profile name accepted',
  () => checkConfirmToken('modify_campaign_profile', { profile_name: 'Data Leads', confirm_token: 'Data Leads' }));
verdict('confirm_token mismatch refused',
  () => checkConfirmToken('modify_campaign_profile', { profile_name: 'Data Leads', confirm_token: 'wrong' }));
verdict('nested dialingSchedule refused (not patchable in v1)', () => buildCampaignProfileXml('Data Leads', { dialingSchedule: {} }));
out.push('Audit event (previous_state carries the pre-patch profile, incl. numberOfAttempts):');
out.push(eventShape('modify_campaign_profile', 'five9_campaign_profile', 'Data Leads', { compliance: '<verdict>', verify_mismatches: '<read-back drift>' }));

section('Complex-type serialization (Phase C defect, fixed 2026-08-05)');
out.push('  Phase C whitelisted actionOnQueueExpiration but ran escapeXml() over it, so it');
out.push('  serialized as the literal string "[object Object]". Now:');
line('  actionOnQueueExpiration', actionFieldXml('actionOnQueueExpiration', { actionType: 'DROP_CALL' }));
line('  in a full patch', buildModifyOutboundCampaignXml('REHASH OUTBOUND', { actionOnQueueExpiration: { actionType: 'DROP_CALL' } }));

section('Phase G (2026-08-13) — config surface: the Canvass Confirmation build');
out.push('  These six ops build inbound routing end to end. Shown in the order they');
out.push('  must execute, each verified by read-back before the next is queued.');

out.push('\n① five9_create_prompt_tts — addPromptTTS');
line('inner XML', buildPromptTtsXml({
  name: 'Canvass Confirmation Greeting',
  description: 'Inbound canvass confirmation line greeting',
  text: 'Thanks for calling Reece Windows and Doors.',
}));
out.push('  promptInfo sequence: description, languages[], name, type — then a SIBLING ttsInfo.');

out.push('\n② five9_create_ivr_script — createIVRScript THEN modifyIVRScript (two calls, not atomic)');
line('step 1 inner XML', buildIvrScriptNameXml('Canvass Confirmation Routing'));
line('step 2 inner XML', buildIvrScriptDefXml('Canvass Confirmation Routing', {
  description: 'Canvass confirmation inbound routing',
  xmlDefinition: '<ivrScript><play prompt="Canvass Confirmation Greeting"/></ivrScript>',
}));
out.push('  createIVRScript accepts ONLY <name> — the definition CANNOT ride along (WSDL');
out.push('  verified). If step 2 fails, an empty shell holds the name and blocks every');
out.push('  retry, so the executor compensates with deleteIVRScript and reports whether');
out.push('  that succeeded. deleteIVRScript is NOT queueable as an action.');
verdict('well-formed definition accepted', () => { assertWellFormedXml('<ivrScript><play/></ivrScript>'); return { ok: true }; });
verdict('truncated definition refused', () => assertWellFormedXml('<ivrScript><play na'));
verdict('mismatched close refused', () => assertWellFormedXml('<ivrScript><play></ivrScript>'));

out.push('\n③ five9_create_inbound_campaign — createInboundCampaign');
line('inner XML', buildInboundCampaignXml({
  name: 'Canvass Confirmation - Inbound',
  type: 'INBOUND', mode: 'BASIC', maxNumOfLines: 10, autoRecord: true,
  trainingMode: false, useFtp: false,
  callWrapup: { agentNotReady: true, dispostionName: 'No Disposition', enabled: true, timeout: 180 },
}));
out.push('  16-field flattened sequence: campaign → generalCampaign → inboundCampaign.');
out.push('  dispostionName is misspelled IN FIVE9\'S SCHEMA. Emitting the correct spelling');
out.push('  raises no error and silently sets no wrapup disposition. Do not "fix" it.');
verdict('ftpPassword refused (in the WSDL order array, NOT settable)', () => buildInboundCampaignXml({ name: 'X', ftpPassword: 'p' }));
verdict('state refused (live state is not a create-time field)', () => buildInboundCampaignXml({ name: 'X', state: 'RUNNING' }));

out.push('\n④ five9_set_default_ivr_schedule — setDefaultIVRSchedule');
line('inner XML', buildSetDefaultIvrScheduleXml('Canvass Confirmation - Inbound', 'Canvass Confirmation Routing'));
out.push('  Prior scriptName goes to rollback_payload. The attached script is read at');
out.push('  defaultIvrSchedule.ivrSchedule.scriptName — TWO levels down.');

out.push('\n⑤ five9_add_dnis_to_campaign — addDNISToCampaign');
line('inner XML', buildCampaignDnisXml('Canvass Confirmation - Inbound', ['9045550000']));
out.push('  DNIS-steal guard (P1 — attribution). Assignments are re-read with refresh:true;');
out.push('  a cached map is exactly how a since-reassigned number would slip through.');
const ASSIGNMENTS = { '9045551234': 'Main Number', '9045559999': 'Canvass Confirmation - Inbound' };
verdict('unassigned spare accepted',
  () => { const c = checkDnisSteal(['9045550000'], ASSIGNMENTS, 'Canvass Confirmation - Inbound'); if (!c.ok) throw new Error(c.violations.join('; ')); return c; });
verdict('number already on the TARGET campaign is a no-op re-add, not a steal',
  () => { const c = checkDnisSteal(['9045559999'], ASSIGNMENTS, 'Canvass Confirmation - Inbound'); if (!c.ok) throw new Error(c.violations.join('; ')); return c; });
verdict('number owned by ANOTHER campaign refused',
  () => { const c = checkDnisSteal(['9045551234'], ASSIGNMENTS, 'Canvass Confirmation - Inbound'); if (!c.ok) throw new Error(c.violations.join('; ')); return c; });
verdict('same steal WITH compliance_override accepted',
  () => checkDnisSteal(['9045551234'], ASSIGNMENTS, 'Canvass Confirmation - Inbound', { complianceOverride: true }));

out.push('\n⑥ five9_start_campaign — existing Phase C op, unchanged');
line('inner XML', buildCampaignNameXml('Canvass Confirmation - Inbound'));

out.push('\nfive9_modify_ivr_script / five9_remove_dnis_from_campaign — the two Phase G double-gates');
line('modify_ivr_script token', requiredConfirmToken('modify_ivr_script', { name: 'Canvass Confirmation Routing' }));
line('remove_dnis token', requiredConfirmToken('remove_dnis_from_campaign', { campaign_name: 'Canvass Confirmation - Inbound' }));
verdict('modify_ivr_script confirm_token restating the script name accepted',
  () => checkConfirmToken('modify_ivr_script', { name: 'Canvass Confirmation Routing', confirm_token: 'Canvass Confirmation Routing' }));
verdict('modify_ivr_script confirm_token mismatch refused',
  () => checkConfirmToken('modify_ivr_script', { name: 'Canvass Confirmation Routing', confirm_token: 'wrong' }));
verdict('remove_dnis confirm_token must be the CAMPAIGN, not the numbers',
  () => checkConfirmToken('remove_dnis_from_campaign', { campaign_name: 'Canvass Confirmation - Inbound', confirm_token: '9045550000' }));
out.push('  modify_ivr_script additionally refuses a script live on >1 RUNNING campaign');
out.push('  without compliance_override, and captures the prior xmlDefinition first.');
out.push('Audit event (previous_state carries the pre-write config; rollback_payload rides on the event):');
out.push(eventShape('add_dnis_to_campaign', 'five9_campaign', 'Canvass Confirmation - Inbound', {
  compliance: '<steal verdict>', current_assignments: '<conflict table>', rollback_payload: '<symmetric remove>', verified: '<bool>',
}));

section('Serialization + gate (applies to every op above)');
out.push('  1. FIVE9_WRITES_ENABLED !== "true" → DRY-RUN: reads + guardrails run, envelope logged, audit event dry_run:true, action completed (dry-run). No mutation.');
out.push('  2. outbound_locks key five9_admin:write held → { deferred, retry_at } (one write in flight fleet-wide, held in dry-run too)');
out.push('  3. requires_approval !== true → thrown REFUSED (handler-level belt-and-braces; queue via create_agent_action → approve_action)');
out.push('  4. INBOUND / compliance / missing DNC reason / confirm_token mismatch / bad payload → thrown REFUSED (loud failed status, in dry-run and live alike)');
out.push('  5. start-on-RUNNING / stop-on-NOT_RUNNING → { skipped } no-op after the state read');
out.push('  6. skill add-when-held / remove-when-unheld, profile create-when-exists → { skipped } no-op after the read');

console.log(out.join('\n'));
console.log('\n[DRY RUN COMPLETE] No SOAP call was made. No DB row was touched.');
