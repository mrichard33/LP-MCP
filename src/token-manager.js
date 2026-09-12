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
//
// TWO IDENTITIES, DELIBERATELY SEPARATE
//   LP attributes every write to the USER BEHIND THE CREDENTIAL. AddNotes has
//   no rep_id / author field (see .env.example LP_NOTE_REP_ID), so the only
//   way to change who a note appears to come from is to authenticate as a
//   different LP user.
//
//   The primary credential (LP_USERNAME) drives everything: appointment sync,
//   lead creation, the mirror, every read. Repointing it to change note
//   authorship would silently re-attribute ALL of that too — and would break
//   outright if the new user lacked a permission the old one had.
//
//   So notes get their OWN optional credential and their OWN cache. Unset,
//   getNoteToken() returns the primary token and behaviour is byte-identical
//   to before. Set, only the note-write path authenticates as that user.
//
// SINGLE-FLIGHT (2026-09-12). Every LP call routes through getToken()
// (lp-client.js:102), so a cold or expired cache used to mean EVERY concurrent
// caller fired its own POST /token. The capacity lead pass alone opens ~180
// per-lead fetches, so a restart produced a ~180-request login stampede
// against LP.
//
// The cost was not the wasted requests, it was the queue behind them. Observed
// on 2026-09-12: a token request took 80 SECONDS (16:30:04 -> 16:31:24) and
// three refreshes landed inside one second. Meanwhile the capacity board's
// GetSalesSchedule — which must await a token before it can issue its own
// request — burned its entire 60s budget waiting in that queue and never
// reached the schedule endpoint at all, failing at exactly 60000ms every
// attempt with no LP-side error. The board read DATA STALE for hours and the
// cause was diagnosed as "the vendor is slow". It was not; it was us.
//
// So: ONE refresh is shared by every concurrent caller, and the token fetch is
// timeout-bounded. The timeout is not optional garnish — with single-flight, a
// hung login blocks every LP call in the process, so it must be able to fail.

let cachedToken = null;
let tokenExpiry = null;
let refreshTimer = null;
// Shared in-flight refresh promises — the single-flight guards. Null when no
// refresh is running. See the SINGLE-FLIGHT note above.
let inFlightRefresh = null;
let inFlightNoteRefresh = null;

// A token fetch had NO timeout and could hang indefinitely. Under
// single-flight that would wedge every LP call in the process, so this bound
// is load-bearing.
const TOKEN_TIMEOUT_MS = Math.max(
  1000,
  parseInt(process.env.LP_TOKEN_TIMEOUT_MS || '', 10) || 30_000,
);

// Separate cache for the note-writing identity. MUST NOT share storage with
// the primary token: one cache holding two identities would hand whichever
// was fetched last to both call sites, and the failure is invisible — notes
// silently attributed to the wrong user, or a sync running as the note user.
let cachedNoteToken = null;
let noteTokenExpiry = null;

export const getToken = async () => {
  const now = Date.now();
  if (cachedToken && tokenExpiry && now < tokenExpiry) return cachedToken;
  // refreshToken() is itself single-flighted, so N concurrent cold callers
  // produce ONE login request rather than N.
  return await refreshToken();
};

/**
 * Is a dedicated note-writing identity configured?
 * Both halves are required — a username with no password is a misconfiguration
 * that must fall back to the primary credential rather than fail every note.
 */
export const hasNoteIdentity = () =>
  Boolean(process.env.LP_NOTE_USERNAME && process.env.LP_NOTE_PASSWORD);

/**
 * Token for the note-writing identity.
 *
 * Falls back to the primary token when LP_NOTE_USERNAME / LP_NOTE_PASSWORD are
 * unset, so this is safe to call unconditionally from the note path.
 */
export const getNoteToken = async () => {
  if (!hasNoteIdentity()) return await getToken();
  const now = Date.now();
  if (cachedNoteToken && noteTokenExpiry && now < noteTokenExpiry) return cachedNoteToken;
  return await refreshNoteToken();
};

/**
 * Shared token request. `label` only ever appears in logs.
 * The credential values themselves are never logged.
 */
