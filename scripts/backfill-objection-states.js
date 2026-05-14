#!/usr/bin/env node
/**
 * Backfill Objection States — scripts/backfill-objection-states.js
 *
 * One-shot sweep that classifies existing contacts into the new
 * objection-state substrate (S5.2 v2, Spec v1.2). Targets contacts
 * that have a re-engagement / appt-cancelled / appt-no-show / objection
 * stage tag but no row in contact_objection_states yet.
 *
 * Usage:
 *   node scripts/backfill-objection-states.js [--limit=N] [--dry-run] [--contact-id=<id>]
 *
 *   --limit=N         Cap the number of contacts processed
 *   --dry-run         Classify but do NOT write to the database
 *   --contact-id=<id> Classify just one contact
 *
 * Pre-conditions:
 *   - sql/migrations/2026-05-14_objection_state_substrate.sql has been run
 *   - sql/seeds/2026-05-14_objection_state_policies.sql has been run
 *   - sql/seeds/2026-05-14_objection_state_transitions.sql has been run
 *
 * Idempotency: contacts that already have an active row in
 * contact_objection_states are skipped. Safe to re-run.
 */

import supabase from '../src/supabase.js';
import { executeTransitionObjectionState } from '../src/actions/handlers/objection-state.js';

const args = process.argv.slice(2);
const opt = {
  limit: parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '0', 10),
  dryRun: args.includes('--dry-run'),
  contactId: (args.find(a => a.startsWith('--contact-id=')) || '').split('=')[1] || null,
};

// ─── Classification rules (precedence: top → bottom) ─────────────────────
// Each rule has a `match` predicate over a contact record and a `state`.
// First match wins. The "contact record" shape is whatever lp_leads + tags
// looks like once joined (see fetchCandidates below).
const RULES = [
  // DNC / opt-out tags (terminal)
  { state: 'DISENGAGEMENT.hard_loss',
    match: c => hasAnyTag(c, ['dnc', 'lp-dnc', 'unsubscribed']) },
  { state: 'DISENGAGEMENT.soft_opt_out',
    match: c => hasAnyTag(c, ['objection:not-interested']) },

  // LP disposition signals (post-appointment)
  { state: 'APPOINTMENT_DISRUPTION.cancelled',
    match: c => ['CXL', 'CCC'].includes(c.lp_disposition) },
  { state: 'APPOINTMENT_DISRUPTION.no_show',
    match: c => ['NS', 'NoHome'].includes(c.lp_disposition),
    nuanceFn: c => c.lp_disposition === 'NoHome' ? ['nuance:rep_traveled'] : null },
  { state: 'APPOINTMENT_DISRUPTION.one_leg',
    match: c => c.lp_disposition === '1Leg',
    nuance: ['nuance:spouse_required'] },
  { state: 'APPOINTMENT_DISRUPTION.be_back',
    match: c => c.lp_disposition === 'BO' },
  { state: 'POST_PROPOSAL_RESISTANCE.financing_pressure',
    match: c => ['OPPFDN', 'FDNS'].includes(c.lp_disposition) },

  // Tag-based stages
  { state: 'DISENGAGEMENT.passive_cooling',
    match: c => hasAnyTagPrefix(c, ['appt-cancelled-cold', 'appt-no-show-cold']) },
  { state: 'APPOINTMENT_DISRUPTION.cancelled',
    match: c => hasAnyTagPrefix(c, ['appt-cancelled']) },
  { state: 'APPOINTMENT_DISRUPTION.no_show',
    match: c => hasAnyTagPrefix(c, ['appt-no-show']) },
  { state: 'DISENGAGEMENT.passive_cooling',
    match: c => hasAnyTag(c, ['stage:re-engagement', 'stage:cooling', 'stage:long-term-hold']) },
];

function hasAnyTag(c, tags) {
  const set = new Set(c.tags || []);
  return tags.some(t => set.has(t));
}
function hasAnyTagPrefix(c, prefixes) {
  const tags = c.tags || [];
  return tags.some(t => prefixes.some(p => t === p || t.startsWith(p + '-') || t.startsWith(p + ':')));
}

