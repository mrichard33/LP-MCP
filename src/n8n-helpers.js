/**
 * n8n Helper APIs — replaces Code nodes in Token Keeper, Prospect ID Lookup, and Time to Appointment workflows
 * 
 * POST /n8n/refresh-token        — Gets LP token and stores in GHL custom value
 * POST /n8n/prospect-lookup      — Searches LP by phone/email/name, scores matches, returns best prospect ID
 * POST /n8n/time-to-appointment  — Parses GHL appointment date string, calculates hours until appointment
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
// TIME TO APPOINTMENT — POST /n8n/time-to-appointment
// Handles ALL common date formats:
//   1. "Saturday, April 5, 2026 2:00 PM" (GHL formatted display)
//   2. "2026-04-05T18:00:00.000Z" (ISO 8601 — GHL startTime)
//   3. "2026-04-05T14:00:00-04:00" (ISO with offset)
//   4. "04/05/2026 2:00 PM" (MM/DD/YYYY AM/PM)
//   5. "1775595600000" (epoch milliseconds)
//   6. "1775595600" (epoch seconds)
// All treated as America/New_York local UNLESS they have a timezone offset or are UTC.
// ═══════════════════════════════════════════════════════════════════

function parseFlexibleDateToUTC(raw) {
  const s = String(raw || '').trim();
  if (!s) throw new Error('Empty appointment_start');

  const months = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };

  // 1. ISO 8601 with Z or offset: "2026-04-05T18:00:00.000Z" or "2026-04-05T14:00:00-04:00"
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d;
  }

  // 2. Pure epoch (ms if > 10 billion, seconds otherwise)
  if (/^\d{10,13}$/.test(s)) {
    const num = Number(s);
    const ms = num > 9999999999 ? num : num * 1000;
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d;
  }

  // 3. GHL formatted: "Saturday, April 5, 2026 2:00 PM" (with or without day name)
  const ghlMatch = s.match(/(?:[A-Za-z]+,?\s+)?([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (ghlMatch) {
    const monthIdx = months[ghlMatch[1].toLowerCase()];
    if (monthIdx !== undefined) {
      const day = Number(ghlMatch[2]);
      const year = Number(ghlMatch[3]);
      let hour = Number(ghlMatch[4]);
      const minute = Number(ghlMatch[5]);
      const ampm = ghlMatch[6].toUpperCase();
      if (ampm === 'PM' && hour !== 12) hour += 12;
      if (ampm === 'AM' && hour === 12) hour = 0;
      return localNYToUTC(year, monthIdx, day, hour, minute);
    }
  }

  // 4. MM/DD/YYYY H:MM AM/PM: "04/05/2026 2:00 PM"
  const usMatch = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (usMatch) {
    const monthIdx = Number(usMatch[1]) - 1;
    const day = Number(usMatch[2]);
    const year = Number(usMatch[3]);
    let hour = Number(usMatch[4]);
    const minute = Number(usMatch[5]);
    const ampm = usMatch[6].toUpperCase();
    if (ampm === 'PM' && hour !== 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    return localNYToUTC(year, monthIdx, day, hour, minute);
  }

  // 5. MM/DD/YYYY without time (assume noon)
  const dateOnly = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dateOnly) {
    return localNYToUTC(Number(dateOnly[3]), Number(dateOnly[1]) - 1, Number(dateOnly[2]), 12, 0);
  }

  // 6. YYYY-MM-DD without time (assume noon ET)
  const isoDate = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDate) {
    return localNYToUTC(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]), 12, 0);
  }

  // 7. Last resort: try native Date parse
  const lastResort = new Date(s);
  if (!isNaN(lastResort.getTime())) return lastResort;

  throw new Error('Unrecognized appointment_start format: ' + s);
}

/** Convert local America/New_York time components to UTC Date */
function localNYToUTC(year, monthIdx, day, hour, minute) {
  // Create a UTC date from the local components
  const utcGuess = new Date(Date.UTC(year, monthIdx, day, hour, minute, 0));

  // Get the NY offset at that moment
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });

  const parts = fmt.formatToParts(utcGuess).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  const nyRendered = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );

  const offsetMinutes = (nyRendered - utcGuess.getTime()) / 60000;
  return new Date(Date.UTC(year, monthIdx, day, hour, minute, 0) - offsetMinutes * 60000);
}

async function handleTimeToAppointment(req, res) {
  try {
    const body = req.body || {};
    const contactId = body.contact_id || body.contactId || '';
    const apptStartRaw = body.appointment_start || body.appointmentStart || body.start_time || body.startTime || '';

    if (!contactId) {
      return res.status(400).json({ success: false, error: 'Missing contact_id' });
    }
    if (!apptStartRaw) {
      return res.status(400).json({ success: false, error: 'Missing appointment_start', contact_id: contactId });
    }

    const apptUTC = parseFlexibleDateToUTC(apptStartRaw);
    const now = new Date();
    const diffMs = apptUTC.getTime() - now.getTime();
    const diffHoursExact = diffMs / (1000 * 60 * 60);
    const time_to_appointment_hours = Math.max(0, Math.round(diffHoursExact * 10) / 10);

    res.json({
      success: true,
      contact_id: contactId,
      time_to_appointment_hours,
      appointment_start_utc: apptUTC.toISOString(),
      now_utc: now.toISOString(),
      parsed_from: apptStartRaw,
    });
  } catch (err) {
    console.error('[n8n/time-to-appointment] Error:', err.message);
    res.status(500).json({ success: false, error: err.message, contact_id: req.body?.contact_id || '' });
  }
}

