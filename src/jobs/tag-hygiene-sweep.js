/**
 * Daily agentic tag hygiene sweep — src/jobs/tag-hygiene-sweep.js
 *
 * 2026-09-22 — WHY. Conflicting and stale tags were being left on contacts
 * because nothing ever cleaned them up:
 *   - 538 ND leads still wore `dq-needs-type`, a tag for a field that no longer
 *     exists;
 *   - cancelled customers kept `deal-won` / `stage:customer-onboarding` next to
 *     their loss tags and could still receive onboarding messages;
 *   - contacts carried two P3 placements or two loss reasons at once.
 * The pure rules live in src/tag-hygiene/rules.js (R1–R6). This job owns the
 * reads, the writes, the log and the one Slack line.
 *
 * FLOW: candidates from the HL cache → LIVE read of each contact from GHL →
 * evaluate on the LIVE tags (the cache only finds candidates; the live read
 * wins) → in `apply` mode, one DELETE per contact through ghlFetch (and so
 * through the shared GHL limiter) → every decision to tag_hygiene_log.
 *
 * SHIPS IN REPORT MODE. TAG_SWEEP_MODE defaults to `report`; Mark flips it to
 * `apply` after reading the first report. TAG_SWEEP_MAX_WRITES (default 500)
 * caps writes per run — past it, remaining fixes are reported as
 * skipped:write_cap, never silently dropped.
 *
 * NOTIFICATION POLICY — silent unless there is something for Mark: one Slack
 * line to #ops-alerts only when something was fixed or needs review. Counts
 * only, never a name or contact id. Slack is the primary destination here (the
 * handoff asked for it), so postToSlack, not the GroupMe mirror.
 *
 * Schedule: daily 03:00 ET, gated on TAG_SWEEP_ENABLED=true (ships off).
 * Manual: POST /admin/tag-hygiene/run?mode=report|apply&limit=N (authenticated).
 */

import { runJob } from '../job-runner.js';
import { hourET, todayET } from './lp-report-common.js';
import { PIPELINE_IDS, GHL_LOCATION_ID } from '../actions/constants.js';
import {
  evaluateTagRules, needsLpVerdict, needsOpenP3, tagsToRemove,
  summarizeDecisions, shouldPostSummary, formatSweepSummary, CUSTOMER_TAGS,
} from '../tag-hygiene/rules.js';

export const JOB_ID = 'tag-hygiene-sweep';
export const DEFAULT_LIMIT = 2000;
export const MAX_LIMIT = 5000;
export const DEFAULT_MAX_WRITES = 500;
const RUN_HOUR_ET = 3;

export function sweepEnabled(env = process.env) {
  return String(env.TAG_SWEEP_ENABLED || '').toLowerCase() === 'true';
}

/** 'apply' only when explicitly asked for; anything else is 'report'. Pure. */
export function resolveMode(raw) {
  return String(raw || '').trim().toLowerCase() === 'apply' ? 'apply' : 'report';
}

