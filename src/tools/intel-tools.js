// ─── Intelligence / Diagnostic Tools — src/tools/intel-tools.js ──
//
// v1.0 (2026-05-01) — Foundational diagnostic tools surfaced by the
//   2026-05-01 Jeanne Jewell investigation. Each one collapses what
//   was previously a multi-step manual process into one MCP call.
//
//   Tools added:
//     - check_service_area     — Is this zip in a Reece market?
//     - get_decoded_contact    — GHL contact with custom fields named
//     - get_contact_timeline   — Unified chronological event timeline
//
//   None of these create new tables or schemas. They synthesize across
//   tables that already exist (service_area_zips, service_markets,
//   lp_leads, lp_call_logs, lp_notes, lp_activities, system_events,
//   agent_actions) plus a live GHL fetch where needed.

import { z } from 'zod';
import supabase from '../supabase.js';
import { getGHLContact } from '../ghl.js';
import { decodeFields } from '../ghl-field-decoder.js';

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Normalize a zip-like input to the 5-digit form stored in
 * service_area_zips. Strips ZIP+4 suffixes and non-digits.
 * Returns null if it can't extract 5 consecutive digits.
 */
function normalizeZip(input) {
  if (!input) return null;
  const str = String(input).trim();
  const match = str.match(/\b(\d{5})(?:-?\d{4})?\b/);
  return match ? match[1] : null;
}

/**
 * Convert a timestamp (ISO string, epoch ms number, or epoch ms string)
 * to an ISO string. Returns null on invalid input.
 */
