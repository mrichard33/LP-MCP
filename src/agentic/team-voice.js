/**
 * src/agentic/team-voice.js
 *
 * 2026-10-02 (Mark), after the break test:
 *  - "The bot should act as the Reece Team." Asked for Randy, the live chat said
 *    "I'm Mark, handling chat here in the office" and the text bot "This is
 *    Mark". Neither bot gives a personal name now; a self-introduction with
 *    one becomes "this is the Reece Team". The post-demo rehash line keeps its
 *    rep's name (pass allowName), which is a separate ruling (2026-10-01).
 *  - "Randy's father founded Reece in 1972." The text bot said "Randy founded
 *    the company back in 1972". The KB is right ("family-owned since 1972");
 *    the model's paraphrase was not, so the paraphrase is corrected here.
 *
 * Pure. Runs after humanizeReply in both bots.
 */

const STOP_WORDS = new Set([
  'Reece', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'Happy', 'Sorry', 'Glad', 'Here', 'Just', 'Not', 'Still', 'So', 'Also', 'On', 'In', 'At',
]);

function personalNames() {
  const configured = String(process.env.AGENTIC_REPLY_SENDER_NAME || '').trim().split(/\s+/)[0];
  return ['Mark', 'Randy', configured].filter(Boolean);
}

/**
 * @param {string} text
 * @param {{ allowName?: string|null }} [opts]  a name this line may use (rehash rep)
 * @returns {{ text: string, changes: string[] }}
 */
export function enforceTeamVoice(text, { allowName = null } = {}) {
  let out = String(text || '');
  const changes = [];

  // 1. Who founded Reece.
  const founder = out
    .replace(/\bRandy(?:\s+Reece)?\s+is\s+(?:our|the|Reece's)\s+founder\b/gi, "Randy's father founded Reece")
    .replace(/\b(?:our|the)\s+founder,?\s+Randy(?:\s+Reece)?\b(?!'s),?/gi, "Randy's father")
    .replace(/\bfounded\s+by\s+Randy(?:\s+Reece)?\b(?!'s)/gi, "founded by Randy's father")
    .replace(/\bRandy(?:\s+Reece)?(?!'s)(\s+(?:\w+\s+)?(?:founded|started)\b)/gi, "Randy's father$1");
  if (founder !== out) { out = founder; changes.push('founder'); }

  if (allowName) return { text: out, changes };

  // 2. No personal name for the bot. "I'm Mark, handling chat here in the
  // office" / "This is Mark with the team" / "Mark here" / "— Mark".
  const names = personalNames();
  const nameAlt = names.map(n => n.replace(/[^A-Za-z'-]/g, '')).filter(Boolean).join('|');
  const intro = new RegExp(String.raw`\b(I'm|I am|this is|it's|my name is)\s+(${nameAlt})\b(?:\s*,?\s*(?:with|from|on|at|handling|here)\b[^.!?]*?)?(?=[,.!?]|\s+and\b|$)`, 'gi');
  let next = out.replace(intro, (m, lead) => `${/^[A-Z]/.test(lead) ? 'This' : 'this'} is the Reece Team`);
  // A generic name with a role ("I'm Dana, handling chat here") is the same thing.
  next = next.replace(/\b(I'm|I am|my name is)\s+([A-Z][a-z]+)\s*,?\s+(?:handling|here\s+(?:in|at)|with\s+the\s+(?:team|office))\b[^.!?]*/g,
    (m, lead, name) => STOP_WORDS.has(name) ? m : `${/^[A-Z]/.test(lead) ? 'This' : 'this'} is the Reece Team`);
  next = next.replace(new RegExp(String.raw`(^|[.!?]\s+)(?:${nameAlt})\s+here\b[,.]?\s*`, 'g'), (m, pre) => `${pre}This is the Reece Team. `);
  next = next.replace(new RegExp(String.raw`([—–-]\s*)(?:${nameAlt})\s*$`), '$1Reece Team');
  if (next !== out) { out = next.replace(/\s{2,}/g, ' ').trim(); changes.push('team_identity'); }

  return { text: out, changes };
}
