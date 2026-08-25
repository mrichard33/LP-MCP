/**
 * Call Intelligence — AI output contract (schema_version 1.0) — src/ci/analysis-schema.js
 *
 * The verbatim §7 structured-output shape, plus a validator and the review
 * triggers that read it. Pure module: no env, no clients, no import-time work.
 *
 * WHY A HAND-ROLLED VALIDATOR: this repo runs on six production dependencies
 * and adds none lightly. The §7 schema is fixed, small, and versioned — a
 * declarative spec plus ~80 lines of walker costs less than a schema-validator
 * dependency and its transitive tree, and it lets the error strings name the
 * exact JSON path a model got wrong, which is what lands in ci_events when a
 * call goes to review.
 *
 * WHY VALIDATION IS NOT OPTIONAL: this output is the sole input to note text
 * that will eventually be written into two CRMs against a real customer
 * record. A model that returns an outcome outside the taxonomy, or a
 * confidence as the string "high" instead of a number, must land in review —
 * never in a note. §7: two failed attempts → review with `ai_output_invalid`.
 *
 * Changing the taxonomy or the shape is a SCHEMA BUMP (schema_version), never
 * an ad-hoc edit — stored rows carry the version they were produced under.
 */

export const ANALYSIS_SCHEMA_VERSION = '1.0';

/** §7 outcome taxonomy, v1. Order is the handoff's; do not sort. */
export const OUTCOMES = [
  'appointment_set',
  'appointment_confirmed',
  'appointment_rescheduled',
  'appointment_cancelled',
  'callback_requested',
  'follow_up_required',
  'not_interested',
  'wrong_number',
  'no_meaningful_contact',
  'dnc_request',
  'qualification_completed',
  'customer_service',
  'escalation_required',
  'sale_discussion',
  'other',
];

/** Provenance of a single extracted value. */
export const VALUE_SOURCES = ['stated', 'unknown'];
/** Provenance of a judgement (an outcome or a key detail may be inferred). */
export const BASIS_SOURCES = ['stated', 'inferred'];

/** The eight §7 booleans, exact names and order. */
export const FLAG_KEYS = [
  'dnc_request',
  'cancellation_request',
  'reschedule_request',
  'escalation',
  'complaint',
  'pricing_discussed',
  'financing_discussed',
  'spanish',
];

const CUSTOMER_FIELDS = ['name', 'phone_mentioned', 'email', 'address'];