const requestToken = async ({ username, password, label }) => {
  const baseUrl = (process.env.LP_API_BASE_URL || '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('[Token] LP_API_BASE_URL not configured');
  }

  const clientid = process.env.LP_CLIENT_ID;
  const appkey   = process.env.LP_APP_KEY;

  if (!username || !password || !clientid || !appkey) {
    throw new Error(`[Token] Missing LP credentials for ${label} — need username, password, LP_CLIENT_ID, LP_APP_KEY`);
  }

  const params = new URLSearchParams({
    grant_type: 'password',
    username,
    password,
    clientid,
    appkey,
  });

  console.log(`[Token] Requesting ${label} token from ${baseUrl}/token...`);

  let res;
  try {
    res = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    // A timeout/abort must surface as a normal failure so the breaker counts
    // it and the next caller can retry, rather than hanging forever.
    const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      ? `timed out after ${TOKEN_TIMEOUT_MS}ms`
      : err.message;
    throw new Error(`[Token] ${label} request failed: ${reason}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[Token] ${label} refresh failed: HTTP ${res.status} — ${body}`);
  }

  return await res.json();
};

export const refreshToken = async () => {
  // Join the refresh already in flight rather than starting a competing one.
  // The guard lives HERE rather than only in getToken() so every path shares
  // it — including lp-client.js's 401 retry (which stampedes hardest, since
  // concurrent calls all get 401 together) and the 23-hour scheduled refresh.
  if (inFlightRefresh) return await inFlightRefresh;

  inFlightRefresh = (async () => {
    const data = await requestToken({
      username: process.env.LP_USERNAME,
      password: process.env.LP_PASSWORD,
      label: 'primary',
    });
    cachedToken = data.access_token;
    // LP tokens expire in 24 hours — refresh 1 hour early (23 hours)
    tokenExpiry = Date.now() + (23 * 60 * 60 * 1000);
    console.log('[Token] Refreshed — valid for 23 hours');
    return cachedToken;
  })();

  try {
    return await inFlightRefresh;
  } finally {
    // Cleared on settle, success or failure: a failed refresh must not pin a
    // rejected promise that every later caller then inherits.
    inFlightRefresh = null;
  }
};

/**
 * Refresh the note-writing token.
 *
 * A failure here does NOT fall back to the primary credential. Falling back
 * would post the note under the wrong author and report success, which is the
 * one outcome this whole separation exists to prevent — and it would be
 * invisible, because AddNotes answers every write with the same constant
 * string either way. Let it throw; sync.js already records a sync failure with
 * the reason and retries on backoff.
 */
export const refreshNoteToken = async () => {
  if (inFlightNoteRefresh) return await inFlightNoteRefresh;

  inFlightNoteRefresh = (async () => {
    const data = await requestToken({
      username: process.env.LP_NOTE_USERNAME,
      password: process.env.LP_NOTE_PASSWORD,
      label: 'note-identity',
    });
    cachedNoteToken = data.access_token;
    noteTokenExpiry = Date.now() + (23 * 60 * 60 * 1000);
    console.log(`[Token] Note-identity token refreshed (user=${process.env.LP_NOTE_USERNAME}) — valid for 23 hours`);
    return cachedNoteToken;
  })();

  try {
    return await inFlightNoteRefresh;
  } finally {
    inFlightNoteRefresh = null;
  }
};

export const invalidateToken = () => {
  cachedToken = null;
  tokenExpiry = null;
  // Deliberately does NOT touch inFlightRefresh. A refresh already in flight
  // is fetching a NEWER token than the one being invalidated, so cancelling it
  // would only make the next caller start another.
};

/** Invalidate the note-identity token only. */
export const invalidateNoteToken = () => {
  cachedNoteToken = null;
  noteTokenExpiry = null;
};

export const getTokenStatus = () => ({
  hasToken: !!cachedToken,
  expiresAt: tokenExpiry ? new Date(tokenExpiry).toISOString() : null,
  expiresInMs: tokenExpiry ? tokenExpiry - Date.now() : null,
  refreshInFlight: !!inFlightRefresh,
  noteRefreshInFlight: !!inFlightNoteRefresh,
  tokenTimeoutMs: TOKEN_TIMEOUT_MS,
  noteIdentity: hasNoteIdentity() ? (process.env.LP_NOTE_USERNAME || null) : null,
  hasNoteToken: !!cachedNoteToken,
  noteExpiresAt: noteTokenExpiry ? new Date(noteTokenExpiry).toISOString() : null,
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
    // Refresh the note identity on the same cadence, but only when one is
    // configured, and never let its failure abort the primary refresh above.
    if (hasNoteIdentity()) {
      try {
        await refreshNoteToken();
      } catch (err) {
        console.error('[Token] Scheduled note-identity refresh failed:', err.message);
      }
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
