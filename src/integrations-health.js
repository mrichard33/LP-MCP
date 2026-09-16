/**
 * integrations-health.js — read-only reachability probes for the services
 * whose credentials live only in this process (LP API, Five9, Slack, GroupMe).
 *
 * WHY (2026-09-16). The dashboard could say whether LP MCP and HL MCP answer,
 * but not whether the things BEHIND them were reachable. Every silent outage
 * we have paid for looked like a quiet night from the outside: the 47-hour
 * agentic-silence outage, the 71-day fail-closed blind spot, the Slack mirror
 * that is fail-silent by design (src/slack.js). This module lets one screen
 * answer "can we reach it right now?" for each of those services.
 *
 * The contract (borrowed from the Founder OS connectors pattern, MIT):
 *   - one row per service: { id, name, group, state, detail, checked_at, latency_ms, meta }
 *   - state is one of  connected | degraded | not_configured | error | unknown
 *   - a probe NEVER reports `connected` unless it actually reached the service
 *   - a throw becomes `error`, a timeout becomes `unknown` (tri-state: "could
 *     not tell" is not "healthy" — same doctrine as reportAlertCondition's
 *     `active: null` in src/alert-state.js)
 *   - probes run in parallel via Promise.allSettled so one failure can never
 *     hide another row
 *   - probes are READ-ONLY and never post. GroupMe bots can only be exercised
 *     by posting, so with a bot id alone the row is `unknown`, on purpose.
 *
 * Everything that reaches the network comes in through `deps` so the module
 * unit-tests with no live service (scripts/test-integrations-health.js).
 */

export const PROBE_TIMEOUT_MS = 5000;

export const STATES = Object.freeze(['connected', 'degraded', 'not_configured', 'error', 'unknown']);

const LP_REQUIRED_ENV = ['LP_API_BASE_URL', 'LP_CLIENT_ID', 'LP_USERNAME', 'LP_PASSWORD', 'LP_APP_KEY'];

function row(id, name, group, state, detail, extra = {}) {
  return { id, name, group, state, detail, ...extra };
}

/**
 * Run one probe under a timeout. `fn` resolves to a partial row
 * ({ state, detail, meta? }); the wrapper fills in identity and timing.
 *   throw    → error   (message is the detail)
 *   timeout  → unknown (never green on "no answer")
 */
export async function probe(id, name, group, fn, { timeoutMs = PROBE_TIMEOUT_MS, now = Date.now } = {}) {
  const started = now();
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs);
  });
  let result;
  try {
    result = await Promise.race([Promise.resolve().then(fn), timeout]);
  } catch (err) {
    clearTimeout(timer);
    return row(id, name, group, 'error', String(err?.message || err).slice(0, 300), {
      latency_ms: now() - started,
    });
  }
  clearTimeout(timer);
  if (result && result.__timeout) {
    return row(id, name, group, 'unknown', `no answer within ${timeoutMs}ms`, {
      latency_ms: now() - started,
    });
  }
  const state = STATES.includes(result?.state) ? result.state : 'unknown';
  return row(id, name, group, state, String(result?.detail ?? ''), {
    latency_ms: now() - started,
    ...(result?.meta ? { meta: result.meta } : {}),
  });
}

// ─── Individual probes ──────────────────────────────────────────────

async function lpApiProbe(deps) {
  const env = deps.env;
  const missing = LP_REQUIRED_ENV.filter((k) => !env[k]);
  if (missing.length) {
    return { state: 'not_configured', detail: `Set ${missing.join(', ')} on LP MCP.` };
  }
  // getToken() is cached and single-flighted: it only logs in when the token
  // is expired. Deliberately NOT testConnection() — that invalidates the live
  // token and would force a re-login on every dashboard render.
  await deps.lp.getToken();
  const status = deps.lp.getTokenStatus();
  const expiresIn = typeof status?.expiresInMs === 'number' ? Math.round(status.expiresInMs / 60000) : null;
  return {
    state: status?.hasToken ? 'connected' : 'error',
    detail: status?.hasToken
      ? `Authenticated. Token expires in ${expiresIn ?? '?'} min.`
      : 'Login returned no token.',
    meta: { expires_at: status?.expiresAt ?? null },
  };
}

