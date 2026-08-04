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
