# Mink AI Theme Studio — operator images per slot

Every image a generated theme renders is a **slot**: a `theme-asset://<id>`
path in the package's asset manifest. A model can only fill a slot with a
server-drawn placeholder, and Phase 5 acceptance refuses placeholders, so no
generated version could ever become a candidate. This adds the missing path:
an operator uploads an image for each slot and saves them as a new version.

It is operator-only: nothing a merchant, their staff or a shopper does
changes, so there is no Help Centre migration.

## 1. What changes for an operator

Every version row in a Studio project has an **Images** link. Its badge counts
the placeholders left. The screen (`…/versions/[versionId]/images`) lists
every slot with its current image, its shape and where it appears ("Product ·
Rose oil", "Home · hero", "Theme catalog card"). A filter shows only the
slots that still have a placeholder.

1. **Upload an image for a slot.** It is cropped to the slot's shape and
   compressed straight away; the new image appears beside the current one. No
   version changes yet.
2. **Say what it is and where it came from.** Alt text, then _ours_
   (photographed or made by us) or _licensed_, with a licence note. The last
   note typed is offered for the next image.
3. **Save N images as version X.** One new version is created from all staged
   images. Its parent is the version edited, and it becomes current. The
   version edited never changes. A candidate goes back to `ready`, because its
   acceptance evidence covered different images.

**★ A revision keeps the images.** A revision recompiles the whole package,
and every slot would otherwise come back as a placeholder. Any slot the
revised package still declares with the same id and the same shape keeps its
uploaded image. A slot the model reshaped gets a placeholder again, because
the old image would be cropped wrong.

## 2. Processing an upload

`lib/theme-studio/slot-images.ts` treats an upload exactly like a reference.
The shared `openUntrustedImage` (in `references.ts`) handles every check:

- the format is decided by magic bytes and cross-checked against what the
  decoder decoded;
- only one frame is accepted;
- there is a pixel ceiling;
- the stored bytes are always a re-encode, so no EXIF or trailing payload
  survives.

Then:

- **Crop to the slot's shape.** The largest centred region with the ratio of
  the image being replaced. The layout rendering the slot was designed for
  that ratio.
- **Size.** A long edge of 1600px, and never narrower than 800px, so a tall
  mobile-screenshot slot grows taller instead.
- **★ Never upscaled.** A crop narrower than 800px is refused with a reason.
  A blurry image passes every automated check and fails every human one.
- **Compress to the storefront limits (TA-2.6).** WebP within 500 KiB, or
  250 KiB for the catalog card. Each size tries the lowest quality first; if
  even that is too big, the image shrinks at once, otherwise it takes the best
  quality that fits. Every pass decodes the original upload, so the image is
  compressed once. An image that cannot fit at 800px wide is refused.

The upload route
(`POST /api/platform/theme-studio/projects/[projectId]/slot-images?versionId=&slot=`)
is a route handler, because a server action's body is capped at 6 MB. It
requires:

- a superadmin session and a same-origin request;
- a rate limit, and a 15 MB streamed byte cap;
- a slot that the named version really declares.

It stores an `image` asset (at most 200 per project) and returns its id.

## 3. Saving

`replaceThemeStudioSlotImages` locks the project and checks the expected
revision and the edited version's package digest. It then applies the pure
`applySlotReplacements` (`slot-images-core.ts`), which:

- refuses a slot the version lacks, an upload that is not an `image` of this
  project, and an image whose ratio does not match its slot;
- sets the operator's alt text and provenance;
- gives a replaced catalog screenshot the new alt text (15 characters or
  more);
- sets the release version to `0.0.N`;
- re-runs the full package contract.

The new version is written with `origin = 'asset_edit'`, no run, and
`edit_detail` naming the slots and the version edited. The
`slot_images_replaced` event records the same.

## 4. Serving

Previews render through next/image, which fetches without cookies. So operator
images are served publicly by `/api/theme-studio/images/[assetId]`, like
placeholders. That route serves only `image` assets, never a reference, which
is someone else's website. `preview.ts`'s `slotUrls` maps each slot to the
placeholder or image route, so a preview store and the Images screen can never
disagree. Acceptance now treats `image` assets as renderable.

## 5. Schema — migration `20260924_0133_theme_studio_slot_images`

- **`theme_studio_versions.run_id` becomes nullable.** A new `origin` column
  (`run` | `asset_edit`) and an `edit_detail` column come with it. The CHECK
  requires a run exactly when the origin is `run`, and a parent and a package
  for an image edit.
- **Assets:** the purpose vocabulary gains `image`.
- **Events:** `slot_image_uploaded` and `slot_images_replaced`.

All of it is additive for the revision being replaced, which writes only `run`
versions. Applied locally; the local drift baseline is refreshed.

## 6. Verified, and not

**Verified against the local database and dev server:**

- **A generated version's four slots.** Three got real photos: cropped,
  compressed (11–23 KB), stored, and saved as one new version (an image edit,
  with no run, parent version 1, now current). A stale package digest was
  refused. The images serve with 200.
- **The fourth slot was refused as too small, correctly.** It was the 9:19
  mobile screenshot, and the photo offered was landscape.
- **Acceptance on the edited version.** Asset integrity passed, and provenance
  flagged only the remaining placeholder.
- **A revision of the edited version kept all three images.**
- **Database CHECK probes.** An image edit without a parent or a package, a
  run version without a run, and a non-object `edit_detail` are refused; a
  valid edit is accepted.

**Not verified:**

- **The Images screen in a browser.** It is behind a superadmin login, which
  was not entered. The page compiles and renders its shell without errors.
