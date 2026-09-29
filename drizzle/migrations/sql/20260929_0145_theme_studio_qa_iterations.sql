-- Theme Studio: allow a fourth automatic QA pass (iterations 0-3).
--
-- The web tier's MAX_QA_ITERATION rose from 2 to 3 (quality over cost, owner
-- 2026-09-29), but 0144 bounds qa_iteration to 0-2 in four CHECKs, so the
-- third automatic revision would be refused by the database at insert time.
-- This only widens the bound; every row valid before stays valid, so the
-- revision being replaced is unaffected (docs/migrations.md).

ALTER TABLE public.theme_studio_versions
  DROP CONSTRAINT theme_studio_versions_qa_check,
  ADD CONSTRAINT theme_studio_versions_qa_check
    CHECK (qa_status IN ('not_required', 'pending', 'passed', 'failed')
       AND qa_iteration BETWEEN 0 AND 3
       AND (visibility = 'internal') = (qa_status = 'pending'));

ALTER TABLE public.theme_studio_runs
  DROP CONSTRAINT theme_studio_runs_qa_iteration_check,
  ADD CONSTRAINT theme_studio_runs_qa_iteration_check
    CHECK (qa_iteration BETWEEN 0 AND 3
       AND (automatic OR qa_iteration = 0));

ALTER TABLE public.theme_studio_captures
  DROP CONSTRAINT theme_studio_captures_qa_iteration_check,
  ADD CONSTRAINT theme_studio_captures_qa_iteration_check
    CHECK (qa_iteration BETWEEN 0 AND 3
       AND (automatic OR qa_iteration = 0));

ALTER TABLE public.theme_studio_visual_qa_runs
  DROP CONSTRAINT theme_studio_visual_qa_shape_check,
  ADD CONSTRAINT theme_studio_visual_qa_shape_check
    CHECK (package_digest ~ '^[a-f0-9]{64}$'
       AND qa_iteration BETWEEN 0 AND 3
       AND jsonb_typeof(browser_report) = 'object'
       AND jsonb_typeof(vision_report) = 'object'
       AND cardinality(screenshot_asset_ids) BETWEEN 1 AND 30
       AND attempt_count BETWEEN 0 AND max_attempts
       AND max_attempts BETWEEN 1 AND 3
       AND (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$'));
