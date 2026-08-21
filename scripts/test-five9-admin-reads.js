/**
 * Offline unit tests for the Phase B Five9 read-side parsing helpers.
 * No network. Run: node --test scripts/test-five9-admin-reads.js
 *
 * Covers the one recursive extractor (parseXmlBlock), the timer/array
 * normalizers, and the pure report-criteria builder — everything the new
 * read wrappers lean on that can be proven without a SOAP call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseXmlBlock,
  asArray,
  timerToSeconds,
  buildReportCriteriaXml,
  returnBlocks,
  tag,
  // 2026-08-13 Phase G — config surface
  promptBlocks,
  assertResponseSize,
  assertIvrDefinitionLimit,
  getDnisMap,
  invalidateDnisMap,
  __setDnisMapCacheForTest,
  MAX_IVR_DEFINITIONS,
  MAX_IVR_RESPONSE_BYTES,
  // 2026-08-21 — VCC credential redaction
  redactPasswords,
  REDACTED,
} from '../src/five9-admin.js';

/* ── VCC password redaction ────────────────────────────────────────────────
 *
 * getVCCConfiguration used to hand back recordingsServer and
 * transcriptsServer passwords in cleartext to every caller, which in practice
 * meant into any MCP transcript that asked for domain config.
 *
 * The shape below mirrors the LIVE response as read on 2026-08-21, with
 * invented credentials: three server blocks, each appearing TWICE (promoted
 * to the top level, and again under `raw`). The duplication is the whole
 * point — a redaction walking only the three named top-level keys passes a
 * naive test and still leaks both passwords through raw.
 */
const SECRET_RECORDINGS = 'rec-pw-must-never-appear';
const SECRET_TRANSCRIPTS = 'txn-pw-must-never-appear';

function liveShapedVccResponse() {
  const servers = {
    recordingsServer: { hostName: 'nas1.example.com', password: SECRET_RECORDINGS, userName: 'svcRecordings' },
    // Reece runs no Reports Server by design — all three fields blank.
    reportsServer: { hostName: '', password: '', userName: '' },
    transcriptsServer: { hostName: 'proxy.example.net', password: SECRET_TRANSCRIPTS, userName: 'svcTranscripts' },
  };
  return {
    domainId: '137613',
    domainName: 'Example Domain',
    ...servers,
    miscOptions: { defaultCampaign: 'Main Number', voicemailTimeout: '20' },
    raw: { domainId: '137613', domainName: 'Example Domain', ...servers },
  };
}

test('redactPasswords: no password value survives ANYWHERE in the serialized output', () => {
  const serialized = JSON.stringify(redactPasswords(liveShapedVccResponse()));
  // The assertion that matters. Checking only the top-level keys is exactly
  // the miss this guards against, so search the whole document — that also
  // catches a third copy if Five9 ever adds one.
  assert.equal(serialized.includes(SECRET_RECORDINGS), false, 'recordings password leaked');
  assert.equal(serialized.includes(SECRET_TRANSCRIPTS), false, 'transcripts password leaked');
});

test('redactPasswords: the nested raw duplicate is redacted, not just the top level', () => {
  const out = redactPasswords(liveShapedVccResponse());
  assert.equal(out.recordingsServer.password, REDACTED);
  assert.equal(out.transcriptsServer.password, REDACTED);
  // The copy a top-level-only redaction would have missed.
  assert.equal(out.raw.recordingsServer.password, REDACTED);
  assert.equal(out.raw.transcriptsServer.password, REDACTED);
});

test('redactPasswords: an EMPTY password stays empty — unset must not read as set', () => {
  const out = redactPasswords(liveShapedVccResponse());
  // Blanket-redacting would turn Reece's deliberately-absent Reports Server
  // into "[REDACTED]", i.e. into a claim that a credential is configured.
  assert.equal(out.reportsServer.password, '');
  assert.equal(out.raw.reportsServer.password, '');
  // ...and would also destroy the change log's ability to see a blank server
  // become a configured one.
  assert.notEqual(redactPasswords({ password: 'x' }).password, '');
  assert.equal(redactPasswords({ password: 'x' }).password, REDACTED);
});

