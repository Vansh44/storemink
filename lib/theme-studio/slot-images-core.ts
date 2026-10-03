import {
  PLACEHOLDER_LICENSE_NOTE,
  THEME_ASSET_PREFIX,
  productSlotBrief,
} from "./compiler";
import {
  THEME_STUDIO_LIMITS,
  validateThemePackageV2,
  type ThemePackageAsset,
  type ThemePackageV2,
} from "./contracts";
import { THEME_IMAGE_RULES } from "@/lib/themes/validation";

// ---------------------------------------------------------------------------
// Operator images per slot — the pure half.
//
// Every image a generated theme renders is a SLOT: a `theme-asset://<id>`
// path declared in the package's asset manifest. A model can only fill a slot
// with a placeholder, and acceptance refuses placeholders, so an operator
// replaces them. Replacements are STAGED and saved together as ONE new
// version: versions are immutable and content-addressed, so editing in place
// is not an option, and twenty slots should not mean twenty versions.
//
// ★ A slot's ASPECT RATIO is fixed by the package, not the upload. The layout
// that renders the slot was designed for it, so every upload is cropped to the
// ratio of the image it replaces (slot-images.ts) and a stored image whose
// ratio does not match is refused here rather than stretched.
//
// ★ The operator states where the image came from. `operator-owned` or
// `licensed`, with a licence note, is what acceptance's provenance gate and a
// later publication rely on; nothing here infers it.
// ---------------------------------------------------------------------------

export const SLOT_IMAGE_SOURCES = ["operator-owned", "licensed"] as const;
export type SlotImageSource = (typeof SLOT_IMAGE_SOURCES)[number];

/** Output sizing for an uploaded slot image. */
export const SLOT_IMAGE_LONG_EDGE = 1600;
export const SLOT_IMAGE_MIN_WIDTH = THEME_IMAGE_RULES.minWidth;
/** Relative tolerance when comparing a stored image's ratio to its slot's. */
const ASPECT_TOLERANCE = 0.01;

export const SLOT_ALT_MIN = 3;
export const SLOT_ALT_MAX = 200;
/** A catalog screenshot's alt text is held to TA-2.1's 15 characters. */
export const SCREENSHOT_ALT_MIN = 15;
export const SLOT_LICENSE_MIN = 3;
export const SLOT_LICENSE_MAX = 300;

export interface SlotDescriptor {
  id: string;
  path: string;
  kind: ThemePackageAsset["kind"];
  width: number | null;
  height: number | null;
  alt: string;
  source: ThemePackageAsset["source"];
  licenseNote: string | null;
  placeholder: boolean;
  /** The catalog's 4:3 card image, held to the tighter preview limits. */
  catalogPreview: boolean;
  catalogScreenshot: boolean;
  /** Where the slot renders, in words an operator recognises. */
  usage: string[];
}

function sectionLabel(type: string): string {
  return type.replace(/_/g, " ");
}

/** Where each slot path renders. */
export function slotUsage(pkg: ThemePackageV2): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  const add = (path: unknown, label: string) => {
    if (typeof path !== "string" || !path.startsWith(THEME_ASSET_PREFIX)) {
      return;
    }
    const list = usage.get(path) ?? [];
    if (!list.includes(label)) list.push(label);
    usage.set(path, list);
  };
  const { catalog, preset } = pkg.definition;
  add(catalog.previewImage, "Theme catalog card");
  for (const shot of catalog.screenshots) {
    add(shot.src, `Catalog screenshot (${shot.viewport})`);
  }
  for (const product of preset.sampleData?.products ?? []) {
    const label = `Product · ${product.name}`;
    add(product.image_url, label);
    for (const url of product.images ?? []) add(url, label);
    for (const variant of product.variants ?? []) {
      for (const url of variant.images ?? []) add(url, label);
    }
  }
  for (const category of preset.sampleData?.categories ?? []) {
    add(category.image_url, `Category · ${category.name}`);
  }
  for (const page of preset.pages) {
    for (const section of page.sections) {
      const label = `${page.title || "Home"} · ${sectionLabel(section.type)}`;
      const visit = (value: unknown): void => {
        if (typeof value === "string") add(value, label);
        else if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") {
          Object.values(value).forEach(visit);
        }
      };
      visit(section.config);
    }
  }
  return usage;
}

