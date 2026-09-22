#!/usr/bin/env node
/**
 * One-time loss-routing backfills — scripts/backfill-loss-routing.js
 *
 * 2026-09-22. Two backlogs, both caused by a loss that was closed but never
 * routed:
 *
 *   --mode=nd  538 ND leads closed as "Cannot Qualify" in P1 and left with
 *              `dq-needs-type`. L.1 (the P1 Loss Router) never ran for them.
 *              A webhook cannot re-run L.1 — it needs opportunity context — so
 *              the proven method (piloted by hand on contact qSUErNjs55BJYEmkJSws)
 *              is to RE-MARK the opportunity: open, wait 2s, lost again with the
 *              Cannot Qualify reason. That re-fires L.1 → hard-DQ tags, P3
 *              Stage 4, marketing removal. After ≥60s each contact is re-read
 *              live, and only a contact L.1 actually routed gets its three stale
 *              tags removed.
 *
 *   --mode=p2  ~510 lost P2 opportunities that never reached L.6 (see
 *              src/loss-routing/l6.js). Candidates come from the HL cache, each
 *              opportunity is re-read LIVE before posting, and the post goes
 *              through the same maybePostL6 the executor uses. Piloted by hand
 *              on contact 33Suo36c2Mg52ldJto5o.
 *
 * DRY RUN IS THE DEFAULT. Nothing is written to GHL and nothing is POSTed
 * without --apply. A dry run still logs its decisions to tag_hygiene_log under
 * mode='report', which never counts toward L.6 idempotency.
 *
 * --apply REFUSES TO START without tag_hygiene_log: it is the idempotency
 * record, and re-running a backfill without it would post to L.6 twice.
 *
 * Pace: at most one contact every 2 seconds, on top of the shared GHL limiter
 * inside ghlFetch.
 *
 * Usage:
 *   node scripts/backfill-loss-routing.js --mode=nd --limit=10            # dry run
 *   node scripts/backfill-loss-routing.js --mode=nd --limit=10 --apply
 *   node scripts/backfill-loss-routing.js --mode=p2 --apply --run-id=p2-2026-09-23
 * Writes a JSON report to stdout.
 */

import { pathToFileURL } from 'node:url';

export const CANNOT_QUALIFY_ID = '69cd512e10b2ee8d9ff36a73';
export const PACE_MS = 2000;
export const REMARK_GAP_MS = 2000;
export const VERIFY_AFTER_MS = 60_000;
export const ND_CLEANUP_TAGS = Object.freeze(['dq-needs-type', 'loss-needs-reason', 'lp-route:deferred-standard']);

const P1 = 'x0cxXOkKwqAWVvcPdKZQ';
const P2 = '44mOrpmHqk7YqZN9vSPW';
const P3 = '1jIWe4Ad04oJtYE9UuXq';
const LOCATION = 'SsBG7j5KQAIP1SFP2Sca';

const norm = (t) => (typeof t === 'string' ? t.trim().toLowerCase() : '');
const hasTag = (tags, tag) => (tags || []).some((t) => norm(t) === tag);

export function parseArgs(argv) {
  const str = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const mode = str('mode');
  const limitRaw = str('limit');
  const limit = limitRaw === null ? null : Number(limitRaw);
  return {
    mode,
    apply: argv.includes('--apply') && !argv.includes('--dry-run'),
    limit: Number.isInteger(limit) && limit > 0 ? limit : null,
    runId: str('run-id'),
    errors: [
      ...(['nd', 'p2'].includes(mode) ? [] : ['--mode must be nd or p2']),
      ...(limitRaw !== null && !(Number.isInteger(limit) && limit > 0) ? ['--limit must be a positive integer'] : []),
    ],
  };
}

