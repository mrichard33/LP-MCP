/**
 * Planner copy snapshot — scripts/test-planner-copy-snapshot.js
 *
 * 2026-10-18 (Phase 0 loose end, closed in Phase 1): the version rule covered
 * the response prompt only. #1363 changed LINES.callback_at, words a lead
 * reads, under v2.8.0 with no bump, so a reply row could not say which copy
 * wrote it. This snapshots the planner's own copy:
 *   - src/agentic/nepq-planner.js: every string / template literal in LINES,
 *     ALT_LINES, POST_DEMO_ASK_BACK, and on every line that sets a fixed line
 *     (fixed_line, ack_line, fixed(...), const line / stopLine);
 *   - src/agentic/rehash-nepq.js: every string / template literal (the track's
 *     stages, examples, moves and the block it renders).
 * A change there while RESPONSE_GENERATOR_VERSION still equals the version the
 * snapshot was recorded under fails, exactly like the prompt snapshot.
 * UPDATE_SNAPSHOTS=1 re-records it (with the new version).
 *
 * Run: node --test scripts/test-planner-copy-snapshot.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SNAPSHOT = path.join(HERE, 'fixtures', 'response-prompt', '__snapshots__', 'planner-copy.json');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/**
 * Every string and template literal in a JS source, with its line number.
 * A small tokenizer: comments and regex literals are skipped, so a word in
 * either never counts. Template literals keep their ${…} text raw. Pure.
 */
export function stringLiterals(src) {
  const out = [];
  let i = 0;
  let line = 1;
  let prev = '';
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; } i += 2; continue; }
    if (c === '/' && (prev === '' || REGEX_PREV.has(prev) || /(?:return|typeof|case|in|of)$/.test(src.slice(Math.max(0, i - 8), i).trimEnd()))) {
      i++;
      let cls = false;
      while (i < n) {
        const d = src[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '[') cls = true;
        else if (d === ']') cls = false;
        else if (d === '/' && !cls) break;
        else if (d === '\n') break;
        i++;
      }
      i++;
      while (i < n && /[a-z]/i.test(src[i])) i++;
      prev = '/';
      continue;
    }
    if (c === '\'' || c === '"') {
      const start = line;
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== c) { if (src[j] === '\\') { s += src[j] + src[j + 1]; j += 2; continue; } s += src[j]; j++; }
      out.push({ text: s, line: start });
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === '`') {
      const start = line;
      let j = i + 1;
      let s = '';
      let depth = 0;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { s += d + src[j + 1]; j += 2; continue; }
        if (depth === 0 && d === '`') break;
        if (d === '$' && src[j + 1] === '{') { depth++; s += '${'; j += 2; continue; }
        if (depth > 0 && d === '}') depth--;
        if (d === '\n') line++;
        s += d;
        j++;
      }
      out.push({ text: s, line: start });
      i = j + 1;
      prev = '`';
      continue;
    }
    prev = c;
    i++;
  }
  return out;
}

/** The [first, last] line of a top-level `const NAME = …` block (to its `});` / `};`). Pure. */
function blockLines(src, name) {
  const lines = src.split('\n');
  const startIdx = lines.findIndex(l => new RegExp(`^(?:export\\s+)?const\\s+${name}\\s*=`).test(l));
  if (startIdx < 0) return null;
  let endIdx = startIdx;
  while (endIdx < lines.length && !/^\}\)?;?\s*$/.test(lines[endIdx])) endIdx++;
  return [startIdx + 1, endIdx + 1];
}

