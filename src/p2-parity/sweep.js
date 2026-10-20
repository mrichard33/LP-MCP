/**
 * P2 parity sweep — src/p2-parity/sweep.js
 *
 * Every pass: compare EVERY P2 (Client Lifecycle) card with LP and, in live mode, put
 * it where LP says the customer is. The decisions are pure (./rules.js); this file
 * reads, re-checks and writes. Why it exists: see rules.js (the user, 2026-10-20,
 * "zero deviation from the source").
 *
 * READS: the cards from the HL mirror (one query), the contacts' LP jobs and
 *   milestones in bulk (lp_jobs by contact and by lead, lp_job_milestones), and the
 *   live P2_MILESTONE_* rules for the stage map. A bulk read that fails ends the
 *   pass as { ok: false }: "could not tell" never writes and never reports zero.
 * RE-CHECK: every card the mirror says is wrong is re-read LIVE from GHL and
 *   decided again from the live card before anything is written (the mirror lags).
 *   A card changed in the last SETTLE_MS is left for the next pass: an event-driven
 *   move may still be landing.
 * WRITES (P2_PARITY_MODE=live only), at most P2_PARITY_MAX_WRITES a pass, status
 *   fixes first: one PUT per card with the fields that differ. With P2_HEAL_TAG=on, a
 *   heal that moves an OPEN card into stages 4-8 adds the tag `p2-stage-heal` first,
 *   which GHL C.1 / C.2 / C.4 consume and exit on, so a repair never texts a customer
 *   (docs/ghl-p2-customer-workflow-fixes.md). A loss carries its lost reason, goes on
 *   to L.6 like every other P2 loss (maybePostL6, idempotent through tag_hygiene_log)
 *   and takes the customer out of C.0–C.5 (./customer-workflows.js).
 * RECORD: one `p2.parity` event per change (shadow: `would_change`, once per card per
 *   target per day), and the pass's counts in job_runs.detail.
 */
import { expectedP2, parityAction, writePriority, needsHealTag } from './rules.js';
import { buildMilestoneStageMap } from '../p2-milestone-map.js';
import { readOppJobId } from '../p2-opportunity-context.js';
import { PIPELINE_IDS } from '../actions/constants.js';
import { removeFromCustomerWorkflows } from './customer-workflows.js';

export const HEAL_TAG = 'p2-stage-heal';
export const SETTLE_MS = 30 * 60 * 1000;
const CHUNK = 150;
// Shadow re-plans the same differences every pass and the order is fixed (status
// first), so without this the first P2_PARITY_MAX_WRITES cards would be re-read live
// every 30 minutes and the rest never. A card confirmed in shadow waits RECHECK_MS.
export const RECHECK_MS = 6 * 60 * 60 * 1000;
const CHECKED = new Map();
const MODES = new Set(['off', 'shadow', 'live']);

/**
 * P2_PARITY_MODE off | shadow | live (default). Read per pass. Live by the user's ruling
 * (2026-10-20: "go live right away because no messages are firing"; it replaced the
 * same day's "3 days of shadow first"). An unknown value reads as shadow, never live.
 */
export function parityMode(env = process.env) {
  const m = String(env.P2_PARITY_MODE || 'live').toLowerCase().trim();
  return MODES.has(m) ? m : 'shadow';
}

/**
 * P2_HEAL_TAG on | off (default off). The repair tag `p2-stage-heal` is useful only once
 * GHL C.1/C.2/C.4 have the first step that consumes it
 * (docs/ghl-p2-customer-workflow-fixes.md). Added before that step exists, it would sit
 * on the contact and swallow that customer's next REAL update later. While the C-series
 * stay test-gated a repair texts nobody anyway, so the tag waits for this switch.
 */
export function healTagEnabled(env = process.env) {
  return String(env.P2_HEAL_TAG || 'off').toLowerCase().trim() === 'on';
}
export function maxWrites(env = process.env) {
  const n = Number(env.P2_PARITY_MAX_WRITES);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 50;
}

