// ─── Child Entity Sync — src/sync-children.js ────────────────────
//
// Syncs child records under each lead: call logs, notes, activities,
// jobs, milestones. Also includes Pass 2 orchestrator.
// ALL LP date fields wrapped with lpDateToEastern().
//
// v7.0 — DISK I/O OPTIMIZATION:
// - Call logs, notes, activities use batch existence checks before upserting
// - Only upserts records that don't already exist (INSERT-only for immutable child records)
// - Jobs still use full upsert (mutable status field)
// - raw_lp_data removed from call_logs and activities (low-value, high-cost)
//
// v7.1 — MILESTONE EVENT EMISSION:
// - When a milestone tag fires, emit lp.milestone_completed to system_events
// - Enables P2_MILESTONE_* agent rules (IDs 113-119) for pipeline advancement
//
// v7.2 — BATCHED CHILD WRITES (perf/batch-child-sync):
// - syncCallLogs / syncNotes / syncActivities build their rows, dedupe on the
//   conflict key, and issue ONE bulk upsert each with a per-row fallback —
//   the shape syncJobAndMilestones has used since #512-perf
// - raw_lp_data removal from call_logs and activities is now ACTUALLY done;
//   the v7.0 line above described an intent that was never carried out
// - Call aggregates briefly derived from the LP payload; REVERTED — LP's
//   getLead returns a rolling ~7-day call window, not the full history, so
//   call_count was silently truncated. See the block comment in syncCallLogs.
//
// v7.3 — MILESTONE ACHIEVEMENT GATE + RICHER EVENT PAYLOAD (2026-08-06):
// - A milestone with act_date in the FUTURE is scheduled, not achieved. The
//   fire test now runs through isMilestoneAchieved() (src/milestone-gate.js).
//   209 rows carried a future act_date and 56 had already fired, including 6
//   "Install End" fires for installs ending as late as 2026-12-29. The row is
//   still written with its future date; only the tag + event are held back,
//   and processMilestoneTriggers fires it on the day it lands.
// - lp.milestone_completed payload now carries datetype, act_date, job_value
//   and branch_code — needed by the P2 rules (opportunity value, market
//   attribution) and to disambiguate the mdt_id 'X' collision downstream.
//
// v7.5 — SKIP UNCHANGED JOB + MILESTONE WRITES (perf/skip-unchanged-child-writes):
// - Calls, notes and activities have skipped existing rows since v7.0. Jobs and
//   milestones did NOT: every job payload triggered an unconditional lp_jobs
//   upsert (raw_lp_data JSONB included) and every milestone in it was pushed
//   into msRows, whether or not one field had changed. Both rows carry
//   synced_at: new Date().toISOString(), so every one of those was a REAL write
//   — same class of defect as the lp_last_synced = new Date() bug that caused
//   858 full GHL pushes per cycle.
// - Measured 2026-09-04 on lp-mcp-production: 2,111 milestone rows written per
//   incremental pass against 2 leads that had actually changed; the sync ran
//   7m 31s on a ~16min cycle. sql/058 already had lp_job_milestones at 15.9%
//   dead tuples.
// - The header line above ("milestones use existence check since they're
//   append-only") described an existence check that only ever fed the FIRE
//   decision. It never gated the write. It does now, via rowIsUnchanged().
// - The fire path is UNCHANGED: firesToDo is still materialised from
//   decisionByMdt, never from msRows, so a skipped row still fires its tag.

import supabase from './supabase.js';
import { buildJobUpsertError } from './job-upsert-error.js';
import { getField, normalizePhone, extractArray, loggedFirstKeys, sleep } from './sync-utils.js';
import { syncLogProgress, logSyncError } from './sync-log.js';
import { lpDateToEastern } from './lp-dates.js';
import { matchToGHL, applyGHLTag } from './ghl.js';
import { emitEvent } from './event-emitter.js';
import { combineNotes } from './safe-notes.js';
import { getLead } from './lp-client.js';
import { isMilestoneAchieved } from './milestone-gate.js';
import { staleFireMode, staleFireVerdict } from './milestone-stale-gate.js';
import { mapJobFields, mapMilestoneChangeFields } from './lp-job-fields.js';
import { selectFurthestMilestone } from './milestone-order.js';
import { verifiedStamp, VERIFIED_FROM, FRESHNESS_VOLATILE_COLUMNS } from './services/freshness.js';
import {
  detectJobStatusChange, buildJobStatusEvent, classifyJobStatusEmit,
} from './services/job-status-change.js';

// ─── Note edit detection (2026-09-18) ────────────────────────────────────
// syncNotes has always been INSERT-ONLY: it batch-checks lp_note_id and
// `continue`s on any hit, on the stated premise that "notes are immutable once
// created in LP". They are not — LP notes can be edited, and when one is, the
// original body stays in Supabase permanently. Nothing has ever corrected it.
//
// Off by default. Turning it on widens the existence read from one id column to
// the note body across 256k rows, and the body is the expensive part; measure
// the sweep cost in shadow before enforcing.
//   off (default) — today's behaviour, insert-only
//   shadow        — detect edits, log them, still do not write
//   enforce       — update the row when the body or its metadata changed
const NOTE_EDIT_MODES = new Set(['off', 'shadow', 'enforce']);
const noteEditMode = () => {
  const m = String(process.env.LP_NOTE_EDIT_MODE || 'off').toLowerCase().trim();
  return NOTE_EDIT_MODES.has(m) ? m : 'off';
};
const NOTE_COMPARE_COLUMNS = ['note_body', 'note_type', 'note_category', 'created_by_rep_name'];

// ─── Skip counter for observability ──────────────────────────────
// Read-once semantics: reading DRAINS the counter. src/sync-engine.js reads it
// exactly once per cycle, in the final orchestrator log line.
const emptySkips = () => ({ calls: 0, notes: 0, activities: 0, jobs: 0, milestones: 0 });
let _childSkips = emptySkips();
export function getChildSkipStats() { const s = { ..._childSkips }; _childSkips = emptySkips(); return s; }

// ─── Unchanged-row gate (v7.5) ───────────────────────────────────
// Kill switch. Default ON. Set SYNC_SKIP_UNCHANGED_CHILDREN to the string
// 'false' on Railway to restore the old always-write behaviour without a deploy.
// Read per call, not once at import, so the flag can be flipped by a restart
// rather than a rebuild.
const skipUnchangedEnabled = () => process.env.SYNC_SKIP_UNCHANGED_CHILDREN !== 'false';

// Columns that change on EVERY sync regardless of whether the record changed.
// Excluding them is the entire point of this helper — compare content, not clocks.
//
// raw_lp_data is excluded for a second reason: it is the whole LP payload, so
// comparing it would mean pulling every byte of it back over PostgREST on the
// existence read — which is most of the cost this change exists to remove.
//
// The consequence: a row would otherwise hold the raw payload from the last sync
// that changed a MAPPED column rather than from the last sync full stop. Two
// things close that gap:
//   • Nothing on the hot path reads the blob — mapJobFields derives every
//     lp_jobs column from the LIVE payload, never from the stored one.
//   • The keys inside it that anything downstream DOES read are compared
//     individually, projected as scalars. See RAW_TRACKED_KEYS below.
// verified_at / verified_from join the volatile set for the same reason
// synced_at is here: they change on every pass by construction, so comparing
// them would make rowIsUnchanged() return false forever and the v7.5 skip —
// the thing that took milestone writes from 2,111 per pass to near zero —
// would silently stop working.
const VOLATILE_COLS = new Set(['synced_at', 'raw_lp_data', ...FRESHNESS_VOLATILE_COLUMNS]);

