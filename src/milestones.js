import supabase from './supabase.js';
import { applyGHLTag } from './ghl.js';
import { emitEvent } from './event-emitter.js';
import { classifyMilestoneDate, MIN_PLAUSIBLE_ACT_DATE } from './milestone-gate.js';
import { selectAllIn } from './supabase-page.js';
import { staleFireMode, staleFireVerdict } from './milestone-stale-gate.js';

// Rows per candidate page. PostgREST caps a response at 1,000 on this project
// and says nothing when it truncates, so this is the cap made explicit rather
// than a limit being imposed — see src/supabase-page.js.
const CANDIDATE_PAGE_ROWS = 1000;

// The lowest possible uuid, as the opening keyset cursor. lp_job_milestones.id
// is a uuid, so this is `>= every row` rather than an integer 0.
const UUID_MIN = '00000000-0000-0000-0000-000000000000';

/**
 * Ceiling on GHL tags this sweep will apply in one pass.
 *
 * NOT a performance knob — a blast-radius one. When the clog described above
 * was fixed there were 12,618 achieved-but-unfired milestones waiting, each of
 * which applies a customer-visible tag and emits an event that can move a P2
 * opportunity. Draining that in a single pass would fire twelve thousand tags
 * at real homeowners inside one sync. At 100 per pass and a 15-minute sync the
 * backlog clears in about a day and a half, and a mistake costs 100 records
 * rather than all of them.
 *
 * Rows skipped for want of a contact do NOT consume budget — only real fires
 * do — so a queue that is mostly unfireable still makes full progress.
 *
 * Set MILESTONE_SWEEP_MAX_FIRES=0 for SCAN-ONLY: the sweep still walks the
 * whole queue and reports exactly what it would have fired, but applies no tag
 * and emits no event. That is the safe way to confirm the walk on live data
 * before letting it write — the same dry-run-first posture the repair scripts
 * in scripts/ take.
 */
const MAX_FIRES_PER_PASS = Number(process.env.MILESTONE_SWEEP_MAX_FIRES ?? 100);

// mdt_id → GHL tag lookup (16 milestones for the C.x Customer Journey)
export const MDT_TAG_MAP = {
  R: 'lp-milestone-rtp',
  M: 'lp-milestone-measure',
  O: 'lp-milestone-quoted',
  H: 'lp-milestone-hoa-approved',
  K: 'lp-milestone-ordered',
  U: 'lp-milestone-permit-submit',
  P: 'lp-milestone-permit-issued',
  V: 'lp-milestone-recv-windows',
  E: 'lp-milestone-recv-doors',
  G: 'lp-milestone-recv-all',
  S: 'lp-milestone-install-start',
  F: 'lp-milestone-install-end',
  C: 'lp-milestone-completion',
  I: 'lp-milestone-insp-set',
  B: 'lp-milestone-insp-passed',
  // KNOWN DEFECT (2026-08-06): LP uses mdt_id 'X' for TWO datetypes —
  // 'Inspection Ready' (4,772 rows) and 'Snap and Trim' (580). Keying the
  // map on mdt_id alone means all 4,772 Inspection Ready completions fire
  // lp-milestone-snap-trim. Neither X variant is a customer-facing beat, so
  // this is a reporting-accuracy defect, not a messaging one. Fixing it
  // needs the map keyed on mdt_id + datetype AND the (lp_job_id, mdt_id)
  // conflict key widened — tracked separately, deliberately not in this PR.
  X: 'lp-milestone-snap-trim',
};

// Human-readable labels
export const MDT_LABELS = {
  R: 'RTP (Ready to Process)',
  M: 'Measure',
  O: 'Quoted',
  H: 'HOA Approved',
  K: 'Ordered',
  U: 'Permit Submit',
  P: 'Permit Issued',
  V: 'Receive (Windows)',
  E: 'Receive (Doors)',
  G: 'Received All Product',
  S: 'Install Start',
  F: 'Install End',
  C: 'Completion',
  I: 'Inspection Set',
  B: 'Inspection Passed',
  X: 'Snap and Trim',
};

