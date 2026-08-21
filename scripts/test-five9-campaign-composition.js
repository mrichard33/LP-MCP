/**
 * Five9 campaign composition — guards and dry-run behaviour.
 * scripts/test-five9-campaign-composition.js (Phase H PR4, 2026-08-21)
 *
 * The eleven registered composition ops plus the one that is deliberately
 * NOT registered. What these assertions are actually protecting:
 *
 *   - A campaign the floor is working must not have what it dials, or who it
 *     routes to, changed underneath it. Hence the RUNNING refusals, and hence
 *     they REFUSE rather than skip: the request is dangerous, not
 *     already-satisfied.
 *   - modifyCampaignLists and setCampaignStrategies REPLACE their sets. A
 *     payload naming two lists on a campaign carrying five detaches three, so
 *     the read-before-write and the recorded lists_detached are the evidence.
 *   - Removing the LAST skill from a RUNNING campaign strands every queued
 *     call. That is a sharper line than "refuse while running", so
 *     remove_skills gets that guard instead of the blanket one.
 *   - five9_remove_dispositions_from_campaign must stay UNREACHABLE while its
 *     payroll guard has no authoritative source.
 *
 * OFFLINE. Supabase env is scrubbed before the first import so no audit event
 * can reach a real database; Five9 creds are dummies and fetch is stubbed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Before the first import that reaches supabase.js — it builds its client at
// load time, and withFive9WriteGate emits an audit event on every execution.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const writes = await import('../src/five9/admin-writes.js');
const {
  refuseIfCampaignRunning,
  checkConfirmToken,
  requiredConfirmToken,
  checkPayrollDispositions,
  PAYROLL_PROTECTED_DISPOSITIONS,
  CAMPAIGN_TOKEN_OPS,
  executeCreateOutboundCampaign,
  executeAddListsToCampaign,
  executeRemoveListsFromCampaign,
  executeModifyCampaignLists,
  executeAddSkillsToCampaign,
  executeRemoveSkillsFromCampaign,
  executeAddDispositionsToCampaign,
  executeRemoveDispositionsFromCampaign,
  executeResetCampaignDispositions,
  executeSetCampaignStrategies,
  executeCreateList,
  executeResetListPosition,
} = writes;

const RUNNING_NAME = 'DIAL ASAP';
const STOPPED_NAME = 'REHASH OUTBOUND';

/* ====================================================================== *
 * 1. the shared RUNNING guard
 * ====================================================================== */

test('refuseIfCampaignRunning refuses RUNNING and passes NOT_RUNNING', () => {
  assert.throws(
    () => refuseIfCampaignRunning('add_lists_to_campaign', { name: RUNNING_NAME, state: 'RUNNING' }),
    /REFUSED: add_lists_to_campaign on a RUNNING campaign/,
  );
  assert.doesNotThrow(
    () => refuseIfCampaignRunning('add_lists_to_campaign', { name: STOPPED_NAME, state: 'NOT_RUNNING' }));
});

/* ====================================================================== *
 * 2. confirm_token — every gated op in the tranche
 * ====================================================================== */

const TOKENED_COMPOSITION = [
  'create_outbound_campaign', 'add_lists_to_campaign', 'remove_lists_from_campaign',
  'modify_campaign_lists', 'add_skills_to_campaign', 'remove_skills_from_campaign',
  'add_dispositions_to_campaign', 'remove_dispositions_from_campaign',
  'reset_campaign_dispositions', 'set_campaign_strategies', 'reset_list_position',
];

