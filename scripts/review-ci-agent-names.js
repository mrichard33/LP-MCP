#!/usr/bin/env node
/**
 * Review agent labels before they reach a customer record — READ ONLY
 * scripts/review-ci-agent-names.js
 *
 * ci_agent_map.agent_name is seeded from the live Five9 user record, and those
 * records carry ADMINISTRATIVE labels — notes to whoever maintains the domain,
 * not names anyone should read. Confirmed live 2026-08-24:
 *
 *     e.ramirez@reecewindows.com  ->  'Mark R (Keep Old Edwin Account)'
 *
 * which the note composer renders into a CRM note header as:
 *
 *     Agent: Mark R (Keep Old Edwin Account) (reece)
 *
 * on a real customer's record, in both CRMs.
 *
 * This script does not fix anything. It PRINTS the roster and flags the rows
 * that would embarrass us, so Mark can decide the correct display_name for
 * each. Guessing a person's real name from an administrative label is exactly
 * the kind of inference that put the label there in the first place.
 *
 * ── THERE IS NO --execute, AND THAT IS THE POINT ───────────────────────────
 * Every other script in this family writes once Mark approves the dry run.
 * This one has no write path at all: choosing what a colleague is called on a
 * customer's permanent record is a human decision, and a script that could
 * make it automatically would eventually be run without reading the output.
 *
 * Usage:
 *   node scripts/review-ci-agent-names.js
 *
 * Pre-conditions:
 *   - sql/069 applied (ci_agent_map.display_name)
 *   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY set
 */

import { resolveAgentLabel } from '../src/ci/teams.js';

/**
 * Words and shapes that mark a label as internal bookkeeping.
 *
 * Parentheses are the strongest single signal — a real person's name almost
 * never carries them, and every administrative note observed on this domain
 * does. The word list covers the rest of what Five9 admins write into a name
 * field when they need somewhere to put a note.
 */
export const SUSPICIOUS_WORDS = ['keep', 'old', 'test', 'do not use', 'donotuse', 'inactive', 'disabled', 'dupe', 'duplicate'];

/**
 * Would this label embarrass us on a customer record? Pure.
 *
 * @returns {{suspicious: boolean, reasons: string[]}}
 */
export function inspectAgentName(name) {
  const s = String(name ?? '').trim();
  const reasons = [];
  if (!s) return { suspicious: false, reasons };

  if (/[()[\]{}]/.test(s)) reasons.push('contains parentheses/brackets');
  const lower = s.toLowerCase();
  for (const w of SUSPICIOUS_WORDS) {
    // Word-boundary match so 'Goldstein' does not trip on 'old' and
    // 'Testa' does not trip on 'test'.
    const re = new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i');
    if (re.test(lower)) reasons.push(`contains '${w}'`);
  }
  if (/@/.test(s)) reasons.push('looks like an email address, not a name');

  return { suspicious: reasons.length > 0, reasons };
}

/**
 * Build the report. Pure — rows are an argument, so the flagging logic is
 * testable without a database.
 */
export function buildReport(rows) {
  return (rows || []).map((r) => {
    const { suspicious, reasons } = inspectAgentName(r?.agent_name);
    const label = resolveAgentLabel({
      displayName: r?.display_name,
      agentName: r?.agent_name,
      agentUsername: r?.agent_username,
    });
    // An override already in place answers the concern — what reaches the CRM
    // is the display_name, not the flagged agent_name.
    const needsReview = suspicious && !String(r?.display_name ?? '').trim();
    return { ...r, label, suspicious, reasons, needsReview };
  });
}

async function main() {
  const { default: supabase } = await import('../src/supabase.js');
  if (!supabase) {
    console.error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).');
    process.exit(1);
  }

  console.log('review-ci-agent-names (READ ONLY — this script has no write path)\n');

  const { data, error } = await supabase
    .from('ci_agent_map')
    .select('agent_username, agent_name, display_name, team, active')
    .order('agent_username');
  if (error) throw new Error(`ci_agent_map read failed: ${error.message}`);

  const report = buildReport(data || []);

  console.log('username | agent_name | display_name | team | active');
  console.log('─'.repeat(110));
  for (const r of report) {
    const line = [
      String(r.agent_username ?? '').padEnd(30),
      String(r.agent_name ?? '').padEnd(34),
      String(r.display_name ?? '—').padEnd(20),
      String(r.team ?? '').padEnd(15),
      r.active === false ? 'inactive' : 'active',
    ].join(' | ');
    console.log(line);
    if (r.needsReview) {
      console.log(`${' '.repeat(4)}↳ REVIEW — would appear in CRM notes as-is: "${r.label}"  [${r.reasons.join('; ')}]`);
    }
  }

  const flagged = report.filter((r) => r.needsReview);
  const overridden = report.filter((r) => String(r.display_name ?? '').trim());

  console.log(`\n${report.length} agent(s) · ${overridden.length} with a display_name override · ${flagged.length} FLAGGED for review`);

  if (flagged.length) {
    console.log('\nFLAGGED — each of these renders into a customer-facing note header as written:');
    for (const r of flagged) {
      console.log(`  ${String(r.agent_username).padEnd(30)} Agent: ${r.label} (${r.team ?? 'unknown'})`);
    }
    console.log('\nTo correct one, once Mark has confirmed the right name:');
    console.log("  UPDATE ci_agent_map SET display_name = '<the name they go by>'");
    console.log("   WHERE agent_username = '<username>';");
    console.log('\nDo NOT guess. An administrative label is not a hint about the person behind it.');
  } else {
    console.log('\nNothing flagged. Every agent_name reaching a CRM note reads as a name.');
  }
}

// Only run as a script — inspectAgentName/buildReport are imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('review-ci-agent-names failed:', err.message);
    process.exit(1);
  });
}
