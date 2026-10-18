/**
 * test-response-prompt-snapshot.js — the guard on response-generator prompt text.
 *
 * Asserts that the fully assembled system + user prompts are BYTE-IDENTICAL to
 * committed snapshots, for every fixture. It exists so prompt text can be moved
 * out of src/response-generator.js into src/prompts/response-generator/ with
 * proof that nothing about what the model receives changed
 * (Handoff_ResponseGenerator_Split_v1, 2026-09).
 *
 * It is also the guard on every FUTURE prompt edit. A deliberate copy change is:
 *
 *   UPDATE_SNAPSHOTS=1 node --test scripts/test-response-prompt-snapshot.js
 *   node --test scripts/test-response-prompt-snapshot.js
 *
 * and the diff of scripts/fixtures/response-prompt/__snapshots__/*.txt IS the
 * copy change under review. An UNEXPLAINED snapshot diff means the extraction
 * is wrong, not the snapshot.
 *
 * Determinism: env is frozen and the clock is pinned BEFORE the module is
 * imported, so snapshots do not drift with whoever runs them.
 *
 * Coverage: scripts/fixtures/response-prompt/blocks.json is the machine-readable
 * form of docs/handoffs/response-generator-split-map.md — every prompt block
 * being moved, with a probe that identifies it in rendered output. A block no
 * fixture reaches fails the run, so a block cannot be extracted unguarded.
 *
 * VERSION DISCIPLINE (Phase 0, 2026-10-18): __snapshots__/VERSION records the
 * RESPONSE_GENERATOR_VERSION the snapshots were written under. A snapshot that
 * differs while the constant still equals VERSION fails with "prompt copy
 * changed; bump RESPONSE_GENERATOR_VERSION …": v2.7.14 had been stamped on
 * 206 builds, so a stored reply could not say which prompt wrote it.
 * UPDATE_SNAPSHOTS=1 rewrites VERSION along with the snapshots.
 *
 * Run: node --test scripts/test-response-prompt-snapshot.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'response-prompt');
const SNAPSHOT_DIR = path.join(FIXTURE_DIR, '__snapshots__');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

// ── Frozen env ───────────────────────────────────────────────────────
// Every key response-generator.js reads, at module load or per call, plus the
// NEPQ toggle its prompt block reads. Set BEFORE the import below: the first
// five are captured at module scope and a test that let the shell decide them
// would produce snapshots nobody else can reproduce.
const FROZEN_ENV = {
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  RESPONSE_GENERATOR_MAX_TOKENS: '2000',
  REECE_TIMEZONE: 'America/New_York',
  RESPONSE_GENERATOR_EDITS_LIMIT: '3',
  RESPONSE_GEN_SB_TIMEOUT_MS: '6000',
  REECE_DOMAIN_ALLOWLIST: 'reecewindows.com,getreecewindows.com,mail.reecewindows.com,reecewindowsmail.com,api.leadconnectorhq.com,app.gohighlevel.com,services.leadconnectorhq.com',
  AGENTIC_REPLY_SENDER_NAME: 'Mark',
  AGENTIC_REPLY_SENDER_ALLOWLIST: 'Mark',
  AGENTIC_SMS_NUMBER_MARK: '9542808890',
  AGENTIC_SMS_NUMBER_TEAM: '9543710083',
  NAMED_STORM_MODE: 'false',
  NEPQ_LAYER_MODE: 'on',
  CANVASS_PREFERRED_TIME_FIELD_ID: 'fixture_preferred_time_field',
  // 2026-10-10: the NEPQ-live prompt has a cleanup variant behind this flag.
  // Frozen off so system-nepq-live.txt is the legacy NEPQ prompt whoever runs
  // this; the clean variant is rendered explicitly below.
  PROMPT_NEPQ_CLEANUP_MODE: 'off',
};
for (const [k, v] of Object.entries(FROZEN_ENV)) process.env[k] = v;

// ── Pinned clock ─────────────────────────────────────────────────────
// formatTodayForPrompt() calls new Date(), and the fast-track/temperature
// helpers call Date.now(). Both are pinned to DEFAULT_NOW — the instant every fixture's
// context.now describes — so "TODAY IS:" is stable.
// FIXED_NOW is mutable so a fixture carrying "fixedNow" can pin a different day for its
// own render: TODAY IS / TOMORROW IS read the clock, not context.now, so a fixture that
// needs a specific weekday (34- needs a Friday) has no other way to ask for one.
const DEFAULT_NOW = new Date('2026-09-02T15:30:00Z').getTime();
let FIXED_NOW = DEFAULT_NOW;
const RealDate = Date;
class PinnedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(FIXED_NOW);
    else super(...args);
  }
  static now() {
    return FIXED_NOW;
  }
}
globalThis.Date = PinnedDate;

const { buildResponsePrompt, getResponseSystemPrompt, RESPONSE_GENERATOR_VERSION } =
  await import('../src/response-generator.js');

const VERSION_FILE = path.join(SNAPSHOT_DIR, 'VERSION');
const recordedVersion = fs.existsSync(VERSION_FILE) ? fs.readFileSync(VERSION_FILE, 'utf8').trim() : null;
if (UPDATE) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  fs.writeFileSync(VERSION_FILE, `${RESPONSE_GENERATOR_VERSION}\n`);
}

/**
 * Why a differing snapshot fails. Pure. The same version as the one the
 * snapshots were recorded under means the copy moved without a bump; a new
 * version means the bump is there and the snapshots only need re-recording.
 */