test('every composition op requires a confirm_token restating the campaign name', () => {
  assert.deepEqual([...CAMPAIGN_TOKEN_OPS].sort(), [...TOKENED_COMPOSITION].sort());
  for (const op of TOKENED_COMPOSITION) {
    assert.equal(requiredConfirmToken(op, { campaign_name: STOPPED_NAME }), STOPPED_NAME);
    assert.throws(
      () => checkConfirmToken(op, { campaign_name: STOPPED_NAME, confirm_token: 'rehash outbound' }),
      /confirm_token mismatch/, `${op} must refuse a case-mismatched token`);
    assert.throws(
      () => checkConfirmToken(op, { campaign_name: STOPPED_NAME }),
      /confirm_token mismatch/, `${op} must refuse a missing token`);
    assert.doesNotThrow(
      () => checkConfirmToken(op, { campaign_name: STOPPED_NAME, confirm_token: STOPPED_NAME }));
  }
});

test('create_list is deliberately NOT token-gated', () => {
  // A new list is empty and attached to nothing — there is no target to
  // confirm, and a token there would be ceremony that teaches people to paste
  // tokens without reading them.
  assert.equal(requiredConfirmToken('create_list', { list_name: 'X' }), null);
  assert.doesNotThrow(() => checkConfirmToken('create_list', { list_name: 'X' }));
});

test('reset_list_position keys its token on the CAMPAIGN, per the v13 schema', async () => {
  // The PR4 handoff said "confirm_token on the LIST name". v13
  // resetListPosition takes exactly one argument, <campaignName> — there is no
  // list argument to key a token on, so a list-name token would confirm a
  // target the call never receives. Schema wins (standing rule).
  const { wsdlSchema } = writes;
  assert.deepEqual(wsdlSchema().operations.resetListPosition.fields, ['campaignName']);
  assert.equal(requiredConfirmToken('reset_list_position', { campaign_name: STOPPED_NAME, list_name: 'Data Leads' }), STOPPED_NAME);
});

/* ====================================================================== *
 * 3. the payroll guard that has no source
 * ====================================================================== */

test('the CC payroll disposition guard REFUSES while unenforceable — it never allows', () => {
  // The failure mode to prevent: a guard with no mapping that quietly passes
  // everything, reading as protection while protecting nothing.
  assert.equal(PAYROLL_PROTECTED_DISPOSITIONS.available, false);
  assert.equal(PAYROLL_PROTECTED_DISPOSITIONS.source, null);
  const verdict = checkPayrollDispositions(['NoRehash', 'Appointment Set']);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.unenforceable, true);
  assert.match(verdict.violations.join(' '), /no authoritative source/);
});

test('the payroll guard works correctly once a mapping IS supplied', () => {
  // Pinning the enforcing behaviour now means registering the op later is a
  // wiring change against a tested guard, not a fresh implementation.
  const mapping = { available: true, source: 'test fixture', names: ['NoRehash'] };
  assert.equal(checkPayrollDispositions(['Appointment Set'], mapping).ok, true);
  const blocked = checkPayrollDispositions(['norehash'], mapping); // case-insensitive
  assert.equal(blocked.ok, false);
  assert.match(blocked.violations.join(' '), /CC payroll bonus mapping/);
});

/* ====================================================================== *
 * 4. executors — over a stubbed transport
 * ====================================================================== */

const campaignsXml = () =>
  '<soap:Envelope><soap:Body><ns2:getCampaignsResponse>' +
  `<return><name>${RUNNING_NAME}</name><state>RUNNING</state><type>OUTBOUND</type><mode>POWER</mode><profileName>Data Leads</profileName></return>` +
  `<return><name>${STOPPED_NAME}</name><state>NOT_RUNNING</state><type>OUTBOUND</type><mode>POWER</mode><profileName>Data Leads</profileName></return>` +
  '<return><name>Main Number</name><state>RUNNING</state><type>INBOUND</type><mode>BASIC</mode></return>' +
  '</ns2:getCampaignsResponse></soap:Body></soap:Envelope>';

// One attached skill by default, so "remove the last one" is reachable.
let outboundSkills = ['Setter'];
// The outbound campaign BLOCK also carries <lists>, which is the fallback when
// the separate getListsForCampaign call fails. Both have to be absent before
// the set is genuinely unreadable — so this is a separate toggle.
let outboundBlockLists = ['Data Leads', 'Previous Customer'];

