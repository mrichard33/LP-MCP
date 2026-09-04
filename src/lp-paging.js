// LP result-set paging — WO-13.
//
// WHAT WAS WRONG
// --------------
// LP's `StartIndex` is a 1-BASED PAGE INDEX, not a row offset. Every caller in
// this repo advanced it by the number of rows returned (`startIndex += items.length`),
// which is row-offset semantics. So:
//
//   StartIndex=1,  PageSize=50 -> page 1   -> rows 1..50       works
//   StartIndex=51, PageSize=50 -> page 51  -> rows 2501..2550  EMPTY
//   StartIndex=51, PageSize=1  -> page 51  -> row 51           works
//
// Page 1 is identical under both readings, which is why this survived so long:
// the very first page always works and the SECOND page always comes back empty.
//
// The existing workaround ("deep-offset mode") saw the empty second page,
// probed with PageSize=1, got a row, and concluded LP refuses multi-row pages
// at depth — so it dropped to PageSize=1 for the rest of the sweep. That works
// for exactly one reason: PageSize=1 is the only size where page number and row
// number are the same value. It is not a depth limit. It is a unit mismatch,
// and the "fix" was paying one HTTP round trip per row to paper over it.
//
// THE EVIDENCE
// ------------
// Measured 2026-09-04 from lp_sync_log, deriving the trigger offset as
// (rows_scanned - sweep_api_calls + 4) against the known cost model
// calls = 3 + (rows - trigger) + 1:
//
//   23 of 23 deep-offset triggers fired at StartIndex EXACTLY 51.
//   Across two independent sweeps (getLeadData and getJobStatusChanges),
//   at row counts of 71, 73, 74, 84, 90, 163 and 175.
//
// A depth limit cannot produce that. On the 175-row run, rows 51..100 all
// existed and a row-offset API would have served them; LP returned empty. And
// the trigger never once landed on 101 or 151 — only ever on "the page after
// the first", which is the signature of a page-index API being fed row offsets.
//
// The cost model itself is confirmed exactly: predicted vs observed api_calls
// was 43/43, 37/37, 27/27 and 128/128.
//
// WHY THIS IS SAFE TO SHIP ON AN INFERENCE
// ----------------------------------------
// It is not shipped on the inference. The walker PROVES the addressing mode at
// runtime before it trusts it, once per sweep:
//
//   1. The second page comes back empty (the symptom).
//   2. Probe PageSize=1 at the row offset. If empty, that is genuinely the end.
//   3. Fetch the same logical rows using PAGE addressing.
//   4. Compare identities: the first row of the page-addressed fetch MUST be
//      the same record as the probe row. Only then is page mode adopted.
//   5. If they differ, or the page fetch is empty, fall back to the previous
//      PageSize=1 behaviour, unchanged.
//
// Step 4 is the guarantee. Page mode is adopted only when both addressing modes
// agree on which record lives at that offset, so it cannot silently skip rows.
// If the inference is wrong the walker lands on exactly today's behaviour and
// costs one extra call per sweep.

export const PAGING_MODE = Object.freeze({
  NORMAL: 'normal', // full-size pages, first page only or page mode confirmed
  PAGE:   'page',   // page-index addressing confirmed at runtime
  DEEP:   'deep',   // fell back to one row per call (the pre-WO-13 behaviour)
});

/**
 * Walk an LP result set, one page per next() call.
 *
 * @param {object}   opts
 * @param {function} opts.fetch     async ({ PageSize, StartIndex }) => rows[]
 *                                  Must already have the window bound in.
 * @param {number}   opts.pageSize  full page size (LP's SYNC_PAGE_SIZE)
 * @param {function} opts.idOf      row => stable identity, for the page-mode proof
 * @param {string}   opts.label     log prefix, e.g. '[Sync:Leads]'
 * @param {function} [opts.onFetch] awaited before every LP call — lets a caller
 *                                  yield to other work between round trips
 */
