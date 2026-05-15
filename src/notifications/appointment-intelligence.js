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
import { getLead as lpGetLead, getCustomers3 as lpGetCustomers3 } from '../lp-client.js';
import { extractArray, getField } from '../sync-utils.js';

const DEFAULT_TIMEOUT_MS = parseInt(
  process.env.APPT_NOTIFICATION_CONTEXT_TIMEOUT_MS || '4000',
  10
);
const TIMELINE_LIMIT = 10;

const LP_API_SOURCE_LOOKUP_TIMEOUT_MS = 2500;
const SOURCE_ANALYTICS_RETRY_TIMEOUT_MS = 1500;

// Priority-ordered list of GHL custom-field source pairs to walk for
// Tier 2 resolution. Both fields in a pair must carry non-empty values
// for the pair to be accepted. Order matters: LP-attributed pair first
// (highest fidelity), then generic source fields, then first-touch
// attribution.
const GHL_SOURCE_PAIRS = [
  { source: 'LP Source',             subsource: 'LP Subsource' },
  { source: 'Source Category',       subsource: 'Source Subcategory' },
  { source: 'First Source Category', subsource: 'First Source Subcategory' },
];

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
 * Tier 3 prospect lookup — direct supabase query against lp_leads by
 * phone (the same table search_leads MCP tool queries). Returns the
 * `lp_prospect_id` of the most recent matching lead, or null on no
 * match / no row with a prospect id. Normalizes the input to its last
 * 10 digits so formatted/unformatted phone variants match.
 */
async function lookupProspectByPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  const last10 = digits.slice(-10);

  const { data, error } = await supabase
    .from('lp_leads')
    .select('lp_prospect_id, created_at_lp')
    .ilike('phone', `%${last10}%`)
    .order('created_at_lp', { ascending: false })
    .limit(10);

  if (error) throw new Error(`lp_leads_phone_lookup:${error.message}`);
  if (!Array.isArray(data) || data.length === 0) return null;

  for (const row of data) {
    const pid = String(row?.lp_prospect_id ?? '').trim();
    if (pid) return pid;
  }
  return null;
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
 * Walk every category of decoded_contact.custom_fields and find the
 * first complete source-pair from GHL_SOURCE_PAIRS. A pair is "complete"
 * when both the source field and the subsource field exist on the
 * contact AND both have non-empty trimmed string values.
 *
 * Returns { source, subsource, matched_pair_name } or null when no
 * complete pair is found.
 */
function findGhlSourcePair(decodedContact) {
  if (!decodedContact?.custom_fields) return null;
  const byName = {};
  for (const category of Object.values(decodedContact.custom_fields)) {
    if (!Array.isArray(category)) continue;
    for (const field of category) {
      if (!field?.name) continue;
      const val = String(field.value ?? '').trim();
      if (val) byName[field.name] = val;
    }
  }
  for (const pair of GHL_SOURCE_PAIRS) {
    const src = byName[pair.source];
    const sub = byName[pair.subsource];
    if (src && sub) {
      return {
        source: src,
        subsource: sub,
        matched_pair_name: `${pair.source}/${pair.subsource}`,
      };
    }
  }
  return null;
}

/**
 * Look up a custom field by name across every category of a decoded
 * contact. Returns the string value (trimmed) or null when absent.
 */
function findGhlCustomField(decodedContact, fieldName) {
  if (!decodedContact?.custom_fields) return null;
  for (const category of Object.values(decodedContact.custom_fields)) {
    if (!Array.isArray(category)) continue;
    for (const field of category) {
      if (field?.name === fieldName) {
        const val = String(field.value ?? '').trim();
        if (val) return val;
      }
    }
  }
  return null;
}

/**
 * Pull source + subsource from an LP record using the same field
 * mapping that sync-leads.js applies when populating lp_leads.lead_source
 * and lp_leads.lead_source_detail. The point of this fallback is to
 * surface what would have been in lp_leads if the sync had run already
 * — so the field names MUST match sync-leads.js exactly.
 *
 * LP responses from getLead / getCustomers3 are arrays of prospects;
 * each prospect carries its source on the nested `leads` records.
 * Walk leads first, then fall back to top-level prospect fields just
 * in case a flattened shape arrives.
 *
 * Returns { source, subsource } or null.
 */
