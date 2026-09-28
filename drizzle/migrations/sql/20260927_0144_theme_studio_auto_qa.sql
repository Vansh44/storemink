-- Theme Studio Tracks 4–5: hidden automatic imagery, browser QA and bounded
-- visual self-critique before an operator sees a generated version.
--
-- Existing versions/runs/captures keep their public-to-operator/manual meaning
-- through defaults. The feature is additionally fail-closed behind the web
-- deployment flag, so applying this migration alone changes no workflow.

ALTER TABLE public.theme_studio_versions
  ADD COLUMN visibility text NOT NULL DEFAULT 'operator',
  ADD COLUMN qa_status text NOT NULL DEFAULT 'not_required',
  ADD COLUMN qa_iteration integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT theme_studio_versions_visibility_check
    CHECK (visibility IN ('internal', 'operator')),
  ADD CONSTRAINT theme_studio_versions_qa_check
    CHECK (qa_status IN ('not_required', 'pending', 'passed', 'failed')
       AND qa_iteration BETWEEN 0 AND 2
       AND (visibility = 'internal') = (qa_status = 'pending'));

-- Package/intent history remains immutable. The one new mutable envelope is
-- the fail-closed reveal transition after QA has judged those exact bytes.
DROP TRIGGER theme_studio_versions_immutable ON public.theme_studio_versions;
CREATE FUNCTION public.theme_studio_version_qa_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'theme_studio_versions rows are immutable';
  END IF;
  IF NEW.id <> OLD.id OR NEW.project_id <> OLD.project_id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.origin <> OLD.origin OR NEW.edit_detail <> OLD.edit_detail
     OR NEW.parent_version_id IS DISTINCT FROM OLD.parent_version_id
     OR NEW.version_number <> OLD.version_number
     OR NEW.intent_json <> OLD.intent_json OR NEW.intent_digest <> OLD.intent_digest
     OR NEW.package_json <> OLD.package_json
     OR NEW.package_digest IS DISTINCT FROM OLD.package_digest
     OR NEW.qa_iteration <> OLD.qa_iteration OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'theme studio version content is immutable';
  END IF;
  IF NOT (OLD.visibility = 'internal' AND OLD.qa_status = 'pending'
          AND NEW.visibility = 'operator'
          AND NEW.qa_status IN ('passed', 'failed')) THEN
    RAISE EXCEPTION 'illegal theme studio version QA transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER theme_studio_versions_qa_guard
BEFORE UPDATE OR DELETE ON public.theme_studio_versions
FOR EACH ROW EXECUTE FUNCTION public.theme_studio_version_qa_guard();

GRANT UPDATE (visibility, qa_status) ON public.theme_studio_versions TO app_service;
REVOKE ALL ON FUNCTION public.theme_studio_version_qa_guard() FROM PUBLIC, app_user;

ALTER TABLE public.theme_studio_runs
  ADD COLUMN automatic boolean NOT NULL DEFAULT false,
  ADD COLUMN qa_iteration integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT theme_studio_runs_qa_iteration_check
    CHECK (qa_iteration BETWEEN 0 AND 2
       AND (automatic OR qa_iteration = 0));

ALTER TABLE public.theme_studio_captures
  ADD COLUMN automatic boolean NOT NULL DEFAULT false,
  ADD COLUMN qa_iteration integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT theme_studio_captures_qa_iteration_check
    CHECK (qa_iteration BETWEEN 0 AND 2
       AND (automatic OR qa_iteration = 0));

ALTER TABLE public.theme_studio_captures
  DROP CONSTRAINT theme_studio_captures_shape_check;
ALTER TABLE public.theme_studio_captures
  ADD CONSTRAINT theme_studio_captures_shape_check
    CHECK (package_digest ~ '^[a-f0-9]{64}$'
       AND previous_status IN ('ready', 'candidate', 'generating')
       AND (automatic = (previous_status = 'generating'))
       AND char_length(idempotency_key) BETWEEN 16 AND 80
       AND attempt_count BETWEEN 0 AND max_attempts
       AND max_attempts BETWEEN 1 AND 5);

-- The capture guard predates the two automation inputs. They are immutable in
-- exactly the same way as version/package/idempotency identity.
CREATE OR REPLACE FUNCTION public.theme_studio_capture_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'theme studio captures are append-only';
  END IF;
  IF NEW.project_id <> OLD.project_id OR NEW.version_id <> OLD.version_id
     OR NEW.package_digest <> OLD.package_digest
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.previous_status <> OLD.previous_status
     OR NEW.automatic <> OLD.automatic
     OR NEW.qa_iteration <> OLD.qa_iteration
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'theme studio capture inputs are immutable';
  END IF;
  IF OLD.status IN ('succeeded', 'failed')
     AND (NEW.status IS DISTINCT FROM OLD.status
          OR NEW.error_code IS DISTINCT FROM OLD.error_code
          OR NEW.result_version_id IS DISTINCT FROM OLD.result_version_id
          OR NEW.finished_at IS DISTINCT FROM OLD.finished_at
          OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
          OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count
          OR (NEW.created_by IS DISTINCT FROM OLD.created_by
              AND NEW.created_by IS NOT NULL)) THEN
    RAISE EXCEPTION 'theme studio capture % is final', OLD.id;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Browser evidence and screenshots are durable input to one vision verdict.
