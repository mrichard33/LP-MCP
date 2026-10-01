// The SMS / email reply prompt on a coverage turn (2026-10-01, Mark's ruling 4).
// generateResponse builds the same plan the live-chat lane does and passes it
// to buildResponsePrompt as opts.serviceAreaTurn. These pin what the model is
// told; the guard itself is covered in test-service-area-turn.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';
process.env.NEPQ_LAYER_MODE ||= 'on';

const { buildResponsePrompt } = await import('../src/response-generator.js');
const { planServiceAreaTurn, resolveCoverage } = await import('../src/agentic/service-area-turn.js');

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/response-prompt/04-sms-objection-price-no-quote.json', import.meta.url), 'utf8'));

function render(trigger, conversation, lookups, extraOpts = {}, context = fx.context) {
  const plan = planServiceAreaTurn({ trigger, conversation });
  const coverage = resolveCoverage(plan, lookups);
  return buildResponsePrompt(
    { ...context, conversation_recent: conversation },
    'sms', trigger, fx.kbPack, fx.classification, false, 'warm', null,
    { ...fx.opts, ...extraOpts, serviceAreaTurn: coverage ? { plan, coverage } : null },
  );
}

test('SMS: "do you service palm coast fl area?" with a zip on the CRM record still asks for the zip first', () => {
  const q = 'do you service palm coast fl area?';
  const user = render(q, [{ direction: 'inbound', text: q }], {}, {
    // The record says in-area; on a coverage turn that must NOT be confirmed.
    serviceArea: { checked: true, zip: '33101', in_service_area: true, city: 'Miami' },
  });
  assert.match(user, /SERVICE AREA QUESTION — ZIP FIRST/);
  assert.doesNotMatch(user, /VERIFIED IN SERVICE AREA/, 'the generic record-zip line is suppressed on a coverage turn');
});

test('SMS: "Do you serve Houston? 77002" → the prompt fixes the first sentence', () => {
  const q = 'Do you serve Houston? 77002';
  const user = render(q, [{ direction: 'inbound', text: q }], {
    zipResult: { checked: true, zip: '77002', in_service_area: true, city: 'Houston', market_code: 'HOU' },
  });
  assert.match(user, /FIRST sentence must be exactly: "Yes, we serve Houston \(77002\)\."/);
});

test('SMS: "75233" after our zip ask → out-of-area instruction overrides every collection rule', () => {
  const conv = [
    { direction: 'inbound', text: 'do you service dallas?' },
    { direction: 'outbound', text: "Happy to check that for you. What's your zip code?" },
    { direction: 'inbound', text: '75233' },
  ];
  const user = render('75233', conv, { zipResult: { checked: true, zip: '75233', in_service_area: false } });
  assert.match(user, /zip 75233 is OUTSIDE Reece's service area/);
  assert.match(user, /overrides every other instruction/);
  assert.doesNotMatch(user, /SERVICE AREA STATUS: zip 75233 is OUTSIDE.*UNIVERSAL FALLBACK/s, 'not the generic out-of-area block with its offer-a-call exception');
});

test('SMS: an ordinary turn keeps the generic service-area status lines exactly as before', () => {
  const user = render('How long is the install?', [{ direction: 'inbound', text: 'How long is the install?' }], {}, {
    serviceArea: { checked: true, zip: '32137', in_service_area: true, city: 'Palm Coast' },
  });
  assert.match(user, /zip 32137 VERIFIED IN SERVICE AREA \(Palm Coast\)/);
  assert.doesNotMatch(user, /ZIP FIRST|SERVICE AREA RESULT/);
});

test('SMS: a Houston contact\'s prompt clock is Central', () => {
  const user = render('hello', [{ direction: 'inbound', text: 'hello' }], {}, {}, {
    ...fx.context,
    market: { market_code: 'HOU', timezone: 'America/Chicago', label: 'CT' },
    now: { ...fx.context.now, time_human: '10:30 AM', tz: 'America/Chicago' },
  });
  assert.match(user, /CURRENT DATE — Houston \/ America\/Chicago/);
  assert.match(user, /TIME NOW: It is 10:30 AM on .* \(Central\)/);
});
