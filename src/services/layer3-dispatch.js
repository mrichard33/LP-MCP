/**
 * Layer 3 Dispatch — src/services/layer3-dispatch.js
 *
 * Single source of truth for what each Layer 3 recommended_action triggers.
 * Reads layer3_action_dispatch and applies a confidence gate.
 *
 * Confidence: takes the max of any *_confidence numeric fields on the event
 * payload (objection_confidence, buyer_stage_confidence, intent_confidence,
 * etc.). If none are present, defaults to 1.0 — analyzers that don't emit
 * confidence are trusted as-is. Gate compares against row.min_confidence.
 */

import supabase from '../supabase.js';

export async function getDispatchForClassification(payload) {
  if (!supabase) return { dispatch: null, reason: 'no_supabase' };
  const recommended = payload?.recommended_action;
  if (!recommended) return { dispatch: null, reason: 'no_recommended_action' };

  const { data, error } = await supabase
    .from('layer3_action_dispatch')
    .select('*')
    .eq('recommended_action', recommended)
    .eq('active', true)
    .maybeSingle();

  if (error) {
    console.error(`[layer3-dispatch] fetch error for ${recommended}: ${error.message}`);
    return { dispatch: null, reason: 'fetch_error', error: error.message };
  }
  if (!data) return { dispatch: null, reason: 'no_active_dispatch_row', recommended_action: recommended };

  const confidences = Object.entries(payload || {})
    .filter(([k, v]) => k.endsWith('_confidence') && typeof v !== 'object' && Number.isFinite(Number(v)))
    .map(([, v]) => Number(v));
  const confidence = confidences.length ? Math.max(...confidences) : 1.0;

  const threshold = Number(data.min_confidence);
  if (confidence < threshold) {
    return {
      dispatch: null,
      reason: 'below_confidence_threshold',
      confidence, threshold, recommended_action: recommended,
    };
  }

  return { dispatch: data, confidence, threshold };
}
