/**
 * scripts/five9-dispatch-dryrun.js — manual verification harness for the
 * Five9 direct-dispatch path (call-dispatch-integrity 2026-07-07).
 *
 * Modes:
 *   node scripts/five9-dispatch-dryrun.js --dry
 *     Prints the exact createList / addRecordToList SOAP envelopes the
 *     dispatch would send, with a sample record. No network, no env needed.
 *
 *   FIVE9_USERNAME=... FIVE9_PASSWORD=... FIVE9_CALLBACK_LIST=... \
 *   node scripts/five9-dispatch-dryrun.js --live --phone 5551234567
 *     Runs ensureListExists + one addCallbackToList against the real Five9
 *     Admin SOAP API. Use ONLY with a test phone number; the record lands in
 *     the real list. Prints the outcome (and the raw fault on failure).
 */
import { buildAddRecordToListXml, ensureListExists, addCallbackToList } from '../src/five9/list-dispatch.js';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const listName = process.env.FIVE9_CALLBACK_LIST || 'GHL Confirmation Callbacks';

if (has('--dry') || !has('--live')) {
  console.log('── DRY RUN (no network) ──────────────────────────────────');
  console.log('\ncreateList inner XML:');
  console.log(`<listName>${listName}</listName>`);
  console.log('\naddRecordToList inner XML (sample record, all custom fields present):');
  console.log(buildAddRecordToListXml(
    listName,
    ['number1', 'first_name', 'last_name', 'call_purpose', 'requested_time', 'ghl_contact_id', 'notes'],
    ['5551234567', 'Mark', 'Test', 'pricing_questions', '07/08/2026 10:30', '0kk3xz6XatILy8jajymX', 'GHL Confirmation Call — calendar "Confirmation Call"'],
  ));
  console.log('\nEnvelope wrapper + Basic auth are applied by five9SoapCall (src/five9-admin.js).');
  process.exit(0);
}

// ── LIVE mode ──────────────────────────────────────────────────────
const phone = val('--phone');
if (!phone) {
  console.error('--live requires --phone <10-digit test number>');
  process.exit(1);
}
if (!process.env.FIVE9_USERNAME || !process.env.FIVE9_PASSWORD) {
  console.error('--live requires FIVE9_USERNAME / FIVE9_PASSWORD in env');
  process.exit(1);
}

try {
  console.log(`ensureListExists("${listName}") …`);
  await ensureListExists(listName);
  console.log('list ok — inserting test record …');
  const out = await addCallbackToList({
    phone,
    firstName: 'Mark',
    lastName: 'Test',
    callPurpose: 'requested_callback',
    requestedTime: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
    ghlContactId: '0kk3xz6XatILy8jajymX',
    notes: 'five9-dispatch-dryrun --live test record',
  });
  console.log('✅ record added:', JSON.stringify(out));
} catch (err) {
  console.error(`❌ live dispatch failed: ${err.message}`);
  process.exit(1);
}
