import { z } from 'zod';
import {
  computeRescissionDeadline,
  detectSigningDate,
  isBusinessDay,
  federalHolidaysObserved,
} from '../rescission-window.js';

/**
 * MCP tool wrapper around src/rescission-window.js.
 * Exposes the rescission-deadline computation and inbound-text signing-date
 * detection so the agentic layer (and Claude / n8n / external callers) can
 * compute deadlines on demand.
 *
 * Phase 2.2 of Competitor Rescission Rescue plan.
 */
export function registerRescissionTools(server) {

  // Tool: compute_rescission_deadline
  server.tool(
    'compute_rescission_deadline',
    'Compute the Florida 3-business-day rescission deadline for a given signing date. Returns deadline date, day-of-week classification, message variant key, business-days-remaining, past-window flag, and holiday-in-window flag. Federal holidays only. Use to drive day-aware rescue messaging when a contact reports signing with a competitor.',
    {
      signed_date: z.string().describe('Date the contract was signed. Accepts YYYY-MM-DD or any ISO datetime string. Required.'),
      timezone: z.string().optional().describe('IANA timezone for "today" calculation. Defaults to America/New_York (Florida).'),
      now: z.string().optional().describe('Override the current time for testing. ISO datetime string.'),
    },
    async ({ signed_date, timezone, now }) => {
      try {
        const opts = {};
        if (timezone) opts.timezone = timezone;
        if (now) opts.now = now;
        const result = computeRescissionDeadline(signed_date, opts);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: err.message }, null, 2),
          }],
        };
      }
    }
  );

  // Tool: detect_signing_date
  server.tool(
    'detect_signing_date',
    'Parse inbound message text for a signing-recency cue (e.g. "yesterday", "today", "3 days ago", "last week"). Returns YYYY-MM-DD if a cue is detected, or null when ambiguous (caller should default to today per rescission-rescue policy). Conservative — returns null on ambiguous phrasing rather than guessing.',
    {
      text: z.string().describe('Inbound message text to scan for signing-date cues.'),
      timezone: z.string().optional().describe('IANA timezone for "today" baseline. Defaults to America/New_York.'),
      now: z.string().optional().describe('Override the current time for testing. ISO datetime string.'),
    },
    async ({ text, timezone, now }) => {
      const opts = {};
      if (timezone) opts.timezone = timezone;
      if (now) opts.now = now;
      const result = detectSigningDate(text, opts);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            detected_signing_date: result,
            assumed_today_if_null: result === null,
          }, null, 2),
        }],
      };
    }
  );

  // Tool: list_federal_holidays
  server.tool(
    'list_federal_holidays',
    'List observed federal holidays for a given year, with weekend-shift applied (Saturday → previous Friday observed, Sunday → following Monday observed). Used by the rescission-window helper to compute business days. Federal-only scope per architecture decision.',
    {
      year: z.number().int().min(2020).max(2100).describe('Calendar year to list observed federal holidays for.'),
    },
    async ({ year }) => {
      const dates = [...federalHolidaysObserved(year)].sort();
      const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      const enriched = dates.map(ymd => {
        const [y, m, d] = ymd.split('-').map(Number);
        const dow = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
        return { date: ymd, dow: dayNames[dow], is_business_day: isBusinessDay(ymd) };
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ year, count: enriched.length, holidays: enriched }, null, 2),
        }],
      };
    }
  );
}