export function describeSlots(pkg: ThemePackageV2): SlotDescriptor[] {
  const usage = slotUsage(pkg);
  const screenshots = new Set(
    pkg.definition.catalog.screenshots.map((shot) => shot.src),
  );
  return pkg.assets
    .filter((asset) => asset.path.startsWith(THEME_ASSET_PREFIX))
    .map((asset) => ({
      id: asset.id,
      path: asset.path,
      kind: asset.kind,
      width: asset.width,
      height: asset.height,
      alt: asset.alt,
      source: asset.source,
      licenseNote: asset.licenseNote ?? null,
      placeholder: asset.licenseNote === PLACEHOLDER_LICENSE_NOTE,
      catalogPreview: asset.path === pkg.definition.catalog.previewImage,
      catalogScreenshot: screenshots.has(asset.path),
      usage: usage.get(asset.path) ?? [],
    }));
}

/**
 * The size an upload for this slot is produced at: the slot's ratio, a long
 * edge of 1600px, and never narrower than the 800px storefront minimum — a
 * tall mobile screenshot slot grows taller rather than falling below it.
 */
export function slotTargetSize(slot: {
  width: number | null;
  height: number | null;
}): { width: number; height: number; aspect: number } | null {
  if (!slot.width || !slot.height) return null;
  const aspect = slot.width / slot.height;
  if (aspect >= 1) {
    return {
      width: SLOT_IMAGE_LONG_EDGE,
      height: Math.round(SLOT_IMAGE_LONG_EDGE / aspect),
      aspect,
    };
  }
  const height = Math.max(
    SLOT_IMAGE_LONG_EDGE,
    Math.ceil(SLOT_IMAGE_MIN_WIDTH / aspect),
  );
  return { width: Math.round(height * aspect), height, aspect };
}

/** The byte ceiling for a slot's image (TA-2.6). */
export function slotByteLimit(slot: { catalogPreview: boolean }): number {
  return slot.catalogPreview
    ? THEME_IMAGE_RULES.maxPreviewBytes
    : THEME_IMAGE_RULES.maxBytes;
}

export interface SlotReplacementInput {
  slotId: unknown;
  assetId: unknown;
  alt: unknown;
  source: unknown;
  licenseNote: unknown;
}

export interface SlotReplacement {
  slotId: string;
  assetId: string;
  alt: string;
  source: SlotImageSource;
  licenseNote: string;
}

/** A stored operator image, as much as applying it needs. */
export interface SlotImageRow {
  id: string;
  purpose: string;
  sha256: string;
  width: number;
  height: number;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** Shape-check what the browser sent. Refuses rather than repairs. */
export function validateSlotReplacements(
  input: unknown,
): { ok: true; value: SlotReplacement[] } | { ok: false; error: string } {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, error: "Choose at least one image to save." };
  }
  if (input.length > THEME_STUDIO_LIMITS.slotReplacementsPerEdit) {
    return {
      ok: false,
      error: `Save at most ${THEME_STUDIO_LIMITS.slotReplacementsPerEdit} images at once.`,
    };
  }
  const out: SlotReplacement[] = [];
  const seen = new Set<string>();
  for (const raw of input as SlotReplacementInput[]) {
    const slotId = text(raw?.slotId);
    const assetId = text(raw?.assetId);
    const alt = text(raw?.alt);
    const licenseNote = text(raw?.licenseNote);
    const source = raw?.source as SlotImageSource;
    if (!slotId || slotId.length > 80 || !UUID_RE.test(assetId)) {
      return {
        ok: false,
        error: "An image refers to an unknown slot or upload.",
      };
    }
    if (seen.has(slotId)) {
      return { ok: false, error: `The slot ${slotId} was chosen twice.` };
    }
    seen.add(slotId);
    if (alt.length < SLOT_ALT_MIN || alt.length > SLOT_ALT_MAX) {
      return {
        ok: false,
        error: `Describe the ${slotId} image in ${SLOT_ALT_MIN}–${SLOT_ALT_MAX} characters (alt text).`,
      };
    }
    if (!SLOT_IMAGE_SOURCES.includes(source)) {
      return { ok: false, error: `Say where the ${slotId} image came from.` };
    }
    if (
      licenseNote.length < SLOT_LICENSE_MIN ||
      licenseNote.length > SLOT_LICENSE_MAX
    ) {
      return {
        ok: false,
        error: `Add a licence note for the ${slotId} image (${SLOT_LICENSE_MIN}–${SLOT_LICENSE_MAX} characters).`,
      };
    }
    if (licenseNote === PLACEHOLDER_LICENSE_NOTE) {
      return { ok: false, error: "That licence note is reserved." };
    }
    out.push({ slotId, assetId, alt, source, licenseNote });
  }
  return { ok: true, value: out };
}