async function defaultDeps() {
  const [{ default: supabase }, { hlRunSQL }, { ghlFetch }, { applyGHLTag }, { emitEvent }, l6] = await Promise.all([
    import('../supabase.js'),
    import('../admin/hl-client.js'),
    import('../actions/helpers.js'),
    import('../ghl.js'),
    import('../event-emitter.js'),
    import('../loss-routing/l6.js'),
  ]);
  return { supabase, hlRunSQL, ghlFetch, applyGHLTag, emitEvent, postL6: l6.maybePostL6 };
}

const must = ({ data, error }, what) => {
  if (error) throw new Error(`${what}: ${error.message || error}`);
  return data || [];
};

/** The P2 cards, mapped to GHL's field names. */
export async function readCards({ hlRunSQL }, p2PipelineId = PIPELINE_IDS.P2) {
  const rows = await hlRunSQL(`
    SELECT ghl_opportunity_id, ghl_contact_id, status, ghl_stage_id, monetary_value, custom_fields
      FROM opportunities
     WHERE ghl_pipeline_id = '${p2PipelineId}' AND deleted_at IS NULL AND ghl_contact_id IS NOT NULL`);
  if (!Array.isArray(rows)) throw new Error('HL mirror read returned no rows array');
  return rows.map((r) => ({
    id: r.ghl_opportunity_id,
    contactId: r.ghl_contact_id,
    status: r.status,
    pipelineStageId: r.ghl_stage_id,
    monetaryValue: r.monetary_value,
    customFields: Array.isArray(r.custom_fields) ? r.custom_fields : [],
  }));
}

/** contact id → that contact's LP jobs, each with milestones from BOTH sources. */
export async function readJobsByContact({ supabase }, contactIds) {
  const cols = 'lp_job_id, lp_lead_id, ghl_contact_id, job_status, job_value, job_stage, install_completed_date, '
    + 'contractdate:raw_lp_data->>contractdate, payments:raw_lp_data->payments, milestones:raw_lp_data->milestones';
  const byContact = new Map();
  const add = (cid, j) => {
    if (!cid) return;
    if (!byContact.has(cid)) byContact.set(cid, new Map());
    byContact.get(cid).set(String(j.lp_job_id), j);
  };
  const leadContact = new Map();
  for (let i = 0; i < contactIds.length; i += CHUNK) {
    const chunk = contactIds.slice(i, i + CHUNK);
    for (const j of must(await supabase.from('lp_jobs').select(cols).in('ghl_contact_id', chunk), 'lp_jobs by contact')) add(j.ghl_contact_id, j);
    for (const l of must(await supabase.from('lp_leads').select('lp_lead_id, ghl_contact_id').in('ghl_contact_id', chunk), 'lp_leads by contact')) {
      leadContact.set(String(l.lp_lead_id), l.ghl_contact_id);
    }
  }
  const leadIds = [...leadContact.keys()];
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    for (const j of must(await supabase.from('lp_jobs').select(cols).in('lp_lead_id', leadIds.slice(i, i + CHUNK)), 'lp_jobs by lead')) {
      add(leadContact.get(String(j.lp_lead_id)), j);
    }
  }
  const jobIds = [...new Set([...byContact.values()].flatMap((m) => [...m.keys()]))];
  const tableMs = new Map();
  for (let i = 0; i < jobIds.length; i += CHUNK) {
    const rows = must(await supabase.from('lp_job_milestones').select('lp_job_id, mdt_id, act_date')
      .in('lp_job_id', jobIds.slice(i, i + CHUNK)).not('act_date', 'is', null), 'lp_job_milestones');
    for (const m of rows) {
      const k = String(m.lp_job_id);
      if (!tableMs.has(k)) tableMs.set(k, []);
      tableMs.get(k).push({ mdt_id: m.mdt_id, act_date: m.act_date });
    }
  }
  const out = new Map();
  for (const [cid, jobs] of byContact) {
    out.set(cid, [...jobs.values()].map((j) => ({
      ...j,
      milestones: [...(Array.isArray(j.milestones) ? j.milestones : []), ...(tableMs.get(String(j.lp_job_id)) || [])],
    })));
  }
  return out;
}

