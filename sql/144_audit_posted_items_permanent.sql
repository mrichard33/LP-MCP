-- ════════════════════════════════════════════════════════════════════
-- sql/144 — audit_posted_items.permanent (2026-10-02)
--
-- Additive. Mirrored in src/admin/startup-mirrors.js.
--
-- WHY
--   The drift card ("GHL closed / LP active") posts ONCE per contact, ever —
--   even if the contact clears and drifts again, even across redeploys (Mark,
--   2026-10-02). audit_posted_items (sql/143) expires its rows after a TTL, so
--   a drift row needs to be exempt. Rather than a second store, a row can now
--   be permanent: src/alert-posted.js never deletes or ages one out.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE audit_posted_items ADD COLUMN IF NOT EXISTS permanent boolean NOT NULL DEFAULT false;
