/**
 * Omi conversation ingest — src/memory/omi-ingest.js
 *
 * Turns ONE Omi conversation into UNCONFIRMED proposals inside the memory tier
 * that already exists (sql/101). The ruling this implements, 2026-09-10:
 *
 *   • No new tables, no entity registry. Omi feeds claude_pending_items under
 *     one claude_session_logs row per conversation (surface/log_origin 'omi').
 *   • NO RAW TRANSCRIPT IS EVER STORED. The transcript exists as a string in
 *     this process for the length of one request and is never written anywhere
 *     — not to Supabase, not to a log line, not into a failure record.
 *   • Omi never writes claude_decision_log or claude_known_issues. Nothing it
 *     hears is confirmed. Confirmation stays the existing path: Mark says yes
 *     in chat → memory_checkpoint writes the decision (live / confirmed) and
 *     closes the pending row with status 'ratified'.
 *   • A conflict with a confirmed decision is FLAGGED, never applied. The
 *     confirmed row is not touched.
 *
 * MAPPING (the model's own category is kept in raw.omi_category):
 *   decision_candidate | proposal | commitment | system_change → unconfirmed_decision
 *   action_item | pending_item                                → action_needed
 *   question                                                  → open_question
 *   issue | risk                        → verification_needed, description also
 *                                         prefixed "Possible issue heard in Omi — "
 *
 * PII. stripPii() (memory-text.js) is the single scrubber in this codebase and
 * it runs HERE, before anything is handed to the database — not at embed time,
 * which is the gap that left phone numbers in 12 session summaries and 9 open
 * pending items. Title, summary, search keys, item text, evidence and owner all
 * go through it.
 *
 * MODES (OMI_INGEST_MODE):
 *   off     the route answers 503 and never calls this.
 *   shadow  everything runs — extraction, scrub, dedupe, conflict check — and
 *           the planned payload lands in claude_memory_validation_log only.
 *           No memory row is created or changed.
 *   live    one rpc('claude_omi_ingest') writes the whole conversation in a
 *           single transaction, then the new items are embedded best-effort.
 *
 * SCOPE. `db` is always the omi-db.js proxy: six verbs on six memory tables.
 * This file imports nothing from the CRM, dialer or messaging side, and
 * scripts/test-omi-ingest.js fails if that ever changes.
 *
 * v1.0 — 2026-09-11. Initial (sql/101).
 */
import { createHash } from 'node:crypto';
import { stripPii, toEmbeddingRow, wordCount } from './memory-text.js';
import { normText } from './memory-checkpoint.js';

export class OmiBadRequest extends Error {
  constructor(message) { super(message); this.name = 'OmiBadRequest'; }
}
export class OmiExtractError extends Error {
  constructor(message) { super(message); this.name = 'OmiExtractError'; }
}

export const OMI_MODES = new Set(['off', 'shadow', 'live']);

// ─── Category → item_type ──────────────────────────────────────────────────
export const OMI_CATEGORY_MAP = Object.freeze({
  decision_candidate: 'unconfirmed_decision',
  proposal: 'unconfirmed_decision',
  commitment: 'unconfirmed_decision',
  system_change: 'unconfirmed_decision',
  action_item: 'action_needed',
  pending_item: 'action_needed',
  question: 'open_question',
  issue: 'verification_needed',
  risk: 'verification_needed',
});
export const OMI_CATEGORIES = Object.freeze(Object.keys(OMI_CATEGORY_MAP));
/** Categories that get a conflict check against active confirmed decisions. */
const DECISION_CATEGORIES = new Set(['decision_candidate', 'proposal', 'commitment', 'system_change']);
const ISSUE_PREFIX = 'Possible issue heard in Omi — ';
const TIMEZONE = 'America/New_York';
const OMI_PREFIX_RE = /^\s*\[Omi \d{4}-\d{2}-\d{2}\]\s*/i;
/** Cap on the open-pending rows loaded for exact-text dedupe (see dedupe step). */
const PENDING_SCAN_LIMIT = 4000;

