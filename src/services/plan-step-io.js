/**
 * The previous reply's plan step — src/services/plan-step-io.js
 *
 * 2026-10-18 (Phase 1 item 4): "a no after our close" is read from the plan
 * step our LAST SENT reply to this contact ran on (bot_message_context.plan_step,
 * written by both bots), never from our own wording. This is the read.
 *
 * Only a sent reply counts (sent_at stamped): a draft that never went out, or
 * this same action's earlier attempt, is not "our previous reply". Fails soft
 * to null (the planner then reads the thread as before): a missing column
 * before the migration, a slow read (capped), any error.
 */

import supabase from '../supabase.js';

const READ_CAP_MS = Number(process.env.PLAN_STEP_READ_MS || 800);

export async function readLastPlanStep(contactId, deps = {}) {
  const db = deps.supabase ?? supabase;
  if (!db || !contactId) return null;
  let timer;
  try {
    const read = db.from('bot_message_context').select('plan_step, generated_at')
      .eq('ghl_contact_id', contactId).eq('message_type', 'reply').not('sent_at', 'is', null)
      .order('generated_at', { ascending: false }).limit(1);
    const res = await Promise.race([read, new Promise(r => { timer = setTimeout(() => r({ timedOut: true }), READ_CAP_MS); })]);
    if (res?.timedOut || res?.error || !Array.isArray(res?.data)) return null;
    const step = res.data[0]?.plan_step;
    return step ? String(step) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default { readLastPlanStep };