const FIXED_LINE_RX = /\bfixed_line\b|\back_line\b|\bfixed\(|\bconst\s+(?:line|stopLine)\b|\bstopLine\s*=/;

/** The planner copy, as one JSON-able object. Pure (reads the two files). */
export function plannerCopy(root = ROOT) {
  const planner = fs.readFileSync(path.join(root, 'src/agentic/nepq-planner.js'), 'utf8');
  const rehash = fs.readFileSync(path.join(root, 'src/agentic/rehash-nepq.js'), 'utf8');
  const lits = stringLiterals(planner);
  const ranges = ['LINES', 'ALT_LINES', 'POST_DEMO_ASK_BACK'].map(n => blockLines(planner, n)).filter(Boolean);
  const srcLines = planner.split('\n');
  const fixedLines = new Set();
  srcLines.forEach((l, idx) => {
    if (!FIXED_LINE_RX.test(l)) return;
    // The line and its continuation lines (a statement split over a few).
    for (let k = idx; k < Math.min(srcLines.length, idx + 4); k++) {
      fixedLines.add(k + 1);
      if (/[;)]\s*$/.test(srcLines[k]) || /,\s*$/.test(srcLines[k]) && k > idx) break;
    }
  });
  const inRange = (ln) => ranges.some(([a, b]) => ln >= a && ln <= b) || fixedLines.has(ln);
  const pick = (arr) => [...new Set(arr.map(x => x.text).filter(t => t.trim().length > 1))].sort();
  return {
    'src/agentic/nepq-planner.js': pick(lits.filter(x => inRange(x.line))),
    'src/agentic/rehash-nepq.js': pick(stringLiterals(rehash).filter(x => !/^\.\.?\//.test(x.text))),
  };
}

/** Why a differing planner copy fails (the prompt snapshot's rule). Pure. */
export function copyVerdict(savedVersion, currentVersion) {
  return savedVersion === currentVersion
    ? 'planner copy changed; bump RESPONSE_GENERATOR_VERSION and re-run with UPDATE_SNAPSHOTS=1'
    : `RESPONSE_GENERATOR_VERSION is ${currentVersion} (planner copy recorded under ${savedVersion}); re-run with UPDATE_SNAPSHOTS=1 to record its copy`;
}

const { RESPONSE_GENERATOR_VERSION } = await import('../src/response-generator.js');

test('the tokenizer reads strings and skips comments and regexes', () => {
  const lits = stringLiterals("// 'not this'\nconst a = /it's/i; const b = 'yes'; const c = `x ${'y'} z`;");
  assert.deepEqual(lits.map(x => x.text), ['yes', "x ${'y'} z"]);
});

test('planner copy is snapshotted with the generator version it was written under', () => {
  const copy = plannerCopy();
  assert.ok(copy['src/agentic/nepq-planner.js'].length > 50, 'LINES and the fixed lines were found');
  assert.ok(copy['src/agentic/rehash-nepq.js'].length > 20, 'the rehash track copy was found');
  if (UPDATE) {
    fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
    fs.writeFileSync(SNAPSHOT, `${JSON.stringify({ version: RESPONSE_GENERATOR_VERSION, copy }, null, 1)}\n`);
    return;
  }
  assert.ok(fs.existsSync(SNAPSHOT), 'missing planner-copy.json — run with UPDATE_SNAPSHOTS=1');
  const saved = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  const same = JSON.stringify(saved.copy) === JSON.stringify(copy);
  if (same) return;
  const added = [];
  const removed = [];
  for (const f of Object.keys(copy)) {
    const before = new Set(saved.copy?.[f] || []);
    const now = new Set(copy[f]);
    for (const t of now) if (!before.has(t)) added.push(`+ ${f}: ${t}`);
    for (const t of before) if (!now.has(t)) removed.push(`- ${f}: ${t}`);
  }
  assert.fail(`${copyVerdict(saved.version, RESPONSE_GENERATOR_VERSION)}\n${[...removed, ...added].slice(0, 40).join('\n')}`);
});

test('a copy change without a bump names the bump; with one, the re-record (#1363)', () => {
  assert.match(copyVerdict('v2.8.0', 'v2.8.0'), /^planner copy changed; bump RESPONSE_GENERATOR_VERSION/);
  assert.match(copyVerdict('v2.8.0', 'v2.9.0'), /re-run with UPDATE_SNAPSHOTS=1 to record its copy$/);
});

test('a LINES edit shows up in the copy (the #1363 case)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-copy-'));
  try {
    fs.mkdirSync(path.join(tmp, 'src', 'agentic'), { recursive: true });
    const planner = fs.readFileSync(path.join(ROOT, 'src/agentic/nepq-planner.js'), 'utf8');
    fs.copyFileSync(path.join(ROOT, 'src/agentic/rehash-nepq.js'), path.join(tmp, 'src/agentic/rehash-nepq.js'));
    fs.writeFileSync(path.join(tmp, 'src/agentic/nepq-planner.js'), planner.replace('export const LINES = Object.freeze({', "export const LINES = Object.freeze({\n  probe_test: 'A brand new line a lead would read.',"));
    assert.ok(plannerCopy(tmp)['src/agentic/nepq-planner.js'].includes('A brand new line a lead would read.'));
    assert.ok(!plannerCopy()['src/agentic/nepq-planner.js'].includes('A brand new line a lead would read.'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
