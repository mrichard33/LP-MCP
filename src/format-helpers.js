/**
 * Format Helpers — src/format-helpers.js
 *
 * Shared formatting utilities for GroupMe display.
 * Used by action-executor.js and groupme.js to render
 * human-readable phone numbers and dates.
 */

/**
 * Format a phone number for display.
 * +12399809343 → (239) 980-9343
 * 2399809343   → (239) 980-9343
 * 7274668193   → (727) 466-8193
 * Returns original string if format not recognized.
 */
export function formatPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  // 11 digits starting with 1 (US with country code)
  if (digits.length === 11 && digits[0] === '1') {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  // 10 digits (US without country code)
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  // Return original if not a standard US number
  return String(phone);
}

/**
 * Format a date/time string for human display.
 * Handles multiple input formats:
 *   ISO:        2026-04-09T10:00:00+00:00 → 04/09/2026 at 10:00 AM
 *   ISO date:   2026-04-09T10:00:00       → 04/09/2026 at 10:00 AM
 *   Long date:  April 8, 2026             → 04/08/2026
 *   MM/DD/YYYY: 04/08/2026                → 04/08/2026 (passthrough)
 *   With time:  04/08/2026 06:00 PM       → 04/08/2026 at 6:00 PM
 *   LP format:  03/31/2026 06:00 PM       → 03/31/2026 at 6:00 PM
 *
 * If a separate time string is provided, it's appended.
 * Returns original string if format not recognized.
 */
export function formatDateTime(dateStr, timeStr = null) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();

  let datePart = null;
  let timePart = timeStr ? String(timeStr).trim() : null;

  // ISO format: 2026-04-09T10:00:00+00:00 or 2026-04-09T10:00:00Z
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (isoMatch) {
    datePart = `${isoMatch[2]}/${isoMatch[3]}/${isoMatch[1]}`;
    if (!timePart) {
      const h = parseInt(isoMatch[4], 10);
      const m = isoMatch[5];
      const ampm = h >= 12 ? 'PM' : 'AM';
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      timePart = `${h12}:${m} ${ampm}`;
    }
    return timePart ? `${datePart} at ${timePart}` : datePart;
  }

  // Long date: "April 8, 2026" or "April 14, 2026"
  const MONTHS = {
    january: '01', february: '02', march: '03', april: '04',
    may: '05', june: '06', july: '07', august: '08',
    september: '09', october: '10', november: '11', december: '12',
  };
  const longMatch = s.match(/^(\w+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (longMatch) {
    const mon = MONTHS[longMatch[1].toLowerCase()];
    if (mon) {
      datePart = `${mon}/${String(longMatch[2]).padStart(2, '0')}/${longMatch[3]}`;
      return timePart ? `${datePart} at ${timePart}` : datePart;
    }
  }

  // MM/DD/YYYY with optional time: "03/31/2026 06:00 PM"
  const usMatch = s.match(/^(\d{2}\/\d{2}\/\d{4})\s*(.*)$/);
  if (usMatch) {
    datePart = usMatch[1];
    if (!timePart && usMatch[2]) timePart = usMatch[2].trim();
    return timePart ? `${datePart} at ${timePart}` : datePart;
  }

  // Fallback: return with time if provided
  return timePart ? `${s} at ${timePart}` : s;
}
