/**
 * Guardrail 13 — Five9 web connector destination allow-list.
 * scripts/test-five9-webconnector-guardrail.js (Phase H PR4, 2026-08-21)
 *
 * WHY THESE ASSERTIONS AND NOT OTHERS. PR3 classified createWebConnector and
 * modifyWebConnector as `denied`, reasoning: "posts live call and contact data
 * to an arbitrary URL from the agent desktop; there is no destination
 * allow-list." Mark ruled the pair allowed on 2026-08-21. The reasoning was
 * not waived — it was ANSWERED, by building the allow-list. So this file's job
 * is to prove the answer holds: every escape route the denial was worried
 * about is closed, and the guardrail fails CLOSED when unconfigured.
 *
 * If any assertion here is ever relaxed, the ops go back to `denied`. They are
 * not independently safe.
 *
 * OFFLINE. Supabase env is scrubbed before the first import so the module-level
 * client is null and no audit event can reach a real database. Five9 creds are
 * dummies and global fetch is stubbed, so nothing leaves the process.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// MUST happen before the first import of anything that reaches supabase.js:
// that module builds its client at load time from these two vars.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const writes = await import('../src/five9/admin-writes.js');
const {
  validateWebConnectorDestination,
  checkWebConnectorDestinations,
  webConnectorAllowedHosts,
  webConnectorFromRead,
  mergeWebConnector,
  verifyWebConnectorReadBack,
  requiredConfirmToken,
  checkConfirmToken,
  executeCreateWebConnector,
  executeModifyWebConnector,
  WEBCONNECTOR_KV_BLOCKS,
} = writes;

const ALLOW = 'lp-mcp-production.up.railway.app,example.com';
const OK_URL = 'https://lp-mcp-production.up.railway.app/webhook/five9-event';

/* ====================================================================== *
 * 1. the allow-list itself
 * ====================================================================== */

test('an allow-listed https destination passes', () => {
  const v = validateWebConnectorDestination(OK_URL, ALLOW);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.host, 'lp-mcp-production.up.railway.app');
});

test('http:// is refused at an ALLOW-LISTED host — the scheme is checked first', () => {
  // The point: being on the allow-list does not buy you plaintext. An agent
  // desktop posting call and contact data over http is unacceptable at any
  // destination, so the scheme check runs before the host check.
  const v = validateWebConnectorDestination('http://lp-mcp-production.up.railway.app/x', ALLOW);
  assert.equal(v.ok, false);
  assert.match(v.reason, /not https/);
});

test('an off-list host is refused', () => {
  const v = validateWebConnectorDestination('https://webhook.site/abc', ALLOW);
  assert.equal(v.ok, false);
  assert.match(v.reason, /not in FIVE9_WEBCONNECTOR_ALLOWED_HOSTS/);
});

test('SUFFIX ATTACK: evil-example.com does not pass an entry of example.com', () => {
  // The specific bug exact-matching exists to prevent. A naive endsWith()
  // allow-list passes this, and it is indistinguishable from the real host at
  // a glance in an approval prompt.
  const v = validateWebConnectorDestination('https://evil-example.com/steal', ALLOW);
  assert.equal(v.ok, false);
  assert.match(v.reason, /exact match only/);
});

test('a SUBDOMAIN of an allow-listed host is refused too', () => {
  // Also exact-match: attacker-controlled subdomains are a real delegation
  // path, so "a.example.com" is not covered by "example.com".
  assert.equal(validateWebConnectorDestination('https://a.example.com/x', ALLOW).ok, false);
});

test('embedded credentials are refused', () => {
  const v = validateWebConnectorDestination('https://user:pass@example.com/x', ALLOW);
  assert.equal(v.ok, false);
  assert.match(v.reason, /embedded credentials/);
});

test('a non-standard port is refused', () => {
  const v = validateWebConnectorDestination('https://example.com:8443/x', ALLOW);
  assert.equal(v.ok, false);
  assert.match(v.reason, /non-standard port/);
});

test('IP-literal hosts are refused (v4, v6, and the bare-integer form)', () => {
  for (const url of ['https://192.168.1.5/x', 'https://[::1]/x', 'https://2130706433/x']) {
    const v = validateWebConnectorDestination(url, ALLOW);
    assert.equal(v.ok, false, `${url} must refuse`);
    assert.match(v.reason, /IP-literal|not a parseable/);
  }
});

