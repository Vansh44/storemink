-- Phase 3 of Mink AI Theme Studio: real two-stage generation.
--
-- Additive only. 0128 is the Phase 2 intake schema; this widens three
-- vocabularies and adds one column, so the revision being replaced keeps
-- working against the new schema during the rollout.

-- A run can end in a question or a reasoned decline as well as a version.
-- `outcome_detail` carries the model's clarifying questions or its decline
-- reason for the operator to read. It is bounded, and it never carries provider
-- error text: failure causes stay in the closed-vocabulary `error_code`.
ALTER TABLE public.theme_studio_runs
  ADD COLUMN outcome_detail jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.theme_studio_runs
  ADD CONSTRAINT theme_studio_runs_outcome_detail_check
  CHECK (jsonb_typeof(outcome_detail) = 'object'
     AND octet_length(outcome_detail::text) <= 16384);

-- A model writes text, not photographs, and a generated package must declare a
-- SHA-256 for every image it references. So a candidate's image slots are
-- filled with server-generated placeholders, stored like references so their
-- digests are real. They are never published: publication must replace them
-- with operator-owned, licensed or generated imagery.
ALTER TABLE public.theme_studio_assets
  DROP CONSTRAINT theme_studio_assets_purpose_check;
ALTER TABLE public.theme_studio_assets
  ADD CONSTRAINT theme_studio_assets_purpose_check
  CHECK (purpose IN ('reference', 'placeholder'));

ALTER TABLE public.theme_studio_events
  DROP CONSTRAINT theme_studio_events_type_check;
ALTER TABLE public.theme_studio_events
  ADD CONSTRAINT theme_studio_events_type_check
  CHECK (event_type IN ('project_created', 'reference_added', 'reference_removed',
                        'run_queued', 'run_started', 'run_succeeded', 'run_failed',
                        'run_cancel_requested', 'run_cancelled', 'run_retried',
                        'version_created', 'project_archived',
                        'clarification_requested', 'details_added'));
