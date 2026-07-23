/**
 * Unit tests for the LP↔GHL link-corroboration resolver —
 * src/services/link-corroboration.js
 *
 * Uses Node's built-in test runner (`node:test`). Run with:
 *   node --test scripts/test-link-corroboration.js
 *
 * No DB and no GHL: every I/O dependency (live contact read, HL cache read,
 * verdict cache, conflict recorder) is swapped via the _internal
 * __setDepsForTest seam, so resolution logic is exercised in memory.
 *
 * Reference case throughout: LP lead 560362 (Wanda Mitchell,
 * phone 7272421300 / alt 7275643912, LP email literally "NA") whose
 * lognumber pointed at GHL shell nGwfbenVOSuAFGc9K3Cd ("Guest Visitor 039",
 * no phone, no email).
 */

// Harmless Supabase dummies so module imports don't warn (all queries are
// stubbed through the deps seam).
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveLeadGhlLink,
  resetLinkVerifyBudget,
  verifyLognumberCandidate,
  LINK_SOURCE,
  _internal,
} from '../src/services/link-corroboration.js';
import { shapeValidLognumber, lognumberCandidate } from '../src/ghl-link-shape.js';

// ─── Fixtures ────────────────────────────────────────────────────

const SHELL_ID = 'nGwfbenVOSuAFGc9K3Cd'; // 20-char shape-valid
const OTHER_ID = 'Ybp9JREKWogGpnzRcQby';
const THIRD_ID = 'GQW0coFkDh8Tc0MxTxDI';

const wandaProspect = {
  firstname: 'Wanda', lastname: 'Mitchell',
  phone1: '7272421300',
  altphones: [{ phone: '7275643912' }],
  email: 'NA',
};

const leadWithLognumber = (lognumber) => ({ lognumber });

// Deps harness: each test installs stubs and restores after.
function withDeps(overrides, fn) {
  return async () => {
    resetLinkVerifyBudget();
    const calls = { live: [], cache: [], conflicts: [], verdictsSaved: [], verdictLookups: [] };
    const restore = _internal.__setDepsForTest({
      now: () => new Date('2026-07-23T12:00:00Z'),
      fetchContactLive: async (id) => {
        calls.live.push(id);
        return overrides.liveContacts?.[id] ?? null;
      },
      fetchContactCache: async (id) => {
        calls.cache.push(id);
        return overrides.cacheContacts?.[id];
      },
      getVerdict: async (lpLeadId, ghlContactId) => {
        calls.verdictLookups.push([lpLeadId, ghlContactId]);
        return overrides.storedVerdicts?.[`${lpLeadId}:${ghlContactId}`] ?? null;
      },
      saveVerdict: async (lpLeadId, ghlContactId, verdict, source, detail) => {
        calls.verdictsSaved.push({ lpLeadId, ghlContactId, verdict, source, detail });
      },
      recordConflict: async (conflict) => {
        calls.conflicts.push(conflict);
      },
    });
    const prevMode = process.env.LP_LINK_CORROBORATION_MODE;
    const prevCap = process.env.LP_LINK_VERIFY_MAX_READS_PER_CYCLE;
    if (overrides.mode) process.env.LP_LINK_CORROBORATION_MODE = overrides.mode;
    if (overrides.cap != null) process.env.LP_LINK_VERIFY_MAX_READS_PER_CYCLE = String(overrides.cap);
    try {
      await fn(calls);
    } finally {
      restore();
      if (prevMode === undefined) delete process.env.LP_LINK_CORROBORATION_MODE;
      else process.env.LP_LINK_CORROBORATION_MODE = prevMode;
      if (prevCap === undefined) delete process.env.LP_LINK_VERIFY_MAX_READS_PER_CYCLE;
      else process.env.LP_LINK_VERIFY_MAX_READS_PER_CYCLE = prevCap;
    }
  };
}

// ─── Shape primitives ────────────────────────────────────────────

test('shapeValidLognumber: 20-char alphanumeric only', () => {
  assert.equal(shapeValidLognumber(SHELL_ID), true);
  assert.equal(shapeValidLognumber('AbcDefGhij123456789'), false, '19 chars');
  assert.equal(shapeValidLognumber('AbcDefGhij1234567890X'), false, '21 chars');
  assert.equal(shapeValidLognumber('AbcDef-hij1234567890'), false, 'contains dash');
  assert.equal(shapeValidLognumber(null), false);
  assert.equal(shapeValidLognumber('  ' + SHELL_ID + '  '), true, 'trimmed before test');
});

