# LP report golden fixtures (redacted pdftotext output)

The golden tests in `scripts/test-lp-report-parse-a.js` /
`test-lp-report-parse-b.js` assert the July 2026 report footers to the cent
(288 rows / $7,502,745.76 net; 428 rows / $10,456,216 gross with the
Hold-HOA 65/$1,379,228, Credit Decline 30/$680,720 and Cancelled-group
66/$1,675,576 splits). They run **only when these files exist** and skip
cleanly otherwise — CI stays green without them.

Raw PDFs are **never committed** (customer names, phones, emails = PII).
What lives here is the `pdftotext -layout` TEXT with contact fields masked.

## Producing a fixture

1. Take the real scheduled-email PDF (Report A "Jobs by Milestone Date"
   RTP/Actual, or Report B "Jobs By Status").
2. Extract the text layer exactly the way the ingest route does:

   ```sh
   pdftotext -layout report.pdf report.txt
   ```

3. Redact PII **preserving length** so `-layout` column offsets survive —
   replace each digit of phones with `5`, each local-part character of
   emails with `x`, and customer surnames with same-length `X…` runs.
   Do NOT touch job/prosp numbers, dates, branches, statuses, or money —
   those are what the goldens assert.

   ```sh
   perl -pe 's/\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/555-555-5555/g;
             s/[A-Za-z0-9._%+-]+(?=@)/"x" x length($&)/ge' report.txt > fixture.txt
   ```

   (Spot-check a few lines after — the substitutions above are same-length
   for emails but normalize phones; if a phone column shifts, re-mask
   digit-for-digit instead.)

4. Save as:
   - `report-a-jobs-by-milestone.txt`
   - `report-b-jobs-by-status.txt`

5. `npm test` — the golden tests un-skip and must pass.

If a future month's report is used instead of July 2026, update the golden
constants in both test files to that month's printed footer values.

---

## Report 135 — Lead Disposition Detail (`-bbox-layout`, not `-layout`)

135 is parsed by COORDINATE CLUSTERING, so its fixture is `pdftotext
-bbox-layout` XML rather than `-layout` text. `-layout` is unusable here:
continuation fragments from different columns interleave on the same physical
line, so `Answering` / `Machine` (one Last Result) is split by an email and an
address printed between its two words.

