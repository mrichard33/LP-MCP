// scripts/test-rejected-link-source.js
//
// buildLeadRow must never leave a row reading "refused to bind" next to a
// populated ghl_contact_id.
//
// 2026-09-19. Measured on live data: 19 lp_leads rows carried a
// ghl_contact_id under ghl_link_source rejected_conflict /
// rejected_uncorroborated. Two distinct shapes produced them, and the
// 2026-07-29 guard caught neither:
//
//   16 rows — ghl_contact_id identical to LP's lognumber. The stored id WAS
//             the rejected candidate, so `leadGhlId !== existingGhlId` was
//             false and the guard never ran.
//    3 rows — ghl_contact_id from a good phone match, different from the
//             rejected lognumber. The guard correctly kept the stored id and
//             then stamped the rejection over its classification anyway.
//
// The rule these tests pin: a rejected verdict describes the CANDIDATE. When a
// stored link survives the pass, its classification survives with it. The
// rejection only becomes the row's source when there is no stored link, where
// it sits beside a NULL id and reads as an honest audit trail.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { _internal } = await import('../src/sync-leads.js');
const { buildLeadRow } = _internal;
const { LINK_SOURCE } = await import('../src/services/link-corroboration.js');

const PROSPECT = { firstname: 'Ada', lastname: 'Lovelace', phone1: '3865551234' };
const LEAD = { ldsid: '1', cstid: '9' };

const build = ({ existingGhlId = null, resolvedLink = null }) => buildLeadRow(
  PROSPECT, LEAD,
  { lpLeadId: '1', lpProspectId: '9', bucket: null, tag: null, existingGhlId, resolvedLink },
).row;

const STORED = 'StoredContactId01234';
const CANDIDATE = 'RejectedCandidate01';

for (const source of [LINK_SOURCE.REJECTED_CONFLICT, LINK_SOURCE.REJECTED_UNCORROBORATED]) {
  test(`${source}: a rejected candidate never displaces a stored link`, () => {
    const row = build({
      existingGhlId: STORED,
      resolvedLink: { ghlContactId: CANDIDATE, linkSource: source },
    });
    assert.equal(row.ghl_contact_id, STORED, 'stored link must survive');
    assert.equal(row.ghl_link_source, undefined,
      'the stored classification must be preserved, not overwritten by the candidate verdict');
  });

  test(`${source}: the stored id being the rejected candidate is not stamped`, () => {
    // The 16-row shape: observe mode returns the raw lognumber, which is
    // already what the row holds, so the inequality guard never fires.
    const row = build({
      existingGhlId: STORED,
      resolvedLink: { ghlContactId: STORED, linkSource: source },
    });
    assert.equal(row.ghl_contact_id, STORED);
    assert.equal(row.ghl_link_source, undefined,
      'a surviving link keeps its classification even when it is the rejected candidate');
  });

  test(`${source}: with no stored link the rejection is the source, beside a null id`, () => {
    const row = build({
      existingGhlId: null,
      resolvedLink: { ghlContactId: CANDIDATE, linkSource: source },
    });
    assert.equal(row.ghl_contact_id, null, 'a rejected candidate is never adopted');
    assert.equal(row.ghl_link_source, source, 'the rejection stands as the audit trail');
  });
}

test('an accepted verdict still classifies the row', () => {
  const row = build({
    existingGhlId: null,
    resolvedLink: { ghlContactId: CANDIDATE, linkSource: LINK_SOURCE.LOGNUMBER_VERIFIED },
  });
  assert.equal(row.ghl_contact_id, CANDIDATE);
  assert.equal(row.ghl_link_source, LINK_SOURCE.LOGNUMBER_VERIFIED);
});

test('a new row carrying a link gets the legacy_unverified floor, never NULL', () => {
  const row = build({ existingGhlId: null, resolvedLink: { ghlContactId: CANDIDATE, linkSource: null } });
  assert.equal(row.ghl_contact_id, CANDIDATE);
  assert.equal(row.ghl_link_source, LINK_SOURCE.LEGACY_UNVERIFIED);
});

test('an existing row with an unclassified pass keeps its stored classification', () => {
  const row = build({ existingGhlId: STORED, resolvedLink: { ghlContactId: STORED, linkSource: null } });
  assert.equal(row.ghl_contact_id, STORED);
  assert.equal(row.ghl_link_source, undefined);
});
