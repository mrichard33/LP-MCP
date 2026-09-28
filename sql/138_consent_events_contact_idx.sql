-- ════════════════════════════════════════════════════════════════════
-- sql/138 — consent_events lookup index (2026-09-28)
--
-- Part 1, execution 3 of 5. MUST BE ITS OWN EXECUTION: CREATE INDEX
-- CONCURRENTLY cannot run inside a transaction, so it cannot share a run
-- with sql/137 and cannot go through apply_migration (see sql/README.md).
--
-- Serves "last 5 consent events for this contact" — the Slack review card
-- and getConsent() both read newest-first per contact.
-- The boot mirror (src/admin/startup-mirrors.js) creates the same index
-- non-concurrently, which is instant only because the table is empty then.
-- ════════════════════════════════════════════════════════════════════

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_consent_events_contact ON consent_events (ghl_contact_id, created_at DESC);