/**
 * The next version's package: each replaced slot points at its new stored
 * image with the operator's alt text and provenance; a replaced catalog
 * screenshot carries the new alt text too; the release version follows the
 * new version number. The result must pass the full package contract.
 */
export function applySlotReplacements(
  pkg: ThemePackageV2,
  replacements: readonly SlotReplacement[],
  rows: ReadonlyMap<string, SlotImageRow>,
  versionNumber: number,
  /** The release note; defaults to naming an operator's replacement. */
  releaseNote?: string,
): { ok: true; value: ThemePackageV2 } | { ok: false; error: string } {
  const next: ThemePackageV2 = structuredClone(pkg);
  const screenshotSrcs = new Set(
    next.definition.catalog.screenshots.map((shot) => shot.src),
  );
  for (const replacement of replacements) {
    const index = next.assets.findIndex((a) => a.id === replacement.slotId);
    const asset = next.assets[index];
    if (!asset || !asset.path.startsWith(THEME_ASSET_PREFIX)) {
      return {
        ok: false,
        error: `This version has no slot ${replacement.slotId}.`,
      };
    }
    const row = rows.get(replacement.assetId);
    if (!row || row.purpose !== "image") {
      return {
        ok: false,
        error: `The upload for ${replacement.slotId} no longer exists. Upload it again.`,
      };
    }
    if (asset.width && asset.height) {
      const expected = asset.width / asset.height;
      const actual = row.width / row.height;
      if (Math.abs(actual - expected) / expected > ASPECT_TOLERANCE) {
        return {
          ok: false,
          error: `The upload for ${replacement.slotId} has the wrong shape for that slot. Upload it again for this slot.`,
        };
      }
    }
    if (
      screenshotSrcs.has(asset.path) &&
      replacement.alt.length < SCREENSHOT_ALT_MIN
    ) {
      return {
        ok: false,
        error: `A catalog screenshot needs alt text of at least ${SCREENSHOT_ALT_MIN} characters (${replacement.slotId}).`,
      };
    }
    next.assets[index] = {
      ...asset,
      sha256: row.sha256,
      width: row.width,
      height: row.height,
      alt: replacement.alt,
      source: replacement.source,
      licenseNote: replacement.licenseNote,
    };
    next.definition.catalog.screenshots =
      next.definition.catalog.screenshots.map((shot) =>
        shot.src === asset.path ? { ...shot, alt: replacement.alt } : shot,
      );
  }
  const slots = replacements.map((r) => r.slotId);
  next.definition.release = {
    ...next.definition.release,
    version: `0.0.${versionNumber}`,
    notes: [
      ...next.definition.release.notes.slice(-4),
      (
        releaseNote ?? `Images replaced by an operator: ${slots.join(", ")}.`
      ).slice(0, 500),
    ],
  };
  const validated = validateThemePackageV2(next);
  if (!validated.ok) {
    return {
      ok: false,
      error: `The edited theme no longer passes its contract: ${validated.issues[0] ?? "unknown issue"}`,
    };
  }
  return { ok: true, value: validated.value };
}

/** The fields of an asset brief that decide what its image depicts. */
export interface CarryBrief {
  id: string;
  subject: string;
  artDirection: string;
  aspectRatio: string;
  purpose?: string;
}

/**
 * Carry the operator's images into a REVISION. A revision recompiles the whole
 * package and every slot comes back as a fresh placeholder, so without this an
 * operator who uploaded images and then asked for new copy would silently lose
 * every image. A slot keeps its image when the revised package still declares
 * a slot with the same id AND the same shape — a slot the model reshaped gets
 * a placeholder, because the old image would be cropped wrong.
 *
 * ★★ AND WHEN ONLY THE NAME CHANGED (`briefs`). A revision often renames slots
 * without changing what they depict: Bubble's version 6 renamed five
 * (`promo-tile-summer-specials` → `promo-tile-seasonal`, …), four with a
 * byte-identical brief, and every one came back as a placeholder — paid images
 * discarded, more paid to redraw them. A slot whose brief is identical in
 * subject, art direction, aspect and purpose to an unused base slot's brief
 * takes that image; a product keeps its photo when the same product slug sits
 * under an identical product brief. Any change to the brief means a new
 * picture was asked for, so it is never carried by this fallback.
 */
