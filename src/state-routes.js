/**
 * State Routes — src/state-routes.js
 *
 * Read-side surface for the objection-state substrate (Spec v1.2).
 *
 * Public-ish GET endpoint used by GHL workflows as a race-window safety net
 * when the mirrored `objection_state_code` custom field hasn't yet been
 * populated (or is suspected stale).
 *
 *   GET /state/current?contact_id=<id>
 *     → 200 { state_code, parent_state, entered_at,
 *             recovery_attempt_number, parent_attempt_number,
 *             nuance_tags, trigger_source }
 *     → 200 { state_code: null }  (no active state)
 *     → 400 { error: 'contact_id required' }
 *
 * 2026-05-14 — initial version (S5.2 v2 build handoff).
 */

import supabase from './supabase.js';

export function registerStateRoutes(app) {
  app.get('/state/current', async (req, res) => {
    const contact_id = (req.query.contact_id || '').toString().trim();
    if (!contact_id) {
      return res.status(400).json({ error: 'contact_id required' });
    }

    try {
      const { data, error } = await supabase
        .from('contact_objection_states')
        .select('state_code, parent_state, entered_at, recovery_attempt_number, parent_attempt_number, nuance_tags, trigger_source, classifier_confidence, classifier_version, triggering_event_id')
        .eq('contact_id', contact_id)
        .is('exited_at', null)
        .maybeSingle();

      if (error) {
        console.error('[state-routes] /state/current error:', error.message);
        return res.status(500).json({ error: error.message });
      }

      if (!data) return res.json({ state_code: null });
      res.json(data);
    } catch (err) {
      console.error('[state-routes] /state/current threw:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Diagnostics: history for a contact (most-recent first, max 50).
  app.get('/state/history', async (req, res) => {
    const contact_id = (req.query.contact_id || '').toString().trim();
    if (!contact_id) return res.status(400).json({ error: 'contact_id required' });
    try {
      const { data, error } = await supabase
        .from('contact_objection_states')
        .select('id, state_code, parent_state, entered_at, exited_at, resolution, recovery_attempt_number, parent_attempt_number, trigger_source, nuance_tags')
        .eq('contact_id', contact_id)
        .order('entered_at', { ascending: false })
        .limit(50);
      if (error) return res.status(500).json({ error: error.message });
      res.json({ contact_id, history: data || [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
