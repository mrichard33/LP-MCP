/**
 * What the bot may read from a Siro visit — src/siro/text-guards.js (2026-10-19)
 *
 * Pure, and a leaf: normalize.js and presentation-facts.js both import it, and
 * presentation-facts.js already imports normalize.js, so these cleaners cannot
 * live in either without a cycle.
 *
 * Three cleaners, each dropping the sentence (or, where the sentence opens on
 * something worth keeping, only the clause) that carries what the bot must not
 * use:
 *   dropDiscountTalk     a concession Siro advised ("offer the additional
 *                        $2,000 to $5,000 discount"; 2026-10-16, moved here).
 *   dropMoneyTalk        any dollar figure, percent or financing term (the F.0
 *                        visit facts and Siro's follow-up text; the reply bot's
 *                        PRESENTATION block keeps the quotes, the user's ruling
 *                        of 2026-10-16).
 *   dropSensitiveDetail  a death or loss, an illness or the hospital, a
 *                        divorce, a lost job, debt or "can't afford", age (Mark,
 *                        2026-10-19, ruling 7). Mr. Jackson "recently lost his
 *                        wife" (g8WqjuFBCCjlDZedSdoJ) stays out of every text;
 *                        "before his family visits for Christmas" may stay.
 *                        Maria's visit ended with firefighters at the door and
 *                        her husband's heart trouble: none of it is the bot's.
 */

// "Mr. Jackson" is not two sentences.
const SENTENCE_SPLIT = /(?<!\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr)\.)(?<=[.!?;])\s+/;
const CLAUSE_SPLIT = /,\s+/;

function tidy(s) {
  return String(s ?? '').replace(/\s{2,}/g, ' ').replace(/\s+([,.;!?])/g, '$1').trim();
}

/**
 * Drop each sentence that matches `rx`. When `keepRest` is set and the sentence
 * has other clauses, only the matching clauses go ("Customer recently lost his
 * wife, and wants to protect his home before Christmas" → "Wants to protect his
 * home before Christmas.").
 */
function dropMatching(text, rx, { keepRest = true } = {}) {
  const t = String(text ?? '');
  if (!rx.test(t)) return t;
  const kept = [];
  for (const sen of t.split(SENTENCE_SPLIT)) {
    if (!rx.test(sen)) { kept.push(sen); continue; }
    const clauses = sen.split(CLAUSE_SPLIT);
    if (clauses.length < 2) continue;
    if (!keepRest && rx.test(clauses[0])) continue;
    const rest = clauses.filter(c => !rx.test(c));
    if (!rest.length) continue;
    let out = rest.join(', ').replace(/^(?:and|or|but|while|so)\s+/i, '')
      .replace(/[,;]?\s*(?:\s(?:and|or))?\s*$/i, '').replace(/[.!?;]?$/, '');
    if (!out.trim()) continue;
    out = out[0].toUpperCase() + out.slice(1);
    kept.push(`${out}.`);
  }
  return tidy(kept.join(' '));
}

// Siro's follow-up advice often names a concession. The bot must never offer
// one, so any sentence about a discount, a price cut or a promotion is dropped
// from what the bot reads. The quotes themselves stay (the user's ruling).
// 2026-10-20 (the first reprocess of Siro's follow-up texts): "go to bat with
// my GM Craig to get you the absolute best number" and "I'll see what extra
// room I have with management" are concessions too.
const DISCOUNT_RX = /\b(?:discount\w*|rebate\w*|promo(?:tion|tional)?s?|coupon\w*|price\s+(?:cut|drop|reduction|match)\w*|(?:reduce|lower|cut|drop)\w*\s+(?:the\s+|their\s+|her\s+|his\s+)?(?:price|cost|quote|number)|manager[-\s]approved|special\s+(?:pricing|offer|deal)|incentive\w*|knock\w*\s+off|go(?:ing|es)?\s+to\s+bat|(?:extra|wiggle)\s+room|with\s+(?:my|our|the)\s+(?:GM|general\s+manager|manager|management)|best\s+(?:possible\s+)?(?:number|price|pricing|rate))\b/i;
export function dropDiscountTalk(text) {
  // "…review the brochures, confirm door specs, and offer the discount." keeps
  // its first clauses; a sentence that opens on the concession goes whole.
  const t = String(text ?? '');
  if (!DISCOUNT_RX.test(t)) return t;
  const kept = [];
  for (const sen of t.split(/(?<!\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr)\.)(?<=[.!?])\s+/)) {
    if (!DISCOUNT_RX.test(sen)) { kept.push(sen); continue; }
    const clauses = sen.split(CLAUSE_SPLIT);
    if (DISCOUNT_RX.test(clauses[0])) continue;
    const rest = clauses.filter(c => !DISCOUNT_RX.test(c));
    kept.push(`${rest.join(', ').replace(/[,;]?\s*(?:\s(?:and|or))?\s*$/i, '').replace(/[.!?]?$/, '')}.`);
  }
  return kept.join(' ').trim();
}