function extractSourceFromLpRecord(lpRecord) {
  if (!lpRecord) return null;

  const leads = getField(lpRecord, 'leads', 'Leads');
  if (Array.isArray(leads) && leads.length) {
    for (const lead of leads) {
      const src = getField(lead, 'source', 'Source');
      const sub = getField(lead, 'sourcesubdescr', 'SourceSubDescr');
      if (src && String(src).trim()) {
        return {
          source: String(src).trim(),
          subsource: sub ? String(sub).trim() : null,
        };
      }
    }
  }

  const src = getField(lpRecord, 'source', 'Source');
  const sub = getField(lpRecord, 'sourcesubdescr', 'SourceSubDescr');
  if (src && String(src).trim()) {
    return {
      source: String(src).trim(),
      subsource: sub ? String(sub).trim() : null,
    };
  }
  return null;
}

/**
 * Tier 3 path A — direct LP fetch by prospect ID. Returns
 * { source, subsource } or null. Quiet on failure: callers attribute
 * the gap via data_gaps.
 */
async function lookupSourceByProspectId(prospectId) {
  if (!prospectId) return null;
  const result = await lpGetLead(prospectId);
  const prospects = extractArray(result);
  if (!prospects.length) return null;
  return extractSourceFromLpRecord(prospects[0]);
}

/**
 * Tier 3 path B — LP search by phone (last-10 digits). Returns
 * { source, subsource } or null.
 */
