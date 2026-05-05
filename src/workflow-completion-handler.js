/**
 * Workflow Completion Handler — src/workflow-completion-handler.js
 * 
 * Self-enriching endpoint for workflow completion signals.
 * Uses the same pattern as contact-created: accepts just contactId,
 * calls GHL API to find the completed:* tag, resolves the workflow ID.
 * 
 * GHL Setup (ONE workflow handles all completions):
 *   1. Each content workflow adds a tag: completed:w02, completed:w03, etc.
 *   2. ONE GHL workflow triggers on "Contact Tag Added" → tag contains "completed:"
 *   3. That workflow POSTs to /webhook/ghl/workflow-tag with contactId: {{contact.id}}
 *   4. This endpoint self-enriches, resolves the workflow, emits the event
 *   5. The GHL workflow then removes the completed:* tag (cleanup for re-entry)
 * 
 * Integration: Add 2 lines to index.js:
 *   import { registerWorkflowCompletionRoutes } from './workflow-completion-handler.js';
 *   registerWorkflowCompletionRoutes(app);
 * 
 * v1.1 — 2026-05-05. Added completed:wec mapping for the Window Estimate
 *   Calculator entry receiver workflow (59e07e46). Pairs with the
 *   ESTIMATE_CALC_COMPLETED rule re-aim from ghl.lead_score_changed (proxy)
 *   to ghl.workflow_completed (direct signal). Mark adds the
 *   "Add Contact Tag: completed:wec" step at end of the entry receiver
 *   workflow in GHL UI.
 *
 * v1.0 — Initial implementation. Tag-to-workflow mapping for 20 workflows.
 */

import { emitEvent } from './event-emitter.js';

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_WEBHOOK_SECRET = process.env.GHL_WEBHOOK_SECRET || '';

function validateWebhook(req) {
  if (!GHL_WEBHOOK_SECRET) return true;
  const provided = req.headers['x-ghl-signature']
    || req.headers['x-webhook-secret']
    || req.query.secret
    || '';
  return provided === GHL_WEBHOOK_SECRET;
}

// ═══════════════════════════════════════════════════════════════════
// TAG → WORKFLOW MAPPING
// ═══════════════════════════════════════════════════════════════════

const TAG_TO_WORKFLOW = {
  // Tier 0 entry receivers (ingestion workflows that fire BEFORE W0.x bridges)
  'completed:wec':    { id: '59e07e46-19fc-4dab-a068-94dd1588a7bd', name: 'Window Estimate Calculator Completed (entry receiver)' },

  // Tier 1 bridges
  'completed:w01':    { id: '85f4600a-a55d-4fb5-bd62-d2886dc3d461', name: 'W0.1 - Risk Report Entry Bridge' },
  'completed:w02':    { id: '74c90736-6550-4504-881d-2849231aa63c', name: 'W0.2 - Estimate Calculator Bridge' },
  'completed:w03':    { id: '2d404941-fc8b-46c7-a310-2acd176eb2f9', name: 'W0.3 - Chatbot Intent Qualifier' },
  'completed:w04':    { id: 'd526e09e-4922-42d5-9634-5e2fcc3e5222', name: 'W0.4 - Canvassing Pre-Frame Bridge' },
  'completed:w05':    { id: '0c7b2137-76fd-46d9-9f9b-75d095d3d769', name: 'W0.5 - Other / Unknown Bridge' },
  'completed:w06':    { id: 'e3ad4b2f-8ef8-4978-aeec-9732a8db9fc1', name: 'W0.6 - Referral Entry Bridge' },
  'completed:w07':    { id: '92c5d673-dede-4b4a-9629-3a4a7f9bd1e9', name: 'W0.7 - High-Intent Digital Bridge' },
  'completed:w11':    { id: 'da06ee55-2ab0-450d-981a-0e50703f4b4d', name: 'W1.1 - EC Indoctrination' },
  'completed:w12':    { id: 'ea3c3aed-77a4-470d-bc3c-1b1765bfff3b', name: 'W1.2 - Canvassing/Chatbot Indoctrination' },
  'completed:w21':    { id: '69fdc012-cefc-4917-b156-d6dbc8d13b7c', name: 'W2.1 - Pricing Accuracy Content' },
  'completed:w31':    { id: 'd693f40a-9dd6-4d54-ab07-da76669cdc39', name: 'W3.1 - Calculator Solution Pitch' },
  'completed:w45':    { id: '40d77229-555d-49da-9987-9c57db191c0c', name: 'W4.5 - Seinfeld Broadcast' },
  'completed:w51':    { id: 'a708de2e-3ff4-440f-8d2b-39b3c49d7f06', name: 'W5.1 - Decision Compression' },
  'completed:w52':    { id: '613dbbbd-b7af-4be0-81fa-371f3e1d7b14', name: 'W5.2 - Appointment Rescue' },
  'completed:w60':    { id: 'fc8a2dd2-caa7-432a-9aae-2a64dd19fa80', name: 'W6.0 - Review Session Confirmation' },
  'completed:w80':    { id: '15f47572-9ffc-453d-995d-a1890441f290', name: 'W8.0 - Post Appointment Follow-Up' },
  'completed:w90':    { id: 'fdf4ad82-33ab-4e73-b581-18d21d51ac42', name: 'W9.0 - Objection Handler' },
  'completed:objval': { id: '377de49d-f8df-4f41-b9e4-8e9aba36732f', name: 'Objection Validator + Tag Sync' },
  'completed:w100':   { id: 'fd3d777a-25e0-4b49-8de8-971e22f64aea', name: 'W10.0 - Sales/Close' },
  'completed:w120':   { id: '6b2c2920-a21b-4ebd-92df-8e31ef4ed8dc', name: 'W12.0 - Customer Onboarding' },
};

