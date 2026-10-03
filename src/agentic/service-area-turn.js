/**
 * Service-area turns, zip first — src/agentic/service-area-turn.js
 *
 * WHY (2026-09-30, live evidence): all three real website-chat visitors that
 * day opened with "do you serve my area?" (Flagler Beach 32136, The Villages,
 * Dallas TX). GHL's Conversation AI dodged every one, and asked the
 * out-of-area Dallas visitor for his ADDRESS. The agentic bot had no answer
 * of its own either: the live-chat lane never ran a service-area check, and
 * the SMS path only recognised a bare zip in the Florida range (3xxxx), so
 * "77002" was invisible.
 *
 * MARK'S RULING 4 (2026-09-30): when anyone asks whether Reece serves their
 * area, the bot ALWAYS asks for their zip code before confirming coverage,
 * unless they already gave a zip in this conversation (a zip on the CRM
 * record does not count — the question is about the place they are asking
 * about). Coverage is then answered from the zip lookup, plainly, in the
 * first sentence of the next reply.
 *
 *   needs zip      → the reply asks for the zip, first and ONLY question; no
 *                    name / phone / email ask, no "Good question".
 *   in area        → first sentence "Yes, we serve <city> (<zip>)." then on.
 *   out of area    → say plainly Reece doesn't serve it, thank them, stop.
 *                    No address, phone, email or booking ask.
 *   lookup failed  → "Let me have a team member confirm coverage for <zip>."
 *   zip refused    → a place that maps to exactly ONE market may answer;
 *                    otherwise a team member confirms. The zip is never
 *                    asked for twice.
 *
 * Shared by the live-chat fast lane and generateResponse (the SMS / email
 * reply path), which build the same prompt. Pure: the lookup arrives from the
 * caller, so this whole file unit-tests without a database.
 */

// ── detection ──────────────────────────────────────────────────────────────

// Words that make "do you service X" about a PRODUCT, not a place.
const PRODUCT_OBJECT_RX = /^(?:the\s+|my\s+|our\s+|your\s+|existing\s+|old\s+)?(?:windows?|doors?|glass|sliders?|sliding|impact|hurricane|shutters?|garage|frames?|screens?|repairs?|warrant(?:y|ies)|installs?|installations?|homes?\s+you|ones?\s+you|what\s+you|products?|brands?|vinyl|aluminum|commercial|condos?|mobile|manufactured)\b/i;

