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

section('Complex-type serialization (Phase C defect, fixed 2026-08-05)');
out.push('  Phase C whitelisted actionOnQueueExpiration but ran escapeXml() over it, so it');
out.push('  serialized as the literal string "[object Object]". Now:');
line('  actionOnQueueExpiration', actionFieldXml('actionOnQueueExpiration', { actionType: 'DROP_CALL' }));
line('  in a full patch', buildModifyOutboundCampaignXml('REHASH OUTBOUND', { actionOnQueueExpiration: { actionType: 'DROP_CALL' } }));

section('Serialization + gate (applies to every op above)');
out.push('  1. FIVE9_WRITES_ENABLED !== "true" → DRY-RUN: reads + guardrails run, envelope logged, audit event dry_run:true, action completed (dry-run). No mutation.');
out.push('  2. outbound_locks key five9_admin:write held → { deferred, retry_at } (one write in flight fleet-wide, held in dry-run too)');
out.push('  3. requires_approval !== true → thrown REFUSED (handler-level belt-and-braces; queue via create_agent_action → approve_action)');
out.push('  4. INBOUND / compliance / missing DNC reason / confirm_token mismatch / bad payload → thrown REFUSED (loud failed status, in dry-run and live alike)');
out.push('  5. start-on-RUNNING / stop-on-NOT_RUNNING → { skipped } no-op after the state read');
out.push('  6. skill add-when-held / remove-when-unheld, profile create-when-exists → { skipped } no-op after the read');

console.log(out.join('\n'));
console.log('\n[DRY RUN COMPLETE] No SOAP call was made. No DB row was touched.');