// ═══════════════════════════════════════════════════════════════════
// TOKEN KEEPER — POST /n8n/refresh-token
// ═══════════════════════════════════════════════════════════════════

async function handleRefreshToken(req, res) {
  const startTime = Date.now();
  try {
    const token = await getToken();
    if (!token) {
      return res.status(500).json({ success: false, error: 'Failed to get LP token' });
    }

    const cvResponse = await ghlRequest('GET', `https://services.leadconnectorhq.com/locations/${GHL_LOCATION_ID}/customValues`);
    const customValues = cvResponse.customValues || cvResponse.data || [];
    const existing = customValues.find(cv =>
      cv.name === 'lp_active_token' || cv.name === 'LP Active Token' || cv.name === 'lp active token'
    );

    let cvResult;
    if (existing) {
      cvResult = await ghlRequest('PUT', `https://services.leadconnectorhq.com/locations/${GHL_LOCATION_ID}/customValues/${existing.id}`, {
        name: existing.name, value: token,
      });
    } else {
      cvResult = await ghlRequest('POST', `https://services.leadconnectorhq.com/locations/${GHL_LOCATION_ID}/customValues`, {
        name: 'lp_active_token', value: token,
      });
    }

    const elapsed = Date.now() - startTime;
    res.json({
      success: true, action: existing ? 'updated' : 'created',
      cv_id: cvResult.customValue?.id || existing?.id || 'unknown',
      generated_at: new Date().toISOString(),
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

    const token = await getToken();
    if (!token) {
      return res.status(500).json({ success: false, error: 'Failed to get LP token', contact_id });
    }

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

    if (lognumberResults.length > 0) {
      const match = lognumberResults[0];
      const prospectId = match.cst_id || match.ProspectID || match.prospect_id || '';
      if (prospectId) {
        await saveProspectToGHL(contact_id, String(prospectId), 100, 'lognumber (exact match)');
        const elapsed = Date.now() - startTime;
        return res.json({
          success: true, lp_prospect_id: String(prospectId), contact_id, confidence: 100,
          found_by: 'lognumber (exact match)', match_details: `GHL contact_id matched LP lognumber — Prospect ID: ${prospectId}`,
          candidates_evaluated: 1, ghl_updated: true, elapsed_ms: elapsed,
        });
      }
    }

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

    if (accepted) {
      await saveProspectToGHL(contact_id, best.prospect_id, best.score, best.matchedFields.join(' + '));
    }

    const elapsed = Date.now() - startTime;
    res.json({
      success: accepted, lp_prospect_id: accepted ? best.prospect_id : '', contact_id,
      confidence: best.score, found_by: accepted ? best.matchedFields.join(' + ') : 'none',
      match_details: accepted
        ? `Matched ${best.name} (LP #${best.prospect_id}) — score ${best.score}/125 on: ${best.matchedFields.join(', ')}`
        : rejectReason,
      best_candidate: { prospect_id: best.prospect_id, name: best.name, phone: best.phone, email: best.email, score: best.score, matched_fields: best.matchedFields },
      runner_up: secondBest ? { prospect_id: secondBest.prospect_id, name: secondBest.name, score: secondBest.score, matched_fields: secondBest.matchedFields } : null,
      candidates_evaluated: scored.length,
      all_scores: scored.slice(0, 10).map(s => ({ id: s.prospect_id, name: s.name, score: s.score, fields: s.matchedFields })),
      ghl_updated: accepted, elapsed_ms: elapsed,
    });
  } catch (err) {
    console.error('[n8n/prospect-lookup] Error:', err.stack || err.message);
    res.status(500).json({ success: false, error: err.message, contact_id: req.body?.contact_id || '' });
  }
}

async function saveProspectToGHL(contactId, prospectId, confidence, foundBy) {
  try {
    await ghlRequest('PUT', `https://services.leadconnectorhq.com/contacts/${contactId}`, {
      customFields: [
        { key: 'lp_prospect_id', field_value: prospectId },
        { key: 'lp_match_confidence', field_value: `${confidence}/100 via ${foundBy}` },
        { key: 'lp_last_synced', field_value: new Date().toISOString() },
      ],
    });
    await ghlRequest('POST', `https://services.leadconnectorhq.com/contacts/${contactId}/tags`, { tags: ['lp-linked'] });
  } catch (e) {
    console.error('[n8n/prospect-lookup] Failed to save to GHL:', e.message);
  }
}

// ─── Register routes ─────────────────────────────────────────────

export function registerN8nHelperRoutes(app) {
  app.post('/n8n/refresh-token', handleRefreshToken);
  app.post('/n8n/prospect-lookup', handleProspectLookup);
  app.post('/n8n/time-to-appointment', handleTimeToAppointment);
}
