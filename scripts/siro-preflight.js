#!/usr/bin/env node
/**
 * Siro preflight — scripts/siro-preflight.js (2026-10-16, Siro PR 1)
 *
 * Read-only. Proves the credential works on BOTH Siro APIs before any feature
 * code depends on it, and prints what the setup needs:
 *   - caller identity on the org-wide and user-scoped base URLs
 *   - integration connections (is Lead_Perfection connected? its id →
 *     SIRO_LP_CONNECTION_ID)
 *   - conversation configurations (the in-home presentation type UUID →
 *     SIRO_PRESENTATION_CONVERSATION_TYPE)
 *   - users (email + id)
 * Never prints a token. Usage: SIRO_API=… node scripts/siro-preflight.js
 * (or SIRO_CLIENT_ID + SIRO_CLIENT_SECRET).
 */
import {
  getCallerIdentity, listConnections, listConversationConfigurations, listUsers, listRows,
} from '../src/siro/client.js';
import { siroConfig } from '../src/siro/config.js';

function orgIdFrom(identity) {
  if (!identity || typeof identity !== 'object') return null;
  return identity.organizationId || identity.orgId || identity?.organization?.id
    || identity?.data?.organizationId || identity?.user?.organizationId || null;
}
function redactIdentity(identity) {
  // The identity body describes the caller; drop anything that looks like a secret.
  return JSON.parse(JSON.stringify(identity ?? null, (k, v) =>
    /token|secret|password|key/i.test(k) ? '[redacted]' : v));
}

async function main() {
  const cfg = siroConfig();
  const authKind = cfg.clientId && cfg.clientSecret ? 'client app (client_credentials)'
    : cfg.legacyToken ? `legacy org token (SIRO_API, ${cfg.legacyToken.length} chars)` : 'none';
  console.log(`Auth: ${authKind}`);
  // The webhook secret: set or not set, never the value.
  console.log(`SIRO_WEBHOOK_SECRET: ${process.env.SIRO_WEBHOOK_SECRET ? 'set' : 'NOT SET (the webhook refuses every request)'}`);

  const org = await getCallerIdentity('org');
  const user = await getCallerIdentity('user');
  console.log(`\nOrg-wide  caller-identity: ${org.status} ${org.ok ? 'OK' : org.error}`);
  if (org.ok) console.log(JSON.stringify(redactIdentity(org.data), null, 2));
  console.log(`User-scoped caller-identity: ${user.status} ${user.ok ? 'OK' : user.error}`);
  if (user.ok) console.log(JSON.stringify(redactIdentity(user.data), null, 2));

  const denied = (r) => r.status === 401 || r.status === 403 || r.status === 0;
  if (denied(org) && denied(user)) {
    console.log('\nSTOP: both APIs refused the credential.');
    console.log('Mark, create a client app in Siro (org admin → API access tab) and set SIRO_CLIENT_ID + SIRO_CLIENT_SECRET.');
    process.exitCode = 2;
    return;
  }

  const conns = await listConnections();
  console.log(`\nConnections: ${conns.status} ${conns.ok ? '' : conns.error}`);
  const rows = listRows(conns.data);
  for (const c of rows) console.log(`  ${c.id}  ${c.platform || c.type || '?'}  ${c.name || ''}`);
  const lp = rows.find(c => /lead[_ ]?perfection/i.test(`${c.platform || ''} ${c.name || ''}`));
  console.log(lp
    ? `→ SIRO_LP_CONNECTION_ID=${lp.id}`
    : '→ No Lead_Perfection connection: matching is phone-only until LP is connected in Siro.');

  const orgId = cfg.organizationId || orgIdFrom(org.data) || orgIdFrom(user.data);
  console.log(`\nOrganization id: ${orgId || 'unknown'}`);
  if (orgId) {
    const types = await listConversationConfigurations(orgId);
    console.log(`Conversation configurations: ${types.status} ${types.ok ? '' : types.error}`);
    for (const t of listRows(types.data)) console.log(`  ${t.conversationType || '?'}  ${t.name || t.title || t.displayName || ''}`);
  }

  const users = await listUsers();
  const urows = listRows(users.data);
  console.log(`\nUsers: ${users.status} ${users.ok ? urows.length : users.error}`);
  for (const u of urows) console.log(`  ${u.id}  ${u.email || ''}`);
}

main().catch(err => { console.error(`preflight failed: ${err.message}`); process.exitCode = 1; });