test('a protocol-relative destination is refused — the scheme cannot be proven', () => {
  const v = validateWebConnectorDestination('//example.com/x', ALLOW);
  assert.equal(v.ok, false);
  assert.match(v.reason, /not a parseable absolute URL/);
});

test('FAILS CLOSED: an unset or empty allow-list refuses EVERYTHING', () => {
  // The single most important assertion in this file. A missing env var must
  // disable the feature, never open it.
  for (const raw of ['', '   ', ',,', undefined, null]) {
    assert.equal(webConnectorAllowedHosts(raw).size, 0, `${JSON.stringify(raw)} must parse to an empty set`);
    const v = validateWebConnectorDestination(OK_URL, raw);
    assert.equal(v.ok, false, `${JSON.stringify(raw)} must refuse a destination that is otherwise fine`);
    assert.match(v.reason, /unset or empty|fail closed/);
  }
});

test('the allow-list is case-insensitive on the hostname', () => {
  assert.equal(validateWebConnectorDestination('https://EXAMPLE.COM/x', ALLOW).ok, true);
  assert.equal(validateWebConnectorDestination(OK_URL, 'EXAMPLE.COM,LP-MCP-PRODUCTION.UP.RAILWAY.APP').ok, true);
});

/* ====================================================================== *
 * 2. every destination on the struct, not just `url`
 * ====================================================================== */

test('a connector with no url at all is refused rather than approved', () => {
  const v = checkWebConnectorDestinations({ name: 'X' }, { allowedHosts: ALLOW });
  assert.equal(v.ok, false);
  assert.match(v.violations.join(' '), /url: missing/);
});

test('a SECOND destination hidden in any keyValuePair block is caught', () => {
  // The whole reason the check does not stop at `url`: a connector whose url
  // is impeccable can still mirror every POST to somewhere else.
  for (const block of WEBCONNECTOR_KV_BLOCKS) {
    const v = checkWebConnectorDestinations({
      url: OK_URL,
      [block]: [{ key: 'mirror', value: 'https://webhook.site/steal' }],
    }, { allowedHosts: ALLOW });
    assert.equal(v.ok, false, `a rogue destination in ${block} must be caught`);
    assert.match(v.violations.join(' '), new RegExp(block));
    assert.match(v.violations.join(' '), /webhook\.site/);
  }
});

test('percent-encoding does not smuggle a destination past the check', () => {
  const v = checkWebConnectorDestinations({
    url: OK_URL,
    constants: [{ key: 'cb', value: 'https%3A%2F%2Fwebhook.site%2Fsteal' }],
  }, { allowedHosts: ALLOW });
  assert.equal(v.ok, false);
  assert.match(v.violations.join(' '), /webhook\.site/);
});

test('startPageText is checked too — same principle, different field', () => {
  const v = checkWebConnectorDestinations({
    url: OK_URL,
    startPageText: '<img src="https://webhook.site/beacon">',
  }, { allowedHosts: ALLOW });
  assert.equal(v.ok, false);
  assert.match(v.violations.join(' '), /startPageText/);
});

test('an EMBEDDED protocol-relative destination is caught, not just a leading one', () => {
  // startPageText is HTML, so the realistic form is <img src="//host/x">
  // rather than a bare leading "//". Anchoring the check to the start of the
  // value would have missed exactly the case this field makes possible.
  const v = checkWebConnectorDestinations({
    url: OK_URL,
    startPageText: '<img src="//webhook.site/beacon">',
  }, { allowedHosts: ALLOW });
  assert.equal(v.ok, false);
  assert.match(v.violations.join(' '), /startPageText/);
});

test('an ordinary "// comment" is not mistaken for a destination', () => {
  // The protocol-relative check requires a dotted hostname after the slashes,
  // so a false positive does not block a legitimate configuration.
  const v = checkWebConnectorDestinations({
    url: OK_URL,
    constants: [{ key: 'note', value: '// set by ops 2026-08' }],
  }, { allowedHosts: ALLOW });
  assert.equal(v.ok, true, v.violations.join('; '));
});

test('an ordinary call variable is NOT treated as a destination', () => {
  // False positives cost real configurations. Only URL-shaped values are
  // examined; "Call.ANI" is a variable reference, not a destination.
  const v = checkWebConnectorDestinations({
    url: OK_URL,
    postVariables: [{ key: 'ani', value: 'Call.ANI' }, { key: 'sid', value: 'Call.SessionId' }],
  }, { allowedHosts: ALLOW });
  assert.equal(v.ok, true, v.violations.join('; '));
});

