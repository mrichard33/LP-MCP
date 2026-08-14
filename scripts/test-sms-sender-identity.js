/**
 * test-sms-sender-identity.js — which line a reply goes out from decides the
 * sign-off (2026-08-14, owner requirement).
 *
 *   (954) 280-8890 — Mark's direct line       → "— Mark"
 *   (954) 371-0083 — the shared Reece team line → "— Reece Team", and when a
 *     customer asks for a name: give Mark AND say it is a shared team number.
 *
 * The properties under test:
 *   - the number match is format-agnostic (+1, dashes, parens all normalize);
 *   - an UNKNOWN or missing number resolves to the TEAM identity, never to a
 *     named person — fromNumber comes from a live GHL conversation scan that
 *     can fail, and a wrong "— Mark" is worse than a generic "— Reece Team";
 *   - the shared-line caveat is bound to the name, so a reply can never give
 *     the name without it;
 *   - body voice is untouched — this is a signature split only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const {
  resolveSmsSenderIdentity,
  last10Digits,
  buildResponsePrompt,
} = await import('../src/response-generator.js');

const MARK_LINE = '+19542808890';
const TEAM_LINE = '+19543710083';

function withEnv(vars, fn) {
  const prior = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── number normalization ────────────────────────────────────────────

test('last10Digits normalizes every phone format we see', () => {
  assert.equal(last10Digits('+19542808890'), '9542808890');
  assert.equal(last10Digits('9542808890'), '9542808890');
  assert.equal(last10Digits('(954) 280-8890'), '9542808890');
  assert.equal(last10Digits('+1 954 280 8890'), '9542808890');
  assert.equal(last10Digits('954-280-8890'), '9542808890');
});

test('last10Digits rejects anything too short to be a number', () => {
  assert.equal(last10Digits(''), null);
  assert.equal(last10Digits(null), null);
  assert.equal(last10Digits(undefined), null);
  assert.equal(last10Digits('8890'), null);
  assert.equal(last10Digits('not a phone'), null);
});

// ── identity resolution ─────────────────────────────────────────────

test("Mark's line resolves to the Mark identity", () => {
  const id = resolveSmsSenderIdentity(MARK_LINE);
  assert.equal(id.persona, 'mark');
  assert.equal(id.signature, 'Mark');
  assert.equal(id.shared, false);
  assert.equal(id.matched, true);
});

test("Mark's line matches in any format", () => {
  for (const fmt of ['9542808890', '(954) 280-8890', '+1 954-280-8890']) {
    assert.equal(resolveSmsSenderIdentity(fmt).persona, 'mark', `failed for ${fmt}`);
  }
});

test('the team line resolves to the shared Reece Team identity', () => {
  const id = resolveSmsSenderIdentity(TEAM_LINE);
  assert.equal(id.persona, 'team');
  assert.equal(id.signature, 'Reece Team');
  assert.equal(id.shared, true);
  assert.equal(id.nameIfAsked, 'Mark', 'a name is still available when asked');
  assert.equal(id.matched, true);
});

// ── the fallback never claims a person ──────────────────────────────

test('an UNKNOWN number falls back to the team identity, not to Mark', () => {
  const id = resolveSmsSenderIdentity('+19995551234');
  assert.equal(id.persona, 'team');
  assert.equal(id.signature, 'Reece Team');
  assert.equal(id.shared, true);
  assert.equal(id.matched, false, 'matched=false marks this as a fallback, not a real team-line hit');
});

test('a missing number falls back to the team identity', () => {
  for (const v of [null, undefined, '', '   ']) {
    const id = resolveSmsSenderIdentity(v);
    assert.equal(id.persona, 'team', `failed for ${JSON.stringify(v)}`);
    assert.equal(id.matched, false);
  }
});

// ── config ──────────────────────────────────────────────────────────

test('the numbers are env-tunable without a redeploy', () => {
  withEnv({ AGENTIC_SMS_NUMBER_MARK: '9998887777' }, () => {
    assert.equal(resolveSmsSenderIdentity('+19998887777').persona, 'mark');
    // the old default no longer maps to Mark
    assert.equal(resolveSmsSenderIdentity(MARK_LINE).persona, 'team');
  });
});

test('the Randy guard applies to the SMS signature too', () => {
  withEnv({ AGENTIC_REPLY_SENDER_NAME: 'Randy' }, () => {
    const id = resolveSmsSenderIdentity(MARK_LINE);
    assert.equal(id.signature, 'Mark', 'Randy must never reach a customer-facing signature');
    assert.equal(resolveSmsSenderIdentity(TEAM_LINE).nameIfAsked, 'Mark');
  });
});

test('a configured in-office rep other than Mark flows through', () => {
  withEnv({ AGENTIC_REPLY_SENDER_NAME: 'Dana' }, () => {
    assert.equal(resolveSmsSenderIdentity(MARK_LINE).signature, 'Dana');
    assert.equal(resolveSmsSenderIdentity(TEAM_LINE).signature, 'Reece Team', 'the team signature is not a person');
    assert.equal(resolveSmsSenderIdentity(TEAM_LINE).nameIfAsked, 'Dana');
  });
});

// ── the prompt block ────────────────────────────────────────────────

const CONTEXT = {
  lead: { ghl_contact_id: 'c-test', name: 'Maria', first_name: 'Maria', current_tags: [] },
  lp: { matched: false, notes: [] },
  intelligence: { buyer_stage: 2 },
  conversation_recent: [],
};

function prompt(channel, opts = {}) {
  return buildResponsePrompt(
    CONTEXT, channel, 'Do you carry French doors?', null,
    { intent_class: 'UNCLEAR', confidence: 0.5, classification_method: 'test' },
    false, 'warm', null,
    { threadSenderType: 'rep', ...opts },
  );
}

test("Mark's line: prompt instructs the Mark sign-off and no shared-line language", () => {
  const p = prompt('sms', { fromNumber: MARK_LINE });
  assert.ok(/sign-off "— Mark"/.test(p), 'Mark sign-off not instructed');
  assert.ok(/Do not describe this as a shared or team number/.test(p), 'missing the not-shared guard');
  assert.ok(!/shared team number so more than one person/.test(p), 'shared-line disclosure leaked onto the direct line');
});

test('team line: prompt instructs the team sign-off AND binds the name to the caveat', () => {
  const p = prompt('sms', { fromNumber: TEAM_LINE });
  assert.ok(/sign-off "— Reece Team"/.test(p), 'team sign-off not instructed');
  assert.ok(/give the name Mark, AND tell them plainly that this is a shared team number/.test(p),
    'the name is not bound to the shared-line caveat');
  assert.ok(/Both halves, every time/.test(p), 'nothing stops a name being given without the caveat');
});

test('team line: the caveat is answer-only, never volunteered', () => {
  const p = prompt('sms', { fromNumber: TEAM_LINE });
  assert.ok(/Do NOT volunteer the shared-line explanation when they have not asked/.test(p));
});

test('an unknown number gets the team block and says the number was unconfirmed', () => {
  const p = prompt('sms', { fromNumber: '+19995551234' });
  assert.ok(/sign-off "— Reece Team"/.test(p));
  assert.ok(/could not be confirmed/.test(p), 'fallback is not distinguished from a real team-line hit');
});

test('a missing number still produces the team block (no crash, no named signature)', () => {
  const p = prompt('sms', {});
  assert.ok(/sign-off "— Reece Team"/.test(p));
  assert.ok(!/sign-off "— Mark"/.test(p));
});

test('the sign-off survives the brevity instructions', () => {
  const p = prompt('sms', { fromNumber: MARK_LINE });
  assert.ok(/IDENTITY, not a flourish/.test(p),
    'without this the ack-only "no sign-off flourish" rule contradicts the signature');
});

test('body voice is explicitly left alone', () => {
  const p = prompt('sms', { fromNumber: MARK_LINE });
  assert.ok(/BODY voice does not change/.test(p));
  assert.ok(/we \/ our team/.test(p));
});

test('EMAIL gets no line-identity block (this is an SMS-only split)', () => {
  const p = prompt('email', { fromNumber: MARK_LINE });
  assert.ok(!/WHICH LINE THIS REPLY GOES OUT FROM/.test(p));
});
