/**
 * Opportunity Handlers — src/actions/handlers/opportunities.js
 *
 * move_opportunity (v3.0): Find opp by contact+pipeline, PUT pipelineStageId.
 *   Auto-creates opp if none exists. Forward-only guard (v4.0) prevents
 *   backward pipeline movement.
 *
 *   v4.3 (2026-05-06): allow_backward payload flag bypasses the guard for
 *   intentional backward moves (remediation, cold-cancellation rerouting).
 *
 *   v5.1 (2026-08-31): every write path now carries monetaryValue — the value of
 *   the contact's MOST RECENT non-cancelled lp_jobs row, recomputed per write.
 *   An opportunity tracks ONE job, so a sum double-counts a repeat customer
 *   whose earlier job is already closed Won. See src/lp-job-value.js.
 *
 *   v5.2 (2026-08-31): the value freeze is stated rather than emergent — see
 *   isValueWritable() below — and the create path stops producing records with
 *   no source and a first-name-only name.
 *
 *   v5.0 (2026-08-16): one-open-opportunity-per-pipeline invariant — in-process
 *   lock keyed contact+pipeline, and opps[0] replaced by pickPrimaryOpp().
 *   Documented here 2026-09-21; it had only ever been a body comment.
 *
 *   v5.3 (2026-08-31): the create path's source carries the LP VENDOR too where
 *   the contact and LP agree on the channel ("Internet" → "Internet, Modernize").
 *   Documented here 2026-09-21; it had only ever been an inline comment.
 *
 *   v5.4 (2026-09-21): the P2 create path reads the JOB, not just the contact.
 *   Source is the LP "Source, Subsource" of the lead owning the deciding job, so
 *   a blank or 'lp-backstop' contact no longer mints a sourceless opportunity (21
 *   of 1,144 open P2 opps). And a terminal-job guard stops the create path
 *   minting a NEW open opp for a job already Paid In Full or dead — 115 of the
 *   157 P2 creates in 30 days. Guard is CREATE-only (an existing open opp still
 *   moves), P2-only, fails OPEN on no job or an unreadable read, and ships behind
 *   P2_TERMINAL_CREATE_GUARD_MODE (off | shadow | enforce, default shadow).
 *   See src/p2-opportunity-context.js.
 *
 *   v4.4 (2026-06-16): duplicate-opportunity recovery (N1). When the create
 *   path's POST is rejected by GHL with 400 "Can not create duplicate
 *   opportunity for the contact" (meta.existingId), update that existing opp
 *   in place to the target stage/status instead of failing and being reaped.
 *   The pipeline-scoped search can miss an opp that lives in another pipeline
 *   or hasn't propagated yet; recovering by PUT mirrors the opps.length>0 path.
 *
 * update_opportunity (v4.1): PUT monetaryValue, source, lostReasonId, status,
 *   name. Optionally also updates contact source and custom fields.
 *   Used for P2 value/source enrichment and loss intelligence.
 *
 * ROUTE-TO-P3 CONTRACT (2026-06-10): any rule or dispatch row whose
 * move_opportunity targets P3 as a LOSS outcome must, in the same action
 * batch, (a) set the "Intended Loss Reason" custom field
 * (I9CbRV0dKMfwaSlge9uU) to a valid picklist option and (b) add the
 * mark-p1-lost tag — the L.0 P1 Loss Marker workflow (248d42f0) triggers on
 * that tag and branches on the field to close the P1 opp lost. The contract
 * lives in config, not here: this handler must NOT auto-stamp it, because
 * legitimate non-loss P3 moves (Reactivation Queue, deferred monetization)
 * route through the same action_type.
 *
 * Extracted from action-executor.js v4.2 refactor.
 */