const RESPONSES = {
  getCampaigns: campaignsXml,
  getListsInfo: () =>
    '<soap:Envelope><soap:Body><ns2:getListsInfoResponse>' +
    '<return><name>Data Leads</name><size>100</size></return>' +
    '<return><name>Previous Customer</name><size>50</size></return>' +
    '</ns2:getListsInfoResponse></soap:Body></soap:Envelope>',
  getSkills: () =>
    '<soap:Envelope><soap:Body><ns2:getSkillsResponse>' +
    '<return><id>1</id><name>Setter</name></return>' +
    '<return><id>2</id><name>Closer</name></return>' +
    '</ns2:getSkillsResponse></soap:Body></soap:Envelope>',
  getDispositions: () =>
    '<soap:Envelope><soap:Body><ns2:getDispositionsResponse>' +
    '<return><name>Appointment Set</name></return>' +
    '<return><name>No Answer</name></return>' +
    '</ns2:getDispositionsResponse></soap:Body></soap:Envelope>',
  getCampaignProfiles: () =>
    '<soap:Envelope><soap:Body><ns2:getCampaignProfilesResponse>' +
    '<return><name>Data Leads</name></return>' +
    '</ns2:getCampaignProfilesResponse></soap:Body></soap:Envelope>',
  getOutboundCampaign: () =>
    '<soap:Envelope><soap:Body><ns2:getOutboundCampaignResponse><return>' +
    `<name>${STOPPED_NAME}</name><state>NOT_RUNNING</state><type>OUTBOUND</type>` +
    outboundBlockLists.map((l) => `<lists><listName>${l}</listName></lists>`).join('') +
    outboundSkills.map((s) => `<skills><skillName>${s}</skillName></skills>`).join('') +
    '</return></ns2:getOutboundCampaignResponse></soap:Body></soap:Envelope>',
  // getOutboundCampaign fetches attached lists through a SECOND SOAP call.
  // The stub must serve it, or `lists` comes back null (lookup failed) and the
  // fail-safe refusals below fire instead of the behaviour under test.
  getListsForCampaign: () =>
    '<soap:Envelope><soap:Body><ns2:getListsForCampaignResponse>' +
    '<return><listName>Data Leads</listName><priority>1</priority></return>' +
    '<return><listName>Previous Customer</listName><priority>2</priority></return>' +
    '</ns2:getListsForCampaignResponse></soap:Body></soap:Envelope>',
  getCampaignStrategies: () =>
    '<soap:Envelope><soap:Body><ns2:getCampaignStrategiesResponse>' +
    '<return><name>Daytime</name><enabled>true</enabled></return>' +
    '</ns2:getCampaignStrategiesResponse></soap:Body></soap:Envelope>',
};