test('lognumberCandidate reads lognumber case variants', () => {
  assert.equal(lognumberCandidate({ lognumber: SHELL_ID }), SHELL_ID);
  assert.equal(lognumberCandidate({ LogNumber: SHELL_ID }), SHELL_ID);
  assert.equal(lognumberCandidate({ lognumber: '12345' }), null);
  assert.equal(lognumberCandidate(null), null);
});

// ─── Identity comparison primitives ──────────────────────────────

test('phonesMatch compares last 10 digits across formats', () => {
  assert.equal(_internal.phonesMatch('7272421300', '+17272421300'), true);
  assert.equal(_internal.phonesMatch('(727) 242-1300', '17272421300'), true);
  assert.equal(_internal.phonesMatch('7272421300', '7275643912'), false);
  assert.equal(_internal.phonesMatch('1300', '1300'), false, 'short fragments never match');
  assert.equal(_internal.phonesMatch(null, '+17272421300'), false);
});

test('normalizeEmail nulls LP sentinels', () => {
  for (const sentinel of ['NA', 'N/A', 'na', 'n/a', '', '   ', 'none', 'None']) {
    assert.equal(_internal.normalizeEmail(sentinel), null, `sentinel: ${JSON.stringify(sentinel)}`);
  }
  assert.equal(_internal.normalizeEmail(' Wanda@Example.com '), 'wanda@example.com');
});

test('corroborateIdentity: NA-vs-NA email must not corroborate', () => {
  // Wanda's LP email is literally "NA"; a GHL contact whose email is also
  // "NA" has no real identity — this must be no_identity, never pass.
  const lp = _internal.extractLpIdentity(null, { ...wandaProspect, phone1: null, altphones: [] });
  assert.equal(lp.email, null, 'LP sentinel email normalized to null');
  const verdict = _internal.corroborateIdentity(lp, { phone: null, email: 'NA' });
  assert.equal(verdict, 'no_identity');
});

test('corroborateIdentity: never corroborates on name alone', () => {
  const lp = _internal.extractLpIdentity(null, wandaProspect);
  const verdict = _internal.corroborateIdentity(
    { ...lp },
    { firstName: 'Wanda', lastName: 'Mitchell', phone: null, email: null },
  );
  assert.equal(verdict, 'no_identity');
});

// ─── Precedence case 1: lognumber === verified match ─────────────

test('lognumber corroborated by verified match', withDeps({ mode: 'enforce' }, async (calls) => {
  const res = await resolveLeadGhlLink({
    lead: leadWithLognumber(SHELL_ID),
    prospect: wandaProspect,
    verifiedGhlId: SHELL_ID,
  }, { lpLeadId: '560362' });
  assert.equal(res.ghlContactId, SHELL_ID);
  assert.equal(res.linkSource, LINK_SOURCE.LOGNUMBER_CORROBORATED);
  assert.equal(res.conflict, null);
  assert.equal(calls.live.length + calls.cache.length, 0, 'no verification reads needed');
}));

// ─── Case 2: lognumber !== verified match → verified wins ────────

test('verified match beats disagreeing lognumber and records a conflict', withDeps({ mode: 'enforce' }, async (calls) => {
  const res = await resolveLeadGhlLink({
    lead: leadWithLognumber(SHELL_ID),
    prospect: wandaProspect,
    verifiedGhlId: OTHER_ID,
  }, { lpLeadId: '560362', lpProspectId: '173050' });
  assert.equal(res.ghlContactId, OTHER_ID);
  assert.equal(res.linkSource, LINK_SOURCE.PHONE_EMAIL_MATCH);
  assert.equal(calls.conflicts.length, 1);
  assert.equal(calls.conflicts[0].lognumber_ghl_id, SHELL_ID);
  assert.equal(calls.conflicts[0].verified_ghl_id, OTHER_ID);
  assert.equal(calls.conflicts[0].resolution, LINK_SOURCE.PHONE_EMAIL_MATCH);
  assert.equal(calls.conflicts[0].lp_phone, '7272421300');
}));

// ─── Case 4: the Wanda case — lognumber only, contact has no identity ──