async function handleWorkflowCompletedByTag(req, res) {
  const body = req.body || {};
  const contactId = body.contactId || body.contact_id || body.id || null;

  if (!contactId) return res.status(400).json({ error: 'Missing contactId' });

  // Self-enrich: fetch contact tags from GHL API
  let tags = [];
  if (GHL_API_KEY) {
    try {
      const ghlRes = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
        headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (ghlRes.ok) {
        const data = await ghlRes.json();
        tags = data?.contact?.tags || [];
      }
    } catch (err) {
      console.warn(`[WorkflowCompletion] GHL lookup failed for ${contactId}: ${err.message}`);
    }
  }

  // Fallback: accept tags from webhook body (comma-separated or array)
  if (tags.length === 0) {
    const raw = body.tags || body.contactTags;
    if (Array.isArray(raw)) tags = raw;
    else if (typeof raw === 'string') tags = raw.split(',').map(t => t.trim()).filter(Boolean);
  }

  const completedTags = tags.filter(t => t.startsWith('completed:'));
  if (completedTags.length === 0) {
    console.warn(`[WorkflowCompletion] No completed:* tags for ${contactId}`);
    return res.json({ status: 'accepted', event_type: 'none', reason: 'no_completed_tag_found' });
  }

  const emitted = [];
  for (const tag of completedTags) {
    const workflow = TAG_TO_WORKFLOW[tag];
    const workflowId = workflow?.id || tag.replace('completed:', '');
    const workflowName = workflow?.name || `Unknown (${tag})`;

    const timeBucket = Math.floor(Date.now() / (30 * 60 * 1000));
    await emitEvent({
      event_type: 'ghl.workflow_completed',
      event_subtype: workflowId,
      source: 'ghl_webhook_tag',
      entity_type: 'contact',
      entity_id: contactId,
      ghl_contact_id: contactId,
      payload: { workflow_id: workflowId, workflow_name: workflowName, completion_tag: tag },
      priority: 'normal',
      idempotency_key: `ghl_wf_tag_${contactId}_${tag}_${timeBucket}`,
    });
    emitted.push({ tag, workflowId, workflowName });
    console.log(`[WorkflowCompletion] ${tag} → ${workflowName} (${workflowId}) for ${contactId}`);
  }

  return res.json({ status: 'accepted', event_type: 'ghl.workflow_completed', workflows_completed: emitted });
}

// ═══════════════════════════════════════════════════════════════════
// ROUTE REGISTRATION
// ═══════════════════════════════════════════════════════════════════

export function registerWorkflowCompletionRoutes(app) {
  const validateGHL = (req, res, next) => {
    if (!validateWebhook(req)) {
      console.warn(`[WorkflowCompletion] Rejected: invalid secret from ${req.ip}`);
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }
    next();
  };

  app.post('/webhook/ghl/workflow-tag', validateGHL, async (req, res) => {
    try { await handleWorkflowCompletedByTag(req, res); }
    catch (err) { console.error('[WorkflowCompletion] error:', err.message); if (!res.headersSent) res.status(500).json({ error: err.message }); }
  });

  console.log('[WorkflowCompletion] Route registered: POST /webhook/ghl/workflow-tag');
}