import { ghlFetch, isLPLeadId } from '../helpers.js';
import { PIPELINE_IDS, STAGE_MAP, GHL_LOCATION_ID } from '../constants.js';
import { checkForwardOnly, getStagePosition } from '../../pipeline-guard.js';
import { updateGHLContactFields } from '../../ghl.js';
// 2026-07-03 (pipeline-integrity breach) — evidence-gated milestone moves.
import { checkStageMoveEvidence } from '../stage-evidence.js';
import { emitEvent } from '../../event-emitter.js';
import { openJobValueForContact } from '../../lp-job-value.js';
import { opportunitySourceField } from '../../lp-source-attribution.js';
import { loadP2CreateContext, terminalGuardMode } from '../../p2-opportunity-context.js';

// ─── v5.0 (2026-08-16): one-open-opportunity-per-pipeline invariant ──
// Standing rule (Mark): a contact must never hold more than one OPEN
// opportunity in the same pipeline. Two things broke it.
//
// (1) Concurrency. The milestone burst on contact PIDxmWzCs35NHgW85vOW
//     queued 12 move_opportunity actions inside 60s. Search + create was
//     never atomic, so each could find nothing and each could POST.
// (2) opps[0]. GHL returns opportunities in creation order, so when
//     duplicates already exist the OLDEST — usually the stalest stage —
//     was the one being moved and guarded against.
//
// Audit 2026-08-16: 28 contacts / 68 open opps across P1, P2, P3.
//
// The lock is IN-PROCESS, keyed contact+pipeline. The action executor is a
// single Node process, so this closes the real race. It is NOT distributed
// — if the executor is ever sharded, replace with Postgres advisory locks.
// The map holds the CHAINED tail promise, not `current` — comparing against
// `current` on the way out would never match, and the entry would leak one
// slot per (contact, pipeline) for the life of the process. Deleting only
// when the tail is still ours means a waiter that queued behind us keeps the
// chain intact.
const _oppLocks = new Map();
async function withOpportunityLock(key, fn) {
  const prior = _oppLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((res) => { release = res; });
  const tail = prior.then(() => current);
  _oppLocks.set(key, tail);
  await prior.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (_oppLocks.get(key) === tail) _oppLocks.delete(key);
  }
}

// ─── The value invariant, stated once ───────────────────────────────
// A won/lost/abandoned opportunity's monetaryValue is historical record and is
// never rewritten. If a Won opp kept recomputing against the contact's newest
// job, historical won revenue would silently rewrite itself downward every time
// a later job was cancelled, with nothing to detect it.
//
// Until 2026-08-31 this held only as a SIDE EFFECT of the v5.0 openOpps filter
// below — a closed opp was never a move target, so it was never revalued. An
// invariant held by accident breaks the first time someone refactors the guard
// that happens to be holding it, and nobody connects the two. Hence this
// function, and hence the status predicate in
// scripts/backfill-opportunity-values.js which had no such accident protecting
// it and would have rewritten every closed-won opportunity in the pipeline.
//
// The freeze point is the win itself: executeMoveOpportunity recomputes on
// every call, so the write that carries status:'won' stamps the value as of the
// win. executeUpdateOpportunity does the same explicitly.
function isValueWritable(opp) {
  return (opp?.status || 'open') === 'open';
}

// Rank duplicates furthest-along-first and report them. Unknown stage
// positions sort last. Creation order breaks ties.
function pickPrimaryOpp(openOpps, contactId, pipeline) {
  if (openOpps.length <= 1) return openOpps;
  const sorted = [...openOpps].sort((a, b) => {
    const pa = getStagePosition(a.pipelineStageId);
    const pb = getStagePosition(b.pipelineStageId);
    if (pa !== pb) return (pb ?? -1) - (pa ?? -1);
    return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
  });
  console.warn(`[ActionExecutor] ⚠️ ${openOpps.length} open ${pipeline} opportunities for contact ${contactId} — acting on ${sorted[0].id}; duplicates: ${sorted.slice(1).map(o => o.id).join(', ')}`);
  emitEvent({
    event_type: 'opportunity.duplicate_detected',
    source: 'action_executor',
    entity_type: 'contact',
    entity_id: String(contactId),
    ghl_contact_id: String(contactId),
    priority: 'normal',
    bypass_filter: true,
    payload: {
      pipeline,
      open_count: openOpps.length,
      primary_opportunity_id: sorted[0].id,
      duplicate_opportunity_ids: sorted.slice(1).map(o => o.id),
    },
    idempotency_key: `opp_dupe_${contactId}_${pipeline}_${new Date().toISOString().slice(0, 10)}`,
  }).catch((err) => console.warn(`[ActionExecutor] duplicate_detected emit failed: ${err.message}`));
  return sorted;
}