/** A {value, source, confidence} triple. `value` is a nullable string. */
function checkValueTriple(node, path, errors) {
  if (!isPlainObject(node)) {
    errors.push(`${path}: expected an object`);
    return;
  }
  rejectExtraKeys(node, ['value', 'source', 'confidence'], path, errors);
  if (!('value' in node)) errors.push(`${path}.value: missing`);
  else if (node.value !== null && typeof node.value !== 'string') {
    errors.push(`${path}.value: expected string or null, got ${typeName(node.value)}`);
  }
  checkEnum(node.source, VALUE_SOURCES, `${path}.source`, errors);
  checkConfidence(node.confidence, `${path}.confidence`, errors);

  // A value cannot be both absent and attested. §7: absent → value null with
  // source 'unknown'. The inverse — a stated value that is null — is the shape
  // a model produces when it wants to claim something it did not hear.
  if (node.source === 'stated' && node.value === null) {
    errors.push(`${path}: source 'stated' with a null value`);
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function typeName(v) {
  if (v === null) return 'null';
  return Array.isArray(v) ? 'array' : typeof v;
}

/** additionalProperties:false, everywhere — §7 says so for every object. */
function rejectExtraKeys(node, allowed, path, errors) {
  for (const k of Object.keys(node)) {
    if (!allowed.includes(k)) errors.push(`${path}.${k}: unexpected property`);
  }
}

function checkEnum(v, allowed, path, errors) {
  if (!allowed.includes(v)) {
    errors.push(`${path}: expected one of ${allowed.join('|')}, got ${JSON.stringify(v)}`);
  }
}

function checkConfidence(v, path, errors) {
  if (typeof v !== 'number' || Number.isNaN(v)) {
    errors.push(`${path}: expected a number, got ${typeName(v)}`);
    return;
  }
  if (v < 0 || v > 1) errors.push(`${path}: expected 0..1, got ${v}`);
}

function checkBool(v, path, errors) {
  if (typeof v !== 'boolean') errors.push(`${path}: expected a boolean, got ${typeName(v)}`);
}

function checkNullableString(v, path, errors) {
  if (v !== null && typeof v !== 'string') {
    errors.push(`${path}: expected string or null, got ${typeName(v)}`);
  }
}

/**
 * Validate a candidate AI output against schema_version 1.0.
 *
 * Collects EVERY error rather than failing at the first — the whole list goes
 * into ci_events, so a reviewer sees the full picture of what the model got
 * wrong instead of one symptom at a time.
 *
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateAnalysis(obj) {
  const errors = [];
  if (!isPlainObject(obj)) {
    return { valid: false, errors: [`root: expected an object, got ${typeName(obj)}`] };
  }

  rejectExtraKeys(
    obj,
    ['schema_version', 'summary', 'outcome', 'outcome_confidence', 'outcome_basis',
      'customer', 'appointment', 'follow_up', 'key_details', 'flags', 'quality'],
    'root',
    errors,
  );

  if (obj.schema_version !== ANALYSIS_SCHEMA_VERSION) {
    errors.push(`root.schema_version: expected '${ANALYSIS_SCHEMA_VERSION}', got ${JSON.stringify(obj.schema_version)}`);
  }

  if (typeof obj.summary !== 'string' || !obj.summary.trim()) {
    errors.push('root.summary: expected a non-empty string');
  } else if (countWords(obj.summary) > 120) {
    // §7 caps the summary at 120 words. It becomes note text in two CRMs;
    // an unbounded summary is how a note turns into a transcript dump.
    errors.push(`root.summary: ${countWords(obj.summary)} words, limit is 120`);
  }

  checkEnum(obj.outcome, OUTCOMES, 'root.outcome', errors);
  checkConfidence(obj.outcome_confidence, 'root.outcome_confidence', errors);
  checkEnum(obj.outcome_basis, BASIS_SOURCES, 'root.outcome_basis', errors);

  // customer
  if (!isPlainObject(obj.customer)) {
    errors.push('root.customer: expected an object');
  } else {
    rejectExtraKeys(obj.customer, CUSTOMER_FIELDS, 'root.customer', errors);
    for (const f of CUSTOMER_FIELDS) {
      if (!(f in obj.customer)) errors.push(`root.customer.${f}: missing`);
      else checkValueTriple(obj.customer[f], `root.customer.${f}`, errors);
    }
  }

  // appointment
  if (!isPlainObject(obj.appointment)) {
    errors.push('root.appointment: expected an object');
  } else {
    rejectExtraKeys(obj.appointment, ['discussed', 'date', 'time', 'notes'], 'root.appointment', errors);
    checkBool(obj.appointment.discussed, 'root.appointment.discussed', errors);
    checkValueTriple(obj.appointment.date, 'root.appointment.date', errors);
    checkValueTriple(obj.appointment.time, 'root.appointment.time', errors);
    checkNullableString(obj.appointment.notes, 'root.appointment.notes', errors);
  }

  // follow_up
  if (!isPlainObject(obj.follow_up)) {
    errors.push('root.follow_up: expected an object');
  } else {
    rejectExtraKeys(obj.follow_up, ['required', 'when', 'action'], 'root.follow_up', errors);
    checkBool(obj.follow_up.required, 'root.follow_up.required', errors);
    checkNullableString(obj.follow_up.when, 'root.follow_up.when', errors);
    checkNullableString(obj.follow_up.action, 'root.follow_up.action', errors);
  }

  // key_details
  if (!Array.isArray(obj.key_details)) {
    errors.push(`root.key_details: expected an array, got ${typeName(obj.key_details)}`);
  } else {
    obj.key_details.forEach((d, i) => {
      const path = `root.key_details[${i}]`;
      if (!isPlainObject(d)) {
        errors.push(`${path}: expected an object`);
        return;
      }
      rejectExtraKeys(d, ['detail', 'source', 'confidence'], path, errors);
      if (typeof d.detail !== 'string' || !d.detail.trim()) {
        errors.push(`${path}.detail: expected a non-empty string`);
      }
      checkEnum(d.source, BASIS_SOURCES, `${path}.source`, errors);
      checkConfidence(d.confidence, `${path}.confidence`, errors);
    });
  }

  // flags — all eight required, booleans, nothing else
  if (!isPlainObject(obj.flags)) {
    errors.push('root.flags: expected an object');
  } else {
    rejectExtraKeys(obj.flags, FLAG_KEYS, 'root.flags', errors);
    for (const k of FLAG_KEYS) {
      if (!(k in obj.flags)) errors.push(`root.flags.${k}: missing`);
      else checkBool(obj.flags[k], `root.flags.${k}`, errors);
    }
  }

  // quality
  if (!isPlainObject(obj.quality)) {
    errors.push('root.quality: expected an object');
  } else {
    rejectExtraKeys(obj.quality, ['transcript_intelligible', 'uncertainty_notes'], 'root.quality', errors);
    checkBool(obj.quality.transcript_intelligible, 'root.quality.transcript_intelligible', errors);
    checkNullableString(obj.quality.uncertainty_notes, 'root.quality.uncertainty_notes', errors);
  }

  return { valid: errors.length === 0, errors };
}

function countWords(s) {
  return String(s).trim().split(/\s+/).filter(Boolean).length;
}

/** §7 confidence floor below which an outcome is not trusted unreviewed. */
export const OUTCOME_CONFIDENCE_FLOOR = 0.7;

/**
 * Flags that are RECORDED but do not stop a call.
 *
 * ── WHY unknown_team IS HERE ───────────────────────────────────────────────
 * 84 calls were parked on 'unknown_team', and measurement showed they are not
 * unmapped agents at all: every one has agent_username AND agent_name NULL.
 * 83 arrived on DNIS 2394930774 ('Canvass Confirmation - Inbound'), all
 * was_transferred, averaging 213 seconds; the 84th is the same shape on Main
 * Number. No Reece agent was on those calls — the caller reached a LINE and
 * was transferred to a third party. There is no team to resolve, so parking
 * them waits for an answer that will never come, and a real multi-minute
 * conversation with a customer produces no note at all.
 *
 * The flag STAYS. It is still written to ci_summaries.review_flags and still
 * carried in the ci_events detail, so "no team was resolved" remains visible
 * and queryable. Only the BLOCK is lifted.
 *
 * ── WHY A NAMED SET AND NOT A BOOLEAN ──────────────────────────────────────
 * A `blocking: false` property hung off a flag is a property the next flag
 * inherits by whichever default someone picks. Membership here is a decision
 * somebody has to write down, one reason at a time. Nothing joins this set
 * because it resembles something already in it.
 */
export const NON_BLOCKING_REVIEW_FLAGS = new Set(['unknown_team']);

/** The flags in `flags` that actually stop a call. Order is preserved. */
export function blockingReviewFlags(flags) {
  return (flags || []).filter((f) => !NON_BLOCKING_REVIEW_FLAGS.has(f));
}

/**
 * The §7 review triggers that are readable from the transcript + analysis
 * alone. Match-tier and sync-failure triggers belong to PRs 4 and 5 and are
 * deliberately absent here rather than stubbed.
 *
 * Returns the reasons, not a boolean: ci_summaries.review_flags stores the
 * full set so a reviewer knows why, and two calls flagged for different
 * reasons are not the same operational problem.
 *
 * @returns {string[]} zero or more review reasons
 */
export function analysisReviewFlags({ analysis, transcript = null, call = null } = {}) {
  const flags = [];
  if (transcript?.low_confidence) flags.push('low_confidence_transcript');
  if (!analysis) return flags;

  if (typeof analysis.outcome_confidence === 'number'
      && analysis.outcome_confidence < OUTCOME_CONFIDENCE_FLOOR) {
    flags.push('low_outcome_confidence');
  }
  // These two are customer intent with legal and retention weight. They go to
  // a human on every call, at any confidence — an automated note is not an
  // acceptable response to "take me off your list".
  if (analysis.flags?.dnc_request) flags.push('dnc_request');
  if (analysis.flags?.cancellation_request) flags.push('cancellation_request');

  if (analysis.quality && analysis.quality.transcript_intelligible === false) {
    flags.push('transcript_unintelligible');
  }
  // §7: an unknown agent or unmapped campaign is a review trigger. Known at
  // discovery, but re-checked here because this is where review_flags is
  // written and a call must not reach a CRM write with an unattributed team.
  if (call && (!call.team || call.team === 'unknown')) flags.push('unknown_team');

  return flags;
}
