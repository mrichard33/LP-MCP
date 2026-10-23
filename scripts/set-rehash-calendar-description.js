/**
 * Set the Rehash Call calendar's description (Mark, 2026-10-23; decision F).
 *
 * GHL API v2 takes `description` on PUT /calendars/{calendarId} (CalendarUpdateDTO,
 * every field optional). Dry run by default: it reads the calendar and prints the
 * current description next to the new one. `--apply` writes it, then reads it back.
 * Nothing else on the calendar is sent.
 *
 *   node scripts/set-rehash-calendar-description.js            # dry run
 *   node scripts/set-rehash-calendar-description.js --apply    # write
 *
 * Needs GHL_API_KEY; the calendar is REHASH_CALENDAR_ID (default ncDzLgzbfKJRfhmtlWtB).
 * The manual fallback: GHL → Calendars → Rehash Call → Description, the same text.
 */
export const REHASH_CALENDAR_DESCRIPTION = [
  'What to Expect',
  'A quick 15-minute phone call with the Reece team. We’ll call you at the number you gave us.',
  'We’ll answer any questions left from your visit, go over your quote, and see what we can do to get you a better price.',
  'If there’s a better option for your home, we may suggest a short visit with one of our managers to walk you through it. That part is completely up to you.',
  'No pressure. Just straight answers.',
].join('\n');

async function main() {
  const apply = process.argv.includes('--apply');
  const calendarId = String(process.env.REHASH_CALENDAR_ID || 'ncDzLgzbfKJRfhmtlWtB').trim();
  const { ghlFetch } = await import('../src/actions/helpers.js');
  const before = await ghlFetch('GET', `/calendars/${calendarId}`);
  const cal = before?.calendar || before || {};
  console.log(`Calendar ${calendarId} (${cal.name || 'unnamed'})`);
  console.log('--- current description ---');
  console.log(cal.description || '(empty)');
  console.log('--- new description ---');
  console.log(REHASH_CALENDAR_DESCRIPTION);
  if (!apply) { console.log('\nDry run: nothing written. Re-run with --apply.'); return; }
  await ghlFetch('PUT', `/calendars/${calendarId}`, { description: REHASH_CALENDAR_DESCRIPTION });
  const after = await ghlFetch('GET', `/calendars/${calendarId}`);
  const saved = (after?.calendar || after || {}).description || '';
  console.log(saved.trim() === REHASH_CALENDAR_DESCRIPTION.trim() ? '\n✅ Written and read back.' : '\n⚠️ Written, but the read-back differs. Check GHL by hand.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
