/**
 * Identity Extraction & Promotion — src/services/identity-extraction.js
 *
 * v1.1 — Victor Lopez incident (GHL XdAUR9qR42UdBre6Byrw, 2026-07-04).
 * A live-chat lead gave his full name, phone, and street address in chat;
 * none of it reached the GHL STANDARD fields (the record stayed
 * "Guest Visitor bljpx" with no address), and a Saturday slot was held
 * with decision-maker presence unconfirmed.
 *
 * This module owns the four pieces that prevent a recurrence:
 *
 *   1. HYDRATION (R5): read what the GHL record already knows, so the bot
 *      NEVER asks the prospect for a field already on file. A field counts
 *      as "known" when present on the record OR extracted from the
 *      conversation. Placeholder names ("Guest Visitor xxxxx") count as
 *      MISSING, not known.
 *
 *   2. EXTRACTION (R1): pull identity out of the running conversation —
 *      a deterministic heuristic pass on every inbound message (cheap,
 *      no LLM), plus a structured-output LLM pass at booking intent.
 *
 *   3. PROMOTION (R1): write extracted values to the GHL STANDARD fields
 *      (firstName/lastName, phone, email, address1, city, state,
 *      postalCode) — fill-if-empty, never silently overwrite; conflicts
 *      are logged to system_events. The promotion payload NEVER contains
 *      a `tags` key (GHL PUT /contacts/{id} wholesale-replaces the tag
 *      array — Kristen Nichols 2026-05-19, LP Enrichment 2026-05-15).
 *
 *   4. BOOKING GATE (R2/R3/R4): an in-home appointment may never be
 *      offered as held/booked without a real name, phone, property
 *      address, and the decision-maker question having been asked.
 *      decision_maker_confirmed === true → status "confirmed"; false or
 *      "unknown" → status "new". Email is asked ONCE, only when missing
 *      everywhere (soft — a decline never blocks).
 *
 * Consumers: response-generator.js (gate + prompt hydration),
 * message-analyzer.js (per-inbound heuristic pass), actions/handlers/
 * appointments.js (hard backstop before appointment creation),
 * scripts/remediate-guest-visitors.js (one-time remediation).
 */

import { callLLM } from '../llm-client.js';
import { emitEvent } from '../event-emitter.js';
import { updateGHLContactStandardFields, removeGHLTags } from '../ghl.js';
import { extractPreferredTime, persistPreferredTime } from './preferred-time.js';
import { scrubUrlsForExtraction } from '../email-thread.js';
import supabase from '../supabase.js';

// Live-chat widget placeholder ("Guest Visitor bljpx"). Matched against the
// full name AND the raw first name. "Guy Visitorson" must NOT match.
export const PLACEHOLDER_NAME_RE = /^guest\s+visitor\b/i;

// Tag applied by I.CN v2.2 when it skips normalization on a placeholder
// name; removed here once a real name is promoted.
export const NAME_PLACEHOLDER_TAG = 'name-placeholder';

// Stamped when the prompt instructs the bot to ask for an email, so the
// ask happens at most once (R4: asked-once, never a hard block).
export const EMAIL_ASKED_TAG = 'booking:email-asked';

// Standard-field allowlist for the promotion PUT. Anything else — most
// importantly `tags` and `customFields` — never reaches the payload.
const PROMOTABLE_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'address1', 'city', 'state', 'postalCode'];

/** True when a name is missing or the live-chat widget placeholder. */
export function isPlaceholderName(name) {
  const n = String(name || '').trim();
  if (!n) return true;
  return PLACEHOLDER_NAME_RE.test(n);
}

