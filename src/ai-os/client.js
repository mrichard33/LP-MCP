import { createClient } from '@supabase/supabase-js';

const AI_OS_SUPABASE_URL = process.env.AI_OS_SUPABASE_URL;
const AI_OS_SUPABASE_SERVICE_ROLE_KEY = process.env.AI_OS_SUPABASE_SERVICE_ROLE_KEY;

if (!AI_OS_SUPABASE_URL || !AI_OS_SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[AI OS] Missing AI_OS_SUPABASE_URL or AI_OS_SUPABASE_SERVICE_ROLE_KEY. ai_os_context will return unavailable until configured.');
}

const aiOsSupabase = AI_OS_SUPABASE_URL && AI_OS_SUPABASE_SERVICE_ROLE_KEY
  ? createClient(AI_OS_SUPABASE_URL, AI_OS_SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

export default aiOsSupabase;