Committed: `report-135-lead-disposition-p1-6.bbox.xml.gz` — pages 1–6 of the
real 2026-08-06 file, redacted, gzipped (31 KB). Those six pages carry the
complete unlabeled band and its bare `Totals: 70`, blank last names, a malformed
wrapping phone, mid-token email wraps, a duplicate Prosp #, and `Can't Do
Project`. They deliberately STOP before `Grand Totals:`, so the same fixture
doubles as the truncated-file fail-closed test.

The full-file goldens (1,194 rows; band totals 70/49/51/201/136/31/33/240/138/245)
skip unless you drop the whole redacted file in as
`report-135-lead-disposition-full.bbox.xml`. It is not committed — 651 KB
gzipped, far past this directory's norm.

### Producing them

```sh
pdftotext -bbox-layout _135_*.pdf 135.xml
node scripts/redact-bbox.mjs 135.xml report-135-lead-disposition-full.bbox.xml
node scripts/redact-bbox.mjs 135.xml p1-6.xml 6 && gzip -9 p1-6.xml
```

Redaction is STRUCTURE-PRESERVING and that is not optional: it masks glyphs
only, never coordinates, token counts or line-wrap points. It must leave
numbers, `Totals:` lines, band labels, the column header and page furniture
untouched — those are what the goldens assert, and an earlier pass that masked
them turned `BOCA` into `Bxxx` and `49` into `55`. Verify by parsing the
redacted file: it must produce the identical 1,194 rows, ten bands and zero
warnings as the original.

---

## CSV fixtures (the go-forward format)

LP now schedules CSV exports, so CSV is the format all six reports arrive in and
the PDF fixtures above are legacy. `scripts/test-lp-csv-cutover.js` and
`scripts/test-lp-report-parse-appt-stats.js` run against these.

| File | Report | Provenance |
|---|---|---|
| `report-138-appt-stats-jan.csv` | 138 Appointment Stats by Sales Rep with Source | **REAL** — January 2026, 345 rows, 79 reps, 17 sources |
| `report-137-sales-efficiency-jan.csv` | 137 Sales Efficiency | **REAL** — January 2026, 9 branch rows |
| `report-137-sales-efficiency-ytd.csv` | 137 Sales Efficiency | **REAL** — the 2026-08-05 YTD export, 10 branch rows, cents-exact |
| `report-137-sales-efficiency-feb.csv` | 137 Sales Efficiency | **REAL** — February 2026, 9 branch rows |
| `report-136-source-cost-jan.csv` | 136 Marketing Sub-Source Cost 2 | **REAL** — January 2026, 66 sub-sources |
| `report-136-source-cost-feb.csv` | 136 Marketing Sub-Source Cost 2 | **REAL** — February 2026, 68 sub-sources |
| `report-135-lead-disposition-jan-slice.csv` | 135 Lead Disposition Detail 2 | **REAL, SLICED** — 338 of January's 10,032 rows |
| `report-135-lead-disposition-feb-slice.csv` | 135 Lead Disposition Detail 2 | **REAL, SLICED** — 400 of February's 12,444 rows |
| `report-134-jobs-by-milestone-mar.csv` | 134 Jobs by Milestone Date | **REAL** — March 2026, 365 rows |
| `report-133-job-status-mar.csv` | 133 Jobs By Status | **REAL** — March 2026, 525 rows, 729 physical lines |
| `report-134-jobs-by-milestone.csv` | 134 Jobs by Milestone Date | synthetic (superseded by the March file above; kept for its money-notation cases) |
| `report-135-lead-disposition.csv` | 135 Lead Disposition Detail | synthetic (superseded by the slice above) |
| `report-136-source-cost.csv` | 136 Marketing Sub-Source Cost 2 | synthetic (superseded by the January file above) |

### What the real fixtures pin

- **138** — the January sit rates by source, asserted exactly: Internet 736/914,
  Canvass 607/853, PrevCust 38/40, CustRef 20/21, Magazine 35/43,
  Affiliates 38/48. Also the twelve `(SalesRep Unknown)` rows (59 issued, 3 sat,
  1,822 sets), the mixed `int`/`0.0000` money forms in `GSA`/`NSA`, the constant
  `Dsp1..Dsp10` label ordering, the repeated static `Footer` legend, and the two
  control identities `Σ NumDsp1..10 == NumIssued` and
  `NumIssued + NumOther == NumSet`, both of which hold on all 345 rows.
- **137 January** — the period the PDF parser rejected as
  `unexpected_band_count_11`. It also carries RFED and no JAX, which is the case
  a hard nine-market gate would have failed.
- **136 January** — the blank-`descr` unattributed bucket and duplicate
  sub-source names on distinct rows.
- **135 slice** — all 22 `Category` values, all 16 `src_id` values, and 64
  blank-`brn_id` rows (the `UNASSIGNED` bucket that must never be dropped).
- **133 March** — the real export, and the reason the parser was rewritten on
  2026-08-07. It pins: 525 records against 729 physical lines (newlines inside
  quoted `MostRecentNoteHOA` — **133 is the only report that does this**, not
  135); the 14 shipped statuses and their buckets, footing `completed` 331 +
  `lost` 167 + `in_production` 25 + `hoa` 1 + `permit` 1 = 525; `ContractDate`'s
  **two-digit year** (`03/01/26`), which `parseCsvDate` rejects and `parseDateMDY`
  does not; `TotalDue`'s four-decimal form on 478 rows and its 18 **negative**
  values; a duplicate `id` (414605 on two jobs) proving `lp_id` is not a row key;
  and `contractid` = `'NEW'` on 8 rows.

### Why 135 is a slice

The full January export is 4.3 MB and carries name, phone, email and street
address for 10,032 people. Committing it whole is far past this directory's norm
and is not worth the exposure, so the slice keeps every structural property the
parser must handle and drops the bulk. Company-total goldens that need the whole
file — Σ136 `NumRaw` = 10,032 = 135's full record count — skip unless the full
redacted file is dropped in as `report-135-lead-disposition-jan-full.csv`, the
same arrangement the bbox fixture above uses.

### Producing or replacing one

Raw exports are **never** committed. Redact with the script — it encodes the
rules below per report and identifies the report by HEADER FINGERPRINT, never by
filename, so a renamed export cannot be redacted against the wrong column list:

```sh
node scripts/redact-lp-csv.mjs ~/Downloads/_260807120011_Export.csv \
     scripts/fixtures/lp-reports/report-133-job-status-mar.csv
node scripts/redact-lp-csv.mjs ~/Downloads/_135_Export.csv \
     scripts/fixtures/lp-reports/report-135-lead-disposition-feb-slice.csv --slice 400
```

The rules it applies:

1. Customer names, phones, emails, street addresses and city become synthetic
   (`Surname0000, Given0000`, `(555)555-0000`, `person0000@example.com`,
   `City0000`). Free text — 133's `MostRecentNoteHOA` — has its **letters**
   masked with the digits, punctuation and **embedded newlines left intact**.
2. **Row count, column count and order, embedded newlines, and every numeric
   value survive exactly** — those are what the goldens assert.
3. Employee names stay: `Salesrep` (138), `SalesRepName` / `Manager` (134) are
   not customer PII and rep-level goldens depend on them. Only the report
   RUNNER is replaced — `FullName` / `fullname` → `Dana Whitfield`, `EmpName`
   (136) → `dwhitfield`.
4. `npm test` — the suite must stay green. If a total moves, the redaction
   touched a number and must be redone.

Same doctrine as the PDF fixtures above: mask glyphs, never structure. The
structural test in `scripts/test-lp-csv-cutover.js` re-parses every committed
fixture with its own report's parser and requires `validate()` to pass, so a
redaction that damaged a file fails the suite rather than sitting unnoticed.

### Still outstanding

The **133 January export (484 rows)** has not been supplied. When it arrives,
redact it to `report-133-job-status-jan.csv` and add it to the fixture table in
`test-lp-csv-cutover.js` — the structural test picks it up with no other change.
