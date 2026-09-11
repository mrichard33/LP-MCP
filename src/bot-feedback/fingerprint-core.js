/**
 * Bot Review — fingerprint pure core — src/bot-feedback/fingerprint-core.js
 *
 * v1.0 — 2026-09-11. BOT REVIEW PHASE 0.
 *   PROBLEM: nothing records WHY the bot said what it said. When a reply is
 *   wrong there is no snapshot of the inputs that produced it, so a fix can
 *   only ever be guessed at and never replayed.
 *   FIX: one bot_message_context row per reply / skip / nurture send, holding
 *   the inputs, the KB tier modes and the sources used. This file is the pure
 *   half — shaping and normalizing — so it is unit-testable with no I/O.
 *   All DB work lives in fingerprint.js.
 *
 * Dependency-free + pure, following the repo's *-core.js convention
 * (exemplars-core.js, ci-moments-core.js, vector-gate.js).
 */

/** Modes this feature understands. Mirrors vector-gate.js / exemplars-core.js. */
export const BOT_FINGERPRINT_MODES = new Set(['off', 'on']);

/**
 * Resolved BOT_FINGERPRINT_MODE for this process. Default 'on' (handoff §8):
 * Phase 0 is logging only and must be on from the first deploy, so coverage
 * can be measured. 'off' is the rollback switch — no code revert needed.
 */
export function getFingerprintMode(env = process.env) {
  const m = String(env.BOT_FINGERPRINT_MODE ?? 'on').toLowerCase().trim();
  return BOT_FINGERPRINT_MODES.has(m) ? m : 'on';
}

/** Resolved BOT_JUDGE_PERSIST for this process. Default 'on' (handoff §8). */
export function getJudgePersistMode(env = process.env) {
  const m = String(env.BOT_JUDGE_PERSIST ?? 'on').toLowerCase().trim();
  return m === 'off' ? 'off' : 'on';
}

/**
 * Normalize a channel to the three values the review queue groups on.
 *
 * The known defect this closes: the live-chat surface is spelled 'livechat'
 * in the action payload and send handler, 'live_chat' in some analytics, and
 * "Live Chat" in GHL exports. Three spellings meant three buckets in every
 * per-channel report. Normalize at WRITE so every downstream reader gets one.
 *
 * @returns {'sms'|'email'|'live_chat'|null}
 */
export function normalizeChannel(raw) {
  if (raw == null) return null;
  const s = String(raw).toLowerCase().replace(/[\s_-]+/g, '');
  if (s === 'sms' || s === 'text' || s === 'textmessage') return 'sms';
  if (s === 'email' || s === 'mail') return 'email';
  if (s === 'livechat' || s === 'chat' || s === 'webchat') return 'live_chat';
  return null;
}

/** Trim a string to `max` chars, returning null for empty/absent input. */
export function clip(value, max) {
  if (value == null) return null;
  const s = String(value);
  if (s.trim() === '') return null;
  return s.length > max ? s.slice(0, max) : s;
}

