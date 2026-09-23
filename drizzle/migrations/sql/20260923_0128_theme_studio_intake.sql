-- Phase 2 of Mink AI Theme Studio: the operator-only project shell, secure
-- reference intake, immutable prompts/runs/versions and an append-only audit
-- trail. Every table is platform data, not tenant data: there is no store_id,
-- merchant RLS grants nothing, and all access is service scope behind a
-- superadmin gate in server code.
--
-- ★ References live HERE, not in the media bucket. That bucket is public
-- (allUsers:objectViewer, uniform access), so a "private prefix" inside it
-- does not exist. Only the SANITIZED re-encode is stored; the original upload
-- bytes are never persisted. This is the data_job_payloads precedent.

CREATE TABLE public.theme_studio_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  theme_id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  industries text[] NOT NULL DEFAULT '{}',
  catalog_sizes text[] NOT NULL DEFAULT '{}',
  required_features text[] NOT NULL DEFAULT '{}',
  base_theme_id text,
  model_key text NOT NULL,
  -- The editable brief while the project is a draft. Queueing a run snapshots
  -- it, with the exact references cited, into an immutable message; the run
  -- is generated from that message, never from this column.
  draft_brief text NOT NULL,
  current_version_id uuid,
  -- Optimistic lock for every operator mutation of this project.
  revision integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES public.platform_admins(id) ON DELETE SET NULL,
  created_by_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT theme_studio_projects_theme_id_check
    CHECK (theme_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND char_length(theme_id) BETWEEN 3 AND 80),
  CONSTRAINT theme_studio_projects_name_check
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  CONSTRAINT theme_studio_projects_status_check
    CHECK (status IN ('draft', 'generating', 'ready', 'candidate', 'approved',
                      'published', 'failed', 'blocked', 'archived')),
  CONSTRAINT theme_studio_projects_model_check
    CHECK (model_key IN ('opus-5', 'opus-5.5', 'fable-5')),
  CONSTRAINT theme_studio_projects_base_theme_check
    CHECK (base_theme_id IS NULL OR base_theme_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT theme_studio_projects_list_bounds_check
    CHECK (cardinality(industries) BETWEEN 1 AND 5
       AND cardinality(catalog_sizes) BETWEEN 1 AND 4
       AND cardinality(required_features) <= 10),
  CONSTRAINT theme_studio_projects_brief_check
    CHECK (char_length(btrim(draft_brief)) BETWEEN 1 AND 12000),
  CONSTRAINT theme_studio_projects_revision_check CHECK (revision >= 0),
  CONSTRAINT theme_studio_projects_archive_check
    CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);

-- An archived project releases its id, so a new attempt can reuse it.
CREATE UNIQUE INDEX theme_studio_projects_active_theme_key
  ON public.theme_studio_projects (theme_id)
  WHERE status <> 'archived';

CREATE INDEX theme_studio_projects_updated_idx
  ON public.theme_studio_projects (updated_at DESC);

CREATE INDEX theme_studio_projects_creator_day_idx
  ON public.theme_studio_projects (created_by, created_at DESC);

