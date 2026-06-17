/**
 * Entry Event Handler — src/entry-event-handler.js
 *
 * Three routes for the Antifragile entry-routing system:
 *
 *   1. POST /webhook/ghl/entry                    (Route B — agentic routing)
 *      Each entry-source workflow fires this with {contactId, source}.
 *      Emits ghl.entry_detected events that ENTRY_ROUTE_* rules consume
 *      to decide the destination workflow.
 *
 *   2. POST /webhook/ghl/ensure-routing-tags      (v2.0 — safety net)
 *      Fired at the START of E.0 Master Router, BEFORE the Check Entry
 *      Source decision. Ensures the contact has a current active-entry:*
 *      tag — if missing, infers from available signals and writes
 *      entry:*, active-entry:*, source:* via the action-executor (which
 *      enforces immutability + exclusivity).
 *
 *      Covers contacts that bypassed contact_created hygiene rules:
 *      - Created via inbound webhook trigger
 *      - Created indirectly by P1 opportunity creation
 *      - Pre-hygiene-rollout contacts re-entering the system
 *
 *   3. POST /webhook/ghl/branch-fired             (v2.0 — observability)
 *      Each E.0 branch terminus fires this with {contactId, branch_name,
 *      destination_workflow}. Emits ghl.e0_branch_fired events for
 *      routing telemetry — distinct from ghl.entry_detected so it does
 *      not trigger Route B rules.
 *
 * v2.1 — 2026-05-21. bypass_filter:true on the two v2.0 observability
 *        emits. These events are pure telemetry with no rule consumer,
 *        so applyIntakeFilter() was silently dropping them — never a
 *        single ghl.e0_branch_fired or ghl.routing_tags_ensured event
 *        landed in system_events since launch. Bypass restores them
 *        so we can verify whether E.0 LP-Advanced exit (and the safety
 *        net) is firing for every contact that hits it.
 * v2.0 — 2026-05-21. Safety-net + branch-fired observability.
 * v1.1 — 2026-04-29. Defensive payload parsing.
 * v1.0 — Initial Route B implementation.
 */

import { emitEvent } from './event-emitter.js';
import { executeAddTag } from './actions/handlers/tags.js';
import { resolveEntryFromSourceMap, entryTagSuffix } from './entry-source-map.js';

// Routing fix Step 2 — map-driven entry resolution. Default OFF so a merge is
// a no-op; flipped to 'true' on Railway `dev` only after deploy. When OFF, both
// inferEntrySource Priority 0 and the contact_created resolver are skipped and
// behavior is byte-for-byte unchanged.
const ENTRY_RESOLVER_MAP_DRIVEN = process.env.ENTRY_RESOLVER_MAP_DRIVEN === 'true';

// Canonical entry source names for Route B (POST /webhook/ghl/entry).
// Adding a new entry source means adding it here AND creating a
// corresponding ENTRY_ROUTE_* rule in agent_rules.
const VALID_SOURCES = new Set([
  'calculator',           // Estimate Calculator submission
  'hrr',                  // Home Risk Report
  'chatbot',              // Chatbot intent qualified
  'canvassing',           // Canvasser submission
  'referral',             // Customer referral
  'high_intent_digital',  // High-intent digital signal
  'manual',               // Rep manual entry
  'other',                // v2.0 — E.0 default branch
]);

// Map internal entry-source name -> (source-tag suffix).
// Entry-tag values match what the 22 hygiene rules write on
// ghl.contact_created (entry:canvassing, entry:high-intent-digital, ...).
// Used by ensure-routing-tags to write the three governance tags.
const ROUTING_TAG_MAP = {
  'risk-report':         { source_tag: 'risk-report' },
  'estimate-calculator': { source_tag: 'reece-calculator' },
  'chatbot':             { source_tag: 'reece-chatbot' },
  'referral':            { source_tag: 'previous-customer' },
  'high-intent-digital': { source_tag: 'reece-direct-site' },
  'canvassing':          { source_tag: 'canvass' },
  'other':               { source_tag: 'unknown' },
};

const GHL_API_KEY = process.env.GHL_API_KEY;

/**
 * Pull a value from an object by trying multiple key names in order.
 * Returns the first non-empty match. Treats empty string as not-found.
 */
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// ROUTE B — /webhook/ghl/entry  (existing, unchanged behavior)
// ═══════════════════════════════════════════════════════════════════

/**
 * Resolve contactId and source from a request, trying every payload
 * shape GHL is known to produce. Returns the resolved values plus a
 * shape fingerprint for diagnostics.
 */
