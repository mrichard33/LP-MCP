/**
 * F.0 v2 context — src/siro/f0-context.js (2026-10-16, Siro PR 1)
 *
 * Everything the nurture orchestrator needs for a workflow_code 'F.0' turn,
 * read once from Supabase (never Siro live, except the one on-demand ensure
 * while the demo is younger than SIRO_WAIT_MAX_H):
 *   - the visit facts and the template variables the F.0 prompt rows read
 *     ({{siro.presentation_block}}, {{siro.rehash_rep_first_name}}, …)
 *   - the inputs of postDemoInterrupt (src/siro/f0-interrupts.js)
 *
 * The decisions themselves stay in the pure modules; this file only reads.
 * AIOS: CANON.K.051 (stored memory), K.070 (a failed read is "unknown" and
 * the conservative answer is taken: no visit data, not in rehash → suppress).
 */
import supabaseDefault from '../supabase.js';
import { readSiroRows } from './context-read.js';
import { ensureRecordingForLead } from './ensure-recording.js';
import { buildPresentationFacts, presentationTemplateVars, repFirstName } from './presentation-facts.js';
import { siroConfig, siroModes } from './config.js';
import { buildVisitFacts, fourStepObjectionType, STORY_ANGLES, earlierClosesLine } from './f0-four-step.js';
import { firstPersonName } from '../services/lp-identity-fill.js';
import { isPostDemoLead } from '../agentic/post-demo-lead.js';
import { lpSold, isUnsoldPostDemo } from '../agentic/post-demo-owner.js';
import { isInRehash, rehashLeadFromContext, stageFromRows } from '../agentic/rehash-state.js';
import { appointmentOnFile } from '../agentic/booking-claim.js';
import { isCustomerP2 } from '../agentic/lead-state/signals/context-reader.js';
import { POST_DEMO_STOP_RX } from '../agentic/nepq-planner.js';
import { getCustomValue } from '../services/ghl-custom-values.js';
import { REHASH_REP_CUSTOM_VALUE } from '../agentic/rehash.js';
import { rehashRepFor } from '../config/rehash-assignee.js';
import { rehashTeamUserIds } from '../agentic/rehash-state.js';
import { rehashRepFirstName, ghlUserFirstName } from '../agentic/rehash-slots.js';
import { isF0EmailRequest, emailHoldWindow, F0_TEAM_CALL_FALLBACK } from './f0-email.js';
import { testLinkFor } from './f0-test-link.js';
import { rehashOwned as readRehashOwned, rehashOwnedMode } from '../agentic/rehash-owned.js';
import { rehashCalendarId } from '../knowledge/booking-calendar-router.js';

const HOUR_MS = 3_600_000;
const SENT_STATUSES = ['ghl_sent_confirmed', 'generated_ready'];

const textOf = (m) => String(m?.text ?? m?.body ?? '');
const isOutbound = (m) => String(m?.direction || '').toLowerCase() === 'outbound';
const atOf = (m) => Date.parse(m?.timestamp || m?.date || m?.dateAdded || '') || null;

/**
 * The sticky post-demo stop (nepq-planner.js planPostDemo): our "I'm here if
 * anything changes." went out and the lead has not asked anything since.
 * The durable trace is the nepq:handoff:rehash_stop tag. Pure.
 */
export function postDemoStopFrom({ conversation = [], tags = [] } = {}) {
  if ((tags || []).some(t => String(t).toLowerCase() === 'nepq:handoff:rehash_stop')) return true;
  const list = Array.isArray(conversation) ? conversation : [];
  let stopAt = -1;
  list.forEach((m, i) => { if (isOutbound(m) && POST_DEMO_STOP_RX.test(textOf(m))) stopAt = i; });
  if (stopAt < 0) return false;
  return !list.slice(stopAt + 1).some(m => !isOutbound(m) && /\?/.test(textOf(m)));
}

/**
 * The first name an F.0 touch may greet, or '' (2026-10-22, the live preview's
 * "Hi A,"): GHL held the first name "a" (LP: "AJ / Anita"), and any non-empty
 * GHL name won, so the email and its subject opened on a lone initial. A
 * couple's field keeps its first person (firstPersonName); a first word of
 * fewer than two letters ("a", "A.", "a j") is no name; two or three capitals
 * typed as the name ("AJ") stay as typed rather than becoming "Aj". Pure.
 */