/** Coerce to a finite integer or null (buyer_stage is `integer` in the DDL). */
export function toInt(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * The version string stamped on every fingerprint so a replay knows which
 * generator produced the reply: the response-generator header version plus the
 * deployed git sha. Railway sets RAILWAY_GIT_COMMIT_SHA on every deploy.
 */
export function corePromptVersion(generatorVersion, env = process.env) {
  const v = clip(generatorVersion, 40) || 'unknown';
  const sha = env.RAILWAY_GIT_COMMIT_SHA || env.GIT_COMMIT_SHA || null;
  return sha ? `${v}+${String(sha).slice(0, 7)}` : v;
}

/** Last N thread turns, shaped small and stable for replay. */
export function shapeThread(conversation, limit = 10) {
  if (!Array.isArray(conversation)) return [];
  return conversation
    .slice(-limit)
    .map((m) => ({
      direction: m?.direction === 'inbound' || m?.direction === 'outbound' ? m.direction : null,
      channel: normalizeChannel(m?.type ?? m?.channel),
      body: clip(m?.body ?? m?.message ?? m?.text, 2000),
      at: m?.sent_at ?? m?.dateAdded ?? m?.created_at ?? m?.at ?? null,
    }))
    .filter((m) => m.body !== null || m.direction !== null);
}

/**
 * Build the replay snapshot (handoff §4.1 `input_snapshot`). Everything a
 * dry-run needs to reproduce the turn without touching live state.
 *
 * PII: kept as-is. This is an internal LP Supabase table, and a replay that
 * scrubs names cannot reproduce a reply that used one. Scrubbing happens later,
 * at the point examples leave the record (Phase 2, `exemplars.js` pattern).
 */
export function buildInputSnapshot(input = {}) {
  const {
    conversation = null,
    contactTags = [],
    buyerStage = null,
    activeEntryTag = null,
    lpDisposition = null,
    intentClass = null,
    detectedSignals = null,
    availability = null,
    channel = null,
    nowEt = null,
    extra = null,
  } = input;

  return {
    thread: shapeThread(conversation),
    contact_tags: Array.isArray(contactTags) ? contactTags.map(String) : [],
    buyer_stage: toInt(buyerStage),
    active_entry_tag: clip(activeEntryTag, 120),
    lp_disposition: clip(lpDisposition, 120),
    intent_class: clip(intentClass, 80),
    detected_signals: detectedSignals ?? null,
    booking_availability: shapeAvailability(availability),
    channel: normalizeChannel(channel),
    now_et: nowEt ?? null,
    ...(extra && typeof extra === 'object' ? extra : {}),
  };
}

/** Only what the reply could have offered — slots and the calendar it read. */
export function shapeAvailability(availability) {
  if (!availability || typeof availability !== 'object') return null;
  const slots = Array.isArray(availability.slots) ? availability.slots : [];
  return {
    calendar_name: clip(availability.calendar_name, 200),
    calendar_id: clip(availability.calendar_id, 120),
    slots_total_count: toInt(availability.slots_total_count),
    slots: slots.slice(0, 12).map((s) => (typeof s === 'string' ? s : (s?.start ?? s?.startTime ?? null))),
  };
}

/**
 * The per-tier mode map written to bot_message_context.kb_modes. Reads the
 * `*_mode` fields buildKbPack() already puts on the pack (v1.9/v1.11/v1.12),
 * plus the two Phase 2 learning tiers which are absent until then.
 */
export function extractKbModes(kbPack) {
  if (!kbPack || typeof kbPack !== 'object') return null;
  return {
    faq_semantic: kbPack.faq_semantic_mode ?? null,
    vector: kbPack.vector_mode ?? null,
    exemplars: kbPack.exemplar_mode ?? null,
    call_moments: kbPack.call_moments_mode ?? null,
    guidance: kbPack.guidance_mode ?? null,   // Phase 2
    examples: kbPack.examples_mode ?? null,   // Phase 2
  };
}

/** Small id-only view of what the pack actually retrieved. Bounded on purpose. */
export function extractKbSources(kbPack) {
  if (!kbPack || typeof kbPack !== 'object') return null;
  const ids = (arr, key = 'id') =>
    (Array.isArray(arr) ? arr : []).slice(0, 20).map((x) => x?.[key] ?? x?.doc_id ?? x?.chunk_id ?? null).filter((v) => v != null);

  return {
    faqs: ids(kbPack.faqs),
    objection_script: kbPack.objection_script?.id ?? null,
    exemplars: ids(kbPack.exemplars),
    call_moments: ids(kbPack.call_moments),
    vector_chunks: ids(kbPack.vector_context),
    proof_points: ids(kbPack.proof_points),
    primary_arc: kbPack.primary_arc?.arc_id ?? kbPack.primary_arc?.id ?? null,
  };
}

/**
 * Shape one bot_message_context row. Pure: every value is derived from the
 * argument, nothing is read from the environment except the git sha.
 *
 * Returns null when there is no usable `message_ref` — a row keyed on nothing
 * would break the UNIQUE(message_type, message_ref) contract the fingerprint
 * relies on for idempotency.
 */
export function buildContextRow(input = {}, env = process.env) {
  const messageType = input.message_type;
  if (!['reply', 'skip', 'nurture'].includes(messageType)) return null;

  const messageRef = clip(input.message_ref, 200);
  if (!messageRef) return null;

  return {
    message_type: messageType,
    message_ref: messageRef,
    ghl_contact_id: clip(input.ghl_contact_id, 120),
    channel: normalizeChannel(input.channel),
    intent_class: clip(input.intent_class, 80),
    buyer_stage: toInt(input.buyer_stage),
    rule_applied: clip(input.rule_applied, 200),
    workflow_code: clip(input.workflow_code, 80),
    prompt_code: clip(input.prompt_code, 80),
    prompt_version: toInt(input.prompt_version),
    core_prompt_version: corePromptVersion(input.core_prompt_version, env),
    model: clip(input.model, 120),
    inbound_text: clip(input.inbound_text, 8000),
    reply_text: clip(input.reply_text, 8000),
    skip_reason: clip(input.skip_reason, 500),
    input_snapshot: input.input_snapshot ?? null,
    kb_modes: input.kb_modes ?? null,
    kb_sources: input.kb_sources ?? null,
    guidance_version_ids: Array.isArray(input.guidance_version_ids) ? input.guidance_version_ids : [],
    example_ids: Array.isArray(input.example_ids) ? input.example_ids : [],
    shadow_guidance_version_ids: Array.isArray(input.shadow_guidance_version_ids) ? input.shadow_guidance_version_ids : [],
    shadow_example_ids: Array.isArray(input.shadow_example_ids) ? input.shadow_example_ids : [],
    generated_at: input.generated_at ?? new Date().toISOString(),
    sent_at: input.sent_at ?? null,
  };
}

/**
 * Did this send_message action end WITHOUT anything reaching the contact?
 *
 * One hook at the executor covers every gate — hard suppression, stop-bot,
 * supersession, the outbound lock, the quiet-hours hold, the compliance
 * short-circuit — instead of six call sites inside a 171KB handler. It runs
 * after the handler has already returned, so it is off the send path entirely.
 *
 * The tell is `sent_body`: both paths that actually call GHL put the delivered
 * text on their result (send-message-handler v3.17 line ~3277 and the
 * customer-status probe). A result without it never reached the contact.
 *
 * `pending` is NOT a skip — a deferral (tag sources unavailable, lock held) is
 * a reply that is late, not a reply that was withheld, and it will come back
 * through this same path when it sends.
 *
 * @returns {'skip'|null}
 */
export function classifySkipOutcome(actionType, status, result) {
  if (actionType !== 'send_message') return null;
  if (status === 'pending' || status === 'failed') return null;
  if (result?.sent_body) return null;
  if (status === 'skipped') return 'skip';
  // A 'completed' status with no delivered body: the gate returns in
  // executeSendMessage (suppressed / stop_bot / handed_off / no_trigger_message)
  // do not set `skipped: true`, so classifyHandlerResult records them as
  // completed. Honest for the executor's purposes; for review they are skips.
  const label = result?.action;
  if (typeof label === 'string' && label.startsWith('send_message_')) return 'skip';
  return null;
}

/** The reason text for a skip fingerprint, preferring the most specific source. */
export function skipReasonFor(result, errorMessage) {
  return clip(result?.reason || result?.action || errorMessage, 500);
}

/**
 * Postgres "relation does not exist". Mirrors isMissingRelation() in the
 * dashboard's lib/queries/commandCenter.ts — the handoff §1.2 rule: code must
 * degrade gracefully when sql/103 has not been applied yet.
 */
export function isMissingRelation(error) {
  if (!error) return false;
  return error.code === '42P01' || /does not exist|schema cache/i.test(error.message ?? '');
}

export default {
  BOT_FINGERPRINT_MODES,
  getFingerprintMode,
  getJudgePersistMode,
  normalizeChannel,
  clip,
  toInt,
  corePromptVersion,
  shapeThread,
  shapeAvailability,
  buildInputSnapshot,
  extractKbModes,
  extractKbSources,
  buildContextRow,
  classifySkipOutcome,
  skipReasonFor,
  isMissingRelation,
};
