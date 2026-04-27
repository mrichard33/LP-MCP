// ─── IME HTTP Client — src/ime/client.js ─────────────────────────
//
// Wrapper around the IME MIC API with automatic token injection +
// one-shot 401 retry (handles stale-token races near expiry).
//
// IME uses JSON for all bodies (different from LP which is form-urlencoded).
// Some IME endpoints return 204 No Content for successful state transitions.

import { getToken, invalidateToken } from './token-manager.js';

const REQUEST_TIMEOUT_MS = parseInt(process.env.IME_REQUEST_TIMEOUT_MS || '15000', 10);

const baseUrl = () => {
  const env = (process.env.IME_ENV || 'uat').toUpperCase();
  return process.env[`IME_BASE_URL_${env}`] || '';
};

async function call(method, path, body = null, retried = false) {
  const base = baseUrl();
  if (!base) throw new Error('[ime] [client] IME_BASE_URL not configured');

  const token = await getToken();
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
  };
  if (body !== null && body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== null && body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  // Lazy refresh on 401 (one retry only)
  if (res.status === 401 && !retried) {
    console.log(`[ime] [client] 401 on ${method} ${path}, refreshing token and retrying`);
    invalidateToken();
    return call(method, path, body, true);
  }

  // 204 No Content — successful state transition with no body
  if (res.status === 204) return { status: 204, data: null };

  const text = await res.text().catch(() => '');
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const err = new Error(`[ime] ${method} ${path} → ${res.status}`);
    err.status = res.status;
    err.response = data;
    throw err;
  }

  return { status: res.status, data };
}

export const get  = (path)        => call('GET',  path);
export const post = (path, body)  => call('POST', path, body);
export const put  = (path, body)  => call('PUT',  path, body);

export default { get, post, put };
