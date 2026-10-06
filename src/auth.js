import { timingSafeEqual } from 'node:crypto';
// Circular on purpose: request-auth reuses safeEqual from here. Each side
// reads the other's exports only inside function bodies, never while its
// module body runs, so the cycle is safe.
import { authEnforceMode, recordAuthWouldReject } from './security/request-auth.js';

/**
 * auth — the standard operator bearer-token middleware.
 *
 * Moved out of src/index.js unchanged (2026-09-23) so a route module can be
 * tested against the REAL check rather than a stand-in. index.js builds the
 * one instance every authenticated route uses; behaviour is identical:
 *
 *   - no MCP_AUTH_TOKEN configured → open (local dev)
 *   - `Authorization: Bearer <token>` → allowed
 *   - AUTH_SOFT_LAUNCH=true → logged and allowed ("would reject")
 *   - otherwise → 401
 *
 * @param {{ token?: string|null, softLaunch?: boolean, log?: (msg: string) => void }} opts
 * @returns {(req, res, next) => void}
 */
/**
 * Constant-time string compare (2026-10-03, security review). A plain `===`
 * returns as soon as one character differs, which leaks how much of a guess
 * was right through response timing. Different lengths are simply unequal.
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/*
 * AUTH_ENFORCE_MODE (2026-10-06, AI OS batch 1 PR 3; src/security/request-auth.js):
 *   log (default) — the four lines above, unchanged, plus one
 *     `security.auth_would_reject` row per route+reason per hour for an unset
 *     token (secret_unset) and a soft-launch pass (soft_launch).
 *   enforce — no token configured → 503; AUTH_SOFT_LAUNCH is ignored → 401.
 * `mode` and `record` are seams for tests; production reads the env per request.
 */
export function makeAuthenticate({ token = null, softLaunch = false, log = (m) => console.warn(m), mode = null, record = recordAuthWouldReject } = {}) {
  return function authenticate(req, res, next) {
    const m = mode ?? authEnforceMode();
    const route = req.path || req.originalUrl || 'unknown';

    if (!token) {
      record({ route, reason: 'secret_unset', mode: m, method: req.method });
      if (m === 'enforce') return res.status(503).json({ error: 'auth_not_configured', detail: 'MCP_AUTH_TOKEN is not set; this endpoint refuses all requests' });
      return next();
    }

    const authHeader = req.headers.authorization;
    if (safeEqual(authHeader, `Bearer ${token}`)) return next();

    if (softLaunch && m !== 'enforce') {
      log(`[Auth] SOFT_LAUNCH: unauthenticated ${req.method} ${req.path} from ${req.ip} ua="${req.headers['user-agent'] || 'none'}" — would reject in enforce mode`);
      record({ route, reason: 'soft_launch', mode: m, method: req.method });
      return next();
    }

    record({ route, reason: authHeader ? 'bad_secret' : 'missing_token', mode: m, method: req.method });
    return res.status(401).json({ error: 'Unauthorized' });
  };
}

/**
 * Fail-closed stand-in for a route module that was registered without an
 * auth middleware. A route that spends money or rewrites data must never go
 * open because a caller forgot to pass one.
 */
export function denyAll(_req, res) {
  return res.status(401).json({ error: 'Unauthorized' });
}
