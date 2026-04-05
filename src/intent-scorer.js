/**
 * Intent Scorer — src/intent-scorer.js
 * 
 * The PROACTIVE layer. Runs on every behavioral event to:
 * 
 *   1. SPIKE DETECTION (Hot Window Protocol)
 *      Count events per contact in 30-min windows. 2+ events = buying window.
 *      Fires immediately — not on the next heartbeat.
 * 
 *   2. INTENT SCORING (Composite Score 0-100)
 *      Stacks signals from LP, GHL, AI analysis, engagement, and timing.
 *      Every signal adds/removes points. Score = conversion probability proxy.
 * 
 *   3. TIER CLASSIFICATION + TRANSITION DETECTION
 *      cold (0-20) → warm (21-50) → hot (51-80) → imminent (81+)
 *      Emits intent.tier_changed event on transitions for downstream rules.
 * 
 *   4. PATTERN MATCHING (Compound Signal Detection)
 *      Identifies multi-signal patterns: hot_window, demo_silent, stalling_at_gate,
 *      cancel_rescue, spouse_pre_detect.
 * 
 *   5. CLOSER ASSISTANT (Rep Briefing Generator)
 *      When tier = imminent, generates a specific script recommendation
 *      based on objections, stage, source, and engagement history.
 * 
 * Philosophy: "Predict → Intercept → Close" — not "Detect → Respond"
 */

import supabase from './supabase.js';
import { upsertLeadIntelligence } from './context-builder.js';
import { emitEvent } from './event-emitter.js';

// ═══════════════════════════════════════════════════════════════════
// 1. SPIKE DETECTION — Hot Window Protocol
// ═══════════════════════════════════════════════════════════════════

const SPIKE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const SPIKE_THRESHOLD = 2;