// Keys that live ONLY inside raw_lp_data and that something downstream reads.
// The blob is excluded from the row comparison (above), so without these a
// change confined to one of them would be skipped and the stored blob would go
// stale. They are projected as SCALARS via PostgREST's JSON-path select, so the
// read costs a text field rather than the whole payload.
//
// contractid — read by src/admin/lp-rtp-job-backfill.js as
// raw_lp_data->>'contractid'. Not a mapped column, so nothing else would catch
// a change to it. Measured 2026-09-04: present on 5,986/5,986 lp_jobs rows and
// populated on 5,985, across BOTH payload shapes (3,592 Shape A / 2,394 Shape
// B) — so it is safe to compare unconditionally rather than shape-scoped.
//
// brp_id / brn_id are deliberately ABSENT: market-resolver.js falls back to them
// only when branch_code is NULL, and branch_code is a compared column derived
// from those same two keys, so a change to either already forces a write.
const RAW_TRACKED_KEYS = [
  { column: 'raw_contractid', jsonKey: 'contractid', aliases: ['contractid', 'ContractID', 'contract_id'] },
];
const RAW_TRACKED_SELECT = RAW_TRACKED_KEYS
  .map(({ column, jsonKey }) => `${column}:raw_lp_data->>${jsonKey}`).join(', ');

/** True when every tracked raw_lp_data key matches what the payload carries. */
function rawTrackedUnchanged(job, existingJob) {
  for (const { column, aliases } of RAW_TRACKED_KEYS) {
    const incoming = getField(job, ...aliases);
    const a = (incoming === null || incoming === undefined || incoming === '') ? null : String(incoming);
    const b = (existingJob?.[column] ?? null) === '' ? null : (existingJob?.[column] ?? null);
    if (a !== b) return false;
  }
  return true;
}

/**
 * True when `row` would write nothing new over `existing`.
 *
 * Only keys PRESENT on `row` are compared: both lp_jobs and lp_job_milestones
 * build sparse rows (ghl_contact_id, and the shape-scoped job keys updated_at_lp
 * and financing_company, are OMITTED — not nulled — when unavailable), and an
 * omitted key must never read as a change. That asymmetry is deliberate: a sweep
 * arriving with no contact must not blank a link it simply never saw (#784).
 *
 * Returns false when `existing` is missing — a new row always writes.
 *
 * CALLER CONTRACT: every key `row` can carry must be in the caller's SELECT
 * list. A written-but-unselected column reads as undefined on `existing`, so a
 * populated value on `row` compares unequal and the row never skips — noisy, but
 * safe. The dangerous direction is the reverse and cannot happen here: this
 * helper never treats an unknown key as equal.
 */
function rowIsUnchanged(row, existing) {
  if (!existing) return false;
  for (const [k, v] of Object.entries(row)) {
    if (VOLATILE_COLS.has(k)) continue;
    const a = v === undefined ? null : v;
    const b = existing[k] === undefined ? null : existing[k];
    if (a === null && b === null) continue;
    if (a === null || b === null) return false;
    if (a instanceof Date || b instanceof Date) {
      if (new Date(a).getTime() !== new Date(b).getTime()) return false;
      continue;
    }
    // Timestamps come back from PostgREST as strings in the server's rendering
    // ('2026-06-01T09:00:00+00:00'), not the string we sent. Normalise before
    // declaring a change, or every timestamp column would read as changed
    // forever and the gate would never skip anything.
    if (typeof a === 'string' && typeof b === 'string' && a !== b) {
      const ta = Date.parse(a), tb = Date.parse(b);
      if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta === tb) continue;
      return false;
    }
    // job_value is the ONE numeric column written here (NUMERIC(12,2)). PostgREST
    // renders numerics as a JSON number on most deployments and as a string on
    // some; parseFloat gives us a number either way. Compare numerically when
    // BOTH sides look numeric so a 19595 vs '19595.00' render difference does
    // not read as a change on every single sync. Every other column we write is
    // text/boolean/timestamp, where both sides are already the same JS type.
    if (typeof a === 'number' || typeof b === 'number') {
      const na = Number(a), nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) {
        if (na !== nb) return false;
        continue;
      }
      return false;
    }
    if (a !== b) return false;
  }
  return true;
}

// Every lp_jobs column syncJobAndMilestones can write, so rowIsUnchanged has
// something to compare against. financing_company is ALSO load-bearing as input
// to mapJobFields (it is Shape-B-only; without it a Shape A sweep of a
// known-financed job downgrades financing_status) — that is why the read existed
// before this change.
//
// KEEP IN STEP WITH THE UPSERT LITERAL AND mapJobFields (src/lp-job-fields.js).
// A column that is written but not listed here can never be seen as changed by
// the gate... which is the SAFE direction (it reads as changed and writes). The
// unsafe direction would be listing a column here that the row never carries,
// and that is harmless too — unlisted keys on `existing` are simply not compared.
const JOB_COMPARE_COLUMNS = [
  'lp_job_id', 'lp_lead_id', 'ghl_contact_id',
  'job_status', 'job_value', 'branch_code', 'rep_name', 'created_at_lp',
  // mapJobFields — always written
  'rep_id', 'job_stage', 'install_date', 'install_completed_date',
  'permit_status', 'hoa_required', 'permit_required', 'financing_status',
  // mapJobFields — shape-scoped
  'updated_at_lp', 'financing_company',
].join(', ');

// Every lp_job_milestones column the built msRow can write. ghl_tag_fired is
// read for the FIRE decision (it predates this change) and tag_suppressed_* only
// appear on suppressed rows, which are never skipped — both are listed so the
// comparison is complete either way.
const MILESTONE_COMPARE_COLUMNS = [
  'lp_job_id', 'lp_lead_id', 'ghl_contact_id', 'mdt_id',
  'datetype', 'est_date', 'act_date', 'entered_by', 'entered_on',
  'last_changed_by', 'last_changed_on',
  'ghl_tag_fired', 'tag_suppressed_backfill',
].join(', ');

// ─── Milestone Tag Map (mdt_id → GHL tag) ────────────────────────
// NOTE: duplicated in src/milestones.js — the two must stay in step.
// KNOWN DEFECT (2026-08-06): LP uses mdt_id 'X' for TWO datetypes,
// 'Inspection Ready' (4,772 rows) and 'Snap and Trim' (580), so every
// Inspection Ready completion fires lp-milestone-snap-trim. Neither is a
// customer-facing beat, so this is a reporting defect; fixing it needs the
// map keyed on mdt_id + datetype AND the (lp_job_id, mdt_id) conflict key
// widened. Tracked separately.
export const MDT_TAG_MAP = {
  R: 'lp-milestone-rtp',          M: 'lp-milestone-measure',
  O: 'lp-milestone-quoted',       H: 'lp-milestone-hoa-approved',
  K: 'lp-milestone-ordered',      U: 'lp-milestone-permit-submit',
  P: 'lp-milestone-permit-issued', V: 'lp-milestone-recv-windows',
  E: 'lp-milestone-recv-doors',   G: 'lp-milestone-recv-all',
  S: 'lp-milestone-install-start', F: 'lp-milestone-install-end',
  C: 'lp-milestone-completion',   I: 'lp-milestone-insp-set',
  B: 'lp-milestone-insp-passed',  X: 'lp-milestone-snap-trim',
};

// ─── Batch existence check helper ────────────────────────────────
// Returns a Set of IDs that already exist in the table.
async function getExistingIds(table, idColumn, ids) {
  if (ids.length === 0) return new Set();
  try {
    // Supabase IN filter has a practical limit; chunk if needed
    const chunks = [];
    for (let i = 0; i < ids.length; i += 500) {
      chunks.push(ids.slice(i, i + 500));
    }
    const allIds = new Set();
    for (const chunk of chunks) {
      const { data } = await supabase.from(table)
        .select(idColumn)
        .in(idColumn, chunk);
      if (data) data.forEach(row => allIds.add(row[idColumn]));
    }
    return allIds;
  } catch (err) {
    console.warn(`[Sync] Batch existence check failed on ${table}:`, err.message);
    return new Set(); // Fall through to upsert all
  }
}

