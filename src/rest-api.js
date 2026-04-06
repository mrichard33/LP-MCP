/**
 * REST API for GHL Agent Studio — src/rest-api.js
 *
 * Lightweight REST endpoints that wrap Supabase queries so GHL Agent Studio
 * API call nodes can fetch LP data without speaking MCP protocol.
 *
 * Routes:
 *   GET /api/prospects/:prospectId   — LP prospect by cst_id
 *   GET /api/leads/:leadId           — LP lead by lds_id
 *   GET /api/search?phone=...        — Search by phone (E.164 or digits)
 *   GET /api/search?ghlContactId=... — Search by GHL contact ID
 *   GET /api/search?email=...        — Search by email
 *   GET /api/search?name=...         — Search by name (first or last)
 *   GET /api/lead-summary/:contactId — Full lead intelligence summary
 */

import supabase from './supabase.js';

export function registerRestApiRoutes(app, authenticate) {

  // ─── GET /api/prospects/:prospectId ────────────────────────────
  // Returns all leads for an LP prospect (cst_id)
  app.get('/api/prospects/:prospectId', authenticate, async (req, res) => {
    try {
      const { prospectId } = req.params;
      if (!prospectId) return res.status(400).json({ error: 'prospectId is required' });

      const { data, error } = await supabase
        .from('lp_leads')
        .select('*')
        .eq('lp_prospect_id', prospectId)
        .order('synced_at', { ascending: false });

      if (error) return res.status(500).json({ error: error.message });
      if (!data || data.length === 0) return res.status(404).json({ error: 'No leads found for prospect', prospectId, match_count: 0 });

      res.json({ match_count: data.length, best_match: data[0], all_leads: data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/leads/:leadId ────────────────────────────────────
  // Returns a single LP lead by lds_id
  app.get('/api/leads/:leadId', authenticate, async (req, res) => {
    try {
      const { leadId } = req.params;
      if (!leadId) return res.status(400).json({ error: 'leadId is required' });

      const { data, error } = await supabase
        .from('lp_leads')
        .select('*')
        .eq('lp_lead_id', leadId)
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'Lead not found', leadId, match_count: 0 });

      res.json({ match_count: 1, best_match: data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/search?phone=...&ghlContactId=...&email=...&name=... ─
  // Multi-field search — returns matching LP leads
  app.get('/api/search', authenticate, async (req, res) => {
    try {
      const { phone, ghlContactId, email, name } = req.query;

      if (!phone && !ghlContactId && !email && !name) {
        return res.status(400).json({ error: 'At least one search param required: phone, ghlContactId, email, or name' });
      }

      let query = supabase.from('lp_leads').select('*');

      if (ghlContactId) {
        query = query.eq('ghl_contact_id', ghlContactId);
      } else if (phone) {
        // Strip to digits for flexible matching
        const digits = phone.replace(/\D/g, '');
        const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
        // Try exact match first, then partial
        query = query.or(`phone.ilike.%${last10}%,phone_alt.ilike.%${last10}%`);
      } else if (email) {
        query = query.ilike('email', `%${email}%`);
      } else if (name) {
        query = query.or(`first_name.ilike.%${name}%,last_name.ilike.%${name}%`);
      }

      query = query.order('synced_at', { ascending: false }).limit(10);
      const { data, error } = await query;

      if (error) return res.status(500).json({ error: error.message });
      if (!data || data.length === 0) {
        return res.json({ match_count: 0, best_match: null, all_leads: [], search_params: { phone, ghlContactId, email, name } });
      }

      res.json({ match_count: data.length, best_match: data[0], all_leads: data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/lead-summary/:contactId ──────────────────────────
  // Full intelligence summary: LP lead + jobs + milestones + call logs + intent
  app.get('/api/lead-summary/:contactId', authenticate, async (req, res) => {
    try {
      const { contactId } = req.params;
      if (!contactId) return res.status(400).json({ error: 'contactId is required' });

      // Get LP lead
      const { data: leads } = await supabase
        .from('lp_leads')
        .select('*')
        .eq('ghl_contact_id', contactId)
        .order('synced_at', { ascending: false })
        .limit(1);

      const lead = leads?.[0] || null;

      // Get lead intelligence
      const { data: intel } = await supabase
        .from('lead_intelligence')
        .select('*')
        .eq('ghl_contact_id', contactId)
        .maybeSingle();

      // Get jobs if LP lead found
      let jobs = [];
      if (lead?.lp_lead_id) {
        const { data: j } = await supabase
          .from('lp_jobs')
          .select('*')
          .eq('lp_lead_id', lead.lp_lead_id);
        jobs = j || [];
      }

      // Get recent call logs
      let calls = [];
      if (lead?.lp_lead_id) {
        const { data: c } = await supabase
          .from('lp_call_logs')
          .select('*')
          .eq('lp_lead_id', lead.lp_lead_id)
          .order('call_date', { ascending: false })
          .limit(10);
        calls = c || [];
      }

      if (!lead && !intel) {
        return res.status(404).json({ error: 'No LP or intelligence data found', contactId });
      }

      res.json({
        contactId,
        lp_lead: lead,
        intelligence: intel ? {
          intent_score: intel.intent_score,
          intent_tier: intel.intent_tier,
          buyer_stage: intel.buyer_stage,
          primary_objection: intel.primary_objection,
          recommended_approach: intel.recommended_approach,
          spike_count: intel.spike_count,
          engagement_count: intel.engagement_count,
          last_engagement: intel.last_engagement_at,
        } : null,
        jobs,
        recent_calls: calls,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log('[REST API] Registered: GET /api/prospects/:id | /api/leads/:id | /api/search | /api/lead-summary/:contactId');
}