async function lookupSourceByPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  const last10 = digits.slice(-10);
  const result = await lpGetCustomers3({ phone: last10 });
  const prospects = extractArray(result);
  if (!prospects.length) return null;
  return extractSourceFromLpRecord(prospects[0]);
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
  contact_phone,
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
    lookupProspectByPhone: _deps?.lookupProspectByPhone || lookupProspectByPhone,
    lookupSourceByProspectId: _deps?.lookupSourceByProspectId || lookupSourceByProspectId,
    lookupSourceByPhone: _deps?.lookupSourceByPhone || lookupSourceByPhone,
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

  // ─── Effective source resolution chain ─────────────────────────
  // Payload `lp_source`/`lp_subsource` come from GHL merge tags and
  // are often empty even when the contact has a known source elsewhere.
  // When the payload is empty, walk three fallback tiers in order:
  //   Tier 1: lp_leads cache (already loaded above)
  //   Tier 2: GHL contact custom-field source-pair (e.g. Source
  //           Category / Source Subcategory)
  //   Tier 3: LP API direct lookup, by prospect ID then by phone.
  // After the chain settles, retry close-rate analytics if any tier
  // resolved a source.
  const payloadSource = String(lp_source || '').trim();
  const payloadSubsource = String(lp_subsource || '').trim();
  let effective_source = payloadSource || null;
  let effective_subsource = payloadSubsource || null;

  // Tier 1 — LP cache (lp_leads) fallback.
  if (!effective_source && !effective_subsource) {
    const lpSource = String(ctx.lead_summary?.lead?.lead_source || '').trim();
    const lpSubsource = String(ctx.lead_summary?.lead?.lead_source_detail || '').trim();
    if (lpSource) {
      effective_source = lpSource;
      effective_subsource = lpSubsource || null;
      ctx.data_gaps.push('source_resolved_from:lp_fallback');
    }
  }

  // Tier 2 — walk GHL custom fields for a complete source-pair.
  if (!effective_source && !effective_subsource) {
    const ghlPair = findGhlSourcePair(ctx.decoded_contact);
    if (ghlPair) {
      effective_source = ghlPair.source;
      effective_subsource = ghlPair.subsource;
      ctx.data_gaps.push(
        `source_resolved_from:ghl_custom_field:${ghlPair.matched_pair_name}`,
      );
    }
  }

  // Tier 3 — LP API direct lookup. Path A by prospect ID (from the GHL
  // "LP Prospect ID" custom field), Path B by phone. Both bounded at
  // 2.5s and quiet on failure.
  if (!effective_source && !effective_subsource) {
    const prospectIdFromGhl = findGhlCustomField(ctx.decoded_contact, 'LP Prospect ID');
    const phoneDigits = String(contact_phone || '').replace(/\D/g, '').slice(-10);

    let lookupMode = null;
    let extracted = null;

    try {
      if (prospectIdFromGhl) {
        extracted = await withTimeout(
          loaders.lookupSourceByProspectId(prospectIdFromGhl),
          LP_API_SOURCE_LOOKUP_TIMEOUT_MS,
          'source_lookup_lp_api',
        );
        lookupMode = 'by_prospect_id';
      } else if (phoneDigits.length === 10) {
        extracted = await withTimeout(
          loaders.lookupSourceByPhone(phoneDigits),
          LP_API_SOURCE_LOOKUP_TIMEOUT_MS,
          'source_lookup_lp_api',
        );
        lookupMode = 'by_phone';
      }
    } catch (err) {
      const detail = String(err?.message || 'unknown').slice(0, 80);
      ctx.data_gaps.push(`source_lookup_lp_api_failed:${detail}`);
    }

    if (extracted?.source) {
      effective_source = extracted.source;
      effective_subsource = extracted.subsource || null;
      ctx.data_gaps.push(`source_resolved_from:lp_api:${lookupMode}`);
    }
  }

  // After the entire Tier-1-through-Tier-3 chain settles, retry the
  // close-rate analytics with whatever source resolved. Skip when the
  // initial parallel load already populated it.
  if (effective_source && !ctx.source_analytics) {
    try {
      const retried = await withTimeout(
        loaders.loadSourceAnalytics(effective_source, effective_subsource),
        SOURCE_ANALYTICS_RETRY_TIMEOUT_MS,
        'source_analytics_retry',
      );
      ctx.source_analytics = retried ?? null;
    } catch (err) {
      ctx.data_gaps.push(`source_analytics_retry:${err.message}`);
    }
  }

  ctx.effective_source = effective_source;
  ctx.effective_subsource = effective_subsource;

  // ─── 3-tier prospect_id resolution ─────────────────────────────
  // Tier 1: lp_leads (already loaded).
  // Tier 2: GHL "LP Prospect ID" custom field (id ZRQAVrzhtzApzLlHmT87)
  //         — walk every category since GHL groups fields by section.
  // Tier 3: direct LP search by phone, bounded at 2s. Only runs if
  //         tiers 1 and 2 miss and we have a phone to search by.
  const tier1 = String(ctx.lead_summary?.lead?.lp_prospect_id ?? '').trim();
  let resolvedProspectId = tier1 || null;

  if (!resolvedProspectId) {
    const groups = ctx.decoded_contact?.custom_fields;
    if (groups && typeof groups === 'object') {
      for (const category of Object.keys(groups)) {
        const fields = groups[category];
        if (!Array.isArray(fields)) continue;
        const hit = fields.find(
          f => f && (f.id === 'ZRQAVrzhtzApzLlHmT87' || f.name === 'LP Prospect ID'),
        );
        const val = hit ? String(hit.value ?? '').trim() : '';
        if (val) {
          resolvedProspectId = val;
          break;
        }
      }
    }
  }

  if (!resolvedProspectId && contact_phone) {
    try {
      const fromLpApi = await withTimeout(
        loaders.lookupProspectByPhone(contact_phone),
        2000,
        'prospect_lookup_lp_api',
      );
      const val = String(fromLpApi ?? '').trim();
      if (val) {
        resolvedProspectId = val;
        ctx.data_gaps.push('prospect_resolved_from:lp_api_lookup');
      }
    } catch {
      // Silent fallthrough — prospect stays unknown.
    }
  }

  ctx.resolved_prospect_id = resolvedProspectId;

  return ctx;
}

export const _internal = {
  loadDecodedContact,
  loadLeadSummary,
  loadContactTimeline,
  loadSourceAnalytics,
  lookupProspectByPhone,
  lookupSourceByProspectId,
  lookupSourceByPhone,
  findGhlSourcePair,
  findGhlCustomField,
  extractSourceFromLpRecord,
  withTimeout,
  GHL_SOURCE_PAIRS,
};
