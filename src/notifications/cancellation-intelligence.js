/**
 * Contract Cancellation Notifications — Hybrid Intelligence Loader
 * src/notifications/cancellation-intelligence.js
 *
 * Pulls per-contact LIVE intelligence from LP MCP's internal services
 * in parallel, with a 4s total cap. Returns whatever resolved before
 * the deadline plus a `data_gaps` list naming whichever sources
 * failed or timed out.
 *
 * Differs from loadAppointmentContext in two ways:
 *   1. No source attribution / close-rate analytics. Cancellation
 *      routing doesn't care about marketing source — it cares about
 *      the customer's state of mind and what they actually said.
 *   2. Tightened prospect-id resolution. Cancellation is high-stakes
 *      enough that we always want the LP prospect id surfaced if it
 *      exists anywhere — payload, GHL custom field, lp_leads cache,
 *      or live LP API lookup by phone.
 *
 * Reuses the loader helpers from appointment-intelligence._internal
 * (loadDecodedContact, loadLeadSummary, loadContactTimeline,
 * lookupProspectByPhone, withTimeout) so the two flows stay aligned
 * as the underlying contact-fetch/lead-fetch logic evolves.
 */

import { _internal as apptIntelInternal } from './appointment-intelligence.js';

const {
  loadDecodedContact,
  loadLeadSummary,
  loadContactTimeline,
  lookupProspectByPhone,
  withTimeout,
} = apptIntelInternal;

const DEFAULT_TIMEOUT_MS = parseInt(
  process.env.CANCELLATION_NOTIFICATION_CONTEXT_TIMEOUT_MS || '4000',
  10,
);

const LP_PROSPECT_LOOKUP_TIMEOUT_MS = 2000;

/**
 * Main entrypoint.
 *
 * Runs decoded_contact + lead_summary + timeline in parallel, then
 * resolves the LP prospect id via a 3-tier chain. Any source that
 * fails or times out is dropped from the returned context and named
 * in data_gaps so the body generator can surface "(intel unavailable)"
 * in the right slot rather than fabricating data.
 *
 * Returns:
 *   {
 *     decoded_contact:        { profile, custom_fields } | null,
 *     lead_summary:           { lead, all_leads, recent } | null,
 *     timeline:               [{ ts, type, summary, rep? }],
 *     resolved_prospect_id:   string | null,
 *     data_gaps:              string[]
 *   }
 *
 * Throws only if contact_id is missing — every other failure is
 * captured in data_gaps and the call still returns a usable context.
 */
export async function loadCancellationContext({
  contact_id,
  contact_phone,
  payload_prospect_id,
  timeout_ms = DEFAULT_TIMEOUT_MS,
  _deps,
}) {
  if (!contact_id) {
    throw new Error('loadCancellationContext: contact_id required');
  }

  // Dependency injection for tests.
  const loaders = {
    loadDecodedContact: _deps?.loadDecodedContact || loadDecodedContact,
    loadLeadSummary: _deps?.loadLeadSummary || loadLeadSummary,
    loadContactTimeline: _deps?.loadContactTimeline || loadContactTimeline,
    lookupProspectByPhone: _deps?.lookupProspectByPhone || lookupProspectByPhone,
  };

  const data_gaps = [];

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

  const results = await Promise.all(tasks);

  const ctx = {
    decoded_contact: null,
    lead_summary: null,
    timeline: [],
    resolved_prospect_id: null,
    data_gaps,
  };

  for (const r of results) {
    if (r.error) {
      ctx.data_gaps.push(`${r.kind}:${r.error}`);
      continue;
    }
    ctx[r.kind] = r.value ?? null;
  }

  // ─── 3-tier prospect-id resolution ────────────────────────────
  // Tier 1: explicit payload from the GHL webhook (lp_prospect_id
  //         merge tag). Most efficient — no lookups needed.
  // Tier 2: lp_leads cache (loaded above as part of lead_summary).
  // Tier 3: GHL "LP Prospect ID" custom field, walking every
  //         category since the decoder groups fields by section.
  // Tier 4: live LP API lookup by phone, bounded at 2s. Quiet on
  //         failure — the body generator handles "(unknown)" cleanly.
  const tier1 = String(payload_prospect_id ?? '').trim();
  let resolvedProspectId = tier1 || null;

  if (!resolvedProspectId) {
    const tier2 = String(ctx.lead_summary?.lead?.lp_prospect_id ?? '').trim();
    if (tier2) resolvedProspectId = tier2;
  }

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
        LP_PROSPECT_LOOKUP_TIMEOUT_MS,
        'prospect_lookup_lp_api',
      );
      const val = String(fromLpApi ?? '').trim();
      if (val) {
        resolvedProspectId = val;
        ctx.data_gaps.push('prospect_resolved_from:lp_api_lookup');
      }
    } catch {
      // Silent fallthrough — prospect stays unknown. The body
      // generator handles the "(unknown)" case explicitly.
    }
  }

  ctx.resolved_prospect_id = resolvedProspectId;

  return ctx;
}

export const _internal = {
  DEFAULT_TIMEOUT_MS,
  LP_PROSPECT_LOOKUP_TIMEOUT_MS,
};
