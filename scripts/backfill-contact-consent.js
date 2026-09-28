#!/usr/bin/env node
/**
 * One-time consent backfill — scripts/backfill-contact-consent.js
 *
 * Consent Model v1 (2026-09-28). Seeds contact_consent (sql/136) from what the
 * contact carries TODAY, and writes one consent_events row per contact with
 * source = 'backfill', so every pre-existing opt-out has a starting record.
 *
 * DRY RUN IS THE DEFAULT. Nothing is written without --execute, and --execute
 * is for AFTER Mark has approved the dry-run output (the verification step is
 * `SELECT count(*) FROM contact_consent` = the dry run's `would_insert`).
 *
 * Mapping (the handoff's, verbatim):
 *   dnc | stage:dnc | lp-dnc | do-not-contact  → dnc_full = true
 *   dnc-sms                                     → phone revoked + sms_carrier_stop
 *   dnc-voice                                   → phone revoked
 *   email unsubscribed                          → email_consent = revoked
 * plus one signal the tags miss: GHL SMS/RCS DND 'permanent' is GHL's own
 * record of a texted STOP (src/actions/handlers/dnd.js), so it also sets
 * phone revoked + sms_carrier_stop.
 *
 * "Email unsubscribed" = GHL Email DND active/permanent (what U.UNS sets) or an
 * agentic_messages.unsubscribed_at. NOTE: Email DND was also set on every DNC
 * contact by the 2026-07-23 DNC backfill, so for a dnc_full contact it is not
 * proof of an unsubscribe — it still reads as email revoked here, which is the
 * conservative direction (it blocks, never opens).
 *
 * Candidates: contacts in contact_tag_snapshot carrying any DNC-family tag,
 * plus agentic_messages rows with unsubscribed_at. A contact whose ONLY signal
 * is an Email DND set in GHL with no tag cannot be found without scanning every
 * GHL contact; it gets its row the first time a live change is recorded.
 *
 * Existing rows are NEVER overwritten: live traffic between deploy and backfill
 * is newer than a backfill, so contact_consent is inserted ON CONFLICT DO
 * NOTHING and events are written only for rows this run inserted.
 *
 * Usage:
 *   node scripts/backfill-contact-consent.js                   # dry run, live GHL reads
 *   node scripts/backfill-contact-consent.js --snapshot-only   # dry run, tags from the snapshot, no DND
 *   node scripts/backfill-contact-consent.js --limit=50
 *   node scripts/backfill-contact-consent.js --execute         # after Mark approves the dry run
 * Prints a JSON report to stdout.
 */

import { pathToFileURL } from 'node:url';

export const DNC_FULL_TAGS = Object.freeze(['dnc', 'stage:dnc', 'lp-dnc', 'do-not-contact']);
export const CANDIDATE_TAGS = Object.freeze([...DNC_FULL_TAGS, 'dnc-sms', 'dnc-voice']);
const DND_ON = new Set(['active', 'permanent']);

export function parseArgs(argv) {
  const has = (f) => argv.includes(f);
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.slice(8)) : null;
  return {
    execute: has('--execute'),
    snapshotOnly: has('--snapshot-only'),
    limit: Number.isFinite(limit) && limit > 0 ? limit : null,
  };
}

/**
 * The consent row one contact should start with. Pure.
 * @returns {null | {phone_consent, email_consent, sms_carrier_stop, dnc_full, signals: string[]}}
 *   null when nothing about the contact is an opt-out (no row is written).
 */
