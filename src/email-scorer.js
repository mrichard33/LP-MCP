// src/email-scorer.js
// Email Confidence Scoring for LP→GHL Enrichment
// Used by sync-leads.js hook and admin/email-backfill.js

import supabase from './supabase.js';

// ═══════════════════════════════════════════════════════════════
// BLACKLISTS
// ═══════════════════════════════════════════════════════════════

// Exact-match blacklist (normalized to lowercase)
const BLACKLISTED_EMAILS = new Set([
  'fake@gmail.com',
  'noemail@gmail.com',
  'noemail@noemail.com',
  'noemail@email.com',
  'noemail@mail.com',
  'na@gmail.com',
  'no@email.com',
  'no@gmail.com',
  'no@noemail.com',
  'none@none.com',
  'none@gmail.com',
  'test@test.com',
  'testing@example.com',
  'testform@test.com',
  '123@gmail.com',
  'fakeit@gmail.com',
  'abc@gmail.com',
  'asdf@gmail.com',
  'xxx@gmail.com',
  'nana@gmail.com',
]);

// Pattern blacklist (regex patterns — applied after exact match)
const BLACKLIST_PATTERNS = [
  /^reecebuilder/i,           // reecebuilders@gmail.com, reecebuilder@gmail.com
  /^reeceform/i,              // reeceFormJude4@gmail.com, etc.
  /^jude-reece/i,             // jude-reece-call1@gmail.com, etc.
  /^acolon\.reecewindows/i,   // acolon.reecewindows@gmail.com
  /^muellc54\+reecewindows/i, // muellc54+reecewindows@gmail.com
  /^stop@reecewindows/i,      // stop@reecewindows.com
];

// Domain blacklist — company/employee domains that are NOT homeowner emails
const COMPANY_DOMAINS = new Set([
  'reecewindows.com',
]);

// Disposable email domains
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email',
  'sharklasers.com', 'guerrillamailblock.com', 'grr.la', 'yopmail.com',
  'trashmail.com', 'tempmail.net', 'getnada.com', 'maildrop.cc',
]);

// Major ISP domains (higher trust — homeowners actually use these)
const MAJOR_PROVIDERS = new Set([
  'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'live.com', 'msn.com',
  'att.net', 'comcast.net', 'bellsouth.net', 'verizon.net',
  'sbcglobal.net', 'cox.net', 'charter.net', 'earthlink.net',
  'mail.com', 'protonmail.com', 'zoho.com',
]);

// Lead sources where the homeowner self-entered the email (higher trust)
const DIGITAL_SOURCES = new Set([
  'website', 'estimate calculator', 'home risk report',
  'website estimate calculator', 'reece chatbot',
  'fb - contact us', 'fb - lead ad', 'google', 'google ads',
]);

// ═══════════════════════════════════════════════════════════════
// SCORING ENGINE
// ═══════════════════════════════════════════════════════════════

/**
 * Score a single email address for validity and confidence.
 *
 * @param {string} email - The email to score
 * @param {Object} context - Additional context for scoring
 * @param {string} [context.firstName] - Contact first name (for name matching)
 * @param {string} [context.lastName] - Contact last name
 * @param {string} [context.leadSource] - LP lead source or sourcesubdescr
 * @param {number} [context.crossProspectCount] - How many DIFFERENT prospects share this email
 * @returns {{ score: number, reasons: string[] }}
 */