/**
 * Sweep newly-completed milestones and fire their GHL tags.
 *
 * This is the SECOND of the two milestone fire paths. syncJobAndMilestones
 * (src/sync-children.js) fires inline when a completion first appears on a
 * lead that already has a GHL contact linked; this sweeper catches every
 * other case — contact linked later, tag application failed, or (as of the
 * achievement gate) act_date that was in the future when it was written and
 * has since arrived. It runs on every sync pass.
 *
 * ─── 2026-08-06: TWO DEFECTS FIXED ───────────────────────────────
 *
 * 1. ACHIEVEMENT GATE. The query used to be "act_date IS NOT NULL AND
 *    ghl_tag_fired = false" with no date bound, so a scheduled-but-not-yet-
 *    reached completion fired immediately. 209 rows carried a future
 *    act_date; 56 had fired. See src/milestone-gate.js for the measurement.
 *    Bounded here in Postgres (cheaper than filtering in Node) and
 *    re-checked per row against the shared predicate so both fire paths
 *    agree on what "achieved" means.
 *
 * 2. EVENT PARITY. This sweeper applied the GHL tag but never emitted
 *    lp.milestone_completed — only the inline path did. Result: 1,391 of
 *    5,867 genuinely-fired milestones (24%) reached GHL as a tag but never
 *    reached the Decision Engine, so no P2_MILESTONE_* rule ran and the
 *    opportunity never moved stage. Those customers sat in the wrong
 *    Client Lifecycle stage with the right tag on them. Now emitted with
 *    the same idempotency_key as the inline path, so a milestone that fires
 *    here after a partial inline failure cannot double-emit.
 *
 * ─── 2026-08-31: THIRD DEFECT — THE SWEEP WAS FIRING NOTHING AT ALL ───
 *
 * Measured on live data before this fix:
 *
 *   candidate queue (exact count)  27668
 *   rows the sweep actually read    1000   ← 3.6%
 *   overlap between two reads       1000 / 1000  (100% identical)
 *   of that window, fireable           0
 *
 * Three things compounded, and only together do they explain a job that
 * looks healthy in the logs and does nothing:
 *
 *   1. The candidate SELECT had no .range() and no .limit(). PostgREST caps a
 *      response at 1,000 rows SILENTLY, so 27,668 candidates arrived as 1,000
 *      with no error and no truncation marker.
 *   2. It had no ORDER BY either. An unordered PostgREST read comes back in
 *      heap order, which is stable between calls — hence the 100% overlap. The
 *      sweep saw the same arbitrary 1,000 rows on every pass, forever.
 *   3. A row is only marked ghl_tag_fired once a tag has ACTUALLY been applied.
 *      A row whose contact cannot be resolved hits `continue` and is never
 *      marked, so it stays a candidate permanently. 15,050 rows are in that
 *      state — 15x the page size — and heap order had clustered them into
 *      exactly the window the sweep kept re-reading.
 *
 * So the window was 100% unfireable, nothing in it could ever be marked, the
 * window therefore never changed, and 12,618 fireable milestones sat
 * unreachable behind it. Each is a missed GHL tag AND a missed
 * lp.milestone_completed — which is to say a missed P2 stage move, the very
 * defect (2) above claims to have fixed.
 *
 * THE FIX IS ORDERING, NOT FILTERING, AND THAT DISTINCTION IS LOAD-BEARING.
 *
 * The tempting fix — only consider rows that have a contact — is FORBIDDEN
 * here. scripts/test-ghl-link-propagate.js pins the invariant that this
 * SELECT filters on act_date and ghl_tag_fired and nothing else, because
 * sql/075_ghl_link_propagate.sql's "this cannot fire a tag at a real
 * homeowner" claim rests on the fire set being independent of ghl_contact_id.
 * Add that filter and the propagation silently arms thousands of historical
 * fires. Do not add it. That test is not in the way; it is the reason this
 * fix takes the shape it does.
 *
 * Ordering alone is enough, because the dead rows are not concentrated: walked
 * in id order every 1,000-row page is ~45% fireable (454, 452, 438, 447, ...).
 * It was only heap order that made them look like a wall. So this now walks
 * the queue by keyset on id, and pages PAST unfireable rows instead of
 * stopping at them.
 *
 * The 15,050 unfireable rows are still read each pass — about 16 pages once
 * the backlog drains. They no longer block anything; they cost reads. Retiring
 * them for good needs a decision this code should not make on its own: their
 * leads have no GHL contact TODAY, but a later link would make them legitimate
 * fires, so marking them fired would silently destroy that.
 */
