/**
 * Storm season awareness — src/agentic/storm-season.js
 *
 * Tells the responder WHERE IN THE YEAR IT IS, in the only terms this business
 * cares about: is the customer before, inside, or after Atlantic hurricane
 * season.
 *
 * WHY THIS EXISTS (2026-09-23, owner review)
 * ──────────────────────────────────────────────────────────────────────────
 * The prompt already carried today's date, and the copy still said things like
 * "so you have it on hand BEFORE storm season" — on 2026-09-23, which is not
 * only inside the season but within days of its climatological peak. A date is
 * not awareness: the model has to be told what that date MEANS here, or it
 * reaches for whichever seasonal frame it saw most in training, and "get ready
 * before the storms" is the one marketing writes most.
 *
 * Saying "before storm season" to a Florida homeowner in September is worse
 * than generic — it tells them the sender is not paying attention, in the exact
 * month they are paying the most attention.
 *
 * Season dates are the official NOAA Atlantic hurricane season, June 1 through
 * November 30. The peak window is the climatological one (mid-August to
 * mid-October, sharpest around September 10); it is deliberately a little wider
 * than the statistical spike, because the copy difference between "peak" and
 * "in season" is one of urgency FRAMING, not of fact.
 *
 * PURE. No I/O, no env reads, and the clock arrives as an argument so
 * scripts/test-storm-season.js can drive any date deterministically.
 */

/** NOAA Atlantic hurricane season, inclusive. */
const SEASON_START = { month: 6, day: 1 };   // June 1
const SEASON_END   = { month: 11, day: 30 }; // November 30
/** Climatological peak window (sharpest ~Sept 10). */
const PEAK_START = { month: 8, day: 15 };    // August 15
const PEAK_END   = { month: 10, day: 15 };   // October 15

const asOrdinal = (month, day) => month * 100 + day;

/**
 * Which phase of the storm year a date falls in.
 *
 * @param {{month:number, day:number}} md 1-indexed month, 1-indexed day
 * @returns {'pre_season'|'early_season'|'peak_season'|'late_season'|'post_season'}
 */
export function seasonPhase({ month, day }) {
  const n = asOrdinal(month, day);
  if (n < asOrdinal(SEASON_START.month, SEASON_START.day)) return 'pre_season';
  if (n > asOrdinal(SEASON_END.month, SEASON_END.day)) return 'post_season';
  if (n < asOrdinal(PEAK_START.month, PEAK_START.day)) return 'early_season';
  if (n <= asOrdinal(PEAK_END.month, PEAK_END.day)) return 'peak_season';
  return 'late_season';
}

/**
 * Parse the month/day out of a YYYY-MM-DD string. Returns null on anything
 * else — a caller that cannot resolve the date must render NO seasonal block
 * rather than guess, because a wrong season is worse than no season.
 */
export function monthDayFromISO(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDate || ''));
  if (!m) return null;
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  return { month, day };
}

/**
 * The guidance for each phase. Deliberately states what is TRUE right now and
 * what is therefore BANNED right now — a positive instruction alone does not
 * stop the model reaching for the familiar "before the storms" line.
 */
const PHASE_COPY = Object.freeze({
  pre_season: {
    label: 'BEFORE hurricane season (season opens June 1)',
    truth: 'Season has not started. Getting ahead of it is genuine, and "before storm season" is accurate.',
    banned: 'Do not imply a storm is imminent or that the season is already underway.',
  },
  early_season: {
    label: 'INSIDE hurricane season — early (season runs June 1 to November 30)',
    truth: 'The season is already open. Talk about being ready for THIS season, the one they are in.',
    banned: 'NEVER say "before storm season", "ahead of storm season", "before hurricane season" or "before the season starts". The season has started. Saying otherwise tells them you are not paying attention.',
  },
  peak_season: {
    label: 'PEAK of hurricane season (climatological peak; season runs June 1 to November 30)',
    truth: 'This is the most active stretch of the year and they know it. Present tense only — protection matters now, not later.',
    banned: 'NEVER say "before storm season", "ahead of storm season", "before hurricane season", "get ready before the storms", or anything implying the season is still ahead of them. It is happening now.',
  },
  late_season: {
    label: 'INSIDE hurricane season — late (season closes November 30)',
    truth: 'Still officially in season, but winding down. Both "the rest of this season" and "ahead of next season" are honest framings.',
    banned: 'Do not say the season has ended — it has not. Do not say "before storm season" as though it were still ahead.',
  },
  post_season: {
    label: 'AFTER hurricane season (season closed November 30; next opens June 1)',
    truth: 'The season is over. This is the calm window — the honest frame is getting it done before the next one, with no time pressure invented.',
    banned: 'Do not imply a storm threat right now. Do not manufacture urgency; real urgency here is install scheduling capacity, not weather.',
  },
});

/**
 * Renders the seasonal awareness block, or null when the date could not be
 * resolved. Null means the prompt simply omits the block — see monthDayFromISO.
 *
 * @param {string} isoDate YYYY-MM-DD in the business timezone
 * @returns {string[]|null}
 */
export function stormSeasonBlock(isoDate) {
  const md = monthDayFromISO(isoDate);
  if (!md) return null;
  const phase = seasonPhase(md);
  const c = PHASE_COPY[phase];
  return [
    `\nWHERE WE ARE IN THE STORM YEAR: ${c.label}.`,
    `  ${c.truth}`,
    `  ${c.banned}`,
    `  Reece's real urgency is storm season and install scheduling capacity — never a fake countdown or invented deadline.`,
  ];
}

export const STORM_SEASON_VERSION = '1.0';
