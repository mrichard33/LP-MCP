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
} from '../src/five9-admin.js';

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
