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
