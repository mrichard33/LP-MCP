/**
 * Revin webhook body → contact_messages rows — src/revin/normalize.js (2026-10-19)
 *
 * Pure. Revin publishes no webhook spec we could find, so this reads whatever
 * shape arrives through FIELD_MAP: each field lists the keys (dot paths) it is
 * read from, first non-empty value wins. When Revin's first real payloads land,
 * adjust the map here; `unmapped_keys` on the result names what nothing read.
 *
 * Never drops an event: an event type we do not know is stored as 'unknown'
 * (its raw body stays in revin_events_raw, linked by raw_event_id). A Revin
 * call event becomes channel 'call_event', context only: Five9 is the only
 * call source and nothing counts these rows as calls.
 */
import { createHash } from 'node:crypto';
import { normalizePhoneE164 } from '../services/identity-extraction.js';

// Adjust once real samples arrive. Order matters: first non-empty wins.
export const FIELD_MAP = Object.freeze({
  event_type: ['event', 'event_type', 'eventType', 'type', 'action', 'topic'],
  direction: ['direction', 'message.direction', 'data.direction'],
  body: ['message.body', 'message.text', 'body', 'text', 'message', 'content', 'message_body', 'sms', 'data.body', 'data.text'],
  // The LEAD's phone. Revin's own number is the other side of from/to, so
  // from/to are read by direction below, after these.
  lead_phone: ['lead.phone', 'contact.phone', 'customer.phone', 'prospect.phone', 'phone', 'phone_number', 'lead_phone', 'customer_phone'],
  from: ['from', 'from_number', 'message.from'],
  to: ['to', 'to_number', 'message.to'],
  sent_at: ['message.timestamp', 'timestamp', 'sent_at', 'sentAt', 'occurred_at', 'created_at', 'createdAt', 'date', 'time'],
  external_id: ['message_id', 'messageId', 'message.id', 'sms_id', 'event_id', 'id'],
  external_thread_id: ['conversation_id', 'conversationId', 'conversation.id', 'thread_id', 'threadId'],
  lp_lead_id: ['lp_lead_id', 'lead_id', 'leadId', 'lead.id', 'lead.lp_lead_id', 'custom_fields.lp_lead_id', 'crm_id'],
  channel: ['channel', 'medium', 'message.channel'],
});

// Keys a batch payload may hold its messages under.
const BATCH_KEYS = ['messages', 'events', 'data'];
// A batch item never inherits these from its parent: a shared parent id would
// give every item the same dedupe key and collapse the batch into one row.
const NOT_INHERITED = new Set([...FIELD_MAP.external_id, ...FIELD_MAP.body].map((p) => p.split('.')[0]));

// Order matters: the first pattern that matches the event name wins.
export const EVENT_MAP = Object.freeze([
  ['opt_out', /opt(?:ed)?[\s_.-]*out|unsubscri|\bstop\b|\bdnc\b|do[\s_.-]*not[\s_.-]*contact/i],
  ['call', /\bcall(?!back)|voice|dial/i],
  ['conversation_end', /conversation[\s_.-]*(end|ended|closed|complete)|\bend(ed)?\b|closed|completed/i],
  ['status', /status|deliver|undeliver|fail|bounce|\bread\b/i],
  ['reply', /reply|replied|inbound|incoming|received/i],
  ['message', /message|sent|outbound|outgoing|\bsms\b|text/i],
]);

