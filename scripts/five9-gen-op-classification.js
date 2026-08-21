#!/usr/bin/env node
/**
 * Generate docs/five9/op-classification.md from wsdl-schema.json +
 * OP_CLASSIFICATION.  Run:
 *   node scripts/five9-gen-op-classification.js          # write the doc
 *   node scripts/five9-gen-op-classification.js --check  # exit 1 if stale
 *
 * The doc is GENERATED, not hand-maintained. That is the point: a hand-typed
 * 182-row table drifts from the schema the first time Five9 ships a version
 * bump, and a blank cell in one is invisible. Here the row set comes from the
 * artifact and every cell comes from a required field, so "all 182 operations,
 * no blanks" is a property of the generator rather than a thing to re-check by
 * eye. scripts/test-five9-op-registry.js runs this in --check mode.
 *
 * EDIT src/five9/op-registry.js, NOT the markdown.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { wsdlSchema } from '../src/five9/admin-writes.js';
import {
  OP_CLASSIFICATION, OP_REGISTRY, TIERS, KINDS, STATUSES,
  unknownOperations, unclassifiedOperations,
} from '../src/five9/op-registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = resolve(HERE, '../docs/five9/op-classification.md');

const schema = wsdlSchema();

/* -- integrity: refuse to generate a doc that would be wrong -------------- */
const unknown = unknownOperations(schema);
const unclassified = unclassifiedOperations(schema);
if (unknown.length) {
  console.error(`REFUSED: classified operations absent from v13: ${unknown.join(', ')}`);
  process.exit(2);
}
if (unclassified.length) {
  console.error(`REFUSED: v13 operations with no classification row: ${unclassified.join(', ')}`);
  process.exit(2);
}
for (const [op, row] of Object.entries(OP_CLASSIFICATION)) {
  for (const [k, allowed] of [['kind', KINDS], ['tier', TIERS], ['status', STATUSES]]) {
    if (!allowed.includes(row[k])) {
      console.error(`REFUSED: ${op}.${k} = ${JSON.stringify(row[k])} is not one of ${allowed.join('|')}`);
      process.exit(2);
    }
  }
  if (!row.reason || !row.reason.trim()) {
    console.error(`REFUSED: ${op} has no reason`);
    process.exit(2);
  }
}

/* -- rendering ------------------------------------------------------------ */
const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
const ops = Object.keys(OP_CLASSIFICATION).sort((a, b) => a.localeCompare(b));

const count = (pred) => ops.filter((o) => pred(OP_CLASSIFICATION[o])).length;
const tierCount = (t) => count((r) => r.tier === t);
const registered = new Map(OP_REGISTRY.map((e) => [e.soapOperation, e.actionType]));

const rows = ops.map((op) => {
  const r = OP_CLASSIFICATION[op];
  const at = registered.get(op);
  const name = at ? `\`${op}\`<br>→ \`${at}\`` : `\`${op}\``;
  return `| ${name} | ${r.kind} | **${r.tier}** | ${r.status} | ${esc(r.reason)} |`;
});