// ─── Call Log Sync ───────────────────────────────────────────────
// v7.0: Batch check existing IDs, only INSERT new records.
// Call logs are immutable once created in LP — no need to update existing rows.
export async function syncCallLogs(lpLeadId, ghlContactId, calls) {
  if (calls.length === 0) return;
  if (!loggedFirstKeys.has('call')) {
    loggedFirstKeys.add('call');
    console.log('[Sync] Call record keys:', Object.keys(calls[0]).join(', '));
  }

  // Build all call IDs first
  const callEntries = calls.map(call => {
    const callDatetime = getField(call, 'calldatetime', 'calldate', 'CallDate', 'date', 'call_date');
    const callId = String(getField(call, 'id', 'call_id', 'CallID') || `${lpLeadId}-${callDatetime || ''}-${getField(call, 'agent', 'agentname') || Math.random()}`);
    return { call, callId, callDatetime };
  });

  // Batch check which already exist
  const existingIds = await getExistingIds('lp_call_logs', 'lp_call_id', callEntries.map(e => e.callId));

  // ─── Batched write path (perf/batch-child-sync) ──────────────────
  // Was one upsert round-trip PER call. pg_stat_statements logged 526,545
  // single-row INSERTs into lp_call_logs at 23.0ms mean (12,088s total) over
  // 1,386 tracked hours. Same shape as the #512-perf milestone path below: build
  // the rows, one bulk upsert, per-row fallback so a single bad row cannot drop
  // the lead's whole call history.
  //
  // raw_lp_data is NOT written. The v7.0 header above has claimed it was removed
  // since v7.0; it never was, and that payload is the bulk of the 23ms. Nothing
  // reads lp_call_logs.raw_lp_data — get_lead_summary / get_call_history project
  // LP_CALL_COLUMNS (tools/lead-tools.js), which excludes it for the same TOAST
  // cost. Omitting the key also leaves it out of the ON CONFLICT SET list, so
  // existing rows keep the payload they already have.
  //
  // Keyed by lp_call_id, last occurrence wins — the same dedupe decisionByMdt
  // does for milestones. A conflict key repeated inside ONE bulk upsert is a hard
  // Postgres error (21000, "ON CONFLICT DO UPDATE command cannot affect row a
  // second time") that fails the WHOLE batch; the per-row loop was immune to it.
  const callRowsById = new Map();
  for (const { call, callId, callDatetime } of callEntries) {
    if (existingIds.has(callId)) {
      _childSkips.calls++;
      continue;
    }
    callRowsById.set(callId, {
      lp_call_id:        callId,
      lp_lead_id:        lpLeadId,
      // OMITTED, not nulled — the same treatment lp_jobs got in #784 and
      // lp_job_milestones in its child follow-up. This path is insert-only
      // today (the existingIds guard above `continue`s on a known call id), so
      // the null could not yet clobber a stored link — but the identical
      // literal on lp_notes DID, once its skip became conditional on a note
      // edit. Measured 2026-09-18: 236,961 lp_call_logs rows sit NULL against a
      // linked parent lead, every one of them written by this literal at INSERT
      // time before the lead was resolved. Omitting the key is what lets
      // scripts/backfill-ghl-link-propagate.js drain them and keep them drained.
      ...(ghlContactId ? { ghl_contact_id: ghlContactId } : {}),
      call_date:         lpDateToEastern(callDatetime),
      call_duration_sec: getField(call, 'duration', 'Duration', 'call_duration', 'callduration'),
      call_result:       getField(call, 'resultcode', 'ResultCode', 'resultdescr', 'result'),
      call_direction:    getField(call, 'calltype', 'CallType', 'calltypedescr', 'direction'),
      rep_id:            getField(call, 'agent', 'emp_id', 'EmpID', 'empid', 'rep_id'),
      rep_name:          getField(call, 'agentname', 'AgentName', 'rep_name', 'agent_name'),
      call_notes:        getField(call, 'notes', 'Notes', 'note', 'call_notes', 'CallNotes'),
      recording_url:     getField(call, 'recording_url', 'RecordingURL', 'recordingurl', 'recording'),
      synced_at:         new Date().toISOString(),
    });
  }
  const callRows = [...callRowsById.values()];

  let newCount = 0;
  if (callRows.length) {
    const { error: bulkErr } = await supabase.from('lp_call_logs')
      .upsert(callRows, { onConflict: 'lp_call_id' });
    if (bulkErr) {
      console.warn(`[Sync] Call bulk upsert failed for lead ${lpLeadId} (${bulkErr.message}) — falling back to per-row`);
      for (const row of callRows) {
        try {
          const { error } = await supabase.from('lp_call_logs')
            .upsert(row, { onConflict: 'lp_call_id' });
          if (error) console.warn(`[Sync] Call upsert failed for ${row.lp_call_id}:`, error.message);
          else newCount++;
        } catch (err) {
          console.warn(`[Sync] Call upsert failed for ${row.lp_call_id}:`, err.message);
        }
      }
    } else {
      newCount = callRows.length;
    }
  }

  // Only update aggregates if we actually inserted new calls
  //
  // These stay as DB reads. perf/batch-child-sync briefly derived them from the
  // LP payload on the premise that `calls` is the prospect's COMPLETE call list.
  // It is not: LP's getLead returns a ROLLING ~7-DAY WINDOW. Measured on lead
  // 563286 immediately after that deploy — 36 distinct calls on file spanning
  // 2026-06-26..2026-08-01, of which exactly 9 fell in the last 7 days, and the
  // payload-derived call_count wrote 9. Every lead whose history outruns the
  // window would have had call_count silently truncated on each sync, and worse
  // as it aged. Post-deploy mismatch rate was 1/64 leads vs 0/182 before.
  //
  // last_contact_date is re-read for the same reason: it is only safe to take
  // from the payload if the payload is complete, and it isn't. The batching above
  // is where this branch's I/O win actually comes from; these two reads are per
  // lead only when new calls landed. Collapsing them into ONE round-trip needs a
  // server-side aggregate (an RPC returning count + max in a single statement) —
  // a schema change, deliberately not folded in here.
  if (newCount > 0) {
    try {
      const { count } = await supabase.from('lp_call_logs')
        .select('*', { count: 'exact', head: true }).eq('lp_lead_id', lpLeadId);
      const { data: latest } = await supabase.from('lp_call_logs')
        .select('call_date').eq('lp_lead_id', lpLeadId)
        .not('call_date', 'is', null)
        .order('call_date', { ascending: false }).limit(1).single();
      await supabase.from('lp_leads').update({
        call_count: count || 0,
        last_contact_date: latest?.call_date || null,
      }).eq('lp_lead_id', lpLeadId);
    } catch (err) {
      console.warn(`[Sync] Failed to update call aggregates for lead ${lpLeadId}:`, err.message);
    }
  }
}