async function defaultDeps() {
  const [{ hlRunSQL, esc }, { ghlFetch }, log, snapshot, l6] = await Promise.all([
    import('../src/admin/hl-client.js'),
    import('../src/actions/helpers.js'),
    import('../src/tag-hygiene/log.js'),
    import('../src/services/tag-snapshot.js'),
    import('../src/loss-routing/l6.js'),
  ]);
  return {
    hlRunSQL,
    esc,
    ghlFetch,
    logHygiene: log.logHygiene,
    hasPostedL6: log.hasPostedL6,
    tableExists: log.tableExists,
    applyTagsToSnapshot: snapshot.applyTagsToSnapshot,
    maybePostL6: l6.maybePostL6,
    fetch: globalThis.fetch,
    webhookUrl: process.env.L6_WEBHOOK_URL || '',
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

async function liveContact(deps, contactId) {
  try { return (await deps.ghlFetch('GET', `/contacts/${contactId}`))?.contact || null; }
  catch { return null; }
}

async function searchOpps(deps, contactId, pipelineId) {
  const res = await deps.ghlFetch('GET',
    `/opportunities/search?location_id=${LOCATION}&contact_id=${contactId}&pipeline_id=${pipelineId}`);
  return (Array.isArray(res?.opportunities) ? res.opportunities : []).filter((o) => o?.pipelineId === pipelineId || !o?.pipelineId);
}

// ─── --mode=nd ──────────────────────────────────────────────────────────────

async function runNd({ apply, limit, runId }, deps, report) {
  const mode = apply ? 'apply' : 'report';
  const log = (row) => deps.logHygiene({ run_id: runId, run_type: 'backfill_nd', mode, rule: 'ND', ...row });
  const outcome = (contactId, action, reason, extra = {}) => {
    report.items.push({ contact_id: contactId, action, reason, ...extra });
    report.counts[action] = (report.counts[action] || 0) + 1;
  };

  const rows = await deps.hlRunSQL(`SELECT c.ghl_contact_id FROM contacts c
     WHERE c.deleted_at IS NULL AND c.ghl_contact_id IS NOT NULL
       AND c.tags && ARRAY['dq-needs-type']::text[]
     ORDER BY c.date_updated ASC NULLS FIRST
     LIMIT ${Number(limit || 1000)}`);
  const ids = [...new Set((rows || []).map((r) => r.ghl_contact_id).filter(Boolean))];
  report.candidates = ids.length;

  const toVerify = [];
  let lastRemarkAt = null;

  for (let i = 0; i < ids.length; i += 1) {
    const contactId = ids[i];
    if (i > 0) await deps.sleep(PACE_MS);

    const contact = await liveContact(deps, contactId);
    if (!contact) { await log({ contact_id: contactId, action: 'skipped', detail: { reason: 'contact_unreadable' } }); outcome(contactId, 'skipped', 'contact_unreadable'); continue; }
    const tags = contact.tags || [];
    if (!hasTag(tags, 'dq-needs-type')) { await log({ contact_id: contactId, action: 'skipped', detail: { reason: 'no_longer_tagged' } }); outcome(contactId, 'skipped', 'no_longer_tagged'); continue; }

    // Already routed by L.1 at some point — no re-mark (that would re-fire
    // L.1's "re-lost" path). Still eligible for the same tag cleanup below.
    if (hasTag(tags, 'hard-disqualified') || hasTag(tags, 'p3:hard-disqualified')) {
      toVerify.push({ contactId, opportunityId: null, reason: 'already_routed' });
      continue;
    }

    let p1;
    let openP3;
    try {
      p1 = (await searchOpps(deps, contactId, P1))
        .filter((o) => o.status === 'lost' && o.lostReasonId === CANNOT_QUALIFY_ID);
      openP3 = (await searchOpps(deps, contactId, P3)).filter((o) => o.status === 'open');
    } catch (err) {
      await log({ contact_id: contactId, action: 'skipped', detail: { reason: 'opportunity_read_failed', error: err.message } });
      outcome(contactId, 'skipped', 'opportunity_read_failed');
      continue;
    }
    if (openP3.length > 0) { await log({ contact_id: contactId, action: 'skipped', detail: { reason: 'open_p3_exists' } }); outcome(contactId, 'skipped', 'open_p3_exists'); continue; }
    if (p1.length !== 1) {
      await log({ contact_id: contactId, action: 'skipped', detail: { reason: `p1_cannot_qualify_count_${p1.length}` } });
      outcome(contactId, 'skipped', `p1_cannot_qualify_count_${p1.length}`);
      continue;
    }
    const opp = p1[0];

    if (!apply) {
      await log({ contact_id: contactId, opportunity_id: opp.id, action: 'retriggered_l1', detail: { dry_run: true } });
      outcome(contactId, 'retriggered_l1', 'dry_run', { opportunity_id: opp.id });
      continue;
    }

    try {
      await deps.ghlFetch('PUT', `/opportunities/${opp.id}`, { status: 'open', pipelineStageId: opp.pipelineStageId });
    } catch (err) {
      await log({ contact_id: contactId, opportunity_id: opp.id, action: 'skipped', detail: { reason: 'reopen_failed', error: err.message } });
      outcome(contactId, 'skipped', 'reopen_failed', { opportunity_id: opp.id });
      continue;
    }
    await deps.sleep(REMARK_GAP_MS);
    let relost = false;
    let lastErr = null;
    // The opportunity is OPEN right now. Two attempts at closing it again; a
    // failure here leaves a reopened opportunity and is reported loudly.
    for (let attempt = 0; attempt < 2 && !relost; attempt += 1) {
      if (attempt > 0) await deps.sleep(5000);
      try {
        await deps.ghlFetch('PUT', `/opportunities/${opp.id}`,
          { status: 'lost', lostReasonId: CANNOT_QUALIFY_ID, pipelineStageId: opp.pipelineStageId });
        relost = true;
      } catch (err) { lastErr = err; }
    }
    if (!relost) {
      await log({ contact_id: contactId, opportunity_id: opp.id, action: 'needs_review', detail: { reason: 'reopened_not_relost', error: lastErr?.message } });
      outcome(contactId, 'needs_review', 'reopened_not_relost', { opportunity_id: opp.id });
      report.reopened_not_relost.push(opp.id);
      continue;
    }
    lastRemarkAt = deps.now();
    await log({ contact_id: contactId, opportunity_id: opp.id, action: 'retriggered_l1', detail: null });
    outcome(contactId, 'retriggered_l1', 'remarked', { opportunity_id: opp.id });
    toVerify.push({ contactId, opportunityId: opp.id, reason: 'remarked' });
  }

  // Batched verification: give L.1 at least 60s after the LAST re-mark.
  if (apply && lastRemarkAt !== null) {
    const wait = VERIFY_AFTER_MS - (deps.now() - lastRemarkAt);
    if (wait > 0) await deps.sleep(wait);
  }

  for (let i = 0; i < toVerify.length; i += 1) {
    const { contactId, opportunityId, reason } = toVerify[i];
    if (i > 0) await deps.sleep(PACE_MS);
    const contact = await liveContact(deps, contactId);
    const tags = contact?.tags || [];
    const routed = hasTag(tags, 'hard-disqualified') && hasTag(tags, 'loss-reason:cannot-qualify');
    if (!routed) {
      await log({ contact_id: contactId, opportunity_id: opportunityId, action: 'needs_review', detail: { reason: contact ? 'not_routed_after_remark' : 'contact_unreadable', via: reason } });
      outcome(contactId, 'needs_review', contact ? 'not_routed_after_remark' : 'contact_unreadable', { opportunity_id: opportunityId });
      continue;
    }
    const remove = tags.filter((t) => ND_CLEANUP_TAGS.includes(norm(t)));
    if (remove.length === 0) { outcome(contactId, 'skipped', 'already_clean'); continue; }
    if (apply) {
      try {
        await deps.ghlFetch('DELETE', `/contacts/${contactId}/tags`, { tags: remove });
        await deps.applyTagsToSnapshot?.(contactId, { remove });
      } catch (err) {
        await log({ contact_id: contactId, opportunity_id: opportunityId, action: 'skipped', tags: remove, detail: { reason: 'tag_removal_failed', error: err.message } });
        outcome(contactId, 'skipped', 'tag_removal_failed');
        continue;
      }
    }
    await log({ contact_id: contactId, opportunity_id: opportunityId, action: 'removed_tags', tags: remove, detail: { via: reason } });
    outcome(contactId, 'removed_tags', reason, { tags: remove });
  }
}

// ─── --mode=p2 ──────────────────────────────────────────────────────────────

async function runP2({ apply, limit, runId }, deps, report) {
  const rows = await deps.hlRunSQL(`SELECT o.ghl_opportunity_id, o.ghl_contact_id FROM opportunities o
     WHERE o.ghl_pipeline_id = '${P2}' AND o.status = 'lost'
       AND o.deleted_at IS NULL AND o.ghl_contact_id IS NOT NULL
     ORDER BY o.date_updated ASC NULLS FIRST
     LIMIT ${Number(limit || 1000)}`);
  const list = (rows || []).filter((r) => r.ghl_opportunity_id);
  report.candidates = list.length;
  const outcome = (item, res) => {
    report.items.push({ opportunity_id: item.ghl_opportunity_id, contact_id: item.ghl_contact_id, action: res.action, reason: res.reason || null, lostType: res.lostType || null });
    report.counts[res.action] = (report.counts[res.action] || 0) + 1;
  };

  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (i > 0) await deps.sleep(PACE_MS);
    let opp = null;
    try { opp = (await deps.ghlFetch('GET', `/opportunities/${item.ghl_opportunity_id}`))?.opportunity || null; }
    catch { opp = null; }
    if (!opp) { outcome(item, { action: 'skipped', reason: 'opportunity_unreadable' }); continue; }
    if (opp.status !== 'lost') { outcome(item, { action: 'skipped', reason: `live_status_${opp.status}` }); continue; }
    const res = await deps.maybePostL6({
      contactId: opp.contactId || item.ghl_contact_id,
      opportunityId: opp.id || item.ghl_opportunity_id,
      lostReasonId: opp.lostReasonId || null,
      runType: 'backfill_p2',
      runId,
      apply,
    }, deps);
    outcome(item, res);
  }
}

// ─── Entry ──────────────────────────────────────────────────────────────────

export async function runBackfill(opts, injected = null) {
  const deps = injected || await defaultDeps();
  const runId = opts.runId || `backfill_${opts.mode}:${new Date(deps.now ? deps.now() : Date.now()).toISOString()}`;
  const report = {
    mode: opts.mode, apply: Boolean(opts.apply), run_id: runId, limit: opts.limit || null,
    candidates: 0, counts: {}, items: [], reopened_not_relost: [],
  };

  if (opts.apply) {
    const exists = await deps.tableExists();
    if (exists !== true) {
      report.error = exists === false
        ? 'tag_hygiene_log is missing — apply sql/migrations/2026-09-22_tag_hygiene_log.sql before --apply'
        : 'could not confirm tag_hygiene_log exists — refusing --apply';
      return report;
    }
  }

  if (opts.mode === 'nd') await runNd({ ...opts, runId }, deps, report);
  else if (opts.mode === 'p2') await runP2({ ...opts, runId }, deps, report);
  else report.error = '--mode must be nd or p2';
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.errors.length) {
    console.error(args.errors.join('\n'));
    process.exit(2);
  }
  const report = await runBackfill(args);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.error || report.reopened_not_relost.length) process.exit(1);
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
