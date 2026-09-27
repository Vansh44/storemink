import { describe, expect, it } from "vitest";
import { isSafePreviewPath, studioPreviewMarker } from "./preview-store";

const P = "11111111-1111-4111-8111-111111111111";
const V = "22222222-2222-4222-8222-222222222222";

describe("studioPreviewMarker", () => {
  it("recognises a demo store carrying a well-formed marker", () => {
    expect(
      studioPreviewMarker({
        demo: true,
        studioPreview: { projectId: P, versionId: V },
      }),
    ).toEqual({ projectId: P, versionId: V });
  });

  it("needs BOTH markers, so a stray key cannot hide a real storefront", () => {
    expect(
      studioPreviewMarker({ studioPreview: { projectId: P, versionId: V } }),
    ).toBeNull();
    expect(
      studioPreviewMarker({
        demo: "true",
        studioPreview: { projectId: P, versionId: V },
      }),
    ).toBeNull();
    expect(studioPreviewMarker({ demo: true })).toBeNull();
  });

  it("refuses malformed ids", () => {
    expect(
      studioPreviewMarker({
        demo: true,
        studioPreview: { projectId: P, versionId: "v1" },
      }),
    ).toBeNull();
    expect(studioPreviewMarker(null)).toBeNull();
    expect(studioPreviewMarker([])).toBeNull();
  });
});

describe("isSafePreviewPath", () => {
  it("accepts same-origin absolute paths", () => {
    for (const ok of ["/", "/shop", "/shop/tea-1?x=1", "/about#top"]) {
      expect(isSafePreviewPath(ok)).toBe(true);
    }
  });

  it("refuses anything that could leave the preview host", () => {
    for (const bad of [
      "//evil.example",
      "/\\evil.example",
      "https://evil.example",
      "shop",
      "/a b",
      "",
      "/" + "a".repeat(600),
      42,
    ]) {
      expect(isSafePreviewPath(bad)).toBe(false);
    }
  });
});

describe("readThemeSelection for a preview store", () => {
  it("carries the Studio version only when both markers are present", async () => {
    const { readThemeSelection } = await import("@/lib/themes/meta");
    const theme = { presetId: "clay-co", presetVersion: "0.0.2" };
    expect(
      readThemeSelection({
        demo: true,
        theme,
        studioPreview: { projectId: P, versionId: V },
      }),
    ).toEqual({ id: "clay-co", version: "0.0.2", studioVersionId: V });
    expect(
      readThemeSelection({
        theme,
        studioPreview: { projectId: P, versionId: V },
      }),
    ).toEqual({ id: "clay-co", version: "0.0.2" });
  });
});
