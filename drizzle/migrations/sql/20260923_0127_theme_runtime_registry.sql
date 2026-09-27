-- Phase 1 of Mink AI Theme Studio: immutable runtime theme releases and a
-- separately mutable catalog pointer. The package is service-owned and never
-- exposed through merchant RLS; public pages receive a validated projection
-- from server code.

CREATE TABLE public.theme_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  theme_id text NOT NULL,
  version text NOT NULL,
  release_status text NOT NULL,
  package_json jsonb NOT NULL,
  manifest_digest text NOT NULL,
  source text NOT NULL DEFAULT 'theme-studio',
  -- Actor snapshot only: a release must remain immutable even if an operator
  -- account is later removed, so this deliberately has no mutable FK action.
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT theme_releases_theme_version_key UNIQUE (theme_id, version),
  CONSTRAINT theme_releases_id_theme_key UNIQUE (id, theme_id),
  CONSTRAINT theme_releases_theme_id_check
    CHECK (theme_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND char_length(theme_id) <= 80),
  CONSTRAINT theme_releases_version_check
    CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  CONSTRAINT theme_releases_status_check
    CHECK (release_status IN ('candidate', 'approved', 'published', 'blocked')),
  CONSTRAINT theme_releases_digest_check
    CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT theme_releases_source_check
    CHECK (source IN ('bundled-import', 'theme-studio')),
  CONSTRAINT theme_releases_package_size_check
    CHECK (octet_length(package_json::text) <= 2097152)
);

CREATE INDEX theme_releases_lookup_idx
  ON public.theme_releases (theme_id, version, release_status);

CREATE TABLE public.theme_catalog_entries (
  theme_id text PRIMARY KEY,
  current_release_id uuid NOT NULL,
  visibility text NOT NULL,
  updated_by uuid REFERENCES public.platform_admins(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT theme_catalog_entries_release_fkey
    FOREIGN KEY (current_release_id, theme_id)
    REFERENCES public.theme_releases(id, theme_id),
  CONSTRAINT theme_catalog_entries_theme_id_check
    CHECK (theme_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND char_length(theme_id) <= 80),
  CONSTRAINT theme_catalog_entries_visibility_check
    CHECK (visibility IN ('hidden', 'legacy', 'public'))
);

CREATE INDEX theme_catalog_entries_visibility_idx
  ON public.theme_catalog_entries (visibility, theme_id);

-- Release rows are content-addressed history. Publication, hiding and restore
-- change the catalog pointer; they never rewrite or delete a package that a
-- store may already have pinned.
CREATE FUNCTION public.prevent_theme_release_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'theme releases are immutable';
END;
$$;

CREATE TRIGGER theme_releases_immutable
BEFORE UPDATE OR DELETE ON public.theme_releases
FOR EACH ROW EXECUTE FUNCTION public.prevent_theme_release_mutation();

-- A catalog pointer may expose only a release whose immutable package was
-- recorded as published. Candidate and approved rows remain available to the
-- future operator preview path by exact id/version, never to public selection.
CREATE FUNCTION public.validate_theme_catalog_release()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.theme_releases AS release
    WHERE release.id = NEW.current_release_id
      AND release.theme_id = NEW.theme_id
      AND release.release_status = 'published'
  ) THEN
    RAISE EXCEPTION 'catalog entries must reference a published release';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER theme_catalog_entries_validate_release
BEFORE INSERT OR UPDATE ON public.theme_catalog_entries
FOR EACH ROW EXECUTE FUNCTION public.validate_theme_catalog_release();

ALTER TABLE public.theme_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.theme_catalog_entries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.theme_releases, public.theme_catalog_entries
  FROM PUBLIC, app_user;
GRANT SELECT, INSERT ON TABLE public.theme_releases TO app_service;
GRANT SELECT, INSERT, UPDATE ON TABLE public.theme_catalog_entries TO app_service;

REVOKE ALL ON FUNCTION public.prevent_theme_release_mutation() FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION public.validate_theme_catalog_release() FROM PUBLIC, app_user;