export function createPageWalker({ fetch, pageSize, idOf, label, onFetch }) {
  let mode = PAGING_MODE.NORMAL;
  let pageNumber = 1;   // what we send as StartIndex once page mode is proven
  let rowOffset = 1;    // what we send as StartIndex in row/deep addressing
  let rowsFetched = 0;
  let apiCalls = 0;
  let pages = 0;
  let deepFrom = null;
  let pageModeFrom = null;
  let done = false;

  async function call(PageSize, StartIndex) {
    if (onFetch) await onFetch();
    apiCalls++;
    return (await fetch({ PageSize, StartIndex })) || [];
  }

  function advance(count) {
    rowsFetched += count;
    if (mode === PAGING_MODE.PAGE) pageNumber++;
    else rowOffset += count;
  }

  return {
    /**
     * @returns {Promise<{items: any[], done: boolean}>}
     * Throws on a hard LP error after one reduced-size retry — callers keep
     * their existing truncation semantics.
     */
    async next() {
      if (done) return { items: [], done: true };
      pages++;

      const size  = mode === PAGING_MODE.DEEP ? 1 : pageSize;
      const index = mode === PAGING_MODE.PAGE ? pageNumber : rowOffset;

      let items;
      try {
        items = await call(size, index);
      } catch (err) {
        // A genuine LP error (500, timeout). Retry once at a quarter size —
        // a lighter response often succeeds where the full page did not.
        console.error(`${label} page StartIndex=${index} failed: ${err.message} — retrying smaller`);
        items = await call(Math.max(1, Math.floor(size / 4)), index);
      }

      if (items.length > 0) {
        advance(items.length);
        return { items, done: false };
      }

      // An empty page is NOT proof of completion. In deep mode this fetch WAS
      // the one-row probe, so empty is authoritative.
      if (mode === PAGING_MODE.DEEP) {
        done = true;
        return { items: [], done: true };
      }

      // Probe the next ROW. If there is no row there, the window really is done.
      const probe = await call(1, rowsFetched + 1);
      if (probe.length === 0) {
        done = true;
        return { items: [], done: true };
      }

      // A row exists where the full page said nothing. Test page addressing
      // before falling back to one-call-per-row.
      if (mode === PAGING_MODE.NORMAL) {
        const candidatePage = Math.floor(rowsFetched / pageSize) + 1;
        let candidate = [];
        try {
          candidate = await call(pageSize, candidatePage);
        } catch (err) {
          console.warn(`${label} page-mode probe at StartIndex=${candidatePage} failed (${err.message}) — falling back to one row per call`);
        }

        const agrees =
          candidate.length > 0 &&
          idOf(candidate[0]) != null &&
          idOf(candidate[0]) === idOf(probe[0]);

        if (agrees) {
          mode = PAGING_MODE.PAGE;
          pageModeFrom = candidatePage;
          pageNumber = candidatePage;
          console.log(
            `${label} LP StartIndex is a PAGE index, confirmed at page ${candidatePage}: ` +
            `row ${rowsFetched + 1} is the same record under both addressings ` +
            `(id=${idOf(probe[0])}). Continuing at PageSize=${pageSize}, one call per page.`
          );
          advance(candidate.length);
          return { items: candidate, done: false };
        }

        if (candidate.length > 0) {
          console.warn(
            `${label} page-mode probe returned rows but the FIRST ROW DISAGREES with the row probe ` +
            `(page=${idOf(candidate[0])} vs row=${idOf(probe[0])}) — refusing page mode, ` +
            `falling back to one row per call. Paging rows would be skipped otherwise.`
          );
        }
      }

      // Fall back to the pre-WO-13 behaviour: one row per call, sticky.
      mode = PAGING_MODE.DEEP;
      deepFrom = rowsFetched + 1;
      rowOffset = rowsFetched + 1;
      console.warn(`${label} deep-offset fallback engaged at row ${deepFrom} — PageSize=1 for the remainder of this sweep`);
      advance(probe.length);
      return { items: probe, done: false };
    },

    get stats() {
      return {
        mode,
        pagingMode: mode === PAGING_MODE.DEEP ? PAGING_MODE.DEEP : PAGING_MODE.NORMAL,
        apiCalls,
        pages,
        rowsFetched,
        deepFrom,
        pageModeFrom,
      };
    },
  };
}
