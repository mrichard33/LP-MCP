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
    .replace(/&#x2F;/g, '/').replace(/&#47;/g, '/');
}

const protectorKeys = ['hurricane','storm','impact','rated','code','shutters','cat','wind-borne','wind borne','debris','protect my family','safety','evac','storm season','next storm','hurricane guide'];
const researcherKeys = ['compare','options','brands','best','rating','spec','stc','u-factor','u factor','energy','noise','insurance','premium','warranty','roi','price range','ballpark','estimate cost','deductible','budget'];
const plannerKeys = ['just looking','not ready','researching','thinking','no pressure',"don't call",'do not call','just email','email only','busy','how long','process','timeline','appointment','what to expect','how long does the estimate take'];

const reasonLabelMap = { storm_language:'Storm language', comparison_or_specs:'Comparison or specs', hesitation_or_time_control:'Hesitation or time control', booked_soon:'Booked soon', high_question_density:'Many questions', wants_control:'Wants control', insurance_interest:'Insurance mentioned', no_signal_default:'No clear signal' };

// ═══════════════════════════════════════════════════════════════════
// 1. POST /n8n/avatar/score
// Replaces: "Score Avatar + Pain + Season + Stage" AND "Determine Week + Pillar"
// ═══════════════════════════════════════════════════════════════════

