// ─── Capacity diagnostic tools — src/tools/capacity-tools.js ─────────────────
//
// Read-only. Backs the band-level capacity reconcile in
// src/jobs/capacity-bands.js. No confirm gate — nothing here writes.
//
// New domain file rather than a fold-in: there was no capacity domain in
// src/tools/ before this, job-tools.js is post-sale job tracking, and
// lp-appointment-tools.js is the confirm-gated WRITE domain — putting a
// read-only diagnostic there would blur the gate boundary that file exists to
// enforce.

import { z } from 'zod';
import { reconcileBands } from '../jobs/capacity-bands.js';

export function registerCapacityTools(server) {

  // get_capacity_vs_ghl [READ — no confirm gate]
  server.tool(
    'get_capacity_vs_ghl',
    'Read-only: reconciles GHL calendar bookings against LP per-band rep availability. ' +
    'LP publishes three bands per rep per day — slot_id 1=Morning, 2=Afternoon, 3=Evening. ' +
    "GHL's 18:00, 18:30 and 19:00 booking times ALL draw from the same LP band 3 (Evening) " +
    'slot per rep, which the /board/capacity aggregate cannot show because it sums slot_id away. ' +
    'READ THIS BEFORE ACTING ON THE OUTPUT: status UNKNOWN means one or more markets have ' +
    'NOT FILED their availability for that date yet. It does NOT mean zero capacity and it ' +
    'does NOT mean the day is full. Reps file weekly and on different schedules, so future ' +
    'dates are routinely unfiled — on 2026-07-25 two of seven markets had filed only through ' +
    'that same day. NEVER treat an UNKNOWN row as "no availability", never use it to gate, ' +
    'close a slot, or decline a booking; read markets_unknown (a list of market names) to see ' +
    'which market has not filed. ' +
    'Status precedence, first match wins: UNKNOWN > OVERSOLD (ghl_booked > lp_capacity) > ' +
    'TIGHT (ghl_booked >= 80% of lp_capacity) > OK. ' +
    'fill_pct is null when lp_capacity is 0 and is UNCAPPED above 1.0 so overbooking stays ' +
    'visible. lp_booked counts appointments LP knows about through any channel, so ' +
    'lp_minus_ghl is a reconciliation signal, not an error. ' +
    'Defaults: today ET through +14 days, calendar aJj14ONxh1oFyDcQ706O (Window Estimate).',
    {
      start_date: z.string().optional()
        .describe('YYYY-MM-DD (ET). Default: today ET.'),
      end_date: z.string().optional()
        .describe('YYYY-MM-DD (ET). Default: start_date + 14 days. Maximum window 60 days.'),
      calendar_id: z.string().optional()
        .describe('GHL calendar id. Default aJj14ONxh1oFyDcQ706O (Window Estimate).'),
      market: z.string().optional()
        .describe(
          'Optional market code, e.g. SAR_MKT. This is a LENS, not a filter: it ADDS an ' +
          'LP-side market_capacity slice to each row but does NOT filter the GHL side, ' +
          'because GHL appointments carry no market dimension. lp_capacity, ghl_booked ' +
          'and status stay location-wide.'
        ),
    },
    async (args = {}) => {
      try {
        const out = await reconcileBands({
          startDate: args.start_date,
          endDate: args.end_date,
          calendarId: args.calendar_id,
          market: args.market,
        });
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );
}