/** Normalize a US phone to E.164 (+1XXXXXXXXXX) or null. */
export function normalizePhoneE164(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/** 5-digit zip (strips ZIP+4) or null. */
export function normalizeZip5(raw) {
  const m = String(raw || '').match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : null;
}

function emptyIdentity() {
  return {
    first_name: null,
    last_name: null,
    phone: null,
    email: null,
    address_line1: null,
    city: null,
    state: null,
    postal_code: null,
    decision_maker_confirmed: 'unknown',
    decision_maker_question_asked: false,
    spouse_partner_name: null,
    _source: {},
  };
}

// ═══════════════════════════════════════════════════════════════════
// 1. HYDRATION — what the GHL record already knows (R5)
// ═══════════════════════════════════════════════════════════════════

/**
 * Build the identity state from the fields already on the GHL record.
 * Accepts either the context-builder lead object ({ first_name, ... }) or
 * a raw GHL contact ({ firstName, ... }). Placeholder names hydrate as
 * null — they are MISSING, not known.
 */
export function hydrateIdentityFromRecord(record = {}) {
  const id = emptyIdentity();
  const first = record.first_name ?? record.firstName ?? null;
  const last = record.last_name ?? record.lastName ?? null;
  const fullName = [first, last].filter(Boolean).join(' ');

  if (first && !isPlaceholderName(fullName) && !isPlaceholderName(first)) {
    id.first_name = String(first).trim();
    id._source.first_name = 'ghl_record';
    if (last) {
      id.last_name = String(last).trim();
      id._source.last_name = 'ghl_record';
    }
  }

  const assign = (key, value) => {
    if (value === null || value === undefined || String(value).trim() === '') return;
    id[key] = String(value).trim();
    id._source[key] = 'ghl_record';
  };
  assign('phone', normalizePhoneE164(record.phone) || record.phone);
  assign('email', record.email);
  assign('address_line1', record.address1 ?? record.address_line1);
  assign('city', record.city);
  assign('state', record.state);
  assign('postal_code', normalizeZip5(record.postal_code ?? record.postalCode));

  // "Decision Makers Present" GHL select — Yes/Solo Owner ⇒ confirmed true;
  // No/Uncertain ⇒ answered-but-not-confirmed (question WAS asked).
  const dm = record.decision_makers_present ?? record.decisionMakersPresent ?? null;
  if (dm === 'Yes' || dm === 'Solo Owner') {
    id.decision_maker_confirmed = true;
    id.decision_maker_question_asked = true;
    id._source.decision_maker_confirmed = 'ghl_record';
  } else if (dm === 'No' || dm === 'Uncertain') {
    id.decision_maker_confirmed = false;
    id.decision_maker_question_asked = true;
    id._source.decision_maker_confirmed = 'ghl_record';
  }

  return id;
}

// ═══════════════════════════════════════════════════════════════════
// 2. EXTRACTION — heuristic pass (deterministic, every inbound message)
// ═══════════════════════════════════════════════════════════════════

const STREET_SUFFIX = '(?:Dr|Drive|St|Street|Ave|Avenue|Rd|Road|Ln|Lane|Blvd|Boulevard|Ct|Court|Cir|Circle|Way|Ter|Terrace|Trl|Trail|Pl|Place|Pkwy|Parkway|Hwy|Highway|Loop)';
const ADDRESS_RE = new RegExp(
  `\\b(\\d{1,6}\\s+(?:[NSEW]\\.?\\s+)?[A-Za-z0-9'.]+(?:\\s+[A-Za-z0-9'.]+){0,3}?\\s+${STREET_SUFFIX})\\.?\\b` +
  `(?:\\s*,?\\s*(?:Apt|Unit|Ste|Suite|#)\\s*[\\w-]+)?` +
  `(?:\\s*,\\s*([A-Za-z][A-Za-z .'-]{2,30}))?` +
  `(?:\\s*,?\\s*(FL|Florida)\\b)?` +
  `(?:\\s*,?\\s*(\\d{5})(?:-\\d{4})?)?`,
  'i'
);
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const PHONE_RE = /(?:\+?1[\s\-.]*)?\(?(\d{3})\)?[\s\-.]*(\d{3})[\s\-.]*(\d{4})\b/;
// Zip capture OUTSIDE the address regex — the zip is what determines service
// area, so it must be caught even when given on its own ("33435") or with a
// keyword ("zip is 33435"). Bare 5-digit tokens are only accepted in the FL
// range (3xxxx) to avoid eating window counts / prices.
const ZIP_KEYWORD_RE = /\bzip(?:\s*code)?\s*(?:is|:)?\s*(\d{5})(?:-\d{4})?\b/i;
const BARE_FL_ZIP_RE = /^\s*(3[0-4]\d{3})(?:-\d{4})?\s*$/;

// Decision-maker signals (R3 mapping).
const DM_PENDING_RE = /\b(?:talk(?:ing)?|check(?:ing)?|speak(?:ing)?|discuss(?:ing)?|run (?:it|this))\s+(?:it\s+|this\s+|things\s+)?(?:over\s+)?with\s+my\s+(wife|husband|spouse|partner)\b|\bafter\s+talking\s+(?:to|with)\s+my\s+(wife|husband|spouse|partner)\b|\bask\s+my\s+(wife|husband|spouse|partner)\b/i;
const DM_UNSURE_RE = /\b(?:i(?:'|’)?ll see if (?:she|he|they) can|maybe (?:she|he|they)|not sure if (?:she|he|they)|i think (?:she|he|they)(?:'|’)?ll be)\b/i;
const DM_CONFIRMED_RE = /\b(?:we(?:'|’)?(?:ll| will)? both be (?:there|home)|both of us will|yes,?\s*we(?:'|’)?ll both|we(?:'|’)?re both good|everyone(?:\s+\w+){0,4}\s+will be (?:there|home)|i(?:'|’)?m the only (?:one|decision[- ]?maker)|i live alone|it(?:'|’)?s just me|i make all the decisions)\b/i;
// Did the BOT ask the decision-maker question? (scanned over outbound turns)
const DM_QUESTION_RE = /\b(?:decision[- ]?makers?|will (?:you both|everyone)|both (?:of you )?(?:be|going to be) (?:there|home)|everyone (?:who(?:'|’)?s |who is )?part of the decision)\b/i;

// A message that is likely a bare name reply ("Victor Lopez").
const NAME_WORD = "[A-Za-z][A-Za-z'’-]{1,20}";
const BARE_NAME_RE = new RegExp(`^\\s*(${NAME_WORD})\\s+(${NAME_WORD})(?:\\s+(${NAME_WORD}))?\\s*$`);
const STATED_NAME_RE = new RegExp(`\\b(?:my name is|this is|i(?:'|’)?m|name(?:'|’)?s)\\s+(${NAME_WORD})(?:\\s+(${NAME_WORD}))?`, 'i');
// Words that disqualify a bare 2-word message from being a name. Expanded
// 2026-07-04 after the remediation DRY RUN caught the loose heuristic
// planning promotions like "never mind" / "trying to" / "real person" as
// names across the guest-visitor cohort.
const NAME_STOPWORDS = new Set([
  'yes', 'no', 'ok', 'okay', 'sure', 'thanks', 'thank', 'you', 'please', 'hello', 'hi', 'hey',
  'good', 'morning', 'afternoon', 'evening', 'night', 'sounds', 'works', 'great', 'perfect',
  'guest', 'visitor', 'windows', 'doors', 'window', 'door', 'quote', 'price', 'prices', 'call', 'text',
  'me', 'not', 'stop', 'saturday', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
  'today', 'tomorrow', 'next', 'week', 'this', 'that', 'what', 'when', 'where', 'how', 'much',
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'of', 'to', 'for', 'from', 'with', 'so',
  'is', 'was', 'are', 'be', 'it', 'its', 'my', 'your', 'our', 'his', 'her', 'their', 'just', 'only',
  'never', 'mind', 'need', 'needs', 'all', 'set', 'like', 'very', 'sorry', 'either', 'both',
  'trying', 'looking', 'planning', 'talking', 'contacting', 'gathering', 'interested', 'unable',
  'exploring', 'surfing', 'real', 'person', 'people', 'info', 'information', 'options', 'option',
  'existing', 'one', 'two', 'three', 'four', 'five', 'free', 'gift', 'gifts', 'tax', 'credit',
  'email', 'address', 'name', 'house', 'home', 'group', 'recommendation', 'replacement', 'process',
  'spanish', 'english', 'supposed', 'thousand', 'hundred', 'contact', 'family', 'tree', 'wen', 'web',
  'about', 'more', 'less', 'some', 'any', 'here', 'there', 'now', 'later', 'soon', 'still', 'also',
]);

function looksLikeName(words) {
  return words.every(w => !NAME_STOPWORDS.has(w.toLowerCase()) && !/\d/.test(w));
}

// A bare (unprompted) name candidate must also be CAPITALIZED like a name —
// "Victor Lopez" / "Edward Vogel" yes; "never mind" / "The existing one" no.
// Internal caps allowed (McHale, DiMarco). Explicit "my name is …" phrasing
// is exempt (strong evidence), and gets title-cased on write instead.
function isCapitalizedNameWord(w) {
  return /^[A-Z][A-Za-z'’-]{1,19}$/.test(w);
}

function titleCaseName(w) {
  const s = String(w || '').trim();
  if (!s) return s;
  // Preserve deliberate internal capitalization (McHale); fix all-lower/ALL-UPPER.
  if (/^[a-z'’-]+$/.test(s) || /^[A-Z'’-]+$/.test(s)) {
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Deterministic identity extraction over conversation messages.
 *
 * @param {Array<{direction?: string, text?: string}|string>} messages
 *   Conversation turns, oldest→newest. Strings are treated as inbound.
 *   Identity fields are only extracted from INBOUND turns (the prospect's
 *   own words); the decision-maker QUESTION is detected on outbound turns.
 */
export function heuristicExtract(messages = []) {
  const id = emptyIdentity();
  const turns = (Array.isArray(messages) ? messages : [messages]).map(m =>
    typeof m === 'string' ? { direction: 'inbound', text: m } : { direction: m?.direction || 'inbound', text: m?.text || '' }
  );

  for (const turn of turns) {
    const text = String(turn.text || '');
    if (!text.trim()) continue;
    const inbound = String(turn.direction).toLowerCase() !== 'outbound';

    if (!inbound) {
      if (DM_QUESTION_RE.test(text)) id.decision_maker_question_asked = true;
      continue;
    }

    // 2026-07-29 (Kelly Callahan incident): blank URLs BEFORE the segment
    // split. A URL is never a customer-supplied phone/ZIP/address, but tracked
    // links carry long digit runs and PHONE_RE has no left anchor — the last
    // ten digits of an unsubscribe link's `time_stamp=1785346485266` were
    // extracted as the phone +15346485266 and raised an identity.field_conflict
    // against her real number. Scrubbing after the split would be too late:
    // the split delimiter is `/`, which shreds the URL into bare segments.
    const scrubbed = scrubUrlsForExtraction(text);

    // Split multi-part transcripts ("a / b / c") into segments so a bare
    // name or address inside a chat-transcript custom field is still seen.
    const segments = scrubbed.split(/\s*\/\s*|\n+/).map(s => s.trim()).filter(Boolean);
    for (const seg of segments) {
      const phoneM = seg.match(PHONE_RE);
      if (phoneM && !id.phone) {
        const e164 = normalizePhoneE164(`${phoneM[1]}${phoneM[2]}${phoneM[3]}`);
        if (e164) { id.phone = e164; id._source.phone = 'extracted'; }
      }

      const emailM = seg.match(EMAIL_RE);
      if (emailM && !id.email) { id.email = emailM[0].toLowerCase(); id._source.email = 'extracted'; }

      if (!id.postal_code) {
        const zipKw = seg.match(ZIP_KEYWORD_RE);
        const zipBare = seg.match(BARE_FL_ZIP_RE);
        const zip = zipKw ? zipKw[1] : (zipBare ? zipBare[1] : null);
        if (zip) { id.postal_code = zip; id._source.postal_code = 'extracted'; }
      }

      const addrM = seg.match(ADDRESS_RE);
      if (addrM && !id.address_line1) {
        id.address_line1 = addrM[1].replace(/\s+/g, ' ').trim();
        id._source.address_line1 = 'extracted';
        if (addrM[2]) {
          // Greedy city capture may swallow a trailing state token — strip it.
          const cityRaw = addrM[2].trim().replace(/[\s,]+(FL|Florida)$/i, '');
          const strippedState = cityRaw.length !== addrM[2].trim().length;
          if (cityRaw && looksLikeName(cityRaw.split(/\s+/))) {
            id.city = cityRaw;
            id._source.city = 'extracted';
          }
          if (strippedState) { id.state = 'FL'; id._source.state = 'extracted'; }
        }
        if (addrM[3]) { id.state = 'FL'; id._source.state = 'extracted'; }
        if (addrM[4]) { id.postal_code = addrM[4]; id._source.postal_code = 'extracted'; }
      }

      if (!id.first_name) {
        const stated = seg.match(STATED_NAME_RE);
        const bare = seg.match(BARE_NAME_RE);
        let candidate = null;
        if (stated && stated[2] && looksLikeName([stated[1], stated[2]])) {
          // Explicit "my name is …" — strong evidence, any casing accepted.
          candidate = [stated[1], stated[2]];
        } else if (bare) {
          // Bare 2-3 word message — weak evidence, so it must ALSO be
          // capitalized like a name (dry-run 2026-07-04: "never mind",
          // "trying to", "real person" would otherwise promote as names).
          const words = [bare[1], bare[2], bare[3]].filter(Boolean);
          if (words.every(isCapitalizedNameWord) && looksLikeName(words) && !isPlaceholderName(words.join(' '))) {
            candidate = words;
          }
        }
        if (candidate) {
          id.first_name = titleCaseName(candidate[0]);
          id.last_name = candidate.slice(1).map(titleCaseName).join(' ') || null;
          id._source.first_name = 'extracted';
          if (id.last_name) id._source.last_name = 'extracted';
        }
      }

      // Decision-maker signals — later turns override earlier ones.
      if (DM_CONFIRMED_RE.test(seg)) {
        id.decision_maker_confirmed = true;
        id.decision_maker_question_asked = true;
        id._source.decision_maker_confirmed = 'extracted';
      } else if (DM_PENDING_RE.test(seg) || DM_UNSURE_RE.test(seg)) {
        id.decision_maker_confirmed = false;
        id._source.decision_maker_confirmed = 'extracted';
        const spouseM = seg.match(DM_PENDING_RE);
        const spouseWord = spouseM && (spouseM[1] || spouseM[2] || spouseM[3]);
        if (spouseWord && !id.spouse_partner_name) {
          // Relation word only — a proper spouse NAME comes from the LLM pass.
          id.spouse_partner_name = null;
        }
      }
    }
  }

  return id;
}

// ═══════════════════════════════════════════════════════════════════
// 2b. EXTRACTION — structured LLM pass (booking intent / placeholder name)
// ═══════════════════════════════════════════════════════════════════

const EXTRACTION_SYSTEM_PROMPT = `You extract customer identity data from a sales chat transcript for Reece Windows & Doors (South Florida).

Return ONLY a JSON object with exactly these keys (null when the customer did not provide the value — NEVER guess or infer beyond the transcript):
{
  "first_name": string|null,        // the CUSTOMER's own name, as they stated it
  "last_name": string|null,
  "phone": string|null,             // digits as given
  "email": string|null,
  "address_line1": string|null,     // street address only, e.g. "2885 S Oasis Dr"
  "city": string|null,
  "state": string|null,             // two-letter, only if stated or clearly implied by a stated city
  "postal_code": string|null,
  "decision_maker_confirmed": true|false|"unknown",
  "decision_maker_question_asked": true|false,
  "spouse_partner_name": string|null
}

decision_maker_confirmed mapping:
- true  → customer explicitly said all decision-makers will be present ("we'll both be there", "just me, I'm the only one")
- false → pending or negative ("need to talk to my wife", "not sure", "let me check", "she won't be there")
- "unknown" → the topic never came up
decision_maker_question_asked = true only if the AGENT/bot asked about decision-maker presence.
Never treat the agent's words as the customer's data. Placeholder names like "Guest Visitor x" are NOT names.`;

/**
 * Structured-output LLM extraction over the conversation. Falls back to
 * (and merges with) the heuristic pass — the LLM fills what the regexes
 * miss; regex-derived phone/email win on conflict (deterministic > model).
 */
export async function extractIdentityLLM(messages = [], { contactId = null } = {}) {
  const heuristic = heuristicExtract(messages);
  const turns = (Array.isArray(messages) ? messages : [messages]).map(m =>
    typeof m === 'string' ? { direction: 'inbound', text: m } : m
  );
  const transcript = turns
    .filter(t => t?.text)
    .map(t => `[${String(t.direction || 'inbound').toLowerCase() === 'outbound' ? 'agent' : 'customer'}] ${String(t.text).slice(0, 500)}`)
    .join('\n')
    .slice(0, 12000);
  if (!transcript.trim()) return heuristic;

  let parsed = null;
  try {
    const { text } = await callLLM({
      fn: 'identity_extraction',
      system: EXTRACTION_SYSTEM_PROMPT,
      user: `TRANSCRIPT:\n${transcript}\n\nReturn the JSON object.`,
      maxTokens: 500,
      json: true,
    });
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    console.warn(`[IdentityExtraction] LLM pass failed${contactId ? ` for ${contactId}` : ''}: ${err.message} — using heuristics only`);
    return heuristic;
  }
  if (!parsed || typeof parsed !== 'object') return heuristic;

  const merged = { ...heuristic };
  const take = (key, normalize = (v) => String(v).trim()) => {
    if (merged[key] == null && parsed[key] != null && String(parsed[key]).trim() !== '') {
      const v = normalize(parsed[key]);
      if (v) { merged[key] = v; merged._source[key] = 'extracted'; }
    }
  };
  take('first_name');
  take('last_name');
  take('phone', normalizePhoneE164);
  take('email', (v) => String(v).trim().toLowerCase());
  take('address_line1');
  take('city');
  take('state', (v) => String(v).trim().slice(0, 2).toUpperCase());
  take('postal_code', normalizeZip5);
  take('spouse_partner_name');
  if (merged.first_name && isPlaceholderName(merged.first_name)) {
    merged.first_name = null;
    merged.last_name = null;
  }
  if (merged.decision_maker_confirmed === 'unknown' && parsed.decision_maker_confirmed !== undefined
      && [true, false, 'unknown'].includes(parsed.decision_maker_confirmed)) {
    merged.decision_maker_confirmed = parsed.decision_maker_confirmed;
    if (parsed.decision_maker_confirmed !== 'unknown') merged._source.decision_maker_confirmed = 'extracted';
  }
  if (parsed.decision_maker_question_asked === true) merged.decision_maker_question_asked = true;
  return merged;
}

// ═══════════════════════════════════════════════════════════════════
// 3. MERGE — record + extraction → hydrated identity state (R5)
// ═══════════════════════════════════════════════════════════════════

const IDENTITY_FIELDS = ['first_name', 'last_name', 'phone', 'email', 'address_line1', 'city', 'state', 'postal_code'];

function normalizedEqual(field, a, b) {
  if (field === 'phone') return (normalizePhoneE164(a) || String(a)) === (normalizePhoneE164(b) || String(b));
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * Merge hydrated record state with extraction. The RECORD wins every
 * conflict (extraction only fills gaps); differing values are reported in
 * `conflicts` so promotion can log them without overwriting.
 */
export function mergeIdentity(recordId, extractedId) {
  const merged = { ...recordId, _source: { ...recordId._source } };
  const conflicts = [];

  for (const field of IDENTITY_FIELDS) {
    const rec = recordId[field];
    const ext = extractedId[field];
    if (ext == null) continue;
    if (rec == null) {
      merged[field] = ext;
      merged._source[field] = 'extracted';
    } else if (!normalizedEqual(field, rec, ext)) {
      conflicts.push({ field, record_value: rec, extracted_value: ext });
    }
  }

  // Decision-maker: a fresh conversational answer beats a stale field value
  // ONLY in the pending/unsure direction (never auto-upgrade to confirmed
  // when the record says No/Uncertain — humans upgrade that).
  if (merged.decision_maker_confirmed === 'unknown' && extractedId.decision_maker_confirmed !== 'unknown') {
    merged.decision_maker_confirmed = extractedId.decision_maker_confirmed;
    merged._source.decision_maker_confirmed = extractedId._source.decision_maker_confirmed || 'extracted';
  } else if (merged.decision_maker_confirmed === true && extractedId.decision_maker_confirmed === false) {
    merged.decision_maker_confirmed = false;
    merged._source.decision_maker_confirmed = extractedId._source.decision_maker_confirmed || 'extracted';
  }
  merged.decision_maker_question_asked = merged.decision_maker_question_asked
    || recordId.decision_maker_question_asked
    || extractedId.decision_maker_question_asked;
  if (!merged.spouse_partner_name && extractedId.spouse_partner_name) {
    merged.spouse_partner_name = extractedId.spouse_partner_name;
  }

  return { identity: merged, conflicts };
}

/**
 * Build the full hydrated identity state for a contact from a lead-context
 * object (context-builder shape) — hydrate → extract → merge.
 *
 * @param {object} context   buildLeadContext() result (needs .lead and
 *                           .conversation_recent), or { lead, conversation_recent }
 * @param {object} [opts]
 * @param {boolean} [opts.useLLM=false]  run the structured LLM pass in
 *   addition to heuristics (booking intent / persistent placeholder name)
 * @param {Array}  [opts.extraMessages]  additional transcript turns (e.g.
 *   the Chat Transcript custom field) appended to the corpus
 */
export async function buildIdentityState(context, { useLLM = false, extraMessages = [] } = {}) {
  const lead = context?.lead || {};
  const recordId = hydrateIdentityFromRecord(lead);
  const corpus = [
    ...(extraMessages || []),
    ...(context?.conversation_recent || []),
  ];
  const extractedId = useLLM
    ? await extractIdentityLLM(corpus, { contactId: lead.ghl_contact_id })
    : heuristicExtract(corpus);
  const { identity, conflicts } = mergeIdentity(recordId, extractedId);
  return {
    identity,
    conflicts,
    contact_id: lead.ghl_contact_id || null,
    record_had_placeholder_name: isPlaceholderName([lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.name),
    tags: lead.current_tags || [],
  };
}

// ═══════════════════════════════════════════════════════════════════
// 4. BOOKING GATE (R2/R3/R4)
// ═══════════════════════════════════════════════════════════════════

/**
 * Evaluate the in-home booking prerequisites against the HYDRATED identity
 * state. Pure — no I/O. A field satisfied by the record passes with no
 * question asked (R5).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.bookingInFlight=false] — true when an in-home calendar
 *   is being offered THIS turn (slot selection in progress). The email ask is
 *   soft and asked-once (R4); it must NEVER share a turn with slot selection
 *   (2026-07-24 Engelke incident — the bot offered slots and asked for email in
 *   the same message). When in flight, should_ask_email is suppressed here and
 *   the post-booking handler asks on the following turn instead. Defaults to
 *   {} so every existing caller is unaffected.
 * @returns {{
 *   ok: boolean,
 *   missing: string[],            // hard blockers, in ask-order
 *   appointment_status: 'confirmed'|'new',
 *   decision_maker_confirmed: true|false|'unknown',
 *   should_ask_email: boolean,    // soft — ask once, never block, never with a slot offer
 *   known: object,                // field → value for prompt hydration
 * }}
 */
export function assertBookingPrerequisites(state, opts = {}) {
  const id = state?.identity || emptyIdentity();
  const tags = state?.tags || [];
  const bookingInFlight = opts.bookingInFlight === true;

  const missing = [];
  const nameKnown = !!id.first_name && !isPlaceholderName([id.first_name, id.last_name].filter(Boolean).join(' '));
  if (!nameKnown) missing.push('name');
  // Street + ZIP are the hard address components — the zip is what proves
  // the home is in a Reece service market (city/state derive from the zip
  // via service_area_zips and never block).
  if (!id.address_line1) missing.push('address');
  if (!id.postal_code) missing.push('zip');
  const dmAsked = id.decision_maker_question_asked || id.decision_maker_confirmed !== 'unknown';
  if (!dmAsked) missing.push('decision_maker_question');
  if (!id.phone) missing.push('phone');

  const emailAsked = tags.includes(EMAIL_ASKED_TAG);
  // Never ask for email on a turn that is selecting/offering slots — the ask is
  // sequenced to AFTER the appointment lands (post-booking handler).
  const should_ask_email = !id.email && !emailAsked && !bookingInFlight;

  return {
    ok: missing.length === 0,
    missing,
    appointment_status: id.decision_maker_confirmed === true ? 'confirmed' : 'new',
    decision_maker_confirmed: id.decision_maker_confirmed,
    should_ask_email,
    known: {
      name: nameKnown ? [id.first_name, id.last_name].filter(Boolean).join(' ') : null,
      phone: id.phone,
      email: id.email,
      address: id.address_line1
        ? [id.address_line1, id.city, id.state, id.postal_code].filter(Boolean).join(', ')
        : null,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// 4b. SERVICE AREA — zip → market check (mirrors LP MCP check_service_area)
// ═══════════════════════════════════════════════════════════════════

/**
 * Look a zip up in service_area_zips (same table check_service_area uses).
 * Returns { checked, zip, in_service_area?, city?, county?, market_code? }.
 * checked=false means the lookup could not run (no supabase / error) —
 * callers must treat that as UNKNOWN, never as out-of-area.
 */
export async function checkServiceAreaZip(zip) {
  const z = normalizeZip5(zip);
  if (!z) return { checked: false, zip: null };
  if (!supabase) return { checked: false, zip: z };
  try {
    const { data, error } = await supabase
      .from('service_area_zips')
      .select('zip, city, county, market_code')
      .eq('zip', z)
      .maybeSingle();
    if (error) {
      console.warn(`[IdentityExtraction] service_area_zips lookup error for ${z}: ${error.message}`);
      return { checked: false, zip: z };
    }
    if (!data) return { checked: true, zip: z, in_service_area: false };
    return { checked: true, zip: z, in_service_area: true, city: data.city || null, county: data.county || null, market_code: data.market_code || null };
  } catch (err) {
    console.warn(`[IdentityExtraction] service_area_zips lookup threw for ${z}: ${err.message}`);
    return { checked: false, zip: z };
  }
}

/**
 * TENTATIVE city-level service-area signal. A city name matching rows in
 * service_area_zips means Reece serves at least part of that city — enough
 * for the bot to speak positively, NEVER enough to certify the home is
 * in-area (cities are partially covered; the zip is the authoritative
 * check, per Mark 2026-07-04). Deliberately does NOT return or infer any
 * zip — city→zip is a one-to-many guess and is forbidden.
 */
export async function checkServiceAreaCity(city) {
  const c = String(city || '').trim();
  if (!c || !supabase) return { checked: false, city: c || null };
  try {
    const { data, error } = await supabase
      .from('service_area_zips')
      .select('market_code')
      .ilike('city', c)
      .limit(1);
    if (error) {
      console.warn(`[IdentityExtraction] service_area_zips city lookup error for "${c}": ${error.message}`);
      return { checked: false, city: c };
    }
    return {
      checked: true,
      city: c,
      city_served: Array.isArray(data) && data.length > 0,
      market_code: data?.[0]?.market_code || null,
      tentative: true,
    };
  } catch (err) {
    console.warn(`[IdentityExtraction] service_area_zips city lookup threw for "${c}": ${err.message}`);
    return { checked: false, city: c };
  }
}

// ═══════════════════════════════════════════════════════════════════
// 4c. GEOCODING — street address → zip (US Census Bureau, free, no key)
// ═══════════════════════════════════════════════════════════════════

const CENSUS_GEOCODER_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const GEOCODE_TIMEOUT_MS = parseInt(process.env.GEOCODE_TIMEOUT_MS || '5000', 10);

/**
 * Parse a Census geocoder response. Returns { zip, city, state, matched }
 * ONLY on a single unambiguous match — zero matches or 2+ candidates
 * return null (a guessed zip would poison the service-area determinant).
 * Pure — unit-tested against fixtures.
 */
export function parseCensusGeocodeResponse(json) {
  const matches = json?.result?.addressMatches;
  if (!Array.isArray(matches) || matches.length !== 1) return null;
  const m = matches[0];
  const zip = normalizeZip5(m?.addressComponents?.zip);
  if (!zip) return null;
  return {
    zip,
    city: m?.addressComponents?.city ? String(m.addressComponents.city).trim() : null,
    state: m?.addressComponents?.state ? String(m.addressComponents.state).trim().toUpperCase() : null,
    matched: m?.matchedAddress || null,
  };
}

/**
 * Resolve a street address to a zip via the US Census geocoder (free, no
 * API key). Single-unambiguous-match rule; any error, timeout, or
 * ambiguity returns null and the bot simply asks the customer for the zip
 * (the existing gate fallback). State defaults to FL — every Reece market
 * is in Florida, and the bias disambiguates street-only inputs.
 */
export async function geocodeStreetToZip(addressLine1, { city = null, state = 'FL' } = {}) {
  const street = String(addressLine1 || '').trim();
  if (!street) return null;
  const oneLine = [street, city, state].filter(Boolean).join(', ');
  const url = `${CENSUS_GEOCODER_URL}?address=${encodeURIComponent(oneLine)}&benchmark=Public_AR_Current&format=json`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[IdentityExtraction] census geocode HTTP ${res.status} for "${oneLine}"`);
      return null;
    }
    const parsed = parseCensusGeocodeResponse(await res.json());
    if (parsed) console.log(`[IdentityExtraction] geocoded "${oneLine}" → zip ${parsed.zip} (${parsed.matched})`);
    return parsed;
  } catch (err) {
    console.warn(`[IdentityExtraction] census geocode failed for "${oneLine}": ${err.message}`);
    return null;
  }
}

/**
 * Backfill city/state from a verified in-service-area zip. This is the only
 * path that defaults state to FL — a zip inside a Reece service market IS a
 * Florida market (handoff §4.1: default "FL" only when the location resolves
 * to a FL service market). Mutates and returns the identity.
 */
export function enrichIdentityFromServiceArea(identity, serviceArea) {
  if (!identity || !serviceArea?.checked || serviceArea.in_service_area !== true) return identity;
  if (!identity.city && serviceArea.city) {
    identity.city = serviceArea.city;
    identity._source.city = 'extracted';
  }
  if (!identity.state) {
    identity.state = 'FL';
    identity._source.state = 'extracted';
  }
  return identity;
}

// ═══════════════════════════════════════════════════════════════════
// 5. PROMOTION — write to GHL standard fields (R1)
// ═══════════════════════════════════════════════════════════════════

/**
 * Compute the standard-field PUT payload for a contact. Pure — no I/O.
 *
 * Rules:
 *  - Name: written ONLY when the current name is empty or matches the
 *    placeholder pattern. A differing real name is a conflict, never an
 *    overwrite.
 *  - Everything else: fill-if-empty; differing values are conflicts.
 *  - The payload NEVER contains `tags` or `customFields` (tag-wipe hazard).
 *
 * @param {object} current  current standard-field values ({ firstName|first_name, ... })
 * @param {object} identity merged identity (extraction-sourced values only are written)
 * @returns {{ payload: object, conflicts: Array, wroteRealName: boolean }}
 */
export function buildPromotionPayload(current = {}, identity = {}) {
  const cur = {
    firstName: current.firstName ?? current.first_name ?? null,
    lastName: current.lastName ?? current.last_name ?? null,
    email: current.email ?? null,
    phone: current.phone ?? null,
    address1: current.address1 ?? current.address_line1 ?? null,
    city: current.city ?? null,
    state: current.state ?? null,
    postalCode: current.postalCode ?? current.postal_code ?? null,
  };
  const src = identity._source || {};
  const payload = {};
  const conflicts = [];
  let wroteRealName = false;

  // Name — placeholder-or-empty overwrite only (also match raw firstName).
  const curFull = [cur.firstName, cur.lastName].filter(Boolean).join(' ');
  const curIsPlaceholder = isPlaceholderName(curFull) || isPlaceholderName(cur.firstName);
  if (identity.first_name && src.first_name === 'extracted' && !isPlaceholderName(identity.first_name)) {
    if (curIsPlaceholder) {
      payload.firstName = identity.first_name;
      // A placeholder surname ("Visitor bljpx") must not survive next to a
      // real first name — write the extracted last name or clear it.
      payload.lastName = identity.last_name || '';
      wroteRealName = true;
    } else if (!normalizedEqual('name', curFull, [identity.first_name, identity.last_name].filter(Boolean).join(' '))) {
      conflicts.push({ field: 'name', record_value: curFull, extracted_value: [identity.first_name, identity.last_name].filter(Boolean).join(' ') });
    }
  }

  const fillIfEmpty = (payloadKey, curValue, extValue, extracted) => {
    if (extValue == null || !extracted) return;
    if (curValue == null || String(curValue).trim() === '') {
      payload[payloadKey] = extValue;
    } else if (!normalizedEqual(payloadKey === 'phone' ? 'phone' : payloadKey, curValue, extValue)) {
      conflicts.push({ field: payloadKey, record_value: curValue, extracted_value: extValue });
    }
  };
  fillIfEmpty('phone', cur.phone, identity.phone, src.phone === 'extracted');
  fillIfEmpty('email', cur.email, identity.email, src.email === 'extracted');
  fillIfEmpty('address1', cur.address1, identity.address_line1, src.address_line1 === 'extracted');
  fillIfEmpty('city', cur.city, identity.city, src.city === 'extracted');
  fillIfEmpty('state', cur.state, identity.state, src.state === 'extracted');
  // 'geocoded' = zip resolved from the street address via the Census
  // geocoder (single unambiguous match only) — promotable like extraction.
  fillIfEmpty('postalCode', cur.postalCode, identity.postal_code, src.postal_code === 'extracted' || src.postal_code === 'geocoded');

  // TAG-WIPE GUARD: the payload is built exclusively from the allowlist
  // above, but strip defensively in case a caller mutated the object.
  for (const key of Object.keys(payload)) {
    if (!PROMOTABLE_FIELDS.includes(key)) delete payload[key];
  }

  return { payload, conflicts, wroteRealName };
}

/**
 * Promote extraction-sourced identity values onto the GHL contact's
 * standard fields. Conflicts are logged to system_events, never
 * overwritten. Removes the I.CN `name-placeholder` tag once a real name
 * lands. Best-effort by contract — callers fire-and-forget.
 *
 * @param {string} contactId
 * @param {object} state    buildIdentityState() result
 * @param {object} [opts]
 * @param {object} [opts.current]  current standard-field values (defaults
 *   to the record view captured in state via hydration source markers)
 * @param {string} [opts.trigger]  provenance for the event log
 */
export async function promoteIdentityToGHL(contactId, state, { current = null, trigger = 'agentic' } = {}) {
  if (!contactId || !state?.identity) return { written: 0, conflicts: 0 };

  // Reconstruct the record view from hydration when no explicit current
  // snapshot is provided: record-sourced fields ARE the current values.
  const id = state.identity;
  const src = id._source || {};
  const cur = current || {
    firstName: src.first_name === 'ghl_record' ? id.first_name : (state.record_had_placeholder_name ? 'Guest Visitor' : null),
    lastName: src.last_name === 'ghl_record' ? id.last_name : null,
    email: src.email === 'ghl_record' ? id.email : null,
    phone: src.phone === 'ghl_record' ? id.phone : null,
    address1: src.address_line1 === 'ghl_record' ? id.address_line1 : null,
    city: src.city === 'ghl_record' ? id.city : null,
    state: src.state === 'ghl_record' ? id.state : null,
    postalCode: src.postal_code === 'ghl_record' ? id.postal_code : null,
  };

  const { payload, conflicts, wroteRealName } = buildPromotionPayload(cur, id);
  const allConflicts = [...conflicts, ...(state.conflicts || [])];

  for (const conflict of allConflicts) {
    try {
      await emitEvent({
        event_type: conflict.field === 'name' ? 'identity.name_conflict' : 'identity.field_conflict',
        event_subtype: conflict.field,
        source: 'lp_mcp',
        entity_type: 'contact',
        entity_id: contactId,
        ghl_contact_id: contactId,
        payload: { ...conflict, trigger },
        priority: 'low',
        idempotency_key: `identity-conflict:${contactId}:${conflict.field}:${String(conflict.extracted_value).slice(0, 40)}`,
        bypass_filter: true,
      });
    } catch (err) {
      console.warn(`[IdentityExtraction] conflict event emit failed for ${contactId}: ${err.message}`);
    }
  }

  if (Object.keys(payload).length === 0) {
    return { written: 0, conflicts: allConflicts.length };
  }

  const result = await updateGHLContactStandardFields(contactId, payload);
  if (result !== true) {
    console.warn(`[IdentityExtraction] standard-field promotion failed for ${contactId} (result=${result})`);
    return { written: 0, conflicts: allConflicts.length, failed: true };
  }

  console.log(`[IdentityExtraction] ✅ promoted ${Object.keys(payload).join(', ')} for ${contactId}${wroteRealName ? ' (placeholder name replaced)' : ''}`);
  try {
    await emitEvent({
      event_type: 'identity.promoted',
      event_subtype: trigger,
      source: 'lp_mcp',
      entity_type: 'contact',
      entity_id: contactId,
      ghl_contact_id: contactId,
      payload: { fields: Object.keys(payload), wrote_real_name: wroteRealName },
      priority: 'low',
      bypass_filter: true,
    });
  } catch { /* best-effort */ }

  if (wroteRealName) {
    await removeGHLTags(contactId, [NAME_PLACEHOLDER_TAG]).catch(() => {});
  }

  return { written: Object.keys(payload).length, conflicts: allConflicts.length, wroteRealName };
}

/**
 * Per-inbound identity pass (message-analyzer hook). Heuristics only — no
 * LLM cost on the analyzer path. Fire-and-forget; never throws.
 */
export async function runInboundIdentityPass(contactId, context) {
  try {
    const state = await buildIdentityState(context, { useLLM: false });
    const result = await promoteIdentityToGHL(contactId, state, { trigger: 'inbound_message' });

    // v1.1 (2026-07-24 Engelke incident) §5a — capture the lead's OWN stated
    // time from this inbound turn and persist it to the custom fields (fill-if-
    // empty, fire-and-forget). Uses the custom-field write path (never the
    // standard-fields promotion, which is allowlisted and can't carry these).
    try {
      const preferred = extractPreferredTime(context.conversation_recent || []);
      if (preferred && preferred.source === 'inbound') {
        persistPreferredTime(contactId, preferred).catch(() => {});
      }
    } catch (err) {
      console.warn(`[IdentityExtraction] preferred-time capture skipped for ${contactId}: ${err.message}`);
    }

    return result;
  } catch (err) {
    console.warn(`[IdentityExtraction] inbound pass failed for ${contactId}: ${err.message}`);
    return null;
  }
}