export function deriveConsentFromContact({ tags = [], dndSettings = null, emailUnsubscribed = false } = {}) {
  const lower = new Set((tags || []).map((t) => String(t || '').toLowerCase()));
  const signals = [];
  const dnd = (ch) => String(dndSettings?.[ch]?.status || '').toLowerCase();

  const dncFull = DNC_FULL_TAGS.some((t) => lower.has(t));
  if (dncFull) signals.push(...DNC_FULL_TAGS.filter((t) => lower.has(t)).map((t) => `tag:${t}`));

  let carrierStop = false;
  let phoneRevoked = false;
  if (lower.has('dnc-sms')) { carrierStop = true; phoneRevoked = true; signals.push('tag:dnc-sms'); }
  for (const ch of ['SMS', 'RCS']) {
    if (dnd(ch) === 'permanent') { carrierStop = true; phoneRevoked = true; signals.push(`dnd:${ch}:permanent`); }
  }
  if (lower.has('dnc-voice')) { phoneRevoked = true; signals.push('tag:dnc-voice'); }

  let emailRevoked = false;
  if (DND_ON.has(dnd('Email'))) { emailRevoked = true; signals.push(`dnd:Email:${dnd('Email')}`); }
  if (emailUnsubscribed) { emailRevoked = true; signals.push('agentic_messages:unsubscribed_at'); }

  if (!dncFull && !phoneRevoked && !emailRevoked) return null;
  return {
    phone_consent: phoneRevoked ? 'revoked' : 'unknown',
    email_consent: emailRevoked ? 'revoked' : 'unknown',
    sms_carrier_stop: carrierStop,
    dnc_full: dncFull,
    signals,
  };
}

/**
 * The ONE consent_events row for a backfilled contact: its strongest change.
 * The full derived state rides in evidence. Pure.
 */