function stubFive9() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const body = String(opts?.body ?? '');
    const method = (/<ser:(\w+)>/.exec(body) || [])[1] || '(unknown)';
    calls.push({ method, body });
    const responder = RESPONSES[method];
    return {
      ok: true, status: 200, headers: { get: () => null },
      text: async () => (responder ? responder() : `<soap:Envelope><soap:Body><ns2:${method}Response/></soap:Body></soap:Envelope>`),
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const DRY = { FIVE9_WRITES_ENABLED: undefined, FIVE9_USERNAME: 'u', FIVE9_PASSWORD: 'p' };
const ARMED = { FIVE9_WRITES_ENABLED: 'true', FIVE9_USERNAME: 'u', FIVE9_PASSWORD: 'p' };

const act = (type, payload) => ({ id: 1, action_type: type, requires_approval: true, action_payload: payload });

// Every op that carries the blanket RUNNING refusal, with a payload that is
// otherwise entirely valid — so a refusal can only be the state guard.
const RUNNING_REFUSERS = [
  ['five9_add_lists_to_campaign', executeAddListsToCampaign, { lists: ['Data Leads'] }, 'addListsToCampaign'],
  ['five9_remove_lists_from_campaign', executeRemoveListsFromCampaign, { lists: ['Data Leads'] }, 'removeListsFromCampaign'],
  ['five9_modify_campaign_lists', executeModifyCampaignLists, { lists: ['Data Leads'] }, 'modifyCampaignLists'],
  ['five9_add_skills_to_campaign', executeAddSkillsToCampaign, { skills: ['Closer'] }, 'addSkillsToCampaign'],
  ['five9_reset_campaign_dispositions', executeResetCampaignDispositions, { dispositions: ['No Answer'] }, 'resetCampaignDispositions'],
  ['five9_set_campaign_strategies', executeSetCampaignStrategies, { campaign_strategies: { strategies: [{ name: 'D', enabled: true, startAfterTimeMins: 30 }] } }, 'setCampaignStrategies'],
  ['five9_reset_list_position', executeResetListPosition, {}, 'resetListPosition'],
];

test('every RUNNING-refusal op refuses on RUNNING — with writes ARMED', async () => {
  // Armed on purpose: this proves the GUARD stops it, not the master flag.
  for (const [type, exec, extra, method] of RUNNING_REFUSERS) {
    const stub = stubFive9();
    try {
      await withEnv(ARMED, async () => {
        await assert.rejects(
          exec(act(type, { campaign_name: RUNNING_NAME, confirm_token: RUNNING_NAME, ...extra })),
          /on a RUNNING campaign/, `${type} must refuse a RUNNING target`);
      });
      assert.equal(stub.calls.some((c) => c.method === method), false,
        `${type} must not reach ${method} when refused`);
    } finally { stub.restore(); }
  }
});

test('every RUNNING-refusal op PROCEEDS on NOT_RUNNING (dry-run envelope, no mutation)', async () => {
  for (const [type, exec, extra, method] of RUNNING_REFUSERS) {
    const stub = stubFive9();
    try {
      const result = await withEnv(DRY, () =>
        exec(act(type, { campaign_name: STOPPED_NAME, confirm_token: STOPPED_NAME, ...extra })));
      assert.equal(result.dry_run, true, `${type} must report dry_run`);
      assert.ok(result.envelope_preview?.length, `${type} must preview an envelope`);
      assert.equal(result.envelope_preview[0].method, method);
      assert.equal(stub.calls.some((c) => c.method === method), false,
        `${type} must not mutate in dry-run`);
    } finally { stub.restore(); }
  }
});

test('INBOUND campaigns stay immutable through the composition ops too', async () => {
  const stub = stubFive9();
  try {
    await withEnv(ARMED, async () => {
      await assert.rejects(
        executeAddListsToCampaign(act('five9_add_lists_to_campaign', {
          campaign_name: 'Main Number', confirm_token: 'Main Number', lists: ['Data Leads'],
        })),
        /INBOUND campaigns are immutable/);
    });
  } finally { stub.restore(); }
});

test('remove_skills: refuses the LAST skill on a RUNNING campaign, allows it once stopped', async () => {
  // The sharp version of the RUNNING guard. Removing SOME skills from a live
  // campaign is a routing change; removing the last one strands every queued
  // call with nothing to route to.
  outboundSkills = ['Setter'];
  let stub = stubFive9();
  try {
    await withEnv(ARMED, async () => {
      await assert.rejects(
        executeRemoveSkillsFromCampaign(act('five9_remove_skills_from_campaign', {
          campaign_name: RUNNING_NAME, confirm_token: RUNNING_NAME, skills: ['Setter'],
        })),
        /would leave .* with NO skills while it is RUNNING/);
    });
    assert.equal(stub.calls.some((c) => c.method === 'removeSkillsFromCampaign'), false);
  } finally { stub.restore(); }

  // Same removal, stopped campaign — allowed.
  stub = stubFive9();
  try {
    const result = await withEnv(DRY, () =>
      executeRemoveSkillsFromCampaign(act('five9_remove_skills_from_campaign', {
        campaign_name: STOPPED_NAME, confirm_token: STOPPED_NAME, skills: ['Setter'],
      })));
    assert.equal(result.dry_run, true);
    assert.equal(result.envelope_preview[0].method, 'removeSkillsFromCampaign');
  } finally { stub.restore(); }
});

test('remove_skills: removing SOME skills from a RUNNING campaign is allowed', async () => {
  outboundSkills = ['Setter', 'Closer'];
  const stub = stubFive9();
  try {
    const result = await withEnv(DRY, () =>
      executeRemoveSkillsFromCampaign(act('five9_remove_skills_from_campaign', {
        campaign_name: RUNNING_NAME, confirm_token: RUNNING_NAME, skills: ['Closer'],
      })));
    assert.equal(result.dry_run, true, 'a non-emptying removal on a RUNNING campaign is a routing change, not a strand');
  } finally { stub.restore(); outboundSkills = ['Setter']; }
});

test('add_dispositions has NO running refusal — it is purely additive', async () => {
  const stub = stubFive9();
  try {
    const result = await withEnv(DRY, () =>
      executeAddDispositionsToCampaign(act('five9_add_dispositions_to_campaign', {
        campaign_name: RUNNING_NAME, confirm_token: RUNNING_NAME, dispositions: ['Appointment Set'],
      })));
    assert.equal(result.dry_run, true);
    assert.equal(result.envelope_preview[0].method, 'addDispositionsToCampaign');
  } finally { stub.restore(); }
});

test('modify_campaign_lists records what its REPLACE would detach', async () => {
  // The campaign carries Data Leads + Previous Customer. Naming only one
  // detaches the other, and that must be visible in the result and on the
  // audit event rather than discovered later.
  const stub = stubFive9();
  try {
    const result = await withEnv(DRY, () =>
      executeModifyCampaignLists(act('five9_modify_campaign_lists', {
        campaign_name: STOPPED_NAME, confirm_token: STOPPED_NAME, lists: ['Data Leads'],
      })));
    assert.deepEqual(result.lists_before, ['Data Leads', 'Previous Customer']);
    assert.deepEqual(result.lists_detached, ['Previous Customer']);
  } finally { stub.restore(); }
});

test('existence checks refuse unknown lists, skills and dispositions', async () => {
  // Five9 accepts an unknown list silently and the campaign then dials nothing
  // from it — a success response for a change that did not happen.
  const cases = [
    [executeAddListsToCampaign, 'five9_add_lists_to_campaign', { lists: ['No Such List'] }, /list\(s\) that do not exist/],
    [executeAddSkillsToCampaign, 'five9_add_skills_to_campaign', { skills: ['No Such Skill'] }, /skill\(s\) that do not exist/],
    [executeAddDispositionsToCampaign, 'five9_add_dispositions_to_campaign', { dispositions: ['No Such Disp'] }, /disposition\(s\) that do not exist/],
  ];
  for (const [exec, type, extra, re] of cases) {
    const stub = stubFive9();
    try {
      await withEnv(ARMED, async () => {
        await assert.rejects(
          exec(act(type, { campaign_name: STOPPED_NAME, confirm_token: STOPPED_NAME, ...extra })), re);
      });
    } finally { stub.restore(); }
  }
});

test('create_outbound_campaign: refuses an unknown profile, and refuses state=RUNNING', async () => {
  let stub = stubFive9();
  try {
    await withEnv(ARMED, async () => {
      await assert.rejects(
        executeCreateOutboundCampaign(act('five9_create_outbound_campaign', {
          campaign_name: 'NEW ONE', confirm_token: 'NEW ONE',
          campaign: { profileName: 'Nonexistent Profile' },
        })),
        /campaign profile "Nonexistent Profile" does not exist/);

      // An explicit RUNNING is a refusal, not something to silently overwrite:
      // a campaign that dials the moment it is created was never reviewed in
      // the state it runs in.
      await assert.rejects(
        executeCreateOutboundCampaign(act('five9_create_outbound_campaign', {
          campaign_name: 'NEW ONE', confirm_token: 'NEW ONE',
          campaign: { profileName: 'Data Leads', state: 'RUNNING' },
        })),
        /creates only with state=NOT_RUNNING/);

      // And a duplicate name is refused — campaign names key DNIS→source
      // attribution, so they are never reused.
      await assert.rejects(
        executeCreateOutboundCampaign(act('five9_create_outbound_campaign', {
          campaign_name: STOPPED_NAME, confirm_token: STOPPED_NAME,
          campaign: { profileName: 'Data Leads' },
        })),
        /already exists/);
    });
    assert.equal(stub.calls.some((c) => c.method === 'createOutboundCampaign'), false);
  } finally { stub.restore(); }

  stub = stubFive9();
  try {
    const result = await withEnv(DRY, () =>
      executeCreateOutboundCampaign(act('five9_create_outbound_campaign', {
        campaign_name: 'NEW ONE', confirm_token: 'NEW ONE',
        campaign: { profileName: 'Data Leads' },
      })));
    assert.match(result.envelope_preview[0].innerXml, /<state>NOT_RUNNING<\/state>/,
      'the forced state must actually be on the wire, not just asserted in a comment');
  } finally { stub.restore(); }
});

test('create_list: creating one that already exists is a skipped no-op, not a refusal', async () => {
  // Already-satisfied, not dangerous — so it skips, matching the lifecycle
  // no-op convention rather than the refusal convention.
  const stub = stubFive9();
  try {
    const result = await withEnv(DRY, () =>
      executeCreateList(act('five9_create_list', { list_name: 'Data Leads' })));
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'list_already_exists');
    assert.equal(stub.calls.some((c) => c.method === 'createList'), false);
  } finally { stub.restore(); }
});