export function carryOverSlotImages(
  next: ThemePackageV2,
  base: ThemePackageV2,
  briefs?: { next: readonly CarryBrief[]; base: readonly CarryBrief[] },
): { value: ThemePackageV2; carried: string[] } {
  const baseById = new Map(
    base.assets
      .filter(
        (asset) =>
          asset.path.startsWith(THEME_ASSET_PREFIX) &&
          asset.licenseNote !== PLACEHOLDER_LICENSE_NOTE &&
          asset.sha256 &&
          asset.width &&
          asset.height,
      )
      .map((asset) => [asset.id, asset]),
  );
  if (baseById.size === 0) return { value: next, carried: [] };
  const out: ThemePackageV2 = structuredClone(next);
  const carried: string[] = [];
  const used = new Set<string>();
  const sameShape = (asset: ThemePackageAsset, previous: ThemePackageAsset) => {
    if (!asset.width || !asset.height) return false;
    const expected = asset.width / asset.height;
    const actual = previous.width! / previous.height!;
    return Math.abs(actual - expected) / expected <= ASPECT_TOLERANCE;
  };
  const take = (asset: ThemePackageAsset, previous: ThemePackageAsset) => {
    carried.push(asset.id);
    used.add(previous.id);
    return {
      ...asset,
      sha256: previous.sha256,
      width: previous.width,
      height: previous.height,
      alt: previous.alt,
      source: previous.source,
      licenseNote: previous.licenseNote,
    };
  };
  // Pass 1: the same slot id (the original rule).
  out.assets = out.assets.map((asset) => {
    const previous = baseById.get(asset.id);
    return previous && sameShape(asset, previous)
      ? take(asset, previous)
      : asset;
  });
  // Pass 2: a renamed slot whose brief did not change.
  if (briefs) {
    const key = (b: CarryBrief | undefined) =>
      b
        ? [b.subject, b.artDirection, b.aspectRatio, b.purpose ?? ""]
            .map((v) => v.trim().replace(/\s+/g, " ").toLowerCase())
            .join("\u0000")
        : null;
    const nextBriefs = new Map(briefs.next.map((b) => [b.id, b]));
    const baseBriefs = new Map(briefs.base.map((b) => [b.id, b]));
    const slotOf = (url: string) =>
      url.startsWith(THEME_ASSET_PREFIX)
        ? url.slice(THEME_ASSET_PREFIX.length)
        : null;
    const baseProductSlot = new Map(
      (base.definition.preset.sampleData?.products ?? []).map((p) => [
        p.slug,
        slotOf(p.image_url),
      ]),
    );
    const productSlug = new Map(
      (out.definition.preset.sampleData?.products ?? []).flatMap((p) => {
        const slot = slotOf(p.image_url);
        return slot ? [[slot, p.slug] as const] : [];
      }),
    );
    const counterpart = (slotId: string): string | null => {
      const direct = key(nextBriefs.get(slotId));
      if (direct) {
        const match = briefs.base.find(
          (b) => b.id !== slotId && key(b) === direct,
        );
        return match?.id ?? null;
      }
      const slug = productSlug.get(slotId);
      const baseSlot = slug ? baseProductSlot.get(slug) : null;
      if (!baseSlot) return null;
      const nextBrief = productSlotBrief(slotId, nextBriefs.keys());
      const baseBrief = productSlotBrief(baseSlot, baseBriefs.keys());
      return nextBrief &&
        baseBrief &&
        key(nextBriefs.get(nextBrief)) === key(baseBriefs.get(baseBrief))
        ? baseSlot
        : null;
    };
    out.assets = out.assets.map((asset) => {
      if (carried.includes(asset.id)) return asset;
      const from = counterpart(asset.id);
      const previous = from ? baseById.get(from) : undefined;
      return previous && !used.has(previous.id) && sameShape(asset, previous)
        ? take(asset, previous)
        : asset;
    });
  }
  const altBySrc = new Map(
    base.definition.catalog.screenshots.map((shot) => [shot.src, shot.alt]),
  );
  const carriedPaths = new Set(
    out.assets.filter((a) => carried.includes(a.id)).map((a) => a.path),
  );
  out.definition.catalog.screenshots = out.definition.catalog.screenshots.map(
    (shot) =>
      carriedPaths.has(shot.src) && altBySrc.has(shot.src)
        ? { ...shot, alt: altBySrc.get(shot.src)! }
        : shot,
  );
  const validated = validateThemePackageV2(out);
  // A carried image must never make a valid package invalid: if it would,
  // the revision keeps its placeholders.
  return validated.ok
    ? { value: validated.value, carried }
    : { value: next, carried: [] };
}