function resolveEntryFields(req) {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const customData = (body.customData || body.custom_data || body.customValues || {}) || {};
  const contact = (body.contact && typeof body.contact === 'object') ? body.contact : {};
  const query = req.query || {};

  const contactId =
    pick(body, ['contactId', 'contact_id', 'id']) ||
    pick(customData, ['contactId', 'contact_id', 'id']) ||
    pick(contact, ['id', 'contactId', '_id']) ||
    pick(query, ['contactId', 'contact_id', 'id']) ||
    null;

  const sourceRaw =
    pick(body, ['source', 'entry_source']) ||
    pick(customData, ['source', 'entry_source']) ||
    pick(query, ['source', 'entry_source']) ||
    null;

  const context =
    (body.context && typeof body.context === 'object' ? body.context : null) ||
    (body.payload && typeof body.payload === 'object' ? body.payload : null) ||
    (customData.context && typeof customData.context === 'object' ? customData.context : null) ||
    {};

  return {
    contactId,
    sourceRaw,
    context,
    fingerprint: {
      content_type: req.headers['content-type'] || null,
      body_keys: Object.keys(body),
      customData_keys: Object.keys(customData),
      contact_keys: Object.keys(contact),
      query_keys: Object.keys(query),
      contactId_resolved_from: contactId
        ? (body.contactId || body.contact_id || body.id ? 'body'
          : customData.contactId || customData.contact_id || customData.id ? 'customData'
          : contact.id || contact.contactId || contact._id ? 'contact'
          : 'query')
        : null,
      source_resolved_from: sourceRaw
        ? (body.source || body.entry_source ? 'body'
          : customData.source || customData.entry_source ? 'customData'
          : 'query')
        : null,
    },
  };
}

async function handleEntryEvent(req, res) {
  const { contactId, sourceRaw, context, fingerprint } = resolveEntryFields(req);
  const source = sourceRaw ? String(sourceRaw).toLowerCase().trim() : null;

  console.log('[EntryEvent] inbound shape:', JSON.stringify(fingerprint));

  if (!contactId) {
    return res.status(400).json({ error: 'Missing contactId', debug: fingerprint });
  }
  if (!source) {
    return res.status(400).json({
      error: 'Missing source. Must be one of: ' + [...VALID_SOURCES].join(', '),
      debug: fingerprint,
    });
  }
  if (!VALID_SOURCES.has(source)) {
    return res.status(400).json({
      error: `Invalid source "${source}". Must be one of: ${[...VALID_SOURCES].join(', ')}`,
      debug: fingerprint,
    });
  }

  const timeBucket = Math.floor(Date.now() / (5 * 60 * 1000));

  await emitEvent({
    event_type: 'ghl.entry_detected',
    event_subtype: source,
    source: 'ghl_webhook_entry',
    entity_type: 'contact',
    entity_id: contactId,
    ghl_contact_id: contactId,
    payload: { source, context, raw: req.body, shape: fingerprint },
    priority: 'high',
    idempotency_key: `entry_${source}_${contactId}_${timeBucket}`,
  });

  console.log(`[EntryEvent] ✅ ${source} → ${contactId} (idempotency=${timeBucket}, source_from=${fingerprint.source_resolved_from})`);

  return res.json({
    status: 'accepted',
    event_type: 'ghl.entry_detected',
    source,
    contactId,
    resolved_from: {
      contactId: fingerprint.contactId_resolved_from,
      source: fingerprint.source_resolved_from,
    },
  });
}

// ═══════════════════════════════════════════════════════════════════
// SAFETY NET — /webhook/ghl/ensure-routing-tags  (v2.0)
// ═══════════════════════════════════════════════════════════════════

async function fetchContactRaw(contactId) {
  if (!GHL_API_KEY) {
    throw new Error('GHL_API_KEY env var not configured');
  }
  const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Version': '2021-07-28',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GHL GET /contacts/${contactId} returned ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data?.contact || data;
}

function getCustomFieldValue(contact, fieldId) {
  const fields = contact?.customFields || [];
  const f = fields.find((f) => f.id === fieldId);
  return (f?.value ?? '').toString();
}

/**
 * Infer the current entry source from contact signals.
 * Returns { source, signal, confidence[, bucket] }. For heuristic matches
 * (Priorities 1-6) `source` is one of the keys of ROUTING_TAG_MAP. For a
 * Priority 0 map-driven match `source` is the bare entry suffix from
 * lp_source_mapping (which may be outside ROUTING_TAG_MAP, e.g. "media") and
 * `signal` starts with "source-map:".
 */