// ─── Notes Sync ──────────────────────────────────────────────────
// v7.0: Batch check existing IDs, only INSERT new records.
// Notes are immutable once created in LP.
export async function syncNotes(lpLeadId, ghlContactId, notes) {
  if (notes.length === 0) return;
  if (!loggedFirstKeys.has('note')) {
    loggedFirstKeys.add('note');
    console.log('[Sync] Note record keys:', Object.keys(notes[0]).join(', '));
  }

  const noteEntries = notes.map(note => {
    const noteId = String(getField(note, 'id', 'note_id', 'NoteID') || `${lpLeadId}-${getField(note, 'date', 'Date', 'enteredon') || Math.random()}`);
    return { note, noteId };
  });

  const existingIds = await getExistingIds('lp_notes', 'lp_note_id', noteEntries.map(e => e.noteId));

  // Load the comparable columns for rows that already exist, so an EDITED note
  // can be detected. One read per lead, only for ids already on file, and only
  // when the mode is on — off by default this block does nothing.
  const existingNotes = new Map();
  const nMode = noteEditMode();
  if (nMode !== 'off' && existingIds.size > 0) {
    const ids = noteEntries.map(e => e.noteId).filter(id => existingIds.has(id));
    for (let i = 0; i < ids.length; i += 500) {
      const { data, error } = await supabase.from('lp_notes')
        .select(`lp_note_id, ${NOTE_COMPARE_COLUMNS.join(', ')}`)
        .in('lp_note_id', ids.slice(i, i + 500));
      // Fail OPEN: a failed read means we cannot prove an edit, so leave the
      // rows alone. Treating an empty result as "no stored note" would rewrite
      // every note on the lead from the payload — far worse than a missed edit.
      if (error) {
        console.warn(`[Sync] note edit read failed for lead ${lpLeadId}: ${error.message} — edit detection skipped this pass`);
        existingNotes.clear();
        break;
      }
      for (const r of data || []) existingNotes.set(r.lp_note_id, r);
    }
  }

  // 2026-07-29 echo-loop fix. A note the GHL→LP pipeline wrote onto the LP
  // prospect comes back to us here; without this stamp pushNotesToGHL sends it
  // straight back to the GHL contact it came from, wrapped in a "📋 LP Note"
  // header that defeats addGHLNote's body-match dedup. Classify once, at
  // ingest, so the push filter is a plain indexed equality.
  //
  // BOTH prefixes are matched on purpose: rows written before Task F carry the
  // legacy "[AI BRIEF", rows after carry "[GHL · AI BRIEF". "** IMPORTANT **"
  // is prepended by writeLpNote for landmine notes.
  const noteOriginOf = (body) => {
    const b = String(body || '').replace(/^\*\* IMPORTANT \*\*\s*/, '');
    return /^\[(?:GHL · )?AI BRIEF · /.test(b) ? 'ghl_ai_brief' : 'lp';
  };

  // Batched (perf/batch-child-sync) — was one round-trip per note. Deduped by
  // lp_note_id, last occurrence wins: the id fallback above is
  // `${lpLeadId}-${date}` with no per-note discriminator, so two same-dated notes
  // that carry no LP id collide, and a repeated conflict key inside one bulk
  // upsert fails the whole batch with Postgres 21000.
  //
  // raw_lp_data is RETAINED here, unlike calls and activities: the v7.0 removal
  // note never covered lp_notes, and the note pipeline is the one consumer that
  // may still want the original LP payload.
  const noteRowsById = new Map();
  for (const { note, noteId } of noteEntries) {
    const noteBody = getField(note, 'note', 'notes', 'Notes', 'body', 'text', 'note_body', 'NoteBody', 'content', 'Content');
    if (existingIds.has(noteId)) {
      const stored = existingNotes.get(noteId);
      const edited = stored && (
        String(stored.note_body ?? '') !== String(noteBody ?? '')
        || String(stored.note_type ?? '') !== String(getField(note, 'rectype', 'RecType', 'type', 'note_type') ?? '')
      );
      if (!edited) { _childSkips.notes++; continue; }
      console.log(`[Sync] NOTE EDIT (${nMode}) ${noteId} on lead ${lpLeadId}: body changed in LP`);
      if (nMode !== 'enforce') { _childSkips.notes++; continue; }
      // falls through to the row build below, which upserts on lp_note_id
    }
    noteRowsById.set(noteId, {
      lp_note_id:          noteId,
      lp_lead_id:          lpLeadId,
      // OMITTED, not nulled. THE LAST INSTANCE OF THE #784 BUG, found
      // 2026-09-18 while repairing the P2 link gap.
      //
      // Unlike lp_call_logs above, this path is NOT insert-only: the note-edit
      // branch a few lines up deliberately falls THROUGH to this row build when
      // LP's note body changed and nMode === 'enforce'. That re-upserts on
      // lp_note_id with whatever ghlContactId the caller happens to hold — and
      // syncAllChildRecords calls syncNotes with a null contact for every lead
      // it could not resolve, so an edited note erased a link that was already
      // correct. Measured 2026-09-18: 27,349 lp_notes rows NULL against a
      // linked parent lead, versus 0 for lp_jobs and 0 for lp_job_milestones —
      // those two were fixed and drained, these were never covered.
      //
      // Uniform key set across the bulk-upserted array still holds:
      // ghlContactId is one parameter for the whole call, so every object in
      // noteRows either carries the key or none of them does.
      ...(ghlContactId ? { ghl_contact_id: ghlContactId } : {}),
      note_origin:         noteOriginOf(noteBody),
      note_body:           noteBody,
      note_type:           getField(note, 'rectype', 'RecType', 'type', 'note_type'),
      note_category:       getField(note, 'category', 'Category'),
      created_by_rep_name: getField(note, 'enteredby', 'EnteredBy', 'rep_name', 'entered_by'),
      created_by_rep_id:   getField(note, 'rep_id', 'agent', 'emp_id', 'EmpID'),
      created_at_lp:       lpDateToEastern(getField(note, 'date', 'Date', 'enteredon', 'EnteredOn', 'created_at')),
      synced_at:           new Date().toISOString(),
      ...verifiedStamp(VERIFIED_FROM.LP),
      raw_lp_data:         note,
    });
  }
  const noteRows = [...noteRowsById.values()];

  if (noteRows.length) {
    const { error: bulkErr } = await supabase.from('lp_notes')
      .upsert(noteRows, { onConflict: 'lp_note_id' });
    if (bulkErr) {
      console.warn(`[Sync] Note bulk upsert failed for lead ${lpLeadId} (${bulkErr.message}) — falling back to per-row`);
      for (const row of noteRows) {
        try {
          const { error } = await supabase.from('lp_notes')
            .upsert(row, { onConflict: 'lp_note_id' });
          if (error) console.warn(`[Sync] Note upsert failed for ${row.lp_note_id}:`, error.message);
        } catch (err) {
          console.warn(`[Sync] Note upsert failed for ${row.lp_note_id}:`, err.message);
        }
      }
    }
  }
}

// ─── Activity Sync — synthesize from calls + notes ───────────────
// v7.0: Batch check existing IDs, only INSERT new activities.
// Activities are derived/immutable.
export async function syncActivities(lpLeadId, calls, notes) {
  if (calls.length === 0 && notes.length === 0) return;

  // Build all activity IDs
  const activityEntries = [];
  for (const call of calls) {
    const callDatetime = getField(call, 'calldatetime', 'calldate', 'CallDate', 'date', 'call_date');
    const activityId = `call-${lpLeadId}-${callDatetime || ''}-${getField(call, 'agent', 'agentname') || ''}`;
    activityEntries.push({ type: 'call', source: call, activityId, date: callDatetime });
  }
  for (const note of notes) {
    const noteDate = getField(note, 'date', 'Date', 'enteredon', 'EnteredOn', 'created_at');
    const noteId = `note-${lpLeadId}-${noteDate || ''}-${getField(note, 'enteredby', 'EnteredBy') || ''}`;
    activityEntries.push({ type: 'note', source: note, activityId: noteId, date: noteDate });
  }

  const existingIds = await getExistingIds('lp_activities', 'lp_activity_id', activityEntries.map(e => e.activityId));

  // Batched (perf/batch-child-sync). Highest-volume writer in the sync:
  // 1,059,937 single-row INSERTs at 11.1ms mean (11,743s) over 1,386 hours.
  //
  // The dedupe matters MORE here than on calls or notes. lp_activity_id is
  // synthesized as `call-${lead}-${date}-${agent}` / `note-${lead}-${date}-${by}`,
  // so two calls placed at the same datetime by the same agent produce ONE key
  // even though their lp_call_ids differ. Repeated inside a single bulk upsert
  // that is Postgres 21000 ("ON CONFLICT DO UPDATE command cannot affect row a
  // second time") and the whole batch fails. Last occurrence wins, matching the
  // sequential order the per-row loop used to leave behind.
  //
  // raw_lp_data dropped, per the v7.0 header's stated intent — activities are
  // SYNTHESIZED from calls and notes, both of which are stored in their own
  // tables, so the payload here was a third copy of data already persisted twice.
  // Existing rows are untouched.
  const activityRowsById = new Map();
  for (const entry of activityEntries) {
    if (existingIds.has(entry.activityId)) {
      _childSkips.activities++;
      continue;
    }
    if (entry.type === 'call') {
      const call = entry.source;
      activityRowsById.set(entry.activityId, {
        lp_activity_id:  entry.activityId,
        lp_lead_id:      lpLeadId,
        activity_type:   'call',
        activity_detail: getField(call, 'resultdescr', 'resultcode', 'ResultCode', 'result') || 'Call logged',
        rep_id:          getField(call, 'agent', 'emp_id', 'EmpID', 'empid', 'rep_id'),
        rep_name:        getField(call, 'agentname', 'AgentName', 'rep_name', 'agent_name'),
        activity_date:   lpDateToEastern(entry.date),
        synced_at:       new Date().toISOString(),
      });
    } else {
      const note = entry.source;
      activityRowsById.set(entry.activityId, {
        lp_activity_id:  entry.activityId,
        lp_lead_id:      lpLeadId,
        activity_type:   getField(note, 'rectype', 'RecType', 'type', 'note_type') || 'note',
        activity_detail: (getField(note, 'note', 'notes', 'Notes', 'body', 'text') || '').slice(0, 500),
        rep_id:          null,
        rep_name:        getField(note, 'enteredby', 'EnteredBy', 'rep_name', 'entered_by'),
        activity_date:   lpDateToEastern(entry.date),
        synced_at:       new Date().toISOString(),
      });
    }
  }
  const activityRows = [...activityRowsById.values()];

  if (activityRows.length) {
    const { error: bulkErr } = await supabase.from('lp_activities')
      .upsert(activityRows, { onConflict: 'lp_activity_id' });
    if (bulkErr) {
      // Activities are derived and non-critical, so the fallback stays silent
      // per-row as before rather than escalating.
      for (const row of activityRows) {
        try {
          await supabase.from('lp_activities').upsert(row, { onConflict: 'lp_activity_id' });
        } catch (err) { /* Non-critical */ }
      }
    }
  }
}

// ─── Job + Milestone Sync ────────────────────────────────────────
// Jobs are mutable (status changes) so we keep full upsert, but
// milestones use existence check since they're append-only.
// v7.1: Emits lp.milestone_completed events when milestone tags fire.
//
// opts.suppressSideEffects (#512): upsert lp_jobs + lp_job_milestones but SKIP
//   the GHL milestone tag (applyGHLTag) and the lp.milestone_completed event.
//   Used by the one-shot RTP job-axis backfill: hydrating historical jobs would
//   otherwise retroactively fire a burst of milestone tags/events for
//   completions from weeks-to-months ago on already-sold contacts. Default
//   false — all normal sync callers keep firing exactly as before. Suppression
//   pre-marks EVERY first-time completion (linked or not) so the milestones.js
//   sweeper can never fire it on a later sync — see the block comment below.
// Returns { suppressedFires, suppressedUnlinked } — first-time completions whose
//   tag/event was suppressed, split by whether a GHL contact was linked at write
//   time (0/0 when not suppressing). Feeds the backfill's blast-radius report.
export async function syncJobAndMilestones(job, lpLeadId, ghlContactId, opts = {}) {
  const { suppressSideEffects = false } = opts;
  let suppressedFires = 0;      // suppressed completions on a GHL-LINKED contact
  let suppressedUnlinked = 0;   // suppressed completions with NO contact linked yet
  if (!loggedFirstKeys.has('job')) {
    loggedFirstKeys.add('job');
    console.log('[Sync] Job record keys:', Object.keys(job).join(', '));
  }
  const jobId = String(getField(job, 'id', 'job_id', 'JobID'));

  // Hoisted out of the upsert literal (v7.3) so the milestone event payload
  // below can carry them. The P2 rules need job_value for the opportunity's
  // monetary value and branch_code for market attribution; before this they
  // had to re-query lp_jobs to get either.
  const jobValue = parseFloat(getField(job, 'grossamount', 'GrossAmount', 'gsa', 'GSA') || 0) || null;
  // #512-market: persist the LP branch (revenue-authoritative for market
  // attribution). LP pads the code ('ORL  '), so TRIM + upper. Falls back to
  // brn_id. Null when the job carries no branch (market resolver → zip).
  const branchCode = (getField(job, 'brp_id', 'brn_id', 'BRP_ID', 'BrpId') || '').trim().toUpperCase() || null;

  // The try/catch that used to wrap this was DEAD CODE: supabase-js resolves
  // with { error }, it does not throw. A failed lp_jobs upsert was therefore
  // silent, and the only visible symptom was the milestone bulk upsert failing
  // its FK against a parent row that never landed — which then "fell back to
  // per-row" and failed identically, losing every milestone for the job.
  // Destructure the error, name the violated constraint, and stop: milestone
  // work against a missing parent cannot succeed, so continuing only produces
  // noise that masks this line.
  // mapJobFields (src/lp-job-fields.js) supplies the ten columns that used to sit
  // at 100% null, and replaces the old updated_at_lp line, which read
  // 'lastchangedon' — a key that appears on ZERO job payloads. It returns a SPARSE
  // object: shape-scoped keys (updated_at_lp, financing_company) are omitted when
  // this payload cannot speak to them, so a Shape B sweep cannot blank a value only
  // Shape A carries. Spread it; do not read fixed keys off it.
  //
  // It needs the current row because financing_company is Shape-B-only: without it
  // a Shape A sweep of a known-financed job would find no finance evidence in hand
  // and downgrade the row to whatever its status implied.
  //
  // v7.5: the select was widened from 'financing_company' to every column this
  // upsert can write, so rowIsUnchanged() can gate the write below. The
  // financing_company read is unchanged in purpose — it is still passed into
  // mapJobFields for cross-shape continuity.
  // This read has always failed SILENTLY: `data` comes back null, which is
  // indistinguishable from "no such job", and mapJobFields then loses the
  // financing_company continuity it needs — a Shape A sweep of a known-financed
  // job would quietly downgrade financing_status. Now that the select is wide
  // enough to matter, the failure is named, and a row we could not read is never
  // claimed to be unchanged.
  //
  // Two-step, because RAW_TRACKED_SELECT uses PostgREST's JSON-path projection
  // and nothing else in this codebase does — it is unproven against THIS
  // deployment. If it is rejected, retry with the plain column list: continuity
  // is preserved, only the job-side skip is given up (the milestone skip, which
  // is the 2,111-row bulk of the problem, is untouched), and the warning below
  // says so exactly once per job so it cannot go unnoticed.
  let { data: existingJob, error: existingJobErr } = await supabase.from('lp_jobs')
    .select(`${JOB_COMPARE_COLUMNS}, ${RAW_TRACKED_SELECT}`)
    .eq('lp_job_id', jobId).maybeSingle();
  let rawTrackedReadable = !existingJobErr;
  if (existingJobErr) {
    console.warn(
      `[Sync] lp_jobs read with JSON-path projection failed for job ${jobId} ` +
      `(code=${existingJobErr.code || 'none'} message="${existingJobErr.message}") ` +
      `— retrying without it; job-side skip disabled this pass`,
    );
    ({ data: existingJob, error: existingJobErr } = await supabase.from('lp_jobs')
      .select(JOB_COMPARE_COLUMNS).eq('lp_job_id', jobId).maybeSingle());
  }
  if (existingJobErr) {
    console.warn(
      `[Sync] lp_jobs existence read FAILED for job ${jobId} (lead ${lpLeadId}) — ` +
      `code=${existingJobErr.code || 'none'} message="${existingJobErr.message}" ` +
      `— writing unconditionally this pass`,
    );
  }

  const jobRow = {
    lp_job_id:       jobId,
    lp_lead_id:      lpLeadId,
    // ghl_contact_id is OMITTED, not nulled, when the caller has none. The
    // job-changes sweep calls this with ghlContactId=null for every record
    // (src/sync-engine.js), so writing the null erased the link that the Tier A
    // backfill copies down from lp_leads — measured 2026-08-31: 93 jobs sitting
    // NULL against a linked parent lead, all of them Shape A, zero Shape B. That
    // asymmetry is this code path. Same shape-scoped treatment as updated_at_lp.
    ...(ghlContactId ? { ghl_contact_id: ghlContactId } : {}),
    job_status:      getField(job, 'jobstatus', 'JobStatus', 'job_status'),
    job_value:       jobValue,
    branch_code:     branchCode,
    rep_name:        getField(job, 'salesrepname', 'SalesRepName', 'rep_name'),
    created_at_lp:   lpDateToEastern(getField(job, 'entrydate', 'EntryDate')),
    ...mapJobFields(job, existingJob || {}),
    synced_at:       new Date().toISOString(),
    ...verifiedStamp(VERIFIED_FROM.LP),
    raw_lp_data:     job,
  };

  // v7.5 — skip the write when nothing this payload carries would change. The
  // job-changes sweep re-delivers the same 131 jobs every pass; before this,
  // each one rewrote the row plus its raw_lp_data JSONB.
  //
  // wouldLinkJobNow is the #784 orphan-link fix and MUST bypass the gate: on the
  // pass where a contact first becomes available, the link has to land even if
  // every other column matches. (rowIsUnchanged already returns false in that
  // case — an omitted-vs-populated ghl_contact_id compares unequal — so this is
  // belt-and-braces against a future edit to the comparison, and it is what
  // makes the intent readable at the call site.)
  const wouldLinkJobNow = 'ghl_contact_id' in jobRow && !existingJob?.ghl_contact_id;
  const skipJob = skipUnchangedEnabled()
    && !existingJobErr
    && rawTrackedReadable
    && !wouldLinkJobNow
    && rowIsUnchanged(jobRow, existingJob)
    && rawTrackedUnchanged(job, existingJob);

  let jobErr = null;
  if (skipJob) {
    // A skipped job is a SUCCESS. It must not return jobUpsertError, or
    // runJobChangesSweep would count every quiet job as a failure.
    _childSkips.jobs++;
  } else {
    ({ error: jobErr } = await supabase.from('lp_jobs')
      .upsert(jobRow, { onConflict: 'lp_job_id' }));
  }
  if (jobErr) {
    console.error(
      `[Sync] Job upsert FAILED for job ${jobId} (lead ${lpLeadId}) — ` +
      `code=${jobErr.code || 'none'} message="${jobErr.message}" ` +
      `details="${jobErr.details || ''}" hint="${jobErr.hint || ''}" ` +
      `— skipping milestones for this job (parent row absent)`
    );
    // Return the failure instead of only logging it. This function cannot
    // throw on a failed upsert — supabase-js RESOLVES with { error } — so every
    // caller's try/catch is blind to this path. runJobChangesSweep counted each
    // rejected job as synced and never wrote lp_sync_errors, which is why
    // get_sync_health reported clean sweeps while jobs silently vanished
    // (verified 2026-09-03: jobs 57771 and 58260 absent from lp_jobs, both
    // parents absent from lp_leads, zero rows in lp_sync_errors). Callers that
    // ignore the extra field are unaffected.
    return {
      suppressedFires,
      suppressedUnlinked,
      jobUpsertError: buildJobUpsertError(jobId, lpLeadId, jobErr),
    };
  }

  // ─── lp.job_status_changed (2026-09-18) ──────────────────────────
  // LP job STATUS changes emitted NOTHING until now, so a cancellation in LP
  // never reached GHL and the P2 opportunity stayed open forever — 241 of a
  // 249-job sample of dead LP jobs were still open on 2026-09-18. Milestones
  // have had an event since v7.1; status never did.
  //
  // Emitted AFTER the upsert succeeded, deliberately: the early return above
  // means a failed parent write never gets here, and announcing a transition we
  // did not persist would leave the next pass unable to detect it (the stored
  // status would still be the old one, so it would fire again) — or, worse, make
  // a rule act on a row that does not say what the event says.
  //
  // The prior status costs nothing: existingJob was already read for the skip
  // gate and JOB_COMPARE_COLUMNS already carries job_status. And a real change
  // always defeats that gate, so skipJob can never swallow one.
  //
  // NEVER fails the sync. LP is the source of truth for the job either way, and
  // scripts/reconcile-p2-stages.js is the backstop for anything this drops.
  const statusChange = detectJobStatusChange(existingJob, jobRow);
  if (statusChange) {
    try {
      const res = await emitEvent(buildJobStatusEvent({
        change: statusChange,
        lpJobId: jobId,
        lpLeadId,
        // Three layers, and they nest rather than compete. The job-changes
        // sweep calls this with ghlContactId=null for EVERY record
        // (src/sync-engine.js), so the stored link is the only source there —
        // it is a copy propagated down from lp_leads, and the upsert above
        // OMITS rather than nulls the column precisely so the sweep cannot
        // erase it. When both are null, emitEvent's emit-time binding reads
        // lp_leads itself: resolveEmitContactBinding only runs when no contact
        // id was passed, so this fallback FEEDS that binding rather than
        // masking it — which matters, because 93 jobs sat NULL against a
        // linked parent lead as of 2026-08-31.
        //
        // The one case it cannot fix is a STALE non-null link on the job row
        // disagreeing with lp_leads (a dedupe reassignment). That wins here and
        // the binding never runs. Narrow, and scripts/reconcile-p2-stages.js is
        // the backstop; noted rather than engineered around.
        //
        // All three null is still a true record: the engine records a
        // GHL-targeted action on a contactless event as `skipped` rather than
        // executing it (src/decision-engine.js), so nothing acts on a guess.
        ghlContactId: ghlContactId || existingJob?.ghl_contact_id || null,
        jobValue,
        branchCode,
      }));
      const outcome = classifyJobStatusEmit(res);
      if (outcome === 'dropped_at_intake') {
        // The allowlist in src/services/event-intake-filter.js is default-DROP.
        // If this ever prints, the event_type entry was lost and every
        // P2_JOB_TERMINAL_* rule is dead — silently. Say so loudly.
        console.error(
          `[Sync] lp.job_status_changed DROPPED AT INTAKE for job ${jobId} ` +
          `(${statusChange.old_status} → ${statusChange.new_status}) — ` +
          'add it to ALLOWED_EVENT_TYPES in src/services/event-intake-filter.js',
        );
      } else {
        console.log(
          `[Sync] lp.job_status_changed job ${jobId}: ` +
          `"${statusChange.old_status}" → "${statusChange.new_status}" (${outcome})`,
        );
      }
    } catch (err) {
      console.warn(
        `[Sync] lp.job_status_changed emit FAILED for job ${jobId} ` +
        `(${statusChange.old_status} → ${statusChange.new_status}): ${err.message} — continuing`,
      );
    }
  }

  const milestones = getField(job, 'milestones', 'Milestones') || [];
  if (milestones.length > 0 && !loggedFirstKeys.has('milestone')) {
    loggedFirstKeys.add('milestone');
    console.log('[Sync] Milestone record keys:', Object.keys(milestones[0]).join(', '));
  }

  // ─── Batched write path (#512-perf) ──────────────────────────────
  // Previously this did a SELECT + upsert PER milestone (~2N round-trips per
  // job). At backfill scale (hundreds of thousands of milestones) that dominated
  // wall-clock. Now: ONE read of the job's existing milestones, then ONE bulk
  // upsert. The fire decision is identical, just computed in memory first.
  const existingByMdt = new Map();
  {
    // v7.5: widened from 'mdt_id, act_date, ghl_tag_fired' to every column the
    // built msRow can write, so rowIsUnchanged() has something to compare. The
    // three original columns still drive the FIRE decision, unchanged.
    const { data: existingRows, error: existingMsErr } = await supabase.from('lp_job_milestones')
      .select(MILESTONE_COMPARE_COLUMNS).eq('lp_job_id', jobId);
    // A failed read here is NOT "this job has no milestones on file". It has
    // always been treated as one — data comes back null, the map stays empty,
    // and every already-completed milestone then reads as a FIRST completion
    // (isFirstCompletion tests !existing?.act_date), re-firing tags and events
    // for completions that fired weeks ago. Now that the select is wider there
    // is more that can fail, so name it and stop: milestone work this pass is
    // skipped and picked up on the next one, which is strictly safer than a
    // replayed tag burst on a live contact.
    if (existingMsErr) {
      console.error(
        `[Sync] lp_job_milestones read FAILED for job ${jobId} (lead ${lpLeadId}) — ` +
        `code=${existingMsErr.code || 'none'} message="${existingMsErr.message}" ` +
        `— skipping milestone work this pass (an empty map would re-fire settled tags)`,
      );
      return { suppressedFires, suppressedUnlinked, jobUpsertError: null };
    }
    for (const r of existingRows || []) existingByMdt.set(String(r.mdt_id), r);
  }

  // Decide per UNIQUE mdt_id (last occurrence wins). Counting/firing off this
  // deduped map — not the raw milestones loop — is what keeps suppressedFires /
  // suppressedUnlinked honest: a milestones[] array with a repeated datetype
  // would otherwise increment the counter once per occurrence while only one row
  // is written, over-reporting suppressions. #512-counterfix.
  const decisionByMdt = new Map(); // mdt_id -> { msRow, suppress, ghlLinked, fire, tag }
  for (const ms of milestones) {
    const mdtId = getField(ms, 'mdt_id', 'MDT_ID', 'MdtId');
    if (!mdtId) continue;
    const existing = existingByMdt.get(String(mdtId));

    const actDate = getField(ms, 'actdate', 'ActDate', 'act_date');
    const actDateEt = lpDateToEastern(actDate);
    const dateType = getField(ms, 'datetype', 'DateType');
    const tag = MDT_TAG_MAP[mdtId];

    // v7.3 ACHIEVEMENT GATE — act_date alone is NOT a completion.
    // LP is routinely used to record SCHEDULED actuals: the coordinator books
    // the install and stamps act_date with the future date. Measured
    // 2026-08-06: 209 rows carried a future act_date, 56 had already fired,
    // including 6 "Install End" fires for installs ending as late as
    // 2026-12-29 (plus corrupt 2206 / 2046 entries). See src/milestone-gate.js.
    //
    // The row is still WRITTEN with its future act_date — that data is real
    // and reporting wants it. Only the tag + event are held. Because
    // `existing.act_date` will then be non-null on the next sync, this inline
    // path will never re-fire it; processMilestoneTriggers (src/milestones.js)
    // is what picks it up on the day it actually lands. That sweeper carries
    // the same gate, so the two paths cannot disagree.
    const achieved = isMilestoneAchieved(actDateEt);

    // A first-time completion of a tag-mapped milestone fires a GHL tag — here
    // (only when a contact is linked NOW), AND independently via milestones.js
    // processMilestoneTriggers, which sweeps every row with act_date NOT NULL +
    // ghl_tag_fired=false and re-resolves the contact from lp_leads (its Bug-10
    // fallback). So a backfilled completion written UNLINKED (ghl_tag_fired left
    // false) is NOT safe: the sweeper resolves the lead's contact on a LATER
    // sync and fires it — a permanent armed state a scheduler pause can't cover.
    // Therefore suppression must NOT depend on ghlContactId: pre-mark
    // ghl_tag_fired=true IN THIS UPSERT for EVERY first-time completion, linked
    // or not, so no future sweep can ever match the row. tag_suppressed_backfill
    // keeps these distinguishable from genuinely-fired tags (ghl_tag_fired now
    // means "fired OR deliberately suppressed"). #512.
    const isFirstCompletion = !!(actDate && achieved && !existing?.act_date && !existing?.ghl_tag_fired && tag);
    const wouldFire = isFirstCompletion && !!ghlContactId;         // fires only if a contact is linked now
    // 2026-09-21: same stale-fire gate as the sweeper (src/milestone-stale-gate.js).
    // In enforce it rides the existing suppress path, so the row is pre-marked and
    // the sweeper can never fire it later. Counted in suppressedFires/suppressedUnlinked.
    const staleness = isFirstCompletion
      ? staleFireVerdict({ actDate: actDateEt, jobStatus: jobRow.job_status })
      : { stale: false };
    if (staleness.stale && staleFireMode() !== 'off') {
      console.warn(`[Sync] STALE FIRE (${staleFireMode()}) ${tag} job=${jobId} lead=${lpLeadId} reason=${staleness.reason} age=${staleness.ageDays ?? 'n/a'}d`);
    }
    const staleSuppress = staleness.stale && staleFireMode() === 'enforce';
    const suppressThisFire = isFirstCompletion && (suppressSideEffects || staleSuppress); // suppress linked OR unlinked

    const msRow = {
      lp_job_id: jobId, lp_lead_id: lpLeadId,
      // OMITTED, not nulled, when the caller has none — the same treatment the
      // parent lp_jobs row got in #784. That fix covered the parent and left
      // the child: the job-changes sweep calls this with ghlContactId=null for
      // every record, so this literal kept writing null over the link Tier A
      // copies down from lp_leads. Measured 2026-08-31, after #784 deployed:
      // lp_jobs orphaned 96 (frozen), lp_job_milestones orphaned 1,773 (still
      // climbing) — 18x the number that justified the original fix.
      ...(ghlContactId ? { ghl_contact_id: ghlContactId } : {}),
      mdt_id: mdtId,
      datetype:    dateType,
      est_date:    lpDateToEastern(getField(ms, 'estdate', 'EstDate', 'est_date')),
      act_date:    actDateEt,
      entered_by:  getField(ms, 'enteredby', 'EnteredBy', 'entered_by'),
      entered_on:  lpDateToEastern(getField(ms, 'enteredon', 'EnteredOn', 'entered_on')),
      // This literal read 8 of the 10 keys LP sends per milestone, taking
      // enteredby/enteredon and dropping lastchangedby/lastchangedon — which is why
      // both columns were null across all 94,870 rows. Always emits both keys, null
      // included: msRows is bulk-upserted as an ARRAY and PostgREST rejects a batch
      // whose objects do not all carry the same keys.
      ...mapMilestoneChangeFields(ms),
      synced_at:   new Date().toISOString(),
      // Spread, not a bare key: verifiedStamp() returns {} when disabled, and a
      // constant shape when enabled, so every object in this bulk-upserted
      // ARRAY still carries an identical key set (see the note above).
      ...verifiedStamp(VERIFIED_FROM.LP),
    };
    if (suppressThisFire) {
      msRow.ghl_tag_fired = true;             // pre-mark so the sweeper skips it
      msRow.tag_suppressed_backfill = true;   // audit: distinguishable from real fires
      msRow.tag_suppressed_at = new Date().toISOString();
    }

    // Last occurrence wins (matches the old sequential order); the decision is
    // recorded once per mdt_id so counting happens exactly once below.
    decisionByMdt.set(mdtId, {
      msRow, suppress: suppressThisFire, ghlLinked: !!ghlContactId, fire: wouldFire,
      tag, dateType, actDateEt,
    });
  }

  // Materialise the deduped rows + counts + fire list from the decision map.
  //
  // v7.5 — the WRITE is gated here; the FIRE is not. firesToDo is still built
  // from decisionByMdt and never from msRows, so a row that skips its write
  // still fires its tag and emits its event exactly as before. Keep them
  // decoupled: reading the fire list off msRows would silently re-couple them.
  const msRows = [];               // one row per mdt_id for the bulk upsert
  const firesToDo = [];            // non-suppressed first-time completions to fire after the upsert
  const skipUnchanged = skipUnchangedEnabled();
  for (const [mdtId, d] of decisionByMdt) {
    const existing = existingByMdt.get(String(mdtId));
    // NEVER skip a row that is being suppressed — the ghl_tag_fired /
    // tag_suppressed_backfill pre-mark is the whole point of that path, and
    // without it the milestones.js sweeper fires the tag on a later sync (#512).
    // NEVER skip a row that would newly write ghl_contact_id — that is the
    // orphan-link fix (#784 and its child follow-up); skipping freezes the
    // 1,773 orphaned milestone rows in place forever.
    const wouldLinkNow = 'ghl_contact_id' in d.msRow && !existing?.ghl_contact_id;
    if (skipUnchanged && !d.suppress && !wouldLinkNow && rowIsUnchanged(d.msRow, existing)) {
      _childSkips.milestones++;
    } else {
      msRows.push(d.msRow);
    }
    if (d.suppress) {
      if (d.ghlLinked) suppressedFires++; else suppressedUnlinked++;
    } else if (d.fire) {
      firesToDo.push({ mdtId, tag: d.tag, dateType: d.dateType, actDateEt: d.actDateEt });
    }
  }

  if (msRows.length) {
    const { error: bulkErr } = await supabase.from('lp_job_milestones')
      .upsert(msRows, { onConflict: 'lp_job_id, mdt_id', ignoreDuplicates: false });
    if (bulkErr) {
      // Fall back to per-row upserts so one bad row can't drop the whole job's
      // milestones (preserves the pre-batch fault isolation).
      console.warn(`[Sync] Milestone bulk upsert failed for job ${jobId} (${bulkErr.message}) — falling back to per-row`);
      for (const row of msRows) {
        try {
          await supabase.from('lp_job_milestones').upsert(row, { onConflict: 'lp_job_id, mdt_id', ignoreDuplicates: false });
        } catch (err) {
          console.warn(`[Sync] Milestone upsert failed for job ${jobId} mdt ${row.mdt_id}:`, err.message);
        }
      }
    }
  }

  // ─── v7.4 MILESTONE COLLAPSE (2026-08-16) ────────────────────────
  // A returning customer linked for the first time delivers the ENTIRE job
  // history in one pass, and every completion reads as a first completion.
  // Contact PIDxmWzCs35NHgW85vOW replayed 12 milestones (Dec 2024 → Apr
  // 2025) in six seconds, queueing 24 actions that walked the P2 opp
  // through seven stages and left it at Install Scheduled — BEHIND the
  // Referral & Expansion it had already reached. The forward-only guard
  // cannot hold at that rate: GHL's opportunity search returns a stale
  // pipelineStageId under rapid successive writes.
  //
  // TAGS STILL FIRE FOR EVERY MILESTONE. They are the durable record and
  // C.1/C.2 trigger on them (see the P2_MILESTONE_PERMIT_SUBMIT rule note:
  // "C.1 must trigger on lp-milestone-permit-submit, not on
  // pipeline_stage_updated"). Only the EVENT collapses — one
  // lp.milestone_completed for the furthest-along milestone, so exactly one
  // P2 stage move is requested.
  //
  // Real-time progress delivers one milestone per pass, where firesToDo has
  // length 1 and this is a no-op. The collapse only engages on replay.
  const emitMdtId = selectFurthestMilestone(firesToDo);
  const collapsedFrom = firesToDo.map(f => f.mdtId).filter(m => m !== emitMdtId);
  if (collapsedFrom.length > 0) {
    console.log(`[Sync] Milestone collapse: job ${jobId} had ${firesToDo.length} first-time completions — emitting ${emitMdtId || 'NONE'} only; tag-only for [${collapsedFrom.join(', ')}]`);
  }

  // Fire the non-suppressed first-time completions (normal-sync path; EMPTY under
  // suppressSideEffects). Sequential — applyGHLTag is rate-limited.
  for (const { mdtId, tag, dateType, actDateEt } of firesToDo) {
    const success = await applyGHLTag(ghlContactId, tag);
    if (success) {
      await supabase.from('lp_job_milestones')
        .update({ ghl_tag_fired: true }).eq('lp_job_id', jobId).eq('mdt_id', mdtId);
      console.log(`[Sync] Milestone tag fired: ${tag} for contact ${ghlContactId}`);
      // v7.4 collapse gate — tag landed above; only the furthest-along
      // milestone proceeds to the event.
      if (mdtId !== emitMdtId) continue;
      // v7.1: Emit milestone event for P2 lifecycle agent rules
      // v7.3: payload carries datetype (disambiguates the mdt_id 'X' collision),
      //       act_date, job_value and branch_code so the P2 rules can set the
      //       opportunity value and market without a second query.
      try {
        await emitEvent({
          event_type: 'lp.milestone_completed',
          source: 'lp_sync',
          entity_type: 'contact',
          entity_id: ghlContactId,
          ghl_contact_id: ghlContactId,
          payload: {
            mdt_id: mdtId,
            datetype: dateType || null,
            milestone_tag: tag,
            act_date: actDateEt || null,
            job_id: jobId,
            lp_lead_id: lpLeadId,
            job_value: jobValue,
            branch_code: branchCode,
            collapsed_from: collapsedFrom,
            collapsed_count: collapsedFrom.length,
          },
          priority: 'normal',
          idempotency_key: `lp_milestone_${ghlContactId}_${mdtId}_${jobId}`,
        });
      } catch (emitErr) {
        console.warn(`[Sync] Milestone event emit failed for ${ghlContactId} ${mdtId}: ${emitErr.message}`);
      }
    }
  }
  return { suppressedFires, suppressedUnlinked, jobUpsertError: null };
}

// ─── Pass 2 — syncAllChildRecords() ──────────────────────────────
export async function syncAllChildRecords(logIds, counts) {
  let offset = 0;
  const pageSize = 100;
  let totalProcessed = 0;

  while (true) {
    const { data: leads, error } = await supabase.from('lp_leads')
      .select('lp_lead_id, lp_prospect_id, ghl_contact_id, ghl_link_source, ghl_tag_applied, ghl_entry_tag, lp_day15_triggered, created_at_lp')
      .range(offset, offset + pageSize - 1)
      .order('created_at_lp', { ascending: false });
    if (error) throw error;
    if (!leads || leads.length === 0) break;

    for (const lead of leads) {
      try {
        const result = await getLead(lead.lp_prospect_id);
        const prospects = extractArray(result);
        if (!prospects[0]) continue;
        const prospect = prospects[0];
        const matchedGhlId = lead.ghl_contact_id ? null : await (async () => {
          try {
            return await matchToGHL({
              phone: normalizePhone(getField(prospect, 'phone1', 'Phone1', 'phone', 'Phone')),
              phone_alt: normalizePhone(prospect.altphones?.[0]?.phone || getField(prospect, 'Phone2', 'phone2', 'phone_alt')),
              email: getField(prospect, 'email', 'Email'),
            });
          } catch (_) { return null; }
        })();
        const ghlId = lead.ghl_contact_id || matchedGhlId;

        // A link written from a fresh matchToGHL result is phone/email
        // verified by construction — stamp its ghl_link_source accordingly.
        //
        // 2026-07-29: the carried-forward case used to omit ghl_link_source
        // entirely, so a stored link that was never classified stayed NULL
        // forever while this write kept re-asserting the id. A populated
        // ghl_contact_id must never sit next to a NULL source — that is what
        // made the Y21mrJPUGYGKIWFptVpu link untraceable. Floor it at
        // legacy_unverified; the resolver upgrades it on the next lead sync.
        if (ghlId && !lead.ghl_tag_applied && lead.ghl_entry_tag) {
          const success = await applyGHLTag(ghlId, lead.ghl_entry_tag);
          if (success) {
            await supabase.from('lp_leads')
              .update({
                ghl_contact_id: ghlId,
                ghl_tag_applied: true,
                ghl_link_source: matchedGhlId
                  ? 'phone_email_match'
                  : (lead.ghl_link_source || 'legacy_unverified'),
              }).eq('lp_lead_id', lead.lp_lead_id);
          }
        } else if (matchedGhlId && !lead.ghl_contact_id) {
          await supabase.from('lp_leads')
            .update({ ghl_contact_id: matchedGhlId, ghl_link_source: 'phone_email_match' })
            .eq('lp_lead_id', lead.lp_lead_id);
        }

        const prospectLeads = getField(prospect, 'leads', 'Leads') || [];
        const calls = getField(prospect, 'calls', 'Calls') || [];
        for (const lpLead of prospectLeads) {
          const lpLeadId = String(getField(lpLead, 'id', 'lds_id', 'LeadID'));
          const notes = combineNotes(getField(prospect, 'notes', 'Notes'), getField(lpLead, 'notes', 'Notes'));
          const jobs = getField(lpLead, 'jobs', 'Jobs') || [];
          await Promise.all([
            syncCallLogs(lpLeadId, ghlId, calls),
            syncNotes(lpLeadId, ghlId, notes),
            syncActivities(lpLeadId, calls, notes),
            ...jobs.map(job => syncJobAndMilestones(job, lpLeadId, ghlId)),
          ]);
          counts.calls += calls.length;
          counts.notes += notes.length;
          counts.jobs += jobs.length;
          for (const job of jobs) { counts.milestones += (getField(job, 'milestones', 'Milestones') || []).length; }
          counts.activities += calls.length + notes.length;
        }

        if (!lead.lp_day15_triggered && ghlId) {
          const firstLead = prospectLeads[0];
          if (firstLead) {
            const { checkDay15Handoff } = await import('./sync-triggers.js');
            await checkDay15Handoff(lead.lp_lead_id, ghlId,
              getField(firstLead, 'entrydate', 'EntryDate'),
              getField(firstLead, 'disposition', 'Disposition'));
          }
        }
        totalProcessed++;
      } catch (err) {
        console.error(`[Sync P2] Failed lead ${lead.lp_lead_id}:`, err.message);
        await logSyncError(lead.lp_lead_id, err);
      }
      await sleep(200);
    }

    if (logIds) {
      await Promise.all([
        syncLogProgress(logIds.calls, counts.calls),
        syncLogProgress(logIds.notes, counts.notes),
        syncLogProgress(logIds.jobs, counts.jobs),
        syncLogProgress(logIds.milestones, counts.milestones),
        syncLogProgress(logIds.activities, counts.activities),
      ]);
    }
    console.log(`[Sync P2] Processed ${totalProcessed} contacts (offset ${offset})`);
    offset += pageSize;
  }
  console.log(`[Sync P2] Done — ${totalProcessed} contacts fully processed`);
  return totalProcessed;
}
