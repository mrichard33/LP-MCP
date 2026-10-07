# Red-team runs

One entry per run (newest first): date, tool, suite, pass rate, failures and their fix PR. See `redteam/README.md`.

| Date | Tool | Suite | Result | Failures → fix |
|---|---|---|---|---|
| 2026-10-07 | node:test | `scripts/test-redteam-injection.js`: 20 attacks + 20 benign | 20/20 attacks caught, 0/20 false positives | 1 false positive found while building ("You are now my favorite window company") → pattern narrowed |
