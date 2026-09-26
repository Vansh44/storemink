-- Theme Studio: image runs (Track 3.2).
--
-- An operator can ask Theme Studio to draw a version's images. The run makes
-- one art-direction anchor, then an image for every placeholder slot matched to
-- it, and saves them as ONE new version whose parent is the version filled.
--
-- Additive for the revision being replaced:
--   • a run kind `images`, which — like `revise` — is bound to a base version;
--   • a message kind `images`, the immutable record of the request;
--   • an asset purpose `anchor`, the reference image every generated image is
--     matched to (kept so a later regeneration can match it too; never served
--     and never published);
--   • an event type `images_requested`.
--
-- ⚠ Rollout window: a worker still on the previous revision does not know the
-- `images` kind and would claim such a run as an ordinary generation. Only the
-- new code queues one, the operator console is superadmin-only, and the window
-- is a Cloud Run rollout, so this is accepted rather than engineered around.

ALTER TABLE public.theme_studio_runs
  DROP CONSTRAINT theme_studio_runs_kind_check;
ALTER TABLE public.theme_studio_runs
  ADD CONSTRAINT theme_studio_runs_kind_check
  CHECK (kind IN ('generate', 'revise', 'images'));

-- Every operand is NOT NULL or tested with IS [NOT] NULL, so the CHECK cannot
-- pass by evaluating to NULL. An image run is bound to the version it fills,
-- like a revision, but reads no conversation: its context list stays empty.
ALTER TABLE public.theme_studio_runs
  DROP CONSTRAINT theme_studio_runs_base_check;
ALTER TABLE public.theme_studio_runs
  ADD CONSTRAINT theme_studio_runs_base_check
  CHECK ((kind IN ('revise', 'images')) = (base_version_id IS NOT NULL)
     AND (base_version_id IS NULL) = (base_package_digest IS NULL)
     AND (base_package_digest IS NULL OR base_package_digest ~ '^[a-f0-9]{64}$')
     AND (kind = 'revise') = (cardinality(context_message_ids) > 0)
     AND cardinality(context_message_ids) <= 20);

ALTER TABLE public.theme_studio_messages
  DROP CONSTRAINT theme_studio_messages_kind_check;
ALTER TABLE public.theme_studio_messages
  ADD CONSTRAINT theme_studio_messages_kind_check
  CHECK (kind IN ('brief', 'revision', 'images'));

ALTER TABLE public.theme_studio_assets
  DROP CONSTRAINT theme_studio_assets_purpose_check;
ALTER TABLE public.theme_studio_assets
  ADD CONSTRAINT theme_studio_assets_purpose_check
  CHECK (purpose IN ('reference', 'placeholder', 'image', 'anchor'));

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
                        'catalog_release_selected', 'images_requested'));
