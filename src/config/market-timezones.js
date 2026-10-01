/**
 * Market time zones — src/config/market-timezones.js
 *
 * 2026-10-01 (Mark's ruling 3, fix/live-chat-service-area-and-markets):
 * Houston contacts see Central time; every other market stays Eastern.
 *
 * A code map, not a service_markets column, on purpose: the PR that added
 * Houston could not ship DDL, and one entry does not justify one. If a third
 * zone ever appears, move this to a column and keep these helpers as the API.
 *
 * Scope: CUSTOMER-FACING times for a contact — slot offers, appointment times,
 * the prompt's "now" line, and that contact's quiet hours. Office and dialer
 * hours (staffed-hours.js, dial-window.js) stay Eastern with an explicit "ET"
 * label, because they describe Reece's floor, not the contact. Logs, storage
 * and reporting stay as they are.
 *
 * Pure and dependency-free. The zip → market lookup lives in
 * src/services/contact-timezone.js.
 */

export const DEFAULT_TIMEZONE = 'America/New_York';

export const MARKET_TIMEZONES = Object.freeze({
  HOU: 'America/Chicago',
});

const LABELS = Object.freeze({
  'America/New_York': { short: 'ET', long: 'Eastern' },
  'America/Chicago': { short: 'CT', long: 'Central' },
});

/** IANA zone for a service_markets.market_code. Unknown or empty → Eastern. */
export function marketTimezone(marketCode) {
  const code = String(marketCode || '').trim().toUpperCase();
  return MARKET_TIMEZONES[code] || DEFAULT_TIMEZONE;
}

/** "CT" / "ET" — the label printed next to a customer-facing time. */
export function tzLabel(timeZone) {
  return (LABELS[timeZone] || LABELS[DEFAULT_TIMEZONE]).short;
}

/** "Central" / "Eastern" — for prose such as "(Central)". */
export function tzLongName(timeZone) {
  return (LABELS[timeZone] || LABELS[DEFAULT_TIMEZONE]).long;
}

/** A known zone or the default — never an arbitrary string from a payload. */
export function normalizeTimezone(timeZone) {
  return LABELS[timeZone] ? timeZone : DEFAULT_TIMEZONE;
}
