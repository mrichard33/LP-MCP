/**
 * Established Facts — src/agentic/established-facts.js
 *
 * What this conversation has already SETTLED, assembled before the reply is
 * drafted so the responder can be told what it is not allowed to ask again.
 *
 * WHY THIS EXISTS (2026-09-11, Alfredo Fontan — GHL VKMKhd8JQ4wsp3zMn8Lt,
 * conversation mivvUZnKmGScwo5FoVUR, LP lead 575210)
 * ──────────────────────────────────────────────────────────────────────────
 * At 19:37:37Z the analyzer read his inbound "Just myself." and wrote, in its
 * own reasoning (ai.analysis_completed event 3603318): "He is the sole
 * decision-maker." Nothing persisted that. The custom field stayed empty.
 *
 * At 21:11:55Z — one hour and thirty-four minutes later — the responder sent
 * outbound yFkfGW3AOmm9M8Myk7W8:
 *
 *   "Fair point, Alfredo — close is close. To get the visit scheduled
 *    correctly, will it just be you home, or is there someone else who'd
 *    want to be there?"
 *
 * It re-asked the question he had already answered, and conceded his objection
 * on the way in. The field was finally written at 21:25:22Z by the responder's
 * own QUALIFYING_DATA_PERSIST path (agent_actions 448555) — an hour and
 * forty-eight minutes after the fact was known, and one repeat-ask too late.
 *
 * The defect was not that the field was empty. It was that an empty field was
 * the ONLY place the responder looked. The lead's own words were sitting in
 * the transcript the whole time.
 *
 * WHAT THIS MODULE DOES
 * ─────────────────────
 * Resolves each fact through three tiers, highest first:
 *
 *   1. A populated GHL / LP field.
 *   2. The lead's OWN WORDS in the transcript — each outbound turn carrying a
 *      question is paired with the next inbound turn, and that inbound is read
 *      as the answer to it.
 *   3. Nothing. The fact is genuinely open and may be asked.
 *
 * `source` records which tier produced each fact, so a Bot Review replay can
 * tell a CRM read from a transcript inference. A fact is NEVER derived from an
 * outbound-only turn: us saying something is not them confirming it.
 *
 * PURE. No I/O, no writes, no env reads, no clock. Every input arrives as an
 * argument so scripts/test-established-facts.js can drive it directly.
 */

/**
 * The questions this module can close. A key appearing in `closed_questions`
 * means the responder is forbidden to ask it again — see closedQuestions() in
 * src/prompts/response-generator/context-frame.js for the binding wording.
 */
export const CLOSED_QUESTION_KEYS = Object.freeze([
  'decision_makers',
  'window_count',
  'address',
  'preferred_time',
  'prior_quotes',
  'email',
  'timeline',
]);

/** Human label per key, used in the rendered ESTABLISHED block. */
export const FACT_LABELS = Object.freeze({
  decision_makers: 'decision makers',
  window_count: 'window count',
  address: 'property address',
  preferred_time: 'preferred time',
  prior_quotes: 'prior quotes / other companies out',
  email: 'email address',
  timeline: 'timeline',
});

