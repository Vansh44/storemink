-- Cross-instance Theme Studio admission. Eleven-minute expiry exceeds the
-- longest ten-minute provider request; heartbeat loss cancels the transport.
CREATE TABLE public.theme_studio_provider_capacity (
  scope_key text PRIMARY KEY CHECK (scope_key ~ '^[a-f0-9]{64}$'),
  capacity integer NOT NULL DEFAULT 3 CHECK (capacity BETWEEN 1 AND 3),
  epoch integer NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  successes integer NOT NULL DEFAULT 0 CHECK (successes BETWEEN 0 AND 2),
  pause_until timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.theme_studio_provider_leases (
  id uuid PRIMARY KEY,
  scope_key text NOT NULL REFERENCES public.theme_studio_provider_capacity(scope_key) ON DELETE CASCADE,
  epoch integer NOT NULL CHECK (epoch >= 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX theme_studio_provider_leases_scope_expiry_idx ON public.theme_studio_provider_leases(scope_key,expires_at);
ALTER TABLE public.theme_studio_provider_capacity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.theme_studio_provider_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.theme_studio_provider_capacity, public.theme_studio_provider_leases FROM PUBLIC, app_user;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.theme_studio_provider_capacity, public.theme_studio_provider_leases TO app_service;

CREATE FUNCTION public.theme_studio_capacity_lock(p_key text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  INSERT INTO public.theme_studio_provider_capacity(scope_key) VALUES(p_key) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM public.theme_studio_provider_capacity WHERE scope_key=p_key FOR UPDATE;
END;
$$;
REVOKE ALL ON FUNCTION public.theme_studio_capacity_lock(text) FROM PUBLIC, app_user;
GRANT EXECUTE ON FUNCTION public.theme_studio_capacity_lock(text) TO app_service;
