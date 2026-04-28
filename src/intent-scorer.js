/**
 * Intent Scorer — src/intent-scorer.js
 *
 * The PROACTIVE layer. Runs on every behavioral event to:
 *   1. SPIKE DETECTION (Hot Window Protocol)
 *   2. INTENT SCORING (Composite Score 0-100)
 *   3. TIER CLASSIFICATION + TRANSITION DETECTION
 *   4. PATTERN MATCHING (Compound Signal Detection)
 *   5. CLOSER ASSISTANT (Decision Ownership + Loss Framing)
 *
 * Philosophy: "Predict → Intercept → Close"
 *
 * v1.1 — 2026-04-28. KILL CANVASSING FALSE-POSITIVE on Hot Window.
 *   Per Mark's Nancy Kesner / JpTvo8p5fmVp3uKO8g2k investigation:
 *   canvassing leads were generating "🔥 HOT WINDOW: Call within 10 min"
 *   GroupMe alerts within 90 seconds of contact creation, despite zero
 *   user-driven engagement. Pattern:
 *
 *     17:54:44 ghl.contact_created  (canvasser entered them)
 *     17:54:51 ghl.appointment_booked  (canvasser booked it)
 *     17:55:29 ghl.lead_score_changed  (auto from tags)
 *     → 2 events in 30min = SPIKE → "HOT WINDOW" alert fires
 *
 *   None of those are buyer signals. They're rep-driven CRM activity.
 *
 *   The fix: split spike-eligible events into INBOUND_ENGAGEMENT
 *   (genuine lead actions) and OUTCOME (outputs that may be rep-driven).
 *   Spike now requires AT LEAST ONE inbound engagement event in the
 *   window — rep activity alone can no longer trigger a HOT WINDOW.
 *
 *   ghl.lead_score_changed and ai.analysis_completed are removed from
 *   the candidate set entirely — they are downstream automation events,
 *   not buyer signals.
 *
 * v1.0 — Initial implementation.
 */

import supabase from './supabase.js';
import { upsertLeadIntelligence } from './context-builder.js';
import { emitEvent } from './event-emitter.js';

const SPIKE_WINDOW_MS = 30 * 60 * 1000;
const SPIKE_THRESHOLD = 2;

// v1.1: Split spike-eligible events by source-of-truth.
//
// INBOUND_ENGAGEMENT: real lead actions. The lead opened, clicked,
// replied, or watched something — undeniable buyer signal.
const INBOUND_ENGAGEMENT_EVENTS = [
  'ghl.reply_received',
  'ghl.email_opened',
  'ghl.link_clicked',
  'ghl.vsl_watched',
];

// OUTCOME: signals that COULD be rep-driven (canvassing booking, manual
// admin action) or lead-driven (self-service calendar booking via funnel).
// Counted toward total spike count, but cannot trigger a spike on their
// own — at least 1 INBOUND_ENGAGEMENT must be present.
const OUTCOME_EVENTS = [
  'ghl.appointment_booked',
];

// REMOVED from spike detection (was: ghl.lead_score_changed, ai.analysis_completed):
// - lead_score_changed: noisy automation event, fires whenever any tag-based
//   scoring rule trips. Not a buyer signal.
// - ai.analysis_completed: internal system event from message analyzer. Not
//   a buyer signal. (Reply that triggered the analysis is already counted.)

// ═══════════════════════════════════════════════════════════════════
// 1. SPIKE DETECTION — Hot Window Protocol (v1.1)
// ═══════════════════════════════════════════════════════════════════

