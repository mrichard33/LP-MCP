// ─── IME Token Manager — src/ime/token-manager.js ────────────────
//
// Manages JWT token lifecycle for the IME MIC API.
// Tokens expire every 30 minutes (vs LP's 24 hours). We refresh proactively
// at the 25-minute mark (controlled by IME_TOKEN_REFRESH_BUFFER_MIN).
//
// Pattern mirrors src/token-manager.js (LP) but:
//   - JSON body for /auth/login and /auth/refreshtoken (LP uses form-urlencoded)
//   - 30-minute refresh cycle
//   - Falls back to /auth/login if refresh token expires
//
// Never log full token values — they contain credentials.

const REFRESH_BUFFER_MIN = parseInt(process.env.IME_TOKEN_REFRESH_BUFFER_MIN || '5', 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.IME_REQUEST_TIMEOUT_MS || '15000', 10);

let accessToken = null;
let refreshTokenValue = null;
let accessTokenExpiresAt = 0;        // epoch ms
let refreshTokenExpiresAt = 0;
let refreshInFlight = null;

const baseUrl = () => {
  const env = (process.env.IME_ENV || 'uat').toUpperCase();
  return process.env[`IME_BASE_URL_${env}`] || '';
};

const parseExpiry = (value) => {
  if (!value) return 0;
  // IME returns ISO 8601 string for expiresIn / refreshTokenExpiresOn
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
};

export const login = async () => {
  const base = baseUrl();
  if (!base) throw new Error('[ime] [token] IME_BASE_URL not configured for IME_ENV');
  if (!process.env.IME_USERNAME || !process.env.IME_PASSWORD) {
    throw new Error('[ime] [token] IME_USERNAME / IME_PASSWORD missing');
  }

  const res = await fetch(`${base}/api/v2/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      username: process.env.IME_USERNAME,
      password: process.env.IME_PASSWORD,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[ime] [token] login failed: ${res.status} ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  accessToken = data.accessToken;
  refreshTokenValue = data.refreshToken;
  accessTokenExpiresAt = parseExpiry(data.expiresIn);
  refreshTokenExpiresAt = parseExpiry(data.refreshTokenExpiresOn);

  console.log(`[ime] [token] login successful, valid until ${new Date(accessTokenExpiresAt).toISOString()}`);
  return accessToken;
};

export const refresh = async () => {
  const base = baseUrl();
  if (!refreshTokenValue || Date.now() > refreshTokenExpiresAt) {
    console.log('[ime] [token] refresh token missing or expired, falling back to login');
    return login();
  }

  const res = await fetch(`${base}/api/v2/auth/refreshtoken`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ refreshToken: refreshTokenValue }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    console.log(`[ime] [token] refresh failed (${res.status}), falling back to login`);
    return login();
  }

  const data = await res.json();
  accessToken = data.accessToken;
  refreshTokenValue = data.refreshToken;
  accessTokenExpiresAt = parseExpiry(data.expiresIn);
  refreshTokenExpiresAt = parseExpiry(data.refreshTokenExpiresOn);
  console.log(`[ime] [token] refreshed, valid until ${new Date(accessTokenExpiresAt).toISOString()}`);
  return accessToken;
};

export const getToken = async () => {
  const bufferMs = REFRESH_BUFFER_MIN * 60 * 1000;
  const stale = !accessToken || Date.now() > (accessTokenExpiresAt - bufferMs);
  if (!stale) return accessToken;

  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (accessToken ? refresh() : login()).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
};

export const invalidateToken = () => {
  accessToken = null;
  accessTokenExpiresAt = 0;
};

export const getTokenStatus = () => ({
  hasToken: !!accessToken,
  expiresAt: accessTokenExpiresAt ? new Date(accessTokenExpiresAt).toISOString() : null,
  expiresInMs: accessTokenExpiresAt ? accessTokenExpiresAt - Date.now() : null,
  refreshExpiresAt: refreshTokenExpiresAt ? new Date(refreshTokenExpiresAt).toISOString() : null,
});