// ── Which question an OUTBOUND turn was asking ──────────────────────────
//
// Matched on intent, not wording. These are the phrasings our own outbounds
// actually use; an outbound must ALSO contain a question mark before any of
// them count, so a statement that merely mentions a topic never closes it.
const OUTBOUND_QUESTION_PATTERNS = Object.freeze({
  decision_makers: [
    /\b(?:anyone|anybody|someone|somebody)\s+else\b/i,
    /\bwho\s+else\b/i,
    /\bjust\s+(?:you|yourself)\b/i,
    /\bonly\s+you\b/i,
    /\bboth\s+(?:of\s+you\s+)?(?:be\s+)?(?:home|there|present|available)\b/i,
    /\bdecision[-\s]?makers?\b/i,
    /\byour\s+call\b/i,
    /\b(?:wife|husband|spouse|partner)\s+(?:be\s+)?(?:home|there|joining)\b/i,
  ],
  window_count: [
    /\bhow\s+many\b[^?]{0,40}\b(?:windows?|openings?|doors?)\b/i,
    /\bnumber\s+of\s+(?:windows?|openings?|doors?)\b/i,
    /\bwindow\s+count\b/i,
  ],
  address: [
    /\b(?:property|home|service|street|full|best)\s+address\b/i,
    /\bwhat(?:'s|\s+is)\s+the\s+address\b/i,
    /\bwhere\s+(?:is|are)\s+(?:the|your)\s+(?:home|house|property|windows?)\b/i,
    /\bzip\s*code\b/i,
  ],
  preferred_time: [
    /\bwhat\s+(?:day|time)\b/i,
    /\bmornings?\s+or\s+afternoons?\b/i,
    /\bwhich\s+(?:day|time|works)\b/i,
    /\bwhen\s+(?:works|would\s+work|is\s+good)\b/i,
    /\bwhat\s+works\s+(?:better|best)\b/i,
  ],
  prior_quotes: [
    /\bhad\s+(?:anyone|anybody|someone)\s+out\b/i,
    /\bhad\s+(?:any\s+)?(?:other\s+)?(?:quotes?|estimates?|bids?)\b/i,
    /\bother\s+(?:companies|quotes?|estimates?|bids?)\b/i,
    /\bshopping\s+around\b/i,
    /\btalked\s+to\s+(?:anyone|any\s+other)\b/i,
  ],
  email: [
    /\bemail\s+address\b/i,
    /\b(?:best|good|an?)\s+email\b/i,
    /\bwhere\s+(?:should|can|do)\s+(?:i|we)\s+send\b/i,
  ],
  timeline: [
    /\bhow\s+soon\b/i,
    /\btime\s*frame\b/i,
    /\btimeline\b/i,
    /\bwhen\s+(?:are|were)\s+you\s+(?:looking|hoping|planning)\b/i,
    /\bthis\s+year\s+or\b/i,
  ],
});

// ── What an INBOUND answer means, where a value can be read off it ──────
//
// Deliberately conservative. A question is closed by the PAIRING — an outbound
// question followed by an inbound — whether or not a machine-readable value
// falls out. `value` may be null and the fact still stands, because the lead's
// own words are what the responder is told to reference.
const SOLO_OWNER_RX = /\b(?:just\s+(?:me|myself|mine)|only\s+me|myself\s+only|by\s+myself|it'?s\s+(?:just\s+)?me|me\s+only|solo|i'?m\s+the\s+only\s+one|my\s+(?:call|decision)\s+(?:alone|only)?)\b/i;
const BOTH_PRESENT_RX = /\b(?:both\s+of\s+us|we'?ll\s+both|my\s+(?:wife|husband|spouse|partner)\s+(?:and|will|too)|we\s+both|us\s+both|yes,?\s+both)\b/i;
const NEGATIVE_DM_RX = /\b(?:(?:she|he|they)\s+(?:won'?t|can'?t|will\s+not)\s+be|not\s+(?:be\s+)?(?:home|there|available)|(?:she|he|they)'?s?\s+(?:out\s+of\s+town|traveling|working))\b/i;

/** Read a decision-maker value off the lead's own answer. Null when unclear. */
function readDecisionMakers(text) {
  const s = String(text || '');
  if (SOLO_OWNER_RX.test(s)) return 'Solo Owner';
  if (BOTH_PRESENT_RX.test(s)) return 'Yes';
  if (NEGATIVE_DM_RX.test(s)) return 'No';
  return null;
}

/** Read a window/opening count off the lead's own answer. Null when unclear. */
function readWindowCount(text) {
  const s = String(text || '');
  const m = s.match(/\b(\d{1,3})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n <= 300 ? String(n) : null;
}

/** Per-key reader. Keys with no reader close on the pairing alone. */
const INBOUND_VALUE_READERS = Object.freeze({
  decision_makers: readDecisionMakers,
  window_count: readWindowCount,
});

// ── Offers we have already made ─────────────────────────────────────────
const OFFER_PATTERNS = Object.freeze([
  ['slots', /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i],
  ['visit', /\b(?:specialist|come\s+out|in-?home|measure|stop\s+by|swing\s+by|get\s+(?:someone|somebody)\s+out)\b/i],
  ['guide', /\b(?:guide|send\s+(?:you\s+)?(?:over\s+)?(?:some\s+)?(?:info|information|details|something)|pdf|breakdown)\b/i],
  ['callback', /\b(?:give\s+you\s+a\s+call|call\s+you|have\s+(?:someone|somebody)\s+call|get\s+(?:someone|somebody)\s+on\s+the\s+phone)\b/i],
]);

// An apology in an outbound. The point of tracking these is that a SECOND
// apology for the same mistake reads as a script, not as contrition.
const APOLOGY_RX = /\b(?:sorry|apologies|apologize|apologise|my\s+apolog\w+)\b/i;

// ── Objections the lead has raised, in their own words ──────────────────
const OBJECTION_PATTERNS = Object.freeze([
  ['price', /\b(?:too\s+(?:expensive|much|high|pricey)|can'?t\s+afford|out\s+of\s+(?:my|our)\s+(?:budget|range)|that'?s\s+a\s+lot|pricey|steep|cheaper)\b/i],
  // "almost signed with them that same evening" — Alfredo, 19:54:44Z. A lead
  // telling us how close they came to signing elsewhere is the single most
  // actionable objection in the thread, and it is the one the 21:11 reply
  // conceded rather than answered.
  ['competitor', /\b(?:another\s+(?:company|contractor|vendor)|other\s+(?:company|companies|quotes?|bids?)|last\s+company\s+that\s+came\s+out|already\s+(?:signed|talking|got\s+a\s+quote)|close\s+is\s+close|(?:almost|nearly)\s+signed|went\s+with|sat\s+through\s+several\s+presentations)\b/i],
  ['timing', /\b(?:not\s+right\s+now|maybe\s+later|next\s+year|after\s+the\s+holidays|need\s+(?:some\s+)?time|not\s+ready)\b/i],
  ['spouse', /\b(?:talk\s+to\s+my\s+(?:wife|husband|spouse|partner)|run\s+it\s+by|check\s+with\s+my)\b/i],
  ['trust', /\b(?:scam|legit|never\s+heard\s+of|reviews?\b[^?]{0,20}\byou|who\s+are\s+you\s+really)\b/i],
]);

// ── helpers ─────────────────────────────────────────────────────────────

const HAS_QUESTION_RX = /\?/;

/** Normalize a turn to { direction, text, at, channel }. Tolerates shapes. */
function normalizeTurn(m) {
  if (!m || typeof m !== 'object') return null;
  const raw = m.direction;
  const direction = raw === 'inbound' || raw === 1 || raw === '1' ? 'inbound' : 'outbound';
  const text = String(m.text ?? m.body ?? m.message ?? '').trim();
  return {
    direction,
    text,
    at: m.timestamp ?? m.at ?? m.dateAdded ?? null,
    channel: m.channel ?? null,
  };
}

/**
 * Wall-clock label for a timestamp, in the prompt's timezone.
 * Pure given `timezone`; returns null for anything unparseable so a bad
 * timestamp degrades to "no time stated" rather than "Invalid Date".
 */
export function formatFactTime(at, timezone = 'America/New_York') {
  if (!at) return null;
  const ms = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(ms));
  } catch {
    return null;
  }
}

/** Trim a quote to something a prompt line can carry without swallowing it. */
function quote(text, max = 220) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** First non-empty value among the candidates, trimmed. Null otherwise. */
function firstPresent(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s && s.toLowerCase() !== 'null' && s.toLowerCase() !== 'undefined') return s;
  }
  return null;
}

