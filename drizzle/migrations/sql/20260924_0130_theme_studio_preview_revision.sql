-- Phase 4 of Mink AI Theme Studio: private previews and iterative revision.
--
-- Additive only, so the revision being replaced keeps working against the new
-- schema during the rollout: two nullable run columns and one defaulted array,
-- one new table, and a widened event vocabulary. Nothing the previous revision
-- writes is refused — it writes only `generate` runs, which carry no base.

-- A revision is bound to the exact version it revises. `base_version_id` names
-- it and `base_package_digest` records the content address the operator saw, so
-- the worker can refuse a run whose base is not what it was queued against.
-- `context_message_ids` is the explicit, ordered list of messages a revision
-- reads — the revision request and any answers to its clarifying questions —
-- so two revisions branching from one version never read each other's text.
ALTER TABLE public.theme_studio_runs
  ADD COLUMN base_version_id uuid,
  ADD COLUMN base_package_digest text,
  ADD COLUMN context_message_ids uuid[] NOT NULL DEFAULT '{}';

ALTER TABLE public.theme_studio_runs
  ADD CONSTRAINT theme_studio_runs_base_version_fkey
  FOREIGN KEY (base_version_id, project_id)
  REFERENCES public.theme_studio_versions(id, project_id);

-- Every operand below is NOT NULL or tested with IS [NOT] NULL, so none of
-- these CHECKs can pass by evaluating to NULL.
ALTER TABLE public.theme_studio_runs
  ADD CONSTRAINT theme_studio_runs_base_check
  CHECK ((kind = 'revise') = (base_version_id IS NOT NULL)
     AND (base_version_id IS NULL) = (base_package_digest IS NULL)
     AND (base_package_digest IS NULL OR base_package_digest ~ '^[a-f0-9]{64}$')
     AND (kind = 'revise') = (cardinality(context_message_ids) > 0)
     AND cardinality(context_message_ids) <= 20);

-- A private preview: a hidden, demo-flagged store materialized from ONE
-- version, rendered by the real storefront. One per version. The store row owns
-- all of its data, so deleting the store removes the preview and everything it
-- seeded in one cascade; this row cascades with it.
CREATE TABLE public.theme_studio_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.theme_studio_projects(id),
  version_id uuid NOT NULL,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'materializing',
  created_by uuid REFERENCES public.platform_admins(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_opened_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT theme_studio_previews_version_fkey
    FOREIGN KEY (version_id, project_id)
    REFERENCES public.theme_studio_versions(id, project_id),
  CONSTRAINT theme_studio_previews_version_key UNIQUE (version_id),
  CONSTRAINT theme_studio_previews_store_key UNIQUE (store_id),
  CONSTRAINT theme_studio_previews_status_check
    CHECK (status IN ('materializing', 'ready', 'failed')),
  CONSTRAINT theme_studio_previews_expiry_check CHECK (expires_at > created_at)
);

CREATE INDEX theme_studio_previews_expiry_idx
  ON public.theme_studio_previews (expires_at);

CREATE INDEX theme_studio_previews_project_idx
  ON public.theme_studio_previews (project_id, last_opened_at DESC);

ALTER TABLE public.theme_studio_previews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.theme_studio_previews FROM PUBLIC, app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.theme_studio_previews TO app_service;

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
                        'preview_created', 'preview_failed', 'preview_expired'));