test('enforce: lognumber-only candidate with no contact identity is rejected (Wanda case)', withDeps({
  mode: 'enforce',
  liveContacts: { [SHELL_ID]: { firstName: 'Guest Visitor', lastName: '039', phone: null, email: null } },
}, async (calls) => {
  const res = await resolveLeadGhlLink({
    lead: leadWithLognumber(SHELL_ID),
    prospect: wandaProspect,
    existingGhlId: null,
  }, { lpLeadId: '560362' });
  assert.equal(res.ghlContactId, null, 'refuses to bind — no existing link to preserve');
  assert.equal(res.linkSource, LINK_SOURCE.REJECTED_UNCORROBORATED);
  assert.equal(calls.live.length, 1);
  assert.equal(calls.verdictsSaved[0].verdict, 'no_identity');
}));

test('enforce: rejection preserves an existing link', withDeps({
  mode: 'enforce',
  liveContacts: { [SHELL_ID]: { phone: null, email: null } },
}, async () => {
  const res = await resolveLeadGhlLink({
    lead: leadWithLognumber(SHELL_ID),
    prospect: wandaProspect,
    existingGhlId: OTHER_ID,
    existingLinkSource: LINK_SOURCE.LEGACY_UNVERIFIED,
  }, { lpLeadId: '560362' });
  assert.equal(res.ghlContactId, OTHER_ID, 'existing link carried forward');
  assert.equal(res.linkSource, LINK_SOURCE.REJECTED_UNCORROBORATED);
}));

// ─── Case 4: phone_alt corroboration ─────────────────────────────

test('enforce: GHL phone matching LP phone_alt verifies the lognumber', withDeps({
  mode: 'enforce',
  liveContacts: { [SHELL_ID]: { phone: '+17275643912', email: null } },
}, async () => {
  const res = await resolveLeadGhlLink({
    lead: leadWithLognumber(SHELL_ID),
    prospect: wandaProspect,
  }, { lpLeadId: '560362' });
  assert.equal(res.ghlContactId, SHELL_ID);
  assert.equal(res.linkSource, LINK_SOURCE.LOGNUMBER_VERIFIED);
}));

// ─── Case 4: contradiction → rejected_conflict ───────────────────

test('enforce: contact identity contradicting LP is rejected with a conflict row', withDeps({
  mode: 'enforce',
  liveContacts: { [SHELL_ID]: { phone: '+19998887777', email: 'robert.fortier@example.com' } },
}, async (calls) => {
  const res = await resolveLeadGhlLink({
    lead: leadWithLognumber(SHELL_ID),
    prospect: wandaProspect,
    existingGhlId: null,
  }, { lpLeadId: '560362' });
  assert.equal(res.ghlContactId, null);
  assert.equal(res.linkSource, LINK_SOURCE.REJECTED_CONFLICT);
  assert.equal(calls.conflicts.length, 1);
  assert.equal(calls.conflicts[0].resolution, LINK_SOURCE.REJECTED_CONFLICT);
}));

// ─── Downgrade guard ─────────────────────────────────────────────

test('downgrade guard: rank-3 stored link is not displaced by a lognumber candidate', withDeps({
  mode: 'enforce',
  liveContacts: { [SHELL_ID]: { phone: '+17272421300', email: null } },
}, async (calls) => {
  const res = await resolveLeadGhlLink({
    lead: leadWithLognumber(SHELL_ID),
    prospect: wandaProspect,
    existingGhlId: OTHER_ID,
    existingLinkSource: LINK_SOURCE.PHONE_EMAIL_MATCH,
  }, { lpLeadId: '560362' });
  assert.equal(res.ghlContactId, OTHER_ID, 'kept the stronger existing link');
  assert.equal(res.linkSource, null, 'no classification overwrite');
  assert.equal(calls.live.length, 0, 'guard fires before any verification read');
}));

// ─── Shape-invalid lognumbers fall through ───────────────────────

test('shape-invalid lognumbers fall through to existing link', withDeps({ mode: 'enforce' }, async (calls) => {
  for (const bad of ['AbcDefGhij123456789', 'AbcDefGhij1234567890X', 'AbcDef-hij1234567890']) {
    const res = await resolveLeadGhlLink({
      lead: leadWithLognumber(bad),
      prospect: wandaProspect,
      existingGhlId: THIRD_ID,
      existingLinkSource: null,
    }, { lpLeadId: '560362' });
    assert.equal(res.ghlContactId, THIRD_ID, `candidate ${bad} must not bind`);
    assert.equal(res.linkSource, LINK_SOURCE.EXISTING_PRESERVED);
  }
  assert.equal(calls.live.length + calls.cache.length, 0);
}));

// ─── Observe mode ────────────────────────────────────────────────