/** The address on file, assembled the same way the booking gate assembles it. */
function composeAddress(lead) {
  if (!lead?.address1) return null;
  return [lead.address1, lead.city, lead.state, lead.postal_code].filter(Boolean).join(', ');
}

// ── tier 1: the CRM fields ──────────────────────────────────────────────
//
// Field ids verified live on VKMKhd8JQ4wsp3zMn8Lt, 2026-09-11:
//   decision makers  GH1QGGOseMKmJAMqajiN   (select: Yes|No|Solo Owner|Uncertain)
//   window count     h9FJTUbmUHIuD6JKmpXv   (number)
//   preferred time   7lpRWFDM8DZbLd3viHEG   (text)
// They reach this module already decoded onto `lead` / `lp` / `estimate` by
// src/context-builder.js — this module never reads GHL itself.
function fieldFacts({ lead, lp, estimate }) {
  const out = {};
  const dm = firstPresent(lead?.decision_makers_present);
  if (dm && dm !== 'Uncertain') out.decision_makers = dm;

  const wc = firstPresent(estimate?.window_count, lead?.window_count);
  if (wc) out.window_count = wc;

  const addr = composeAddress(lead);
  if (addr) out.address = addr;

  const pt = firstPresent(lead?.preferred_estimate_time, lp?.preferred_estimate_time, lead?.preferred_time);
  if (pt) out.preferred_time = pt;

  const email = firstPresent(lead?.email);
  if (email) out.email = email;

  return out;
}

