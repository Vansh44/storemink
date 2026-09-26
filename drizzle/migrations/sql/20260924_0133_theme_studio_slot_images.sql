-- Theme Studio: operator images per slot.
--
-- A generated version's images are server-drawn placeholders, and acceptance
-- refuses placeholders, so no generated version could ever become a
-- candidate. An operator can now upload an image for a slot, stage several,
-- and save them as ONE new version: the previous version is untouched
-- (versions are immutable) and the new one's parent is the version edited.
--
-- Additive for the revision being replaced:
--   • `theme_studio_versions.run_id` becomes nullable, with an `origin` column
--     that says why — a version made by an image edit has no model run. The
--     previous revision only ever writes `run` versions with a run id.
--   • one new asset purpose, `image`, which only the new code writes;
--   • two new event types.

ALTER TABLE public.theme_studio_versions
  ALTER COLUMN run_id DROP NOT NULL,
  ADD COLUMN origin text NOT NULL DEFAULT 'run',
  ADD COLUMN edit_detail jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Every operand is NOT NULL or tested with IS [NOT] NULL, so none of these
-- CHECKs can pass by evaluating to NULL.
ALTER TABLE public.theme_studio_versions
  ADD CONSTRAINT theme_studio_versions_origin_check
  CHECK (origin IN ('run', 'asset_edit')
     AND (origin = 'run') = (run_id IS NOT NULL)
     -- An image edit always edits SOMETHING: it has a parent and a package.
     AND (origin = 'run' OR parent_version_id IS NOT NULL)
     AND (origin = 'run' OR package_json IS NOT NULL)
     AND jsonb_typeof(edit_detail) = 'object'
     AND octet_length(edit_detail::text) <= 16384);

-- `image`: an operator-uploaded storefront image, cropped to its slot and
-- re-encoded. Unlike a reference it is meant for publication, which is why
-- the public image route may serve it (and never a reference).
ALTER TABLE public.theme_studio_assets
  DROP CONSTRAINT theme_studio_assets_purpose_check;
ALTER TABLE public.theme_studio_assets
  ADD CONSTRAINT theme_studio_assets_purpose_check
  CHECK (purpose IN ('reference', 'placeholder', 'image'));

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
                        'slot_image_uploaded', 'slot_images_replaced'));
