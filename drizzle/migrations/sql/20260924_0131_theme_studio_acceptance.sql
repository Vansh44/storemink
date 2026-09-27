-- Phase 5 of Mink AI Theme Studio: automated acceptance.
--
-- Additive for the revision being replaced: one new table and a widened event
-- vocabulary. The project guard is REPLACED, and the replacement only adds a
-- transition (candidate -> ready) and a precondition on entering `candidate`.
-- The previous revision never moves a project into `candidate`, so nothing it
-- writes is refused.

-- One acceptance run: the automated gates evaluated against ONE version,
-- bound to the exact inputs they judged. `package_digest` is the version's
-- content address, `assets_digest` addresses the stored bytes of every asset
-- the package declares, and `build_id` names the application build that
-- rendered the preview. Evidence is current only while all three still match,
-- so changing the manifest, an asset, or the renderer invalidates it.
--
-- Two stages: the server gates run first (package, security, assets, demo
-- materialization, rendered routes); a run whose server gates pass waits for
-- the operator's browser to measure the three viewports, bound to a one-time
-- nonce stored only as a hash.
CREATE TABLE public.theme_studio_acceptance_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.theme_studio_projects(id),
  version_id uuid NOT NULL,
  package_digest text NOT NULL,
  assets_digest text NOT NULL,
  build_id text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  server_report jsonb NOT NULL DEFAULT '{}'::jsonb,
  browser_report jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_digest text,
  browser_nonce_hash text,
  browser_expires_at timestamptz,
  created_by uuid REFERENCES public.platform_admins(id) ON DELETE SET NULL,
  created_by_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT theme_studio_acceptance_version_fkey
    FOREIGN KEY (version_id, project_id)
    REFERENCES public.theme_studio_versions(id, project_id),
  CONSTRAINT theme_studio_acceptance_status_check
    CHECK (status IN ('running', 'awaiting_browser', 'passed', 'failed',
                      'blocked', 'error', 'expired')),
  -- Every operand is NOT NULL or tested with IS [NOT] NULL, so none of these
  -- CHECKs can pass by evaluating to NULL.
  CONSTRAINT theme_studio_acceptance_digest_check
    CHECK (package_digest ~ '^[a-f0-9]{64}$'
       AND assets_digest ~ '^[a-f0-9]{64}$'
       AND (evidence_digest IS NULL OR evidence_digest ~ '^[a-f0-9]{64}$')
       AND char_length(build_id) BETWEEN 1 AND 200),
  CONSTRAINT theme_studio_acceptance_lifecycle_check
    CHECK ((status IN ('running', 'awaiting_browser')) = (completed_at IS NULL)
       AND (status = 'awaiting_browser') = (browser_nonce_hash IS NOT NULL)
       AND (browser_nonce_hash IS NULL) = (browser_expires_at IS NULL)
       AND (status NOT IN ('passed', 'failed', 'blocked')
            OR evidence_digest IS NOT NULL))
);

-- One active run per version, so two tabs cannot produce two competing
-- verdicts for the same inputs.
CREATE UNIQUE INDEX theme_studio_acceptance_one_active
  ON public.theme_studio_acceptance_runs (version_id)
  WHERE status IN ('running', 'awaiting_browser');

CREATE INDEX theme_studio_acceptance_project_idx
  ON public.theme_studio_acceptance_runs (project_id, created_at DESC);

CREATE INDEX theme_studio_acceptance_version_idx
  ON public.theme_studio_acceptance_runs (version_id, created_at DESC);

-- Evidence is append-only once it reaches a verdict: a finished run can never
-- be edited into a pass, and its inputs can never be re-pointed. Rows are
-- never deleted.
CREATE FUNCTION public.theme_studio_acceptance_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'theme studio acceptance evidence is append-only';
  END IF;
  IF OLD.status NOT IN ('running', 'awaiting_browser') THEN
    RAISE EXCEPTION 'theme studio acceptance run % is final', OLD.id;
  END IF;
  IF NEW.project_id <> OLD.project_id OR NEW.version_id <> OLD.version_id
     OR NEW.package_digest <> OLD.package_digest
     OR NEW.assets_digest <> OLD.assets_digest
     OR NEW.build_id <> OLD.build_id
     OR NEW.created_by_email <> OLD.created_by_email
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'theme studio acceptance inputs are immutable';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER theme_studio_acceptance_guard
BEFORE UPDATE OR DELETE ON public.theme_studio_acceptance_runs
FOR EACH ROW EXECUTE FUNCTION public.theme_studio_acceptance_guard();

ALTER TABLE public.theme_studio_acceptance_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.theme_studio_acceptance_runs FROM PUBLIC, app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE public.theme_studio_acceptance_runs TO app_service;
REVOKE ALL ON FUNCTION public.theme_studio_acceptance_guard() FROM PUBLIC, app_user;

-- The project state machine gains ONE transition, candidate -> ready (failed
-- or superseded evidence demotes a candidate without calling it blocked), and
-- ONE precondition: a project may only enter `candidate` when its current
-- version has a PASSED acceptance run over that version's exact package
-- digest, and a candidate may never change its current version in place.
-- So no server action, however it is written, can present a version for
-- human approval without passing evidence.
CREATE OR REPLACE FUNCTION public.theme_studio_project_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.theme_id <> OLD.theme_id
     OR NEW.created_by_email <> OLD.created_by_email
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'theme studio project identity is immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('generating', 'archived')) OR
    (OLD.status = 'generating' AND NEW.status IN ('ready', 'failed', 'blocked')) OR
    (OLD.status = 'ready' AND NEW.status IN ('generating', 'candidate', 'blocked', 'archived')) OR
    (OLD.status = 'candidate' AND NEW.status IN ('generating', 'ready', 'approved', 'blocked', 'archived')) OR
    (OLD.status = 'approved' AND NEW.status IN ('generating', 'published', 'blocked', 'archived')) OR
    (OLD.status = 'published' AND NEW.status = 'archived') OR
    (OLD.status = 'failed' AND NEW.status IN ('generating', 'archived')) OR
    (OLD.status = 'blocked' AND NEW.status IN ('generating', 'ready', 'archived'))
  ) THEN
    RAISE EXCEPTION 'illegal theme studio transition % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'candidate' THEN
    IF OLD.status = 'candidate'
       AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
      RAISE EXCEPTION 'a theme studio candidate cannot change its version';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.theme_studio_acceptance_runs a
      JOIN public.theme_studio_versions v
        ON v.id = a.version_id AND v.project_id = a.project_id
      WHERE a.project_id = NEW.id
        AND a.version_id = NEW.current_version_id
        AND a.status = 'passed'
        AND a.package_digest = v.package_digest
    ) THEN
      RAISE EXCEPTION 'a theme studio candidate needs passing acceptance evidence';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

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
                        'acceptance_failed', 'acceptance_blocked'));
