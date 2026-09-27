// Shared fixtures for Theme Studio tests. Excluded from coverage by name.
import { createHash } from "node:crypto";
import { THEME_DEFINITIONS } from "@/lib/themes";
import { collectThemeImageUrls } from "@/lib/themes/validation";
import type { ThemeDefinition } from "@/lib/themes/types";
import { PLACEHOLDER_LICENSE_NOTE } from "./compiler";
import {
  THEME_PACKAGE_SCHEMA_VERSION,
  THEME_STUDIO_VIEWPORTS,
  validateThemePackageV2,
  type ThemePackageV2,
} from "./contracts";

export function hex(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

/** A generated-shape package: every image a placeholder slot (4:3, except the
 * mobile screenshot at 9:19). */
export function placeholderPackage(): ThemePackageV2 {
  let theme: ThemeDefinition = structuredClone(THEME_DEFINITIONS[0]);
  const urls = [...collectThemeImageUrls(theme)];
  const slotFor = new Map(urls.map((url, i) => [url, `slot-${i}`]));
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string" && slotFor.has(value)) {
      return `theme-asset://${slotFor.get(value)}`;
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, rewrite(v)]),
      );
    }
    return value;
  };
  theme = rewrite(theme) as ThemeDefinition;
  theme.catalog.visibility = "hidden";
  theme.release = { version: "0.0.1", status: "draft", notes: ["Generated."] };
  theme.demo = { slug: theme.demo.slug, status: "unavailable" };
  const mobile = theme.catalog.screenshots.find((s) => s.viewport === "mobile");
  const pkg: ThemePackageV2 = {
    schemaVersion: THEME_PACKAGE_SCHEMA_VERSION,
    definition: theme,
    renderer: {
      minVersion: theme.engine.version,
      viewports: THEME_STUDIO_VIEWPORTS,
    },
    declaredCapabilities: {
      features: [...theme.catalog.features],
      surfaces: ["home", "shop", "product", "cart"],
    },
    assets: urls.map((_url, i) => {
      const path = `theme-asset://slot-${i}`;
      const tall = mobile?.src === path;
      return {
        id: `slot-${i}`,
        path,
        kind: "content" as const,
        source: "generated" as const,
        sha256: hex(`placeholder-${i}`),
        width: tall ? 758 : 1600,
        height: tall ? 1600 : 1200,
        alt: `Slot ${i} placeholder`,
        licenseNote: PLACEHOLDER_LICENSE_NOTE,
      };
    }),
    provenance: {
      origin: "generated",
      modelKey: "gemini-3.8-flash",
      promptVersion: "theme-studio-v2",
      referenceDigests: [],
    },
    capabilityGaps: [],
  };
  const parsed = validateThemePackageV2(pkg);
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return parsed.value;
}

/** The same package with every slot holding an operator image, as it stands
 * after the Images screen: publishable. */
export function operatorImagePackage(): ThemePackageV2 {
  const pkg = placeholderPackage();
  const next: ThemePackageV2 = {
    ...pkg,
    assets: pkg.assets.map((asset) => ({
      ...asset,
      source: "operator-owned" as const,
      sha256: hex(`image-${asset.id}`),
      licenseNote: "Photographed by StoreMink",
    })),
  };
  const parsed = validateThemePackageV2(next);
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return parsed.value;
}
