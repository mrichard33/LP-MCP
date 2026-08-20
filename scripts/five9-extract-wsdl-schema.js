#!/usr/bin/env node
/**
 * five9-extract-wsdl-schema.js — regenerate src/five9/wsdl-schema.json from the
 * live Five9 Admin API WSDL.
 *
 * Standalone and manually run. NOTHING in the server imports this file; the
 * committed JSON artifact is what the runtime and the tests read.
 *
 *   node scripts/five9-extract-wsdl-schema.js            # write the artifact
 *   node scripts/five9-extract-wsdl-schema.js --stdout   # print, write nothing
 *   node scripts/five9-extract-wsdl-schema.js --file X   # parse a local copy
 *
 * ---------------------------------------------------------------------------
 * FETCH NOTE — the `&user=x` parameter is load-bearing.
 *
 * Plain `?wsdl` returns HTTP 403 carrying a SOAP Fault, not a schema:
 *     <faultstring>No user name ("user" parameter) provided</faultstring>
 * Appending `&user=x` is what makes it fetchable. ANY value works and NO
 * password is involved — this endpoint needs no credentials. The 403 reads like
 * "the proxy blocked me" or "we need FIVE9_USERNAME/FIVE9_PASSWORD"; it is
 * neither. This was first recorded in docs/five9/phase-g-wsdl-v13.md.
 *
 * Do NOT fetch this through LP-MCP's `http_request` tool: MAX_BODY_CHARS in
 * src/tools/admin/http-tools.js truncates at 100,000 characters and the
 * document is ~961 KB, so everything past roughly the first tenth is silently
 * lost. That truncation is why Phase D stalled. Plain fetch, as used here, is
 * the only path that returns the whole schema.
 *
 * The document is pretty-printed (~20,205 lines), not one long line: every
 * top-level <xs:complexType> sits at exactly two spaces of indentation. The
 * parser below does not rely on that, but it is why the output diffs cleanly.
 * ---------------------------------------------------------------------------
 *
 * WHY THIS EXISTS. Every Five9 SOAP body in src/five9/admin-writes.js is
 * emitted in WSDL sequence order, because JAXB rejects out-of-order elements.
 * Those orders were transcribed by hand, which has already produced shipped
 * bugs (a55200d, and the defaultIvrSchedule correction at admin-writes.js:1706).
 * scripts/test-five9-wsdl-schema.js diffs every hand-written *_FIELD_ORDER
 * against this artifact, so a transcription error fails the suite instead of
 * reaching Five9 as a 500.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(HERE, '../src/five9/wsdl-schema.json');

// Same default as src/tools/admin/http-tools.js:63 — no new env var.
const ENDPOINT =
  process.env.FIVE9_ADMIN_WSDL_URL || 'https://api.five9.com/wsadmin/v13/AdminWebService';
const WSDL_URL = `${ENDPOINT}?wsdl&user=x`;

const FETCH_TIMEOUT_MS = 120_000;
// The v13 document is ~961 KB. Anything dramatically smaller means we caught a
// SOAP Fault or a truncating proxy rather than a schema.
const MIN_PLAUSIBLE_BYTES = 400_000;

/* -- fetch ---------------------------------------------------------------- */

async function fetchWsdl() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res, text;
  try {
    res = await fetch(WSDL_URL, { signal: controller.signal });
    text = await res.text();
  } catch (err) {
    throw new Error(
      err.name === 'AbortError'
        ? `WSDL fetch timed out after ${FETCH_TIMEOUT_MS}ms`
        : `WSDL fetch failed: ${err.message}`
    );
  } finally {
    clearTimeout(timer);
  }

  const fault = /<faultstring>([\s\S]*?)<\/faultstring>/i.exec(text);
  if (fault) {
    throw new Error(
      `WSDL endpoint returned a SOAP Fault instead of a schema: ${fault[1].trim()}\n` +
      '(if this says No user name — the &user=x parameter went missing; see the FETCH NOTE)'
    );
  }
  if (!res.ok) throw new Error(`WSDL fetch: HTTP ${res.status}`);
  if (!text.includes('<wsdl:definitions')) {
    throw new Error('Response is not a WSDL document (no <wsdl:definitions>)');
  }
  return text;
}