export function snapshotVerdict({ same, version, recorded }) {
  if (same) return null;
  if (recorded == null || version === recorded) {
    return 'prompt copy changed; bump RESPONSE_GENERATOR_VERSION and re-run with UPDATE_SNAPSHOTS=1';
  }
  return `RESPONSE_GENERATOR_VERSION is ${version} (snapshots recorded under ${recorded}); re-run with UPDATE_SNAPSHOTS=1 to record its copy`;
}

// ── Fixtures ─────────────────────────────────────────────────────────
const fixtures = fs.readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.json') && f !== 'blocks.json')
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8')));

const blocks = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'blocks.json'), 'utf8'));

/** Render one fixture. Per-fixture env is applied around the call and restored. */
function render(fixture) {
  const overrides = fixture.env || {};
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const savedNow = FIXED_NOW;
  if (fixture.fixedNow) FIXED_NOW = new RealDate(fixture.fixedNow).getTime();
  try {
    return {
      system: getResponseSystemPrompt(),
      user: buildResponsePrompt(
        fixture.context,
        fixture.channel,
        fixture.triggerMessage,
        fixture.kbPack,
        fixture.classification,
        fixture.fastTrack,
        fixture.trafficTemp,
        fixture.availability,
        fixture.opts,
      ),
    };
  } finally {
    FIXED_NOW = savedNow;
    for (const [k, prev] of Object.entries(saved)) {
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  }
}

/** First 40 differing lines, as a unified-diff-style report. */
function firstDifferences(expected, actual, limit = 40) {
  const e = expected.split('\n');
  const a = actual.split('\n');
  const out = [];
  for (let i = 0; i < Math.max(e.length, a.length) && out.length < limit * 2; i++) {
    if (e[i] === a[i]) continue;
    if (e[i] !== undefined) out.push(`-${i + 1}: ${e[i]}`);
    if (a[i] !== undefined) out.push(`+${i + 1}: ${a[i]}`);
  }
  return out.slice(0, limit * 2).join('\n');
}

function compare(file, label, actual) {
  if (UPDATE) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    fs.writeFileSync(file, actual);
    return;
  }
  assert.ok(
    fs.existsSync(file),
    `missing snapshot ${path.relative(HERE, file)} — run with UPDATE_SNAPSHOTS=1`,
  );
  const expected = fs.readFileSync(file, 'utf8');
  if (expected !== actual) {
    assert.fail(
      `${snapshotVerdict({ same: false, version: RESPONSE_GENERATOR_VERSION, recorded: recordedVersion })}\n` +
      `${label} changed.\n` +
      `If this was not a deliberate copy edit, the extraction is wrong — revert it.\n` +
      `First differing lines (- committed, + produced):\n${firstDifferences(expected, actual)}`,
    );
  }
  assert.strictEqual(actual, expected);
}

// The system prompt is a static const — it does not vary by fixture. Storing it
// once, and asserting every fixture reproduces that one file, keeps a
// system-prompt copy edit to a ONE-file diff instead of 32 identical ones, and
// is a strictly stronger check: a system prompt that started varying per
// fixture would fail here rather than pass 32 divergent snapshots.
const SYSTEM_SNAPSHOT = path.join(SNAPSHOT_DIR, 'system.txt');

// ── Snapshots ────────────────────────────────────────────────────────
const rendered = new Map();

test('the snapshots record the generator version they were written under', () => {
  assert.ok(recordedVersion, `missing ${path.relative(HERE, VERSION_FILE)} — run with UPDATE_SNAPSHOTS=1`);
  assert.match(recordedVersion, /^v\d+\.\d+\.\d+$/);
});