function getPath(obj, path) {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function firstScalar(obj, paths) {
  for (const p of paths) {
    const v = getPath(obj, p);
    if (v == null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return { path: p, value: v };
  }
  return null;
}

/** 'inbound' | 'outbound' | null from an explicit direction value. */
export function readDirection(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (/^(in|inbound|incoming|received|mo|1)$/.test(s)) return 'inbound';
  if (/^(out|outbound|outgoing|sent|mt|2)$/.test(s)) return 'outbound';
  return null;
}

/** The event name → one of EVENT_MAP's types, else 'unknown'. */
export function readEventType(name) {
  if (name == null || String(name).trim() === '') return null;
  for (const [type, rx] of EVENT_MAP) if (rx.test(String(name))) return type;
  return 'unknown';
}

/** Epoch seconds, epoch ms, or a date string → UTC ISO, else null. */
export function toUtcIso(v) {
  if (v == null || v === '') return null;
  let d;
  if (typeof v === 'number' || /^\d{9,13}(\.\d+)?$/.test(String(v).trim())) {
    const n = Number(v);
    d = new Date(n < 1e12 ? n * 1000 : n);
  } else {
    d = new Date(String(v));
  }
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function readChannel(raw, eventType) {
  if (eventType === 'call') return 'call_event';
  const s = String(raw || '').toLowerCase();
  if (/call|voice|phone/.test(s)) return 'call_event';
  if (/mail/.test(s)) return 'email';
  if (/chat/.test(s)) return 'chat';
  if (eventType === 'status' || eventType === 'conversation_end') return 'system';
  return 'sms';
}

/** Every leaf path in an object (one array level flattened by index-free name). */
function leafPaths(obj, prefix = '', out = new Set()) {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leafPaths(v, p, out);
    else out.add(p);
  }
  return out;
}

const ALL_MAPPED = new Set(Object.values(FIELD_MAP).flat());

/** The dedupe key: Revin's message id when it sends one, else a hash. */
export function dedupeKeyFor({ external_id, phone_e164, sent_at, body, event_type }) {
  if (external_id) return `x:${external_id}`;
  const h = createHash('md5').update(`${phone_e164 || ''}|${sent_at || ''}|${body || ''}|${event_type || ''}`).digest('hex');
  return `h:${h}`;
}

/** One item (a message or event object) → a contact_messages row shape. */
export function normalizeItem(item, { parent = null, receivedAt = null } = {}) {
  const src = parent ? { ...parent, ...item } : (item || {});
  const pick = (f) => firstScalar(src, FIELD_MAP[f]);

  const eventName = pick('event_type')?.value ?? null;
  const bodyVal = pick('body')?.value;
  const body = bodyVal == null ? null : String(bodyVal);
  let eventType = readEventType(eventName) || (body ? 'message' : 'unknown');
  let direction = readDirection(pick('direction')?.value);
  if (!direction) direction = eventType === 'reply' ? 'inbound' : eventType === 'message' ? 'outbound' : 'event';
  if (eventType === 'message' && direction === 'inbound') eventType = 'reply';

  const leadPhone = pick('lead_phone')?.value;
  const from = pick('from')?.value;
  const to = pick('to')?.value;
  const phoneRaw = leadPhone ?? (direction === 'inbound' ? from : direction === 'outbound' ? to : (to ?? from));
  const sentIso = toUtcIso(pick('sent_at')?.value);
  const externalId = pick('external_id')?.value;
  const threadId = pick('external_thread_id')?.value;
  const leadId = pick('lp_lead_id')?.value;

  const row = {
    source: 'revin',
    channel: readChannel(pick('channel')?.value, eventType),
    direction,
    body,
    sent_at: sentIso || toUtcIso(receivedAt),
    external_id: externalId == null ? null : String(externalId),
    external_thread_id: threadId == null ? null : String(threadId),
    event_type: eventType,
    phone_e164: normalizePhoneE164(phoneRaw),
    lp_lead_id: leadId == null || !/^\d+$/.test(String(leadId).replace(/^LDS/i, '')) ? null : String(leadId).replace(/^LDS/i, ''),
  };
  row.dedupe_key = dedupeKeyFor(row);
  return { row, sentAtAssumed: !sentIso, paths: leafPaths(src) };
}

/**
 * The whole body → { rows, unmapped_keys, sent_at_assumed }.
 * A batch (an array, or messages/events/data holding an array) gives one row
 * per item, each item falling back to the parent's fields. Anything else is
 * one row. An empty batch gives no rows.
 */
export function normalizeRevinPayload(payload, { receivedAt = null } = {}) {
  const p = payload && typeof payload === 'object' ? payload : { _raw_text: payload == null ? null : String(payload) };
  let items = null;
  let parent = null;
  if (Array.isArray(p)) items = p;
  else {
    const key = BATCH_KEYS.find((k) => Array.isArray(p[k]));
    if (key) {
      items = p[key];
      parent = Object.fromEntries(Object.entries(p).filter(([k]) => k !== key && !NOT_INHERITED.has(k)));
    }
  }
  const list = items ? items.map((it) => (it && typeof it === 'object' ? it : { message: it })) : [p];

  const rows = [];
  const unmapped = new Set();
  let assumed = false;
  for (const it of list) {
    const { row, sentAtAssumed, paths } = normalizeItem(it, { parent, receivedAt });
    rows.push(row);
    if (sentAtAssumed) assumed = true;
    for (const path of paths) {
      if (path === '_raw_text') continue;
      const covered = [...ALL_MAPPED].some((m) => path === m || m.startsWith(`${path}.`));
      if (!covered) unmapped.add(path);
    }
  }
  return { rows, unmapped_keys: [...unmapped].sort(), sent_at_assumed: assumed };
}