async function detectSpike(ghlContactId) {
  const windowStart = new Date(Date.now() - SPIKE_WINDOW_MS).toISOString();
  const candidateEvents = [...INBOUND_ENGAGEMENT_EVENTS, ...OUTCOME_EVENTS];

  const { data, error } = await supabase
    .from('system_events')
    .select('event_type')
    .eq('ghl_contact_id', ghlContactId)
    .gte('created_at', windowStart)
    .in('event_type', candidateEvents);

  if (error) {
    console.error(`[IntentScorer] Spike detection query failed for ${ghlContactId}:`, error.message);
    return { isSpiking: false, eventCount: 0, inboundCount: 0, outcomeCount: 0, windowMinutes: 30 };
  }

  const events = data || [];
  const inboundCount = events.filter(e => INBOUND_ENGAGEMENT_EVENTS.includes(e.event_type)).length;
  const outcomeCount = events.filter(e => OUTCOME_EVENTS.includes(e.event_type)).length;
  const totalCount = events.length;

  // v1.1: Spike requires (a) total events ≥ threshold AND (b) at least one
  // genuine inbound engagement signal. Pure rep-side activity does NOT spike.
  const isSpiking = totalCount >= SPIKE_THRESHOLD && inboundCount >= 1;

  return {
    isSpiking,
    eventCount: totalCount,
    inboundCount,
    outcomeCount,
    windowMinutes: 30,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 2. INTENT SCORING — Composite Score
// ═══════════════════════════════════════════════════════════════════

function calculateIntentScore(intelligence, context, spike) {
  let score = 0;
  const sourceBonus = {
    'selfgen': 40, 'prevcust': 30, 'referral': 25, 'canvassing': 10,
    'estimate-calculator': 15, 'risk-report': 10, 'chatbot': 5, 'other': 0,
  };
  score += sourceBonus[intelligence?.entry_source || context?.lead?.entry_source || 'other'] || 0;

  score += Math.min((intelligence?.emails_opened || 0) * 3, 15);
  score += Math.min((intelligence?.links_clicked || 0) * 5, 15);
  score += intelligence?.vsl_watched ? 15 : 0;
  score += Math.min((intelligence?.replies_count || 0) * 8, 24);

  const stageBonus = { 1: 0, 2: 10, 3: 25, 4: 35, 5: 45 };
  score += stageBonus[intelligence?.buyer_stage || 1] || 0;
  score += intelligence?.fast_track_eligible ? 25 : 0;

  const buyingSignals = intelligence?.buying_signals;
  const signalCount = Array.isArray(buyingSignals) ? buyingSignals.length :
    (typeof buyingSignals === 'string' ? (() => { try { return JSON.parse(buyingSignals).length; } catch { return 0; } })() : 0);
  score += Math.min(signalCount * 5, 15);

  const dispBonus = {
    'Cnf': 25, 'Set': 15, 'Soft Confirm': 10, 'OPPFDN': 5, 'FDNS': 5,
    'Sale': 50, 'PM': 40, 'SW': 50, 'NoRehash': -5, 'CXL': -10,
    'NI': -20, 'NIS': -25, 'DNC': -100, 'NG': -100, 'BD': -100,
  };
  score += dispBonus[context?.lp?.disposition] || 0;

  if (context?.lp?.demo_completed) score += 15;
  else if (context?.lp?.appointment_set) score += 10;

  const lastEngagement = intelligence?.last_engagement_at;
  if (lastEngagement) {
    const daysSince = (Date.now() - new Date(lastEngagement).getTime()) / 86400000;
    if (daysSince <= 1) score += 10;
    else if (daysSince <= 3) score += 5;
    else if (daysSince <= 14) score -= 5;
    else if (daysSince <= 30) score -= 15;
    else score -= 25;
  } else { score -= 10; }

  const responseMin = intelligence?.response_velocity_minutes;
  if (responseMin != null) {
    if (responseMin < 30) score += 15;
    else if (responseMin < 120) score += 8;
    else if (responseMin < 1440) score += 3;
  }

  if (spike?.isSpiking) { score += 20; if (spike.eventCount >= 3) score += 10; }

  if (intelligence?.engagement_quality === 'dnc') return -100;
  if (intelligence?.engagement_quality === 'disengagement') score -= 20;
  if (intelligence?.objection_type === 'not-interested') score -= 30;

  return Math.max(-100, Math.min(100, score));
}

function classifyTier(score) {
  if (score >= 81) return 'imminent';
  if (score >= 51) return 'hot';
  if (score >= 21) return 'warm';
  return 'cold';
}

// ═══════════════════════════════════════════════════════════════════
// 3. PATTERN MATCHING
// ═══════════════════════════════════════════════════════════════════

function detectPattern(intelligence, context, spike) {
  if (spike?.isSpiking && (intelligence?.buyer_stage || 0) >= 2) return 'hot_window';
  if (context?.lp?.demo_completed && !context?.lp?.closed_won) {
    const lastReply = intelligence?.last_reply_at;
    if (!lastReply || (Date.now() - new Date(lastReply).getTime()) > 3 * 86400000) return 'demo_silent';
  }
  if ((intelligence?.buyer_stage || 0) >= 2 && (intelligence?.emails_opened || 0) >= 2 &&
      (intelligence?.days_in_current_stage || 0) >= 5 && !context?.lp?.appointment_set) return 'stalling_at_gate';
  if (context?.lp?.disposition === 'CXL' && (intelligence?.replies_count || 0) > 0) return 'cancel_rescue';
  if (intelligence?.objection_type === 'spouse' && context?.lp?.appointment_set) {
    const apptDate = new Date(context?.lp?.appointment_date || 0);
    if (apptDate > new Date()) return 'spouse_pre_detect';
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// 4. PSYCHOLOGICAL BARRIER
// ═══════════════════════════════════════════════════════════════════

function classifyBarrier(intelligence, context) {
  const stage = intelligence?.buyer_stage || 1;
  const objection = intelligence?.objection_type;
  const stallDays = intelligence?.days_in_current_stage || 0;
  const demoCompleted = context?.lp?.demo_completed || false;
  if (demoCompleted && !objection && stallDays >= 2) return 'sticker-shock';
  if (objection === 'spouse') return 'spouse-discussion';
  if (objection === 'timing') return 'timing';
  if (objection === 'price') return 'sticker-shock';
  if (stage >= 2 && stage <= 3 && stallDays >= 5 && !objection) return 'confusion';
  if (context?.lp?.disposition === 'CXL') return 'cold-feet';
  if ((intelligence?.emails_opened || 0) >= 2 && stallDays >= 7) return 'distraction';
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// 5. CLOSER ASSISTANT — Decision Ownership + Loss Framing
// ═══════════════════════════════════════════════════════════════════

function generateRepBriefing(intelligence, context) {
  const parts = [];
  const objection = intelligence?.objection_type;
  const source = intelligence?.entry_source || context?.lead?.entry_source || 'unknown';
  const demoCompleted = context?.lp?.demo_completed || false;
  const isImminent = (intelligence?.intent_score || 0) >= 80 || intelligence?.fast_track_eligible;

  parts.push(`LEAD: ${context?.lead?.name || 'Unknown'} | Source: ${source} | Stage ${intelligence?.buyer_stage || '?'} | Score: ${intelligence?.intent_score || 0}`);
  if (context?.lp?.rep_name) parts.push(`Rep: ${context.lp.rep_name}`);

  if (objection === 'price') {
    parts.push('SAY FIRST: "Based on what you told us, I put together a few options — one that fits most budgets."');
    parts.push('ASSUME: They want this. Price is the last barrier, not a dealbreaker.');
    parts.push('AVOID: Never say "I understand it\'s expensive." That validates the objection.');
    parts.push('PUSH: "Most clients pay less per month than their cable bill. Want me to show you the breakdown?"');
    parts.push('LOSS FRAME: "Material costs reset quarterly — if we don\'t lock pricing now, your quote shifts with the next cycle."');
  } else if (objection === 'spouse') {
    parts.push('SAY FIRST: "We find the best results happen when both decision-makers see the options together."');
    parts.push('ASSUME: Both people will be present. Frame it as obvious, not optional.');
    parts.push('AVOID: Never say "Do you need to check with your spouse?" — that gives them an exit.');
    parts.push('PUSH: "I\'ve got an evening slot Thursday or Saturday morning — which works for both of you?"');
    parts.push('LOSS FRAME: "The longer this sits, the harder it is to coordinate — let\'s get it on the calendar while we\'re both thinking about it."');
  } else if (objection === 'timing') {
    parts.push('SAY FIRST: "I totally get it — most people start this process 8-12 weeks before they actually need it done."');
    parts.push('ASSUME: They ARE doing this, just not sure when. Reframe "later" as "now is actually later."');
    parts.push('AVOID: Never push a hard deadline they didn\'t set themselves.');
    parts.push('PUSH: "Getting measured now means you\'re ready before next hurricane season — and pricing is locked at today\'s rate."');
    parts.push('LOSS FRAME: "Every month you wait is a month closer to season with no protection. And material lead times only get longer."');
  } else if (objection === 'competitor') {
    parts.push('SAY FIRST: "Smart to compare — most of our clients did exactly that. Here\'s what they found."');
    parts.push('ASSUME: They\'re comparing because they\'re serious. That\'s Stage 3 — close to buying.');
    parts.push('AVOID: Never trash the competitor by name. Never say "they\'re bad." Position, don\'t attack.');
    parts.push('PUSH: "We never use subcontractors — every installer is our employee with 10+ years. Ask the other company who actually shows up to install."');
    parts.push('LOSS FRAME: "The company you choose is the one you\'ll call in 10 years when something needs service. We\'ve been here since 1972. Will they?"');
  } else if (objection === 'trust') {
    parts.push('SAY FIRST: "That\'s exactly why Randy Reece still runs every project review personally — 50 years of family reputation on the line."');
    parts.push('ASSUME: They want to trust someone. Give them a reason, not a pitch.');
    parts.push('AVOID: Never say "trust me" — show proof instead.');
    parts.push('PUSH: "I can show you 3 projects we completed on your street this year. Want to see the before/after?"');
    parts.push('LOSS FRAME: "The risk isn\'t choosing us — it\'s choosing a company that won\'t be around to honor the warranty."');
  } else if (objection === 'diy') {
    parts.push('SAY FIRST: "I respect that — but impact windows aren\'t like regular windows. The installation IS the product."');
    parts.push('ASSUME: They\'re capable but don\'t know what they don\'t know. Educate without condescending.');
    parts.push('AVOID: Never say "you can\'t do this yourself" — say "here\'s what most people don\'t realize."');
    parts.push('PUSH: "Incorrect installation voids the product warranty AND your insurance wind mitigation rating. One gap and you\'re unprotected."');
    parts.push('LOSS FRAME: "A failed inspection means ripping everything out and starting over — at 3x the cost."');
  } else if (demoCompleted) {
    parts.push('SAY FIRST: "I wanted to follow up on what we discussed — you mentioned [specific concern from notes]."');
    parts.push('ASSUME: The demo went well. They\'re processing, not rejecting.');
    parts.push('AVOID: Never re-pitch the full demo. Never ask "so what did you think?" — that invites hesitation.');
    parts.push('PUSH: "Based on what we measured, the next step is locking in your configuration before material pricing adjusts."');
    parts.push('LOSS FRAME: "Your quote is based on today\'s material costs. Every week that passes is a week closer to the next price adjustment."');
  } else {
    parts.push('SAY FIRST: "Based on what you\'ve been looking at, the next step is getting your home assessed — let\'s lock that in."');
    parts.push('ASSUME: They\'ve already decided they need this. The question is when, not if.');
    parts.push('AVOID: Never ask "are you interested?" — they already showed interest by engaging.');
    parts.push('PUSH: "I\'ve got one morning and one afternoon slot this week — which works better?"');
    parts.push('LOSS FRAME: "Homes without rated impact protection are the first to see insurance premium increases. Getting assessed now puts you ahead of that."');
  }

  if (context?.lp?.notes?.length) {
    parts.push(`\nREP NOTES: ${context.lp.notes.slice(0, 2).map(n => '"' + n.text + '"').join(' | ')}`);
  }

  if (isImminent) {
    parts.push('\n⚡ THIS LEAD IS READY. Own the decision:');
    parts.push('"I\'ve got Mark available [tomorrow/Thursday] — he\'ll have everything measured and quoted on the spot. Morning or afternoon?"');
    parts.push('Do NOT ask if they want to. The decision is made. You\'re scheduling logistics.');
  }

  return parts.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════

export async function scoreIntent(ghlContactId, context = null) {
  const { data: intelligence } = await supabase
    .from('lead_intelligence').select('*')
    .eq('ghl_contact_id', ghlContactId).maybeSingle();
  if (!intelligence) return null;

  const spike = await detectSpike(ghlContactId);
  const score = calculateIntentScore(intelligence, context, spike);
  const tier = classifyTier(score);
  const previousTier = intelligence.intent_tier || 'cold';
  const tierChanged = tier !== previousTier;
  const pattern = detectPattern(intelligence, context, spike);
  const barrier = classifyBarrier(intelligence, context);
  const briefing = (tier === 'hot' || tier === 'imminent') ? generateRepBriefing(intelligence, context) : null;

  const history = (() => {
    try {
      return Array.isArray(intelligence.intent_score_history)
        ? intelligence.intent_score_history
        : JSON.parse(intelligence.intent_score_history || '[]');
    } catch { return []; }
  })();
  const now = new Date().toISOString();
  const newHistory = [{ score, timestamp: now }, ...history].slice(0, 10);

  let velocity = 0;
  if (newHistory.length >= 2) {
    const oldest = newHistory[newHistory.length - 1];
    const hoursSpan = (Date.now() - new Date(oldest.timestamp).getTime()) / 3600000;
    if (hoursSpan >= 1) velocity = ((score - oldest.score) / hoursSpan) * 24;
  }
  const cappedVelocity = Math.max(-999, Math.min(999, Math.round(velocity * 100) / 100));

  await upsertLeadIntelligence(ghlContactId, {
    intent_score: score, intent_tier: tier, intent_velocity: cappedVelocity,
    compound_pattern: pattern,
    pattern_matched_at: pattern ? now : intelligence.pattern_matched_at,
    psychological_barrier: barrier, spike_event_count: spike.eventCount,
    spike_window_start: spike.isSpiking ? (intelligence.spike_window_start || now) : null,
    rep_briefing: briefing, intent_score_history: JSON.stringify(newHistory),
  });

  if (tierChanged) {
    await emitEvent({
      event_type: 'intent.tier_changed', event_subtype: `${previousTier}_to_${tier}`,
      source: 'intent_scorer', entity_type: 'contact', entity_id: ghlContactId,
      ghl_contact_id: ghlContactId,
      payload: { previous_tier: previousTier, new_tier: tier, score, velocity: cappedVelocity, pattern, barrier, briefing: briefing?.slice(0, 500) },
      priority: tier === 'imminent' ? 'critical' : tier === 'hot' ? 'high' : 'normal',
      idempotency_key: `intent_tier_${ghlContactId}_${tier}_${Date.now()}`,
    });
    console.log(`[IntentScorer] 🎯 TIER CHANGE: ${ghlContactId} ${previousTier} → ${tier} (score: ${score})`);
  }

  if (spike.isSpiking && spike.eventCount === SPIKE_THRESHOLD) {
    await emitEvent({
      event_type: 'intent.spike_detected', event_subtype: 'hot_window',
      source: 'intent_scorer', entity_type: 'contact', entity_id: ghlContactId,
      ghl_contact_id: ghlContactId,
      payload: {
        event_count: spike.eventCount,
        inbound_count: spike.inboundCount,         // v1.1
        outcome_count: spike.outcomeCount,         // v1.1
        window_minutes: spike.windowMinutes, score, tier,
      },
      priority: 'critical',
      idempotency_key: `intent_spike_${ghlContactId}_${Date.now()}`,
    });
    console.log(`[IntentScorer] 🔥 SPIKE: ${ghlContactId} — ${spike.eventCount} events (${spike.inboundCount} inbound + ${spike.outcomeCount} outcome) in ${spike.windowMinutes}min`);
  } else if (spike.eventCount >= SPIKE_THRESHOLD && spike.inboundCount === 0) {
    // v1.1: log when we suppress a spike for the canvassing/rep-driven case.
    // Helps Mark see that the new gate is working without drowning the alert
    // channel.
    console.log(`[IntentScorer] Spike suppressed for ${ghlContactId}: ${spike.eventCount} events but 0 inbound engagement (rep-driven activity only)`);
  }

  return { score, tier, previousTier, tierChanged, pattern, barrier, spike, briefing, velocity: cappedVelocity };
}

// ═══════════════════════════════════════════════════════════════════
// STALL DETECTOR (Proactive sweep — cron)
// ═══════════════════════════════════════════════════════════════════

export async function sweepForStalls({ limit = 50 } = {}) {
  const startTime = Date.now();
  const { data: stallingLeads, error } = await supabase
    .from('lead_intelligence')
    .select('ghl_contact_id, buyer_stage, intent_score, intent_tier, last_engagement_at, emails_opened, replies_count, days_in_current_stage, objection_type, compound_pattern')
    .gte('emails_opened', 1).is('compound_pattern', null)
    .gte('days_in_current_stage', 3).neq('intent_tier', 'cold')
    .order('intent_score', { ascending: false }).limit(limit);

  if (error || !stallingLeads?.length) return { stalls_found: 0, elapsed_ms: Date.now() - startTime };
  let emitted = 0;
  for (const lead of stallingLeads) {
    const daysSinceEngagement = lead.last_engagement_at
      ? (Date.now() - new Date(lead.last_engagement_at).getTime()) / 86400000 : 999;
    if (lead.buyer_stage >= 2 && lead.days_in_current_stage >= 5 && daysSinceEngagement <= 14) {
      await emitEvent({
        event_type: 'intent.stall_detected', event_subtype: 'stalling_at_gate',
        source: 'intent_scorer', entity_type: 'contact', entity_id: lead.ghl_contact_id,
        ghl_contact_id: lead.ghl_contact_id,
        payload: { buyer_stage: lead.buyer_stage, days_stalling: lead.days_in_current_stage, intent_score: lead.intent_score },
        priority: 'normal',
        idempotency_key: `stall_${lead.ghl_contact_id}_${Math.floor(Date.now() / 86400000)}`,
      });
      await upsertLeadIntelligence(lead.ghl_contact_id, {
        compound_pattern: 'stalling_at_gate', pattern_matched_at: new Date().toISOString(), psychological_barrier: 'confusion',
      });
      emitted++;
    }
  }
  console.log(`[IntentScorer] Stall sweep: ${stallingLeads.length} checked, ${emitted} stalling`);
  return { checked: stallingLeads.length, stalls_found: emitted, elapsed_ms: Date.now() - startTime };
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS ROUTES
// ═══════════════════════════════════════════════════════════════════

export function registerIntentScorerRoutes(app) {
  app.post('/n8n/intent/score', async (req, res) => {
    const contactId = req.body?.contactId;
    if (!contactId) return res.status(400).json({ error: 'contactId required' });
    try { res.json({ success: true, ...(await scoreIntent(contactId)) }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.post('/n8n/intent/sweep', async (req, res) => {
    try { res.json({ success: true, ...(await sweepForStalls({ limit: req.body?.limit || 50 })) }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.get('/n8n/intent/breakdown', async (req, res) => {
    const contactId = req.query.contactId;
    if (!contactId) return res.status(400).json({ error: 'contactId required' });
    try {
      const { data } = await supabase.from('lead_intelligence')
        .select('intent_score, intent_tier, intent_velocity, compound_pattern, psychological_barrier, spike_event_count, rep_briefing, intent_score_history')
        .eq('ghl_contact_id', contactId).maybeSingle();
      res.json(data || { status: 'no_data' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}
