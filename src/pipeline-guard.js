/**
 * Pipeline Forward-Only Guard — src/pipeline-guard.js
 *
 * Prevents move_opportunity actions from moving an opportunity
 * backward in a pipeline. Used by action-executor.js to ensure
 * milestone-driven P2 advancement is always forward.
 *
 * v2.0 — Canonicalized to Antifragile (TOFU/MOFU/BOFU/SOFU) post-rename
 *        2026-05-06. Pairs with allow_backward bypass in handler.
 * v1.0 — Initial build. Stage positions from live GHL pipeline data.
 */

// Stage ID → position index (canonical Antifragile order, verified May 7 2026
// against live GHL pipelines). Higher position = further in lifecycle.
// Stages from different pipelines can share position numbers — comparison
// only valid within same pipeline.
const STAGE_POSITIONS = {
  // P1 — Antifragile Buyer Activation (12 stages, positions 0-11)
  // TOFU: 0-2 | MOFU: 3-5 | BOFU: 6-9 | SOFU: 10-11
  '793f72f8-08b3-4d0a-9227-a646f1fdc7f6': 0,   // 0. Lead Captured
  '0afdc1bc-2859-4696-ab13-07f8c59e457e': 1,   // 1. High-Intent Qualified
  '9a3fec61-4057-4b30-bb23-5b5f57702d4d': 2,   // 2. Re-engagement (S1.x)
  '67f50407-f004-47b3-ad70-83e0eccbe2d1': 3,   // 3. Indoctrination
  '538d9a8e-4b38-4331-9711-87f40a6dd4ef': 4,   // 4. Solution Education
  'a75f34d2-b38d-4edd-ac98-4a89304be71c': 5,   // 5. Solution Pitch (S3.x)
  '79ab10fd-5294-4330-b4ac-91b2df7c7d3a': 6,   // 6. Appointment Booked (A.x)
  '656c8446-da9b-4c97-add8-ba50d8319b84': 7,   // 7. Appointment Completed
  '10776799-ee76-409f-a630-9c496e5d708e': 8,   // 8. Proposal Delivered
  '2f7396e6-c51f-41f8-85f2-c2896733889f': 9,   // 9. Sale Recorded
  '8a17a6ab-56ff-47b2-9c61-77b8ded7e479': 10,  // 10. Reactivation (S5.x)
  '36ccbca0-c57f-466a-bd66-c7aa2a91e79d': 11,  // 11. Long-Term Hold

  // P2 — Client Lifecycle (8 stages, positions 0-7)
  'fec39f2e-ba39-4536-95b2-bbac7ca6c454': 0,   // 1. Contract Signed
  'b7fc445c-a969-42b1-9a7a-eda5c89f25a5': 1,   // 2. Financing Pending
  '375089e1-aaa5-429f-8c4c-5e01058fa8f8': 2,   // 3. Financing Approved
  '561f35fe-3632-40e9-bf0d-b9061bdf2589': 3,   // 4. Permitting & HOA
  '6b89bc8d-067a-41fb-a76c-fc0c9feaaf92': 4,   // 5. In Production
  'd852ba71-c6f5-422b-9c74-33b6036c69a5': 5,   // 6. Install Scheduled
  '5fc94c74-d136-481e-b8ca-2200817111af': 6,   // 7. Install Completed
  '053a0020-0f96-4a22-8717-8814c3ca1ff8': 7,   // 8. Referral & Expansion

  // P3 — Recycle / Lost / Deferred (6 stages, positions 0-5)
  '3b786609-dec8-411f-9318-8b63778aa4cb': 0,   // 0. Deferred (Timing)
  'e0bde70a-f32f-4b6d-88b2-be0c89c46852': 1,   // 1. Not Interested (Cooling)
  'fda5f000-19a7-420f-935a-f1f2de0c7675': 2,   // 2. Reactivation Queue
  'f9cd1a23-a6f9-452c-b129-c47d5a14a6bd': 3,   // 3. Bad Fit / Wrong Home
  '6194a841-8f59-4164-adee-dc0bd99510dc': 4,   // 4. Hard Disqualified
  '5f332652-b8c1-4a67-ba30-dc3450a3e039': 5,   // 5. Do Not Contact
};

/**
 * Check if moving from currentStageId to targetStageId is a forward move.
 *
 * @param {string} currentStageId — The opp's current pipelineStageId
 * @param {string} targetStageId — The stage we want to move to
 * @returns {{ allowed: boolean, currentPos: number|null, targetPos: number|null, reason: string }}
 */
export function checkForwardOnly(currentStageId, targetStageId) {
  const currentPos = STAGE_POSITIONS[currentStageId];
  const targetPos = STAGE_POSITIONS[targetStageId];

  // If either stage is unknown, allow the move (don't block on missing data)
  if (currentPos === undefined || targetPos === undefined) {
    return { allowed: true, currentPos: currentPos ?? null, targetPos: targetPos ?? null, reason: 'unknown_stage_position' };
  }

  // Same stage — skip (no-op)
  if (targetPos === currentPos) {
    return { allowed: false, currentPos, targetPos, reason: 'already_at_target_stage' };
  }

  // Backward — block
  if (targetPos < currentPos) {
    return { allowed: false, currentPos, targetPos, reason: 'target_is_backward' };
  }

  // Forward — allow
  return { allowed: true, currentPos, targetPos, reason: 'forward_move' };
}