CREATE TABLE public.theme_studio_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.theme_studio_projects(id),
  purpose text NOT NULL DEFAULT 'reference',
  media_type text NOT NULL,
  bytes bytea NOT NULL,
  byte_size integer NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  sha256 text NOT NULL,
  original_media_type text NOT NULL,
  original_byte_size integer NOT NULL,
  created_by uuid REFERENCES public.platform_admins(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT theme_studio_assets_purpose_check CHECK (purpose IN ('reference')),
  CONSTRAINT theme_studio_assets_media_type_check CHECK (media_type = 'image/webp'),
  CONSTRAINT theme_studio_assets_original_type_check
    CHECK (original_media_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/avif')),
  CONSTRAINT theme_studio_assets_size_check
    CHECK (byte_size = octet_length(bytes) AND byte_size BETWEEN 1 AND 10485760
       AND original_byte_size BETWEEN 1 AND 10485760),
  CONSTRAINT theme_studio_assets_dimensions_check
    CHECK (width BETWEEN 1 AND 4096 AND height BETWEEN 1 AND 4096),
  CONSTRAINT theme_studio_assets_sha256_check CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT theme_studio_assets_project_sha_key UNIQUE (project_id, sha256),
  CONSTRAINT theme_studio_assets_id_project_key UNIQUE (id, project_id)
);

CREATE INDEX theme_studio_assets_project_idx
  ON public.theme_studio_assets (project_id, created_at);

CREATE TABLE public.theme_studio_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.theme_studio_projects(id),
  kind text NOT NULL,
  body text NOT NULL,
  reference_asset_ids uuid[] NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES public.platform_admins(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT theme_studio_messages_kind_check CHECK (kind IN ('brief', 'revision')),
  CONSTRAINT theme_studio_messages_body_check
    CHECK (char_length(btrim(body)) BETWEEN 1 AND 12000),
  CONSTRAINT theme_studio_messages_refs_check
    CHECK (cardinality(reference_asset_ids) <= 10),
  CONSTRAINT theme_studio_messages_id_project_key UNIQUE (id, project_id)
);

CREATE INDEX theme_studio_messages_project_idx
  ON public.theme_studio_messages (project_id, created_at);

CREATE TABLE public.theme_studio_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.theme_studio_projects(id),
  message_id uuid NOT NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  provider text NOT NULL,
  model_key text NOT NULL,
  provider_model text NOT NULL,
  prompt_version text NOT NULL,
  -- Operator-generated key; a double-submitted form finds its own run.
  idempotency_key text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  lease_owner uuid,
  lease_expires_at timestamptz,
  cancel_requested_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  -- Safe, closed-vocabulary code only. Never provider text or prompt content.
  error_code text,
  usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  retry_of_run_id uuid REFERENCES public.theme_studio_runs(id),
  created_by uuid REFERENCES public.platform_admins(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT theme_studio_runs_message_fkey
    FOREIGN KEY (message_id, project_id)
    REFERENCES public.theme_studio_messages(id, project_id),
  CONSTRAINT theme_studio_runs_kind_check CHECK (kind IN ('generate', 'revise')),
  CONSTRAINT theme_studio_runs_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT theme_studio_runs_provider_check CHECK (provider IN ('fake', 'anthropic-vertex')),
  CONSTRAINT theme_studio_runs_model_check
    CHECK (model_key IN ('opus-5', 'opus-5.5', 'fable-5')),
  CONSTRAINT theme_studio_runs_idempotency_check
    CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{16,80}$'),
  CONSTRAINT theme_studio_runs_idempotency_key UNIQUE (idempotency_key),
  CONSTRAINT theme_studio_runs_attempts_check
    CHECK (max_attempts BETWEEN 1 AND 3 AND attempt_count BETWEEN 0 AND max_attempts),
  -- A lease exists exactly while a run is running. Both columns are tested
  -- explicitly: a CHECK that evaluates to NULL passes, so `lease_owner IS NULL`
  -- alone would let a running row with a half-written lease through.
  CONSTRAINT theme_studio_runs_lease_check
    CHECK ((status = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (status <> 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL)),
  CONSTRAINT theme_studio_runs_terminal_check
    CHECK ((status IN ('succeeded', 'failed', 'cancelled')) = (finished_at IS NOT NULL)),
  CONSTRAINT theme_studio_runs_error_check
    CHECK ((status = 'failed') = (error_code IS NOT NULL)
       AND (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{0,63}$')),
  CONSTRAINT theme_studio_runs_usage_check CHECK (jsonb_typeof(usage) = 'object'),
  CONSTRAINT theme_studio_runs_id_project_key UNIQUE (id, project_id)
);

-- One generation or revision at a time per project, enforced by the database
-- rather than by a read-then-insert that two tabs can both pass.
CREATE UNIQUE INDEX theme_studio_runs_one_active_key
  ON public.theme_studio_runs (project_id)
  WHERE status IN ('queued', 'running');

CREATE INDEX theme_studio_runs_claim_idx
  ON public.theme_studio_runs (status, created_at)
  WHERE status IN ('queued', 'running');

CREATE INDEX theme_studio_runs_project_idx
  ON public.theme_studio_runs (project_id, created_at DESC);

CREATE INDEX theme_studio_runs_creator_active_idx
  ON public.theme_studio_runs (created_by)
  WHERE status IN ('queued', 'running');

CREATE TABLE public.theme_studio_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.theme_studio_projects(id),
  run_id uuid NOT NULL,
  parent_version_id uuid,
  version_number integer NOT NULL,
  intent_json jsonb NOT NULL,
  intent_digest text NOT NULL,
  package_json jsonb,
  package_digest text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT theme_studio_versions_run_fkey
    FOREIGN KEY (run_id, project_id)
    REFERENCES public.theme_studio_runs(id, project_id),
  CONSTRAINT theme_studio_versions_run_key UNIQUE (run_id),
  CONSTRAINT theme_studio_versions_number_key UNIQUE (project_id, version_number),
  CONSTRAINT theme_studio_versions_id_project_key UNIQUE (id, project_id),
  CONSTRAINT theme_studio_versions_parent_fkey
    FOREIGN KEY (parent_version_id, project_id)
    REFERENCES public.theme_studio_versions(id, project_id),
  CONSTRAINT theme_studio_versions_number_check CHECK (version_number > 0),
  CONSTRAINT theme_studio_versions_intent_check
    CHECK (jsonb_typeof(intent_json) = 'object'
       AND intent_digest ~ '^[a-f0-9]{64}$'
       AND octet_length(intent_json::text) <= 262144),
  CONSTRAINT theme_studio_versions_package_check
    CHECK ((package_json IS NULL AND package_digest IS NULL)
        OR (package_json IS NOT NULL AND package_digest IS NOT NULL
            AND jsonb_typeof(package_json) = 'object'
            AND package_digest ~ '^[a-f0-9]{64}$'
            AND octet_length(package_json::text) <= 2097152))
);

ALTER TABLE public.theme_studio_projects
  ADD CONSTRAINT theme_studio_projects_current_version_fkey
  FOREIGN KEY (current_version_id, id)
  REFERENCES public.theme_studio_versions(id, project_id);

CREATE TABLE public.theme_studio_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.theme_studio_projects(id),
  run_id uuid REFERENCES public.theme_studio_runs(id),
  actor_kind text NOT NULL,
  actor_id uuid,
  actor_email text,
  event_type text NOT NULL,
  -- Ids, counts, digests and safe codes only. Never prompt or reference text.
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT theme_studio_events_actor_check
    CHECK ((actor_kind = 'operator' AND actor_email IS NOT NULL)
        OR (actor_kind = 'worker' AND actor_id IS NULL AND actor_email IS NULL)),
  CONSTRAINT theme_studio_events_type_check
    CHECK (event_type IN ('project_created', 'reference_added', 'reference_removed',
                          'run_queued', 'run_started', 'run_succeeded', 'run_failed',
                          'run_cancel_requested', 'run_cancelled', 'run_retried',
                          'version_created', 'project_archived')),
  CONSTRAINT theme_studio_events_detail_check
    CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 4096)
);

CREATE INDEX theme_studio_events_project_idx
  ON public.theme_studio_events (project_id, created_at DESC);

-- Immutability. A prompt, a sanitized reference, an intent/package version and
-- an audit event are history: a correction is a new row, never an edit. Assets
-- and messages may still be DELETED (reference removal and the retention
-- sweep); versions and events may not, so nothing can rewrite what a later
-- approval or publication will cite.
CREATE FUNCTION public.theme_studio_forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER theme_studio_messages_immutable
BEFORE UPDATE ON public.theme_studio_messages
FOR EACH ROW EXECUTE FUNCTION public.theme_studio_forbid_mutation();

CREATE TRIGGER theme_studio_assets_immutable
BEFORE UPDATE ON public.theme_studio_assets
FOR EACH ROW EXECUTE FUNCTION public.theme_studio_forbid_mutation();

CREATE TRIGGER theme_studio_versions_immutable
BEFORE UPDATE OR DELETE ON public.theme_studio_versions
FOR EACH ROW EXECUTE FUNCTION public.theme_studio_forbid_mutation();

CREATE TRIGGER theme_studio_events_immutable
BEFORE UPDATE OR DELETE ON public.theme_studio_events
FOR EACH ROW EXECUTE FUNCTION public.theme_studio_forbid_mutation();

-- The project lifecycle is the Phase 0 state machine, enforced where no
-- server action can skip it. Mirrors canTransitionThemeStudioProject.
CREATE FUNCTION public.theme_studio_project_guard()
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
    (OLD.status = 'candidate' AND NEW.status IN ('generating', 'approved', 'blocked', 'archived')) OR
    (OLD.status = 'approved' AND NEW.status IN ('generating', 'published', 'blocked', 'archived')) OR
    (OLD.status = 'published' AND NEW.status = 'archived') OR
    (OLD.status = 'failed' AND NEW.status IN ('generating', 'archived')) OR
    (OLD.status = 'blocked' AND NEW.status IN ('generating', 'ready', 'archived'))
  ) THEN
    RAISE EXCEPTION 'illegal theme studio transition % -> %', OLD.status, NEW.status;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER theme_studio_projects_guard
BEFORE UPDATE ON public.theme_studio_projects
FOR EACH ROW EXECUTE FUNCTION public.theme_studio_project_guard();

ALTER TABLE public.theme_studio_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.theme_studio_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.theme_studio_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.theme_studio_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.theme_studio_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.theme_studio_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.theme_studio_projects, public.theme_studio_assets,
  public.theme_studio_messages, public.theme_studio_runs,
  public.theme_studio_versions, public.theme_studio_events
  FROM PUBLIC, app_user;

GRANT SELECT, INSERT, UPDATE ON TABLE public.theme_studio_projects TO app_service;
GRANT SELECT, INSERT, DELETE ON TABLE public.theme_studio_assets TO app_service;
GRANT SELECT, INSERT, DELETE ON TABLE public.theme_studio_messages TO app_service;
GRANT SELECT, INSERT, UPDATE ON TABLE public.theme_studio_runs TO app_service;
GRANT SELECT, INSERT ON TABLE public.theme_studio_versions TO app_service;
GRANT SELECT, INSERT ON TABLE public.theme_studio_events TO app_service;

REVOKE ALL ON FUNCTION public.theme_studio_forbid_mutation() FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION public.theme_studio_project_guard() FROM PUBLIC, app_user;