test('the verdict records that NO compliance_override exists', () => {
  // Every other gated op here has an override. This one deliberately does not,
  // and the audit event says so rather than leaving it implied by absence.
  const v = checkWebConnectorDestinations({ url: OK_URL }, { allowedHosts: ALLOW });
  assert.equal(v.override_available, false);
});

/* ====================================================================== *
 * 3. read-modify-write — modify is a FULL-OBJECT REPLACE
 * ====================================================================== */

const LIVE = {
  name: 'LP-MCP Event Push',
  raw: {
    name: 'LP-MCP Event Push',
    description: 'original description',
    url: OK_URL,
    trigger: 'OnCallAccepted',
    postMethod: 'true',
    executeInBrowser: 'false',
    startPageText: 'hello',
    postVariables: [{ key: 'ani', value: 'Call.ANI' }, { key: 'sid', value: 'Call.SessionId' }],
    constants: [{ key: 'src', value: 'five9' }],
  },
};

test('RMW preserves every untouched field byte-for-byte', () => {
  const merged = mergeWebConnector(LIVE, { description: 'changed' });
  for (const [k, v] of Object.entries(LIVE.raw)) {
    if (k === 'description') continue;
    assert.deepEqual(merged[k], v, `${k} must survive the merge unchanged`);
  }
  assert.equal(merged.description, 'changed');
});

test('RMW reads booleans from the RAW block, so absent never becomes false', () => {
  // The reader normalizes `x === 'true'`, which turns an ABSENT field into an
  // explicit false. On a full-object replace an invented false is a silent
  // setting change, so the merge reads raw instead.
  const sparse = { name: 'C', raw: { name: 'C', url: OK_URL } };
  const built = webConnectorFromRead(sparse);
  assert.equal(Object.hasOwn(built, 'addWorksheet'), false, 'an absent boolean must stay absent, not become false');
  assert.equal(Object.hasOwn(built, 'postMethod'), false);
});

test('RMW refuses an unknown field rather than dropping it silently', () => {
  assert.throws(() => mergeWebConnector(LIVE, { notAField: 1 }), /unknown webConnector field/);
});

test('RMW refuses a rename through modify', () => {
  assert.throws(() => mergeWebConnector(LIVE, { name: 'Something Else' }), /cannot rename/);
});

test('RMW refuses when the read returned nothing parseable', () => {
  // Replacing a struct we could not read would submit a truncated object and
  // silently clear whatever we failed to see.
  assert.throws(() => mergeWebConnector({ name: 'C' }, { description: 'x' }), /no parseable webConnector body/);
  assert.throws(() => mergeWebConnector(null, { description: 'x' }), /no parseable webConnector body/);
});

test('the read-back diff reports drift on UNTOUCHED fields, not just changed ones', () => {
  const merged = mergeWebConnector(LIVE, { description: 'changed' });
  const after = { raw: { ...LIVE.raw, description: 'changed', trigger: 'OnCallEnded' } };
  const drift = verifyWebConnectorReadBack(merged, after, ['description']);
  const triggerDrift = drift.find((d) => d.field === 'trigger');
  assert.ok(triggerDrift, 'a field nobody asked to change that came back different must be reported');
  assert.equal(triggerDrift.untouched, true);
  assert.equal(drift.some((d) => d.field === 'description'), false, 'a field that landed as intended is not drift');
});

/* ====================================================================== *
 * 4. confirm_token
 * ====================================================================== */

test('both web connector ops require a confirm_token restating the connector name', () => {
  for (const op of ['create_web_connector', 'modify_web_connector']) {
    assert.equal(requiredConfirmToken(op, { connector_name: 'LP-MCP Event Push' }), 'LP-MCP Event Push');
    assert.throws(
      () => checkConfirmToken(op, { connector_name: 'LP-MCP Event Push', confirm_token: 'lp-mcp event push' }),
      /confirm_token mismatch/,
      `${op} must refuse a case-mismatched token`,
    );
    assert.doesNotThrow(
      () => checkConfirmToken(op, { connector_name: 'LP-MCP Event Push', confirm_token: 'LP-MCP Event Push' }));
  }
});

/* ====================================================================== *
 * 5. the executors — guardrail refusals happen, and dry-run cannot mutate
 * ====================================================================== */

function stubFive9(responder) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const body = String(opts?.body ?? '');
    const method = (/<ser:(\w+)>/.exec(body) || [])[1] || '(unknown)';
    calls.push({ method, body });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => responder(method, body),
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const EMPTY_CONNECTORS = '<soap:Envelope><soap:Body><ns2:getWebConnectorsResponse/></soap:Body></soap:Envelope>';