// ─── Config ────────────────────────────────────────────────────────────────
function num(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const v = Number(env[name]);
  return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

/** off (default) | shadow | live. */
export function getOmiMode(env = process.env) {
  const m = String(env.OMI_INGEST_MODE || 'off').toLowerCase().trim();
  return OMI_MODES.has(m) ? m : 'off';
}
export function getOmiConfig(env = process.env) {
  return {
    mode: getOmiMode(env),
    minConfidence: num(env, 'OMI_MIN_CONFIDENCE', 0.5, { min: 0, max: 1 }),
    dedupeThreshold: num(env, 'OMI_DEDUPE_THRESHOLD', 0.90, { min: 0, max: 1 }),
    conflictThreshold: num(env, 'MEMORY_CONFLICT_THRESHOLD', 0.85, { min: 0, max: 1 }),
    maxTranscriptChars: num(env, 'OMI_MAX_TRANSCRIPT_CHARS', 60000, { min: 1000 }),
    model: env.OMI_EXTRACT_MODEL || null,
    // 2026-09-16 — the action-item substance floor. See mapStructuredExtraction.
    minActionWords: num(env, 'OMI_MIN_ACTION_WORDS', 5, { min: 0 }),
  };
}

// ─── Identity ──────────────────────────────────────────────────────────────
/** sha256('omi|' + conversation_id) — the claude_session_logs.checkpoint_key. */
export function omiCheckpointKey(conversationId) {
  return createHash('sha256').update(`omi|${conversationId}`).digest('hex');
}
/** The claude_transcript_ledger key. Not a URL and never fetched. */
export function omiLedgerRef(conversationId) { return `omi:${conversationId}`; }

function dateET(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// ─── 1. Normalize ──────────────────────────────────────────────────────────
/**
 * Cap the transcript at `cap` characters, keeping the first 75% and the last
 * 25%: the opening states the subject, the close states what was decided, and
 * the middle of a long recording is mostly drive time.
 */
export function capTranscript(text, cap) {
  const s = String(text || '');
  if (s.length <= cap) return s;
  const marker = `\n…[${s.length - cap} characters of the middle omitted]…\n`;
  const head = Math.max(1, Math.round(cap * 0.75) - marker.length);
  const tail = Math.max(1, cap - head - marker.length);
  return `${s.slice(0, head)}${marker}${s.slice(-tail)}`;
}

/**
 * The Omi conversation webhook body → the only shape the rest of this file
 * knows about. Tolerant about the id field on purpose: Omi has shipped it as
 * `id`, and older / adjacent payloads use `conversation_id` or `memory_id`.
 * Throws OmiBadRequest when there is no id at all — without one there is no
 * idempotency key, and a retry would write the conversation twice.
 */
export function normalizeOmiConversation(body, { now = new Date(), maxTranscriptChars = 60000 } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const conversation_id = String(b.id ?? b.conversation_id ?? b.memory_id ?? '').trim();
  if (!conversation_id) throw new OmiBadRequest('conversation id missing — expected id, conversation_id or memory_id');

  const segments = Array.isArray(b.transcript_segments) ? b.transcript_segments : [];
  const speakers = [];
  const lines = [];
  let mark_spoke = false;
  for (const seg of segments) {
    const text = String(seg?.text ?? '').trim();
    if (!text) continue;
    const who = String(seg?.speaker ?? seg?.speaker_name ?? seg?.speakerId ?? seg?.speaker_id ?? '').trim() || 'Speaker';
    if (!speakers.includes(who)) speakers.push(who);
    if (seg?.is_user === true) mark_spoke = true;
    lines.push(`${who}: ${text}`);
  }

  const structured = b.structured && typeof b.structured === 'object' ? b.structured : {};
  const started_at = b.started_at || b.created_at || null;
  const parsed = started_at ? new Date(started_at) : null;
  const session_date = dateET(parsed && !Number.isNaN(parsed.getTime()) ? parsed : now);

  return {
    conversation_id,
    discarded: b.discarded === true,
    transcript: capTranscript(lines.join('\n'), maxTranscriptChars),
    segment_count: lines.length,
    speakers,
    mark_spoke,
    session_date,
    started_at: started_at || null,
    finished_at: b.finished_at || null,
    // Omi's own summary fields. On the WEBHOOK path these are context for the
    // extractor and are never stored as-is. On the PULL path they are the only
    // content there is (see mapStructuredExtraction) — the Developer API returns
    // transcript_segments: null on every endpoint.
    omi_title: String(structured.title || '').trim(),
    omi_overview: String(structured.overview || '').trim(),
    omi_category: String(structured.category || '').trim(),
    omi_folder: String(b.folder_name || '').trim() || null,
    omi_source: String(b.source || '').trim() || null,
    structured,
  };
}

// ─── 3a. Mapping — the no-LLM path ─────────────────────────────────────────
/**
 * True when Omi has already done the extraction for us.
 *
 * 2026-09-14: the Developer API returns `transcript_segments: null` on the
 * conversation list AND on GET /user/conversations/{id} — there is no transcript
 * to read, on any endpoint. What it DOES return is `structured`: Omi's own
 * title, overview and action_items. So when `structured` carries content there
 * is nothing for a model to extract; asking one would be paying to re-derive
 * fields we already have, from a transcript we do not have.
 */
export function hasStructuredContent(body) {
  const st = body && typeof body === 'object' && body.structured && typeof body.structured === 'object'
    ? body.structured : null;
  if (!st) return false;
  const items = Array.isArray(st.action_items) ? st.action_items : [];
  // A TITLE IS NOT CONTENT. Omi stamps a title on almost everything, including
  // conversations it summarised into nothing, so treating a title as mappable
  // would send a recording that has a real transcript and an empty summary down
  // the no-LLM path and file it as "no business content" — losing the one case
  // the extractor exists for. Only an overview or an action item is something
  // to map.
  return Boolean(String(st.overview || '').trim() || items.length > 0);
}

/**
 * A word that means somebody settled something. Used ONLY to decide whether an
 * overview with no action items is worth one unconfirmed_decision card, and it
 * is deliberately conservative: a false negative costs one card nobody sees, a
 * false positive puts noise in front of Mark every single day.
 *
 * Nothing this produces is ever a decision. It is a `decision_candidate`, which
 * maps to item_type 'unconfirmed_decision' — a question for the Command Center.
 */
const DECISION_WORDS = /\b(decided?|decision|agreed?|we'?ll|we will|going to|switch(?:ing|ed)? to|move (?:to|off)|instead of|approved?|sign(?:ed)? off|settled on|the plan is|from now on|stop(?:ping|ped)? (?:using|doing)|start(?:ing|ed)? (?:using|doing))\b/i;

/**
 * An Omi conversation → the exact shape validateExtraction() returns, with no
 * model call. Mapping, not extraction: every field comes from Omi's own JSON.
 *
 * confidence is 1 throughout. That is not a claim that the CONTENT is right —
 * it is the honest statement that this is what Omi recorded, read verbatim,
 * with no model in between to be unsure. The uncertainty that matters is
 * carried by item_type ('unconfirmed_decision') and by confidence_label
 * ('unconfirmed') in raw, exactly as on the webhook path. Setting it lower
 * would only make the OMI_MIN_CONFIDENCE filter drop real items for a
 * doubt that no step here actually introduced.
 */
export function mapStructuredExtraction(conv, { minActionWords = 0 } = {}) {
  const st = conv.structured && typeof conv.structured === 'object' ? conv.structured : {};
  const title = String(st.title || '').trim();
  const overview = String(st.overview || '').trim();
  const rawItems = Array.isArray(st.action_items) ? st.action_items : [];

  // Counted BEFORE the word floor below, and it is what the overview fallback
  // reads. See the comment on that fallback for why.
  let survivedWithoutFloor = 0;

  const items = [];
  for (const it of rawItems) {
    // Omi has shipped these as objects with `description` and, in older
    // payloads, as bare strings.
    const text = clampStr(typeof it === 'string' ? it : (it?.description ?? ''), 300).trim();
    if (!text) continue;
    // Already ticked off inside Omi — filing it as open work would be a to-do
    // that was done before we heard about it.
    if ((typeof it === 'object' && it?.completed === true)) continue;
    survivedWithoutFloor += 1;
    // 2026-09-16 — the substance floor (OMI_MIN_ACTION_WORDS, default 5). An
    // action item too short to act on a week later is not a to-do, it is a
    // fragment of transcription: 5 of the 116 open items read like "Fix it".
    // The prefix is stripped first because an existing description may already
    // carry "[Omi YYYY-MM-DD] ", which would otherwise pad the count by one.
    // Deliberately the ONLY filter on action items — Mark reviewed the current
    // set and approved it, so nothing else here second-guesses him.
    if (minActionWords > 0 && wordCount(text.replace(OMI_PREFIX_RE, '')) < minActionWords) continue;
    items.push({
      category: 'action_item',
      text,
      owner: null,
      systems: [],
      evidence: 'omi structured.action_items',
      confidence: 1,
      stated_by_mark: true,
      omi_action_item_id: typeof it === 'object' && it?.id ? String(it.id) : null,
      due_at: typeof it === 'object' && it?.due_at ? String(it.due_at) : null,
    });
  }

  // A conversation where something was settled but nothing was assigned still
  // carries the thing that was settled. One card, from the overview.
  //
  // 2026-09-16 — this reads survivedWithoutFloor, NOT items.length, and the
  // difference matters. If the word floor above empties a conversation that DID
  // have action items, reading items.length would open this gate and mint an
  // unconfirmed_decision card the conversation does not have today. A change
  // whose whole point is to remove noise must not manufacture a new row on its
  // way past. A conversation Omi filed with no action items at all is the only
  // one this fallback was ever for, and it still reaches it.
  if (!survivedWithoutFloor && overview && DECISION_WORDS.test(overview)) {
    items.push({
      category: 'decision_candidate',
      text: clampStr(overview, 300).trim(),
      owner: null,
      systems: [],
      evidence: 'omi structured.overview',
      confidence: 1,
      stated_by_mark: true,
      omi_action_item_id: null,
      due_at: null,
    });
  }

  return {
    has_business_content: items.length > 0,
    title: clampStr(title || 'Omi conversation', 80).trim() || 'Omi conversation',
    summary: clampStr(overview, 600).trim(),
    // Omi gives us no transcript, so a search key cannot be "a phrase that
    // appears literally in the transcript" the way the extractor's are. The
    // category and folder are what Omi itself filed this under.
    search_keys: [conv.omi_category, conv.omi_folder, 'Omi'].filter(Boolean).map((k) => clampStr(k, 80)),
    items,
    model: null,
    via: 'structured',
  };
}

// ─── 3. Extraction ─────────────────────────────────────────────────────────
export const EXTRACT_SYSTEM = [
  'You read a transcript of a spoken conversation recorded by Mark Richard, who runs revenue operations at Reece Windows & Doors (a Florida window and door replacement company).',
  'You extract ONLY business and operations content about Reece: the lead funnel, GoHighLevel workflows, the Five9 dialer, Lead Perfection, reporting, staffing and process. Ignore small talk, personal matters, family, travel and anything unrelated to running the company.',
  '',
  'Rules, in order of importance:',
  '1. NEVER invent. If the transcript does not say it, it does not exist. An empty items list is a correct answer.',
  '2. NEVER include a customer name, phone number, email address or street address in ANY field.',
  '3. Phrase every item as ONE plain statement a reader can act on without the transcript.',
  '4. A decision is only "already made" if the speaker plainly says it is done. Anything else is proposed — use decision_candidate or proposal.',
  '5. search_keys must be words or short phrases that appear LITERALLY in the transcript, so the item can be found again by searching for them.',
  '6. evidence is a SHORT PARAPHRASE (25 words maximum) of where in the conversation the item came from. It is not a quote.',
  '7. confidence is how sure you are the item is real and correctly stated: 0 to 1.',
  '',
  'Reply with JSON only — no prose, no markdown fence. Shape:',
  '{"has_business_content":boolean,"title":string,"summary":string,"search_keys":[string],"items":[',
  ' {"category":"decision_candidate|proposal|commitment|action_item|pending_item|question|issue|risk|system_change",',
  '  "text":string,"owner":string|null,"systems":[string],"evidence":string,"confidence":number,"stated_by_mark":boolean}]}',
  'title max 80 characters. summary max 600 characters. search_keys: 3 to 8 entries. item text max 300 characters.',
].join('\n');

function clampStr(v, max) {
  const s = v == null ? '' : String(v);
  return s.length > max ? s.slice(0, max) : s;
}

/** Validate + clamp the model's JSON. Throws OmiExtractError with a reason the repair pass can act on. */
export function validateExtraction(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OmiExtractError('response is not a JSON object');
  if (typeof raw.has_business_content !== 'boolean') throw new OmiExtractError('has_business_content must be a boolean');
  if (!Array.isArray(raw.items)) throw new OmiExtractError('items must be an array');

  const keys = (Array.isArray(raw.search_keys) ? raw.search_keys : [])
    .map((k) => clampStr(k, 80).trim()).filter(Boolean).slice(0, 8);

  const items = raw.items.map((it, i) => {
    if (!it || typeof it !== 'object') throw new OmiExtractError(`items[${i}] is not an object`);
    const category = String(it.category || '').toLowerCase().trim();
    if (!OMI_CATEGORY_MAP[category]) {
      throw new OmiExtractError(`items[${i}].category '${it.category}' is not one of ${OMI_CATEGORIES.join('|')}`);
    }
    const text = clampStr(it.text, 300).trim();
    if (!text) throw new OmiExtractError(`items[${i}].text is empty`);
    const confidence = Number(it.confidence);
    return {
      category,
      text,
      owner: it.owner == null || it.owner === '' ? null : clampStr(it.owner, 100).trim() || null,
      systems: (Array.isArray(it.systems) ? it.systems : []).map((s) => clampStr(s, 60).trim()).filter(Boolean).slice(0, 8),
      evidence: clampStr(it.evidence, 300).trim(),
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
      stated_by_mark: it.stated_by_mark === true,
    };
  });

  return {
    has_business_content: raw.has_business_content,
    title: clampStr(raw.title, 80).trim() || 'Omi conversation',
    summary: clampStr(raw.summary, 600).trim(),
    search_keys: keys,
    items,
  };
}

/** ONE structured call, temperature 0, with a single repair retry on bad JSON. */
export async function extractOmiItems(conv, { llm, maxTokens = 2000 } = {}) {
  const context = [
    conv.omi_title ? `Omi's own title: ${conv.omi_title}` : '',
    conv.omi_category ? `Omi's own category: ${conv.omi_category}` : '',
    `Speakers heard: ${conv.speakers.length ? conv.speakers.join(', ') : 'unknown'}`,
    '',
    'TRANSCRIPT:',
    conv.transcript,
  ].filter(Boolean).join('\n');

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const user = attempt === 1
      ? context
      : `${context}\n\nYour previous reply could not be used: ${lastError}\nReply again with JSON only, matching the shape exactly.`;
    let res;
    try {
      res = await llm({ fn: 'omi_extract', system: EXTRACT_SYSTEM, user, maxTokens, temperature: 0, json: true });
    } catch (err) {
      // A transport / provider failure is not something a repair prompt fixes.
      throw new OmiExtractError(`extraction call failed: ${err.message}`);
    }
    try {
      const data = validateExtraction(res && typeof res === 'object' && 'data' in res ? res.data : res);
      return { ...data, model: (res && res.model) || null, attempts: attempt };
    } catch (err) {
      lastError = err.message;
      if (attempt === 2) throw new OmiExtractError(`extraction did not match the schema after a repair attempt: ${err.message}`);
    }
  }
  throw new OmiExtractError(lastError || 'extraction failed');
}

// ─── 5. Scrub ──────────────────────────────────────────────────────────────
/** A key that scrubbed down to nothing (or to a bare placeholder) is not a search key. */
function usefulKey(k) {
  const s = String(k || '').trim();
  if (!s) return false;
  return !/^(\[phone\]|\[email\])$/i.test(s);
}

export function scrubExtraction(ex) {
  return {
    ...ex,
    title: stripPii(ex.title),
    summary: stripPii(ex.summary),
    search_keys: ex.search_keys.map((k) => stripPii(k).trim()).filter(usefulKey),
    items: ex.items.map((it) => ({
      ...it,
      text: stripPii(it.text),
      evidence: stripPii(it.evidence),
      owner: it.owner ? (stripPii(it.owner).trim() || null) : null,
    })),
  };
}

// ─── Helpers around the memory tables ──────────────────────────────────────
function must(res, what) {
  if (res?.error) throw new Error(`${what}: ${res.error.message}`);
  return res?.data ?? null;
}

/** An existing description may itself carry the "[Omi YYYY-MM-DD] " tag; compare the substance. */
function dedupeKeyOf(text) { return normText(String(text || '').replace(OMI_PREFIX_RE, '')); }

/** Best-effort validation-log row. Never throws — the ingest must not fail because logging did. */
async function logOmi(db, row) {
  try {
    const res = await db.from('claude_memory_validation_log').insert({
      check_name: row.check_name, mode: row.mode ?? null, rows_checked: row.rows_checked ?? null,
      rows_flagged: row.rows_flagged ?? null, sample: row.sample ?? null, notes: row.notes ?? null,
    });
    if (res?.error) console.warn(`[OmiIngest] validation log skipped: ${res.error.message}`);
  } catch (err) { console.warn(`[OmiIngest] validation log skipped: ${err.message}`); }
}

async function findDuplicate(db, { key, ledger_ref }) {
  const s = await db.from('claude_session_logs').select('id').eq('checkpoint_key', key).maybeSingle();
  const session = must(s, 'omi duplicate lookup (session)');
  if (session?.id) return { status: 'duplicate_event', session_id: session.id, reason: 'session_exists' };
  const l = await db.from('claude_transcript_ledger').select('session_id, disposition').eq('chat_url', ledger_ref).maybeSingle();
  const ledger = must(l, 'omi duplicate lookup (ledger)');
  if (ledger?.disposition === 'no_content') {
    return { status: 'duplicate_event', session_id: ledger.session_id ?? null, reason: 'no_content_already_recorded' };
  }
  return null;
}

/**
 * Open pending descriptions, for the exact-text half of the dedupe. One query
 * per conversation (a handful a day), capped — the vector pass below is what
 * catches anything the cap misses.
 */
async function loadOpenPending(db) {
  const res = await db.from('claude_pending_items')
    .select('id, description, status')
    .eq('status', 'open')
    .order('id', { ascending: false })
    .limit(PENDING_SCAN_LIMIT);
  const rows = must(res, 'omi open pending scan') || [];
  const byText = new Map();
  for (const r of rows) {
    const k = dedupeKeyOf(r.description);
    if (k && !byText.has(k)) byText.set(k, r.id);
  }
  return byText;
}

async function vectorHits(db, embed, text, { kind, threshold, count = 5 }) {
  const q = await embed(text);
  const res = await db.rpc('match_memory_embeddings', {
    query_embedding: q.embedding,
    match_threshold: threshold,
    match_count: count,
    filter_area: null,
    filter_kind: kind,
    include_closed: false,
  });
  if (res?.error) throw new Error(res.error.message);
  return (res?.data || []).filter((h) => typeof h.similarity === 'number' && h.similarity >= threshold);
}

const CLASSIFY_SYSTEM = [
  'You compare a CONFIRMED decision already recorded for Reece Windows & Doors with something heard in a spoken conversation.',
  'Answer with JSON only: {"verdict":"same|conflicts|unrelated","why":"one short sentence"}.',
  '  same       — the spoken item restates the recorded decision. Same subject, same outcome.',
  '  conflicts  — same subject, DIFFERENT outcome. Following one would contradict the other.',
  '  unrelated  — different subject, however similar the wording.',
  'When you are unsure between same and conflicts, answer conflicts: a flag a human dismisses costs less than a contradiction nobody sees.',
].join('\n');

async function classifyPair(llm, decisionText, omiText) {
  const res = await llm({
    fn: 'omi_extract',
    system: CLASSIFY_SYSTEM,
    user: `RECORDED DECISION:\n${decisionText}\n\nHEARD IN CONVERSATION:\n${omiText}`,
    maxTokens: 200, temperature: 0, json: true,
  });
  const data = res && typeof res === 'object' && 'data' in res ? res.data : res;
  const verdict = String(data?.verdict || '').toLowerCase().trim();
  return ['same', 'conflicts', 'unrelated'].includes(verdict)
    ? { verdict, why: clampStr(data?.why, 200) }
    : { verdict: 'unrelated', why: 'classifier returned no usable verdict' };
}

// ─── The ingest ────────────────────────────────────────────────────────────
/**
 * @param {object} body   the Omi conversation webhook payload
 * @param {object} deps
 *   db     REQUIRED — the omi-db.js guarded proxy
 *   llm    ({fn,system,user,maxTokens,temperature,json}) => {data,model}; defaults to callLLMJson
 *   embed  (text) => {embedding}; defaults to the OpenAI client when OPENAI_API_KEY is set,
 *          else the vector dedupe and conflict check are skipped (never fatal)
 *   env / now  injected in tests
 * @returns {Promise<object>} { status: 'written' | 'shadow' | 'no_content' | 'duplicate_event', … }
 */
export async function ingestOmiConversation(body, { db, llm, embed, env = process.env, now = new Date() } = {}) {
  if (!db) throw new Error('omi ingest: db is required (pass the omi-db.js guarded client)');
  const cfg = getOmiConfig(env);
  let stage = 'normalize';
  let conv = null;
  try {
    conv = normalizeOmiConversation(body, { now, maxTranscriptChars: cfg.maxTranscriptChars });
    const key = omiCheckpointKey(conv.conversation_id);
    const ledger_ref = omiLedgerRef(conv.conversation_id);
    const base = { conversation_id: conv.conversation_id, mode: cfg.mode };

    // 2. Idempotency FIRST, so a replay never spends a model call.
    stage = 'idempotency';
    const dup = await findDuplicate(db, { key, ledger_ref });
    if (dup) return { ...base, ...dup };

    // A discarded recording, or one with neither a transcript nor Omi's own
    // structured summary, is recorded as handled and dropped.
    const structured = hasStructuredContent(body);
    if (conv.discarded || (!conv.transcript.trim() && !structured)) {
      return { ...base, ...(await recordNoContent(db, { ledger_ref, mode: cfg.mode, reason: conv.discarded ? 'discarded' : 'empty_transcript' })) };
    }

    // 3. Extract — or, when Omi has already done it, map.
    //
    // 2026-09-14: the pull path ALWAYS lands here with structured content and
    // no transcript, so it never spends a model call. The LLM branch below is
    // now only reached by a webhook body that carries transcript_segments and
    // no `structured` — which is the only shape a model can add anything to.
    stage = 'extract';
    let extracted;
    if (structured) {
      extracted = mapStructuredExtraction(conv, { minActionWords: cfg.minActionWords });
    } else {
      const llmFn = llm === undefined ? (await import('../llm-client.js')).callLLMJson : llm;
      extracted = { ...(await extractOmiItems(conv, { llm: llmFn })), via: 'llm' };
    }

    // 4. Filter by confidence.
    stage = 'filter';
    const kept = extracted.items.filter((it) => it.confidence >= cfg.minConfidence);
    if (!extracted.has_business_content || !kept.length) {
      return {
        ...base,
        ...(await recordNoContent(db, { ledger_ref, mode: cfg.mode, reason: extracted.has_business_content ? 'no_items_above_confidence' : 'no_business_content' })),
        extracted: extracted.items.length,
      };
    }

    // 5. Scrub — before anything reaches the database.
    stage = 'scrub';
    const clean = scrubExtraction({ ...extracted, items: kept });

    // 6/7. Dedupe, conflict check, and the rows we would write.
    stage = 'plan';
    const embedFn = embed === undefined ? await defaultEmbed(env) : embed;
    const llmForClassify = llm === undefined ? (await import('../llm-client.js')).callLLMJson : llm;
    const plan = await planRows(clean, conv, {
      db, embed: embedFn, llm: llmForClassify, cfg, key, ledger_ref, now,
      // Never borrow OMI_EXTRACT_MODEL on the mapped path. A row that no model
      // touched must not carry a model's name — that is the field anyone
      // auditing "what did this cost" reads first.
      extraction_model: extracted.via === 'structured' ? null : (extracted.model || cfg.model || null),
      extraction_via: extracted.via || 'llm',
    });

    // 9. Write (or, in shadow, describe).
    if (cfg.mode === 'shadow') {
      stage = 'shadow_log';
      await logOmi(db, {
        check_name: 'omi:shadow', mode: 'shadow',
        rows_checked: clean.items.length, rows_flagged: plan.conflicts,
        sample: plan.payload,
        notes: `would write ${plan.payload.items.length} item(s), append ${plan.payload.mentions.length} mention(s)`,
      });
      return {
        ...base, status: 'shadow', planned: plan.payload.items.length,
        mentions: plan.payload.mentions.length, conflicts: plan.conflicts,
        restated: plan.restated, deduped: plan.deduped, via: extracted.via,
        llm_calls: plan.llm_calls,
      };
    }

    stage = 'rpc';
    const res = await db.rpc('claude_omi_ingest', { p: plan.payload });
    if (res?.error) throw new Error(`claude_omi_ingest: ${res.error.message}`);
    const out = (Array.isArray(res?.data) ? res.data[0] : res?.data) || {};
    for (const entry of plan.logs) await logOmi(db, entry);

    const pendingIds = Array.isArray(out.pending_ids) ? out.pending_ids : [];
    const embedded = out.status === 'written' && pendingIds.length
      ? await embedNewItems(db, embedFn, pendingIds)
      : { embedded: 0, skipped: 'nothing to embed' };

    return {
      ...base, ...out, conflicts: plan.conflicts, restated: plan.restated,
      deduped: plan.deduped, embed: embedded, via: extracted.via, llm_calls: plan.llm_calls,
    };
  } catch (err) {
    // 10. Record the failure WITHOUT any transcript text, then rethrow so the
    //     route answers 500 and n8n retries — which the idempotency key makes safe.
    await logOmi(db, {
      check_name: 'omi:ingest_failed', mode: cfg.mode, rows_flagged: 1,
      sample: {
        conversation_id: conv?.conversation_id ?? null,
        bytes: conv?.transcript?.length ?? null,
        segments: conv?.segment_count ?? null,
        stage,
        error: String(err?.message || err).slice(0, 500),
      },
      notes: `omi ingest failed at ${stage}`,
    });
    throw err;
  }
}

async function defaultEmbed(env = process.env) {
  if (!env.OPENAI_API_KEY) return null;
  const m = await import('../knowledge/openai-embeddings.js');
  return m.embed;
}

/** Ledger row saying this conversation held nothing worth remembering. */
async function recordNoContent(db, { ledger_ref, mode, reason }) {
  if (mode === 'shadow') {
    await logOmi(db, { check_name: 'omi:shadow', mode: 'shadow', rows_checked: 0, rows_flagged: 0, sample: { ledger_ref, reason }, notes: 'would record no_content' });
    return { status: 'no_content', reason, ledger: 'shadow' };
  }
  const res = await db.from('claude_transcript_ledger').upsert({
    chat_url: ledger_ref, session_id: null, disposition: 'no_content',
    reviewed_at: new Date().toISOString(), notes: `omi ingest: ${reason}`,
  }, { onConflict: 'chat_url' });
  if (res?.error) throw new Error(`omi no_content ledger: ${res.error.message}`);
  return { status: 'no_content', reason, ledger: 'no_content' };
}

/**
 * Dedupe → conflict check → the exact jsonb claude_omi_ingest() expects.
 * Nothing here writes; shadow mode runs this same function.
 */
async function planRows(clean, conv, { db, embed, llm, cfg, key, ledger_ref, now, extraction_model, extraction_via = 'llm' }) {
  const openPending = await loadOpenPending(db);
  const seenInPayload = new Map();
  const items = [];
  const mentions = [];
  const logs = [];
  let conflicts = 0;
  let restated = 0;
  // Counted, not assumed. The mapped path spends nothing on extraction, but the
  // conflict classifier below is still a model call — it fires only when a
  // decision-shaped item vector-matches an ACTIVE decision above
  // MEMORY_CONFLICT_THRESHOLD, which is rare. Returning the count means "zero
  // LLM cost on the pull path" is something a run can be checked against
  // rather than something a comment claims.
  let llm_calls = 0;
  const deduped = { exact: 0, vector: 0, in_payload: 0 };

  const extraction_at = now.toISOString();
  const datePrefix = `[Omi ${conv.session_date}] `;

  for (const it of clean.items) {
    const textKey = dedupeKeyOf(it.text);

    // (c) the same thing said twice in one conversation
    if (seenInPayload.has(textKey)) { deduped.in_payload += 1; continue; }

    // (a) exact text against an open item of any origin
    const exact = openPending.get(textKey);
    if (exact != null) {
      deduped.exact += 1;
      mentions.push({ pending_id: exact, mention: mentionOf(conv, it) });
      seenInPayload.set(textKey, true);
      continue;
    }

    // (b) vector against open pending items
    let conflictCheck = embed ? 'ran' : 'skipped';
    if (embed) {
      try {
        const hits = await vectorHits(db, embed, it.text, { kind: 'pending', threshold: cfg.dedupeThreshold });
        const top = hits.find((h) => String(h.status || 'open') === 'open');
        if (top) {
          deduped.vector += 1;
          mentions.push({ pending_id: top.source_id, mention: { ...mentionOf(conv, it), similarity: Number(top.similarity.toFixed(3)) } });
          seenInPayload.set(textKey, true);
          continue;
        }
      } catch (err) {
        conflictCheck = `skipped: ${err.message}`;
        console.warn(`[OmiIngest] vector dedupe skipped: ${err.message}`);
      }
    }

    // (7) conflict check — decision-shaped items only
    let conflictsWith = null;
    if (embed && DECISION_CATEGORIES.has(it.category) && !String(conflictCheck).startsWith('skipped')) {
      try {
        const hits = await vectorHits(db, embed, it.text, { kind: 'decision', threshold: cfg.conflictThreshold });
        const top = hits.find((h) => String(h.status || 'active') === 'active');
        if (top) {
          llm_calls += 1;
          const verdict = await classifyPair(llm, String(top.text || ''), it.text);
          if (verdict.verdict === 'same') {
            restated += 1;
            logs.push({
              check_name: 'omi:restated', mode: cfg.mode, rows_checked: 1, rows_flagged: 0,
              sample: { conversation_id: conv.conversation_id, decision_id: top.source_id, similarity: Number(top.similarity.toFixed(3)), why: verdict.why },
              notes: 'heard again; the confirmed decision was not touched',
            });
            seenInPayload.set(textKey, true);
            continue; // no row: this is not news
          }
          if (verdict.verdict === 'conflicts') {
            conflicts += 1;
            conflictsWith = { id: top.source_id, similarity: Number(top.similarity.toFixed(3)), why: verdict.why };
            logs.push({
              check_name: 'omi:conflict', mode: cfg.mode, rows_checked: 1, rows_flagged: 1,
              sample: { conversation_id: conv.conversation_id, decision_id: top.source_id, similarity: conflictsWith.similarity, why: verdict.why, heard: it.text.slice(0, 200) },
              notes: 'flagged as an unconfirmed proposal; the confirmed decision is unchanged',
            });
          }
        }
      } catch (err) {
        conflictCheck = `skipped: ${err.message}`;
        console.warn(`[OmiIngest] conflict check skipped: ${err.message}`);
      }
    }

    seenInPayload.set(textKey, true);
    items.push(buildItem(it, {
      conv, datePrefix, conflictsWith, conflictCheck, extraction_at, extraction_model,
      extraction_via, speakers: conv.speakers, mark_spoke: conv.mark_spoke,
    }));
  }

  return {
    payload: {
      checkpoint_key: key,
      session: {
        session_date: conv.session_date,
        session_title: clampStr(clean.title, 300),
        raw_summary: clean.summary,
        transcript_search_keys: clean.search_keys,
      },
      items,
      mentions,
      ledger_ref,
    },
    logs, conflicts, restated, deduped, llm_calls,
  };
}

function mentionOf(conv, it) {
  return { conversation_id: conv.conversation_id, date: conv.session_date, item_text: it.text };
}

function buildItem(it, { conv, datePrefix, conflictsWith, conflictCheck, extraction_at, extraction_model, extraction_via = 'llm', speakers, mark_spoke }) {
  const item_type = OMI_CATEGORY_MAP[it.category];
  let description = it.text;
  if (item_type === 'verification_needed') description = `${ISSUE_PREFIX}${description}`;
  if (conflictsWith) description = `CONFLICTS WITH #${conflictsWith.id} — ${description}`;
  description = `${datePrefix}${description}`;

  const raw = {
    source: 'omi',
    source_type: 'conversation',
    omi_conversation_id: conv.conversation_id,
    conversation_started_at: conv.started_at,
    conversation_finished_at: conv.finished_at,
    extraction_at,
    extraction_model,
    extraction_via,
    confidence: it.confidence,
    confidence_label: 'unconfirmed',
    omi_category: it.category,
    // Omi's OWN category for the conversation, kept alongside ours. The handoff
    // calls for the original to survive: ours says what kind of card this is,
    // Omi's says what Omi thought the conversation was about.
    omi_conversation_category: conv.omi_category || null,
    omi_folder: conv.omi_folder || null,
    omi_source: conv.omi_source || null,
    systems: it.systems,
    evidence: it.evidence,
    speakers,
    mark_spoke,
    stated_by_mark: it.stated_by_mark,
  };
  // The write-back loop guard, when this row came from a task Omi already had.
  if (it.omi_action_item_id) raw.omi_action_item_id = it.omi_action_item_id;
  if (it.due_at) raw.due_at = it.due_at;
  if (conflictsWith) {
    raw.conflicts_with_decision_id = conflictsWith.id;
    raw.conflict_similarity = conflictsWith.similarity;
    raw.conflict_reason = conflictsWith.why;
  }
  if (String(conflictCheck).startsWith('skipped')) raw.conflict_check = 'skipped';

  return {
    item_type,
    description,
    priority: conflictsWith ? 1 : null,
    owner: it.owner,
    raw,
  };
}

/**
 * Best-effort embed of the rows just written, so they are searchable now rather
 * than after tonight's run. A failure is logged and swallowed: the nightly
 * re-embed is content-hash incremental and catches up on its own.
 */
async function embedNewItems(db, embed, pendingIds) {
  if (!embed) return { embedded: 0, skipped: 'no embed client' };
  try {
    const res = await db.from('claude_pending_items')
      .select('id, session_date, kind, item_type, description, ref, area, origin, status')
      .in('id', pendingIds);
    const rows = must(res, 'omi embed re-read') || [];
    if (!rows.length) return { embedded: 0, skipped: 'rows not found' };
    const shaped = [];
    for (const row of rows) {
      const base = toEmbeddingRow('pending', row);
      const q = await embed(base.embedded_text);
      shaped.push({ ...base, embedding: q.embedding, embedded_at: new Date().toISOString() });
    }
    const up = await db.from('claude_memory_embeddings').upsert(shaped, { onConflict: 'source_table,source_id' });
    if (up?.error) throw new Error(up.error.message);
    return { embedded: shaped.length };
  } catch (err) {
    console.warn(`[OmiIngest] best-effort embed skipped: ${err.message}`);
    return { embedded: 0, skipped: err.message };
  }
}

export default {
  ingestOmiConversation, getOmiMode, getOmiConfig, omiCheckpointKey, omiLedgerRef,
  hasStructuredContent, mapStructuredExtraction,
};