export function backfillEventFor(state) {
  if (state.dnc_full) return { channel: 'all', change: 'dnc_full_on' };
  if (state.sms_carrier_stop) return { channel: 'phone', change: 'carrier_stop_on' };
  if (state.phone_consent === 'revoked' && state.email_consent === 'revoked') return { channel: 'all', change: 'revoked' };
  if (state.phone_consent === 'revoked') return { channel: 'phone', change: 'revoked' };
  return { channel: 'email', change: 'revoked' };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { default: supabase } = await import('../src/supabase.js');
  if (!supabase) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set (LP instance) — nothing was read');
  const { ghlFetch } = await import('../src/actions/helpers.js');
  const { selectAllPaged, selectAllIn } = await import('../src/supabase-page.js');

  // ── candidates ──
  // PAGED, not a single select (fixed 2026-09-28, before the first run):
  // PostgREST silently caps a read at 1,000 rows and the snapshot holds 1,206
  // candidates, so a plain select would have backfilled ~1,000 and reported
  // that as the whole population. selectAllPaged throws on a short read.
  const snap = await selectAllPaged(supabase, 'contact_tag_snapshot', {
    columns: 'ghl_contact_id, tags',
    orderBy: 'ghl_contact_id',
    refine: (q) => q.overlaps('tags', CANDIDATE_TAGS),
  });
  const unsub = await selectAllPaged(supabase, 'agentic_messages', {
    columns: 'id, ghl_contact_id',
    orderBy: 'id',
    refine: (q) => q.not('unsubscribed_at', 'is', null),
  });
  const unsubSet = new Set(unsub.map((r) => r.ghl_contact_id).filter(Boolean));

  const byId = new Map(snap.map((r) => [r.ghl_contact_id, r.tags || []]));
  for (const id of unsubSet) if (!byId.has(id)) byId.set(id, []);
  let ids = [...byId.keys()].filter(Boolean).sort();
  if (args.limit) ids = ids.slice(0, args.limit);

  // ── derive ──
  const rows = [];
  const counts = { candidates: ids.length, live_read_failed: 0, no_opt_out_now: 0, dnc_full: 0, sms_carrier_stop: 0, phone_revoked: 0, email_revoked: 0 };
  console.error(`[backfill] ${ids.length} candidates — reading ${args.snapshotOnly ? 'the tag snapshot' : 'live GHL contacts (this takes a while)'}…`);
  let seen = 0;
  for (const id of ids) {
    if (++seen % 100 === 0) console.error(`[backfill] ${seen}/${ids.length}`);
    let tags = byId.get(id);
    let dndSettings = null;
    let readFrom = 'snapshot';
    if (!args.snapshotOnly) {
      try {
        const c = (await ghlFetch('GET', `/contacts/${id}`))?.contact;
        if (c) { tags = c.tags || []; dndSettings = c.dndSettings || null; readFrom = 'ghl_live'; }
        else counts.live_read_failed++;
      } catch {
        counts.live_read_failed++;
      }
    }
    const state = deriveConsentFromContact({ tags, dndSettings, emailUnsubscribed: unsubSet.has(id) });
    if (!state) { counts.no_opt_out_now++; continue; }
    if (state.dnc_full) counts.dnc_full++;
    if (state.sms_carrier_stop) counts.sms_carrier_stop++;
    if (state.phone_consent === 'revoked') counts.phone_revoked++;
    if (state.email_consent === 'revoked') counts.email_revoked++;
    rows.push({ id, state, readFrom });
  }

  // Existing rows are left alone, so the dry run reports what --execute would insert.
  const existingRows = await selectAllIn(supabase, 'contact_consent', {
    columns: 'ghl_contact_id',
    orderBy: 'ghl_contact_id',
    column: 'ghl_contact_id',
    values: rows.map((r) => r.id),
  });
  const existing = new Set(existingRows.map((r) => r.ghl_contact_id));
  const toInsert = rows.filter((r) => !existing.has(r.id));

  const report = {
    mode: args.execute ? 'execute' : 'dry_run',
    read_from: args.snapshotOnly ? 'snapshot_only' : 'ghl_live',
    ...counts,
    already_has_row: existing.size,
    would_insert: toInsert.length,
    sample: toInsert.slice(0, 15).map((r) => ({ ghl_contact_id: r.id, ...r.state, read_from: r.readFrom })),
  };

  if (!args.execute) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // ── execute ──
  let inserted = 0;
  let eventsWritten = 0;
  const eventFailures = [];
  for (let i = 0; i < toInsert.length; i += 200) {
    const chunk = toInsert.slice(i, i + 200);
    const nowIso = new Date().toISOString();
    const up = await supabase.from('contact_consent').upsert(
      chunk.map((r) => ({
        ghl_contact_id: r.id,
        phone_consent: r.state.phone_consent,
        email_consent: r.state.email_consent,
        sms_carrier_stop: r.state.sms_carrier_stop,
        dnc_full: r.state.dnc_full,
        last_reason: `backfill: ${r.state.signals.join(', ')}`,
        last_source: 'backfill',
        last_changed_by: 'system',
        updated_at: nowIso,
      })),
      { onConflict: 'ghl_contact_id', ignoreDuplicates: true },
    ).select('ghl_contact_id');
    if (up.error) throw new Error(`contact_consent insert failed at chunk ${i}: ${up.error.message}`);
    const newIds = new Set((up.data || []).map((r) => r.ghl_contact_id));
    inserted += newIds.size;

    const events = chunk.filter((r) => newIds.has(r.id)).map((r) => ({
      ghl_contact_id: r.id,
      ...backfillEventFor(r.state),
      source: 'backfill',
      reason: `Backfilled from ${r.readFrom === 'ghl_live' ? 'live GHL tags + DND' : 'the tag snapshot'}`,
      actor: 'system',
      evidence: { signals: r.state.signals, derived: { ...r.state, signals: undefined }, read_from: r.readFrom },
    }));
    if (events.length) {
      const ev = await supabase.from('consent_events').insert(events);
      if (ev.error) eventFailures.push({ chunk: i, error: ev.error.message, contacts: events.map((e) => e.ghl_contact_id) });
      else eventsWritten += events.length;
    }
  }
  console.log(JSON.stringify({ ...report, inserted, events_written: eventsWritten, event_failures: eventFailures }, null, 2));
  if (eventFailures.length) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  // process.exit on success too: imported modules (the GHL rate limiter) keep
  // timers alive, and a script that never returns to the prompt looks hung.
  main().then(() => process.exit(process.exitCode || 0))
    .catch((err) => { console.error(err); process.exit(1); });
}