test('redactPasswords: everything that is not a password is preserved exactly', () => {
  const input = liveShapedVccResponse();
  const out = redactPasswords(input);
  assert.equal(out.recordingsServer.hostName, 'nas1.example.com');
  assert.equal(out.recordingsServer.userName, 'svcRecordings');
  assert.equal(out.reportsServer.hostName, '');
  assert.equal(out.domainId, '137613');
  assert.deepEqual(out.miscOptions, { defaultCampaign: 'Main Number', voicemailTimeout: '20' });
  // Key PRESENCE is preserved: a caller can still see that a password field
  // exists and whether one is set, just not what it is.
  assert.ok(Object.hasOwn(out.recordingsServer, 'password'));
  // Pure — the caller's object is never mutated.
  assert.equal(input.recordingsServer.password, SECRET_RECORDINGS);
});

test('redactPasswords: walks arrays and tolerates odd shapes', () => {
  assert.deepEqual(redactPasswords([{ password: 'a' }, { password: '' }]), [{ password: REDACTED }, { password: '' }]);
  assert.deepEqual(redactPasswords({ a: [{ b: { password: 'deep' } }] }), { a: [{ b: { password: REDACTED } }] });
  // Non-string passwords are left alone rather than coerced — a null or an
  // object there means Five9 changed the shape, and silently stringifying it
  // to "[REDACTED]" would hide that.
  assert.deepEqual(redactPasswords({ password: null }), { password: null });
  for (const v of [null, undefined, 3, 'str', true]) assert.deepEqual(redactPasswords(v), v);
  // parseXmlBlock collapses repeated siblings into an array, so a password
  // arriving as ['secret'] must not walk past a string-only check.
  assert.deepEqual(redactPasswords({ password: ['secret', ''] }), { password: [REDACTED, ''] });
  assert.equal(JSON.stringify(redactPasswords({ raw: { password: ['secret'] } })).includes('secret'), false);
});

test('parseXmlBlock: flat scalar block', () => {
  const out = parseXmlBlock('<name>Rehash</name><state>RUNNING</state><dialingRatio>2</dialingRatio>');
  assert.deepEqual(out, { name: 'Rehash', state: 'RUNNING', dialingRatio: '2' });
});

test('parseXmlBlock: repeated siblings collapse to arrays, single stays scalar', () => {
  const out = parseXmlBlock(
    '<lists><name>A</name><priority>1</priority></lists>' +
    '<lists><name>B</name><priority>2</priority></lists>' +
    '<profileName>P1</profileName>'
  );
  assert.deepEqual(out.lists, [
    { name: 'A', priority: '1' },
    { name: 'B', priority: '2' },
  ]);
  assert.equal(out.profileName, 'P1');
  // asArray bridges the single-vs-array ambiguity for consumers
  assert.deepEqual(asArray(out.profileName), ['P1']);
  assert.deepEqual(asArray(out.lists), out.lists);
  assert.deepEqual(asArray(undefined), []);
  assert.deepEqual(asArray(null), []);
});

test('parseXmlBlock: deep nesting (report rows shape)', () => {
  const out = parseXmlBlock(
    '<header><values><data>CAMPAIGN</data><data>CALLS</data></values></header>' +
    '<records><values><data>Rehash</data><data>17</data></values></records>' +
    '<records><values><data>Fresh</data><data>3</data></values></records>'
  );
  assert.deepEqual(out.header.values.data, ['CAMPAIGN', 'CALLS']);
  assert.equal(out.records.length, 2);
  assert.deepEqual(out.records[1].values.data, ['Fresh', '3']);
});

test('parseXmlBlock: same-named nested tag is depth-matched, not first-close-matched', () => {
  const out = parseXmlBlock('<group><name>outer</name><group><name>inner</name></group></group>');
  assert.equal(out.group.name, 'outer');
  assert.equal(out.group.group.name, 'inner');
});

test('parseXmlBlock: xsi:nil and self-closing elements are null; empty element is empty string', () => {
  const out = parseXmlBlock('<data xsi:nil="true"/><ANI/><description></description><name>x</name>');
  assert.equal(out.data, null);
  assert.equal(out.ANI, null);
  assert.equal(out.description, '');
  assert.equal(out.name, 'x');
});

test('parseXmlBlock: entity decoding in leaves', () => {
  const out = parseXmlBlock('<description>A&amp;B &lt;Rehash&gt; &apos;Q4&apos;</description>');
  assert.equal(out.description, "A&B <Rehash> 'Q4'");
});

test('parseXmlBlock: repeated nillable data preserves null slots', () => {
  const out = parseXmlBlock('<values><data>a</data><data xsi:nil="true"/><data>c</data></values>');
  assert.deepEqual(out.values.data, ['a', null, 'c']);
});