/**
 * One page of sweep candidates, in keyset order after `cursor`.
 *
 * Takes the client as an argument for one reason: it is the only seam in this
 * module. Everything else here reaches Supabase and GHL through import-time
 * singletons, which is why scripts/test-ghl-link-propagate.js has to assert
 * its invariant against source TEXT. The paging rules below — ordered, keyset,
 * and free of any ghl_contact_id predicate — are the ones that were wrong for
 * long enough to stall the sweep completely, so they get a real test with a
 * fake PostgREST instead (scripts/test-milestone-sweep.js).
 *
 * THE PREDICATE AND THE WALK ARE DIFFERENT THINGS, and the order below says
 * which is which: everything up to ghl_tag_fired decides ELIGIBILITY and is
 * pinned by the propagation safety test; everything after it decides only
 * WHERE WE ARE in the queue and must never narrow the set.
 */
export async function readCandidatePage(client, { now, cursor, pageRows = CANDIDATE_PAGE_ROWS }) {
  return client
    .from('lp_job_milestones')
    .select('id, lp_job_id, lp_lead_id, ghl_contact_id, mdt_id, datetype, act_date')
    .not('act_date', 'is', null)
    // Achievement gate, pushed into Postgres. Upper bound excludes both
    // scheduled-future and the corrupt 2206/2046 rows in one comparison.
    .gte('act_date', MIN_PLAUSIBLE_ACT_DATE)
    .lte('act_date', now.toISOString())
    .eq('ghl_tag_fired', false)
    // ── walk, not predicate ──
    .gt('id', cursor)
    .order('id', { ascending: true })
    .limit(pageRows);
}

export async function processMilestoneTriggers(now = new Date()) {
  let fired = 0;
  let errors = 0;
  let gated = 0;
  let processed = 0;
  let scanned = 0;
  let pagesRead = 0;
  let skippedNoContact = 0;
  let skippedNoTag = 0;
  let wouldFire = 0;
  // Outward-facing ATTEMPTS this pass — successful fires plus failed tag
  // applications. The budget is charged against this, not against `fired`,
  // because a failure still reached a live contact and still wrote a log row.
  let attempted = 0;
  let stoppedOnBudget = false;

  // Budget 0 means "walk everything, write nothing" rather than "do nothing":
  // an off switch that still reports is worth far more than a silent one.
  const scanOnly = MAX_FIRES_PER_PASS <= 0;

  // Keyset, not offset. Firing a row sets ghl_tag_fired = true, which removes
  // it from this very filter mid-walk; an offset cursor would then slide over
  // exactly as many unread rows as were fired. A cursor on id cannot skip.
  let cursor = UUID_MIN;

  for (;;) {
    if (!scanOnly && attempted >= MAX_FIRES_PER_PASS) { stoppedOnBudget = true; break; }

    const { data: page, error } = await readCandidatePage(supabase, { now, cursor });

    if (error) {
      console.error('[Milestones] Query failed:', error.message);
      if (scanned === 0) return { processed: 0, fired: 0, errors: 0, gated: 0 };
      break; // partial pass: report what was actually done, do not claim zero
    }
    if (!page.length) break;

    pagesRead++;
    scanned += page.length;
    cursor = page[page.length - 1].id;

    // Bug 10: Build a map of lead_id → {ghl_contact_id, lp_prospect_id} from
    // lp_leads so we can resolve contacts and always log prospect IDs.
    // Per page, and via the shared count-asserting reader: a page carries up to
    // 1,000 keys, and an unchunked .in() of 1,000 sits exactly ON the response
    // cap — a partial lead map would make fireable rows look contact-less and
    // skip them silently, which is the same class of bug as the one above.
    const leadIds = [...new Set(page.map(m => m.lp_lead_id).filter(Boolean))];
    const leadDataMap = {};
    if (leadIds.length > 0) {
      const leads = await selectAllIn(supabase, 'lp_leads', {
        columns: 'id, lp_lead_id, ghl_contact_id, lp_prospect_id',
        orderBy: 'id',
        column: 'lp_lead_id',
        values: leadIds,
      });
      for (const lead of leads) {
        leadDataMap[lead.lp_lead_id] = {
          ghl_contact_id: lead.ghl_contact_id,
          lp_prospect_id: lead.lp_prospect_id,
        };
      }
    }

    // Job context for the emitted event payload (job_value drives the P2
    // opportunity's monetary value; branch_code drives market attribution).
    // ONE batched read per page, not one per milestone.
    const jobIds = [...new Set(page.map(m => m.lp_job_id).filter(Boolean))];
    const jobDataMap = {};
    if (jobIds.length > 0) {
      const jobs = await selectAllIn(supabase, 'lp_jobs', {
        columns: 'id, lp_job_id, job_value, branch_code, job_status',
        orderBy: 'id',
        column: 'lp_job_id',
        values: jobIds,
      });
      for (const job of jobs) {
        jobDataMap[job.lp_job_id] = { job_value: job.job_value, branch_code: job.branch_code, job_status: job.job_status };
      }
    }

    const spent = await processPage(page, {
      now, leadDataMap, jobDataMap, scanOnly,
      // Charged against attempts ACROSS pages, not fires within one. An earlier
      // draft passed `MAX_FIRES_PER_PASS - fired`: because a failed tag
      // increments errors and not fired, a GHL outage left the remaining budget
      // at full on every page and the ceiling became 28x itself. Track the spend.
      remainingBudget: MAX_FIRES_PER_PASS - attempted,
      onWouldFire: () => { wouldFire++; },
      onFired: () => { fired++; },
      onError: () => { errors++; },
      onGated: () => { gated++; },
      onNoContact: () => { skippedNoContact++; },
      onNoTag: () => { skippedNoTag++; },
      onProcessed: () => { processed++; },
    });
    attempted += spent;
    if (!scanOnly && attempted >= MAX_FIRES_PER_PASS) { stoppedOnBudget = true; break; }

    if (page.length < CANDIDATE_PAGE_ROWS) break;
  }

  if (gated > 0) {
    console.log(`[Milestones] ${gated} row(s) held by the achievement gate — act_date not yet reached`);
  }
  if (skippedNoContact > 0) {
    console.log(
      `[Milestones] ${skippedNoContact} row(s) skipped — no GHL contact on the milestone or its lead. `
      + 'These are never marked fired, so they stay candidates; the walk pages past them.',
    );
  }
  console.log(
    `[Milestones] swept ${scanned} candidate(s) over ${pagesRead} page(s): `
    + (scanOnly ? `SCAN ONLY — ${wouldFire} would fire (nothing written)` : `${fired} fired`)
    + `, ${errors} failed, ${skippedNoContact} no-contact, ${skippedNoTag} no-tag`
    + (stoppedOnBudget ? ` — STOPPED at the ${MAX_FIRES_PER_PASS}-fire budget, more remain` : ''),
  );

  return {
    processed, fired, errors, gated,
    scanned, pagesRead, skippedNoContact, skippedNoTag, wouldFire, scanOnly, stoppedOnBudget,
  };
}