export async function executeMoveOpportunity(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};
  const { pipeline, stage, status } = payload;
  const allowBackward = payload.allow_backward === true;
  if (!contactId || !pipeline || !stage) throw new Error('Missing contactId, pipeline, or stage');
  const pipelineId = PIPELINE_IDS[pipeline];
  if (!pipelineId) throw new Error(`Unknown pipeline: ${pipeline}`);
  const stageId = STAGE_MAP[stage];
  if (!stageId) throw new Error(`Unknown stage: "${stage}" — fix the agent_rule`);

  // ── Job value on every move (2026-08-31) ────────────────────────
  // All three write paths below used to send only pipelineStageId/status, so
  // every opportunity this handler created or moved landed with NO value —
  // 260 of 2,483 Client Lifecycle opps sitting at zero. monetaryValue is
  // GHL's own field and what its pipeline revenue reporting reads; the
  // "LP Gross Sale Amount" custom field is CONTACT-scoped and cannot be
  // written onto an opportunity.
  //
  // The value is ONE job's — the contact's most recent non-cancelled lp_jobs
  // row — not a sum across their jobs. An opportunity tracks a single job's
  // lifecycle and is closed Won when that job closes, so summing counts a job
  // whose opportunity is already Won a second time and inflates pipeline for
  // precisely the repeat customers this exists to get right.
  //
  // Recomputed from the contact's FULL job set on every write, never
  // incremented — a delta write drifts permanently the first time a job is
  // cancelled or revalued. null means "no live work", and the key is then
  // OMITTED rather than sent as 0, so a contact with no linked LP job never
  // has an existing value clobbered by a stage move.
  const jobValue = await openJobValueForContact(contactId);
  const valueField = jobValue === null ? {} : { monetaryValue: jobValue };

  // ── Stage-transition evidence validator (2026-07-03) ────────────
  // Milestone stages require real-world evidence BEFORE any move, no matter
  // which rule requested it (BEHAVIORAL_FAST_TRACK fabricated "Appointment
  // Booked" on AI intent; BEHAVIORAL_*_OBJECTION fabricated "Proposal
  // Delivered" with no demo — ~150 unearned moves / 111 contacts). Demotions
  // and un-gated stages pass straight through (required: false).
  const evidence = await checkStageMoveEvidence(contactId, stageId);
  if (evidence.required && !evidence.allowed) {
    const ruleKey = action.rule_applied || null;
    console.warn(
      `[ActionExecutor] 🚫 move_opportunity BLOCKED by stage-transition validator: ` +
      `contact=${contactId} stage="${stage}" rule=${ruleKey || 'manual'} ` +
      `missing=[${(evidence.missing_evidence || []).join(', ')}]`
    );
    emitEvent({
      event_type: 'opportunity.move_blocked',
      source: 'action_executor',
      entity_type: 'contact',
      entity_id: String(contactId),
      ghl_contact_id: String(contactId),
      priority: 'normal',
      bypass_filter: true,
      payload: {
        rule_key: ruleKey,
        requested_stage: stage,
        requested_stage_id: stageId,
        pipeline,
        evidence_kind: evidence.evidence_kind,
        missing_evidence: evidence.missing_evidence,
        facts_unreadable: evidence.facts_unreadable || false,
        action_id: action.id || null,
      },
      idempotency_key: `move_blocked_${contactId}_${stageId}_${action.id || Date.now()}`,
    }).catch((err) => console.warn(`[ActionExecutor] move_blocked event emit failed: ${err.message}`));
    return {
      action: 'move_blocked_no_evidence',
      blocked_by_validator: true,
      reason: `stage "${stage}" requires evidence (${evidence.evidence_kind}); missing: ${(evidence.missing_evidence || []).join(', ')}`,
      contact_id: contactId,
      pipeline,
      requested_stage: stage,
      missing_evidence: evidence.missing_evidence,
    };
  }

  return await withOpportunityLock(`${contactId}:${pipelineId}`, async () => {
  const searchRes = await ghlFetch('GET', `/opportunities/search?location_id=${GHL_LOCATION_ID}&contact_id=${contactId}&pipeline_id=${pipelineId}`);
  // v5.0: OPEN opps only — a lost/won opp in this pipeline is history, not a
  // move target, and must not suppress the create path.
  const openOpps = (searchRes?.opportunities || []).filter(o => (o.status || 'open') === 'open');
  const opps = pickPrimaryOpp(openOpps, contactId, pipeline);
  if (opps.length > 0) {
    // v4.0: Forward-only guard — prevent backward pipeline movement
    // v4.3: allow_backward: true in payload bypasses the guard for intentional
    //       backward moves (remediation, cold-cancellation rerouting, etc.)
    const guard = checkForwardOnly(opps[0].pipelineStageId, stageId);
    if (!guard.allowed && !allowBackward) {
      console.log(`[ActionExecutor] ⏭️ Forward-only: ${pipeline} opp at pos ${guard.currentPos}, target pos ${guard.targetPos} — ${guard.reason}`);
      return {
        action: 'skipped_forward_only',
        opportunity_id: opps[0].id,
        pipeline,
        current_position: guard.currentPos,
        target_position: guard.targetPos,
        target_stage: stage,
        reason: guard.reason,
      };
    }
    if (!guard.allowed && allowBackward) {
      console.log(`[ActionExecutor] ⚠️ Backward move ALLOWED via allow_backward: ${pipeline} opp at pos ${guard.currentPos}, target pos ${guard.targetPos} — ${guard.reason}`);
    }
    // opps[0] is open by construction (the openOpps filter above), but the
    // invariant is enforced at the WRITE rather than inherited from that filter
    // — that inheritance is exactly what made the freeze accidental.
    const moveValueField = isValueWritable(opps[0]) ? valueField : {};
    await ghlFetch('PUT', `/opportunities/${opps[0].id}`, { pipelineStageId: stageId, status: status || 'open', ...moveValueField });
    return {
      action: 'updated',
      opportunity_id: opps[0].id,
      pipeline,
      stage,
      status,
      monetary_value: Object.keys(moveValueField).length ? jobValue : null,
      backward_override: !guard.allowed && allowBackward,
    };
  } else {
    const contactRes = await ghlFetch('GET', `/contacts/${contactId}`);
    const c = contactRes?.contact || {};
    // v5.2 (2026-08-31): this used to read `c.name || c.firstName`. ghlFetch
    // talks to GHL API v2 (services.leadconnectorhq.com, Version 2021-07-28),
    // whose contact payload carries firstName/lastName/contactName — `name` is
    // not reliably present, so the expression silently degraded to the FIRST
    // NAME ALONE. 212 of the 260 empty Client Lifecycle opportunities are
    // one-word names ("Kelly", "Charles") against 26 of 2,223 populated ones.
    // Matches the builder used in handlers/appointments.js and handlers/notes.js.
    const name = [c.firstName, c.lastName].filter(Boolean).join(' ')
      || c.contactName || c.name || 'Unknown';
    // v5.2: and it never sent source at all, which is why no_value and no_source
    // track each other stage for stage. Create only — the PUT paths must not
    // clobber a source another path already set.
    //
    // v5.3 (2026-08-31): the source now carries the LP VENDOR too, where the
    // contact's source and LP's already agree on the channel — "Internet"
    // becomes "Internet, Modernize". The parent alone is near-useless for
    // attribution ("Internet" is 60%+ of volume). Contacts whose vocabulary
    // differs from LP's ("Canvassing", "Window Estimator") are returned
    // unchanged, so this only ever adds detail and never rewrites a value
    // another path set. See src/lp-source-attribution.js.
    let sourceField = opportunitySourceField(c);
    // v5.4 (2026-09-21): P2 create reads the JOB, not just the contact.
    //  - SOURCE: LP "Source, Subsource" of the lead that owns the deciding job.
    //    The contact-based value above returns nothing for blank/'lp-backstop'
    //    contacts, which is how 21 open P2 opps ended up with no source.
    //  - GUARD: never mint a NEW open opp for a job that is already collected or
    //    dead (115 of 157 creates in 30 days). Create-path only; an existing open
    //    opp still moves. Fails OPEN on no job / unreadable. Mode flag, default shadow.
    let terminalGuard = null;
    if (pipeline === 'P2') {
      const ctx = await loadP2CreateContext(contactId);
      if (ctx.source) sourceField = { source: ctx.source };
      if (ctx.terminal) {
        const mode = terminalGuardMode();
        terminalGuard = `${mode}:${ctx.verdict}`;
        console.warn(`[ActionExecutor] P2 create on terminal job (${mode}): contact=${contactId} job=${ctx.job?.lp_job_id} status="${ctx.job?.job_status}" stage="${stage}" rule=${action.rule_applied || 'manual'}`);
        if (mode === 'enforce') {
          return {
            action: 'skipped_terminal_job', pipeline, target_stage: stage, contact_id: contactId,
            lp_job_id: ctx.job?.lp_job_id ?? null, job_status: ctx.job?.job_status ?? null, verdict: ctx.verdict,
          };
        }
      }
    }
    try {
      const newOpp = await ghlFetch('POST', '/opportunities/', {
        pipelineId,
        pipelineStageId: stageId,
        locationId: GHL_LOCATION_ID,
        contactId,
        name,
        status: status || 'open',
        ...valueField,
        ...sourceField,
      });
      return { action: 'created', opportunity_id: newOpp?.opportunity?.id, pipeline, stage, status, monetary_value: jobValue, source: sourceField.source || null, terminal_guard: terminalGuard };
    } catch (err) {
      // v4.4 (2026-06-16) — Duplicate-opportunity recovery (N1).
      // GHL permits only one open opportunity per contact and rejects the
      // create with 400 "Can not create duplicate opportunity", carrying the
      // colliding opp in meta.existingId. The pipeline-scoped search above
      // missed it (different pipeline, or eventual-consistency lag). Rather
      // than fail and get reaped, update that existing opp in place to the
      // target stage — the outcome the rule intended. Mirrors the PUT used
      // when opps.length > 0.
      const m = /"existingId"\s*:\s*"([^"]+)"/.exec(err?.message || '');
      if (m) {
        const existingId = m[1];
        // v5.2: the opp GHL collided with was never searched for, so unlike the
        // opps[0] path above it is NOT known to be open — it may be a won opp in
        // another pipeline. Read it before deciding whether the value may be
        // written; if we cannot read it, omit the value rather than guess.
        let existingOpp = null;
        try {
          const res = await ghlFetch('GET', `/opportunities/${existingId}`);
          existingOpp = res?.opportunity || null;
        } catch (readErr) {
          console.warn(`[ActionExecutor] duplicate-recovery: could not read opp ${existingId} (${readErr.message}) — omitting monetaryValue`);
        }
        const recoveryValueField = (existingOpp && isValueWritable(existingOpp)) ? valueField : {};
        await ghlFetch('PUT', `/opportunities/${existingId}`, { pipelineStageId: stageId, status: status || 'open', ...recoveryValueField });
        console.log(`[ActionExecutor] ♻️ move_opportunity recovered from duplicate-opp 400 — updated existing opp ${existingId} → ${pipeline}/${stage}`);
        return {
          action: 'updated_existing_on_duplicate',
          opportunity_id: existingId,
          pipeline,
          stage,
          status,
          monetary_value: Object.keys(recoveryValueField).length ? jobValue : null,
          recovered_from: 'duplicate_opportunity_400',
        };
      }
      throw err;
    }
  }
  });
}

