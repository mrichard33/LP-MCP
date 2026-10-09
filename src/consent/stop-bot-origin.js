/**
 * stop-bot-origin — src/consent/stop-bot-origin.js
 *
 * 2026-10-08 (the user, after "stop-bot is not a DNC", 2026-10-07). Rule 14
 * (LP_DISP_DNC) still adds stop-bot when LP marks a lead DNC, and it has to:
 * stop-bot is the only thing behind the mutation gate, the analyzer skip and
 * the ownership stamp, so without it a later set_stage wipes stage:dnc and the
 * bot can text an LP-DNC lead. Every DNC lift then removes stop-bot (rules
 * DNC_LIFT_ON_REENGAGEMENT_LP/_FIVE9, the re-entry lifts, SLACK_DNC_LIFT's
 * LIFT_TAGS). That also removed a stop-bot that a person, the hard-DQ stop,
 * an LP-note DQ, the Bot Review button or rule 356 put there, and turned the
 * bot back on for a lead someone had decided it must not talk to.
 *
 * The rule now: a DNC lift removes ONLY a stop-bot a DNC put there.
 *   - A `bot-off:<reason>` tag marks a stop that is not a DNC (`bot-off:dq`,
 *     `bot-off:lp-note`, `bot-off:review`, `bot-off:rescission`). Any one of
 *     them keeps stop-bot through a lift.
 *   - Without one, the lift may remove stop-bot only when our own records show
 *     the NEWEST stop-bot add came from a DNC rule (LP_DISP_DNC, the opt-out
 *     family). A stop-bot a person added in GHL leaves no record here, so it
 *     stays too.
 *   - A read that fails keeps it (fail closed toward the bot staying off).
 * Pure; the I/O lives in readStopBotAdds (deps seam).
 */

export const STOP_BOT = 'stop-bot';
export const BOT_OFF_PREFIX = 'bot-off:';

/** Rules whose stop-bot means "a DNC or an opt-out", which a DNC lift may undo. */
export const DNC_STOP_BOT_RULES = Object.freeze(new Set([
  'LP_DISP_DNC',
  'AGENTIC_REPLY_SLA_OPTOUT',
  'BEHAVIORAL_DNC_REPLY',
  'VOICE_DNC_REQUEST',
]));

/** The reason tag for a non-DNC stop, e.g. botOffTag('dq') → 'bot-off:dq'. */
export function botOffTag(reason) {
  return `${BOT_OFF_PREFIX}${String(reason || 'manual').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`;
}

export function hasBotOffTag(tags) {
  return (Array.isArray(tags) ? tags : []).some(t => String(t || '').trim().toLowerCase().startsWith(BOT_OFF_PREFIX));
}

/**
 * Is this remove_tag action a DNC lift? Lifts carry bypass_suppression (they
 * must remove the suppression stack from a stop-bot contact) or run under a
 * lift rule.
 */
export function isDncLiftRemoval(action) {
  if (action?.action_payload?.bypass_suppression === true) return true;
  return /DNC_LIFT|CONSENT_RENEWAL/i.test(String(action?.rule_applied || ''));
}

/**
 * May a DNC lift remove stop-bot from this contact? Pure.
 * @param {{tags: string[], adds: Array<{rule: string, at: string}>|null}} input
 *   tags  the contact's current tags
 *   adds  our records of stop-bot being added, any order; null = could not read
 * @returns {{removable: boolean, reason: string}}
 */
export function stopBotRemovableByLift({ tags = [], adds = null } = {}) {
  if (hasBotOffTag(tags)) return { removable: false, reason: 'bot_off_reason_tag' };
  if (adds === null) return { removable: false, reason: 'origin_unreadable' };
  if (!adds.length) return { removable: false, reason: 'no_dnc_origin_on_record' };
  const newest = [...adds].sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0))[0];
  if (!DNC_STOP_BOT_RULES.has(String(newest.rule || ''))) return { removable: false, reason: `newest_add_not_dnc:${newest.rule || 'unknown'}` };
  return { removable: true, reason: 'dnc_origin' };
}

/**
 * Our records of stop-bot being added to a contact: completed add_tag rows and
 * completed dq_hard_stop rows that added it. Returns null when it cannot read.
 */
export async function readStopBotAdds(contactId, { supabase } = {}) {
  if (!supabase || !contactId) return null;
  try {
    const { data, error } = await supabase
      .from('agent_actions')
      .select('action_type, rule_applied, action_payload, execution_result, executed_at, created_at')
      .eq('target_id', String(contactId))
      .eq('status', 'completed')
      .in('action_type', ['add_tag', 'dq_hard_stop'])
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) return null;
    const adds = [];
    for (const r of data || []) {
      const p = r.action_payload || {};
      const tagsAdded = r.action_type === 'dq_hard_stop'
        ? (r.execution_result?.added_tags || [])
        : [p.tag, ...(Array.isArray(p.tags) ? p.tags : [])];
      if (tagsAdded.some(t => String(t || '').trim().toLowerCase() === STOP_BOT)) {
        adds.push({ rule: r.action_type === 'dq_hard_stop' ? 'DQ_HARD_STOP' : (r.rule_applied || ''), at: r.executed_at || r.created_at });
      }
    }
    return adds;
  } catch {
    return null;
  }
}

/**
 * The tags a remove_tag action may really remove. A DNC lift that would
 * remove stop-bot drops it from the list unless the DNC made it. Pure.
 * @returns {{tags: string[], kept: boolean, reason: string|null}}
 */
export function filterLiftRemoval(action, tagsToRemove, { currentTags = [], adds = null } = {}) {
  const tags = Array.isArray(tagsToRemove) ? tagsToRemove : [];
  if (!isDncLiftRemoval(action) || !tags.some(t => String(t).trim().toLowerCase() === STOP_BOT)) {
    return { tags, kept: false, reason: null };
  }
  const verdict = stopBotRemovableByLift({ tags: currentTags, adds });
  if (verdict.removable) return { tags, kept: false, reason: verdict.reason };
  return { tags: tags.filter(t => String(t).trim().toLowerCase() !== STOP_BOT), kept: true, reason: verdict.reason };
}
