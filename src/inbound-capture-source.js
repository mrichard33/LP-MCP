// ─── Inbound Caller Capture — the LP source of a captured call ──────────────
// src/inbound-capture-source.js
//
// Pure, no I/O. Which LP Sub-Source (srs_id) and Promoter (pro_id) a lead made
// by inbound capture carries.
//
// WHY (2026-10-12, the user's rulings)
//   Before this, every captured caller would have reached LP as the chatbot:
//   enrollLpLeadCreation backfills a blank srs_id / pro_id with 830 / 5574, and
//   workflow 8e30ff37 sends only those two fields (contact.source reaches LP as
//   free text in `sender`). A Google PPC caller would have been credited to the
//   website chatbot. The rulings:
//     - the Sub-Source comes from the NUMBER CALLED (Five9 dnis): each paid line
//       has its own tracking number, which says how the caller found us;
//     - the Promoter is "Integration, GoHighLevel" (5686) for every lead this
//       system creates from a call: the system made the lead, and the
//       Sub-Source still carries the marketing channel for reporting;
//     - the number called wins over an older source on the GHL contact;
//     - a number not in this table is not captured: it is listed for review,
//       so a new tracking number never goes out under a wrong source;
//     - a "Main Number" call is captured only when an appointment was set
//       (notALeadReason), and goes out as Reece Call In: that line spans
//       hundreds of local numbers, so it is keyed on the line, not the number.
//   Numbers read from five9_events_raw (90 days, 2026-10-12); Sub-Source ids
//   from lp_source_catalog; 5686 from LP's GetLeadsSourceSubPromoter (type p).
//   Add a number here when a new tracking line starts; never widen the
//   chatbot backfill.

// GHL "LP Source ID" and "Pro ID" (src/ghl-field-map.js lp_source_id / pro_id):
// the only two fields workflow 8e30ff37 sends LP as attribution.
export const LP_SOURCE_ID_FIELD = 'k6j4IBh5IejPooSCsj49';
export const PRO_ID_FIELD = 'BbUJ6RrdTjjEqqRA8JVx';

export const CAPTURE_PROMOTER = Object.freeze({ proId: '5686', promoter: 'Integration, GoHighLevel' });

const src = (srsId, subSource, line) => Object.freeze({ srsId, subSource, line });
const PPC = src('303', 'Internet / Google PPC Windows', 'Google PPC Windows');
const VIS = src('875', 'Internet / Vis PPC', 'JMJ Marketing VIS PPC');
const BEST_PICK = src('38', 'Magazine / Best Pick', 'Magazine - Best Pick Reports');
const FIVE_STAR = src('380', 'Magazine / 5 Star', 'Magazine - 5 Star Reviews');
const HOME_MAG = src('647', 'Magazine / TheHomeMag', 'TheHomeMag');
const SHOWCASE = src('743', 'TownShowCase / TownShowCase', 'Town Showcase');
const BILLBOARD = src('797', 'Job Signs / Billboard', 'Billboard-Trailer Job Signs');
const STICKY = (line) => src('774', 'Canvass Sticky / Canvass Sticky', line);
const CHATBOT = src('830', 'Website / Reece ChatBot', 'Internet - Reece Chatbot');

/** Called number (10 digits) → Sub-Source. One row per tracking number. */
export const CAPTURE_SOURCES_BY_NUMBER = Object.freeze({
  '5615592041': PPC,
  '7274935237': VIS,
  '9547031133': BEST_PICK,
  '9548337133': FIVE_STAR,
  '4073266687': FIVE_STAR,
  '9549069080': HOME_MAG,
  '9544661179': SHOWCASE,
  '7272751929': SHOWCASE,
  '8667602010': BILLBOARD,
  '2393760435': BILLBOARD,
  '9542805859': STICKY('FTL Sticky'),
  '7276775600': STICKY('St Pete Sticky'),
  '2397665799': STICKY('Ft Myers Sticky'),
  '9047129091': STICKY('JAX Sticky'),
  '9548901067': CHATBOT,
});

export const MAIN_NUMBER_SOURCE = src('91', 'RCI / Reece Call In', 'Main Number');

const last10 = (v) => {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
};

/**
 * The LP attribution for a captured call, or null when it has none.
 * @param {{ calledNumber?: string, campaign?: string }} call
 * @returns {{ srsId, subSource, line, proId, promoter } | null}
 */
export function captureSourceFor({ calledNumber, campaign } = {}) {
  const byNumber = CAPTURE_SOURCES_BY_NUMBER[last10(calledNumber)];
  const hit = byNumber
    || (String(campaign ?? '').trim().toLowerCase() === 'main number' ? MAIN_NUMBER_SOURCE : null);
  return hit ? { ...hit, ...CAPTURE_PROMOTER } : null;
}