const doc = `# Five9 Admin API v13 — operation classification

<!-- GENERATED FILE — DO NOT EDIT BY HAND.
     Source: src/five9/op-registry.js (OP_CLASSIFICATION) + src/five9/wsdl-schema.json
     Regenerate: node scripts/five9-gen-op-classification.js
     Verified in CI by scripts/test-five9-op-registry.js -->

Every operation in the v13 Admin API, classified. Generated from
\`src/five9/wsdl-schema.json\` (v13.0.00/13, sha256 \`${schema.wsdlSha256.slice(0, 12)}…\`,
extracted ${schema.generatedAt.slice(0, 10)}) — **${schema.operationCount} operations, ${schema.complexTypeCount} complexTypes**.

## Why this document exists

Before it, the answer to "can we automate X in Five9?" was a research project
per operation: find the op, transcribe its \`xs:sequence\` by hand, discover its
guards, wire six touch-points. Roughly a day each, and 24 action types deep the
list of what we had *decided about* was shorter than the list of what *exists*.

The tier list that came out of earlier planning was derived from a v9.5-era
reference and did not survive contact with the v13 schema. It named four
operations that do not exist:

| named | reality in v13 |
|---|---|
| \`getCallLogReport\`, \`getCallLogReportCsv\` | do not exist — and were listed as already implemented |
| \`getAgentAuditReport\`, \`getAgentAuditReportCsv\` | do not exist; the string "audit" appears nowhere in the 961 KB WSDL, so **the Admin API has no audit-trail operation at all** |
| \`resetListPositions\` | the real name is \`resetListPosition\`, singular |

It also left 57 operations unclassified, including two feature areas nobody had
looked at: **speed dial** and **IVR icons / script ownership**.

**The schema is the authority.** Every operation name below is a key in
\`wsdl-schema.json\`; nothing survives here that the artifact does not contain.

## How to read the tiers

The line between \`enabled\` and \`gated\` is about the **payload**, not about risk.

| tier | meaning |
|---|---|
| \`enabled\` | Registered; \`approve_action\` alone clears it. Guards still run and can refuse — an INBOUND target, a campaign already RUNNING — but the caller needs no extra ceremony in the payload. |
| \`gated\` | Registered, and the payload must carry something **more** than the approval: a \`confirm_token\` restating the target, a \`compliance_override\` plus \`legal_basis\`, or a declared record count. A gated op can refuse an already-approved action. |
| \`denied\` | Must not be registered, ever. Every denied row carries a specific reason. Enforced by test — \`scripts/test-five9-op-registry.js\` fails if a denied operation acquires an action type or a reachable handler. |
| \`skip\` | Not a registry candidate. Every **read** is \`skip\` — a read is a direct MCP tool, never an approvable agent action. A **write** is \`skip\` when it is redundant with something already shipped, or has no identified use. |

\`status\` is \`shipped\` when the operation is reachable today (as a \`five9_*\`
action type, or as a reader in \`src/five9-admin.js\`), \`not-built\` otherwise.

## Counts

| | count |
|---|---|
| operations in v13 | **${schema.operationCount}** |
| reads | ${count((r) => r.kind === 'read')} |
| writes | ${count((r) => r.kind === 'write')} |
| \`enabled\` | ${tierCount('enabled')} |
| \`gated\` | ${tierCount('gated')} |
| \`denied\` | ${tierCount('denied')} |
| \`skip\` | ${tierCount('skip')} |
| shipped today | ${count((r) => r.status === 'shipped')} |
| registered action types | ${OP_REGISTRY.length} |

**No new operation is registered by this PR.** The registry ships seeded with
exactly the ${OP_REGISTRY.length} action types that already existed, and one of them —
\`five9_create_campaign_profile\` — migrated onto \`buildFromSchema\`.
Tiers below are the *proposal* for later tranches, not a description of what is
live. Each tranche is its own reviewable PR against a builder that has already
proven itself.

## Open questions for Mark

Two feature areas were never considered before this pass. They are classified
here from first principles and flagged rather than decided:

- **Speed dial** — \`createSpeedDialNumber\`, \`getSpeedDialNumbers\`,
  \`removeSpeedDialNumber\`. The schema shows \`{code, number, description}\`: an
  agent-desktop dialling shortcut with no routing or compliance effect.
  *Proposed \`skip\`* — no agentic need identified.
- **IVR icons and script ownership** — \`getIvrIcons\`, \`setIvrIcons\`,
  \`removeIvrIcons\`, \`getIvrScriptOwnership\`, \`setIvrScriptOwnership\`,
  \`removeIvrScriptOwnership\`. Icons are the visual representation of a script
  in the IVR designer, with no runtime effect. Ownership reads as an
  access-control grant from its name, but the schema shows a single
  \`othersCanCopy\` boolean — it governs whether other admins may **copy** a
  script, not who may edit or run it. *Proposed \`skip\`* for both.

## All ${schema.operationCount} operations

Sorted by name. A registered operation shows its action type beneath it.

| operation | kind | tier | status | reason |
|---|---|---|---|---|
${rows.join('\n')}

---

_Generated by \`scripts/five9-gen-op-classification.js\`. To change a row, edit
\`OP_CLASSIFICATION\` in \`src/five9/op-registry.js\` and regenerate._
`;

const check = process.argv.includes('--check');
if (check) {
  let current = '';
  try { current = readFileSync(DOC, 'utf8'); } catch { /* missing counts as stale */ }
  if (current !== doc) {
    console.error('STALE: docs/five9/op-classification.md does not match OP_CLASSIFICATION.');
    console.error('Regenerate: node scripts/five9-gen-op-classification.js');
    process.exit(1);
  }
  console.log(`op-classification.md is current (${ops.length} operations).`);
} else {
  writeFileSync(DOC, doc);
  console.log(`Wrote ${DOC} — ${ops.length} operations.`);
}
