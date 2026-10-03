-- Operator-only metadata, additive for older workers and immutable versions.
ALTER TABLE public.theme_studio_runs ADD COLUMN variety_context jsonb
  CONSTRAINT theme_studio_runs_variety_context_check CHECK (
    variety_context IS NULL OR (jsonb_typeof(variety_context) = 'array'
      AND jsonb_array_length(variety_context) <= 100
      AND octet_length(variety_context::text) <= 262144)
  );
ALTER TABLE public.theme_studio_versions ADD COLUMN distinctness_report jsonb
  CONSTRAINT theme_studio_versions_distinctness_check CHECK (
    distinctness_report IS NULL OR (jsonb_typeof(distinctness_report) = 'object'
      AND octet_length(distinctness_report::text) <= 8192)
  );

CREATE FUNCTION public.theme_studio_variety_context_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.variety_context IS NOT NULL AND NEW.variety_context IS DISTINCT FROM OLD.variety_context THEN
    RAISE EXCEPTION 'Theme Studio catalogue context is immutable once captured';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER theme_studio_variety_context_guard BEFORE UPDATE ON public.theme_studio_runs
  FOR EACH ROW EXECUTE FUNCTION public.theme_studio_variety_context_guard();
REVOKE ALL ON FUNCTION public.theme_studio_variety_context_guard() FROM PUBLIC, app_user;

-- The existing QA guard has an explicit content-field list; extend protection
-- additively so revealing a version cannot rewrite its comparison evidence.
CREATE FUNCTION public.theme_studio_distinctness_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.distinctness_report IS DISTINCT FROM OLD.distinctness_report THEN
    RAISE EXCEPTION 'Theme Studio distinctness evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER theme_studio_distinctness_guard BEFORE UPDATE ON public.theme_studio_versions
  FOR EACH ROW EXECUTE FUNCTION public.theme_studio_distinctness_guard();
REVOKE ALL ON FUNCTION public.theme_studio_distinctness_guard() FROM PUBLIC, app_user;