-- Final rows are append-only; a lease may be retried but never re-pointed.
CREATE TABLE public.theme_studio_visual_qa_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.theme_studio_projects(id),
  version_id uuid NOT NULL,
  package_digest text NOT NULL,
  qa_iteration integer NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  browser_report jsonb NOT NULL,
  screenshot_asset_ids uuid[] NOT NULL,
  vision_report jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision_run_id uuid,
  lease_owner uuid,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 2,
  error_code text,
  created_by uuid REFERENCES public.platform_admins(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT theme_studio_visual_qa_version_fkey
    FOREIGN KEY (version_id, project_id)
    REFERENCES public.theme_studio_versions(id, project_id),
  CONSTRAINT theme_studio_visual_qa_revision_run_fkey
    FOREIGN KEY (revision_run_id, project_id)
    REFERENCES public.theme_studio_runs(id, project_id),
  CONSTRAINT theme_studio_visual_qa_status_check
    CHECK (status IN ('queued', 'running', 'passed', 'failed', 'revision_queued')),
  CONSTRAINT theme_studio_visual_qa_shape_check
    CHECK (package_digest ~ '^[a-f0-9]{64}$'
       AND qa_iteration BETWEEN 0 AND 2
       AND jsonb_typeof(browser_report) = 'object'
       AND jsonb_typeof(vision_report) = 'object'
       AND cardinality(screenshot_asset_ids) BETWEEN 1 AND 30
       AND attempt_count BETWEEN 0 AND max_attempts
       AND max_attempts BETWEEN 1 AND 3
       AND (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$')),
  CONSTRAINT theme_studio_visual_qa_lifecycle_check
    CHECK ((status = 'running') = (lease_owner IS NOT NULL)
       AND (lease_owner IS NULL) = (lease_expires_at IS NULL)
       AND (status IN ('passed', 'failed', 'revision_queued')) = (finished_at IS NOT NULL)
       AND (status = 'failed') = (error_code IS NOT NULL)
       AND (status = 'revision_queued') = (revision_run_id IS NOT NULL))
);

CREATE UNIQUE INDEX theme_studio_visual_qa_one_active
  ON public.theme_studio_visual_qa_runs (project_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX theme_studio_visual_qa_queue_idx
  ON public.theme_studio_visual_qa_runs (created_at)
  WHERE status IN ('queued', 'running');
CREATE INDEX theme_studio_visual_qa_version_idx
  ON public.theme_studio_visual_qa_runs (version_id, created_at DESC);

CREATE FUNCTION public.theme_studio_visual_qa_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'theme studio visual QA is append-only';
  END IF;
  IF NEW.project_id <> OLD.project_id OR NEW.version_id <> OLD.version_id
     OR NEW.package_digest <> OLD.package_digest
     OR NEW.qa_iteration <> OLD.qa_iteration
     OR NEW.browser_report <> OLD.browser_report
     OR NEW.screenshot_asset_ids <> OLD.screenshot_asset_ids
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'theme studio visual QA inputs are immutable';
  END IF;
  IF OLD.status IN ('passed', 'failed', 'revision_queued')
     AND (NEW.status IS DISTINCT FROM OLD.status
          OR NEW.vision_report IS DISTINCT FROM OLD.vision_report
          OR NEW.revision_run_id IS DISTINCT FROM OLD.revision_run_id
          OR NEW.error_code IS DISTINCT FROM OLD.error_code
          OR NEW.finished_at IS DISTINCT FROM OLD.finished_at
          OR (NEW.created_by IS DISTINCT FROM OLD.created_by
              AND NEW.created_by IS NOT NULL)) THEN
    RAISE EXCEPTION 'theme studio visual QA % is final', OLD.id;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER theme_studio_visual_qa_guard
BEFORE UPDATE OR DELETE ON public.theme_studio_visual_qa_runs
FOR EACH ROW EXECUTE FUNCTION public.theme_studio_visual_qa_guard();

ALTER TABLE public.theme_studio_visual_qa_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.theme_studio_visual_qa_runs FROM PUBLIC, app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE public.theme_studio_visual_qa_runs TO app_service;
REVOKE ALL ON FUNCTION public.theme_studio_visual_qa_guard() FROM PUBLIC, app_user;

ALTER TABLE public.theme_studio_assets
  DROP CONSTRAINT theme_studio_assets_purpose_check;
ALTER TABLE public.theme_studio_assets
  ADD CONSTRAINT theme_studio_assets_purpose_check
  CHECK (purpose IN ('reference', 'placeholder', 'image', 'anchor', 'qa_screenshot'));

ALTER TABLE public.theme_studio_events
  DROP CONSTRAINT theme_studio_events_type_check;
ALTER TABLE public.theme_studio_events
  ADD CONSTRAINT theme_studio_events_type_check
  CHECK (event_type IN ('project_created', 'reference_added', 'reference_removed',
                        'run_queued', 'run_started', 'run_succeeded', 'run_failed',
                        'run_cancel_requested', 'run_cancelled', 'run_retried',
                        'version_created', 'project_archived',
                        'clarification_requested', 'details_added',
                        'revision_requested', 'version_restored',
                        'preview_created', 'preview_failed', 'preview_expired',
                        'acceptance_started', 'acceptance_passed',
                        'acceptance_failed', 'acceptance_blocked',
                        'slot_image_uploaded', 'slot_images_replaced',
                        'review_submitted', 'project_approved',
                        'publication_started', 'publication_failed',
                        'theme_published', 'catalog_visibility_changed',
                        'catalog_release_selected', 'images_requested',
                        'capture_requested', 'capture_succeeded',
                        'capture_failed', 'auto_qa_started',
                        'auto_qa_browser_finished', 'auto_qa_passed',
                        'auto_qa_revision_queued', 'auto_qa_failed'));
