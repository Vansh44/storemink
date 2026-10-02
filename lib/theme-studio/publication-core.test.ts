import { describe, expect, it } from "vitest";
import { operatorImagePackage, placeholderPackage } from "./_test-helpers";
import { validateThemePackageV2 } from "./contracts";
import {
  buildPublishedPackage,
  nextReleaseVersion,
  publicationBlockers,
  releaseDate,
  validateCatalogChange,
} from "./publication-core";

describe("release versions", () => {
  it.each([
    [[], "1.0.0"],
    [["1.0.0"], "1.1.0"],
    [["1.0.0", "1.4.2", "1.10.0"], "1.11.0"],
    [["0.3.0"], "1.0.0"],
    [["2.0.0", "1.9.0", "not-a-version"], "2.1.0"],
  ])("after %j comes %s", (existing, next) => {
    expect(nextReleaseVersion(existing)).toBe(next);
  });
});

describe("the published package", () => {
  const url = (path: string) =>
    `https://storage.googleapis.com/storemink-media/${path}`;

  it("refuses a version that still has placeholders", () => {
    const pkg = placeholderPackage();
    expect(publicationBlockers(pkg)[0]).toMatch(/placeholder/);
    const built = buildPublishedPackage(pkg, {
      version: "1.0.0",
      releasedAt: "2026-09-25",
      sourceVersionNumber: 3,
      publicUrl: url,
    });
    expect(!built.ok && built.error).toMatch(/placeholder/);
  });

  it("points every slot at its immutable object and publishes the release", () => {
    const draft = operatorImagePackage();
    const built = buildPublishedPackage(draft, {
      version: "1.0.0",
      releasedAt: "2026-09-25",
      sourceVersionNumber: 3,
      publicUrl: url,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const { pkg, objects } = built.value;
    const id = draft.definition.id;
    expect(objects).toHaveLength(draft.assets.length);
    for (const object of objects) {
      expect(object.objectPath).toBe(
        `theme-releases/${id}/1.0.0/${object.assetId}-${object.sha256.slice(0, 16)}.webp`,
      );
    }
    expect(
      pkg.assets.every((a) => a.path.startsWith(url("theme-releases/"))),
    ).toBe(true);
    expect(JSON.stringify(pkg.definition)).not.toContain("theme-asset://");
    expect(pkg.definition.release).toEqual({
      version: "1.0.0",
      status: "published",
      releasedAt: "2026-09-25",
      notes: ["Published from Theme Studio version 3."],
    });
    expect(pkg.definition.catalog.visibility).toBe("public");
    expect(pkg.definition.demo).toEqual({
      slug: `demo-${id}`,
      status: "healthy",
    });
    // The draft is untouched.
    expect(draft.definition.release.status).not.toBe("published");
  });

  it("refuses a bad version or date", () => {
    const draft = operatorImagePackage();
    const base = {
      releasedAt: "2026-09-25",
      sourceVersionNumber: 1,
      publicUrl: url,
    };
    expect(buildPublishedPackage(draft, { ...base, version: "1.0" }).ok).toBe(
      false,
    );
    expect(
      buildPublishedPackage(draft, {
        ...base,
        version: "1.0.0",
        releasedAt: "25/09/2026",
      }).ok,
    ).toBe(false);
  });
});

describe("published image paths in the contract", () => {
  function published() {
    const built = buildPublishedPackage(operatorImagePackage(), {
      version: "1.0.0",
      releasedAt: "2026-09-25",
      sourceVersionNumber: 1,
      publicUrl: (p) => `https://storage.googleapis.com/bucket-x/${p}`,
    });
    if (!built.ok) throw new Error(built.error);
    return built.value.pkg;
  }

  it("accepts the release's own images", () => {
    expect(validateThemePackageV2(published()).ok).toBe(true);
  });

  it.each([
    [
      "another theme's image",
      (p: string) =>
        p.replace(/\/theme-releases\/[^/]+\//, "/theme-releases/other-theme/"),
    ],
    ["another release's image", (p: string) => p.replace("/1.0.0/", "/2.0.0/")],
    [
      "an image whose digest does not match",
      (p: string) =>
        p.replace(/-[a-f0-9]{16}\.webp$/, "-0000000000000000.webp"),
    ],
    [
      "an arbitrary URL",
      () => "https://evil.example.com/theme-releases/x.webp",
    ],
  ])("refuses %s", (_label, mutate) => {
    const pkg = published();
    const asset = pkg.assets[0];
    const moved = mutate(asset.path);
    const tampered = JSON.parse(
      JSON.stringify(pkg).split(asset.path).join(moved),
    );
    expect(validateThemePackageV2(tampered).ok).toBe(false);
  });
});

describe("catalog changes", () => {
  it("needs no reason: a blank one gets a plain sentence for the audit", () => {
    const hide = validateCatalogChange({ action: "hide" });
    expect(hide).toEqual({
      ok: true,
      value: { action: "hide", reason: "Hidden from new stores." },
    });
    const show = validateCatalogChange({ action: "show", reason: "  " });
    expect(show.ok && show.value.reason).toBe("Shown in the catalog again.");
    const typed = validateCatalogChange({
      action: "hide",
      reason: "Broken PDP",
    });
    expect(typed.ok && typed.value.reason).toBe("Broken PDP");
  });

  it("accepts hide, show and a release selection", () => {
    expect(
      validateCatalogChange({ action: "hide", reason: "Broken PDP" }).ok,
    ).toBe(true);
    expect(
      validateCatalogChange({
        action: "select_release",
        version: "1.0.0",
        reason: "Roll back",
      }),
    ).toEqual({
      ok: true,
      value: {
        action: "select_release",
        version: "1.0.0",
        reason: "Roll back",
      },
    });
    expect(
      validateCatalogChange({ action: "select_release", reason: "x".repeat(4) })
        .ok,
    ).toBe(false);
    expect(validateCatalogChange({ action: "delete", reason: "nope" }).ok).toBe(
      false,
    );
  });
});

describe("release dates", () => {
  it("dates a release in India time", () => {
    // 20:00 UTC on the 24th is 01:30 IST on the 25th.
    expect(releaseDate(new Date("2026-09-24T20:00:00Z"))).toBe("2026-09-25");
  });
});
