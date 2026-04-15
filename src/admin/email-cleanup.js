/**
 * Email Cleanup — src/admin/email-cleanup.js
 * 
 * Admin endpoint to bulk-clear blacklisted emails from GHL contacts.
 * Also provides an ongoing hook that can be called periodically.
 * 
 * Routes:
 *   POST /admin/email-cleanup          — Run cleanup (dryRun=true by default)
 *   POST /admin/email-cleanup?dryRun=false — Execute for real
 *   POST /admin/email-cleanup?dryRun=false&limit=50 — Limit batch size
 * 
 * How it works:
 *   1. Queries lp_leads for emails that match the blacklist
 *   2. Gets distinct GHL contact IDs
 *   3. Fetches each GHL contact to confirm the email is still blacklisted
 *   4. Clears the email field via PUT /contacts/{id} with { email: "" }
 *   5. Adds a GHL note documenting the cleanup
 *   6. Logs to email_enrichment_log for audit trail
 */

import supabase from '../supabase.js';
import { scoreEmail } from '../email-scorer.js';
import { acquireToken } from '../ghl-rate-limiter.js';

const GHL_API_KEY = process.env.GHL_API_KEY;

async function ghlFetch(method, path, body = null) {
  if (!GHL_API_KEY) throw new Error('GHL_API_KEY not configured');
  await acquireToken();
  const url = `https://services.leadconnectorhq.com${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GHL ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : { status: res.status, ok: true };
}

/**
 * Run the email cleanup process.
 * Finds GHL contacts with blacklisted emails and clears them.
 */
export async function runEmailCleanup({ dryRun = true, limit = 200 } = {}) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const results = {
    dryRun,
    contacts_scanned: 0,
    emails_cleared: 0,
    already_clean: 0,
    ghl_not_found: 0,
    errors: 0,
    details: [],
  };

  // Step 1: Get distinct GHL contacts with blacklisted emails from Supabase
  const { data: candidates, error } = await supabase
    .from('lp_leads')
    .select('ghl_contact_id, email')
    .not('ghl_contact_id', 'is', null)
    .not('email', 'is', null)
    .order('synced_at', { ascending: false });

  if (error) throw new Error(`Query failed: ${error.message}`);
  if (!candidates?.length) return { ...results, message: 'No candidates found' };

  // Deduplicate by GHL contact ID + find blacklisted ones
  const contactMap = new Map();
  for (const row of candidates) {
    if (contactMap.has(row.ghl_contact_id)) continue;
    const emailScore = scoreEmail(row.email);
    if (emailScore.score === 0) {
      contactMap.set(row.ghl_contact_id, {
        ghlContactId: row.ghl_contact_id,
        lpEmail: row.email,
        reason: emailScore.reasons[0],
      });
    }
  }

  const toClean = Array.from(contactMap.values()).slice(0, limit);
  console.log(`[EmailCleanup] Found ${contactMap.size} contacts with blacklisted emails, processing ${toClean.length} (dryRun=${dryRun})`);

  // Step 2: For each contact, verify GHL email and clear if blacklisted
  for (const candidate of toClean) {
    results.contacts_scanned++;

    try {
      // Fetch GHL contact to check current email
      const ghlRes = await ghlFetch('GET', `/contacts/${candidate.ghlContactId}`);
      const contact = ghlRes?.contact;

      if (!contact) {
        results.ghl_not_found++;
        continue;
      }

      const currentEmail = (contact.email || '').trim().toLowerCase();
      if (!currentEmail) {
        results.already_clean++;
        continue;
      }

      // Score the GHL email
      const ghlScore = scoreEmail(currentEmail);
      if (ghlScore.score > 0) {
        // GHL has a different (non-blacklisted) email — don't touch it
        results.already_clean++;
        results.details.push({
          ghlContactId: candidate.ghlContactId,
          action: 'skipped',
          reason: `GHL email "${currentEmail}" scores ${ghlScore.score} — not blacklisted`,
        });
        continue;
      }

      // GHL email is blacklisted — clear it
      if (dryRun) {
        results.emails_cleared++;
        results.details.push({
          ghlContactId: candidate.ghlContactId,
          name: contact.name || contact.firstName || 'Unknown',
          email: currentEmail,
          reason: ghlScore.reasons[0],
          action: 'would_clear',
        });
      } else {
        // Clear the email field
        await ghlFetch('PUT', `/contacts/${candidate.ghlContactId}`, { email: '' });
        results.emails_cleared++;

        // Add GHL note for audit trail
        try {
          await ghlFetch('POST', `/contacts/${candidate.ghlContactId}/notes`, {
            body: `[EMAIL CLEANUP] Removed blacklisted email "${currentEmail}" (reason: ${ghlScore.reasons[0]}). LP has no valid replacement email for this contact.`,
          });
        } catch {}

        // Log to enrichment log
        try {
          await supabase.from('email_enrichment_log').insert({
            ghl_contact_id: candidate.ghlContactId,
            old_email: currentEmail,
            new_email: null,
            confidence_score: 0,
            scoring_reasons: ghlScore.reasons,
            action_taken: 'cleared_blacklisted',
          });
        } catch {}

        results.details.push({
          ghlContactId: candidate.ghlContactId,
          name: contact.name || contact.firstName || 'Unknown',
          email: currentEmail,
          reason: ghlScore.reasons[0],
          action: 'cleared',
        });

        // Rate limit: 200ms between GHL calls
        await sleep(200);
      }
    } catch (err) {
      results.errors++;
      results.details.push({
        ghlContactId: candidate.ghlContactId,
        action: 'error',
        error: err.message,
      });
    }
  }

  console.log(`[EmailCleanup] Done: ${results.emails_cleared} ${dryRun ? 'would be' : ''} cleared, ${results.already_clean} already clean, ${results.errors} errors`);
  return results;
}

/**
 * Register the admin route.
 */
export function registerEmailCleanupRoutes(app) {
  app.post('/admin/email-cleanup', async (req, res) => {
    try {
      const dryRun = req.query.dryRun !== 'false';
      const limit = parseInt(req.query.limit || '200', 10);
      const results = await runEmailCleanup({ dryRun, limit });
      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log('[EmailCleanup] Registered: POST /admin/email-cleanup');
}