export function greetingName(raw) {
  const person = firstPersonName(raw);
  const firstWord = person.split(/\s+/)[0] || '';
  if (firstWord.replace(/[^\p{L}]/gu, '').length < 2) return '';
  const typed = String(raw || '').split(/\/|&|\+|\s+and\s+/i)[0].trim();
  if (/^\p{Lu}{2,3}$/u.test(typed)) return typed;
  return person;
}

/**
 * The prompt reads {{lead.first_name}}, so an F.0 touch that opens on a name
 * (Four-Step texts, the email) greets the cleaned name or none at all, never
 * the raw field. Mutates context.lead; a no-op for v1 texts.
 */
export function applyGreetingName(context, f0, { fourStep = false, email = false } = {}) {
  if (!(fourStep || email) || !f0?.vars || f0.vars.first_name === undefined) return;
  context.lead = { ...(context.lead || {}), first_name: f0.vars.first_name || '' };
}

/**
 * Our earlier messages to this lead, newest last (at most 8), for the "never the
 * same close twice" check and the prompt's EARLIER CLOSES (the user,
 * 2026-10-22). Pure.
 */
export function earlierOutbound(conversation = []) {
  return (Array.isArray(conversation) ? conversation : []).filter(isOutbound).map(textOf).filter(Boolean).slice(-8);
}

/** The lead texted after our last F.0 touch. Pure. */
export function repliedSince({ conversation = [], lastTouchAt = null } = {}) {
  const t = Date.parse(lastTouchAt || '');
  if (!Number.isFinite(t)) return false;
  return (Array.isArray(conversation) ? conversation : []).some(m => !isOutbound(m) && (atOf(m) || 0) > t);
}

/** Hours since the demo: the recording, else LP's demo / appointment date. Pure. */
export function demoAgeHours({ facts = null, lp = null, nowMs = Date.now() } = {}) {
  const at = Date.parse(facts?.recorded_at || lp?.demo_date || lp?.last_appointment_date || lp?.appointment_date || '');
  return Number.isFinite(at) ? Math.max(0, (nowMs - at) / HOUR_MS) : null;
}

async function safe(label, fn, fallback) {
  try { return await fn(); } catch (err) { console.log(`[F0v2] ${label} read failed: ${err.message}`); return fallback; }
}

const REP_READ_CAP_MS = 2500;
const capped = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), REP_READ_CAP_MS))]);

/**
 * The rehash rep's first name for the F.0 texts (and the email in
 * F0_EMAIL_VOICE=rep; the Reece Team email reads resolveEmailRepFirst, Mark
 * 2026-10-22). 2026-10-15 (the user): the rep is the FOLLOWER
 * the GHL rehash workflow put on THIS lead (rehashRepFor), named from
 * REHASH_TEAM_USER_NAMES or the GHL user record; else the GHL custom value
 * rehash_rep_name, as before; else "Reece Team". Never guessed. Never throws.
 */
export async function resolveRehashRepFirst(contactId, { env = process.env, deps = {} } = {}) {
  const getContact = deps.getContact || (async (id) => (await import('../actions/contact-cache.js')).getContactCached(id, null, { maxWaitMs: 2000 }));
  const contact = contactId ? await capped(getContact(contactId)).catch(() => null) : null;
  const repId = rehashRepFor(contact, rehashTeamUserIds(env));
  const fromFollower = repId
    ? (rehashRepFirstName(repId, env) || await capped((deps.getUserName || ghlUserFirstName)(repId)).catch(() => null))
    : null;
  if (fromFollower) return fromFollower;
  const repRaw = await (deps.getCustomValue || getCustomValue)(REHASH_REP_CUSTOM_VALUE);
  return repFirstName(repRaw) || 'Reece Team';
}

/**
 * A rep's first name fit to print, or null: the first word of the value,
 * letters only. A merge tag ("{{custom_values.rehash_rep_name}}"), a blank or
 * anything else is no name, so a tag can never reach a draft; nor is "Reece". Pure.
 */