const MONEY_RX = /\$\s?\d|\b\d+(?:\.\d+)?\s?%|\bpercent\b|\bAPR\b|\binterest[-\s]free\b|\b(?:no|zero|0%?)\s+interest\b|\binterest\s+rate\b|\bfinanc\w*|\bloans?\b|\bdown\s+payment\b|\bmonthly\s+payments?\b|\bpayments?\b|\bper\s+month\b|\/\s?(?:mo|month)\b|\ba\s+month\b|\bcredit\s+(?:score|check|decline|approval)\b|\bdeposit\b|\bdollars?\b|\b\d{1,3}(?:,\d{3})+\b|\b\d+k\b/i;
export function dropMoneyTalk(text) {
  // "high electric bills ($400+ per month)" keeps the bills, loses the figure.
  const t = String(text ?? '').replace(/\s*\(([^)]*)\)/g, (m, inner) => (MONEY_RX.test(inner) ? '' : m));
  return dropMatching(t, MONEY_RX);
}

const SENSITIVE_RX = new RegExp([
  // death and loss
  String.raw`\b(?:died|dies|dying|death|dead|deceased|passed\s+away|passing\s+of|funeral|grie(?:f|ving|ves)|bereave\w*|widow(?:ed|er)?|late\s+(?:wife|husband|spouse|mother|father|son|daughter))\b`,
  String.raw`\b(?:sorry\s+(?:about\s+(?:your|his|her|their)|to\s+hear|for\s+(?:your|his|her|their)\s+loss)|condolence\w*|(?:my|our)\s+sympath\w*|thoughts\s+and\s+prayers)\b`,
  String.raw`\blost\s+(?:his|her|their|my|a)\s+(?:wife|husband|spouse|partner|son|daughter|child|mother|father|mom|dad|parent|brother|sister|family\s+member|loved\s+one)\b`,
  String.raw`\bloss\s+(?:of|in)\s+(?:the\s+|his\s+|her\s+|their\s+)?(?:family|wife|husband|spouse|child|parent|loved)`,
  // illness and health
  String.raw`\b(?:ill|illness|sick(?:ness)?|cancer|chemo\w*|diagnos\w*|hospital\w*|surger(?:y|ies)|surgical|stroke|dementia|alzheimer\w*|parkinson\w*|disab(?:led|ility|ilities)|medical|medication|health|healthy?\s+issues|ailing|caregiv\w*|terminal|hospice|ambulance|paramedics?|firefighters?|emergency\s+room|heart\s+(?:attack|problems?|condition|issues?|trouble))\b`,
  // divorce and separation
  String.raw`\b(?:divorc\w*|separated|separation|split\s+up|ex[-\s](?:wife|husband))\b`,
  // job loss
  String.raw`\b(?:laid\s+off|layoffs?|unemploy\w*|out\s+of\s+work|lost\s+(?:his|her|their|my)\s+job|job\s+loss|got\s+fired)\b`,
  // debt and hardship
  String.raw`\b(?:debt\w*|bankrupt\w*|foreclos\w*|can'?t\s+afford|cannot\s+afford|could\s*n[o']t\s+afford|hardship|struggling\s+financially|behind\s+on\s+(?:bills|payments|the\s+mortgage)|collections)\b`,
  // credit trouble (2026-10-20: "credit restoration program" in a Siro draft)
  String.raw`\b(?:credit\s+(?:restoration|repair|problems?|issues?|trouble|history)|(?:bad|poor|low)\s+credit)\b`,
  // age
  String.raw`\b(?:elderly|senior\s+citizens?|retirees?|retired|retirement|\d{1,3}[-\s]years?[-\s]old|old\s+age|aging\s+(?:parent|parents|mother|father|mom|dad)|in\s+(?:his|her|their)\s+(?:60|70|80|90)s)\b`,
].join('|'), 'i');
export function dropSensitiveDetail(text) {
  return dropMatching(text, SENSITIVE_RX);
}

// 2026-10-20: Siro's drafted text is written AS the rep, for the day of the
// visit: "this is Alex Cocco from Reece …", "reconnect tomorrow at 2:00 PM".
// Neither is ours to repeat: the bot is the Reece Team, and the rep's time is
// not a booking. Only Siro's follow-up text runs these.
const CLOCK_RX = /\b\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?)(?![a-z])|\b\d{1,2}:\d{2}\b|\b(?:at|by)\s+(?:noon|\d{1,2}(?::\d{2})?)\b|\b(?:tomorrow|tonight|this\s+(?:afternoon|evening|morning))\b/i;
const SELF_INTRO_RX = /\b(?:this\s+is|it'?s|my\s+name\s+is)\s+[A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+){0,2}\s+(?:from|with|at|of)\s+Reece\b/;
export function dropClockTimes(text) {
  return dropMatching(text, CLOCK_RX);
}
export function dropSelfIntro(text) {
  return dropMatching(text, SELF_INTRO_RX, { keepRest: false });
}

/** True when the text carries something dropSensitiveDetail would remove. Pure. */
export function hasSensitiveDetail(text) {
  return SENSITIVE_RX.test(String(text ?? ''));
}
/** True when the text carries a dollar figure, percent or financing term. Pure. */
export function hasMoneyTalk(text) {
  return MONEY_RX.test(String(text ?? ''));
}
