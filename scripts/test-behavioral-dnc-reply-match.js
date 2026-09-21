/**
 * test-behavioral-dnc-reply-match.js — BEHAVIORAL_DNC_REPLY must fire on a
 * contact-initiated STOP, whatever the lead is worth. (2026-09-21)
 *
 * Background: rule 57 flags a STOP in LP (and now Five9), but it fired on only
 * ~16% of opt-out replies between 2026-05-15 and 2026-09-21 — roughly 199
 * people asked us to stop and the dialer kept calling. The cause was never the
 * regex: payload_message_matches compiles with the 'i' flag, so case was never
 * load-bearing, and the 2026-09-21 rewrite of the pattern into [Ss][Tt][Oo][Pp]
 * character classes was a no-op.
 *
 * The cause was passesStageGate(). Any rule key starting with BEHAVIORAL_ /
 * OBJECTION_ / INTENT_ is held to a SALES-QUALIFICATION test — the contact must
 * carry a QUALIFYING_TAG (appointment or late buyer-journey) or sit at
 * buyer_stage >= 3. A compliance rule inherited a sales gate by name, and a
 * person texting STOP is almost never a qualified lead, so the gate blocked the
 * rule precisely when it mattered. It even blocked booked contacts, because
 * they carry window-estimate-booked while QUALIFYING_TAGS lists
 * appt:window-estimate (canaries dDEvTYYv56kW031zv0ml, qM5QYwn5ISZ8DQOgFJpX).
 *
 * The properties under test:
 *   - the live rule-57 regex fires on the real opt-out wordings and stays off
 *     the ambiguous ones (Cancel / Change appt / stopped by the store);
 *   - TRUST_BREAK_AMBIGUOUS_KEYWORD still owns "leave me alone";
 *   - the stage gate no longer blocks a suppression rule on an unqualified
 *     contact — the regression that made all of the above moot;
 *   - and it still blocks a BEHAVIORAL_* SALES rule on that same contact, so
 *     the carve-out did not quietly retire the gate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
process.env.GHL_API_KEY = process.env.GHL_API_KEY || 'test-ghl-key';

const { _internal } = await import('../src/decision-engine.js');
const {
  evaluateContextConditions,
  matchesPattern,
  passesStageGate,
  isStageGateExempt,
  STAGE_GATE_EXEMPT_RULE_KEYS,
  QUALIFYING_TAGS,
} = _internal;

// ── fixtures: the LIVE rows, copied verbatim from agent_rules 2026-09-21 ──

const RULE_57 = {
  rule_key: 'BEHAVIORAL_DNC_REPLY',
  event_pattern: { event_type: 'ghl.reply_received', event_subtype: 'dnc' },
  conditions: null,
  context_conditions: {
    payload_message_matches: "\\b([Ss][Tt][Oo][Pp]|[Ss][Tt][Oo][Pp][Aa][Ll][Ll]|[Uu][Nn][Ss][Uu][Bb][Ss][Cc][Rr][Ii][Bb][Ee]|[Rr][Ee][Mm][Oo][Vv][Ee]\\s+[Mm][Ee]|[Tt][Aa][Kk][Ee]\\s+[Mm][Ee]\\s+[Oo][Ff][Ff]|[Dd][Oo]\\s+[Nn][Oo][Tt]\\s+([Cc][Oo][Nn][Tt][Aa][Cc][Tt]|[Tt][Ee][Xx][Tt]|[Cc][Aa][Ll][Ll]|[Ee][Mm][Aa][Ii][Ll])|[Dd][Oo][Nn]'?[Tt]\\s+([Cc][Oo][Nn][Tt][Aa][Cc][Tt]|[Tt][Ee][Xx][Tt]|[Cc][Aa][Ll][Ll]|[Ee][Mm][Aa][Ii][Ll])\\s+[Mm][Ee]|[Qq][Uu][Ii][Tt]\\s+([Tt][Ee][Xx][Tt][Ii][Nn][Gg]|[Cc][Aa][Ll][Ll][Ii][Nn][Gg]|[Ee][Mm][Aa][Ii][Ll][Ii][Nn][Gg]|[Mm][Ee][Ss][Ss][Aa][Gg][Ii][Nn][Gg])|[Oo][Pp][Tt][\\s\\-]*[Oo][Uu][Tt]|[Nn][Oo]\\s+([Mm][Oo][Rr][Ee]|[Ff][Uu][Rr][Tt][Hh][Ee][Rr])\\s+([Cc][Oo][Nn][Tt][Aa][Cc][Tt]|[Tt][Ee][Xx][Tt][Ss]?|[Cc][Aa][Ll][Ll][Ss]?|[Mm][Ee][Ss][Ss][Aa][Gg][Ee][Ss]?|[Ee][Mm][Aa][Ii][Ll][Ss]?)|[Pp][Ll][Ee][Aa][Ss][Ee]\\s+[Ss][Tt][Oo][Pp])\\b",
  },
};

const RULE_TRUST_BREAK = {
  rule_key: 'TRUST_BREAK_AMBIGUOUS_KEYWORD',
  event_pattern: { event_type: 'ghl.reply_received', event_subtype: 'dnc' },
  conditions: null,
  context_conditions: {
    payload_message_matches: '^\\s*(end|quit|stop\\s+bothering|leave\\s+me\\s+alone|quit\\s+(texting|messaging|calling|emailing))\\b',
  },
};

// A real dnc reply, shaped exactly as behavioral-emitter.js writes it.
const replyEvent = (messageText) => ({
  id: 3836790,
  event_type: 'ghl.reply_received',
  event_subtype: 'dnc',
  ghl_contact_id: 'qM5QYwn5ISZ8DQOgFJpX',
  payload: {
    message_text: messageText,
    message_type: 'SMS',
    channel: 'sms',
    message_id: 'syn-test',
    engagement_quality: 'dnc',
    word_count: String(messageText).split(/\s+/).length,
  },
});

// evaluateContextConditions needs a supabase/fetch bundle even when no
// condition here is I/O-backed; an unexpected read would throw rather than
// silently pass.
const noIo = {
  deps: {
    fetch: async () => { throw new Error('unexpected network read'); },
    supabase: { from() { throw new Error('unexpected db read'); } },
    sleep: async () => {},
  },
};

const conds = (rule) => ({ ...(rule.conditions || {}), ...(rule.context_conditions || {}) });

async function ruleMatches(rule, messageText) {
  const event = replyEvent(messageText);
  if (!matchesPattern(event, rule.event_pattern)) return false;
  return evaluateContextConditions(conds(rule), {}, event, { ...noIo, ruleKey: rule.rule_key });
}

// ── 1. the wordings that MUST reach LP and Five9 ──────────────────────

const MUST_FIRE = [
  'STOP WITH THE SOLICITATION',                                                    // qM5QYwn5ISZ8DQOgFJpX, 9/20
  "If your company doesn't STOP calling me, my next call is to the BBB!!!",         // qM5QYwn5ISZ8DQOgFJpX, 9/21
  'Stop',                                                                           // the commonest reply by far
  'No more texts or calls please',                                                  // xMqwsnhZ98Ek2ZijUiyM, 9/16
];

for (const msg of MUST_FIRE) {
  test(`rule 57 fires on ${JSON.stringify(msg.slice(0, 40))}`, async () => {
    assert.equal(await ruleMatches(RULE_57, msg), true);
  });
}

// ── 2. the wordings that MUST NOT ────────────────────────────────────
// "Cancel" is the James Davis incident (0zhRcjAxKxDbz96EFgXx): he typed it to
// cancel an appointment and the system marked him permanent DNC. GHL's native
// STOP-keyword detection still stamps event_subtype=dnc on these, so the regex
// is the only thing separating them.

const MUST_NOT_FIRE = ['Cancel', 'Change appt', 'stopped by the store', 'Yes I want to book'];

for (const msg of MUST_NOT_FIRE) {
  test(`rule 57 stays off ${JSON.stringify(msg)}`, async () => {
    assert.equal(await ruleMatches(RULE_57, msg), false);
  });
}

// ── 3. the ambiguous-keyword rule still owns its lane ────────────────

test('TRUST_BREAK_AMBIGUOUS_KEYWORD fires on "leave me alone"', async () => {
  assert.equal(await ruleMatches(RULE_TRUST_BREAK, 'leave me alone'), true);
});

test('rule 57 does not also claim "leave me alone"', async () => {
  assert.equal(await ruleMatches(RULE_57, 'leave me alone'), false);
});

// ── 4. the regression: the stage gate must not block a suppression rule ──

// A GHL contact with a phone, no qualifying tag, and no buyer stage — i.e.
// every one of the ~199 people the gate swallowed. window-estimate-booked is
// deliberately present: two of the canaries were BOOKED and still blocked,
// because QUALIFYING_TAGS lists appt:window-estimate, not this.
const UNQUALIFIED_CONTACT = {
  contact: {
    id: 'qM5QYwn5ISZ8DQOgFJpX',
    phone: '+19545551234',
    email: 'lead@example.com',
    tags: ['entry:other', 'source:internet', 'window-estimate-booked', 'time-lapse:warm'],
  },
};

function stubGhl(body) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  });
  return () => { globalThis.fetch = original; };
}

test('stage gate passes BEHAVIORAL_DNC_REPLY for an unqualified contact', async () => {
  const restore = stubGhl(UNQUALIFIED_CONTACT);
  try {
    const passed = await passesStageGate(replyEvent('STOP'), RULE_57, {});
    assert.equal(passed, true, 'a STOP must reach LP/Five9 regardless of lead quality');
  } finally { restore(); }
});

test('stage gate still BLOCKS a BEHAVIORAL_* sales rule for that same contact', async () => {
  const restore = stubGhl(UNQUALIFIED_CONTACT);
  try {
    const salesRule = { rule_key: 'BEHAVIORAL_PRICE_OBJECTION' };
    const passed = await passesStageGate(replyEvent('too expensive'), salesRule, {});
    assert.equal(passed, false, 'the carve-out must not retire the gate for sales rules');
  } finally { restore(); }
});

test('a qualified contact still passes the gate for a sales rule', async () => {
  const restore = stubGhl({ contact: { phone: '+19545551234', tags: ['bj:stage-3-comparing'] } });
  try {
    const salesRule = { rule_key: 'BEHAVIORAL_PRICE_OBJECTION' };
    assert.equal(await passesStageGate(replyEvent('too expensive'), salesRule, {}), true);
  } finally { restore(); }
});

// ── 5. the carve-out list itself ─────────────────────────────────────

test('the exemption is a named list of suppression rules, not a prefix', () => {
  assert.equal(isStageGateExempt('BEHAVIORAL_DNC_REPLY'), true);
  assert.equal(isStageGateExempt('INTENT_DNC_HARD_REQUEST'), true);
  assert.equal(isStageGateExempt('INTENT_SPIKE_GUARD_DNC'), true);
  // a new BEHAVIORAL_* rule must NOT inherit the exemption by prefix
  assert.equal(isStageGateExempt('BEHAVIORAL_DNC_SOMETHING_NEW'), false);
  assert.equal(isStageGateExempt('BEHAVIORAL_PRICE_OBJECTION'), false);
  assert.equal(isStageGateExempt(''), false);
  assert.equal(isStageGateExempt(null), false);
});

test('no exempt rule key is also a QUALIFYING_TAG-style sales rule', () => {
  // Sanity: every exempt key names a suppression/exit behaviour. If someone
  // adds a rule here that sends a customer-facing message, this list is wrong.
  for (const key of STAGE_GATE_EXEMPT_RULE_KEYS) {
    assert.match(key, /DNC|CANCEL|DISENGAGEMENT/, `${key} does not look like a suppression rule`);
  }
  assert.ok(QUALIFYING_TAGS.length > 0);
});
