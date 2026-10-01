-- Additive: the previous revision may continue using runs unchanged.
-- Delayed recovery is separate from crash attempts and keeps the run active.
ALTER TABLE public.theme_studio_runs
  ADD COLUMN retry_not_before timestamptz,
  ADD COLUMN rate_limit_deferrals integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT theme_studio_runs_rate_limit_deferrals_check
    CHECK (rate_limit_deferrals BETWEEN 0 AND 4);

CREATE TABLE public.theme_studio_generation_responses (
  run_id uuid NOT NULL REFERENCES public.theme_studio_runs(id) ON DELETE CASCADE,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, request_digest),
  CONSTRAINT theme_studio_generation_responses_shape_check CHECK (
    jsonb_typeof(response_json) = 'object'
    AND response_json ? 'kind'
    AND response_json ? 'usage'
    AND jsonb_typeof(response_json -> 'kind') = 'string'
    AND response_json ->> 'kind' IN ('ok', 'invalid_json', 'refused', 'truncated')
    AND jsonb_typeof(response_json -> 'usage') = 'object'
    AND octet_length(response_json::text) <= 4194304
  )
);
ALTER TABLE public.theme_studio_generation_responses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.theme_studio_generation_responses FROM PUBLIC, app_user, app_service;
GRANT SELECT, INSERT ON public.theme_studio_generation_responses TO app_service;
