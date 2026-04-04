/**
 * n8n Helper APIs — replaces Code nodes in Token Keeper and Prospect ID Lookup workflows
 * 
 * POST /n8n/refresh-token   — Gets LP token and stores in GHL custom value
 * POST /n8n/prospect-lookup  — Searches LP by phone/email/name, scores matches, returns best prospect ID
 */

import { getToken } from './token-manager.js';

const LP_API_BASE = process.env.LP_API_BASE_URL || 'https://api.leadperfection.com';
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = 'SsBG7j5KQAIP1SFP2Sca';

// ─── Helpers ─────────────────────────────────────────────────────

async function lpPost(path, params, token) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(`${LP_API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Bearer ${token}` },
    body,
    signal: AbortSignal.timeout(30000),
  });
  return res.json();
}

async function ghlRequest(method, url, body) {
  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Content-Type': 'application/json', 'Accept': 'application/json' },
    signal: AbortSignal.timeout(30000),
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return res.json();
}

function parseResults(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (data.Records) return Array.isArray(data.Records) ? data.Records : [data.Records];
  if (data.Data) return Array.isArray(data.Data) ? data.Data : [data.Data];
  if (data.Result) return Array.isArray(data.Result) ? data.Result : [data.Result];
  if (data.cst_id || data.ProspectID) return [data];
  return [];
}

const clean = (s) => String(s || '').toLowerCase().trim();
const cleanPhone = (p) => String(p || '').replace(/\D/g, '').slice(-10);

// ═══════════════════════════════════════════════════════════════════
// TOKEN KEEPER — POST /n8n/refresh-token
// Replaces: Validate Token + Find Token Custom Value + Log Success
// ═══════════════════════════════════════════════════════════════════

