/**
 * scripts/test-backfill-opportunity-values.js
 *
 * Unit coverage for the repair decisions in
 * scripts/backfill-opportunity-values.js — the guards that decide whether a
 * live CRM record gets written, and what it gets written to.
 *
 * The failure these guard against is a repair pass that makes the data worse:
 * one job's value landing on several open opportunities for the same contact,
 * a closed opportunity being revalued, a source that was already set being
 * overwritten, or a name a human chose being replaced.
 *
 * The 2026-08-31 P2 dry run is the case that motivated the duplicate guard: 21
 * contacts held 54 open opportunities where 21 should exist, and writing each
 * contact's job value to all of them would have inflated pipeline by $651,556.
 *
 * Pure-function test — no DB, no network.
 * Run: node --test scripts/test-backfill-opportunity-values.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  valueWriteDecision, repairedName, repairedSource, titleCasePart,
} from './backfill-opportunity-values.js';

// ─── the duplicate guard ────────────────────────────────────────────────

test('one open opportunity for the contact is written', () => {
  assert.equal(valueWriteDecision({ value: 12000, currentValue: null, openOppsForContact: 1 }), 'write');
});

test('a contact holding TWO open opportunities is skipped, not written twice', () => {
  // The whole point. Writing 12000 to both would add 24000 of pipeline for
  // 12000 of work — the sum-of-jobs error, arriving from the other direction.
  assert.equal(valueWriteDecision({ value: 12000, currentValue: null, openOppsForContact: 2 }), 'skip_duplicate');
  assert.equal(valueWriteDecision({ value: 12000, currentValue: null, openOppsForContact: 5 }), 'skip_duplicate');
});

test('a missing or unparseable open-opp count is treated as one, not as zero', () => {
  // count(*) coming back as a string, or absent on an older mirror row, must
  // not silently disable the guard OR block every write.
  assert.equal(valueWriteDecision({ value: 12000, currentValue: null, openOppsForContact: '1' }), 'write');
  assert.equal(valueWriteDecision({ value: 12000, currentValue: null, openOppsForContact: '3' }), 'skip_duplicate');
  assert.equal(valueWriteDecision({ value: 12000, currentValue: null, openOppsForContact: undefined }), 'write');
});

test('no usable job is reported ahead of duplicate', () => {
  // A contact with neither has the more basic problem; calling it a duplicate
  // would imply we would have written had it only been deduped.
  assert.equal(valueWriteDecision({ value: null, currentValue: null, openOppsForContact: 4 }), 'skip_no_job');
  assert.equal(valueWriteDecision({ value: undefined, currentValue: null, openOppsForContact: 1 }), 'skip_no_job');
});

// ─── value eligibility ──────────────────────────────────────────────────

test('an opportunity that already has a value is left alone by default', () => {
  assert.equal(valueWriteDecision({ value: 12000, currentValue: 9000, openOppsForContact: 1 }), 'skip_ineligible');
});

test('--include-valued revalues it, but still obeys the duplicate guard', () => {
  assert.equal(valueWriteDecision({ value: 12000, currentValue: 9000, openOppsForContact: 1, includeValued: true }), 'write');
  assert.equal(valueWriteDecision({ value: 12000, currentValue: 9000, openOppsForContact: 2, includeValued: true }), 'skip_duplicate');
});

test('zero counts as empty, so a zeroed opportunity is repaired', () => {
  assert.equal(valueWriteDecision({ value: 12000, currentValue: 0, openOppsForContact: 1 }), 'write');
});

test('re-running writes nothing — the value is already what we would set', () => {
  assert.equal(valueWriteDecision({ value: 12000, currentValue: 12000, openOppsForContact: 1, includeValued: true }), 'skip_unchanged');
  assert.equal(valueWriteDecision({ value: 0, currentValue: 0, openOppsForContact: 1 }), 'skip_unchanged');
});

// ─── source repair ──────────────────────────────────────────────────────

test('an empty source is filled from the contact', () => {
  assert.equal(repairedSource({ source: null, contact_source: 'Canvass' }), 'Canvass');
  assert.equal(repairedSource({ source: '   ', contact_source: 'Canvass' }), 'Canvass');
});

test('a source that is already set is NEVER overwritten', () => {
  assert.equal(repairedSource({ source: 'Internet', contact_source: 'Canvass' }), null);
});

test('nothing to copy means nothing to write', () => {
  assert.equal(repairedSource({ source: null, contact_source: null }), null);
  assert.equal(repairedSource({ source: null, contact_source: '  ' }), null);
});

// ─── name repair ────────────────────────────────────────────────────────

const nameRow = (name, first, last) => ({ name, first_name: first, last_name: last });

test('the degraded first-name-only name is repaired to the full name', () => {
  assert.equal(repairedName(nameRow('Kelly', 'kelly', 'stahley')), 'Kelly Stahley');
  assert.equal(repairedName(nameRow('Charles', 'Charles', 'Brady')), 'Charles Brady');
});

test('a full name a human would recognise is left alone', () => {
  // The 35 empties that carry a real name must not be touched.
  assert.equal(repairedName(nameRow('Wendel & Kathleen Kauffman', 'Wendel', 'Kauffman')), null);
});

test('a deliberately renamed opportunity is left alone', () => {
  assert.equal(repairedName(nameRow('Kitchen windows — phase 2', 'Kelly', 'Stahley')), null);
});

test('a contact with no last name is left alone — there is nothing to add', () => {
  assert.equal(repairedName(nameRow('Kelly', 'Kelly', '')), null);
  assert.equal(repairedName(nameRow('Kelly', 'Kelly', null)), null);
});

test('an already-correct name is not rewritten', () => {
  assert.equal(repairedName(nameRow('Kelly Stahley', 'Kelly', 'Stahley')), null);
});

test('matching is case-insensitive because GHL title-cases what LP stores lower', () => {
  assert.equal(repairedName(nameRow('Kelly', 'kelly', 'stahley')), 'Kelly Stahley');
});

test('a spacing-only difference is normalised', () => {
  assert.equal(repairedName(nameRow('Alex  Ivelic', 'alex', 'ivelic')), 'Alex Ivelic');
  assert.equal(repairedName(nameRow('Mary\tJane Okonkwo', 'mary jane', 'okonkwo')), 'Mary Jane Okonkwo');
});

test('an all-caps name that matches the contact is normalised', () => {
  assert.equal(repairedName(nameRow('JOHN SMITH', 'john', 'smith')), 'John Smith');
});

test('an opportunity naming TWO people is never collapsed to one', () => {
  // 535 records. The opportunity carries the household; the contact carries
  // one person. Rewriting these would delete the co-signer.
  assert.equal(repairedName(nameRow('Brenda & Michael Patton', 'brenda', 'patton')), null);
  assert.equal(repairedName(nameRow('Cheryl/Mark Miller', 'cheryl', 'miller')), null);
  assert.equal(repairedName(nameRow('Paula & Kimano Griffith', 'paula', 'griffith')), null);
});

test('a spelling conflict is left for a human, not guessed at', () => {
  assert.equal(repairedName(nameRow('MARY PERRY', 'merry', 'perry')), null);
  assert.equal(repairedName(nameRow('Richard Dittman', 'richard', 'dittmon')), null);
});

test('a mixed-case name is never re-cased — the opportunity is the better record', () => {
  // LP stores "mcleod" flat; the opportunity carries "McLeod". Rewriting
  // flattens it. titleCasePart cannot catch this: it inspects the contact's
  // part, which is lowercase, not the name being replaced. 32 such records.
  assert.equal(repairedName(nameRow('Lawrence McLeod', 'lawrence', 'mcleod')), null);
  assert.equal(repairedName(nameRow('Cassandra DiChristopher', 'cassandra', 'dichristopher')), null);
  assert.equal(repairedName(nameRow('Nevanita LaVita', 'nevanita', 'lavita')), null);
});

test('spacing is still repaired on a mixed-case name — only CASE is off limits', () => {
  assert.equal(repairedName(nameRow('Lawrence  McLeod', 'lawrence', 'McLeod')), 'Lawrence McLeod');
});

test('slash- and comma-joined couples capitalise both people', () => {
  // "kent/earlene" as one token yields "Kent/earlene" — the second person
  // lowercased. 27 planned rewrites came out damaged this way.
  assert.equal(titleCasePart('kent/earlene'), 'Kent/Earlene');
  assert.equal(titleCasePart('brian,stephanie'), 'Brian,Stephanie');
  assert.equal(repairedName(nameRow('KENT/EARLENE BIGGERSTAFF', 'kent/earlene', 'biggerstaff')),
               'Kent/Earlene Biggerstaff');
});

test('a mixed-case couple already spelled correctly is left alone', () => {
  assert.equal(repairedName(nameRow('Renata/Zbigniew Kang/Folga', 'renata/zbigniew', 'kang/folga')), null);
});

test('leading and trailing whitespace does not defeat the match', () => {
  assert.equal(repairedName(nameRow(' Mary ', 'mary', 'okonkwo')), 'Mary Okonkwo');
});

// ─── title casing ───────────────────────────────────────────────────────

test('lowercase LP names are title-cased', () => {
  assert.equal(titleCasePart('kelly'), 'Kelly');
  assert.equal(titleCasePart("o'brien"), "O'Brien");
  assert.equal(titleCasePart('mary-jane'), 'Mary-Jane');
  assert.equal(titleCasePart('van dyke'), 'Van Dyke');
});

test('a name that already carries capitals is never re-cased', () => {
  // The guard against turning McDonald into Mcdonald.
  assert.equal(titleCasePart('McDonald'), 'McDonald');
  assert.equal(titleCasePart('DeLaCruz'), 'DeLaCruz');
  assert.equal(titleCasePart('DELACRUZ'), 'DELACRUZ');
});