/* -- parse ---------------------------------------------------------------- */

function attrs(raw) {
  // Attribute ORDER varies across the document (minOccurs-first and name-first
  // both occur), so parse into a map rather than positionally.
  const out = {};
  const re = /([A-Za-z:]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(raw))) out[m[1]] = m[2];
  return out;
}

// Strip the tns:/xs: prefix — every type in this document is in one of two
// namespaces and the prefix carries no information the consumer needs.
const localName = (v) => (v == null ? null : String(v).replace(/^[^:]+:/, ''));

/**
 * Walk every xs: tag once, maintaining a stack, and record:
 *   - named complexTypes at schema level, with their inheritance base
 *   - the xs:element children of each type's own sequence
 *   - schema-level xs:element declarations (the operation request wrappers)
 *
 * A stack-based walk rather than per-type regex slicing because three
 * complexTypes in this document are anonymous and nested inside an element;
 * their children must not be attributed to the enclosing named type.
 */
function parseSchema(text) {
  const complexTypes = {};
  const elementDecls = {};

  const tagRe = /<(\/?)(xs:[A-Za-z]+)([^>]*?)(\/?)>/g;
  const stack = [];
  let current = null; // the named complexType being filled

  let m;
  while ((m = tagRe.exec(text))) {
    const [, closing, tag, rawAttrs, selfClosing] = m;

    if (closing) {
      const popped = stack.pop();
      if (popped === 'xs:complexType' && current && current.depth === stack.length) {
        complexTypes[current.name] = current.record;
        current = null;
      }
      continue;
    }

    const a = attrs(rawAttrs);
    const isLeaf = selfClosing === '/';
    const parent = stack[stack.length - 1];

    if (tag === 'xs:complexType') {
      // Named, and a direct child of xs:schema — anything deeper is anonymous
      // or nested and is deliberately ignored.
      if (a.name && parent === 'xs:schema' && !current) {
        current = {
          name: a.name,
          depth: stack.length,
          record: {
            extends: null,
            abstract: a.abstract === 'true',
            final: a.final ?? null,
            fields: [],
          },
        };
      }
    } else if (tag === 'xs:extension' && current) {
      current.record.extends = localName(a.base);
    } else if (tag === 'xs:element') {
      if (parent === 'xs:schema') {
        // Schema-level declaration: the request/response wrapper elements.
        if (a.name) elementDecls[a.name] = localName(a.type);
      } else if (current && parent === 'xs:sequence') {
        // A field of the type currently being filled. minOccurs defaults to 1
        // in XSD, and its ABSENCE is what makes an element schema-required —
        // see userSkill/level, the Phase G regression.
        current.record.fields.push({
          name: a.name,
          type: localName(a.type),
          minOccurs: a.minOccurs === undefined ? 1 : Number(a.minOccurs),
          maxOccurs: a.maxOccurs ?? null,
          nillable: a.nillable === 'true',
        });
      }
    }

    if (!isLeaf) stack.push(tag);
  }

  return { complexTypes, elementDecls };
}

/** Operation names from the portType, with their documentation string. */
function parseOperations(text, elementDecls, complexTypes) {
  const portType = /<wsdl:portType[\s\S]*?<\/wsdl:portType>/.exec(text);
  if (!portType) throw new Error('No <wsdl:portType> found');

  const operations = {};
  const opRe = /<wsdl:operation name="([^"]+)">([\s\S]*?)<\/wsdl:operation>/g;
  let m;
  while ((m = opRe.exec(portType[0]))) {
    const [, name, body] = m;
    const doc = /<wsdl:documentation>([\s\S]*?)<\/wsdl:documentation>/.exec(body);
    const requestWrapper = elementDecls[name] ?? null;
    const wrapper = requestWrapper ? complexTypes[requestWrapper] : null;
    const fields = wrapper ? wrapper.fields : [];

    // Most request wrappers hold exactly one child (e.g. createCampaignProfile
    // -> <campaignProfile> of type campaignProfileInfo). Surfacing that pair
    // is what lets a caller find the type to build without re-reading the WSDL.
    const only = fields.length === 1 ? fields[0] : null;

    operations[name] = {
      requestWrapper,
      childElement: only ? only.name : null,
      childType: only ? only.type : null,
      fields: fields.map((f) => f.name),
      responseType: elementDecls[`${name}Response`] ?? null,
      documentation: doc ? doc[1].trim().replace(/\s+/g, ' ') : null,
    };
  }
  return operations;
}

