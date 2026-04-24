/**
 * Action Executor Helpers — src/actions/helpers.js
 *
 * Shared helpers: ID type detection, GHL fetch wrapper, template interpolation.
 * Extracted from action-executor.js v4.2 refactor.
 */

import { acquireToken, report429 } from '../ghl-rate-limiter.js';

const GHL_API_KEY = process.env.GHL_API_KEY;

// ═══════════════════════════════════════════════════════════════════
// ID TYPE DETECTION
// ═══════════════════════════════════════════════════════════════════

export function isLPLeadId(id) {
  return id && /^\d+$/.test(String(id));
}

// ═══════════════════════════════════════════════════════════════════
// GHL FETCH WRAPPER — rate-limited, 429-aware, 15s timeout
// ═══════════════════════════════════════════════════════════════════

export async function ghlFetch(method, path, body = null) {
  if (!GHL_API_KEY) throw new Error('GHL_API_KEY not configured');
  await acquireToken();
  const url = `https://services.leadconnectorhq.com${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (res.status === 429) {
    report429();
    const text = await res.text().catch(() => '');
    throw new Error(`GHL ${method} ${path} → 429: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GHL ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : { status: res.status, ok: true };
}

// ═══════════════════════════════════════════════════════════════════
// TEMPLATE INTERPOLATION — {{var}} substitution from event context
// ═══════════════════════════════════════════════════════════════════

export function interpolate(template, context) {
  if (!template || typeof template !== 'string') return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const val = context[key];
    if (val === undefined || val === null) return '';
    return String(val);
  });
}

export function interpolatePayload(payload, context) {
  if (!payload || typeof payload !== 'object') return payload;
  if (!context || Object.keys(context).length === 0) return payload;
  const result = {};
  for (const [key, val] of Object.entries(payload)) {
    if (typeof val === 'string') {
      result[key] = interpolate(val, context);
    } else if (Array.isArray(val)) {
      result[key] = val.map(item => typeof item === 'string' ? interpolate(item, context) : item);
    } else {
      result[key] = val;
    }
  }
  return result;
}