// ── tier 2: the lead's own words ────────────────────────────────────────
//
// Pair each OUTBOUND turn that asks a question with the NEXT INBOUND turn.
// That inbound is the answer to it. An outbound question with no inbound after
// it closes NOTHING — the question was asked and never answered, which is
// exactly the state in which asking again is correct.
function transcriptFacts(turns) {
  const out = {};
  for (let i = 0; i < turns.length; i += 1) {
    const t = turns[i];
    if (t.direction !== 'outbound' || !t.text || !HAS_QUESTION_RX.test(t.text)) continue;

    // The reply to THIS outbound: the next inbound turn, if one exists before
    // the conversation ends.
    let answer = null;
    for (let j = i + 1; j < turns.length; j += 1) {
      if (turns[j].direction === 'inbound') { answer = turns[j]; break; }
      // Another outbound in between is fine — reps double-text. Keep looking.
    }
    if (!answer || !answer.text) continue;

    for (const [key, patterns] of Object.entries(OUTBOUND_QUESTION_PATTERNS)) {
      if (!patterns.some(rx => rx.test(t.text))) continue;
      const reader = INBOUND_VALUE_READERS[key];
      const candidate = {
        value: reader ? reader(answer.text) : null,
        their_words: quote(answer.text),
        at: answer.at,
        asked_at: t.at,
      };
      // Later answers supersede earlier ones: if they revised it, the revision
      // is the fact. An earlier answer that produced a value is not thrown
      // away for a later one that produced none.
      const prior = out[key];
      if (!prior || candidate.value !== null || prior.value === null) out[key] = candidate;
    }
  }
  return out;
}

// ── the rest of the ledger ──────────────────────────────────────────────

function collectOffers(turns) {
  const offers = [];
  for (const t of turns) {
    if (t.direction !== 'outbound' || !t.text) continue;
    for (const [kind, rx] of OFFER_PATTERNS) {
      const m = t.text.match(rx);
      if (m) offers.push({ kind, at: t.at, detail: quote(m[0], 60) });
    }
  }
  return offers;
}

function collectApologies(turns) {
  const out = [];
  for (const t of turns) {
    if (t.direction !== 'outbound' || !t.text) continue;
    if (!APOLOGY_RX.test(t.text)) continue;
    // The sentence the apology lives in is what it was FOR.
    const sentence = t.text.split(/(?<=[.!?])\s+/).find(s => APOLOGY_RX.test(s)) || t.text;
    out.push({ for: quote(sentence, 160), at: t.at });
  }
  return out;
}

