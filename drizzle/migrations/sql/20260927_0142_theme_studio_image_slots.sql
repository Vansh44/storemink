-- Theme Studio: redraw chosen slots (Track 3.5).
--
-- An image run could only draw every placeholder slot of a version. An
-- operator reviewing generated images needs to redraw ONE that came out
-- wrong, including one that is already a generated image. The run now
-- records which slots it was asked to draw; empty means "every placeholder",
-- which is exactly what every existing image run did.
--
-- Additive for the revision being replaced: the column defaults to empty, so
-- the old worker's insert still succeeds and its runs keep their meaning.
-- ⚠ Rollout window: a worker still on the previous revision ignores the
-- column and would draw every placeholder instead of the chosen slots. Only
-- the new code queues a targeted run, the console is superadmin-only, and the
-- window is a Cloud Run rollout, so this is accepted rather than engineered
-- around.

ALTER TABLE public.theme_studio_runs
  ADD COLUMN image_slot_ids text[] NOT NULL DEFAULT '{}';

-- Every operand is NOT NULL, so the CHECK cannot pass by evaluating to NULL.
-- 41 is the most one run may draw (image-generation-core.ts
-- MAX_IMAGES_PER_RUN), and only an image run may name slots.
ALTER TABLE public.theme_studio_runs
  ADD CONSTRAINT theme_studio_runs_image_slots_check
  CHECK ((kind = 'images' OR cardinality(image_slot_ids) = 0)
     AND cardinality(image_slot_ids) <= 41);
