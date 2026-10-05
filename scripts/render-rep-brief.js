#!/usr/bin/env node
/**
 * render-rep-brief.js — DRY RUN. Prints the LP note (rep brief) a contact would
 * get, beside the note LP holds today, and sends nothing.
 *
 *   node scripts/render-rep-brief.js LgCeHyniTQPfrnT4Ga7j
 *   node scripts/render-rep-brief.js LgCeHyniTQPfrnT4Ga7j 2026-10-05 "2:00 PM"
 *   railway run node scripts/render-rep-brief.js <ghl contact id>
 *
 * The appointment comes from the arguments, else from the contact's lp_leads
 * row (what LP holds). READ-ONLY: it reads GHL, Supabase and the model, and
 * writes nothing anywhere. Needs GHL, Supabase and model credentials.
 */
import supabase from '../src/supabase.js';
import { fetchAndBuildRepBrief } from '../src/services/rep-brief-io.js';

const [contactId, argDate, argTime] = process.argv.slice(2);
if (!contactId) {
  console.error('usage: node scripts/render-rep-brief.js <ghl contact id> [adate] [atime]');
  process.exit(2);
}

let lead = null;
if (supabase) {
  const { data } = await supabase.from('lp_leads')
    .select('lp_lead_id,appointment_date,raw_lp_data')
    .eq('ghl_contact_id', contactId).order('created_at_lp', { ascending: false }).limit(1);
  lead = data?.[0] || null;
}

// LP's apptdate is an ET wall-clock ISO string ("2026-10-05T14:00:00").
const lpAppt = String(lead?.raw_lp_data?.apptdate || '');
let adate = argDate || lpAppt.slice(0, 10);
let atime = argTime || '';
if (!atime && /T\d{2}:\d{2}/.test(lpAppt)) atime = lpAppt.slice(11, 16);
if (!adate) atime = '';

const brief = await fetchAndBuildRepBrief(contactId, {
  body: { adate, atime },
  hasAppointment: !!adate,
});

console.log(`contact ${contactId}${lead ? ` · LP lead ${lead.lp_lead_id}` : ''}`);
console.log(`\nNOW IN LP (${String(lead?.raw_lp_data?.notes || '').length} chars):\n${lead?.raw_lp_data?.notes || '(none)'}`);
console.log(`\nREP BRIEF (${brief?.notes?.length || 0} chars, ${brief?.source || 'no build'}):\n${brief?.notes || '(could not build — contact not readable)'}`);
process.exit(0);