function num(value, fallback, { min = 0, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function sqlArray(values, esc) {
  return `ARRAY[${values.map((v) => `'${esc(v)}'`).join(',')}]::text[]`;
}

/**
 * The candidate query against the HL cache. Deterministic-fix candidates sort
 * first so a limit never crowds them out behind report-only R6 rows.
 * Exported for the test.
 */
export function buildCandidateSql(limit, esc = (s) => String(s).replace(/'/g, "''")) {
  const count = (like) => `(SELECT count(*) FROM unnest(c.tags) t WHERE t LIKE '${like}')`;
  const any = (likes) => `EXISTS (SELECT 1 FROM unnest(c.tags) t WHERE ${likes.map((l) => `t LIKE '${l}'`).join(' OR ')})`;
  const fixable = [
    `c.tags && ARRAY['dq-needs-type']::text[]`,
    `(c.tags && ARRAY['loss-needs-reason']::text[] AND ${any(['loss-reason:%'])})`,
    `c.tags @> ARRAY['hard-disqualified','lp-route:deferred-standard']::text[]`,
    `(c.tags && ${sqlArray(CUSTOMER_TAGS, esc)} AND ${any(['p3:%', 'loss-reason:%'])})`,
  ];
  const conflicts = [
    `${count('p3:%')} > 1`,
    `${count('loss-reason:%')} > 1`,
    `${count('stage:%')} > 1`,
    `${count('active-entry:%')} > 1`,
    `${count('buyer:%')} > 1`,
  ];
  return `SELECT c.ghl_contact_id
    FROM contacts c
   WHERE c.deleted_at IS NULL AND c.ghl_contact_id IS NOT NULL
     AND (${[...fixable, ...conflicts].join('\n       OR ')})
   ORDER BY CASE WHEN (${fixable.join(' OR ')}) THEN 0 ELSE 1 END,
            c.date_updated DESC NULLS LAST
   LIMIT ${Number(limit)}`;
}

async function defaultDeps() {
  const [{ hlRunSQL, esc }, { ghlFetch }, log, snapshot, jobValue, p2ctx, slack] = await Promise.all([
    import('../admin/hl-client.js'),
    import('../actions/helpers.js'),
    import('../tag-hygiene/log.js'),
    import('../services/tag-snapshot.js'),
    import('../lp-job-value.js'),
    import('../p2-opportunity-context.js'),
    import('../slack.js'),
  ]);
  return {
    hlRunSQL,
    esc,
    ghlFetch,
    logHygiene: log.logHygiene,
    applyTagsToSnapshot: snapshot.applyTagsToSnapshot,
    lpVerdict: async (contactId) => {
      const { jobs, error } = await jobValue.jobsForContact(contactId);
      if (error) return { error };
      return { verdict: p2ctx.decidingJob(jobs).verdict };
    },
    postSummary: (text) => slack.postToSlack(text, slack.opsChannelId()),
    now: () => new Date(),
  };
}

async function readOpenP3(contactId, ghlFetch) {
  try {
    const res = await ghlFetch('GET',
      `/opportunities/search?location_id=${GHL_LOCATION_ID}&contact_id=${contactId}&pipeline_id=${PIPELINE_IDS.P3}`);
    const opps = Array.isArray(res?.opportunities) ? res.opportunities : null;
    if (!opps) return null;
    return opps.filter((o) => o?.status === 'open').map((o) => ({ id: o.id, pipelineStageId: o.pipelineStageId }));
  } catch {
    return null;
  }
}

const LOG_ACTION = { remove: 'removed_tags', needs_review: 'needs_review', skipped: 'skipped' };

let running = false;

/**
 * One sweep pass. Never throws; failure is `{ ok: false }` so runJob files it
 * as failed (a job that swallows its errors must still be able to fail).
 */
export async function runTagHygieneSweep(opts = {}, injected = null) {
  if (running) return { skipped: true, reason: 'already_running' };
  running = true;
  try {
    const deps = injected || await defaultDeps();
    const env = opts.env || process.env;
    const mode = resolveMode(opts.mode ?? env.TAG_SWEEP_MODE);
    const limit = num(opts.limit, DEFAULT_LIMIT, { min: 1, max: MAX_LIMIT });
    const maxWrites = num(opts.maxWrites ?? env.TAG_SWEEP_MAX_WRITES, DEFAULT_MAX_WRITES, { min: 0 });
    const now = deps.now ? deps.now() : new Date();
    const runId = opts.runId || `sweep:${now.toISOString()}`;

    let candidates;
    try {
      const rows = await deps.hlRunSQL(buildCandidateSql(limit, deps.esc));
      candidates = [...new Set((rows || []).map((r) => r.ghl_contact_id).filter(Boolean))];
    } catch (err) {
      console.error(`[TagHygiene] candidate query failed: ${err.message}`);
      return { ok: false, errors: [`candidate query failed: ${err.message}`], run_id: runId, mode };
    }

    const all = [];
    let writes = 0;
    let writeCapHit = false;
    let unreadable = 0;

    for (const contactId of candidates) {
      let contact = null;
      try {
        contact = (await deps.ghlFetch('GET', `/contacts/${contactId}`))?.contact || null;
      } catch { contact = null; }
      if (!contact) {
        unreadable += 1;
        const d = { rule: 'read', action: 'skipped', tags: [], reason: 'contact_unreadable' };
        all.push(d);
        await deps.logHygiene({ run_id: runId, run_type: 'sweep', mode, contact_id: contactId, rule: d.rule, action: 'skipped', detail: { reason: d.reason } });
        continue;
      }

      const tags = Array.isArray(contact.tags) ? contact.tags : [];
      const lp = needsLpVerdict(tags) ? await deps.lpVerdict(contactId).catch((e) => ({ error: e.message })) : null;
      const openP3Opps = needsOpenP3(tags) ? await readOpenP3(contactId, deps.ghlFetch) : null;
      const decisions = evaluateTagRules({ tags, lp, openP3Opps });
      const remove = tagsToRemove(decisions);

      if (mode === 'apply' && remove.length) {
        let failure = null;
        if (writes >= maxWrites) {
          writeCapHit = true;
          failure = 'write_cap';
        } else {
          try {
            await deps.ghlFetch('DELETE', `/contacts/${contactId}/tags`, { tags: remove });
            writes += 1;
            await deps.applyTagsToSnapshot?.(contactId, { remove });
          } catch (err) {
            failure = 'write_failed';
            console.error(`[TagHygiene] tag removal failed for ${contactId}: ${err.message}`);
          }
        }
        if (failure) {
          for (const d of decisions) {
            if (d.action === 'remove') Object.assign(d, { action: 'skipped', reason: failure });
          }
        }
      }

      all.push(...decisions);
      if (decisions.length) {
        await deps.logHygiene(decisions.map((d) => ({
          run_id: runId, run_type: 'sweep', mode, contact_id: contactId,
          rule: d.rule, action: LOG_ACTION[d.action], tags: d.tags,
          detail: d.reason ? { reason: d.reason } : null,
        })));
      }
    }

    const counts = summarizeDecisions(all);
    let slack = null;
    if (shouldPostSummary(counts)) {
      try { slack = await deps.postSummary(formatSweepSummary(counts, mode)); }
      catch (err) { slack = { ok: false, error: err.message }; }
    }

    const summary = `${mode}: ${counts.fixed} fixed, ${counts.needs_review} need review, ${counts.skipped} skipped `
      + `across ${candidates.length} candidates${writeCapHit ? ` (write cap ${maxWrites} hit)` : ''}`;
    console.log(`[TagHygiene] ${summary}`);
    return {
      ok: true,
      summary,
      run_id: runId,
      mode,
      candidates: candidates.length,
      unreadable,
      fixed: counts.fixed,
      needs_review: counts.needs_review,
      skipped: counts.skipped,
      writes,
      write_cap_hit: writeCapHit,
      by_rule: counts.by_rule,
      remaining_hint: candidates.length >= limit ? 'more_likely' : 'drained',
      slack,
    };
  } finally {
    running = false;
  }
}

export function registerTagHygieneRoutes(app, authenticate) {
  const guards = typeof authenticate === 'function' ? [authenticate] : [];
  app.post('/admin/tag-hygiene/run', ...guards, async (req, res) => {
    const b = req.body || {};
    const rawMode = b.mode ?? req.query.mode;
    if (rawMode !== undefined && !['report', 'apply'].includes(String(rawMode).toLowerCase())) {
      return res.status(400).json({ ok: false, error: 'mode must be report or apply' });
    }
    try {
      const out = await runJob(JOB_ID, () => runTagHygieneSweep({
        mode: rawMode ?? 'report',
        limit: b.limit ?? req.query.limit,
      }));
      res.json({ status: out.status, summary: out.summary, ...(out.value || {}), error: out.error || undefined });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  console.log(`[TagHygiene] Route: POST /admin/tag-hygiene/run?mode=report|apply&limit=N${guards.length ? ' (authenticated)' : ' (UNAUTHENTICATED)'}`);
}

// ── Scheduler — daily at 03:00 ET ───────────────────────────────────────────
// The 5-minute tick convention every daily job here uses; the WORK is wrapped
// in runJob, not the tick (docs/job-runs.md). hourET, not hour12:false, so
// midnight reads 0 (see lp-report-common.js).
let timer = null;
let lastRunSlot = null;

export function startTagHygieneScheduler() {
  if (timer) return;
  if (!sweepEnabled()) {
    console.log('[TagHygiene] disabled (TAG_SWEEP_ENABLED is not true)');
    return;
  }
  console.log(`[TagHygiene] Scheduler started — daily run at 03:00 ET, mode ${resolveMode(process.env.TAG_SWEEP_MODE)}`);
  const checkAndRun = async () => {
    const today = todayET();
    if (hourET() === RUN_HOUR_ET && lastRunSlot !== today) {
      lastRunSlot = today;
      try {
        await runJob(JOB_ID, () => runTagHygieneSweep({ mode: process.env.TAG_SWEEP_MODE }), { occurrence: today });
      } catch (err) {
        console.error('[TagHygiene] run failed:', err.message);
      }
    }
  };
  timer = setInterval(checkAndRun, 5 * 60 * 1000);
  timer.unref?.();
}

export function stopTagHygieneScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