// "do you service/serve/cover/come to/work in …" and friends.
const VERB_PLACE_RX = /\b(?:do|does|can|will|would|are|r)\s+(?:you|y'?all|u|reece|your\s+(?:company|team|crews?|guys))(?:\s+guys)?(?:\s+(?:still|also|even|currently|guys))?\s+(service|serve|serving|servicing|cover|covering|come|coming|travel|go|going|work|working|install|installing|operate|operating|available|located|based|in|near|around|out)\b\s*(?:(to|in|into|out\s+to|out\s+in|near|around|at|on|for|the|by)\b\s*)?([^?.!\n]{0,60})/i;

// 2026-10-03 (Mark's thread): "But I don't think your service our area." is a
// coverage question too. It was not one, so the bot answered "good chance you're
// covered" with no zip ask. Any "serve/service/cover … our area" now counts.
const AREA_PHRASE_RX = /\b(?:service|coverage)\s+areas?\b|\b(?:in|within|inside|part\s+of)\s+your\s+(?:service\s+)?area\b|\bareas?\s+(?:do\s+)?(?:you|y'?all)\s+(?:serve|service|cover|work)\b|\bwhere\s+(?:do|does)\s+(?:you|reece)\s+(?:serve|service|cover|work|install)\b|\bis\s+(?:my|our|this|that)\s+(?:area|zip|town|city|county|neighborhood)\s+(?:covered|served|serviced|included)\b|\b(?:cover|covering|serve|serving|service|servicing|come\s+(?:out\s+)?to)\s+(?:my|our|this|that)\s+(?:area|zip|town|city|county|neighborhood)\b/i;

// Verbs that only mean "coverage" with a locative preposition after them
// ("work in Dallas" yes, "work on weekends" no).
const NEEDS_PREPOSITION = new Set(['work', 'working', 'install', 'installing', 'operate', 'operating', 'available', 'go', 'going', 'come', 'coming', 'travel', 'out', 'located', 'based']);
const LOCATIVE = new Set(['to', 'in', 'into', 'out to', 'out in', 'near', 'around', 'at', 'by']);

/** True when the message asks whether Reece serves a place. Pure. */
export function isCoverageQuestion(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (AREA_PHRASE_RX.test(t)) return true;
  const m = VERB_PLACE_RX.exec(t);
  if (!m) return false;
  const verb = m[1].toLowerCase();
  const prep = (m[2] || '').toLowerCase().replace(/\s+/g, ' ');
  const object = (m[3] || '').trim();
  if (verb === 'in' || verb === 'near' || verb === 'around') {
    // "are you in my area", "are you near Ocala" — but not "are you in business"
    return /^(?:my|our|the|this|that)?\s*(?:area|town|city|county|neighborhood)\b/i.test(object)
      || (!!extractPlace(object) && !/^(?:business|stock|person|charge|network)\b/i.test(object));
  }
  if (NEEDS_PREPOSITION.has(verb) && !LOCATIVE.has(prep)) return false;
  if (PRODUCT_OBJECT_RX.test(object)) return false;
  return !!object;
}

const ZIP_KEYWORD_RX = /\bzip(?:\s*code)?\s*(?:is|:|=|#)?\s*(\d{5})(?:-\d{4})?\b/i;
const BARE_ZIP_RX = /^\s*(?:it'?s\s+|its\s+|my\s+zip\s+is\s+)?(\d{5})(?:-\d{4})?\s*[.!]?\s*$/i;
// A 5-digit token that is not money, a measurement or a count.
const INLINE_ZIP_RX = /(^|[^\d$#.,])(\d{5})(?:-\d{4})?(?![\d,.]|\s*(?:sq|square|ft|feet|dollars|bucks|k\b|windows?|doors?|btu|lbs?|miles?|%))/gi;

function validZip(z) {
  return /^\d{5}$/.test(z) && z !== '00000' && Number(z) >= 501;
}

/**
 * A US zip the visitor typed. `loose` (the message is a coverage question)
 * also accepts a zip inside a sentence ("Do you serve Houston? 77002");
 * otherwise only "zip is 12345" or a message that is just the zip counts,
 * so window counts and prices are never mistaken for a zip. Pure.
 */
export function extractZip(text, { loose = false } = {}) {
  const t = String(text || '');
  const kw = ZIP_KEYWORD_RX.exec(t);
  if (kw && validZip(kw[1])) return kw[1];
  const bare = BARE_ZIP_RX.exec(t);
  if (bare && validZip(bare[1])) return bare[1];
  if (!loose) return null;
  INLINE_ZIP_RX.lastIndex = 0;
  let m;
  while ((m = INLINE_ZIP_RX.exec(t)) !== null) {
    if (validZip(m[2])) return m[2];
  }
  return null;
}

const NOT_A_PLACE_RX = /^(?:my|our|this|that|your|me|us|here|there|it|them|you|area|zone|region|everywhere|anywhere|all|any|which|what|where)\b/i;
const STATE_TAIL_RX = /(?:,?\s+(?:fl|fla|florida|tx|texas|nc|north\s+carolina|ga|georgia|sc|al))\.?$/i;

/** The place named in a coverage question, or null. Pure. */
export function extractPlace(text) {
  let s = String(text || '').replace(/\b\d{5}(?:-\d{4})?\b/g, ' ').replace(/[?!.,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  // Cut at the first word that ends the place ("palm coast fl area please")
  s = s.replace(/\s+(?:area|areas|region|county\s+area|please|pls|thanks|thank\s+you|or\s+not|at\s+all|yet|still|too|also|now|and\b.*|for\b.*|with\b.*|if\b.*|because\b.*|since\b.*).*$/i, '').trim();
  s = s.replace(STATE_TAIL_RX, '').trim();
  // "the Jacksonville area" → Jacksonville, but "The Villages" is the name.
  if (!/^the\s+(?:villages|woodlands|acreage|hammocks|crossings|meadows|landings)\b/i.test(s)) s = s.replace(/^the\s+/i, '');
  if (!s || NOT_A_PLACE_RX.test(s)) return null;
  if (s.split(' ').length > 5) return null;
  if (PRODUCT_OBJECT_RX.test(s)) return null;
  return s.replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

/** The place in a coverage question, from the whole message. Pure. */
export function placeFromQuestion(text) {
  const m = VERB_PLACE_RX.exec(String(text || ''));
  if (m && m[3]) {
    const p = extractPlace(m[3]);
    if (p) return p;
  }
  const inMatch = /\b(?:in|to|near|around)\s+([A-Za-z][A-Za-z .'-]{1,40})/i.exec(String(text || ''));
  return inMatch ? extractPlace(inMatch[1]) : null;
}

const REFUSE_RX = /\b(?:rather\s+not|prefer\s+not|don'?t\s+(?:want|wanna|feel\s+comfortable)|not\s+(?:giving|comfortable|sharing)|why\s+do\s+you\s+need|just\s+tell\s+me|no\s+thanks|none\s+of\s+your|skip\s+that)\b/i;

// ── conversation helpers ───────────────────────────────────────────────────

const textOf = (m) => String(m?.text ?? m?.body ?? m?.message ?? '');
const isInbound = (m) => /^(?:inbound|in)$/i.test(String(m?.direction || ''));
const isOutbound = (m) => /^(?:outbound|out)$/i.test(String(m?.direction || ''));

/** Earlier messages, oldest first, without the trigger itself at the end. */
function priorMessages(conversation, trigger) {
  const conv = Array.isArray(conversation) ? conversation.slice() : [];
  const last = conv[conv.length - 1];
  if (last && isInbound(last) && textOf(last).trim() === String(trigger || '').trim()) conv.pop();
  return conv;
}

function lastOutboundAskedZip(prior) {
  for (let i = prior.length - 1; i >= 0; i--) {
    // Our booking ask for the visit address ("street address … zip code?")
    // is not a coverage question (2026-10-03 replay: the address reply ran as
    // a coverage turn, skipped the booking plan, and the visit never booked).
    if (isOutbound(prior[i])) return /\bzip\b/i.test(textOf(prior[i])) && textOf(prior[i]).includes('?') && !/\baddress\b/i.test(textOf(prior[i]));
  }
  return false;
}

// ── the plan ───────────────────────────────────────────────────────────────

/**
 * What this turn owes the visitor on coverage. Pure.
 *
 * @returns {{ active: boolean, coverage_question: boolean, zip: string|null,
 *             place: string|null, needs_zip: boolean, asked_before: boolean,
 *             refused_zip: boolean }}
 */
export function planServiceAreaTurn({ trigger, conversation = [] } = {}) {
  const prior = priorMessages(conversation, trigger);
  const inboundPrior = prior.filter(isInbound).map(textOf);
  const coverage = isCoverageQuestion(trigger);
  const askedBefore = lastOutboundAskedZip(prior);
  // A coverage question in the last few inbound messages keeps the topic open.
  const recentCoverage = inboundPrior.slice(-4).find(isCoverageQuestion) || null;
  const triggerZip = extractZip(trigger, { loose: coverage || !!recentCoverage || askedBefore });
  const bareZip = BARE_ZIP_RX.test(String(trigger || ''));

  const active = coverage || (!!triggerZip && (askedBefore || !!recentCoverage || bareZip)) || (askedBefore && !!recentCoverage);
  if (!active) {
    return { active: false, coverage_question: false, zip: null, place: null, needs_zip: false, asked_before: askedBefore, refused_zip: false };
  }
  let zip = triggerZip;
  if (!zip) {
    for (let i = inboundPrior.length - 1; i >= 0 && !zip; i--) {
      zip = extractZip(inboundPrior[i], { loose: isCoverageQuestion(inboundPrior[i]) });
    }
  }
  const place = (coverage ? placeFromQuestion(trigger) : null)
    || (recentCoverage ? placeFromQuestion(recentCoverage) : null)
    || (askedBefore && !zip ? extractPlace(trigger) : null);
  const needsZip = !zip;
  return {
    active: true,
    coverage_question: coverage,
    zip: zip || null,
    place: place || null,
    needs_zip: needsZip,
    asked_before: askedBefore,
    // Asked once already and still no zip: never ask a second time.
    refused_zip: needsZip && askedBefore && (REFUSE_RX.test(String(trigger || '')) || !coverage),
  };
}

// ── the answer ─────────────────────────────────────────────────────────────

export const ZIP_ASK_LINE = "Happy to check that for you. What's your zip code?";

/**
 * Fold the plan and the lookups into one status. Pure.
 *   zipResult:   checkServiceAreaZip shape { checked, zip, in_service_area, city, market_code } or null (timed out)
 *   placeResult: { checked, market_codes: [...], city } or null
 */
export function resolveCoverage(plan, { zipResult = null, placeResult = null } = {}) {
  if (!plan?.active) return null;
  const base = { zip: plan.zip, place: plan.place, city: null, market_code: null };
  if (plan.zip) {
    if (!zipResult || !zipResult.checked) return { ...base, status: 'unknown' };
    if (zipResult.in_service_area) return { ...base, status: 'in', city: zipResult.city || null, market_code: zipResult.market_code || null };
    return { ...base, status: 'out' };
  }
  if (!plan.refused_zip) return { ...base, status: 'ask_zip' };
  const codes = placeResult?.checked ? [...new Set(placeResult.market_codes || [])] : [];
  if (codes.length === 1) return { ...base, status: 'place_in', city: placeResult.city || plan.place, market_code: codes[0] };
  return { ...base, status: 'place_unknown' };
}

/** The deterministic sentence for a status — the fallback and the guard's yardstick. Pure. */
export function coverageSentence(res) {
  if (!res) return null;
  switch (res.status) {
    case 'ask_zip': return ZIP_ASK_LINE;
    case 'in': return res.city ? `Yes, we serve ${res.city} (${res.zip}).` : `Yes, we serve the ${res.zip} area.`;
    case 'out': return `Sorry, Reece doesn't serve the ${res.zip} area. Thank you for checking with us.`;
    case 'unknown': return `Let me have a team member confirm coverage for ${res.zip}.`;
    case 'place_in': return `Yes, we serve the ${res.city || res.place} area.`;
    case 'place_unknown': return 'No problem. A team member will confirm whether we cover your area.';
    default: return null;
  }
}

/** The prompt hint for this turn. Pure. */
export function coverageHint(res) {
  if (!res) return null;
  const s = coverageSentence(res);
  switch (res.status) {
    case 'ask_zip':
      return 'SERVICE AREA QUESTION — ZIP FIRST: the visitor asked whether Reece serves their area and has not given a zip code in this conversation. ' +
        'Coverage is confirmed ONLY by zip code. This reply asks for their zip code and nothing else, friendly and direct, e.g. ' +
        `"${ZIP_ASK_LINE}" It is the first and ONLY question. Do NOT confirm or deny coverage yet. Do NOT ask for their name, phone, email or address. Do not open with "Good question".`;
    case 'in':
    case 'place_in':
      return `SERVICE AREA RESULT: ${res.zip ? `zip ${res.zip}` : res.place} is IN Reece's service area${res.city ? ` (${res.city})` : ''}. ` +
        `Your reply's FIRST sentence must be exactly: "${s}" Then continue normally; the discovery discipline still applies.`;
    case 'out':
      return `SERVICE AREA RESULT: zip ${res.zip} is OUTSIDE Reece's service area. Say so plainly in the FIRST sentence, thank them, and stop: ` +
        `e.g. "${s}" No question. Do NOT ask for an address, phone, email, name or a visit, and do not pitch. This rule overrides every other instruction about collecting details.`;
    case 'unknown':
      return `SERVICE AREA RESULT: the coverage check for zip ${res.zip} did not finish. Your reply's FIRST sentence must be exactly: "${s}" ` +
        'Then continue normally. Do NOT say we do or do not serve it.';
    case 'place_unknown':
      return `SERVICE AREA RESULT: the visitor would rather not give a zip, and the place they named does not settle it. Your reply's FIRST sentence must be: "${s}" ` +
        'Do not ask for the zip again.';
    default: return null;
  }
}

// ── the guard ──────────────────────────────────────────────────────────────

const CONTACT_ASK_RX = /\b(?:your|the\s+best|a\s+good)\s+(?:full\s+)?(?:name|phone|number|cell|email|e-mail|address|street)\b|\bwhat(?:'s|\s+is)\s+your\s+(?:name|phone|number|email|address)\b|\bwho\s+(?:am\s+i|do\s+i\s+have)\b/i;
const BOOKING_ASK_RX = /\b(?:schedule|book|set\s+up|come\s+out|visit|appointment|in-home|consultation|estimate|assessment|stop\s+by|morning|afternoon|evening|what\s+time|which\s+day|when\s+(?:works|would|is\s+good))\b/i;
const GOOD_QUESTION_RX = /^\s*(?:good|great)\s+question\b/i;

const splitSentences = (t) => String(t || '').split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
const questionCount = (t) => (String(t || '').match(/\?/g) || []).length;
const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Does the first sentence state this result? Pure. */
export function firstSentenceStates(draft, res) {
  const first = norm(splitSentences(draft)[0] || '');
  if (!first || !res) return false;
  const names = [res.zip, res.city, res.place].filter(Boolean).map(norm);
  const mentions = names.some((n) => first.includes(n));
  switch (res.status) {
    case 'in':
    case 'place_in':
      return mentions && /\b(?:serve|serves|service|services|cover|covers|in our service area)\b/.test(first) && !/\b(?:don t|doesn t|do not|does not|not in|outside)\b/.test(first);
    case 'out':
      return mentions && /\b(?:don t|doesn t|do not|does not|not|outside)\b/.test(first);
    case 'unknown':
      return /\bteam member\b/.test(first) && /\bconfirm\b/.test(first) && (!res.zip || first.includes(res.zip));
    case 'place_unknown':
      return /\bteam member\b/.test(first) && /\bconfirm\b/.test(first);
    default:
      return true;
  }
}

/**
 * Post-generation check of a draft against this turn's coverage result.
 * Returns the notes that ask for a regeneration and a deterministic `fixed`
 * draft; the caller picks by how much time is left, exactly like guardDraft.
 * Pure.
 */
export function guardCoverageDraft(draft, res) {
  const text = String(draft || '').trim();
  if (!res) return { notes: [], fixed: text };
  const sentence = coverageSentence(res);
  const notes = [];

  if (res.status === 'ask_zip') {
    const qs = splitSentences(text).filter((s) => s.includes('?'));
    const ok = questionCount(text) === 1 && qs.length === 1 && /\bzip\b/i.test(qs[0])
      && !CONTACT_ASK_RX.test(text) && !GOOD_QUESTION_RX.test(text)
      && !/\b(?:yes|we (?:do )?(?:serve|service|cover)|outside)\b/i.test(text.replace(qs[0], ''));
    if (!ok) {
      notes.push(`SERVICE AREA: your previous draft did not ask for the zip code as its one and only question. Ask ONLY for the zip code, e.g. "${ZIP_ASK_LINE}" No name, phone, email or address ask; do not confirm or deny coverage yet.`);
      return { notes, fixed: ZIP_ASK_LINE };
    }
    return { notes, fixed: text };
  }

  if (res.status === 'out') {
    const bad = questionCount(text) > 0 || CONTACT_ASK_RX.test(text) || BOOKING_ASK_RX.test(text) || !firstSentenceStates(text, res);
    if (bad) {
      notes.push(`SERVICE AREA: zip ${res.zip} is outside our service area. Your previous draft did not say so plainly first, or it still asked for something. Say we don't serve it, thank them, and stop, with no question: "${sentence}"`);
      return { notes, fixed: sentence };
    }
    return { notes, fixed: text };
  }

  if (!firstSentenceStates(text, res)) {
    notes.push(`SERVICE AREA: your previous draft's first sentence did not state the coverage result. Start with exactly: "${sentence}"`);
    // Prepend the sentence; drop any later sentence that re-states coverage
    // so the reply does not say it twice.
    // 2026-10-03 replay: the draft's own "No problem." stayed after our
    // "No problem. A team member will confirm…", so the reply said it twice.
    // A bare acknowledgement goes with the coverage sentence's own.
    const rest = splitSentences(text).filter((s) => !/\b(?:serve|service area|cover(?:age)?)\b/i.test(s)
      && !/^(?:no\s+problem|got\s+it|sure|okay|ok|of\s+course|sounds\s+good|understood)[.!]?$/i.test(s.trim()));
    return { notes, fixed: [sentence, ...rest].join(' ').trim() };
  }
  return { notes, fixed: text };
}

/** The execution_result record. Pure. */
export function serviceAreaRecord(plan, res) {
  if (!plan?.active || !res) return null;
  return { zip: res.zip || null, place: res.place || null, result: res.status, market_code: res.market_code || null };
}