async function handleRefreshToken(req, res) {
  const startTime = Date.now();
  try {
    // Step 1: Get fresh LP token via LP MCP's token manager
    const token = await getToken();
    if (!token) {
      return res.status(500).json({ success: false, error: 'Failed to get LP token' });
    }

    // Step 2: Get GHL custom values to find lp_active_token
    const cvResponse = await ghlRequest('GET', `https://services.leadconnectorhq.com/locations/${GHL_LOCATION_ID}/customValues`);
    const customValues = cvResponse.customValues || cvResponse.data || [];
    const existing = customValues.find(cv =>
      cv.name === 'lp_active_token' || cv.name === 'LP Active Token' || cv.name === 'lp active token'
    );

    // Step 3: Create or update the custom value
    let cvResult;
    if (existing) {
      cvResult = await ghlRequest('PUT', `https://services.leadconnectorhq.com/locations/${GHL_LOCATION_ID}/customValues/${existing.id}`, {
        name: existing.name,
        value: token,
      });
    } else {
      cvResult = await ghlRequest('POST', `https://services.leadconnectorhq.com/locations/${GHL_LOCATION_ID}/customValues`, {
        name: 'lp_active_token',
        value: token,
      });
    }

    const elapsed = Date.now() - startTime;
    const now = new Date().toISOString();
    res.json({
      success: true,
      action: existing ? 'updated' : 'created',
      cv_id: cvResult.customValue?.id || existing?.id || 'unknown',
      generated_at: now,
      next_refresh: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
      elapsed_ms: elapsed,
    });
  } catch (err) {
    console.error('[n8n/refresh-token] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════
// PROSPECT LOOKUP — POST /n8n/prospect-lookup
// Replaces: Parse Lookup Params + Extract Cached Token + Score & Pick Best Match
// ═══════════════════════════════════════════════════════════════════

async function handleProspectLookup(req, res) {
  const startTime = Date.now();
  try {
    const body = req.body || {};
    const contact_id = body.contact_id || body.contactId || '';
    const phone = body.phone || body.Phone || '';
    const email = body.email || body.Email || '';
    const last_name = body.last_name || body.lastName || body.lastname || '';
    const first_name = body.first_name || body.firstName || body.firstname || '';
    const address1 = body.address1 || body.address || '';
    const city = body.city || body.City || '';
    const state = body.state || body.State || '';
    const zip = body.postalCode || body.postal_code || body.zip || '';

    if (!contact_id) {
      return res.status(400).json({ success: false, error: 'contact_id is required' });
    }
    if (!phone && !last_name && !email) {
      return res.status(400).json({ success: false, error: 'Need at least phone, last_name, or email to search LP', contact_id });
    }

    // Get LP token
    const token = await getToken();
    if (!token) {
      return res.status(500).json({ success: false, error: 'Failed to get LP token', contact_id });
    }

    // Run all 4 searches in parallel
    const now = new Date();
    const oneYearAgo = new Date(now); oneYearAgo.setFullYear(now.getFullYear() - 1);
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    const fmt = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;

    const searches = await Promise.allSettled([
      lpPost('/api/Leads/GetInboundLeadInfo', { lognumber: contact_id, startdate: fmt(oneYearAgo), enddate: fmt(tomorrow), PageSize: '10', StartIndex: '1' }, token),
      phone ? lpPost('/api/Customers/GetCustomers3', { phone }, token) : Promise.resolve(null),
      email ? lpPost('/api/Customers/GetCustomers3', { email }, token) : Promise.resolve(null),
      last_name ? lpPost('/api/Customers/GetCustomers3', { lastname: last_name }, token) : Promise.resolve(null),
    ]);

    const lognumberResults = parseResults(searches[0].status === 'fulfilled' ? searches[0].value : null);
    const phoneResults = parseResults(searches[1].status === 'fulfilled' ? searches[1].value : null);
    const emailResults = parseResults(searches[2].status === 'fulfilled' ? searches[2].value : null);
    const nameResults = parseResults(searches[3].status === 'fulfilled' ? searches[3].value : null);

    // Check lognumber first (highest confidence)
    if (lognumberResults.length > 0) {
      const match = lognumberResults[0];
      const prospectId = match.cst_id || match.ProspectID || match.prospect_id || '';
      if (prospectId) {
        // Save to GHL and add tag
        await saveProspectToGHL(contact_id, String(prospectId), 100, 'lognumber (exact match)');
        const elapsed = Date.now() - startTime;
        return res.json({
          success: true, lp_prospect_id: String(prospectId), contact_id, confidence: 100,
          found_by: 'lognumber (exact match)', match_details: `GHL contact_id matched LP lognumber — Prospect ID: ${prospectId}`,
          candidates_evaluated: 1, ghl_updated: true, elapsed_ms: elapsed,
        });
      }
    }

    // Merge + deduplicate all results
    const allResults = [...phoneResults, ...emailResults, ...nameResults];
    const candidateMap = new Map();
    for (const record of allResults) {
      const pid = String(record.cst_id || record.ProspectID || record.prospect_id || '');
      if (pid && !candidateMap.has(pid)) candidateMap.set(pid, record);
    }

    const candidates = Array.from(candidateMap.entries());
    if (candidates.length === 0) {
      const elapsed = Date.now() - startTime;
      return res.json({
        success: false, lp_prospect_id: '', contact_id, confidence: 0, found_by: 'none',
        match_details: `No candidates found. Searches: lognumber(${lognumberResults.length}), phone(${phoneResults.length}), email(${emailResults.length}), name(${nameResults.length})`,
        candidates_evaluated: 0, ghl_updated: false, elapsed_ms: elapsed,
      });
    }

    // Score each candidate
    const ghl = { contact_id, phone, email, last_name, first_name, address1, city, zip };
    const scored = candidates.map(([pid, record]) => {
      let score = 0;
      const matchedFields = [];

      const recPhone = cleanPhone(record.phone || record.Phone || record.HomePhone || '');
      if (cleanPhone(ghl.phone) && recPhone && recPhone === cleanPhone(ghl.phone)) { score += 40; matchedFields.push('phone'); }

      const recEmail = clean(record.email || record.Email || '');
      if (clean(ghl.email) && recEmail && recEmail === clean(ghl.email)) { score += 35; matchedFields.push('email'); }

      const recLN = clean(record.lastname || record.LastName || '');
      if (clean(ghl.last_name) && recLN && recLN === clean(ghl.last_name)) { score += 15; matchedFields.push('last_name'); }

      const recFN = clean(record.firstname || record.FirstName || '');
      if (clean(ghl.first_name) && recFN && recFN === clean(ghl.first_name)) { score += 15; matchedFields.push('first_name'); }

      const recAddr = clean(record.address1 || record.Address1 || '');
      if (clean(ghl.address1) && recAddr && clean(ghl.address1).length > 3 && (recAddr.includes(clean(ghl.address1)) || clean(ghl.address1).includes(recAddr))) { score += 10; matchedFields.push('address'); }

      const recCity = clean(record.city || record.City || '');
      if (clean(ghl.city) && recCity && recCity === clean(ghl.city)) { score += 5; matchedFields.push('city'); }

      const recZip = clean(record.zip || record.Zip || record.postalcode || '');
      if (clean(ghl.zip) && recZip && recZip.substring(0, 5) === clean(ghl.zip).substring(0, 5)) { score += 5; matchedFields.push('zip'); }

      return {
        prospect_id: pid,
        name: `${record.firstname || record.FirstName || ''} ${record.lastname || record.LastName || ''}`.trim(),
        phone: record.phone || record.Phone || '', email: record.email || record.Email || '',
        address: record.address1 || record.Address1 || '',
        score, matchedFields, matchCount: matchedFields.length,
      };
    });

    scored.sort((a, b) => b.score - a.score || b.matchCount - a.matchCount);

    const best = scored[0];
    const secondBest = scored.length > 1 ? scored[1] : null;

    let accepted = false;
    let rejectReason = '';
    if (best.score >= 55) accepted = true;
    else if (best.score >= 40 && (!secondBest || secondBest.score < 30)) accepted = true;
    else if (best.score >= 35 && (!secondBest || secondBest.score < 20)) accepted = true;
    else if (secondBest && best.score - secondBest.score < 10) {
      rejectReason = `Ambiguous: top 2 scored ${best.score} vs ${secondBest.score}. ${best.name} (LP #${best.prospect_id}) vs ${secondBest.name} (LP #${secondBest.prospect_id}). Needs manual review.`;
    } else {
      rejectReason = `Score too low (${best.score}/125). Matched: ${best.matchedFields.join(', ') || 'none'}. Best: ${best.name} (LP #${best.prospect_id}).`;
    }

    // If accepted, save to GHL
    if (accepted) {
      await saveProspectToGHL(contact_id, best.prospect_id, best.score, best.matchedFields.join(' + '));
    }

    const elapsed = Date.now() - startTime;
    res.json({
      success: accepted,
      lp_prospect_id: accepted ? best.prospect_id : '',
      contact_id,
      confidence: best.score,
      found_by: accepted ? best.matchedFields.join(' + ') : 'none',
      match_details: accepted
        ? `Matched ${best.name} (LP #${best.prospect_id}) — score ${best.score}/125 on: ${best.matchedFields.join(', ')}`
        : rejectReason,
      best_candidate: { prospect_id: best.prospect_id, name: best.name, phone: best.phone, email: best.email, score: best.score, matched_fields: best.matchedFields },
      runner_up: secondBest ? { prospect_id: secondBest.prospect_id, name: secondBest.name, score: secondBest.score, matched_fields: secondBest.matchedFields } : null,
      candidates_evaluated: scored.length,
      all_scores: scored.slice(0, 10).map(s => ({ id: s.prospect_id, name: s.name, score: s.score, fields: s.matchedFields })),
      ghl_updated: accepted,
      elapsed_ms: elapsed,
    });
  } catch (err) {
    console.error('[n8n/prospect-lookup] Error:', err.stack || err.message);
    res.status(500).json({ success: false, error: err.message, contact_id: req.body?.contact_id || '' });
  }
}

async function saveProspectToGHL(contactId, prospectId, confidence, foundBy) {
  try {
    // Save prospect ID + confidence to GHL custom fields
    await ghlRequest('PUT', `https://services.leadconnectorhq.com/contacts/${contactId}`, {
      customFields: [
        { key: 'lp_prospect_id', field_value: prospectId },
        { key: 'lp_match_confidence', field_value: `${confidence}/100 via ${foundBy}` },
        { key: 'lp_last_synced', field_value: new Date().toISOString() },
      ],
    });
    // Add lp-linked tag (POST to avoid overwriting existing tags)
    await ghlRequest('POST', `https://services.leadconnectorhq.com/contacts/${contactId}/tags`, { tags: ['lp-linked'] });
  } catch (e) {
    console.error('[n8n/prospect-lookup] Failed to save to GHL:', e.message);
  }
}

// ─── Register routes ─────────────────────────────────────────────

export function registerN8nHelperRoutes(app) {
  app.post('/n8n/refresh-token', handleRefreshToken);
  app.post('/n8n/prospect-lookup', handleProspectLookup);
}
