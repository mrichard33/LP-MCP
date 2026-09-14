/**
 * Email Cleanup — src/admin/email-cleanup.js
 *
 * Admin endpoint to bulk-clear blacklisted emails from GHL contacts,
 * auto-correct recoverable typo domains, and (optionally) run daily.
 *
 * Routes:
 *   POST /admin/email-cleanup          — Run cleanup (dryRun=true by default)
 *   POST /admin/email-cleanup?dryRun=false — Execute for real
 *   POST /admin/email-cleanup?dryRun=false&limit=50 — Limit batch size
 *
 * Scheduler (2026-07-03):
 *   EMAIL_CLEANUP_SWEEP_ENABLED=true      — enables a daily LIVE run (default OFF)
 *   EMAIL_CLEANUP_SWEEP_INTERVAL_MIN=1440 — interval between runs
 *   EMAIL_CLEANUP_SWEEP_LIMIT=200         — max contacts per run
 *
 * How it works:
 *   1. Queries lp_leads for emails that hard-fail scoreEmail (score = 0)
 *   2. Gets distinct GHL contact IDs
 *   3. Fetches each GHL contact to confirm the email still hard-fails
 *   4a. typo_domain_suggest:* reason → CORRECTS the email (gmail.comm → gmail.com)
 *   4b. any other hard-fail → CLEARS the email via PUT { email: "" }
 *       (GHL cannot send to an empty email — all future sends stop)
 *   5. Adds a GHL note documenting the action
 *   6. Logs to email_enrichment_log for audit trail
 */

import supabase from '../supabase.js';
import { scoreEmail } from '../email-scorer.js';
import { withGhlToken } from '../ghl-rate-limiter.js';

const GHL_API_KEY = process.env.GHL_API_KEY;

async function ghlFetch(method, path, body = null) {
  if (!GHL_API_KEY) throw new Error('GHL_API_KEY not configured');
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
  // 2026-09-14: was acquireToken() + a bare fetch, which held a token but
  // never called report429() — this module's throttling was invisible to the
  // limiter. withGhlToken does both halves.
  const res = await withGhlToken(() => fetch(url, opts));
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GHL ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : { status: res.status, ok: true };
}

/** Extract the corrected address from a typo_domain_suggest:<addr> reason. */
function typoSuggestion(reasons) {
  const hit = (reasons || []).find(r => typeof r === 'string' && r.startsWith('typo_domain_suggest:'));
  if (!hit) return null;
  const suggested = hit.slice('typo_domain_suggest:'.length).trim();
  // Sanity: must look like an email before we ever write it to a contact
  return /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(suggested) ? suggested : null;
}

/**
 * Run the email cleanup process.
 * Finds GHL contacts with hard-failed emails; corrects typo domains,
 * clears everything else.
 */
