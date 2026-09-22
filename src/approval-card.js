/**
 * Approval card — plain-English body. src/approval-card.js
 *
 * 2026-09-22 — WHY THIS EXISTS. The approval card printed the rule CODE
 * (`P2_JOB_TERMINAL_WON`), a generic contact header (score / tier / prospect /
 * disposition) and a bare action type (`update_opportunity`). It never said
 * what happened, what approving would change, or what rejecting meant, so the
 * approver could neither decide nor diagnose from the card (agent_actions
 * #486315 is the example that prompted this). Every card now answers four
 * questions in order: what happened, what approving changes, what rejecting
 * means, and who this is. The rule code survives only in the small `ref:`
 * footer, for diagnosis.
 *
 * PURE: no I/O and no project imports, so every wording rule unit-tests
 * offline (scripts/test-approval-card.js). The loader that reads the rule and
 * the triggering event lives in src/approval-card-context.js. This one body
 * feeds BOTH the GroupMe text and the Slack button card — build it once.
 *
 * All times render in America/New_York (the business timezone), never UTC.
 */

export const BUSINESS_TZ = 'America/New_York';

// Short BRANCH names for the contact line. Deliberately not the
// service_markets names ("Ft. Myers / SW Florida"): those are MARKET labels,
// wider than the branch, and read like a region rather than an office.
// A code missing here is never printed — the caller's resolved market name
// is used instead, and failing that the branch is simply left off.
export const BRANCH_NAMES = Object.freeze({
  BOCA: 'Boca Raton',
  FTLAU: 'Fort Lauderdale',
  FTMYR: 'Fort Myers',
  JAX: 'Jacksonville',
  LAKE: 'Lakeland',
  MIAMI: 'Miami',
  ORL: 'Orlando',
  SAR: 'Sarasota',
  STPET: 'St. Petersburg',
});

/** "FTMYR" → "Fort Myers". Unknown or empty → null. */
export function branchName(code) {
  if (code === undefined || code === null) return null;
  return BRANCH_NAMES[String(code).trim().toUpperCase()] || null;
}

/** ISO / Date → "Sep 22, 2:53 PM ET". Unparseable → null. */
export function formatEt(input) {
  if (!input) return null;
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  const date = new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TZ, month: 'short', day: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  return `${date}, ${time} ET`;
}