test('create_list: a new name previews a createList envelope and mutates nothing', async () => {
  const stub = stubFive9();
  try {
    const result = await withEnv(DRY, () =>
      executeCreateList(act('five9_create_list', { list_name: 'Rehash 2026-08' })));
    assert.equal(result.dry_run, true);
    assert.equal(result.envelope_preview[0].method, 'createList');
    assert.match(result.envelope_preview[0].innerXml, /<listName>Rehash 2026-08<\/listName>/);
    assert.equal(stub.calls.some((c) => c.method === 'createList'), false);
  } finally { stub.restore(); }
});

test('the unregistered op still refuses on its own payroll guard if ever called directly', async () => {
  // Belt-and-braces. Nothing can queue it (it is absent from ACTION_HANDLERS),
  // but the executor itself must also refuse rather than proceed, so
  // registering it by accident cannot quietly enable an unguarded removal.
  const stub = stubFive9();
  try {
    await withEnv(ARMED, async () => {
      await assert.rejects(
        executeRemoveDispositionsFromCampaign(act('five9_remove_dispositions_from_campaign', {
          campaign_name: STOPPED_NAME, confirm_token: STOPPED_NAME, dispositions: ['Appointment Set'],
        })),
        /no authoritative source/);
    });
    assert.equal(stub.calls.some((c) => c.method === 'removeDispositionsFromCampaign'), false);
  } finally { stub.restore(); }
});