function handleAvatarScore(req, res) {
  try {
    const payload = req.body || {};
    const nurture_week = pickFirstDefined(payload.nurture_week, payload.nurtureWeek, payload.recommended_week, payload.week, payload.customData?.nurture_week, payload.fields?.nurture_week, payload.data?.nurture_week);
    const chat = String(payload.chat_transcript || '').toLowerCase();
    const notes = String(payload.notes || '').toLowerCase();
    const leadSource = String(payload.lead_source || '').toLowerCase();
    const pages = String(payload.pages_visited || '').toLowerCase();
    const utm = `${payload.utm_campaign || ''} ${payload.utm_content || ''} ${payload.utm_term || ''}`.toLowerCase();
    const bookedRaw = String(payload.booked_appointment || 'none').toLowerCase();
    const requestedQuote = !!payload.requested_quote;
    const timeToAppt = Number(payload.time_to_appointment_hours || 0);

    let booked = 'none';
    if (bookedRaw.includes('conf') || bookedRaw.includes('call')) booked = 'call';
    if (bookedRaw.includes('estimate') || bookedRaw.includes('in-home') || bookedRaw.includes('in home') || bookedRaw.includes('visit')) booked = 'estimate';

    const blob = [chat, notes, pages, utm, leadSource].join(' ');

    let score_planner = 0, score_protector = 0, score_researcher = 0, reasons = [];
    if (includesAny(blob, protectorKeys)) { score_protector += 3; reasons.push('storm_language'); }
    if (includesAny(blob, researcherKeys)) { score_researcher += 3; reasons.push('comparison_or_specs'); }
    if (includesAny(blob, plannerKeys)) { score_planner += 3; reasons.push('hesitation_or_time_control'); }
    if ((booked === 'call' || booked === 'estimate') && timeToAppt > 0 && timeToAppt <= 24) { score_protector += 1; score_researcher += 1; reasons.push('booked_soon'); }
    const qCount = (chat.match(/\?/g) || []).length;
    if (qCount >= 3 || chat.length > 600) { score_researcher += 2; reasons.push('high_question_density'); }
    if (includesAny(blob, ["don't call", 'do not call', 'text only', 'email only', 'not now', 'later'])) { score_planner += 2; reasons.push('wants_control'); }
    if (includesAny(blob, ['insurance', 'premium', 'deductible', 'claim'])) { score_researcher += 2; reasons.push('insurance_interest'); }

    const scores = [{ name: 'Cautious Planner', score: score_planner }, { name: 'Storm Focused Protector', score: score_protector }, { name: 'Value Driven Researcher', score: score_researcher }].sort((a, b) => b.score - a.score);
    let customer_avatar = scores[0].name;
    if (scores.length > 1 && scores[0].score === scores[1].score) customer_avatar = 'Cautious Planner';
    customer_avatar = enforceEnum(mapAvatarToEnum(customer_avatar), ENUMS.PrimaryAvatar, 'Cautious Planner').replace(/-/g, ' ').trim();
    let confidence = clamp(60 + (scores[0].score - (scores[1]?.score ?? 0)) * 10, 55, 95);

    const painSignals = [
      { pain: 'Storm Vulnerability', keys: ['hurricane','storm','evac','shutters','impact','debris','storm season','hurricane guide','wind','wind-borne','wind borne'] },
      { pain: 'Wrong Decision', keys: ['wrong choice','mess this up','make a mistake','bad choice','best option','compare','which is better','what should i choose'] },
      { pain: 'Hidden Costs', keys: ['hidden','fees','surprise','deductible','premium','claim','insurance','budget','ballpark','price range','estimate cost','cost'] },
      { pain: 'Timing Uncertainty', keys: ['when','timing','not ready','later','busy','how long','timeline','schedule'] },
      { pain: 'Regret', keys: ['regret','wish','should have','too late'] },
      { pain: 'Sales Pressure', keys: ['pressure','sales','sold','pushy',"don't call",'do not call','stop calling'] },
    ];
    let primary_emotional_pain = 'Sales Pressure';
    for (const p of painSignals) { if (includesAny(blob, p.keys)) { primary_emotional_pain = p.pain; break; } }
    primary_emotional_pain = enforceEnum(mapPainToEnum(primary_emotional_pain), ENUMS.PrimaryEmotionalPain, 'Sales Pressure');

    const month = new Date().getMonth() + 1;
    let season_context = enforceEnum(month >= 6 && month <= 11 ? 'Storm Season' : 'Off Season', ENUMS.SeasonContext, 'Off Season');

    let journey_stage = 'Nurture';
    if (booked === 'call' || booked === 'estimate') journey_stage = 'Appointment';
    else if (requestedQuote) journey_stage = 'Indoctrination';
    journey_stage = enforceEnum(mapJourneyStageToEnum(journey_stage), ENUMS.JourneyStage, 'Nurture');

    let keyPhrases = [...new Set([...findMatches(blob, protectorKeys), ...findMatches(blob, researcherKeys), ...findMatches(blob, plannerKeys)])].slice(0, 8);
    if (reasons.length === 0) reasons.push('no_signal_default');
    const avatar_reason_codes = reasons.slice(0, 3).map(r => reasonLabelMap[String(r).trim()] || 'No clear signal').join(' | ');
    const avatar_key_phrases = keyPhrases.map(p => normalizeWhitespace(p)).filter(Boolean).join(' || ');

    // Determine Week + Pillar (merged into same endpoint)
    const currentWeek = nurture_week || 'Week 1';
    const weekNum = Number((currentWeek.match(/\d+/) || ['1'])[0]);
    const nurture_pillar = (weekNum % 2 === 1) ? 'Education' : 'Engagement';

    const raw = { nurture_week, customer_avatar, confidence, reason_codes: reasons.slice(0, 3), key_phrases: keyPhrases, primary_emotional_pain, season_context, journey_stage, booked_appointment_normalized: booked, debug_scores: { planner: score_planner, protector: score_protector, researcher: score_researcher } };

    res.json({
      customer_avatar, nurture_week: `Week ${weekNum}`, nurture_pillar,
      avatar_confidence: confidence, avatar_reason_codes, avatar_key_phrases,
      avatar_classification_raw: JSON.stringify(raw),
      journey_stage, primary_emotional_pain, season_context,
      booked_appointment_normalized: booked,
      contact_id: payload.contact_id, location_id: payload.location_id,
    });
  } catch (err) { console.error('[n8n/avatar/score] Error:', err.message); res.status(500).json({ error: err.message }); }
}

// ═══════════════════════════════════════════════════════════════════
// 2. POST /n8n/avatar/parse-gpt
// Replaces: "Parse GPT JSON"
// ═══════════════════════════════════════════════════════════════════