function parseVersion(text) {
  // <wsdl:documentation>...Version [13.0.00/13]</wsdl:documentation>
  const m = /Version \[([^\]]+)\]/.exec(text);
  if (m) return m[1];
  const fromUrl = /\/(v\d+(?:_\d+)?)\//.exec(ENDPOINT);
  return fromUrl ? fromUrl[1] : null;
}

/* -- main ----------------------------------------------------------------- */

const args = process.argv.slice(2);
const fileArg = args.indexOf('--file');
const toStdout = args.includes('--stdout');

const text =
  fileArg !== -1 ? readFileSync(args[fileArg + 1], 'utf8') : await fetchWsdl();

if (text.length < MIN_PLAUSIBLE_BYTES) {
  throw new Error(
    `WSDL is only ${text.length} bytes — expected >= ${MIN_PLAUSIBLE_BYTES}. ` +
    'This is what a truncated fetch looks like; see the FETCH NOTE.'
  );
}

const { complexTypes, elementDecls } = parseSchema(text);
const operations = parseOperations(text, elementDecls, complexTypes);

// Structural self-checks. A silently empty or half-parsed artifact is worse
// than a loud failure, because the retro-validation test would then be
// comparing against nothing.
const problems = [];
if (Object.keys(complexTypes).length < 400) {
  problems.push(`only ${Object.keys(complexTypes).length} complexTypes parsed`);
}
if (Object.keys(operations).length < 150) {
  problems.push(`only ${Object.keys(operations).length} operations parsed`);
}
for (const t of ['campaignProfileInfo', 'userSkill', 'inboundCampaign',
                 'outboundCampaign', 'listDeleteSettings', 'vccConfiguration']) {
  if (!complexTypes[t]) problems.push(`missing expected complexType ${t}`);
}
// Five9 misspells this element in their own schema. If it ever parses as
// "dispositionName" the document changed under us and the builders must move
// with it — see CAMPAIGN_CALL_WRAPUP_FIELD_ORDER in admin-writes.js.
const wrapup = complexTypes.campaignCallWrapup?.fields.map((f) => f.name) ?? [];
if (!wrapup.includes('dispostionName')) {
  problems.push('campaignCallWrapup no longer carries the dispostionName misspelling');
}
if (problems.length) {
  throw new Error(`WSDL parse looks wrong:\n  - ${problems.join('\n  - ')}`);
}

const artifact = {
  generatedAt: new Date().toISOString(),
  wsdlEndpoint: WSDL_URL,
  wsdlVersion: parseVersion(text),
  wsdlSha256: createHash('sha256').update(text).digest('hex'),
  wsdlBytes: Buffer.byteLength(text),
  operationCount: Object.keys(operations).length,
  complexTypeCount: Object.keys(complexTypes).length,
  operations,
  complexTypes,
};

const json = JSON.stringify(artifact, null, 2) + '\n';
if (toStdout) {
  process.stdout.write(json);
} else {
  writeFileSync(OUT_PATH, json);
  process.stderr.write(
    `wrote ${OUT_PATH}\n` +
    `  ${artifact.complexTypeCount} complexTypes, ${artifact.operationCount} operations\n` +
    `  wsdl ${artifact.wsdlBytes} bytes, sha256 ${artifact.wsdlSha256}\n`
  );
}
