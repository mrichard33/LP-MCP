/**
 * Nurture Prompt Selector — src/nurture/nurture-prompt-selector.js
 *
 * Picks the best matching prompt for a given context + request.
 *
 * Two-stage selection:
 *   1. HARD FILTER — excludes ineligible prompts entirely. Repeated
 *      story arcs are filtered HERE, not penalized in score; a
 *      high-scoring repeated arc cannot win.
 *   2. SCORE RANK — ranks the remaining eligibles by match specificity,
 *      then version, then weighted-random tie-break for A/B variants.
 *
 * Returns null when nothing matches; caller falls back to the
 * always-active GENERIC fallback prompt (seeded in MSG-009).
 */

import supabase from '../supabase.js';

/**
 * Select the best prompt for a given (workflow, channel, context).
 *
 * @param {object} context  — full envelope from buildLeadContext
 * @param {object} request  — { workflow_code, sequence_position, channel }
 * @returns {Promise<object|null>} — prompt row, or null
 */
export async function selectPrompt(context, request) {
  const recentArcs = (context?.nurture?.stories_already_deployed || []).slice(-4);
  const buyerStage = context?.intelligence?.buyer_stage
    || inferBuyerStageFromContext(context);
  const dominantObjection = pickDominantObjection(context);

  const { data, error } = await supabase
    .from('agentic_messaging_prompts')
    .select('*')
    .eq('active', true)
    .eq('workflow_code', request.workflow_code)
    .eq('channel', request.channel);

  if (error) {
    console.error(`[PromptSelector] query error: ${error.message}`);
    return null;
  }
  if (!data || data.length === 0) return null;

  // Apply remaining hard filters in JS — the JS client's array operators
  // are awkward for our use case and we have a small candidate set.
  const eligible = data.filter(p => {
    // sequence_position match (NULL = any)
    if (p.sequence_position !== null && p.sequence_position !== request.sequence_position) {
      return false;
    }
    // buyer_stage_target match (NULL = any)
    if (p.buyer_stage_target !== null && p.buyer_stage_target !== buyerStage) {
      return false;
    }
    // story arc HARD exclusion
    if (p.story_arc && recentArcs.includes(p.story_arc)) {
      return false;
    }
    // objection filter — if the prompt declares filters, it must allow
    // the contact's dominant objection (or 'none' when there isn't one).
    if (Array.isArray(p.objection_filter) && p.objection_filter.length > 0) {
      const allowsNone = p.objection_filter.includes('none');
      if (dominantObjection === null) {
        if (!allowsNone) return false;
      } else {
        if (!p.objection_filter.includes(dominantObjection)) return false;
      }
    }
    return true;
  });

  if (eligible.length === 0) return null;

  const scored = eligible.map(p => ({
    prompt: p,
    score:
      (p.sequence_position === request.sequence_position ? 10 : 0) +
      (p.buyer_stage_target === buyerStage ? 8 : 0) +
      ((Array.isArray(p.objection_filter) && p.objection_filter.includes(dominantObjection || 'none')) ? 6 : 0),
  }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if ((b.prompt.version || 1) !== (a.prompt.version || 1)) {
      return (b.prompt.version || 1) - (a.prompt.version || 1);
    }
    return Math.random() < 0.5 ? -1 : 1;
  });

  return scored[0].prompt;
}

/**
 * Pick the strongest objection signal from the context. Returns the
 * objection name (e.g. 'price', 'spouse') or null when no tags.
 */
function pickDominantObjection(context) {
  const tags = context?.lead?.objection_tags || [];
  if (tags.length === 0) return null;

  const priority = ['price', 'spouse', 'timing', 'trust', 'competitor', 'diy'];
  for (const p of priority) {
    if (tags.includes(p)) return p;
  }
  return tags[0];
}

/**
 * Fallback buyer-stage derivation when intelligence.buyer_stage is null.
 * Mirrors response-generator.js inferBuyerStage at a high level — see
 * that module for the canonical version.
 */
function inferBuyerStageFromContext(context) {
  const stageTag = context?.lead?.current_stage_tag || '';
  const m = stageTag.match(/stage:(\d+)/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 5) return n;
  }
  if (context?.lp?.closed_won) return 5;
  if (context?.lp?.demo_completed) return 4;
  if (context?.lp?.appointment_set) return 3;
  return 2;
}
