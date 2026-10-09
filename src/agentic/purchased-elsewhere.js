// ─── "I signed with another company" — src/agentic/purchased-elsewhere.js ────
//
// ONE pattern for a lead telling us they bought elsewhere. It is the same text
// as the `payload_message_matches` of agent_rules 173 (INTENT_PURCHASED_ELSEWHERE)
// and 356 (RESCISSION_RESCUE_HUMAN_OWNED), which own the routing and stop-bot.
// The reply planner (post-demo-turn.js / nepq-planner.js) reads it so the bot's
// own reply matches what the rules decided (2026-10-09, Marika Ossman: "Sorry I
// signed the contract with other company." got "Congratulations" and a stock
// discovery question). Change the rules and this together.
//
// Pure.

export const PURCHASED_ELSEWHERE_RX = new RegExp(
  String.raw`\b(contracted\s+with\s+(another|a\s+different)|(signed|going|went)\s+with\s+(another|a\s+different)|already\s+(chose|picked|hired|signed|decided)|purchased\s+(elsewhere|from\s+(another|someone))|hired\s+(another|someone\s+else)|with\s+another\s+(company|vendor|contractor)|(signed|contracted|went|going|gone)\s+((the|a|our|my)\s+)?((contract|paperwork|deal|agreement)\s+)?with\s+((an|a|the)\s+)?(other|different)\s+(company|vendor|contractor|business|guys|people|outfit)|(bought|purchased|ordered|got)\s+((them|it|the\s+windows|our\s+windows|windows|doors)\s+)?(elsewhere|somewhere\s+else|from\s+((an|a|the)\s+)?(other|another|different)\s+(company|vendor|contractor|business))|(chose|picked|hired|went\s+with)\s+(someone\s+else|somebody\s+else|a\s+different\s+(company|vendor|contractor)|the\s+other\s+(company|guys)))\b`,
  'i',
);

export function isPurchasedElsewhere(text) {
  return PURCHASED_ELSEWHERE_RX.test(String(text || ''));
}
