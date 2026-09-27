-- Phase 6 of Mink AI Theme Studio: human approval, publication and rollback.
--
-- Additive for the revision being replaced: three new tables, a widened event
-- vocabulary, and a REPLACED project guard whose only changes are two new
-- preconditions (entering `approved`, entering `published`) and one new
-- freeze (an approved project may not change its version in place). The
-- previous revision never moves a project into `approved` or `published`, so
-- nothing it writes is refused.

-- One reviewer's scorecard (docs/theme-acceptance.md §5) for ONE version,
-- bound to the acceptance run whose evidence they reviewed. Reviewing is
-- judging a specific set of bytes: when the version, an asset or the evidence
-- changes, the old scorecards stop counting because they name the old run.
--
-- ★ The scores are eight columns, not a jsonb blob, so the approval rule is a
-- CHECK on the row: an `approve` verdict is only storable when every row is
-- at least 4, the total is at least 34 (an average of 4.2 over eight rows),
-- and no automatic-rejection condition was ticked. A client cannot submit an
-- approving verdict over failing scores, however it is written.
CREATE TABLE public.theme_studio_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.theme_studio_projects(id),
  version_id uuid NOT NULL,
  acceptance_run_id uuid NOT NULL
    REFERENCES public.theme_studio_acceptance_runs(id),
  package_digest text NOT NULL,
  evidence_digest text NOT NULL,
  reviewer_role text NOT NULL,
  reviewer_is_author boolean NOT NULL,
  art_direction smallint NOT NULL,
  distinctness smallint NOT NULL,
  commerce_clarity smallint NOT NULL,
  typography smallint NOT NULL,
  imagery smallint NOT NULL,
  responsive_composition smallint NOT NULL,
  detail_quality smallint NOT NULL,
  brand_adaptability smallint NOT NULL,
  rejections text[] NOT NULL DEFAULT '{}'::text[],
  verdict text NOT NULL,
  notes text NOT NULL DEFAULT '',
  created_by uuid REFERENCES public.platform_admins(id) ON DELETE SET NULL,
  created_by_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT theme_studio_reviews_version_fkey
    FOREIGN KEY (version_id, project_id)
    REFERENCES public.theme_studio_versions(id, project_id),
  -- One design review and one commerce review per piece of evidence, and one
  -- person may not hold both chairs.
  CONSTRAINT theme_studio_reviews_role_unique UNIQUE (acceptance_run_id, reviewer_role),
  CONSTRAINT theme_studio_reviews_reviewer_unique UNIQUE (acceptance_run_id, created_by_email),
  CONSTRAINT theme_studio_reviews_role_check
    CHECK (reviewer_role IN ('design', 'commerce')),
  CONSTRAINT theme_studio_reviews_verdict_check
    CHECK (verdict IN ('approve', 'reject')),
  CONSTRAINT theme_studio_reviews_digest_check
    CHECK (package_digest ~ '^[a-f0-9]{64}$' AND evidence_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT theme_studio_reviews_score_check
    CHECK (art_direction BETWEEN 1 AND 5 AND distinctness BETWEEN 1 AND 5
       AND commerce_clarity BETWEEN 1 AND 5 AND typography BETWEEN 1 AND 5
       AND imagery BETWEEN 1 AND 5 AND responsive_composition BETWEEN 1 AND 5
       AND detail_quality BETWEEN 1 AND 5 AND brand_adaptability BETWEEN 1 AND 5),
  CONSTRAINT theme_studio_reviews_rejections_check
    CHECK (rejections <@ ARRAY['palette_only', 'copied', 'generic_surface',
                               'needs_custom_code', 'placeholder_copy',
                               'inaccessible_copy']::text[]
       AND cardinality(rejections) <= 6),
  CONSTRAINT theme_studio_reviews_notes_check
    CHECK (char_length(notes) <= 2000),
  -- Every operand is NOT NULL, so this cannot pass by evaluating to NULL.
  CONSTRAINT theme_studio_reviews_approve_bar_check
    CHECK (verdict = 'reject' OR (
      LEAST(art_direction, distinctness, commerce_clarity, typography, imagery,
            responsive_composition, detail_quality, brand_adaptability) >= 4
      AND (art_direction + distinctness + commerce_clarity + typography
           + imagery + responsive_composition + detail_quality
           + brand_adaptability) >= 34
      AND cardinality(rejections) = 0)),
  -- A rejection must say why, or the operator revising the theme has nothing
  -- to act on.
  CONSTRAINT theme_studio_reviews_reject_reason_check
    CHECK (verdict = 'approve' OR char_length(btrim(notes)) >= 10)
);

