-- ════════════════════════════════════════════════════════════════════
-- sql/143 — audit_posted_items: what a daily audit already posted (2026-10-02)
--
-- Additive. Mirrored in src/admin/startup-mirrors.js.
--
-- WHY THIS TABLE EXISTS
--   The F.0 / S5.2 integrity audit (src/jobs/f0-integrity-audit.js) posted the
--   whole list every morning, so the same pre-10/1 backlog filled #ops-alerts
--   day after day and a new problem was buried in it (Mark, 2026-10-02). It now
--   posts only problems it has not posted in the last 30 days: one row per
--   (audit, contact, reason) it put on a card. Rows older than 30 days are
--   deleted by the audit itself, so a problem still there a month later is
--   posted again.
--
--   Until the table exists the audit posts everything it finds, as before —
--   a missing table must never turn a real problem into silence.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS audit_posted_items (
  id          bigserial PRIMARY KEY,
  audit       text NOT NULL,
  contact_id  text NOT NULL,
  reason      text NOT NULL,
  posted_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_posted_items_key ON audit_posted_items (audit, contact_id, reason);
CREATE INDEX IF NOT EXISTS idx_audit_posted_items_posted_at ON audit_posted_items (posted_at);

ALTER TABLE audit_posted_items ENABLE ROW LEVEL SECURITY;
