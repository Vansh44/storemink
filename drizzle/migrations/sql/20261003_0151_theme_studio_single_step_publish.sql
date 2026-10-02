-- One-step theme publication (2026-10-03).
--
-- 0134 made entering `approved` require two human scorecards (a design chair
-- and a commerce chair, at least one not an author). A candidate has already
-- passed every automated acceptance gate and the automated visual QA
-- scorecard, so that second human round is removed: a superadmin publishes a
-- candidate in one step. `approved` stays as the state a failed publication
-- waits in, so a retry resumes the same attempt.
--
-- What the database still refuses, unchanged in spirit:
--   • `candidate` and `approved` need a PASSED acceptance run over the current
--     version's exact package digest;
--   • a candidate or approved project cannot swap its version in place;
--   • `published` needs a published publication of the current version.
--
-- Backward compatible: the previous revision still records reviews before
-- approving, which this guard accepts; it only stops requiring them.
-- theme_studio_reviews is kept (expand/contract) and simply no longer written.
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
  -- Candidate: on every write, as 0131/0134 did. Approved: on entry, which is
  -- where 0134 used to demand the two scorecards.
  IF NEW.status = 'candidate'
     OR (NEW.status = 'approved' AND OLD.status <> 'approved') THEN
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
      RAISE EXCEPTION 'a theme studio % needs passing acceptance evidence', NEW.status;
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
