# GET /health/integrations — connection reachability probes

**Added:** 2026-09-16
**Auth:** same Bearer token as the MCP endpoint (`MCP_AUTH_TOKEN`)
**Consumer:** Reece-Dashboard → Settings → Integrations grid

## Why

The dashboard could tell whether LP MCP and HL MCP answered, but not whether
the services behind them were reachable. The 47-hour agentic-silence outage
and the 71-day fail-closed blind spot both looked like quiet nights from the
outside, and the Slack mirror is fail-silent by design. This endpoint gives
one screen a live "can we reach it right now?" answer for the four services
whose credentials exist only in this process.

## What it probes (read-only, never posts)

| id | how | states |
|---|---|---|
| `lp_api` | `getToken()` (cached; only logs in when expired) | connected / not_configured / error |
| `five9` | `getSkills` (smallest admin read); refuses if the auth breaker is open | connected / not_configured / error |
| `slack` | `auth.test` with the bot token; `not_configured` if the mirror is off | connected / not_configured / error |
| `groupme` | read API (`GROUPME_ACCESS_TOKEN` + `GROUPME_GROUP_ID`); bot id alone is `unknown` because a bot can only be tested by posting | connected / unknown / not_configured / error |

## The state vocabulary

`connected` means the probe reached the service and got a sane answer.
`degraded` is reserved for reachable-but-stale. `not_configured` names the
missing env var. `error` is a definite failure (401, SOAP fault,
`invalid_auth`). `unknown` means the probe could not run or timed out (5s),
and is **never** rendered green: same tri-state doctrine as `active: null`
in `src/alert-state.js`.

Probes run in parallel with `Promise.allSettled`; one failing probe never
hides another row.

## Response

```json
{
  "status": "ok",
  "checked_at": "2026-09-16T14:02:11.000Z",
  "integrations": [
    { "id": "five9", "name": "Five9", "group": "dialer", "state": "connected",
      "detail": "Admin API answered. 12 skills.", "latency_ms": 640,
      "checked_at": "2026-09-16T14:02:11.000Z", "meta": { "skills": 12 } }
  ]
}
```

Logic lives in `src/integrations-health.js` (pure, `deps` seam); tests in
`scripts/test-integrations-health.js`.