function toIsoString(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number') return new Date(ts).toISOString();
  if (typeof ts === 'string') {
    const asNum = Number(ts);
    if (!isNaN(asNum) && ts.length >= 10 && /^\d+$/.test(ts)) {
      return new Date(asNum).toISOString();
    }
    const d = new Date(ts);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

// ─── Tool Registration ───────────────────────────────────────────

export function registerIntelTools(server) {

  // ───────────────────────────────────────────────────────────────
  // Tool: check_service_area
  // ───────────────────────────────────────────────────────────────
  // Foundational gate that should have killed the Jeanne Jewell case
  // before Bot 4 ever offered an appointment. Looks up a zip against
  // service_area_zips (1,060 rows, 9 markets) and returns the market
  // routing info.
  //
  // Inputs:
  //   zip — 5-digit US zip code (also accepts ZIP+4, normalized)
  //
  // Returns one of:
  //   { in_service_area: true, market_code, market_name, service_phone,
  //     service_phone_e164, hours, has_dedicated_phone, county, city }
  //   { in_service_area: false, fallback_phone, suggestion: "..." }
  //
  // Use cases:
  //   - Bot orchestrators (Bot 4 etc.) gate appointment booking on this
  //   - Inbound webhooks pre-DQ leads outside service area
  //   - Manual investigation: "is this address even servicable?"
  //
  server.tool(
    'check_service_area',
    'Check whether a zip code is inside a Reece service market. Returns the market code, market name, dedicated service phone, and routing details if in-area; returns the general fallback phone otherwise. Use this as a gate before any booking decision.',
    {
      zip: z.string().describe('5-digit US zip (ZIP+4 also accepted, will be normalized)'),
    },
    async ({ zip }) => {
      const normalized = normalizeZip(zip);
      if (!normalized) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Could not extract a 5-digit zip from input.',
              input: zip,
            }, null, 2),
          }],
        };
      }

      // Lookup the zip → market mapping
      const { data: zipRow, error: zipErr } = await supabase
        .from('service_area_zips')
        .select('zip, city, county, market_code')
        .eq('zip', normalized)
        .maybeSingle();

      if (zipErr) {
        return {
          content: [{
            type: 'text',
            text: `service_area_zips lookup error: ${zipErr.message}`,
          }],
        };
      }

      // Get the GENERAL fallback for both in-area and out-of-area paths
      // (some in-area markets like JAX share the general phone).
      const { data: generalMarket } = await supabase
        .from('service_markets')
        .select('service_phone, service_phone_e164')
        .eq('market_code', 'GENERAL')
        .maybeSingle();

      if (!zipRow) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              zip: normalized,
              in_service_area: false,
              fallback_phone: generalMarket?.service_phone || null,
              fallback_phone_e164: generalMarket?.service_phone_e164 || null,
              suggestion: 'Out of mapped service area. Hard-DQ with loss-reason:out-of-area is appropriate. Do NOT offer in-home appointments. The general phone above can field misc inquiries but Reece does not service this area.',
            }, null, 2),
          }],
        };
      }

      // In-area: pull the market's full record
      const { data: market, error: marketErr } = await supabase
        .from('service_markets')
        .select('market_code, market_name, service_phone, service_phone_e164, hours, has_dedicated_phone, notes')
        .eq('market_code', zipRow.market_code)
        .single();

      if (marketErr) {
        return {
          content: [{
            type: 'text',
            text: `service_markets lookup error for ${zipRow.market_code}: ${marketErr.message}`,
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            zip: normalized,
            in_service_area: true,
            city: zipRow.city,
            county: zipRow.county,
            market_code: market.market_code,
            market_name: market.market_name,
            service_phone: market.service_phone,
            service_phone_e164: market.service_phone_e164,
            hours: market.hours,
            has_dedicated_phone: market.has_dedicated_phone,
            notes: market.notes,
          }, null, 2),
        }],
      };
    }
  );

  // ───────────────────────────────────────────────────────────────
  // Tool: get_decoded_contact
  // ───────────────────────────────────────────────────────────────
  // Fetches a live GHL contact and decodes the customFields array
  // into human-readable, category-grouped form. Uses forceLive equivalent
  // (direct GHL API call via getGHLContact) — no cache.
  //
  // Inputs (one of):
  //   ghl_contact_id — the GHL contact ID
  //   phone          — phone number (E.164 preferred but flexible)
  //   email          — email address
  //
  // Returns:
  //   profile:       basic contact fields (name, phone, email, address, source, dates, tags)
  //   custom_fields: decoded fields grouped by category (identity, status, ai, source, etc.)
  //   raw_field_count, decoded_field_count, unknown_field_count
  //
  // Use cases:
  //   - Replaces every manual field-decoder lookup
  //   - First call in any contact investigation
  //   - Source for synthesized contact intelligence profiles
  //
  server.tool(
    'get_decoded_contact',
    'Fetch a GHL contact LIVE and decode all custom fields into human-readable, category-grouped form. Replaces manual field-decoder lookups. Pass one of: ghl_contact_id, phone, or email.',
    {
      ghl_contact_id: z.string().optional().describe('GHL contact ID (preferred — direct lookup)'),
      phone:          z.string().optional().describe('Phone number (will be searched via GHL API)'),
      email:          z.string().optional().describe('Email address (will be searched via GHL API)'),
    },
    async ({ ghl_contact_id, phone, email }) => {
      if (!ghl_contact_id && !phone && !email) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Must provide one of: ghl_contact_id, phone, or email.',
            }, null, 2),
          }],
        };
      }

      let contact = null;
      if (ghl_contact_id) {
        contact = await getGHLContact(ghl_contact_id);
      } else {
        // Fall back to HL Supabase cache for phone/email lookups —
        // we don't currently expose a GHL API search wrapper from LP MCP.
        // The HL MCP search_contacts tool is the right path for phone/email.
        // Tell the caller and skip — better to be explicit than to return
        // stale cache data dressed up as "live".
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Phone/email lookups not yet supported in this LP MCP tool — pass ghl_contact_id directly. Use HL MCP search_contacts to find the contactId by phone/email first, then call this tool with the resulting ID.',
              suggestion: 'HL MCP:search_contacts({ query: "<phone>", forceLive: true }) → grab .contacts[0].id → call get_decoded_contact with it.',
            }, null, 2),
          }],
        };
      }

      if (!contact) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Contact not found in GHL or fetch failed.',
              ghl_contact_id,
            }, null, 2),
          }],
        };
      }

      // GHL returns customFields as Array<{id, value}> on contact records.
      const rawFields = Array.isArray(contact.customFields) ? contact.customFields : [];
      const grouped = decodeFields(rawFields);

      const unknownCount = (grouped.unknown || []).length;
      const totalDecoded = rawFields.length - unknownCount;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            profile: {
              id: contact.id,
              name: contact.contactName || `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
              first_name: contact.firstName,
              last_name: contact.lastName,
              phone: contact.phone,
              email: contact.email,
              address: contact.address1,
              city: contact.city,
              state: contact.state,
              postal_code: contact.postalCode,
              country: contact.country,
              source: contact.source,
              type: contact.type,
              assigned_to: contact.assignedTo,
              date_added: contact.dateAdded,
              date_updated: contact.dateUpdated,
              tags: contact.tags || [],
              dnd: contact.dnd,
            },
            custom_fields: grouped,
            stats: {
              raw_field_count: rawFields.length,
              decoded_field_count: totalDecoded,
              unknown_field_count: unknownCount,
              ...(unknownCount > 0 ? { note: 'Unknown fields exist — consider updating src/ghl-field-decoder.js with the new IDs.' } : {}),
            },
          }, null, 2),
        }],
      };
    }
  );

  // ───────────────────────────────────────────────────────────────
  // Tool: get_contact_timeline
  // ───────────────────────────────────────────────────────────────
  // Builds a unified chronological timeline for a contact across:
  //   - LP records      (lp_leads)            — created, disposition, appointment, demo, sale
  //   - Call history    (lp_call_logs)        — every call with outcome
  //   - Notes           (lp_notes)            — notes added by reps
  //   - Activities      (lp_activities)       — LP system events
  //   - System events   (system_events)       — agentic event bus
  //   - Agent actions   (agent_actions)       — what the executor did
  //
  // GHL data (opportunities, conversations, messages) is NOT in this
  // Supabase — fetch that via HL MCP for the full picture.
  //
  // Inputs:
  //   ghl_contact_id (preferred) OR lp_lead_id OR phone
  //   since_days        — only events newer than N days (default 90)
  //   limit_per_source  — cap each source at N events (default 50)
  //
  // Returns:
  //   timeline: chronological array of { ts, source, type, summary, detail }
  //   counts: per-source event counts
  //   range: { earliest, latest }
  //
  server.tool(
    'get_contact_timeline',
    'Unified chronological timeline for a contact across LP records, calls, notes, activities, system events, and agent actions. Replaces 6+ manual queries. Pass ghl_contact_id (preferred), lp_lead_id, or phone.',
    {
      ghl_contact_id:   z.string().optional().describe('GHL contact ID — preferred, joins all sources'),
      lp_lead_id:       z.string().optional().describe('LP Lead ID (specific lead) — covers LP-only events'),
      phone:            z.string().optional().describe('Phone number — used to find lp_lead_id if neither ID provided'),
      since_days:       z.number().optional().describe('Only events newer than N days (default 90; use 0 for all)'),
      limit_per_source: z.number().optional().describe('Max events per source (default 50)'),
    },
    async ({ ghl_contact_id, lp_lead_id, phone, since_days = 90, limit_per_source = 50 }) => {
      if (!ghl_contact_id && !lp_lead_id && !phone) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Must provide one of: ghl_contact_id, lp_lead_id, or phone.',
            }, null, 2),
          }],
        };
      }

      const sinceIso = since_days > 0
        ? new Date(Date.now() - since_days * 86400000).toISOString()
        : null;

      // ─── Resolve identifiers ──────────────────────────────────
      // Goal: end up with both ghl_contact_id (for system_events / agent_actions)
      // AND a list of lp_lead_ids (for LP-side queries — one prospect can have
      // multiple leads in LP).
      let resolvedGhlId = ghl_contact_id || null;
      let lpLeadIds = [];

      if (lp_lead_id) {
        lpLeadIds.push(lp_lead_id);
        if (!resolvedGhlId) {
          const { data } = await supabase
            .from('lp_leads')
            .select('ghl_contact_id, lp_lead_id')
            .eq('lp_lead_id', lp_lead_id)
            .maybeSingle();
          if (data?.ghl_contact_id) resolvedGhlId = data.ghl_contact_id;
        }
      } else if (resolvedGhlId) {
        const { data } = await supabase
          .from('lp_leads')
          .select('lp_lead_id')
          .eq('ghl_contact_id', resolvedGhlId);
        lpLeadIds = (data || []).map(r => r.lp_lead_id);
      } else if (phone) {
        const cleanPhone = phone.replace(/\D/g, '');
        const { data } = await supabase
          .from('lp_leads')
          .select('lp_lead_id, ghl_contact_id')
          .or(`phone.eq.${cleanPhone},phone.eq.+1${cleanPhone},phone.eq.${phone}`);
        if (data?.length) {
          lpLeadIds = data.map(r => r.lp_lead_id);
          resolvedGhlId = data.find(r => r.ghl_contact_id)?.ghl_contact_id || null;
        }
      }

      // ─── Build queries for each source in parallel ────────────
      const events = [];
      const counts = {};

      const queries = [];

      // LP leads (creation event per lead, plus appointment/demo events)
      if (lpLeadIds.length) {
        queries.push(
          supabase
            .from('lp_leads')
            .select('lp_lead_id, disposition_code, disposition_label, lead_source_detail, appointment_set, appointment_date, demo_completed, demo_date, closed_won, job_value, created_at_lp, last_contact_date, rep_name')
            .in('lp_lead_id', lpLeadIds)
            .then(r => ({ source: 'lp_leads', rows: r.data || [], err: r.error })),
        );

        queries.push(
          supabase
            .from('lp_call_logs')
            .select('*')
            .in('lp_lead_id', lpLeadIds)
            .order('call_date', { ascending: false })
            .limit(limit_per_source)
            .then(r => ({ source: 'lp_call_logs', rows: r.data || [], err: r.error })),
        );

        queries.push(
          supabase
            .from('lp_notes')
            .select('*')
            .in('lp_lead_id', lpLeadIds)
            .order('created_at_lp', { ascending: false })
            .limit(limit_per_source)
            .then(r => ({ source: 'lp_notes', rows: r.data || [], err: r.error })),
        );

        queries.push(
          supabase
            .from('lp_activities')
            .select('*')
            .in('lp_lead_id', lpLeadIds)
            .order('activity_date', { ascending: false })
            .limit(limit_per_source)
            .then(r => ({ source: 'lp_activities', rows: r.data || [], err: r.error })),
        );
      }

      // System events (agentic event bus) — keyed off ghl_contact_id or lp_lead_id
      if (resolvedGhlId || lpLeadIds.length) {
        let q = supabase
          .from('system_events')
          .select('id, event_type, event_subtype, source, entity_type, entity_id, ghl_contact_id, lp_lead_id, payload, priority, processed, action_taken, event_timestamp, created_at')
          .order('created_at', { ascending: false })
          .limit(limit_per_source);
        if (resolvedGhlId) q = q.eq('ghl_contact_id', resolvedGhlId);
        else if (lpLeadIds.length) q = q.in('lp_lead_id', lpLeadIds);
        if (sinceIso) q = q.gte('created_at', sinceIso);
        queries.push(q.then(r => ({ source: 'system_events', rows: r.data || [], err: r.error })));
      }

      // Agent actions — keyed off target_id (which may be ghl_contact_id or lp_lead_id)
      if (resolvedGhlId) {
        let q = supabase
          .from('agent_actions')
          .select('id, action_type, target_system, target_entity, target_id, status, reasoning, rule_applied, executed_at, error_message, created_at')
          .eq('target_id', resolvedGhlId)
          .order('created_at', { ascending: false })
          .limit(limit_per_source);
        if (sinceIso) q = q.gte('created_at', sinceIso);
        queries.push(q.then(r => ({ source: 'agent_actions', rows: r.data || [], err: r.error })));
      }

      const results = await Promise.all(queries);

      // ─── Normalize each source into timeline entries ─────────
      for (const { source, rows, err } of results) {
        if (err) {
          counts[source] = { error: err.message };
          continue;
        }
        counts[source] = rows.length;

        for (const row of rows) {
          if (source === 'lp_leads') {
            // Synthesize multiple events per lead row
            if (row.created_at_lp) {
              events.push({
                ts: toIsoString(row.created_at_lp),
                source: 'lp',
                type: 'lead_created',
                summary: `LP lead created (${row.lead_source_detail || 'unknown source'}) — disposition: ${row.disposition_label || row.disposition_code || 'none'}`,
                detail: { lp_lead_id: row.lp_lead_id, rep: row.rep_name },
              });
            }
            if (row.appointment_set && row.appointment_date) {
              events.push({
                ts: toIsoString(row.appointment_date),
                source: 'lp',
                type: 'appointment_set',
                summary: `Appointment set (lead ${row.lp_lead_id})`,
                detail: { rep: row.rep_name },
              });
            }
            if (row.demo_completed && row.demo_date) {
              events.push({
                ts: toIsoString(row.demo_date),
                source: 'lp',
                type: 'demo_completed',
                summary: `Demo completed (lead ${row.lp_lead_id})`,
                detail: { rep: row.rep_name, job_value: row.job_value },
              });
            }
            if (row.closed_won && row.demo_date) {
              events.push({
                ts: toIsoString(row.demo_date),
                source: 'lp',
                type: 'closed_won',
                summary: `Closed won — $${row.job_value || '?'}`,
                detail: { lp_lead_id: row.lp_lead_id, rep: row.rep_name },
              });
            }
          } else if (source === 'lp_call_logs') {
            events.push({
              ts: toIsoString(row.call_date),
              source: 'lp',
              type: 'call',
              summary: `Call: ${row.outcome || row.call_type || 'no outcome'}${row.duration ? ` (${row.duration}s)` : ''}`,
              detail: { rep: row.rep_name, lp_lead_id: row.lp_lead_id, raw: row },
            });
          } else if (source === 'lp_notes') {
            const body = (row.note_body || row.body || '').toString();
            events.push({
              ts: toIsoString(row.created_at_lp || row.created_at),
              source: 'lp',
              type: 'note',
              summary: `Note: ${body.slice(0, 100)}${body.length > 100 ? '…' : ''}`,
              detail: { full_note: body, rep: row.created_by_rep_name ?? row.rep_name, lp_lead_id: row.lp_lead_id },  // lp_notes has no rep_name column (2026-09-25)
            });
          } else if (source === 'lp_activities') {
            events.push({
              ts: toIsoString(row.activity_date),
              source: 'lp',
              type: 'activity',
              summary: `Activity: ${row.activity_type || 'unknown'}`,
              detail: row,
            });
          } else if (source === 'system_events') {
            events.push({
              ts: toIsoString(row.event_timestamp || row.created_at),
              source: 'agentic',
              type: `event:${row.event_type}`,
              summary: `${row.event_type}${row.event_subtype ? ` (${row.event_subtype})` : ''} — ${row.processed ? 'processed' : 'pending'}${row.action_taken ? `: ${row.action_taken}` : ''}`,
              detail: { id: row.id, source_system: row.source, priority: row.priority, payload: row.payload },
            });
          } else if (source === 'agent_actions') {
            events.push({
              ts: toIsoString(row.executed_at || row.created_at),
              source: 'agentic',
              type: `action:${row.action_type}`,
              summary: `${row.action_type} → ${row.target_system} — ${row.status}${row.error_message ? ` (${row.error_message})` : ''}`,
              detail: { id: row.id, rule: row.rule_applied, reasoning: row.reasoning, target_entity: row.target_entity },
            });
          }
        }
      }

      // ─── Sort & filter by date window ────────────────────────
      let filtered = events.filter(e => e.ts);
      if (sinceIso) {
        filtered = filtered.filter(e => e.ts >= sinceIso);
      }
      filtered.sort((a, b) => b.ts.localeCompare(a.ts));

      const earliest = filtered.length ? filtered[filtered.length - 1].ts : null;
      const latest = filtered.length ? filtered[0].ts : null;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            resolved: {
              ghl_contact_id: resolvedGhlId,
              lp_lead_ids: lpLeadIds,
            },
            window: {
              since_days,
              earliest,
              latest,
            },
            counts,
            event_count: filtered.length,
            timeline: filtered,
            note: resolvedGhlId
              ? 'GHL opportunities, conversations, and messages are NOT in this Supabase. Use HL MCP get_opportunities and get_conversations for the GHL side of the timeline.'
              : 'No GHL contact ID resolved — agentic events not included. Pass ghl_contact_id for full coverage.',
          }, null, 2),
        }],
      };
    }
  );

}
