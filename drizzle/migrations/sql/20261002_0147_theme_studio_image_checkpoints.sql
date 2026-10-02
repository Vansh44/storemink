-- Private original draws and per-image evidence survive worker interruption.
-- Additive: the previous worker may continue using its existing final store.
ALTER TABLE public.theme_studio_runs
  ADD COLUMN image_review_deferrals integer NOT NULL DEFAULT 0
    CONSTRAINT theme_studio_runs_image_review_deferrals_check
    CHECK (image_review_deferrals BETWEEN 0 AND 2);

CREATE TABLE public.theme_studio_image_checkpoints (
  run_id uuid NOT NULL REFERENCES public.theme_studio_runs(id) ON DELETE CASCADE,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  response_json jsonb NOT NULL,
  image_bytes bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, request_digest),
  CONSTRAINT theme_studio_image_checkpoints_shape_check CHECK (
    jsonb_typeof(response_json) = 'object'
    AND response_json ?& ARRAY['stage', 'response', 'call']
    AND jsonb_typeof(response_json->'response') = 'object'
    AND jsonb_typeof(response_json->'call') = 'object'
    AND jsonb_typeof(response_json->'response'->'usage') = 'object'
    AND response_json->'response' ?& ARRAY['kind', 'usage']
    AND octet_length(response_json::text) <= 65536
    AND (
      (response_json->>'stage' = 'draw' AND (
        (response_json->'response'->>'kind' = 'ok'
          AND response_json->'response'->>'mediaType' IN ('image/jpeg', 'image/png', 'image/webp')
          AND image_bytes IS NOT NULL AND octet_length(image_bytes) BETWEEN 1 AND 20971520)
        OR (response_json->'response'->>'kind' = 'refused' AND image_bytes IS NULL)
        OR (response_json->'response'->>'kind' = 'error' AND image_bytes IS NULL)
      ))
      OR (response_json->>'stage' = 'review'
        AND response_json->'response'->>'kind' IN ('reviewed', 'unavailable')
        AND image_bytes IS NULL)
    ) IS TRUE
  )
);
ALTER TABLE public.theme_studio_image_checkpoints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.theme_studio_image_checkpoints FROM PUBLIC, app_user, app_service;
GRANT SELECT, INSERT ON public.theme_studio_image_checkpoints TO app_service;

-- Completed calls are replayable, so an interrupted image run can reclaim its
-- lease without buying its saved draws again. Paid errors remain bounded.
UPDATE public.theme_studio_runs SET max_attempts = 3
WHERE kind = 'images' AND status IN ('queued', 'running') AND max_attempts = 1;