export async function readStageMapping({ supabase }) {
  const rules = must(await supabase.from('agent_rules').select('rule_key, event_pattern, action_template')
    .like('rule_key', 'P2_MILESTONE%').eq('enabled', true), 'agent_rules');
  const { mapping, problems } = buildMilestoneStageMap(rules);
  if (!Object.keys(mapping).length) throw new Error('no P2_MILESTONE_* rule maps a milestone to a stage');
  // A tag-only rule (H, rule 114) is expected; anything else would mis-stage cards.
  const hard = problems.filter((p) => p.reason !== 'no_p2_move_action');
  if (hard.length) throw new Error(`P2 milestone rules disagree: ${hard.map((p) => `${p.ruleKey}:${p.reason}`).join(', ')}`);
  return mapping;
}

/** Pure. Plan a pass from the mirror. */
export function planPass({ cards, jobsByContact, mapping, now }) {
  const plans = [];
  for (const card of cards) {
    const expected = expectedP2({ jobs: jobsByContact.get(card.contactId) || [], stampedJobId: readOppJobId(card), mapping, now });
    const act = parityAction({ card, expected });
    if (act.action === 'none') continue;
    plans.push({ card, expected, ...act });
  }
  plans.sort((a, b) => writePriority(a.kinds) - writePriority(b.kinds));
  return plans;
}

function eventFor(mode, plan, subtype, extra = {}) {
  const day = new Date().toISOString().slice(0, 10);
  const target = `${plan.body?.status || ''}|${plan.body?.pipelineStageId || ''}`;
  return {
    event_type: 'p2.parity',
    event_subtype: subtype,
    source: 'p2_parity_sweep',
    entity_type: 'contact',
    entity_id: String(plan.card.contactId),
    ghl_contact_id: String(plan.card.contactId),
    priority: 'low',
    bypass_filter: true,
    payload: {
      mode,
      opportunity_id: plan.card.id,
      kinds: plan.kinds,
      reason: plan.reason || null,
      from_status: plan.card.status || null,
      from_stage_id: plan.card.pipelineStageId || null,
      to_status: plan.body?.status || null,
      to_stage_id: plan.body?.pipelineStageId || null,
      job_id: plan.expected?.job?.lp_job_id ?? null,
      job_status: plan.expected?.job?.job_status ?? null,
      ...extra,
    },
    // Shadow re-plans the same card every pass: once per card per target per day.
    idempotency_key: subtype === 'done' || subtype === 'failed'
      ? `p2_parity:${subtype}:${plan.card.id}:${Date.now()}`
      : `p2_parity:${subtype}:${plan.card.id}:${target}:${day}`,
  };
}

/**
 * One pass. Never throws: a failure is { ok: false } so runJob classifies it.
 * opts: { mode, deps, now, maxWrites, logger }
 */