async function inferEntrySource(contact) {
  const tags = contact?.tags || [];
  const sourceField = (contact?.source || '').toString();

  // Priority 0 (routing fix Step 2): map-driven resolution from
  // lp_source_mapping. Gated by ENTRY_RESOLVER_MAP_DRIVEN; when it resolves it
  // wins over every heuristic below. Flag OFF = skipped (identical behavior).
  if (ENTRY_RESOLVER_MAP_DRIVEN) {
    try {
      const resolved = await resolveEntryFromSourceMap(contact);
      const suffix = entryTagSuffix(resolved?.entryTag);
      if (suffix) {
        return {
          source: suffix,
          signal: `source-map:${resolved.matchedOn}`,
          confidence: 'high',
          bucket: resolved.bucket,
        };
      }
    } catch (err) {
      console.error(`[inferEntrySource] map-driven resolve failed: ${err.message} — falling through to heuristics`);
    }
  }

  // Priority 1: single existing entry:* tag (clean history → re-promote)
  const entryTags = tags.filter((t) => t.startsWith('entry:'));
  if (entryTags.length === 1) {
    const value = entryTags[0].slice('entry:'.length);
    if (ROUTING_TAG_MAP[value]) {
      return { source: value, signal: `single-entry-tag:${entryTags[0]}`, confidence: 'high' };
    }
  }

  // Priority 2: explicit content/intent tags (highest-confidence intent signals)
  if (tags.includes('chatbot') || tags.includes('chat-widget')) {
    return { source: 'chatbot', signal: 'tag:chatbot', confidence: 'high' };
  }
  if (tags.includes('canvassing') || tags.includes('canvass-sticky')) {
    return { source: 'canvassing', signal: 'tag:canvassing', confidence: 'high' };
  }
  if (tags.includes('referral-lead') || tags.includes('previous-customer')) {
    return { source: 'referral', signal: 'tag:referral-lead', confidence: 'high' };
  }
  if (tags.includes('window-estimator') || tags.includes('estimator-completed')) {
    return { source: 'estimate-calculator', signal: 'tag:window-estimator', confidence: 'high' };
  }
  if (tags.includes('high-intent-digital')) {
    return { source: 'high-intent-digital', signal: 'tag:high-intent-digital', confidence: 'high' };
  }
  if (tags.includes('risk-report')) {
    return { source: 'risk-report', signal: 'tag:risk-report', confidence: 'high' };
  }

  // Priority 3: contact source field (set by external integrations)
  if (sourceField === 'Window Estimator') {
    return { source: 'estimate-calculator', signal: 'source:Window Estimator', confidence: 'high' };
  }
  if (sourceField === 'Chatbot') {
    return { source: 'chatbot', signal: 'source:Chatbot', confidence: 'high' };
  }
  if (sourceField === 'Canvassing') {
    return { source: 'canvassing', signal: 'source:Canvassing', confidence: 'high' };
  }

  // Priority 4: UTM-based HID detection
  // Field IDs from current E.0 HID branch: SjkhgmZ1dQVYKr1islZu (utm source),
  // exgLkUOPIZgjAt13FY8e (utm campaign)
  const utmSource = getCustomFieldValue(contact, 'SjkhgmZ1dQVYKr1islZu').toLowerCase();
  const utmCampaign = getCustomFieldValue(contact, 'exgLkUOPIZgjAt13FY8e');
  if (utmSource.includes('google')) {
    return { source: 'high-intent-digital', signal: `utm-source:${utmSource}`, confidence: 'medium' };
  }
  if (/google|MySafeFloridaHome|Reecewindows/i.test(utmCampaign)) {
    return { source: 'high-intent-digital', signal: `utm-campaign:${utmCampaign}`, confidence: 'medium' };
  }

  // Priority 5: calculator detection custom field (VJ8JhmawlFD7nL4RU1Qz)
  const calcField = getCustomFieldValue(contact, 'VJ8JhmawlFD7nL4RU1Qz');
  if (calcField.toLowerCase().includes('window_estimator')) {
    return { source: 'estimate-calculator', signal: 'calc-field:window_estimator', confidence: 'medium' };
  }

  // Priority 6: multi-entry pollution — pick a deterministic non-'other'
  if (entryTags.length > 1) {
    const values = entryTags.map((t) => t.slice('entry:'.length)).sort();
    const nonOther = values.filter((v) => v !== 'other');
    const chosen = nonOther[0] || values[0];
    if (ROUTING_TAG_MAP[chosen]) {
      return {
        source: chosen,
        signal: `multi-entry-pollution:[${values.join(',')}]:chose-${chosen}`,
        confidence: 'low',
      };
    }
  }

  // Default: other
  return { source: 'other', signal: 'no-signal', confidence: 'low' };
}

