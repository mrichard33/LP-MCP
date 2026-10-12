-- 20261012180000_feature_modes (Fix 2, 2026-10-12)
--
-- One row per `*_MODE` flag in LP-MCP, written at every boot by
-- registerModes() (src/mode-registry-sync.js) from src/mode-registry.js, and
-- read by the dashboard's /modes page. Nothing here changes a flag: a flip is
-- still a Railway variable set by a person. The trigger below records each
-- flip the first time the service boots with the new value, so "how long has
-- this been in shadow" and "who changed it when" come from the database, not
-- from memory.
--
-- system_events already has idx_se_type (event_type, created_at DESC), which
-- the page's 7-day shadow-event counts use; no new index is needed.

CREATE TABLE IF NOT EXISTS public.feature_modes (
  name              text PRIMARY KEY,
  mode_group        text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('enum', 'boolean', 'choice')),
  current_value     text NOT NULL,
  current_state     text NOT NULL CHECK (current_state IN ('live', 'shadow', 'off', 'choice', 'other')),
  is_set            boolean NOT NULL DEFAULT false,
  default_value     text NOT NULL,
  allowed_values    text[] NOT NULL DEFAULT '{}',
  live_values       text[] NOT NULL DEFAULT '{}',
  shadow_values     text[] NOT NULL DEFAULT '{}',
  since             date,
  decider           text,
  evidence          jsonb NOT NULL DEFAULT '{}'::jsonb,
  go_live           text,
  note              text,
  registered_at     timestamptz NOT NULL DEFAULT now(),
  value_changed_at  timestamptz,
  state_changed_at  timestamptz
);

COMMENT ON TABLE public.feature_modes IS
  'Every *_MODE flag in LP-MCP with its current value, upserted at boot from src/mode-registry.js (Fix 2, 2026-10-12). Read by the dashboard /modes page.';
COMMENT ON COLUMN public.feature_modes.current_state IS
  'live | shadow | off | choice (a setting with no shadow stage) | other (a value the code does not recognise: check Railway).';
COMMENT ON COLUMN public.feature_modes.state_changed_at IS
  'When the state last changed, stamped by the trigger. NULL until the first change seen after this table existed; the page then counts from since.';

CREATE TABLE IF NOT EXISTS public.feature_mode_changes (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  from_value  text,
  to_value    text,
  from_state  text,
  to_state    text,
  changed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feature_mode_changes_name_changed_at
  ON public.feature_mode_changes (name, changed_at DESC);

COMMENT ON TABLE public.feature_mode_changes IS
  'One row per flag value change, written by the feature_modes trigger when a boot registers a different value (Fix 2, 2026-10-12).';

CREATE OR REPLACE FUNCTION public.feature_modes_track_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.current_value IS DISTINCT FROM OLD.current_value THEN
      NEW.value_changed_at := now();
      INSERT INTO public.feature_mode_changes (name, from_value, to_value, from_state, to_state)
      VALUES (NEW.name, OLD.current_value, NEW.current_value, OLD.current_state, NEW.current_state);
    ELSE
      NEW.value_changed_at := OLD.value_changed_at;
    END IF;
    IF NEW.current_state IS DISTINCT FROM OLD.current_state THEN
      NEW.state_changed_at := now();
    ELSE
      NEW.state_changed_at := OLD.state_changed_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER feature_modes_track_change
  BEFORE UPDATE ON public.feature_modes
  FOR EACH ROW EXECUTE FUNCTION public.feature_modes_track_change();

-- Service-key access only (LP-MCP writes, the dashboard reads server-side).
-- Supabase's default privileges grant anon/authenticated ALL on every new
-- public table; the 2026-10-12 drift check found exactly that gap elsewhere.
ALTER TABLE public.feature_modes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_mode_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.feature_modes FROM anon, authenticated;
REVOKE ALL ON TABLE public.feature_mode_changes FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.feature_mode_changes_id_seq FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.feature_modes_track_change() FROM PUBLIC, anon, authenticated;