CREATE INDEX theme_studio_reviews_project_idx
  ON public.theme_studio_reviews (project_id, created_at DESC);

-- A scorecard binds to evidence that is TRUE: a passed run over this exact
-- version, whose package digest and evidence digest the row repeats.
CREATE FUNCTION public.theme_studio_review_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.theme_studio_acceptance_runs a
    JOIN public.theme_studio_versions v
      ON v.id = a.version_id AND v.project_id = a.project_id
    WHERE a.id = NEW.acceptance_run_id
      AND a.project_id = NEW.project_id
      AND a.version_id = NEW.version_id
      AND a.status = 'passed'
      AND a.package_digest = v.package_digest
      AND a.package_digest = NEW.package_digest
      AND a.evidence_digest = NEW.evidence_digest
  ) THEN
    RAISE EXCEPTION 'a theme studio review must bind to passing evidence for its version';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER theme_studio_review_binding
BEFORE INSERT ON public.theme_studio_reviews
FOR EACH ROW EXECUTE FUNCTION public.theme_studio_review_binding();

-- Scorecards are a record, never edited or withdrawn. A reviewer who changes
-- their mind reviews the NEXT version.
CREATE TRIGGER theme_studio_reviews_immutable
BEFORE UPDATE OR DELETE ON public.theme_studio_reviews
FOR EACH ROW EXECUTE FUNCTION public.theme_studio_forbid_mutation();

-- One publication attempt. It is written BEFORE anything leaves the database,
-- so a crash mid-publication leaves a `publishing` row naming the release it
-- was building, and a retry resumes that release instead of allocating a new
-- one. `failure` holds what went wrong (a demo seeding error, a render check).
CREATE TABLE public.theme_studio_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.theme_studio_projects(id),
  version_id uuid NOT NULL,
  acceptance_run_id uuid NOT NULL
    REFERENCES public.theme_studio_acceptance_runs(id),
  theme_id text NOT NULL,
  release_version text NOT NULL,
  release_id uuid REFERENCES public.theme_releases(id),
  manifest_digest text,
  -- The demo store, as a record. Deliberately NOT a foreign key: every store
  -- foreign key cascades (migration 0014), and a cascade would delete this
  -- append-only audit row with the store.
  demo_store_id uuid,
  status text NOT NULL DEFAULT 'publishing',
  failure jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES public.platform_admins(id) ON DELETE SET NULL,
  created_by_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT theme_studio_publications_version_fkey
    FOREIGN KEY (version_id, project_id)
    REFERENCES public.theme_studio_versions(id, project_id),
  CONSTRAINT theme_studio_publications_status_check
    CHECK (status IN ('publishing', 'published', 'failed')),
  CONSTRAINT theme_studio_publications_version_check
    CHECK (release_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
       AND theme_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
       AND (manifest_digest IS NULL OR manifest_digest ~ '^[a-f0-9]{64}$')),
  CONSTRAINT theme_studio_publications_failure_check
    CHECK (jsonb_typeof(failure) = 'array' AND pg_column_size(failure) <= 32768),
  -- Every operand is NOT NULL or tested with IS [NOT] NULL.
  CONSTRAINT theme_studio_publications_lifecycle_check
    CHECK ((status = 'publishing') = (completed_at IS NULL)
       AND (status <> 'published'
            OR (release_id IS NOT NULL AND manifest_digest IS NOT NULL))
       AND (release_id IS NULL) = (manifest_digest IS NULL))
);