async function detectSpike(ghlContactId) {
  const windowStart = new Date(Date.now() - SPIKE_WINDOW_MS).toISOString();

  const { count, error } = await supabase
    .from('system_events')
    .select('id', { count: 'exact', head: true })
    .eq('ghl_contact_id', ghlContactId)
    .gte('created_at', windowStart)
    .in('event_type', [
      'ghl.reply_received', 'ghl.email_opened', 'ghl.link_clicked',
      'ghl.vsl_watched', 'ghl.appointment_booked', 'ghl.lead_score_changed',
      'ai.analysis_completed'
    ]);

  const eventCount = error ? 0 : (count || 0);
  return {
    isSpiking: eventCount >= SPIKE_THRESHOLD,
    eventCount,
    windowMinutes: 30,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 2. INTENT SCORING — Composite Score
// ═══════════════════════════════════════════════════════════════════

function calculateIntentScore(intelligence, context, spike) {
  let score = 0;

  // ─── Source Baseline ──────────────────────────────────
  const sourceBonus = {
    'selfgen': 40, 'prevcust': 30, 'referral': 25,
    'canvassing': 10, 'estimate-calculator': 15,
    'risk-report': 10, 'chatbot': 5, 'other': 0,
  };
  const source = intelligence?.entry_source || context?.lead?.entry_source || 'other';
  score += sourceBonus[source] || 0;

  // ─── Engagement Signals ───────────────────────────────
  score += Math.min((intelligence?.emails_opened || 0) * 3, 15);
  score += Math.min((intelligence?.links_clicked || 0) * 5, 15);
  score += intelligence?.vsl_watched ? 15 : 0;
  score += Math.min((intelligence?.replies_count || 0) * 8, 24);

  // ─── AI Analysis Signals ──────────────────────────────
  const buyerStage = intelligence?.buyer_stage || 1;
  const stageBonus = { 1: 0, 2: 10, 3: 25, 4: 35, 5: 45 };
  score += stageBonus[buyerStage] || 0;
  score += intelligence?.fast_track_eligible ? 25 : 0;

  const buyingSignals = intelligence?.buying_signals;
  const signalCount = Array.isArray(buyingSignals) ? buyingSignals.length :
    (typeof buyingSignals === 'string' ? (() => { try { return JSON.parse(buyingSignals).length; } catch { return 0; } })() : 0);
  score += Math.min(signalCount * 5, 15);

  // ─── LP Disposition Signals ───────────────────────────
  const disp = context?.lp?.disposition;
  const dispBonus = {
    'Cnf': 25, 'Set': 15, 'Soft Confirm': 10,
    'OPPFDN': 5, 'FDNS': 5, 'Sale': 50, 'PM': 40, 'SW': 50,
    'NoRehash': -5, 'CXL': -10, 'NI': -20, 'NIS': -25,
    'DNC': -100, 'NG': -100, 'BD': -100,
  };
  score += dispBonus[disp] || 0;

  // ─── Demo / Appointment Status ────────────────────────
  if (context?.lp?.demo_completed) score += 15;
  else if (context?.lp?.appointment_set) score += 10;

  // ─── Recency Decay ────────────────────────────────────
  const lastEngagement = intelligence?.last_engagement_at;
  if (lastEngagement) {
    const daysSince = (Date.now() - new Date(lastEngagement).getTime()) / 86400000;
    if (daysSince <= 1) score += 10;
    else if (daysSince <= 3) score += 5;
    else if (daysSince <= 14) score -= 5;
    else if (daysSince <= 30) score -= 15;
    else score -= 25;
  } else {
    score -= 10;
  }

  // ─── Response Velocity Bonus ──────────────────────────
  const responseMin = intelligence?.response_velocity_minutes;
  if (responseMin != null) {
    if (responseMin < 30) score += 15;
    else if (responseMin < 120) score += 8;
    else if (responseMin < 1440) score += 3;
  }

  // ─── SPIKE BONUS (Hot Window Protocol) ────────────────
  if (spike?.isSpiking) {
    score += 20;
    if (spike.eventCount >= 3) score += 10;
  }

  // ─── Negative Signals ─────────────────────────────────
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

  if ((intelligence?.buyer_stage || 0) >= 2 &&
      (intelligence?.emails_opened || 0) >= 2 &&
      (intelligence?.days_in_current_stage || 0) >= 5 &&
      !context?.lp?.appointment_set) return 'stalling_at_gate';

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
// 5. CLOSER ASSISTANT — Rep Briefing
// ═══════════════════════════════════════════════════════════════════

function generateRepBriefing(intelligence, context) {
  const parts = [];
  const objection = intelligence?.objection_type;
  const source = intelligence?.entry_source || context?.lead?.entry_source || 'unknown';
  const demoCompleted = context?.lp?.demo_completed || false;

  parts.push(`LEAD: ${context?.lead?.name || 'Unknown'} | Source: ${source} | Stage ${intelligence?.buyer_stage || '?'}`);
  if (context?.lp?.rep_name) parts.push(`Assigned Rep: ${context.lp.rep_name}`);

  if (objection === 'price') {
    parts.push('APPROACH: Lead with financing + ROI. "Most clients pay less per month than their cable bill." Use SA3 — someone saved $500 upfront, spent $15K fixing water damage.');
  } else if (objection === 'spouse') {
    parts.push('APPROACH: "Best if both decision-makers are present — can we find a time for both of you?" Offer evening/weekend.');
  } else if (objection === 'timing') {
    parts.push('APPROACH: Don\'t push timeline. "The process takes 8-12 weeks from order to install. Getting measured now means you\'re ready before next hurricane season."');
  } else if (objection === 'competitor') {
    parts.push('APPROACH: Don\'t trash competitors. "We never use subcontractors — every installer is our employee. Ask the other company who actually installs." 50-year track record.');
  } else if (objection === 'trust') {
    parts.push('APPROACH: Authority first. "We\'ve been doing this since 1972. Randy Reece\'s family. We\'re not going anywhere." Offer to show local projects.');
  } else if (objection === 'diy') {
    parts.push('APPROACH: "Incorrect installation voids the warranty AND your insurance rating. One mistake and you\'re unprotected." Lead with code compliance.');
  } else if (demoCompleted) {
    parts.push('APPROACH: Demo already ran. Follow up on specific concerns. Personalize — don\'t re-pitch.');
  } else {
    parts.push('APPROACH: Discovery mode. Find the emotional driver. Listen more than talk.');
  }

  if (context?.lp?.notes?.length) {
    parts.push(`REP NOTES: ${context.lp.notes.slice(0, 2).map(n => '"' + n.text + '"').join(' | ')}`);
  }

  if (intelligence?.fast_track_eligible || (intelligence?.intent_score || 0) >= 80) {
    parts.push('⚡ READY TO CLOSE. Be assumptive: "I\'ve got [time] open — let\'s get you on the schedule." Don\'t ask IF — ask WHEN.');
  }

  return parts.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════

export async function scoreIntent(ghlContactId, context = null) {
  const { data: intelligence } = await supabase
    .from('lead_intelligence')
    .select('*')
    .eq('ghl_contact_id', ghlContactId)
    .maybeSingle();

  if (!intelligence) return null;

  const spike = await detectSpike(ghlContactId);
  const score = calculateIntentScore(intelligence, context, spike);
  const tier = classifyTier(score);
  const previousTier = intelligence.intent_tier || 'cold';
  const tierChanged = tier !== previousTier;
  const pattern = detectPattern(intelligence, context, spike);
  const barrier = classifyBarrier(intelligence, context);
  const briefing = (tier === 'hot' || tier === 'imminent') ? generateRepBriefing(intelligence, context) : null;

  // Velocity calculation
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
    if (hoursSpan > 0) velocity = ((score - oldest.score) / hoursSpan) * 24;
  }

  await upsertLeadIntelligence(ghlContactId, {
    intent_score: score,
    intent_tier: tier,
    intent_velocity: Math.round(velocity * 100) / 100,
    compound_pattern: pattern,
    pattern_matched_at: pattern ? now : intelligence.pattern_matched_at,
    psychological_barrier: barrier,
    spike_event_count: spike.eventCount,
    spike_window_start: spike.isSpiking ? (intelligence.spike_window_start || now) : null,
    rep_briefing: briefing,
    intent_score_history: JSON.stringify(newHistory),
  });

  if (tierChanged) {
    await emitEvent({
      event_type: 'intent.tier_changed',
      event_subtype: `${previousTier}_to_${tier}`,
      source: 'intent_scorer',
      entity_type: 'contact',
      entity_id: ghlContactId,
      ghl_contact_id: ghlContactId,
      payload: {
        previous_tier: previousTier, new_tier: tier, score, velocity,
        pattern, barrier, briefing: briefing?.slice(0, 500),
      },
      priority: tier === 'imminent' ? 'critical' : tier === 'hot' ? 'high' : 'normal',
      idempotency_key: `intent_tier_${ghlContactId}_${tier}_${Date.now()}`,
    });
    console.log(`[IntentScorer] 🎯 TIER CHANGE: ${ghlContactId} ${previousTier} → ${tier} (score: ${score})`);
  }

  if (spike.isSpiking && spike.eventCount === SPIKE_THRESHOLD) {
    await emitEvent({
      event_type: 'intent.spike_detected',
      event_subtype: 'hot_window',
      source: 'intent_scorer',
      entity_type: 'contact',
      entity_id: ghlContactId,
      ghl_contact_id: ghlContactId,
      payload: { event_count: spike.eventCount, window_minutes: spike.windowMinutes, score, tier },
      priority: 'critical',
      idempotency_key: `intent_spike_${ghlContactId}_${Date.now()}`,
    });
    console.log(`[IntentScorer] 🔥 SPIKE: ${ghlContactId} — ${spike.eventCount} events in ${spike.windowMinutes}min`);
  }

  return { score, tier, previousTier, tierChanged, pattern, barrier, spike, briefing, velocity };
}

// ═══════════════════════════════════════════════════════════════════
// STALL DETECTOR (Proactive sweep — cron)
// ═══════════════════════════════════════════════════════════════════

export async function sweepForStalls({ limit = 50 } = {}) {
  const startTime = Date.now();

  const { data: stallingLeads, error } = await supabase
    .from('lead_intelligence')
    .select('ghl_contact_id, buyer_stage, intent_score, intent_tier, last_engagement_at, emails_opened, replies_count, days_in_current_stage, objection_type, compound_pattern')
    .gte('emails_opened', 1)
    .is('compound_pattern', null)
    .gte('days_in_current_stage', 3)
    .neq('intent_tier', 'cold')
    .order('intent_score', { ascending: false })
    .limit(limit);

  if (error || !stallingLeads?.length) return { stalls_found: 0, elapsed_ms: Date.now() - startTime };

  let emitted = 0;
  for (const lead of stallingLeads) {
    const daysSinceEngagement = lead.last_engagement_at
      ? (Date.now() - new Date(lead.last_engagement_at).getTime()) / 86400000 : 999;

    if (lead.buyer_stage >= 2 && lead.days_in_current_stage >= 5 && daysSinceEngagement <= 14) {
      await emitEvent({
        event_type: 'intent.stall_detected',
        event_subtype: 'stalling_at_gate',
        source: 'intent_scorer',
        entity_type: 'contact',
        entity_id: lead.ghl_contact_id,
        ghl_contact_id: lead.ghl_contact_id,
        payload: { buyer_stage: lead.buyer_stage, days_stalling: lead.days_in_current_stage, intent_score: lead.intent_score },
        priority: 'normal',
        idempotency_key: `stall_${lead.ghl_contact_id}_${Math.floor(Date.now() / 86400000)}`,
      });
      await upsertLeadIntelligence(lead.ghl_contact_id, {
        compound_pattern: 'stalling_at_gate',
        pattern_matched_at: new Date().toISOString(),
        psychological_barrier: 'confusion',
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
