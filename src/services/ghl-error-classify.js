// ─── GHL error classification — src/services/ghl-error-classify.js ──────────
//
// 2026-07-29 incident. A single orphan contact id (Y21mrJPUGYGKIWFptVpu on LP
// lead 562172) produced "[Sync] GHL notes push: 0 pushed, 3 failed" every 90s
// cycle, forever. The id exists in no Reece location, and GHL answers a contact
// outside the token's location with:
//
//   HTTP 403 {"statusCode":403,"message":"The token does not have access to this location."}
//
// ...while some deleted contacts answer 404. The old classifier in src/ghl.js
// only matched 400 + "not found", so neither shape was recognised. Every retry
// therefore fell through to the generic failure branch and walked the SHARED
// module-level ghlFailCount toward GHL_FAIL_THRESHOLD — one bad contact id was
// able to set ghlDisabled = true and silently kill tag, field, note and email
// writes for every contact until the process restarted.
//
// This lives outside src/ghl.js on purpose, for two reasons:
//
//   1. Testability. src/ghl.js builds its axios client from process.env at
//      module load and never exports the classifier, so it cannot be exercised
//      without an adapter injection or nock (neither is a dependency — the repo
//      has zero devDependencies). A pure function is trivially unit-testable;
//      see scripts/test-ghl-error-classify.js.
//   2. Reuse. scripts/audit-orphan-ghl-links.js needs the same 403/404 logic,
//      but reads through ghlFetch (src/actions/helpers.js), whose errors have a
//      completely different shape from axios's.
//
// BINDING RULE: a BARE 403 is NOT not-found. A genuine scope or credential
// revocation must still surface as a hard failure and must still trip the kill
// switch — that is the whole point of the kill switch. Only the specific
// wrong-location message is reclassified.

/**
 * Classify a GHL API error, normalizing both error shapes used in this repo.
 *
 *   axios (src/ghl.js)          → err.response.status / err.response.data
 *   ghlFetch (actions/helpers)  → plain Error, message is
 *                                 `GHL ${method} ${path} → ${status}: ${body}`
 *                                 (status exists ONLY inside the message)
 *
 * @param {unknown} err
 * @returns {{ status: number|null, notFound: boolean, reason: string|null }}
 *   notFound=true means "this contact id is not reachable by us — never retry".
 *   status is null for network/timeout errors that never got a response.
 */
export function classifyGHLError(err) {
  let status = err?.response?.status ?? err?.status ?? null;
  let body = err?.response?.data;

  // ghlFetch form: recover the status (and body) from the thrown message.
  if (status == null && typeof err?.message === 'string') {
    const m = err.message.match(/→\s*(\d{3})\s*:\s*([\s\S]*)$/);
    if (m) {
      status = Number(m[1]);
      body = m[2];
    }
  }

  const text = (typeof body === 'string' ? body : JSON.stringify(body ?? ''))
    .toLowerCase();

  // Deleted contact.
  if (status === 404) {
    return { status, notFound: true, reason: 'http_404' };
  }
  // Pre-existing behavior, preserved verbatim.
  if (status === 400 && text.includes('not found')) {
    return { status, notFound: true, reason: 'http_400_not_found' };
  }
  // Contact id belongs to another location — "not found" as far as we can act.
  // Matched on the message substring, case-insensitive, NOT on the bare status.
  if (status === 403 && text.includes('does not have access to this location')) {
    return { status, notFound: true, reason: 'http_403_wrong_location' };
  }

  return { status, notFound: false, reason: null };
}