export function scoreEmail(email, context = {}) {
  const reasons = [];

  if (!email || typeof email !== 'string') {
    return { score: 0, reasons: ['missing_or_empty'] };
  }

  const normalized = email.trim().toLowerCase();

  // ── HARD FAILURES (score = 0) ────────────────────────────────

  // Exact blacklist match
  if (BLACKLISTED_EMAILS.has(normalized)) {
    return { score: 0, reasons: ['blacklisted_exact'] };
  }

  // Pattern blacklist match
  for (const pattern of BLACKLIST_PATTERNS) {
    if (pattern.test(normalized)) {
      return { score: 0, reasons: [`blacklisted_pattern:${pattern.source}`] };
    }
  }

  // Basic format validation
  const formatRegex = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
  if (!formatRegex.test(normalized)) {
    return { score: 0, reasons: ['invalid_format'] };
  }

  // Extract parts
  const [localPart, domain] = normalized.split('@');

  // Company domain (employee/canvasser email, not homeowner)
  if (COMPANY_DOMAINS.has(domain)) {
    return { score: 0, reasons: ['company_domain'] };
  }

  // Disposable domain
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { score: 10, reasons: ['disposable_domain'] };
  }

  // ── BASE SCORE ───────────────────────────────────────────────

  let score = 50;
  reasons.push('valid_format:+50');

  // ── POSITIVE SIGNALS ─────────────────────────────────────────

  // Major ISP domain
  if (MAJOR_PROVIDERS.has(domain)) {
    score += 15;
    reasons.push('major_provider:+15');
  }

  // Digital lead source (homeowner self-entered)
  const sourceLower = (context.leadSource || '').toLowerCase();
  if (DIGITAL_SOURCES.has(sourceLower)) {
    score += 15;
    reasons.push('digital_source:+15');
  } else if (sourceLower && !sourceLower.includes('canvass')) {
    score += 5;
    reasons.push('non_canvass_source:+5');
  }

  // Unique to this prospect (not shared across many unrelated prospects)
  if (context.crossProspectCount !== undefined) {
    if (context.crossProspectCount <= 1) {
      score += 10;
      reasons.push('unique_email:+10');
    } else if (context.crossProspectCount >= 3) {
      score -= 15;
      reasons.push(`shared_across_${context.crossProspectCount}_prospects:-15`);
    }
  }

  // Name matching — local part contains fragments of first/last name
  if (context.firstName || context.lastName) {
    const first = (context.firstName || '').toLowerCase().replace(/[^a-z]/g, '');
    const last = (context.lastName || '').toLowerCase().replace(/[^a-z]/g, '');
    const localClean = localPart.replace(/[^a-z]/g, '');

    if (first.length >= 3 && localClean.includes(first)) {
      score += 5;
      reasons.push('name_match_first:+5');
    }
    if (last.length >= 3 && localClean.includes(last)) {
      score += 5;
      reasons.push('name_match_last:+5');
    }
  }

  // ── NEGATIVE SIGNALS ─────────────────────────────────────────

  // Suspiciously short local part (1-2 chars)
  if (localPart.length <= 2) {
    score -= 25;
    reasons.push('short_local_part:-25');
  }

  // Truncated TLD (e.g., rafaelsolano@att.ne instead of att.net)
  const tld = domain.split('.').pop();
  if (tld.length < 2) {
    score -= 20;
    reasons.push('truncated_tld:-20');
  }

  // Canvassing source (higher fake risk)
  if (sourceLower.includes('canvass')) {
    score -= 10;
    reasons.push('canvass_source:-10');
  }

  // Clamp to 0-100
  score = Math.max(0, Math.min(100, score));

  return { score, reasons };
}

/**
 * Find the best email for a prospect by scoring all emails across
 * their LP lead records.
 *
 * @param {string} prospectId - LP prospect ID
 * @param {Object} [opts]
 * @param {string} [opts.firstName] - Contact first name
 * @param {string} [opts.lastName] - Contact last name
 * @returns {Promise<{ email: string, score: number, reasons: string[], sourceLeadId: string } | null>}
 */
export async function findBestEmailForProspect(prospectId, opts = {}) {
  if (!prospectId) return null;

  // Pull all leads under this prospect
  const { data: leads, error } = await supabase
    .from('lp_leads')
    .select('lp_lead_id, email, lead_source, lead_source_detail')
    .eq('lp_prospect_id', prospectId)
    .not('email', 'is', null);

  if (error || !leads || leads.length === 0) return null;

  // Collect unique emails and check cross-prospect sharing for each
  const emailCandidates = [];
  const seenEmails = new Set();

  for (const lead of leads) {
    const email = (lead.email || '').trim().toLowerCase();
    if (!email || seenEmails.has(email)) continue;
    seenEmails.add(email);

    // Check how many OTHER prospects share this email
    let crossProspectCount = 1;
    try {
      const { data: crossCheck } = await supabase
        .from('lp_leads')
        .select('lp_prospect_id')
        .eq('email', email)
        .neq('lp_prospect_id', prospectId)
        .limit(5);
      // Count distinct OTHER prospect IDs
      const otherProspects = new Set((crossCheck || []).map(r => r.lp_prospect_id));
      crossProspectCount = 1 + otherProspects.size;
    } catch {
      // If cross-check fails, proceed without penalty/bonus
    }

    const result = scoreEmail(email, {
      firstName: opts.firstName,
      lastName: opts.lastName,
      leadSource: lead.lead_source_detail || lead.lead_source,
      crossProspectCount,
    });

    emailCandidates.push({
      email,
      score: result.score,
      reasons: result.reasons,
      sourceLeadId: lead.lp_lead_id,
    });
  }

  if (emailCandidates.length === 0) return null;

  // Sort by score descending, return the best
  emailCandidates.sort((a, b) => b.score - a.score);
  return emailCandidates[0];
}