export async function runP2ParitySweep(opts = {}) {
  const logger = opts.logger || console;
  const mode = opts.mode || parityMode();
  if (mode === 'off') return { ok: true, skipped: 'P2_PARITY_MODE=off' };
  const deps = { ...(opts.deps?.__noDefaults ? {} : await defaultDeps()), ...(opts.deps || {}) };
  const now = opts.now || new Date();
  const cap = opts.maxWrites ?? maxWrites();
  const healTag = opts.healTag ?? healTagEnabled();
  const runId = `p2_parity:${now.toISOString()}`;
  const emit = (ev) => Promise.resolve(deps.emitEvent?.(ev)).catch((err) => logger.warn?.(`[P2Parity] event failed: ${err.message}`));

  let cards; let jobsByContact; let mapping;
  try {
    mapping = await readStageMapping(deps);
    cards = await readCards(deps);
    jobsByContact = await readJobsByContact(deps, [...new Set(cards.map((c) => c.contactId))]);
  } catch (err) {
    logger.error?.(`[P2Parity] could not read: ${err.message}`);
    return { ok: false, error: err.message };
  }

  const plans = planPass({ cards, jobsByContact, mapping, now });
  const planned = {};
  for (const p of plans) for (const k of (p.kinds.length ? p.kinds : [p.reason || p.action])) planned[k] = (planned[k] || 0) + 1;

  const memo = deps.checkedMemo || CHECKED;
  for (const [k, t] of memo) if (now.getTime() - t >= RECHECK_MS) memo.delete(k);
  const outcome = { recent: 0, verified: 0, settling: 0, gone: 0, unreadable: 0, already_fine: 0, written: 0, failed: 0, deferred: 0, report: 0 };
  const byAction = {};
  const sample = [];
  for (const plan of plans) {
    if (plan.action === 'report') { outcome.report++; continue; }
    const checked = memo.get(plan.card.id);
    if (mode !== 'live' && checked && now.getTime() - checked < RECHECK_MS) { outcome.recent++; continue; }
    if (outcome.verified >= cap) { outcome.deferred++; continue; }

    let live;
    try {
      live = (await deps.ghlFetch('GET', `/opportunities/${plan.card.id}`))?.opportunity || null;
    } catch (err) {
      outcome.unreadable++;
      continue;
    }
    if (!live || live.pipelineId !== PIPELINE_IDS.P2) { outcome.gone++; continue; }
    const changedAt = Date.parse(live.updatedAt || live.lastStageChangeAt || '');
    if (Number.isFinite(changedAt) && now.getTime() - changedAt < SETTLE_MS) { outcome.settling++; continue; }

    const card = { ...plan.card, status: live.status, pipelineStageId: live.pipelineStageId, monetaryValue: live.monetaryValue, customFields: live.customFields || [] };
    const act = parityAction({ card, expected: plan.expected });
    if (act.action !== 'update') { outcome.already_fine++; continue; }
    outcome.verified++;
    memo.set(plan.card.id, now.getTime());
    const fresh = { ...plan, card, ...act };
    for (const k of fresh.kinds) byAction[k] = (byAction[k] || 0) + 1;
    if (sample.length < 25) sample.push({ opportunity_id: card.id, contact_id: card.contactId, job: plan.expected.job?.lp_job_id, kinds: fresh.kinds });

    if (mode !== 'live') {
      await emit(eventFor(mode, fresh, 'would_change'));
      continue;
    }
    try {
      if (healTag && needsHealTag(card, fresh.body)) await deps.applyGHLTag(card.contactId, HEAL_TAG);
      await deps.ghlFetch('PUT', `/opportunities/${card.id}`, fresh.body);
      let l6 = null; let cSeries = null;
      if (fresh.kinds.includes('lose')) {
        if (deps.postL6) {
          l6 = await deps.postL6({ contactId: card.contactId, opportunityId: card.id, lostReasonId: fresh.lostReasonId, runType: 'l6_auto', runId })
            .catch((err) => ({ action: 'failed', reason: err.message }));
        }
        cSeries = await removeFromCustomerWorkflows(card.contactId, { ghlFetch: deps.ghlFetch, logger });
      }
      outcome.written++;
      await emit(eventFor(mode, fresh, 'done', { l6: l6?.action || null, c_series_removed: cSeries?.removed?.length ?? null }));
    } catch (err) {
      outcome.failed++;
      logger.warn?.(`[P2Parity] write failed for ${card.id}: ${err.message}`);
      await emit(eventFor(mode, fresh, 'failed', { error: String(err.message).slice(0, 300) }));
    }
  }

  const summary = `${cards.length} P2 card(s), ${plans.length} differ from LP by the mirror; `
    + `${outcome.verified} confirmed live (${Object.entries(byAction).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'})`
    + (mode === 'live' ? `, ${outcome.written} fixed, ${outcome.failed} failed` : ` (${mode}, nothing written)`)
    + `, ${outcome.report} for a person, ${outcome.deferred} next pass, ${outcome.recent} checked recently`;
  logger.log?.(`[P2Parity] ${summary}`);
  return {
    ok: outcome.failed === 0,
    mode, cards: cards.length, differ: plans.length, planned, by_action: byAction, ...outcome, sample, summary,
  };
}
