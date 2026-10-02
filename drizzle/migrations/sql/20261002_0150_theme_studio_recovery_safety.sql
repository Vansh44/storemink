-- Applied 0147/0149 remain immutable. Correct their verification and protect
-- image recovery during rolling upgrades without modifying their checksums.
CREATE FUNCTION public.theme_studio_image_claim_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.kind = 'images' AND NEW.status = 'running' AND NEW.max_attempts > 1
     AND (OLD.status = 'queued' OR NEW.attempt_count > OLD.attempt_count)
     AND current_setting('app.theme_studio_image_recovery', true) IS DISTINCT FROM 'v1' THEN
    -- Suppress only the incompatible claim, not unrelated worker settlement.
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.theme_studio_image_claim_guard() FROM PUBLIC, app_user, app_service;
CREATE TRIGGER theme_studio_image_claim_guard BEFORE UPDATE ON public.theme_studio_runs
FOR EACH ROW EXECUTE FUNCTION public.theme_studio_image_claim_guard();

-- Pre-checkpoint runs remain single-attempt until a capable worker claims them.
-- Existing running old workers may finish, but cannot reclaim and redraw them.
UPDATE public.theme_studio_runs r SET max_attempts = 1
WHERE kind = 'images' AND status IN ('queued','running') AND max_attempts > 1
  AND NOT EXISTS (SELECT 1 FROM public.theme_studio_image_checkpoints c WHERE c.run_id = r.id);

CREATE INDEX theme_studio_image_checkpoints_retention_idx
ON public.theme_studio_image_checkpoints(created_at, run_id);

-- Raw originals have a 30-day recovery window. Run usage and settled assets
-- remain durable. Only this bounded service function may delete checkpoints.
CREATE FUNCTION public.theme_studio_prune_image_checkpoints(p_before timestamptz, p_limit integer)
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH RECURSIVE active_ancestry AS (
    SELECT id, retry_of_run_id, 0 AS depth FROM public.theme_studio_runs
    WHERE kind = 'images' AND status IN ('queued','running')
    UNION
    SELECT r.id, r.retry_of_run_id, a.depth + 1
    FROM active_ancestry a JOIN public.theme_studio_runs r ON r.id = a.retry_of_run_id
    WHERE a.depth < 50
  ), victims AS (
    SELECT c.run_id, c.request_digest
    FROM public.theme_studio_image_checkpoints c
    JOIN public.theme_studio_runs r ON r.id = c.run_id
    WHERE c.created_at < least(p_before, clock_timestamp() - interval '30 days')
      AND r.finished_at < least(p_before, clock_timestamp() - interval '30 days')
      AND r.status IN ('succeeded','failed','cancelled')
      AND NOT EXISTS (SELECT 1 FROM active_ancestry a WHERE a.id = r.id)
    ORDER BY c.created_at, c.run_id, c.request_digest
    LIMIT greatest(0, least(coalesce(p_limit,0),50))
    FOR UPDATE OF c SKIP LOCKED
  ), removed AS (
    DELETE FROM public.theme_studio_image_checkpoints c USING victims v
    WHERE c.run_id = v.run_id AND c.request_digest = v.request_digest RETURNING 1
  ) SELECT count(*)::integer FROM removed;
$$;
REVOKE ALL ON FUNCTION public.theme_studio_prune_image_checkpoints(timestamptz,integer) FROM PUBLIC, app_user;
GRANT EXECUTE ON FUNCTION public.theme_studio_prune_image_checkpoints(timestamptz,integer) TO app_service;
