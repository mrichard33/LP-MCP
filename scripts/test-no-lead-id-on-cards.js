// A Slack card names the LP PROSPECT, never the LP lead id (the user, 2026-10-16:
// "The Slack channel should not send an LP lead with a lead ID. It must always
// include the Prospect ID, never the actual lead ID.").
//
// Three layers, each tested here:
//   1. prospectLabel (src/format-helpers.js) is the one format: "Prospect 462947",
//      or "Prospect: unknown" when none is known. The lead id is never a fallback.
//   2. normalizeSlackText (src/slack-phone-format.js) is the net at every Slack
//      send point: a "lead 581695" / "LDS581695" that slipped into a card (an
//      approval card's reasoning, an error message, model output) loses its number.
//   3. A scan of src/ fails on a new template that prints a lead id. A line that
//      is not Slack text (a log, a GHL or LP note, MCP tool text, a stored reason)
//      carries `lead-id-ok: <reason>` on it or on the line above.
//
// LP inbound inquiry numbers (in1, "inbound #430305") are NOT lead ids and stay:
// an inquiry has no prospect yet and staff find the row to import by that number.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { prospectLabel } from '../src/format-helpers.js';
import { stripSlackLeadIds, normalizeSlackText, normalizeSlackBlocks } from '../src/slack-phone-format.js';
import { describeApprove } from '../src/approval-card.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('prospectLabel: the prospect, or "Prospect: unknown", never anything else', () => {
  assert.equal(prospectLabel('462947'), 'Prospect 462947');
  assert.equal(prospectLabel(462947), 'Prospect 462947');
  for (const blank of [null, undefined, '', '  ', '?', 'null', 'undefined', 'none']) {
    assert.equal(prospectLabel(blank), 'Prospect: unknown', String(blank));
  }
});

test('the send-time net drops a lead id and keeps the prospect', () => {
  assert.equal(stripSlackLeadIds('📋 LP Lead: 581695 | Prospect: 462947'), '📋 LP Lead | Prospect: 462947');
  for (const t of ['LP lead 581695 is CXL', 'lead #581695', 'lead_id: 581695', 'LP lead id 581695', 'record LDS581695']) {
    assert.doesNotMatch(stripSlackLeadIds(t), /581695/, t);
  }
});

test('the net leaves inquiry numbers, dates, counts and phones alone', () => {
  for (const t of [
    'inbound #430305 waiting 45 min',
    'inquiry 430305',
    'lead 3 days old',
    'lead 2026-10-16',
    'Prospect 462947',
    'a new lead arrived',
  ]) {
    assert.equal(stripSlackLeadIds(t), t, t);
  }
  // Phones are still normalised first, then lead ids.
  assert.equal(normalizeSlackText('Call (352) 555-0188 · LP lead 581695'), 'Call 3525550188 · LP lead');
});

test('the net covers Block Kit text but never a button value', () => {
  const blocks = normalizeSlackBlocks([
    { type: 'section', text: { type: 'mrkdwn', text: 'LP lead 581695 needs a person' } },
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Approve' }, value: 'lead 581695' }] },
  ]);
  assert.doesNotMatch(blocks[0].text.text, /581695/);
  assert.equal(blocks[1].elements[0].value, 'lead 581695');
});

test('an approval card never lists a lead id among an action\'s settings', () => {
  const text = describeApprove({
    action_type: 'some_new_action',
    action_payload: { lp_lead_id: '581695', lead_id: '581695', ldsId: '581695', issued_lead_id: '581695', list_name: 'Conf - Next Day' },
  }, { contactName: 'Dana Smith' });
  assert.doesNotMatch(text, /581695/);
  assert.match(text, /Conf - Next Day/);
});

// ─── the scan ────────────────────────────────────────────────────────────

const SHAPES = [
  /LP [Ll]ead[ :#]*\$\{/,                                             // `LP lead ${…}`, `LP Lead: ${…}`
  /\b[Ll]ead \$\{[^}]*(?:[Ll]ead_?[Ii]d|ldsId|lds_id|LeadId)\b/,      // `lead ${row.lp_lead_id}`
  /issued lead \$\{/,
  /\bLead: \$\{/,
  /\blp_lead \$\{/,
];
// A log line, or a GHL note, is not Slack. The statement may start a few lines up.
const NOT_SLACK = /console\.|logger\.|\blog\.(?:warn|info|error|debug|log)\(|\blog\(|addGHLNote\(|addNote\(/;

function* jsFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* jsFiles(p);
    else if (p.endsWith('.js')) yield p;
  }
}

function offenders() {
  const out = [];
  for (const file of jsFiles(path.join(ROOT, 'src'))) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!SHAPES.some((r) => r.test(line))) return;
      if (/lead-id-ok:/.test(line) || /lead-id-ok:/.test(lines[i - 1] || '')) return;
      for (let j = i; j >= Math.max(0, i - 6); j--) {
        if (j < i && /[;{}]\s*$/.test(lines[j])) break; // the statement began after this line
        if (NOT_SLACK.test(lines[j])) return;
      }
      out.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  return out;
}

test('no Slack text in src/ prints an LP lead id', () => {
  const found = offenders();
  assert.deepEqual(found, [],
    'Print the prospect with prospectLabel() instead. If the line is not Slack text, '
    + 'add `// lead-id-ok: <why>` on it or on the line above.\n' + found.join('\n'));
});

test('the scan catches the shapes it is meant to', () => {
  const sample = [
    '`📋 LP Lead: ${lpLeadId} | Prospect: ${p}`',
    '`LP lead ${row.ldsId} is waiting`',
    '`the cancel came from lead ${row.lp_lead_id}`',
    '`🆔 issued lead ${r.issued_lead_id}`',
  ];
  for (const s of sample) assert.ok(SHAPES.some((r) => r.test(s)), s);
  assert.ok(!SHAPES.some((r) => r.test('`LP ${prospectLabel(row.cstId)}`')));
  assert.ok(!SHAPES.some((r) => r.test('`inbound ${row.in1}`')));
});
