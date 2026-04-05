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

import supabase from './supabase.js';
import { getField, normalizePhone, extractArray, loggedFirstKeys, sleep } from './sync-utils.js';
import { syncLogProgress, logSyncError } from './sync-log.js';
import { lpDateToEastern } from './lp-dates.js';
import { matchToGHL, applyGHLTag } from './ghl.js';
import { combineNotes } from './safe-notes.js';
import { getLead } from './lp-client.js';

// ─── Skip counter for observability ──────────────────────────────
let _childSkips = { calls: 0, notes: 0, activities: 0 };
export function getChildSkipStats() { const s = { ..._childSkips }; _childSkips = { calls: 0, notes: 0, activities: 0 }; return s; }

// ─── Milestone Tag Map (mdt_id → GHL tag) ────────────────────────
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

  let newCount = 0;
  for (const { call, callId, callDatetime } of callEntries) {
    if (existingIds.has(callId)) {
      _childSkips.calls++;
      continue;
    }
    try {
      await supabase.from('lp_call_logs').upsert({
        lp_call_id:        callId,
        lp_lead_id:        lpLeadId,
        ghl_contact_id:    ghlContactId || null,
        call_date:         lpDateToEastern(callDatetime),
        call_duration_sec: getField(call, 'duration', 'Duration', 'call_duration', 'callduration'),
        call_result:       getField(call, 'resultcode', 'ResultCode', 'resultdescr', 'result'),
        call_direction:    getField(call, 'calltype', 'CallType', 'calltypedescr', 'direction'),
        rep_id:            getField(call, 'agent', 'emp_id', 'EmpID', 'empid', 'rep_id'),
        rep_name:          getField(call, 'agentname', 'AgentName', 'rep_name', 'agent_name'),
        call_notes:        getField(call, 'notes', 'Notes', 'note', 'call_notes', 'CallNotes'),
        recording_url:     getField(call, 'recording_url', 'RecordingURL', 'recordingurl', 'recording'),
        synced_at:         new Date().toISOString(),
        raw_lp_data:       call,
      }, { onConflict: 'lp_call_id' });
      newCount++;
    } catch (err) {
      console.warn(`[Sync] Call upsert failed for ${callId}:`, err.message);
    }
  }

  // Only update aggregates if we actually inserted new calls
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

  for (const { note, noteId } of noteEntries) {
    if (existingIds.has(noteId)) {
      _childSkips.notes++;
      continue;
    }
    try {
      await supabase.from('lp_notes').upsert({
        lp_note_id:          noteId,
        lp_lead_id:          lpLeadId,
        ghl_contact_id:      ghlContactId || null,
        note_body:           getField(note, 'note', 'notes', 'Notes', 'body', 'text', 'note_body', 'NoteBody', 'content', 'Content'),
        note_type:           getField(note, 'rectype', 'RecType', 'type', 'note_type'),
        note_category:       getField(note, 'category', 'Category'),
        created_by_rep_name: getField(note, 'enteredby', 'EnteredBy', 'rep_name', 'entered_by'),
        created_by_rep_id:   getField(note, 'rep_id', 'agent', 'emp_id', 'EmpID'),
        created_at_lp:       lpDateToEastern(getField(note, 'date', 'Date', 'enteredon', 'EnteredOn', 'created_at')),
        synced_at:           new Date().toISOString(),
        raw_lp_data:         note,
      }, { onConflict: 'lp_note_id' });
    } catch (err) {
      console.warn(`[Sync] Note upsert failed for ${noteId}:`, err.message);
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

  for (const entry of activityEntries) {
    if (existingIds.has(entry.activityId)) {
      _childSkips.activities++;
      continue;
    }
    try {
      if (entry.type === 'call') {
        const call = entry.source;
        await supabase.from('lp_activities').upsert({
          lp_activity_id:  entry.activityId,
          lp_lead_id:      lpLeadId,
          activity_type:   'call',
          activity_detail: getField(call, 'resultdescr', 'resultcode', 'ResultCode', 'result') || 'Call logged',
          rep_id:          getField(call, 'agent', 'emp_id', 'EmpID', 'empid', 'rep_id'),
          rep_name:        getField(call, 'agentname', 'AgentName', 'rep_name', 'agent_name'),
          activity_date:   lpDateToEastern(entry.date),
          synced_at:       new Date().toISOString(),
          raw_lp_data:     call,
        }, { onConflict: 'lp_activity_id' });
      } else {
        const note = entry.source;
        await supabase.from('lp_activities').upsert({
          lp_activity_id:  entry.activityId,
          lp_lead_id:      lpLeadId,
          activity_type:   getField(note, 'rectype', 'RecType', 'type', 'note_type') || 'note',
          activity_detail: (getField(note, 'note', 'notes', 'Notes', 'body', 'text') || '').slice(0, 500),
          rep_id:          null,
          rep_name:        getField(note, 'enteredby', 'EnteredBy', 'rep_name', 'entered_by'),
          activity_date:   lpDateToEastern(entry.date),
          synced_at:       new Date().toISOString(),
          raw_lp_data:     note,
        }, { onConflict: 'lp_activity_id' });
      }
    } catch (err) { /* Non-critical */ }
  }
}

// ─── Job + Milestone Sync ────────────────────────────────────────
// Jobs are mutable (status changes) so we keep full upsert, but
// milestones use existence check since they're append-only.
export async function syncJobAndMilestones(job, lpLeadId, ghlContactId) {
  if (!loggedFirstKeys.has('job')) {
    loggedFirstKeys.add('job');
    console.log('[Sync] Job record keys:', Object.keys(job).join(', '));
  }
  const jobId = String(getField(job, 'id', 'job_id', 'JobID'));
  try {
    await supabase.from('lp_jobs').upsert({
      lp_job_id:       jobId,
      lp_lead_id:      lpLeadId,
      ghl_contact_id:  ghlContactId || null,
      job_status:      getField(job, 'jobstatus', 'JobStatus', 'job_status'),
      job_value:       parseFloat(getField(job, 'grossamount', 'GrossAmount', 'gsa', 'GSA') || 0) || null,
      rep_name:        getField(job, 'salesrepname', 'SalesRepName', 'rep_name'),
      created_at_lp:   lpDateToEastern(getField(job, 'entrydate', 'EntryDate')),
      updated_at_lp:   lpDateToEastern(getField(job, 'lastchangedon', 'LastChangedOn')),
      synced_at:       new Date().toISOString(),
      raw_lp_data:     job,
    }, { onConflict: 'lp_job_id' });
  } catch (err) {
    console.warn(`[Sync] Job upsert failed for ${jobId}:`, err.message);
  }

  const milestones = getField(job, 'milestones', 'Milestones') || [];
  if (milestones.length > 0 && !loggedFirstKeys.has('milestone')) {
    loggedFirstKeys.add('milestone');
    console.log('[Sync] Milestone record keys:', Object.keys(milestones[0]).join(', '));
  }

  for (const ms of milestones) {
    const mdtId = getField(ms, 'mdt_id', 'MDT_ID', 'MdtId');
    if (!mdtId) continue;
    const { data: existing } = await supabase.from('lp_job_milestones')
      .select('act_date, ghl_tag_fired').eq('lp_job_id', jobId).eq('mdt_id', mdtId).single();
    try {
      await supabase.from('lp_job_milestones').upsert({
        lp_job_id: jobId, lp_lead_id: lpLeadId, ghl_contact_id: ghlContactId || null,
        mdt_id: mdtId,
        datetype:    getField(ms, 'datetype', 'DateType'),
        est_date:    lpDateToEastern(getField(ms, 'estdate', 'EstDate', 'est_date')),
        act_date:    lpDateToEastern(getField(ms, 'actdate', 'ActDate', 'act_date')),
        entered_by:  getField(ms, 'enteredby', 'EnteredBy', 'entered_by'),
        entered_on:  lpDateToEastern(getField(ms, 'enteredon', 'EnteredOn', 'entered_on')),
        synced_at:   new Date().toISOString(),
      }, { onConflict: 'lp_job_id, mdt_id', ignoreDuplicates: false });
    } catch (err) {
      console.warn(`[Sync] Milestone upsert failed for job ${jobId} mdt ${mdtId}:`, err.message);
      continue;
    }
    const actDate = getField(ms, 'actdate', 'ActDate', 'act_date');
    if (actDate && !existing?.act_date && !existing?.ghl_tag_fired && ghlContactId) {
      const tag = MDT_TAG_MAP[mdtId];
      if (tag) {
        const success = await applyGHLTag(ghlContactId, tag);
        if (success) {
          await supabase.from('lp_job_milestones')
            .update({ ghl_tag_fired: true }).eq('lp_job_id', jobId).eq('mdt_id', mdtId);
          console.log(`[Sync] Milestone tag fired: ${tag} for contact ${ghlContactId}`);
        }
      }
    }
  }
}

// ─── Pass 2 — syncAllChildRecords() ──────────────────────────────
export async function syncAllChildRecords(logIds, counts) {
  let offset = 0;
  const pageSize = 100;
  let totalProcessed = 0;

  while (true) {
    const { data: leads, error } = await supabase.from('lp_leads')
      .select('lp_lead_id, lp_prospect_id, ghl_contact_id, ghl_tag_applied, ghl_entry_tag, lp_day15_triggered, created_at_lp')
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
        const ghlId = lead.ghl_contact_id || await (async () => {
          try {
            return await matchToGHL({
              phone: normalizePhone(getField(prospect, 'phone1', 'Phone1', 'phone', 'Phone')),
              phone_alt: normalizePhone(prospect.altphones?.[0]?.phone || getField(prospect, 'Phone2', 'phone2', 'phone_alt')),
              email: getField(prospect, 'email', 'Email'),
            });
          } catch (_) { return null; }
        })();

        if (ghlId && !lead.ghl_tag_applied && lead.ghl_entry_tag) {
          const success = await applyGHLTag(ghlId, lead.ghl_entry_tag);
          if (success) {
            await supabase.from('lp_leads')
              .update({ ghl_contact_id: ghlId, ghl_tag_applied: true }).eq('lp_lead_id', lead.lp_lead_id);
          }
        } else if (ghlId && !lead.ghl_contact_id) {
          await supabase.from('lp_leads').update({ ghl_contact_id: ghlId }).eq('lp_lead_id', lead.lp_lead_id);
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