export async function runEmailCleanup({ dryRun = true, limit = 200 } = {}) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const results = {
    dryRun,
    contacts_scanned: 0,
    emails_cleared: 0,
    emails_corrected: 0,
    already_clean: 0,
    ghl_not_found: 0,
    errors: 0,
    details: [],
  };

  // Step 1: Get distinct GHL contacts with hard-failed emails from Supabase
  const { data: candidates, error } = await supabase
    .from('lp_leads')
    .select('ghl_contact_id, email')
    .not('ghl_contact_id', 'is', null)
    .not('email', 'is', null)
    .order('synced_at', { ascending: false });

  if (error) throw new Error(`Query failed: ${error.message}`);
  if (!candidates?.length) return { ...results, message: 'No candidates found' };

  // Deduplicate by GHL contact ID + find hard-failed ones
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
  console.log(`[EmailCleanup] Found ${contactMap.size} contacts with hard-failed emails, processing ${toClean.length} (dryRun=${dryRun})`);

  // Step 2: For each contact, verify GHL email and correct/clear
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
        // GHL has a different (non-hard-failed) email — don't touch it
        results.already_clean++;
        results.details.push({
          ghlContactId: candidate.ghlContactId,
          action: 'skipped',
          reason: `GHL email "${currentEmail}" scores ${ghlScore.score} — not hard-failed`,
        });
        continue;
      }

      const name = contact.name || contact.firstName || 'Unknown';
      const correction = typoSuggestion(ghlScore.reasons);

      if (dryRun) {
        if (correction) {
          results.emails_corrected++;
          results.details.push({
            ghlContactId: candidate.ghlContactId, name, email: currentEmail,
            reason: ghlScore.reasons[0], action: 'would_correct', corrected_to: correction,
          });
        } else {
          results.emails_cleared++;
          results.details.push({
            ghlContactId: candidate.ghlContactId, name, email: currentEmail,
            reason: ghlScore.reasons[0], action: 'would_clear',
          });
        }
        continue;
      }

      if (correction) {
        // ── Typo domain: CORRECT the email instead of destroying it ──
        await ghlFetch('PUT', `/contacts/${candidate.ghlContactId}`, { email: correction });
        results.emails_corrected++;

        try {
          await ghlFetch('POST', `/contacts/${candidate.ghlContactId}/notes`, {
            body: `[EMAIL CLEANUP] Corrected typo email "${currentEmail}" → "${correction}" (reason: ${ghlScore.reasons[0]}). If mail to the corrected address also bounces, please collect a fresh email at next contact.`,
          });
        } catch {}

        try {
          await supabase.from('email_enrichment_log').insert({
            ghl_contact_id: candidate.ghlContactId,
            old_email: currentEmail,
            new_email: correction,
            confidence_score: 0,
            scoring_reasons: ghlScore.reasons,
            action_taken: 'corrected_typo_domain',
          });
        } catch {}

        results.details.push({
          ghlContactId: candidate.ghlContactId, name, email: currentEmail,
          reason: ghlScore.reasons[0], action: 'corrected', corrected_to: correction,
        });
      } else {
        // ── Placeholder/fake: CLEAR the email so GHL cannot send to it ──
        await ghlFetch('PUT', `/contacts/${candidate.ghlContactId}`, { email: '' });
        results.emails_cleared++;

        try {
          await ghlFetch('POST', `/contacts/${candidate.ghlContactId}/notes`, {
            body: `[EMAIL CLEANUP] Removed invalid email "${currentEmail}" (reason: ${ghlScore.reasons[0]}). LP has no valid replacement email for this contact — please collect a real email at next contact so nurture can resume.`,
          });
        } catch {}

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
          ghlContactId: candidate.ghlContactId, name, email: currentEmail,
          reason: ghlScore.reasons[0], action: 'cleared',
        });
      }

      // Rate limit: 200ms between GHL write cycles
      await sleep(200);
    } catch (err) {
      results.errors++;
      results.details.push({
        ghlContactId: candidate.ghlContactId,
        action: 'error',
        error: err.message,
      });
    }
  }

  console.log(`[EmailCleanup] Done: ${results.emails_cleared} ${dryRun ? 'would be ' : ''}cleared, ${results.emails_corrected} ${dryRun ? 'would be ' : ''}corrected, ${results.already_clean} already clean, ${results.errors} errors`);
  return results;
}

// ═══════════════════════════════════════════════════════════════
// SCHEDULER — daily live sweep, opt-in via env
// Default OFF: nothing changes until EMAIL_CLEANUP_SWEEP_ENABLED=true
// is set on Railway. Run a manual dry-run first and review the details
// array before enabling.
// ═══════════════════════════════════════════════════════════════

const SWEEP_ENABLED = process.env.EMAIL_CLEANUP_SWEEP_ENABLED === 'true';
const SWEEP_INTERVAL_MS = Math.max(60, parseInt(process.env.EMAIL_CLEANUP_SWEEP_INTERVAL_MIN || '1440', 10)) * 60 * 1000;
const SWEEP_LIMIT = parseInt(process.env.EMAIL_CLEANUP_SWEEP_LIMIT || '200', 10);

export function startEmailCleanupScheduler() {
  if (!SWEEP_ENABLED) {
    console.log('[EmailCleanup] Scheduler disabled (set EMAIL_CLEANUP_SWEEP_ENABLED=true to enable daily live sweep)');
    return;
  }
  console.log(`[EmailCleanup] Scheduler ENABLED — live sweep every ${SWEEP_INTERVAL_MS / 60000} min, limit ${SWEEP_LIMIT}`);
  // First run 5 minutes after boot (let sync + rate limiter settle), then on interval.
  setTimeout(() => {
    runEmailCleanup({ dryRun: false, limit: SWEEP_LIMIT }).catch(e => console.error('[EmailCleanup] Sweep failed:', e.message));
    setInterval(() => {
      runEmailCleanup({ dryRun: false, limit: SWEEP_LIMIT }).catch(e => console.error('[EmailCleanup] Sweep failed:', e.message));
    }, SWEEP_INTERVAL_MS);
  }, 5 * 60 * 1000);
}

/**
 * Register the admin route (and start the opt-in scheduler).
 * The scheduler is started here rather than index.js so this feature
 * ships without touching the 32KB index.js — it no-ops unless the
 * EMAIL_CLEANUP_SWEEP_ENABLED env var is set.
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

  startEmailCleanupScheduler();

  console.log('[EmailCleanup] Registered: POST /admin/email-cleanup');
}
