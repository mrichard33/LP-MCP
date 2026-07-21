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