async function handleEnsureRoutingTags(req, res) {
  const body = req.body || {};
  const customData = body.customData || body.custom_data || body.customValues || {};
  const contactId =
    pick(body, ['contactId', 'contact_id', 'id']) ||
    pick(customData, ['contactId', 'contact_id', 'id']) ||
    pick(req.query || {}, ['contactId', 'contact_id', 'id']) ||
    null;

  if (!contactId) {
    return res.status(400).json({ error: 'Missing contactId' });
  }

  // 1. Fetch contact
  let contact;
  try {
    contact = await fetchContactRaw(contactId);
  } catch (err) {
    console.error(`[EnsureRoutingTags] GHL fetch failed for ${contactId}: ${err.message}`);
    return res.status(502).json({
      error: 'GHL fetch failed',
      detail: err.message,
      contact_id: contactId,
    });
  }

  const tags = contact?.tags || [];
  const existing = tags.find((t) => t.startsWith('active-entry:'));

  // 2. Already has active-entry:* — return no-op
  if (existing) {
    console.log(`[EnsureRoutingTags] ${contactId} already has ${existing} — no-op`);
    return res.json({
      status: 'already_set',
      contact_id: contactId,
      active_entry: existing,
      action_taken: 'none',
    });
  }

  // 3. Infer the entry source
  const inferred = await inferEntrySource(contact);
  // A map-driven (Priority 0) match carries the authoritative entry suffix +
  // intent bucket straight from lp_source_mapping; that suffix may be outside
  // ROUTING_TAG_MAP (e.g. "media"), so don't downgrade it to 'other'. The
  // source:* tag has no equivalent in the table, so it's skipped for map hits.
  const mapDriven = typeof inferred.signal === 'string' && inferred.signal.startsWith('source-map:');
  if (!ROUTING_TAG_MAP[inferred.source] && !mapDriven) {
    console.warn(`[EnsureRoutingTags] unknown inferred source: ${inferred.source} — falling back to 'other'`);
    inferred.source = 'other';
    inferred.signal = `${inferred.signal}|unknown-source-fallback`;
  }
  const sourceTag = ROUTING_TAG_MAP[inferred.source]?.source_tag || null;

  // 4. Write the governance tags via the executor.
  //    executeAddTag enforces:
  //      - entry:* immutability (no-op if any entry:* exists)
  //      - active-entry:* + source:* exclusivity (swap on conflict)
  const stepResults = [];
  try {
    stepResults.push({
      step: 'add_entry',
      result: await executeAddTag({
        target_id: contactId,
        action_payload: { tag: `entry:${inferred.source}` },
      }),
    });
    stepResults.push({
      step: 'add_active_entry',
      result: await executeAddTag({
        target_id: contactId,
        action_payload: { tag: `active-entry:${inferred.source}` },
      }),
    });
    // NEW reporting tag — only present on map-driven matches.
    if (inferred.bucket) {
      stepResults.push({
        step: 'add_intent_bucket',
        result: await executeAddTag({
          target_id: contactId,
          action_payload: { tag: `intent-bucket:${inferred.bucket}` },
        }),
      });
    }
    if (sourceTag) {
      stepResults.push({
        step: 'add_source',
        result: await executeAddTag({
          target_id: contactId,
          action_payload: { tag: `source:${sourceTag}` },
        }),
      });
    }
  } catch (err) {
    console.error(`[EnsureRoutingTags] tag write failed for ${contactId}: ${err.message}`);
    return res.status(502).json({
      error: 'Tag write failed',
      detail: err.message,
      contact_id: contactId,
      inferred,
      partial_results: stepResults,
    });
  }

  // 5. Observability event
  const timeBucket = Math.floor(Date.now() / (60 * 1000));
  await emitEvent({
    event_type: 'ghl.routing_tags_ensured',
    event_subtype: inferred.source,
    source: 'lp_mcp_safety_net',
    entity_type: 'contact',
    entity_id: contactId,
    ghl_contact_id: contactId,
    payload: {
      inferred,
      previous_tags: tags,
      tags_written: [
        `entry:${inferred.source}`,
        `active-entry:${inferred.source}`,
        ...(inferred.bucket ? [`intent-bucket:${inferred.bucket}`] : []),
        ...(sourceTag ? [`source:${sourceTag}`] : []),
      ],
      step_results: stepResults,
    },
    priority: 'normal',
    idempotency_key: `routing_safety_${contactId}_${timeBucket}`,
    // v2.1: bypass event-intake-filter — observability event with no
    // rule consumer; without this it gets dropped silently.
    bypass_filter: true,
  });

  console.log(`[EnsureRoutingTags] ✅ ${contactId} inferred=${inferred.source} signal="${inferred.signal}" confidence=${inferred.confidence}`);

  return res.json({
    status: 'inferred_and_set',
    contact_id: contactId,
    active_entry: `active-entry:${inferred.source}`,
    entry: `entry:${inferred.source}`,
    source: sourceTag ? `source:${sourceTag}` : null,
    intent_bucket: inferred.bucket ? `intent-bucket:${inferred.bucket}` : null,
    inferred,
    action_taken: 'tags_set',
    step_results: stepResults,
  });
}

