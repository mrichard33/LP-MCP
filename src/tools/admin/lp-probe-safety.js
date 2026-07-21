// ─── LP API Probe safety gate ────────────────────────────────────
// Pure, dependency-free — imported by lp-probe-tools.js and unit-tested
// directly (scripts/test-lp-probe-safety.js) without needing node_modules.
//
// Every LP endpoint is POST, so the HTTP verb carries no safety signal.
// Gate on the function name in the path instead: only
// /api/<Namespace>/Get*|List* passes, and anything containing a mutating
// verb is rejected belt-and-braces. /api/Leads/AddLead fails the
// allowlist; /api/SalesApi/GetSalesSchedule passes. That's the whole
// contract.

// Allow: /api/<Namespace>/Get*  and  /api/<Namespace>/List*
export const PROBE_ALLOW = /^\/api\/[A-Za-z0-9]+\/(Get|List)[A-Za-z0-9]*$/;

// Belt and braces — reject anything that smells mutating even if it
// somehow satisfies the pattern above. Matched against whole CamelCase
// words, NOT substrings: a raw substring test rejects real read
// endpoints ("GetLeadData" contains "adD" ≈ Add; "GetDisputes" would
// contain "put"). The allowlist above is the primary gate — this only
// needs to catch compound names like GetAndUpdateLead.
export const PROBE_DENY_VERBS = [
  'Add', 'Set', 'Update', 'Delete', 'Del', 'Save', 'Insert',
  'Remove', 'Post', 'Put', 'Merge', 'Assign',
];

function containsMutatingVerb(fnRemainder) {
  const words = fnRemainder.split(/(?=[A-Z])/);
  return words.some((w) => PROBE_DENY_VERBS.some((v) => w.toLowerCase() === v.toLowerCase()));
}

export function assertProbeSafe(path) {
  if (!PROBE_ALLOW.test(path)) {
    throw new Error(`Probe rejected: "${path}" is not a Get*/List* function.`);
  }
  const fn = path.split('/').pop();
  if (containsMutatingVerb(fn.replace(/^(Get|List)/, ''))) {
    throw new Error(`Probe rejected: "${fn}" contains a mutating verb.`);
  }
}

// Truncate top-level array responses to maxRows.
export function truncateRows(result, maxRows) {
  if (Array.isArray(result) && result.length > maxRows) {
    return { total_rows: result.length, showing: maxRows, rows: result.slice(0, maxRows) };
  }
  return result;
}
