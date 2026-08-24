/**
 * Call Intelligence — note composition — src/ci/notes.js
 *
 * §9. Builds the note body that goes into BOTH CRMs, identically. Pure module:
 * no env, no clients, no I/O. Composing and sending are separate on purpose —
 * shadow mode stores exactly the body it would have sent, so what a reviewer
 * reads during QA is byte-for-byte what would go live.
 *
 * ── THE FOOTER IS NOT DECORATION ───────────────────────────────────────────
 * Every note ends with an explicit AI provenance line. A rep reading their
 * pipeline must be able to tell in one glance that a note was machine-written
 * from a recording rather than typed by a colleague who was on the call — and
 * that commitments in it are unverified. The `AI-CI:` id makes any note
 * traceable back to its ci_calls row, which is the only way to answer "where
 * did this come from" six weeks later.
 *
 * ── WHAT IS DELIBERATELY EXCLUDED ──────────────────────────────────────────
 * Customer PII the model merely *heard* — a phone number or email spoken on
 * the call — is NOT written into the note. §7 captures it for matching and
 * audit; repeating it in CRM note text would scatter contact data into free
 * text across two systems with no way to redact it later.
 */

/** §7 outcome → the label a human reads. */
const OUTCOME_LABELS = {
  appointment_set: 'Appointment set',
  appointment_confirmed: 'Appointment confirmed',
  appointment_rescheduled: 'Appointment rescheduled',
  appointment_cancelled: 'Appointment cancelled',
  callback_requested: 'Callback requested',
  follow_up_required: 'Follow-up required',
  not_interested: 'Not interested',
  wrong_number: 'Wrong number',
  no_meaningful_contact: 'No meaningful contact',
  dnc_request: 'DNC REQUEST',
  qualification_completed: 'Qualification completed',
  customer_service: 'Customer service',
  escalation_required: 'ESCALATION REQUIRED',
  sale_discussion: 'Sale discussion',
  other: 'Other',
};

export function outcomeLabel(outcome) {
  return OUTCOME_LABELS[outcome] || String(outcome || 'Unknown');
}

/**
 * Format a UTC instant as Eastern wall-clock, DST-aware.
 *
 * This is display only, and it is the ONE place in the subsystem that uses
 * America/New_York. The recording filenames use a FIXED -5 offset with no DST
 * (see time.js) — mixing the two up is the highest-risk confusion in the
 * codebase, so the distinction is restated wherever either appears.
 */
export function formatEt(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown time';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('month')}/${get('day')} ${get('hour')}:${get('minute')} ${get('dayPeriod')} ET`;
}

/** Short, stable id for the footer — first 8 chars of the ci_calls uuid. */
export function shortId(callId) {
  return String(callId || '').replace(/-/g, '').slice(0, 8);
}

/**
 * Key details line. Stated facts read plainly; inferred ones are marked
 * "(likely)" so a rep can tell what the model heard from what it worked out.
 * An unmarked inference is how a guess becomes a fact in someone's CRM.
 */
export function formatKeyDetails(keyDetails) {
  const items = (keyDetails || [])
    .filter((d) => d && typeof d.detail === 'string' && d.detail.trim())
    .map((d) => (d.source === 'inferred' ? `${d.detail.trim()} (likely)` : d.detail.trim()));
  return items.length ? items.join(' • ') : null;
}

/** Follow-up line, omitted entirely when there is none. */
export function formatFollowUp(followUp) {
  if (!followUp?.required) return null;
  const bits = [followUp.action, followUp.when].filter((x) => typeof x === 'string' && x.trim());
  return bits.length ? bits.join(' — ') : 'Follow-up required';
}

