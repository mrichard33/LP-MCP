/**
 * Five9 consolidated config reads — five9_get_config and friends.
 * scripts/test-five9-config-reads.js (Phase H PR4, 2026-08-21)
 *
 * WHAT THIS PINS. Twenty read operations reach the MCP through FOUR tools, so
 * the dispatch table is now the thing that can silently be wrong: an
 * entity_type wired to the right SOAP operation but the WRONG argument
 * element returns an empty list rather than an error, and an empty list reads
 * as "nothing configured" instead of "you asked wrongly". A return-shape
 * assertion cannot tell those apart.
 *
 * So these tests drive the REAL readers over a stubbed transport and assert
 * the element that actually goes on the wire.
 *
 * OFFLINE. Supabase env is scrubbed before the first import; Five9 creds are
 * dummies and global fetch is stubbed, so nothing leaves the process.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.FIVE9_USERNAME = 'test-user';
process.env.FIVE9_PASSWORD = 'test-pass';

const tools = await import('../src/tools/five9-tools.js');
const {
  CONFIG_ENTITIES, CONFIG_ENTITY_TYPES,
  IMPORT_RESULT_READERS, IMPORT_JOB_TYPES,
  registerFive9Tools,
} = tools;

/* ---------------------------------------------------------------------- *
 * Transport stub — records every SOAP method and body that goes on the wire.
 * ---------------------------------------------------------------------- */