test('an empty array is refused rather than sent as a no-op write', async () => {
  const stub = stubFive9();
  try {
    await withEnv(ARMED, async () => {
      await assert.rejects(
        executeAddListsToCampaign(act('five9_add_lists_to_campaign', {
          campaign_name: STOPPED_NAME, confirm_token: STOPPED_NAME, lists: [],
        })),
        /non-empty array/);
    });
  } finally { stub.restore(); }
});

/* ====================================================================== *
 * 5. fail-safe: an UNREADABLE current state must refuse, never assume empty
 * ====================================================================== */

// getOutboundCampaign leaves `lists` null when getListsForCampaign throws, and
// is explicit that null means "lookup failed" while [] means "none attached".
// Collapsing the two would be a fail-open on the two ops that depend on
// knowing the current set.
function stubWithFailingListLookup() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const body = String(opts?.body ?? '');
    const method = (/<ser:(\w+)>/.exec(body) || [])[1] || '(unknown)';
    calls.push({ method, body });
    if (method === 'getListsForCampaign') {
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => '<soap:Envelope><soap:Body><soap:Fault><faultstring>boom</faultstring></soap:Fault></soap:Body></soap:Envelope>',
      };
    }
    const responder = RESPONSES[method];
    return {
      ok: true, status: 200, headers: { get: () => null },
      text: async () => (responder ? responder() : `<soap:Envelope><soap:Body><ns2:${method}Response/></soap:Body></soap:Envelope>`),
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('the outbound campaign block is the FALLBACK when getListsForCampaign fails', async () => {
  // Not every failed list lookup is an unreadable state: the campaign block
  // itself carries <lists>, so the fallback recovers the set and the op
  // proceeds with a real lists_before. Pinning this keeps the fail-safe below
  // from being over-eager.
  const stub = stubWithFailingListLookup();
  try {
    const result = await withEnv(DRY, () =>
      executeModifyCampaignLists(act('five9_modify_campaign_lists', {
        campaign_name: STOPPED_NAME, confirm_token: STOPPED_NAME, lists: ['Data Leads'],
      })));
    assert.deepEqual(result.lists_before, ['Data Leads', 'Previous Customer']);
    assert.deepEqual(result.lists_detached, ['Previous Customer']);
  } finally { stub.restore(); }
});

test('modify_campaign_lists REFUSES when the current list set cannot be read', async () => {
  // Reporting an empty lists_detached here would tell the approver that
  // nothing is being detached — precisely the thing that could not be
  // established. A REPLACE with an unknown blast radius must not proceed.
  const stub = stubWithFailingListLookup();
  const savedLists = outboundBlockLists;
  outboundBlockLists = []; // neither the second call NOR the block carries them
  try {
    await withEnv(ARMED, async () => {
      await assert.rejects(
        executeModifyCampaignLists(act('five9_modify_campaign_lists', {
          campaign_name: STOPPED_NAME, confirm_token: STOPPED_NAME, lists: ['Data Leads'],
        })),
        /could not read the lists currently attached/);
    });
    assert.equal(stub.calls.some((c) => c.method === 'modifyCampaignLists'), false);
  } finally { stub.restore(); outboundBlockLists = savedLists; }
});

test('remove_skills REFUSES on a RUNNING campaign whose skill set cannot be read', async () => {
  // The last-skill guard cannot be evaluated without the current set, and a
  // removal that strands every queued call is not something to take on trust.
  const stub = stubFive9();
  const savedSkills = outboundSkills;
  outboundSkills = []; // campaign block carries no <skills> at all
  try {
    await withEnv(ARMED, async () => {
      await assert.rejects(
        executeRemoveSkillsFromCampaign(act('five9_remove_skills_from_campaign', {
          campaign_name: RUNNING_NAME, confirm_token: RUNNING_NAME, skills: ['Setter'],
        })),
        /could not read the skills currently on RUNNING campaign/);
    });
    assert.equal(stub.calls.some((c) => c.method === 'removeSkillsFromCampaign'), false);
  } finally { stub.restore(); outboundSkills = savedSkills; }
});

test('an unreadable skill set on a STOPPED campaign is not a refusal', async () => {
  // The guard exists to protect calls queued on a LIVE campaign. With the
  // campaign stopped there is nothing to strand, so the same unreadable state
  // is not a reason to block the change.
  const stub = stubFive9();
  const savedSkills = outboundSkills;
  outboundSkills = [];
  try {
    const result = await withEnv(DRY, () =>
      executeRemoveSkillsFromCampaign(act('five9_remove_skills_from_campaign', {
        campaign_name: STOPPED_NAME, confirm_token: STOPPED_NAME, skills: ['Setter'],
      })));
    assert.equal(result.dry_run, true);
  } finally { stub.restore(); outboundSkills = savedSkills; }
});