-- One attempt in flight per project, and one success ever: a Studio project
-- publishes exactly one release line.
CREATE UNIQUE INDEX theme_studio_publications_one_active
  ON public.theme_studio_publications (project_id)
  WHERE status = 'publishing';
CREATE UNIQUE INDEX theme_studio_publications_one_published
  ON public.theme_studio_publications (project_id)
  WHERE status = 'published';
CREATE INDEX theme_studio_publications_project_idx
  ON public.theme_studio_publications (project_id, created_at DESC);

-- An attempt is append-only once it reaches a verdict, and its inputs never
-- move. The release it names may be set once (NULL -> value) while it runs.
CREATE FUNCTION public.theme_studio_publication_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'theme studio publications are append-only';
  END IF;
  -- The operator's removal (created_by -> NULL) is the only change to a
  -- finished row.
  IF OLD.created_by IS NOT NULL AND NEW.created_by IS NULL
     AND (to_jsonb(NEW) - 'created_by') = (to_jsonb(OLD) - 'created_by') THEN
    RETURN NEW;
  END IF;
  IF OLD.status <> 'publishing' THEN
    RAISE EXCEPTION 'theme studio publication % is final', OLD.id;
  END IF;
  IF NEW.project_id <> OLD.project_id OR NEW.version_id <> OLD.version_id
     OR NEW.acceptance_run_id <> OLD.acceptance_run_id
     OR NEW.theme_id <> OLD.theme_id
     OR NEW.release_version <> OLD.release_version
     OR NEW.created_by_email <> OLD.created_by_email
     OR NEW.created_at <> OLD.created_at
     OR (OLD.release_id IS NOT NULL
         AND NEW.release_id IS DISTINCT FROM OLD.release_id)
     OR (OLD.manifest_digest IS NOT NULL
         AND NEW.manifest_digest IS DISTINCT FROM OLD.manifest_digest) THEN
    RAISE EXCEPTION 'theme studio publication inputs are immutable';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER theme_studio_publication_guard
BEFORE UPDATE OR DELETE ON public.theme_studio_publications
FOR EACH ROW EXECUTE FUNCTION public.theme_studio_publication_guard();

-- The catalog audit: every change to what new stores may install, whoever
-- makes it. Append-only. A pinned store's installed release is never touched
-- by any of these; the audit records exposure only.
CREATE TABLE public.theme_catalog_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  theme_id text NOT NULL,
  action text NOT NULL,
  release_id uuid NOT NULL REFERENCES public.theme_releases(id),
  visibility text NOT NULL,
  previous_release_id uuid REFERENCES public.theme_releases(id),
  previous_visibility text,
  project_id uuid REFERENCES public.theme_studio_projects(id),
  reason text NOT NULL DEFAULT '',
  created_by uuid REFERENCES public.platform_admins(id) ON DELETE SET NULL,
  created_by_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT theme_catalog_audit_action_check
    CHECK (action IN ('publish', 'hide', 'show', 'select_release')),
  CONSTRAINT theme_catalog_audit_visibility_check
    CHECK (visibility IN ('hidden', 'legacy', 'public')
       AND (previous_visibility IS NULL
            OR previous_visibility IN ('hidden', 'legacy', 'public'))),
  CONSTRAINT theme_catalog_audit_reason_check
    CHECK (char_length(reason) <= 500)
);

CREATE INDEX theme_catalog_audit_theme_idx
  ON public.theme_catalog_audit (theme_id, created_at DESC);

