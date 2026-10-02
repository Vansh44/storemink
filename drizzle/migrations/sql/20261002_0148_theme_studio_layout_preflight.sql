-- Measure native layouts before purchasing artwork. Existing captures retain
-- their final-acceptance behavior during rolling deployment.
ALTER TABLE public.theme_studio_captures
  ADD COLUMN phase text NOT NULL DEFAULT 'final';
ALTER TABLE public.theme_studio_captures
  ADD CONSTRAINT theme_studio_captures_phase_check
    CHECK (phase IN ('layout', 'final') AND (phase <> 'layout' OR automatic));

CREATE FUNCTION public.theme_studio_capture_phase_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.phase IS DISTINCT FROM OLD.phase THEN
    RAISE EXCEPTION 'theme studio capture phase is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER theme_studio_capture_phase_guard
  BEFORE UPDATE ON public.theme_studio_captures
  FOR EACH ROW EXECUTE FUNCTION public.theme_studio_capture_phase_guard();

-- Expand the screenshot contract only for measured layout preflights. Final
-- acceptance keeps its 1..30 screenshot requirement and iteration ceiling.
ALTER TABLE public.theme_studio_visual_qa_runs
  DROP CONSTRAINT theme_studio_visual_qa_shape_check;
ALTER TABLE public.theme_studio_visual_qa_runs
  ADD CONSTRAINT theme_studio_visual_qa_shape_check
    CHECK (package_digest ~ '^[a-f0-9]{64}$'
       AND qa_iteration BETWEEN 0 AND 3
       AND jsonb_typeof(browser_report) = 'object'
       AND jsonb_typeof(vision_report) = 'object'
       AND ((coalesce(browser_report ->> 'phase', '') = 'layout'
              AND cardinality(screenshot_asset_ids) = 0
              AND coalesce(jsonb_typeof(browser_report -> 'evidence') = 'object', false)
              AND coalesce(jsonb_typeof(browser_report -> 'gates') = 'array', false)
              AND coalesce(length(browser_report ->> 'buildId') > 0, false))
         OR (coalesce(browser_report ->> 'phase', 'final') = 'final'
              AND cardinality(screenshot_asset_ids) BETWEEN 1 AND 30))
       AND attempt_count BETWEEN 0 AND max_attempts
       AND max_attempts BETWEEN 1 AND 3
       AND (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$'));