/** ISO / Date → "Sep 22" (ET). A bare "YYYY-MM-DD" is a calendar day, not UTC midnight. */
export function formatEtDate(input) {
  if (!input) return null;
  const s = String(input);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00Z`) : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TZ, month: 'short', day: 'numeric' }).format(d);
}

/** "5613739673" / "+15613739673" → "(561) 373-9673". Anything else as given. */
export function formatPhoneUS(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  const ten = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  if (ten.length === 10) return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
  return String(phone);
}

/** 116000 → "$116,000". Not a positive number → null. */
export function formatMoney(v) {
  const n = Number(String(v ?? '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/**
 * LP stores reps as "Last, First" (`Carr, Michael`); a person reads
 * "Michael Carr". A name without a comma is already in reading order.
 */
export function repDisplayName(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/^([^,]+),\s*(.+)$/);
  return m ? `${m[2].trim()} ${m[1].trim()}` : s;
}

/** "P2" / "2" / "Pipeline 2" → "Pipeline 2". Anything else as given. */
export function pipelineLabel(p) {
  if (p === undefined || p === null || p === '') return 'the';
  const m = String(p).trim().match(/^(?:p|pipeline\s*)?([1-9])$/i);
  return m ? `Pipeline ${m[1]}` : String(p);
}

/** "update_opportunity" → "update opportunity". */
export function humanizeKey(s) {
  return String(s ?? '').replace(/[_.:-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Strip the engine's "Rule CODE:" prefix from agent_actions.reasoning. */
export function stripRulePrefix(reasoning) {
  return String(reasoning ?? '').replace(/^\s*Rule\s+[A-Z0-9_]+\s*:\s*/, '').trim();
}

// The contact name, or null when resolveContactInfo fell back to an ID
// (a GHL contact id or an "LP Lead 123" placeholder) — never address a
// person by their database key.
function personName(name) {
  const s = String(name ?? '').trim();
  if (!s || s === 'Unknown') return null;
  if (/^LP Lead \d+$/.test(s)) return null;
  if (/^[A-Za-z0-9]{16,}$/.test(s) && /\d/.test(s)) return null;
  return s;
}

// The possessive we use in place of a pronoun. We do not know the contact's
// pronouns and must not guess them from a name, so the card says "Stacey's"
// rather than "Her".
function possessive(name) {
  const p = personName(name);
  if (!p) return "the contact's";
  const first = p.split(/\s+/)[0];
  return /s$/i.test(first) ? `${first}'` : `${first}'s`;
}

function firstName(name) {
  const p = personName(name);
  return p ? p.split(/\s+/)[0] : 'the contact';
}

function payloadOf(event) {
  const p = event?.payload;
  if (!p) return {};
  if (typeof p === 'string') {
    try { return JSON.parse(p); } catch { return {}; }
  }
  return p;
}

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

// ═══════════════════════════════════════════════════════════════════
// WHAT HAPPENED — one formatter per triggering event_type
// ═══════════════════════════════════════════════════════════════════

const INBOUND_MESSAGE_EVENTS = new Set([
  'ghl.reply_received', 'ghl.inbound_message', 'ghl.message_received', 'ai.analysis_completed',
]);

/**
 * One sentence describing the triggering system_events row. Falls back to the
 * action's reasoning (minus its "Rule CODE:" prefix) when the event is missing
 * or of a type with no formatter.
 */
export function describeEvent({ event, action, contactName, enrichment = {} }) {
  const name = personName(contactName) || 'The contact';
  const p = payloadOf(event);
  const type = event?.event_type || '';

  if (type === 'lp.job_status_changed' && (p.old_status || p.new_status)) {
    const when = formatEt(event.created_at);
    const job = p.lp_job_id ? ` #${p.lp_job_id}` : '';
    const from = p.old_status || 'unknown';
    const to = p.new_status || 'unknown';
    return `${name}'s LP job${job} changed ${from} → ${to}${when ? ` (${when})` : ''}.`;
  }

  if (type === 'lp.disposition_changed' || type === 'five9.disposition_set') {
    const label = p.disposition_label || p.disposition_name || p.disposition_code || event.event_subtype;
    if (label) {
      const by = repDisplayName(p.rep_name || p.agent_name?.replace(/\s+-\s+\w+$/, ''));
      const via = type === 'five9.disposition_set' ? ' on a Five9 call' : ' in LP';
      const when = formatEt(p.call_end_at || event.created_at);
      return `${name} was dispositioned "${label}"${via}${by ? ` by ${by}` : ''}${when ? ` (${when})` : ''}.`;
    }
  }

  const text = p.message_text || p.body || p.message_preview || enrichment.messageText;
  if ((INBOUND_MESSAGE_EVENTS.has(type) || (!event && enrichment.messageText)) && text) {
    const kind = String(p.message_type || enrichment.messageType || '').toLowerCase();
    const verb = kind.includes('email') ? 'emailed' : 'texted';
    const when = formatEt(event?.created_at);
    return `${name} ${verb}: “${clip(text, 120)}”${when ? ` (${when})` : ''}.`;
  }

  const reason = stripRulePrefix(action?.reasoning);
  if (reason) return clip(reason, 300);
  return 'No event details were recorded for this action.';
}

// ═══════════════════════════════════════════════════════════════════
// IF YOU APPROVE — one formatter per action_type
// ═══════════════════════════════════════════════════════════════════

// One-line meanings for the tag families an approver meets most. A tag not
// listed here is shown without a gloss rather than with a guessed one.
const TAG_MEANINGS = [
  [/^stage:/, 'sets where they are in the funnel'],
  [/^loss-reason:/, 'records why the deal was lost'],
  [/^(dnc|do-not-contact)$/i, 'stops all texts and calls to them'],
  [/^recovery:dnc-lifted$/, 'records that their do-not-contact was lifted'],
];

function tagMeaning(tag) {
  for (const [re, meaning] of TAG_MEANINGS) if (re.test(tag)) return meaning;
  return null;
}

function stageLabel(tag) {
  return humanizeKey(String(tag).replace(/^stage:/, ''));
}

