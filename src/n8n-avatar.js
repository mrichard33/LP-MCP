/**
 * n8n Avatar Workflow APIs — replaces ALL Code nodes in *Identify Lead Avatar workflow
 *
 * POST /n8n/avatar/score           — Score Avatar + Pain + Season + Stage + Determine Week + Pillar
 * POST /n8n/avatar/parse-gpt       — Parse GPT JSON response
 * POST /n8n/avatar/unified-inputs  — Merge scored + GPT classification results
 * POST /n8n/avatar/pick-best       — Score and pick best Notion content row
 * POST /n8n/avatar/build-ghl       — Build GHL Custom Fields payload from Notion page
 * POST /n8n/avatar/build-notion    — Build Notion Update Payload (Last Used Date, Times Used)
 */

// ═══════════════════════════════════════════════════════════════════
// SHARED ENUMS + HELPERS
// ═══════════════════════════════════════════════════════════════════

const ENUMS = {
  JourneyStage: ['Indoctrination', 'Nurture', 'Re-Engagement', 'Appointment'],
  PrimaryEmotionalPain: ['Storm Vulnerability', 'Wrong Decision', 'Hidden Costs', 'Regret', 'Sales Pressure', 'Timing Uncertainty'],
  PrimaryAvatar: ['Cautious Planner', 'Storm Focused Protector', 'Value Driven Researcher'],
  SeasonContext: ['Storm Season', 'Off Season'],
};

function includesAny(text, arr) { const t = (text || '').toLowerCase(); return arr.some(k => t.includes(String(k).toLowerCase())); }
function findMatches(text, phrases) { const t = (text || '').toLowerCase(); return phrases.filter(p => t.includes(String(p).toLowerCase())); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function normalizeWhitespace(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function firstOrSelf(v) { return Array.isArray(v) ? (v.length ? v[0] : '') : v; }
function enforceEnum(value, allowed, fallback) { const v = normalizeWhitespace(firstOrSelf(value)); return allowed.includes(v) ? v : fallback; }
function pickFirstDefined(...vals) { for (const v of vals) { if (v == null) continue; const s = String(v).trim(); if (s.length) return s; } return ''; }

function mapAvatarToEnum(name) {
  const n = normalizeWhitespace(firstOrSelf(name)).toLowerCase();
  if (n.includes('cautious') || n.includes('planner')) return 'Cautious Planner';
  if (n.includes('storm') || n.includes('protector')) return 'Storm Focused Protector';
  if (n.includes('research') || n.includes('value')) return 'Value Driven Researcher';
  return 'Cautious Planner';
}

function mapPainToEnum(painKey) {
  const n = normalizeWhitespace(firstOrSelf(painKey)).toLowerCase();
  if (n.includes('storm') || n.includes('hurricane') || n.includes('wind') || n.includes('debris') || n.includes('evac')) return 'Storm Vulnerability';
  if (n.includes('wrong') || n.includes('decision') || n.includes('mistake') || n.includes('bad choice') || n.includes('mess this up')) return 'Wrong Decision';
  if (n.includes('hidden') || n.includes('cost') || n.includes('fees') || n.includes('budget') || n.includes('price') || n.includes('surprise')) return 'Hidden Costs';
  if (n.includes('regret') || n.includes('too late') || n.includes('wish') || n.includes('should have')) return 'Regret';
  if (n.includes('sales') || n.includes('pressure') || n.includes('pushy') || n.includes("don't call") || n.includes('dont call')) return 'Sales Pressure';
  if (n.includes('timing') || n.includes('timeline') || n.includes('later') || n.includes('not ready') || n.includes('when') || n.includes('schedule')) return 'Timing Uncertainty';
  return 'Sales Pressure';
}

function mapJourneyStageToEnum(stageKey) {
  const n = normalizeWhitespace(firstOrSelf(stageKey)).toLowerCase();
  if (n.includes('appointment') || n.includes('booked') || n.includes('estimate') || n.includes('call')) return 'Appointment';
  if (n.includes('indoctrination') || n.includes('new lead') || n.includes('requested')) return 'Indoctrination';
  if (n.includes('re-engagement') || n.includes('reengagement') || n.includes('reactiv')) return 'Re-Engagement';
  return 'Nurture';
}

function decodeHTMLEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&#x22;/g, '"')
    .replace(/&amp;/g, '&').replace(/&#x26;/g, '&')
    .replace(/&lt;/g, '<').replace(/&#x3C;/g, '<')
    .replace(/&gt;/g, '>').replace(/&#x3E;/g, '>')
    .replace(/&#x2F;/g, '/').replace(/&#47;/g, '/