function collectObjections(turns, intelligence) {
  const out = [];
  for (let i = 0; i < turns.length; i += 1) {
    const t = turns[i];
    if (t.direction !== 'inbound' || !t.text) continue;
    for (const [type, rx] of OBJECTION_PATTERNS) {
      if (!rx.test(t.text)) continue;
      const answered = turns.slice(i + 1).find(x => x.direction === 'outbound' && x.text);
      out.push({
        type,
        at: t.at,
        // 400, not the 220 the facts use. An objection IS its wording — the
        // reply has to answer the actual sentence, and on the Alfredo thread
        // the operative clause ("I almost signed with them that same evening")
        // sits past character 230 of a 91-word message. Truncating it hands
        // the responder the setup and not the objection.
        their_words: quote(t.text, 400),
        how_we_answered: answered ? quote(answered.text, 200) : null,
      });
    }
  }
  // The analyzer's own verdict, when the transcript scan found nothing of that
  // family. Never overrides the lead's words — it only fills a silence.
  const declared = intelligence?.objection_type;
  if (declared && !out.some(o => o.type === declared)) {
    out.push({ type: declared, at: null, their_words: null, how_we_answered: null });
  }
  return out;
}

/**
 * Build the established-facts ledger for one turn.
 *
 * @param {object}   input
 * @param {object[]} input.conversation  conversation_recent, oldest first
 * @param {object}   input.lead          context.lead
 * @param {object}   input.lp            context.lp
 * @param {object}   input.intelligence  context.intelligence
 * @param {object}   [input.estimate]    context.estimate
 * @param {string}   [input.timezone]    for the `at_human` labels
 * @returns {{facts: object[], closed_questions: string[], offers_made: object[],
 *            apologies_made: object[], objections_raised: object[]}}
 */
export function buildEstablishedFacts({
  conversation = [],
  lead = null,
  lp = null,
  intelligence = null,
  estimate = null,
  timezone = 'America/New_York',
} = {}) {
  const turns = (Array.isArray(conversation) ? conversation : [])
    .map(normalizeTurn)
    .filter(Boolean);

  const fromFields = fieldFacts({ lead, lp, estimate });
  const fromTranscript = transcriptFacts(turns);

  const facts = [];
  for (const key of CLOSED_QUESTION_KEYS) {
    const fieldValue = fromFields[key] ?? null;
    const said = fromTranscript[key] ?? null;

    if (fieldValue !== null) {
      // Tier 1 wins. When the transcript says something different, BOTH are
      // recorded: the responder still gets to reference what they actually
      // said, and a Bot Review replay can see the disagreement.
      const fact = {
        key,
        value: fieldValue,
        source: 'field',
        their_words: said?.their_words ?? null,
        at: said?.at ?? null,
        at_human: formatFactTime(said?.at, timezone),
      };
      if (said && said.value !== null && said.value !== fieldValue) {
        fact.conflict = {
          value: said.value,
          source: 'transcript',
          their_words: said.their_words,
          at: said.at,
        };
      }
      facts.push(fact);
      continue;
    }

    if (said) {
      // Tier 2. This is the tier that was missing on 2026-09-11 and the reason
      // "Just myself." was asked for twice.
      facts.push({
        key,
        value: said.value,
        source: 'transcript',
        their_words: said.their_words,
        at: said.at,
        at_human: formatFactTime(said.at, timezone),
      });
    }
    // Tier 3: nothing. The fact is genuinely open — it is absent from `facts`
    // and from `closed_questions`, and may be asked.
  }

  return {
    facts,
    closed_questions: facts.map(f => f.key),
    offers_made: collectOffers(turns),
    apologies_made: collectApologies(turns),
    objections_raised: collectObjections(turns, intelligence),
  };
}

export const ESTABLISHED_FACTS_VERSION = '1.0';