CREATE TRIGGER theme_catalog_audit_immutable
BEFORE UPDATE OR DELETE ON public.theme_catalog_audit
FOR EACH ROW EXECUTE FUNCTION public.theme_studio_forbid_mutation();

ALTER TABLE public.theme_studio_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.theme_studio_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.theme_catalog_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.theme_studio_reviews FROM PUBLIC, app_user;
REVOKE ALL ON TABLE public.theme_studio_publications FROM PUBLIC, app_user;
REVOKE ALL ON TABLE public.theme_catalog_audit FROM PUBLIC, app_user;
GRANT SELECT, INSERT ON TABLE public.theme_studio_reviews TO app_service;
GRANT SELECT, INSERT, UPDATE ON TABLE public.theme_studio_publications TO app_service;
GRANT SELECT, INSERT ON TABLE public.theme_catalog_audit TO app_service;
REVOKE ALL ON FUNCTION public.theme_studio_review_binding() FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION public.theme_studio_publication_guard() FROM PUBLIC, app_user;

-- The project guard gains two preconditions and one freeze:
--   • entering `approved` needs, for the current version's latest passed
--     run, an approving design review AND an approving commerce review, at
--     least one by somebody who did not author the theme, and no rejection;
--   • an approved project may not change its current version in place;
--   • entering `published` needs a published publication of that version.
-- So no server action, however it is written, can approve without two
-- qualifying reviewers or mark a project published without a release.
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
  IF NEW.status IN ('candidate', 'approved')
     AND OLD.status = NEW.status
     AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
    RAISE EXCEPTION 'a theme studio % cannot change its version', NEW.status;
  END IF;
  IF NEW.status = 'candidate' THEN
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
  IF NEW.status = 'approved' AND OLD.status <> 'approved' THEN
    -- The LATEST passing run for the version, as the application reads it:
    -- reviews of evidence that has since been superseded do not count.
    IF NOT EXISTS (
      SELECT 1
      FROM (
        SELECT a.*
        FROM public.theme_studio_acceptance_runs a
        WHERE a.project_id = NEW.id
          AND a.version_id = NEW.current_version_id
          AND a.status = 'passed'
        ORDER BY a.completed_at DESC, a.created_at DESC
        LIMIT 1
      ) a
      JOIN public.theme_studio_versions v
        ON v.id = a.version_id AND v.project_id = a.project_id
      WHERE a.package_digest = v.package_digest
        AND EXISTS (SELECT 1 FROM public.theme_studio_reviews r
                    WHERE r.acceptance_run_id = a.id AND r.verdict = 'approve'
                      AND r.reviewer_role = 'design')
        AND EXISTS (SELECT 1 FROM public.theme_studio_reviews r
                    WHERE r.acceptance_run_id = a.id AND r.verdict = 'approve'
                      AND r.reviewer_role = 'commerce')
        AND EXISTS (SELECT 1 FROM public.theme_studio_reviews r
                    WHERE r.acceptance_run_id = a.id AND r.verdict = 'approve'
                      AND NOT r.reviewer_is_author)
        AND NOT EXISTS (SELECT 1 FROM public.theme_studio_reviews r
                        WHERE r.acceptance_run_id = a.id AND r.verdict = 'reject')
    ) THEN
      RAISE EXCEPTION 'a theme studio approval needs two qualifying reviews';
    END IF;
  END IF;
  IF NEW.status = 'published' AND OLD.status <> 'published' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.theme_studio_publications p
      WHERE p.project_id = NEW.id
        AND p.version_id = NEW.current_version_id
        AND p.status = 'published'
    ) THEN
      RAISE EXCEPTION 'a theme studio project is published only by a publication';
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
                        'acceptance_failed', 'acceptance_blocked',
                        'slot_image_uploaded', 'slot_images_replaced',
                        'review_submitted', 'project_approved',
                        'publication_started', 'publication_failed',
                        'theme_published', 'catalog_visibility_changed',
                        'catalog_release_selected'));
