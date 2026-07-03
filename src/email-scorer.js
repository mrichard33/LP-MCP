// src/email-scorer.js
// Email Confidence Scoring for LP→GHL Enrichment
// Used by sync-leads.js hook, admin/email-backfill.js, and admin/email-cleanup.js
//
// 2026-07-03: Extended hard-fail detection after the June 2026 bounce report
// (52 bounces in 30 days). New classes: local-part blacklist (real@, noreply@,
// askatappt@...), "fake" anywhere in local part, numeric-only local parts,
// non-mail domains (m.facebook.com), and typo-domain detection (gmail.comm,
// aaol.com, tamoabay.rr.com) via Levenshtein distance 1 against known
// providers. Typo failures carry a typo_domain_suggest:<corrected> reason so
// email-cleanup can CORRECT them instead of clearing a recoverable email.

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
  // 2026-07-03 — June bounce report additions
  'fakegmail@gmail.com',
  'real@gmail.com',
  'real@yahoo.com',
  'noreply@gmail.com',
  'askatappt@gmail.com',
  'nama@gmail.com',
]);

// Local-part exact blacklist — placeholder words reps/leads type to get past
// a required field. Matched against the full local part (before the @).
const LOCAL_PART_BLACKLIST = new Set([
  'fake', 'fakeemail', 'fakegmail', 'real', 'none', 'noemail', 'nomail',
  'noname', 'nope', 'na', 'test', 'testing', 'sample', 'asdf', 'qwerty',
  'abc', 'xyz', 'xxx', 'aaa', 'nothanks', 'declined', 'refused', 'unknown',
  'notgiven', 'noreply', 'nana', 'nama', 'email', 'gmail', 'yahoo',
  'customer', 'homeowner', 'askatappt', 'askatappointment',
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

// Local-part regex hard-fails (applied to the part before the @)
const LOCAL_PART_FAIL_PATTERNS = [
  { re: /fake/,                    reason: 'local_contains_fake' },       // andreasfake@yahoo.com
  { re: /^(no-?reply|donotreply)/, reason: 'noreply_local_part' },
  { re: /^\d+$/,                   reason: 'numeric_only_local_part' },   // 123@gmail.com, 555@...
];

// Domain blacklist — company/employee domains that are NOT homeowner emails
const COMPANY_DOMAINS = new Set([
  'reecewindows.com',
]);

// Websites people type into an email field that have no public mailboxes.
// medic662peso@m.facebook.com bounced in the June report.
const NON_MAIL_DOMAINS = new Set([
  'facebook.com', 'm.facebook.com', 'instagram.com', 'tiktok.com',
  'youtube.com', 'google.com', 'twitter.com', 'x.com', 'linkedin.com',
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

// ═══════════════════════════════════════════════════════════════
// TYPO-DOMAIN DETECTION
// ───────────────────────────────────────────────────────────────
// A domain at Levenshtein distance 1 from a common provider — and not
// itself a known-good domain — is a keyboard typo, not a real mailbox.
// June report: gmail.comm, gmail.ccom, aaol.com, tamoabay.rr.com.
// The reason string carries the corrected address so email-cleanup can
// FIX the contact instead of clearing a recoverable email.
// ═══════════════════════════════════════════════════════════════

// Providers worth fuzzy-matching against (high-volume in our lead base)
const TYPO_TARGETS = [
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'comcast.net', 'bellsouth.net', 'verizon.net', 'att.net',
  'sbcglobal.net', 'earthlink.net', 'msn.com', 'live.com',
  'tampabay.rr.com', 'cfl.rr.com',
]);

// Real domains that sit at distance 1 from a TYPO_TARGET — never flag these.
const KNOWN_GOOD_DOMAINS = new Set([
  ...MAJOR_PROVIDERS,
  ...TYPO_TARGETS,
  'ymail.com', 'rocketmail.com', 'aim.com', 'juno.com', 'netzero.net',
  'optonline.net', 'roadrunner.com', 'mindspring.com', 'gmx.com', 'gmx.net',
  'fastmail.com', 'netscape.net', 'frontier.com', 'windstream.net',
  'centurylink.net', 'embarqmail.com', 'peoplepc.com', 'tds.net', 'q.com',
]);

// TLD typos that are never legitimate — fallback for domains not close
// enough to a TYPO_TARGET for the Levenshtein check to catch.
const BAD_TLDS = new Set([
  'comm', 'ccom', 'con', 'cmo', 'ocm', 'coom', 'vom', 'xom', 'clm',
  'cim', 'cpm', 'conm', 'nett', 'orgg',
]);

/** Levenshtein distance (iterative two-row). Small strings only. */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

/**
 * Check a domain for a single-edit typo of a known provider.
 * @returns {string|null} the corrected domain, or null if not a typo
 */
function detectTypoDomain(domain) {
  if (KNOWN_GOOD_DOMAINS.has(domain)) return null;
  for (const target of TYPO_TARGETS) {
    if (Math.abs(domain.length - target.length) > 1) continue;
    if (levenshtein(domain, target) === 1) return target;
  }
  return null;
}

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

  // Local-part exact blacklist (placeholder words)
  if (LOCAL_PART_BLACKLIST.has(localPart)) {
    return { score: 0, reasons: ['blacklisted_local_part'] };
  }

  // Local-part pattern hard-fails (contains "fake", noreply, numeric-only)
  for (const { re, reason } of LOCAL_PART_FAIL_PATTERNS) {
    if (re.test(localPart)) {
      return { score: 0, reasons: [reason] };
    }
  }

  // Company domain (employee/canvasser email, not homeowner)
  if (COMPANY_DOMAINS.has(domain)) {
    return { score: 0, reasons: ['company_domain'] };
  }

  // Non-mail domain (facebook.com etc. — no public mailboxes exist)
  if (NON_MAIL_DOMAINS.has(domain)) {
    return { score: 0, reasons: ['non_mail_domain'] };
  }

  // Typo domain (gmail.comm, aaol.com, tamoabay.rr.com) — carries suggestion
  const typoCorrection = detectTypoDomain(domain);
  if (typoCorrection) {
    return { score: 0, reasons: [`typo_domain_suggest:${localPart}@${typoCorrection}`] };
  }

  // Impossible TLD fallback (typo not close to a known provider)
  const domainTld = domain.split('.').pop();
  if (BAD_TLDS.has(domainTld)) {
    return { score: 0, reasons: [`invalid_tld:${domainTld}`] };
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