test('observe: returns the legacy result while classifying via HL cache', withDeps({
  mode: 'observe',
  cacheContacts: { [SHELL_ID]: { phone: null, email: null, synced_at: '2026-07-20T00:00:00Z' } },
}, async (calls) => {
  const res = await resolveLeadGhlLink({
    lead: leadWithLognumber(SHELL_ID),
    prospect: wandaProspect,
    existingGhlId: null,
  }, { lpLeadId: '560362' });
  // Legacy deriveLeadGhlId behavior: the shape-valid lognumber binds.
  assert.equal(res.ghlContactId, SHELL_ID, 'observe returns the legacy derivation');
  // ...but the classification records what enforce would have done.
  assert.equal(res.linkSource, LINK_SOURCE.REJECTED_UNCORROBORATED);
  assert.equal(calls.live.length, 0, 'observe never reads GHL live');
  assert.equal(calls.cache.length, 1);
  assert.equal(calls.verdictsSaved[0].source, 'hl_cache');
  assert.equal(calls.verdictsSaved[0].detail.cache_synced_at, '2026-07-20T00:00:00Z', 'staleness measurement recorded');
}));

test('observe: missing cache row leaves the link unclassified', withDeps({
  mode: 'observe',
  cacheContacts: {},
}, async (calls) => {
  const res = await resolveLeadGhlLink({
    lead: leadWithLognumber(SHELL_ID),
    prospect: wandaProspect,
    existingGhlId: null,
  }, { lpLeadId: '560362' });
  assert.equal(res.ghlContactId, SHELL_ID, 'legacy result unchanged');
  assert.equal(res.linkSource, null, 'absence of cache data is not evidence');
  assert.equal(res.deferred, true);
  assert.equal(calls.verdictsSaved.length, 0);
}));

test('observe: verified-match path is identical to legacy when they agree', withDeps({ mode: 'observe' }, async () => {
  const res = await resolveLeadGhlLink({
    lead: {},
    prospect: wandaProspect,
    verifiedGhlId: OTHER_ID,
  }, { lpLeadId: '560362' });
  assert.equal(res.ghlContactId, OTHER_ID);
  assert.equal(res.linkSource, LINK_SOURCE.PHONE_EMAIL_MATCH);
}));

// ─── Fast path ───────────────────────────────────────────────────

test('fast path: classified unchanged link resolves with zero reads', withDeps({
  mode: 'enforce',
  liveContacts: { [SHELL_ID]: { phone: '+17272421300' } },
}, async (calls) => {
  const res = await resolveLeadGhlLink({
    lead: leadWithLognumber(SHELL_ID),
    prospect: wandaProspect,
    existingGhlId: SHELL_ID,
    existingLinkSource: LINK_SOURCE.LOGNUMBER_VERIFIED,
  }, { lpLeadId: '560362' });
  assert.equal(res.ghlContactId, SHELL_ID);
  assert.equal(res.linkSource, null, 'nothing to rewrite');
  assert.equal(calls.live.length + calls.cache.length + calls.verdictLookups.length, 0, 'zero queries on unchanged re-sync');
}));

test('cheap upgrade: fresh verified match confirming the stored link upgrades its source', withDeps({ mode: 'enforce' }, async (calls) => {
  const res = await resolveLeadGhlLink({
    lead: leadWithLognumber(SHELL_ID),
    prospect: wandaProspect,
    verifiedGhlId: SHELL_ID,
    existingGhlId: SHELL_ID,
    existingLinkSource: LINK_SOURCE.LOGNUMBER_VERIFIED,
  }, { lpLeadId: '560362' });
  assert.equal(res.ghlContactId, SHELL_ID);
  assert.equal(res.linkSource, LINK_SOURCE.LOGNUMBER_CORROBORATED);
  assert.equal(calls.live.length + calls.cache.length, 0);
}));

// ─── Enforce-mode verification cache + budget ────────────────────

test('enforce: fresh ghl_live verdict is trusted (no live read)', withDeps({
  mode: 'enforce',
  storedVerdicts: {
    '560362:nGwfbenVOSuAFGc9K3Cd': {
      verdict: 'pass', verify_source: 'ghl_live',
      verified_at: '2026-07-22T00:00:00Z', detail: {},
    },
  },
}, async (calls) => {
  const res = await resolveLeadGhlLink({
    lead: leadWithLognumber(SHELL_ID),
    prospect: wandaProspect,
  }, { lpLeadId: '560362' });
  assert.equal(res.linkSource, LINK_SOURCE.LOGNUMBER_VERIFIED);
  assert.equal(calls.live.length, 0, 'TTL cache hit');
}));

