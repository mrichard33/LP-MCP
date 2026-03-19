// ─── Date Window Generator — src/date-windows.js ─────────────────
//
// v5.2 fix: LP API GetLead has an internal result cap (~500-1000 records
// per date range query). Yearly windows silently truncate results —
// the pagination appears to complete but records beyond the cap are lost.
//
// Solution: Generate weekly date windows to stay under the cap.
// At ~370 new prospects/day for Reece, weekly windows yield ~2,600
// records max — safely under any LP API limit.
//
// Usage:
//   import { generateDateWindows } from './date-windows.js';
//   const windows = generateDateWindows(); // [{start, end, label}, ...]

/**
 * Generate date windows from most recent to oldest.
 * @param {Object} opts
 * @param {number} opts.windowDays - Days per window (default 7)
 * @param {string} opts.startDate  - Earliest date to sync from (default '2000-01-01')
 * @param {Date}   opts.endDate    - Latest date (default tomorrow)
 * @returns {Array<{start: string, end: string, label: string}>}
 */
export function generateDateWindows(opts = {}) {
  const windowDays = opts.windowDays || 7;
  const startDate = new Date(opts.startDate || '2000-01-01');
  const endDate = opts.endDate || (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1); // Tomorrow — LP enddate is exclusive
    return d;
  })();

  const windows = [];
  let curEnd = new Date(endDate);

  while (curEnd > startDate) {
    let curStart = new Date(curEnd);
    curStart.setDate(curStart.getDate() - windowDays);
    if (curStart < startDate) curStart = new Date(startDate);

    const startStr = curStart.toISOString().slice(0, 10);
    const endStr = curEnd.toISOString().slice(0, 10);

    windows.push({
      start: startStr,
      end:   endStr,
      label: `w_${startStr}`,
    });

    curEnd = curStart;
  }

  return windows;
}