test('parseXmlBlock: prototype-polluting tag names are ignored', () => {
  const out = parseXmlBlock('<__proto__><x>1</x></__proto__><safe>ok</safe>');
  assert.equal(out.safe, 'ok');
  assert.equal(Object.prototype.x, undefined);
});

test('timerToSeconds: full struct, partial struct, junk', () => {
  assert.equal(timerToSeconds({ days: '0', hours: '0', minutes: '1', seconds: '30' }), 90);
  assert.equal(timerToSeconds({ seconds: '2' }), 2);
  assert.equal(timerToSeconds({ days: '1' }), 86400);
  assert.equal(timerToSeconds(null), null);
  assert.equal(timerToSeconds('120'), null);
  assert.equal(timerToSeconds({}), 0);
});

test('buildReportCriteriaXml: WSDL sequence order is <end> before <start>', () => {
  const xml = buildReportCriteriaXml({ startIso: '2026-07-01T00:00:00', endIso: '2026-07-21T00:00:00' });
  assert.match(xml, /^<criteria><time><end>2026-07-21T00:00:00<\/end><start>2026-07-01T00:00:00<\/start><\/time><\/criteria>$/);
  assert.equal(buildReportCriteriaXml({}), '');
  assert.equal(buildReportCriteriaXml(), '');
  assert.match(buildReportCriteriaXml({ endIso: '2026-07-21T00:00:00' }), /<end>.*<\/end><\/time>/);
});

test('returnBlocks/tag: exported extractors still behave (regression)', () => {
  const xml = '<env><return><name>A</name></return><return><name>B&amp;C</name></return></env>';
  const blocks = returnBlocks(xml);
  assert.equal(blocks.length, 2);
  assert.equal(tag(blocks[0], 'name'), 'A');
  assert.equal(tag(blocks[1], 'name'), 'B&C');
  assert.equal(tag(blocks[0], 'missing'), '');
});

/* ---------------------------------------------------------------------- *
 * Phase G (2026-08-13) — config surface reads.
 *
 * These pin the three WSDL findings that a reasonable reader would
 * otherwise get wrong, each of which fails silently rather than loudly.
 * Verbatim schema: docs/five9/phase-g-wsdl-v13.md
 * ---------------------------------------------------------------------- */

test('promptBlocks: getPrompts wraps in <prompts>, and returnBlocks finds NOTHING there', () => {
  // Verbatim shape: <xs:element name="prompts" maxOccurs="unbounded"
  // type="tns:promptInfo"/> — getPrompts is the ONE op in this client whose
  // response is not <return>. Reaching for returnBlocks here yields an empty
  // list that reads exactly like "this domain has no prompts".
  const xml =
    '<ns2:getPromptsResponse>' +
    '<prompts><description>Main greeting</description><languages>en-US</languages>' +
    '<name>Canvass Greeting</name><type>TTSGenerated</type></prompts>' +
    '<prompts><description>Fallback</description><languages>en-US</languages>' +
    '<languages>es-MX</languages><name>Canvass Fallback</name><type>PreRecorded</type></prompts>' +
    '</ns2:getPromptsResponse>';

  assert.deepEqual(returnBlocks(xml), [], 'returnBlocks must not match this response');

  const blocks = promptBlocks(xml);
  assert.equal(blocks.length, 2);

  const parsed = blocks.map(parseXmlBlock);
  assert.equal(parsed[0].name, 'Canvass Greeting');
  assert.equal(parsed[0].type, 'TTSGenerated');
  // languages is maxOccurs="unbounded": one language parses scalar, two parse
  // as an array. asArray is what makes the shapes agree downstream.
  assert.deepEqual(asArray(parsed[0].languages), ['en-US']);
  assert.deepEqual(asArray(parsed[1].languages), ['en-US', 'es-MX']);
  assert.deepEqual(promptBlocks('<ns2:getPromptsResponse/>'), []);
});

test('assertIvrDefinitionLimit: refuses above the ceiling, and names the pattern', () => {
  assert.doesNotThrow(() => assertIvrDefinitionLimit(0, '^Canvass.*'));
  assert.doesNotThrow(() => assertIvrDefinitionLimit(MAX_IVR_DEFINITIONS, '^Canvass.*'));
  assert.throws(
    () => assertIvrDefinitionLimit(MAX_IVR_DEFINITIONS + 1, '.*'),
    /REFUSED: include_definition matched 4 scripts \(ceiling 3\) for name_pattern "\.\*"/,
  );
  // The limit is a parameter so a caller can tighten it, never widen it silently.
  assert.throws(() => assertIvrDefinitionLimit(2, 'x', 1), /matched 2 scripts \(ceiling 1\)/);
});

