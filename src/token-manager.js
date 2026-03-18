// ─── Token Manager — src/token-manager.js ────────────────────────
//
// Manages JWT token lifecycle for the Lead Perfection API.
// Tokens expire every 24 hours. We refresh proactively every 23 hours.
//
// CRITICAL:
//   - Tokens are PATH-SPECIFIC: a token from api.leadperfection.com
//     is invalid on api2.leadperfection.com. Use one server consistently.
//   - Content-Type for /token is application/x-www-form-urlencoded.
//   - Never log the full token value — it contains credentials.

let cachedToken = null;
let tokenExpiry = null;
let refreshTimer = null;

export const getToken = async () => {
  const now = Date.now();
  if (cachedToken && tokenExpiry && now < tokenExpiry) return cachedToken;
  return await refreshToken();
};

export const refreshToken = async () => {
  const baseUrl = (process.env.LP_API_BASE_URL || '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('[Token] LP_API_BASE_URL not configured');
  }

  const username = process.env.LP_USERNAME;
  const password = process.env.LP_PASSWORD;
  const clientid = process.env.LP_CLIENT_ID;
  const appkey   = process.env.LP_APP_KEY;

  if (!username || !password || !clientid || !appkey) {
    throw new Error('[Token] Missing LP credentials — need LP_USERNAME, LP_PASSWORD, LP_CLIENT_ID, LP_APP_KEY');
  }

  const params = new URLSearchParams({
    grant_type: 'password',
    username,
    password,
    clientid,
    appkey,
  });

  console.log(`[Token] Requesting token from ${baseUrl}/token...`);

  const res = await fetch(`${baseUrl}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[Token] Refresh failed: HTTP ${res.status} — ${body}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  // LP tokens expire in 24 hours — refresh 1 hour early (23 hours)
  tokenExpiry = Date.now() + (23 * 60 * 60 * 1000);

  console.log('[Token] Refreshed — valid for 23 hours');
  return cachedToken;
};

export const invalidateToken = () => {
  cachedToken = null;
  tokenExpiry = null;
};

export const getTokenStatus = () => ({
  hasToken: !!cachedToken,
  expiresAt: tokenExpiry ? new Date(tokenExpiry).toISOString() : null,
  expiresInMs: tokenExpiry ? tokenExpiry - Date.now() : null,
});

// Schedule proactive refresh every 23 hours
export const startTokenRefreshSchedule = () => {
  if (refreshTimer) return; // already running
  const TWENTY_THREE_HOURS = 23 * 60 * 60 * 1000;
  refreshTimer = setInterval(async () => {
    try {
      await refreshToken();
    } catch (err) {
      console.error('[Token] Scheduled refresh failed:', err.message);
    }
  }, TWENTY_THREE_HOURS);
  console.log('[Token] Proactive refresh scheduled every 23 hours');
};

export const stopTokenRefreshSchedule = () => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
};