test('enforce: hl_cache verdict rows are NOT trusted — re-verifies live', withDeps({
  mode: 'enforce',
  storedVerdicts: {
    '560362:nGwfbenVOSuAFGc9K3Cd': {
      verdict: 'pass', verify_source: 'hl_cache',
      verified_at: '2026-07-22T00:00:00Z', detail: {},
    },
  },
  liveContacts: { [SHELL_ID]: { phone: null, email: null } },
}, async (calls) => {
  const res = await resolveLeadGhlLink({
    lead: leadWithLognumber(SHELL_ID),
    prospect: wandaProspect,
  }, { lpLeadId: '560362' });
  assert.equal(calls.live.length, 1, 'cache-sourced verdict forces a live read');
  assert.equal(res.linkSource, LINK_SOURCE.REJECTED_UNCORROBORATED, 'live result wins over stale cache verdict');
}));

test('enforce: live-read budget cap defers without touching the link', withDeps({
  mode: 'enforce',
  cap: 1,
  liveContacts: {
    [SHELL_ID]: { phone: '+17272421300' },
    [OTHER_ID]: { phone: '+17272421300' },
  },
}, async (calls) => {
  const first = await resolveLeadGhlLink({
    lead: leadWithLognumber(SHELL_ID),
    prospect: wandaProspect,
  }, { lpLeadId: '560362' });
  assert.equal(first.linkSource, LINK_SOURCE.LOGNUMBER_VERIFIED);

  const second = await resolveLeadGhlLink({
    lead: leadWithLognumber(OTHER_ID),
    prospect: wandaProspect,
    existingGhlId: THIRD_ID,
    existingLinkSource: LINK_SOURCE.LEGACY_UNVERIFIED,
  }, { lpLeadId: '99999' });
  assert.equal(second.deferred, true, 'over cap → deferred');
  assert.equal(second.ghlContactId, THIRD_ID, 'link left untouched');
  assert.equal(second.linkSource, null);
  assert.equal(calls.live.length, 1, 'only the first candidate consumed the budget');

  resetLinkVerifyBudget();
  const third = await resolveLeadGhlLink({
    lead: leadWithLognumber(OTHER_ID),
    prospect: wandaProspect,
    existingGhlId: THIRD_ID,
    existingLinkSource: LINK_SOURCE.LEGACY_UNVERIFIED,
  }, { lpLeadId: '99999' });
  assert.equal(third.linkSource, LINK_SOURCE.LOGNUMBER_VERIFIED, 'budget reset re-enables verification');
}));

// ─── Case 5 + legacy marker retention ────────────────────────────

test('no candidates: unclassified existing link becomes existing_preserved; legacy marker is kept', withDeps({ mode: 'enforce' }, async () => {
  const unclassified = await resolveLeadGhlLink({
    lead: {},
    prospect: wandaProspect,
    existingGhlId: THIRD_ID,
    existingLinkSource: null,
  }, { lpLeadId: '1' });
  assert.equal(unclassified.linkSource, LINK_SOURCE.EXISTING_PRESERVED);

  const legacy = await resolveLeadGhlLink({
    lead: {},
    prospect: wandaProspect,
    existingGhlId: THIRD_ID,
    existingLinkSource: LINK_SOURCE.LEGACY_UNVERIFIED,
  }, { lpLeadId: '2' });
  assert.equal(legacy.ghlContactId, THIRD_ID);
  assert.equal(legacy.linkSource, null, 'legacy_unverified marker survives (untriaged ≠ preserved)');
}));

// ─── verifyLognumberCandidate (admin surface) ────────────────────

test('verifyLognumberCandidate: empty LP identity is unknown, never a rejection', withDeps({
  liveContacts: { [SHELL_ID]: { phone: '+17272421300' } },
}, async (calls) => {
  const res = await verifyLognumberCandidate({
    lpIdentity: { phone: null, phoneAlt: null, email: null },
    candidateId: SHELL_ID,
    allowLive: true,
  });
  assert.equal(res.verdict, 'unknown');
  assert.equal(calls.live.length, 0, 'no read wasted on an unevaluable row');
}));

test('verifyLognumberCandidate: live contact gone → no_identity', withDeps({
  liveContacts: {},
}, async () => {
  const res = await verifyLognumberCandidate({
    lpIdentity: { phone: '7272421300', phoneAlt: null, email: null },
    candidateId: SHELL_ID,
    allowLive: true,
    lpLeadId: '560362',
  });
  assert.equal(res.verdict, 'no_identity');
  assert.equal(res.source, 'ghl_live');
}));