async function fetchCandidates() {
  // Pull contacts from lp_leads that have a ghl_contact_id. Join their
  // active tag set via the existing materialized contact rollup if any;
  // otherwise fall back to whatever tag store the project uses. This
  // script assumes a `contact_tags` view/table with (contact_id, tag).
  // Adjust the SELECT below if the project's tag mirror is elsewhere.

  if (opt.contactId) {
    return [{
      contact_id: opt.contactId,
      lp_disposition: null,
      tags: await fetchTags(opt.contactId),
    }];
  }

  // Find contacts who might need backfill: those with an LP disposition
  // signaling appt friction, or an appt-* / re-engagement stage tag.
  const { data: leads, error } = await supabase
    .from('lp_leads')
    .select('ghl_contact_id, disposition_code')
    .not('ghl_contact_id', 'is', null)
    .limit(opt.limit > 0 ? opt.limit : 10000);
  if (error) throw new Error(`fetchCandidates: ${error.message}`);

  const out = [];
  for (const l of leads || []) {
    out.push({
      contact_id: l.ghl_contact_id,
      lp_disposition: l.disposition_code,
      tags: await fetchTags(l.ghl_contact_id),
    });
    if (opt.limit > 0 && out.length >= opt.limit) break;
  }
  return out;
}

async function fetchTags(contact_id) {
  try {
    const { data } = await supabase
      .from('contact_tags')
      .select('tag')
      .eq('contact_id', contact_id);
    return (data || []).map(r => r.tag);
  } catch {
    return [];
  }
}

async function hasActiveState(contact_id) {
  const { data, error } = await supabase
    .from('contact_objection_states')
    .select('id')
    .eq('contact_id', contact_id)
    .is('exited_at', null)
    .maybeSingle();
  if (error) throw new Error(`hasActiveState: ${error.message}`);
  return !!data;
}

function pickRule(contact) {
  for (const r of RULES) {
    if (r.match(contact)) {
      const nuance = r.nuance || (r.nuanceFn ? r.nuanceFn(contact) : null);
      return { state: r.state, nuance };
    }
  }
  return null;
}

async function run() {
  const candidates = await fetchCandidates();
  const summary = {
    total: candidates.length,
    classified: {},
    skipped_already_active: 0,
    skipped_no_rule: 0,
    errors: 0,
    error_details: [],
  };

  console.log(`[Backfill] Fetched ${candidates.length} candidates (dryRun=${opt.dryRun})`);

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    try {
      if (await hasActiveState(c.contact_id)) {
        summary.skipped_already_active++;
        continue;
      }
      const pick = pickRule(c);
      if (!pick) {
        summary.skipped_no_rule++;
        continue;
      }

      if (opt.dryRun) {
        summary.classified[pick.state] = (summary.classified[pick.state] || 0) + 1;
        continue;
      }

      const result = await executeTransitionObjectionState({
        target_id: c.contact_id,
        action_payload: {
          proposed_state: pick.state,
          trigger_source: 'IMPORT_BACKFILL',
          classifier_version: 'backfill-v1.0',
          triggering_event_id: null,
          nuance_tags: pick.nuance || null,
          resolution_for_current: 'backfilled',
        },
      });

      if (result?.success) {
        summary.classified[pick.state] = (summary.classified[pick.state] || 0) + 1;
      } else {
        summary.errors++;
        summary.error_details.push({ contact_id: c.contact_id, reason: result?.reason || 'unknown' });
      }
    } catch (err) {
      summary.errors++;
      summary.error_details.push({ contact_id: c.contact_id, error: err.message });
    }

    if ((i + 1) % 100 === 0) {
      console.log(`[Backfill] Progress ${i + 1}/${candidates.length}`);
    }
  }

  console.log('[Backfill] Done. Summary:');
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.errors > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('[Backfill] Fatal:', err);
  process.exit(1);
});
