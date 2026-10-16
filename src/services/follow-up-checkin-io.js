/**
 * follow-up-checkin-io.js — production deps for the follow-up check-in
 * (src/agentic/follow-up-checkin.js, 2026-10-16). Kept apart so the module
 * itself stays testable without GHL, Supabase or a model.
 */

import { generateFollowUpCheckIn } from '../agentic/follow-up-checkin.js';
import { readRecentHolds } from '../agentic/hold-complete.js';
import { buildLeadContext } from '../context-builder.js';
import { callLLM } from '../llm-client.js';

export const followUpCheckInDeps = Object.freeze({
  readHolds: (contactId) => readRecentHolds(contactId),
  // A fresh read: the conversation may have moved on during a weeks-long hold.
  buildContext: (contactId) => buildLeadContext(contactId, { skipCache: true }),
  callLLM,
});

export function writeFollowUpCheckIn(params, deps = followUpCheckInDeps) {
  return generateFollowUpCheckIn(params, deps);
}