// ═══════════════════════════════════════════════════════════════════
// OBSERVABILITY — /webhook/ghl/branch-fired  (v2.0)
// ═══════════════════════════════════════════════════════════════════

async function handleBranchFired(req, res) {
  const body = req.body || {};
  const customData = body.customData || body.custom_data || body.customValues || {};

  const contactId =
    pick(body, ['contactId', 'contact_id', 'id']) ||
    pick(customData, ['contactId', 'contact_id', 'id']) ||
    pick(req.query || {}, ['contactId', 'contact_id', 'id']) ||
    null;

  const branchRaw =
    pick(body, ['branch', 'branch_name']) ||
    pick(customData, ['branch', 'branch_name']) ||
    pick(req.query || {}, ['branch', 'branch_name']) ||
    null;

  const destinationWorkflow =
    pick(body, ['destination_workflow', 'destination']) ||
    pick(customData, ['destination_workflow', 'destination']) ||
    null;

  if (!contactId) return res.status(400).json({ error: 'Missing contactId' });
  if (!branchRaw) return res.status(400).json({ error: 'Missing branch / branch_name' });

  const branch = String(branchRaw).toLowerCase().trim();
  const timeBucket = Math.floor(Date.now() / (60 * 1000));

  await emitEvent({
    event_type: 'ghl.e0_branch_fired',
    event_subtype: branch,
    source: 'ghl_webhook_branch',
    entity_type: 'contact',
    entity_id: contactId,
    ghl_contact_id: contactId,
    payload: {
      branch,
      destination_workflow: destinationWorkflow,
      workflow: 'E.0',
    },
    priority: 'normal',
    idempotency_key: `e0_branch_${branch}_${contactId}_${timeBucket}`,
    // v2.1: bypass event-intake-filter — observability event with no
    // rule consumer; without this it gets dropped silently.
    bypass_filter: true,
  });

  console.log(`[E0Branch] ${branch} → ${destinationWorkflow || '?'} for ${contactId}`);

  return res.json({
    status: 'accepted',
    branch,
    contact_id: contactId,
    destination_workflow: destinationWorkflow,
  });
}

// ═══════════════════════════════════════════════════════════════════
// ROUTE REGISTRATION
// ═══════════════════════════════════════════════════════════════════

export function registerEntryEventRoutes(app) {
  // Route B agentic routing
  app.post('/webhook/ghl/entry', async (req, res) => {
    try {
      await handleEntryEvent(req, res);
    } catch (err) {
      console.error('[EntryEvent] error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });
  app.get('/webhook/ghl/entry/sources', (req, res) => {
    res.json({ valid_sources: [...VALID_SOURCES] });
  });

  // v2.0 — Safety net
  app.post('/webhook/ghl/ensure-routing-tags', async (req, res) => {
    try {
      await handleEnsureRoutingTags(req, res);
    } catch (err) {
      console.error('[EnsureRoutingTags] error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  // v2.0 — Per-branch observability
  app.post('/webhook/ghl/branch-fired', async (req, res) => {
    try {
      await handleBranchFired(req, res);
    } catch (err) {
      console.error('[E0Branch] error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  console.log('[EntryEvent] Route registered: POST /webhook/ghl/entry');
  console.log('[EntryEvent] Route registered: GET  /webhook/ghl/entry/sources');
  console.log('[EntryEvent] Route registered: POST /webhook/ghl/ensure-routing-tags  (v2.0 safety net)');
  console.log('[EntryEvent] Route registered: POST /webhook/ghl/branch-fired         (v2.0 observability)');
}
