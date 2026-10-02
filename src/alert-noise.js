// Alert noise cut — src/alert-noise.js
//
// 2026-10-02 (Mark). Pure rules for which rule-built cards still post.
//   - CUT_NOTIFICATION_RULE_KEYS lost their send_notification step in
//     sql/seeds/2026-10-02_alert_noise_cut.sql (info-only enrollment cards).
//     The rules still run; their events are still recorded.
//   - DIGESTED_NOTIFICATION_RULE_KEYS (P2 Won / Lost, ~140 a week) keep the
//     step in the template but it is dropped at queue time while
//     ALERT_DIGEST_ENABLED is on: the 8 AM digest (src/jobs/ops-morning-digest.js)
//     lists them instead. Turning the switch off brings the per-contact cards
//     back with no SQL.
import { alertDigestEnabled } from './alert-posted.js';

export const CUT_NOTIFICATION_RULE_KEYS = Object.freeze([
  'OBJECTION_ROUTE_PRE_DEMO',              // 215 — "ROUTED TO S5.2 v2"
  'ENROLL_S1_1_V3_REENGAGEMENT',           // 269
  'ENROLL_S2_2_FROM_CHATBOT_NO_BOOK',      // 286
  'S2_2_NO_EMAIL_EXHAUST_TO_COOLING',      // 288
  'W5_2_EXHAUSTED_ROUTE_TO_W11_0',         // 150
  'BACKSTOP_E0_OTHER_BOOKED_LEAD',         // 296
  'ENROLL_S5_2_v2_NO_SHOW_REP_TRAVELED',   // 295 — its GroupMe-target card
]);

export const DIGESTED_NOTIFICATION_RULE_KEYS = Object.freeze(['P2_JOB_TERMINAL_WON', 'P2_JOB_TERMINAL_LOST']);

/** Pure. The template with every send_notification step removed (what the seed does). */
export function stripNotifications(template) {
  const list = Array.isArray(template) ? template : [template];
  return list.filter((t) => t?.action_type !== 'send_notification');
}

/** Pure. The steps createActionsFromRule should queue for this rule right now. */
export function planRuleActions(rule, env = process.env) {
  const list = Array.isArray(rule?.action_template) ? rule.action_template : [rule?.action_template].filter(Boolean);
  if (DIGESTED_NOTIFICATION_RULE_KEYS.includes(rule?.rule_key) && alertDigestEnabled(env)) {
    return list.filter((t) => t?.action_type !== 'send_notification');
  }
  return list;
}