async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const action = (type, payload) => ({ id: 1, action_type: type, requires_approval: true, action_payload: payload });

test('executor: an off-list destination REFUSES, and never reaches the wire', async () => {
  const stub = stubFive9(() => EMPTY_CONNECTORS);
  try {
    await withEnv({
      FIVE9_WRITES_ENABLED: 'true', // armed, to prove the guardrail — not the flag — is what stops this
      FIVE9_USERNAME: 'u', FIVE9_PASSWORD: 'p',
      FIVE9_WEBCONNECTOR_ALLOWED_HOSTS: ALLOW,
    }, async () => {
      await assert.rejects(
        executeCreateWebConnector(action('five9_create_web_connector', {
          connector_name: 'Rogue', confirm_token: 'Rogue',
          connector: { url: 'https://webhook.site/steal' },
        })),
        /Guardrail 13/,
      );
    });
    assert.equal(stub.calls.some((c) => c.method === 'createWebConnector'), false,
      'a refused connector must never reach createWebConnector, even with writes armed');
  } finally { stub.restore(); }
});

test('executor: with the allow-list UNSET, even a good destination refuses', async () => {
  const stub = stubFive9(() => EMPTY_CONNECTORS);
  try {
    await withEnv({
      FIVE9_WRITES_ENABLED: 'true',
      FIVE9_USERNAME: 'u', FIVE9_PASSWORD: 'p',
      FIVE9_WEBCONNECTOR_ALLOWED_HOSTS: undefined,
    }, async () => {
      await assert.rejects(
        executeCreateWebConnector(action('five9_create_web_connector', {
          connector_name: 'Good', confirm_token: 'Good', connector: { url: OK_URL },
        })),
        /Guardrail 13/,
      );
    });
    assert.equal(stub.calls.some((c) => c.method === 'createWebConnector'), false);
  } finally { stub.restore(); }
});

test('executor: DRY-RUN builds the envelope and sends no write', async () => {
  const stub = stubFive9(() => EMPTY_CONNECTORS);
  try {
    const result = await withEnv({
      FIVE9_WRITES_ENABLED: undefined, // dry-run
      FIVE9_USERNAME: 'u', FIVE9_PASSWORD: 'p',
      FIVE9_WEBCONNECTOR_ALLOWED_HOSTS: ALLOW,
    }, () => executeCreateWebConnector(action('five9_create_web_connector', {
      connector_name: 'LP-MCP Event Push', confirm_token: 'LP-MCP Event Push',
      connector: { url: OK_URL, postMethod: true },
    })));

    assert.equal(result.dry_run, true);
    assert.equal(result.envelope_preview.length, 1, 'exactly one envelope previewed');
    assert.equal(result.envelope_preview[0].method, 'createWebConnector');
    assert.match(result.envelope_preview[0].innerXml, /<url>https:\/\/lp-mcp-production/);
    // The read ran for real; the write did not.
    assert.ok(stub.calls.some((c) => c.method === 'getWebConnectors'), 'read-before-write must still happen in dry-run');
    assert.equal(stub.calls.some((c) => c.method === 'createWebConnector'), false, 'dry-run must not mutate');
  } finally { stub.restore(); }
});

test('executor: modify REFUSES a token that does not match Five9’s own spelling', async () => {
  // The payload can be internally consistent and still be aimed at the wrong
  // target; this is the check that catches that.
  const live = '<soap:Envelope><soap:Body><ns2:getWebConnectorsResponse>' +
    `<return><name>LP-MCP Event Push</name><url>${OK_URL}</url></return>` +
    '</ns2:getWebConnectorsResponse></soap:Body></soap:Envelope>';
  const stub = stubFive9(() => live);
  try {
    await withEnv({
      FIVE9_WRITES_ENABLED: 'true',
      FIVE9_USERNAME: 'u', FIVE9_PASSWORD: 'p',
      FIVE9_WEBCONNECTOR_ALLOWED_HOSTS: ALLOW,
    }, async () => {
      await assert.rejects(
        executeModifyWebConnector({
          ...action('five9_modify_web_connector', {
            connector_name: 'lp-mcp event push',
            confirm_token: 'lp-mcp event push',
            changes: { description: 'x' },
          }),
        }),
        /confirm_token mismatch .*live connector name/s,
      );
    });
    assert.equal(stub.calls.some((c) => c.method === 'modifyWebConnector'), false);
  } finally { stub.restore(); }
});

