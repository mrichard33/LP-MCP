// ─── IME → LP Bridge — src/ime/lp-bridge.js ──────────────────────
//
// Posts an enriched IME WorkOrder into LP via /api/Leads/AddLead.
// LP returns in1_id (inbound queue ID). The real lds_id is not generated
// until an LP user processes the inbound queue entry.
//
// LP addlead is form-urlencoded — lpPost handles that via URLSearchParams.
// Field naming follows LP MCP Server Spec v5; cross-check against any
// future drift in src/sync-leads.js.

import { lpPost } from '../lp-client.js';

export async function addLeadFromIME(woData, woId) {
  const customer = woData?.customer || {};
  const address  = woData?.jobAddress || customer.address || {};

  const fields = {
    firstname:      customer.firstName || '',
    lastname:       customer.lastName  || '',
    phone:          customer.mobilePhone || customer.phone || customer.homePhone || '',
    email:          customer.email      || '',
    address1:       address.address     || '',
    city:           address.city        || '',
    state:          address.state       || '',
    zip:            address.zip         || '',
    source:         'Retail Partner',
    sourcesubdescr: 'Sams Club',
    notes:          `IME WorkOrderId ${woId}. Sam's Club Construction lead.`,
    user1:          String(woId),    // store IME WO ID in user1 for later lookup
  };

  // D5 path audit (2026-08-18): this path bypasses the addlead proxy's
  // address gate and lp-client addLead's required-field validation. IME work
  // orders carry a job address by construction; a blank one is upstream data
  // loss — surface it loudly (LP never repairs a prospect from a later push).
  const missingAddr = ['address1', 'city', 'state', 'zip'].filter((k) => !String(fields[k] || '').trim());
  if (missingAddr.length) {
    console.error(`[IME-LP] ⚠️ addlead for WO ${woId} missing address field(s) [${missingAddr.join(', ')}] — forwarding anyway (IME path is ungated); prospect will need UpdateProspectInfo backfill`);
  }

  return lpPost('/api/Leads/AddLead', fields);
}