/**
 * v4.1: Update opportunity details that move_opportunity doesn't handle.
 * Supports: monetaryValue, source, lostReasonId, status, name.
 *
 * Payload options:
 *   opportunity_id         — direct opp ID (fastest, skips search)
 *   pipeline               — "P1"/"P2"/"P3" (used with contactId to find opp)
 *   monetaryValue          — numeric sale amount
 *   source                 — opportunity source string
 *   lostReasonId           — GHL native lost reason ID
 *   status                 — open/won/lost/abandoned
 *   contact_source         — if provided, also updates the GHL contact's source field
 *   contact_custom_fields  — [{id, field_value}] to update on the contact
 */
export async function executeUpdateOpportunity(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};

  let oppId = payload.opportunity_id;

  // If no direct opp ID, search by contact + pipeline
  if (!oppId) {
    const pipeline = payload.pipeline;
    if (!contactId || !pipeline) throw new Error('Missing opportunity_id or contactId+pipeline');
    const pipelineId = PIPELINE_IDS[pipeline];
    if (!pipelineId) throw new Error(`Unknown pipeline: ${pipeline}`);

    const searchRes = await ghlFetch('GET', `/opportunities/search?location_id=${GHL_LOCATION_ID}&contact_id=${contactId}&pipeline_id=${pipelineId}`);
    const opps = searchRes?.opportunities || [];
    if (opps.length === 0) throw new Error(`No ${pipeline} opportunity found for contact ${contactId}`);
    oppId = opps[0].id;
  }

  // Build the update body — only include fields that are provided
  const updateBody = {};
  if (payload.monetaryValue !== undefined && payload.monetaryValue !== null) {
    updateBody.monetaryValue = Number(payload.monetaryValue);
  }
  if (payload.source) updateBody.source = payload.source;
  if (payload.lostReasonId) updateBody.lostReasonId = payload.lostReasonId;
  if (payload.status) updateBody.status = payload.status;
  if (payload.name) updateBody.name = payload.name;

  // Freeze at the win, not before it (v5.2, 2026-08-31). This action type
  // passes payload.monetaryValue through verbatim and the loss/win rules do not
  // supply one, so a rule that only sets status:'won' would leave the value
  // frozen as of the last stage MOVE. A job revalued between that move and its
  // close would then be recorded won at the stale number — a silent
  // understatement of won revenue with nothing to detect it later. Recompute in
  // the same write that closes it.
  if (updateBody.status === 'won' && updateBody.monetaryValue === undefined
      && contactId && !isLPLeadId(contactId)) {
    const wonValue = await openJobValueForContact(contactId);
    if (wonValue !== null) updateBody.monetaryValue = wonValue;
  }

  if (Object.keys(updateBody).length === 0 && !payload.contact_source && !payload.contact_custom_fields) {
    return { action: 'skipped_no_fields', opportunity_id: oppId, contact_id: contactId };
  }

  // Update the opportunity
  if (Object.keys(updateBody).length > 0) {
    await ghlFetch('PUT', `/opportunities/${oppId}`, updateBody);
    console.log(`[ActionExecutor] ✅ update_opportunity: opp ${oppId} updated — ${Object.keys(updateBody).join(', ')}`);
  }

  // Optionally update contact source (core field, not custom field)
  if (payload.contact_source && contactId && !isLPLeadId(contactId)) {
    await ghlFetch('PUT', `/contacts/${contactId}`, { source: payload.contact_source });
    console.log(`[ActionExecutor] ✅ update_opportunity: contact ${contactId} source → "${payload.contact_source}"`);
  }

  // Optionally update contact custom fields (e.g., LP Gross Sale Amount)
  if (payload.contact_custom_fields && Array.isArray(payload.contact_custom_fields) && contactId && !isLPLeadId(contactId)) {
    await updateGHLContactFields(contactId, payload.contact_custom_fields);
    console.log(`[ActionExecutor] ✅ update_opportunity: contact ${contactId} custom fields updated — ${payload.contact_custom_fields.length} fields`);
  }

  return {
    action: 'opportunity_updated',
    opportunity_id: oppId,
    contact_id: contactId,
    fields_updated: Object.keys(updateBody),
    contact_source_updated: !!payload.contact_source,
    contact_custom_fields_updated: payload.contact_custom_fields?.length || 0,
  };
}