test('executor: modify re-submits the WHOLE struct, carrying untouched fields', async () => {
  const live = '<soap:Envelope><soap:Body><ns2:getWebConnectorsResponse><return>' +
    '<name>LP-MCP Event Push</name>' +
    '<description>original description</description>' +
    `<url>${OK_URL}</url>` +
    '<trigger>OnCallAccepted</trigger>' +
    '<postMethod>true</postMethod>' +
    '<postVariables><key>ani</key><value>Call.ANI</value></postVariables>' +
    '</return></ns2:getWebConnectorsResponse></soap:Body></soap:Envelope>';
  const stub = stubFive9(() => live);
  try {
    const result = await withEnv({
      FIVE9_WRITES_ENABLED: undefined,
      FIVE9_USERNAME: 'u', FIVE9_PASSWORD: 'p',
      FIVE9_WEBCONNECTOR_ALLOWED_HOSTS: ALLOW,
    }, () => executeModifyWebConnector(action('five9_modify_web_connector', {
      connector_name: 'LP-MCP Event Push',
      confirm_token: 'LP-MCP Event Push',
      changes: { description: 'Updated by LP-MCP' },
    })));

    const xml = result.envelope_preview[0].innerXml;
    assert.equal(result.envelope_preview[0].method, 'modifyWebConnector');
    assert.match(xml, /<description>Updated by LP-MCP<\/description>/);
    // Everything nobody touched must still be on the wire — that is what makes
    // this a replace rather than a patch, and why omitting a field is dangerous.
    assert.match(xml, /<trigger>OnCallAccepted<\/trigger>/);
    assert.match(xml, /<postMethod>true<\/postMethod>/);
    assert.match(xml, /<postVariables><key>ani<\/key><value>Call\.ANI<\/value><\/postVariables>/);
    assert.match(xml, /<url>https:\/\/lp-mcp-production/);
    assert.equal(stub.calls.some((c) => c.method === 'modifyWebConnector'), false, 'dry-run must not mutate');
  } finally { stub.restore(); }
});

test('executor: a live connector already pointing off-list cannot be re-submitted', async () => {
  // Guardrail 13 runs on the MERGED struct, not on `changes`. A full-object
  // replace re-submits whatever destination the connector already carried, so
  // checking only the caller's changes would let a pre-existing bad
  // destination through on every subsequent edit.
  const live = '<soap:Envelope><soap:Body><ns2:getWebConnectorsResponse><return>' +
    '<name>Legacy</name><url>https://webhook.site/legacy</url>' +
    '</return></ns2:getWebConnectorsResponse></soap:Body></soap:Envelope>';
  const stub = stubFive9(() => live);
  try {
    await withEnv({
      FIVE9_WRITES_ENABLED: 'true',
      FIVE9_USERNAME: 'u', FIVE9_PASSWORD: 'p',
      FIVE9_WEBCONNECTOR_ALLOWED_HOSTS: ALLOW,
    }, async () => {
      await assert.rejects(
        executeModifyWebConnector(action('five9_modify_web_connector', {
          connector_name: 'Legacy', confirm_token: 'Legacy',
          changes: { description: 'just a description change' },
        })),
        /Guardrail 13/,
      );
    });
    assert.equal(stub.calls.some((c) => c.method === 'modifyWebConnector'), false);
  } finally { stub.restore(); }
});

test('executor: creating a connector whose name is taken REFUSES', async () => {
  const live = '<soap:Envelope><soap:Body><ns2:getWebConnectorsResponse><return>' +
    `<name>LP-MCP Event Push</name><url>${OK_URL}</url>` +
    '</return></ns2:getWebConnectorsResponse></soap:Body></soap:Envelope>';
  const stub = stubFive9(() => live);
  try {
    await withEnv({
      FIVE9_WRITES_ENABLED: 'true',
      FIVE9_USERNAME: 'u', FIVE9_PASSWORD: 'p',
      FIVE9_WEBCONNECTOR_ALLOWED_HOSTS: ALLOW,
    }, async () => {
      await assert.rejects(
        executeCreateWebConnector(action('five9_create_web_connector', {
          connector_name: 'LP-MCP Event Push', confirm_token: 'LP-MCP Event Push',
          connector: { url: OK_URL },
        })),
        /already exists/,
      );
    });
    assert.equal(stub.calls.some((c) => c.method === 'createWebConnector'), false);
  } finally { stub.restore(); }
});
