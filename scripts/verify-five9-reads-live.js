/**
 * Live read-only verification of every Phase B Five9 wrapper —
 * scripts/verify-five9-reads-live.js
 *
 * NOT part of `node --test` CI (CI has no Five9 creds). Run manually or on
 * Railway where FIVE9_USERNAME / FIVE9_PASSWORD are set:
 *
 *   node scripts/verify-five9-reads-live.js [--dnc 5551234567]
 *
 * Every call is a Config-API READ. Asserts non-empty parses, prints one
 * PASS/FAIL line per wrapper, exits 1 on any failure. Campaign names for
 * the detail reads are discovered from the live inventory (first OUTBOUND /
 * first INBOUND), so no fixture names go stale.
 */
import {
  getCampaigns,
  getOutboundCampaign,
  getInboundCampaign,
  getCampaignProfiles,
  getListsInfo,
  getDispositions,
  getSkills,
  getUsersGeneralInfo,
  checkDncForNumbers,
} from '../src/five9-admin.js';

if (!process.env.FIVE9_USERNAME || !process.env.FIVE9_PASSWORD) {
  console.error('FIVE9_USERNAME / FIVE9_PASSWORD not set — run where Five9 creds exist (Railway).');
  process.exit(1);
}

const dncArgIdx = process.argv.indexOf('--dnc');
const dncNumber = dncArgIdx >= 0 ? process.argv[dncArgIdx + 1] : null;

let failures = 0;
async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name} — ${err.message}`);
  }
}

const nonEmpty = (n, what) => { if (!n) throw new Error(`empty ${what}`); };

const inventory = await getCampaigns();
nonEmpty(inventory.count, 'campaign inventory');
console.log(`PASS  getCampaigns — ${inventory.count} campaigns (${inventory.running} running)`);

const firstOutbound = inventory.campaigns.find(c => c.type === 'OUTBOUND');
const firstInbound = inventory.campaigns.find(c => c.type === 'INBOUND');

await check('getOutboundCampaign', async () => {
  const c = await getOutboundCampaign(firstOutbound.name);
  nonEmpty(Object.keys(c.raw || {}).length, 'outbound campaign config');
  return `${c.name}: mode=${c.dialingMode} abandon=${c.maxDroppedCallsPercentage}% queue=${c.maxQueueTimeSeconds}s lists=${c.lists?.length ?? 'n/a'}`;
});

await check('getInboundCampaign', async () => {
  const c = await getInboundCampaign(firstInbound.name);
  nonEmpty(Object.keys(c.raw || {}).length, 'inbound campaign config');
  return `${c.name}: state=${c.state}`;
});

await check('getCampaignProfiles', async () => {
  const { count, profiles } = await getCampaignProfiles();
  nonEmpty(count, 'profile inventory');
  return `${count} profiles (e.g. ${profiles[0].name}: attempts=${profiles[0].numberOfAttempts})`;
});

await check('getListsInfo', async () => {
  const { count, lists } = await getListsInfo();
  nonEmpty(count, 'list inventory');
  const withCounts = lists.filter(l => Number.isFinite(l.size)).length;
  nonEmpty(withCounts, 'list record counts');
  return `${count} lists, ${withCounts} with record counts`;
});

await check('getDispositions', async () => {
  const { count } = await getDispositions();
  nonEmpty(count, 'disposition inventory');
  return `${count} dispositions`;
});

await check('getSkills', async () => {
  const { count, skills } = await getSkills();
  nonEmpty(count, 'skill inventory');
  return `${count} skills (e.g. ${skills[0].name})`;
});

await check('getUsersGeneralInfo', async () => {
  const { count, users } = await getUsersGeneralInfo('.*');
  nonEmpty(count, 'user inventory');
  if (users.some(u => 'password' in u)) throw new Error('password field leaked');
  return `${count} users, password fields stripped`;
});

await check('checkDncForNumbers', async () => {
  const numbers = dncNumber ? [dncNumber] : ['5555550100'];
  const r = await checkDncForNumbers(numbers);
  if (r.checked !== numbers.length) throw new Error('checked count mismatch');
  return dncNumber
    ? `${dncNumber} → ${r.on_dnc.includes(dncNumber) ? 'ON DNC' : 'not on DNC'}`
    : `probe number checked (pass --dnc <number> to test a known-DNC number)`;
});

console.log(failures ? `\n${failures} wrapper(s) FAILED` : '\nAll Phase B live reads verified.');
process.exit(failures ? 1 : 0);