async function five9Probe(deps) {
  const env = deps.env;
  if (!env.FIVE9_USERNAME || !env.FIVE9_PASSWORD) {
    return { state: 'not_configured', detail: 'Set FIVE9_USERNAME and FIVE9_PASSWORD on LP MCP.' };
  }
  const breaker = deps.five9.breakerStatus();
  if (breaker?.open) {
    return {
      state: 'error',
      detail: `Auth breaker open since ${breaker.since}: ${breaker.reason}. Fix the credential, then reset the breaker.`,
    };
  }
  // getSkills is the smallest read the admin API offers.
  const skills = await deps.five9.getSkills();
  return {
    state: 'connected',
    detail: `Admin API answered. ${skills?.count ?? 0} skills.`,
    meta: { skills: skills?.count ?? 0 },
  };
}

async function slackProbe(deps) {
  const env = deps.env;
  if (String(env.SLACK_MIRROR_ENABLED || 'false') !== 'true') {
    return { state: 'not_configured', detail: 'Mirror is off (SLACK_MIRROR_ENABLED is not "true"). Cards go to GroupMe only.' };
  }
  if (!env.SLACK_BOT_TOKEN) {
    return { state: 'not_configured', detail: 'Mirror is on but SLACK_BOT_TOKEN is unset; every mirror send is a silent no-op.' };
  }
  const res = await deps.fetch('https://slack.com/api/auth.test', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.ok) {
    return { state: 'error', detail: `auth.test failed: ${body?.error || `HTTP ${res.status}`}` };
  }
  return {
    state: 'connected',
    detail: `Bot token valid for ${body.team || 'workspace'} as ${body.user || 'bot'}.`,
    meta: { team: body.team ?? null, user: body.user ?? null },
  };
}

async function groupmeProbe(deps) {
  const env = deps.env;
  const hasRead = Boolean(env.GROUPME_ACCESS_TOKEN && env.GROUPME_GROUP_ID);
  if (hasRead) {
    const r = await deps.groupme.getRecentMessages(1);
    if (r?.ok) {
      return { state: 'connected', detail: 'Read API answered for the configured group.' };
    }
    return { state: 'error', detail: `Read API failed: ${r?.reason || 'unknown'}` };
  }
  if (env.GROUPME_BOT_ID) {
    // A bot can only be exercised by posting, and a probe must never post.
    return {
      state: 'unknown',
      detail: 'Bot id set. Add GROUPME_ACCESS_TOKEN + GROUPME_GROUP_ID to probe reachability without posting.',
    };
  }
  return { state: 'not_configured', detail: 'Set GROUPME_BOT_ID on LP MCP.' };
}

// ─── Aggregate ──────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {Record<string,string|undefined>} deps.env
 * @param {typeof fetch} deps.fetch
 * @param {{ getToken: () => Promise<string>, getTokenStatus: () => object }} deps.lp
 * @param {{ breakerStatus: () => object, getSkills: () => Promise<{count:number}> }} deps.five9
 * @param {{ getRecentMessages: (n:number) => Promise<{ok:boolean, reason?:string}> }} deps.groupme
 * @param {() => number} [deps.now]
 * @param {number} [deps.timeoutMs]
 */
export async function buildIntegrationsHealth(deps) {
  const opts = { timeoutMs: deps.timeoutMs ?? PROBE_TIMEOUT_MS, now: deps.now ?? Date.now };
  const settled = await Promise.allSettled([
    probe('lp_api', 'Lead Perfection API', 'services', () => lpApiProbe(deps), opts),
    probe('five9', 'Five9', 'dialer', () => five9Probe(deps), opts),
    probe('slack', 'Slack mirror', 'notify', () => slackProbe(deps), opts),
    probe('groupme', 'GroupMe', 'notify', () => groupmeProbe(deps), opts),
  ]);
  const checkedAt = new Date(opts.now()).toISOString();
  const integrations = settled.map((s) =>
    s.status === 'fulfilled'
      ? { ...s.value, checked_at: checkedAt }
      : row('unknown', 'unknown', 'services', 'unknown', String(s.reason?.message || s.reason), { checked_at: checkedAt }),
  );
  return { checked_at: checkedAt, integrations };
}