/**
 * Fire one page of candidates. Returns the number of outward-facing ATTEMPTS
 * made — fires plus failed tag applications — so the caller can charge them
 * against a budget that spans the whole pass rather than resetting per page.
 *
 * Split out of processMilestoneTriggers only so the paging above stays legible;
 * the per-row rules are unchanged.
 */
async function processPage(page, {
  now, leadDataMap, jobDataMap, remainingBudget, scanOnly,
  onFired, onError, onGated, onNoContact, onNoTag, onProcessed, onWouldFire,
}) {
  let spent = 0;

  for (const milestone of page) {
    if (!scanOnly && spent >= remainingBudget) return spent;
    onProcessed();
    // Belt-and-braces: the range filter above already excluded these, but
    // running the shared predicate here keeps the two fire paths provably
    // in agreement and catches anything the range filter's timezone
    // handling might let through.
    const verdict = classifyMilestoneDate(milestone.act_date, now);
    if (!verdict.achieved) {
      onGated();
      continue;
    }

    const leadData = leadDataMap[milestone.lp_lead_id] || {};
    // Bug 10: Use lead's ghl_contact_id as fallback if milestone row has null
    const ghlContactId = milestone.ghl_contact_id || leadData.ghl_contact_id;
    const lpProspectId = leadData.lp_prospect_id || null;
    // Unfireable, and deliberately NOT marked: the lead may gain a GHL contact
    // later, and this row is then a legitimate fire. It costs a read on every
    // pass and blocks nothing — the walk continues past it. Counting it is the
    // point: 15,050 of these silently wedged the sweep before it was ordered.
    if (!ghlContactId) { onNoContact(); continue; }

    const tag = MDT_TAG_MAP[milestone.mdt_id];
    if (!tag) { onNoTag(); continue; }

    // 2026-09-21 stale-fire gate. Per ROW, after the read — readCandidatePage's
    // predicate is pinned by scripts/test-ghl-link-propagate.js and is untouched.
    // Enforce retires the row with the SAME audit columns the #512 backfill uses,
    // so it never fires later and stays distinguishable from a real fire.
    const staleness = staleFireVerdict({
      actDate: milestone.act_date,
      jobStatus: (jobDataMap[milestone.lp_job_id] || {}).job_status,
      now,
    });
    if (staleness.stale) {
      const mode = staleFireMode();
      if (mode !== 'off') {
        console.warn(`[Milestones] STALE FIRE (${mode}) ${tag} contact=${ghlContactId} job=${milestone.lp_job_id} reason=${staleness.reason} age=${staleness.ageDays ?? 'n/a'}d`);
      }
      if (mode === 'enforce') {
        if (!scanOnly) {
          await supabase.from('lp_job_milestones')
            .update({ ghl_tag_fired: true, tag_suppressed_backfill: true, tag_suppressed_at: new Date().toISOString() })
            .eq('lp_job_id', milestone.lp_job_id).eq('mdt_id', milestone.mdt_id);
        }
        continue;
      }
    }

    // Everything above is classification and touches nothing. The line below
    // is the first outward-facing act in this function, so scan-only stops
    // exactly here — after the row has been counted, before anything is sent.
    if (scanOnly) { onWouldFire(); continue; }

    const success = await applyGHLTag(ghlContactId, tag);

    if (success) {
      // Also update ghl_contact_id on milestone row if it was resolved from lead
      const updateFields = { ghl_tag_fired: true };
      if (!milestone.ghl_contact_id && ghlContactId) {
        updateFields.ghl_contact_id = ghlContactId;
      }
      await supabase.from('lp_job_milestones')
        .update(updateFields)
        .eq('lp_job_id', milestone.lp_job_id)
        .eq('mdt_id', milestone.mdt_id);

      // Event parity with the inline path (defect 2 in the header). Same
      // idempotency_key shape — lp_milestone_<contact>_<mdt>_<job> — so a
      // milestone whose inline emit already landed cannot double-fire.
      const jobData = jobDataMap[milestone.lp_job_id] || {};
      try {
        await emitEvent({
          event_type: 'lp.milestone_completed',
          source: 'lp_milestone_sweeper',
          entity_type: 'contact',
          entity_id: ghlContactId,
          ghl_contact_id: ghlContactId,
          payload: {
            mdt_id: milestone.mdt_id,
            datetype: milestone.datetype || null,
            milestone_tag: tag,
            act_date: milestone.act_date,
            job_id: milestone.lp_job_id,
            lp_lead_id: milestone.lp_lead_id,
            job_value: jobData.job_value ?? null,
            branch_code: jobData.branch_code ?? null,
          },
          priority: 'normal',
          idempotency_key: `lp_milestone_${ghlContactId}_${milestone.mdt_id}_${milestone.lp_job_id}`,
        });
      } catch (emitErr) {
        // Non-fatal: the tag landed, which is the customer-visible half.
        // A missed event means the P2 stage move is skipped, which the
        // nightly reconcile can pick up.
        console.warn(`[Milestones] Event emit failed for ${ghlContactId} ${milestone.mdt_id}: ${emitErr.message}`);
      }

      await logTrigger({
        lp_lead_id: milestone.lp_lead_id,
        lp_prospect_id: lpProspectId,
        ghl_contact_id: ghlContactId,
        event: `milestone_${milestone.mdt_id}`,
        tag_fired: tag,
        status: 'success',
      });
      onFired();
      spent++;
    } else {
      await logTrigger({
        lp_lead_id: milestone.lp_lead_id,
        lp_prospect_id: lpProspectId,
        ghl_contact_id: ghlContactId,
        event: `milestone_${milestone.mdt_id}`,
        tag_fired: tag,
        status: 'failed',
        error_detail: 'GHL tag application failed',
      });
      onError();
      // A failed tag still consumed an attempt against a live contact. Charge
      // it to the budget, or a GHL outage turns the ceiling into no ceiling.
      spent++;
    }
  }

  return spent;
}

async function logTrigger({ lp_lead_id, lp_prospect_id, ghl_contact_id, event, tag_fired, status, error_detail }) {
  try {
    await supabase.from('lp_trigger_log').insert({
      lp_lead_id,
      lp_prospect_id: lp_prospect_id || null,
      ghl_contact_id,
      event,
      tag_fired,
      status,
      error_detail: error_detail || null,
    });
  } catch (err) {
    console.error('[Milestones] Trigger log write failed:', err.message);
  }
}