/** Expiry date for the recording line: MM/DD/YYYY in Eastern wall-clock. */
export function formatExpiryDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: '2-digit', day: '2-digit', year: 'numeric',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('month')}/${get('day')}/${get('year')}`;
}

/**
 * The recording line, or null when there is nothing linkable.
 *
 * ── WHY THE EXPIRY IS IN THE NOTE ──────────────────────────────────────────
 * The audio is purged at CI_AUDIO_RETENTION_DAYS and the link dies with it, by
 * design. A rep who clicks a six-week-old note and gets nothing has no way to
 * tell an expected expiry from a broken system — and will report it as a bug,
 * repeatedly. Stating the date turns a dead link into an understood one.
 *
 * ── WHY ONE LINK AND A COUNT ───────────────────────────────────────────────
 * A held call produces one file per segment; a real call in this domain
 * carried seven. Seven URLs in a CRM note is not a note anyone reads. The
 * first segment is linked and the rest are counted.
 *
 * Returns null — so the line is omitted entirely rather than rendered empty —
 * when there is no token, or no link base configured. Both are normal states:
 * recordings ingested before sql/068 have no token, and CI_RECORDING_LINK_BASE
 * has no default.
 */
export function formatRecordingLine({ token, expiresAt, extraSegments = 0, linkBase } = {}) {
  const base = String(linkBase || '').trim().replace(/\/+$/, '');
  const tok = String(token || '').trim();
  if (!base || !tok) return null;

  const expiry = expiresAt ? formatExpiryDate(expiresAt) : null;
  const extra = Number.isFinite(extraSegments) && extraSegments > 0
    ? ` (+${extraSegments} more segment${extraSegments === 1 ? '' : 's'})`
    : '';
  return `Recording: ${base}/ci/rec/${tok}${expiry ? `  (expires ${expiry})` : ''}${extra}`;
}

/**
 * Compose the note body. Identical text for LP and GHL — one composer, so the
 * two CRMs can never drift into telling different stories about a call.
 *
 * @param {object} call     ci_calls row
 * @param {object} summary  ci_summaries row (with .output = the §7 analysis)
 * @param {object} [link]   { token, expiresAt, extraSegments, linkBase } — the
 *                          recording link. The base is PASSED IN, never read
 *                          from env here: this module is pure by contract, and
 *                          reading config would make every note test need env.
 * @param {string} [agentLabel] The name to print for the agent, ALREADY
 *                          RESOLVED against ci_agent_map.display_name by the
 *                          caller (teams.js resolveAgentLabel). Passed in
 *                          rather than looked up because this module takes no
 *                          database dependency — and because the analyzer must
 *                          print the identical label, which only holds if one
 *                          resolution is shared rather than repeated.
 *                          Omitted, it falls back to the call row's own fields.
 * @returns {string}
 */
export function composeNote(call, summary, link = null, agentLabel = null) {
  const analysis = summary?.output ?? {};
  const direction = String(call?.direction || '').toLowerCase().includes('inbound') ? 'inbound' : 'outbound';
  const agent = String(agentLabel ?? '').trim()
    || call?.agent_name || call?.agent_username || 'unknown agent';
  const team = call?.team && call.team !== 'unknown' ? call.team : 'unassigned';

  const header = `[AI CALL NOTE | ${formatEt(call?.call_start)} | ${direction} | Agent: ${agent} (${team}) | Outcome: ${outcomeLabel(analysis.outcome)}]`;

  const lines = [header];
  if (analysis.summary) lines.push(String(analysis.summary).trim());

  const key = formatKeyDetails(analysis.key_details);
  if (key) lines.push(`Key: ${key}`);

  const follow = formatFollowUp(analysis.follow_up);
  if (follow) lines.push(`Follow-up: ${follow}`);

  // Immediately ABOVE the provenance footer: the footer says the note was
  // machine-written and that commitments need verifying, and this is the line
  // that makes verifying possible.
  const recording = formatRecordingLine(link || {});
  if (recording) lines.push(recording);

  lines.push(
    `[AI-CI:${shortId(call?.id)} | Five9 ${call?.five9_call_id ?? 'unknown'} | `
    + 'AI-generated from call recording — verify commitments before acting]',
  );

  return lines.join('\n');
}

/**
 * The idempotency key for one (call, target) write.
 *
 * ci_syncs.idempotency_key is UNIQUE, so this is what makes a duplicate write
 * a CONSTRAINT VIOLATION rather than a second note on a customer's record. It
 * is derived only from the call id and the target — deliberately NOT from the
 * note body or a timestamp. Including either would let a re-analysis mint a
 * fresh key and post the same call twice, which is precisely the failure the
 * constraint exists to prevent.
 */
export function idempotencyKey(callId, target) {
  return `ci:${target}:${callId}`;
}

export default {
  composeNote,
  idempotencyKey,
  outcomeLabel,
  formatEt,
  formatExpiryDate,
  formatKeyDetails,
  formatFollowUp,
  formatRecordingLine,
  shortId,
};