test('assertResponseSize: opt-in ceiling, and the marker survives for the caller', () => {
  // No ceiling configured => never throws, whatever the size. This is what
  // keeps every pre-Phase-G caller's behaviour identical.
  assert.doesNotThrow(() => assertResponseSize('getCampaigns', 50_000_000, undefined));
  assert.doesNotThrow(() => assertResponseSize('getCampaigns', 50_000_000, 0));
  // A missing content-length parses to NaN and must not be treated as
  // oversize. This is not a hypothetical: measured live 2026-08-13, Five9
  // returns large getIVRScripts responses with `transfer-encoding: chunked`
  // and NO content-length, so NaN is the normal case on exactly the
  // responses the ceiling exists for. Throwing here would refuse every large
  // read outright; the body-length check below is what enforces the limit.
  assert.doesNotThrow(() => assertResponseSize('getIVRScripts', NaN, 100));
  assert.doesNotThrow(() => assertResponseSize('getIVRScripts', parseInt('', 10), 100),
    'a header that is absent entirely must behave the same way');
  assert.doesNotThrow(() => assertResponseSize('getIVRScripts', 100, 100));

  assert.throws(
    () => assertResponseSize('getIVRScripts', 101, 100),
    /Five9 getIVRScripts: response is 101 bytes, over the 100-byte ceiling/,
  );
  // five9SoapCall keys off this marker to re-throw the refusal verbatim
  // instead of relabelling it a network error.
  try {
    assertResponseSize('getIVRScripts', 101, 100);
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.five9Oversize, true);
  }
  assert.ok(MAX_IVR_RESPONSE_BYTES > 0);
});

test('getDnisMap: cache is served without network and carries fetched_at', async () => {
  // No credentials are configured in this process, so any real SOAP call
  // throws. A resolved value therefore proves the cache short-circuited.
  const seeded = {
    fetched_at: '2026-08-13T00:00:00.000Z',
    inbound_campaigns: 2,
    assigned_count: 2,
    assignments: { '9045551234': 'Main Number', '9045559999': 'Canvass Confirmation - Inbound' },
    by_campaign: { 'Main Number': ['9045551234'], 'Canvass Confirmation - Inbound': ['9045559999'] },
    unassigned_count: 1,
    unassigned: ['9045550000'],
  };
  try {
    __setDnisMapCacheForTest(seeded);
    const hit = await getDnisMap();
    assert.equal(hit, seeded);
    assert.equal(hit.fetched_at, '2026-08-13T00:00:00.000Z');
    assert.equal(hit.assignments['9045559999'], 'Canvass Confirmation - Inbound');
    assert.deepEqual(hit.unassigned, ['9045550000']);

    // refresh must NOT be served from cache — it has to attempt a real read,
    // which fails here for want of credentials. That failure is the proof.
    await assert.rejects(() => getDnisMap({ refresh: true }), /credentials not configured/);

    invalidateDnisMap();
    await assert.rejects(() => getDnisMap(), /credentials not configured/);
  } finally {
    invalidateDnisMap();
  }
});

/* ── Part A: user-profile reads (2026-08-21 Phase H) ──────────────────────
 *
 * These drive the real readers over a stubbed transport, so they prove the
 * exact SOAP element that goes on the wire and the exact shape that comes
 * back — not just that a helper function is pure.
 */

const PROFILE_BLOCK = (name, extra = '') =>
  `<return><name>${name}</name><description>d-${name}</description><IEXScheduled>false</IEXScheduled>` +
  '<roles><agent><alwaysRecorded>true</alwaysRecorded><attachVmToEmail>false</attachVmToEmail>' +
  '<permissions><type>CanRunWebClient</type><value>true</value></permissions>' +
  '<sendEmailOnVm>false</sendEmailOnVm></agent></roles>' +
  `${extra}</return>`;

function stubFive9(handler) {
  const savedFetch = globalThis.fetch;
  const saved = { u: process.env.FIVE9_USERNAME, p: process.env.FIVE9_PASSWORD };
  process.env.FIVE9_USERNAME = 'test-user';
  process.env.FIVE9_PASSWORD = 'test-pass';
  const sent = [];
  globalThis.fetch = async (_url, opts) => {
    sent.push(String(opts?.body ?? ''));
    const body = handler(String(opts?.body ?? ''));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },      // Five9 sends these chunked, no length
      text: async () => `<soapenv:Envelope><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`,
    };
  };
  return {
    sent,
    restore() {
      globalThis.fetch = savedFetch;
      for (const [k, env] of [['u', 'FIVE9_USERNAME'], ['p', 'FIVE9_PASSWORD']]) {
        if (saved[k] === undefined) delete process.env[env]; else process.env[env] = saved[k];
      }
    },
  };
}

