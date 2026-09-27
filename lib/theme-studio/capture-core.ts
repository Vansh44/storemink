import { PLACEHOLDER_LICENSE_NOTE } from "./compiler";
import type { ThemePackageV2 } from "./contracts";
import {
  applySlotReplacements,
  describeSlots,
  slotByteLimit,
  slotTargetSize,
  type SlotImageRow,
} from "./slot-images-core";

// ---------------------------------------------------------------------------
// Track 3.6: the catalog card and screenshots, captured from the preview.
//
// Publication needs a catalog card and two screenshots, and the model cannot
// draw them: they are pictures of the storefront itself. So the capture job
// (scripts/theme-studio-capture-job.mjs) opens the version's private preview
// store in headless Chromium and photographs its home page, and the pictures
// are saved as a new version. This module is the pure half: what to shoot at
// what size, when shooting would be pointless, and how the pictures enter the
// package.
//
// ★ EACH SHOT IS RENDERED LARGER THAN ITS SLOT. The crop step refuses to
// upscale (slot-images.ts), and a catalog card is looked at on retina screens,
// so a shot is taken at 2× (3× on the phone) and cropped down.
//
// ★ NOT WHILE ART IS A PLACEHOLDER. A catalog card of solid-colour blocks
// would pass every check and sell nothing; the capture waits for real images.
// ---------------------------------------------------------------------------

export const CAPTURED_LICENSE_NOTE =
  "Captured by StoreMink Theme Studio from this theme's own preview store.";

export interface CaptureShot {
  slotId: string;
  /** The storefront path photographed. */
  path: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  /** A phone: touch, mobile viewport and user agent. */
  mobile: boolean;
  alt: string;
  /** The crop the stored picture ends at, and its byte ceiling. */
  target: { width: number; height: number; aspect: number };
  byteLimit: number;
}

const CSS_WIDTH = { card: 1280, desktop: 1440, mobile: 390 } as const;

/** The pictures a capture takes for this version, in package order. */
export function captureShots(pkg: ThemePackageV2): CaptureShot[] {
  const name = pkg.definition.name;
  const viewportBySrc = new Map(
    pkg.definition.catalog.screenshots.map((shot) => [shot.src, shot.viewport]),
  );
  const shots: CaptureShot[] = [];
  for (const slot of describeSlots(pkg)) {
    if (!slot.catalogPreview && !slot.catalogScreenshot) continue;
    const target = slotTargetSize(slot);
    if (!target) continue;
    const kind = slot.catalogPreview
      ? "card"
      : viewportBySrc.get(slot.path) === "mobile"
        ? "mobile"
        : "desktop";
    const width = CSS_WIDTH[kind];
    shots.push({
      slotId: slot.id,
      path: "/",
      viewport: { width, height: Math.round(width / target.aspect) },
      deviceScaleFactor: kind === "mobile" ? 3 : 2,
      mobile: kind === "mobile",
      alt:
        kind === "card"
          ? `${name}: the storefront home page`
          : `${name} storefront on ${kind}`,
      target,
      byteLimit: slotByteLimit(slot),
    });
  }
  return shots;
}

/** Why a capture of this version would be pointless, in operator words. */
export function captureBlockers(pkg: ThemePackageV2): string[] {
  const blockers: string[] = [];
  const art = describeSlots(pkg).filter(
    (slot) =>
      !slot.catalogPreview &&
      !slot.catalogScreenshot &&
      slot.licenseNote === PLACEHOLDER_LICENSE_NOTE,
  );
  if (art.length > 0) {
    blockers.push(
      `${art.length} image${art.length === 1 ? " is" : "s are"} still a placeholder. Draw or upload ${art.length === 1 ? "it" : "them"} first: the catalog pictures show the storefront as it is.`,
    );
  }
  if (captureShots(pkg).length === 0) {
    blockers.push("This version has no catalog card or screenshot to capture.");
  }
  return blockers;
}

/**
 * The next version's package with the captured pictures in place, marked as
 * StoreMink's own capture (operator-owned, with a licence note) and with alt
 * text that no longer calls the screenshots placeholders.
 */
export function applyCapturedImages(
  pkg: ThemePackageV2,
  captured: readonly { slotId: string; row: SlotImageRow }[],
  versionNumber: number,
): { ok: true; value: ThemePackageV2 } | { ok: false; error: string } {
  if (captured.length === 0) {
    return { ok: false, error: "Nothing was captured." };
  }
  const alts = new Map(captureShots(pkg).map((s) => [s.slotId, s.alt]));
  return applySlotReplacements(
    pkg,
    captured.map(({ slotId, row }) => ({
      slotId,
      assetId: row.id,
      alt: alts.get(slotId) ?? `${pkg.definition.name} storefront`,
      source: "operator-owned",
      licenseNote: CAPTURED_LICENSE_NOTE,
    })),
    new Map(captured.map(({ row }) => [row.id, row])),
    versionNumber,
    `Catalog pictures captured from the preview: ${captured.map((c) => c.slotId).join(", ")}.`,
  );
}
