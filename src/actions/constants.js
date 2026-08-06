/**
 * Action Executor Constants — src/actions/constants.js
 *
 * Pure data: GHL location, pipeline IDs, stage map, calendar map, misc.
 * Extracted from action-executor.js v4.2 refactor.
 */

export const GHL_LOCATION_ID = 'SsBG7j5KQAIP1SFP2Sca';

export const PIPELINE_IDS = {
  P1: 'x0cxXOkKwqAWVvcPdKZQ',
  P2: '44mOrpmHqk7YqZN9vSPW',
  P3: '1jIWe4Ad04oJtYE9UuXq',
};

/**
 * STAGE_MAP — canonical name → stageId
 *
 * After the 2026-05-06 Antifragile rename, both canonical and legacy keys
 * resolve to the same stable stageIds. Use canonical names for new rules.
 *
 * P1 zone framework: TOFU = entry, MOFU = trust-building, BOFU = conversion,
 * SOFU = side-funnel recovery. Sale Recorded is the BOFU terminal.
 */
export const STAGE_MAP = {
  // ============================================================
  // P1 — Antifragile Buyer Activation Pipeline (canonical)
  // ============================================================
  // TOFU
  'Lead Captured':                       '793f72f8-08b3-4d0a-9227-a646f1fdc7f6',
  'High-Intent Qualified':               '0afdc1bc-2859-4696-ab13-07f8c59e457e',
  'Re-engagement':                       '9a3fec61-4057-4b30-bb23-5b5f57702d4d',
  // MOFU
  'Indoctrination':                      '67f50407-f004-47b3-ad70-83e0eccbe2d1',
  'Solution Education':                  '538d9a8e-4b38-4331-9711-87f40a6dd4ef',
  'Solution Pitch':                      'a75f34d2-b38d-4edd-ac98-4a89304be71c',
  // BOFU
  'Appointment Booked':                  '79ab10fd-5294-4330-b4ac-91b2df7c7d3a',
  'Appointment Completed':               '656c8446-da9b-4c97-add8-ba50d8319b84',
  'Proposal Delivered':                  '10776799-ee76-409f-a630-9c496e5d708e',
  'Sale Recorded':                       '2f7396e6-c51f-41f8-85f2-c2896733889f',
  // SOFU
  'Reactivation':                        '8a17a6ab-56ff-47b2-9c61-77b8ded7e479',
  'Long-Term Hold':                      '36ccbca0-c57f-466a-bd66-c7aa2a91e79d',

  // P1 — Legacy aliases (do not use for new rules)
  // ⚠ 'Re-Engagement' (capital E + hyphen) maps to the OLD stage 5 entropy
  //   bucket which is now labeled 'Solution Pitch'. The canonical
  //   'Re-engagement' (lowercase e) is at stageId 9a3fec61. Rules using
  //   'Re-Engagement' continue routing to Solution Pitch — this is the
  //   bug being fixed in the Phase B Pass 2 SQL canonicalization.
  'Indoctrination / Short Nurture':      '67f50407-f004-47b3-ad70-83e0eccbe2d1',
  'Active Nurture':                      '538d9a8e-4b38-4331-9711-87f40a6dd4ef',
  'Re-Engagement':                       'a75f34d2-b38d-4edd-ac98-4a89304be71c',
  'Conversion Sequence':                 '79ab10fd-5294-4330-b4ac-91b2df7c7d3a',
  'Proposal / Estimate Delivered':       '10776799-ee76-409f-a630-9c496e5d708e',
  'Unresponsive':                        '9a3fec61-4057-4b30-bb23-5b5f57702d4d',
  'Long Term Nurture':                   '36ccbca0-c57f-466a-bd66-c7aa2a91e79d',
  'Closed Won':                          '2f7396e6-c51f-41f8-85f2-c2896733889f',
  // catches the previously-broken W11_1_REROUTE_LAPSED_* rules
  '11. Long Term Nurture':               '36ccbca0-c57f-466a-bd66-c7aa2a91e79d',

  // ============================================================
  // P2 — Client Lifecycle Pipeline (canonical)
  // ============================================================
  // Sale & Setup
  'Contract Signed':                     'fec39f2e-ba39-4536-95b2-bbac7ca6c454',
  'Financing Pending':                   'b7fc445c-a969-42b1-9a7a-eda5c89f25a5',
  // Build Authorization
  //
  // 2026-08-06 RENAME: stage 375089e1 is now "3. Released to Production (RTP)"
  // in GHL. It was "3. Financing Approved", which was the wrong noun — the
  // event that actually lands a job here is the LP RTP milestone (mdt_id=R),
  // meaning the contract cleared verification and was released to production.
  // RTP is also the event LP's Net revenue report is keyed on. Financing
  // approval is a precondition, not the milestone.
  //
  // The stage ID is unchanged by a GHL rename, so nothing breaks either way;
  // this map just stops lying about what the stage means. New rules use the
  // canonical name. 'Financing Approved' is retained below as a legacy alias
  // because agent_rules rows and older seeds still carry it.
  'Released to Production (RTP)':        '375089e1-aaa5-429f-8c4c-5e01058fa8f8',
  'Permitting & HOA':                    '561f35fe-3632-40e9-bf0d-b9061bdf2589',
  // Build Execution
  'In Production':                       '6b89bc8d-067a-41fb-a76c-fc0c9feaaf92',
  'Install Scheduled':                   'd852ba71-c6f5-422b-9c74-33b6036c69a5',
  'Install Completed':                   '5fc94c74-d136-481e-b8ca-2200817111af',
  // Customer Lifecycle
  'Referral & Expansion':                '053a0020-0f96-4a22-8717-8814c3ca1ff8',

  // P2 — Legacy aliases
  'Closed Won (Contract Signed)':            'fec39f2e-ba39-4536-95b2-bbac7ca6c454',
  'Financing Pending / Document Collection': 'b7fc445c-a969-42b1-9a7a-eda5c89f25a5',
  'Financing Approved':                      '375089e1-aaa5-429f-8c4c-5e01058fa8f8',
  'Released to Production':                  '375089e1-aaa5-429f-8c4c-5e01058fa8f8',
  'RTP':                                     '375089e1-aaa5-429f-8c4c-5e01058fa8f8',
  'HOA / Permit In Progress':                '561f35fe-3632-40e9-bf0d-b9061bdf2589',
  'Production / Manufacturing':              '6b89bc8d-067a-41fb-a76c-fc0c9feaaf92',
  'Referral & Expansion Opportunity':        '053a0020-0f96-4a22-8717-8814c3ca1ff8',

  // ============================================================
  // P3 — Recycle, Lost, Deferred & Future Monetization (canonical)
  // ============================================================
  // Recovery
  'Deferred (Timing)':                   '3b786609-dec8-411f-9318-8b63778aa4cb',
  'Not Interested (Cooling)':            'e0bde70a-f32f-4b6d-88b2-be0c89c46852',
  'Reactivation Queue':                  'fda5f000-19a7-420f-935a-f1f2de0c7675',
  // Terminal
  'Bad Fit / Wrong Home':                'f9cd1a23-a6f9-452c-b129-c47d5a14a6bd',
  'Hard Disqualified':                   '6194a841-8f59-4164-adee-dc0bd99510dc',
  'Do Not Contact':                      '5f332652-b8c1-4a67-ba30-dc3450a3e039',

  // P3 — Legacy aliases
  'Deferred / Timing':                   '3b786609-dec8-411f-9318-8b63778aa4cb',
  'Not Interested (Now)':                'e0bde70a-f32f-4b6d-88b2-be0c89c46852',
};

export const CALENDAR_MAP = {
  'Review Session':             'DQYMaJ22N6zL4SXjHukw',
  // Alias: the booking-calendar-router names this same phone calendar
  // "Protection Profile Review" (PPR). Both names resolve to the same id so a
  // book_appointment that carries either name routes correctly. Routing should
  // still prefer payload.calendar_id (stamped server-side) over the name.
  'Protection Profile Review':  'DQYMaJ22N6zL4SXjHukw',
  'Measurement Verification':   'zEdPmkNccR2ovo3rQAd3',
  'Window Estimate':            'aJj14ONxh1oFyDcQ706O',
  'Home Protection Assessment': 'zS1wg0JqQ1zsszJyJqKX',
  'Confirmation Call':          'gFWoSQrlKIdfRbAPV842',
};

export const REMOVE_ALL_MARKETING_WF = '07a657bd-0492-4137-a831-babfa608c902';

export const MONTH_MAP = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
};