test('Part A — an empty/omitted pattern returns ALL profiles', async () => {
  const { getUserProfiles } = await import('../src/five9-users-info.js');
  const stub = stubFive9(() => PROFILE_BLOCK('Level 1 Setter Profile') + PROFILE_BLOCK('Level 2 Setter Profile'));
  try {
    for (const arg of [undefined, '', null]) {
      const out = await getUserProfiles(arg);
      assert.equal(out.count, 2, `pattern ${JSON.stringify(arg)} must list everything`);
      assert.deepEqual(out.profiles.map(p => p.name), ['Level 1 Setter Profile', 'Level 2 Setter Profile']);
    }
    // The misspelled element, and `.*` rather than "" — an empty string is not
    // a reliable match-all on this API.
    for (const body of stub.sent) {
      assert.match(body, /<userProfileNamePatern>\.\*<\/userProfileNamePatern>/);
      assert.match(body, /<ser:getUserProfiles>/);
    }
  } finally { stub.restore(); }
});

test('Part A — a named lookup returns exactly one, by exact name', async () => {
  const { getUserProfile } = await import('../src/five9-users-info.js');
  const stub = stubFive9(() => PROFILE_BLOCK('Level 1 Setter Profile'));
  try {
    const p = await getUserProfile('Level 1 Setter Profile');
    assert.equal(p.name, 'Level 1 Setter Profile');
    assert.equal(stub.sent.length, 1);
    // Singular op, and the element here is spelled correctly — only the
    // PATTERN one is misspelled in the WSDL.
    assert.match(stub.sent[0], /<ser:getUserProfile>/);
    assert.match(stub.sent[0], /<userProfileName>Level 1 Setter Profile<\/userProfileName>/);
  } finally { stub.restore(); }
});

test('Part A — a missing profile reads back as null, not as a throw', async () => {
  const { getUserProfile } = await import('../src/five9-users-info.js');
  const stub = stubFive9(() => '');  // no <return> block
  try {
    // The write-side existence guard depends on this being data, not an error.
    assert.equal(await getUserProfile('No Such Profile'), null);
  } finally { stub.restore(); }
  await assert.rejects(() => getUserProfile('  '), /profileName is required/);
});

test('Part A — the response carries the roles block, so no second call is needed', async () => {
  const { getUserProfiles } = await import('../src/five9-users-info.js');
  const stub = stubFive9(() => PROFILE_BLOCK(
    'Level 1 Setter Profile',
    '<skills>Dispatch</skills><skills>Rehash</skills><users>dellis1</users><users>jdennis1</users>',
  ));
  try {
    const [p] = (await getUserProfiles()).profiles;
    // The question that matters before anyone modifies a profile: what does
    // it GRANT? Answerable from this one response.
    assert.deepEqual(p.roles.assigned, ['agent']);
    assert.deepEqual(p.roles.permissions.agent, [{ type: 'CanRunWebClient', value: true }]);
    assert.deepEqual(p.skills, ['Dispatch', 'Rehash']);
    assert.deepEqual(p.users, ['dellis1', 'jdennis1']);
    assert.equal(p.description, 'd-Level 1 Setter Profile');
    assert.equal(p.IEXScheduled, false);
    // raw is retained — it is the lossless base modifyUserProfile rebuilds from.
    assert.equal(p.raw.roles.agent.alwaysRecorded, 'true');
  } finally { stub.restore(); }
});

test('Part A — an admin-granting profile is legible from the read alone', async () => {
  const { getUserProfiles } = await import('../src/five9-users-info.js');
  const stub = stubFive9(() =>
    '<return><name>Privileged</name><roles><admin><permissions><type>ManageUsers</type><value>true</value></permissions></admin></roles></return>');
  try {
    const [p] = (await getUserProfiles('Priv.*')).profiles;
    assert.deepEqual(p.roles.assigned, ['admin']);
    assert.deepEqual(p.roles.permissions.admin, [{ type: 'ManageUsers', value: true }]);
    assert.match(stub.sent[0], /<userProfileNamePatern>Priv\.\*<\/userProfileNamePatern>/);
  } finally { stub.restore(); }
});