function stubFive9(responder = () => '') {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const body = String(opts?.body ?? '');
    const method = (/<ser:(\w+)>/.exec(body) || [])[1] || '(unknown)';
    calls.push({ method, body });
    return {
      ok: true, status: 200, headers: { get: () => null },
      text: async () => responder(method, body)
        || `<soap:Envelope><soap:Body><ns2:${method}Response/></soap:Body></soap:Envelope>`,
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/* ====================================================================== *
 * 1. five9_get_config — operation AND argument element, per entity_type
 * ====================================================================== */

// The authority for this table is the v13 schema, not the reader: each entry
// is the operation's declared argument name. A mismatch here is a read that
// silently returns nothing.
const EXPECTED = {
  skill: ['getSkillsInfo', 'skillNamePattern'],
  agent_group: ['getAgentGroups', 'groupNamePattern'],
  call_variable: ['getCallVariables', 'namePattern'],
  call_variable_group: ['getCallVariableGroups', 'namePattern'],
  web_connector: ['getWebConnectors', 'namePattern'],
  dialing_rule: ['getDialingRules', 'namePattern'],
  contact_field: ['getContactFields', 'namePattern'],
  reason_code: ['getReasonCodeByType', 'reasonCodeName'],
  prompt: ['getPrompts', null],
  campaign_strategy: ['getCampaignStrategies', 'campaignName'],
  campaign_profile_filter: ['getCampaignProfileFilter', 'profileName'],
  campaign_profile_dispositions: ['getCampaignProfileDispositions', 'profileName'],
  speed_dial: ['getSpeedDialNumbers', null],
};

test('the dispatch table covers exactly the 13 documented entity types', () => {
  assert.deepEqual([...CONFIG_ENTITY_TYPES].sort(), Object.keys(EXPECTED).sort());
});

test('every entity_type hits the right SOAP operation with the right element', async () => {
  for (const [entityType, [operation, element]] of Object.entries(EXPECTED)) {
    const stub = stubFive9();
    try {
      await CONFIG_ENTITIES[entityType].read({ name_pattern: 'SENTINEL_VALUE' });
      assert.equal(stub.calls.length >= 1, true, `${entityType} made no SOAP call`);
      const call = stub.calls[0];
      assert.equal(call.method, operation, `${entityType} dispatched to the wrong operation`);
      if (element) {
        assert.match(call.body, new RegExp(`<${element}>SENTINEL_VALUE</${element}>`),
          `${entityType} must send its argument as <${element}> — a wrong element name returns an empty list, not an error`);
      } else {
        // No-argument operations must send a bare wrapper, never an invented
        // element that Five9 would ignore.
        assert.match(call.body, new RegExp(`<ser:${operation}></ser:${operation}>|<ser:${operation}/>`),
          `${entityType} takes no argument, so nothing may be sent`);
        assert.equal(/SENTINEL_VALUE/.test(call.body), false,
          `${entityType} takes no argument but SENTINEL_VALUE reached the wire`);
      }
    } finally { stub.restore(); }
  }
});

test('the declared operation in CONFIG_ENTITIES matches what actually goes on the wire', async () => {
  // The table is also returned to the caller as `operation`, so a stale label
  // would mislabel real data. Pin the label against the wire, not against the
  // table's own copy of itself.
  for (const entityType of CONFIG_ENTITY_TYPES) {
    const stub = stubFive9();
    try {
      await CONFIG_ENTITIES[entityType].read({ name_pattern: 'x' });
      assert.equal(stub.calls[0].method, CONFIG_ENTITIES[entityType].operation, entityType);
    } finally { stub.restore(); }
  }
});

test('an omitted name_pattern lists everything on the pattern readers', async () => {
  for (const entityType of CONFIG_ENTITY_TYPES) {
    const entry = CONFIG_ENTITIES[entityType];
    if (entry.exact || !entry.patternField) continue;
    const stub = stubFive9();
    try {
      await entry.read({});
      assert.match(stub.calls[0].body, new RegExp(`<${entry.patternField}>\\.\\*</${entry.patternField}>`),
        `${entityType} must default to the match-everything pattern`);
    } finally { stub.restore(); }
  }
});

test('call_variable scopes to a group only when one is given', async () => {
  let stub = stubFive9();
  try {
    await CONFIG_ENTITIES.call_variable.read({ name_pattern: 'x', group_name: 'Default' });
    assert.match(stub.calls[0].body, /<groupName>Default<\/groupName>/);
  } finally { stub.restore(); }

  stub = stubFive9();
  try {
    await CONFIG_ENTITIES.call_variable.read({ name_pattern: 'x' });
    assert.equal(/<groupName>/.test(stub.calls[0].body), false,
      'an absent group must be omitted entirely, not sent empty');
  } finally { stub.restore(); }
});

test('reason_code sends its type filter only when one is given', async () => {
  let stub = stubFive9();
  try {
    await CONFIG_ENTITIES.reason_code.read({ name_pattern: 'x', type: 'NOT_READY' });
    assert.match(stub.calls[0].body, /<type>NOT_READY<\/type>/);
  } finally { stub.restore(); }

  stub = stubFive9();
  try {
    await CONFIG_ENTITIES.reason_code.read({ name_pattern: 'x' });
    assert.equal(/<type>/.test(stub.calls[0].body), false);
  } finally { stub.restore(); }
});

test('the three EXACT-name entity types refuse an empty name rather than listing everything', async () => {
  // These take an exact name, so an omitted one cannot silently become ".*" —
  // that would turn "read one campaign's strategies" into a fault or a wrong
  // answer depending on the operation.
  for (const entityType of ['campaign_strategy', 'campaign_profile_filter', 'campaign_profile_dispositions']) {
    assert.equal(CONFIG_ENTITIES[entityType].exact, true, `${entityType} must be marked exact`);
    const stub = stubFive9();
    try {
      await assert.rejects(() => CONFIG_ENTITIES[entityType].read({}), /is required/, entityType);
      assert.equal(stub.calls.length, 0, `${entityType} must not call SOAP with an empty name`);
    } finally { stub.restore(); }
  }
});

test('an exact-name value is passed VERBATIM, not escaped into a pattern', async () => {
  // A campaign called "DIAL ASAP (2026)" must reach Five9 as that exact string.
  const stub = stubFive9();
  try {
    await CONFIG_ENTITIES.campaign_strategy.read({ name_pattern: 'DIAL ASAP' });
    assert.match(stub.calls[0].body, /<campaignName>DIAL ASAP<\/campaignName>/);
  } finally { stub.restore(); }
});

test('prompt filters CLIENT-side, because the operation takes no argument', async () => {
  // getPrompts is the one reader here that does NOT parse <return> blocks —
  // its response wraps each prompt in <prompts>, which is why it has its own
  // promptBlocks() helper. A fixture using <return> would parse to zero and
  // make this test pass for the wrong reason.
  const stub = stubFive9((method) => (method === 'getPrompts'
    ? '<soap:Envelope><soap:Body><ns2:getPromptsResponse>' +
      '<prompts><name>Welcome Greeting</name><type>TTS</type></prompts>' +
      '<prompts><name>Hold Music</name><type>WAV</type></prompts>' +
      '</ns2:getPromptsResponse></soap:Body></soap:Envelope>'
    : ''));
  try {
    const all = await CONFIG_ENTITIES.prompt.read({});
    assert.equal(all.count, 2);
    const filtered = await CONFIG_ENTITIES.prompt.read({ name_pattern: 'hold' });
    assert.equal(filtered.count, 1);
    assert.equal(filtered.prompts[0].name, 'Hold Music');
    assert.equal(filtered.filtered_client_side, true,
      'the caller must be told the filter was not applied by Five9');
  } finally { stub.restore(); }
});

/* ====================================================================== *
 * 2. the tool handler — unknown types refuse, never default
 * ====================================================================== */

function captureTools() {
  const handlers = new Map();
  registerFive9Tools({
    tool: (name, _desc, _schema, handler) => handlers.set(name, handler),
  });
  return handlers;
}

const textOf = (res) => JSON.parse(res.content[0].text);

test('exactly four tools are added by this tranche, by name', () => {
  const handlers = captureTools();
  for (const name of [
    'five9_get_config', 'five9_get_import_result',
    'five9_get_contact_records', 'five9_get_call_counters_state',
  ]) {
    assert.equal(typeof handlers.get(name), 'function', `${name} must be registered`);
  }
});

test('an unknown entity_type REFUSES and names the valid set', async () => {
  // Never default. Defaulting to "skill" (or to anything) would answer a
  // question nobody asked, and the caller would have no way to tell.
  const handlers = captureTools();
  const out = textOf(await handlers.get('five9_get_config')({ entity_type: 'campaigns' }));
  assert.match(out.error, /unknown entity_type "campaigns"/);
  for (const valid of CONFIG_ENTITY_TYPES) {
    assert.match(out.error, new RegExp(valid), `the refusal must name ${valid}`);
  }
});

test('an exact-name type with no name_pattern refuses through the tool too', async () => {
  const handlers = captureTools();
  const out = textOf(await handlers.get('five9_get_config')({ entity_type: 'campaign_strategy' }));
  assert.match(out.error, /name_pattern is required/);
  assert.match(out.error, /exact campaignName/);
});

test('the tool labels its result with the entity_type and operation used', async () => {
  const stub = stubFive9();
  try {
    const handlers = captureTools();
    const out = textOf(await handlers.get('five9_get_config')({ entity_type: 'web_connector' }));
    assert.equal(out.entity_type, 'web_connector');
    assert.equal(out.operation, 'getWebConnectors');
  } finally { stub.restore(); }
});

/* ====================================================================== *
 * 3. five9_get_import_result — three job types, one identifier
 * ====================================================================== */

test('each job_type hits its own operation and sends the identifier', async () => {
  const expected = {
    list: 'getListImportResult',
    crm: 'getCrmImportResult',
    dispositions: 'getDispositionsImportResult',
  };
  assert.deepEqual([...IMPORT_JOB_TYPES].sort(), Object.keys(expected).sort());
  for (const [jobType, operation] of Object.entries(expected)) {
    const stub = stubFive9();
    try {
      await IMPORT_RESULT_READERS[jobType].read('JOB-123');
      assert.equal(stub.calls[0].method, operation, `${jobType} dispatched wrongly`);
      // The identifier is doubly nested in this API — <identifier><identifier>.
      assert.match(stub.calls[0].body, /<identifier><identifier>JOB-123<\/identifier><\/identifier>/,
        `${jobType} must send the nested identifier shape`);
    } finally { stub.restore(); }
  }
});

test('an unknown job_type refuses and names the valid set', async () => {
  const handlers = captureTools();
  const out = textOf(await handlers.get('five9_get_import_result')({ job_type: 'nope', identifier: 'x' }));
  assert.match(out.error, /unknown job_type "nope"/);
  assert.match(out.error, /list, crm, dispositions/);
});

test('an unrecognized identifier reports found:false, not a failure', async () => {
  // found:false means Five9 does not know the identifier — usually a job that
  // never submitted. Conflating that with "the job failed" would send someone
  // hunting the wrong problem.
  const stub = stubFive9();
  try {
    const out = await IMPORT_RESULT_READERS.list.read('NOPE');
    assert.equal(out.found, false);
    assert.equal(out.identifier, 'NOPE');
  } finally { stub.restore(); }
});

/* ====================================================================== *
 * 4. five9_get_contact_records — a query, not a pattern
 * ====================================================================== */

test('contact records send lookupCriteria, and require at least one criterion', async () => {
  const stub = stubFive9();
  try {
    const handlers = captureTools();
    await handlers.get('five9_get_contact_records')({ criteria: [{ field: 'number1', value: '5551234567' }] });
    assert.equal(stub.calls[0].method, 'getContactRecords');
    assert.match(stub.calls[0].body,
      /<lookupCriteria><criteria><field>number1<\/field><value>5551234567<\/value><\/criteria><\/lookupCriteria>/);
  } finally { stub.restore(); }

  const handlers = captureTools();
  const out = textOf(await handlers.get('five9_get_contact_records')({ criteria: [] }));
  assert.match(out.error, /at least one/);
});

test('contact records restate that LP is the system of record', async () => {
  // Not decoration: the whole reason every contact-DB WRITE is denied is that
  // a second writable copy diverges. A reader that presents Five9 data without
  // that caveat invites exactly the treatment the denial exists to prevent.
  const stub = stubFive9();
  try {
    const handlers = captureTools();
    const out = textOf(await handlers.get('five9_get_contact_records')({
      criteria: [{ field: 'number1', value: '5551234567' }],
    }));
    assert.match(out.system_of_record, /LP/);
  } finally { stub.restore(); }
});

/* ====================================================================== *
 * 5. five9_get_call_counters_state — live telemetry
 * ====================================================================== */

test('call counters take no argument and carry a capture timestamp', async () => {
  // A counter without a timestamp is not interpretable: these change
  // per-second, unlike every config read in this file.
  const stub = stubFive9();
  try {
    const handlers = captureTools();
    const out = textOf(await handlers.get('five9_get_call_counters_state')({}));
    assert.equal(stub.calls[0].method, 'getCallCountersState');
    assert.match(stub.calls[0].body, /<ser:getCallCountersState><\/ser:getCallCountersState>/);
    assert.ok(Date.parse(out.captured_at), 'captured_at must be a parseable timestamp');
  } finally { stub.restore(); }
});