function listNumbers(nums) {
  const shown = nums.slice(0, 5).map(formatPhoneUS).join(', ');
  return nums.length > 5 ? `${shown} and ${nums.length - 5} more` : shown;
}

function shortPayload(payload) {
  const parts = [];
  for (const [k, v] of Object.entries(payload || {})) {
    if (k.startsWith('_') || v === null || v === undefined || v === '') continue;
    const val = Array.isArray(v) ? v.slice(0, 5).join(', ') + (v.length > 5 ? ` (+${v.length - 5})` : '')
      : typeof v === 'object' ? JSON.stringify(v)
        : String(v);
    parts.push(`${humanizeKey(k)}: ${clip(val, 80)}`);
    if (parts.length >= 6) break;
  }
  return parts.length ? parts.join(', ') : 'no settings';
}

/**
 * Plain-English effect of approving ONE action. May return a multi-line string
 * (a message to be sent is always shown in full).
 */
export function describeApprove(action, { event, contactName, enrichment = {} } = {}) {
  const type = action?.action_type || '';
  const pl = action?.action_payload || {};
  const ev = payloadOf(event);
  const whose = possessive(contactName);
  const who = firstName(contactName);

  switch (type) {
    case 'update_opportunity': {
      const status = pl.status ? String(pl.status).toUpperCase() : 'UPDATED';
      const value = formatMoney(pl.monetary_value ?? pl.value ?? ev.job_value);
      const pipe = pipelineLabel(pl.pipeline);
      return `${capitalize(whose)} ${pipe} opportunity is marked ${status}${value ? ` (${value})` : ''}.`;
    }
    case 'move_opportunity': {
      const stage = pl.stage ? ` → ${pl.stage}` : '';
      return `${capitalize(whose)} opportunity moves to ${pipelineLabel(pl.pipeline)}${stage}.`;
    }
    case 'add_tag': {
      const tag = pl.tag || (Array.isArray(pl.tags) ? pl.tags.join(', ') : '');
      const meaning = tagMeaning(String(tag));
      return `Adds tag \`${tag}\`${meaning ? ` — ${meaning}` : ''}.`;
    }
    case 'remove_tag': {
      const tags = (Array.isArray(pl.tags) ? pl.tags : [pl.tag]).filter(Boolean);
      const meaning = tags.length === 1 ? tagMeaning(String(tags[0])) : null;
      return `Removes tag${tags.length === 1 ? '' : 's'} \`${tags.join('`, `')}\`${meaning ? ` — the one that ${meaning}` : ''}.`;
    }
    case 'set_stage':
      return `Moves ${who} to the "${stageLabel(pl.tag || pl.stage || '')}" stage.`;
    case 'set_dnd': {
      const channels = Array.isArray(pl.channels) && pl.channels.length ? pl.channels.join(', ') : 'all channels';
      return String(pl.status).toLowerCase() === 'inactive'
        ? `Turns Do Not Disturb OFF (${channels}), so ${who} can be contacted again.`
        : `Turns Do Not Disturb ON (${channels}) — no more messages to ${who} on those channels.`;
    }
    case 'send_message':
    case 'send_sms':
    case 'send_email': {
      const channel = type === 'send_email' || String(pl.channel).toLowerCase() === 'email' ? 'email' : 'text';
      const text = pl.message || pl.body || enrichment.generatedMessage;
      if (text) {
        const subject = channel === 'email' && pl.subject ? `Subject: ${pl.subject}\n` : '';
        return `Sends ${who} this ${channel}:\n${subject}“${String(text).trim()}”`;
      }
      if (enrichment.aiGenerationError) {
        return `Sends ${who} an AI-written ${channel} — but the draft failed to generate (${clip(enrichment.aiGenerationError, 100)}). Reject and handle by hand.`;
      }
      return `Sends ${who} an AI-written ${channel}, drafted when you approve.`;
    }
    case 'create_task': {
      const assignee = pl.assigned_to_name || pl.assignee_name || (pl.assigned_to && !/^[A-Za-z0-9]{16,}$/.test(pl.assigned_to) ? pl.assigned_to : null) || "the contact's owner";
      const due = formatEtDate(pl.due_date || pl.dueDate || pl.due_at);
      return `Creates a task for ${assignee}: ${pl.title || 'follow up'}${due ? ` (due ${due})` : ''}.`;
    }
    case 'add_to_workflow':
      return `Enrolls ${who} in ${pl.canonical_name || pl.workflow_name || 'a workflow'}.`;
    case 'remove_from_workflow':
      return `Removes ${who} from ${pl.canonical_name || pl.workflow_name || 'their current workflow'}.`;
    case 'resolve_objection_state': {
      const states = (Array.isArray(pl.only_if_state) ? pl.only_if_state : [])
        .map(s => humanizeKey(String(s).split('.').pop()));
      return `Closes ${whose} open objection as "${humanizeKey(pl.resolution || 'resolved')}"${states.length ? ` — only if it is currently: ${states.join(', ')}` : ''}.`;
    }
    case 'book_appointment': {
      const when = formatEt(pl.start_time);
      return `Books ${who} on ${pl.calendar_name || 'the calendar'}${when ? ` for ${when}` : ''}.`;
    }
    case 'cancel_appointment':
      return `Cancels ${whose} appointment.`;
    case 'reschedule_appointment': {
      const when = formatEt(pl.new_start_time);
      return `Moves ${whose} appointment${when ? ` to ${when}` : ''}.`;
    }
    case 'five9_add_numbers_to_dnc': {
      const nums = Array.isArray(pl.numbers) ? pl.numbers : [];
      return `Adds ${nums.length} number${nums.length === 1 ? '' : 's'} to the Five9 do-not-call list (permanent): ${listNumbers(nums)}.`;
    }
    case 'five9_start_campaign':
      return `Starts the Five9 campaign "${pl.campaign_name}".`;
    case 'five9_stop_campaign':
      return `Stops the Five9 campaign "${pl.campaign_name}".`;
    default:
      return `Runs ${humanizeKey(type) || 'an unnamed action'} with: ${shortPayload(pl)}.`;
  }
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * What rejecting means — one line. A rejected action is marked `rejected`
 * by resolveApproval and is never retried; only a NEW event can raise a
 * new card.
 */
export function describeReject(actions, { contactName } = {}) {
  const first = actions?.[0] || {};
  const pl = first.action_payload || {};
  const who = firstName(contactName);
  // A mixed batch has no single thing that "stays as it is".
  const types = new Set((actions || []).map(a => a.action_type));
  const type = types.size === 1 ? (first.action_type || '') : '';
  let what;
  if (type === 'update_opportunity' || type === 'move_opportunity') {
    what = `the ${pipelineLabel(pl.pipeline)} opportunity stays as it is`;
  } else if (['send_message', 'send_sms', 'send_email'].includes(type)) {
    what = `nothing is sent to ${who}`;
  } else if (type === 'add_tag' || type === 'remove_tag' || type === 'set_stage') {
    what = `${who}'s tags stay as they are`;
  } else if (type === 'set_dnd') {
    what = `${who}'s Do Not Disturb setting stays as it is`;
  } else {
    what = 'none of the above happens';
  }
  return `Nothing changes; ${what}. It is not retried.`;
}

// ═══════════════════════════════════════════════════════════════════
// CONTACT LINE + CONDITIONAL DETAIL
// ═══════════════════════════════════════════════════════════════════

/**
 * Which enrichment fields the rule actually decided on. Score / tier /
 * disposition / prospect only earn a place on the card when the rule's
 * conditions reference them — otherwise they are noise the approver has to
 * read past (the old card printed "Score: -10 | Tier: cold" on a job-paid card).
 */
export function conditionFieldsUsed(rule) {
  const keys = Object.keys({ ...(rule?.conditions || {}), ...(rule?.context_conditions || {}) }).join(' ').toLowerCase();
  return {
    score: /score/.test(keys),
    tier: /tier/.test(keys),
    disposition: /disposition/.test(keys),
    prospect: /prospect/.test(keys),
  };
}

export function contactLine({ contactName, contactPhone, enrichment = {}, event }) {
  const ev = payloadOf(event);
  const parts = [personName(contactName) || 'Unknown contact'];
  const phone = formatPhoneUS(contactPhone);
  if (phone) parts.push(phone);
  const rep = repDisplayName(enrichment.repName);
  if (rep) parts.push(`Rep: ${rep}`);
  const branch = branchName(ev.branch_code) || branchName(enrichment.marketCode) || enrichment.market || null;
  if (branch) parts.push(`Branch: ${branch}`);
  if (enrichment.lpSource) parts.push(`Source: ${enrichment.lpSource}`);
  return `Contact: ${parts.join(' · ')}`;
}

function detailLine({ rule, enrichment = {} }) {
  const used = conditionFieldsUsed(rule);
  const parts = [];
  if (used.disposition && enrichment.disposition) parts.push(`Disposition: ${enrichment.disposition}`);
  if (used.score && enrichment.score != null && enrichment.score !== '') parts.push(`Score: ${enrichment.score}`);
  if (used.tier && enrichment.tier) parts.push(`Tier: ${enrichment.tier}`);
  if (used.prospect && enrichment.prospectId) parts.push(`Prospect: ${enrichment.prospectId}`);
  return parts.length ? parts.join(' · ') : null;
}

// ═══════════════════════════════════════════════════════════════════
// TITLE + FULL CARD
// ═══════════════════════════════════════════════════════════════════

/** agent_rules.rule_name, tidied. "->" becomes "→". Falls back to the action. */
export function cardTitle({ rule, actions, fallbackTitle }) {
  const name = String(rule?.rule_name || '').trim();
  if (name) return name.replace(/\s*->\s*/g, ' → ');
  if (fallbackTitle) return String(fallbackTitle).trim();
  const t = humanizeKey(actions?.[0]?.action_type || 'action');
  return `Approve: ${t}`;
}

/**
 * Build the card body shared by GroupMe and Slack. Does NOT include the
 * GroupMe typed-reply footer ("Reply: Yes 123 …"); the Slack card has
 * buttons instead.
 *
 * @param {object} args
 * @param {object[]} args.actions        the batch (agent_actions rows)
 * @param {string}   args.shortRef
 * @param {object}   [args.rule]         agent_rules row: rule_name, conditions, context_conditions
 * @param {object}   [args.event]        system_events row: id, event_type, event_subtype, payload, created_at
 * @param {string}   [args.contactName]
 * @param {string}   [args.contactPhone]
 * @param {object}   [args.enrichment]   buildNotificationEnrichment output (+ generatedMessage)
 * @param {string}   [args.fallbackTitle] used only when no rule row was found
 * @param {string}   [args.header]     replaces the "🔔 Approval needed" first line
 *                                     (the timeout reminder uses its own)
 * @param {string[]} [args.notes]      extra plain lines, placed after the contact
 * @returns {string}
 */
export function buildApprovalCardText({
  actions = [], shortRef, rule = null, event = null,
  contactName = null, contactPhone = null, enrichment = {}, fallbackTitle = null,
  header = null, notes = [],
}) {
  const first = actions[0] || {};
  const ruleCode = first.rule_applied || null;
  const ctx = { event, contactName, enrichment };

  const lines = [];
  lines.push(header || `🔔 Approval needed · #${shortRef}`);
  lines.push(cardTitle({ rule, actions, fallbackTitle }));
  lines.push(`What happened: ${describeEvent({ event, action: first, contactName, enrichment })}`);

  const effects = actions.map(a => describeApprove(a, ctx));
  if (effects.length === 1) {
    lines.push(`If you approve: ${effects[0]}`);
  } else {
    lines.push('If you approve:');
    for (const e of effects) lines.push(`• ${e}`);
  }
  lines.push(`If you reject: ${describeReject(actions, { contactName })}`);
  lines.push(contactLine({ contactName, contactPhone, enrichment, event }));

  const detail = detailLine({ rule, enrichment });
  if (detail) lines.push(detail);
  for (const n of notes || []) if (n) lines.push(n);

  // The rule code is for diagnosis only. Anything above that echoed it
  // (a free-text reasoning fallback, a title fallback) is scrubbed so the
  // code appears exactly once, in the ref line.
  let body = lines.join('\n');
  if (ruleCode) body = body.split(ruleCode).join('this rule');

  const ref = [ruleCode, event?.id != null ? `event ${event.id}` : (first.event_id != null ? `event ${first.event_id}` : null)]
    .filter(Boolean).join(' · ');
  return ref ? `${body}\nref: ${ref}` : body;
}