function handleParseGpt(req, res) {
  try {
    const input = req.body || {};
    let raw = input.gpt_output || input.output_text || input.text || '';
    if (!raw) {
      // Deep search for any string
      const walk = (obj, seen = new Set()) => {
        if (!obj || seen.has(obj)) return null; if (typeof obj === 'string' && obj.trim()) return obj;
        if (typeof obj !== 'object') return null; seen.add(obj);
        if (Array.isArray(obj)) { for (const i of obj) { const f = walk(i, seen); if (f) return f; } return null; }
        for (const k of Object.keys(obj)) { const f = walk(obj[k], seen); if (f) return f; } return null;
      };
      raw = walk(input) || '';
    }
    raw = String(raw).replace(/```json/gi, '').replace(/```/g, '').trim();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { const m = raw.match(/\{[\s\S]*\}/); if (m) try { parsed = JSON.parse(m[0]); } catch (_e) {} }
    if (!parsed) return res.status(400).json({ error: 'Could not parse GPT JSON', raw_snippet: String(raw).slice(0, 500) });

    const titleCase = s => String(s || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    const normRC = input => { if (!input) return ''; const arr = Array.isArray(input) ? input : [input]; return arr.map(r => titleCase(normalizeWhitespace(String(r).replace(/_/g, ' ')))).filter(Boolean).slice(0, 3).join(' | '); };
    const normKP = input => { if (!input) return ''; const arr = Array.isArray(input) ? input : [input]; return arr.map(x => normalizeWhitespace(x)).filter(Boolean).slice(0, 8).join(' || '); };

    const customer_avatar = enforceEnum(mapAvatarToEnum(parsed.customer_avatar), ENUMS.PrimaryAvatar, 'Cautious Planner');
    const avatar_confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 55;

    res.json({
      customer_avatar, avatar_confidence,
      avatar_reason_codes: normRC(parsed.reason_codes),
      avatar_key_phrases: normKP(parsed.key_phrases),
      avatar_classification_raw: JSON.stringify(parsed),
      primary_emotional_pain: enforceEnum(mapPainToEnum(parsed.primary_emotional_pain), ENUMS.PrimaryEmotionalPain, 'Sales Pressure'),
      journey_stage: enforceEnum(mapJourneyStageToEnum(parsed.journey_stage), ENUMS.JourneyStage, 'Nurture'),
      season_context: enforceEnum(normalizeWhitespace(firstOrSelf(parsed.season_context)).toLowerCase().includes('storm') ? 'Storm Season' : 'Off Season', ENUMS.SeasonContext, 'Off Season'),
    });
  } catch (err) { console.error('[n8n/avatar/parse-gpt] Error:', err.message); res.status(500).json({ error: err.message }); }
}

// ═══════════════════════════════════════════════════════════════════
// 3. POST /n8n/avatar/unified-inputs
// Replaces: "Unified Inputs" AND "Normalize Notion Filters"
// ═══════════════════════════════════════════════════════════════════

function handleUnifiedInputs(req, res) {
  try {
    const { scored, gpt_parsed, week_pillar } = req.body || {};
    const pillar = String(week_pillar?.nurture_pillar || scored?.nurture_pillar || '').trim();
    const week = String(week_pillar?.nurture_week || scored?.nurture_week || '').trim();
    const hasGpt = gpt_parsed && String(gpt_parsed.customer_avatar || '').trim().length > 0;
    const chosen = hasGpt ? gpt_parsed : (scored || {});
    const rawAvatar = String(chosen.customer_avatar || '').trim();
    const rawSeason = String(chosen.season_context || 'Storm Season').trim();
    const notion_avatar = rawAvatar.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
    const notion_season = rawSeason.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();

    res.json({
      nurture_pillar: pillar, nurture_week: week,
      customer_avatar: rawAvatar, season_context: rawSeason,
      notion_pillar: pillar, notion_week: week, notion_avatar, notion_season,
    });
  } catch (err) { console.error('[n8n/avatar/unified-inputs] Error:', err.message); res.status(500).json({ error: err.message }); }
}

// ═══════════════════════════════════════════════════════════════════
// 4. POST /n8n/avatar/pick-best
// Replaces: "Pick Best"
// ═══════════════════════════════════════════════════════════════════

function handlePickBest(req, res) {
  try {
    const { results, nurture_pillar, nurture_week, customer_avatar, season_context } = req.body || {};
    const pages = results || [];

    const getMS = (page, prop) => { const p = page?.properties?.[prop]; return (p?.type === 'multi_select') ? (p.multi_select || []).map(x => x.name).filter(Boolean) : []; };
    const getSel = (page, prop) => { const p = page?.properties?.[prop]; return (p?.type === 'select') ? (p.select?.name || '') : ''; };
    const getCB = (page, prop) => { const p = page?.properties?.[prop]; return (p?.type === 'checkbox') ? !!p.checkbox : false; };
    const getTitle = (page, prop) => { const p = page?.properties?.[prop]; return (p?.type === 'title') ? (p.title || []).map(t => t.plain_text).join('').trim() : ''; };
    const rt = (page, prop) => {
      const p = page?.properties?.[prop]; if (!p) return '';
      if (p.type === 'rich_text') return (p.rich_text || []).map(x => x.plain_text).join('').trim();
      if (p.type === 'title') return (p.title || []).map(x => x.plain_text).join('').trim();
      if (p.type === 'select') return p.select?.name || '';
      if (p.type === 'multi_select') return (p.multi_select || []).map(x => x.name).join(', ');
      if (p.type === 'checkbox') return !!p.checkbox;
      return '';
    };

    function scoreTieBreaker(page) {
      let score = 0;
      if (getCB(page, 'Active')) score += 5;
      if (getSel(page, 'Pillar') === nurture_pillar) score += 50;
      if (getSel(page, 'Recommended Week') === nurture_week) score += 40;
      if (getMS(page, 'Primary Avatar').includes(customer_avatar)) score += 60;
      const seasons = getMS(page, 'Season Relevance');
      if (seasons.includes(season_context)) score += 25;
      if (seasons.includes('Year Round')) score += 10;
      if (season_context === 'Off Season' && seasons.includes('Storm Season') && !seasons.includes('Year Round')) score -= 15;
      return score;
    }

    if (!Array.isArray(pages) || pages.length === 0) {
      return res.json({ inputs: { nurture_pillar, nurture_week, customer_avatar, season_context }, results_count: 0, best_score: null, best_page_id: null, best_title: null, best_page: null, best_topic_name: '', best_key_facts: '', best_email_summary: '', best_sms_hook: '', best_soft_cta: '', best_primary_pain: '', best_primary_avatar_list: '', best_season_relevance_list: '' });
    }

    const ranked = pages.map(p => ({ page: p, score: scoreTieBreaker(p), title: getTitle(p, 'Topic Name') || getTitle(p, 'Name') || '' }))
      .sort((a, b) => { if (b.score !== a.score) return b.score - a.score; const tA = (a.title || '').toLowerCase(), tB = (b.title || '').toLowerCase(); if (tA < tB) return -1; if (tA > tB) return 1; return (a.page?.id || '').localeCompare(b.page?.id || ''); });

    const best = ranked[0];
    const bp = best.page;

    res.json({
      inputs: { nurture_pillar, nurture_week, customer_avatar, season_context },
      results_count: pages.length, best_score: best.score, best_page_id: bp?.id || null, best_title: best.title,
      best_page: bp,
      best_topic_name: rt(bp, 'Topic Name'), best_key_facts: rt(bp, 'Key Facts / Research'),
      best_email_summary: rt(bp, 'Education Topic Summary'), best_sms_hook: rt(bp, 'SMS Hook (Example)'),
      best_soft_cta: rt(bp, 'Soft CTA (Email)'), best_primary_pain: rt(bp, 'Primary Emotional Pain'),
      best_primary_avatar_list: rt(bp, 'Primary Avatar'), best_season_relevance_list: rt(bp, 'Season Relevance'),
    });
  } catch (err) { console.error('[n8n/avatar/pick-best] Error:', err.message); res.status(500).json({ error: err.message }); }
}

// ═══════════════════════════════════════════════════════════════════
// 5. POST /n8n/avatar/build-ghl
// Replaces: "Build GHL Custom Fields"
// ═══════════════════════════════════════════════════════════════════

function handleBuildGhl(req, res) {
  try {
    const { best_page, nurture_pillar } = req.body || {};
    const best = best_page || {};
    const pillar = nurture_pillar || '';

    const titlePlain = (page, prop) => { const p = page?.properties?.[prop]; return (p?.type === 'title') ? (p.title || []).map(t => t.plain_text || '').join('').trim() : ''; };
    const selectName = (page, prop) => { const p = page?.properties?.[prop]; return (p?.type === 'select') ? (p.select?.name || '').trim() : ''; };
    const richTextPlain = (page, prop) => { const p = page?.properties?.[prop]; return (p?.type === 'rich_text') ? (p.rich_text || []).map(t => t.plain_text || '').join('').trim() : ''; };

    const topicName = decodeHTMLEntities(titlePlain(best, 'Topic Name'));
    const primaryPain = decodeHTMLEntities(selectName(best, 'Primary Emotional Pain'));
    const cognitiveOutcome = decodeHTMLEntities(selectName(best, 'Cognitive Outcome'));
    const topicSummary = decodeHTMLEntities(richTextPlain(best, 'Education Topic Summary'));
    const keyFacts = decodeHTMLEntities(richTextPlain(best, 'Key Facts / Research'));
    const educationWeekControlBlock = decodeHTMLEntities(richTextPlain(best, 'Education Week Control Block'));
    const engagementWeekControlBlock = decodeHTMLEntities(richTextPlain(best, 'Engagement Week Control Block'));
    const softCTA = decodeHTMLEntities(richTextPlain(best, 'Soft CTA (Email)'));
    const notionPageId = best?.id || '';
    const notionRowId = decodeHTMLEntities(richTextPlain(best, 'Row ID') || notionPageId);

    const payload = {
      customFields: [
        { id: '2rpIC1i1JkArFQ5l1Kf5', value: pillar },
        { id: '2oY9alRtz16kWuCgbRSo', value: topicName },
        { id: 'vFBE8NHEGq2pp2xO4pWc', value: primaryPain },
        { id: 'B9guy6VjVsjUYI7nFjQ4', value: cognitiveOutcome },
        { id: 'd4TAk14TpIbYc8KWfzcR', value: softCTA },
        { id: 'vwvGd9WvhRaYzOJtgltx', value: topicSummary },
        { id: 'J2dtqVvS1Qx5nKK2c3R6', value: keyFacts },
        { id: 'dSQEg0PfQtb13gzYDDzz', value: notionRowId },
        { id: 'RspcdFzktMcPTQ2Ui5ef', value: new Date().toISOString() },
      ],
    };

    if (pillar === 'Education' && educationWeekControlBlock) payload.customFields.push({ id: 'jOApgjImuEUEiKzs1e1L', value: educationWeekControlBlock });
    if (pillar === 'Engagement' && engagementWeekControlBlock) payload.customFields.push({ id: 'kG5umAf8lmVlWlbFAiHR', value: engagementWeekControlBlock });

    res.json(payload);
  } catch (err) { console.error('[n8n/avatar/build-ghl] Error:', err.message); res.status(500).json({ error: err.message }); }
}

// ═══════════════════════════════════════════════════════════════════
// 6. POST /n8n/avatar/build-notion
// Replaces: "Build Notion Update Payload"
// ═══════════════════════════════════════════════════════════════════

function handleBuildNotion(req, res) {
  try {
    const { best_page_id, best_page } = req.body || {};
    const bp = best_page || {};
    const timesUsedProp = bp?.properties?.['Times Used'];
    const currentTimesUsed = (timesUsedProp?.type === 'number' && typeof timesUsedProp.number === 'number') ? timesUsedProp.number : 0;

    res.json({
      pageId: best_page_id,
      body: {
        properties: {
          'Last Used Date': { date: { start: new Date().toISOString() } },
          'Times Used': { number: currentTimesUsed + 1 },
        },
      },
    });
  } catch (err) { console.error('[n8n/avatar/build-notion] Error:', err.message); res.status(500).json({ error: err.message }); }
}

// ═══════════════════════════════════════════════════════════════════
// REGISTER ROUTES
// ═══════════════════════════════════════════════════════════════════

export function registerN8nAvatarRoutes(app) {
  app.post('/n8n/avatar/score', handleAvatarScore);
  app.post('/n8n/avatar/parse-gpt', handleParseGpt);
  app.post('/n8n/avatar/unified-inputs', handleUnifiedInputs);
  app.post('/n8n/avatar/pick-best', handlePickBest);
  app.post('/n8n/avatar/build-ghl', handleBuildGhl);
  app.post('/n8n/avatar/build-notion', handleBuildNotion);
}
