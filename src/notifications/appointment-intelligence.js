/**
 * Appointment Notifications — Hybrid Intelligence Loader
 * src/notifications/appointment-intelligence.js
 *
 * Pulls per-contact LIVE intelligence from LP MCP's internal services
 * and aggregate analytics from Supabase, in parallel, with a 4s total
 * timeout. Returns whatever resolved before the deadline plus a
 * `data_gaps` list naming whichever sources failed or timed out.
 *
 * The "live, in-process service calls" pattern: we read directly from
 * the same underlying libraries the MCP tools (get_decoded_contact,
 * get_lead_summary, get_contact_timeline, get_close_rate_by_source,
 * get_revenue_by_source) wrap — no MCP transport, no HTTP round-trip
 * back to ourselves.
 *
 * Per-contact sources:
 *   decoded_contact  — live GHL fetch + custom field decode
 *   lead_summary     — full LP record + calls + notes + activities
 *   timeline         — unified chronological timeline (last N events)
 *
 * Aggregate sources (skipped when lp_source/lp_subsource is empty):
 *   close_rate       — get_close_rate_by_source RPC, filtered to source/subsource
 *   revenue          — same RPC reused for revenue aggregation
 *
 * Both aggregate calls read from the same Supabase RPC, so we call
 * it ONCE and split the result into two views for the body generator.
 */

import supabase from '../supabase.js';
import { getGHLContact } from '../ghl.js';
import { decodeFields } from '../ghl-field-decoder.js';

const DEFAULT_TIMEOUT_MS = parseInt(
  process.env.APPT_NOTIFICATION_CONTEXT_TIMEOUT_MS || '4000',
  10
);
const TIMELINE_LIMIT = 10;

/**
 * Race a promise against a timeout that rejects with a tagged error so
 * the caller can distinguish "this source timed out" from "this source
 * threw." Both are surfaced as data_gaps; the tag tells us which.
 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout:${label}`)), ms),
    ),
  ]);
}

/**
 * Live GHL contact + decoded custom fields. Equivalent to the
 * get_decoded_contact MCP tool's happy path, but returns a plain JS
 * object instead of an MCP content envelope.
 */