test('a snapshot diff without a version bump names the bump; with one, the re-record', () => {
  assert.equal(snapshotVerdict({ same: true, version: 'v2.8.0', recorded: 'v2.8.0' }), null);
  assert.equal(
    snapshotVerdict({ same: false, version: 'v2.8.0', recorded: 'v2.8.0' }),
    'prompt copy changed; bump RESPONSE_GENERATOR_VERSION and re-run with UPDATE_SNAPSHOTS=1',
  );
  assert.match(snapshotVerdict({ same: false, version: 'v2.8.1', recorded: 'v2.8.0' }), /re-run with UPDATE_SNAPSHOTS=1/);
  assert.doesNotMatch(snapshotVerdict({ same: false, version: 'v2.8.1', recorded: 'v2.8.0' }), /bump/);
});

test('fixtures load', () => {
  assert.ok(fixtures.length >= 10, `expected at least 10 fixtures, found ${fixtures.length}`);
  const names = new Set(fixtures.map((f) => f.name));
  assert.equal(names.size, fixtures.length, 'fixture names must be unique');
});

for (const fixture of fixtures) {
  test(`snapshot: ${fixture.name}`, () => {
    const out = render(fixture);
    rendered.set(fixture.name, out);
    compare(SYSTEM_SNAPSHOT, `system prompt (fixture "${fixture.name}")`, out.system);
    compare(
      path.join(SNAPSHOT_DIR, `${fixture.name}.user.txt`),
      `user prompt for fixture "${fixture.name}"`,
      out.user,
    );
  });
}

// 2026-10-06 (AI OS batch 1 PR 2): with a NEPQ PLAN block in the prompt the
// own-initiative CTA text is swapped (PPR_GATE_NEPQ, VALUE_LADDER_NEPQ). That
// variant gets its own snapshot so its copy is reviewed the same way.
test('snapshot: system prompt with a NEPQ PLAN block (NEPQ live)', () => {
  compare(path.join(SNAPSHOT_DIR, 'system-nepq-live.txt'), 'system prompt (NEPQ live)', getResponseSystemPrompt('live'));
});

// 2026-10-10 (audit 2026-10-09): with NEPQ live AND PROMPT_NEPQ_CLEANUP_MODE=live,
// six more legacy lines (HSO mandate, two times by default, push to book) are
// swapped for NEPQ variants. Its own snapshot, so Mark reads the diff against
// system-nepq-live.txt before flipping the flag.
test('snapshot: system prompt with a NEPQ PLAN block and the cleanup live (NEPQ live + PROMPT_NEPQ_CLEANUP_MODE=live)', () => {
  compare(path.join(SNAPSHOT_DIR, 'system-nepq-clean.txt'), 'system prompt (NEPQ live, cleanup live)', getResponseSystemPrompt('live', { cleanup: 'live' }));
});

test('the cleanup flag changes nothing with NEPQ off, and nothing but the six lines with NEPQ live', () => {
  assert.equal(getResponseSystemPrompt('off', { cleanup: 'live' }), getResponseSystemPrompt('off'));
  assert.equal(getResponseSystemPrompt('live', { cleanup: 'off' }), getResponseSystemPrompt('live'));
  const live = getResponseSystemPrompt('live').split('\n');
  const clean = getResponseSystemPrompt('live', { cleanup: 'live' }).split('\n');
  // The HSO MANDATE section (8 lines) becomes REPLY SHAPE (2 lines); the other
  // five swaps are line for line. So the clean prompt is exactly 6 lines shorter.
  assert.equal(live.length - clean.length, 6);
});

// ── Block coverage ───────────────────────────────────────────────────
test('every prompt block in the split map is exercised by a fixture', () => {
  // rendered is populated by the snapshot tests above, which node:test runs in
  // order; re-render anything missing so this test stands on its own.
  for (const fixture of fixtures) {
    if (!rendered.has(fixture.name)) rendered.set(fixture.name, render(fixture));
  }

  const coverage = new Map();
  for (const block of blocks) {
    const hits = [];
    const matcher = block.pattern
      ? (text) => new RegExp(block.pattern).test(text)
      : (text) => text.includes(block.probe);
    for (const [name, out] of rendered) {
      if (matcher(out.system) || matcher(out.user)) hits.push(name);
    }
    coverage.set(block.id, hits);
  }

  const lines = ['', 'BLOCK COVERAGE', ''];
  for (const block of blocks) {
    const hits = coverage.get(block.id);
    lines.push(
      `${hits.length ? 'ok  ' : 'MISS'} ${block.id.padEnd(22)} ${String(hits.length).padStart(2)}  ` +
      `${block.target.padEnd(14)} ${block.label}` +
      (hits.length && hits.length <= 3 ? `  [${hits.join(', ')}]` : ''),
    );
  }
  console.log(lines.join('\n'));

  const uncovered = blocks.filter((b) => coverage.get(b.id).length === 0);
  assert.deepEqual(
    uncovered.map((b) => `${b.id} (${b.label})`),
    [],
    'these prompt blocks are in the split map but no fixture renders them — ' +
    'add a fixture before extracting them',
  );
});