export function cleanRepFirst(raw) {
  const first = repFirstName(String(raw ?? '').trim());
  // "Reece" is the company, never a person (2026-10-23: "a quick call with Reece").
  if (/^reece$/i.test(first || '')) return null;
  return first && /^\p{L}[\p{L}'’-]*$/u.test(first) ? first : null;
}

/**
 * The rehash rep the Reece Team EMAIL invites a call with (Mark, 2026-10-22):
 * the GHL custom value rehash_rep_name FIRST, then the follower on the lead
 * (resolveRehashRepFirst), else null and the invite is a call "with our team".
 * Never guessed, never "Reece Team" as a person's name. Never throws.
 */
export async function resolveEmailRepFirst(contactId, { env = process.env, deps = {} } = {}) {
  const raw = await Promise.resolve().then(() => (deps.getCustomValue || getCustomValue)(REHASH_REP_CUSTOM_VALUE)).catch(() => null);
  const fromValue = cleanRepFirst(raw);
  if (fromValue) return fromValue;
  const follower = await resolveRehashRepFirst(contactId, { env, deps }).catch(() => null);
  return follower && follower !== 'Reece Team' ? cleanRepFirst(follower) : null;
}

/**
 * @param {object} context  buildLeadContext() output
 * @param {{contact_id: string, sequence_position: number}} request
 * @returns {Promise<{facts, rows, vars, recordingId, interruptInput}>}
 */
export async function loadF0Context(context, request, { env = process.env, deps = {}, nowMs = Date.now(), allowEnsure = true } = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const cfg = siroConfig(env);
  const lp = context?.lp || {};
  const lead = context?.lead || {};
  const tags = (lead.current_tags || []).map(t => String(t).toLowerCase());
  const read = deps.readSiroRows || readSiroRows;
  // 2026-10-21 (the user): a test contact (tag aios-test, listed in
  // F0_TEST_LINKS) reads the visit of the real LP lead it is linked to, and
  // nothing else of that lead: no Siro ensure, no rehash_stage, no lp_leads.
  const testLink = deps.testLink !== undefined ? deps.testLink : testLinkFor(request.contact_id, lead.current_tags, env);
  const readArgs = testLink
    ? { supabase, contactId: null, leadIds: [testLink.lpLeadId], prospectId: null }
    : { supabase, contactId: request.contact_id, leadIds: [lp.lead_id], prospectId: lp.prospect_id };
  // 2026-10-21 (Mark): the position-0 email waits for the recording until the
  // cap (08:30 ET the day after the demo), not the texts' 24h. A linked test
  // contact's demo is always two hours ago, so the email never waits for Siro.
  const email = isF0EmailRequest(request);
  const testDemoAtMs = nowMs - 2 * HOUR_MS;
  const demoAtMs = (f) => (testLink ? testDemoAtMs : Date.parse(f?.recorded_at || lp.demo_date || lp.last_appointment_date || lp.appointment_date || ''));
  const waitFor = (f) => (email
    ? emailHoldWindow({ demoAtMs: demoAtMs(f), nowMs, capEt: cfg.f0EmailHoldCapEt, stepH: cfg.waitHoldH })
    : { waitMaxH: cfg.waitMaxH, waitHoldH: cfg.waitHoldH });

  let rows = await safe('siro_recordings', () => read(readArgs), []);
  let facts = buildPresentationFacts(rows, { now: nowMs });
  const ageBefore = demoAgeHours({ facts, lp, nowMs });
  if (!facts && allowEnsure && !testLink && Number.isFinite(ageBefore) && ageBefore < waitFor(facts).waitMaxH && lp.lead_id) {
    const ensured = await (deps.ensureRecordingForLead || ensureRecordingForLead)(
      { lp_lead_id: lp.lead_id, phone: lead.phone, demo_date: lp.demo_date, appointment_date: lp.last_appointment_date || lp.appointment_date },
      { env, deps, nowMs },
    );
    if (ensured === 'row') {
      rows = await safe('siro_recordings', () => read(readArgs), []);
      facts = buildPresentationFacts(rows, { now: nowMs });
    }
  }
  const recording = facts ? rows.find(r => r.recording_id === facts.recording_id) : null;
  const demoLeadId = String(recording?.lp_lead_id || lp.lead_id || '');

  // Rehash: the demo lead's own 30-day window and its rehash_stage row. Tags
  // are NOT read here: F.0 itself carries active-f.0, which would read as
  // "in rehash" forever.
  const stageRows = testLink ? [] : await safe('rehash_stage', async () => {
    const { data, error } = await supabase.from('rehash_stage')
      .select('ghl_contact_id, lp_lead_id, demo_date, started_at, ended_at').eq('ghl_contact_id', request.contact_id);
    if (error) throw new Error(error.message);
    return data || [];
  }, null);
  const stage = stageRows ? stageFromRows(stageRows) : null;
  const currentLead = rehashLeadFromContext(lp);
  const rehashActive = (!!stage?.open && String(stage.open.lp_lead_id) === demoLeadId)
    || isInRehash({ tags: [], currentLead, stage, nowMs, env });

  // A newer lead on the prospect than the demo lead.
  const newest = (lp.prospect_id && !testLink) ? await safe('lp_leads', async () => {
    const { data, error } = await supabase.from('lp_leads').select('lp_lead_id, created_at_lp')
      .eq('lp_prospect_id', String(lp.prospect_id)).order('created_at_lp', { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    return data?.[0] || null;
  }, null) : null;
  const newerLead = !!(newest && demoLeadId && String(newest.lp_lead_id) !== demoLeadId
    && Number(newest.lp_lead_id) > Number(demoLeadId));

  // 2026-10-21 (Mark, rehash ownership): John owns the lead once a Rehash Call
  // is booked, LP has the visit set, or he tagged the contact rehash-owned.
  // Live stops the touch (`rehash_owned`); shadow only logs it.
  let ownedLive = false;
  const ownedMode = rehashOwnedMode(env);
  if (!testLink && ownedMode !== 'off') {
    const calId = rehashCalendarId(env);
    const appointments = calId ? await safe('appointments', async () => {
      const fetchAppts = deps.fetchRecentAndUpcomingAppointments
        || (await import('../knowledge/contact-appointments.js')).fetchRecentAndUpcomingAppointments;
      return fetchAppts(request.contact_id, { pastHours: 0 });
    }, null) : [];
    const owned = readRehashOwned({ tags, appointments, currentLead, rehashCalendarId: calId, nowMs });
    if (owned.owned === true) {
      if (ownedMode === 'live') ownedLive = true;
      else console.log(`[F0] shadow: ${request.contact_id} rehash-owned (${owned.reason}); live would stop this touch`);
    }
  }

  // The last F.0 touch that went out (or was ready to), for "replied since".
  const lastTouch = await safe('agentic_messages', async () => {
    const { data, error } = await supabase.from('agentic_messages').select('generated_at')
      .eq('ghl_contact_id', request.contact_id).eq('workflow_code', 'F.0').in('send_status', SENT_STATUSES)
      .order('generated_at', { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    return data?.[0]?.generated_at || null;
  }, null);

  // A linked test contact is sold only by its OWN tag; its LP lead is 'Data'.
  const sold = testLink ? tags.includes('deal-won') : (lpSold(lp) || isCustomerP2(context) || tags.includes('deal-won'));
  const postAppointment = isPostDemoLead({ lp, tags, stageTag: lead.current_stage_tag || null });

  const age = testLink ? 2 : demoAgeHours({ facts, lp, nowMs });
  const modes = siroModes(env);
  // 2026-10-22 (Mark): the email is the Reece Team's; its call invite names
  // the rep from the custom value first ('' when none: "a quick call with
  // our team"). The texts, and the email in rep voice, keep the follower
  // first, else the custom value, never guessed: "Reece Team" when none.
  const emailVoice = email ? modes.f0EmailVoice : null;
  const teamEmail = emailVoice === 'team';
  // 2026-10-23 (the user): the Four-Step texts are the Reece Team's too, so the
  // email and the texts come from one sender, and they name ONE rep: the
  // email's (resolveEmailRepFirst: the custom value first, then a rehash-team
  // follower). The follower-first read printed "a quick call with Reece" for a
  // lead whose follower was a "Reece …" user (2026-10-23). None found: "a quick
  // call with our team". Rep voice keeps the follower-first read (the rollback).
  // 2026-10-24 (the user): F0_TEXT_VOICE=assistant writes as the rep's virtual
  // assistant, which needs a rep to be the assistant of: with no rep name found
  // the texts fall back to the Reece Team voice (never "our team's assistant").
  const wantVoice = !email && modes.f0Formula === 'four_step' ? modes.f0TextVoice : null;
  const teamLike = teamEmail || wantVoice === 'team' || wantVoice === 'assistant';
  const rehashRepFirst = teamLike
    ? (await resolveEmailRepFirst(request.contact_id, { env, deps })) || ''
    : await resolveRehashRepFirst(request.contact_id, { env, deps });
  const textVoice = wantVoice === 'assistant' && !rehashRepFirst ? 'team' : wantVoice;
  const teamText = textVoice === 'team' || textVoice === 'assistant';
  const textCallWith = teamText ? rehashRepFirst || null : null;
  const followupTextLive = modes.followupText === 'live';
  const vars = {
    ...presentationTemplateVars(facts, { followupTextLive }),
    rehash_rep_first_name: rehashRepFirst,
    ...(email ? { email_voice: emailVoice } : {}),
    ...(teamEmail ? { call_with: rehashRepFirst || F0_TEAM_CALL_FALLBACK } : {}),
    ...(textVoice ? { text_voice: textVoice } : {}),
    ...(teamText ? { call_with: textCallWith || F0_TEAM_CALL_FALLBACK } : {}),
    days_since_demo: Number.isFinite(age) ? String(Math.floor(age / 24)) : '',
    earlier_closes: earlierClosesLine(earlierOutbound(context?.conversation_recent || [])),
    recording_id: facts?.recording_id || '',
    presentation: facts,
  };
  // 2026-10-19 (Mark, ruling 6): the Four-Step prompts (F0_FORMULA_MODE=
  // four_step) read the visit as <visit_facts> (no price, no sensitive detail)
  // and are picked by Siro's MAIN objection: v1 picked by the first moment
  // type, so 8 of 10 preview leads got the price variant, Mr. Jackson's
  // "decision maker not present" included.
  // The position-0 email reads the same <visit_facts> whatever the text
  // formula (one prompt row serves v1 and four_step), plus the person who
  // visited, whom it may name once (Mark, 2026-10-21).
  if (modes.f0Formula === 'four_step' || email) {
    // 2026-10-20: the formula opens on the first name. A couple's field
    // ("George/Paula") is no name to the reply writer, so it is read here and
    // its first person used; with none at all the text opens without a name.
    // A linked test contact's name is its own, never the real lead's. A lone
    // initial in GHL is no name: LP's lead is read instead (greetingName).
    let firstName = greetingName(lead.first_name);
    if (!firstName && demoLeadId && !testLink) {
      firstName = await safe('lp_leads first_name', async () => {
        const { data, error } = await supabase.from('lp_leads').select('first_name').eq('lp_lead_id', demoLeadId).limit(1);
        if (error) throw new Error(error.message);
        return greetingName(data?.[0]?.first_name);
      }, '');
    }
    vars.first_name = firstName || '';
    const objectionType = fourStepObjectionType(facts);
    if (modes.f0Formula === 'four_step') vars.formula = 'four_step';
    vars.objection_type = objectionType;
    vars.story_angle = STORY_ANGLES[objectionType] || STORY_ANGLES.none;
    vars.visit_facts = buildVisitFacts(facts, {
      firstName: vars.first_name, repFirstName: rehashRepFirst, followupTextLive,
      ...(email ? { visitedBy: facts?.rep_first_name || '' } : {}),
    });
  }
  const wait = waitFor(facts);
  return {
    facts,
    rows,
    vars,
    recordingId: facts?.recording_id || null,
    testLink: testLink || null,
    earlierMessages: earlierOutbound(context?.conversation_recent || []),
    interruptInput: {
      lpSold: sold,
      unsoldPostDemo: testLink ? true : isUnsoldPostDemo({ postAppointment, rehash: rehashActive, sold }),
      rehashActive: testLink ? true : rehashActive,
      newerLead: testLink ? false : newerLead,
      appointmentOnFile: testLink ? false : !!appointmentOnFile({ upcomingAppointments: [], lp, nowMs }),
      noteDq: testLink ? false : !!context?.lead_facts?.note_dq,
      postDemoStop: postDemoStopFrom({ conversation: context?.conversation_recent || [], tags }),
      repliedSinceLastTouch: repliedSince({ conversation: context?.conversation_recent || [], lastTouchAt: lastTouch }),
      rehashOwned: ownedLive,
      tags,
      siroFacts: facts,
      demoAgeH: age,
      waitMaxH: wait.waitMaxH,
      waitHoldH: wait.waitHoldH,
    },
  };
}
