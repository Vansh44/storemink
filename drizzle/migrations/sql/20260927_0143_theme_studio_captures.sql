-- Theme Studio: catalog pictures captured from the preview store (Track 3.6).
--
-- Publication needs a catalog card and two screenshots, and until now only an
-- operator upload could provide them. A capture renders the version's private
-- preview store in headless Chromium (a separate Cloud Run job) and saves the
-- three pictures as a new version. This table is the job's queue and record:
-- queued → running (leased) → succeeded | failed.
--
-- Additive: a new service-only table and three event types. Nothing the
-- revision being replaced reads or writes changes.

CREATE TABLE public.theme_studio_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.theme_studio_projects(id),
  version_id uuid NOT NULL,
  package_digest text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  -- The project's status when the capture was queued, kept as a record. A
  -- failed capture returns the project to `ready`: generating → candidate is
  -- not a transition, so a candidate's Checks are run again, as after a
  -- failed image run.
  previous_status text NOT NULL,
  idempotency_key text NOT NULL,
  lease_owner uuid,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 2,
  error_code text,
  result_version_id uuid,
  created_by uuid REFERENCES public.platform_admins(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT theme_studio_captures_idempotency_key UNIQUE (idempotency_key),
  CONSTRAINT theme_studio_captures_version_fkey
    FOREIGN KEY (version_id, project_id)
    REFERENCES public.theme_studio_versions(id, project_id),
  CONSTRAINT theme_studio_captures_result_fkey
    FOREIGN KEY (result_version_id, project_id)
    REFERENCES public.theme_studio_versions(id, project_id),
  CONSTRAINT theme_studio_captures_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  -- Every operand is NOT NULL or tested with IS [NOT] NULL, so none of these
  -- CHECKs can pass by evaluating to NULL.
  CONSTRAINT theme_studio_captures_shape_check
    CHECK (package_digest ~ '^[a-f0-9]{64}$'
       AND previous_status IN ('ready', 'candidate')
       AND char_length(idempotency_key) BETWEEN 16 AND 80
       AND attempt_count BETWEEN 0 AND max_attempts
       AND max_attempts BETWEEN 1 AND 5),
  CONSTRAINT theme_studio_captures_lifecycle_check
    CHECK ((status = 'running') = (lease_owner IS NOT NULL)
       AND (lease_owner IS NULL) = (lease_expires_at IS NULL)
       AND (status IN ('succeeded', 'failed')) = (finished_at IS NOT NULL)
       AND (status = 'succeeded') = (result_version_id IS NOT NULL)
       AND (status = 'failed') = (error_code IS NOT NULL)
       AND (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$'))
);

-- One capture at a time per project: a capture writes the project's next
-- version, exactly as a run does.
CREATE UNIQUE INDEX theme_studio_captures_one_active
  ON public.theme_studio_captures (project_id)
  WHERE status IN ('queued', 'running');

CREATE INDEX theme_studio_captures_queue_idx
  ON public.theme_studio_captures (created_at)
  WHERE status IN ('queued', 'running');

CREATE INDEX theme_studio_captures_version_idx
  ON public.theme_studio_captures (version_id, created_at DESC);

-- A finished capture is a record: it may not change, except that removing an
-- operator nulls created_by (the Phase 5 lesson, 0132).
CREATE FUNCTION public.theme_studio_capture_guard()
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

CREATE TRIGGER theme_studio_capture_guard
BEFORE UPDATE OR DELETE ON public.theme_studio_captures
FOR EACH ROW EXECUTE FUNCTION public.theme_studio_capture_guard();

ALTER TABLE public.theme_studio_captures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.theme_studio_captures FROM PUBLIC, app_user;

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
                        'capture_failed'));