async function loadDecodedContact(contactId) {
  const contact = await getGHLContact(contactId);
  if (!contact) {
    throw new Error('contact_not_found_or_fetch_failed');
  }
  const rawFields = Array.isArray(contact.customFields) ? contact.customFields : [];
  const grouped = decodeFields(rawFields);
  return {
    profile: {
      id: contact.id,
      name:
        contact.contactName ||
        `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
      first_name: contact.firstName,
      last_name: contact.lastName,
      phone: contact.phone,
      email: contact.email,
      address: contact.address1,
      city: contact.city,
      state: contact.state,
      postal_code: contact.postalCode,
      assigned_to: contact.assignedTo,
      source: contact.source,
      type: contact.type,
      date_added: contact.dateAdded,
      tags: contact.tags || [],
      dnd: contact.dnd,
    },
    custom_fields: grouped,
  };
}

/**
 * LP record + recent calls + recent notes + recent activities for one
 * GHL contact. Joins via lp_leads.ghl_contact_id (one prospect may
 * have multiple lp_leads — we pick the most recent).
 */
async function loadLeadSummary(contactId) {
  const { data: leads, error: leadsErr } = await supabase
    .from('lp_leads')
    .select(
      'lp_lead_id, lp_prospect_id, first_name, last_name, phone, email, ' +
        'lead_source, lead_source_detail, disposition_code, disposition_label, ' +
        'rep_name, appointment_set, appointment_date, demo_completed, demo_date, ' +
        'closed_won, job_value, call_count, last_contact_date, created_at_lp',
    )
    .eq('ghl_contact_id', contactId)
    .order('created_at_lp', { ascending: false })
    .limit(5);

  if (leadsErr) throw new Error(`lp_leads:${leadsErr.message}`);
  if (!leads || leads.length === 0) return { lead: null, recent: { calls: [], notes: [], activities: [] } };

  const primary = leads[0];
  const leadIds = leads.map(l => l.lp_lead_id);

  const [calls, notes, activities] = await Promise.all([
    supabase
      .from('lp_call_logs')
      .select('lp_lead_id, call_date, outcome, duration, rep_name, call_type, notes')
      .in('lp_lead_id', leadIds)
      .order('call_date', { ascending: false })
      .limit(10),
    supabase
      .from('lp_notes')
      .select('lp_lead_id, created_at_lp, note_body, body, rep_name')
      .in('lp_lead_id', leadIds)
      .order('created_at_lp', { ascending: false })
      .limit(10),
    supabase
      .from('lp_activities')
      .select('lp_lead_id, activity_date, activity_type, notes')
      .in('lp_lead_id', leadIds)
      .order('activity_date', { ascending: false })
      .limit(10),
  ]);

  return {
    lead: primary,
    all_leads: leads,
    recent: {
      calls: calls.data || [],
      notes: notes.data || [],
      activities: activities.data || [],
    },
  };
}

/**
 * Unified chronological timeline across LP records + system events +
 * agent actions, capped at TIMELINE_LIMIT.
 *
 * Mirrors the synthesis logic from src/tools/intel-tools.js
 * get_contact_timeline, but returns just the top N items so the LLM
 * prompt stays tight.
 */
async function loadContactTimeline(contactId) {
  // ─── Resolve lp_lead_ids for this contact ──────────────────────
  const { data: leadRows } = await supabase
    .from('lp_leads')
    .select('lp_lead_id')
    .eq('ghl_contact_id', contactId);
  const leadIds = (leadRows || []).map(r => r.lp_lead_id);

  const events = [];

  if (leadIds.length) {
    const [calls, notes, activities] = await Promise.all([
      supabase
        .from('lp_call_logs')
        .select('lp_lead_id, call_date, outcome, duration, rep_name, call_type')
        .in('lp_lead_id', leadIds)
        .order('call_date', { ascending: false })
        .limit(TIMELINE_LIMIT),
      supabase
        .from('lp_notes')
        .select('lp_lead_id, created_at_lp, note_body, body, rep_name')
        .in('lp_lead_id', leadIds)
        .order('created_at_lp', { ascending: false })
        .limit(TIMELINE_LIMIT),
      supabase
        .from('lp_activities')
        .select('lp_lead_id, activity_date, activity_type')
        .in('lp_lead_id', leadIds)
        .order('activity_date', { ascending: false })
        .limit(TIMELINE_LIMIT),
    ]);

    for (const row of calls.data || []) {
      const dur = row.duration ? ` (${row.duration}s)` : '';
      events.push({
        ts: row.call_date,
        type: 'call',
        summary: `Call: ${row.outcome || row.call_type || 'no outcome'}${dur}`,
        rep: row.rep_name,
      });
    }
    for (const row of notes.data || []) {
      const body = String(row.note_body || row.body || '').trim();
      events.push({
        ts: row.created_at_lp,
        type: 'note',
        summary: `Note: ${body.slice(0, 120)}${body.length > 120 ? '…' : ''}`,
        rep: row.rep_name,
      });
    }
    for (const row of activities.data || []) {
      events.push({
        ts: row.activity_date,
        type: 'activity',
        summary: `Activity: ${row.activity_type || 'unknown'}`,
      });
    }
  }

  // ─── System events keyed off ghl_contact_id ────────────────────
  const { data: sysEvents } = await supabase
    .from('system_events')
    .select('event_type, event_subtype, event_timestamp, created_at, action_taken')
    .eq('ghl_contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(TIMELINE_LIMIT);

  for (const row of sysEvents || []) {
    events.push({
      ts: row.event_timestamp || row.created_at,
      type: `event:${row.event_type}`,
      summary: `${row.event_type}${row.event_subtype ? ` (${row.event_subtype})` : ''}${row.action_taken ? ` — ${row.action_taken}` : ''}`,
    });
  }

  return events
    .filter(e => e.ts)
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
    .slice(0, TIMELINE_LIMIT);
}

/**
 * Filter the get_close_rate_by_source RPC results to the requested
 * source/subsource. The RPC returns all sources × buckets; we pick the
 * row(s) that match. lp_subsource is the more specific filter
 * (sourcesubdescr in LP's vocabulary), lp_source is the broader bucket.
 */
async function loadSourceAnalytics(lp_source, lp_subsource) {
  if (!lp_source && !lp_subsource) return null;

  const { data, error } = await supabase.rpc('get_close_rate_by_source');
  if (error) throw new Error(`close_rate_rpc:${error.message}`);

  const rows = Array.isArray(data) ? data : [];
  const matchSub = lp_subsource
    ? rows.find(r =>
        String(r.sourcesubdescr || r.source_subdescr || '').trim().toLowerCase() ===
        String(lp_subsource).trim().toLowerCase(),
      )
    : null;
  const matchSrc = lp_source
    ? rows.find(r =>
        String(r.source || r.ghl_bucket || '').trim().toLowerCase() ===
        String(lp_source).trim().toLowerCase(),
      )
    : null;
  const best = matchSub || matchSrc;
  if (!best) return null;

  const totalLeads = Number(best.total_leads ?? best.lead_count ?? 0);
  const closedWon = Number(best.closed_won_count ?? best.closed_won ?? 0);
  const totalRevenue = Number(best.total_revenue ?? 0);
  const closeRatePct =
    totalLeads > 0 ? Math.round((closedWon / totalLeads) * 1000) / 10 : null;

  return {
    matched_on: matchSub ? 'subsource' : 'source',
    source: best.source || best.ghl_bucket || lp_source,
    subsource: best.sourcesubdescr || best.source_subdescr || lp_subsource,
    total_leads: totalLeads,
    closed_won: closedWon,
    close_rate_pct: closeRatePct,
    total_revenue: totalRevenue,
  };
}

/**
 * Main entrypoint.
 *
 * Runs all sources in parallel with a 4s total cap. Any source that
 * fails or times out is dropped from the returned context and named in
 * data_gaps so the body generator can surface "(intel unavailable)"
 * in the right slot.
 */
export async function loadAppointmentContext({
  contact_id,
  lp_source,
  lp_subsource,
  timeout_ms = DEFAULT_TIMEOUT_MS,
  _deps,
}) {
  if (!contact_id) {
    throw new Error('loadAppointmentContext: contact_id required');
  }

  // Dependency injection for tests; production callers omit _deps and
  // the module-scope loaders are used directly.
  const loaders = {
    loadDecodedContact: _deps?.loadDecodedContact || loadDecodedContact,
    loadLeadSummary: _deps?.loadLeadSummary || loadLeadSummary,
    loadContactTimeline: _deps?.loadContactTimeline || loadContactTimeline,
    loadSourceAnalytics: _deps?.loadSourceAnalytics || loadSourceAnalytics,
  };

  const data_gaps = [];

  const sourceIntelEnabled = Boolean(
    (lp_source && String(lp_source).trim()) ||
      (lp_subsource && String(lp_subsource).trim()),
  );
  if (!sourceIntelEnabled) {
    data_gaps.push('source_intel_unavailable:empty_lp_source');
  }

  const tasks = [
    withTimeout(loaders.loadDecodedContact(contact_id), timeout_ms, 'decoded_contact')
      .then(v => ({ kind: 'decoded_contact', value: v }))
      .catch(err => ({ kind: 'decoded_contact', error: err.message })),

    withTimeout(loaders.loadLeadSummary(contact_id), timeout_ms, 'lead_summary')
      .then(v => ({ kind: 'lead_summary', value: v }))
      .catch(err => ({ kind: 'lead_summary', error: err.message })),

    withTimeout(loaders.loadContactTimeline(contact_id), timeout_ms, 'timeline')
      .then(v => ({ kind: 'timeline', value: v }))
      .catch(err => ({ kind: 'timeline', error: err.message })),
  ];

  if (sourceIntelEnabled) {
    tasks.push(
      withTimeout(
        loaders.loadSourceAnalytics(lp_source, lp_subsource),
        timeout_ms,
        'source_analytics',
      )
        .then(v => ({ kind: 'source_analytics', value: v }))
        .catch(err => ({ kind: 'source_analytics', error: err.message })),
    );
  }

  const results = await Promise.all(tasks);

  const ctx = {
    decoded_contact: null,
    lead_summary: null,
    timeline: [],
    source_analytics: null,
    data_gaps,
  };

  for (const r of results) {
    if (r.error) {
      ctx.data_gaps.push(`${r.kind}:${r.error}`);
      continue;
    }
    ctx[r.kind] = r.value ?? null;
  }

  // ─── Effective source resolution with LP fallback ──────────────
  // Payload `lp_source`/`lp_subsource` come from GHL merge tags and
  // are sometimes empty even when the LP record has a known source.
  // When both payload fields are empty AND the LP record carries a
  // `lead_source`, fall back to it and retry the close-rate aggregate
  // using the resolved value.
  const payloadSource = String(lp_source || '').trim();
  const payloadSubsource = String(lp_subsource || '').trim();
  let effective_source = payloadSource || null;
  let effective_subsource = payloadSubsource || null;

  if (!payloadSource && !payloadSubsource) {
    const lpSource = String(ctx.lead_summary?.lead?.lead_source || '').trim();
    const lpSubsource = String(ctx.lead_summary?.lead?.lead_source_detail || '').trim();
    if (lpSource) {
      effective_source = lpSource;
      effective_subsource = lpSubsource || null;
      ctx.data_gaps.push('source_resolved_from:lp_fallback');

      if (!ctx.source_analytics) {
        try {
          const retried = await withTimeout(
            loaders.loadSourceAnalytics(effective_source, effective_subsource),
            1500,
            'source_analytics_retry',
          );
          ctx.source_analytics = retried ?? null;
        } catch (err) {
          ctx.data_gaps.push(`source_analytics_retry:${err.message}`);
        }
      }
    }
  }

  ctx.effective_source = effective_source;
  ctx.effective_subsource = effective_subsource;

  return ctx;
}

export const _internal = {
  loadDecodedContact,
  loadLeadSummary,
  loadContactTimeline,
  loadSourceAnalytics,
  withTimeout,
};
