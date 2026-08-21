/**
 * Tests — Call Intelligence flag logic: shadow blocks every write path
 * scripts/test-ci-config.js
 *
 * THE CONTRACT THIS GUARDS (handoff §13, PR 1 test mandate): in shadow mode —
 * the default, and the coercion target of every malformed CALL_INTEL_MODE —
 * no combination of write flags may ever enable a CRM write. The flag logic
 * in src/ci/config.js is the single safety boundary between "full pipeline
 * runs in shadow" and "notes appear on real LP/GHL records", so the shadow
 * cases are enumerated exhaustively (all 16 flag combinations × every
 * non-'live' mode spelling), not sampled.
 *
 * parseConfig is pure (takes an env object) and src/ci/config.js imports no
 * clients, so no env stubbing is needed to import it.
 *
 * Run: node --test scripts/test-ci-config.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseConfig,
  liveWrites,
  ghlCreateEnabled,
  allowProbableLp,
  nextRetryAt,
} from '../src/ci/config.js';
import {
  teamFromName,
  teamFromEmail,
  deriveTeam,
  isServiceAccount,
  isCanvassConfirmation,
} from './seed-ci-maps.js';

const FLAG_KEYS = [
  'CALL_INTEL_LP_WRITES',
  'CALL_INTEL_GHL_WRITES',
  'CALL_INTEL_GHL_CREATE',
  'CALL_INTEL_ALLOW_PROBABLE',
];

// All 16 true/false combinations of the four write flags.
function allFlagCombos() {
  const combos = [];
  for (let bits = 0; bits < 16; bits++) {
    const env = {};
    FLAG_KEYS.forEach((k, i) => { env[k] = bits & (1 << i) ? 'true' : 'false'; });
    combos.push(env);
  }
  return combos;
}

function assertAllWritePathsBlocked(cfg, label) {
  assert.equal(liveWrites('lp', cfg), false, `${label}: liveWrites('lp') must be false`);
  assert.equal(liveWrites('ghl', cfg), false, `${label}: liveWrites('ghl') must be false`);
  assert.equal(ghlCreateEnabled(cfg), false, `${label}: ghlCreateEnabled must be false`);
  assert.equal(allowProbableLp(cfg), false, `${label}: allowProbableLp must be false`);
}

test('shadow mode blocks every write path for all 16 flag combinations', () => {
  for (const flags of allFlagCombos()) {
    const cfg = parseConfig({ CALL_INTEL_MODE: 'shadow', ...flags });
    assertAllWritePathsBlocked(cfg, `shadow + ${JSON.stringify(flags)}`);
  }
});

test('unset, empty, and malformed modes coerce to shadow and block every write path', () => {
  const allOn = Object.fromEntries(FLAG_KEYS.map((k) => [k, 'true']));
  for (const mode of [undefined, '', 'SHADOW', 'live!', 'prod', 'true', '1', 'enforce', 'off']) {
    const env = { ...allOn };
    if (mode !== undefined) env.CALL_INTEL_MODE = mode;
    const cfg = parseConfig(env);
    assert.equal(cfg.mode, 'shadow', `mode ${JSON.stringify(mode)} must coerce to shadow`);
    assertAllWritePathsBlocked(cfg, `mode=${JSON.stringify(mode)} + all flags true`);
  }
});

// 'live' itself must parse (case/whitespace-tolerantly) — otherwise the
// coercion above would make going live impossible and nobody would notice
// until flip day.
test("mode 'live' (any casing, trimmed) parses as live", () => {
  for (const mode of ['live', 'LIVE', ' live ', 'Live']) {
    assert.equal(parseConfig({ CALL_INTEL_MODE: mode }).mode, 'live');
  }
});

test('completely empty env: shadow, all flags off, every write path blocked', () => {
  const cfg = parseConfig({});
  assert.equal(cfg.mode, 'shadow');
  assert.equal(cfg.lpWrites, false);
  assert.equal(cfg.ghlWrites, false);
  assert.equal(cfg.ghlCreate, false);
  assert.equal(cfg.allowProbable, false);
  assertAllWritePathsBlocked(cfg, 'empty env');
});

test('live mode with a target flag off still blocks that target', () => {
  const cfg = parseConfig({ CALL_INTEL_MODE: 'live' });
  assertAllWritePathsBlocked(cfg, 'live + all flags off');
});

test('live + LP flag enables ONLY LP — targets are independent', () => {
  const cfg = parseConfig({ CALL_INTEL_MODE: 'live', CALL_INTEL_LP_WRITES: 'true' });
  assert.equal(liveWrites('lp', cfg), true);
  assert.equal(liveWrites('ghl', cfg), false);
  assert.equal(ghlCreateEnabled(cfg), false);
});

test('live + GHL flag enables ONLY GHL — targets are independent', () => {
  const cfg = parseConfig({ CALL_INTEL_MODE: 'live', CALL_INTEL_GHL_WRITES: 'true' });
  assert.equal(liveWrites('ghl', cfg), true);
  assert.equal(liveWrites('lp', cfg), false);
  assert.equal(allowProbableLp(cfg), false);
});

test('ghlCreateEnabled needs live AND ghlWrites AND ghlCreate — all three', () => {
  const base = { CALL_INTEL_MODE: 'live', CALL_INTEL_GHL_WRITES: 'true', CALL_INTEL_GHL_CREATE: 'true' };
  assert.equal(ghlCreateEnabled(parseConfig(base)), true);
  assert.equal(ghlCreateEnabled(parseConfig({ ...base, CALL_INTEL_MODE: 'shadow' })), false);
  assert.equal(ghlCreateEnabled(parseConfig({ ...base, CALL_INTEL_GHL_WRITES: 'false' })), false);
  assert.equal(ghlCreateEnabled(parseConfig({ ...base, CALL_INTEL_GHL_CREATE: 'false' })), false);
});

test('allowProbableLp needs live AND lpWrites AND allowProbable — all three', () => {
  const base = { CALL_INTEL_MODE: 'live', CALL_INTEL_LP_WRITES: 'true', CALL_INTEL_ALLOW_PROBABLE: 'true' };
  assert.equal(allowProbableLp(parseConfig(base)), true);
  assert.equal(allowProbableLp(parseConfig({ ...base, CALL_INTEL_MODE: 'shadow' })), false);
  assert.equal(allowProbableLp(parseConfig({ ...base, CALL_INTEL_LP_WRITES: 'false' })), false);
  assert.equal(allowProbableLp(parseConfig({ ...base, CALL_INTEL_ALLOW_PROBABLE: 'false' })), false);
});

test('unknown write target is false even when everything is on', () => {
  const cfg = parseConfig({
    CALL_INTEL_MODE: 'live',
    CALL_INTEL_LP_WRITES: 'true',
    CALL_INTEL_GHL_WRITES: 'true',
  });
  assert.equal(liveWrites('salesforce', cfg), false);
  assert.equal(liveWrites('', cfg), false);
  assert.equal(liveWrites(undefined, cfg), false);
});

test("flag values other than 'true' (case-insensitive, no padding) stay false", () => {
  for (const v of ['1', 'yes', 'on', 'TRUE ', 'enabled', 'false', '']) {
    const cfg = parseConfig({ CALL_INTEL_MODE: 'live', CALL_INTEL_LP_WRITES: v });
    assert.equal(liveWrites('lp', cfg), false, `value ${JSON.stringify(v)} must not enable writes`);
  }
  assert.equal(liveWrites('lp', parseConfig({ CALL_INTEL_MODE: 'live', CALL_INTEL_LP_WRITES: 'TRUE' })), true);
});

test('numeric tunables: defaults, garbage fallback, floor clamping', () => {
  const d = parseConfig({});
  assert.equal(d.minSeconds, 30);
  assert.equal(d.batchSize, 10);
  assert.equal(d.maxAttempts, 5);
  assert.equal(d.recordingWaitHours, 6);
  assert.equal(d.audioRetentionDays, 7);
  assert.equal(d.sftp.port, 2282);   // v2: ETG's archive, not the generic 22
  assert.equal(d.lpNoteCategoryId, 1);

  const garbage = parseConfig({ CALL_INTEL_MIN_SECONDS: 'banana', CALL_INTEL_BATCH_SIZE: '' });
  assert.equal(garbage.minSeconds, 30);
  assert.equal(garbage.batchSize, 10);

  const floored = parseConfig({ CALL_INTEL_BATCH_SIZE: '0', CALL_INTEL_MAX_ATTEMPTS: '-3' });
  assert.equal(floored.batchSize, 1);
  assert.equal(floored.maxAttempts, 1);
});

// THE DEFECT THIS GUARDS: the repo's usual boolean idiom is `=== 'true'`
// (opt-in). Applied here it would make an unset CI_SFTP_READONLY mean
// WRITABLE — against a third party's recording archive that the account holds
// rwxrwxrwx over and that is the system of record for every recording. Only
// the literal 'false' may disarm the guard.
test('sftp.readOnly defaults TRUE and only literal false disarms it', () => {
  for (const v of [undefined, '', '   ', 'garbage', 'no', '0', 'FALSE_', 'true', 'TRUE']) {
    const env = { CI_SFTP_READONLY: v };
    if (v === undefined) delete env.CI_SFTP_READONLY;
    assert.equal(parseConfig(env).sftp.readOnly, true, `${JSON.stringify(v)} must stay read-only`);
  }
  assert.equal(parseConfig({}).sftp.readOnly, true, 'empty env must be read-only');
  // Only an explicit, unambiguous opt-out flips it.
  for (const v of ['false', 'FALSE', ' false ']) {
    assert.equal(parseConfig({ CI_SFTP_READONLY: v }).sftp.readOnly, false, `${JSON.stringify(v)} disarms`);
  }
});

// THE DEFECT THIS GUARDS: the correct offset is NEGATIVE. Routing it through
// intFloor (Math.max(floor, n)) would clamp -300 to 0 for any floor >= 0 and
// silently shift every filename-derived timestamp five hours, breaking the
// campaign+ANI+time join for every recording.
test('recordingTzOffsetMin keeps its negative sign and is never clamped', () => {
  assert.equal(parseConfig({}).recordingTzOffsetMin, -300);
  assert.equal(parseConfig({ CI_RECORDING_TZ_OFFSET_MIN: '-300' }).recordingTzOffsetMin, -300);
  assert.equal(parseConfig({ CI_RECORDING_TZ_OFFSET_MIN: '-240' }).recordingTzOffsetMin, -240);
  assert.equal(parseConfig({ CI_RECORDING_TZ_OFFSET_MIN: '0' }).recordingTzOffsetMin, 0);
  assert.equal(parseConfig({ CI_RECORDING_TZ_OFFSET_MIN: 'banana' }).recordingTzOffsetMin, -300);
  assert.ok(parseConfig({}).recordingTzOffsetMin < 0, 'EST offset must remain negative');
});

test('SFTP config: v2 names, real defaults, password stays secret', () => {
  const d = parseConfig({}).sftp;
  assert.equal(d.host, 'nas1.etgts.com');
  assert.equal(d.port, 2282);
  assert.equal(d.user, 'Five9reece');
  assert.equal(d.root, '/Five9/Recordings');
  assert.equal(d.password, null, 'password must never carry a default');
  // The v1 names are gone — a stale reference must not silently read undefined.
  assert.equal('key' in d, false);
  assert.equal('path' in d, false);
  const o = parseConfig({ CI_SFTP_HOST: 'h', CI_SFTP_PORT: '22', CI_SFTP_USER: 'u', CI_SFTP_PASSWORD: 'p', CI_SFTP_ROOT: '/r' }).sftp;
  assert.deepEqual([o.host, o.port, o.user, o.password, o.root], ['h', 22, 'u', 'p', '/r']);
});

test('v2 recording-join tunables: defaults and floors', () => {
  const d = parseConfig({});
  assert.equal(d.recordingMatchWindowS, 180);
  assert.equal(d.minRecordingBytes, 8000);
  assert.equal(d.transferRecordingEnabledFrom, null);
  assert.equal(parseConfig({ CI_RECORDING_MATCH_WINDOW_S: '0' }).recordingMatchWindowS, 1);
  assert.equal(parseConfig({ CI_MIN_RECORDING_BYTES: 'x' }).minRecordingBytes, 8000);
  assert.equal(parseConfig({ CI_TRANSFER_RECORDING_ENABLED_FROM: '2026-08-19' }).transferRecordingEnabledFrom, '2026-08-19');
});

test('nextRetryAt: 5min × 2^attempts, capped at 6h', () => {
  const now = new Date('2026-08-19T12:00:00Z');
  const min = 60 * 1000;
  assert.equal(nextRetryAt(0, now).getTime() - now.getTime(), 5 * min);
  assert.equal(nextRetryAt(1, now).getTime() - now.getTime(), 10 * min);
  assert.equal(nextRetryAt(5, now).getTime() - now.getTime(), 160 * min);
  assert.equal(nextRetryAt(7, now).getTime() - now.getTime(), 360 * min);   // 640 → capped
  assert.equal(nextRetryAt(20, now).getTime() - now.getTime(), 360 * min);  // deep overflow still capped
});

// ─── seed-script rules (settled handoff decisions #5 and §8) ─────────────────

test('teamFromName: LP-name suffixes map deterministically, no suffix → null', () => {
  assert.equal(teamFromName('Jane Doe - LF'), 'lightfire');
  assert.equal(teamFromName('Jane Doe - NC'), 'north_carolina');
  assert.equal(teamFromName('Jane Doe - FTM'), 'ftm');
  assert.equal(teamFromName('Jane Doe -LF'), 'lightfire');
  assert.equal(teamFromName('Jane Doe'), null);
  assert.equal(teamFromName('LF Jane Doe'), null);   // suffix rule, not substring
  assert.equal(teamFromName(''), null);
  assert.equal(teamFromName(null), null);
});

test('isCanvassConfirmation matches by live-name content, case-insensitively', () => {
  assert.equal(isCanvassConfirmation('Canvass Confirmation'), true);
  assert.equal(isCanvassConfirmation('Canvass Confirmation - Inbound'), true);
  assert.equal(isCanvassConfirmation('CANVASS CONFIRM QUEUE'), true);
  assert.equal(isCanvassConfirmation('Canvass Outbound'), false);
  assert.equal(isCanvassConfirmation('Confirmation Calls'), false);
  assert.equal(isCanvassConfirmation(''), false);
});

// The live 2026-08-20 campaign list contains BOTH of these. Matching the
// canvass line must not also catch the ordinary confirmation line, and the
// canvass row's key must be the full live name — the handoff's shorthand
// "Canvass Confirmation" is the dial PROFILE name and matches no campaign.
test('the live canvass line matches and the ordinary confirmation line does not', () => {
  assert.equal(isCanvassConfirmation('Canvass Confirmation - Inbound'), true);
  assert.equal(isCanvassConfirmation('Confirmation - Inbound'), false);
  assert.equal(isCanvassConfirmation('Conf - Next Day'), false);
});

test('teamFromEmail: measured live-domain patterns, no overlap', () => {
  assert.equal(teamFromEmail('ssmith@lightfirepartners.com'), 'lightfire');
  assert.equal(teamFromEmail('craigdlfpc@gmail.com'), 'lightfire');
  assert.equal(teamFromEmail('daanaelfpc@gmail.com'), 'lightfire');
  assert.equal(teamFromEmail('r.lymych@reecewindows.com'), 'reece');
  assert.equal(teamFromEmail('J.Nunes@Reecewindows.com'), 'reece');   // live casing varies
  assert.equal(teamFromEmail('dylannunes.reece@gmail.com'), 'reece');
  // Deliberately undecided — a different entity, and unlabelled personal mail.
  assert.equal(teamFromEmail('brian@reecebuilders.com'), null);
  assert.equal(teamFromEmail('hilla0616@gmail.com'), null);
  assert.equal(teamFromEmail(''), null);
  assert.equal(teamFromEmail(null), null);
});

// THE DEFECT THIS GUARDS: measured 2026-08-20, zero of 48 live Five9 users
// carry an LP-name suffix, so a name-only rule with a 'reece' fallback
// labelled nine demonstrably-LightFire agents as Reece — silently, on every
// note and every report.
test('deriveTeam: LightFire agents never come back as reece', () => {
  assert.equal(deriveTeam({ firstName: 'Shakeriah', lastName: 'Smith', EMail: 'ssmith@lightfirepartners.com' }), 'lightfire');
  assert.equal(deriveTeam({ firstName: 'Craig', lastName: 'Deer', EMail: 'craigdlfpc@gmail.com' }), 'lightfire');
  assert.equal(deriveTeam({ firstName: 'Carla', lastName: 'Wright', EMail: 'carlawlfpc@gmail.com' }), 'lightfire');
});

test('deriveTeam: suffix wins over email when present', () => {
  assert.equal(deriveTeam({ firstName: 'Jane', lastName: 'Doe - NC', EMail: 'jane.reece@gmail.com' }), 'north_carolina');
  assert.equal(deriveTeam({ firstName: 'Jane', lastName: 'Doe - FTM', EMail: 'jane@reecewindows.com' }), 'ftm');
});

test("deriveTeam: undecidable agents are 'unknown', never a guessed team", () => {
  assert.equal(deriveTeam({ firstName: 'Brian', lastName: 'Lovette', EMail: 'brian@reecebuilders.com' }), 'unknown');
  assert.equal(deriveTeam({ firstName: 'April', lastName: 'Hill', EMail: 'hilla0616@gmail.com' }), 'unknown');
  assert.equal(deriveTeam({ firstName: 'Nobody', lastName: 'Here' }), 'unknown');
  assert.equal(deriveTeam({}), 'unknown');
});

test('isServiceAccount: the six non-agent logins are excluded, real agents are not', () => {
  for (const userName of [
    'ETG - Reece Windows',
    'LeadPerfectio@reecewindows.com',
    'LeadPerfectioASAP@reecewindows.com',
    'svc-reece-api',
    'reecewindowsvcc@outboundani.com',
    'reecewindowsapi@outboundani.com',
  ]) {
    assert.equal(isServiceAccount({ userName }), true, `${userName} must be skipped`);
  }
  for (const userName of ['cavril', 'rjakob', 'ssmith3', 'm.richard@reecewindows.com']) {
    assert.equal(isServiceAccount({ userName }), false, `${userName} must be seeded`);
  }
  assert.equal(isServiceAccount({}), false);
});
